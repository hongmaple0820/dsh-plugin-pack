/**
 * 部署锁（v3.0-P0）：把 v2 的进程内 `Map` 换成 SQLite 表。
 *
 * 为什么必须落库：`deployLocks` 原本是 `index.js` 里的 `new Map()`，进程重启即清空、
 * 多副本部署时各进程互相看不见。两个 Admin 同时点「部署 prod」不会互相阻塞——这是 v2 最实际的事故来源。
 *
 * 语义：
 * - 互斥键是 `target`（目标名），与 v1 行为一致；同一 target 同时只允许一次部署。
 * - 锁带 TTL（默认 30 分钟，可用 `ttlSec` 覆盖）与心跳（`heartbeat()` 续期）。
 * - 过期锁可被抢占（`acquire()` 先删过期行再插入），避免进程被杀后永久死锁。
 * - `release()` 只释放自己持有的锁（比对 runId/owner），防止 A 超时后 B 抢到、A 结束时误删 B 的锁。
 */

import { randomBytes } from 'node:crypto'

export const DEFAULT_LOCK_TTL_SEC = 30 * 60

function nowIso() {
  return new Date().toISOString()
}

function plusSeconds(iso, sec) {
  return new Date(new Date(iso).getTime() + sec * 1000).toISOString()
}

export function createDeployLocks({ db, ttlSec = DEFAULT_LOCK_TTL_SEC } = {}) {
  if (!db) throw new Error('createDeployLocks 需要 db 句柄')
  const ttl = () => (Number(ttlSec) > 0 ? Number(ttlSec) : DEFAULT_LOCK_TTL_SEC)
  const select = db.prepare('SELECT * FROM deploy_locks WHERE target = ?')
  const remove = db.prepare('DELETE FROM deploy_locks WHERE target = ?')
  const removeExpired = db.prepare('DELETE FROM deploy_locks WHERE expires_at <= ?')
  const upsert = db.prepare(`INSERT INTO deploy_locks (target, project_id, run_id, owner, acquired_at, expires_at, heartbeat_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(target) DO UPDATE SET project_id = excluded.project_id, run_id = excluded.run_id, owner = excluded.owner,
      acquired_at = excluded.acquired_at, expires_at = excluded.expires_at, heartbeat_at = excluded.heartbeat_at`)
  const touch = db.prepare('UPDATE deploy_locks SET expires_at = ?, heartbeat_at = ? WHERE target = ? AND run_id = ?')

  function read(target) {
    const row = select.get(String(target))
    return row ? {
      target: String(row.target),
      projectId: String(row.project_id ?? ''),
      runId: String(row.run_id ?? ''),
      owner: String(row.owner ?? ''),
      acquiredAt: String(row.acquired_at ?? ''),
      expiresAt: String(row.expires_at ?? ''),
      heartbeatAt: String(row.heartbeat_at ?? ''),
    } : null
  }

  function prune(now = nowIso()) {
    const info = removeExpired.run(now)
    return Number(info?.changes ?? 0)
  }

  /**
   * 尝试加锁。成功返回 `{ ok: true, lock }`；已被占用返回 `{ ok: false, holder }`。
   * 先清理过期行，所以「上一个进程崩了」不会造成死锁。
   */
  function acquire({ target, projectId = '', runId = '', owner = '' } = {}) {
    const key = String(target || '')
    if (!key) throw new Error('acquire 需要 target')
    const at = nowIso()
    prune(at)
    const existing = read(key)
    if (existing) return { ok: false, holder: existing }
    upsert.run(key, String(projectId), String(runId), String(owner), at, plusSeconds(at, ttl()), at)
    return { ok: true, lock: read(key) }
  }

  /** 续期：只有持有者（runId 或 owner 匹配）能续。返回是否续上。 */
  function heartbeat({ target, runId = '', owner = '' } = {}) {
    const current = read(target)
    if (!current) return false
    const mineRun = runId && current.runId === String(runId)
    const mineOwner = !runId && owner && current.owner === String(owner)
    if (!mineRun && !mineOwner) return false
    const at = nowIso()
    touch.run(plusSeconds(at, ttl()), at, String(target), current.runId)
    return true
  }

  /** 释放：只删自己那把锁。runId 与 owner 都给则两者都要匹配（owner 用于「无 runId 的临时锁」）。 */
  function release({ target, runId = '', owner = '' } = {}) {
    const current = read(target)
    if (!current) return false
    if (runId && current.runId !== String(runId)) return false
    if (!runId && owner && current.owner !== String(owner)) return false
    if (!runId && !owner) return false // 拒绝无条件释放，否则 A 会误删 B 的锁
    remove.run(String(target))
    return true
  }

  /** 仅供「管理入口强制解锁」使用，必须配合 Admin 判定与审计。 */
  function forceRelease(target) {
    remove.run(String(target))
    return true
  }

  function list() {
    return db.prepare('SELECT * FROM deploy_locks ORDER BY acquired_at DESC').all().map((row) => ({
      target: String(row.target),
      projectId: String(row.project_id ?? ''),
      runId: String(row.run_id ?? ''),
      owner: String(row.owner ?? ''),
      acquiredAt: String(row.acquired_at ?? ''),
      expiresAt: String(row.expires_at ?? ''),
      heartbeatAt: String(row.heartbeat_at ?? ''),
      expired: String(row.expires_at ?? '') <= nowIso(),
    }))
  }

  /** 供测试与运维排查：随机标识一个「无 runId」的持有者。 */
  function newOwner(prefix = 'lock') {
    return `${prefix}-${randomBytes(4).toString('hex')}`
  }

  return { acquire, heartbeat, release, forceRelease, list, read, prune, ttlSec: ttl, newOwner }
}
