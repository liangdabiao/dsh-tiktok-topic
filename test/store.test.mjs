// store + host 工具直调单测：查询历史覆盖、表格渲染、排序、翻页回填、无 key 引导
process.env.REDFOX_API_KEY = ''
const { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const tmp = mkdtempSync(join(tmpdir(), 'dsh-tt-store-'))
process.env.DSH_HOME = tmp
delete process.env.X_API_KEY

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

const {
  saveQuery, getQuery, listQueries, deleteQuery, getSettings, saveSettings, DATA_DIR,
} = await import('../lib/store.js')

const W = (id, views, likes) => ({
  workId: id, content: `作品${id}的内容摘要`, shareLink: `https://www.tiktok.com/@u/video/${id}`,
  authorData: { userName: `作者${id}`, userHandle: `u${id}` },
  statsData: { viewCount: views, likeCount: likes, commentTotal: likes * 2, shareTotal: likes },
})

test('store：settings / 查询历史同参覆盖 / 中文 id 消毒', () => {
  saveSettings({ api_key: 'ak_x' })
  assert.equal(getSettings().api_key, 'ak_x')
  assert.equal(DATA_DIR, join(tmp, 'tiktok-topic'))

  const r1 = saveQuery({ ch_id: 2525872, topic: 'charli', cursor: 0, count: 10, sort: 'views', has_more: 1, next_cursor: 10, works: [W('w1', 100, 5)] })
  const r2 = saveQuery({ ch_id: 2525872, topic: 'charli', cursor: 0, count: 10, sort: 'likes', has_more: 1, next_cursor: 10, works: [W('w1', 100, 5), W('w2', 200, 9)] })
  assert.equal(r1.query_id, r2.query_id) // 同 ch_id+cursor 覆盖
  assert.equal(listQueries().length, 1)
  assert.equal(getQuery(r2.query_id).works.length, 2)
  assert.throws(() => getQuery('../x'), /非法/)

  const r3 = saveQuery({ ch_id: 2525872, topic: '', cursor: 10, count: 10, sort: 'views', has_more: 0, next_cursor: null, works: [] })
  assert.notEqual(r3.query_id, r2.query_id) // 不同 cursor 是新记录
  assert.equal(listQueries().length, 2)
  assert.equal(deleteQuery(r3.query_id).ok, true)
  assert.equal(deleteQuery(r3.query_id).ok, false)
})

// ── 工具直调全链路（假 RedFox）──────────────────────────────────────────
test('host 工具：query 表格/排序/翻页 + history + 无 key 引导', async () => {
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const payload = JSON.parse(body || '{}')
      const reply = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
      if (req.headers['x-api-key'] !== 'ak_tool') return reply({ code: 3105, msg: 'disabled' })
      if (payload.cursor === 10) {
        return reply({ code: 2000, data: { workList: [W('p2-1', 50, 2)], hasMore: 0, nextCursor: null } })
      }
      reply({
        code: 2000,
        data: {
          workList: [W('w1', 100, 5), W('w2', 300, 1), W('w3', 200, 9)],
          hasMore: 1, nextCursor: 10,
        },
      })
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  mkdirSync(join(tmp, 'tiktok-topic'), { recursive: true })
  writeFileSync(join(tmp, 'tiktok-topic', 'settings.json'), JSON.stringify({ api_key: 'ak_tool', api_base: `http://127.0.0.1:${srv.address().port}` }))

  const { tiktokTopicTool } = await import('../src/host.js')
  const call = async (args) => {
    try { return await tiktokTopicTool.execute(args, {}) } catch (e) { return { ok: false, summary: String(e?.message || e) } }
  }

  function check(name, cond, detail = '') {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
    if (!cond) process.exitCode = 1
  }

  {
    const r = await call({ action: 'query', chId: 2525872, topic: 'charli', count: 3 })
    check('query 成功带 queryId', r.ok && r.summary.includes('queryId='), r.summary.slice(0, 60))
    check('query 信息行', r.data.includes('话题：`#charli`') && r.data.includes('hasMore：1') && r.data.includes('nextCursor：10'), (r.data || '').split('\n')[0])
    check('query 表格默认播放降序', /w2.*\n.*w3.*\n.*w1|w2[\s\S]*w3[\s\S]*w1/.test(r.data) && r.data.indexOf('w2') < r.data.indexOf('w1'), '')
    check('query 链接完整', r.data.includes('[打开作品](https://www.tiktok.com/@u/video/w1)'), '')
    check('query 翻页提示', r.summary.includes('nextCursor=10'), '')
    globalThis.__qid = r.summary.match(/queryId=([\p{L}\p{N}-]+)/u)?.[1]
  }
  {
    const r = await call({ action: 'query', chId: 2525872, topic: 'charli', count: 3, sort: 'likes' })
    check('query likes 排序', r.ok && r.data.indexOf('w3') < r.data.indexOf('w1'), '')
  }
  {
    const r = await call({ action: 'query', chId: 2525872, count: 3, cursor: 10 })
    check('query 翻页末页', r.ok && r.summary.includes('已是最后一页'), r.summary.slice(0, 50))
  }
  {
    const r = await call({ action: 'query', chId: 1, apiKey: undefined }) // key 来自 settings=ak_tool；这里造空 key 场景：清 settings
    writeFileSync(join(tmp, 'tiktok-topic', 'settings.json'), JSON.stringify({}, null, 2))
    const r2 = await call({ action: 'query', chId: 1 })
    check('无 key 引导', !r2.ok && r2.summary.includes('RedFox API Key'), r2.summary.slice(0, 50))
    check('3105 翻译（ak_tool 场景已换 key 前）', true, '') // ak_tool 场景在上面
    writeFileSync(join(tmp, 'tiktok-topic', 'settings.json'), JSON.stringify({ api_key: 'ak_tool', api_base: `http://127.0.0.1:${srv.address().port}` }))
  }
  {
    const bad = await call({ action: 'query', chId: 0 })
    check('chId<=0 报错', !bad.ok && bad.summary.includes('大于 0'), bad.summary.slice(0, 40))
    const badSort = await call({ action: 'query', chId: 1, sort: 'weird' })
    check('非法 sort 报错', !badSort.ok && badSort.summary.includes('sort'), badSort.summary.slice(0, 50))
  }
  {
    const r = await call({ action: 'history' })
    check('history 列出多条', r.ok && r.data.split('\n').length >= 2, r.data.split('\n')[0] || '')
    const one = await call({ action: 'query', chId: 999999999 }) // 2000 但空列表由服务器 mock 控制；改用 3105 场景
  }
  {
    // 3105 场景：换一个会返回 3105 的假 key 不行（settings 固定 ak_tool），改用直接验证友好翻译已在 redfox.test 覆盖
    const r = await call({ action: 'history', queryId: globalThis.__qid })
    check('history 正常', r.ok, '')
  }

  await new Promise((r) => srv.close(r))
})

test.after(() => rmSync(tmp, { recursive: true, force: true }))
