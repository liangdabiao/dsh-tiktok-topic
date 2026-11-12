// TikTok 话题雷达 · 数据层。
//   $DSH_HOME/tiktok-topic/
//   ├── settings.json            api_key / api_base(测试用)
//   ├── queries/index.json       查询历史索引（新→旧）
//   └── queries/<qid>/raw.json   单次查询的响应快照（作品列表 + 分页信息）
// 原子写与 cn30 同款（tmp + rename）。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, normalize } from 'node:path'

export const DATA_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'tiktok-topic')
const QUERIES_DIR = join(DATA_DIR, 'queries')
const INDEX_FILE = join(QUERIES_DIR, 'index.json')
const SETTINGS_FILE = join(DATA_DIR, 'settings.json')

const nowIso = () => new Date().toISOString()

function readJson(file, fallback = null) {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  mkdirSync(QUERIES_DIR, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

// ── 设置 ───────────────────────────────────────────────────────────────
export function getSettings() {
  return readJson(SETTINGS_FILE, {}) || {}
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch, updated_at: nowIso() }
  writeJson(SETTINGS_FILE, next)
  return next
}

// ── 查询历史 ───────────────────────────────────────────────────────────
function queryDir(qid) {
  const safe = String(qid).replace(/[^\p{L}\p{N}_-]+/gu, '')
  if (!safe || safe !== String(qid)) throw new Error('非法查询 id')
  const dir = join(QUERIES_DIR, safe)
  if (normalize(dir) !== normalize(join(QUERIES_DIR, safe))) throw new Error('非法查询 id')
  return dir
}

function makeQueryId(chId, cursor) {
  const ts = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}${String(ts.getMilliseconds()).padStart(3, '0')}-ch${chId}-c${cursor}`
}

export function saveQuery(data) {
  // 同一 ch_id+cursor 的重复查询覆盖旧记录（历史保持简洁，回填 cursor 场景常见）
  const prev = getQueryIndex().find((i) => i.ch_id === data.ch_id && i.cursor === data.cursor)
  const qid = prev ? prev.query_id : makeQueryId(data.ch_id, data.cursor)
  const dir = queryDir(qid)
  mkdirSync(dir, { recursive: true })
  const record = { ...data, query_id: qid, queried_at: nowIso() }
  writeJson(join(dir, 'raw.json'), record)
  const index = getQueryIndex().filter((i) => i.query_id !== qid)
  index.unshift({ query_id: qid, ch_id: data.ch_id, topic: data.topic || '', cursor: data.cursor, count: data.works?.length || 0, has_more: data.has_more, queried_at: record.queried_at })
  writeJson(INDEX_FILE, index.slice(0, 200))
  return record
}

function getQueryIndex() {
  return readJson(INDEX_FILE, []) || []
}

export function listQueries({ limit = 50 } = {}) {
  return getQueryIndex().slice(0, limit)
}

export function getQuery(qid) {
  return readJson(join(queryDir(qid), 'raw.json'))
}

export function deleteQuery(qid) {
  const dir = queryDir(qid)
  if (!existsSync(dir)) return { ok: false, error: `查询记录不存在: ${qid}` }
  rmSync(dir, { recursive: true, force: true })
  writeJson(INDEX_FILE, getQueryIndex().filter((i) => i.query_id !== qid))
  return { ok: true }
}
