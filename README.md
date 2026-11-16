# dsh-tiktok-topic · TikTok 话题雷达

DeepSeek Harness（dsh）插件：**按 TikTok 话题 ID 查询话题下作品列表**。播放/点赞/评论/分享核心数据 + 完整作品链接，默认播放数降序，支持点赞/评论/分享排序切换与游标翻页，侧栏看板。

移植自 [redfox-data/redfox-community](https://github.com/redfox-data/redfox-community) 的 `skills/tiktok-topic-aweme-list`（Python 脚本重写为 Node 原生，**零 Python 依赖**；渲染规则、错误处理与积分保护原则完整保留）。
<img width="2478" height="1170" alt="image" src="https://github.com/user-attachments/assets/e833f201-0251-48ad-a21d-699199047372" />


## 安装

```bash
dsh plugin --profile web add https://github.com/liangdabiao/dsh-tiktok-topic
```

## 功能

- 🔍 **话题作品查询**：输入话题 ID（challengeId / hashtagId），同步秒回该话题下作品
- 📊 **核心指标齐全**：播放 / 点赞 / 评论 / 分享，Markdown 表格与面板表格双形态
- 🔗 **链接完整直达**：使用接口返回的完整 `shareLink`，不自行拼接
- ↕️ **多维度排序**：默认播放降序，本地重排不重复消耗积分
- 📄 **游标翻页**：`nextCursor` 显式续查（面板翻页按钮明确标注「消耗积分」）

**积分保护**（上游原则）：每次成功查询可能消耗积分——插件与 agent 都不会主动翻页或批量查询多个话题，必须用户明确要求。

## 工作流

```
tiktok_topic(action="query", chId=2525872, topic="charlidamelio", sort="views", count=10)
  → 信息行（话题/ch_id/cursor/count/hasMore/nextCursor）+ Markdown 作品表格
  → 用户说「看下一页」→ cursor=nextCursor 继续查
  → history 查询历史；对旧记录复述传 queryId
```

只给 TikTok 作品链接没有话题 ID？agent 会先从作品页内嵌 JSON 的 `challenges`/`textExtra` 提取话题 ID；提取不到则如实说明「暂无话题 ID」，不改查其他话题。

## 传输实现（本插件的真技术点）

redfox.hk 该接口在部分网络环境下需要**无 SNI 的 TLS 连接**（上游 Python 用 `server_hostname=None` 的裸 socket+SSL）。Node 侧等价实现：

- `tls.connect({ servername: '' })` —— ClientHello 不带 SNI 扩展
- 保留证书链校验（`rejectUnauthorized` 默认 true），仅关闭主机名匹配（无 SNI 时主机名无法匹配，与上游 `check_hostname=False` 语义一致）
- 自带极简 chunked 解码（HTTP/1.1 close 模式）
- 无 SNI 路径网络层失败时**自动回退**常规 https 一次

2026-11-12 实测：无 SNI 主路径直连成功，27 秒返回 `#charlidamelio` 真实作品数据；该接口**免费积分可用**。

## 配置

**RedFox API Key**（必需，`ak_` 开头）：[红狐 hub](https://redfox.hk/settings/api-keys?source=github) 获取。优先级：插件配置 `apiKey` > 面板「设置」页 > 环境变量 `REDFOX_API_KEY`。

## 开发

```bash
npm i
npm run build      # client.js → dist/client.js
npm test           # 8 个单测（错误码翻译/参数校验/常规传输/排序与话题语义）
npm run smoke      # 离线冒烟：本地假 RedFox 服务器全链路（工具 + 面板 API）
npm run live       # 真实 API 冒烟：node scripts/live.mjs <chId> <topic> ak_xxx（无 SNI 主路径）
npm run dev        # 面板独立预览：DSH_HOME=<目录> node scripts/devserver.mjs 5181
```

数据落在 `$DSH_HOME/tiktok-topic/`：`settings.json` + `queries/<qid>/raw.json`（同 ch_id+cursor 覆盖，历史保持简洁），原子写（tmp+rename）。

## 结构

```
src/host.js            tiktok_topic 工具（query/history）+ 装配 + 表格渲染
src/systemPrompt.js    工作流硬规则注入（积分保护/如实展示/无结果不替换）
lib/redfox.js          无 SNI TLS 传输 + 常规回退 + 错误码翻译（3105/3201/3203）
lib/store.js           queries/<qid> 持久化 + 设置
lib/api.js             /tiktok-topic 面板路由
client.js / lab/       浏览器半边（侧栏入口 + iframe 面板，明暗跟随 dsh 主题）
skills/tiktok-topic-aweme-list/  方法论技能（SKILL.md + 上游 core_workflow 参考）
```

## License

MIT（本插件代码）。方法论与 API 用例参考 redfox-data/redfox-community skills/tiktok-topic-aweme-list（上游未附许可证文件，仅作技术参考）；RedFox API 使用受其服务条款约束。
