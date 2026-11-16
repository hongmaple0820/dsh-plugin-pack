/**
 * @local/dsh-aihot · Client 半边。
 *
 * 在 layout 的 `main` 槽上注册整页视图「AI 资讯」（入口是左侧栏全局面板行）：
 * 四个 tab（精选 / 热点 / 日报 / 福利）+ 分类过滤 + 刷新，卡片链回 aihot.news 阅读页；
 * 「日报」tab 里还有期刊分段（日报 / 周报 / 月报，周报月报可选期号），卡片可展开事件时间线抽屉（可复制链接）。
 *
 * 约束：只用 `require('react')`；颜色只用 `--dsw-alias-*` 主题 token；不 iframe、不碰别人的 DOM；
 * 数据全部走 Host 端代理路由 `/api/plugins/aihot/*`（浏览器不直接跨域请求 aihot.news）。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-aihot',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const STYLE_ID = '@local/dsh-aihot/page.css'
    const HOME_URL = 'https://aihot.news/'
    /** 左侧栏全局面板的 id / `main` 槽 key。 */
    const PANEL_ID = 'aihot'

    const CSS = `
.aihot-page{display:flex;flex-direction:column;box-sizing:border-box;width:100%;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.aihot-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;padding:14px 20px 24px}
/* 顶栏：主行（tab 段控件 + 工具）固定基线 28px，上下文行（过滤 / 期号 / 搜索摘要）只在有内容时出现。 */
.aihot-topbar{position:relative;flex:0 0 auto;z-index:3;display:flex;flex-direction:column;gap:6px;box-sizing:border-box;padding:10px 20px 8px;background:var(--dsw-alias-bg-base);border-bottom:.5px solid var(--dsw-alias-border-l2)}
.aihot-topbar-main{display:flex;align-items:center;gap:10px;min-width:0}
.aihot-tabs-wrap{flex:0 1 auto;min-width:0;overflow:hidden}
.aihot-tabs{display:flex;align-items:center;gap:2px;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;padding:2px;border-radius:var(--dsw-radius-md, 8px);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2)}
.aihot-tabs::-webkit-scrollbar{display:none}
.aihot-tab{flex:none;appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;height:24px;padding:0 10px;border-radius:var(--dsw-radius-sm, 6px);cursor:pointer;white-space:nowrap;transition:background-color .12s ease,color .12s ease}
.aihot-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.aihot-tab[aria-selected="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3)}
.aihot-topbar-tools{display:flex;align-items:center;gap:8px;margin-left:auto;flex:0 0 auto;min-width:0}
.aihot-topbar-sub{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:24px}
.aihot-group{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.aihot-group-label{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;white-space:nowrap}
.aihot-vr{flex:none;width:1px;height:14px;background:var(--dsw-alias-border-l2)}
.aihot-topbar-meta{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;white-space:nowrap;font-variant-numeric:tabular-nums}
.aihot-updated{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.aihot-button{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:5px;height:28px;box-sizing:border-box;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;border-radius:var(--dsw-radius-sm, 6px);cursor:pointer}
.aihot-button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.aihot-button:disabled{opacity:.6;cursor:default}
.aihot-refresh svg{transition:transform .2s ease}
.aihot-refresh[data-busy="true"] svg{animation:aihot-spin 1s linear infinite}
@keyframes aihot-spin{to{transform:rotate(360deg)}}
.aihot-filters{display:flex;align-items:center;gap:6px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:12px}
.aihot-chip{appearance:none;display:inline-flex;align-items:center;height:24px;box-sizing:border-box;padding:0 9px;border:.5px solid transparent;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;border-radius:var(--dsw-radius-sm, 6px);cursor:pointer;white-space:nowrap;transition:background-color .12s ease,color .12s ease,border-color .12s ease}
.aihot-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.aihot-chip[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}
.aihot-tab:focus-visible,.aihot-chip:focus-visible,.aihot-button:focus-visible,.aihot-search:focus-within{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.aihot-list{display:flex;flex-direction:column;gap:8px}
.aihot-card{display:flex;flex-direction:column;gap:6px;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg, 10px);background:var(--dsw-alias-bg-layer-1)}
.aihot-card:hover{background:var(--dsw-alias-interactive-bg-hover)}
.aihot-title{font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary);text-decoration:none}
.aihot-title:hover{color:var(--dsw-alias-brand-primary)}
.aihot-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.aihot-badge{display:inline-flex;align-items:center;padding:0 6px;border-radius:var(--dsw-radius-xs, 4px);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.aihot-summary{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.aihot-reason{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.aihot-lead{display:flex;flex-direction:column;gap:6px;padding:14px 16px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg, 10px);background:var(--dsw-alias-bg-layer-2)}
.aihot-lead-title{margin:0;font-size:15px;line-height:24px;font-weight:600;color:var(--dsw-alias-label-primary)}
.aihot-section{display:flex;flex-direction:column;gap:8px;margin-top:4px}
.aihot-section-label{margin:0;font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}
.aihot-state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:48px 16px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;text-align:center}
.aihot-state-error{color:var(--dsw-alias-state-error-primary)}
.aihot-skeleton{display:flex;flex-direction:column;gap:10px}
.aihot-skeleton-row{height:64px;border-radius:var(--dsw-radius-lg, 10px);background:var(--dsw-alias-bg-skeleton)}
.aihot-footer{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.aihot-link{color:var(--dsw-alias-brand-primary);text-decoration:none}
.aihot-link:hover{text-decoration:underline}
.aihot-resets{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px}
.aihot-reset{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg, 10px);background:var(--dsw-alias-bg-layer-1)}
.aihot-reset:hover{background:var(--dsw-alias-interactive-bg-hover)}
.aihot-reset-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.aihot-reset-name{font-size:14px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary)}
.aihot-reset-status{font-weight:400}
.aihot-reset-status-confirmed{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.aihot-reset-status-pending{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.aihot-reset-status-expired{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.aihot-reset-rows{display:flex;flex-direction:column;gap:4px}
.aihot-reset-row{display:flex;gap:8px;font-size:12px;line-height:18px}
.aihot-reset-key{flex:none;min-width:56px;color:var(--dsw-alias-label-tertiary)}
.aihot-reset-value{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary);word-break:break-word}
.aihot-reset-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:6px;border-top:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.aihot-note{margin:0;color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px}
.aihot-title-row{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.aihot-title-row>.aihot-title{flex:1 1 auto;min-width:0}
.aihot-story-link{flex:none;appearance:none;border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;padding:1px 8px;border-radius:var(--dsw-radius-sm, 6px);cursor:pointer;white-space:nowrap}
.aihot-story-link:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.aihot-card-actions{flex:none;display:flex;align-items:center;gap:6px}
.aihot-article-link{flex:none;appearance:none;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-dimmed);font:inherit;font-size:12px;line-height:18px;padding:1px 8px;border-radius:var(--dsw-radius-sm, 6px);cursor:pointer;white-space:nowrap}
.aihot-article-link:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.aihot-save-link{flex:none;appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;line-height:18px;padding:1px 4px;border-radius:var(--dsw-radius-sm, 6px);cursor:pointer}
.aihot-save-link:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.aihot-save-link[aria-pressed="true"]{color:var(--dsw-alias-brand-primary)}
.aihot-unsave-link{flex:none;appearance:none;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;padding:1px 8px;border-radius:var(--dsw-radius-sm, 6px);cursor:pointer;white-space:nowrap}
.aihot-unsave-link:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l3)}
.aihot-export-link,.aihot-clear-link{flex:none;appearance:none;display:inline-flex;align-items:center;height:24px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-dimmed);font:inherit;font-size:12px;line-height:18px;padding:0 9px;border-radius:var(--dsw-radius-sm, 6px);cursor:pointer;white-space:nowrap}.aihot-export-link:hover,.aihot-clear-link:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l3)}
.aihot-clear-link[aria-pressed="true"]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.aihot-export-link:disabled,.aihot-clear-link:disabled{opacity:.5;cursor:default}
.aihot-export-link:disabled:hover,.aihot-clear-link:disabled:hover{background:transparent;color:var(--dsw-alias-label-dimmed);border-color:var(--dsw-alias-border-l2)}
.aihot-card.is-read{border-left:2px solid var(--dsw-alias-border-l3);padding-left:12px}
.aihot-card.is-read .aihot-title{color:var(--dsw-alias-label-secondary)}
.aihot-card.is-read .aihot-summary{color:var(--dsw-alias-label-tertiary)}
.aihot-chip:disabled{opacity:.5;cursor:default}
.aihot-chip:disabled:hover{background:transparent;color:var(--dsw-alias-label-tertiary)}
.aihot-drawer-wide{width:min(560px,94vw)}
.aihot-article-p{margin:0;font-size:14px;line-height:1.75;color:var(--dsw-alias-label-primary);max-width:60em;overflow-wrap:anywhere}
.aihot-alert{color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px}
.aihot-drawer-backdrop{position:fixed;inset:0;z-index:1000;background:var(--dsw-alias-bg-mask-1)}
.aihot-drawer{position:fixed;top:0;right:0;bottom:0;z-index:1001;width:min(440px,94vw);display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1)}
.aihot-drawer-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:.5px solid var(--dsw-alias-border-l1);border-left:.5px solid var(--dsw-alias-border-l2)}
.aihot-drawer-title{margin:0;font-size:15px;line-height:24px;font-weight:600;color:var(--dsw-alias-label-primary)}
.aihot-drawer-body{flex:1 1 auto;min-height:0;overflow:auto;padding:14px 16px 20px;display:flex;flex-direction:column;gap:10px}
.aihot-drawer-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.aihot-timeline{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}
.aihot-timeline-item{position:relative;display:flex;gap:10px;padding:0 0 12px 14px;border-left:1px solid var(--dsw-alias-border-l2)}
.aihot-timeline-item:last-child{border-left-color:transparent;padding-bottom:0}
.aihot-timeline-item::before{content:"";position:absolute;left:-3.5px;top:5px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary)}
.aihot-timeline-time{flex:none;width:66px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.aihot-timeline-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}
.aihot-related{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}
.aihot-journal{display:flex;flex-direction:column;gap:10px}

.aihot-journal-head{display:flex;flex-direction:column;gap:6px;padding:14px 16px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg, 10px);background:var(--dsw-alias-bg-layer-2)}
.aihot-journal-title{margin:0;font-size:15px;line-height:24px;font-weight:600;color:var(--dsw-alias-label-primary)}
.aihot-journal-overview{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;white-space:pre-wrap}
.aihot-journal-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.aihot-section-summary{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;white-space:pre-wrap}
.aihot-drawer-actions{flex:none;display:flex;align-items:center;gap:6px}
.aihot-panel{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base)}
.aihot-panel>.aihot-page{flex:1 1 auto;min-height:0}
.aihot-search{display:flex;align-items:center;gap:6px;flex:0 1 200px;min-width:130px;height:28px;box-sizing:border-box;padding:0 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md, 8px);background:var(--dsw-alias-bg-layer-1);transition:border-color .12s ease}
.aihot-search:focus-within{border-color:var(--dsw-alias-border-l3)}
.aihot-search svg{flex:none;color:var(--dsw-alias-label-tertiary)}
.aihot-search input{flex:1 1 auto;min-width:0;border:0;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px}
.aihot-search input::placeholder{color:var(--dsw-alias-label-dimmed)}
.aihot-search-clear{flex:none;appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;line-height:18px;padding:0 2px;cursor:pointer}
.aihot-search-clear:hover{color:var(--dsw-alias-label-primary)}
.aihot-theme{display:flex;align-items:center;gap:2px;height:28px;box-sizing:border-box;padding:2px;border-radius:var(--dsw-radius-md, 8px);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2)}
.aihot-theme button{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;height:22px;padding:0 8px;border-radius:var(--dsw-radius-sm, 6px);cursor:pointer;white-space:nowrap}
.aihot-theme button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.aihot-theme button[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
/* 窄窗口：先收窄搜索与主题按钮；再窄就把工具组整体换到第二行（段控件独占一行），不做挤到折行的碎排。 */
@media (max-width:1080px){
.aihot-search{flex:0 1 150px;min-width:110px}
.aihot-theme button{padding:0 6px}
}
@media (max-width:900px){
.aihot-topbar-main{flex-wrap:wrap;row-gap:8px}
.aihot-tabs-wrap{flex:1 0 100%}
.aihot-topbar-tools{flex:1 0 100%;margin-left:0;justify-content:flex-end}
.aihot-search{flex:1 1 auto;max-width:none}
}
/* 排行榜：综合榜一张表 + 暂不排名列表 */
.aihot-board{display:flex;flex-direction:column;gap:2px}
.aihot-board-row{display:grid;grid-template-columns:32px minmax(0,1fr) 76px 64px 64px 48px;align-items:center;gap:8px;padding:6px 4px;border-bottom:.5px solid var(--dsw-alias-border-l1);font-size:12px;line-height:18px}
.aihot-board-head{color:var(--dsw-alias-label-tertiary);border-bottom-color:var(--dsw-alias-border-l2)}
.aihot-board-row .aihot-title{font-size:13px;line-height:18px;display:flex;align-items:baseline;gap:6px;min-width:0}
.aihot-board-org{color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}
.aihot-board-dim{color:var(--dsw-alias-label-tertiary)}
.aihot-board-rank{color:var(--dsw-alias-label-tertiary);font-size:12px}
.aihot-board-score{color:var(--dsw-alias-brand-primary);font-weight:600}
.aihot-board-pending{margin-top:8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.aihot-board-pending-row{display:flex;align-items:center;gap:8px;padding:4px 4px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
/* 免费额度：分区 + 每条一张小卡 */
.aihot-free{display:flex;flex-direction:column;gap:10px}
.aihot-free-item{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md, 8px);background:var(--dsw-alias-bg-layer-1)}
.aihot-free-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}
/* 重置日历 */
.aihot-calendar{display:flex;flex-direction:column;gap:8px}
.aihot-calendar-days{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px}
.aihot-calendar-day{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md, 8px);background:var(--dsw-alias-bg-layer-1)}
.aihot-calendar-date{color:var(--dsw-alias-label-secondary);font-size:12px}
.aihot-calendar-today{color:var(--dsw-alias-brand-primary);font-size:11px}
/* Agent 接入 */
.aihot-agent{display:flex;flex-direction:column;gap:8px}
.aihot-agent-card{display:flex;flex-direction:column;gap:6px;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg, 10px);background:var(--dsw-alias-bg-layer-1)}
.aihot-agent-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.aihot-agent-title{font-size:14px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary)}
.aihot-agent-copy{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm, 6px);padding:6px 8px;margin:0;white-space:pre-wrap;word-break:break-all;max-height:120px;overflow:auto}
.aihot-note-plain{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
/* v2.0：主题。只在本面板（含其抽屉）内部覆盖 DSH 的语义变量，不动全局 shell。 */
[data-aihot-theme="dark"]{color-scheme:dark;--dsw-alias-bg-base:#0f1115;--dsw-alias-bg-layer-1:#16191f;--dsw-alias-bg-layer-2:#1d2128;--dsw-alias-bg-layer-3:#252a33;--dsw-alias-bg-mask-1:rgba(0,0,0,.62);--dsw-alias-bg-skeleton:#1d2128;--dsw-alias-border-l1:#222831;--dsw-alias-border-l2:#2a3039;--dsw-alias-border-l3:#39414d;--dsw-alias-border-l4:#4a545f;--dsw-alias-label-primary:#e8ecf2;--dsw-alias-label-secondary:#b3bcc8;--dsw-alias-label-tertiary:#8a93a0;--dsw-alias-label-dimmed:#6b7481;--dsw-alias-interactive-bg-hover:#1b2027;--dsw-alias-interactive-bg-active:#232a33;--dsw-alias-settings-card-fill:#16191f}
`

    const TABS = [
      { id: 'selected', label: '精选' },
      { id: 'hot', label: '热点' },
      { id: 'daily', label: '日报' },
      { id: 'resets', label: '福利' },
      { id: 'saved', label: '收藏' },
      { id: 'leaderboard', label: '排行榜' },
      { id: 'freeTokens', label: '羊毛' },
      { id: 'resetCalendar', label: '重置日历' },
      { id: 'agent', label: '接入' },
    ]

    /** 「收藏」tab 的文案带上条数；0 条时保持「收藏」不加括号。 */
    function tabLabel(entry, savedCount) {
      if (entry.id !== 'saved' || savedCount <= 0) return entry.label
      return `${entry.label}（${savedCount}）`
    }

    /** 「日报」tab 里的期刊分段：日报走 /daily，周报月报走 /period。 */
    const PERIOD_SEGMENTS = [
      { id: 'daily', label: '日报' },
      { id: 'weekly', label: '周报' },
      { id: 'monthly', label: '月报' },
    ]

    const PERIOD_LABELS = { weekly: '周报', monthly: '月报' }

    /** 期刊索引条目 / 正文里的期号字段名。 */
    const periodIssue = (kind, entry) => (kind === 'weekly' ? entry?.week : entry?.month) ?? ''

    /** 期刊区间文案：periodStart ~ periodEnd（都是北京时间日期）。 */
    function periodRange(entry) {
      const from = entry?.periodStart ?? ''
      const to = entry?.periodEnd ?? ''
      if (from && to && from !== to) return `${from} ~ ${to}`
      return from || to || ''
    }

    const CATEGORY_FILTERS = [
      { id: '', label: '全部' },
      { id: 'ai-models', label: '模型' },
      { id: 'ai-products', label: '产品' },
      { id: 'industry', label: '行业' },
      { id: 'paper', label: '论文' },
      { id: 'tip', label: '教程' },
      { id: 'opinion', label: '观点' },
    ]

    const CATEGORY_LABELS = {
      'ai-models': '模型',
      'ai-products': '产品',
      industry: '行业',
      paper: '论文',
      tip: '教程',
      opinion: '观点',
    }

    /** 「福利」tab 的四个服务，顺序固定。 */
    const RESET_SERVICES = [
      { id: 'codex', label: 'Codex' },
      { id: 'antigravity', label: 'Antigravity' },
      { id: 'claude', label: 'Claude' },
      { id: 'grok-bot', label: 'Grok Bot' },
    ]

    /** 上游 `presentation.status`（事件 presentation 优先）→ 中文；未知值原样显示。 */
    const RESET_STATUS_LABELS = {
      announced: '已公告',
      in_progress: '进行中',
      confirmed: '已确认',
      expired_unconfirmed: '预计已过（未确认）',
      likely_completed: '大概率已完成',
    }

    /** 状态 → 徽标配色档（只用状态色别名）。 */
    const RESET_STATUS_TONES = {
      confirmed: 'confirmed',
      announced: 'pending',
      in_progress: 'pending',
      likely_completed: 'pending',
      expired_unconfirmed: 'expired',
    }

    /** 上游 `monitor.status` → 中文。 */
    const MONITOR_LABELS = { healthy: '正常', delayed: '延迟', attention: '需注意', unknown: '未知' }

    /** 北京时间（AIHOT 的「时间」都按 Asia/Shanghai 展示）。 */
    function beijingTime(iso) {
      if (!iso) return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      try {
        return new Intl.DateTimeFormat('zh-CN', {
          timeZone: 'Asia/Shanghai',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(date)
      } catch {
        return date.toISOString().slice(5, 16).replace('T', ' ')
      }
    }

    function feedPath(tab, category) {
      if (tab === 'hot') return '/api/plugins/aihot/hot'
      if (tab === 'daily') return '/api/plugins/aihot/daily'
      const params = new URLSearchParams({ window: '7d', mode: 'selected', limit: '30' })
      if (category) params.set('category', category)
      return `/api/plugins/aihot/items?${params.toString()}`
    }

    /** 从 AIHOT 链接里取 story publicId（热点卡片的 `links.story` 形如 https://aihot.news/story/<uuid>）。 */
    function storyIdFromLink(link) {
      if (typeof link !== 'string') return ''
      const match = /\/story\/([A-Za-z0-9._:-]{1,128})/.exec(link)
      return match ? match[1] : ''
    }

    /** 事件时间线的客户端缓存：同一个 story 5 分钟内复用（抽屉不开不请求、不轮询）。 */
    const STORY_CACHE_TTL_MS = 5 * 60 * 1000
    const STORY_CACHE_MAX = 32
    const storyCache = new Map()

    function storyCacheKey(target) {
      if (target?.id) return `id:${target.id}`
      if (target?.item) return `item:${target.item}`
      return ''
    }

    /**
     * 拉一个事件的来龙去脉。`id` 走 JSON API；`item` 是精选条目的条目 id，
     * Host 端会抓条目页 HTML 兜底解析出 publicId（JSON API 不暴露这层映射）。
     */
    async function loadStory(target, signal) {
      const key = storyCacheKey(target)
      const hit = storyCache.get(key)
      if (hit && Date.now() - hit.at < STORY_CACHE_TTL_MS) return hit.payload

      const params = new URLSearchParams({ limit: '20' })
      if (target.id) params.set('id', target.id)
      else params.set('item', target.item)

      const response = await fetch(`/api/plugins/aihot/story?${params.toString()}`, {
        signal,
        headers: { accept: 'application/json' },
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload === null || payload.ok !== true) {
        throw new Error(payload?.error || `请求失败（HTTP ${response.status}）`)
      }
      if (key) {
        if (storyCache.size >= STORY_CACHE_MAX) storyCache.clear()
        storyCache.set(key, { at: Date.now(), payload })
      }
      return payload
    }

    /** 条目正文的客户端缓存：同一条目 5 分钟内复用（点过才抓，列表从不预取）。 */
    const ARTICLE_CACHE_TTL_MS = 5 * 60 * 1000
    const ARTICLE_CACHE_MAX = 32
    const articleCache = new Map()

    /**
     * 拉一条条目的正文。Host 端抓条目页 HTML 抽 `<p>`，这里只负责缓存与错误归一。
     */
    async function loadArticle(id, signal) {
      const hit = articleCache.get(id)
      if (hit && Date.now() - hit.at < ARTICLE_CACHE_TTL_MS) return hit.payload

      const response = await fetch(`/api/plugins/aihot/article?id=${encodeURIComponent(id)}`, {
        signal,
        headers: { accept: 'application/json' },
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload === null || payload.ok !== true) {
        throw new Error(payload?.error || `请求失败（HTTP ${response.status}）`)
      }
      if (articleCache.size >= ARTICLE_CACHE_MAX) articleCache.clear()
      articleCache.set(id, { at: Date.now(), payload })
      return payload
    }

    /* ------------------- 收藏 / 已读（v1.6：纯浏览器本地状态，不上 Host、不发请求） */
    const SAVED_KEY = 'dsh.aihot.saved.v1'
    const READ_KEY = 'dsh.aihot.read.v1'
    /** 两把 key 各自最多留 500 条，超了丢最旧的。 */
    const STORE_LIMIT = 500

    /** 隐私模式 / 被策略禁用的 localStorage 一碰就抛，所以每次访问都包起来。 */
    function storeArea() {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return null
        return window.localStorage
      } catch {
        return null
      }
    }

    const isStoreEntry = (entry) => Boolean(entry) && typeof entry === 'object' && typeof entry.id === 'string' && entry.id.length > 0

    /**
     * 把一段 localStorage 原文解析成记录数组（坏 JSON / 非数组 / 坏条目一律按现有策略回空）。
     * 只做纯解析、不读写存储：`loadStore` 与跨标签同步的 `storage` 事件共用同一套规则。
     * @param {string|null|undefined} raw localStorage 里的原文
     * @returns {Array<object>}
     */
    function parseStoreValue(raw) {
      if (typeof raw !== 'string' || raw.length === 0) return []
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        return []
      }
      if (!Array.isArray(parsed)) return []
      return parsed
        .filter(isStoreEntry)
        .map((entry) => ({ ...entry, at: Number(entry.at) || 0 }))
        .sort((left, right) => right.at - left.at)
        .slice(0, STORE_LIMIT)
    }

    /**
     * 读一组本地记录。坏 JSON / 坏形状都回空数组，并把干净值覆盖写回一次，
     * 免得每次刷新都重新踩一遍坏数据。
     * @param {string} key localStorage key
     * @returns {Array<object>}
     */
    function loadStore(key) {
      const area = storeArea()
      if (!area) return []
      let raw = null
      try {
        raw = area.getItem(key)
      } catch {
        return []
      }
      if (!raw) return []
      const list = parseStoreValue(raw)
      // 原文和解析结果不一致（坏条目 / 顺序乱 / 超 500 条）就把干净值覆盖写回一次。
      let sane = false
      try {
        const parsed = JSON.parse(raw)
        sane = Array.isArray(parsed) && parsed.length === list.length
      } catch {
        sane = false
      }
      if (!sane) saveStore(key, list)
      return list
    }

    /**
     * 写一组本地记录：按 `at` 倒序、最多 500 条。写不进去（配额满 / 隐私模式）就
     * 静默降级成内存态——页面照常工作，只是刷新后丢。
     * @param {string} key localStorage key
     * @param {Array<object>} list 记录
     * @returns {Array<object>} 截断排序后的列表（给 setState 用）
     */
    function saveStore(key, list) {
      const sorted = (Array.isArray(list) ? list : [])
        .filter(isStoreEntry)
        .map((entry) => ({ ...entry, at: Number(entry.at) || 0 }))
        .sort((left, right) => right.at - left.at)
        .slice(0, STORE_LIMIT)
      const area = storeArea()
      if (!area) return sorted
      try {
        area.setItem(key, JSON.stringify(sorted))
      } catch {
        /* 配额满 / 无痕模式：留内存态即可 */
      }
      return sorted
    }

    /* ------------------------- 收藏导出（v1.8：纯前端 Blob 下载，不开后端路由） */

    /**
     * 导出文件名：`aihot-saved-20261113-2056.json`（本地时间，分钟级足够区分）。
     * @param {Date} date 导出时刻
     * @returns {string}
     */
    function exportFileName(date) {
      const pad = (value) => String(value).padStart(2, '0')
      const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
      return `aihot-saved-${day}-${pad(date.getHours())}${pad(date.getMinutes())}.json`
    }

    /**
     * 导出载荷。带 `version` 与 `exportedAt`，以后要加「导入」时有地方校验版本；
     * 条目不夹带内部字段（只保留收藏要用的六个）。
     * @param {Array<object>} items 收藏记录
     * @param {Date} exportedAt 导出时刻
     * @returns {{version: number, exportedAt: string, items: Array<object>}}
     */
    function buildExportPayload(items, exportedAt) {
      return {
        version: 1,
        exportedAt: exportedAt.toISOString(),
        items: (Array.isArray(items) ? items : []).map((entry) => ({
          id: entry.id,
          title: entry.title ?? '',
          source: entry.source ?? '',
          publishedAt: entry.publishedAt ?? '',
          url: entry.url ?? '',
          at: Number(entry.at) || 0,
        })),
      }
    }

    /**
     * 把载荷存成 JSON 文件给用户下载：Blob + 临时 `<a download>`，不经过任何网络。
     * 环境缺 Blob / URL / document（比如单测）时返回 false，调用方据此提示失败。
     * @param {string} fileName 下载文件名
     * @param {object} payload 导出载荷
     * @returns {boolean} 是否成功触发下载
     */
    function downloadJson(fileName, payload) {
      if (typeof document === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') return false
      let objectUrl = ''
      try {
        objectUrl = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }))
        const anchor = document.createElement('a')
        anchor.href = objectUrl
        anchor.download = fileName
        anchor.rel = 'noopener'
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        // 点击后立刻 revoke 会让部分浏览器下载到空文件，挪到下一轮再释放。
        window.setTimeout(() => {
          try {
            URL.revokeObjectURL(objectUrl)
          } catch {
            /* 已经释放过就算了 */
          }
        }, 1000)
        return true
      } catch {
        return false
      }
    }

    /** 一个 tab 一个请求；切换 tab/分类/刷新都会重新拉取，卸载时 abort。 */
    function useFeed(tab, category, reloadKey) {
      const [state, setState] = useState({ status: 'loading', data: null, error: '', at: 0 })

      useEffect(() => {
        if (tab === 'resets' || tab === 'period' || tab === 'saved' || SSR_TABS[tab]) {
          // 「福利」走 useResets，周报/月报走 usePeriod，「收藏」只读 localStorage，
          // v2.0 的排行榜/羊毛/重置日历/接入走 useJsonRoute。这里一律不发请求。
          setState({ status: 'idle', data: null, error: '', at: 0 })
          return
        }
        const controller = new AbortController()
        let alive = true
        setState({ status: 'loading', data: null, error: '', at: 0 })

        const load = async () => {
          try {
            const response = await fetch(feedPath(tab, category), {
              signal: controller.signal,
              headers: { accept: 'application/json' },
            })
            const payload = await response.json().catch(() => null)
            if (!response.ok || payload === null || payload.ok !== true) {
              const reason = payload?.error || `请求失败（HTTP ${response.status}）`
              throw new Error(reason)
            }
            if (!alive) return
            setState({ status: 'ready', data: payload, error: '', at: Date.now() })
          } catch (error) {
            if (!alive || error?.name === 'AbortError') return
            setState({ status: 'error', data: null, error: error?.message || '加载失败', at: 0 })
          }
        }

        load()
        return () => {
          alive = false
          controller.abort()
        }
      }, [tab, category, reloadKey])

      return state
    }

    /**
     * 期刊（周报 / 月报）：先拿期号索引，再取当期正文；默认最新一期。
     * `kind === 'daily'` 时不发请求（日报走 useFeed 的 /daily）。切换分段 / 期号 / 刷新都会 abort 上一次。
     */
    function usePeriod(kind, reloadKey) {
      const [state, setState] = useState({ status: 'idle', kind: '', items: [], issue: '', report: null, error: '', at: 0 })
      const [issue, setIssue] = useState('')

      // 切换分段（kind）时回到默认：最新一期。
      useEffect(() => {
        setIssue('')
      }, [kind])

      useEffect(() => {
        if (kind === 'daily') {
          setState({ status: 'idle', kind: 'daily', items: [], issue: '', report: null, error: '', at: 0 })
          return
        }
        const controller = new AbortController()
        let alive = true
        setState((prev) => ({
          status: 'loading',
          kind,
          items: prev.kind === kind ? prev.items : [],
          issue,
          report: null,
          error: '',
          at: 0,
        }))

        const getJson = async (query) => {
          const response = await fetch(`/api/plugins/aihot/period?${query}`, {
            signal: controller.signal,
            headers: { accept: 'application/json' },
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || payload === null || payload.ok !== true) {
            throw new Error(payload?.error || `请求失败（HTTP ${response.status}）`)
          }
          return payload
        }

        const load = async () => {
          try {
            const index = await getJson(`kind=${encodeURIComponent(kind)}&limit=12`)
            if (!alive) return
            const items = Array.isArray(index.items) ? index.items : []
            const current = issue || (items.length > 0 ? periodIssue(kind, items[0]) : '')
            if (!current) {
              setState({ status: 'ready', kind, items, issue: '', report: null, error: '', at: Date.now() })
              return
            }
            const detail = await getJson(`kind=${encodeURIComponent(kind)}&issue=${encodeURIComponent(current)}`)
            if (!alive) return
            setState({
              status: 'ready',
              kind,
              items,
              issue: current,
              report: detail.report ?? null,
              error: '',
              at: Date.now(),
            })
          } catch (error) {
            if (!alive || error?.name === 'AbortError') return
            setState((prev) => ({ ...prev, status: 'error', issue, report: null, error: error?.message || '加载失败', at: 0 }))
          }
        }

        load()
        return () => {
          alive = false
          controller.abort()
        }
      }, [kind, issue, reloadKey])

      return { state, setIssue }
    }

    /**
     * 把 `/api/v1/{service}-resets` 的真实字段收成一张卡片要展示的四项。
     * 只读上游确实有的字段：presentation.status（缺则退 event.status）、confirmedAt、estimate.label、
     * schedule.label、count、monitor.status、checkedAt；没有就不编，交给渲染层显示占位文案。
     */
    function resetCard(service, payload) {
      const events = Array.isArray(payload?.events) ? payload.events : []
      const latest = events[0] ?? null
      const status = latest ? latest.presentation?.status ?? latest.status : null
      const confirmedTimes = events
        .map((event) => event.confirmedAt)
        .filter((value) => typeof value === 'string' && value !== '')
        .sort()
      const lastConfirmed = confirmedTimes.length > 0 ? confirmedTimes[confirmedTimes.length - 1] : ''
      const pending = events.find((event) => (event.presentation?.status ?? event.status) !== 'confirmed') ?? null

      return {
        key: service.id,
        label: service.label,
        statusLabel: status ? RESET_STATUS_LABELS[status] ?? status : '暂无记录',
        tone: status ? RESET_STATUS_TONES[status] ?? '' : '',
        empty: events.length === 0,
        title: latest?.title ?? '',
        displayLabel: latest?.displayLabel ?? latest?.label ?? '',
        lastConfirmed,
        lastOccurredOn: latest?.occurredOn ?? '',
        nextLabel: pending ? pending.estimate?.label ?? pending.schedule?.label ?? '等待确认' : '',
        pendingLabel: pending?.displayLabel ?? pending?.label ?? '',
        count: Number.isFinite(payload?.count) ? payload.count : events.length,
        monitor: payload?.monitor?.status ?? '',
        checkedAt: payload?.checkedAt ?? '',
        href: latest?.url ?? `https://aihot.news/${service.id}-reset`,
      }
    }

    /**
     * 「福利」tab：四个服务各打一次 Host 代理，并行拉取并汇总。
     * 只在 tab 选中时请求；卸载 / 切 tab / 刷新都会 abort 上一次。
     */
    function useResets(enabled, reloadKey) {
      const [state, setState] = useState({ status: 'idle', cards: [], failed: [], error: '', at: 0 })

      useEffect(() => {
        if (!enabled) return
        const controller = new AbortController()
        let alive = true
        setState({ status: 'loading', cards: [], failed: [], error: '', at: 0 })

        const loadOne = async (service) => {
          const response = await fetch(`/api/plugins/aihot/resets?service=${encodeURIComponent(service.id)}`, {
            signal: controller.signal,
            headers: { accept: 'application/json' },
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || payload === null || payload.ok !== true) {
            throw new Error(payload?.error || `${service.label} 请求失败（HTTP ${response.status}）`)
          }
          return resetCard(service, payload)
        }

        Promise.allSettled(RESET_SERVICES.map(loadOne)).then((settled) => {
          if (!alive) return
          const cards = []
          const failed = []
          settled.forEach((result, index) => {
            if (result.status === 'fulfilled') cards.push(result.value)
            else failed.push(`${RESET_SERVICES[index].label}：${result.reason?.message || '加载失败'}`)
          })
          if (cards.length === 0) {
            setState({ status: 'error', cards: [], failed, error: failed.join('；') || '加载失败', at: 0 })
            return
          }
          setState({ status: 'ready', cards, failed, error: '', at: Date.now() })
        }).catch((error) => {
          if (!alive || error?.name === 'AbortError') return
          setState({ status: 'error', cards: [], failed: [], error: error?.message || '加载失败', at: 0 })
        })

        return () => {
          alive = false
          controller.abort()
        }
      }, [enabled, reloadKey])

      return state
    }

    function ResetRow({ label, value }) {
      return h(
        'div',
        { className: 'aihot-reset-row' },
        h('span', { className: 'aihot-reset-key' }, label),
        h('span', { className: 'aihot-reset-value' }, value),
      )
    }

    function ResetCard({ card }) {
      const badgeClass = card.tone ? ` aihot-reset-status-${card.tone}` : ''
      return h(
        'article',
        { className: 'aihot-reset' },
        h(
          'div',
          { className: 'aihot-reset-head' },
          h('span', { className: 'aihot-reset-name' }, card.label),
          h('span', { className: `aihot-badge aihot-reset-status${badgeClass}` }, card.statusLabel),
        ),
        card.empty
          ? h('p', { className: 'aihot-summary' }, '近期没有额度重置记录。')
          : h(
              'div',
              { className: 'aihot-reset-rows' },
              card.title
                ? h(ResetRow, { label: '公告', value: card.displayLabel ? `${card.title} · ${card.displayLabel}` : card.title })
                : null,
              h(ResetRow, {
                label: '最近一次',
                value: card.lastConfirmed
                  ? beijingTime(card.lastConfirmed)
                  : card.lastOccurredOn
                    ? `发生日 ${card.lastOccurredOn}`
                    : '暂无已确认的重置',
              }),
              h(ResetRow, {
                label: '下一条',
                value: card.nextLabel
                  ? card.pendingLabel
                    ? `${card.nextLabel}（${card.pendingLabel}）`
                    : card.nextLabel
                  : '暂无新公告',
              }),
              h(ResetRow, { label: '条数', value: `事件 ${card.count} 条` }),
            ),
        h(
          'div',
          { className: 'aihot-reset-foot' },
          h(
            'span',
            null,
            card.monitor
              ? `监控${MONITOR_LABELS[card.monitor] ?? card.monitor}${card.checkedAt ? ` · 核对于 ${beijingTime(card.checkedAt)}` : ''}`
              : '监控状态未知',
          ),
          h('a', { className: 'aihot-link', href: card.href, target: '_blank', rel: 'noreferrer' }, '详情 ↗'),
        ),
      )
    }

    function Badge({ children }) {
      if (children === undefined || children === null || children === '') return null
      return h('span', { className: 'aihot-badge' }, children)
    }

    function Card({ title, href, source, time, badge, summary, reason, story, articleId, originalHref, saved, isRead, unsave, onToggleSave, onOpenStory, onOpenArticle }) {
      const canOpenStory = Boolean(story && onOpenStory)
      const canReadArticle = Boolean(articleId && onOpenArticle)
      const canSave = Boolean(articleId && onToggleSave && !unsave)
      // 「收藏」tab 里同一份 toggleSave 换个外观：明说「取消收藏」，而不是一个 ★。
      const canUnsave = Boolean(articleId && onToggleSave && unsave)
      const saveEntry = { id: articleId, title, source: source ?? '', publishedAt: time ?? '', url: href ?? '' }
      return h(
        'article',
        { className: isRead ? 'aihot-card is-read' : 'aihot-card' },
        h(
          'div',
          { className: 'aihot-title-row' },
          href
            ? h('a', { className: 'aihot-title', href, target: '_blank', rel: 'noreferrer' }, title)
            : h('span', { className: 'aihot-title' }, title),
          canSave || canUnsave || canOpenStory || canReadArticle
            ? h(
                'div',
                { className: 'aihot-card-actions' },
                canUnsave
                  ? h(
                      'button',
                      {
                        className: 'aihot-unsave-link',
                        type: 'button',
                        title: '从收藏里移除（只影响本机浏览器）',
                        onClick: () => onToggleSave(saveEntry),
                      },
                      '取消收藏',
                    )
                  : null,
                canSave
                  ? h(
                      'button',
                      {
                        className: 'aihot-save-link',
                        type: 'button',
                        'aria-pressed': Boolean(saved),
                        'aria-label': saved ? '取消收藏' : '收藏这条',
                        title: saved ? '取消收藏' : '收藏这条（只存在本机浏览器）',
                        onClick: () => onToggleSave(saveEntry),
                      },
                      saved ? '★' : '☆',
                    )
                  : null,
                canReadArticle
                  ? h(
                      'button',
                      {
                        className: 'aihot-article-link',
                        type: 'button',
                        onClick: (event) => onOpenArticle({ id: articleId, title, href, originalHref }, event.currentTarget),
                        title: '在面板里读这条的正文',
                      },
                      '读正文',
                    )
                  : null,
                canOpenStory
                  ? h(
                      'button',
                      {
                        className: 'aihot-story-link',
                        type: 'button',
                        onClick: () => onOpenStory(story, articleId),
                        title: '看这个事件的来龙去脉',
                      },
                      '来龙去脉',
                    )
                  : null,
              )
            : null,
        ),
        h(
          'div',
          { className: 'aihot-meta' },
          badge ? h(Badge, null, badge) : null,
          source ? h('span', null, source) : null,
          time ? h('span', null, beijingTime(time)) : null,
        ),
        summary ? h('p', { className: 'aihot-summary' }, summary) : null,
        reason ? h('p', { className: 'aihot-reason' }, `推荐理由：${reason}`) : null,
      )
    }

    function Skeleton() {
      return h(
        'div',
        { className: 'aihot-skeleton', 'aria-busy': 'true' },
        h('div', { className: 'aihot-skeleton-row' }),
        h('div', { className: 'aihot-skeleton-row' }),
        h('div', { className: 'aihot-skeleton-row' }),
      )
    }

    function EmptyState({ text }) {
      return h('div', { className: 'aihot-state' }, h('div', null, text || '这个窗口里还没有内容。'))
    }

    function ErrorState({ message, onRetry }) {
      return h(
        'div',
        { className: 'aihot-state aihot-state-error' },
        h('div', null, `加载失败：${message}`),
        h('button', { className: 'aihot-button', type: 'button', onClick: onRetry }, '重试'),
      )
    }

    /** 上游 `story.status` → 中文。 */
    const STORY_STATUS_LABELS = { active: '进行中', settled: '已结案' }

    /**
     * 事件「来龙去脉」抽屉。
     *
     * 宿主的 composer 会裁剪 `position: fixed`，所以这里 `createPortal` 到 `document.body`。
     * 三态（加载 / 空 / 错误）都要有；Esc 与遮罩点击关闭；抽屉不轮询，同 story 5 分钟内走缓存。
     */
    /**
     * 复制文本：优先 `navigator.clipboard`，不可用或失败时退回临时 textarea + `execCommand('copy')`
     * （宿主是 webview，两种路径都可能被权限或焦点限制卡住，所以两条都备着）。
     */
    function fallbackCopy(text) {
      if (typeof document === 'undefined') return Promise.reject(new Error('当前环境不支持复制'))
      const area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.top = '-1000px'
      area.style.opacity = '0'
      document.body.appendChild(area)
      try {
        area.select()
        const okay = typeof document.execCommand === 'function' && document.execCommand('copy')
        if (!okay) throw new Error('浏览器拒绝了复制')
        return Promise.resolve()
      } finally {
        area.remove()
      }
    }

    function copyText(text) {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text))
      }
      return Promise.resolve().then(() => fallbackCopy(text))
    }

    function StoryDrawer({ target, onClose }) {
      const open = Boolean(target)
      const [state, setState] = useState({ status: 'idle', story: null, from: '', error: '' })
      const [attempt, setAttempt] = useState(0)
      const [copyState, setCopyState] = useState('idle')
      const targetId = target?.id ?? ''
      const targetItem = target?.item ?? ''

      useEffect(() => {
        if (!open) {
          setState({ status: 'idle', story: null, from: '', error: '' })
          return
        }
        const controller = new AbortController()
        let alive = true
        setState({ status: 'loading', story: null, from: '', error: '' })
        loadStory({ id: targetId || undefined, item: targetItem || undefined }, controller.signal)
          .then((payload) => {
            if (!alive) return
            setState({ status: 'ready', story: payload?.story ?? null, from: payload?.resolvedFrom ?? '', error: '' })
          })
          .catch((error) => {
            if (!alive || error?.name === 'AbortError') return
            setState({ status: 'error', story: null, from: '', error: error?.message || '加载失败' })
          })
        return () => {
          alive = false
          controller.abort()
        }
      }, [open, targetId, targetItem, attempt])

      useEffect(() => {
        if (!open || typeof document === 'undefined') return
        const onKeyDown = (event) => {
          if (event.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [open, onClose])

      // 「复制链接」成功后 2 秒复原文案；切事件时复位。
      useEffect(() => {
        setCopyState('idle')
      }, [open, targetId, targetItem])

      useEffect(() => {
        if (copyState === 'idle') return
        const timer = setTimeout(() => setCopyState('idle'), 2000)
        return () => clearTimeout(timer)
      }, [copyState])

      if (!open) return null
      if (typeof document === 'undefined' || typeof ReactDOM?.createPortal !== 'function') return null

      const story = state.story
      const reports = Array.isArray(story?.reports) ? story.reports : []
      // 上游 reports 是「新→旧」；时间线按 publishedAt 正序，才讲得清来龙去脉。
      const ordered = reports
        .slice()
        .sort((a, b) => String(a?.publishedAt ?? '').localeCompare(String(b?.publishedAt ?? '')))
      const related = Array.isArray(story?.related) ? story.related : []
      const statusLabel = story?.status ? STORY_STATUS_LABELS[story.status] ?? story.status : ''

      let body
      if (state.status === 'loading' || state.status === 'idle') body = h(Skeleton)
      else if (state.status === 'error') {
        body = h(ErrorState, { message: state.error, onRetry: () => setAttempt((value) => value + 1) })
      } else if (ordered.length === 0) {
        body = h(EmptyState, { text: '这个事件还没有公开的时间线条目，稍后再来看。' })
      } else {
        body = h(
          'div',
          { className: 'aihot-list' },
          story?.digest ? h('p', { className: 'aihot-summary' }, story.digest) : null,
          h(
            'ol',
            { className: 'aihot-timeline' },
            ...ordered.map((report, index) =>
              h(
                'li',
                { className: 'aihot-timeline-item', key: report?.id ?? `report-${index}` },
                h('span', { className: 'aihot-timeline-time' }, beijingTime(report?.publishedAt)),
                h(
                  'div',
                  { className: 'aihot-timeline-main' },
                  report?.links?.aihot
                    ? h(
                        'a',
                        { className: 'aihot-title', href: report.links.aihot, target: '_blank', rel: 'noreferrer' },
                        report?.title ?? '（无标题）',
                      )
                    : h('span', { className: 'aihot-title' }, report?.title ?? '（无标题）'),
                  report?.summary ? h('p', { className: 'aihot-summary' }, report.summary) : null,
                  h(
                    'div',
                    { className: 'aihot-meta' },
                    report?.source?.name ? h('span', null, report.source.name) : null,
                    report?.source?.firstParty ? h('span', null, '一手') : null,
                  ),
                ),
              ),
            ),
          ),
          related.length > 0
            ? h(
                'section',
                { className: 'aihot-section' },
                h('h3', { className: 'aihot-section-label' }, '相关事件'),
                h(
                  'ul',
                  { className: 'aihot-related' },
                  ...related.map((neighbor, index) =>
                    h(
                      'li',
                      { key: neighbor?.publicId ?? `related-${index}` },
                      h(
                        'a',
                        {
                          className: 'aihot-link',
                          href: neighbor?.links?.aihot ?? `https://aihot.news/story/${neighbor?.publicId ?? ''}`,
                          target: '_blank',
                          rel: 'noreferrer',
                        },
                        neighbor?.title ?? neighbor?.publicId ?? '相关事件',
                      ),
                      neighbor?.relation ? h('span', { className: 'aihot-updated' }, ` · ${neighbor.relation}`) : null,
                    ),
                  ),
                ),
              )
            : null,
        )
      }

      const shareUrl = (() => {
        const publicId = story?.publicId ?? targetId
        return publicId ? `https://aihot.news/story/${encodeURIComponent(publicId)}` : ''
      })()

      const drawer = h(
        React.Fragment,
        null,
        h('div', { className: 'aihot-drawer-backdrop', 'aria-hidden': 'true', onClick: onClose }),
        h(
          'aside',
          { className: 'aihot-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': '事件来龙去脉' },
          h(
            'div',
            { className: 'aihot-drawer-head' },
            h('h2', { className: 'aihot-drawer-title' }, story?.title ?? (state.status === 'error' ? '事件来龙去脉' : '加载中…')),
            h(
              'div',
              { className: 'aihot-drawer-actions' },
              shareUrl
                ? h(
                    'button',
                    {
                      className: 'aihot-button',
                      type: 'button',
                      title: shareUrl,
                      onClick: () => {
                        copyText(shareUrl)
                          .then(() => setCopyState('done'))
                          .catch(() => setCopyState('fail'))
                      },
                    },
                    copyState === 'done' ? '已复制' : copyState === 'fail' ? '复制失败' : '复制链接',
                  )
                : null,
              h('button', {
                className: 'aihot-button',
                type: 'button',
                onClick: onClose,
                'aria-label': '关闭',
                title: '关闭（Esc）',
              }, '×'),
            ),
          ),
          h(
            'div',
            { className: 'aihot-drawer-body' },
            story
              ? h(
                  'div',
                  { className: 'aihot-drawer-meta' },
                  statusLabel ? h(Badge, null, statusLabel) : null,
                  Number.isFinite(story.sourceCount) ? h('span', null, `${story.sourceCount} 个来源`) : null,
                  Number.isFinite(story.reportCount) ? h('span', null, `${story.reportCount} 条报道`) : null,
                  story.firstReportAt ? h('span', null, `起于 ${beijingTime(story.firstReportAt)}`) : null,
                  story.latestAt ? h('span', null, `更新 ${beijingTime(story.latestAt)}`) : null,
                )
              : null,
            state.from === 'item'
              ? h('p', { className: 'aihot-note' }, '关联事件由条目页解析得出。')
              : null,
            body,
            story?.links?.aihot
              ? h(
                  'a',
                  { className: 'aihot-link', href: story.links.aihot, target: '_blank', rel: 'noreferrer' },
                  '在 AIHOT 打开 ↗',
                )
              : null,
          ),
        ),
      )
      return ReactDOM.createPortal(drawer, document.body)
    }

    /**
     * 条目正文抽屉。外观复用「来龙去脉」那套抽屉；同样 `createPortal` 到 `document.body`。
     * 只有点了「读正文」才请求；同一条目 5 分钟内走缓存；焦点进抽屉、关闭后回到卡片按钮。
     */
    function ArticleDrawer({ target, onClose }) {
      const open = Boolean(target)
      const articleId = target?.id ?? ''
      const [state, setState] = useState({ status: 'idle', item: null, error: '' })
      const [attempt, setAttempt] = useState(0)
      const [copyState, setCopyState] = useState('idle')
      const drawerRef = useRef(null)

      useEffect(() => {
        if (!open) {
          setState({ status: 'idle', item: null, error: '' })
          return
        }
        const controller = new AbortController()
        let alive = true
        setState({ status: 'loading', item: null, error: '' })
        loadArticle(articleId, controller.signal)
          .then((payload) => {
            if (!alive) return
            setState({ status: 'ready', item: payload?.item ?? null, error: '' })
          })
          .catch((error) => {
            if (!alive || error?.name === 'AbortError') return
            setState({ status: 'error', item: null, error: error?.message || '加载失败' })
          })
        return () => {
          alive = false
          controller.abort()
        }
      }, [open, articleId, attempt])

      useEffect(() => {
        if (open) drawerRef.current?.focus?.()
      }, [open, articleId])

      useEffect(() => {
        if (!open || typeof document === 'undefined') return
        const onKeyDown = (event) => {
          if (event.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [open, onClose])

      useEffect(() => {
        if (copyState === 'idle') return
        const timer = setTimeout(() => setCopyState('idle'), 2000)
        return () => clearTimeout(timer)
      }, [copyState])

      if (!open) return null
      if (typeof document === 'undefined' || typeof ReactDOM?.createPortal !== 'function') return null

      const item = state.item
      const paragraphs = Array.isArray(item?.paragraphs) ? item.paragraphs : []
      const readUrl = item?.url || (articleId ? `https://aihot.news/items/${encodeURIComponent(articleId)}` : '')
      const originalUrl = typeof target?.originalHref === 'string' ? target.originalHref : ''
      const shareUrl = articleId ? `https://aihot.news/items/${encodeURIComponent(articleId)}` : readUrl
      const title = item?.title || target?.title || '正文'

      let body
      if (state.status === 'loading' || state.status === 'idle') body = h(Skeleton)
      else if (state.status === 'error') {
        body = h(
          'div',
          { className: 'aihot-state' },
          h('p', { className: 'aihot-alert', role: 'alert' }, `加载失败：${state.error}`),
          h('button', { className: 'aihot-button', type: 'button', onClick: () => setAttempt((value) => value + 1) }, '重试'),
        )
      } else if (paragraphs.length === 0) {
        body = h(
          'div',
          { className: 'aihot-state' },
          h('div', null, '这条没有正文，去原文看'),
          originalUrl || readUrl
            ? h('a', { className: 'aihot-link', href: originalUrl || readUrl, target: '_blank', rel: 'noreferrer' }, '看原文 ↗')
            : null,
        )
      } else {
        body = h(
          'div',
          { className: 'aihot-list' },
          ...paragraphs.map((paragraph, index) => h('p', { className: 'aihot-article-p', key: `p-${index}` }, paragraph)),
          item.truncated
            ? h(
                'p',
                { className: 'aihot-note' },
                '正文过长，已截断 · ',
                originalUrl || readUrl
                  ? h('a', { className: 'aihot-link', href: originalUrl || readUrl, target: '_blank', rel: 'noreferrer' }, '读全文 ↗')
                  : null,
              )
            : null,
        )
      }

      const drawer = h(
        React.Fragment,
        null,
        h('div', { className: 'aihot-drawer-backdrop', 'aria-hidden': 'true', onClick: onClose }),
        h(
          'aside',
          {
            className: 'aihot-drawer aihot-drawer-wide',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': '条目正文',
            tabIndex: -1,
            ref: drawerRef,
          },
          h(
            'div',
            { className: 'aihot-drawer-head' },
            h('h2', { className: 'aihot-drawer-title' }, title),
            h(
              'div',
              { className: 'aihot-drawer-actions' },
              shareUrl
                ? h(
                    'button',
                    {
                      className: 'aihot-button',
                      type: 'button',
                      title: shareUrl,
                      onClick: () => {
                        copyText(shareUrl)
                          .then(() => setCopyState('done'))
                          .catch(() => setCopyState('fail'))
                      },
                    },
                    copyState === 'done' ? '已复制' : copyState === 'fail' ? '复制失败' : '复制链接',
                  )
                : null,
              h(
                'button',
                { className: 'aihot-button', type: 'button', onClick: onClose, 'aria-label': '关闭', title: '关闭（Esc）' },
                '×',
              ),
            ),
          ),
          h(
            'div',
            { className: 'aihot-drawer-body' },
            item
              ? h(
                  'div',
                  { className: 'aihot-drawer-meta' },
                  item.source ? h('span', null, item.source) : null,
                  item.publishedAt ? h('span', null, beijingTime(item.publishedAt)) : null,
                  Number.isFinite(item.chars) ? h('span', null, `${item.chars} 字`) : null,
                )
              : null,
            body,
            item?.fallback ? h('p', { className: 'aihot-note' }, '正文由条目页解析得出，可能与原文排版不同。') : null,
            originalUrl || readUrl
              ? h(
                  'div',
                  null,
                  originalUrl
                    ? h('a', { className: 'aihot-link', href: originalUrl, target: '_blank', rel: 'noreferrer' }, '原文 ↗')
                    : null,
                  originalUrl && readUrl ? h('span', { className: 'aihot-updated' }, ' · ') : null,
                  readUrl
                    ? h('a', { className: 'aihot-link', href: readUrl, target: '_blank', rel: 'noreferrer' }, '在 AIHOT 打开 ↗')
                    : null,
                )
              : null,
          ),
        ),
      )
      return ReactDOM.createPortal(drawer, document.body)
    }

    function itemsFromPayload(payload, tab) {
      const list = Array.isArray(payload?.items) ? payload.items : []
      return list.map((item) => {
        // 热点卡片自带 links.story；精选条目只有条目 id，交给 Host 端条目页兜底解析。
        const linkedStory = storyIdFromLink(item.links?.story)
        const story = linkedStory ? { id: linkedStory } : item.id ? { item: item.id } : null
        return {
          key: item.id,
          // 收藏 / 已读的主键（与「读正文」「来龙去脉」用同一个 id）。
          id: item.id,
          title: item.title,
          href: item.links?.aihot,
          source: item.source?.name,
          time: item.publishedAt ?? item.latestAt,
          badge: item.rank !== undefined ? `第 ${item.rank} 名` : CATEGORY_LABELS[item.category] || item.category,
          summary: item.summary ?? (item.sourceCount !== undefined ? `${item.sourceCount} 个来源 · ${item.signalCount} 条信号` : ''),
          reason: item.reason ?? '',
          story,
          // 「读正文」用条目 id（Host 抓条目页 HTML）；原文链接给抽屉底部的「原文 ↗」。
          articleId: item.id,
          originalHref: item.links?.original ?? '',
        }
      })
    }

    function DailyView({ report, onOpenArticle }) {
      const sections = Array.isArray(report?.sections) ? report.sections : []
      const flashes = Array.isArray(report?.flashes) ? report.flashes : []
      const lead = report?.lead
      const homepage = report?.links?.aihot

      return h(
        'div',
        { className: 'aihot-list' },
        lead
          ? h(
              'div',
              { className: 'aihot-lead' },
              h('h2', { className: 'aihot-lead-title' }, lead.title),
              h('p', { className: 'aihot-summary' }, lead.leadParagraph),
              homepage
                ? h('a', { className: 'aihot-link', href: homepage, target: '_blank', rel: 'noreferrer' }, `阅读 ${report.date ?? ''} 日报原文 ↗`)
                : null,
            )
          : null,
        ...sections.map((section, index) =>
          h(
            'section',
            { className: 'aihot-section', key: `${section.label}-${index}` },
            h('h3', { className: 'aihot-section-label' }, section.label),
            ...(Array.isArray(section.items) ? section.items : []).map((item, itemIndex) =>
              h(Card, {
                key: `${section.label}-${itemIndex}`,
                title: item.title,
                href: item.links?.aihot ?? undefined,
                source: item.source?.name,
                summary: item.summary,
                articleId: item.id,
                originalHref: item.links?.original ?? '',
                onOpenArticle,
              }),
            ),
          ),
        ),
        flashes.length > 0
          ? h(
              'section',
              { className: 'aihot-section' },
              h('h3', { className: 'aihot-section-label' }, '快讯'),
              ...flashes.map((flash, index) =>
                h(Card, {
                  key: `flash-${index}`,
                  title: flash.title,
                  href: flash.links?.aihot ?? undefined,
                  source: flash.source?.name,
                  time: flash.publishedAt,
                  articleId: flash.id,
                  originalHref: flash.links?.original ?? '',
                  onOpenArticle,
                }),
              ),
            )
          : null,
      )
    }

    /** 周报 / 月报：headline + overview + 分栏卡片；字段都没有就交给空状态。 */
    function PeriodView({ report, kind, onOpenArticle }) {
      const sections = Array.isArray(report?.sections) ? report.sections : []
      const issue = periodIssue(kind, report)
      const range = periodRange(report)
      const link = report?.links?.aihot
      const title = report?.headline || `${PERIOD_LABELS[kind] ?? '期刊'}${issue ? ` ${issue}` : ''}`

      return h(
        'div',
        { className: 'aihot-journal' },
        h(
          'div',
          { className: 'aihot-journal-head' },
          h('h2', { className: 'aihot-journal-title' }, title),
          h(
            'div',
            { className: 'aihot-journal-meta' },
            issue ? h(Badge, null, issue) : null,
            range ? h('span', null, range) : null,
            report?.generatedAt ? h('span', null, `生成于 ${beijingTime(report.generatedAt)}`) : null,
          ),
          report?.overview ? h('p', { className: 'aihot-journal-overview' }, report.overview) : null,
          link
            ? h('a', { className: 'aihot-link', href: link, target: '_blank', rel: 'noreferrer' }, '阅读原文 ↗')
            : null,
        ),
        ...sections.map((section, index) =>
          h(
            'section',
            { className: 'aihot-section', key: `${section.label}-${index}` },
            h('h3', { className: 'aihot-section-label' }, section.label),
            section.summary ? h('p', { className: 'aihot-section-summary' }, section.summary) : null,
            ...(Array.isArray(section.items) ? section.items : []).map((item, itemIndex) =>
              h(Card, {
                key: `${index}-${itemIndex}`,
                title: item.title,
                href: item.links?.aihot ?? undefined,
                source: item.source?.name,
                time: item.publishedAt,
                summary: item.summary,
                articleId: item.id,
                originalHref: item.links?.original ?? '',
                onOpenArticle,
              }),
            ),
          ),
        ),
      )
    }

    /* ------------------------------------------------ v2.0 常量与工具 */

    /** 主题选择存在本机；`system` 跟随系统外观，只覆盖本面板的语义变量。 */
    const THEME_KEY = 'aihot-theme'
    const THEMES = [
      { id: 'light', label: '浅色' },
      { id: 'dark', label: '深色' },
      { id: 'system', label: '跟随系统' },
    ]

    /**
     * v2.0：四个「抓站点页」的 tab 各自对应一条 Host 路由。
     * 有值的 tab 走 useJsonRoute，对应的 useFeed 不发请求（上游没有这些端点，只能抓页）。
     */
    const SSR_TABS = {
      leaderboard: '/api/plugins/aihot/leaderboard',
      freeTokens: '/api/plugins/aihot/free-tokens',
      resetCalendar: '/api/plugins/aihot/reset-calendar',
      agent: '/api/plugins/aihot/agent-access',
    }

    function systemTheme() {
      try {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light'
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      } catch (error) {
        return 'light'
      }
    }

    /** 主题状态：浅色 / 深色 / 跟随系统；选择落 localStorage，跟随系统时监听 matchMedia。 */
    function useThemeState() {
      const [choice, setChoice] = useState(() => {
        try {
          const stored = storeArea()?.getItem(THEME_KEY)
          return THEMES.some((entry) => entry.id === stored) ? stored : 'system'
        } catch (error) {
          return 'system'
        }
      })
      const [system, setSystem] = useState(systemTheme)

      useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
        const query = window.matchMedia('(prefers-color-scheme: dark)')
        const onChange = () => setSystem(query.matches ? 'dark' : 'light')
        if (typeof query.addEventListener === 'function') query.addEventListener('change', onChange)
        else if (typeof query.addListener === 'function') query.addListener(onChange)
        return () => {
          if (typeof query.removeEventListener === 'function') query.removeEventListener('change', onChange)
          else if (typeof query.removeListener === 'function') query.removeListener(onChange)
        }
      }, [])

      const choose = useCallback((next) => {
        setChoice(next)
        try {
          storeArea()?.setItem(THEME_KEY, next)
        } catch (error) {
          // 隐私模式写不进就算了，本次会话仍然生效。
        }
      }, [])

      return { choice, resolved: choice === 'system' ? system : choice, choose }
    }

    /** 通用 JSON 路由读取（v2.0 的四个站点页 tab 共用）：只在 enabled 时请求。 */
    function useJsonRoute(path, enabled, reloadKey) {
      const [state, setState] = useState({ status: 'idle', data: null, error: '', at: 0 })

      useEffect(() => {
        if (!enabled) {
          setState({ status: 'idle', data: null, error: '', at: 0 })
          return undefined
        }
        const controller = new AbortController()
        let alive = true
        setState({ status: 'loading', data: null, error: '', at: 0 })

        const load = async () => {
          try {
            const response = await fetch(path, { signal: controller.signal, headers: { accept: 'application/json' } })
            const payload = await response.json().catch(() => null)
            if (!response.ok || payload === null || payload.ok !== true) {
              const reason = payload?.error || `请求失败（HTTP ${response.status}）`
              throw new Error(reason)
            }
            if (!alive) return
            setState({ status: 'ready', data: payload, error: '', at: Date.now() })
          } catch (error) {
            if (!alive || error?.name === 'AbortError') return
            setState({ status: 'error', data: null, error: error?.message || '加载失败', at: 0 })
          }
        }

        load()
        return () => {
          alive = false
          controller.abort()
        }
      }, [path, enabled, reloadKey])

      return state
    }

    /** 全局搜索：词长 ≥ 2 才查（上游要求 2–200 个字符）。 */
    function useSearch(term, reloadKey) {
      const [state, setState] = useState({ status: 'idle', data: null, error: '', at: 0 })

      useEffect(() => {
        if (term.length < 2) {
          setState({ status: 'idle', data: null, error: '', at: 0 })
          return undefined
        }
        const controller = new AbortController()
        let alive = true
        setState({ status: 'loading', data: null, error: '', at: 0 })

        const load = async () => {
          try {
            const query = `q=${encodeURIComponent(term)}&window=7d&limit=30`
            const response = await fetch(`/api/plugins/aihot/search?${query}`, {
              signal: controller.signal,
              headers: { accept: 'application/json' },
            })
            const payload = await response.json().catch(() => null)
            if (!response.ok || payload === null || payload.ok !== true) {
              const reason = payload?.error || `请求失败（HTTP ${response.status}）`
              throw new Error(reason)
            }
            if (!alive) return
            setState({ status: 'ready', data: payload, error: '', at: Date.now() })
          } catch (error) {
            if (!alive || error?.name === 'AbortError') return
            setState({ status: 'error', data: null, error: error?.message || '搜索失败', at: 0 })
          }
        }

        load()
        return () => {
          alive = false
          controller.abort()
        }
      }, [term, reloadKey])

      return state
    }

    /* ------------------------------------------------------ v2.0 四个视图 */

    /** 排行榜：综合榜一张表（模型/上线/价格/评分），下面是「暂不排名」。 */
    function LeaderboardView({ data }) {
      const rows = Array.isArray(data?.rows) ? data.rows : []
      const other = Array.isArray(data?.other) ? data.other : []
      if (rows.length === 0 && other.length === 0) return h(EmptyState, { text: '这一期还没有排行榜数据，稍后再来看。' })

      return h(
        'div',
        { className: 'aihot-board' },
        h(
          'div',
          { className: 'aihot-board-row aihot-board-head' },
          h('span', null, '名次'),
          h('span', null, '模型'),
          h('span', null, '上线'),
          h('span', null, '输入价'),
          h('span', null, '输出价'),
          h('span', null, '评分'),
        ),
        ...rows.map((row) =>
          h(
            'div',
            { className: 'aihot-board-row', key: row.slug || row.name },
            h('span', { className: 'aihot-board-rank' }, String(row.rank ?? '').padStart(2, '0')),
            h(
              'a',
              {
                className: 'aihot-title',
                href: `https://aihot.news/leaderboard/${encodeURIComponent(row.slug || '')}`,
                target: '_blank',
                rel: 'noreferrer',
                title: `${row.evaluations ?? 0} 项评测 · 覆盖 ${row.coverage ?? 0}%`,
              },
              row.name,
              row.org ? h('span', { className: 'aihot-board-org' }, row.org) : null,
            ),
            h('span', { className: 'aihot-board-dim' }, row.launchedAt || '—'),
            h('span', { className: 'aihot-board-dim' }, row.priceInput || '—'),
            h('span', { className: 'aihot-board-dim' }, row.priceOutput || '—'),
            h('span', { className: 'aihot-board-score' }, row.score ?? '—'),
          ),
        ),
        other.length > 0
          ? h(
              'div',
              { className: 'aihot-board-pending' },
              h('p', { className: 'aihot-section-label' }, `暂不排名（${other.length}）`),
              ...other.map((row) =>
                h(
                  'div',
                  { className: 'aihot-board-pending-row', key: row.slug || row.name },
                  h(
                    'a',
                    {
                      className: 'aihot-title',
                      href: `https://aihot.news/leaderboard/${encodeURIComponent(row.slug || '')}`,
                      target: '_blank',
                      rel: 'noreferrer',
                    },
                    row.name,
                  ),
                  h('span', { className: 'aihot-board-dim' }, row.note || ''),
                  h('span', { className: 'aihot-board-score' }, row.score ?? ''),
                ),
              ),
            )
          : null,
      )
    }

    /** 免费额度：三个分区（每天/每月/其他）；「我的卡册」只报总数。 */
    function FreeTokensView({ data }) {
      const sections = Array.isArray(data?.sections) ? data.sections : []
      if (sections.length === 0) return h(EmptyState, { text: '暂时没有可领的额度，稍后再来看。' })
      const album = data?.album

      return h(
        'div',
        { className: 'aihot-free' },
        album && album.total > 0
          ? h('p', { className: 'aihot-note-plain' }, `我的卡册 ${album.total} 张${album.summary ? ` · ${album.summary}` : ''}`)
          : null,
        ...sections.map((section) =>
          h(
            'div',
            { className: 'aihot-section', key: section.title },
            h('p', { className: 'aihot-section-label' }, `${section.title}（${section.items.length}）`),
            ...section.items.map((item, index) =>
              h(
                'div',
                { className: 'aihot-free-item', key: `${section.title}-${index}` },
                h(
                  'div',
                  { className: 'aihot-free-main' },
                  h('a', { className: 'aihot-title', href: item.link || HOME_URL, target: '_blank', rel: 'noreferrer' }, item.title),
                  item.desc ? h('p', { className: 'aihot-summary' }, item.desc) : null,
                  item.validity ? h('p', { className: 'aihot-reason' }, `有效期：${item.validity}`) : null,
                ),
                item.badge ? h('span', { className: 'aihot-badge' }, item.badge) : null,
              ),
            ),
          ),
        ),
      )
    }

    /** 重置日历：最近一张重置卡 + 统计 + 当月有事件的日子。 */
    function ResetCalendarView({ data }) {
      const days = Array.isArray(data?.days) ? data.days : []
      const stats = Array.isArray(data?.stats) ? data.stats : []
      if (!data?.lastCard && days.length === 0) return h(EmptyState, { text: '还没有重置日历数据，稍后再来看。' })

      return h(
        'div',
        { className: 'aihot-calendar' },
        h(
          'div',
          { className: 'aihot-journal-head' },
          h('p', { className: 'aihot-journal-title' }, data.lastCard ? `上一次重置卡发放：${data.lastCard}` : '重置日历'),
          stats.length > 0
            ? h(
                'div',
                { className: 'aihot-journal-meta' },
                ...stats.map((stat) => h('span', { key: stat.label }, `${stat.label} ${stat.value}`)),
              )
            : null,
        ),
        h('p', { className: 'aihot-section-label' }, `${data.monthLabel || data.month || ''} · 本月 ${days.length} 次`),
        h(
          'div',
          { className: 'aihot-calendar-days' },
          ...days.map((day) =>
            h(
              'div',
              { className: 'aihot-calendar-day', key: day.date },
              h('span', { className: 'aihot-calendar-date' }, String(day.date || '').slice(5)),
              ...(day.services || []).map((service) => h('span', { className: 'aihot-badge', key: service }, service)),
              day.today ? h('span', { className: 'aihot-calendar-today' }, '今天') : null,
            ),
          ),
        ),
        h('a', { className: 'aihot-link', href: 'https://aihot.news/resets', target: '_blank', rel: 'noreferrer' }, '在 AIHOT 打开重置监控 ↗'),
      )
    }

    /** Agent 接入：四种方式的说明 + 一键复制（复用 copyText/fallbackCopy）。 */
    function AgentAccessView({ data }) {
      const [copied, setCopied] = useState('')
      const modes = Array.isArray(data?.modes) ? data.modes : []

      useEffect(() => {
        if (!copied) return undefined
        const timer = setTimeout(() => setCopied(''), 2000)
        return () => clearTimeout(timer)
      }, [copied])

      if (modes.length === 0) return h(EmptyState, { text: '接入方式暂时抓不到，稍后再来看。' })

      return h(
        'div',
        { className: 'aihot-agent' },
        h('p', { className: 'aihot-note-plain' }, `匿名只读 · 无需 Key · 版本 ${data.version || '2.0.0'}`),
        ...modes.map((mode) => {
          const text = mode.copyText || mode.feeds?.[0]?.url || ''
          return h(
            'div',
            { className: 'aihot-agent-card', key: mode.id },
            h(
              'div',
              { className: 'aihot-agent-head' },
              h('span', { className: 'aihot-agent-title' }, mode.label || mode.title || mode.id),
              text
                ? h(
                    'button',
                    {
                      className: 'aihot-article-link',
                      type: 'button',
                      onClick: () => {
                        copyText(text)
                          .then(() => setCopied(mode.id))
                          .catch(() => setCopied(`fail:${mode.id}`))
                      },
                    },
                    copied === mode.id ? '已复制' : copied === `fail:${mode.id}` ? '复制失败' : '复制',
                  )
                : null,
            ),
            mode.heading
              ? h('p', { className: 'aihot-summary' }, mode.heading)
              : mode.desc
                ? h('p', { className: 'aihot-summary' }, mode.desc)
                : null,
            mode.clients ? h('p', { className: 'aihot-reason' }, `适用：${mode.clients}`) : null,
            text ? h('pre', { className: 'aihot-agent-copy' }, text) : null,
            mode.feeds?.length > 0
              ? h(
                  'div',
                  { className: 'aihot-filters' },
                  ...mode.feeds.map((feed) =>
                    h(
                      'a',
                      { className: 'aihot-link', key: feed.url, href: feed.url, target: '_blank', rel: 'noreferrer', title: feed.desc },
                      feed.title,
                    ),
                  ),
                )
              : null,
          )
        }),
      )
    }

    function Page() {
      const [tab, setTab] = useState('selected')
      const [category, setCategory] = useState('')
      const [journal, setJournal] = useState('daily')
      const [reloadKey, setReloadKey] = useState(0)
      const [storyTarget, setStoryTarget] = useState(null)
      const [articleTarget, setArticleTarget] = useState(null)
      const articleTrigger = useRef(null)
      // 收藏 / 已读：初始化时从 localStorage 读一次，之后每次变更都立即落盘。
      const [saved, setSaved] = useState(() => loadStore(SAVED_KEY))
      const [read, setRead] = useState(() => loadStore(READ_KEY))
      const [savedOnly, setSavedOnly] = useState(false)
      // 「清空收藏」的二次确认：第一次点进入 armed，3 秒不点就自己复位。
      const [clearArmed, setClearArmed] = useState(false)
      const clearTimer = useRef(null)
      const savedIds = new Set(saved.map((entry) => entry.id))
      const readIds = new Set(read.map((entry) => entry.id))
      // 收藏全删掉时自动退出「只看已收藏」，免得停在一个空列表里。
      const savedView = savedOnly && saved.length > 0
      const isResets = tab === 'resets'
      const isJournal = tab === 'daily' && journal !== 'daily'
      const feed = useFeed(tab, category, reloadKey)
      const resets = useResets(isResets, reloadKey)
      const period = usePeriod(tab === 'daily' ? journal : 'daily', reloadKey)

      // v2.0：全局搜索（300ms 去抖）+ 主题 + 四条抓页路由。
      const [searchInput, setSearchInput] = useState('')
      const [searchTerm, setSearchTerm] = useState('')
      const searchTimer = useRef(null)
      const onSearchChange = useCallback((value) => {
        setSearchInput(value)
        if (searchTimer.current !== null) clearTimeout(searchTimer.current)
        searchTimer.current = setTimeout(() => {
          searchTimer.current = null
          setSearchTerm(value.trim())
        }, 300)
      }, [])
      const clearSearch = useCallback(() => {
        if (searchTimer.current !== null) {
          clearTimeout(searchTimer.current)
          searchTimer.current = null
        }
        setSearchInput('')
        setSearchTerm('')
      }, [])
      useEffect(
        () => () => {
          if (searchTimer.current !== null) clearTimeout(searchTimer.current)
        },
        [],
      )
      // 上游要求 2–200 个字符：少于 2 个字符就不发请求，直接回到当前 tab。
      const searching = searchTerm.length >= 2
      const search = useSearch(searching ? searchTerm : '', reloadKey)
      const searchItems = searching ? itemsFromPayload(search.data, 'selected') : []
      const theme = useThemeState()
      const ssrPath = SSR_TABS[tab] ?? ''
      // 搜索态下四条抓页路由让位给搜索结果（否则会出现两份「加载中」互相覆盖）。
      const ssr = useJsonRoute(ssrPath, Boolean(ssrPath) && !searching, reloadKey)

      // 刷新 = 重新拉当前 tab + 重新读一遍本机收藏/已读（另一个挂载点可能刚写过）。
      const refresh = useCallback(() => {
        setSaved(loadStore(SAVED_KEY))
        setRead(loadStore(READ_KEY))
        setReloadKey((value) => value + 1)
      }, [])
      const toggleSave = useCallback((entry) => {
        setSaved((list) => {
          const exists = list.some((item) => item.id === entry.id)
          const next = exists
            ? list.filter((item) => item.id !== entry.id)
            : [{ ...entry, at: Date.now() }, ...list]
          return saveStore(SAVED_KEY, next)
        })
      }, [])
      // 打开正文 / 来龙去脉都算读过；已在列表里就不重写，省掉无意义的落盘。
      const markRead = useCallback((id) => {
        if (!id) return
        setRead((list) => (list.some((item) => item.id === id) ? list : saveStore(READ_KEY, [{ id, at: Date.now() }, ...list])))
      }, [])
      const openStory = useCallback(
        (target, itemId) => {
          markRead(itemId)
          setStoryTarget(target)
        },
        [markRead],
      )
      const closeStory = useCallback(() => setStoryTarget(null), [])
      // 关闭正文抽屉时把焦点还给触发它的「读正文」按钮（键盘用户不会丢掉位置）。
      const openArticle = useCallback(
        (target, trigger) => {
          articleTrigger.current = trigger ?? null
          markRead(target?.id)
          setArticleTarget(target)
        },
        [markRead],
      )
      const closeArticle = useCallback(() => {
        setArticleTarget(null)
        const trigger = articleTrigger.current
        articleTrigger.current = null
        if (trigger && typeof trigger.focus === 'function') trigger.focus()
      }, [])

      const status = searching
        ? search.status
        : ssrPath
          ? ssr.status
          : isResets
            ? resets.status
            : isJournal
              ? period.state.status
              : feed.status
      const error = searching
        ? search.error
        : ssrPath
          ? ssr.error
          : isResets
            ? resets.error
            : isJournal
              ? period.state.error
              : feed.error

      // v1.8：收藏导出（纯前端 Blob 下载）与「清空收藏」的二次确认状态机。
      const exportSaved = useCallback(() => {
        if (saved.length === 0) return
        const now = new Date()
        downloadJson(exportFileName(now), buildExportPayload(saved, now))
      }, [saved])
      const disarmClear = useCallback(() => {
        setClearArmed(false)
        if (clearTimer.current !== null) {
          clearTimeout(clearTimer.current)
          clearTimer.current = null
        }
      }, [])
      const clearSaved = useCallback(() => {
        if (saved.length === 0) return
        if (clearArmed) {
          // 第二次点击：真清空（只清收藏，已读不动）。
          disarmClear()
          setSaved(saveStore(SAVED_KEY, []))
          return
        }
        setClearArmed(true)
        if (clearTimer.current !== null) clearTimeout(clearTimer.current)
        clearTimer.current = setTimeout(() => {
          clearTimer.current = null
          setClearArmed(false)
        }, 3000)
      }, [clearArmed, disarmClear, saved.length])
      // 离开收藏 tab 或卸载时把确认态与计时器一起收掉，避免下次进来还亮着。
      useEffect(() => {
        if (tab !== 'saved') disarmClear()
      }, [tab, disarmClear])
      useEffect(() => () => {
        if (clearTimer.current !== null) {
          clearTimeout(clearTimer.current)
          clearTimer.current = null
        }
      }, [])

      // v1.8：跨标签同步。storage 事件只在「别的标签」写 key 时派发，所以这里只回读状态、
      // 不回头写存储；本标签自己的 setItem 走 saveStore，不依赖这个事件刷新。
      useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        const onStorage = (event) => {
          if (!event || (event.key !== SAVED_KEY && event.key !== READ_KEY)) return
          if (event.key === SAVED_KEY) setSaved(parseStoreValue(event.newValue))
          else setRead(parseStoreValue(event.newValue))
        }
        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
      }, [])

      let body
      if (searching) {
        // v2.0：搜索结果复用卡片渲染，收藏/已读状态与当前 tab 一致。
        body =
          status === 'loading' || status === 'idle'
            ? h(Skeleton)
            : status === 'error'
              ? h(ErrorState, { message: error, onRetry: refresh })
              : searchItems.length === 0
                ? h(EmptyState, { text: `没有找到和「${searchTerm}」相关的条目。` })
                : h(
                    'div',
                    { className: 'aihot-list' },
                    ...searchItems
                      .filter((entry) => !savedView || savedIds.has(entry.id))
                      .map((entry) =>
                        h(Card, {
                          key: entry.key,
                          title: entry.title,
                          href: entry.href,
                          source: entry.source,
                          time: entry.time,
                          badge: entry.badge,
                          summary: entry.summary,
                          reason: entry.reason,
                          story: entry.story,
                          articleId: entry.articleId,
                          originalHref: entry.originalHref,
                          saved: savedIds.has(entry.id),
                          isRead: readIds.has(entry.id),
                          onToggleSave: toggleSave,
                          onOpenStory: openStory,
                          onOpenArticle: openArticle,
                        }),
                      ),
                  )
      } else if (ssrPath) {
        // v2.0：排行榜 / 羊毛 / 重置日历 / 接入，四条都抓站点页，数据结构由 Host 归一。
        body =
          status === 'loading' || status === 'idle'
            ? h(Skeleton)
            : status === 'error'
              ? h(ErrorState, { message: error, onRetry: refresh })
              : tab === 'leaderboard'
                ? h(LeaderboardView, { data: ssr.data })
                : tab === 'freeTokens'
                  ? h(FreeTokensView, { data: ssr.data })
                  : tab === 'resetCalendar'
                    ? h(ResetCalendarView, { data: ssr.data })
                    : h(AgentAccessView, { data: ssr.data })
      } else if (tab === 'saved') {
        // 收藏页完全由 localStorage 驱动：不发请求、不依赖 Host 状态。
        body =
          saved.length === 0
            ? h(EmptyState, { text: '还没有收藏。在精选/热点里点 ☆ 收藏条目。' })
            : h(
                'div',
                { className: 'aihot-list' },
                ...saved.map((entry) =>
                  h(Card, {
                    key: entry.id,
                    title: entry.title,
                    href: entry.url,
                    source: entry.source,
                    time: entry.publishedAt,
                    // 收藏里没存 story 映射，走 Host 的 `item=` 兜底解析（失败就是既有错误态）。
                    story: { item: entry.id },
                    articleId: entry.id,
                    originalHref: '',
                    saved: true,
                    unsave: true,
                    isRead: readIds.has(entry.id),
                    onToggleSave: toggleSave,
                    onOpenStory: openStory,
                    onOpenArticle: openArticle,
                  }),
                ),
              )
      } else if (status === 'loading' || status === 'idle') body = h(Skeleton)
      else if (status === 'error') body = h(ErrorState, { message: error, onRetry: refresh })
      else if (isResets) {
        body =
          resets.cards.length === 0
            ? h(EmptyState, { text: '还没有额度重置记录。' })
            : h(
                'div',
                { className: 'aihot-list' },
                h(
                  'div',
                  { className: 'aihot-resets' },
                  ...resets.cards.map((card) => h(ResetCard, { key: card.key, card })),
                ),
                resets.failed.length > 0
                  ? h('p', { className: 'aihot-note' }, `部分服务加载失败：${resets.failed.join('；')}`)
                  : null,
              )
      } else if (isJournal) {
        const report = period.state.report
        const empty =
          !report ||
          ((report.sections?.length ?? 0) === 0 && !report.headline && !report.overview)
        body = empty
          ? h(EmptyState, { text: `还没有可用的${PERIOD_LABELS[journal] ?? '期刊'}，稍后再来看。` })
          : h(PeriodView, { report, kind: journal, onOpenArticle: openArticle })
      } else if (tab === 'daily') {
        const report = feed.data?.report
        const empty =
          !report ||
          (!report.lead &&
            (report.sections?.length ?? 0) === 0 &&
            (report.flashes?.length ?? 0) === 0)
        body = empty ? h(EmptyState, { text: '还没有可用的日报，稍后再来看。' }) : h(DailyView, { report, onOpenArticle: openArticle })
      } else {
        const loaded = itemsFromPayload(feed.data, tab)
        const items = savedView && tab === 'selected' ? loaded.filter((item) => savedIds.has(item.id)) : loaded
        body =
          items.length === 0
            ? h(EmptyState, {
                text: savedView && tab === 'selected' ? '还没有收藏的条目：点卡片右上角的 ☆ 就能收进来。' : '',
              })
            : h(
                'div',
                { className: 'aihot-list' },
                ...items.map((item) =>
                  h(Card, {
                    ...item,
                    saved: savedIds.has(item.id),
                    isRead: readIds.has(item.id),
                    onToggleSave: toggleSave,
                    onOpenStory: openStory,
                    onOpenArticle: openArticle,
                  }),
                ),
              )
      }

      const at = searching
        ? search.at
        : ssrPath
          ? ssr.at
          : isResets
            ? resets.at
            : isJournal
              ? period.state.at
              : feed.at
      const updatedAt = status === 'ready' && at ? beijingTime(new Date(at).toISOString()) : ''

      // 顶栏上下文行：搜索摘要 + 当前 tab 的过滤/期号。组与组之间用 1px 竖线分隔，行内统一 24px chip。
      const subGroups = []
      if (searching) {
        subGroups.push(
          h(
            'div',
            { className: 'aihot-group', key: 'search' },
            h(
              'span',
              { className: 'aihot-group-label' },
              status === 'ready' ? `${searchItems.length} 条结果 · 搜索「${searchTerm}」` : `正在搜索「${searchTerm}」…`,
            ),
            h('button', { type: 'button', className: 'aihot-chip', onClick: clearSearch }, '清除搜索'),
          ),
        )
      }
      if (tab === 'saved') {
        subGroups.push(
          h(
            'div',
            { className: 'aihot-group', key: 'saved' },
            h('span', { className: 'aihot-group-label' }, `${saved.length} 条收藏 · 只存在本机`),
            h(
              'button',
              {
                type: 'button',
                className: 'aihot-export-link',
                onClick: exportSaved,
                disabled: saved.length === 0,
                title: '把收藏导出成 JSON 文件下载',
              },
              '导出',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'aihot-clear-link',
                onClick: clearSaved,
                disabled: saved.length === 0,
                'aria-pressed': clearArmed,
                title: clearArmed ? '3 秒内再点一次就清空' : '清空全部收藏（不影响已读）',
              },
              clearArmed ? `确认清空（${saved.length}）` : '清空收藏',
            ),
          ),
        )
      }
      if (tab === 'selected') {
        subGroups.push(
          h(
            'div',
            { className: 'aihot-group', key: 'category' },
            h('span', { className: 'aihot-group-label' }, '分类'),
            ...CATEGORY_FILTERS.map((entry) =>
              h(
                'button',
                {
                  key: entry.id || 'all',
                  type: 'button',
                  className: 'aihot-chip',
                  'aria-pressed': entry.id === category,
                  onClick: () => setCategory(entry.id),
                },
                entry.label,
              ),
            ),
            h('span', { className: 'aihot-vr', key: 'vr-saved' }),
            h(
              'button',
              {
                type: 'button',
                className: 'aihot-chip',
                'aria-pressed': savedView,
                disabled: saved.length === 0,
                title: saved.length === 0 ? '还没有收藏的条目（点卡片右上角的 ☆）' : '只看已收藏的条目',
                onClick: () => setSavedOnly((value) => !value),
              },
              `已收藏（${saved.length}）`,
            ),
          ),
        )
      }
      if (tab === 'daily') {
        subGroups.push(
          h(
            'div',
            { className: 'aihot-group', key: 'journal' },
            h('span', { className: 'aihot-group-label' }, '期刊'),
            ...PERIOD_SEGMENTS.map((entry) =>
              h(
                'button',
                {
                  key: entry.id,
                  type: 'button',
                  className: 'aihot-chip',
                  'aria-pressed': entry.id === journal,
                  onClick: () => setJournal(entry.id),
                },
                entry.label,
              ),
            ),
          ),
        )
        if (isJournal && period.state.items.length > 0) {
          subGroups.push(
            h(
              'div',
              { className: 'aihot-group', key: 'issues' },
              h('span', { className: 'aihot-group-label' }, '期号'),
              ...period.state.items.slice(0, 12).map((entry) => {
                const issue = periodIssue(journal, entry)
                return h(
                  'button',
                  {
                    key: issue,
                    type: 'button',
                    className: 'aihot-chip',
                    'aria-pressed': issue === period.state.issue,
                    title: entry.headline ?? '',
                    onClick: () => period.setIssue(issue),
                  },
                  issue,
                )
              }),
            ),
          )
        }
      }
      const subBar =
        subGroups.length === 0 && !updatedAt
          ? null
          : h(
              'div',
              { className: 'aihot-topbar-sub' },
              ...subGroups.flatMap((node, index) =>
                index === 0 ? [node] : [h('span', { className: 'aihot-vr', key: `vr-${index}` }), node],
              ),
              updatedAt ? h('span', { className: 'aihot-topbar-meta' }, `更新于 ${updatedAt}`) : null,
            )

      return h(
        'div',
        { className: 'aihot-page', 'data-aihot-theme': theme.resolved },
// 顶栏：主行放 tab 段控件与工具（搜索 / 主题 / 刷新），上下文行按需出现。
        h(
          'div',
          { className: 'aihot-topbar' },
          h(
            'div',
            { className: 'aihot-topbar-main' },
            h(
              'div',
              { className: 'aihot-tabs-wrap' },
              h(
                'div',
                { className: 'aihot-tabs', role: 'tablist' },
                ...TABS.map((entry) =>
                  h(
                    'button',
                    {
                      key: entry.id,
                      type: 'button',
                      role: 'tab',
                      className: 'aihot-tab',
                      'aria-selected': entry.id === tab,
                      onClick: () => setTab(entry.id),
                    },
                    tabLabel(entry, saved.length),
                  ),
                ),
              ),
            ),
            h(
              'div',
              { className: 'aihot-topbar-tools' },
              h(
                'div',
                { className: 'aihot-search' },
                h(
                  'svg',
                  { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': 'true' },
                  h('circle', { cx: 7, cy: 7, r: 4.25 }),
                  h('path', { d: 'M10.25 10.25 13.5 13.5' }),
                ),
                h('input', {
                  type: 'search',
                  value: searchInput,
                  placeholder: '搜索资讯',
                  'aria-label': '搜索资讯',
                  spellCheck: false,
                  onChange: (event) => onSearchChange(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key !== 'Escape') return
                    event.stopPropagation()
                    clearSearch()
                  },
                }),
                searchInput
                  ? h(
                      'button',
                      { type: 'button', className: 'aihot-search-clear', onClick: clearSearch, title: '清除搜索', 'aria-label': '清除搜索' },
                      '×',
                    )
                  : null,
              ),
              h(
                'div',
                { className: 'aihot-theme', role: 'group', 'aria-label': '主题' },
                ...THEMES.map((entry) =>
                  h(
                    'button',
                    {
                      key: entry.id,
                      type: 'button',
                      'aria-pressed': theme.choice === entry.id,
                      onClick: () => theme.choose(entry.id),
                      title: `主题：${entry.label}`,
                    },
                    entry.label,
                  ),
                ),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'aihot-button aihot-refresh',
                  onClick: refresh,
                  disabled: status === 'loading',
                  'data-busy': status === 'loading',
                  title: '重新拉取当前页数据',
                },
                h(
                  'svg',
                  { viewBox: '0 0 16 16', width: 13, height: 13, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', 'aria-hidden': 'true' },
                  h('path', { d: 'M13.55 8.6A5.6 5.6 0 1 1 12 4.4' }),
                  h('path', { d: 'M13.7 2.3v4.1h-4.1' }),
                ),
                '刷新',
              ),
            ),
          ),
          subBar,
        ),
        h(
          'div',
          { className: 'aihot-body', 'data-aihot-scroll': '' },
          body,
          h(
            'div',
            { className: 'aihot-footer' },
            h('span', null, '数据来源：'),
            h('a', { className: 'aihot-link', href: HOME_URL, target: '_blank', rel: 'noreferrer' }, 'AIHOT'),
            h('span', null, '· 内容为第三方信源，只作资料；请回原文核对。'),
          ),
        ),
        h(StoryDrawer, { target: storyTarget, onClose: closeStory }),
        h(ArticleDrawer, { target: articleTarget, onClose: closeArticle }),
      )
    }

    /**
     * 左侧栏全局面板行的字形。shell 自己拥有行框、label、选中高亮、折叠 rail，
     * 这里只画 16×16 字形；根 svg 上的 `data-dsh-panel-entry` 是 L2 契约（皮肤）用来
     * 认出「这一行属于哪个插件」的唯一钩子（shell 不额外打标记）。
     * @param {{ size?: number, active?: boolean }} props shell 给的字形边长与选中态
     */
    function AihotPanelIcon({ size = 16 }) {
      return h(
        'svg',
        {
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
        h('rect', { x: 1.75, y: 2.25, width: 12.5, height: 11.5, rx: 1.75 }),
        h('path', { d: 'M4.5 10.5v1.5' }),
        h('path', { d: 'M7.25 8.5v3.5' }),
        h('path', { d: 'M10 6.5v5.5' }),
      )
    }

    /**
     * 左侧栏全局面板页（`main` 槽的 keyed 页面）。layout 只在这个面板被选中时挂载它，
     * 外层容器撑满高度，里面复用会话视图那份四 tab 页面本体。
     */
    function AihotPanelPage() {
      return h('div', { className: 'aihot-panel', 'data-dsh-panel-view': PANEL_ID }, h(Page))
    }

    /** 视图页自己管理样式：apply 里注册，卸载时删除。 */
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      const existing = document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)
      if (existing) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = '@local/dsh-aihot'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        tag.remove()
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => installStyles(), 'dsh-aihot: page styles')

        // 刻意不注册 conversation.view：shell 会把「当前 View」按会话持久化到 localStorage，
        // 于是曾点进 AI 资讯的会话以后每次打开都直接回到资讯页、看不到对话内容（且无处可退）。
        // 全局面板（sidebar.panellist + main）已覆盖同一入口，且点会话必定 clearPanel。
        // （`view:'aihot'` 的旧偏好会因 resolveActiveView 回落到 'chat'，无需迁移。）

        // 左侧栏全局面板行：只提供字形，行框/label/高亮/折叠都属于 shell。
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.panellist',
                  id: PANEL_ID,
                  order: 50,
                  label: () => 'AI 资讯',
                },
                AihotPanelIcon,
              ),
            ),
          'dsh-aihot: AI 资讯 sidebar row',
        )

        // 中心列页面本体：`main` 槽按 key 选面板，只有选中时才挂载。
        ctx.effect(
          () =>
            ctx.slots.inject('main', () =>
              ctx.slots.register({ name: 'main', key: PANEL_ID }, AihotPanelPage),
            ),
          'dsh-aihot: AI 资讯 panel page',
        )
      },
    }
  },
})