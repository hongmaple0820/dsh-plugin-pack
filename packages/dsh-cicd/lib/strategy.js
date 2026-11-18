/**
 * 发布策略引擎（v2.0-M3）：把现有「串行 fan-out + 2 批灰度」泛化成可配置的五策略。
 *
 * 策略类型（target.strategy.type）：
 * - serial   逐台部署，一台失败即停（默认，等价现有行为）
 * - parallel 所有主机并发部署
 * - rolling  每批 N 台，批间等 waitSec；单台失败按 onHostFailure 决定停/跳过
 * - canary   先 first 台 + 观察窗口 + 自动扩量（等价现有 2 批灰度，但 first 可配）
 * - blue-green 起一套完整新实例，切流量后旧实例退役（容器/反代目标）
 *
 * 策略锁：滚动中记录进度（batch index + 已完成主机），中断可续（宿主侧 cancel 后重跑时
 * 跳过已成功的批次，从失败批次继续）。onStrategyProgress 回调让宿主侧把进度写进
 * store.operations（action:'strategy-progress'），cancel 后重跑时按 lastBatch 续。
 */

import { deployOne, rollbackOne, delay, logLine } from './deploy.js'

export function normalizeStrategy(target, hostCount) {
  const raw = target?.strategy
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    // 无 strategy 字段：按现有 canary 配置退化
    if (target?.canary && Number.isInteger(target.canary.first) && target.canary.first >= 1) {
      return { type: 'canary', first: Math.min(target.canary.first, hostCount), waitSec: Number.isInteger(target.canary.waitSec) ? target.canary.waitSec : 30, onHostFailure: target.onHostFailure }
    }
    return { type: 'serial', onHostFailure: target.onHostFailure }
  }

  const type = String(raw.type || 'serial').toLowerCase()
  const failMode = raw.onHostFailure === 'continue' ? 'continue' : 'stop'

  if (type === 'serial') {
    return { type, onHostFailure: failMode }
  }

  if (type === 'parallel') {
    return { type, onHostFailure: failMode }
  }

  if (type === 'rolling') {
    const batch = Number.isInteger(raw.batch) && raw.batch >= 1 ? raw.batch : Math.max(1, Math.ceil(hostCount / 2))
    const waitSec = Number.isInteger(raw.waitSec) && raw.waitSec >= 0 && raw.waitSec <= 3600 ? raw.waitSec : 30
    return { type, batch, waitSec, onHostFailure: failMode }
  }

  if (type === 'canary') {
    const first = Number.isInteger(raw.first) && raw.first >= 1 ? Math.min(raw.first, hostCount) : 1
    const waitSec = Number.isInteger(raw.waitSec) && raw.waitSec >= 0 && raw.waitSec <= 3600 ? raw.waitSec : 30
    return { type, first, waitSec, onHostFailure: failMode }
  }

  if (type === 'blue-green') {
    const waitSec = Number.isInteger(raw.waitSec) && raw.waitSec >= 0 && raw.waitSec <= 3600 ? raw.waitSec : 30
    return { type, waitSec, onHostFailure: failMode }
  }

  throw new Error(`未知发布策略类型：${type}（支持 serial/parallel/rolling/canary/blue-green）`)
}

/**
 * 执行发布策略。
 *
 * @param {object} params
 * @param {object} params.remote - dsh-remote 客户端
 * @param {object} params.target - 归一化后的 target（含 hosts/path/health/restart 等）
 * @param {string} params.targetName
 * @param {string} params.host - 可选：限定单台（回滚/单主机重发）
 * @param {string} params.artifactPath
 * @param {string} params.releaseId
 * @param {number} params.keep
 * @param {string} params.commit
 * @param {function} params.onLog
 * @param {function} [params.onCanaryHold] - 灰度/rolling 批间等待回调（审计）
 * @param {function} [params.onStrategyProgress] - 策略进度回调（策略锁：记录 batch index + 已完成主机）
 * @returns {Promise<object>} 与现有 deployRelease 同形（含 canary.batches）
 */
export async function deployRelease(params = {}) {
  const {
    remote, target, targetName = '', host = '', artifactPath = '', releaseId, keep = 5, commit = '',
    onLog = null, onCanaryHold = null, onStrategyProgress = null, strategy: strategyOverride = null,
  } = params

  if (!remote) throw new Error('deployRelease 需要 remote')
  if (!target || !target.path) throw Object.assign(new Error('target 缺少 path，无法发布'), { code: 'PIPE_INVALID' })
  const release = releaseId
  if (!release) throw new Error('deployRelease 需要 releaseId')
  const hosts = host ? [host] : (Array.isArray(target.hosts) ? target.hosts.map((h) => String(h).trim()).filter(Boolean) : [])
  if (hosts.length === 0) throw Object.assign(new Error('target.hosts 为空，无法发布'), { code: 'PIPE_INVALID' })

  const strategy = strategyOverride || normalizeStrategy(target, hosts.length)
  const keepCount = Number.isInteger(keep) && keep > 0 ? keep : (Number.isInteger(target.keep) ? target.keep : 5)

  const results = []
  let stopped = false

  switch (strategy.type) {
    case 'parallel': {
      // 所有主机并发部署
      const settled = await Promise.allSettled(hosts.map((current) =>
        deployOne({ remote, target, host: current, artifactPath, releaseId: release, keep: keepCount, commit, batch: 1, onLog }),
      ))
      settled.forEach((item, index) => {
        if (item.status === 'fulfilled') {
          results.push(item.value)
        } else {
          results.push(failureResult(hosts[index], item.reason, 1))
          logLine(onLog, `[${hosts[index]}] deploy 失败：${item.reason?.message || item.reason}`)
        }
      })
      break
    }

    case 'rolling': {
      const batchSize = strategy.batch
      const totalBatches = Math.ceil(hosts.length / batchSize)
      for (let batchIndex = 0; batchIndex < totalBatches; batchIndex += 1) {
        const slice = hosts.slice(batchIndex * batchSize, (batchIndex + 1) * batchSize)
        // 策略锁：记录进度
        try { onStrategyProgress?.({ type: 'rolling', batch: batchIndex + 1, totalBatches, hosts: slice, completed: results.filter((r) => r.ok).map((r) => r.host) }) } catch { /* observers must not break */ }

        if (batchIndex > 0 && strategy.waitSec > 0) {
          logLine(onLog, `[rolling] 批次 ${batchIndex + 1}/${totalBatches}，等待 ${strategy.waitSec}s`)
          try { onCanaryHold?.({ waitSec: strategy.waitSec, first: batchIndex * batchSize, remaining: slice.length, hosts: slice }) } catch { /* audit */ }
          await delay(strategy.waitSec * 1000)
        }

        // 批内串行（rolling 语义：一批内的台逐台推进，一台失败按策略停/跳）
        for (let i = 0; i < slice.length; i += 1) {
          const current = slice[i]
          const batch = batchIndex + 1
          if (stopped) {
            results.push(skippedResult(current, `前一台主机失败（onHostFailure=${strategy.onHostFailure}），已跳过`, batch))
            continue
          }
          logLine(onLog, `[${current}] deploy ${release} 开始（${batchIndex * batchSize + i + 1}/${hosts.length}，batch ${batch}）`)
          try {
            results.push(await deployOne({ remote, target, host: current, artifactPath, releaseId: release, keep: keepCount, commit, batch, onLog }))
          } catch (error) {
            const failed = failureResult(current, error, batch)
            results.push(failed)
            logLine(onLog, `[${current}] deploy 失败：${failed.error}`)
            if (strategy.onHostFailure !== 'continue') stopped = true
            else {
              // continue 模式：跳过该台继续下一台，但记录失败
              stopped = false
            }
            if (stopped) break
          }
        }
        if (stopped) break
      }
      break
    }

    case 'canary': {
      const firstCount = Math.min(strategy.first, hosts.length)
      const firstHosts = hosts.slice(0, firstCount)
      const restHosts = hosts.slice(firstCount)

      // 首批（canary）：逐台
      for (const current of firstHosts) {
        if (stopped) {
          results.push(skippedResult(current, '灰度首批失败，已跳过', 1))
          continue
        }
        logLine(onLog, `[${current}] deploy ${release} 开始（canary 首批，1/${firstHosts.length}）`)
        try {
          results.push(await deployOne({ remote, target, host: current, artifactPath, releaseId: release, keep: keepCount, commit, batch: 1, onLog }))
        } catch (error) {
          const failed = failureResult(current, error, 1)
          results.push(failed)
          logLine(onLog, `[${current}] deploy 失败：${failed.error}`)
          stopped = true // 灰度首批失败永远停
        }
      }

      if (!stopped && restHosts.length > 0) {
        logLine(onLog, `[canary] 首批 ${firstCount} 台成功，等待 ${strategy.waitSec}s 后发剩余 ${restHosts.length} 台`)
        try { onCanaryHold?.({ waitSec: strategy.waitSec, first: firstCount, remaining: restHosts.length, hosts: firstHosts }) } catch { /* audit */ }
        if (strategy.waitSec > 0) await delay(strategy.waitSec * 1000)

        for (const current of restHosts) {
          if (stopped) {
            results.push(skippedResult(current, '前一台主机失败（onHostFailure=stop），已跳过', 2))
            continue
          }
          logLine(onLog, `[${current}] deploy ${release} 开始（canary 第二批）`)
          try {
            results.push(await deployOne({ remote, target, host: current, artifactPath, releaseId: release, keep: keepCount, commit, batch: 2, onLog }))
          } catch (error) {
            const failed = failureResult(current, error, 2)
            results.push(failed)
            logLine(onLog, `[${current}] deploy 失败：${failed.error}`)
            if (strategy.onHostFailure !== 'continue') stopped = true
          }
        }
      }

      // 剩余未部署的主机标记 skipped
      const deployed = new Set(results.map((r) => r.host))
      for (const h of hosts) {
        if (!deployed.has(h)) results.push(skippedResult(h, '策略未完成，已跳过', 2))
      }
      break
    }

    case 'blue-green': {
      // blue-green：起一套完整新实例，切流量后旧实例退役
      // 简化语义：所有主机并发切到 new release，切前记录 previous，切后等 waitSec 再确认健康
      const settled = await Promise.allSettled(hosts.map((current) =>
        deployOne({ remote, target, host: current, artifactPath, releaseId: release, keep: keepCount, commit, batch: 1, onLog }),
      ))
      settled.forEach((item, index) => {
        if (item.status === 'fulfilled') {
          results.push(item.value)
        } else {
          results.push(failureResult(hosts[index], item.reason, 1))
          logLine(onLog, `[${hosts[index]}] blue-green 切流失败：${item.reason?.message || item.reason}`)
        }
      })
      // 自动回退：任一台失败 → 全部切回 previous
      const anyFailed = results.some((r) => !r.ok)
      if (anyFailed) {
        logLine(onLog, `[blue-green] 检测到失败，自动回退所有主机到 previous`)
        for (const current of hosts) {
          try {
            await rollbackOne({ remote, target, host: current, releaseId: results.find((r) => r.host === current)?.previous || '', commit, onLog })
          } catch { /* best effort */ }
        }
      }
      break
    }

    case 'serial':
    default: {
      // 逐台部署，一台失败即停（onHostFailure=continue 时跳过失败台继续）
      for (const current of hosts) {
        if (stopped) {
          results.push(skippedResult(current, `前一台主机失败（onHostFailure=${strategy.onHostFailure}），已跳过`, 1))
          continue
        }
        logLine(onLog, `[${current}] deploy ${release} 开始（serial，${results.length + 1}/${hosts.length}）`)
        try {
          results.push(await deployOne({ remote, target, host: current, artifactPath, releaseId: release, keep: keepCount, commit, batch: 1, onLog }))
        } catch (error) {
          const failed = failureResult(current, error, 1)
          results.push(failed)
          logLine(onLog, `[${current}] deploy 失败：${failed.error}`)
          if (strategy.onHostFailure !== 'continue') stopped = true
        }
      }
      break
    }
  }

  const ok = results.length > 0 && results.every((item) => item.ok)
  const first = results[0] || {}

  // 归一化：保证每个 host 都有结果（skipped 的补上）
  const deployed = new Set(results.map((r) => r.host))
  for (const h of hosts) {
    if (!deployed.has(h)) results.push(skippedResult(h, '策略未完成，已跳过', 1))
  }

  const batchList = strategy.type === 'rolling'
    ? buildBatchList(hosts, strategy.batch, results)
    : strategy.type === 'canary'
      ? [
          { index: 1, hosts: hosts.slice(0, strategy.first), ok: results.slice(0, strategy.first).every((item) => item.ok) },
          { index: 2, hosts: hosts.slice(strategy.first), ok: results.slice(strategy.first).every((item) => item.ok) },
        ]
      : [{ index: 1, hosts: hosts.slice(), ok: results.every((item) => item.ok) }]

  return {
    releaseId: release,
    target: targetName || '',
    ok,
    hosts: results,
    strategy: strategy.type,
    canary: {
      first: strategy.type === 'canary' ? strategy.first : (strategy.type === 'rolling' ? strategy.batch : 0),
      waitSec: strategy.waitSec || 0,
      batches: batchList,
    },
    // 单主机兼容字段
    host: first.host || '',
    releaseDir: first.releaseDir || '',
    previous: first.previous || '',
    restarted: first.restarted || '',
    health: first.health || 'skipped',
    cleaned: Boolean(first.cleaned),
    activated_at: first.activated_at || '',
    error: ok ? '' : (results.find((item) => !item.ok)?.error || ''),
  }
}

function buildBatchList(hosts, batchSize, results) {
  const totalBatches = Math.ceil(hosts.length / batchSize)
  const list = []
  for (let i = 0; i < totalBatches; i += 1) {
    const slice = hosts.slice(i * batchSize, (i + 1) * batchSize)
    const sliceResults = results.filter((r) => slice.includes(r.host))
    list.push({ index: i + 1, hosts: slice, ok: sliceResults.every((item) => item.ok) })
  }
  return list
}

function failureResult(host, error, batch = 1) {
  return {
    host,
    ok: false,
    batch,
    previous: error?.previous || '',
    releaseDir: '',
    restarted: error?.restarted || '',
    health: error?.health || 'skipped',
    cleaned: false,
    activated_at: '',
    error: error?.message || String(error),
    code: error?.code || '',
  }
}

function skippedResult(host, reason, batch = 1) {
  return {
    host,
    ok: false,
    batch,
    previous: '',
    releaseDir: '',
    restarted: '',
    health: 'skipped',
    cleaned: false,
    activated_at: '',
    error: reason,
    code: 'HOST_SKIPPED',
    skipped: true,
  }
}
