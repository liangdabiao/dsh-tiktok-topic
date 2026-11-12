// ============================================================================
// TikTok 话题雷达 · 浏览器半边
//   - 侧栏加「TikTok 话题雷达」入口，主区域是插件页面（/tiktok-topic/，iframe）
//   - 页面发 tiktok-topic:refresh：postMessage 一段草稿，这里开新对话并填进输入框（不自动发送）
//   - 明暗跟随 dsh 主题
//
// 注意：这里**不要**自己写 window.__ModuleLoader__.load(...)——scripts/build.mjs 的
// banner 已包了一层注册，再包一次会 duplicate factory registration 让 web boot 失败。
// ============================================================================
const React = require('react')
const h = React.createElement

const PANEL = 'tiktok-topic'
const SRC = '/tiktok-topic/'

// 侧栏图标：雷达圈 + 三平台信号点（小红书 / 抖音 / 公众号）
function PanelIcon(props) {
  const s = (props && props.size) || 18
  return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
    h('circle', { cx: 12, cy: 12, r: 9, strokeDasharray: '2 3' }),
    h('circle', { cx: 12, cy: 12, r: 2 }),
    h('circle', { cx: 12, cy: 5, r: 1.6, fill: 'currentColor', stroke: 'none' }),
    h('circle', { cx: 18, cy: 15.5, r: 1.6, fill: 'currentColor', stroke: 'none' }),
    h('circle', { cx: 6, cy: 15.5, r: 1.6, fill: 'currentColor', stroke: 'none' }))
}

function apply(ctx) {
  const frames = new Set()
  let scheme = null
  const post = (frame) => {
    try { if (scheme && frame.contentWindow) frame.contentWindow.postMessage({ type: 'tiktok-topic:scheme', scheme }, location.origin) } catch {}
  }
  ctx.inject(['theme'], (c) => {
    const push = (snap) => { scheme = snap.active.colorScheme; frames.forEach(post) }
    try { push(c.theme.getTheme()) } catch {}
    c.on('theme/change', push)
  })

  function Cn30Panel() {
    const ref = React.useRef(null)
    React.useEffect(() => {
      const self = ref.current
      if (self) frames.add(self)
      function onMessage(e) {
        const frame = ref.current
        if (!frame || e.source !== frame.contentWindow || e.origin !== location.origin) return
        const m = e.data
        if (!m || m.type !== 'tiktok-topic:refresh' || typeof m.prompt !== 'string') return
        try {
          ctx.uiWorkspace.startSession(undefined, { prompt: m.prompt, whenDraftExists: 'replace' })
          try { frame.contentWindow.postMessage({ type: 'tiktok-topic:start-ok' }, location.origin) } catch {}
        } catch (err) {
          console.error('[tiktok-topic] 开新对话失败', err)
          try { frame.contentWindow.postMessage({ type: 'tiktok-topic:start-failed', message: String((err && err.message) || err) }, location.origin) } catch {}
        }
      }
      addEventListener('message', onMessage)
      return () => { removeEventListener('message', onMessage); frames.delete(self) }
    }, [])
    return h('iframe', {
      ref,
      src: SRC,
      title: 'TikTok 话题雷达',
      allow: 'fullscreen',
      onLoad: (e) => post(e.currentTarget),
      style: { width: '100%', height: '100%', border: 0, display: 'block' },
    })
  }

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 15, label: () => 'TikTok 话题雷达' }, PanelIcon))
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, Cn30Panel))
}

exports.isPlugin = true
exports.inject = ['slots', 'uiWorkspace']
exports.apply = apply
