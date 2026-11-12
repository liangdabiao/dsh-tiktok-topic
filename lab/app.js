// TikTok 话题雷达 · 面板逻辑：概览（查询表单+历史）/ 查询结果（排序切换+作品表格+翻页）/ 设置。
// 结果解读走 agent 对话：嵌入 dsh → postMessage（client.js startSession，有 start-ok 握手）；
// 独立浏览器预览 → 复制草稿。面板直连 API 查询/翻页/重排。
(() => {
  const $app = document.getElementById('app')
  const $toast = document.getElementById('toast')
  const EMBEDDED = (() => { try { return window.parent !== window } catch { return false } })()

  const state = { catalog: null, sort: 'views', lastQuery: null }
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const fmt = (n) => { const v = Number(n); return Number.isFinite(v) && v > 0 ? v.toLocaleString('en-US') : '0' }

  async function api(path) {
    const res = await fetch(`/tiktok-topic${path}`)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      const err = new Error(body.error || `HTTP ${res.status}`)
      err.status = res.status
      throw err
    }
    return body
  }
  async function apiPost(path, payload) {
    const res = await fetch(`/tiktok-topic${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
    return body
  }
  async function apiDelete(path) {
    const res = await fetch(`/tiktok-topic${path}`, { method: 'DELETE' })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
    return body
  }

  let toastTimer = null
  function toast(msg, isErr) {
    $toast.textContent = msg
    $toast.className = `toast show${isErr ? ' err' : ''}`
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { $toast.className = 'toast' }, 2600)
  }
  function copyFallback(prompt, reason) {
    navigator.clipboard?.writeText(prompt).then(
      () => toast(`${reason}，草稿已复制到剪贴板——请粘贴到 dsh 对话`, true),
      () => toast(`${reason}，复制也失败了`, true))
  }

  const ICONS = {
    home: '<path d="M4 11l8-7 8 7"/><path d="M6 9.5V20h12V9.5"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    trash: '<path d="M5 7h14"/><path d="M9 7V5h6v2"/><path d="M7 7l1 13h8l1-13"/>',
    spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
    ext: '<path d="M14 5h5v5"/><path d="M19 5l-8 8"/><path d="M18 14v5H5V6h5"/>',
    back: '<path d="M14 6l-6 6 6 6"/>',
    play: '<path d="M8 5l11 7-11 7V5z"/>',
    next: '<path d="M9 6l6 6-6 6"/>',
  }
  const ic = (name, cls = 'ic') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`

  async function loadCatalog() {
    state.catalog = await api('/api/catalog')
    renderRailFoot()
    return state.catalog
  }
  function renderRailFoot() {
    const c = state.catalog
    if (!c) return
    const latest = (c.queries || [])[0]
    document.getElementById('rail-foot').innerHTML =
      `<div class="v-head">TIKTOK RADAR v${esc(c.version)}</div>` +
      `<div class="v-row"><span>API Key</span><span>${c.has_key ? '已配置' : '未配置'}</span></div>` +
      `<div class="v-row"><span>查询数</span><span>${(c.queries || []).length}</span></div>` +
      `<div class="v-row"><span>最近话题</span><span>${esc(latest ? (latest.topic ? `#${latest.topic}` : `ch${latest.ch_id}`) : '—')}</span></div>`
  }

  function sendAgentPrompt(prompt, okMsg = '已在宿主开新对话——agent 处理中') {
    if (!EMBEDDED) {
      navigator.clipboard?.writeText(prompt).then(
        () => toast('草稿已复制——粘贴到 dsh 对话即可开始'),
        () => copyFallback(prompt, '复制失败'))
      return
    }
    let done = false
    const cleanup = () => { done = true; clearTimeout(timer); removeEventListener('message', onMsg) }
    const onMsg = (e) => {
      if (e.origin !== location.origin) return
      if (e.data?.type === 'tiktok-topic:start-ok') { if (!done) { cleanup(); toast(okMsg) } }
      else if (e.data?.type === 'tiktok-topic:start-failed') { if (!done) { cleanup(); toast(`没能开新对话：${e.data.message || ''}`, true) } }
    }
    const timer = setTimeout(() => { if (!done) { cleanup(); copyFallback(prompt, '未收到宿主确认') } }, 1500)
    addEventListener('message', onMsg)
    parent.postMessage({ type: 'tiktok-topic:refresh', prompt }, location.origin)
  }

  // ---------- 视图：概览 ----------
  function viewHome() {
    const c = state.catalog
    const queries = c.queries || []
    return `
      <header class="head">
        <span class="eyebrow">TIKTOK TOPIC RADAR</span>
        <div class="head-row">
          <h1>TikTok 话题<strong>雷达</strong></h1>
        </div>
        <p>按 TikTok 话题 ID（challengeId / hashtagId）查询话题下作品：播放/点赞/评论/分享核心数据 + 完整作品链接，默认播放数降序。RedFox API Key ${c.has_key ? '已配置' : '未配置——去「设置」页填写'}。</p>
      </header>
      ${!c.has_key ? `<div class="empty" style="margin-bottom:var(--sp-6);padding:var(--sp-4) var(--sp-5);text-align:left"><div class="e-title">🔑 还没有配置 RedFox API Key</div><p>到<a href="#/settings">「设置」</a>页填写（ak_ 开头，<a href="https://redfox.hk/settings/api-keys?source=github" target="_blank" rel="noreferrer">红狐 hub 获取 ↗</a>）。</p></div>` : ''}
      <section class="sec" style="margin-top:0">
        <div class="sec-head"><span class="num">01</span><h2>话题查询</h2></div>
        <div class="form" style="max-width:760px">
          <div class="form-row">
            <div class="field"><label>TOPIC ID · 话题 ID（challengeId/hashtagId）*</label>
              <input id="f-chid" placeholder="如：2525872" inputmode="numeric"></div>
            <div class="field"><label>TOPIC NAME · 话题名（展示用，可空）</label>
              <input id="f-topic" placeholder="如：charlidamelio"></div>
          </div>
          <div class="form-row">
            <div class="field"><label>PER PAGE · 每页条数</label>
              <select id="f-count"><option value="10">10</option><option value="20" selected>20</option><option value="50">50</option></select></div>
            <div class="field"><label>SORT · 排序</label>
              <select id="f-sort"><option value="views" selected>播放数降序</option><option value="likes">点赞降序</option><option value="comments">评论降序</option><option value="shares">分享降序</option><option value="none">接口原始顺序</option></select></div>
          </div>
          <div style="display:flex;gap:var(--sp-3);flex-wrap:wrap">
            <button class="btn accent" id="f-query">${ic('play')}查询作品</button>
            <button class="btn ghost" data-newflow>${ic('spark')}去对话分析话题</button>
          </div>
          <div class="hint">同步秒回。每次成功查询可能消耗积分——面板不会自动翻页；不知道话题 ID？给 agent 一个 TikTok 作品链接，它会从作品页提取话题 ID。</div>
        </div>
      </section>
      <section class="sec">
        <div class="sec-head"><span class="num">02</span><h2>查询历史</h2></div>
        ${queries.length ? `<div class="cards">${queries.map((r) => `
          <a class="card" href="#/q/${encodeURIComponent(r.query_id)}">
            <div class="c-top">
              <div class="c-title">${r.topic ? `#${esc(r.topic)}` : `ch_id ${r.ch_id}`}</div>
              <span class="chip ${r.has_more ? 'searching' : 'done'}">${r.has_more ? '可翻页' : '末页'}</span>
            </div>
            <div class="c-sub">ch_id ${r.ch_id} · cursor=${r.cursor} · ${r.count} 条</div>
            <div class="c-foot"><span>${esc(String(r.queried_at).slice(0, 16).replace('T', ' '))}</span></div>
          </a>`).join('')}</div>`
        : `<div class="empty"><div class="e-title">还没有查询记录</div><p>输入话题 ID 点「查询作品」；或「去对话分析话题」让 agent 帮你从作品链接提取话题 ID 并解读数据。</p></div>`}
      </section>`
  }

  // ---------- 视图：查询结果 ----------
  function worksTable(record) {
    const works = record.works || []
    if (!works.length) return '<div class="empty-inline">暂无数据——该话题下没有查到作品，或 ch_id 不正确。</div>'
    const topic = record.topic ? `#${esc(record.topic)}` : `ch_id:${record.ch_id}`
    return `<div class="works-scroll"><table class="works">
      <thead><tr><th>#</th><th>作者</th><th>作品 ID</th><th class="num">播放</th><th class="num">点赞</th><th class="num">评论</th><th class="num">分享</th><th>链接</th><th>内容摘要</th></tr></thead>
      <tbody>${works.map((w, i) => {
        const a = w.authorData || {}
        const st = w.statsData || {}
        return `<tr>
          <td class="idx">${i + 1}</td>
          <td><div class="author">${esc(a.userName || '—')}</div>${a.userHandle ? `<div class="handle">@${esc(a.userHandle)}</div>` : ''}</td>
          <td><span class="wid">${esc(w.workId || '')}</span></td>
          <td class="num">${fmt(st.viewCount)}</td>
          <td class="num">${fmt(st.likeCount)}</td>
          <td class="num">${fmt(st.commentTotal)}</td>
          <td class="num">${fmt(st.shareTotal)}</td>
          <td>${w.shareLink ? `<a href="${esc(w.shareLink)}" target="_blank" rel="noreferrer">打开作品</a>` : '—'}</td>
          <td><div class="summ">${esc(w.content || '')}</div></td>
        </tr>`
      }).join('')}</tbody>
    </table></div>`
  }

  function pageInfo(record) {
    return `cursor=${record.cursor} · 本页 ${record.works?.length ?? 0} 条 · hasMore=${record.has_more}${record.next_cursor !== null && record.next_cursor !== undefined ? ` · nextCursor=${record.next_cursor}` : ''}`
  }

  function viewQuery(qid) {
    return `<div id="q-view" data-qid="${esc(qid)}"><div class="loading">LOADING…</div></div>`
  }

  async function renderQuery(qid) {
    const holder = document.getElementById('q-view')
    let record
    try {
      record = (await api(`/api/queries/${encodeURIComponent(qid)}`)).record
    } catch (e) {
      const netDown = !e.status
      holder.innerHTML = `<a class="back" href="#/">${ic('back')} 概览</a><div class="empty"><div class="e-title">${netDown ? '面板服务连接失败' : '查询记录不存在'}</div><p>${netDown ? '开发预览：DSH_HOME=<数据目录> node scripts/devserver.mjs 5181' : esc(e.message)}</p></div>`
      return
    }
    state.lastQuery = record
    state.sort = record.sort || 'views'
    const topicLabel = record.topic ? `#${esc(record.topic)}` : `ch_id ${record.ch_id}`
    const sorts = [['views', '播放'], ['likes', '点赞'], ['comments', '评论'], ['shares', '分享'], ['none', '原始顺序']]
    holder.innerHTML = `
      <a class="back" href="#/">${ic('back')} 概览</a>
      <div class="detail-head">
        <div>
          <h1>${topicLabel}</h1>
          <div class="c-sub" style="margin-top:4px">ch_id ${record.ch_id} · 查询于 ${esc(String(record.queried_at).slice(0, 16).replace('T', ' '))}</div>
        </div>
        <div class="actions">
          <button class="btn ghost" data-analyze="${esc(qid)}">${ic('spark')}去对话解读数据</button>
          <button class="btn ghost" data-del-query="${esc(qid)}" title="删除记录">${ic('trash')}</button>
        </div>
      </div>
      <div class="sortbar"><span class="sl">SORT · 重排本地结果</span>${sorts.map(([k, label]) =>
        `<button class="sort-btn${state.sort === k ? ' on' : ''}" data-sort="${k}">${label}</button>`).join('')}</div>
      <div style="height:var(--sp-4)"></div>
      <div id="works-holder">${worksTable(record)}</div>
      <div class="pagebar">
        <span>${esc(pageInfo(record))}</span>
        ${record.has_more && record.next_cursor !== null && record.next_cursor !== undefined
          ? `<button class="btn accent" id="btn-next" data-cursor="${esc(record.next_cursor)}">${ic('next')}查询下一页（消耗积分）</button>`
          : '<span class="more-hint">没有下一页了</span>'}
      </div>`
    bindQuery(qid, record)
  }

  function bindQuery(qid, record) {
    document.querySelectorAll('.sort-btn').forEach((b) => {
      b.onclick = () => {
        state.sort = b.dataset.sort
        document.querySelectorAll('.sort-btn').forEach((x) => x.classList.toggle('on', x === b))
        const key = { views: 'viewCount', likes: 'likeCount', comments: 'commentTotal', shares: 'shareTotal' }[state.sort]
        const works = key
          ? [...(record.works || [])].sort((x, y) => ((y.statsData || {})[key] || 0) - ((x.statsData || {})[key] || 0))
          : (record.works || [])
        // 本地重排只影响展示，不回写 record.works
        const tmp = { ...record, works }
        document.getElementById('works-holder').innerHTML = worksTable(tmp)
      }
    })
    const next = document.getElementById('btn-next')
    if (next) next.onclick = async () => {
      next.disabled = true; next.textContent = '查询中…'
      try {
        const r = await apiPost('/api/queries', {
          chId: record.ch_id, topic: record.topic, cursor: Number(next.dataset.cursor),
          count: record.count, sort: state.sort,
        })
        toast('下一页已入库')
        location.hash = `#/q/${encodeURIComponent(r.record.query_id)}`
      } catch (e) { toast(e.message, true); next.disabled = false; next.innerHTML = `${ic('next')}查询下一页（消耗积分）` }
    }
    const del = document.querySelector('[data-del-query]')
    if (del) del.onclick = async () => {
      if (!confirm('删除这条查询记录？')) return
      try { await apiDelete(`/api/queries/${encodeURIComponent(qid)}`); toast('已删除'); location.hash = '#/' } catch (e) { toast(e.message, true) }
    }
    const analyze = document.querySelector('[data-analyze]')
    if (analyze) analyze.onclick = () => {
      const topic = record.topic ? `#${record.topic}` : `话题 ID ${record.ch_id}`
      sendAgentPrompt([
        `请解读 TikTok ${topic}（ch_id=${record.ch_id}）的话题作品数据：`,
        `1. tiktok_topic(action="query", chId=${record.ch_id}, topic="${record.topic || ''}", sort="views", count=20) 拿最新数据（本地已有快照，你也可以直接基于它分析）`,
        '2. 按 tiktok-topic-aweme-list 技能输出 Markdown 表格（播放/点赞/评论/分享 + 完整作品链接），并解读：头部作品特征、互动率分布、话题热度结构',
        '3. 数值如实展示严禁编造；未经我明确要求不要翻页。',
      ].join('\n'), '已在宿主开新对话——agent 解读完回来看')
    }
  }

  // ---------- 视图：设置 ----------
  function viewSettings() {
    return `
      <a class="back" href="#/">${ic('back')} 概览</a>
      <header class="head">
        <span class="eyebrow">SETTINGS</span>
        <h1>设<strong>置</strong></h1>
        <p>RedFox API Key 是话题查询的唯一凭证。这里保存的 Key 优先于环境变量，低于插件配置。</p>
      </header>
      <div class="form">
        <div class="field"><label>API KEY · RedFox API Key（ak_ 开头）</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <input id="s-key" placeholder="ak_…" style="flex:1;min-width:220px;font-family:var(--font-mono);font-size:12px">
            <button class="btn" id="s-key-save">保存 Key</button>
          </div>
          <div class="hint" id="s-key-hint">…</div>
          <div class="hint">获取：<a href="https://redfox.hk/settings/api-keys?source=github" target="_blank" rel="noreferrer">redfox.hk/settings/api-keys ↗</a>。保存在本机 dsh 数据目录，不上传。</div>
        </div>
        <div class="field"><label>API BASE · 接口地址（测试/自建网关用，默认 https://redfox.hk）</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <input id="s-base" placeholder="https://redfox.hk" style="flex:1;min-width:220px;font-family:var(--font-mono);font-size:12px">
            <button class="btn" id="s-base-save">保存地址</button>
          </div>
          <div class="hint">redfox.hk 该接口走无 SNI 传输（证书链校验保留、主机名匹配关闭）；自定义地址时改用常规传输。</div>
        </div>
      </div>`
  }

  async function bindSettings() {
    try {
      const { settings } = await api('/api/settings')
      const keyHint = document.getElementById('s-key-hint')
      if (keyHint) keyHint.textContent = settings.has_key
        ? `已配置（…${settings.key_tail || '******'}${settings.from_env ? '，其中环境变量可用' : ''}）。重新输入会覆盖。`
        : '未配置。'
      const inp = document.getElementById('s-key')
      if (inp && document.activeElement !== inp) inp.placeholder = settings.has_key ? `已配置（…${settings.key_tail}），输入新值覆盖` : 'ak_…'
      const base = document.getElementById('s-base')
      if (base && document.activeElement !== base) base.value = settings.api_base || ''
    } catch { /* 宿主未就绪 */ }
    const bind = (id, payload) => {
      const btn = document.getElementById(id)
      if (!btn) return
      btn.onclick = async () => {
        try {
          const input = btn.parentElement.querySelector('input')
          await apiPost('/api/settings', payload(input.value.trim()))
          toast('设置已保存')
          loadCatalog().catch(() => {})
        } catch (e) { toast(e.message, true) }
      }
    }
    bind('s-key-save', (v) => ({ api_key: v }))
    bind('s-base-save', (v) => ({ api_base: v }))
  }

  // ---------- 渲染辅助 ----------
  function bindCommon() {
    document.querySelectorAll('[data-newflow]').forEach((b) => {
      b.onclick = () => sendAgentPrompt([
        '请帮我分析一个 TikTok 话题的数据（TikTok 话题雷达）：',
        '1. 我会告诉你话题 ID 或一个 TikTok 作品链接；只有链接时先从作品页 challenges/textExtra 提取话题 ID，提取不到就告诉我「暂无话题 ID」',
        '2. tiktok_topic(action="query", chId=…, topic=…, sort="views", count=20) 查询作品',
        '3. 按 Markdown 表格完整输出（播放/点赞/评论/分享 + 完整作品链接），并解读头部作品特征与话题热度',
        '4. 数值如实展示；未经我明确要求不要翻页。',
        '现在请先问我想查哪个话题（或让我贴作品链接）。',
      ].join('\n'), '已在宿主开新对话——agent 会先问你要话题 ID 或作品链接')
    })
    const qbtn = document.getElementById('f-query')
    if (qbtn) qbtn.onclick = async () => {
      const chId = Number(document.getElementById('f-chid').value.trim())
      if (!Number.isInteger(chId) || chId <= 0) { toast('话题 ID 必须是大于 0 的整数', true); return }
      qbtn.disabled = true
      try {
        const r = await apiPost('/api/queries', {
          chId,
          topic: document.getElementById('f-topic').value.trim(),
          count: Number(document.getElementById('f-count')?.value) || 20,
          sort: document.getElementById('f-sort')?.value || 'views',
          cursor: 0,
        })
        toast(r.record.works?.length ? `查询成功：${r.record.works.length} 条作品` : '查询成功：暂无数据')
        location.hash = `#/q/${encodeURIComponent(r.record.query_id)}`
      } catch (e) { toast(e.message, true) }
      qbtn.disabled = false
    }
  }

  // ---------- 路由 ----------
  async function render() {
    try { await loadCatalog() } catch {}
    const hash = location.hash || '#/'
    const mq = hash.match(/^#\/q\/(.+)$/)
    const qid = mq ? decodeURIComponent(mq[1]) : null
    document.querySelectorAll('.nav a').forEach((a) => {
      const cur = qid ? '' : hash === '#/' ? 'home' : hash.startsWith('#/settings') ? 'settings' : 'home'
      a.classList.toggle('on', a.dataset.view === cur)
    })
    if (qid && /^[\p{L}\p{N}_-]+$/u.test(qid)) {
      $app.innerHTML = viewQuery(qid)
      bindCommon()
      renderQuery(qid)
      return
    }
    if (hash.startsWith('#/settings')) { $app.innerHTML = viewSettings(); bindCommon(); bindSettings(); return }
    $app.innerHTML = viewHome()
    bindCommon()
  }

  async function boot() {
    try { await loadCatalog() } catch {
      state.catalog = { version: '-', has_key: false, key_source: 'none', queries: [], settings: {} }
    }
    render().catch(() => {})
  }
  addEventListener('hashchange', render)
  boot()
  setTimeout(() => { if (!state.catalog?.version || state.catalog.version === '-') boot() }, 2500)
})()
