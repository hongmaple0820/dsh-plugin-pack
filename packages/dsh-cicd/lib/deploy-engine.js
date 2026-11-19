/**
 * 部署事务（v3.0-P3）：把「一台一台整包替换」升级成四阶段事务。
 *
 *   stage（落盘 + 占端口）→ activate（切 current + 起进程）→ verify（L1/L2/L3）→ commit / abort（补偿）
 *
 * 为什么必须是四阶段而不是「一边部署一边切流」：
 * 现有 `lib/deploy.js` 逐台 `mkdir → upload → ln -sfn → restart → health`，第 2 台失败时第 1 台
 * 已经是新版本了。三台机器里两台新一台旧，用户看到的是「发布失败」，生产看到的是混版运行——
 * 这比发布失败严重得多。所以 stage 与 activate 必须分开：**全部主机都落盘成功之后，才开始切流。**
 *
 * 补偿为什么只回滚「已激活的」：
 * 没激活的主机只是磁盘上多了一个 `releases/<id>/` 目录，它不服务任何请求，回滚它没有意义，
 * 反而会删掉排查现场。补偿只做一件事：把已经切过流的主机指回 previous，并且**自己绝不抛错**
 * ——调用方正在报告最初的失败原因，一个抛错的补偿只会把真正的诊断替换成第二个更没用的诊断。
 *
 * 与 `lib/deploy.js` 的关系：
 * `deploy.js` 保留为单主机/无 instances 的兼容路径（它的 `deployOne`/`rollbackOne` 仍被策略引擎
 * 与回滚路径使用）。本文件只在 target 声明了 `instances` 或调用方显式选择时接管主路径，
 * 因为「一台机器一个软链」和「一台机器 N 个端口各一个进程」的回滚现场根本不是一件事。
 *
 * 策略粒度：
 * 五策略（serial/parallel/rolling/canary/blue-green）在这里退化成「主机分批」，每个批次内部
 * 仍然完整走一遍四阶段事务。这个选择是刻意的：把策略做成「每台机器独立事务」会让第 2 台失败时
 * 第 1 台留在新版本上（正是上面要消灭的混版）；做成「整批一个事务」则刚好满足 07-deploy.md §10
 * 第 2、3 条判据。
 */

import { createNativeActuator, ACTUATOR_ERRORS } from './actuator/native.js'
import { normalizeStrategy } from './strategy.js'
import { delay, logLine, shellQuote } from './deploy.js'

export const DEPLOY_ERRORS = {
  STAGE: 'DEPLOY_STAGE_FAILED',
  ACTIVATE: 'DEPLOY_ACTIVATE_FAILED',
  VERIFY: 'DEPLOY_VERIFY_FAILED',
  REVERT: 'DEPLOY_REVERT_FAILED',
  NO_HOSTS: 'DEPLOY_NO_HOSTS',
}

/** 哪些 target 走事务路径：声明了 instances 就一定走；其余保持 deploy.js 的老行为。 */
export function usesTransaction(target) {
  if (!target || typeof target !== 'object') return false
  const count = Number(target.instances?.count)
  return Number.isInteger(count) && count > 0
}

/**
 * 把主机列表按策略切成批次。返回 `[{index, hosts, waitAfterSec}]`。
 *
 * 只复用 `normalizeStrategy` 的**参数归一化**（默认值与合法性），批次语义在这里重新实现：
 * `strategy.js` 的批次是「逐台部署的间隔」，而事务需要的是「一批主机一起走完四阶段」。
 */
export function planBatches(target, hosts, strategyOverride = null) {
  const list = Array.isArray(hosts) ? hosts.slice() : []
  const strategy = strategyOverride || normalizeStrategy(target, list.length)
  const total = list.length
  const chunks = []
  const push = (slice, waitAfterSec) => {
    if (slice.length > 0) chunks.push({ index: chunks.length + 1, hosts: slice, waitAfterSec })
  }

  if (strategy.type === 'parallel') {
    push(list, 0)
  } else if (strategy.type === 'rolling') {
    const size = Math.max(1, Math.min(strategy.batch || 1, total))
    for (let index = 0; index < total; index += size) {
      push(list.slice(index, index + size), index + size < total ? (strategy.waitSec || 0) : 0)
    }
  } else if (strategy.type === 'canary') {
    const first = Math.max(1, Math.min(strategy.first || 1, total))
    push(list.slice(0, first), first < total ? (strategy.waitSec || 0) : 0)
    const rest = list.slice(first)
    if (rest.length > 0) push(rest, 0)
  } else if (strategy.type === 'blue-green') {
    // 蓝绿在主机维度没有「一半一半」的含义：新的一套要么全起、要么不起。
    // 保留批次形状是为了统一结果结构，waitSec 语义与 serial 一致。
    push(list, 0)
  } else {
    push(list, 0)
  }
  return { strategy, batches: chunks }
}

function emptyHostResult(host, batch, reason, code) {
  return {
    host,
    ok: false,
    batch,
    releaseDir: '',
    previous: '',
    restarted: '',
    health: 'skipped',
    cleaned: false,
    activated_at: '',
    instances: [],
    manifest: null,
    compensated: false,
    error: reason,
    code,
  }
}

/**
 * 跑一次部署事务。
 *
 * @param {object} params
 * @param {object} params.remote            dsh-remote 客户端（exec/uploadFile）
 * @param {object} params.project
 * @param {object} params.target            归一化 target
 * @param {string} params.targetName
 * @param {string} [params.host]            限定单台
 * @param {string} params.artifactPath
 * @param {string} [params.artifactDigest]  不可变摘要（写进 manifest 与 release 行）
 * @param {string} params.releaseId
 * @param {number} [params.keep]
 * @param {string} [params.commit]
 * @param {string} [params.runId]
 * @param {string} [params.operator]
 * @param {(line:string)=>void} [params.onLog]
 * @param {Function} [params.onCanaryHold]  批间等待回调（审计）
 * @param {Function} [params.onStrategyProgress]
 * @param {object} [params.strategy]        覆盖 target.strategy
 * @param {Function} [params.actuatorFactory] 测试注入点：({host, target, hostName, onLog}) => actuator
 */
export async function deployTransaction(params = {}) {
  const {
    remote,
    project = null,
    target,
    targetName = '',
    host = '',
    artifactPath = '',
    artifactDigest = '',
    releaseId,
    keep = 5,
    commit = '',
    runId = '',
    operator = '',
    onLog = null,
    onCanaryHold = null,
    onStrategyProgress = null,
    strategy: strategyOverride = null,
    actuatorFactory = null,
  } = params

  if (!remote) throw new Error('deployTransaction 需要 remote')
  if (!target || !target.path) throw Object.assign(new Error('target 缺少 path，无法发布'), { code: 'PIPE_INVALID' })
  const hosts = host
    ? [String(host)]
    : (Array.isArray(target.hosts) ? target.hosts.map((item) => String(item).trim()).filter(Boolean) : [])
  if (hosts.length === 0) {
    throw Object.assign(new Error('target.hosts 为空，无法发布'), { code: DEPLOY_ERRORS.NO_HOSTS })
  }
  const release = String(releaseId || '')
  if (!release) throw new Error('deployTransaction 需要 releaseId')
  const keepCount = Number.isInteger(keep) && keep > 0 ? keep : (Number.isInteger(target.keep) ? target.keep : 5)
  const failMode = target.onHostFailure === 'continue' ? 'continue' : 'stop'

  const { strategy, batches } = planBatches(target, hosts, strategyOverride)
  // mode 拒绝静默降级：写 mode: container 却走软链部署，是那种「面板显示成功、生产其实
  // 没有换镜像」的失败。只有 native 有诚实的实现，其余必须等各自 Actuator 落地。
  // actuatorFactory 是测试注入点，注入时不看 mode（测试用自己的假执行器）。
  if (!actuatorFactory && target.mode && target.mode !== 'native') {
    const error = new Error(`mode ${target.mode} 的 Actuator 还没实现（当前只有 native）；拒绝退回软链部署——那会让面板显示成功而生产没有真的换版本`)
    error.code = 'ACTUATOR_NOT_IMPLEMENTED'
    throw error
  }

  const results = new Map()
  const actuators = new Map()

  const makeActuator = (hostName) => {
    if (actuators.has(hostName)) return actuators.get(hostName)
    const bound = {
      exec: (command, options) => remote.exec(hostName, command, options),
      uploadFile: (localPath, remotePath) => remote.uploadFile(hostName, localPath, remotePath),
    }
    const factory = actuatorFactory || createNativeActuator
    const actuator = factory({ host: bound, target, hostName, onLog })
    actuators.set(hostName, actuator)
    return actuator
  }

  let stopped = false
  for (const batch of batches) {
    if (stopped) {
      for (const hostName of batch.hosts) {
        const row = emptyHostResult(hostName, batch.index, `前一批主机失败（onHostFailure=${failMode}），已跳过`, DEPLOY_ERRORS.STAGE)
        row.skipped = true
        results.set(hostName, row)
      }
      continue
    }

    logLine(onLog, `[batch ${batch.index}] ${batch.hosts.length} 台主机：stage 全部完成后才切流`)
    try { onStrategyProgress?.({ batch: batch.index, hosts: batch.hosts, phase: 'stage' }) } catch { /* observers */ }

    // ---- 阶段 1：全部主机落盘。任何一台失败 → 一台都不切流。 ----
    const staged = []
    let stageFailure = null
    for (const hostName of batch.hosts) {
      const actuator = makeActuator(hostName)
      try {
        logLine(onLog, `[${hostName}] stage 开始`)
        const handle = await actuator.stage({ releaseId: release, artifactPath })
        staged.push({ hostName, actuator, handle })
      } catch (error) {
        stageFailure = { hostName, error }
        break
      }
    }

    if (stageFailure) {
      // 已 stage 的主机没有切流，唯一副作用是磁盘目录与端口槽位。槽位必须还回去，
      // 否则下一次发布会被自己上一次的失败挡住（那正是 §10 第 4 条要防的事）。
      for (const item of staged) {
        try { await item.actuator.slots.releaseAll?.(item.handle.slots) } catch { /* best effort */ }
        results.set(item.hostName, emptyHostResult(item.hostName, batch.index, `同批 ${stageFailure.hostName} 的 stage 失败，本次未切流`, DEPLOY_ERRORS.STAGE))
      }
      const failed = emptyHostResult(
        stageFailure.hostName,
        batch.index,
        `[${stageFailure.hostName}] stage 失败：${stageFailure.error?.message || stageFailure.error}`,
        stageFailure.error?.code || DEPLOY_ERRORS.STAGE,
      )
      failed.errorObject = stageFailure.error
      results.set(stageFailure.hostName, failed)
      // 失败点之后的主机根本没被碰过。它们不是「成功」也不是「失败」，而是「没轮到」——
      // 必须显式标成 skipped，否则它们会落到兜底分支，被显示成一次从没发生过的执行。
      for (const hostName of batch.hosts) {
        if (results.has(hostName)) continue
        const row = emptyHostResult(hostName, batch.index, `同批 ${stageFailure.hostName} 的 stage 失败，本次未开始`, DEPLOY_ERRORS.STAGE)
        row.skipped = true
        results.set(hostName, row)
      }
      logLine(onLog, `[batch ${batch.index}] stage 阶段失败，全批不切流（${staged.length} 台已落盘但未激活）`)
      stopped = failMode !== 'continue'
      continue
    }

    // ---- 阶段 2/3：逐台激活 + 校验 ----
    const activated = []
    let verifyFailure = null
    for (const item of staged) {
      const { hostName, actuator, handle } = item
      logLine(onLog, `[${hostName}] stage 完成（${handle.instances.length || 1} 实例），activate`)
      try {
        await actuator.activate(handle)
        activated.push(item)
      } catch (error) {
        verifyFailure = { hostName, error, phase: 'activate', handle }
        break
      }
      try {
        const verdict = await actuator.health(handle)
        if (!verdict.ok) {
          verifyFailure = { hostName, error: Object.assign(new Error(verdict.detail), { code: ACTUATOR_ERRORS.HEALTH, layer: verdict.layer }), phase: 'verify', handle }
          break
        }
        logLine(onLog, `[${hostName}] verify 通过（${verdict.layer}）`)
      } catch (error) {
        verifyFailure = { hostName, error, phase: 'verify', handle }
        break
      }
    }

    if (verifyFailure) {
      logLine(onLog, `[batch ${batch.index}] ${verifyFailure.hostName} ${verifyFailure.phase} 失败，开始补偿已激活的 ${activated.length} 台`)
      for (const item of activated) {
        const { hostName, actuator, handle } = item
        let compensation = null
        try {
          compensation = await actuator.revert(handle, { drainSec: 0 })
          logLine(onLog, `[${hostName}] 补偿：${compensation.reverted ? `已指回 ${compensation.previous}` : '无 previous，已移除 current'}`)
        } catch (error) {
          compensation = { ok: false, notes: [`补偿抛错：${error.message}`] }
          logLine(onLog, `[${hostName}] 补偿失败：${error.message}`)
        }
        const row = emptyHostResult(hostName, batch.index, `同批 ${verifyFailure.hostName} ${verifyFailure.phase} 失败，已回滚到 ${compensation?.previous || '（无 previous）'}`, DEPLOY_ERRORS.VERIFY)
        row.compensated = true
        row.previous = handle.previous || ''
        row.instances = (handle.instances || []).map((instance) => ({ ...instance }))
        row.releaseDir = handle.dir
        row.activated_at = handle.activatedAt || ''
        row.compensation = compensation
        results.set(hostName, row)
      }
      // 失败的那台如果已经激活（verify 阶段失败），它自己也要补偿。
      if (verifyFailure.phase === 'verify' && verifyFailure.handle) {
        const { hostName, actuator, handle } = { hostName: verifyFailure.hostName, actuator: makeActuator(verifyFailure.hostName), handle: verifyFailure.handle }
        try { await actuator.revert(handle, { drainSec: 0 }) } catch { /* reported below */ }
      }
      for (const item of staged) {
        if (results.has(item.hostName)) continue
        results.set(item.hostName, emptyHostResult(item.hostName, batch.index, '同批主机失败，本次未激活', DEPLOY_ERRORS.STAGE))
        try { await item.actuator.slots.releaseAll?.(item.handle.slots) } catch { /* best effort */ }
      }
      for (const hostName of batch.hosts) {
        if (results.has(hostName)) continue
        const row = emptyHostResult(hostName, batch.index, `同批 ${verifyFailure.hostName} 失败，本次未开始`, DEPLOY_ERRORS.STAGE)
        row.skipped = true
        results.set(hostName, row)
      }
      const failedRow = emptyHostResult(
        verifyFailure.hostName,
        batch.index,
        `[${verifyFailure.hostName}] ${verifyFailure.phase} 失败：${verifyFailure.error?.message || verifyFailure.error}`,
        verifyFailure.error?.code || DEPLOY_ERRORS.VERIFY,
      )
      failedRow.phase = verifyFailure.phase
      failedRow.layer = verifyFailure.error?.layer || ''
      failedRow.errorObject = verifyFailure.error
      results.set(verifyFailure.hostName, failedRow)
      stopped = failMode !== 'continue'
      continue
    }

    // ---- 阶段 4：提交。写 manifest、清理旧 release、释放不再持有的槽位 ----
    for (const item of staged) {
      const { hostName, actuator, handle } = item
      const row = {
        host: hostName,
        ok: true,
        batch: batch.index,
        releaseId: handle.releaseId,
        releaseDir: handle.dir,
        previous: handle.previous || '',
        restarted: handle.instances.length > 0 ? 'restart-template' : (target.restart || target.service || 'symlink-only'),
        health: 'ok',
        cleaned: false,
        activated_at: handle.activatedAt || '',
        instances: (handle.instances || []).map((instance) => ({
          instanceId: instance.instanceId,
          slot: instance.slot,
          port: instance.port,
          pid: instance.pid,
          env: instance.envRendered || instance.env || {},
          log: instance.logPath || '',
        })),
        manifest: null,
        compensated: false,
        error: '',
        code: '',
      }
      try {
        row.manifest = await actuator.writeManifest(handle, {
          targetName,
          artifactPath,
          artifactDigest,
          strategy: strategy.type,
          commit,
          runId,
          operator,
        })
      } catch (error) {
        // manifest 写不下去代表「主机失联时没有回滚现场」，这是要报出来的，但不必让整批失败：
        // 新版本已经在跑了，把它撤下来反而制造一次事故。
        logLine(onLog, `[${hostName}] 写 manifest 失败：${error.message}`)
        row.manifestError = error.message
      }
      try {
        const cleaned = await actuator.cleanup(handle, { keep: keepCount })
        row.cleaned = Boolean(cleaned?.ok)
      } catch { /* cleanup is best-effort */ }
      results.set(hostName, row)
    }

    try { onStrategyProgress?.({ batch: batch.index, hosts: batch.hosts, phase: 'commit' }) } catch { /* observers */ }

    if (batch.waitAfterSec > 0) {
      logLine(onLog, `[batch ${batch.index}] 成功，等待 ${batch.waitAfterSec}s 后进入下一批`)
      try {
        onCanaryHold?.({ waitSec: batch.waitAfterSec, batch: batch.index, hosts: batch.hosts, remaining: hosts.length - batch.hosts.length })
      } catch { /* audit observers must not break a deploy */ }
      await delay(batch.waitAfterSec * 1000)
    }
  }

  const rows = hosts.map((hostName) => results.get(hostName) || emptyHostResult(hostName, 0, '未执行', DEPLOY_ERRORS.STAGE))
  const ok = rows.length > 0 && rows.every((row) => row.ok)
  const first = rows[0] || {}
  const firstFailure = rows.find((row) => !row.ok) || {}

  return {
    releaseId: release,
    target: targetName || '',
    // 回滚只用摘要：调用方拿到它就该把它写进 release 行，而不是重新算一遍产物哈希
    // （重算会跟着「产物文件此刻长什么样」走，而回滚要的是「当时部署了什么」）。
    artifactDigest: artifactDigest || '',
    ok,
    hosts: rows,
    strategy: strategy.type,
    canary: {
      first: strategy.type === 'canary' ? (strategy.first || 0) : 0,
      waitSec: strategy.waitSec || 0,
      batches: batches.map((batch) => ({
        index: batch.index,
        hosts: batch.hosts,
        ok: batch.hosts.every((hostName) => results.get(hostName)?.ok),
      })),
    },
    // 单主机兼容字段：老调用方/渲染器仍然读这些键
    host: first.host || '',
    releaseDir: first.releaseDir || '',
    previous: first.previous || '',
    restarted: first.restarted || '',
    health: first.health || 'skipped',
    cleaned: Boolean(first.cleaned),
    activated_at: first.activated_at || '',
    instances: rows.flatMap((row) => row.instances || []),
    error: ok ? '' : (firstFailure.error || ''),
    code: ok ? '' : (firstFailure.code || DEPLOY_ERRORS.VERIFY),
  }
}

/**
 * 从 `.dsh-manifest.json` 读回滚现场（§10 第 7 条：断网也要能读出完整回滚现场）。
 * 不依赖任何本地状态：manifest 就在目标机的 release 目录里。
 */
export async function readManifest({ remote, target, host, releaseId = '' }) {
  if (!remote) throw new Error('readManifest 需要 remote')
  if (!target || !target.path) throw Object.assign(new Error('target 缺少 path'), { code: 'PIPE_INVALID' })
  const base = String(target.path).replace(/\/+$/, '')
  const dir = releaseId ? `${base}/releases/${releaseId}` : ''
  let wanted = releaseId
  if (!wanted) {
    const read = await remote.exec(host, `readlink ${shellQuote(`${base}/current`)} || true`)
    const text = String(read?.stdout || '').trim()
    const match = /(?:^|\/)releases\/([^/\s]+)\/?$/.exec(text)
    wanted = match ? match[1] : (text.split('/').filter(Boolean).pop() || '')
  }
  if (!wanted) {
    throw Object.assign(new Error(`[${host}] 读不到 current，也没有指定 releaseId`), { code: 'RELEASE_NOT_FOUND' })
  }
  const file = `${dir || `${base}/releases/${wanted}`}/.dsh-manifest.json`
  const output = await remote.exec(host, `cat ${shellQuote(file)}`)
  const text = String(output?.stdout || '').trim()
  if (!text) throw Object.assign(new Error(`[${host}] 没有 manifest：${file}`), { code: 'MANIFEST_NOT_FOUND' })
  let parsed = null
  try { parsed = JSON.parse(text) } catch (error) {
    throw Object.assign(new Error(`[${host}] manifest 不是合法 JSON：${error.message}`), { code: 'MANIFEST_INVALID' })
  }
  return { host, releaseId: wanted, path: file, manifest: parsed }
}
