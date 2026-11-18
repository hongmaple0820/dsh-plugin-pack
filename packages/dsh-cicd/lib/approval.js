/**
 * 审批（block gate）状态机。
 *
 * 生产环境默认 manual: true：deploy 到 prod 阶段会停在「待审批」，
 * 面板点「通过」才继续；未授权环境无法部署。
 *
 * 审批记录落 store（operations 表 action='approval'），
 * 面板通过 /approve 路由写操作解除阻塞。
 */

import { randomBytes } from 'node:crypto'

export const APPROVAL_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
}

export function makeApprovalId(now = Date.now()) {
  return `appr-${new Date(now).toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(3).toString('hex')}`
}

export function createApprovalGate() {
  const pending = new Map() // runId -> { id, project, target, requestedAt, requestedBy, status, resolvedAt, resolvedBy, detail }

  function request({ runId, project, target, requestedBy = '', detail = '' }) {
    const now = new Date().toISOString()
    const approval = {
      id: makeApprovalId(),
      runId,
      project,
      target,
      requestedAt: now,
      requestedBy,
      status: APPROVAL_STATUS.PENDING,
      resolvedAt: '',
      resolvedBy: '',
      detail,
    }
    pending.set(runId, approval)
    return approval
  }

  function resolve({ runId, approved, resolvedBy = '', detail = '' }) {
    const approval = pending.get(runId)
    if (!approval) return null
    approval.status = approved ? APPROVAL_STATUS.APPROVED : APPROVAL_STATUS.REJECTED
    approval.resolvedAt = new Date().toISOString()
    approval.resolvedBy = resolvedBy
    approval.detail = detail || approval.detail
    return approval
  }

  function isPending(runId) {
    const approval = pending.get(runId)
    return Boolean(approval && approval.status === APPROVAL_STATUS.PENDING)
  }

  function get(runId) {
    return pending.get(runId) || null
  }

  function list({ project = '', status = '' } = {}) {
    const rows = []
    for (const approval of pending.values()) {
      if (project && approval.project !== project) continue
      if (status && approval.status !== status) continue
      rows.push(approval)
    }
    rows.sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))
    return rows.slice(0, 50)
  }

  function dispose() {
    pending.clear()
  }

  return { request, resolve, isPending, get, list, dispose }
}
