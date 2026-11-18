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
