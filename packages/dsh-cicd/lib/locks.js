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
 * - v3.0-P7 混沌：库里出任何错（SQLITE_BUSY / 磁盘满 / 文件被换掉）都**当作「这次没拿到锁」**
 *   向外报，而不是把异常抛给上层。反过来说：宁愿拒绝一次发布，也不能在不确定的情况下让两个部署同时写同一批主机。
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

  /**
   * v3.0-P7 混沌：读库失败不能变成「没上锁」。
   * 正常路径一行时延、零分配；只有库里真的出事时才走到 catch。
   */
  function guarded(what, work) {
    try {
      return work()
    } catch (error) {
      return { __dbError: { message: String(error?.message || error || 'unknown'), code: String(error?.code || error?.errno || '') } , __what: what }
    }
  }

  /** 读一行。读不出来时**抛出**——调用方必须区分「没锁」和「不知道有没有锁」。 */
  function readOrThrow(target) {
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
   * 尝试加锁。成功返回 `{ ok: true, lock }`；已被占用返回 `{ ok: false, holder }`；
   * 库不可用返回 `{ ok: false, unavailable: { message } }`。
   * 先清理过期行，所以「上一个进程崩了」不会造成死锁。
   *
   * v3.0-P7：库里出错时**必须**返回 unavailable，绝不能让异常冒泡成 500 —— 那样调用方
   * 分不清「锁表炸了」和「target 被占着」，而且更要紧的是不能让它变成「看起来拿到了锁」。
   */
  function acquire({ target, projectId = '', runId = '', owner = '' } = {}) {
    const key = String(target || '')
    if (!key) throw new Error('acquire 需要 target')
    const result = guarded('acquire', () => {
      const at = nowIso()
      prune(at)
      const existing = readOrThrow(key)
      if (existing) return { ok: false, holder: existing }
      upsert.run(key, String(projectId), String(runId), String(owner), at, plusSeconds(at, ttl()), at)
      return { ok: true, lock: readOrThrow(key) }
    })
    if (result.__dbError) return { ok: false, unavailable: result.__dbError }
    return result
  }

  /** 续期：只有持有者（runId 或 owner 匹配）能续。返回是否续上。读库出错一律按「没续上」。 */
  function heartbeat({ target, runId = '', owner = '' } = {}) {
    const current = guarded('heartbeat', () => readOrThrow(target))
    if (current.__dbError) return false
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
    if (!runId && !owner) return false // 拒绝无条件释放，否则 A 会误删 B 的锁
    const done = guarded('release', () => {
      const current = readOrThrow(target)
      if (!current) return false
      if (runId && current.runId !== String(runId)) return false
      if (!runId && owner && current.owner !== String(owner)) return false
      remove.run(String(target))
      return true
    })
    // 释放失败只意味着这把锁要等 TTL 过期，不改变部署结果，所以这里不抛。
    return done.__dbError ? false : done
  }

  /** 仅供「管理入口强制解锁」使用，必须配合 Admin 判定与审计。读不出来就明说，别假装解掉了。 */
  function forceRelease(target) {
    const done = guarded('forceRelease', () => {
      remove.run(String(target))
      return true
    })
    if (done.__dbError) throw Object.assign(new Error(`解锁失败：${done.__dbError.message}`), { code: 'LOCK_UNAVAILABLE' })
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

  /**
   * v3.0-P7 混沌：列表是运维在「设备不动了」时第一眼要看的东西，所以它不能抛。
   * 读不出来时返回空清单 + 一条 `unavailable`——面板据此说「锁表读不出来」，
   * 而不是显示一个空的锁列表让人以为「根本没锁着」。
   */
  function listGuarded() {
    const done = guarded('list', () => list())
    if (done.__dbError) return { locks: [], unavailable: done.__dbError }
    return { locks: done, unavailable: null }
  }

  /** 供测试与运维排查：随机标识一个「无 runId」的持有者。 */
  function newOwner(prefix = 'lock') {
    return `${prefix}-${randomBytes(4).toString('hex')}`
  }

  return { acquire, heartbeat, release, forceRelease, list, listGuarded, readOrThrow, prune, ttlSec: ttl, newOwner }
}
