/**
 * V2-M2 执行面抽象：把 runner.js 的「spawn 本地进程」抽成 Executor 接口，本地实现保持现状，
 * 远端实现走拉取式协议（server 侧任务 broker + runner 端 claim/心跳/结果回报）。
 *
 * Executor 契约（runPipeline 只依赖这些方法）：
 *   kind: 'local' | 'remote'
 *   execute(step, context) → Promise<{status, exitCode, error}>
 *     status ∈ success | failed | canceled；context = {cwd, env, onLine, signal, taskId, runId}
 *   cancel()                 尽力取消本 executor 正在跑的一切（本地杀进程树；远端给 runner 发 cancel）
 *   kill()                   取消并等待：本地等子进程 close；远端 await broker.claim 取消路径
 *   active()                 当前有没有未完成的执行
 *   describe()               {kind, runnerId, labels, version, ...}
 *
 * TaskBroker（server 侧）：把远端任务排队、派发给已注册的 runner、跟踪状态，供 index.js 的
 * /run 路由在 runner=远端 时使用；本地执行不经 broker。
 */

import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto'

function createLineSplitter(emit) {
  let rest = ''
  return {
    push(chunk) {
      rest += chunk
      let index
      while ((index = rest.indexOf('\n')) >= 0) {
        const line = rest.slice(0, index).replace(/\r$/, '')
        rest = rest.slice(index + 1)
        emit(line)
      }
    },
    flush() {
      if (rest) emit(rest.replace(/\r$/, ''))
      rest = ''
    },
  }
}

function killTree(child) {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* best effort */ }
    return
  }
  try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch { /* gone */ } }
  setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ }
  }, 2000).unref?.()
}

/**
 * 本地 executor：spawnStep 语义（杀树/超时/取消/行回调）搬进 executor，行为与旧 runner 一致。
 * kill() 是「取消并等待」：置 cancelRequested，若子进程已起则杀树并等 close 后 resolve。
 */
export function createLocalExecutor() {
  const active = new Map() // taskId -> {cancel, cancelRequested, wait, finished}

  function execute(step, context) {
    const taskId = `local-${Date.now()}-${randomBytes(3).toString('hex')}`
    const entry = { cancelRequested: false, wait: null, finished: false, cancel: null }
    active.set(taskId, entry)
    return new Promise((resolve) => {
      const startedAt = Date.now()
      let child
      let settled = false
      let timer = null
      const finish = (result) => {
        if (settled) return
        settled = true
        entry.finished = true
        active.delete(taskId)
        if (timer) clearTimeout(timer)
        if (entry.wait) {
          entry.wait(result)
          entry.wait = null
        }
        resolve(result)
      }
      try {
        child = spawn(step.command, {
          shell: true,
          cwd: context.cwd || process.cwd(),
          env: context.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          windowsHide: true,
        })
      } catch (error) {
        finish({ status: 'failed', exitCode: -1, error: error.message, durationMs: Date.now() - startedAt })
        return
      }
      let timedOut = false
      const onLine = typeof context.onLine === 'function' ? context.onLine : () => {}
      const stdout = createLineSplitter(onLine)
      const stderr = createLineSplitter(onLine)
      const cancel = () => {
        if (entry.cancelRequested || entry.finished) return
        entry.cancelRequested = true
        killTree(child)
      }
      entry.cancel = cancel
      if (context.signal) {
        if (context.signal.aborted) cancel()
        else if (typeof context.signal.addEventListener === 'function') context.signal.addEventListener('abort', cancel, { once: true })
      }
      if (step.timeoutSec > 0) {
        timer = setTimeout(() => {
          timedOut = true
          killTree(child)
        }, step.timeoutSec * 1000)
      }
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk) => stdout.push(chunk))
      child.stderr?.on('data', (chunk) => stderr.push(chunk))
      child.on('error', (error) => {
        stdout.flush()
        stderr.flush()
        finish({ status: entry.cancelRequested ? 'canceled' : 'failed', exitCode: -1, error: entry.cancelRequested ? '已取消' : error.message, durationMs: Date.now() - startedAt })
      })
      child.on('close', (code, signalName) => {
        const exitCode = Number.isInteger(code) ? code : -1
        stdout.flush()
        stderr.flush()
        if (entry.cancelRequested) {
          finish({ status: 'canceled', exitCode, signal: signalName || '', error: '已取消', durationMs: Date.now() - startedAt })
          return
        }
        const status = !timedOut && exitCode === 0 ? 'success' : 'failed'
        finish({ status, exitCode, signal: signalName || '', error: timedOut ? `步骤超时（${step.timeoutSec}s）` : '', durationMs: Date.now() - startedAt })
      })
    })
  }

  function cancel() {
    for (const entry of active.values()) {
      if (!entry.finished && entry.cancel) {
        try { entry.cancel() } catch { /* best effort */ }
      }
    }
  }

  function kill() {
    const pending = []
    for (const [taskId, entry] of active.entries()) {
      if (entry.finished) continue
      if (entry.cancel) {
        try { entry.cancel() } catch { /* best effort */ }
      }
      pending.push(new Promise((resolveWait) => {
        entry.wait = (result) => resolveWait(result)
      }))
      // 若该任务已经在 resolve 路径上（finish 已把 wait 清掉），entry.wait 为 null：
      // 此时任务其实已结束，等它从 active 表里消失即可。
      pending.push(new Promise((resolveWait) => {
        const poll = () => {
          if (active.has(taskId)) setTimeout(poll, 20)
          else resolveWait(null)
        }
        poll()
      }))
    }
    return Promise.all(pending).then(() => {})
  }

  function activeNow() {
    return [...active.values()].some((entry) => !entry.finished)
  }

  return {
    kind: 'local',
    runnerId: 'local',
    describe() {
      return { kind: 'local', runnerId: 'local', labels: ['local'], version: 'builtin' }
    },
    execute,
    cancel,
    kill,
    active: activeNow,
  }
}

/**
 * 远端 executor：通过 broker 把 step 任务交给注册的 runner 执行。
 * runner 端（bin/runner.mjs）领任务 → 本地 spawn → 逐行回报 log → 回 result；
 * 这里只关心「拿到结果」。kill() 时 broker 给 runner 发 cancel，runner 杀本地进程树。
 */
export function createRemoteExecutor({ broker, runnerId } = {}) {
  if (!broker) throw new Error('createRemoteExecutor 需要 broker')
  return {
    kind: 'remote',
    runnerId,
    describe() {
      const info = typeof broker.describe === 'function' ? broker.describe(runnerId) : null
      return { kind: 'remote', runnerId, labels: info?.labels || [], version: info?.version || '', lastSeenAt: info?.lastSeenAt || '' }
    },
    async execute(step, context) {
      const spec = {
        taskId: context.taskId || '',
        stepIndex: context.stepIndex ?? 0,
        stageId: context.stageId || '',
        command: step.command,
        cwd: context.cwd || '',
        env: context.env || {},
        timeoutSec: step.timeoutSec || 0,
        runId: context.runId || '',
      }
      return await broker.claim(spec, runnerId, {
        onLine: context.onLine,
        signal: context.signal,
        timeoutMs: context.claimTimeoutMs || 0,
        liveness: context.runnerLiveness || null,
        livenessEveryMs: context.livenessEveryMs || 5000,
      })
    },
    cancel() {
      try { broker.cancelAll(runnerId) } catch { /* best effort */ }
    },
    kill() {
      // broker.claim 的取消路径是异步的：这里标记后，正在 await 的 claim 会 resolve canceled。
      this.cancel()
      return Promise.resolve()
    },
    active() {
      return broker.activeFor(runnerId)
    },
  }
}

/**
 * 任务 broker：server 侧任务队列 + 派发 + 跟踪。
 * 远端 runner 通过 register/claim/log/result 四组回调与它交互（见 bin/runner.mjs 的拉取式协议）。
 *
 * 单进程内（smoke/测试/本机回环）：dispatcher 直接调用 runner 侧实现；
 * 跨进程/跨机：dispatcher 走 HTTP/WebSocket 把 task spec 推给 runner，
 * runner 的 log/result 回调再灌回 broker。两端协议边界在 bin/runner.mjs 里定死。
 */
export function createTaskBroker({ onTaskForRunner = null, log = () => {} } = {}) {
  const tasks = new Map() // taskId -> {spec, runnerId, status, result, lines, onLine, cancelRequested, cancelFn, createdAt, finishedAt}
  const running = new Map() // runnerId -> Set<taskId>
  const runners = new Map() // runnerId -> {labels, version, capacity, lastSeenAt, status}
  const pollQueues = new Map() // runnerId -> [taskId]（FIFO，/runner-poll 取最早未完成任务）

  function register(runnerId, { labels = [], version = '', capacity = 1 } = {}) {
    const info = {
      runnerId,
      labels: String(labels || '').split(',').map((item) => item.trim()).filter(Boolean),
      version: String(version || ''),
      capacity: Number.isInteger(capacity) && capacity > 0 ? capacity : 1,
      lastSeenAt: new Date().toISOString(),
      status: 'online',
    }
    runners.set(runnerId, info)
    log('runner-registered', { runnerId, info })
    return info
  }

  function heartbeat(runnerId) {
    const info = runners.get(runnerId)
    if (info) {
      info.lastSeenAt = new Date().toISOString()
      info.status = 'online'
    }
    log('runner-heartbeat', { runnerId })
  }

  function markOffline(runnerId) {
    const info = runners.get(runnerId)
    if (info) info.status = 'offline'
  }

  function describe(runnerId) {
    const row = runners.get(runnerId)
    if (!row) return null
    return { runnerId, labels: row.labels, version: row.version, lastSeenAt: row.lastSeenAt, status: row.status, capacity: row.capacity }
  }

  function listRunners() {
    return [...runners.entries()].map(([id, row]) => ({
      runnerId: id,
      labels: row.labels || [],
      version: row.version || '',
      capacity: row.capacity || 1,
      lastSeenAt: row.lastSeenAt || '',
      status: row.status || '',
      active: activeFor(id),
    }))
  }

  /** 入队：把 spec 排队，dispatcher 派发给 runner。 */
  function enqueue(spec, runnerId = '') {
    const taskId = spec.taskId || `task-${Date.now()}-${randomBytes(3).toString('hex')}`
    const task = {
      spec: { ...spec, taskId },
      runnerId,
      status: 'queued',
      // v3.0-P7：第一次被 runner 取走的时刻（runner-poll 里写）。null 表示一直没人接。
      claimedAt: 0,
      result: null,
      lines: [],
      onLine: null,
      cancelRequested: false,
      cancelFn: null,
      createdAt: new Date().toISOString(),
      finishedAt: '',
    }
    tasks.set(taskId, task)
    if (runnerId && !running.has(runnerId)) running.set(runnerId, new Set())
    if (runnerId) running.get(runnerId)?.add(taskId)
    // 记住每个 runner 的待领任务（FIFO），供 /runner-poll 下发。
    if (runnerId) {
      const queue = pollQueues.get(runnerId) || []
      queue.push(taskId)
      pollQueues.set(runnerId, queue)
    }
    log('task-enqueued', { taskId, runnerId })
    if (typeof onTaskForRunner === 'function') {
      try {
        onTaskForRunner(task)
      } catch (error) {
        log('task-dispatch-error', { taskId, error: error?.message || String(error) })
      }
    }
    return task
  }

  /** /runner-poll：返回 runner 队列里最早的未完成任务，没有则 null。 */
  function taskForRunner(runnerId) {
    const queue = pollQueues.get(runnerId)
    if (!queue || queue.length === 0) return null
    // 跳过已 finished 的任务（结果已回报，从队列移除）。
    while (queue.length > 0) {
      const taskId = queue[0]
      const task = tasks.get(taskId)
      if (!task || task.status === 'finished') {
        queue.shift()
        continue
      }
      // v3.0-P7：被取走过一次就不再是「没人接」——超时报错要靠这个字段区分
      // 「机器领了但没跑完」和「根本没有机器来领」。
      if (!task.claimedAt) task.claimedAt = Date.now()
      return task
    }
    return null
  }

  /**
   * 协议 v2：批量回报日志，带全局递增 seq，按 (taskId, seq) 去重。
   * 链路会丢包重发（日志 HTTP 失败重试、complete 幂等重放），同一条行重复到达是常态；
   * 去重靠每个 task 自身的 seqSeen 集合，重启后丢集合只是极小概率的重复行，可接受。
   * 返回 { accepted, dropped }，调用方原样透出给 runner 当回执。
   */
  function reportLogBatch(taskId, entries) {
    const task = tasks.get(taskId)
    if (!task) return { accepted: 0, dropped: 0, unknown: true }
    if (!task.seqSeen) task.seqSeen = new Set()
    let accepted = 0
    let dropped = 0
    const sorted = (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry && Number.isFinite(entry.seq))
      .map((entry) => ({ seq: Number(entry.seq), text: String(entry.text ?? '') }))
      .sort((a, b) => a.seq - b.seq)
    for (const entry of sorted) {
      if (task.seqSeen.has(entry.seq)) { dropped += 1; continue }
      task.seqSeen.add(entry.seq)
      accepted += 1
      reportLog(taskId, entry.text)
    }
    return { accepted, dropped }
  }

  /** runner 端逐行回报日志。 */
  function reportLog(taskId, line) {
    const task = tasks.get(taskId)
    if (!task) return
    task.lines.push(String(line || ''))
    if (task.onLine) {
      try { task.onLine(String(line || '')) } catch { /* observer errors are not run errors */ }
    }
  }

  /** runner 端回报最终结果；幂等：同一 taskId 只 resolve 一次。 */
  function resolve(taskId, result) {
    const task = tasks.get(taskId)
    if (!task || task.status === 'finished') return
    task.status = 'finished'
    task.result = {
      status: String(result?.status || 'failed'),
      exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : -1,
      error: String(result?.error || ''),
      signal: String(result?.signal || ''),
    }
    task.finishedAt = new Date().toISOString()
    if (task.runnerId) running.get(task.runnerId)?.delete(taskId)
    log('task-resolved', { taskId, status: task.result.status })
  }

  /**
   * executor 视角的 claim：入队 + await 最终结果；signal abort 时标记取消。
   * 无 dispatcher（onTaskForRunner=null）时任务停在 queued，timeoutMs 到后按失败收尾，
   * 避免「runner 没上线就 claim」永久悬挂。
   */
  async function claim(spec, runnerId, { onLine = null, signal = null, timeoutMs = 0, liveness = null, livenessEveryMs = 5000 } = {}) {
    const task = enqueue(spec, runnerId)
    if (onLine) task.onLine = onLine
    const abortListener = () => {
      task.cancelRequested = true
      if (task.cancelFn) {
        try { task.cancelFn() } catch { /* best effort */ }
      }
    }
    if (signal) {
      if (signal.aborted) abortListener()
      else if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', abortListener, { once: true })
    }
    // 远端 executor 走 broker，本地 executor 不需要 claim 超时。
    const effectiveTimeout = timeoutMs > 0 ? timeoutMs : 0
    return await new Promise((resolveWaiter) => {
      const startedAt = Date.now()
      let checkedAt = startedAt
      let dead = null
      // v3.0-P7 混沌：runner 掉线时任务必须**当场**失败并说清原因。
      // 没有这一步，掉线的机器只会让这次 run 一直挂到超时——而超时原因写的是
      // 「未在 Ns 内响应」，运维会去查命令为什么慢，而真实原因是那台机器没了（或者
      // 任务已经被 revoke 时 cancelAll 取消掉，永远等不到结果）。
      // liveness 是宿主注入的探针（读 DB 注册表），每 livenessEveryMs 问一次是否还活着。
      const probe = () => {
        if (typeof liveness !== 'function') return
        const stamp = Date.now()
        if (stamp - checkedAt < livenessEveryMs) return
        checkedAt = stamp
        try {
          dead = liveness() || null
        } catch {
          dead = null // 探针自己出错不能变成运行失败，退回纯超时保护
        }
      }
      const tick = () => {
        if (task.status === 'finished') {
          resolveWaiter(task.result || { status: 'failed', exitCode: -1, error: '远端 runner 没有返回结果' })
          return
        }
        if (task.cancelRequested) {
          resolveWaiter({ status: 'canceled', exitCode: -1, error: '已取消' })
          return
        }
        probe()
        if (dead) {
          task.status = 'finished'
          task.result = { status: 'failed', exitCode: -1, error: dead.message || 'runner 已不可用', code: dead.code || 'RUNNER_OFFLINE' }
          resolveWaiter(task.result)
          return
        }
        if (effectiveTimeout > 0 && Date.now() - startedAt > effectiveTimeout) {
          task.status = 'finished'
          // v3.0-P7：超时窗口里一直没被认领的，原因不是「命令慢」，而是「没有机器来接这个活」。
          // 两者在面板上必须说得不一样，否则运维会去查构建脚本。
          task.result = task.claimedAt
            ? { status: 'failed', exitCode: -1, error: `远端 runner 未在 ${Math.round(effectiveTimeout / 1000)}s 内响应` }
            : { status: 'failed', exitCode: -1, error: `没有机器在 ${Math.round(effectiveTimeout / 1000)}s 内认领这个任务（runner 可能全忙或没上线）`, code: 'RUNNER_CLAIM_TIMEOUT' }
          resolveWaiter(task.result)
          return
        }
        setTimeout(tick, 50)
      }
      tick()
    })
  }

  /** 标记取消：dispatcher 把 cancel 推给 runner，runner 杀掉本地进程后回 canceled。 */
  function cancelAll(runnerId) {
    for (const taskId of running.get(runnerId) || []) {
      const task = tasks.get(taskId)
      if (task && task.status !== 'finished') {
        task.cancelRequested = true
        if (task.cancelFn) {
          try { task.cancelFn() } catch { /* best effort */ }
        }
        log('task-cancel-requested', { taskId, runnerId })
      }
    }
  }

  function activeFor(runnerId) {
    const ids = running.get(runnerId)
    if (!ids) return false
    for (const taskId of ids) {
      const task = tasks.get(taskId)
      if (task && task.status !== 'finished') return true
    }
    return false
  }

  return {
    register,
    heartbeat,
    markOffline,
    describe,
    enqueue,
    claim,
    task: (taskId) => tasks.get(taskId) || null,
    taskForRunner,
    reportLog,
    reportLogBatch,
    resolve,
    cancelAll,
    activeFor,
    listRunners,
  }
}

/** 校验 runner 注册/claim 用的 join token（sha256 摘要后 timingSafeEqual，避免时序侧信道）。 */
export function joinTokenMatches(provided, secret) {
  if (!provided || !secret) return false
  const a = createHash('sha256').update(String(provided)).digest()
  const b = createHash('sha256').update(String(secret)).digest()
  return timingSafeEqual(a, b)
}
