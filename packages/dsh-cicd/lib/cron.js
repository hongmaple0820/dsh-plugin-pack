/**
 * V2-M1：最小 5 字段 cron 解析器（分 时 日 月 周），无第三方依赖。
 *
 * 支持的语法（与 Vixie cron 的常用子集一致）：
 * - `*` 全部
 * - `*` 后跟 `/n` 的步进（也支持 `a-b/n`）
 * - `a-b` 范围、`a,b,c` 列表、普通数字
 * - 周字段允许 `0-7`（0 和 7 都是周日），月/日字段按自然范围校验
 *
 * 调度模型是「分钟对齐 + 去重」：scheduler 每 tick 用当前分钟调用 cronMatches，
 * 同一分钟内只触发一次（由调用方用 minuteKey 去重），不做 next-fire 精确计算。
 */

const FIELD_RANGES = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, // day of week（0/7=周日）
]

const DOW_ALIASES = new Map([
  ['sun', 0], ['mon', 1], ['tue', 2], ['wed', 3], ['thu', 4], ['fri', 5], ['sat', 6],
])
const MONTH_ALIASES = new Map([
  ['jan', 1], ['feb', 2], ['mar', 3], ['apr', 4], ['may', 5], ['jun', 6],
  ['jul', 7], ['aug', 8], ['sep', 9], ['oct', 10], ['nov', 11], ['dec', 12],
])

class CronError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CronError'
    this.code = 'CRON_INVALID'
  }
}

function parseNumber(token, fieldIndex) {
  const range = FIELD_RANGES[fieldIndex]
  const text = String(token).trim().toLowerCase()
  if (/^\d+$/.test(text)) {
    const value = Number(text)
    if (fieldIndex === 4 && value === 7) return 0 // 7 → 周日
    if (value < range.min || value > range.max) {
      throw new CronError(`cron 第 ${fieldIndex + 1} 个字段的值 ${token} 超出范围 ${range.min}-${range.max}`)
    }
    return value
  }
  if (fieldIndex === 4 && DOW_ALIASES.has(text)) return DOW_ALIASES.get(text)
  if (fieldIndex === 3 && MONTH_ALIASES.has(text)) return MONTH_ALIASES.get(text)
  throw new CronError(`cron 第 ${fieldIndex + 1} 个字段包含无法解析的项 “${token}”`)
}

/** 把单个字段表达式展开成命中值集合。`*` 展开为全量（周字段 0-6，7 归一为 0）。 */
function expandField(expr, fieldIndex) {
  const range = FIELD_RANGES[fieldIndex]
  const max = fieldIndex === 4 ? 6 : range.max
  const values = new Set()
  for (const part of String(expr).split(',')) {
    const piece = part.trim()
    if (!piece) throw new CronError(`cron 第 ${fieldIndex + 1} 个字段有空项`)
    const stepMatch = /^(\*|\d+-\d+|[a-z]{3}-[a-z]{3}|\d+|[a-z]{3})(?:\/(\d+))?$/i.exec(piece)
    if (!stepMatch) throw new CronError(`cron 第 ${fieldIndex + 1} 个字段的项 “${piece}” 无法解析（支持 *、*/n、a-b、a-b/n、a,b,c）`)
    const [, body, stepText] = stepMatch
    const step = stepText ? Number(stepText) : 1
    if (!Number.isInteger(step) || step < 1) throw new CronError(`cron 第 ${fieldIndex + 1} 个字段的步进 “${stepText}” 必须是正整数`)
    let start = range.min
    let end = max
    if (body !== '*') {
      const dash = body.indexOf('-')
      if (dash >= 0) {
        start = parseNumber(body.slice(0, dash), fieldIndex)
        end = parseNumber(body.slice(dash + 1), fieldIndex)
        if (fieldIndex === 4 && end === 7) end = 6
        if (start > end) throw new CronError(`cron 第 ${fieldIndex + 1} 个字段的范围 ${body} 起点大于终点`)
      } else {
        start = parseNumber(body, fieldIndex)
        end = stepText ? start : start
        if (!stepText) {
          values.add(start)
          continue
        }
      }
    }
    for (let value = start; value <= end; value += step) values.add(value)
  }
  if (values.size === 0) throw new CronError(`cron 第 ${fieldIndex + 1} 个字段展开后为空`)
  return values
}

const cache = new Map()

/** 解析并缓存一条 cron 表达式为五个命中集合。 */
export function parseCron(expr) {
  const text = String(expr || '').trim()
  const cached = cache.get(text)
  if (cached) return cached
  const fields = text.split(/\s+/)
  if (fields.length !== 5) {
    throw new CronError(`cron 表达式 “${text}” 必须是 5 个字段（分 时 日 月 周），例如 “0 3 * * *”`)
  }
  const parsed = fields.map((field, index) => expandField(field, index))
  cache.set(text, parsed)
  return parsed
}

/** 判断某个时刻（本地时区）是否命中。date 取其分钟粒度的各字段。 */
export function cronMatches(expr, date = new Date()) {
  const parsed = parseCron(expr)
  const values = [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()]
  return parsed.every((set, index) => set.has(values[index]))
}

/** 去重用的分钟键：同一分钟内的多次 tick 只算一次。 */
export function minuteKey(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 校验表达式（解析失败抛 CronError），供 pipe 校验用。 */
export function assertCron(expr) {
  parseCron(expr)
  return true
}
