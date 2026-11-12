---
name: tiktok-topic-aweme-list
description: TikTok 话题雷达方法论：按 TikTok 话题 ID（challengeId/hashtagId）查询话题下作品列表，播放/点赞/评论/分享核心数据 + 完整作品链接，默认播放数降序，排序切换与游标翻页。用户要查 TikTok 话题作品、hashtag/challenge 数据、话题下最火视频、从作品链接提取话题数据时使用。触发词：TikTok话题作品、话题作品列表、TikTok话题数据、hashtag作品列表、challenge作品列表。
---

# 获取 TikTok 指定话题作品数据

按话题查询 TikTok 作品列表，默认按播放数降序呈现核心数据与可点击作品链接。

## 触发场景

- 「查询 TikTok 话题 ID 的作品数据」
- 「查 #xxx 话题下面的作品」
- 「看看某话题下播放量最高的作品」
- 只给 TikTok 作品链接：先从作品页提取话题 ID 再查询；作品没有 `challenges`/`textExtra` 话题时直接说明「暂无话题 ID」，**不要改查其他话题**

## 工作流

### 1. 鉴权

需要 RedFox API Key（`ak_` 开头，[红狐 hub](https://redfox.hk/settings/api-keys?source=github) 获取）。优先级：插件配置 > 面板「设置」页 > 环境变量 `REDFOX_API_KEY`。

### 2. 理解意图

| 用户意图 | 执行动作 |
|---|---|
| 查询话题作品（给出话题 ID） | `tiktok_topic(action="query", chId=…, topic=…)` |
| 只给作品链接 | 先从作品页内嵌 JSON 的 textExtra/challenges 提取话题 ID |
| 指定排序 | `sort="likes"/"comments"/"shares"/"none"`（默认 views） |
| 翻页 | 用上一页返回的 nextCursor 作为 cursor 再查（**用户明确要求才翻**） |

### 3. 查询

`tiktok_topic(action="query", chId=2525872, topic="charlidamelio", sort="views", count=10)` —— 同步秒回，返回分页信息行 + Markdown 表格。

### 4. 渲染输出（规则固定）

输出顺序：分页信息行 → API Key 获取提醒 → 作品表格。

```
话题：`#charlidamelio` | ch_id：`2525872` | cursor：0 | count：10 | hasMore：1 | nextCursor：10
```

表格表头固定：`| # | 作者 | 作品 ID | 播放 | 点赞 | 评论 | 分享 | 作品链接 | 内容摘要 | 话题 |`

渲染规则：
- 话题名自动加 `#` 前缀；未提供话题名时显示 `ch_id:<id>`
- 「作品链接」必须用接口返回的完整 `shareLink`（`[打开作品](完整shareLink)`）；**不要**自行用 userHandle+workId 拼接
- 作者级字段（fansCount/followCount/workCount/likedTotal）该接口实测常为 0，**默认不展示**，也不作为账号规模判断依据
- 数值全部来自数据服务返回，**如实展示，严禁估算或编造**
- 空结果输出「暂无数据」，不主动改查其他话题

### 5. 错误处理

| 情况 | 处理方式 |
|------|---------|
| code=3105（Key 禁用） | 提示更换有效 Key，不要重复重试 |
| code=3203（参数校验失败） | 按 msg 修正 ch_id/cursor/count；该错误通常提示「积分未扣除」 |
| code=3201（积分不足） | 提示到 https://redfox.hk/dashboard/recharge 充值 |
| 空 workList | 「暂无数据」，给出可选调整方向（换热门话题/确认 ch_id） |
| 未配置 Key | 引导到面板「设置」页填写 |

## 注意事项

1. **积分保护**：每次成功查询可能消耗积分；未经用户明确指定，不主动翻页或批量查询多个话题
2. **链接完整性**：作品链接保持完整可点击，不使用被终端截断的 URL
3. **无结果不替换**：空结果/暂无话题 ID 时如实说明，不自动改查其他话题

## 在 DSH 插件里使用

- `tiktok_topic` 工具负责查询与历史持久化；表格渲染与翻页引导由你完成
- `history` 列出查询历史（新→旧）；对旧记录复述传 `queryId`；翻页直接用上次返回的 nextCursor
- 面板可直接查询/本地重排/翻页/看历史；与对话流程共用同一份数据
