/**
 * job 图调度器：按 `needs` 拓扑推进，带并发池、失败传播、取消收敛。
 *
 * 这个文件只管「什么时候可以开始哪个 job」，不关心 job 里跑什么——命令执行、日志、落库
 * 都在 runner.js。分开的理由：调度是纯逻辑（给定图和状态算出下一批可跑的），能单独测；
 * 而 runner.js 里混着 spawn、日志脱敏、store 写入，测起来要 mock 一堆东西。
 *
 * 与 v1 的关系：v1 的 stage 串行循环**完全不经过这里**（runner.js 里仍是原样），
 * 因为 v1 语义是「一个 stage 一组串行命令」，套进 DAG 会多出一层没有意义的包装。
 */

/** 04-pipe-v2.md §5.2 的十态。 */
export const JOB_STATES = [
  'queued',
  'assigned',
  'preparing',
  'running',
  'waiting_approval',
  'waiting_resource',
  'waiting_callback',
  'succeeded',
  'failed',
  'skipped',
  'canceled',
  'completed',
]

/**
 * v3.0-P1 实际能走到的状态。其余几个（assigned/preparing/waiting_*）要有远端 runner 的
 * 派发协议、资源配额或审批等待才有意义，属于 P2/P3/P4；列出来是为了让 UI 与审计在拿到
 * 这些值时不会当成未知状态，而不是假装已经实现。
 */
export const REACHABLE_STATES = ['queued', 'running', 'succeeded', 'failed', 'skipped', 'canceled', 'completed']

/** runner.js 内部既有的 status 词表（store/client 都在用）→ 十态词表。 */
export function statusToState(status, hasSkip = false) {
  if (status === 'success') return hasSkip ? 'completed' : 'succeeded'
  if (status === 'failed') return 'failed'
  if (status === 'skipped') return 'skipped'
  if (status === 'canceled') return 'canceled'
  return status
}

export const DEFAULT_CONCURRENCY = 4

/**
 * 依赖的 job 结果是否「向下传播停止」。
 *
 * 除了 success，**skipped 也要传播**：GitHub Actions 里 `needs: [a]` 而 a 被跳过时，下游默认
 * 也跳过（要跑必须显式 `if: always()`）。把 skipped 当"没阻塞"会让「上游部署被跳过了」的
 * 下游放心继续跑，这正是最需要制止的一种。v1 的 stage 循环也是这么做的（failedStages 里
 * 同时装 failed 与 skipped）。
 */
function blocksDownstream(result) {
  return Boolean(result) && result.status !== 'success'
}

/**
 * 执行 job 图。
 *
 * @param {object} options
 * @param {object[]} options.jobs 归一化后的 job（每个有 `id`，依赖写在 `needs`）
 * @param {number} [options.concurrency] 并发上限
 * @param {AbortSignal|null} [options.signal]
 * @param {(job: object) => Promise<{status: string, error?: string, durationMs?: number, steps?: object[]}>} options.runJob
 * @param {(job: object, reason: string) => void} [options.onSkip] 被上游拖累而跳过时回调
 * @param {(job: object) => void} [options.onStart] job 真正开跑前回调
 * @returns {Promise<Map<string, object>>} id → 结果
 */
export async function scheduleJobs({ jobs, concurrency = DEFAULT_CONCURRENCY, signal = null, runJob, onSkip = null, onStart = null }) {
  if (typeof runJob !== 'function') throw new TypeError('scheduleJobs 需要 runJob 回调')
  const limit = Number.isInteger(concurrency) && concurrency > 0 ? concurrency : DEFAULT_CONCURRENCY
  const byId = new Map(jobs.map((job) => [job.id, job]))
  const results = new Map()
  /** id → { promise }，promise 一定 resolve（失败也 resolve 成结果），永不 reject */
  const running = new Map()
  /** 尚未开跑也尚未落定的 job（启动时立刻移出，否则会被反复启动） */
  const pending = new Set(jobs.map((job) => job.id))

  const settle = (id, result) => {
    results.set(id, {
      status: result?.status || 'failed',
      error: result?.error || '',
      durationMs: Number.isFinite(result?.durationMs) ? result.durationMs : 0,
      steps: Array.isArray(result?.steps) ? result.steps : [],
      state: result?.state || statusToState(result?.status || 'failed'),
    })
    pending.delete(id)
  }

  const markSkipped = (job, reason) => {
    settle(job.id, { status: 'skipped', error: reason, steps: skippedSteps(job, reason), state: 'skipped' })
    try { onSkip?.(job, reason) } catch { /* 观察者错误不算调度错误 */ }
  }

  /** 关键：先 `pending.delete` 再起任务。少了这一行，同一个 job 会被内层循环反复启动直到 OOM。 */
  const launch = (job) => {
    pending.delete(job.id)
    try { onStart?.(job) } catch { /* ignore */ }
    const promise = Promise.resolve()
      .then(() => runJob(job))
      .then((result) => ({ id: job.id, result: result || { status: 'failed' } }))
      .catch((error) => ({ id: job.id, result: { status: 'failed', error: error?.message || String(error), steps: [] } }))
    running.set(job.id, promise)
  }

  while (pending.size > 0 || running.size > 0) {
    // 1. 把「依赖全部落定」的 job 尽量塞进并发池。
    //    内层循环是为了「跳过被拖累的 job 之后，下游才能立刻判定也跳过」——一轮扫描只推进一层。
    if (!signal?.aborted) {
      let progress = true
      while (progress) {
        progress = false
        if (pending.size === 0) break
        for (const id of [...pending]) {
          const job = byId.get(id)
          const needs = job.needs || []
          if (!needs.every((need) => results.has(need))) continue
          const blocking = needs.find((need) => blocksDownstream(results.get(need)))
          if (blocking) { markSkipped(job, `上游 ${blocking} 失败`); progress = true; continue }
          // 池子满了就停：等下一轮带空位再起，不算进展，否则内层会空转
          if (running.size >= limit) break
          launch(job)
          progress = true
        }
      }
    } else {
      // 取消：未开跑的记 canceled，已在跑的等它自己收（executor 收到了同一个 signal）
      for (const id of [...pending]) {
        const job = byId.get(id)
        settle(id, { status: 'canceled', error: '已取消', steps: canceledSteps(job), state: 'canceled' })
      }
    }

    if (running.size === 0) break

    // 2. 等任意一个跑完，收结果后回到第 1 步继续填池子
    const { id, result } = await Promise.race([...running.values()])
    running.delete(id)
    settle(id, result)
  }

  // 兜底：还剩没结果的（依赖成环之类，正常在 model 层已拦）记 skipped
  for (const id of pending) {
    const job = byId.get(id)
    settle(id, { status: 'skipped', error: '未执行', steps: skippedSteps(job, '未执行') })
  }
  return results
}

function skippedSteps(job, reason) {
  return (job.steps || []).map((step) => ({ ...step, status: 'skipped', durationMs: 0, exitCode: -1, error: reason }))
}

function canceledSteps(job) {
  return (job.steps || []).map((step) => ({ ...step, status: 'canceled', durationMs: 0, exitCode: -1, error: '已取消' }))
}
