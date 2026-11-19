/**
 * @local/dsh-cicd · Client 半边。
 *
 * 在 layout 的 `main` 槽上注册整页视图「流水线」（入口是左侧栏全局面板行，同时保留会话内 View）：
 * 左侧固定导航（运行 / 发布 / 审批 / pipe.yml / 新建 / 构建主机 / Secrets / RBAC / 审计）
 * → 主区面包屑 + 工具条（项目切换 / 目标 / 构建主机 / 计划 / 干跑 / 运行 / 刷新）
 * → 三列内容（阶段与目标矩阵 → Run 详情（运行记录 + steps 时间线 + 跟随日志）→ Releases）；
 * 窄屏（<1100px）退化为两列（详情与 Releases 上下叠）。
 *
 * v3.0-P0 路由：视图/项目/选中运行全部映射到 URL 片段
 * `#/projects/:project[/runs/:runId | /releases | /approvals | /pipeline | /new | /runners | /secrets | /rbac | /audit][?target=&step=&line=]`。
 * 用 hash 而不是 history API：面板挂在宿主页面里，`pushState` 会改掉宿主自身的路径、刷新后宿主不认识该路由；
 * hash 只动片段，宿主刷新后仍能挂载面板，面板自己把视图还原回来。刷新不丢视图、地址可直接分享。
 *
 * 约束：只用 `require('react')`；颜色只用 `--dsw-alias-*` 主题 token；不 iframe、不碰别人的 DOM；
 * 数据全部走 Host 端路由 `/api/plugins/cicd/*`（全部 GET + `x-dsh-cicd: 1` 头）。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-cicd',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const STYLE_ID = '@local/dsh-cicd/page.css'
    /** 左侧栏全局面板的 id / `main` 槽 key。 */
    const PANEL_ID = 'cicd'
    /** Host 路由前缀与鉴权头（Host 端要求带上，避免被当作浏览器随手请求）。 */
    const API_BASE = '/api/plugins/cicd'
    const REQUEST_HEADERS = { accept: 'application/json', 'x-dsh-cicd': '1' }
    /** 有 running / queued 的运行时的轮询间隔。 */
    const POLL_MS = 2000
    /** 运行列表默认条数与日志 tail 行数。 */
    const RUN_LIMIT = 30
    const LOG_TAIL = 200
    /** 「运行」与「回滚」的二次确认窗口。 */
    const CONFIRM_MS = 10000
    const ROLLBACK_CONFIRM_MS = 8000
    /** v0.6 B：测试通知是外发动作，按任务书要求 8 秒二次确认。 */
    const NOTIFY_CONFIRM_MS = 8000
    /** v0.6 C：审计条数候选（Host 端 limit 允许 1..200）。 */
    const AUDIT_LIMITS = [50, 100, 200]
    const AUDIT_DEFAULT_LIMIT = 50

    const CSS = `
.cicd-page{display:flex;flex-direction:column;box-sizing:border-box;width:100%;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.cicd-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:none;padding:10px 16px;border-bottom:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base)}
.cicd-toolbar-group{display:flex;align-items:center;gap:8px;min-width:0}
.cicd-toolbar-spacer{flex:1 1 auto;min-width:0}
.cicd-label{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;white-space:nowrap}
.cicd-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.cicd-select{appearance:auto;box-sizing:border-box;height:28px;max-width:190px;padding:0 6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm, 6px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.cicd-select:disabled{opacity:.55;cursor:default}
.cicd-button{appearance:none;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm, 6px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer}
.cicd-button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.cicd-button:disabled{opacity:.55;cursor:default}
.cicd-button[aria-pressed="true"]{border-color:var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
.cicd-button-primary{border-color:transparent;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.cicd-button-primary:hover{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);opacity:.9}
.cicd-button-danger{color:var(--dsw-alias-state-error-primary)}
.cicd-button-armed{border-color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-error-primary)}
.cicd-hint{flex:1 1 100%;color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px}
.cicd-project-select,.cicd-target-select{min-width:124px}
.cicd-run-now,.cicd-view-releases,.cicd-dry-run{min-width:68px}
.cicd-plan-open,.cicd-plan-close{min-width:56px}
.cicd-plan-close{height:24px;padding:0 8px;font-size:11.5px}
.cicd-refresh{min-width:56px}
.cicd-step-wrap{display:block}
.cicd-poll{color:var(--dsw-alias-label-dimmed);font-size:11.5px;line-height:16px;white-space:nowrap}
.cicd-columns{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:minmax(225px,.95fr) minmax(300px,1.25fr) minmax(235px,.95fr);gap:12px;box-sizing:border-box;padding:12px 16px 14px;overflow:hidden}
.cicd-col{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md, 8px);background:var(--dsw-alias-bg-layer-1)}
.cicd-col-head{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.cicd-col-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:12.5px;font-weight:600;line-height:18px}
.cicd-col-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:8px;padding:8px}
.cicd-project{margin:0 0 2px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px}
.cicd-project-path{margin:0 0 4px;color:var(--dsw-alias-label-dimmed);font-size:11.5px;line-height:16px;overflow-wrap:anywhere}
.cicd-target-row{appearance:none;box-sizing:border-box;display:flex;flex-direction:column;gap:2px;width:100%;padding:7px 9px;border:.5px solid transparent;border-radius:var(--dsw-radius-sm, 6px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;line-height:18px;text-align:left;cursor:pointer}
.cicd-target-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.cicd-target-row.is-active{border-color:var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3)}
.cicd-target-name{display:block;font-weight:600}
.cicd-target-meta{display:block;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cicd-target-health{display:block;color:var(--dsw-alias-label-dimmed);font-size:11px;line-height:15px}
.cicd-target-current{display:block;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px}
.cicd-source-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}
.cicd-run-row{appearance:none;box-sizing:border-box;display:flex;flex-direction:column;gap:3px;width:100%;padding:7px 9px;border:.5px solid transparent;border-radius:var(--dsw-radius-sm, 6px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;line-height:18px;text-align:left;cursor:pointer}
.cicd-run-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.cicd-run-row.is-active{border-color:var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3)}
.cicd-run-row-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.cicd-run-id{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:11.5px}
.cicd-run-meta{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cicd-run-error{color:var(--dsw-alias-state-error-primary);font-size:11.5px;line-height:16px;overflow-wrap:anywhere}
.cicd-status{flex:none;display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:var(--dsw-radius-xs, 4px);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:nowrap}
.cicd-status.is-queued{color:var(--dsw-alias-label-secondary)}
.cicd-status.is-running{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.cicd-status.is-success{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.cicd-status.is-failed{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.cicd-status.is-canceled{color:var(--dsw-alias-label-dimmed)}
.cicd-status.is-skipped{color:var(--dsw-alias-label-dimmed)}
.cicd-detail{display:flex;flex-direction:column;gap:10px;padding:2px}
.cicd-detail-meta{display:grid;grid-template-columns:repeat(auto-fit, minmax(120px, 1fr));gap:6px 12px;margin:0;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm, 6px);background:var(--dsw-alias-bg-layer-2)}
.cicd-detail-meta dt{color:var(--dsw-alias-label-dimmed);font-size:11px;line-height:15px}
.cicd-detail-meta dd{margin:0;color:var(--dsw-alias-label-primary);font-size:12px;line-height:17px;overflow-wrap:anywhere}
.cicd-detail-failure{margin:0;padding:8px 10px;border:.5px solid var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-sm, 6px);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:17px;overflow-wrap:anywhere}
.cicd-section-title{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-weight:600}
.cicd-stages{display:flex;flex-direction:column;gap:6px}
.cicd-stage{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm, 6px);background:var(--dsw-alias-bg-layer-2);padding:6px 8px}
.cicd-stage-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px}
.cicd-stage-name{color:var(--dsw-alias-label-primary);font-size:12px;line-height:17px;font-weight:600;overflow-wrap:anywhere}
.cicd-step{display:flex;align-items:baseline;gap:8px;padding:2px 0}
.cicd-step-index{flex:none;color:var(--dsw-alias-label-dimmed);font-size:11px;line-height:15px}
.cicd-step-name{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px;overflow-wrap:anywhere}
.cicd-step-cmd{display:block;margin:2px 0 4px 26px;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:16px;white-space:pre-wrap;overflow-wrap:anywhere}
.cicd-step-flag{flex:none;color:var(--dsw-alias-label-dimmed);font-size:11px;line-height:15px;white-space:nowrap}
.cicd-log{display:flex;flex-direction:column;gap:1px;margin:0;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm, 6px);background:var(--dsw-alias-bg-layer-2);max-height:320px;overflow:auto;overscroll-behavior:contain}
.cicd-log-line{margin:0;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:16px;white-space:pre-wrap;overflow-wrap:anywhere}
.cicd-log-line.is-highlight{border-radius:3px;background:var(--dsw-alias-state-warn-bg, rgba(255,159,10,.16));color:var(--dsw-alias-label-primary)}
.cicd-note{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:17px}
.cicd-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:18px 10px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;text-align:center}
.cicd-loading{display:flex;align-items:center;gap:8px;padding:10px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.cicd-skeleton{width:100%;height:34px;border-radius:var(--dsw-radius-sm, 6px);background:var(--dsw-alias-bg-skeleton)}
.cicd-error{display:flex;flex-direction:column;gap:4px;padding:9px 10px;border:.5px solid var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-sm, 6px);background:var(--dsw-alias-bg-layer-1)}
.cicd-error-message{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:17px;overflow-wrap:anywhere}
.cicd-error-code{color:var(--dsw-alias-label-dimmed);font-size:11px;line-height:15px}
.cicd-error-hint{color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:16px}
.cicd-error-retry{align-self:flex-start;margin-top:2px}
.cicd-action{display:flex;align-items:center;gap:8px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm, 6px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px;margin:0 16px 10px}
.cicd-action.is-error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.cicd-action-body{display:flex;flex-direction:column;gap:2px;min-width:0}
.cicd-action-message{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.cicd-plan{flex:none;display:flex;flex-direction:column;gap:8px;margin:0;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md, 8px);background:var(--dsw-alias-bg-layer-1)}
.cicd-plan-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.cicd-plan-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:12.5px;font-weight:600;line-height:18px}
.cicd-host-chip.is-prod{border-color:var(--dsw-alias-state-warn-primary)}
.cicd-host-prod-icon{font-size:10px;line-height:14px}
.cicd-host-count{flex:none;display:inline-flex;align-items:center;height:20px;padding:0 6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xs,4px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:10.5px;line-height:14px;white-space:nowrap}
.cicd-target-strategy{flex:none;display:inline-flex;align-items:center;height:16px;padding:0 5px;border:.5px solid var(--dsw-alias-border-l3);border-radius:4px;color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:14px}
.cicd-releases{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;padding:12px 16px 14px;overflow:hidden}
.cicd-releases-head{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px}
.cicd-table-wrap{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md, 8px);background:var(--dsw-alias-bg-layer-1)}
.cicd-table{width:100%;border-collapse:collapse;font-size:12px;line-height:18px}
.cicd-table th{position:sticky;top:0;z-index:1;padding:7px 10px;text-align:left;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:11.5px;font-weight:600;background:var(--dsw-alias-bg-layer-2);border-bottom:.5px solid var(--dsw-alias-border-l1)}
.cicd-table td{padding:6px 10px;color:var(--dsw-alias-label-secondary);border-bottom:.5px solid var(--dsw-alias-border-l1);overflow-wrap:anywhere}
.cicd-release-row.is-active td{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.cicd-release-cell{white-space:nowrap}
.cicd-release-cell.cicd-release-id{max-width:200px;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary)}
.cicd-release-act{text-align:right}
.cicd-rollback{appearance:none;box-sizing:border-box;height:24px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs, 4px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;line-height:16px;white-space:nowrap;cursor:pointer}
.cicd-rollback:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.cicd-rollback.is-armed{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.cicd-footer{flex:none;padding:0 16px 10px;color:var(--dsw-alias-label-dimmed);font-size:11px;line-height:16px}
.cicd-project-picker{min-width:124px}
.cicd-project-static{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:18px}
.cicd-targets{display:flex;flex-direction:column;gap:6px}
.cicd-target-card{gap:4px}
.cicd-target-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.cicd-target-runtime{flex:none;display:inline-flex;align-items:center;height:17px;padding:0 6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs, 4px);color:var(--dsw-alias-label-tertiary);font-size:10.5px;line-height:15px}
.cicd-target-hosts{display:flex;flex-wrap:wrap;gap:4px}
.cicd-host-chip{display:inline-flex;align-items:center;gap:5px;box-sizing:border-box;height:20px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xs, 4px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:15px;white-space:nowrap}
.cicd-host-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-dimmed)}
.cicd-host-dot.is-running{background:var(--dsw-alias-brand-primary)}
.cicd-host-dot.is-success{background:var(--dsw-alias-state-success-primary)}
.cicd-host-dot.is-failed{background:var(--dsw-alias-state-error-primary)}
.cicd-host-dot.is-skipped{background:var(--dsw-alias-label-dimmed)}
.cicd-target-keep{display:block;color:var(--dsw-alias-label-dimmed);font-size:11px;line-height:15px}
.cicd-runs{flex:none;display:flex;flex-direction:column;gap:4px;max-height:220px;overflow:auto;overscroll-behavior:contain;padding-bottom:6px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.cicd-runs-head{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-weight:600}
.cicd-run-row.is-running{box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}
.cicd-run-row.is-success{box-shadow:inset 2px 0 0 var(--dsw-alias-state-success-primary)}
.cicd-run-row.is-failed{box-shadow:inset 2px 0 0 var(--dsw-alias-state-error-primary)}
.cicd-run-row.is-skipped{box-shadow:inset 2px 0 0 var(--dsw-alias-label-dimmed)}
.cicd-timeline{display:flex;flex-direction:column;gap:1px}
.cicd-timeline-stage{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:6px 0 2px;color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600;line-height:17px}
/* v3.0-P1：stage 与 step 之间的 job 行（并行 job / matrix 实例各一行） */
.cicd-timeline-job{display:flex;align-items:center;gap:6px;margin:3px 0 1px;padding-left:3px;min-width:0;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:16px}
.cicd-timeline-job-name{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cicd-timeline-job-meta{flex:none;color:var(--dsw-alias-label-dimmed);font-size:10.5px;line-height:14px}
.cicd-log-job-select{height:24px;padding:0 6px;font-size:11.5px;line-height:22px;max-width:220px}
.cicd-timeline-step{display:flex;align-items:flex-start;gap:8px;padding:2px 0 2px 3px}
.cicd-timeline-dot{flex:none;width:8px;height:8px;margin-top:5px;border-radius:50%;background:var(--dsw-alias-label-dimmed)}
.cicd-timeline-dot.is-running{background:var(--dsw-alias-brand-primary)}
.cicd-timeline-dot.is-success{background:var(--dsw-alias-state-success-primary)}
.cicd-timeline-dot.is-failed{background:var(--dsw-alias-state-error-primary)}
.cicd-timeline-dot.is-skipped{background:var(--dsw-alias-label-dimmed)}
.cicd-timeline-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}
.cicd-timeline-name{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px;overflow-wrap:anywhere}
.cicd-timeline-meta{color:var(--dsw-alias-label-dimmed);font-size:11px;line-height:15px}
.cicd-timeline-summary{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:16px;white-space:pre-wrap;overflow-wrap:anywhere}
.cicd-timeline-summary.is-failed{color:var(--dsw-alias-state-error-primary)}
.cicd-log-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.cicd-log-tools .cicd-button{height:24px;padding:0 8px;font-size:11.5px;line-height:22px}
.cicd-log-follow[aria-pressed="true"]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-border-l3)}
.cicd-action-retry{height:24px;padding:0 8px;font-size:11.5px;line-height:22px}
.cicd-col-releases .cicd-table td{padding:5px 8px}
.cicd-target-envs{display:flex;flex-wrap:wrap;align-items:center;gap:4px}
.cicd-env-chip{flex:none;display:inline-flex;align-items:center;height:16px;padding:0 5px;border:.5px solid var(--dsw-alias-border-l2);border-radius:4px;color:var(--dsw-alias-label-tertiary);font-size:10.5px;line-height:14px}
.cicd-env-chip.is-prod{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.cicd-release-env{margin-left:6px;color:var(--dsw-alias-label-dimmed);font-size:10.5px}
.cicd-prod-guard{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:.5px solid var(--dsw-alias-state-warn-primary);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-1)}
.cicd-prod-guard-text{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.cicd-prod-guard-hosts{color:var(--dsw-alias-state-warn-primary);font-size:11.5px;line-height:16px;overflow-wrap:anywhere}
.cicd-prod-guard-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cicd-prod-confirm{height:24px;padding:0 10px;font-size:11.5px;line-height:22px;color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
/* v0.6 A：灰度分批 */
.cicd-target-canary{flex:none;display:inline-flex;align-items:center;height:16px;padding:0 5px;border:.5px solid var(--dsw-alias-border-l3);border-radius:4px;color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:14px}
.cicd-host-rows{display:flex;flex-direction:column;gap:2px;margin:2px 0 0 16px}
.cicd-timeline-step-wrap{display:block}
.cicd-host-row{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px;overflow-wrap:anywhere}
.cicd-host-batch{flex:none;color:var(--dsw-alias-label-dimmed);font-size:10.5px;line-height:14px}
.cicd-host-health{color:var(--dsw-alias-label-dimmed);font-size:10.5px;line-height:14px}
.cicd-canary-hold{display:flex;align-items:center;gap:6px;padding:5px 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:16px}
.cicd-canary-batches{display:flex;flex-wrap:wrap;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px}
.cicd-canary-batch{display:inline-flex;align-items:center;gap:5px;height:18px;padding:0 6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:4px}
/* v0.6 B：通知 */
.cicd-notify-test{min-width:76px}
.cicd-notify-result{flex:none;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:16px;overflow-wrap:anywhere}
.cicd-notify-result.is-failed{color:var(--dsw-alias-state-error-primary)}
.cicd-notify-hint{margin:0;color:var(--dsw-alias-label-dimmed);font-size:11px;line-height:15px}
/* v0.6 C：审计时间线 */
.cicd-view-audit{min-width:60px}
.cicd-audit{flex:1 1 auto;display:flex;flex-direction:column;gap:8px;min-height:0;padding:12px 16px 14px;overflow:hidden}
.cicd-audit-head{flex:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cicd-audit-limit{height:28px;max-width:104px}
.cicd-audit-row.is-deploy-failed{box-shadow:inset 2px 0 0 var(--dsw-alias-state-error-primary)}
.cicd-audit-row.is-rollback{box-shadow:inset 2px 0 0 var(--dsw-alias-state-warn-primary)}
.cicd-audit-row.is-canary-hold{box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}
.cicd-audit-cell{white-space:nowrap}
.cicd-audit-cell.cicd-audit-detail{white-space:normal;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px}
.cicd-audit-action{display:inline-flex;align-items:center;height:18px;padding:0 6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:4px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:14px}
.cicd-audit-action.is-deploy-failed{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.cicd-audit-action.is-rollback{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.cicd-audit-action.is-canary-hold{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-border-l3)}
@media (max-width:1100px){
.cicd-columns{grid-template-columns:minmax(200px,.9fr) minmax(0,1.1fr);grid-template-rows:minmax(220px,1.1fr) minmax(180px,.9fr)}
.cicd-col-overview{grid-row:1 / span 2}
.cicd-col-releases{grid-column:2;grid-row:2}
}
.cicd-panel{display:flex;flex-direction:column;height:100%;min-height:0}
.cicd-panel>.cicd-page{flex:1 1 auto;min-height:0}
/* v3.0-P0：左侧视图导航 + 主区（工具条/详情）分层，替掉一排同权重的整页切换按钮 */
.cicd-shell{display:flex;flex:1 1 auto;min-height:0;min-width:0}
.cicd-nav{display:flex;flex-direction:column;gap:2px;flex:none;width:132px;box-sizing:border-box;padding:10px 8px;border-right:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);overflow-y:auto;overscroll-behavior:contain}
.cicd-nav-title{padding:0 8px 6px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;letter-spacing:.02em}
.cicd-nav-item{appearance:none;box-sizing:border-box;display:flex;align-items:center;gap:7px;width:100%;height:28px;padding:0 8px;border:.5px solid transparent;border-radius:var(--dsw-radius-sm, 6px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;line-height:18px;text-align:left;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cicd-nav-item:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.cicd-nav-item[aria-current="page"]{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-weight:500}
.cicd-nav-badge{flex:none;min-width:16px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-bg-base);font-size:10.5px;line-height:15px;text-align:center}
.cicd-nav-sep{flex:none;height:1px;margin:6px 8px;background:var(--dsw-alias-border-l2)}
.cicd-main{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0}
.cicd-route{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 16px;border-bottom:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:16px}
.cicd-route-link{appearance:none;padding:0;border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.cicd-route-link:hover{color:var(--dsw-alias-label-primary)}
.cicd-route-copy{border-color:var(--dsw-alias-border-l2)}
@media (max-width:880px){
.cicd-nav{width:108px}
}
/* v2-M0：项目卡 git meta */
.cicd-project-git{display:block;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cicd-project-git.is-dirty{color:var(--dsw-alias-state-warn-primary)}
.cicd-view-editor,.cicd-view-create{min-width:56px}
/* v2-M0：pipe.yml 编辑器 */
.cicd-editor{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;padding:12px 16px 14px;overflow:hidden}
.cicd-editor-head{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.cicd-editor-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:16px}
.cicd-editor-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:8px}
.cicd-editor-textarea{flex:1 1 auto;min-height:0;box-sizing:border-box;width:100%;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md, 8px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:19px;resize:none;outline:none}
.cicd-editor-textarea:focus{border-color:var(--dsw-alias-border-l4)}
.cicd-editor-actions{flex:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cicd-editor-status{flex:none;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:16px;overflow-wrap:anywhere}
.cicd-editor-status.is-error{color:var(--dsw-alias-state-error-primary)}
.cicd-editor-status.is-ok{color:var(--dsw-alias-state-success-primary)}
.cicd-editor-result{flex:none;margin:0;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm, 6px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:17px;overflow-wrap:anywhere}
.cicd-editor-result.is-error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
/* v2-M0：新建向导 */
.cicd-create{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;box-sizing:border-box;padding:12px 16px 14px}
.cicd-create-form{display:flex;flex-direction:column;gap:14px;max-width:560px}
.cicd-form-field{display:flex;flex-direction:column;gap:4px}
.cicd-form-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-weight:600}
.cicd-form-hint{margin:0;color:var(--dsw-alias-label-dimmed);font-size:11px;line-height:15px}
.cicd-form-input{box-sizing:border-box;width:100%;height:28px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm, 6px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;line-height:18px;outline:none}
.cicd-form-input:focus{border-color:var(--dsw-alias-border-l4)}
.cicd-form-radio-group{display:flex;gap:8px;flex-wrap:wrap}
.cicd-form-radio{appearance:none;box-sizing:border-box;display:inline-flex;align-items:center;height:28px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm, 6px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.cicd-form-radio:hover{background:var(--dsw-alias-interactive-bg-hover)}
.cicd-form-radio[aria-pressed="true"]{border-color:var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
.cicd-create-kinds{display:flex;gap:8px;flex-wrap:wrap}
.cicd-create-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:2px}
/* P1：审批门视图 */
.cicd-view-approvals,.cicd-view-rbac,.cicd-view-secrets,.cicd-view-runners{min-width:56px}
.cicd-approvals,.cicd-rbac,.cicd-secrets,.cicd-runners{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;box-sizing:border-box;padding:12px 16px 14px;display:flex;flex-direction:column;gap:10px}
.cicd-approvals-head,.cicd-rbac-head,.cicd-secrets-head,.cicd-runners-head{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px}
.cicd-approvals-list{display:flex;flex-direction:column;gap:6px}
.cicd-approval-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-1)}
.cicd-approval-row.is-resolved{opacity:.7}
.cicd-approval-info{display:flex;flex-direction:column;gap:2px;min-width:0}
.cicd-approval-runid{color:var(--dsw-alias-label-primary);font-size:12px}
.cicd-approval-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px;overflow-wrap:anywhere}
.cicd-approval-actions{display:flex;align-items:center;gap:6px;flex:none}
.cicd-button-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.cicd-button-danger:hover{background:var(--dsw-alias-state-error-bg,rgba(255,59,48,.08))}
.cicd-approvals-resolved,.cicd-rbac-body,.cicd-secrets-body,.cicd-rbac-audit{display:flex;flex-direction:column;gap:6px}
/* P1：RBAC 视图 */
.cicd-rbac-verify{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cicd-rbac-verify .cicd-form-input{flex:1 1 200px;max-width:400px}
/* P1：Secrets 视图 */
.cicd-secrets-form{display:flex;flex-direction:column;gap:8px;max-width:480px}
.cicd-secrets-form .cicd-button{align-self:flex-start}
`

    /** 运行 / 阶段状态 → 中文徽标文案。 */
    const STATUS_LABELS = {
      queued: '排队中',
      running: '运行中',
      success: '成功',
      failed: '失败',
      canceled: '已取消',
      skipped: '已跳过',
      pending: '待执行',
      waiting: '等待中',
    }

    /** 错误码 → 给人看的中文解释（契约里约定的三个码 + Host 没就绪时的兜底）。 */
    const CODE_HINTS = {
      REMOTE_UNAVAILABLE: 'dsh-remote 还没就绪：先在插件页启用并重载 dsh-remote，再回来重试。',
      HEALTH_FAILED: '部署后的健康检查失败，Host 已自动回滚到上一个版本；先看日志确认服务是否起得来。',
      PIPE_INVALID: 'pipe.yml 解析失败：按提示的行号修正文件后重试。',
      NETWORK: '没能连上 Host：确认 DSH 仍在运行，再点重试。',
      BAD_RESPONSE: 'Host 返回的不是预期的 JSON：对应路由可能还没落地，稍后再试。',
      PROD_CONFIRM_REQUIRED: '这次发布包含生产主机：读一遍受影响主机，确认后点「确认发布到生产」。',
      DEPLOY_IN_PROGRESS: '同一个 target 已经有一次发布在跑：等它结束（或看日志）再重试。',
    }

    /** v0.6 C：审计动作 → 中文标签（Host 的 action 取值见契约）。 */
    const OPERATION_LABELS = {
      deploy: '部署',
      'deploy-failed': '部署失败',
      rollback: '回滚',
      'canary-hold': '灰度等待',
      notify: '通知',
    }
    /** 动作 → 行 / 徽标的色调类（与状态类同一套 is-*）。 */
    const OPERATION_TONES = {
      deploy: 'success',
      'deploy-failed': 'failed',
      rollback: 'running',
      'canary-hold': 'running',
      notify: 'skipped',
    }

    /** v2-M0：新建向导的脚手架模板清单（与 Host 端 lib/scaffold.js 的 SCAFFOLD_KINDS 一一对应）。 */
    const SCAFFOLD_KINDS = [
      { id: 'static', name: '静态站点', description: '打包成 tgz 上传，不重启服务' },
      { id: 'node', name: 'Node.js', description: 'npm 构建 + pm2 重启' },
      { id: 'python', name: 'Python', description: 'pip 安装 + systemd --user 重启' },
      { id: 'go', name: 'Go', description: 'go build 出二进制' },
      { id: 'bare', name: '空白模板', description: '只有一段 echo，改造成自己的流程' },
    ]

    const TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })

    function formatTime(value) {
      if (!value) return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      return TIME_FORMAT.format(date).replace(/\//g, '-')
    }

    function formatDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—'
      if (ms < 1000) return ms + ' ms'
      const seconds = Math.round(ms / 100) / 10
      if (seconds < 60) return seconds + ' 秒'
      const minutes = Math.floor(seconds / 60)
      const rest = Math.round(seconds % 60)
      return minutes + ' 分 ' + rest + ' 秒'
    }

    function shortId(value, edge) {
      const text = String(value || '')
      const limit = typeof edge === 'number' ? edge : 18
      return text.length <= limit ? text : text.slice(0, limit) + '…'
    }

    /** 项目选择记在 localStorage（`cicd.project`）：下次打开面板直接回到上次的项目。 */
    const PROJECT_STORE_KEY = 'cicd.project'

    function readStoredProject() {
      try {
        if (typeof localStorage === 'undefined' || !localStorage) return ''
        const value = localStorage.getItem(PROJECT_STORE_KEY)
        return typeof value === 'string' ? value : ''
      } catch (error) {
        return ''
      }
    }

    function writeStoredProject(id) {
      try {
        if (typeof localStorage === 'undefined' || !localStorage) return
        localStorage.setItem(PROJECT_STORE_KEY, id)
      } catch (error) {
        // 隐私模式 / 存储被禁用时静默跳过：这次选择仍然生效，只是不持久化。
      }
    }

    /**
     * v3.0-P0：hash 路由。
     *
     * 之前所有状态都是组件内 `useState`，没有任何 URL 约束，所以刷新回到默认三栏、链接发不出、
     * 也无法从审批消息里直接跳到某次运行。这里用 hash（`#/projects/:p/runs/:id`）而不是
     * history API：面板挂在既有页面里，`pushState` 会改掉宿主页面自身的路径，刷新时宿主不认识这个
     * 路由；hash 只动片段，宿主刷新后仍能挂载面板，面板自己把视图还原回来。
     */
    const ROUTE_VIEWS = ['run', 'releases', 'editor', 'create', 'approvals', 'rbac', 'secrets', 'runners', 'audit']
    /** 视图 → 路径段（`run` 是默认视图，不带段，保证 `#/projects/x` 是最短可分享形式）。 */
    const VIEW_SEGMENTS = {
      releases: 'releases',
      editor: 'pipeline',
      create: 'new',
      approvals: 'approvals',
      rbac: 'rbac',
      secrets: 'secrets',
      runners: 'runners',
      audit: 'audit',
    }
    const SEGMENT_VIEWS = Object.keys(VIEW_SEGMENTS).reduce((acc, view) => {
      acc[VIEW_SEGMENTS[view]] = view
      return acc
    }, {})

    function safeDecode(value) {
      try {
        return decodeURIComponent(String(value == null ? '' : value))
      } catch (error) {
        return String(value == null ? '' : value)
      }
    }

    /** 把 `#/projects/p/runs/r1?target=prod` 解成对象；任何无法识别的片段都退化到安全默认值。 */
    function parseHash(hash) {
      const raw = String(hash == null ? '' : hash).replace(/^#/, '')
      const [pathPart, searchPart] = raw.split('?')
      const query = {}
      if (searchPart) {
        searchPart.split('&').forEach((pair) => {
          if (!pair) return
          const index = pair.indexOf('=')
          const key = safeDecode(index < 0 ? pair : pair.slice(0, index))
          if (!key) return
          query[key] = index < 0 ? '' : safeDecode(pair.slice(index + 1))
        })
      }
      const segments = String(pathPart || '').split('/').filter(Boolean).map(safeDecode)
      const route = { project: '', view: 'run', runId: '', target: query.target || '', line: query.line || '', step: query.step || '' }
      if (segments[0] === 'projects' && segments[1]) {
        route.project = segments[1]
        if (segments[2] === 'runs' && segments[3]) {
          route.runId = segments[3]
          route.view = 'run'
        } else if (segments[2] && SEGMENT_VIEWS[segments[2]]) {
          route.view = SEGMENT_VIEWS[segments[2]]
        }
      } else if (segments[0] === 'new') {
        route.view = 'create'
      }
      return route
    }

    /** 反向：路由对象 → hash 字符串。 */
    function buildHash(route) {
      const view = ROUTE_VIEWS.indexOf(route && route.view) >= 0 ? route.view : 'run'
      const segments = []
      // 路径段必须整体 encode：项目 id / run id 里出现 `/`、`?`、`#` 时若不编码，
      // 拼出来的 hash 会被解析成别的路由（`runs/a/b` 变成 runId=a 加一段垃圾）。
      if (route && route.project) {
        segments.push('projects', encodeURIComponent(route.project))
        if (view === 'run') {
          if (route.runId) segments.push('runs', encodeURIComponent(route.runId))
        } else {
          segments.push(VIEW_SEGMENTS[view])
        }
      } else if (view === 'create') {
        segments.push('new')
      }
      const query = []
      if (route && route.project && view !== 'create') {
        if (route.target) query.push('target=' + encodeURIComponent(route.target))
        if (view === 'run' && route.runId) {
          if (route.step) query.push('step=' + encodeURIComponent(route.step))
          if (route.line) query.push('line=' + encodeURIComponent(route.line))
        }
      }
      const search = query.length ? '?' + query.join('&') : ''
      return segments.length ? '#/' + segments.join('/') + search : ''
    }

    function readHash() {
      try {
        if (typeof window === 'undefined' || !window.location) return ''
        return window.location.hash || ''
      } catch (error) {
        return ''
      }
    }

    /**
     * 写 URL。`replace` 用于「把用户直接带进合法路由」这类修正，避免污染返回历史；
     * 用户主动切视图走 `pushState` 语义（这里用 `assign`）。
     */
    function writeHash(hash, replace) {
      try {
        if (typeof window === 'undefined' || !window.location) return
        if (!hash) return
        const current = window.location.hash || ''
        if (current === hash) return
        if (window.history && typeof window.history.replaceState === 'function') {
          const base = window.location.pathname + window.location.search
          window.history[replace ? 'replaceState' : 'pushState'](null, '', base + hash)
          return
        }
        window.location.hash = hash
      } catch (error) {
        // 沙箱 / 禁用 history 时降级为「只更新内存状态」，路由仍可用，只是不能分享。
      }
    }

    /** 订阅 hashchange：浏览器前进/后退、手改地址、外部深链都走这一条。 */
    function useHashRoute() {
      const [hash, setHash] = useState(() => readHash())
      useEffect(() => {
        if (typeof window === 'undefined' || !window.addEventListener) return undefined
        const onChange = () => setHash(readHash())
        // 我们自己是 `pushState` 写地址，浏览器前进/后退会发 popstate；同一文档内的片段跳转还会发 hashchange。
        // 两个都听：只听其中一个时，某些浏览器组合下后退不会重绘视图。
        window.addEventListener('hashchange', onChange)
        window.addEventListener('popstate', onChange)
        return () => {
          window.removeEventListener('hashchange', onChange)
          window.removeEventListener('popstate', onChange)
        }
      }, [])
      return hash
    }

    /** v2-M0：从 /project-meta 的返回里拼出项目卡上的 git 元信息行（分支 · 提交 · tag · 是否脏）。 */
    function projectGitMeta(meta) {
      if (!meta || meta.status !== 'ready' || !meta.data) return { text: '', dirty: false, isRepo: false }
      const data = meta.data
      const parts = []
      if (data.isRepo) {
        if (data.branch) parts.push(data.branch)
        if (data.commitShort || data.commit) parts.push(data.commitShort || data.commit)
        if (data.tag) parts.push('tag ' + data.tag)
      }
      if (data.dirty) parts.push('已改动')
      return { text: parts.join(' · '), dirty: Boolean(data.dirty), isRepo: Boolean(data.isRepo) }
    }

    /**
     * 把 stage 树摊平成时间线行：stage 标题行 + 每步一行（状态点 / 耗时 / 一行摘要）。
     *
     * v3.0-P1：DSL v2 里一个 stage 可以挂多个 job（含 matrix 实例），它们并行执行、
     * 各有一份日志。只按 stage → step 两级摊平的话，「哪几步是并行的」「哪个 job 失败了」
     * 都看不出来，所以有 job 图时在 stage 与 step 之间插一层 job 行。
     * 没有 job 图（v1 的 pipe、或老的历史运行）时行为与以前完全一致。
     */
    function timelineRows(stages, jobs) {
      const rows = []
      if (!Array.isArray(stages)) return rows
      const jobsByStage = new Map()
      ;(Array.isArray(jobs) ? jobs : []).forEach((job) => {
        const stageKey = job && job.stage ? job.stage : ''
        if (!jobsByStage.has(stageKey)) jobsByStage.set(stageKey, [])
        jobsByStage.get(stageKey).push(job)
      })
      const pushSteps = (stageKey, prefix, steps) => {
        steps.forEach((step, stepIndex) => {
          rows.push({
            kind: 'step',
            key: prefix + ':' + (step && step.index !== undefined ? step.index : stepIndex),
            step,
          })
        })
      }
      stages.forEach((stage, stageIndex) => {
        const stageKey = stage && stage.id ? stage.id : 'stage-' + stageIndex
        rows.push({ kind: 'stage', key: stageKey, stage })
        const steps = Array.isArray(stage && stage.steps) ? stage.steps : []
        const stageJobs = jobsByStage.get(stageKey) || []
        if (stageJobs.length === 0) {
          pushSteps(stageKey, stageKey, steps)
          return
        }
        // 先按 job 分组、保持 job 声明顺序；认不出归属的 step 落到末尾一个「未分组」块，
        // 宁可多显示一行也不要把已有的步骤藏起来。
        const groups = new Map()
        stageJobs.forEach((job) => groups.set(job.id, { job, steps: [] }))
        const loose = []
        steps.forEach((step) => {
          const group = groups.get(step && step.jobId ? step.jobId : '')
          if (group) group.steps.push(step)
          else loose.push(step)
        })
        groups.forEach((group, jobId) => {
          rows.push({ kind: 'job', key: stageKey + '/' + jobId, job: group.job })
          pushSteps(stageKey, stageKey + '/' + jobId, group.steps)
        })
        if (loose.length > 0) {
          rows.push({ kind: 'job', key: stageKey + '/-', job: null })
          pushSteps(stageKey, stageKey + '/-', loose)
        }
      })
      return rows
    }

    /**
     * Host 的字段名以实际实现为准（`projects[].hasPipe` / `pipe`、`runs[].startedAt/finishedAt`、
     * `logs.text`、`run` 路由的扁平返回）。这里做一层兼容：缺字段时退回契约里的另一套名字，
     * 这样 Host 侧以后再改名也不会让面板空着。
     */
    function projectHasPipe(project) {
      if (!project) return false
      if (typeof project.hasPipe === 'boolean') return project.hasPipe
      if (typeof project.exists === 'boolean') return project.exists
      return true
    }

    function projectPipePath(project) {
      if (!project) return ''
      return project.pipe || project.pipePath || project.path || ''
    }

    function runDurationMs(run) {
      if (!run) return null
      if (typeof run.durationMs === 'number' && Number.isFinite(run.durationMs)) return run.durationMs
      const start = Date.parse(run.startedAt || '')
      const end = Date.parse(run.finishedAt || '')
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return end - start
      return null
    }

    function logLines(payload) {
      if (!payload) return []
      if (Array.isArray(payload.lines)) return payload.lines.map((line) => String(line))
      if (typeof payload.text === 'string') return payload.text.split('\n').map((line) => line.replace(/\r$/, ''))
      return []
    }

    function planOf(payload) {
      if (!payload) return null
      if (payload.plan && Array.isArray(payload.plan.stages)) return payload.plan
      if (Array.isArray(payload.stages)) return { name: payload.name || '', stages: payload.stages, target: payload.target, project: payload.project }
      return null
    }

    function runOfPayload(payload) {
      if (!payload) return null
      if (payload.run && payload.run.id) return payload.run
      if (payload.runId || payload.status) {
        return {
          id: payload.runId || '',
          status: payload.status || '',
          target: payload.target || '',
          dryRun: Boolean(payload.dryRun),
          canary: payload.canary || null,
          stages: Array.isArray(payload.stages) ? payload.stages : [],
        }
      }
      return null
    }

    /** v0.6 A：target 上的灰度配置（`{first, waitSec}`）；没配置或首批 0 台时返回 null。 */
    function canaryOf(target) {
      const canary = target && target.canary
      if (!canary || typeof canary !== 'object') return null
      const first = Number(canary.first) || 0
      if (first <= 0) return null
      return { first, waitSec: Number(canary.waitSec) || 0 }
    }

    /** v0.6 A：灰度标徽文案，例如「灰度 1/3 · 间隔 30s」。 */
    function canaryText(canary, hostCount) {
      if (!canary) return ''
      const total = Number(hostCount) > 0 ? Number(hostCount) : Math.max(canary.first, 1)
      const wait = canary.waitSec > 0 ? ' · 间隔 ' + canary.waitSec + 's' : ''
      return '灰度 ' + canary.first + '/' + total + wait
    }

    /** v0.6 A：把 step 的 hosts 摊平成主机行（带批次）。 */
    function hostRowsOf(step) {
      const list = step && Array.isArray(step.hosts) ? step.hosts : []
      return list.map((host, index) => ({
        key: (host && (host.host || host.name)) ? String(host.host || host.name) : 'host-' + index,
        name: String((host && (host.host || host.name)) || '未知主机'),
        batch: Number(host && host.batch) > 0 ? Number(host.batch) : 1,
        ok: Boolean(host && host.ok),
        health: (host && host.health) || '',
        restarted: (host && host.restarted) || '',
        error: (host && host.error) || '',
        skipped: Boolean(host && host.skipped),
      }))
    }

    /** v0.6 A：`canary.batches[]` 里的成功/失败标记 → is-* 状态类。 */
    function batchTone(batch) {
      if (!batch) return 'pending'
      if (batch.ok === true) return 'success'
      if (batch.ok === false) return 'failed'
      return 'running'
    }

    /** v0.6 C：审计动作 → 中文；未知动作原样显示。 */
    function operationLabel(action) {
      return OPERATION_LABELS[action] || action || '未知动作'
    }

    /** Host 路由的错误：带 `code` 与可选 `line`，供 UI 给出中文解释。 */
    function ApiError(message, code, extra) {
      const error = new Error(message)
      error.name = 'ApiError'
      error.code = code || ''
      if (extra && extra.line) error.line = extra.line
      if (extra && extra.status) error.status = extra.status
      // v0.5 生产护栏：Host 会把受影响的生产主机放在错误体里，UI 要原样列出来。
      if (extra && Array.isArray(extra.hosts)) error.hosts = extra.hosts
      return error
    }

    function buildQuery(params) {
      const search = new URLSearchParams()
      Object.keys(params || {}).forEach((key) => {
        const value = params[key]
        if (value === undefined || value === null || value === '') return
        search.set(key, String(value))
      })
      const text = search.toString()
      return text ? '?' + text : ''
    }

    async function callApi(name, params, signal) {
      let response
      try {
        response = await fetch(API_BASE + '/' + name + buildQuery(params), {
          method: 'GET',
          headers: REQUEST_HEADERS,
          signal,
        })
      } catch (error) {
        if (error && error.name === 'AbortError') throw error
        throw ApiError('请求 Host 失败：' + ((error && error.message) || '网络错误'), 'NETWORK')
      }
      let payload = null
      try {
        payload = await response.json()
      } catch (error) {
        payload = null
      }
      if (!payload || typeof payload !== 'object') {
        throw ApiError('Host 返回了无法解析的响应（HTTP ' + response.status + '）', 'BAD_RESPONSE', {
          status: response.status,
        })
      }
      if (payload.ok !== true) {
        throw ApiError(payload.error || 'Host 拒绝了这次请求', payload.code, {
          line: payload.line,
          hosts: payload.hosts,
          status: response.status,
        })
      }
      return payload
    }

    function explainError(error) {
      if (!error) return ''
      const hint = CODE_HINTS[error.code]
      if (!hint) return ''
      if (error.code === 'PIPE_INVALID' && error.line) return 'pipe.yml 第 ' + error.line + ' 行：' + hint
      return hint
    }

    function StatusBadge({ status }) {
      const tone = STATUS_LABELS[status] ? status : 'queued'
      return h('span', { className: 'cicd-status is-' + tone, title: '状态：' + status }, STATUS_LABELS[status] || status || '未知')
    }

    function EmptyState({ text }) {
      return h('div', { className: 'cicd-empty' }, text)
    }

    function LoadingState({ text }) {
      return h('div', { className: 'cicd-loading' }, h('span', null, text || '正在加载…'))
    }

    function ErrorState({ error, onRetry }) {
      const hint = explainError(error)
      return h('div', { className: 'cicd-error', role: 'alert' },
        h('div', { className: 'cicd-error-message' }, (error && error.message) || '未知错误'),
        error && error.code
          ? h('div', { className: 'cicd-error-code cicd-mono' }, error.code + (error.line ? ' · 第 ' + error.line + ' 行' : ''))
          : null,
        hint ? h('div', { className: 'cicd-error-hint' }, hint) : null,
        onRetry ? h('button', { className: 'cicd-button cicd-error-retry', type: 'button', onClick: onRetry }, '重试') : null)
    }

    /** 计划 / 运行的 stage 与 step 树；`showCommand` 打开时逐条显示 `$ 命令`。 */
    function StageTree({ stages, showCommand }) {
      if (!Array.isArray(stages) || stages.length === 0) return null
      return h('div', { className: 'cicd-stages' },
        stages.map((stage, index) => {
          const stageKey = stage && stage.id ? stage.id : 'stage-' + index
          const steps = Array.isArray(stage && stage.steps) ? stage.steps : []
          return h('div', { className: 'cicd-stage', key: stageKey },
            h('div', { className: 'cicd-stage-head' },
              h('span', { className: 'cicd-stage-name' }, (stage && (stage.name || stage.id)) || '未命名阶段'),
              stage && stage.status ? h(StatusBadge, { status: stage.status }) : null),
            steps.length === 0
              ? h('p', { className: 'cicd-note' }, '这个阶段没有步骤。')
              : steps.map((step, stepIndex) => {
                const stepKey = stageKey + ':' + (step && step.index !== undefined ? step.index : stepIndex)
                const flags = []
                if (step && step.kind && step.kind !== 'run') flags.push(step.kind)
                if (step && step.when && step.when !== 'always') flags.push('when: ' + step.when)
                if (step && step.manual) flags.push('手动')
                return h('div', { className: 'cicd-step-wrap', key: stepKey },
                  h('div', { className: 'cicd-step' },
                    h('span', { className: 'cicd-step-index cicd-mono' }, String((step && step.index) !== undefined ? step.index : stepIndex).padStart(2, '0')),
                    h('span', { className: 'cicd-step-name' }, (step && (step.name || step.command)) || '未命名步骤'),
                    flags.length ? h('span', { className: 'cicd-step-flag' }, flags.join(' · ')) : null,
                    step && step.status ? h(StatusBadge, { status: step.status }) : null),
                  showCommand && step && step.command
                    ? h('code', { className: 'cicd-step-cmd cicd-mono' }, '$ ' + step.command)
                    : null)
              }))
        }))
    }

    /** 左列「阶段 / 目标」：项目列表 + 计划（阶段树）+ 目标矩阵。 */
    function OverviewColumn({ projects, projectId, projectMetas, onSelectProject, plan, onClosePlan, onPlanRetry, targets, targetName, onSelectTarget }) {
      return h('section', { className: 'cicd-col cicd-col-overview' },
        h('div', { className: 'cicd-col-head' },
          h('span', { className: 'cicd-col-title' }, '阶段 / 目标'),
          projectId ? h('span', { className: 'cicd-poll' }, projectId) : null),
        h('div', { className: 'cicd-col-body' },
          h('div', { className: 'cicd-section-title' }, '项目'),
          projects.status === 'loading' ? h(LoadingState, { text: '正在读取项目…' }) : null,
          projects.status === 'error' ? h(ErrorState, { error: projects.error, onRetry: projects.retry }) : null,
          projects.status === 'ready' && projects.items.length === 0
            ? h(EmptyState, { text: '还没有项目：先在目标机器上放一个 pipe.yml，再点刷新。' })
            : null,
          projects.status === 'ready' && projects.items.length > 0
            ? projects.items.map((project) => {
              const git = projectGitMeta(projectMetas && projectMetas[project.id])
              return h('div', { key: project.id },
                h('button', {
                  className: 'cicd-target-row' + (project.id === projectId ? ' is-active' : ''),
                  type: 'button',
                  onClick: () => onSelectProject(project.id),
                  title: project.path,
                },
                h('span', { className: 'cicd-target-name' }, project.name || project.id),
                h('span', { className: 'cicd-target-meta' }, projectHasPipe(project) ? projectPipePath(project) : '缺少 pipe.yml：' + (project.error || '文件不存在')),
                git.text
                  ? h('span', { className: 'cicd-project-git' + (git.dirty ? ' is-dirty' : ''), title: 'git：' + git.text }, git.text)
                  : null,
                projectHasPipe(project)
                  ? null
                  : h('p', { className: 'cicd-note' }, '这个项目没有可用的 pipe.yml，计划与运行都会被拒绝。')))
            })
            : null,
          h('div', { className: 'cicd-section-title', style: { marginTop: '4px' } }, '阶段'),
          plan
            ? h('div', { className: 'cicd-plan' },
              h('div', { className: 'cicd-plan-head' },
                h('span', { className: 'cicd-plan-title' },
                  '计划 · ' + (plan.target || '') + (plan.data && plan.data.name ? ' · ' + plan.data.name : '')),
                h('button', { className: 'cicd-button cicd-plan-close', type: 'button', onClick: onClosePlan }, '收起')),
              plan.status === 'loading' ? h(LoadingState, { text: '正在读取计划…' }) : null,
              plan.status === 'error' ? h(ErrorState, { error: plan.error, onRetry: onPlanRetry }) : null,
              plan.status === 'ready'
                ? (plan.data && Array.isArray(plan.data.stages) && plan.data.stages.length > 0
                  ? h(StageTree, { stages: plan.data.stages, showCommand: true })
                  : h(EmptyState, { text: 'pipe.yml 里没有可执行的阶段。' }))
                : null)
            : h('p', { className: 'cicd-note' }, '点工具条的「计划」预览这次会执行的阶段与步骤。'),
          h('div', { className: 'cicd-section-title', style: { marginTop: '4px' } }, '目标'),
          h(TargetsMatrix, { state: targets, targetName, onSelectTarget })))
    }

    /** 目标矩阵：每个 target 一张卡；hosts 逐台 chip（状态点）、current、keep、runtime 徽标。 */
    function TargetsMatrix({ state, targetName, onSelectTarget }) {
      return h('div', { className: 'cicd-targets' },
        state.status === 'loading' ? h(LoadingState, { text: '正在读取目标…' }) : null,
        state.status === 'error' ? h(ErrorState, { error: state.error, onRetry: state.retry }) : null,
        state.status === 'ready' && state.items.length === 0
          ? h(EmptyState, { text: '这个项目没有配置 targets：在 pipe.yml 里加 targets。' })
          : null,
        state.status === 'ready' && state.items.length > 0
          ? state.items.map((target) => {
            const hosts = Array.isArray(target.hosts) ? target.hosts : (target.hosts ? [target.hosts] : [])
            const runtime = (target && target.runtime) || 'static'
            // v0.5：Host 会把 env:/group:/tag: 选择器展开成具体别名，并标出哪些别名是生产主机。
            const envs = Array.isArray(target.envs) ? target.envs.filter((name) => typeof name === 'string' && name) : []
            const prodHosts = Array.isArray(target.prodHosts) ? target.prodHosts.filter((name) => typeof name === 'string' && name) : []
            // v0.6：灰度分批发布（pipe.yml 里 target.canary = first / waitSec）。
            const canary = canaryOf(target)
            const active = target.name === targetName
            const cardTitle = target.name + ' · ' + (hosts.join(', ') || '无主机') + (target.current ? ' · current ' + target.current : '')
            return h('button', {
              key: target.name,
              className: 'cicd-target-row cicd-target-card' + (active ? ' is-active' : ''),
              type: 'button',
              onClick: () => onSelectTarget(target.name),
              title: cardTitle,
            },
            h('span', { className: 'cicd-target-card-head' },
              h('span', { className: 'cicd-target-name' }, target.name),
              h('span', { className: 'cicd-target-runtime' }, runtime)),
            canary
              ? h('span', {
                className: 'cicd-target-canary',
                title: '灰度发布：先发 ' + canary.first + ' 台，等待 ' + canary.waitSec + 's 再发其余主机',
              }, canaryText(canary, hosts.length))
              : null,
            target.strategy
              ? h('span', { className: 'cicd-target-strategy', title: '发布策略：' + (target.strategy.type || 'serial') }, '策略 ' + (target.strategy.type || 'serial'))
              : null,
            hosts.length > 0
              ? h('span', { className: 'cicd-target-hosts' },
                h('span', { className: 'cicd-host-count', title: hosts.length + ' 台主机' }, hosts.length + ' 台'),
                hosts.map((host, hostIndex) => {
                  const hostName = typeof host === 'string' ? host : String((host && (host.name || host.host)) || '')
                  const hostStatus = host && typeof host === 'object' && typeof host.status === 'string' ? host.status : ''
                  const isProd = prodHosts.includes(hostName)
                  return h('span', { key: hostName + ':' + hostIndex, className: 'cicd-host-chip' + (isProd ? ' is-prod' : ''), title: hostName + (isProd ? '（生产）' : '') },
                    h('span', { className: 'cicd-host-dot' + (hostStatus ? ' is-' + hostStatus : '') }),
                    h('span', { className: 'cicd-host-name' }, hostName),
                    isProd ? h('span', { className: 'cicd-host-prod-icon', title: '生产主机' }, '🔒') : null)
                }))
              : null,
            prodHosts.length > 0 || envs.length > 0 || target.envsUnknown
              ? h('span', { className: 'cicd-target-envs' },
                prodHosts.length > 0
                  ? h('span', { className: 'cicd-env-chip is-prod', title: '生产主机：' + prodHosts.join('、') }, '生产 ' + prodHosts.length)
                  : null,
                envs.filter((name) => name !== 'prod').map((name) => h('span', { key: name, className: 'cicd-env-chip' }, name)),
                target.envsUnknown
                  ? h('span', { className: 'cicd-env-chip', title: 'Host 暂时读不到主机环境标签（dsh-remote 未就绪或没配 env）' }, '环境未知')
                  : null)
              : null,
            h('span', { className: 'cicd-target-meta' }, [target.mode, target.path, target.service].filter(Boolean).join(' · ')),
            target.current ? h('span', { className: 'cicd-target-current cicd-mono' }, '当前 ' + shortId(target.current, 14)) : null,
            typeof target.keep === 'number' ? h('span', { className: 'cicd-target-keep' }, '保留 ' + target.keep + ' 份') : null,
            target.health ? h('span', { className: 'cicd-target-health' }, '健康检查：' + target.health) : null)
          })
          : null)
    }

    /** 中列「Run 详情」：上方运行记录（选择器），下方选中运行的 steps 时间线与日志。 */
    function RunsDetailColumn({ runs, onRefreshRuns, selectedRunId, onSelectRun, run, stages, canary, jobs, logState, onReloadLog, highlightLine, logJobId, onSelectJob }) {
      // v0.6 A：灰度信息只在「刚跑完的这次 run」的返回里，历史运行没有；批次行来自 canary.batches。
      const batches = canary && Array.isArray(canary.batches) ? canary.batches.filter(Boolean) : []
      const firstDone = batches.some((batch) => Number(batch.index) === 1 && batch.ok === true)
      const hostTotal = (Array.isArray(stages) ? stages : [])
        .flatMap((stage) => (Array.isArray(stage && stage.steps) ? stage.steps : []))
        .flatMap((step) => (Array.isArray(step && step.hosts) ? step.hosts : [])).length
      const canaryFirst = canary && Number(canary.first) > 0 ? Number(canary.first) : 0
      const canaryWait = canary && Number(canary.waitSec) > 0 ? Number(canary.waitSec) : 0
      const remaining = hostTotal > canaryFirst ? hostTotal - canaryFirst : 0
      const hold = Boolean(run && run.status === 'running' && canaryFirst > 0 && firstDone)
      // v3.0-P1：job 行有两个来源（见 runJobsOf），合并后既供时间线分层，也供日志区下拉。
      const jobRows = runJobsOf(jobs, logState && logState.jobs)
      return h('section', { className: 'cicd-col cicd-col-detail' },
        h('div', { className: 'cicd-col-head' },
          h('span', { className: 'cicd-col-title' }, run ? 'Run 详情 · ' + shortId(run.id, 20) : 'Run 详情'),
          run ? h(StatusBadge, { status: run.status }) : null),
        h('div', { className: 'cicd-col-body' },
          h('div', { className: 'cicd-runs' },
            h('div', { className: 'cicd-runs-head' },
              h('span', null, '运行记录' + (runs.items.length ? '（' + runs.items.length + '）' : ''))),
            runs.status === 'loading' && runs.items.length === 0 ? h(LoadingState, { text: '正在读取运行记录…' }) : null,
            runs.status === 'error' ? h(ErrorState, { error: runs.error, onRetry: onRefreshRuns }) : null,
            runs.status !== 'error' && runs.items.length === 0 && runs.status !== 'loading'
              ? h(EmptyState, { text: '还没有运行记录：点工具条「运行」或「干跑」开始一次。' })
              : null,
            runs.items.map((row) => h('button', {
              key: row.id,
              className: 'cicd-run-row' + (STATUS_LABELS[row.status] ? ' is-' + row.status : '') + (row.id === selectedRunId ? ' is-active' : ''),
              type: 'button',
              onClick: () => onSelectRun(row.id),
              title: row.id,
            },
            h('div', { className: 'cicd-run-row-head' },
              h('span', { className: 'cicd-run-id cicd-mono' }, shortId(row.id, 16)),
              h(StatusBadge, { status: row.status })),
            h('div', { className: 'cicd-run-meta' },
              [row.target, formatTime(row.startedAt), row.dryRun ? '干跑' : '', formatDuration(runDurationMs(row))]
                .filter(Boolean).join(' · ')),
            row.error ? h('div', { className: 'cicd-run-error' }, row.error) : null))),
          run
            ? h('div', { className: 'cicd-detail' },
              h('dl', { className: 'cicd-detail-meta' },
                h('dt', null, '目标'), h('dd', null, run.target || '—'),
                h('dt', null, '开始'), h('dd', null, formatTime(run.startedAt)),
                h('dt', null, '耗时'), h('dd', null, formatDuration(runDurationMs(run))),
                h('dt', null, '类型'), h('dd', null, run.dryRun ? '干跑（不执行真实命令）' : '真实运行')),
              run.error ? h('p', { className: 'cicd-detail-failure' }, '失败原因：' + run.error) : null,
              // v0.6 B：失败的运行结束后 Host 已按 notify.webhooks 推送过通知。
              run.status === 'failed' ? h('p', { className: 'cicd-notify-hint' }, '已按配置推送通知（webhooks 可在插件配置的 notify.webhooks 里改）。') : null,
              // v0.6 A：第一批成功后等候选窗口 → 明确告诉用户「还在等」。
              hold
                ? h('div', { className: 'cicd-canary-hold', role: 'status' },
                  '第一批 ' + canaryFirst + ' 台已成功，等待 ' + canaryWait + 's 后发剩余 ' + remaining + ' 台')
                : null,
              batches.length > 0
                ? h('div', { className: 'cicd-canary-batches' },
                  h('span', null, '灰度批次'),
                  batches.map((batch, index) => {
                    const tone = batchTone(batch)
                    const hostList = Array.isArray(batch.hosts) ? batch.hosts : []
                    return h('span', {
                      key: 'batch-' + (batch.index !== undefined ? batch.index : index),
                      className: 'cicd-canary-batch',
                      title: hostList.length > 0 ? hostList.join('、') : '',
                    },
                    h('span', { className: 'cicd-host-dot is-' + tone }),
                    h('span', null, '第 ' + (Number(batch.index) || index + 1) + ' 批 · ' + hostList.length + ' 台'))
                  }))
                : null,
              stages && stages.length > 0
                ? h('div', null,
                  h('div', { className: 'cicd-section-title' }, '步骤时间线'),
                  h(StepsTimeline, { stages, jobs: jobRows }))
                : h('p', { className: 'cicd-note' }, '运行列表只带状态与时间；这条运行是历史记录，Host 没有单独返回它的 step 明细，日志见下方。'),
              h(LogView, {
                runId: run.id,
                logState,
                onReloadLog,
                highlightLine,
                logJobId: logJobId || '',
                jobOptions: jobRows,
                onSelectJob,
              }))
            : h(EmptyState, { text: '在上方运行记录里选一条，这里显示 steps 时间线与日志。' })))
    }

    /**
     * 这次运行有哪些 job（v3.0-P1）。
     *
     * 两个来源：`/run` 的返回带完整 job 图（有状态、耗时、错误），历史运行只有 `/log` 返回的
     * 分片日志文件名清单（只有 id）。两者都归一成 `{id, status, ...}`，UI 不必分情况处理；
     * 状态缺失时按「未知」渲染，而不是假装成功。
     */
    function runJobsOf(jobGraph, jobLogs) {
      const fromGraph = jobGraph && Array.isArray(jobGraph.items) ? jobGraph.items : null
      if (fromGraph && fromGraph.length > 0) return fromGraph
      const listed = Array.isArray(jobLogs) ? jobLogs : []
      return listed.map((item) => ({ id: item.jobId || item.id || '', status: '', stage: '' }))
    }

    /** steps 时间线：stage 标题行 +（有 job 图时）job 行 + 每步一行（状态点 / 耗时 / 一行摘要）。 */
    function StepsTimeline({ stages, jobs }) {
      const rows = timelineRows(stages, jobs)
      if (rows.length === 0) return null
      return h('div', { className: 'cicd-timeline' },
        rows.map((row) => {
          if (row.kind === 'stage') {
            return h('div', { className: 'cicd-timeline-stage', key: row.key },
              h('span', null, (row.stage && (row.stage.name || row.stage.id)) || '未命名阶段'),
              row.stage && row.stage.status ? h(StatusBadge, { status: row.stage.status }) : null)
          }
          if (row.kind === 'job') {
            const job = row.job
            const jobMeta = job
              ? [job.kind && job.kind !== 'build' ? job.kind : '', typeof job.durationMs === 'number' ? '耗时 ' + formatDuration(job.durationMs) : '']
                .filter(Boolean).join(' · ')
              : '未归属任何 job'
            return h('div', { className: 'cicd-timeline-job', key: row.key, title: job && job.needs && job.needs.length ? '依赖：' + job.needs.join('、') : '' },
              h('span', { className: 'cicd-timeline-job-name cicd-mono' }, job ? shortId(job.id, 40) : '（未分组）'),
              jobMeta ? h('span', { className: 'cicd-timeline-job-meta' }, jobMeta) : null,
              job && job.status ? h(StatusBadge, { status: job.status }) : null)
          }
          const step = row.step
          const status = step && STATUS_LABELS[step.status] ? step.status : 'pending'
          const duration = step && typeof step.durationMs === 'number' ? formatDuration(step.durationMs) : ''
          const exit = step && typeof step.exitCode === 'number' && step.exitCode !== -1 ? 'exit ' + step.exitCode : ''
          const meta = [duration ? '耗时 ' + duration : '', exit].filter(Boolean).join(' · ')
          const summary = step && step.error
            ? step.error
            : step && step.command
              ? '$ ' + step.command
              : (step && step.kind && step.kind !== 'run' ? step.kind : '')
          const hosts = hostRowsOf(step)
          // v0.6 A：每台主机一行，标出它属于第几批（灰度时分批发布）。
          const hostRows = hosts.length > 0
            ? h('div', { className: 'cicd-host-rows' }, hosts.map((host) => {
              const tone = host.skipped ? 'skipped' : host.ok ? 'success' : host.error ? 'failed' : 'running'
              const tail = [host.health, host.error].filter(Boolean).join(' · ')
              return h('div', { className: 'cicd-host-row', key: host.key, title: host.name + (tail ? ' · ' + tail : '') },
                h('span', { className: 'cicd-host-dot is-' + tone }),
                h('span', { className: 'cicd-host-name' }, host.name),
                h('span', { className: 'cicd-host-batch' }, '第 ' + host.batch + ' 批'),
                tail ? h('span', { className: 'cicd-host-health' }, tail) : null)
            }))
            : null
          return h('div', { className: 'cicd-timeline-step-wrap', key: row.key },
            h('div', { className: 'cicd-timeline-step' },
              h('span', { className: 'cicd-timeline-dot is-' + status, title: '状态：' + ((step && step.status) || 'pending') }),
              h('span', { className: 'cicd-timeline-main' },
                h('span', { className: 'cicd-timeline-name' }, (step && (step.name || step.command)) || '未命名步骤'),
                meta ? h('span', { className: 'cicd-timeline-meta' }, meta) : null,
                summary ? h('span', { className: 'cicd-timeline-summary' + (step && step.status === 'failed' ? ' is-failed' : '') }, shortId(summary, 120)) : null)),
            hostRows)
        }))
    }

    /**
     * 日志区：跟随末尾（上滚暂停 / 点击恢复）+ 下载 + 重新读取。
     *
     * v3.0-P1：DSL v2 里一个 stage 的多个 job 是并行的，主日志是一份交错时间线；
     * `logJobId` 选某条分片时只显示那个 job 自己的输出。「全部」= 老行为。
     */
    function LogView({ runId, logState, onReloadLog, highlightLine, logJobId, jobOptions, onSelectJob }) {
      const logRef = useRef(null)
      const [follow, setFollow] = useState(true)
      const lines = Array.isArray(logState.lines) ? logState.lines : []
      const linesCount = lines.length
      const mark = Number(highlightLine) > 0 ? Number(highlightLine) : 0
      const jobId = logJobId || ''
      // 只有一个 job（或根本没分片）时下拉没有意义：唯一选项等于没有选择，还占一行工具条。
      const jobs = (Array.isArray(jobOptions) ? jobOptions : []).filter((job) => job && job.id)
      const showJobPicker = jobs.length > 1 && typeof onSelectJob === 'function'

      // 跟随中且新日志到达（或刚恢复跟随）时滚到末尾；用户上滚后不再打扰。
      useEffect(() => {
        if (!follow) return
        const node = logRef.current
        if (node) node.scrollTop = node.scrollHeight
      }, [follow, logState.lines])

      /**
       * v3.0-P0 深链定位：`#/projects/p/runs/<id>?line=1204` 打开时把那一行高亮并滚进视野。
       * 深链只说「第几行」而不是「第几条消息」——日志每次拉取都会变（tail 窗口滑动），
       * 行号是唯一在多次刷新间稳定的锚点。
       */
      useEffect(() => {
        if (!mark) return
        const node = logRef.current
        if (!node || typeof node.querySelector !== 'function') return
        const target = node.querySelector('[data-log-line="' + mark + '"]')
        if (!target) return
        setFollow(false)
        if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center' })
        else node.scrollTop = Math.max(0, target.offsetTop - node.clientHeight / 2)
      }, [mark, logState.lines])

      const onScroll = useCallback((event) => {
        const node = event && event.currentTarget
        if (!node || typeof node.scrollHeight !== 'number') return
        const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= 40
        setFollow(atBottom)
      }, [])

      const resumeFollow = useCallback(() => {
        setFollow(true)
        const node = logRef.current
        if (node) node.scrollTop = node.scrollHeight
      }, [])

      const onDownload = useCallback(() => {
        if (linesCount === 0) return
        try {
          const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = (runId || 'run') + (jobId ? '-' + jobId.replace(/[^A-Za-z0-9_.-]+/g, '_') : '') + '.log'
          if (document.body && typeof document.body.appendChild === 'function') {
            document.body.appendChild(anchor)
            anchor.click()
            anchor.remove()
          }
          setTimeout(() => URL.revokeObjectURL(url), 1000)
        } catch (error) {
          // 环境不支持 Blob / DOM 下载时静默：日志仍可在线查看。
        }
      }, [lines, linesCount, runId, jobId])

      return h('div', { className: 'cicd-log-section' },
        h('div', { className: 'cicd-section-title' },
          h('span', { className: 'cicd-log-tools' },
            showJobPicker
              ? h('select', {
                className: 'cicd-select cicd-log-job-select',
                value: jobId || '',
                onChange: (event) => onSelectJob(event.currentTarget.value),
                'aria-label': '只看某个 job 的日志',
                title: '并行 job 的日志在主时间线里是交错的；选一个 job 只看它自己的输出',
              },
              h('option', { value: '' }, '全部 job（合并时间线）'),
              jobs.map((job) => h('option', { key: job.id, value: job.id }, job.id)))
              : null,
            h('button', {
              className: 'cicd-button cicd-log-follow',
              type: 'button',
              'aria-pressed': follow,
              onClick: resumeFollow,
              title: follow ? '新日志到达时自动滚到末尾；上滚会暂停' : '已暂停跟随：点击恢复滚动到末尾',
            }, follow ? '跟随末尾' : '恢复跟随'),
            h('button', { className: 'cicd-button cicd-log-download', type: 'button', onClick: onDownload, disabled: linesCount === 0 }, '下载日志'),
            h('button', { className: 'cicd-button', type: 'button', onClick: onReloadLog, disabled: logState.status === 'loading' }, logState.status === 'loading' ? '读取…中' : '重新读取')),
          h('span', null, jobId
            ? '仅 ' + shortId(jobId, 28) + ' · ' + linesCount + ' 行'
            : '日志 tail（' + linesCount + ' 行）')),
        logState.status === 'error'
          ? h(ErrorState, {
            error: logState.error,
            // 读某个 job 的分片失败时，「重试」重试的是同一个坏名字；这时用户真正需要的是回合并时间线。
            onRetry: jobId && typeof onSelectJob === 'function' ? () => onSelectJob('') : onReloadLog,
          })
          : linesCount === 0
            ? h(EmptyState, { text: '这个运行还没有日志输出。' })
            : h('div', { className: 'cicd-log', ref: logRef, onScroll },
              lines.map((line, index) => h('p', {
                className: 'cicd-log-line cicd-mono' + (mark === index + 1 ? ' is-highlight' : ''),
                key: index,
                'data-log-line': index + 1,
              }, line))))
    }

    /** 发布记录表格（列：版本 / 目标 / 主机 / 部署时间 / 状态 / 操作），整页视图与右列共用。 */
    function ReleaseTable({ items, rollbackId, onRollback, busy }) {
      return h('div', { className: 'cicd-table-wrap' },
        h('table', { className: 'cicd-table' },
          h('thead', null, h('tr', null,
            ['版本', '目标', '主机', '部署时间', '状态', '操作']
              .map((label) => h('th', { key: label }, label)))),
          h('tbody', null, items.map((release) => {
            const active = Boolean(release.activatedAt) || release.status === 'active'
            const armed = rollbackId === release.id
            return h('tr', { key: release.id, className: 'cicd-release-row' + (active ? ' is-active' : '') },
              h('td', { className: 'cicd-release-cell cicd-release-id cicd-mono', title: release.id }, shortId(release.id, 24)),
              h('td', { className: 'cicd-release-cell' }, release.target || '—'),
              h('td', { className: 'cicd-release-cell' },
                release.host || '—',
                release.env ? h('span', { className: 'cicd-release-env', title: '部署环境：' + release.env }, release.env) : null),
              h('td', { className: 'cicd-release-cell' }, formatTime(release.createdAt)),
              h('td', { className: 'cicd-release-cell' }, active
                ? h('span', { className: 'cicd-status is-success' }, '已激活')
                : h('span', { className: 'cicd-status' }, STATUS_LABELS[release.status] || release.status || '历史版本')),
              h('td', { className: 'cicd-release-cell cicd-release-act' },
                h('button', {
                  className: 'cicd-rollback' + (armed ? ' is-armed' : ''),
                  type: 'button',
                  onClick: () => onRollback(release),
                  disabled: Boolean(busy),
                  title: armed ? '再点一次确认回滚到这个版本' : '把 current 切回这个版本',
                }, busy ? '回滚…中' : armed ? '确认回滚' : '回滚到此版本')))
          }))))
    }

    /** 「发布」整页视图（工具条开关切换）。 */
    function ReleasesView({ state, targetName, onRefresh, rollbackId, onRollback, busy }) {
      return h('div', { className: 'cicd-releases' },
        h('div', { className: 'cicd-releases-head' },
          h('span', { className: 'cicd-col-title' }, '发布记录' + (targetName ? ' · ' + targetName : '')),
          h('button', { className: 'cicd-button', type: 'button', onClick: onRefresh, disabled: state.status === 'loading' }, state.status === 'loading' ? '刷新…中' : '刷新')),
        state.status === 'loading' ? h(LoadingState, { text: '正在读取发布记录…' }) : null,
        state.status === 'error' ? h(ErrorState, { error: state.error, onRetry: onRefresh }) : null,
        state.status !== 'error' && state.items.length === 0 && state.status !== 'loading'
          ? h(EmptyState, { text: '还没有发布记录：先运行一次带部署的流水线。' })
          : null,
        state.items.length > 0
          ? h(ReleaseTable, { items: state.items, rollbackId, onRollback, busy })
          : null)
    }

    /** 右列「Releases」：三列布局里的发布记录（窄屏时叠到详情下方）。 */
    function ReleasesColumn({ state, targetName, onRefresh, rollbackId, onRollback, busy }) {
      return h('section', { className: 'cicd-col cicd-col-releases' },
        h('div', { className: 'cicd-col-head' },
          h('span', { className: 'cicd-col-title' }, 'Releases' + (targetName ? ' · ' + targetName : '')),
          h('button', {
            className: 'cicd-button cicd-releases-refresh',
            type: 'button',
            onClick: onRefresh,
            disabled: state.status === 'loading' || !targetName,
          }, state.status === 'loading' ? '刷新…中' : '刷新')),
        h('div', { className: 'cicd-col-body' },
          state.status === 'loading' && state.items.length === 0 ? h(LoadingState, { text: '正在读取发布记录…' }) : null,
          state.status === 'error' ? h(ErrorState, { error: state.error, onRetry: onRefresh }) : null,
          state.status !== 'error' && state.items.length === 0 && state.status !== 'loading'
            ? h(EmptyState, { text: '还没有发布记录：运行一次带部署的流水线后，这里会列出可回滚的版本。' })
            : null,
          state.items.length > 0
            ? h(ReleaseTable, { items: state.items, rollbackId, onRollback, busy })
            : null))
    }

    /** v0.6 C：审计时间线（整页视图）：时间 / 动作 / 目标 / 主机 / 版本 / 状态。 */
    function AuditView({ state, limit, onLimit, onRefresh }) {
      const items = Array.isArray(state.items) ? state.items : []
      const unsupported = Boolean(state.unsupported)
      const loading = state.status === 'loading'
      return h('div', { className: 'cicd-audit' },
        h('div', { className: 'cicd-audit-head' },
          h('span', { className: 'cicd-col-title' }, '操作审计' + (items.length > 0 ? '（' + items.length + '）' : '')),
          h('select', {
            className: 'cicd-select cicd-audit-limit',
            value: String(limit),
            onChange: (event) => onLimit(Number(event.currentTarget.value) || AUDIT_DEFAULT_LIMIT),
            'aria-label': '审计条数',
          }, AUDIT_LIMITS.map((value) => h('option', { key: value, value: String(value) }, '最近 ' + value + ' 条'))),
          h('button', {
            className: 'cicd-button cicd-audit-refresh',
            type: 'button',
            onClick: onRefresh,
            disabled: loading,
          }, loading ? '刷新…中' : '刷新')),
        // 旧 Host 没有 /operations：这不是错误，只是还没升级。
        unsupported ? h(EmptyState, { text: 'Host 还不支持审计（升级到 v0.6 后可用）' }) : null,
        !unsupported && loading ? h(LoadingState, { text: '正在读取操作记录…' }) : null,
        !unsupported && state.status === 'error' ? h(ErrorState, { error: state.error, onRetry: onRefresh }) : null,
        !unsupported && !loading && state.status !== 'error' && items.length === 0
          ? h(EmptyState, { text: '还没有操作记录' })
          : null,
        items.length > 0
          ? h('div', { className: 'cicd-table-wrap' },
            h('table', { className: 'cicd-table cicd-audit-table' },
              h('thead', null, h('tr', null,
                ['时间', '动作', '目标', '主机', '版本', '状态'].map((label) => h('th', { key: label }, label)))),
              h('tbody', null, items.map((operation, index) => {
                const action = (operation && operation.action) || ''
                const tone = OPERATION_TONES[action] || ''
                const status = operation && operation.status ? String(operation.status) : ''
                const detail = operation && operation.detail ? String(operation.detail) : ''
                return h('tr', {
                  key: (operation && operation.id !== undefined ? 'op-' + operation.id : 'op-' + index),
                  className: 'cicd-audit-row' + (tone ? ' is-' + action : ''),
                  title: [operation && operation.runId ? 'run ' + operation.runId : '', detail].filter(Boolean).join(' · '),
                  'data-dsh-cicd-action': action,
                },
                h('td', { className: 'cicd-audit-cell cicd-audit-time cicd-mono' }, formatTime(operation && operation.at)),
                h('td', { className: 'cicd-audit-cell' },
                  h('span', { className: 'cicd-audit-action' + (tone ? ' is-' + action : '') }, operationLabel(action))),
                h('td', { className: 'cicd-audit-cell cicd-audit-target' }, (operation && operation.target) || '—'),
                h('td', { className: 'cicd-audit-cell cicd-audit-host' }, (operation && operation.host) || '—'),
                h('td', { className: 'cicd-audit-cell cicd-audit-release cicd-mono' }, operation && operation.releaseId ? shortId(operation.releaseId, 20) : '—'),
                h('td', { className: 'cicd-audit-cell' }, status
                  ? h('span', { className: 'cicd-status is-' + (STATUS_LABELS[status] ? status : 'queued') }, STATUS_LABELS[status] || status)
                  : '—'))
              }))))
          : null)
    }

    /** v2-M0：pipe.yml 校验 / 保存的结果（成功显示 name/version/targets/stages，失败显示错误码与行号）。 */
    function PipeValidateResult({ state }) {
      if (!state || state.status === 'loading') return null
      if (state.status === 'error') {
        const error = state.error
        return h('p', { className: 'cicd-editor-result is-error', role: 'alert' },
          (error && error.message) || '校验失败',
          error && error.code ? ' · ' + error.code : '',
          error && error.line ? ' · 第 ' + error.line + ' 行' : '')
      }
      const data = state.data || {}
      const targets = Array.isArray(data.targets) ? data.targets : []
      const stages = Array.isArray(data.stages) ? data.stages : []
      return h('p', { className: 'cicd-editor-result', role: 'status' },
        '校验通过 · ' + (data.name || '未命名') +
        (data.version ? ' · version ' + data.version : '') +
        ' · ' + targets.length + ' 个目标 · ' + stages.length + ' 个阶段')
    }

    /** v2-M0：pipe.yml 编辑器视图。 */
    function EditorView({ editor, editorValidate, editorSave, projectId, busy, hasTarget, onReload, onChange, onValidate, onSave, onDryRun }) {
      const loading = editor.status === 'loading'
      const source = editor.source || ''
      return h('div', { className: 'cicd-editor' },
        h('div', { className: 'cicd-editor-head' },
          h('span', { className: 'cicd-col-title' }, '编辑器' + (projectId ? ' · ' + projectId : '')),
          h('span', { className: 'cicd-editor-meta' },
            editor.dirty ? h('span', { className: 'cicd-status is-running' }, '未保存') : null,
            h('button', { className: 'cicd-button', type: 'button', onClick: onReload, disabled: loading || busy }, loading ? '读取…中' : '重新读取'))),
        editor.status === 'error' ? h(ErrorState, { error: editor.error, onRetry: onReload }) : null,
        loading ? h(LoadingState, { text: '正在读取 pipe.yml…' }) : null,
        editor.status !== 'error' && !loading
          ? h('div', { className: 'cicd-editor-body' },
            h('textarea', {
              className: 'cicd-editor-textarea',
              value: source,
              onChange: (event) => onChange(event.currentTarget.value),
              spellCheck: false,
              'aria-label': 'pipe.yml 源码',
              placeholder: '在这里编辑 pipe.yml…',
            }),
            h('div', { className: 'cicd-editor-actions' },
              h('button', { className: 'cicd-button', type: 'button', onClick: onValidate, disabled: busy || loading }, '校验'),
              h('button', { className: 'cicd-button cicd-button-primary', type: 'button', onClick: onSave, disabled: busy || loading || !editor.dirty }, '保存'),
              h('button', { className: 'cicd-button cicd-dry-run', type: 'button', onClick: onDryRun, disabled: busy || !hasTarget, title: hasTarget ? '用上方选中的目标做一次干跑' : '先在上方选择目标' }, '干跑')),
            editorSave && editorSave.status === 'done'
              ? h('span', { className: 'cicd-editor-status is-ok', role: 'status' }, editorSave.message)
              : null,
            editorSave && editorSave.status === 'error'
              ? h('span', { className: 'cicd-editor-status is-error', role: 'alert' }, editorSave.message)
              : null,
            h(PipeValidateResult, { state: editorValidate }))
          : null)
    }

    /** v2-M0：新建项目向导（来源二选一 + 脚手架模板）。 */
    function CreateView({ state, busy, onSubmit }) {
      const [sourceType, setSourceType] = useState('local')
      const [name, setName] = useState('')
      const [path, setPath] = useState('')
      const [repoUrl, setRepoUrl] = useState('')
      const [branch, setBranch] = useState('')
      const [kind, setKind] = useState('static')

      const canSubmit = sourceType === 'local'
        ? (name.trim() !== '' || path.trim() !== '')
        : repoUrl.trim() !== ''

      const submit = useCallback(() => {
        onSubmit({ sourceType, name: name.trim(), path: path.trim(), repoUrl: repoUrl.trim(), branch: branch.trim(), kind })
      }, [sourceType, name, path, repoUrl, branch, kind, onSubmit])

      return h('div', { className: 'cicd-create' },
        h('div', { className: 'cicd-create-form' },
          h('div', { className: 'cicd-section-title' }, '新建项目'),
          h('div', { className: 'cicd-form-field' },
            h('span', { className: 'cicd-form-label' }, '来源'),
            h('div', { className: 'cicd-form-radio-group' },
              h('button', { className: 'cicd-form-radio', type: 'button', 'aria-pressed': sourceType === 'local', onClick: () => setSourceType('local') }, '本地目录'),
              h('button', { className: 'cicd-form-radio', type: 'button', 'aria-pressed': sourceType === 'git', onClick: () => setSourceType('git') }, 'Git 仓库'))),
          h('div', { className: 'cicd-form-field' },
            h('span', { className: 'cicd-form-label' }, '项目名'),
            h('input', { className: 'cicd-form-input', value: name, onChange: (event) => setName(event.currentTarget.value), placeholder: '例如 my-app（缺省用目录名 / 仓库名）' })),
          sourceType === 'local'
            ? h('div', { className: 'cicd-form-field' },
              h('span', { className: 'cicd-form-label' }, '本地目录'),
              h('input', { className: 'cicd-form-input', value: path, onChange: (event) => setPath(event.currentTarget.value), placeholder: '例如 D:/work/my-app（会在这里生成 pipe.yml）' }),
              h('p', { className: 'cicd-form-hint' }, '目录不存在会自动创建；已登记过的目录也可以重新选。'))
            : h('div', { className: 'cicd-form-field' },
              h('span', { className: 'cicd-form-label' }, 'Git 仓库地址'),
              h('input', { className: 'cicd-form-input', value: repoUrl, onChange: (event) => setRepoUrl(event.currentTarget.value), placeholder: 'git@github.com:you/repo.git 或 https://…' }),
              h('span', { className: 'cicd-form-label', style: { marginTop: '6px' } }, '分支（可选）'),
              h('input', { className: 'cicd-form-input', value: branch, onChange: (event) => setBranch(event.currentTarget.value), placeholder: '缺省用仓库默认分支' })),
          h('div', { className: 'cicd-form-field' },
            h('span', { className: 'cicd-form-label' }, '脚手架模板'),
            h('div', { className: 'cicd-create-kinds' },
              SCAFFOLD_KINDS.map((item) => h('button', {
                key: item.id,
                className: 'cicd-form-radio',
                type: 'button',
                'aria-pressed': kind === item.id,
                onClick: () => setKind(item.id),
                title: item.description || '',
              }, item.name)))),
          h('div', { className: 'cicd-create-actions' },
            h('button', { className: 'cicd-button cicd-button-primary', type: 'button', onClick: submit, disabled: busy || !canSubmit }, busy ? '创建…中' : '创建并登记'),
            state.status === 'done' && state.result
              ? h('span', { className: 'cicd-editor-status is-ok', role: 'status' }, '已创建 ' + (state.result.name || state.result.id))
              : null,
            state.status === 'error' && state.error
              ? h('span', { className: 'cicd-editor-status is-error', role: 'alert' }, (state.error.message || '创建失败'))
              : null),
          state.status === 'error' && state.error && state.error.code
            ? h('p', { className: 'cicd-editor-result is-error' }, state.error.code + (state.error.line ? ' · 第 ' + state.error.line + ' 行' : ''))
            : null))
    }

    /** P1：审批门视图（列出待审批 run + 通过/拒绝按钮）。 */
    function ApprovalsView({ state, onRefresh, onApprove, onReject, busy }) {
      const items = Array.isArray(state.items) ? state.items : []
      const pending = items.filter((item) => item.status === 'pending' || !item.status)
      const resolved = items.filter((item) => item.status && item.status !== 'pending')
      return h('div', { className: 'cicd-approvals' },
        h('div', { className: 'cicd-approvals-head' },
          h('span', { className: 'cicd-col-title' }, '审批门 · ' + pending.length + ' 条待审批'),
          h('button', { className: 'cicd-button', type: 'button', onClick: onRefresh, disabled: state.status === 'loading' }, state.status === 'loading' ? '刷新…中' : '刷新')),
        state.status === 'loading' ? h(LoadingState, { text: '正在读取审批记录…' }) : null,
        state.status === 'error' ? h(ErrorState, { error: state.error, onRetry: onRefresh }) : null,
        state.status === 'ready' && pending.length === 0
          ? h(EmptyState, { text: '没有待审批的部署。prod 环境默认停在「待审批」，点「运行」后在这里通过或拒绝。' })
          : null,
        pending.length > 0
          ? h('div', { className: 'cicd-approvals-list' },
            pending.map((item) => h('div', { key: item.runId, className: 'cicd-approval-row' },
              h('div', { className: 'cicd-approval-info' },
                h('span', { className: 'cicd-approval-runid cicd-mono' }, item.runId),
                h('span', { className: 'cicd-approval-meta' }, [item.project, item.target, item.requestedAt, item.requestedBy].filter(Boolean).join(' · '))),
              h('div', { className: 'cicd-approval-actions' },
                h('button', { className: 'cicd-button cicd-button-primary', type: 'button', onClick: () => onApprove(item.runId), disabled: busy }, '通过'),
                h('button', { className: 'cicd-button cicd-button-danger', type: 'button', onClick: () => onReject(item.runId), disabled: busy }, '拒绝')))))
          : null,
        resolved.length > 0
          ? h('div', { className: 'cicd-approvals-resolved' },
            h('div', { className: 'cicd-section-title' }, '已处理（最近 ' + Math.min(resolved.length, 10) + ' 条）'),
            resolved.slice(0, 10).reverse().map((item) => h('div', { key: item.runId + item.status, className: 'cicd-approval-row is-resolved' },
              h('div', { className: 'cicd-approval-info' },
                h('span', { className: 'cicd-approval-runid cicd-mono' }, item.runId),
                h('span', { className: 'cicd-approval-meta' }, [item.project, item.target, item.status, item.resolvedAt].filter(Boolean).join(' · '))))))
          : null)
    }

    /** P1：RBAC 管理视图（用户列表 + 校验 token + 审计时间线）。 */
    function RbacView({ state, onRefresh, onRevoke, onVerify, busy }) {
      const [tokenInput, setTokenInput] = useState('')
      const users = Array.isArray(state.users) ? state.users : []
      const audit = Array.isArray(state.audit) ? state.audit : []
      return h('div', { className: 'cicd-rbac' },
        h('div', { className: 'cicd-rbac-head' },
          h('span', { className: 'cicd-col-title' }, 'RBAC · ' + users.length + ' 个用户'),
          h('button', { className: 'cicd-button', type: 'button', onClick: onRefresh, disabled: state.status === 'loading' }, state.status === 'loading' ? '刷新…中' : '刷新')),
        state.status === 'loading' ? h(LoadingState, { text: '正在读取 RBAC…' }) : null,
        state.status === 'error' ? h(ErrorState, { error: state.error, onRetry: onRefresh }) : null,
        state.status === 'ready'
          ? h('div', { className: 'cicd-rbac-body' },
            h('div', { className: 'cicd-section-title' }, '用户'),
            users.length === 0
              ? h(EmptyState, { text: '还没有用户。用 cicd_rbac 工具签发 token（user / role / projects / ttlSec）。' })
              : h('div', { className: 'cicd-table-wrap' },
                h('table', { className: 'cicd-table' },
                  h('thead', null, h('tr', null,
                    h('th', null, '用户'), h('th', null, '角色'), h('th', null, '项目范围'), h('th', null, '过期时间'), h('th', { className: 'cicd-release-act' }, '操作'))),
                  h('tbody', null, users.map((user) => h('tr', { key: user.user },
                    h('td', null, user.user),
                    h('td', null, user.role),
                    h('td', null, (user.projects || []).join(', ') || '*'),
                    h('td', null, user.expiresAt || '—'),
                    h('td', { className: 'cicd-release-act' },
                      h('button', { className: 'cicd-rollback', type: 'button', onClick: () => onRevoke(user.user), disabled: busy }, '吊销'))))))),
            h('div', { className: 'cicd-section-title', style: { marginTop: '12px' } }, '校验 token'),
            h('div', { className: 'cicd-rbac-verify' },
              h('input', { className: 'cicd-form-input', value: tokenInput, onChange: (event) => setTokenInput(event.currentTarget.value), placeholder: '粘贴 token 校验' }),
              h('button', { className: 'cicd-button', type: 'button', onClick: () => onVerify(tokenInput.trim()), disabled: !tokenInput.trim() || busy }, '校验')),
            state.verifyResult && state.verifyResult.status === 'ready'
              ? h('span', { className: 'cicd-editor-status is-ok' }, '校验结果：' + state.verifyResult.message)
              : null,
            state.verifyResult && state.verifyResult.status === 'error'
              ? h('span', { className: 'cicd-editor-status is-error' }, '校验失败：' + state.verifyResult.message)
              : null,
            audit.length > 0
              ? h('div', { className: 'cicd-rbac-audit' },
                h('div', { className: 'cicd-section-title', style: { marginTop: '12px' } }, '审计（最近 ' + Math.min(audit.length, 20) + ' 条）'),
                h('div', { className: 'cicd-table-wrap' },
                  h('table', { className: 'cicd-table' },
                    h('thead', null, h('tr', null,
                      h('th', null, '时间'), h('th', null, '用户'), h('th', null, '操作'), h('th', null, '项目'), h('th', null, '状态'))),
                    h('tbody', null, audit.slice(-20).reverse().map((item, index) => h('tr', { key: item.at + index },
                      h('td', null, item.at), h('td', null, item.user), h('td', null, item.action), h('td', null, item.project || '—'), h('td', null, item.status)))))))
              : null)
          : null)
    }

    /** P1：Secrets 管理视图（列出 + 设置 secret）。 */
    function SecretsView({ state, project, onRefresh, onSet, busy }) {
      const [scope, setScope] = useState('global')
      const [name, setName] = useState('')
      const [value, setValue] = useState('')
      const items = Array.isArray(state.items) ? state.items : []
      return h('div', { className: 'cicd-secrets' },
        h('div', { className: 'cicd-secrets-head' },
          h('span', { className: 'cicd-col-title' }, 'Secrets · ' + (project || '全局') + ' · ' + items.length + ' 条'),
          h('button', { className: 'cicd-button', type: 'button', onClick: onRefresh, disabled: state.status === 'loading' }, state.status === 'loading' ? '刷新…中' : '刷新')),
        state.status === 'loading' ? h(LoadingState, { text: '正在读取 secrets…' }) : null,
        state.status === 'error' ? h(ErrorState, { error: state.error, onRetry: onRefresh }) : null,
        state.status === 'ready'
          ? h('div', { className: 'cicd-secrets-body' },
            items.length === 0
              ? h(EmptyState, { text: '还没有 secret。pipe.yml 里用 ${{SECRET_NAME}} 引用；载荷落 workDir/.secrets.json（0600），DB 只存 ref。' })
              : h('div', { className: 'cicd-table-wrap' },
                h('table', { className: 'cicd-table' },
                  h('thead', null, h('tr', null,
                    h('th', null, 'ref'), h('th', null, 'scope'), h('th', null, 'name'), h('th', null, '创建时间'))),
                  h('tbody', null, items.map((item, index) => h('tr', { key: item.ref || index },
                    h('td', { className: 'cicd-mono' }, item.ref), h('td', null, item.scope || 'global'), h('td', null, item.name), h('td', null, item.createdAt || '—')))))),
            h('div', { className: 'cicd-section-title', style: { marginTop: '12px' } }, '设置 secret'),
            h('div', { className: 'cicd-secrets-form' },
              h('div', { className: 'cicd-form-field' },
                h('span', { className: 'cicd-form-label' }, 'scope'),
                h('input', { className: 'cicd-form-input', value: scope, onChange: (event) => setScope(event.currentTarget.value), placeholder: 'global / target:prod 等' })),
              h('div', { className: 'cicd-form-field' },
                h('span', { className: 'cicd-form-label' }, 'name'),
                h('input', { className: 'cicd-form-input', value: name, onChange: (event) => setName(event.currentTarget.value), placeholder: '例如 DB_PASSWORD' })),
              h('div', { className: 'cicd-form-field' },
                h('span', { className: 'cicd-form-label' }, 'value'),
                h('input', { className: 'cicd-form-input', type: 'password', value: value, onChange: (event) => setValue(event.currentTarget.value), placeholder: 'secret 值（不落明文到日志/DB）' })),
              h('button', { className: 'cicd-button cicd-button-primary', type: 'button', onClick: () => { onSet(scope, name.trim(), value); setName(''); setValue('') }, disabled: busy || !name.trim() || !value }, busy ? '设置…中' : '设置')),
            state.setResult && state.setResult.status === 'ready'
              ? h('span', { className: 'cicd-editor-status is-ok' }, state.setResult.message)
              : null,
            state.setResult && state.setResult.status === 'error'
              ? h('span', { className: 'cicd-editor-status is-error' }, state.setResult.message)
              : null)
          : null)
    }

    /** P1：Runner 管理视图（列出已注册构建主机）。 */
    function RunnersView({ state, onRefresh }) {
      const items = Array.isArray(state.items) ? state.items : []
      return h('div', { className: 'cicd-runners' },
        h('div', { className: 'cicd-runners-head' },
          h('span', { className: 'cicd-col-title' }, '构建主机 · ' + items.length + ' 台'),
          h('button', { className: 'cicd-button', type: 'button', onClick: onRefresh, disabled: state.status === 'loading' }, state.status === 'loading' ? '刷新…中' : '刷新')),
        state.status === 'loading' ? h(LoadingState, { text: '正在读取 runner…' }) : null,
        state.status === 'error' ? h(ErrorState, { error: state.error, onRetry: onRefresh }) : null,
        state.unsupported
          ? h(EmptyState, { text: 'Runner 管理不可用（/runners 路由未启用）。用 bin/runner.mjs 注册远端构建主机。' })
          : null,
        state.status === 'ready' && items.length === 0
          ? h(EmptyState, { text: '还没有注册 runner。在目标机运行：node bin/runner.mjs --host=<host> --token=<token>（拉取式协议 + journal 幂等 + 自签 TLS）。' })
          : null,
        state.status === 'ready' && items.length > 0
          ? h('div', { className: 'cicd-table-wrap' },
            h('table', { className: 'cicd-table' },
              h('thead', null, h('tr', null,
                h('th', null, 'runner id'), h('th', null, 'labels'), h('th', null, '容量'), h('th', null, '状态'), h('th', null, '在跑任务'))),
              h('tbody', null, items.map((item) => h('tr', { key: item.runnerId, className: item.status === 'offline' ? 'is-offline' : '' },
                h('td', { className: 'cicd-mono' }, item.runnerId),
                h('td', null, (item.labels || []).join(', ') || '—'),
                h('td', null, String(item.capacity || '—')),
                h('td', null, item.status === 'offline' ? '离线' : '在线'),
                h('td', null, String(item.activeTasks || 0)))))))
          : null)
    }

    function CicdPage() {
      /**
       * v3.0-P0：视图/项目/选中运行三件事的初值全部从 hash 读，
       * 这样刷新、前进后退、别人发来的深链落在同一处状态上。
       */
      const routeHash = useHashRoute()
      const bootRoute = useRef(null)
      if (bootRoute.current === null) bootRoute.current = parseHash(routeHash)

      const [projects, setProjects] = useState({ status: 'loading', items: [], error: null })
      const [projectId, setProjectId] = useState(bootRoute.current.project || '')
      const [targets, setTargets] = useState({ status: 'idle', items: [], error: null })
      const [targetName, setTargetName] = useState(bootRoute.current.target || '')
      const [runs, setRuns] = useState({ status: 'idle', items: [], error: null })
      const [selectedRunId, setSelectedRunId] = useState(bootRoute.current.runId || '')
      const [log, setLog] = useState({ status: 'idle', lines: [], jobs: [], jobId: '', error: null })
      /**
       * v3.0-P1：日志当前看的是哪个 job 的分片（空串 = 合并时间线）。
       *
       * 单独用一个 state 而不是把它塞进 `log` 里：轮询每 2 秒重拉一次日志，
       * 若「看哪个 job」跟着响应走，用户在轮询间隙切换就会被拨回上一个值。
       */
      const [logJobId, setLogJobId] = useState('')
      /** /run 的返回里带 stage 树，留着给刚启动的这次运行显示明细。 */
      const [runDetail, setRunDetail] = useState(null)
      const [plan, setPlan] = useState(null)
      const [releases, setReleases] = useState({ status: 'idle', items: [], error: null })
      const [view, setView] = useState(bootRoute.current.view || 'run')
      const [action, setAction] = useState({ status: 'idle', message: '', error: null })
      const [busy, setBusy] = useState(false)
      const [armed, setArmed] = useState(false)
      const [rollbackId, setRollbackId] = useState('')
      /** v0.5 生产护栏：Host 返回 409 PROD_CONFIRM_REQUIRED 时挂在这里，用户点确认后才带 confirm=prod 重发。 */
      const [prodGuard, setProdGuard] = useState(null)
      /** v0.6 C：审计视图数据（404 时置 unsupported，不当错误处理）。 */
      const [audit, setAudit] = useState({ status: 'idle', items: [], error: null, unsupported: false })
      const [auditLimit, setAuditLimit] = useState(AUDIT_DEFAULT_LIMIT)
      /** v0.6 B：测试通知的内联结果（不弹窗）。 */
      const [notify, setNotify] = useState({ status: 'idle', message: '', failed: false })
      const [notifyArmed, setNotifyArmed] = useState(false)
      /** v2-M0：项目卡上的 git meta（{ [projectId]: { status, data | error } }）。 */
      const [projectMetas, setProjectMetas] = useState({})
      /** v2-M0：编辑器状态（source / dirty / status / error）。 */
      const [editor, setEditor] = useState({ status: 'idle', source: '', loaded: false, dirty: false, error: null })
      const [editorValidate, setEditorValidate] = useState(null)
      const [editorSave, setEditorSave] = useState(null)
      /** v2-M0：新建向导的提交结果。 */
      const [create, setCreate] = useState({ status: 'idle', error: null, result: null })
      /** v2-M2：构建主机（runner）下拉。 */
      const [runners, setRunners] = useState({ status: 'idle', items: [], error: null })
      const [runnerId, setRunnerId] = useState('')
      /** P1：审批视图数据。 */
      const [approvals, setApprovals] = useState({ status: 'idle', items: [], error: null })
      /** P1：RBAC 视图数据。 */
      const [rbac, setRbac] = useState({ status: 'idle', users: [], audit: [], error: null, verifyResult: null })
      /** P1：Secrets 视图数据。 */
      const [secrets, setSecrets] = useState({ status: 'idle', items: [], error: null, setResult: null })
      /** P1：Runner 管理视图数据（复用 runners 状态）。 */

      /** 每类请求各自一个 controller：轮询时 runs 与 log 一起发，不能互相 abort。 */
      const aborters = useRef({})
      const armTimer = useRef(null)
      const rollbackTimer = useRef(null)
      const notifyTimer = useRef(null)

      /** 同一个 slot 的新请求会掐掉上一笔，避免旧响应盖掉新状态。 */
      const freshSignal = useCallback((slot) => {
        const map = aborters.current
        const key = slot || 'misc'
        if (map[key]) {
          try { map[key].abort() } catch (error) { /* ignore */ }
        }
        const controller = new AbortController()
        map[key] = controller
        return controller.signal
      }, [])

      useEffect(() => () => {
        const map = aborters.current
        Object.keys(map).forEach((key) => {
          try { map[key].abort() } catch (error) { /* ignore */ }
        })
        if (armTimer.current) clearTimeout(armTimer.current)
        if (rollbackTimer.current) clearTimeout(rollbackTimer.current)
        if (notifyTimer.current) clearTimeout(notifyTimer.current)
      }, [])

      /** v2-M0：并行拉每个项目的 /project-meta，喂给项目卡（分支 · 提交 · tag · 是否脏）。 */
      const loadProjectMetas = useCallback(async (items) => {
        const list = Array.isArray(items) ? items : []
        await Promise.all(list.map(async (project) => {
          const id = project && project.id
          if (!id) return
          try {
            const payload = await callApi('project-meta', { project: id }, freshSignal('meta:' + id))
            setProjectMetas((prev) => ({ ...prev, [id]: { status: 'ready', data: payload } }))
          } catch (error) {
            if (error && error.name === 'AbortError') return
            setProjectMetas((prev) => ({ ...prev, [id]: { status: 'error', error } }))
          }
        }))
      }, [freshSignal])

      const loadProjects = useCallback(async () => {
        setProjects({ status: 'loading', items: [], error: null })
        try {
          const payload = await callApi('projects', {}, freshSignal('projects'))
          const items = Array.isArray(payload.projects) ? payload.projects : []
          setProjects({ status: 'ready', items, error: null })
          setProjectId((current) => {
            if (current && items.some((project) => project.id === current)) return current
            // 记住上次选的项目；失效或没有记录时退到第一个有 pipe.yml 的项目。
            const stored = readStoredProject()
            if (stored && items.some((project) => project.id === stored)) return stored
            const usable = items.find((project) => projectHasPipe(project)) || items[0]
            return usable ? usable.id : ''
          })
          // v2-M0：项目列表就绪后并行拉 git meta，喂给项目卡。
          void loadProjectMetas(items)
        } catch (error) {
          if (error && error.name === 'AbortError') return
          setProjects({ status: 'error', items: [], error })
        }
      }, [freshSignal, loadProjectMetas])

      const loadTargets = useCallback(async (id) => {
        if (!id) {
          setTargets({ status: 'idle', items: [], error: null })
          setTargetName('')
          return
        }
        setTargets({ status: 'loading', items: [], error: null })
        try {
          const payload = await callApi('targets', { project: id }, freshSignal('targets'))
          const items = Array.isArray(payload.targets) ? payload.targets : []
          setTargets({ status: 'ready', items, error: null })
          setTargetName((current) => (current && items.some((target) => target.name === current) ? current : (items[0] ? items[0].name : '')))
        } catch (error) {
          if (error && error.name === 'AbortError') return
          setTargets({ status: 'error', items: [], error })
        }
      }, [freshSignal])

      const loadRuns = useCallback(async (id, quiet) => {
        if (!id) return
        if (!quiet) setRuns((prev) => ({ status: 'loading', items: prev.items, error: null }))
        try {
          const payload = await callApi('runs', { project: id, limit: RUN_LIMIT }, freshSignal('runs'))
          setRuns({ status: 'ready', items: Array.isArray(payload.runs) ? payload.runs : [], error: null })
        } catch (error) {
          if (error && error.name === 'AbortError') return
          if (!quiet) setRuns({ status: 'error', items: [], error })
        }
      }, [freshSignal])

      const loadLog = useCallback(async (runId, quiet, jobId) => {
        if (!runId) {
          setLog({ status: 'idle', lines: [], jobs: [], jobId: '', error: null })
          return
        }
        if (!quiet) setLog({ status: 'loading', lines: [], jobs: [], jobId: jobId || '', error: null })
        try {
          const payload = await callApi('log', { runId, tail: LOG_TAIL, jobId: jobId || '' }, freshSignal('log'))
          setLog({
            status: 'ready',
            lines: logLines(payload),
            // v3.0-P1：并行 job 各自有一份分片日志，主日志是交错时间线。
            // 这里把 Host 报告的分片清单留着，日志区据此给出「只看某个 job」的下拉。
            jobs: Array.isArray(payload.jobs) ? payload.jobs : [],
            jobId: payload.jobId || '',
            error: null,
          })
        } catch (error) {
          if (error && error.name === 'AbortError') return
          if (!quiet) {
            // 保留上一次的分片清单：读单个 job 失败时下拉不能消失，否则用户回不到「全部 job」。
            setLog((prev) => ({
              status: 'error',
              lines: [],
              jobs: Array.isArray(prev.jobs) ? prev.jobs : [],
              jobId: jobId || '',
              error,
            }))
          }
        }
      }, [freshSignal])

      const loadReleases = useCallback(async (target) => {
        if (!target) {
          setReleases({ status: 'idle', items: [], error: null })
          return
        }
        setReleases({ status: 'loading', items: [], error: null })
        try {
          const payload = await callApi('releases', { target, limit: 50 }, freshSignal('releases'))
          setReleases({ status: 'ready', items: Array.isArray(payload.releases) ? payload.releases : [], error: null })
        } catch (error) {
          if (error && error.name === 'AbortError') return
          setReleases({ status: 'error', items: [], error })
        }
      }, [freshSignal])

      /** v0.6 C：审计时间线。Host 没有 /operations 时按「未升级」处理，不显示成红色错误。 */
      const loadAudit = useCallback(async (limit) => {
        if (!projectId) {
          setAudit({ status: 'idle', items: [], error: null, unsupported: false })
          return
        }
        setAudit((prev) => ({ status: 'loading', items: prev.items, error: null, unsupported: false }))
        try {
          const payload = await callApi('operations', { project: projectId, limit: limit || AUDIT_DEFAULT_LIMIT }, freshSignal('audit'))
          setAudit({ status: 'ready', items: Array.isArray(payload.operations) ? payload.operations : [], error: null, unsupported: false })
        } catch (error) {
          if (error && error.name === 'AbortError') return
          if (error && (error.status === 404 || error.code === 'NOT_FOUND')) {
            setAudit({ status: 'ready', items: [], error: null, unsupported: true })
            return
          }
          setAudit({ status: 'error', items: [], error, unsupported: false })
        }
      }, [freshSignal, projectId])

      /** v2-M2：构建主机（runner）列表。Host 没有 /runners 时按「未升级」处理，UI 仍可选本机。 */
      const loadRunners = useCallback(async () => {
        setRunners((prev) => ({ status: 'loading', items: prev.items, error: null }))
        try {
          const payload = await callApi('runners', {}, freshSignal('runners'))
          const items = Array.isArray(payload.runners) ? payload.runners : []
          setRunners({ status: 'ready', items, error: null })
        } catch (error) {
          if (error && error.name === 'AbortError') return
          if (error && (error.status === 404 || error.code === 'NOT_FOUND')) {
            setRunners({ status: 'idle', items: [], error: null, unsupported: true })
            return
          }
          setRunners({ status: 'error', items: [], error })
        }
      }, [freshSignal])

      useEffect(() => { void loadProjects() }, [loadProjects])
      useEffect(() => { void loadTargets(projectId) }, [projectId, loadTargets])
      useEffect(() => { void loadRuns(projectId, false) }, [projectId, loadRuns])
      // v2-M2：构建主机下拉，进页面拉一次；失败（404）时 UI 退回本机执行。
      useEffect(() => { void loadRunners() }, [loadRunners])
      // 右列 Releases 常驻，切目标或切项目都要重新拉这一份。
      useEffect(() => {
        if (targetName) void loadReleases(targetName)
      }, [targetName, projectId, loadReleases])

      // v0.6 C：进审计视图或改条数时拉一次 /operations。
      useEffect(() => {
        if (view !== 'audit') return
        void loadAudit(auditLimit)
      }, [view, auditLimit, loadAudit])

      // 选中项：列表变化时保持选中。
      // v3.0-P0：这里**不再**在「选中的运行不在最近列表里」时回落到第一条 ——
      /**
       * 切运行：同时把「看哪个 job 的日志」清掉。
       *
       * 不清的话，从 A 的 `unit[java=17]` 切到 B 会带着一个 B 里不存在的 jobId 去请求日志，
       * Host 只能回 404，用户看到的是「切过去就没日志了」。
       */
      const selectRun = useCallback((runId) => {
        setSelectedRunId(runId || '')
        setLogJobId('')
      }, [])

      // 深链 `#/projects/p/runs/<id>` 打开的就是那一次运行，偷偷换成别的正是「刷新丢视图」的老毛病；
      // 列表还没就绪时更不能回落，否则深链会在首帧被清掉。
      useEffect(() => {
        if (selectedRunId) return
        const first = runs.items[0]
        if (first) setSelectedRunId(first.id)
      }, [runs.items, selectedRunId])

      useEffect(() => {
        void loadLog(selectedRunId, false, logJobId)
      }, [selectedRunId, logJobId, loadLog])

      const selectedRun = runs.items.find((run) => run.id === selectedRunId) || null
      const isRunning = runs.items.some((run) => run.status === 'running' || run.status === 'queued')

      // 只有存在未结束的运行才轮询；离开视图 / 卸载时清掉 timer。
      useEffect(() => {
        if (view !== 'run' || !projectId || !isRunning) return undefined
        const timer = setInterval(() => {
          void loadRuns(projectId, true)
          if (selectedRunId) void loadLog(selectedRunId, true, logJobId)
        }, POLL_MS)
        return () => clearInterval(timer)
      }, [view, projectId, isRunning, selectedRunId, logJobId, loadRuns, loadLog])

      const clearArmed = useCallback(() => {
        if (armTimer.current) {
          clearTimeout(armTimer.current)
          armTimer.current = null
        }
        setArmed(false)
      }, [])

      const clearRollback = useCallback(() => {
        if (rollbackTimer.current) {
          clearTimeout(rollbackTimer.current)
          rollbackTimer.current = null
        }
        setRollbackId('')
      }, [])

      const runPlan = useCallback(async () => {
        if (!projectId || !targetName) return
        setPlan({ status: 'loading', data: null, error: null, target: targetName })
        try {
          const payload = await callApi('plan', { project: projectId, target: targetName }, freshSignal('plan'))
          setPlan({ status: 'ready', data: planOf(payload), error: null, target: targetName })
        } catch (error) {
          if (error && error.name === 'AbortError') return
          setPlan({ status: 'error', data: null, error, target: targetName })
        }
      }, [projectId, targetName, freshSignal])

      const startRun = useCallback(async (dryRun, confirmProd = false) => {
        if (!projectId || !targetName) return
        setBusy(true)
        setProdGuard(null)
        setAction({
          status: 'running',
          message: dryRun ? '正在启动干跑…' : confirmProd ? '正在发布到生产…' : '正在启动运行…',
          error: null,
        })
        try {
          // Host 的 /run 是写路由：即便干跑也要 confirm=1，否则一律 400「写操作需要 confirm=1」。
          // v0.5：目标展开后含 env=prod 的主机时，Host 只认 confirm=prod（409 PROD_CONFIRM_REQUIRED）。
          // v2-M2：选了构建主机时带 runner=<id>，Host 走拉取式 runner 执行；不选则本机。
          const params = { project: projectId, target: targetName, confirm: confirmProd ? 'prod' : 1, dryRun: dryRun ? 1 : 0 }
          if (runnerId) params.runner = runnerId
          const payload = await callApi('run', params, freshSignal('run'))
          const run = runOfPayload(payload)
          setAction({
            status: 'done',
            message: (dryRun ? '干跑' : '运行') + (run && run.id ? '已记录：' + shortId(run.id, 20) + '（' + (run.status || 'queued') + '）' : '请求已提交') + '。',
            error: null,
          })
          if (run && run.id) {
            setRunDetail({
              id: run.id,
              stages: Array.isArray(run.stages) ? run.stages : [],
              canary: run.canary || null,
              // v3.0-P1：v2 的 pipe 才有 job 图（v1 是 null），保留下来给时间线分层。
              jobs: run.jobs || null,
            })
            setSelectedRunId(run.id)
            // 新的一次运行从头看合并时间线：上一条运行选的 job 在这里根本不存在。
            setLogJobId('')
          }
          await loadRuns(projectId, true)
          if (run && run.id) await loadLog(run.id, false, '')
        } catch (error) {
          if (error && error.name === 'AbortError') return
          // 生产护栏：Host 拒绝并要求二次确认时把受影响主机摆出来，等用户点「确认发布到生产」。
          if (error && error.code === 'PROD_CONFIRM_REQUIRED') {
            setProdGuard({ kind: 'run', dryRun, hosts: Array.isArray(error.hosts) ? error.hosts : [], error })
            setAction({ status: 'error', message: '', error, retry: null })
            return
          }
          setAction({ status: 'error', message: '', error, retry: () => void startRun(dryRun, confirmProd) })
        } finally {
          setBusy(false)
        }
      }, [projectId, targetName, runnerId, freshSignal, loadRuns, loadLog])

      const requestRun = useCallback(() => {
        if (armed) {
          clearArmed()
          void startRun(false)
          return
        }
        setArmed(true)
        if (armTimer.current) clearTimeout(armTimer.current)
        armTimer.current = setTimeout(() => {
          armTimer.current = null
          setArmed(false)
        }, CONFIRM_MS)
      }, [armed, clearArmed, startRun])

      /** 真正执行回滚（确认已在 requestRollback 里做过）。 */
      const rollbackTo = useCallback(async (release, confirmProd = false) => {
        if (!targetName) return
        setBusy(true)
        setProdGuard(null)
        setAction({ status: 'running', message: '正在回滚到 ' + release.id + '…', error: null })
        try {
          // 回滚也是写路由：目标展开后含生产主机时同样只认 confirm=prod。
          const payload = await callApi('rollback', {
            target: targetName,
            releaseId: release.id,
            confirm: confirmProd ? 'prod' : 1,
          }, freshSignal('rollback'))
          const released = payload.released || payload
          const where = released && (released.host || released.target) ? '（' + [released.target, released.host].filter(Boolean).join(' · ') + '）' : ''
          setAction({ status: 'done', message: '已回滚到 ' + ((released && (released.releaseId || released.id || released.commit)) || release.id) + where + '。', error: null })
          await loadReleases(targetName)
        } catch (error) {
          if (error && error.name === 'AbortError') return
          if (error && error.code === 'PROD_CONFIRM_REQUIRED') {
            setProdGuard({ kind: 'rollback', release, hosts: Array.isArray(error.hosts) ? error.hosts : [], error })
            setAction({ status: 'error', message: '', error, retry: null })
            return
          }
          setAction({ status: 'error', message: '', error, retry: () => void rollbackTo(release, confirmProd) })
        } finally {
          setBusy(false)
        }
      }, [targetName, freshSignal, loadReleases])

      const requestRollback = useCallback((release) => {
        if (rollbackId !== release.id) {
          setRollbackId(release.id)
          if (rollbackTimer.current) clearTimeout(rollbackTimer.current)
          rollbackTimer.current = setTimeout(() => {
            rollbackTimer.current = null
            setRollbackId('')
          }, ROLLBACK_CONFIRM_MS)
          return
        }
        clearRollback()
        void rollbackTo(release)
      }, [rollbackId, clearRollback, rollbackTo])

      /** P1：审批视图数据加载。 */
      const loadApprovals = useCallback(async () => {
        setApprovals((prev) => ({ status: 'loading', items: prev.items, error: null }))
        try {
          const payload = await callApi('approvals', { project: projectId || '' }, freshSignal('approvals'))
          const items = Array.isArray(payload.approvals) ? payload.approvals : []
          setApprovals({ status: 'ready', items, error: null })
        } catch (error) {
          if (error && error.name === 'AbortError') return
          setApprovals({ status: 'error', items: [], error })
        }
      }, [freshSignal, projectId])

      /** P1：审批操作（approve/reject）。 */
      const resolveApproval = useCallback(async (runId, decision) => {
        try {
          await callApi('approve', { runId, decision, confirm: 1 }, freshSignal('approve'))
          void loadApprovals()
        } catch (error) {
          if (error && error.name !== 'AbortError') {
            setApprovals((prev) => ({ ...prev, error }))
          }
        }
      }, [callApi, freshSignal, loadApprovals])

      /** P1：RBAC 视图数据加载。 */
      const loadRbac = useCallback(async () => {
        setRbac((prev) => ({ status: 'loading', users: prev.users, audit: prev.audit, error: null, verifyResult: null }))
        try {
          const payload = await callApi('rbac', {}, freshSignal('rbac'))
          setRbac({
            status: 'ready',
            users: Array.isArray(payload.users) ? payload.users : [],
            audit: Array.isArray(payload.audit) ? payload.audit : [],
            error: null,
            verifyResult: null,
          })
        } catch (error) {
          if (error && error.name === 'AbortError') return
          setRbac({ status: 'error', users: [], audit: [], error, verifyResult: null })
        }
      }, [freshSignal])

      /** P1：RBAC 吊销用户。 */
      const revokeRbacUser = useCallback(async (user) => {
        try {
          await callApi('rbac', { user, action: 'revoke', confirm: 1 }, freshSignal('rbac-revoke'))
          void loadRbac()
        } catch (error) {
          if (error && error.name !== 'AbortError') {
            setRbac((prev) => ({ ...prev, error }))
          }
        }
      }, [callApi, freshSignal, loadRbac])

      /** P1：RBAC 校验 token。 */
      const verifyRbacToken = useCallback(async (token) => {
        setRbac((prev) => ({ ...prev, verifyResult: { status: 'loading', message: '', error: null } }))
        try {
          const payload = await callApi('rbac', { token, action: 'verify' }, freshSignal('rbac-verify'))
          setRbac((prev) => ({ ...prev, verifyResult: { status: 'ready', message: payload.user ? `${payload.user}（${payload.role}）` : 'token 无效', error: null } }))
        } catch (error) {
          if (error && error.name !== 'AbortError') {
            setRbac((prev) => ({ ...prev, verifyResult: { status: 'error', message: error.message || '校验失败', error } }))
          }
        }
      }, [callApi, freshSignal])

      /** P1：Secrets 视图数据加载。 */
      const loadSecrets = useCallback(async (project) => {
        setSecrets((prev) => ({ status: 'loading', items: prev.items, error: null, setResult: null }))
        try {
          const payload = await callApi('secrets', { project: project || '' }, freshSignal('secrets'))
          const items = Array.isArray(payload.secrets) ? payload.secrets : []
          setSecrets({ status: 'ready', items, error: null, setResult: null })
        } catch (error) {
          if (error && error.name === 'AbortError') return
          setSecrets({ status: 'error', items: [], error, setResult: null })
        }
      }, [freshSignal])

      /** P1：设置 secret。 */
      const setSecret = useCallback(async (scope, name, value) => {
        if (!name || !value) return
        try {
          const payload = await callApi('secrets', { project: projectId || '', scope: scope || 'global', name, value, confirm: 1 }, freshSignal('secret-set'))
          setSecrets((prev) => ({ ...prev, setResult: { status: 'ready', message: '已设置 ' + name } }))
          void loadSecrets(projectId)
        } catch (error) {
          if (error && error.name !== 'AbortError') {
            setSecrets((prev) => ({ ...prev, setResult: { status: 'error', message: error.message || '设置失败' } }))
          }
        }
      }, [callApi, freshSignal, loadSecrets, projectId])

      const refreshAll = useCallback(() => {
        clearArmed()
        clearRollback()
        setAction({ status: 'idle', message: '', error: null })
        void loadProjects()
        if (projectId) {
          void loadTargets(projectId)
          void loadRuns(projectId, false)
        }
        if (targetName) void loadReleases(targetName)
        if (view === 'audit') void loadAudit(auditLimit)
        if (view === 'approvals') void loadApprovals()
        if (view === 'rbac') void loadRbac()
        if (view === 'secrets') void loadSecrets(projectId)
        if (view === 'runners') void loadRunners()
      }, [clearArmed, clearRollback, loadProjects, loadTargets, loadRuns, loadReleases, projectId, targetName, view, loadAudit, auditLimit, loadApprovals, loadRbac, loadSecrets, loadRunners])

      /**
       * v3.0-P0：进入各视图时按需拉自己的数据。
       * 以前只有 `refreshAll` 会按 view 分派，直接打开「审批」视图（尤其是深链
       * `#/projects/p/approvals`）看到的是空表，必须手动点一次刷新才有内容。
       */
      useEffect(() => {
        if (view === 'approvals') void loadApprovals()
        if (view === 'rbac') void loadRbac()
        if (view === 'secrets') void loadSecrets(projectId)
        if (view === 'runners') void loadRunners()
      }, [view, projectId, loadApprovals, loadRbac, loadSecrets, loadRunners])

      /**
       * v3.0-P0：切视图只有一个入口。
       * 以前八个 `toggleXxx` 各自 `setView`，视图和 URL 没有任何关系，所以刷新必丢、也无法分享；
       * 现在统一走 `goView`，URL 由一个同步 effect 从这三个状态（项目/视图/选中运行）推出来。
       */
      const goView = useCallback((next) => {
        clearRollback()
        const target = ROUTE_VIEWS.indexOf(next) >= 0 ? next : 'run'
        setView(target)
        if (target === 'releases' && targetName) void loadReleases(targetName)
        if (target === 'run' && projectId) void loadRuns(projectId, false)
      }, [clearRollback, targetName, projectId, loadReleases, loadRuns])

      /**
       * 路由稳定后再删掉这层：`toggleCreate` 只服务工具条下拉里的「+ 新建项目…」，
       * 其余八个整页切换按钮已随左侧导航一起删除（导航点当前项即回到运行，由 `goView` 覆盖）。
       */
      const toggleCreate = useCallback(() => {
        clearRollback()
        setView((current) => (current === 'create' ? 'run' : 'create'))
      }, [clearRollback])

      /**
       * hash → state。
       * 只依赖 `routeHash`：这个 effect 是「外面改了地址」的唯一落点，若把 projectId/view 等
       * 也放进依赖，它就会反向响应自己写出去的值，陷入「写→读→写」的抖动。
       */
      const routeSync = useRef({})
      routeSync.current = { projectId, view, selectedRunId, targetName, items: projects.items }
      const deepLink = useRef({
        runId: bootRoute.current.runId || '',
        step: bootRoute.current.step || '',
        line: bootRoute.current.line || '',
      })
      const lastRouteHash = useRef(routeHash)
      useEffect(() => {
        if (routeHash === lastRouteHash.current) return
        lastRouteHash.current = routeHash
        const route = parseHash(routeHash)
        const current = routeSync.current
        const known = (id) => current.items.length === 0 || current.items.some((project) => project.id === id)
        if (route.project && route.project !== current.projectId && known(route.project)) {
          writeStoredProject(route.project)
          setProjectId(route.project)
          setPlan(null)
          setRunDetail(null)
          setAction({ status: 'idle', message: '', error: null })
        }
        if (route.view !== current.view) setView(route.view)
        if ((route.runId || '') !== (current.selectedRunId || '')) {
          setSelectedRunId(route.runId || '')
          // 深链换了运行，上一条运行选的 job 分片在这里不存在：跟着清掉，别去请求一个必定 404 的名字。
          setLogJobId('')
        }
        if (route.target && route.target !== current.targetName) setTargetName(route.target)
        deepLink.current = { runId: route.runId || '', step: route.step || '', line: route.line || '' }
      }, [routeHash])

      /**
       * state → hash。
       * 首次进入用 `replaceState`（打开面板本身不该在历史里多一条），之后切换才 push。
       * `writeHash` 在值相同时直接返回，所以「读进来的值再写出去」不会产生额外历史项。
       */
      const hashSeeded = useRef(false)
      useEffect(() => {
        const deep = deepLink.current
        const sameRun = deep.runId && deep.runId === selectedRunId
        const next = buildHash({
          project: projectId,
          view,
          runId: selectedRunId,
          target: targetName,
          step: sameRun ? deep.step : '',
          line: sameRun ? deep.line : '',
        })
        if (!next) return
        const replace = !hashSeeded.current
        writeHash(next, replace)
        hashSeeded.current = true
        lastRouteHash.current = readHash()
      }, [projectId, view, selectedRunId, targetName])

      /** v2-M0：进入编辑器时从 /project-meta 拉 pipeSource。 */
      const loadEditor = useCallback(async (id) => {
        if (!id) {
          setEditor({ status: 'idle', source: '', loaded: false, dirty: false, error: null })
          setEditorValidate(null)
          setEditorSave(null)
          return
        }
        setEditor({ status: 'loading', source: '', loaded: false, dirty: false, error: null })
        setEditorValidate(null)
        setEditorSave(null)
        try {
          const payload = await callApi('project-meta', { project: id }, freshSignal('editor'))
          setEditor({ status: 'ready', source: payload.pipeSource || '', loaded: true, dirty: false, error: null })
        } catch (error) {
          if (error && error.name === 'AbortError') return
          setEditor({ status: 'error', source: '', loaded: false, dirty: false, error })
        }
      }, [freshSignal])

      /** v2-M0：校验当前 textarea 内容（/validate?source=）。校验失败会抛 ApiError（带 code/line）。 */
      const runEditorValidate = useCallback(async () => {
        setEditorValidate({ status: 'loading' })
        try {
          const payload = await callApi('validate', { source: editor.source || '' }, freshSignal('validate'))
          setEditorValidate({ status: 'ok', data: payload })
        } catch (error) {
          if (error && error.name === 'AbortError') return
          setEditorValidate({ status: 'error', error })
        }
      }, [editor.source, freshSignal])

      /** v2-M0：保存 pipe.yml（/pipe-save confirm=1），成功后刷新目标与计划。 */
      const runEditorSave = useCallback(async () => {
        setEditorSave({ status: 'running', message: '' })
        try {
          const payload = await callApi('pipe-save', { project: projectId, source: editor.source || '', confirm: 1 }, freshSignal('pipe-save'))
          setEditorSave({ status: 'done', message: '已保存 ' + (payload.path || 'pipe.yml') })
          setEditor((prev) => ({ ...prev, dirty: false }))
          setEditorValidate({ status: 'ok', data: payload })
          // pipe 变了，目标可能跟着变：刷新目标并清掉旧计划。
          setPlan(null)
          if (projectId) void loadTargets(projectId)
        } catch (error) {
          if (error && error.name === 'AbortError') return
          setEditorSave({ status: 'error', message: '保存失败：' + ((error && error.message) || '未知错误') })
        }
      }, [editor.source, projectId, freshSignal, loadTargets])

      /** v2-M0：提交新建项目（/project-create confirm=1），成功后选中新项目并回到运行视图。 */
      const submitCreate = useCallback(async (form) => {
        setCreate({ status: 'running', error: null, result: null })
        try {
          const payload = await callApi('project-create', { ...form, confirm: 1 }, freshSignal('project-create'))
          setCreate({ status: 'done', error: null, result: payload })
          // 记住并选中新项目；loadProjects 会把它带进列表并保留当前选中。
          if (payload && payload.id) writeStoredProject(payload.id)
          if (payload && payload.id) setProjectId(payload.id)
          setPlan(null)
          setRunDetail(null)
          setTargetName('')
          setView('run')
          void loadProjects()
        } catch (error) {
          if (error && error.name === 'AbortError') return
          setCreate({ status: 'error', error, result: null })
        }
      }, [freshSignal, loadProjects])

      useEffect(() => {
        if (view !== 'editor') return
        void loadEditor(projectId)
      }, [view, projectId, loadEditor])

      const clearNotifyArmed = useCallback(() => {
        if (notifyTimer.current) {
          clearTimeout(notifyTimer.current)
          notifyTimer.current = null
        }
        setNotifyArmed(false)
      }, [])

      /** v0.6 B：真正发测试通知（确认已在 requestNotify 里做过）。 */
      const runNotifyTest = useCallback(async () => {
        setNotify({ status: 'running', message: '正在发送测试通知…', failed: false })
        try {
          // 写路由：与 /run 一样要 confirm=1。
          const payload = await callApi('notify-test', { confirm: 1 }, freshSignal('notify'))
          const configured = Number(payload.configured) || 0
          const webhooks = Array.isArray(payload.webhooks) ? payload.webhooks : []
          if (configured === 0) {
            setNotify({ status: 'empty', message: '还没有配置 webhook（在 dsh-cicd 插件配置里加 notify.webhooks）', failed: false })
            return
          }
          const okCount = webhooks.filter((item) => item && item.ok).length
          const failCount = webhooks.length - okCount
          setNotify({
            status: 'done',
            message: configured + ' 个 webhook：成功 ' + okCount + ' / 失败 ' + failCount,
            failed: failCount > 0,
          })
        } catch (error) {
          if (error && error.name === 'AbortError') return
          setNotify({
            status: 'error',
            message: '测试通知失败：' + ((error && error.message) || '未知错误'),
            failed: true,
          })
        }
      }, [freshSignal])

      /** v0.6 B：测试通知是外发动作 → 8 秒内再点一次才真发。 */
      const requestNotify = useCallback(() => {
        if (notifyArmed) {
          clearNotifyArmed()
          void runNotifyTest()
          return
        }
        setNotify({ status: 'idle', message: '', failed: false })
        setNotifyArmed(true)
        if (notifyTimer.current) clearTimeout(notifyTimer.current)
        notifyTimer.current = setTimeout(() => {
          notifyTimer.current = null
          setNotifyArmed(false)
        }, NOTIFY_CONFIRM_MS)
      }, [notifyArmed, clearNotifyArmed, runNotifyTest])

      const onSelectProject = useCallback((id) => {
        clearArmed()
        clearRollback()
        if (id) writeStoredProject(id)
        setProjectId(id)
        setPlan(null)
        setRunDetail(null)
        setAction({ status: 'idle', message: '', error: null })
      }, [clearArmed, clearRollback])

      const onSelectTarget = useCallback((name) => {
        clearRollback()
        setPlan(null)
        setTargetName(name)
      }, [clearRollback])

      const actionBar = action.status === 'idle'
        ? null
        : h('div', {
          className: 'cicd-action' + (action.status === 'error' ? ' is-error' : ''),
          role: action.status === 'error' ? 'alert' : 'status',
        },
        action.status === 'error'
          ? h('div', { className: 'cicd-action-body' },
            h('span', { className: 'cicd-action-message' }, (action.error && action.error.message) || '操作失败'),
            action.error && action.error.code
              ? h('span', { className: 'cicd-error-code cicd-mono' }, action.error.code + (action.error.line ? ' · 第 ' + action.error.line + ' 行' : ''))
              : null,
            explainError(action.error)
              ? h('span', { className: 'cicd-error-hint' }, explainError(action.error))
              : null,
            action.retry
              ? h('button', { className: 'cicd-button cicd-action-retry', type: 'button', onClick: action.retry, disabled: busy }, '重试')
              : null)
          : h('span', null, action.message))

      // v0.5 生产护栏：Host 拒绝过一次，这里列出受影响主机；用户点确认才带 confirm=prod 重发。
      const prodGuardBar = !prodGuard
        ? null
        : h('div', { className: 'cicd-prod-guard', role: 'alert', 'data-dsh-cicd-prod-guard': prodGuard.kind },
          h('span', { className: 'cicd-prod-guard-text' },
            (prodGuard.kind === 'rollback' ? '这个回滚' : '这次发布') + '会动到生产主机，确认后才真正执行。'),
          h('span', { className: 'cicd-prod-guard-hosts' },
            '受影响主机：' + (prodGuard.hosts.length > 0 ? prodGuard.hosts.join('、') : '（Host 没有列出具体主机）')),
          h('div', { className: 'cicd-prod-guard-actions' },
            h('button', {
              className: 'cicd-button cicd-prod-confirm',
              type: 'button',
              disabled: busy,
              onClick: () => {
                const pending = prodGuard
                setProdGuard(null)
                if (pending.kind === 'rollback' && pending.release) void rollbackTo(pending.release, true)
                else void startRun(Boolean(pending.dryRun), true)
              },
            }, busy ? '发布…中' : prodGuard.kind === 'rollback' ? '确认回滚（生产）' : '确认发布到生产'),
            h('button', {
              className: 'cicd-button cicd-prod-cancel',
              type: 'button',
              disabled: busy,
              onClick: () => setProdGuard(null),
            }, '取消')))

      const toolbar = h('div', { className: 'cicd-toolbar' },
        h('div', { className: 'cicd-toolbar-group' },
          h('span', { className: 'cicd-label' }, '项目'),
          // 始终显示选择器（单项目也可见，避免用户以为不能切）；+ 新建 跳 CreateView。
          h('select', {
            className: 'cicd-select cicd-project-select cicd-project-picker',
            value: projectId,
            disabled: projects.status !== 'ready' || projects.items.length === 0,
            onChange: (event) => {
              const value = event.currentTarget.value
              if (value === '__new__') { toggleCreate(); return }
              onSelectProject(value)
            },
            'aria-label': '选择项目',
          },
            projects.items.length === 0
              ? h('option', { value: '' }, '（没有项目）')
              : projects.items.map((project) => h('option', { key: project.id, value: project.id }, project.name || project.id)),
            h('option', { value: '__new__', disabled: projects.status !== 'ready' }, '+ 新建项目…'))
          ,
        h('div', { className: 'cicd-toolbar-group' },
          h('span', { className: 'cicd-label' }, '目标'),
          h('select', {
            className: 'cicd-select cicd-target-select',
            value: targetName,
            disabled: targets.status !== 'ready' || targets.items.length === 0,
            onChange: (event) => onSelectTarget(event.currentTarget.value),
            'aria-label': '选择部署目标',
          }, targets.items.length === 0
            ? h('option', { value: '' }, '（没有目标）')
            : targets.items.map((target) => h('option', { key: target.name, value: target.name }, target.name)))),
        h('div', { className: 'cicd-toolbar-group' },
          h('span', { className: 'cicd-label' }, '构建主机'),
          h('select', {
            className: 'cicd-select cicd-runner-select',
            value: runnerId,
            disabled: runners.status === 'error',
            onChange: (event) => setRunnerId(event.currentTarget.value),
            'aria-label': '选择构建主机（执行面）',
          },
            h('option', { value: '' }, '本机（Host）'),
            runners.items.map((runner) => h('option', { key: runner.runnerId, value: runner.runnerId }, runner.runnerId + (runner.status === 'offline' ? '（离线）' : ''))))
          ),
        h('div', { className: 'cicd-toolbar-group' },
          h('button', { className: 'cicd-button cicd-plan-open', type: 'button', onClick: runPlan, disabled: busy || !targetName || Boolean(plan && plan.status === 'loading') }, plan && plan.status === 'loading' ? '计划…中' : '计划'),
          h('button', { className: 'cicd-button cicd-dry-run', type: 'button', onClick: () => void startRun(true), disabled: busy || !targetName }, busy ? '干跑…中' : '干跑'),
          h('button', {
            className: 'cicd-button cicd-run-now' + (armed ? ' cicd-button-armed' : ''),
            type: 'button',
            'aria-pressed': armed,
            onClick: requestRun,
            disabled: busy || !targetName,
          }, busy ? '运行…中' : armed ? '确认运行' : '运行'),
          h('button', {
            className: 'cicd-button cicd-notify-test' + (notifyArmed ? ' cicd-button-armed' : ''),
            type: 'button',
            'aria-pressed': notifyArmed,
            onClick: requestNotify,
            disabled: busy || notify.status === 'running',
            title: notifyArmed ? '8 秒内再点一次才真的发出去' : '向配置的 webhook 发一条测试消息',
          }, notify.status === 'running' ? '测试…中' : notifyArmed ? '确认测试' : '测试通知'),
          h('button', { className: 'cicd-button cicd-refresh', type: 'button', onClick: refreshAll, disabled: projects.status === 'loading' }, projects.status === 'loading' ? '刷新…中' : '刷新')
        ),
        h('div', { className: 'cicd-toolbar-spacer' }),
        isRunning && view === 'run' ? h('span', { className: 'cicd-poll' }, '运行中 · 每 2 秒刷新') : null,
        // v0.6 B：测试通知的结果内联在工具条尾部，不弹窗、不占整页。
        notify.status === 'idle' || notify.status === 'running'
          ? null
          : h('span', {
            className: 'cicd-notify-result' + (notify.failed ? ' is-failed' : ''),
            role: notify.failed ? 'alert' : 'status',
          }, notify.message),
        notifyArmed
          ? h('span', { className: 'cicd-hint' }, '点「确认测试」会真的向配置的 webhook 发一条测试消息（8 秒内有效）。')
          : null,
        armed
          ? h('span', { className: 'cicd-hint' }, '会真的执行本地命令并部署到 ' + targetName + (runnerId ? '（构建主机：' + runnerId + '）' : '') + '，继续？10 秒内再点一次「确认运行」。')
          : null
      ))

      const body = view === 'audit'
        ? h(AuditView, {
          state: audit,
          limit: auditLimit,
          onLimit: (value) => setAuditLimit(value),
          onRefresh: () => void loadAudit(auditLimit),
        })
        : view === 'releases'
        ? h(ReleasesView, {
          state: releases,
          targetName,
          onRefresh: () => void loadReleases(targetName),
          rollbackId,
          onRollback: (release) => void requestRollback(release),
          busy,
        })
        : view === 'editor'
        ? h(EditorView, {
          editor,
          editorValidate,
          editorSave,
          projectId,
          busy,
          hasTarget: Boolean(targetName),
          onReload: () => void loadEditor(projectId),
          onChange: (source) => { setEditor((prev) => ({ ...prev, source, dirty: true })); setEditorValidate(null); setEditorSave(null) },
          onValidate: () => void runEditorValidate(),
          onSave: () => void runEditorSave(),
          onDryRun: () => void startRun(true),
        })
        : view === 'create'
        ? h(CreateView, {
          state: create,
          busy: create.status === 'running',
          onSubmit: (form) => void submitCreate(form),
        })
        : view === 'approvals'
        ? h(ApprovalsView, {
          state: approvals,
          onRefresh: () => void loadApprovals(),
          onApprove: (runId) => void resolveApproval(runId, 'approve'),
          onReject: (runId) => void resolveApproval(runId, 'reject'),
          busy,
        })
        : view === 'rbac'
        ? h(RbacView, {
          state: rbac,
          onRefresh: () => void loadRbac(),
          onRevoke: (user) => void revokeRbacUser(user),
          onVerify: (token) => void verifyRbacToken(token),
          busy,
        })
        : view === 'secrets'
        ? h(SecretsView, {
          state: secrets,
          project: projectId,
          onRefresh: () => void loadSecrets(projectId),
          onSet: (scope, name, value) => void setSecret(scope, name, value),
          busy,
        })
        : view === 'runners'
        ? h(RunnersView, {
          state: runners,
          onRefresh: () => void loadRunners(),
        })
        : h('div', { className: 'cicd-columns' },
          h(OverviewColumn, {
            projects: { ...projects, retry: () => void loadProjects() },
            projectId,
            projectMetas,
            onSelectProject,
            plan,
            onClosePlan: () => setPlan(null),
            onPlanRetry: () => void runPlan(),
            targets: { ...targets, retry: () => void loadTargets(projectId) },
            targetName,
            onSelectTarget,
          }),
          h(RunsDetailColumn, {
            runs: { ...runs, retry: () => void loadRuns(projectId, false) },
            onRefreshRuns: () => void loadRuns(projectId, false),
            selectedRunId,
            onSelectRun: selectRun,
            run: selectedRun,
            stages: runDetail && selectedRun && runDetail.id === selectedRun.id ? runDetail.stages : (selectedRun && Array.isArray(selectedRun.stages) ? selectedRun.stages : []),
            canary: runDetail && selectedRun && runDetail.id === selectedRun.id ? runDetail.canary : null,
            // v3.0-P1：job 图只在跑完/刚发起的那次运行里有；历史运行退回 /log 的分片清单。
            jobs: runDetail && selectedRun && runDetail.id === selectedRun.id ? runDetail.jobs : null,
            logState: log,
            logJobId,
            onSelectJob: (jobId) => setLogJobId(String(jobId || '')),
            onReloadLog: () => void loadLog(selectedRunId, false, logJobId),
            // v3.0-P0：深链 `?line=` 只在「深链指定的那一次运行」上生效，切到别的运行就不再高亮。
            highlightLine: deepLink.current.runId && deepLink.current.runId === selectedRunId ? deepLink.current.line : '',
          }),
          h(ReleasesColumn, {
            state: releases,
            targetName,
            onRefresh: () => void loadReleases(targetName),
            rollbackId,
            onRollback: (release) => void requestRollback(release),
            busy,
          }))

      /**
       * v3.0-P0：左侧视图导航。
       * 原来八个「整页切换」按钮和项目/目标/主机/运行挤在同一条工具条里，权重完全一样，
       * 用户既看不出「哪些是我的操作、哪些是去别的页面」，也不知道自己现在在哪。
       * 现在把「去哪」收进左侧固定栏（aria-current 标当前位置），工具条只留「对当前项目做什么」。
       */
      const pendingApprovals = approvals.items.filter((item) => item.status === 'pending').length
      const navSections = [
        {
          title: '流水线',
          entries: [
            { view: 'run', label: '运行', hint: '阶段 / 运行历史 / 发布三栏' },
            { view: 'releases', label: '发布', hint: '当前目标的发布记录与回滚' },
            { view: 'approvals', label: '审批', hint: '待审批的 prod 部署', badge: pendingApprovals },
          ],
        },
        {
          title: '配置',
          entries: [
            { view: 'editor', label: 'pipe.yml', hint: '在线编辑并校验流水线定义' },
            { view: 'create', label: '新建项目', hint: '登记本地目录或 Git 仓库' },
          ],
        },
        {
          title: '管理',
          entries: [
            { view: 'runners', label: '构建主机', hint: '已注册的 runner 与吊销' },
            { view: 'secrets', label: 'Secrets', hint: '项目级密钥（不回流明文）' },
            { view: 'rbac', label: 'RBAC', hint: 'token 与审计时间线' },
            { view: 'audit', label: '审计', hint: '操作记录与哈希链校验' },
          ],
        },
      ]

      const nav = h('nav', { className: 'cicd-nav', 'aria-label': '流水线视图' },
        ...navSections.map((section, index) => [
          index > 0 ? h('div', { className: 'cicd-nav-sep', key: 'sep-' + section.title }) : null,
          h('div', { className: 'cicd-nav-title', key: 'title-' + section.title }, section.title),
          ...section.entries.map((entry) => h('button', {
            key: entry.view,
            className: 'cicd-nav-item cicd-nav-' + entry.view,
            type: 'button',
            'aria-current': view === entry.view ? 'page' : undefined,
            title: entry.hint,
            onClick: () => goView(entry.view),
          },
          h('span', { className: 'cicd-nav-label' }, entry.label),
          entry.badge ? h('span', { className: 'cicd-nav-badge' }, String(entry.badge)) : null)),
        ]))

      /**
       * 面包屑 + 复制链接。
       * 深链只有在「能看见自己在哪、能把当前地址发给别人」时才算真的可用；
       * 这两件事以前都没有，用户只能靠截图描述自己在哪个页面。
       */
      const currentProject = projects.items.find((project) => project.id === projectId) || null
      const viewEntry = navSections
        .reduce((all, section) => all.concat(section.entries), [])
        .find((entry) => entry.view === view)
      const routeTrail = [
        h('button', {
          key: 'project',
          className: 'cicd-route-link',
          type: 'button',
          onClick: () => goView('run'),
          title: '回到运行视图',
        }, currentProject ? (currentProject.name || currentProject.id) : '未选择项目'),
        h('span', { key: 'sep', 'aria-hidden': 'true' }, '›'),
        h('span', { key: 'view' }, viewEntry ? viewEntry.label : '运行'),
        view === 'run' && selectedRunId
          ? h('span', { key: 'run' }, '› ', h('span', { className: 'cicd-mono' }, selectedRunId))
          : null,
      ]
      const routeBar = h('div', { className: 'cicd-route' },
        routeTrail,
        h('span', { style: { flex: '1 1 auto' } }),
        h('button', {
          className: 'cicd-button cicd-route-copy',
          type: 'button',
          title: '把当前视图的地址复制到剪贴板',
          onClick: () => {
            const hash = buildHash({ project: projectId, view, runId: selectedRunId, target: targetName })
            const link = (typeof window !== 'undefined' && window.location ? window.location.href.split('#')[0] : '') + hash
            const done = () => setAction({ status: 'ok', message: '链接已复制：' + link, error: null })
            const fail = () => setAction({ status: 'error', message: '复制失败，请手动复制地址栏', error: null })
            try {
              if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(link).then(done, fail)
                return
              }
            } catch (error) {
              // 非安全上下文没有 clipboard，退回到提示用户手动复制
            }
            fail()
          },
        }, '复制链接'))

      const main = h('div', { className: 'cicd-main' },
        routeBar,
        toolbar,
        actionBar,
        prodGuardBar,
        body)

      return h('div', { className: 'cicd-page', 'data-dsh-cicd-page': '' },
        h('div', { className: 'cicd-shell' }, nav, main),
        h('div', { className: 'cicd-footer' },
          '数据来自 Host 的 /api/plugins/cicd/*；命令在 Host 本机执行，部署经 dsh-remote 的 SSH 通道送达目标机。'))
    }

    /** 左侧栏全局面板页（`main` 槽的 keyed 页面）。 */
    function CicdPanelPage() {
      return h('div', { className: 'cicd-panel', 'data-dsh-panel-view': PANEL_ID }, h(CicdPage))
    }

    /** 左侧栏字形：把 packages/dsh-cicd/icon.svg 的环状节点造型重画成 16×16。 */
    function CicdPanelIcon({ size }) {
      const edge = typeof size === 'number' && Number.isFinite(size) ? size : 16
      return h('svg', {
        'data-dsh-panel-entry': PANEL_ID,
        viewBox: '0 0 16 16',
        width: edge,
        height: edge,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        style: { display: 'block' },
      },
      h('circle', { cx: 3.6, cy: 8, r: 1.9 }),
      h('circle', { cx: 8, cy: 3.4, r: 1.6 }),
      h('circle', { cx: 8, cy: 12.6, r: 1.6 }),
      h('circle', { cx: 12.4, cy: 8, r: 1.9 }),
      h('path', { d: 'M5.2 7.1 6.9 4.6' }),
      h('path', { d: 'M5.2 8.9 6.9 11.4' }),
      h('path', { d: 'M9.1 4.6 10.8 7.1' }),
      h('path', { d: 'M9.1 11.4 10.8 8.9' }),
      h('path', { d: 'M5.5 8h5' }))
    }

    /** 视图页自己管理样式：apply 里注册，卸载时删除。 */
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      const existing = document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)
      if (existing) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = '@local/dsh-cicd'
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
        ctx.effect(() => installStyles(), 'dsh-cicd: page styles')

        // 会话内视图：沿用 remote / aihot 的既有入口形态。
        ctx.effect(() => ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: PANEL_ID,
          order: 70,
          label: () => '流水线',
        }, CicdPage)), 'dsh-cicd: conversation view')

        // 左侧栏全局面板行：只提供字形，行框 / label / 高亮 / 折叠都属于 shell。
        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 70,
          label: () => '流水线',
        }, CicdPanelIcon)), 'dsh-cicd: pipeline sidebar row')

        // 中心列页面本体：`main` 槽按 key 选面板，只有选中时才挂载。
        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, CicdPanelPage)), 'dsh-cicd: pipeline panel page')
      },
    }
  },
})