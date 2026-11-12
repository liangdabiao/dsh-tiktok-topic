// TikTok 话题雷达 · Host 半边（tiktok_topic 原生工具 + 技能提供方 + 硬规则注入 + 面板数据面）。
// 单接口同步查询：query 秒回；排序/渲染在本地完成；翻页由用户显式触发（积分保护）。
import Schema from '@deepseek-ai/schemastery'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSkillProvider } from '../lib/skills.js'
import { systemSection } from './systemPrompt.js'
import { registerApi } from '../lib/api.js'
import { fetchTopicWorks, resolveApiKey, resolveApiBase, SORT_KEYS, API_KEY_REMINDER } from '../lib/redfox.js'
import { saveQuery, getQuery, listQueries, deleteQuery, getSettings } from '../lib/store.js'

export const name = 'tiktok-topic' // = cordis.patch.yml 的 id

export const inject = ['tools', 'skills', 'systemPrompt', 'webServer', 'connection']

export const Config = Schema.object({
  injectRules: Schema.boolean().default(true).description('注入 TikTok 话题雷达工作流到系统提示'),
  apiKey: Schema.string().default('').description('RedFox API Key（ak_ 开头；留空读面板设置或环境变量 REDFOX_API_KEY）'),
  noSni: Schema.boolean().default(true).description('无 SNI 传输（redfox.hk 该接口实测需要；失败自动回退常规 https）'),
})

function check(args, spec) {
  const problems = []
  for (const key of spec.required || []) {
    if (args?.[key] === undefined) problems.push(`缺少必填参数 ${key}`)
  }
  for (const [key, rule] of Object.entries(spec.properties || {})) {
    const value = args?.[key]
    if (value === undefined) continue
    if (rule.enum && !rule.enum.includes(value)) problems.push(`${key} 只能是 ${rule.enum.join(' / ')} 之一`)
  }
  for (const key of Object.keys(args || {})) {
    if (!spec.properties || !(key in spec.properties)) problems.push(`未知参数 ${key}`)
  }
  if (problems.length) throw new Error(`参数有误：${problems.join('；')}。`)
}

const str = (description, extra = {}) => ({ type: 'string', description, ...extra })
const num = (description, extra = {}) => ({ type: 'number', description, ...extra })
const text = (value) => [{ type: 'text', text: value }]

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['ok', 'summary'],
    properties: {
      ok: { type: 'boolean' },
      summary: { type: 'string', description: '给模型看的回执' },
      data: { type: 'string', description: '可选：作品 Markdown 表格' },
    },
  },
  render: (_args, value) => text(value.data ? `${value.summary}\n\n${value.data}` : value.summary),
}

const result = (ok, summary, data = '') => ({ ok, summary, data })

const fmtNum = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n.toLocaleString('en-US') : '0'
}
const escMd = (v) => String(v ?? '').replace(/\n/g, ' ').replace(/\|/g, '\\|').trim()
const summarize = (v, limit = 72) => {
  const s = escMd(v)
  return s.length <= limit ? s : s.slice(0, limit - 3) + '...'
}

// 上游 render_table 同款
function renderTable(topic, works) {
  const lines = [
    '| # | 作者 | 作品 ID | 播放 | 点赞 | 评论 | 分享 | 作品链接 | 内容摘要 | 话题 |',
    '|---:|---|---|---:|---:|---:|---:|---|---|---|',
  ]
  works.forEach((work, i) => {
    const author = work.authorData || {}
    const stats = work.statsData || {}
    const authorCell = author.userHandle ? `${escMd(author.userName)} / \`${escMd(author.userHandle)}\`` : escMd(author.userName)
    const linkCell = work.shareLink ? `[打开作品](${work.shareLink})` : '暂无链接'
    lines.push(
      `| ${i + 1} | ${authorCell} | \`${escMd(work.workId)}\` | ${fmtNum(stats.viewCount)} | ${fmtNum(stats.likeCount)} | ${fmtNum(stats.commentTotal)} | ${fmtNum(stats.shareTotal)} | ${linkCell} | ${summarize(work.content)} | \`${escMd(topic)}\` |`,
    )
  })
  return lines.join('\n')
}

function sortWorks(works, sortName) {
  const key = SORT_KEYS[sortName]
  if (!key) return works
  return [...works].sort((a, b) => ((b.statsData || {})[key] || 0) - ((a.statsData || {})[key] || 0))
}

function displayTopic(topic, chId) {
  const t = String(topic || '').trim()
  if (t) return t.startsWith('#') ? t : `#${t}`
  return `ch_id:${chId}`
}

// resolve queryId 缺省 = 最新一条
function resolveQuery(qid) {
  if (qid) {
    const q = getQuery(qid)
    if (!q) throw new Error(`查询记录不存在：${qid}。用 history 查看。`)
    return q
  }
  const [latest] = listQueries({ limit: 1 })
  if (!latest) throw new Error('还没有查询记录。先 query（chId 必填）。')
  return getQuery(latest.query_id)
}

// ---------------------------------------------------------------------------
// 工具：tiktok_topic —— query / history
// ---------------------------------------------------------------------------
export const tiktokTopicTool = {
  name: 'tiktok_topic',
  description:
    'TikTok 话题雷达：按 TikTok 话题 ID（challengeId/hashtagId）查询话题下作品列表，' +
    '返回播放/点赞/评论/分享核心数据 + 完整作品链接，默认播放数降序，可切换点赞/评论/分享排序，游标翻页。' +
    '同步秒回。积分保护：未经用户明确要求不主动翻页、不批量查多个话题。' +
    '需要 RedFox API Key（面板「设置」页或环境变量 REDFOX_API_KEY）。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: str('query 查询话题作品；history 查询历史', { enum: ['query', 'history'] }),
      chId: num('query：TikTok 话题 ID（challengeId/hashtagId），大于 0 的整数'),
      topic: str('query：话题名称（仅展示用，如 charlidamelio，自动加 # 前缀）'),
      cursor: num('query：分页游标，首页 0；翻页用上一页返回的 nextCursor'),
      count: num('query：每页条数，默认 10'),
      sort: str('query：排序 views(默认)/likes/comments/shares/none', { enum: Object.keys(SORT_KEYS) }),
      queryId: str('history 里定位历史查询；翻页场景也可用于「对上次查询按新排序重排」'),
      limit: num('history：最多返回条数，默认 20'),
    },
  },
  output: OUTPUT,
  async execute(args, ctxConfig) {
    check(args, this.parameters)
    const cfg = ctxConfig || {}

    // ── query ────────────────────────────────────────────────────────────
    if (args.action === 'query') {
      if (args.chId === undefined) throw new Error('query 需要 chId（TikTok 话题 ID，大于 0 的整数）。')
      const chId = Number(args.chId)
      const cursor = Number(args.cursor) || 0
      const count = Math.min(Math.max(Number(args.count) || 10, 1), 50)
      const sort = args.sort || 'views'
      const settings = getSettings()
      const apiKey = resolveApiKey({ settings, config: cfg })
      if (!apiKey) {
        return result(false, `未配置 RedFox API Key。请用户到面板「TikTok 话题雷达 → 设置」填入，或在插件配置/环境变量 REDFOX_API_KEY 里配置。${API_KEY_REMINDER}`)
      }
      const data = await fetchTopicWorks({
        chId, cursor, count, apiKey, apiBase: resolveApiBase({ settings }), noSni: cfg.noSni !== false,
      })
      const works = Array.isArray(data.workList) ? data.workList : []
      const topic = displayTopic(args.topic, chId)
      const sorted = sortWorks(works, sort)
      const record = saveQuery({
        ch_id: chId,
        topic: String(args.topic || '').trim(),
        cursor,
        count,
        sort,
        has_more: data.hasMore,
        next_cursor: data.nextCursor ?? null,
        works: sorted,
      })
      const infoLine = `话题：\`${topic}\` | ch_id：\`${chId}\` | cursor：${cursor} | count：${sorted.length} | hasMore：${data.hasMore} | nextCursor：${data.nextCursor ?? '—'}`
      if (!works.length) {
        return result(false,
          `暂无数据（${infoLine}）。如实告知用户，不自动改查其他话题；可建议换更热门的话题 ID 或确认 ch_id 是否正确。`,
          infoLine)
      }
      const sortNote = sort === 'none' ? '（接口原始顺序）' : `（按 ${({ views: '播放', likes: '点赞', comments: '评论', shares: '分享' })[sort]}降序）`
      return result(true,
        `查询成功${sortNote}（queryId=${record.query_id}）。按 Markdown 表格完整输出作品列表（保留链接完整可点击）+ 上面分页信息行，末尾附「${API_KEY_REMINDER}」。` +
        (data.hasMore ? `用户要翻页时用 nextCursor=${data.nextCursor} 继续查询（不要主动翻页）。` : '已是最后一页。'),
        infoLine + '\n\n' + renderTable(topic, sorted))
    }

    // ── history ──────────────────────────────────────────────────────────
    if (args.action === 'history') {
      const list = listQueries({ limit: Math.min(Number(args.limit) || 20, 100) })
      if (!list.length) return result(false, '还没有查询记录。先 query。')
      const lines = list.map((r) =>
        `${r.query_id}｜ch_id ${r.ch_id}${r.topic ? `（#${r.topic}）` : ''}｜cursor=${r.cursor}｜${r.count} 条｜hasMore=${r.has_more}`)
      return result(true, `共 ${list.length} 次查询（新→旧）。对旧记录重排/复述传 queryId；翻页直接用上次返回的 nextCursor 发起 query。`, lines.join('\n'))
    }

    throw new Error(`未知 action：${args.action}`)
  },
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------
export function apply(ctx, config) {
  const skillDirs = [join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')]

  const toolWithConfig = { ...tiktokTopicTool, execute(args) { return tiktokTopicTool.execute(args, config) } }

  ctx.effect(() => ctx.tools.register(toolWithConfig), `${name}: tool`)
  ctx.effect(() => ctx.skills.registerProvider(() => createSkillProvider(skillDirs)), `${name}: skills`)
  if (config.injectRules !== false) {
    ctx.effect(() => ctx.systemPrompt.section(systemSection()), `${name}: workflow`)
  }
  ctx.effect(() => registerApi(ctx, { config }), `${name}: routes`)
}
