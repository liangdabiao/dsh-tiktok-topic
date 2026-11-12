// 系统提示注入：TikTok 话题雷达工作流硬规则（渲染规则与错误处理在技能 references 里）。
export const SYSTEM_RULES = `## TikTok 话题雷达（tiktok-topic）

用户要「查 TikTok 话题作品 / hashtag 作品列表 / challenge 数据 / 某话题下最火视频」时：

**流程**：tiktok_topic(action="query", chId=…, topic=…, sort=…, count=…) → 按 Markdown 表格输出（序号/作者/作品ID/播放/点赞/评论/分享/链接/摘要/话题）+ 分页信息行 → 用户说「看下一页」时用返回的 nextCursor 继续查。

**硬规则**：数值全部来自接口返回，严禁估算编造；空结果如实说明「暂无数据」，不自动改查其他话题；**积分保护**——未经用户明确要求不主动翻页、不批量查多个话题；作品链接用接口返回的完整 shareLink，不用 userHandle+workId 自拼；作者级字段（粉丝数等）该接口实测常为 0，默认不展示也不作为账号规模判断；只给作品链接没有话题 ID 时先从作品页 challenges/textExtra 提取，没有就说明「暂无话题 ID」。`

export function systemSection() {
  return {
    name: 'tiktok-topic:workflow',
    order: 110,
    text: SYSTEM_RULES,
  }
}
