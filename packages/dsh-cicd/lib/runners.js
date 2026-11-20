/**
 * v3.0-P0：远端构建机（runner）注册表——落库版。
 *
 * 为什么必须落库：v2 的 runner 列表只活在 `createTaskBroker` 的内存 Map 里，
 * 后果有三个，每一个都真实发生过：
 *   1. 服务重启后所有 runner 消失，正在跑的远端任务永远等不到结果；
 *   2. 无法「吊销」某台构建机——重启前注册过的机器重启后照样能领任务；
 *   3. 机器拔电后状态永远是 online，调度器会把任务派给一台死机器。
 *
 * 三条设计约束：
 *   1. **吊销是持久且立即生效的**：`revoke()` 写库，`isRunnable()` 每次都读库（有 1s 缓存）。
 *      吊销后立刻不能领任务、不能收结果，不需要等任何超时——这是安全事故场景，不能靠 TTL。
 *   2. **online 是推导值，不是存储值**：库里的 `status` 只记 `active` / `revoked`，
 *      online/offline 由 `last_seen_at` 与心跳周期实时算出来，避免「库说 online 其实机器早没了」。
 *   3. **判定阈值 = 3 × 心跳周期**：低于 3 个周期会有网络抖动误杀，高于 3 个周期
 *      派给死机器的窗口太长（验收项 ⑧ 就写的是 3×）。
 */

import { randomBytes, createHash } from 'node:crypto'

/** 默认心跳周期（秒）：runner 端每 30s 至少 poll 一次，poll 兼作心跳。 */
export const DEFAULT_HEARTBEAT_SEC = 30
/** 判死阈值：3 × 心跳周期。 */
export const OFFLINE_MULTIPLIER = 3
/**
 * 缓存窗口：避免每次调度都打一次 DB。
 * 缓存里存的是**行**，不是结论——offline/online 是时间的函数，每次读都按此刻重算。
 * 这一点曾经写错过：缓存了算好的 status 之后，一个早就过了心跳阈值的 runner
 * 会在整个窗口里继续显示 online，判死被缓存拖后（而且拖多久取决于窗口有多长）。
 */
const CACHE_TTL_MS = 1000

export const RUNNER_STATUS = {
  ACTIVE: 'active',
  REVOKED: 'revoked',
}

/** 注册表的时钟。测试会注入一个「跳着走」的假时钟，所以这里不能直接用 Date.now()。 */
function nowIso(now) {
  return new Date(now()).toISOString()
}


function parseTime(value) {
  const n = Date.parse(String(value || ''))
  return Number.isFinite(n) ? n : 0
}

/**
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.db
 * @param {number} [options.heartbeatSec] 心跳周期（秒），默认 30
 * @param {() => number} [options.now] 注入时钟，测试用
 */
export function createRunnerRegistry({ db, heartbeatSec = DEFAULT_HEARTBEAT_SEC, now = Date.now } = {}) {
  if (!db) throw new Error('createRunnerRegistry 需要 db')
  const intervalSec = Number.isFinite(heartbeatSec) && heartbeatSec > 0 ? Math.trunc(heartbeatSec) : DEFAULT_HEARTBEAT_SEC
  const staleMs = intervalSec * OFFLINE_MULTIPLIER * 1000

  const stmts = {
    upsert: db.prepare(`
      INSERT INTO runners (runner_id, labels, version, capacity, status, registered_at, last_seen_at, revoked_at, revoked_by)
      VALUES (?, ?, ?, ?, 'active', ?, ?, '', '')
      ON CONFLICT(runner_id) DO UPDATE SET
        labels = excluded.labels,
        version = excluded.version,
        capacity = excluded.capacity,
        last_seen_at = excluded.last_seen_at,
        status = CASE WHEN runners.status = 'revoked' THEN 'revoked' ELSE 'active' END
    `),
    touch: db.prepare(`UPDATE runners SET last_seen_at = ? WHERE runner_id = ?`),
    selectOne: db.prepare(`SELECT * FROM runners WHERE runner_id = ?`),
    selectAll: db.prepare(`SELECT * FROM runners ORDER BY runner_id`),
    revoke: db.prepare(`UPDATE runners SET status = 'revoked', revoked_at = ?, revoked_by = ? WHERE runner_id = ?`),
    remove: db.prepare(`DELETE FROM runners WHERE runner_id = ?`),
  }

  let cache = null
  let cacheAt = 0

  function invalidate() {
    cache = null
    cacheAt = 0
  }

  /**
   * 把库里的行变成对外的形状。**每次调用都重算 online/offline**——判死是时间的函数，
   * 不是那一行的属性。以前缓存里存的是算好的 status，于是缓存窗口一到就漏判：
   * 现在缓存只存「这一行是什么」，要不要判死由读取的那一刻决定。
   */
  function shape(row) {
    if (!row) return null
    const lastSeen = parseTime(row.last_seen_at)
    const revoked = String(row.status || '') === RUNNER_STATUS.REVOKED
    const stale = !lastSeen || now() - lastSeen > staleMs
    return {
      runnerId: String(row.runner_id || ''),
      labels: String(row.labels || '').split(',').map((item) => item.trim()).filter(Boolean),
      version: String(row.version || ''),
      capacity: Number(row.capacity || 1) || 1,
      // 库里的 status 只表达 active/revoked；online/offline 由时间推导。
      lifecycle: revoked ? RUNNER_STATUS.REVOKED : RUNNER_STATUS.ACTIVE,
      status: revoked ? 'revoked' : stale ? 'offline' : 'online',
      revoked: revoked,
      stale: stale,
      registeredAt: String(row.registered_at || ''),
      lastSeenAt: String(row.last_seen_at || ''),
      revokedAt: String(row.revoked_at || ''),
      revokedBy: String(row.revoked_by || ''),
      heartbeatSec: intervalSec,
      offlineAfterSec: intervalSec * OFFLINE_MULTIPLIER,
    }
  }

  function load() {
    const stamp = now()
    // 缓存的是**行**，不是结论：形状与 online/offline 每次读都按此刻重算。
    // （缓存算好的 status 会把判死拖后整个窗口——窗口多长就晚多久。）
    const fresh = cache && stamp >= cacheAt && stamp - cacheAt < CACHE_TTL_MS
    if (!fresh) {
      cache = stmts.selectAll.all()
      cacheAt = stamp
    }
    return cache.map((row) => shape(row))
  }

  /** 注册（幂等）：吊销过的 runner 重新注册**不会**复活，必须先 unrevoke（手工改库或重新加入）。 */
  function register(runnerId, { labels = [], version = '', capacity = 1 } = {}) {
    const id = String(runnerId || '').trim()
    if (!id) throw Object.assign(new Error('runnerId 不能为空'), { code: 'RUNNER_NOT_FOUND' })
    const labelText = Array.isArray(labels) ? labels.join(',') : String(labels || '').split(',').map((s) => s.trim()).filter(Boolean).join(',')
    const cap = Number.isInteger(capacity) && capacity > 0 ? capacity : 1
    const stamp = nowIso(now)
    stmts.upsert.run(id, labelText, String(version || ''), cap, stamp, stamp)
    invalidate()
    const row = shape(stmts.selectOne.get(id))
    if (row && row.revoked) {
      throw Object.assign(new Error(`runner ${id} 已被吊销，不能重新注册`), { code: 'RUNNER_REVOKED' })
    }
    return row
  }

  /** 心跳（poll 兼心跳）：吊销的 runner 心跳直接拒绝。 */
  function heartbeat(runnerId) {
    const id = String(runnerId || '').trim()
    if (!id) return null
    const row = shape(stmts.selectOne.get(id))
    if (!row) return null
    if (row.revoked) throw Object.assign(new Error(`runner ${id} 已被吊销`), { code: 'RUNNER_REVOKED' })
    stmts.touch.run(nowIso(now), id)
    invalidate()
    return { ...row, lastSeenAt: nowIso(now), status: 'online', stale: false }
  }

  function describe(runnerId) {
    const id = String(runnerId || '').trim()
    if (!id) return null
    return shape(stmts.selectOne.get(id))
  }

  function list({ includeRevoked = true } = {}) {
    const rows = load()
    return (includeRevoked ? rows : rows.filter((row) => !row.revoked)).slice()
  }

  /** 吊销：立即生效、持久、可在审计里查到是谁吊销的。 */
  function revoke(runnerId, { by = '', reason = '' } = {}) {
    const id = String(runnerId || '').trim()
    const row = describe(id)
    if (!row) throw Object.assign(new Error(`runner ${id} 不存在`), { code: 'RUNNER_NOT_FOUND' })
    stmts.revoke.run(nowIso(now), String(by || ''), id)
    invalidate()
    return { ...describe(id), reason: String(reason || '') }
  }

  /** 永久删除（用于测试与清理误注册）。 */
  function remove(runnerId) {
    const id = String(runnerId || '').trim()
    stmts.remove.run(id)
    invalidate()
    return { ok: true, runnerId: id }
  }

  /**
   * 调度判定：能不能把任务派给这台 runner。
   * 注意 stale（心跳超时）与 revoked（吊销）是两种不同的拒绝原因，调用方要能区分。
   */
  function isRunnable(runnerId) {
    const row = describe(runnerId)
    if (!row) return { ok: false, code: 'RUNNER_NOT_FOUND', message: `runner ${runnerId} 未注册` }
    if (row.revoked) return { ok: false, code: 'RUNNER_REVOKED', message: `runner ${runnerId} 已被吊销（${row.revokedBy || '未知操作者'}）` }
    if (row.stale) {
      return { ok: false, code: 'RUNNER_OFFLINE', message: `runner ${runnerId} 已 ${Math.round((now() - parseTime(row.lastSeenAt)) / 1000)}s 未心跳（阈值 ${intervalSec * OFFLINE_MULTIPLIER}s）` }
    }
    return { ok: true, runner: row }
  }

  /** 把「派生状态」写回一次，让 DB 里的 status 不至于永远停在 active（可选，供巡检调用）。 */
  function sweep() {
    const rows = list()
    const counts = { online: 0, offline: 0, revoked: 0 }
    for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1
    return counts
  }

  return {
    register,
    heartbeat,
    describe,
    list,
    revoke,
    remove,
    isRunnable,
    sweep,
    invalidate,
    heartbeatSec: intervalSec,
    offlineAfterSec: intervalSec * OFFLINE_MULTIPLIER,
  }
}

/** runner 注册时下发的一次性 join token 摘要（与 lib/auth.js 的 token 存储策略一致：只存摘要）。 */
export function hashRunnerToken(token) {
  return createHash('sha256').update(String(token || '')).digest('hex')
}

/** 生成 runner join token（前缀区分用途，便于在日志里识别类型而不泄漏值）。 */
export function makeRunnerToken() {
  return `run-${randomBytes(16).toString('hex')}`
}
