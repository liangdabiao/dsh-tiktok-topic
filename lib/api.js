// 面板数据面：/tiktok-topic 前缀路由（查询执行 + 历史 + 设置；表格渲染在面板直出）。
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listQueries, deleteQuery, getSettings, saveSettings, getQuery, DATA_DIR } from './store.js'
import { fetchTopicWorks, resolveApiKey, resolveApiBase, SORT_KEYS } from './redfox.js'

const BASE = '/tiktok-topic'
const LAB = fileURLToPath(new URL('../lab/', import.meta.url))

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2',
}

function json(res, statusCode, value) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

export function requestRejection(ctx, req) {
  const connection = ctx.get('connection')
  if (typeof connection?.requestRejection !== 'function') return false // dsh 0.2.x 宿主已 token 鉴权
  return connection.requestRejection({ headers: req.headers })
}

function safeFile(dir, rel) {
  if (!dir || String(rel).split('/').some((p) => p.startsWith('.'))) return null
  let base
  try { base = realpathSync(dir) } catch { return null }
  const file = normalize(join(base, rel))
  if (!file.startsWith(base + sep) || !existsSync(file)) return null
  const real = realpathSync(file)
  return real.startsWith(base + sep) && statSync(real).isFile() ? real : null
}

function serveFile(req, res, file) {
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': statSync(file).size,
    'cache-control': 'no-cache',
  })
  if (req.method === 'HEAD') return res.end()
  createReadStream(file).pipe(res)
}

function readJson(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const origin = req.headers.origin
    if (req.method !== 'POST') return reject(Object.assign(new Error('method'), { status: 405 }))
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return reject(Object.assign(new Error('type'), { status: 415 }))
    if (origin && origin.replace(/^https?:\/\//, '') !== req.headers.host) return reject(Object.assign(new Error('origin'), { status: 403 }))
    let size = 0
    const chunks = []
    req.on('data', (c) => { size += c.length; if (size > max) req.destroy(); else chunks.push(c) })
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch (e) { reject(Object.assign(e, { status: 400 })) } })
    req.on('error', reject)
  })
}

function readVersion() {
  try { return JSON.parse(readFileSync(join(LAB, '..', 'package.json'), 'utf8')).version } catch { return '' }
}

function catalog() {
  const settings = getSettings()
  return {
    version: readVersion(),
    dataDir: DATA_DIR,
    has_key: Boolean(settings.api_key || process.env.REDFOX_API_KEY),
    key_source: settings.api_key ? 'settings' : (process.env.REDFOX_API_KEY ? 'env' : 'none'),
    sorts: Object.keys(SORT_KEYS),
    queries: listQueries({ limit: 50 }),
    settings: { api_base: settings.api_base || '' },
  }
}

// 面板/工具共用：执行一次查询（落历史）
async function runQuery(body, hooks) {
  const chId = Number(body.chId)
  if (!Number.isInteger(chId) || chId <= 0) throw Object.assign(new Error('chId 必须为大于 0 的整数'), { status: 400 })
  const cursor = Number(body.cursor) || 0
  const count = Math.min(Math.max(Number(body.count) || 20, 1), 50)
  const sort = SORT_KEYS.hasOwnProperty(body.sort) ? body.sort : 'views'
  const settings = getSettings()
  const apiKey = resolveApiKey({ settings, config: hooks.config })
  if (!apiKey) throw Object.assign(new Error('未配置 RedFox API Key（设置页或插件配置/环境变量 REDFOX_API_KEY）'), { status: 400 })
  const data = await fetchTopicWorks({ chId, cursor, count, apiKey, apiBase: resolveApiBase({ settings }), noSni: hooks.config?.noSni !== false })
  const works = Array.isArray(data.workList) ? data.workList : []
  const sortKey = SORT_KEYS[sort]
  const sorted = sortKey ? [...works].sort((a, b) => ((b.statsData || {})[sortKey] || 0) - ((a.statsData || {})[sortKey] || 0)) : works
  const { saveQuery } = await import('./store.js')
  const record = saveQuery({
    ch_id: chId, topic: String(body.topic || '').trim(), cursor, count, sort,
    has_more: data.hasMore, next_cursor: data.nextCursor ?? null, works: sorted,
  })
  return record
}

export function registerApi(ctx, hooks = {}) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: BASE,
    async handler(req, res) {
      try {
        const rejection = requestRejection(ctx, req)
        if (typeof rejection === 'number') return json(res, rejection, { error: '未授权' })

        const url = new URL(req.url, 'http://x')
        if (!url.pathname.startsWith(BASE + '/') && url.pathname !== BASE) return json(res, 404, { error: 'not found' })
        const path = decodeURIComponent(url.pathname.slice(BASE.length)) || '/'

        if (path === '/api/catalog' && req.method === 'GET') return json(res, 200, catalog())

        if (path === '/api/queries' && req.method === 'GET') return json(res, 200, { queries: listQueries({ limit: 100 }) })

        if (path === '/api/queries' && req.method === 'POST') {
          try {
            const body = await readJson(req)
            const record = await runQuery(body, hooks)
            return json(res, 200, { ok: true, record })
          } catch (e) { return json(res, e.status || 400, { ok: false, error: e.message }) }
        }

        const qMatch = path.match(/^\/api\/queries\/([^/]+)$/)
        if (qMatch) {
          const qid = qMatch[1]
          if (req.method === 'GET') {
            const q = getQuery(qid)
            if (!q) return json(res, 404, { error: `查询记录不存在: ${qid}` })
            return json(res, 200, { record: q })
          }
          if (req.method === 'DELETE') return json(res, 200, deleteQuery(qid))
          return json(res, 405, { error: 'method' })
        }

        if (path === '/api/settings' && req.method === 'GET') {
          const settings = getSettings()
          const key = String(settings.api_key || '')
          return json(res, 200, {
            settings: {
              has_key: Boolean(key || process.env.REDFOX_API_KEY),
              key_tail: key ? key.slice(-6) : '',
              from_env: Boolean(process.env.REDFOX_API_KEY),
              api_base: settings.api_base || '',
            },
          })
        }
        if (path === '/api/settings' && req.method === 'POST') {
          try {
            const body = await readJson(req)
            const patch = {}
            if (body.api_key !== undefined) {
              const key = String(body.api_key).trim()
              if (key && !key.startsWith('ak_')) return json(res, 400, { ok: false, error: 'RedFox API Key 以 ak_ 开头，请检查' })
              patch.api_key = key
            }
            if (body.api_base !== undefined) patch.api_base = String(body.api_base).trim()
            const next = saveSettings(patch)
            return json(res, 200, { ok: true, has_key: Boolean(next.api_key || process.env.REDFOX_API_KEY) })
          } catch (e) { return json(res, e.status || 400, { ok: false, error: e.message }) }
        }
        if (path.startsWith('/api/')) return json(res, 404, { error: 'not found' })

        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method' })
        const file = safeFile(LAB, path === '/' ? 'index.html' : path.replace(/^\/+/, ''))
        return file ? serveFile(req, res, file) : json(res, 404, { error: 'not found' })
      } catch (err) {
        json(res, 500, { error: err?.message || '内部错误' })
      }
    },
  })
}
