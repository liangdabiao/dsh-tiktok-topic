// 真实网络冒烟：无 SNI 传输主路径查一个真实话题（charlidamelio ch_id=2525872），10 条播放降序。
//   DSH_HOME=<目录> node scripts/live.mjs [chId] [topic] [ak_xxx]
// key 优先级：命令行第三参 > 数据目录 settings.json > 环境变量 REDFOX_API_KEY。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [, , chIdArg, topicArg, keyArg] = process.argv
const chId = Number(chIdArg) || 2525872
const topic = topicArg || 'charlidamelio'
const home = process.env.DSH_HOME || join(process.env.HOME || process.env.USERPROFILE, '.dsh')

if (keyArg) {
  mkdirSync(join(home, 'tiktok-topic'), { recursive: true })
  writeFileSync(join(home, 'tiktok-topic', 'settings.json'), JSON.stringify({ api_key: keyArg }, null, 2))
  console.log('API key 已写入 settings.json')
}
const { getSettings } = await import('../lib/store.js')
if (!getSettings().api_key && !process.env.REDFOX_API_KEY) {
  console.error('缺少 RedFox API Key：node scripts/live.mjs <chId> <topic> ak_xxx')
  process.exit(1)
}

const { tiktokTopicTool } = await import('../src/host.js')
const call = (args) => tiktokTopicTool.execute(args, {})

console.log(`真实查询（无 SNI 主路径）：ch_id=${chId}（#${topic}）count=10 播放降序`)
const t0 = Date.now()
const r = await call({ action: 'query', chId, topic, count: 10, sort: 'views' })
console.log(`\n[${Math.round((Date.now() - t0) / 1000)}s] ${r.summary}`)
if (r.data) console.log('\n' + r.data)
