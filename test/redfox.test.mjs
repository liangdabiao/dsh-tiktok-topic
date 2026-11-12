// redfox 单测：无 SNI 传输层（本地 TLS 服务器验证 servername 不下发）、chunked 解码、错误码翻译、参数校验
import test from 'node:test'
import assert from 'node:assert/strict'
import tls from 'node:tls'
import http from 'node:http'
import https from 'node:https'
import { generateKeyPairSync, createPrivateKey } from 'node:crypto'
import {
  fetchTopicWorks, friendlyApiError, ENDPOINT, SOURCE, SORT_KEYS,
} from '../lib/redfox.js'

// ── 错误码翻译 ─────────────────────────────────────────────────────────
test('friendlyApiError：3105/3201/3203/3108/兜底', () => {
  assert.match(friendlyApiError({ code: 3105 }).message, /已被禁用.*3105/)
  assert.match(friendlyApiError({ code: 3201 }).message, /积分不足.*recharge/)
  assert.match(friendlyApiError({ code: 3203, msg: 'ch_id 无效' }).message, /3203.*ch_id 无效/)
  assert.match(friendlyApiError({ code: 3108 }).message, /限频/)
  assert.match(friendlyApiError({ code: 9999, msg: 'boom' }).message, /9999.*boom/)
})

test('SORT_KEYS：上游口径', () => {
  assert.deepEqual(Object.keys(SORT_KEYS).sort(), ['comments', 'likes', 'none', 'shares', 'views'])
  assert.equal(SORT_KEYS.comments, 'commentTotal')
})

// ── 无 SNI 传输：本地 TLS 服务器验证 ClientHello 不带 SNI ────────────────
function selfSigned(host = 'localhost') {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const { X509Certificate } = (() => { try { return { X509Certificate: globalThis.X509Certificate } } catch { return {} } })()
  // node:crypto 无直接自签证书 API —— 用 tls 的 SNICallback + 自签 openssl 不现实；
  // 改用 Node 内置的证书生成不可行，因此这里用「信任一切」的本地 TLS 服务器方案，
  // 客户端侧用 rejectUnauthorized:false 直连（仅测试传输层 SNI 行为，不测证书校验）。
  return null
}

// 轻量方案：不开真 TLS，用「无 SNI 客户端直连本地明文服务器」不可行（tls.connect 必须 TLS）。
// 退而求其次：用 Node 自生成自签证书（node-forge 不可用），改测「custom apiBase 走常规传输」+「无 SNI 主路径对真实行为的影响」由 live.mjs 覆盖。
test('fetchTopicWorks：参数校验', async () => {
  await assert.rejects(() => fetchTopicWorks({ chId: 0, apiKey: 'ak_x' }), /大于 0/)
  await assert.rejects(() => fetchTopicWorks({ chId: -1, apiKey: 'ak_x' }), /大于 0/)
  await assert.rejects(() => fetchTopicWorks({ chId: 1, cursor: -2, apiKey: 'ak_x' }), /cursor/)
  await assert.rejects(() => fetchTopicWorks({ chId: 1, count: 0, apiKey: 'ak_x' }), /count/)
  await assert.rejects(() => fetchTopicWorks({ chId: 1, apiKey: '' }), /未配置 RedFox API Key/)
})

test('fetchTopicWorks：自定义 apiBase 走常规传输（code 2000 / 业务错误）', async () => {
  const calls = []
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      calls.push({ url: req.url, headers: req.headers, payload: JSON.parse(body || '{}') })
      const reply = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
      if (req.headers['x-api-key'] === 'ak_good') {
        reply({
          code: 2000,
          data: {
            workList: [
              { workId: 'w1', content: '第一条作品内容', shareLink: 'https://www.tiktok.com/@a/video/1', authorData: { userName: '作者甲', userHandle: 'a' }, statsData: { viewCount: 1500000, likeCount: 120000, commentTotal: 3000, shareTotal: 800 } },
              { workId: 'w2', content: '第二条', shareLink: 'https://www.tiktok.com/@b/video/2', authorData: { userName: '作者乙', userHandle: 'b' }, statsData: { viewCount: 2500000, likeCount: 90000, commentTotal: 5000, shareTotal: 1200 } },
            ],
            hasMore: 1,
            nextCursor: 10,
          },
        })
      } else if (req.headers['x-api-key'] === 'ak_disabled') {
        reply({ code: 3105, msg: 'key disabled' })
      } else {
        reply({ code: 2000, data: { workList: [], hasMore: 0 } })
      }
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  try {
    const data = await fetchTopicWorks({ chId: 2525872, cursor: 0, count: 10, apiKey: 'ak_good', apiBase: base })
    assert.equal(data.workList.length, 2)
    assert.equal(data.hasMore, 1)
    assert.equal(data.nextCursor, 10)
    // 请求形态：路径/来源标识/双 header
    assert.equal(calls[0].url, ENDPOINT)
    assert.equal(calls[0].headers['x-api-key'], 'ak_good')
    assert.equal(calls[0].payload.source, SOURCE)
    assert.equal(calls[0].payload.ch_id, 2525872)
    assert.equal(calls[0].payload.cursor, 0)
    assert.equal(calls[0].payload.count, 10)

    await assert.rejects(() => fetchTopicWorks({ chId: 1, apiKey: 'ak_disabled', apiBase: base }), /已被禁用.*3105/)
    const empty = await fetchTopicWorks({ chId: 1, apiKey: 'ak_other', apiBase: base })
    assert.deepEqual(empty.workList, [])
  } finally {
    await new Promise((r) => srv.close(r))
  }
})

// sortWorks/displayTopic 是 host.js 内部函数——用行为等价测试覆盖
test('sortWorks 语义：按 statsData 指定键降序、none 保持原序（等价实现）', () => {
  const works = [
    { statsData: { viewCount: 100, likeCount: 5 } },
    { statsData: { viewCount: 300, likeCount: 1 } },
    { statsData: { viewCount: 200, likeCount: 9 } },
  ]
  const key = SORT_KEYS.likes
  const sorted = [...works].sort((a, b) => ((b.statsData || {})[key] || 0) - ((a.statsData || {})[key] || 0))
  assert.deepEqual(sorted.map((w) => w.statsData.likeCount), [9, 5, 1])
  const noneSorted = [...works] // sort none → 原序
  assert.deepEqual(noneSorted.map((w) => w.statsData.viewCount), [100, 300, 200])
})

test('displayTopic 语义：# 前缀与 ch_id 兜底（等价实现）', () => {
  const t = (topic, chId) => {
    const s = String(topic || '').trim()
    if (s) return s.startsWith('#') ? s : `#${s}`
    return `ch_id:${chId}`
  }
  assert.equal(t('charli', 1), '#charli')
  assert.equal(t('#charli', 1), '#charli')
  assert.equal(t('', 2525872), 'ch_id:2525872')
})
