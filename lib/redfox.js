// RedFox API · TikTok topicAwemeList 适配器。
// 移植自 tiktok-topic-aweme-list fetch_topic_aweme_list.py，关键差异：
// 上游用「无 SNI」的裸 socket+SSL（server_hostname=None，保留证书链校验、关 hostname 检查）——
// Node 侧用 tls.connect({ servername: '' }) 等价实现；保留带回退的常规 HTTPS 路径。
import tls from 'node:tls'
import { DEFAULT_API_BASE_TOKENS } from './common.js'

export const HOST = 'redfox.hk'
export const ENDPOINT = '/story/api/tiktok/ability/topicAwemeList'
export const SOURCE = '获取TikTok指定话题作品数据-dsh'
export const API_KEY_REMINDER = '获取 API Key：前往 https://redfox.hk/settings/api-keys?source=github'

export const SORT_KEYS = {
  none: null,
  views: 'viewCount',
  likes: 'likeCount',
  comments: 'commentTotal',
  shares: 'shareTotal',
}
export function resolveApiKey({ settings = {}, config = {} } = {}) {
  return String(config.apiKey || settings.api_key || process.env.REDFOX_API_KEY || '').trim()
}

export function resolveApiBase({ settings = {} } = {}) {
  const base = String(settings.api_base || process.env.REDFOX_API_BASE || '').trim()
  return (base || 'https://redfox.hk').replace(/\/+$/, '')
}

// ── 无 SNI TLS 请求（上游主路径）───────────────────────────────────────
// Node tls.connect 的 servername 传空串 = ClientHello 不带 SNI 扩展；
// 保留证书链校验（rejectUnauthorized 默认 true），仅关 hostname 匹配——与上游语义一致。
function tlsRequestNoSni({ host, port = 443, method = 'POST', path, headers = {}, body = null, timeout = 30000 }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      servername: '', // 关键：不发 SNI
      checkServerIdentity: () => undefined, // 保留证书链校验，仅关闭主机名检查（无 SNI 时主机名无法匹配）
      timeout,
    })
    const chunks = []
    let headerDone = false
    let headerBuf = Buffer.alloc(0)

    socket.on('secureConnect', () => {
      const payload = body ? Buffer.from(body, 'utf8') : null
      const req = [
        `${method} ${path} HTTP/1.1`,
        `Host: ${host}`,
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      ]
      if (payload) req.push(`Content-Length: ${payload.length}`)
      req.push('Connection: close', '', '')
      socket.write(req.join('\r\n') + '\r\n')
      if (payload) socket.write(payload)
    })
    socket.on('data', (c) => {
      if (headerDone) { chunks.push(c); return }
      headerBuf = Buffer.concat([headerBuf, c])
      const sep = headerBuf.indexOf('\r\n\r\n')
      if (sep === -1) return
      headerDone = true
      chunks.push(headerBuf.subarray(sep + 4))
    })
    socket.on('close', () => {
      const raw = Buffer.concat(chunks)
      // HTTP/1.1 close 模式下若响应带 chunked 编码，简单解码（无需 content-length）
      const text = decodeMaybeChunked(raw.toString('utf8'))
      resolve(text)
    })
    socket.on('timeout', () => socket.destroy(new Error(`请求超时（${timeout}ms）`)))
    socket.on('error', reject)
  })
}

// 极简 chunked 解码（只处理标准 hex-size + CRLF + data 形态）
function decodeMaybeChunked(raw) {
  const m = raw.match(/^[\s\S]*?\r\n\r\n/)
  if (!m) return raw
  const header = m[0]
  if (!/transfer-encoding:\s*chunked/i.test(header)) return raw
  let body = raw.slice(m[0].length)
  const out = []
  for (;;) {
    const lineEnd = body.indexOf('\r\n')
    if (lineEnd === -1) break
    const size = parseInt(body.slice(0, lineEnd).split(';')[0], 16)
    if (!Number.isFinite(size)) break
    if (size === 0) break
    out.push(body.slice(lineEnd + 2, lineEnd + 2 + size))
    body = body.slice(lineEnd + 2 + size + 2)
  }
  return header + out.join('')
}

function extractStatus(header) {
  const first = header.split('\r\n', 1)[0] || ''
  const m = first.match(/HTTP\/[\d.]+\s+(\d{3})/)
  return m ? Number(m[1]) : 0
}

function splitResponse(raw) {
  const sep = raw.indexOf('\r\n\r\n')
  if (sep === -1) return { status: 0, header: '', body: raw }
  return { status: extractStatus(raw.slice(0, sep)), header: raw.slice(0, sep), body: raw.slice(sep + 4) }
}

// ── 错误码翻译 ─────────────────────────────────────────────────────────
export function friendlyApiError(json) {
  const code = json?.code
  const msg = String(json?.msg || json?.message || '')
  if (code === 3105) return new Error(`API Key 已被禁用（3105）：请更换有效的 RedFox API Key。${API_KEY_REMINDER}`)
  if (code === 3201 || msg.includes('积分不足')) return new Error(`RedFox 账户积分不足（3201）：请到 https://redfox.hk/dashboard/recharge 充值后重试。`)
  if (code === 3203) return new Error(`参数校验失败（3203）：${msg || '按提示修正 ch_id/cursor/count'}（该错误通常提示积分未扣除）`)
  if (code === 3108) return new Error('RedFox 限频（3108），稍等片刻再试。')
  if (code === 401 || code === 403) return new Error(`RedFox 鉴权失败（${code}）：请检查面板「设置」页的 API Key。`)
  return new Error(`接口返回异常：code=${code ?? '?'}${msg ? `，${msg}` : ''}`)
}

// ── 查询（主路径无 SNI，回退常规 https）────────────────────────────────
export async function fetchTopicWorks({ chId, cursor = 0, count = 10, apiKey, apiBase, timeout = 30000, noSni = true } = {}) {
  if (!apiKey) {
    throw new Error(`未配置 RedFox API Key。请到面板「设置」页填入，或在插件配置/环境变量 REDFOX_API_KEY 里配置（${API_KEY_REMINDER}）。`)
  }
  if (!Number.isInteger(chId) || chId <= 0) throw new Error('ch_id 必须为大于 0 的整数')
  if (!Number.isInteger(cursor) || cursor < 0) throw new Error('cursor 不能小于 0')
  if (!Number.isInteger(count) || count <= 0) throw new Error('count 必须大于 0')

  const payload = JSON.stringify({ ch_id: chId, cursor, count, source: SOURCE })
  const headers = {
    'X-API-KEY': apiKey,
    'Content-Type': 'application/json',
  }

  // 自定义 apiBase（测试用）：走普通 https/http
  const base = apiBase || DEFAULT_API_BASE_TOKENS
  if (base !== DEFAULT_API_BASE_TOKENS) {
    const { statusText, json } = await postViaNodeHttp(base, ENDPOINT, payload, headers, timeout)
    return checkJson(json, statusText)
  }

  if (noSni) {
    try {
      const raw = await tlsRequestNoSni({ host: HOST, path: ENDPOINT, headers, body: payload, timeout })
      const { status, body: respBody } = splitResponse(raw)
      if (status !== 200) throw new Error(`HTTP 请求失败：HTTP ${status}`)
      let json
      try {
        json = JSON.parse(respBody)
      } catch (err) {
        throw new Error(`响应不是有效 JSON：${String(err.message).slice(0, 200)}`)
      }
      return checkJson(json, `HTTP ${status}`)
    } catch (err) {
      if (err instanceof SyntaxError || /响应不是有效 JSON/.test(String(err?.message))) throw err
      // 无 SNI 路径网络层失败 → 回退常规 https 一次
      const fb = await postViaNodeHttp(`https://${HOST}`, ENDPOINT, payload, headers, timeout)
      return checkJson(fb.json, fb.statusText)
    }
  }
  const fb = await postViaNodeHttp(`https://${HOST}`, ENDPOINT, payload, headers, timeout)
  return checkJson(fb.json, fb.statusText)
}

function checkJson(json, statusText) {
  if (!json || typeof json !== 'object') throw new Error(`响应不是有效 JSON（${statusText}）`)
  if (json.code !== 2000) throw friendlyApiError(json)
  return json.data || {}
}

// 常规 Node 传输（apiBase 自定义 / 回退路径）
async function postViaNodeHttp(base, endpoint, payload, headers, timeout) {
  const http = await import('node:http')
  const https = await import('node:https')
  const u = new URL(`${base.replace(/\/+$/, '')}${endpoint}`)
  const transport = u.protocol === 'http:' ? http.default : https.default
  const body = Buffer.from(payload, 'utf8')
  return await new Promise((resolve, reject) => {
    const req = transport.request({
      host: u.hostname,
      port: Number(u.port) || (u.protocol === 'http:' ? 80 : 443),
      method: 'POST',
      path: `${u.pathname}${u.search}`,
      headers: { ...headers, 'content-length': body.length },
      timeout,
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        try {
          resolve({ statusText: `HTTP ${res.statusCode}`, json: JSON.parse(text) })
        } catch {
          reject(new Error(`响应不是合法 JSON（HTTP ${res.statusCode}）：${text.slice(0, 200)}`))
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(timeout, () => req.destroy(new Error(`请求超时（${timeout}ms）`)))
    req.end(body)
  })
}
