/**
 * V2-M1：DORA 四指标（纯函数，输入是 store.runs() 的行，便于单测与前端复用）。
 *
 * - 部署频率 deployment frequency：窗口内成功运行数 / 天数。
 * - 变更前置时间 change lead time：提交时间（git commitAt）→ 运行结束 的小时数（取中位数）。
 * - 变更失败率 change failure rate：失败（含 canceled）/ 全部尝试。
 * - MTTR：同一 project/target 上，失败结束 → 下一次成功开始 的平均间隔。
 *
 * 只统计真实运行（dry_run 为真、没有结束时间的记录都排除），窗口按运行结束时间过滤。
 */

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

function toTime(value) {
  if (!value) return NaN
  if (value instanceof Date) return value.getTime()
  const time = Date.parse(String(value))
  return Number.isFinite(time) ? time : NaN
}

function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function average(values) {
  if (!values.length) return null
  return values.reduce((total, value) => total + value, 0) / values.length
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null
}

function dayKey(time) {
  const date = new Date(time)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function rateDeployment(perDay) {
  if (!Number.isFinite(perDay)) return 'unknown'
  if (perDay >= 1) return 'elite'
  if (perDay >= 1 / 7) return 'high'
  if (perDay >= 1 / 30) return 'medium'
  return 'low'
}

function rateLeadTime(hours) {
  if (!Number.isFinite(hours)) return 'unknown'
  if (hours < 1) return 'elite'
  if (hours < 24) return 'high'
  if (hours < 24 * 7) return 'medium'
  return 'low'
}

function rateFailure(rate) {
  if (!Number.isFinite(rate)) return 'unknown'
  if (rate <= 0.15) return 'elite'
  if (rate <= 0.3) return 'high'
  if (rate <= 0.45) return 'medium'
  return 'low'
}

function rateMttr(hours) {
  return rateLeadTime(hours)
}

function percentile(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  // 最近秩法（nearest-rank）：对 20 个样本求 P95 时，插值会给出一个从没发生过的数——
  // 运维问的是「最慢的那几次有多慢」，答案必须是一次真实观测。
  const rank = Math.ceil((Math.max(0, Math.min(100, p)) / 100) * sorted.length)
  return sorted[Math.max(0, rank - 1)]
}
function buildSeries(rows, { now, windowDays }) {
  const buckets = Math.min(windowDays, 60)
  const series = []
  const byDate = new Map()
  for (let index = buckets - 1; index >= 0; index -= 1) {
    const key = dayKey(now - index * DAY_MS)
    const row = { date: key, deployments: 0, failures: 0, canceled: 0 }
    series.push(row)
    byDate.set(key, row)
  }
  for (const row of rows) {
    const bucket = byDate.get(dayKey(row.finishedAt))
    if (!bucket) continue
    if (row.status === 'success') bucket.deployments += 1
    else if (row.status === 'failed') bucket.failures += 1
    else if (row.status === 'canceled') bucket.canceled += 1
  }
  return series
}

/**
 * v3.0-P7：运行质量指标（纯函数，输入同样是 store.runs() 的行）。
 *
 * 与 DORA 的分工：DORA 回答「交付好不好」（频率/前置时间/失败率/恢复时间），
 * 这里回答「机器忙不忙」——排队多久、跑多久、时间花在哪个 stage、同一份配置重跑了几次。
 * 两者都从同一批行算，不引入新的采集管道：一次性任务的监控数据，最贵的部分从来不是计算，是埋点。
 */
export function summarizeRunQuality({ runs = [], steps = {}, cache = null, now = Date.now(), days = 30 } = {}) {
  const windowDays = Number.isInteger(days) ? Math.max(1, Math.min(365, days)) : 30
  const from = now - windowDays * DAY_MS
  const busy = []
  const queueMs = []
  const reRuns = new Map()
  let longest = null

  for (const run of Array.isArray(runs) ? runs : []) {
    if (!run) continue
    const started = toTime(run.started_at || run.startedAt)
    const finished = toTime(run.finished_at || run.finishedAt)
    if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < from) continue
    const id = String(run.id || '')
    const durationMs = Math.max(0, finished - started)
    const row = {
      id,
      projectId: String(run.project_id || run.projectId || ''),
      target: String(run.target || ''),
      status: String(run.status || ''),
      trigger: String(run.trigger || ''),
      startedAt: started,
      finishedAt: finished,
      durationMs,
    }
    busy.push(row)
    if (!longest || durationMs > longest.durationMs) longest = row

    // 排队时长 = started_at − 该次运行「被要求开始」的时刻。没有 queued_at 列时
    // 只有重跑能算出这一段（重跑行记录了源运行），所以样本数会明显少于总运行数——
    // 报 samples 而不是让人误以为 0 就是「从不排队」。
    const queuedAt = toTime(run.queued_at || run.queuedAt)
    if (Number.isFinite(queuedAt) && started >= queuedAt) queueMs.push(started - queuedAt)

    const snapshot = String(run.config_hash || run.configHash || '')
    if (snapshot) {
      const key = `${row.projectId}\u0000${row.target}\u0000${snapshot}`
      const list = reRuns.get(key) || []
      list.push(row)
      reRuns.set(key, list)
    }
  }

  busy.sort((a, b) => a.startedAt - b.startedAt)
  const durations = busy.map((row) => row.durationMs / 1000)

  // 拥堵度：窗口内「同时在跑」的峰值。用扫描线（开始 +1 / 结束 -1）而不是按分钟打表格，
  // 运行数上万时前者的代价只跟运行数有关，跟窗口长度无关。
  const events = []
  for (const row of busy) {
    events.push([row.startedAt, 1])
    events.push([row.finishedAt, -1])
  }
  events.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]))
  let live = 0
  let peak = 0
  for (const [, delta] of events) {
    live += delta
    if (live > peak) peak = live
  }

  const stageTotals = new Map()
  for (const row of busy) {
    const list = steps?.[row.id]
    if (!Array.isArray(list)) continue
    for (const step of list) {
      if (!step) continue
      const name = String(step.stage_id ?? step.stageId ?? '')
      if (!name) continue
      const ms = Number(step.duration_ms ?? step.durationMs) || 0
      const entry = stageTotals.get(name) || { stage: name, steps: 0, durationMs: 0, failed: 0 }
      entry.steps += 1
      entry.durationMs += ms
      if (String(step.status || '') === 'failed') entry.failed += 1
      stageTotals.set(name, entry)
    }
  }
  const stages = [...stageTotals.values()]
    .map((entry) => ({ ...entry, durationMs: Math.round(entry.durationMs), share: 0 }))
    .sort((a, b) => b.durationMs - a.durationMs)
  const stageTotal = stages.reduce((total, entry) => total + entry.durationMs, 0)
  for (const entry of stages) entry.share = stageTotal > 0 ? round(entry.durationMs / stageTotal) : 0

  // 同一份配置（config_hash 相同）跑第二次以上，说明第一次没跑通或结果不被信——
  // 这是「流水线本身不稳」最直接的证据，比失败率更早出现。
  const repeated = [...reRuns.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([, list]) => ({
      projectId: list[0].projectId,
      target: list[0].target,
      runs: list.length,
      firstStartedAt: new Date(list[0].startedAt).toISOString(),
    }))
    .sort((a, b) => b.runs - a.runs)

  return {
    windowDays,
    from: new Date(from).toISOString(),
    to: new Date(now).toISOString(),
    total: busy.length,
    concurrency: { peak, average: round(busy.length > 0 ? busy.reduce((t, row) => t + row.durationMs, 0) / (windowDays * DAY_MS) : 0) },
    durationSec: {
      p50: round(percentile(durations, 50)),
      p95: round(percentile(durations, 95)),
      max: round(durations.length ? Math.max(...durations) : null),
      samples: durations.length,
    },
    queueSec: {
      p50: round(percentile(queueMs.map((ms) => ms / 1000), 50)),
      p95: round(percentile(queueMs.map((ms) => ms / 1000), 95)),
      samples: queueMs.length,
    },
    longest: longest ? { ...longest, startedAt: new Date(longest.startedAt).toISOString(), finishedAt: new Date(longest.finishedAt).toISOString() } : null,
    stages,
    repeated,
    // 缓存命中率是「省」而不是「稳」，所以它跟着运行质量一起报、但不进 DORA 四指标：
    // 命中率掉一半不会让发布变慢，只会让它变贵。
    cache: cache || null,
  }
}
/**
 * @param {object} options
 * @param {Array<object>} options.runs store.runs() 的原始行（snake_case 或 camelCase 均可）
 * @param {(commit: string, run: object) => string} [options.commitAt] 提交 sha → ISO 时间
 * @param {number} [options.now] 窗口终点（毫秒时间戳）
 * @param {number} [options.days] 窗口天数（1–365）
 */
export function summarizeDora({ runs = [], commitAt = () => '', now = Date.now(), days = 30 } = {}) {
  const windowDays = Number.isInteger(days) ? Math.max(1, Math.min(365, days)) : 30
  const from = now - windowDays * DAY_MS
  const rows = []
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!run) continue
    if (run.dry_run === 1 || run.dry_run === true || run.dryRun === true) continue
    const finished = toTime(run.finished_at || run.finishedAt) || toTime(run.started_at || run.startedAt)
    const started = toTime(run.started_at || run.startedAt)
    if (!Number.isFinite(finished) || finished < from) continue
    rows.push({
      projectId: String(run.project_id || run.projectId || ''),
      target: String(run.target || ''),
      status: String(run.status || ''),
      commit: String(run.commit_sha || run.commit || ''),
      startedAt: Number.isFinite(started) ? started : finished,
      finishedAt: finished,
    })
  }
  rows.sort((a, b) => a.finishedAt - b.finishedAt)

  const succeeded = rows.filter((run) => run.status === 'success')
  const failed = rows.filter((run) => run.status === 'failed' || run.status === 'canceled')

  const leadTimes = []
  for (const run of succeeded) {
    let commitIso = ''
    try { commitIso = commitAt(run.commit, run) || '' } catch { commitIso = '' }
    const commitTime = toTime(commitIso)
    if (!Number.isFinite(commitTime)) continue
    const hours = (run.finishedAt - commitTime) / HOUR_MS
    if (hours < 0 || hours > windowDays * 24) continue
    leadTimes.push(hours)
  }

  const attempts = succeeded.length + failed.length
  const changeFailureRate = attempts > 0 ? failed.length / attempts : null

  // MTTR：失败（或取消）之后同一 project/target 的下一次成功开始，算一次恢复。
  const recoveries = []
  const pendingFailure = new Map()
  for (const run of rows) {
    const key = `${run.projectId}|${run.target}`
    if (run.status === 'failed' || run.status === 'canceled') {
      if (!pendingFailure.has(key)) pendingFailure.set(key, run.finishedAt)
      continue
    }
    if (run.status !== 'success') continue
    if (!pendingFailure.has(key)) continue
    const failedAt = pendingFailure.get(key)
    pendingFailure.delete(key)
    const hours = (run.startedAt - failedAt) / HOUR_MS
    if (hours >= 0) recoveries.push(hours)
  }

  const deployments = succeeded.length
  const perDay = windowDays > 0 ? deployments / windowDays : 0
  const leadAverage = average(leadTimes)
  const leadMedian = median(leadTimes)
  const mttrAverage = average(recoveries)

  return {
    windowDays,
    from: new Date(from).toISOString(),
    to: new Date(now).toISOString(),
    total: rows.length,
    deployments,
    failures: failed.length,
    deploymentFrequency: {
      deployments,
      perDay: round(perDay),
      perWeek: round(perDay * 7),
    },
    leadTimeHours: {
      avg: round(leadAverage),
      median: round(leadMedian),
      samples: leadTimes.length,
    },
    changeFailureRate: round(changeFailureRate),
    mttrHours: {
      avg: round(mttrAverage),
      samples: recoveries.length,
    },
    levels: {
      deploymentFrequency: rateDeployment(perDay),
      leadTime: rateLeadTime(leadMedian),
      changeFailureRate: rateFailure(changeFailureRate),
      mttr: rateMttr(mttrAverage),
    },
    series: buildSeries(rows, { now, windowDays }),
  }
}
