// 开发预览：把 TikTok 话题雷达面板跑在独立 http 服务上（复用 lib/api.js 路由 + 真实数据）。
//   DSH_HOME=<数据目录> node scripts/devserver.mjs [port]   默认 5181
import { createServer } from 'node:http'
import { registerApi } from '../lib/api.js'

const port = Number(process.argv[2]) || 5181
const routes = {}
const fakeCtx = { get: () => undefined, webServer: { register: (r) => { routes[r.path] = r.handler } } }
registerApi(fakeCtx, { config: {} })

createServer(async (req, res) => {
  try {
    await routes['/tiktok-topic'](req, res)
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: e.message }))
  }
}).listen(port, () => console.log(`[dev] http://127.0.0.1:${port}/tiktok-topic/  (DSH_HOME=${process.env.DSH_HOME || '~/.dsh'})`))
