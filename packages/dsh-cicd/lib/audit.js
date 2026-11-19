/**
 * 审计日志（v3.0-P0）：追加写的哈希链。
 *
 * 设计要点（见 docs/proposals/cicd-v3/08-security-rbac.md §7）：
 * - 每条记录都记「成功」和「失败」，不允许只在成功路径写审计——否则拒绝行为不可见。
 * - `hash = sha256(prev_hash || canonical_json(record))`，`prev_hash` 是上一条的 hash，首条为 GENESIS。
 * - 只追加，不更新、不删除。篡改任意一行都会让后续链条全部失配，`verify()` 能定位到第一个断点。
 * - 哈希链只能证明「事后没被悄悄改过」，不能防「有 DB 写权限的人整链重算」；
 *   真正的不可否认需要把最新 hash 定期外锚（见 §7.3），本期只做单机可验证。
 *
 * canonical_json：字段顺序固定、无空白，保证同样输入永远得到同样字节。
 */

import { createHash } from 'node:crypto'

export const AUDIT_GENESIS = 'GENESIS'

/** 参与哈希的字段顺序即此处顺序，改动等于换算法（务必同步 verify 与文档）。 */
const CANONICAL_FIELDS = [
  'seq',
  'ts',
  'actor_id',
  'auth_method',
  'token_id',
  'action',
  'resource_type',
  'resource_id',
  'project_id',
  'result',
  'reason',
  'source_ip',
  'request_id',
]

export function canonicalRecord(record = {}) {
  const ordered = {}
  for (const field of CANONICAL_FIELDS) {
    if (field === 'seq') continue // seq 由 AUTOINCREMENT 决定，入哈希会让「重放」不可能
    ordered[field] = record[field] === null || record[field] === undefined ? '' : String(record[field])
  }
  return `${JSON.stringify(ordered)}`
}

export function chainHash(prevHash, record) {
  return createHash('sha256').update(`${prevHash}\n${canonicalRecord(record)}`, 'utf8').digest('hex')
}

export const AUDIT_RESULTS = Object.freeze({ ALLOW: 'allow', DENY: 'deny', ERROR: 'error' })

/**
 * 动作命名统一用 `<resource>.<verb>`，便于按前缀过滤：
 * auth.login / token.create / member.change / secret.read / run.trigger / run.cancel /
 * approval.request / approval.decide / deploy.start / deploy.success / deploy.fail /
 * deploy.rollback / config.change / runner.register / runner.revoke / policy.deny
 */
export function createAudit({ db } = {}) {
  if (!db) throw new Error('createAudit 需要 db 句柄')
  const insert = db.prepare(`INSERT INTO audit_events
    (ts, actor_id, auth_method, token_id, action, resource_type, resource_id, project_id, result, reason, source_ip, request_id, prev_hash, hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const selectLast = db.prepare('SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1')
  const selectAll = db.prepare('SELECT * FROM audit_events ORDER BY seq ASC')

  function tail() {
    const row = selectLast.get()
    return row ? { seq: Number(row.seq), hash: String(row.hash) } : { seq: 0, hash: AUDIT_GENESIS }
  }

  /**
   * 追加一条审计。返回落库后的完整记录（含 seq 与 hash）。
   * 这里刻意不吞异常：写不进审计的操作方应当失败（fail-closed），而不是「先干活后补记录」。
   */
  function record(event = {}) {
    const prev = tail()
    const row = {
      ts: String(event.ts || new Date().toISOString()),
      actor_id: String(event.actorId ?? event.actor_id ?? ''),
      auth_method: String(event.authMethod ?? event.auth_method ?? ''),
      token_id: String(event.tokenId ?? event.token_id ?? ''),
      action: String(event.action || ''),
      resource_type: String(event.resourceType ?? event.resource_type ?? ''),
      resource_id: String(event.resourceId ?? event.resource_id ?? ''),
      project_id: String(event.projectId ?? event.project_id ?? ''),
      result: String(event.result || AUDIT_RESULTS.ALLOW),
      reason: String(event.reason || ''),
      source_ip: String(event.sourceIp ?? event.source_ip ?? ''),
      request_id: String(event.requestId ?? event.request_id ?? ''),
    }
    if (!row.action) throw new Error('审计记录缺少 action')
    const hash = chainHash(prev.hash, row)
    insert.run(
      row.ts, row.actor_id, row.auth_method, row.token_id, row.action, row.resource_type,
      row.resource_id, row.project_id, row.result, row.reason, row.source_ip, row.request_id,
      prev.hash, hash,
    )
    const last = tail()
    return { ...row, seq: last.seq, prev_hash: prev.hash, hash }
  }

  /**
   * 全链校验：重算每条的 hash 并与相邻 prev_hash 对齐。
   * 返回第一个断点，便于运维直接定位「从哪条开始不可信」。
   */
  function verify({ limit = 0 } = {}) {
    const rows = selectAll.all()
    const scanned = limit > 0 ? rows.slice(0, limit) : rows
    let prevHash = AUDIT_GENESIS
    for (const raw of scanned) {
      const row = {
        ts: String(raw.ts ?? ''),
        actor_id: String(raw.actor_id ?? ''),
        auth_method: String(raw.auth_method ?? ''),
        token_id: String(raw.token_id ?? ''),
        action: String(raw.action ?? ''),
        resource_type: String(raw.resource_type ?? ''),
        resource_id: String(raw.resource_id ?? ''),
        project_id: String(raw.project_id ?? ''),
        result: String(raw.result ?? ''),
        reason: String(raw.reason ?? ''),
        source_ip: String(raw.source_ip ?? ''),
        request_id: String(raw.request_id ?? ''),
      }
      const expected = chainHash(prevHash, row)
      if (String(raw.prev_hash ?? '') !== prevHash) {
        return { ok: false, count: scanned.length, brokenSeq: Number(raw.seq), kind: 'prev_hash', expected: prevHash, actual: String(raw.prev_hash ?? '') }
      }
      if (String(raw.hash ?? '') !== expected) {
        return { ok: false, count: scanned.length, brokenSeq: Number(raw.seq), kind: 'hash', expected, actual: String(raw.hash ?? '') }
      }
      prevHash = expected
    }
    return { ok: true, count: scanned.length, tail: prevHash }
  }

  function list({ project = '', actor = '', action = '', result = '', limit = 100 } = {}) {
    const clauses = []
    const params = []
    if (project) { clauses.push('project_id = ?'); params.push(project) }
    if (actor) { clauses.push('actor_id = ?'); params.push(actor) }
    if (action) { clauses.push('(action = ? OR action LIKE ?)'); params.push(action, `${action}.%`) }
    if (result) { clauses.push('result = ?'); params.push(result) }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const sql = `SELECT * FROM audit_events ${where} ORDER BY seq DESC LIMIT ?`
    return db.prepare(sql).all(...params, Math.max(1, Math.min(1000, Number(limit) || 100))).map((row) => ({
      seq: Number(row.seq),
      ts: String(row.ts ?? ''),
      actorId: String(row.actor_id ?? ''),
      authMethod: String(row.auth_method ?? ''),
      tokenId: String(row.token_id ?? ''),
      action: String(row.action ?? ''),
      resourceType: String(row.resource_type ?? ''),
      resourceId: String(row.resource_id ?? ''),
      projectId: String(row.project_id ?? ''),
      result: String(row.result ?? ''),
      reason: String(row.reason ?? ''),
      sourceIp: String(row.source_ip ?? ''),
      requestId: String(row.request_id ?? ''),
      prevHash: String(row.prev_hash ?? ''),
      hash: String(row.hash ?? ''),
    }))
  }

  function stats() {
    const row = db.prepare('SELECT COUNT(*) AS n FROM audit_events').get()
    const denied = db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE result = 'deny'").get()
    return { events: Number(row?.n ?? 0), denied: Number(denied?.n ?? 0), tail: tail().hash }
  }

  return { record, verify, list, stats, tail }
}
