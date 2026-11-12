// 冒烟测试（离线）：假 RedFox 服务器 + 工具直调全链路 + 面板 API 全路由。
// 运行：npm run smoke
const { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const http = await import('node:http')

const tmp = mkdtempSync(join(tmpdir(), 'dsh-tt-smoke-'))
process.env.DSH_HOME = tmp
delete process.env.REDFOX_API_KEY

let failed = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  if (!cond) failed++
}

const W = (id, views, likes, handle) => ({
  workId: id, content: `作品${id}的摘要内容`, shareLink: `https://www.tiktok.com/@${handle}/video/${id}`,
  authorData: { userName: `作者${id}`, userHandle: handle },
  statsData: { viewCount: views, likeCount: likes, commentTotal: likes * 2, shareTotal: likes },
})

// ── 假 RedFox：3105 坏 key / 3203 参数 / 正常翻页两页 ──
const srv = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const payload = JSON.parse(body || '{}')
    const reply = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (req.headers['x-api-key'] === 'ak_disabled') return reply({ code: 3105, msg: 'key disabled' })
    if (payload.ch_id === 3203000) return reply({ code: 3203, msg: 'ch_id 无效' })
    if (payload.ch_id === 777) return reply({ code: 2000, data: { workList: [], hasMore: 0 } })
    if (payload.cursor === 20) {
      return reply({ code: 2000, data: { workList: [W('p2-1', 40, 1, 'late'), W('p2-2', 60, 2, 'late2')], hasMore: 0, nextCursor: null } })
    }
    reply({
      code: 2000,
      data: {
        workList: [
          W('w1', 1200000, 80000, 'creator1'),
          W('w2', 2500000, 90000, 'creator2'),
          W('w3', 900000, 120000, 'creator3'),
        ],
        hasMore: 1, nextCursor: 20,
      },
    })
  })
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
mkdirSync(join(tmp, 'tiktok-topic'), { recursive: true })
writeFileSync(join(tmp, 'tiktok-topic', 'settings.json'), JSON.stringify({ api_key: 'ak_smoke', api_base: `http://127.0.0.1:${srv.address().port}` }))

// ── 工具直调 ──
const { tiktokTopicTool } = await import('../src/host.js')
const call = async (args) => {
  try { return await tiktokTopicTool.execute(args, {}) } catch (e) { return { ok: false, summary: String(e?.message || e) } }
}
let qid1, qid2
{
  const r = await call({ action: 'query', chId: 2525872, topic: 'charli', count: 3 })
  check('query 成功', r.ok && r.summary.includes('queryId='), r.summary.slice(0, 50))
  qid1 = r.summary.match(/queryId=([\p{L}\p{N}-]+)/u)?.[1]
  check('信息行完整', r.data.includes('话题：`#charli` | ch_id：`2525872` | cursor：0 | count：3 | hasMore：1 | nextCursor：20'), (r.data || '').split('\n')[0])
  check('播放降序 w2→w1→w3', r.data.indexOf('w2') < r.data.indexOf('w1') && r.data.indexOf('w1') < r.data.indexOf('w3'), '')
  check('表格完整表头', r.data.includes('| # | 作者 | 作品 ID | 播放 | 点赞 | 评论 | 分享 | 作品链接 | 内容摘要 | 话题 |'), '')
  check('链接完整可点', r.data.includes('[打开作品](https://www.tiktok.com/@creator2/video/w2)'), '')
  check('摘要截断正常', r.data.includes('作品w1的摘要内容'), '')
  check('翻页提示', r.summary.includes('nextCursor=20'), '')
}
{
  const r = await call({ action: 'query', chId: 2525872, topic: 'charli', count: 3, sort: 'likes' })
  check('likes 排序 w3→w2→w1', r.data.indexOf('w3') < r.data.indexOf('w2') && r.data.indexOf('w2') < r.data.indexOf('w1'), '')
  qid2 = r.summary.match(/queryId=([\p{L}\p{N}-]+)/u)?.[1]
}
{
  const r = await call({ action: 'query', chId: 2525872, cursor: 20, count: 2 })
  check('翻页第二页', r.ok && r.data.includes('p2-1') && r.summary.includes('已是最后一页'), r.summary.slice(0, 40))
}
{
  const r = await call({ action: 'query', chId: 777 })
  check('空结果如实说明', !r.ok && r.summary.includes('暂无数据'), r.summary.slice(0, 50))
}
{
  const r = await call({ action: 'history' })
  // 同 ch+cursor 覆盖：cursor=0 有两次查询（views→likes）只留 1 条；777 空查与 cursor=20 各一条 → 共 3 条
  check('history 三条记录（同 ch+cursor 覆盖）', r.ok && r.data.split('\n').length === 3, `n=${r.data.split('\n').length}`)
  check('history 含 topic 标注', r.data.includes('#charli'), '')
}

// ── 面板 API ──
const { registerApi } = await import('../lib/api.js')
const { Writable } = await import('node:stream')
const { EventEmitter } = await import('node:events')
const routes = {}
registerApi({ get: () => undefined, webServer: { register: (r) => { routes[r.path] = r.handler } } }, { config: {} })
const req = async (method, path, body) => {
  const reqObj = new EventEmitter()
  reqObj.method = method
  reqObj.url = `/tiktok-topic${path}`
  reqObj.headers = body ? { 'content-type': 'application/json', host: 'x', origin: 'http://x' } : { host: 'x' }
  const chunks = []
  const resObj = new Writable({ write(c, _e, cb) { chunks.push(c); cb() } })
  resObj.statusCode = 0
  resObj.writeHead = (code) => { resObj.statusCode = code }
  const done = new Promise((resolve) => {
    const origEnd = resObj.end.bind(resObj)
    resObj.end = (...args) => { origEnd(...args); resolve({ status: resObj.statusCode, json: (() => { try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return null } })() }) }
  })
  const p = routes['/tiktok-topic'](reqObj, resObj)
  if (body) reqObj.emit('data', Buffer.from(JSON.stringify(body)))
  reqObj.emit('end')
  await p
  return done
}
{
  const cat = await req('GET', '/api/catalog')
  check('catalog：key/sorts/历史', cat.status === 200 && cat.json.has_key && cat.json.sorts.length === 5 && cat.json.queries.length >= 1, '')
  const one = await req('GET', `/api/queries/${qid1}`)
  check('query 详情', one.status === 200 && one.json.record.works.length === 3 && one.json.record.next_cursor === 20, '')
  const created = await req('POST', '/api/queries', { chId: 2525872, topic: '面板查', count: 3, sort: 'likes', cursor: 0 })
  check('面板直查', created.status === 200 && created.json.ok && created.json.record.works.length === 3, `n=${created.json?.record?.works?.length}`)
  const badCh = await req('POST', '/api/queries', { chId: -1 })
  check('chId 校验 400', badCh.status === 400, String(badCh.json?.error || '').slice(0, 40))
  const badSort = await req('POST', '/api/queries', { chId: 1, sort: 'weird' })
  check('非法 sort 落 views 兜底', badSort.status === 200 && badSort.json.ok, '')
  const del = await req('DELETE', `/api/queries/${qid2}`)
  check('面板删记录', del.status === 200 && del.json.ok, '')
}
{
  const st = await req('GET', '/api/settings')
  check('settings GET 尾号', st.status === 200 && st.json.settings.has_key && st.json.settings.key_tail === '_smoke', String(st.json.settings.key_tail))
  const bad = await req('POST', '/api/settings', { api_key: 'no-prefix' })
  check('settings 非 ak_ 拒绝', bad.status === 400, '')
}
{
  const idx = readFileSync(new URL('../lab/index.html', import.meta.url), 'utf8')
  check('lab 引用 scheme/app', idx.includes('app.js') && idx.includes('scheme.js'), '')
  const appjs = readFileSync(new URL('../lab/app.js', import.meta.url), 'utf8')
  check('lab 消息类型与 client 对齐', appjs.includes('tiktok-topic:refresh') && appjs.includes('tiktok-topic:start-ok'), '')
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  check('client 消息类型一致', client.includes('tiktok-topic:refresh') && client.includes('tiktok-topic:start-ok'), '')
}

srv.close()
rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
