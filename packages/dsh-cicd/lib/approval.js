/**
 * 审批（block gate）状态机 —— v3.0-P0 落库版。
 *
 * 设计要点（每条都对应一个真实事故）：
 * 1. **绑 artifact digest，不绑 run**。run 可以重跑，digest 不会；审批闸门保护的是
 *    「这批字节能不能上生产」，同一份审批不能被另一个 digest 复用。
 * 2. **必须有 TTL**。没有超时的审批会让 run 永远停在 pending，面板上看不出
 *    「是在等人还是在死等」。到期由 resolveExpired() 落成 approval_timeout。
 * 3. **禁自批**。requested_by === decided_by 直接拒绝（服务端校验，不靠 UI 隐藏按钮）。
 * 4. **一次性消费**。批准后 consumed_at 立即写入，同一审批不能给第二次部署放行。
 * 5. 内存 Map 只是缓存：所有判断先读 DB，进程重启后审批不会凭空消失。
 *
 * 表结构见 lib/db.js `approvals`。
 */

import { randomBytes } from 'node:crypto'
import { text } from './db.js'

export const APPROVAL_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  CONSUMED: 'consumed',
}

/** 默认审批有效期：4 小时。够覆盖一次正常发版，又不至于让人第二天还能批昨天的包。 */
export const DEFAULT_APPROVAL_TTL_SEC = 4 * 60 * 60

export function makeApprovalId(now = Date.now()) {
  return `appr-${new Date(now).toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(3).toString('hex')}`
}

function rowToApproval(row) {
  if (!row) return null
  return {
    id: text(row.id),
    runId: text(row.run_id),
    project: text(row.project_id),
    target: text(row.target),
    artifactDigest: text(row.artifact_digest),
    status: text(row.status),
    requestedBy: text(row.requested_by),
    requestedAt: text(row.requested_at),
    expiresAt: text(row.expires_at),
    decidedBy: text(row.decided_by),
    decidedAt: text(row.decided_at),
    reason: text(row.reason),
    detail: text(row.detail),
    consumedAt: text(row.consumed_at),
  }
}

function iso(ms) {
  return new Date(ms).toISOString()
}

export function createApprovalGate({ db, ttlSec = DEFAULT_APPROVAL_TTL_SEC, now = () => Date.now() } = {}) {
  if (!db) throw new Error('createApprovalGate 需要 db（审批必须落库，内存 Map 会在重启后丢失）')

  const stmt = {
    insert: db.prepare(
      `INSERT INTO approvals (id, run_id, project_id, target, artifact_digest, status, requested_by, requested_at, expires_at, decided_by, decided_at, reason, detail, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '', ?, '')`,
    ),
    byId: db.prepare('SELECT * FROM approvals WHERE id = ?'),
    byRun: db.prepare('SELECT * FROM approvals WHERE run_id = ? ORDER BY requested_at DESC LIMIT 1'),
    pendingByDigest: db.prepare(
      `SELECT * FROM approvals WHERE artifact_digest = ? AND status = 'approved' AND consumed_at = '' ORDER BY decided_at DESC LIMIT 1`,
    ),
    decide: db.prepare(
      `UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, reason = ? WHERE id = ? AND status = 'pending'`,
    ),
    consume: db.prepare(`UPDATE approvals SET consumed_at = ?, status = 'consumed' WHERE id = ? AND consumed_at = ''`),
    expire: db.prepare(
      `UPDATE approvals SET status = 'expired', reason = 'approval_timeout', decided_at = ? WHERE status = 'pending' AND expires_at <= ?`,
    ),
    selectExpiring: db.prepare(
      `SELECT * FROM approvals WHERE status = 'pending' AND expires_at <= ? ORDER BY expires_at ASC LIMIT 50`,
    ),
    list: db.prepare(
      `SELECT * FROM approvals WHERE ($project = '' OR project_id = $project) AND ($status = '' OR status = $status)
       ORDER BY requested_at DESC LIMIT $limit`,
    ),
  }

  /** 把所有已过期的 pending 落成 expired；返回刚过期的行，便于调用方写审计/通知。 */
  function resolveExpired(at = now()) {
    const stamp = iso(at)
    const rows = stmt.selectExpiring.all(stamp).map(rowToApproval)
    if (rows.length > 0) stmt.expire.run(stamp, stamp)
    return rows
  }

  /**
   * 申请审批。同一个 runId 已有 pending 时返回既有的，避免重复点「运行」堆出一排卡片。
   */
  function request({ runId = '', project = '', target = '', artifactDigest = '', requestedBy = '', detail = '', ttlSec: overrideTtl = 0 } = {}) {
    if (!target) {
      const error = new Error('审批需要 target')
      error.code = 'COMMAND_INVALID'
      throw error
    }
    resolveExpired()
    if (runId) {
      const existing = rowToApproval(stmt.byRun.get(runId))
      if (existing && existing.status === APPROVAL_STATUS.PENDING) return existing
    }
    const ttl = Number(overrideTtl) > 0 ? Number(overrideTtl) : ttlSec
    const at = now()
    const approval = {
      id: makeApprovalId(at),
      runId,
      project,
      target,
      artifactDigest,
      status: APPROVAL_STATUS.PENDING,
      requestedBy,
      requestedAt: iso(at),
      expiresAt: iso(at + ttl * 1000),
      decidedBy: '',
      decidedAt: '',
      reason: '',
      detail: String(detail || ''),
      consumedAt: '',
    }
    stmt.insert.run(
      approval.id, approval.runId, approval.project, approval.target, approval.artifactDigest,
      approval.status, approval.requestedBy, approval.requestedAt, approval.expiresAt, approval.detail,
    )
    return approval
  }

  /**
   * 决策。返回 `{ ok, approval, code, message }`——刻意不抛异常，
   * 让路由层把「自批」「已消费」「过期」都映射成不同 4xx。
   */
  function resolve({ id = '', runId = '', approved, resolvedBy = '', reason = '', detail = '' } = {}) {
    resolveExpired()
    const row = id ? rowToApproval(stmt.byId.get(id)) : rowToApproval(stmt.byRun.get(runId))
    if (!row) return { ok: false, code: 'APPROVAL_NOT_FOUND', message: `审批 ${id || runId} 不存在` }
    if (row.status === APPROVAL_STATUS.CONSUMED) return { ok: false, code: 'APPROVAL_CONSUMED', message: '该审批已被消费，需重新申请', approval: row }
    if (row.status !== APPROVAL_STATUS.PENDING) {
      return { ok: false, code: 'APPROVAL_NOT_PENDING', message: `审批当前状态是 ${row.status}`, approval: row }
    }
    // 禁自批：服务端校验，不依赖 UI 隐藏按钮。
    if (resolvedBy && row.requestedBy && resolvedBy === row.requestedBy) {
      return { ok: false, code: 'SELF_APPROVAL_FORBIDDEN', message: '不能批准自己发起的审批', approval: row }
    }
    const status = approved ? APPROVAL_STATUS.APPROVED : APPROVAL_STATUS.REJECTED
    const changed = stmt.decide.run(status, String(resolvedBy || ''), iso(now()), String(reason || detail || ''), row.id)
    if (Number(changed?.changes ?? 0) === 0) {
      return { ok: false, code: 'APPROVAL_NOT_PENDING', message: '审批状态已被他人改变', approval: row }
    }
    return { ok: true, approval: { ...row, status, decidedBy: String(resolvedBy || ''), decidedAt: iso(now()), reason: String(reason || detail || '') } }
  }

  /** 部署真正开始前调用：把 approved 的审批标注消费掉，返回是否允许放行。 */
  function consume({ id = '', digest = '' } = {}) {
    resolveExpired()
    const row = id ? rowToApproval(stmt.byId.get(id)) : rowToApproval(stmt.pendingByDigest.get(digest))
    if (!row) return { ok: false, code: 'APPROVAL_REQUIRED', message: '需要审批后才能部署' }
    if (row.status === APPROVAL_STATUS.CONSUMED) return { ok: false, code: 'APPROVAL_CONSUMED', message: '审批已被消费', approval: row }
    if (row.status !== APPROVAL_STATUS.APPROVED) {
      return { ok: false, code: row.status === APPROVAL_STATUS.EXPIRED ? 'APPROVAL_EXPIRED' : 'APPROVAL_REQUIRED', message: `审批状态 ${row.status}`, approval: row }
    }
    // 审批可能在「产物还没构建出来」时就申请了，此时 digest 为空：首次消费时绑定，
    // 之后同一审批不可能再用于另一个 digest（它已经 consumed）。
    if (!row.artifactDigest && digest) {
      db.prepare('UPDATE approvals SET artifact_digest = ? WHERE id = ?').run(String(digest), row.id)
      row.artifactDigest = String(digest)
    }
    if (digest && row.artifactDigest && digest !== row.artifactDigest) {
      return { ok: false, code: 'APPROVAL_DIGEST_MISMATCH', message: '审批绑定的产物与本次部署不一致', approval: row }
    }
    const changed = stmt.consume.run(iso(now()), row.id)
    if (Number(changed?.changes ?? 0) === 0) return { ok: false, code: 'APPROVAL_CONSUMED', message: '审批已被并发消费', approval: row }
    return { ok: true, approval: { ...row, status: APPROVAL_STATUS.CONSUMED, consumedAt: iso(now()) } }
  }

  function isPending(runId) {
    resolveExpired()
    const row = rowToApproval(stmt.byRun.get(runId))
    return Boolean(row && row.status === APPROVAL_STATUS.PENDING)
  }

  function get(idOrRunId) {
    if (!idOrRunId) return null
    return rowToApproval(stmt.byId.get(idOrRunId)) || rowToApproval(stmt.byRun.get(idOrRunId))
  }

  function list({ project = '', status = '', limit = 50 } = {}) {
    resolveExpired()
    return stmt.list.all({ project, status, limit: Math.max(1, Math.min(200, Number(limit) || 50)) }).map(rowToApproval)
  }

  function stats() {
    resolveExpired()
    const rows = db.prepare('SELECT status, COUNT(*) AS n FROM approvals GROUP BY status').all()
    const out = { total: 0, pending: 0, approved: 0, rejected: 0, expired: 0, consumed: 0 }
    for (const row of rows) {
      const n = Number(row.n) || 0
      out[text(row.status)] = n
      out.total += n
    }
    return out
  }

  function dispose() { /* 落库，无内存态需要清理（未决审批保留，属于业务数据） */ }

  return { request, resolve, consume, isPending, get, list, stats, resolveExpired, dispose, ttlSec }
}
