"use strict";
/**
 * @local/dsh-wxmp · Client 半边（web UI）。
 *
 * 在左侧栏注册全局面板行「公众号」，并在 layout 的 `main` 槽上注册 keyed 页面：
 * 四个 tab（登录 / 订阅 / 文章 / Webhook）。
 *  - 登录：二维码扫码登录（轮询 /login/status），已登录显示昵称与过期倒计时。
 *  - 订阅：搜索并订阅 / 退订；已订阅列表可编辑分类（/subscriptions?_method=set_category）、
 *    复制 RSS 链接（/rss/{fakeid}.xml）、看 lastPoll 相对时间、导出（/export/{fakeid}.{format}?_method=export），
 *    顶部「手动同步」（/sync?_method=post）与「暂停/恢复/立即轮询」（/rss/poll?_method=pause|resume|post）。
 *  - 文章：按公众号 / 分类过滤，抽屉内读正文（极简 markdown 渲染），行内「原文 ↗」新窗口打开，支持同步。
 *  - Webhook：列表 / 添加 / 删除（/webhooks?_method=list|add|remove）。
 *
 * 约束：只用 `require('react')`/`require('react-dom')`；颜色只用 `--dsw-alias-*` token；
 * 不 iframe、不碰别人的 DOM。数据全走 Host 代理路由 `/api/plugins/wxmp/*`。
 * webServer carrier 只支持 GET/HEAD：所有 POST/DELETE 都写成 GET + `?_method=post|delete`，
 * 业务参数放 query。头像/图片一律 `referrerpolicy="no-referrer"`。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-wxmp',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const STYLE_ID = '@local/dsh-wxmp/page.css'
    /** 左侧栏全局面板的 id / `main` 槽 key。 */
    const PANEL_ID = 'wxmp'

    const CSS = `
.wxmp-page{display:flex;flex-direction:column;box-sizing:border-box;width:100%;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.wxmp-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;padding:14px 20px 24px}
.wxmp-topbar{position:relative;flex:0 0 auto;z-index:3;display:flex;align-items:center;gap:10px;box-sizing:border-box;padding:10px 20px 8px;background:var(--dsw-alias-bg-base);border-bottom:.5px solid var(--dsw-alias-border-l2)}
.wxmp-tabs-wrap{flex:0 1 auto;min-width:0;overflow:hidden}
.wxmp-tabs{display:flex;align-items:center;gap:2px;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;padding:2px;border-radius:var(--dsw-radius-md, 8px);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2)}
.wxmp-tabs::-webkit-scrollbar{display:none}
.wxmp-tab{flex:none;appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;height:24px;padding:0 10px;border-radius:var(--dsw-radius-sm, 6px);cursor:pointer;white-space:nowrap;transition:background-color .12s ease,color .12s ease}
.wxmp-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.wxmp-tab[aria-selected="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3)}
.wxmp-topbar-tools{display:flex;align-items:center;gap:8px;margin-left:auto;flex:0 0 auto;min-width:0}
.wxmp-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;white-space:nowrap;font-variant-numeric:tabular-nums}
.wxmp-button{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:5px;height:28px;box-sizing:border-box;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;border-radius:var(--dsw-radius-sm, 6px);cursor:pointer}
.wxmp-button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.wxmp-button:disabled{opacity:.6;cursor:default}
.wxmp-search{display:flex;align-items:center;gap:6px;flex:0 1 220px;min-width:140px;height:28px;box-sizing:border-box;padding:0 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md, 8px);background:var(--dsw-alias-bg-layer-1);transition:border-color .12s ease}
.wxmp-search:focus-within{border-color:var(--dsw-alias-border-l3)}
.wxmp-search input{flex:1 1 auto;min-width:0;border:0;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px}
.wxmp-search input::placeholder{color:var(--dsw-alias-label-dimmed)}
.wxmp-tab:focus-visible,.wxmp-button:focus-visible,.wxmp-chip:focus-visible,.wxmp-search:focus-within{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.wxmp-state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:48px 16px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;text-align:center}
.wxmp-state-error{color:var(--dsw-alias-state-error-primary)}
.wxmp-skeleton{display:flex;flex-direction:column;gap:10px}
.wxmp-skeleton-row{height:64px;border-radius:var(--dsw-radius-lg, 10px);background:var(--dsw-alias-bg-skeleton)}
.wxmp-card{display:flex;align-items:center;gap:10px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg, 10px);background:var(--dsw-alias-bg-layer-1)}
.wxmp-card:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wxmp-card-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}
.wxmp-avatar{flex:none;width:36px;height:36px;border-radius:var(--dsw-radius-sm, 6px);object-fit:cover;background:var(--dsw-alias-bg-layer-2)}
.wxmp-avatar-sm{width:24px;height:24px}
.wxmp-name{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wxmp-sub{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wxmp-badge{display:inline-flex;align-items:center;padding:0 6px;border-radius:var(--dsw-radius-xs, 4px);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.wxmp-list{display:flex;flex-direction:column;gap:8px}
.wxmp-section{display:flex;flex-direction:column;gap:8px}
.wxmp-section-label{margin:0;font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}
.wxmp-chip{appearance:none;display:inline-flex;align-items:center;height:24px;box-sizing:border-box;padding:0 9px;border:.5px solid transparent;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;border-radius:var(--dsw-radius-sm, 6px);cursor:pointer;white-space:nowrap;transition:background-color .12s ease,color .12s ease,border-color .12s ease}
.wxmp-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.wxmp-chip[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}
.wxmp-articles{display:flex;flex:1 1 auto;min-height:0;gap:10px}
.wxmp-articles-side{flex:0 0 180px;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:2px;padding:8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg, 10px);background:var(--dsw-alias-bg-layer-1)}
.wxmp-articles-main{flex:1 1 auto;min-width:0;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:8px}
.wxmp-article-item{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg, 10px);background:var(--dsw-alias-bg-layer-1);cursor:pointer;text-align:left;font:inherit;color:inherit}
.wxmp-article-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wxmp-article-title{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
.wxmp-article-digest{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.wxmp-article-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.wxmp-qrcode-wrap{display:flex;flex-direction:column;align-items:center;gap:10px;padding:24px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg, 10px);background:var(--dsw-alias-bg-layer-1);max-width:320px;margin:0 auto}
.wxmp-qrcode{width:200px;height:200px;border-radius:var(--dsw-radius-md, 8px);background:var(--dsw-alias-bg-layer-2)}
.wxmp-profile{display:flex;align-items:center;gap:12px;padding:16px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg, 10px);background:var(--dsw-alias-bg-layer-1);max-width:420px}
.wxmp-profile-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}
.wxmp-profile .wxmp-avatar{width:48px;height:48px;border-radius:50%}
.wxmp-drawer-backdrop{position:fixed;inset:0;z-index:1000;background:var(--dsw-alias-bg-mask-1)}
.wxmp-drawer{position:fixed;top:0;right:0;bottom:0;z-index:1001;width:min(480px,94vw);display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1)}
.wxmp-drawer-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:.5px solid var(--dsw-alias-border-l1);border-left:.5px solid var(--dsw-alias-border-l2)}
.wxmp-drawer-title{margin:0;font-size:15px;line-height:24px;font-weight:600;color:var(--dsw-alias-label-primary)}
.wxmp-drawer-body{flex:1 1 auto;min-height:0;overflow:auto;padding:14px 16px 20px;display:flex;flex-direction:column;gap:10px}
.wxmp-drawer-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.wxmp-md{display:flex;flex-direction:column;gap:8px;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1.75;overflow-wrap:anywhere}
.wxmp-md-h{margin:0;font-size:15px;line-height:24px;font-weight:600;color:var(--dsw-alias-label-primary)}
.wxmp-md-h2{font-size:14px}
.wxmp-md-li{margin:0;padding-left:14px;position:relative}
.wxmp-md-li::before{content:"-";position:absolute;left:0;color:var(--dsw-alias-label-tertiary)}
.wxmp-md-p{margin:0}
.wxmp-alert{color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px}
.wxmp-row-actions{display:flex;align-items:center;gap:6px;flex:0 0 auto;flex-wrap:wrap;justify-content:flex-end}
.wxmp-inline-input{height:24px;box-sizing:border-box;padding:0 6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm, 6px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;width:90px;outline:none}
.wxmp-inline-input:focus{border-color:var(--dsw-alias-border-l3)}
.wxmp-link{color:var(--dsw-alias-brand-primary);text-decoration:none;cursor:pointer;font-size:12px;line-height:18px}
.wxmp-link:hover{text-decoration:underline}
.wxmp-select{height:24px;box-sizing:border-box;padding:0 4px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm, 6px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;outline:none}
.wxmp-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wxmp-panel{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base)}
.wxmp-panel>.wxmp-page{flex:1 1 auto;min-height:0}
@media (max-width:900px){
.wxmp-articles{flex-direction:column}
.wxmp-articles-side{flex:0 0 auto;max-height:140px}
}
`

    const TABS = [
      { id: 'login', label: '登录' },
      { id: 'subs', label: '订阅' },
      { id: 'articles', label: '文章' },
      { id: 'webhooks', label: 'Webhook' },
    ]

    const EXPORT_FORMATS = ['md', 'html', 'json', 'xlsx', 'docx', 'epub', 'pdf']

    /** 时间戳(ms) → 相对时间文案。 */
    function relativeTime(ms) {
      const v = Number(ms)
      if (!Number.isFinite(v) || v <= 0) return ''
      const diff = Math.max(0, Date.now() - v)
      if (diff < 60000) return '刚刚'
      if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前'
      if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前'
      return Math.floor(diff / 86400000) + ' 天前'
    }

    /** 复制文本到剪贴板，resolve 是否成功。 */
    function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(() => true, () => false)
        const area = document.createElement('textarea')
        area.value = text
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        let ok = false
        try { ok = document.execCommand('copy') } catch { ok = false }
        area.remove()
        return Promise.resolve(ok)
      } catch {
        return Promise.resolve(false)
      }
    }

    /** 统一的 JSON GET（所有写操作也走 GET + _method），错误归一为中文消息。 */
    async function getJson(path, signal) {
      const response = await fetch(path, { signal, headers: { accept: 'application/json' } })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload === null || payload.ok !== true) {
        if (payload && payload.loginExpired) {
          throw Object.assign(new Error(payload.error || '微信登录凭证已过期，请重新扫码登录'), { code: 'loginExpired' })
        }
        throw new Error((payload && payload.error) || `请求失败（HTTP ${response.status}）`)
      }
      return payload
    }

    function Avatar({ src, alt, small }) {
      if (!src) {
        return h('span', { className: 'wxmp-avatar wxmp-avatar-sm' + (small ? '' : ''), 'aria-hidden': 'true' })
      }
      return h('img', {
        className: 'wxmp-avatar' + (small ? ' wxmp-avatar-sm' : ''),
        src,
        alt: alt || '',
        referrerPolicy: 'no-referrer',
        loading: 'lazy',
      })
    }

    function Skeleton() {
      return h('div', { className: 'wxmp-skeleton', 'aria-busy': 'true' },
        h('div', { className: 'wxmp-skeleton-row' }),
        h('div', { className: 'wxmp-skeleton-row' }),
        h('div', { className: 'wxmp-skeleton-row' }))
    }

    function EmptyState({ text }) {
      return h('div', { className: 'wxmp-state' }, h('div', null, text || '这里还没有内容。'))
    }

    function ErrorState({ message, onRetry }) {
      return h('div', { className: 'wxmp-state wxmp-state-error' },
        h('div', null, `加载失败：${message}`),
        onRetry ? h('button', { className: 'wxmp-button', type: 'button', onClick: onRetry }, '重试') : null)
    }

    /** 过期时间 → 剩余天数文案。 */
    function expireText(expireAt) {
      const ms = Number(expireAt)
      if (!Number.isFinite(ms) || ms <= 0) return ''
      const days = Math.max(0, Math.ceil((ms - Date.now()) / 86400000))
      return days > 0 ? `约 ${days} 天后过期` : '已过期'
    }

    /**
     * 登录 tab：未登录 →「开始登录」拉 sessionId 出二维码并每 2s 轮询状态；
     * 已登录 → 昵称 + 过期倒计时 +「退出登录」。轮询在切 tab / 卸载时清理。
     */
    function LoginTab() {
      const [session, setSession] = useState(null) // { sessionId }
      const [status, setStatus] = useState('loading') // loading | none | pending | scanned | logged_in | expired | failed | error | loggingOut
      const [profile, setProfile] = useState(null) // { nickname, headImg, expireAt }
      const [error, setError] = useState('')
      const [nonce, setNonce] = useState(0)

      // 初次拉登录态
      useEffect(() => {
        if (session) return
        const controller = new AbortController()
        let alive = true
        setStatus('loading')
        setError('')
        getJson('/api/plugins/wxmp/login/status', controller.signal)
          .then((payload) => {
            if (!alive) return
            if (payload.status === 'logged_in') {
              setProfile({ nickname: payload.nickname, headImg: payload.headImg, expireAt: payload.expireAt })
              setStatus('logged_in')
            } else {
              setStatus('none')
            }
          })
          .catch((err) => {
            if (!alive || (err && err.name === 'AbortError')) return
            setStatus('error')
            setError(err.message || '加载失败')
          })
        return () => { alive = false; controller.abort() }
      }, [session, nonce])

      // 二维码轮询：仅在 session 存在时启用
      useEffect(() => {
        if (!session || !session.sessionId) return
        const controller = new AbortController()
        let alive = true
        let timer = 0
        const poll = () => {
          getJson(`/api/plugins/wxmp/login/status?sessionId=${encodeURIComponent(session.sessionId)}`, controller.signal)
            .then((payload) => {
              if (!alive) return
              const s = payload.status || 'pending'
              setStatus(s)
              if (s === 'logged_in') {
                setProfile({ nickname: payload.nickname, headImg: payload.headImg, expireAt: payload.expireAt })
                setSession(null)
              } else if (s === 'expired' || s === 'failed') {
                setSession(null)
              } else {
                timer = window.setTimeout(poll, 2000)
              }
            })
            .catch((err) => {
              if (!alive || (err && err.name === 'AbortError')) return
              setStatus('error')
              setError(err.message || '登录状态查询失败')
              setSession(null)
            })
        }
        poll()
        return () => { alive = false; controller.abort(); window.clearTimeout(timer) }
      }, [session])

      const startLogin = useCallback(async () => {
        setStatus('loading')
        setError('')
        try {
          const payload = await getJson('/api/plugins/wxmp/login/start?_method=post')
          setSession({ sessionId: payload.sessionId })
          setStatus('pending')
        } catch (err) {
          setStatus('error')
          setError(err.message || '发起登录失败')
        }
      }, [])

      const logout = useCallback(async () => {
        setError('')
        try {
          await getJson('/api/plugins/wxmp/login/logout?_method=post')
          setProfile(null)
          setStatus('none')
          setNonce((value) => value + 1)
        } catch (err) {
          setError(err.message || '退出登录失败')
        }
      }, [])

      let body = null
      if (status === 'loading') {
        body = h(Skeleton)
      } else if (status === 'logged_in' && profile) {
        const left = expireText(profile.expireAt)
        body = h('div', { className: 'wxmp-profile' },
          h(Avatar, { src: profile.headImg, alt: profile.nickname }),
          h('div', { className: 'wxmp-profile-main' },
            h('span', { className: 'wxmp-name' }, profile.nickname || '已登录'),
            left ? h('span', { className: 'wxmp-sub' }, left) : null),
          h('button', { className: 'wxmp-button', type: 'button', onClick: logout }, '退出登录'))
      } else if (session && (status === 'pending' || status === 'scanned')) {
        body = h('div', { className: 'wxmp-qrcode-wrap' },
          h('img', {
            className: 'wxmp-qrcode',
            src: `/api/plugins/wxmp/login/qrcode?sessionId=${encodeURIComponent(session.sessionId)}`,
            alt: '登录二维码',
            referrerPolicy: 'no-referrer',
          }),
          h('span', { className: 'wxmp-sub' }, status === 'scanned' ? '已扫码，请在手机上确认' : '请用微信扫码登录'),
          status === 'scanned' ? null : h('span', { className: 'wxmp-sub' }, '二维码过期后可重新发起登录'))
      } else if (status === 'expired' || status === 'failed') {
        body = h('div', { className: 'wxmp-state' + (status === 'failed' ? ' wxmp-state-error' : '') },
          h('div', null, status === 'expired' ? '二维码已过期' : '登录失败，请重试'),
          h('button', { className: 'wxmp-button', type: 'button', onClick: startLogin }, '重新登录'))
      } else if (status === 'error') {
        body = h(ErrorState, { message: error, onRetry: () => setNonce((v) => v + 1) })
      } else {
        body = h('div', { className: 'wxmp-state' },
          h('div', null, '还没有登录微信公众号平台。'),
          h('button', { className: 'wxmp-button', type: 'button', onClick: startLogin }, '开始登录'))
      }

      return h('div', { className: 'wxmp-body' },
        body,
        error && status !== 'error' ? h('p', { className: 'wxmp-alert' }, error) : null)
    }

    /** 订阅 tab：上半搜索 + 结果卡片，下半已订阅列表。 */
    function SubsTab({ subscriptions, subsState, onReloadSubs, onSubscribed, onSync, syncing, syncError, pollStatus, pollBusy, onPollAction }) {
      const [query, setQuery] = useState('')
      const [results, setResults] = useState(null)
      const [searching, setSearching] = useState(false)
      const [searchError, setSearchError] = useState('')
      const [busyId, setBusyId] = useState('')
      const [actionError, setActionError] = useState('')
      const subscribedIds = new Set((subscriptions || []).map((entry) => entry.fakeid))

      const search = useCallback(async (text) => {
        const q = (text || '').trim()
        if (!q) return
        setSearching(true)
        setSearchError('')
        try {
          const payload = await getJson(`/api/plugins/wxmp/search?query=${encodeURIComponent(q)}`)
          setResults(Array.isArray(payload.list) ? payload.list : [])
        } catch (err) {
          setSearchError(err.message || '搜索失败')
          setResults(null)
        } finally {
          setSearching(false)
        }
      }, [])

      const toggleSubscribe = useCallback(async (entry) => {
        if (!entry || !entry.fakeid) return
        const already = subscribedIds.has(entry.fakeid)
        setBusyId(entry.fakeid)
        setActionError('')
        try {
          if (already) {
            await getJson(`/api/plugins/wxmp/subscribe?_method=delete&fakeid=${encodeURIComponent(entry.fakeid)}`)
          } else {
            const params = new URLSearchParams({ _method: 'post' })
            params.set('fakeid', entry.fakeid)
            params.set('nickname', entry.nickname || '')
            params.set('alias', entry.alias || '')
            params.set('headImg', entry.headImg || entry.roundHeadImg || '')
            await getJson(`/api/plugins/wxmp/subscribe?${params.toString()}`)
          }
          if (typeof onSubscribed === 'function') onSubscribed()
        } catch (err) {
          setActionError(err.message || (already ? '退订失败' : '订阅失败'))
        } finally {
          setBusyId('')
        }
      }, [subscribedIds, onSubscribed])

      return h('div', { className: 'wxmp-body' },
        h('div', { className: 'wxmp-search' },
          h('input', {
            type: 'search',
            value: query,
            placeholder: '搜索公众号名称',
            'aria-label': '搜索公众号',
            spellCheck: false,
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') search(query)
              if (event.key === 'Escape') { event.stopPropagation(); setQuery('') }
            },
          }),
          h('button', {
            className: 'wxmp-button',
            type: 'button',
            disabled: searching || !query.trim(),
            onClick: () => search(query),
          }, searching ? '搜索中…' : '搜索')),
        searchError ? h('p', { className: 'wxmp-alert' }, searchError) : null,
        actionError ? h('p', { className: 'wxmp-alert' }, actionError) : null,
        searching ? h(Skeleton) : null,
        !searching && results
          ? results.length === 0
            ? h(EmptyState, { text: '没有找到相关公众号。' })
            : h('div', { className: 'wxmp-section' },
                h('p', { className: 'wxmp-section-label' }, '搜索结果'),
                h('div', { className: 'wxmp-list' }, results.map((entry) =>
                  h('div', { className: 'wxmp-card', key: entry.fakeid },
                    h(Avatar, { src: entry.headImg || entry.roundHeadImg, alt: entry.nickname }),
                    h('div', { className: 'wxmp-card-main' },
                      h('span', { className: 'wxmp-name' }, entry.nickname || '（未命名）'),
                      h('span', { className: 'wxmp-sub' }, entry.alias || entry.fakeid)),
                    h('button', {
                      className: 'wxmp-button',
                      type: 'button',
                      disabled: busyId === entry.fakeid,
                      onClick: () => toggleSubscribe(entry),
                    }, subscribedIds.has(entry.fakeid) ? '退订' : '订阅')))))
          : null,
        h(SubscribedList, {
          subscriptions,
          subsState,
          onReloadSubs,
          onSync,
          syncing,
          syncError,
          pollStatus,
          pollBusy,
          onPollAction,
        }))
    }

    /** 已订阅列表：分类编辑 / RSS 链接复制 / lastPoll / 导出 / 同步与轮询控制。 */
    function SubscribedList({ subscriptions, subsState, onReloadSubs, onSync, syncing, syncError, pollStatus, pollBusy, onPollAction }) {
      const [catDraft, setCatDraft] = useState({})
      const [catBusy, setCatBusy] = useState('')
      const [catError, setCatError] = useState('')
      const [copiedId, setCopiedId] = useState('')
      const [exportState, setExportState] = useState({ busyId: '', path: '', error: '', info: '' })

      const saveCategory = useCallback(async (entry) => {
        if (!entry || !entry.fakeid) return
        const value = catDraft[entry.fakeid] !== undefined ? catDraft[entry.fakeid] : (entry.category || '')
        setCatBusy(entry.fakeid)
        setCatError('')
        try {
          const params = new URLSearchParams({ _method: 'set_category' })
          params.set('fakeid', entry.fakeid)
          params.set('category', value)
          await getJson(`/api/plugins/wxmp/subscriptions?${params.toString()}`)
          if (typeof onReloadSubs === 'function') onReloadSubs()
        } catch (err) {
          setCatError(err.message || '保存分类失败')
        } finally {
          setCatBusy('')
        }
      }, [catDraft, onReloadSubs])

      const copyRss = useCallback(async (entry) => {
        const url = window.location.origin + '/api/plugins/wxmp/rss/' + encodeURIComponent(entry.fakeid) + '.xml'
        const ok = await copyText(url)
        if (!ok) return
        setCopiedId(entry.fakeid)
        window.setTimeout(() => setCopiedId(''), 2000)
      }, [])

      const runExport = useCallback(async (entry, format) => {
        if (!entry || !entry.fakeid || !format) return
        setExportState({ busyId: entry.fakeid, path: '', error: '', info: '' })
        try {
          const path = '/api/plugins/wxmp/export/' + encodeURIComponent(entry.fakeid) + '.' + format + '?_method=export&range=all'
          const payload = await getJson(path)
          setExportState({
            busyId: '',
            path: payload.downloadPath || '',
            error: '',
            info: `${entry.nickname || entry.fakeid} 导出成功：${payload.count} 篇${payload.truncated ? '（已截断）' : ''} · ${payload.filename || format}`,
          })
        } catch (err) {
          setExportState({ busyId: '', path: '', error: err.message || '导出失败', info: '' })
        }
      }, [])

      const pollText = pollStatus
        ? `轮询：每 ${Math.max(1, Math.round((pollStatus.pollIntervalMs || 0) / 60000))} 分钟` +
          (pollStatus.lastPollAt ? ` · 上次 ${relativeTime(pollStatus.lastPollAt)}` : ' · 还未轮询') +
          (pollStatus.paused ? ' · 已暂停' : '')
        : ''

      return h('div', { className: 'wxmp-section' },
        h('div', { className: 'wxmp-toolbar' },
          h('button', {
            className: 'wxmp-button', type: 'button', disabled: syncing, onClick: onSync,
            title: '遍历订阅，从微信拉最新文章入库',
          }, syncing ? '同步中…' : '手动同步'),
          pollStatus ? h('button', {
            className: 'wxmp-button', type: 'button', disabled: pollBusy,
            onClick: () => onPollAction(pollStatus.paused ? 'resume' : 'pause'),
          }, pollBusy ? '处理中…' : pollStatus.paused ? '恢复轮询' : '暂停轮询') : null,
          pollStatus ? h('button', {
            className: 'wxmp-button', type: 'button', disabled: pollBusy,
            onClick: () => onPollAction('post'),
            title: '手动触发一轮订阅增量轮询',
          }, '立即轮询') : null,
          pollText ? h('span', { className: 'wxmp-meta' }, pollText) : null),
        syncError ? h('p', { className: 'wxmp-alert' }, syncError) : null,
        catError ? h('p', { className: 'wxmp-alert' }, catError) : null,
        h('p', { className: 'wxmp-section-label' }, '已订阅'),
        subsState.status === 'loading' ? h(Skeleton)
          : subsState.status === 'error' ? h(ErrorState, { message: subsState.error, onRetry: onReloadSubs })
          : !subscriptions || subscriptions.length === 0 ? h(EmptyState, { text: '还没有订阅任何公众号。' })
          : h('div', { className: 'wxmp-list' }, subscriptions.map((entry) =>
              h('div', { className: 'wxmp-card', key: entry.fakeid, style: { flexWrap: 'wrap', alignItems: 'flex-start' } },
                h(Avatar, { src: entry.headImg, alt: entry.nickname }),
                h('div', { className: 'wxmp-card-main' },
                  h('span', { className: 'wxmp-name' },
                    entry.nickname || '（未命名）',
                    entry.category ? h('span', { className: 'wxmp-badge', style: { marginLeft: '6px', fontWeight: '400' } }, entry.category) : null),
                  h('span', { className: 'wxmp-sub' },
                    (entry.alias || entry.fakeid) + ' · 文章 ' + (entry.articleCount || 0) +
                    (entry.lastPoll ? ' · 上次同步 ' + relativeTime(entry.lastPoll) : '')),
                  h('div', { className: 'wxmp-row-actions', style: { justifyContent: 'flex-start', marginTop: '4px' } },
                    h('input', {
                      className: 'wxmp-inline-input',
                      type: 'text',
                      value: catDraft[entry.fakeid] !== undefined ? catDraft[entry.fakeid] : (entry.category || ''),
                      placeholder: '分类',
                      'aria-label': '分类',
                      spellCheck: false,
                      onChange: (event) => {
                        const value = event.target.value
                        setCatDraft((draft) => ({ ...draft, [entry.fakeid]: value }))
                      },
                      onKeyDown: (event) => { if (event.key === 'Enter') saveCategory(entry) },
                    }),
                    h('button', {
                      className: 'wxmp-button', type: 'button', disabled: catBusy === entry.fakeid,
                      onClick: () => saveCategory(entry),
                    }, catBusy === entry.fakeid ? '保存中…' : '保存分类'),
                    h('a', {
                      className: 'wxmp-link', role: 'button', tabIndex: 0,
                      onClick: () => copyRss(entry),
                      onKeyDown: (event) => { if (event.key === 'Enter') copyRss(entry) },
                      title: '点击复制该号的 RSS 链接',
                    }, copiedId === entry.fakeid ? '已复制 ✓' : 'RSS 链接'))),
                h('div', { className: 'wxmp-row-actions' },
                  h('select', {
                    className: 'wxmp-select',
                    'aria-label': '导出格式',
                    value: '',
                    onChange: (event) => { const format = event.target.value; if (format) runExport(entry, format) },
                  }, [h('option', { value: '', key: '' }, '导出为…'),
                      ...EXPORT_FORMATS.map((format) => h('option', { value: format, key: format }, format.toUpperCase()))]),
                  h('button', {
                    className: 'wxmp-button', type: 'button',
                    disabled: exportState.busyId === entry.fakeid,
                    onClick: () => runExport(entry, 'md'),
                  }, exportState.busyId === entry.fakeid ? '导出中…' : '导出 MD')))),
        exportState.error ? h('p', { className: 'wxmp-alert' }, exportState.error) : null,
        exportState.info ? h('p', { className: 'wxmp-sub' },
          exportState.info,
          exportState.path ? h('a', {
            className: 'wxmp-link', style: { marginLeft: '8px' }, href: exportState.path,
            target: '_blank', rel: 'noreferrer', referrerPolicy: 'no-referrer',
          }, '下载文件 ↗') : null) : null))
    }

    /** 极简 markdown 渲染：# 前缀 → 标题，- → 列表项，其余按段落。 */
    function renderMarkdown(text) {
      const lines = String(text || '').split(/\r?\n/)
      const blocks = []
      let list = null
      const flush = () => {
        if (list && list.items.length > 0) blocks.push(list.node)
        list = null
      }
      for (const raw of lines) {
        const line = raw.trim()
        if (!line) { flush(); continue }
        if (line.startsWith('#')) {
          flush()
          const level = line.match(/^#+/)
          const depth = level ? level[0].length : 1
          blocks.push(h('p', { className: 'wxmp-md-h' + (depth >= 2 ? ' wxmp-md-h2' : '') }, line.replace(/^#+\s*/, '')))
        } else if (line.startsWith('-')) {
          if (!list) list = { items: [], node: null }
          list.items.push(line.replace(/^[-]+\s*/, ''))
        } else {
          flush()
          blocks.push(h('p', { className: 'wxmp-md-p' }, line))
        }
      }
      flush()
      return h('div', { className: 'wxmp-md' }, ...blocks)
    }

    /** 正文抽屉：createPortal 到 document.body（宿主会裁剪 position:fixed）。 */
    function ArticleDrawer({ target, onClose }) {
      const [state, setState] = useState({ status: 'idle', article: null, error: '' })
      const [retryNonce, setRetryNonce] = useState(0)

      useEffect(() => {
        if (!target) { setState({ status: 'idle', article: null, error: '' }); return }
        const controller = new AbortController()
        let alive = true
        setState({ status: 'loading', article: null, error: '' })
        // 本地库不存正文，且 memory/storage 后端的 id 不稳定：抽屉统一按链接现抓。
        const url = target.sourceUrl || target.link
        getJson(`/api/plugins/wxmp/article?link=${encodeURIComponent(url || '')}`, controller.signal)
          .then((payload) => { if (alive) setState({ status: 'ready', article: payload.article || null, error: '' }) })
          .catch((err) => {
            if (!alive || (err && err.name === 'AbortError')) return
            setState({ status: 'error', article: null, error: err.message || '加载失败' })
          })
        return () => { alive = false; controller.abort() }
      }, [target, retryNonce])

      useEffect(() => {
        if (!target) return
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [target, onClose])

      if (!target) return null
      return ReactDOM.createPortal(
        h(React.Fragment, null,
          h('div', { className: 'wxmp-drawer-backdrop', onClick: onClose }),
          h('aside', { className: 'wxmp-drawer', role: 'dialog', 'aria-label': '文章正文' },
            h('div', { className: 'wxmp-drawer-head' },
              h('h3', { className: 'wxmp-drawer-title' }, target.title || '文章'),
              h('button', { className: 'wxmp-button', type: 'button', onClick: onClose }, '关闭')),
            h('div', { className: 'wxmp-drawer-body' },
              h('div', { className: 'wxmp-drawer-meta' },
                target.author ? h('span', null, target.author) : null,
                target.publishTimeStr ? h('span', null, target.publishTimeStr) : null,
                target.sourceUrl ? h('a', { className: 'wxmp-link', href: target.sourceUrl, target: '_blank', rel: 'noreferrer', referrerPolicy: 'no-referrer' }, '查看原文 ↗') : null),
              state.status === 'loading' ? h(Skeleton)
                : state.status === 'error' ? h(ErrorState, { message: state.error, onRetry: () => setRetryNonce((v) => v + 1) })
                : state.article
                  ? h(React.Fragment, null,
                      state.article.title && state.article.title !== target.title
                        ? h('div', { className: 'wxmp-drawer-meta' }, state.article.title) : null,
                      renderMarkdown(state.article.markdown))
                  : h(EmptyState, { text: '正文为空。' })))),
        document.body)
    }

    /** 文章 tab：左栏公众号过滤 + 右栏文章列表 + 抽屉读正文 + 顶部同步。 */
    function ArticlesTab({ subscriptions, onOpenArticle, onSync, syncing, syncError }) {
      const [filter, setFilter] = useState('')
      const [catFilter, setCatFilter] = useState('')
      const [state, setState] = useState({ status: 'loading', articles: [], error: '' })
      const [nonce, setNonce] = useState(0)

      const subById = new Map((subscriptions || []).map((entry) => [String(entry.fakeid), entry]))
      const categories = []
      for (const entry of subscriptions || []) {
        const cat = String(entry.category || '').trim()
        if (cat && categories.indexOf(cat) < 0) categories.push(cat)
      }
      const visibleArticles = catFilter
        ? (state.articles || []).filter((article) => {
            const sub = subById.get(String(article.fakeid))
            return !!sub && String(sub.category || '').trim() === catFilter
          })
        : (state.articles || [])

      useEffect(() => {
        const controller = new AbortController()
        let alive = true
        setState({ status: 'loading', articles: [], error: '' })
        const url = filter
          ? `/api/plugins/wxmp/articles?fakeid=${encodeURIComponent(filter)}&limit=50`
          : '/api/plugins/wxmp/articles?limit=50'
        getJson(url, controller.signal)
          .then((payload) => { if (alive) setState({ status: 'ready', articles: Array.isArray(payload.articles) ? payload.articles : [], error: '' }) })
          .catch((err) => {
            if (!alive || (err && err.name === 'AbortError')) return
            setState({ status: 'error', articles: [], error: err.message || '加载失败' })
          })
        return () => { alive = false; controller.abort() }
      }, [filter, nonce])

      return h('div', { className: 'wxmp-articles' },
        h('nav', { className: 'wxmp-articles-side', 'aria-label': '公众号过滤' },
          h('button', {
            className: 'wxmp-chip',
            type: 'button',
            'aria-pressed': filter === '',
            onClick: () => setFilter(''),
          }, '全部'),
          (subscriptions || []).map((entry) =>
            h('button', {
              key: entry.fakeid,
              className: 'wxmp-chip',
              type: 'button',
              'aria-pressed': filter === entry.fakeid,
              title: entry.nickname || '',
              onClick: () => setFilter(entry.fakeid),
            }, entry.nickname || entry.fakeid))),
        h('div', { className: 'wxmp-articles-main' },
          h('div', { className: 'wxmp-toolbar' },
            h('button', {
              className: 'wxmp-button',
              type: 'button',
              disabled: syncing,
              onClick: onSync,
              title: '拉取订阅公众号的最新文章',
            }, syncing ? '同步中…' : '同步'),
            h('label', { className: 'wxmp-meta', style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
              '按分类',
              h('select', {
                className: 'wxmp-select',
                'aria-label': '按分类过滤',
                value: catFilter,
                onChange: (event) => setCatFilter(event.target.value),
              }, [h('option', { value: '', key: '' }, '全部分类'),
                  ...categories.map((cat) => h('option', { value: cat, key: cat }, cat))])),
            syncError ? h('span', { className: 'wxmp-alert' }, syncError) : null),
          state.status === 'loading' ? h(Skeleton)
            : state.status === 'error' ? h(ErrorState, { message: state.error, onRetry: () => setNonce((v) => v + 1) })
            : visibleArticles.length === 0 ? h(EmptyState, { text: '没有匹配的文章。先在「订阅」里关注公众号，再点「同步」。' })
            : h('div', { className: 'wxmp-list' }, visibleArticles.map((article) => {
                const sub = subById.get(String(article.fakeid))
                return h('button', {
                  key: article.id,
                  className: 'wxmp-article-item',
                  type: 'button',
                  onClick: () => onOpenArticle(article),
                },
                  h('span', { className: 'wxmp-article-title' }, article.title || '（无标题）'),
                  article.digest ? h('p', { className: 'wxmp-article-digest' }, article.digest) : null,
                  h('div', { className: 'wxmp-article-meta' },
                    sub ? h('span', null, sub.nickname || article.fakeid) : null,
                    article.author ? h('span', null, article.author) : null,
                    article.publishTimeStr ? h('span', null, article.publishTimeStr) : null,
                    article.sourceUrl ? h('a', {
                      className: 'wxmp-link',
                      href: article.sourceUrl,
                      target: '_blank',
                      rel: 'noreferrer',
                      referrerPolicy: 'no-referrer',
                      onClick: (event) => event.stopPropagation(),
                    }, '原文 ↗') : null))
              }))))
    }

    /** Webhook 管理 tab：列表 / 添加 / 删除（/webhooks?_method=list|add|remove）。 */
    function WebhooksTab() {
      const [state, setState] = useState({ status: 'loading', list: [], error: '' })
      const [url, setUrl] = useState('')
      const [busy, setBusy] = useState(false)
      const [actionError, setActionError] = useState('')
      const [notice, setNotice] = useState('')

      const load = useCallback(() => {
        const controller = new AbortController()
        let alive = true
        setState({ status: 'loading', list: [], error: '' })
        getJson('/api/plugins/wxmp/webhooks?_method=list', controller.signal)
          .then((payload) => {
            if (!alive) return
            const list = Array.isArray(payload.list) ? payload.list : Array.isArray(payload.webhooks) ? payload.webhooks : []
            setState({ status: 'ready', list, error: '' })
          })
          .catch((err) => {
            if (!alive || (err && err.name === 'AbortError')) return
            setState({ status: 'error', list: [], error: err.message || '加载失败' })
          })
        return () => { alive = false; controller.abort() }
      }, [])

      useEffect(() => load(), [load])

      const add = useCallback(async () => {
        const value = url.trim()
        if (!value) return
        setBusy(true)
        setActionError('')
        setNotice('')
        try {
          const params = new URLSearchParams({ _method: 'add' })
          params.set('url', value)
          await getJson(`/api/plugins/wxmp/webhooks?${params.toString()}`)
          setUrl('')
          setNotice('已添加 Webhook。')
          load()
        } catch (err) {
          setActionError(err.message || '添加 Webhook 失败')
        } finally {
          setBusy(false)
        }
      }, [url, load])

      const remove = useCallback(async (entry) => {
        setBusy(true)
        setActionError('')
        setNotice('')
        try {
          const params = new URLSearchParams({ _method: 'remove' })
          if (entry && entry.id !== undefined && entry.id !== null) params.set('id', String(entry.id))
          else params.set('url', String((entry && entry.url) || entry || ''))
          await getJson(`/api/plugins/wxmp/webhooks?${params.toString()}`)
          setNotice('已删除 Webhook。')
          load()
        } catch (err) {
          setActionError(err.message || '删除 Webhook 失败')
        } finally {
          setBusy(false)
        }
      }, [load])

      return h('div', { className: 'wxmp-body' },
        h('div', { className: 'wxmp-section' },
          h('p', { className: 'wxmp-section-label' }, 'Webhook'),
          h('span', { className: 'wxmp-sub' }, '轮询/同步到新文章时按下面的 URL 列表推送通知。'),
          h('div', { className: 'wxmp-search', style: { flex: '1 1 320px' } },
            h('input', {
              type: 'url',
              value: url,
              placeholder: 'https://example.com/webhook',
              'aria-label': 'Webhook URL',
              spellCheck: false,
              onChange: (event) => setUrl(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') add() },
            }),
            h('button', {
              className: 'wxmp-button',
              type: 'button',
              disabled: busy || !url.trim(),
              onClick: add,
            }, busy ? '处理中…' : '添加')),
          actionError ? h('p', { className: 'wxmp-alert' }, actionError) : null,
          notice ? h('p', { className: 'wxmp-sub' }, notice) : null,
          state.status === 'loading' ? h(Skeleton)
            : state.status === 'error' ? h(ErrorState, { message: state.error, onRetry: load })
            : state.list.length === 0 ? h(EmptyState, { text: '还没有 Webhook。' })
            : h('div', { className: 'wxmp-list' }, state.list.map((entry, index) => {
                const target = typeof entry === 'string' ? entry : (entry && entry.url) || ''
                const key = entry && entry.id !== undefined && entry.id !== null ? String(entry.id) : target + '#' + index
                return h('div', { className: 'wxmp-card', key },
                  h('div', { className: 'wxmp-card-main' },
                    h('span', { className: 'wxmp-name', style: { overflowWrap: 'anywhere', whiteSpace: 'normal' } }, target || '（无 URL）'),
                    entry && entry.createdAt ? h('span', { className: 'wxmp-sub' }, '添加于 ' + relativeTime(entry.createdAt)) : null),
                  h('button', {
                    className: 'wxmp-button',
                    type: 'button',
                    disabled: busy,
                    onClick: () => remove(entry),
                  }, '删除'))
              }))))
    }

    /** 四个 tab 的整页视图。 */
    function Page() {
      const [tab, setTab] = useState('login')
      const [subsState, setSubsState] = useState({ status: 'loading', list: [], error: '' })
      const [articleTarget, setArticleTarget] = useState(null)
      const [syncing, setSyncing] = useState(false)
      const [syncError, setSyncError] = useState('')
      const [pollStatus, setPollStatus] = useState(null)
      const [pollBusy, setPollBusy] = useState(false)

      const loadPollStatus = useCallback(() => {
        const controller = new AbortController()
        getJson('/api/plugins/wxmp/rss/poll?_method=status', controller.signal)
          .then((payload) => {
            setPollStatus({
              paused: !!payload.paused,
              pollIntervalMs: Number(payload.pollIntervalMs) || 0,
              lastPollAt: payload.lastPollAt || null,
            })
          })
          .catch(() => { /* 状态拉不到时静默，不阻塞订阅列表 */ })
        return () => controller.abort()
      }, [])

      const onPollAction = useCallback(async (method) => {
        setPollBusy(true)
        try {
          const payload = await getJson(`/api/plugins/wxmp/rss/poll?_method=${encodeURIComponent(method)}`)
          setPollStatus({
            paused: !!payload.paused,
            pollIntervalMs: Number(payload.pollIntervalMs) || 0,
            lastPollAt: payload.lastPollAt || null,
          })
        } catch (err) {
          setSyncError(err.message || '轮询操作失败')
        } finally {
          setPollBusy(false)
        }
      }, [])

      const reloadSubs = useCallback(() => {
        const controller = new AbortController()
        let alive = true
        setSubsState({ status: 'loading', list: [], error: '' })
        getJson('/api/plugins/wxmp/subscriptions', controller.signal)
          .then((payload) => { if (alive) setSubsState({ status: 'ready', list: Array.isArray(payload.list) ? payload.list : [], error: '' }) })
          .catch((err) => {
            if (!alive || (err && err.name === 'AbortError')) return
            setSubsState({ status: 'error', list: [], error: err.message || '加载失败' })
          })
        return () => { alive = false; controller.abort() }
      }, [])

      useEffect(() => {
        if (tab !== 'subs' && tab !== 'articles') return
        return reloadSubs()
      }, [tab, reloadSubs])

      useEffect(() => {
        if (tab !== 'subs') return
        return loadPollStatus()
      }, [tab, loadPollStatus])

      const sync = useCallback(async () => {
        setSyncing(true)
        setSyncError('')
        try {
          await getJson('/api/plugins/wxmp/sync?_method=post')
        } catch (err) {
          setSyncError(err.message || '同步失败')
        } finally {
          setSyncing(false)
        }
      }, [])

      return h('div', { className: 'wxmp-page' },
        h('div', { className: 'wxmp-topbar' },
          h('div', { className: 'wxmp-tabs-wrap' },
            h('div', { className: 'wxmp-tabs', role: 'tablist' },
              TABS.map((entry) =>
                h('button', {
                  key: entry.id,
                  type: 'button',
                  role: 'tab',
                  className: 'wxmp-tab',
                  'aria-selected': entry.id === tab,
                  onClick: () => setTab(entry.id),
                }, entry.label)))),
          h('div', { className: 'wxmp-topbar-tools' },
            h('span', { className: 'wxmp-meta' }, '微信公众号助手'))),
        tab === 'login' ? h(LoginTab) : null,
        tab === 'subs' ? h(SubsTab, {
          subscriptions: subsState.list,
          subsState,
          onReloadSubs: reloadSubs,
          onSubscribed: reloadSubs,
          onSync: sync,
          syncing,
          syncError,
          pollStatus,
          pollBusy,
          onPollAction,
        }) : null,
        tab === 'articles' ? h(ArticlesTab, {
          subscriptions: subsState.list,
          onOpenArticle: setArticleTarget,
          onSync: sync,
          syncing,
          syncError,
        }) : null,
        tab === 'webhooks' ? h(WebhooksTab) : null,
        h(ArticleDrawer, { target: articleTarget, onClose: () => setArticleTarget(null) }))
    }

    /** 左侧栏全局面板行的字形：16×16，data-dsh-panel-entry 是 shell 认行的唯一钩子。 */
    function WxmpPanelIcon({ size = 16 }) {
      return h('svg', {
        'data-dsh-panel-entry': PANEL_ID,
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('rect', { x: 1.75, y: 2.75, width: 9, height: 9, rx: 1.5 }),
        h('circle', { cx: 5.25, cy: 6.5, r: 0.4, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 7.5, cy: 6.5, r: 0.4, fill: 'currentColor', stroke: 'none' }),
        h('path', { d: 'M11.5 6.2c1.5 0.4 2.5 1.5 2.5 2.9 0 0.8-0.3 1.5-0.9 2.1' }),
        h('path', { d: 'M10.8 10.2c0.4 0.5 1 0.8 1.7 0.8' }))
    }

    /** 左侧栏全局面板页（`main` 槽 keyed 页面），只在选中时挂载。 */
    function WxmpPanelPage() {
      return h('div', { className: 'wxmp-panel', 'data-dsh-panel-view': PANEL_ID }, h(Page))
    }

    /** 视图页自己管理样式：apply 里注册，卸载时删除。 */
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      const existing = document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)
      if (existing) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = '@local/dsh-wxmp'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => installStyles(), 'dsh-wxmp: page styles')

        // 左侧栏全局面板行：只提供字形，行框/label/高亮属于 shell。
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register(
                { name: 'sidebar.panellist', id: PANEL_ID, order: 60, label: () => '公众号' },
                WxmpPanelIcon,
              ),
            ),
          'dsh-wxmp: 公众号 sidebar row',
        )

        // 中心列页面本体：`main` 槽按 key 选面板，只有选中时才挂载。
        ctx.effect(
          () =>
            ctx.slots.inject('main', () =>
              ctx.slots.register({ name: 'main', key: PANEL_ID }, WxmpPanelPage),
            ),
          'dsh-wxmp: 公众号 panel page',
        )
      },
    }
  },
})
