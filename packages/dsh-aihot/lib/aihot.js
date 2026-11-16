/**
 * AIHOT 公共 API 的纯逻辑层。
 *
 * 只做四件事：拼 URL、发请求（含重试与限流处理）、解析 JSON、截断文本。
 * 不依赖 Cordis、不读全局状态，所有副作用都通过参数注入，便于 `test/smoke.mjs` 用假 fetch 单测。
 *
 * 端点依据 `aihot-openapi.json`（AIHOT Public API 2.0.0，openapi 3.1.0）：
 * - 给模型：/api/v1/agent/{latest,search,hot,daily,weekly,monthly,codex-resets,...,stories/{id}}，返回 text/markdown
 * - 给页面：/api/v1/{items,hot-topics,dailies/latest,stories/{id}}，返回 application/json
 */

export const BASE_URL = 'https://aihot.news'

/** Markdown 端点使用的 UA（AIHOT 官方 AIHOT Skill 约定的那种写法）。 */
export const MARKDOWN_UA = 'aihot-skill/2.0.0 (+https://aihot.news/aihot-skill/)'
/** JSON 端点使用的 UA。 */
export const JSON_UA = 'aihot-api/2.0.0'

/** 时间窗口（OpenAPI enum）。 */
export const WINDOWS = ['24h', '7d']
/** 条目范围：selected = 编辑精选，all = 全部入库。 */
export const MODES = ['selected', 'all']
/** 分类（OpenAPI examples；未知值原样透传会被上游 400，所以这里收敛）。 */
export const CATEGORIES = ['ai-models', 'ai-products', 'industry', 'paper', 'tip', 'opinion']
/** 额度重置监控的服务。 */
export const RESET_SERVICES = ['codex', 'antigravity', 'claude', 'grok-bot']
/** 重置监控的取数范围：recent = 近 7 天快照（默认），all = 完整历史。 */
export const RESET_SCOPES = ['recent', 'all']

/** 各端点的 limit 上限与默认值（取自 OpenAPI parameters）。 */
const LIMITS = {
  latest: { max: 30, def: 10 },
  search: { max: 30, def: 10 },
  hot: { max: 10, def: 10 },
  story: { max: 50, def: 20 },
  items: { max: 100, def: 50 },
  period: { max: 60, def: 12 },
  leaderboard: { max: 60, def: 50 },
}

/** 期刊类型：weekly = 周报，monthly = 月报。 */
export const PERIOD_KINDS = ['weekly', 'monthly']

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const WEEK_RE = /^\d{4}-W\d{2}$/
const MONTH_RE = /^\d{4}-\d{2}$/

/* ------------------------------------------------------------------ 校验 */

function pickEnum(value, allowed, name) {
  if (value === undefined || value === null || value === '') return undefined
  if (!allowed.includes(value)) {
    throw new RangeError(`参数 ${name} 无效：${value}（可选 ${allowed.join(' / ')}）`)
  }
  return value
}

function pickInt(value, { min = 1, max, def }, name) {
  if (value === undefined || value === null || value === '') return def
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new RangeError(`参数 ${name} 必须是 ${min}–${max} 之间的整数`)
  }
  return n
}

function pickText(value, { min = 1, max = 200, required = false }, name) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new RangeError(`参数 ${name} 必填`)
    return undefined
  }
  const text = String(value).trim()
  if (text.length < min) throw new RangeError(`参数 ${name} 至少 ${min} 个字符`)
  if (text.length > max) throw new RangeError(`参数 ${name} 最多 ${max} 个字符`)
  return text
}

function pickPattern(value, pattern, message, name) {
  const text = pickText(value, { min: 1, max: 128, required: true }, name)
  if (!pattern.test(text)) throw new RangeError(message)
  return text
}

/** 可选路径参数：给了才校验，没给返回 undefined。 */
function optionalPattern(value, pattern, message, name) {
  if (value === undefined || value === null || value === '') return undefined
  return pickPattern(value, pattern, message, name)
}

/* ------------------------------------------------------------------ URL */

function withQuery(path, query) {
  const url = new URL(path, BASE_URL)
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
  }
  return url.toString()
}

/**
 * 按端点类型构造请求 URL，并校验参数。
 *
 * kind：
 * - `latest` / `search` / `hot` / `daily` / `weekly` / `monthly` / `resets` / `story`（Markdown，给模型）
 * - `items` / `hot-topics` / `daily-report`（JSON，给页面）
 *
 * @param {string} kind 端点类型
 * @param {object} [params] 参数（window / mode / category / limit / q / date / week / month / service / publicId）
 * @returns {string} 绝对 URL
 */
export function buildUrl(kind, params = {}) {
  const p = params || {}
  switch (kind) {
    case 'latest':
      return withQuery('/api/v1/agent/latest', {
        window: pickEnum(p.window, WINDOWS, 'window') ?? '24h',
        mode: pickEnum(p.mode, MODES, 'mode') ?? 'selected',
        category: pickEnum(p.category, CATEGORIES, 'category'),
        limit: pickInt(p.limit, LIMITS.latest, 'limit'),
      })
    case 'search':
      return withQuery('/api/v1/agent/search', {
        q: pickText(p.q, { min: 2, max: 200, required: true }, 'q'),
        window: pickEnum(p.window, WINDOWS, 'window') ?? '7d',
        category: pickEnum(p.category, CATEGORIES, 'category'),
        limit: pickInt(p.limit, LIMITS.search, 'limit'),
      })
    case 'hot':
      return withQuery('/api/v1/agent/hot', { limit: pickInt(p.limit, LIMITS.hot, 'limit') })
    case 'daily': {
      const date = optionalPattern(p.date, DATE_RE, '参数 date 需为 YYYY-MM-DD（北京时间日期）', 'date')
      return withQuery(date ? `/api/v1/agent/daily/${date}` : '/api/v1/agent/daily')
    }
    case 'weekly': {
      const week = optionalPattern(p.week, WEEK_RE, '参数 week 需为 ISO 周标签，如 2026-W39', 'week')
      return withQuery(week ? `/api/v1/agent/weekly/${week}` : '/api/v1/agent/weekly')
    }
    case 'monthly': {
      const month = optionalPattern(p.month, MONTH_RE, '参数 month 需为 2026-09 这样的月份', 'month')
      return withQuery(month ? `/api/v1/agent/monthly/${month}` : '/api/v1/agent/monthly')
    }
    case 'resets': {
      const service = pickEnum(p.service, RESET_SERVICES, 'service')
      if (!service) throw new RangeError(`参数 service 必填（可选 ${RESET_SERVICES.join(' / ')}）`)
      return withQuery(`/api/v1/agent/${service}-resets`)
    }
    case 'story': {
      const publicId = pickPattern(p.publicId, /^[A-Za-z0-9._:-]{1,128}$/, '参数 publicId 只能是 1–128 位字母、数字、点、下划线、冒号或连字符', 'publicId')
      return withQuery(`/api/v1/agent/stories/${encodeURIComponent(publicId)}`, {
        limit: pickInt(p.limit, LIMITS.story, 'limit'),
      })
    }
    case 'story-json': {
      const publicId = pickPattern(p.publicId, /^[A-Za-z0-9._:-]{1,128}$/, '参数 id 只能是 1–128 位字母、数字、点、下划线、冒号或连字符', 'id')
      // 上游 /api/v1/stories/{id} 不接受 limit（未知查询参数会 400），要几条由路由本地截断。
      return withQuery(`/api/v1/stories/${encodeURIComponent(publicId)}`)
    }
    case 'items':
      return withQuery('/api/v1/items', {
        mode: pickEnum(p.mode, MODES, 'mode') ?? 'selected',
        category: pickEnum(p.category, CATEGORIES, 'category'),
        window: pickEnum(p.window, WINDOWS, 'window') ?? '7d',
        q: pickText(p.q, { min: 2, max: 200 }, 'q'),
        limit: pickInt(p.limit, LIMITS.items, 'limit'),
      })
    case 'hot-topics':
      return withQuery('/api/v1/hot-topics')
    case 'daily-report':
      return withQuery('/api/v1/dailies/latest')
    case 'weeklies-json':
      return withQuery('/api/v1/weeklies', { limit: pickInt(p.limit, LIMITS.period, 'limit') })
    case 'monthlies-json':
      return withQuery('/api/v1/monthlies', { limit: pickInt(p.limit, LIMITS.period, 'limit') })
    case 'weekly-json': {
      const week = pickPattern(p.week, WEEK_RE, '参数 issue 需为 ISO 周标签，如 2026-W39', 'issue')
      return withQuery(`/api/v1/weeklies/${encodeURIComponent(week)}`)
    }
    case 'monthly-json': {
      const month = pickPattern(p.month, MONTH_RE, '参数 issue 需为 2026-09 这样的月份', 'issue')
      return withQuery(`/api/v1/monthlies/${encodeURIComponent(month)}`)
    }
    case 'resets-json': {
      const service = pickEnum(p.service, RESET_SERVICES, 'service')
      if (!service) throw new RangeError(`参数 service 必填（可选 ${RESET_SERVICES.join(' / ')}）`)
      const scope = pickEnum(p.scope, RESET_SCOPES, 'scope') ?? 'recent'
      // OpenAPI 约定：/recent 是近 7 天快照，去掉才是完整历史。
      return withQuery(`/api/v1/${service}-resets${scope === 'all' ? '' : '/recent'}`)
    }
    default:
      throw new RangeError(`未知的 AIHOT 端点类型：${kind}`)
  }
}

/* ------------------------------------------------------------------ 缓存 */

/** 事件时间线条数（1–50，默认 20）：路由与 buildUrl 共用同一套校验。 */
export function storyLimit(value) {
  return pickInt(value, LIMITS.story, 'limit')
}

/** 期刊索引条数（1–60，默认 12）：路由与 buildUrl 共用同一套校验。 */
export function periodLimit(value) {
  return pickInt(value, LIMITS.period, 'limit')
}

/** 排行榜行数（1–60，默认 50）：SSR 页一次给全 50 行，这里只做本地截断。 */
export function leaderboardLimit(value) {
  return pickInt(value, LIMITS.leaderboard, 'limit')
}

const CACHE_MAX_ENTRIES = 64
const cache = new Map()

/** 清空内存缓存（单测与手动重试用）。 */
export function clearCache() {
  cache.clear()
}

function cacheLookup(url, ttlMs, now) {
  const hit = cache.get(url)
  if (hit === undefined) return undefined
  if (ttlMs <= 0 || now - hit.at > ttlMs) {
    cache.delete(url)
    return undefined
  }
  return hit.text
}

function cacheStore(url, text, now) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(url, { at: now, text })
}

/* ------------------------------------------------------------------ 请求 */

const sleepReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function headerOf(response, name) {
  const headers = response?.headers
  if (!headers) return null
  if (typeof headers.get === 'function') return headers.get(name)
  return headers[name] ?? headers[name.toLowerCase()] ?? null
}

/** Retry-After → 毫秒；最多等 5s（AIHOT 约定 429 时按它退避）。 */
function retryAfterMs(value) {
  if (value === null || value === undefined || value === '') return 1000
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.min(5000, Math.max(0, seconds * 1000))
  const at = Date.parse(value)
  if (Number.isFinite(at)) return Math.min(5000, Math.max(0, at - Date.now()))
  return 1000
}

function isTimeout(error) {
  const name = error?.name
  return name === 'TimeoutError' || name === 'AbortError' || error?.code === 'ETIMEDOUT' || error?.code === 'UND_ERR_CONNECT_TIMEOUT'
}

function timeoutSignal(signal, timeoutMs) {
  const timeout = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : undefined
  if (!signal) return timeout
  if (!timeout) return signal
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout])
  return signal
}

/** 带 HTTP 状态码的错误：路由据此把上游 404 透成 404，其余算 502。 */
function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

/** 把上游 problem+json（或纯文本）收成一行可读原因。 */
function problemDetail(text) {
  if (typeof text !== 'string' || text.trim() === '') return ''
  try {
    const problem = JSON.parse(text)
    const detail = problem?.detail ?? problem?.title ?? problem?.error
    if (typeof detail === 'string' && detail.trim() !== '') return detail.slice(0, 300)
  } catch {
    // 不是 JSON，按纯文本处理
  }
  return text.slice(0, 300)
}

/**
 * 发一次 GET 并把响应读成文本，处理 429 / 5xx / 超时，最多重试 1 次。
 *
 * @param {string} url 绝对 URL
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] 可注入的 fetch（单测用）
 * @param {number} [options.timeoutMs] 单次请求超时，默认 8000
 * @param {number} [options.retries] 重试次数，默认 1
 * @param {string} [options.ua] User-Agent
 * @param {string} [options.accept] Accept
 * @param {AbortSignal} [options.signal] 外部取消信号（工具取消时透传）
 * @param {(ms: number) => Promise<void>} [options.sleep] 可注入的等待实现（单测用）
 * @param {() => number} [options.now] 可注入的时钟
 * @param {number} [options.cacheTtlMs] 缓存时长，0 = 不缓存
 * @returns {Promise<string>} 响应正文
 */
export async function requestText(url, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    timeoutMs = 8000,
    retries = 1,
    ua = JSON_UA,
    accept = 'application/json',
    signal,
    sleep = sleepReal,
    now = Date.now,
    cacheTtlMs = 0,
  } = options

  if (typeof fetchImpl !== 'function') throw new Error('当前环境没有可用的 fetch，无法访问 AIHOT')
  if (typeof url !== 'string' || url === '') throw new RangeError('AIHOT 请求 URL 为空')

  const cached = cacheTtlMs > 0 ? cacheLookup(url, cacheTtlMs, now()) : undefined
  if (cached !== undefined) return cached

  const headers = { 'user-agent': ua, accept }
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response
    try {
      response = await fetchImpl(url, { method: 'GET', headers, signal: timeoutSignal(signal, timeoutMs) })
    } catch (error) {
      if (signal?.aborted) throw error
      lastError = isTimeout(error)
        ? new Error(`AIHOT 请求超时（${timeoutMs}ms）`)
        : new Error(`AIHOT 请求失败：${error?.message || String(error)}`)
      if (attempt < retries) {
        await sleep(200)
        continue
      }
      throw lastError
    }

    const status = response?.status ?? 0
    if (status >= 200 && status < 300) {
      const text = await response.text()
      if (typeof text !== 'string' || text.trim() === '') throw new Error('AIHOT 返回了空响应')
      if (cacheTtlMs > 0) cacheStore(url, text, now())
      return text
    }

    if (status === 429) {
      const wait = retryAfterMs(headerOf(response, 'retry-after'))
      if (attempt < retries) {
        await sleep(wait)
        continue
      }
      throw httpError(status, `AIHOT 限流（429），已按 Retry-After 等待 ${Math.round(wait / 100) / 10}s 后仍被限流，请稍后再试`)
    }

    if (status >= 500) {
      if (attempt < retries) {
        await sleep(300)
        continue
      }
      throw httpError(status, `AIHOT 服务暂时不可用（HTTP ${status}），请稍后重试`)
    }

    // 4xx：上游返回 application/problem+json，优先取 detail / title 给可读原因。
    const detail = problemDetail(await response.text().catch(() => ''))
    throw httpError(status, `AIHOT 拒绝了请求（HTTP ${status}）${detail ? `：${detail}` : ''}`)
  }

  throw lastError ?? new Error('AIHOT 请求未完成')
}

/**
 * 读取 AIHOT 的 Markdown 端点（给模型看的整理稿）。
 * @returns {Promise<string>} 中文 Markdown 原文
 */
export function requestMarkdown(url, options = {}) {
  return requestText(url, {
    ...options,
    ua: options.ua ?? MARKDOWN_UA,
    accept: options.accept ?? 'text/markdown, text/plain;q=0.9, */*;q=0.1',
  })
}

/**
 * 把 JSON 文本解析成对象；失败时抛中文错误。
 * @returns {unknown}
 */
export function parseJson(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('AIHOT 返回了空响应，无法解析 JSON')
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`AIHOT 返回的不是合法 JSON：${error?.message || String(error)}`)
  }
}

/**
 * 读取 AIHOT 的 JSON 端点并解析。
 * @returns {Promise<unknown>}
 */
export async function requestJson(url, options = {}) {
  const text = await requestText(url, {
    ...options,
    ua: options.ua ?? JSON_UA,
    accept: options.accept ?? 'application/json',
  })
  return parseJson(text)
}

/* ------------------------------------------------------------------ 截断 */

/**
 * 按 UTF-8 字节数截断（默认 48KB），截断时补一行提示。
 * @param {string} text 原文
 * @param {number} [maxBytes] 上限字节数
 * @returns {string}
 */
export function truncateBytes(text, maxBytes = 48 * 1024) {
  const source = typeof text === 'string' ? text : String(text ?? '')
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return ''
  if (typeof TextEncoder === 'undefined') return source.slice(0, maxBytes)
  const encoder = new TextEncoder()
  if (encoder.encode(source).length <= maxBytes) return source
  const marker = '\n\n…（内容过长，已按 48KB 截断；需要更多请缩小 limit 或窗口）'
  const budget = Math.max(0, maxBytes - encoder.encode(marker).length)
  let used = 0
  let out = ''
  for (const char of source) {
    const size = encoder.encode(char).length
    if (used + size > budget) break
    out += char
    used += size
  }
  return out + marker
}

/* -------------------------------------------------------- 条目页正文抽取 */

/** 正文文本上限：64KB（UTF-8 字节），超了标记 truncated。 */
export const ARTICLE_MAX_BYTES = 64 * 1024
/** 单段超过 2000 字再硬切成多段，避免一段话撑爆抽屉。 */
const ARTICLE_MAX_PARAGRAPH_CHARS = 2000

const ENTITY_MAP = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  middot: '·',
  times: '×',
  copy: '©',
}

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code)
        } catch {
          return whole
        }
      }
      return whole
    }
    const mapped = ENTITY_MAP[body.toLowerCase()]
    return mapped === undefined ? whole : mapped
  })
}

/** 去标签 + 合并实体 + 压空白，得到一行纯文本。 */
function plainText(html) {
  return decodeEntities(String(html ?? '').replace(/<[^>]*>/g, ' '))
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 取 `<meta property="og:title" content="…">` 之类的元信息（属性顺序无关）。 */
function metaContent(html, key) {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? []
  for (const tag of tags) {
    if (!new RegExp(`(?:property|name)=["']${key}["']`, 'i').test(tag)) continue
    const content = /content=["']([\s\S]*?)["']/i.exec(tag)?.[1]
    if (content !== undefined) return decodeEntities(content).replace(/\s+/g, ' ').trim()
  }
  return ''
}

/** 正文容器：优先 `<article>`；页面改版没有 article 时退回整页。 */
function articleRegion(html) {
  const match = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html)
  return match ? match[1] : html
}

function stripNoiseBlocks(html) {
  return html.replace(/<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
}

/** 站点头部的噪声行：纯符号、日期/时间、相对时间。 */
function isNoiseLine(line) {
  if (line.length < 3) return true
  if (/^[\s·•|/\\\-–—_]+$/.test(line)) return true
  if (/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(line)) return true
  if (/^\d+\s*(分钟|小时|天|周|个月)前$/.test(line)) return true
  return false
}

function paragraphsFromTags(html) {
  const out = []
  for (const match of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) out.push(plainText(match[1]))
  return out
}

/** 兜底：article 里没有足够的 `<p>` 时，把块级标签换成换行再按行切。 */
function paragraphsFromBlocks(html) {
  const broken = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|h[1-6]|li|blockquote|tr|table)\s*>/gi, '\n')
  return broken.split('\n').map(plainText)
}

function cleanParagraphs(list, title = '') {
  const out = []
  for (const raw of list) {
    const line = plainText(raw)
    if (isNoiseLine(line)) continue
    if (title && line === title) continue // 站点常把 h1 标题再当一段重复一遍
    out.push(line)
  }
  return out
}

function capParagraphs(paragraphs) {
  const encoder = typeof TextEncoder === 'undefined' ? null : new TextEncoder()
  const out = []
  let bytes = 0
  let chars = 0
  let truncated = false
  for (const paragraph of paragraphs) {
    const size = encoder ? encoder.encode(paragraph).length + 1 : paragraph.length + 1
    if (bytes + size > ARTICLE_MAX_BYTES) {
      truncated = true
      break
    }
    out.push(paragraph)
    bytes += size
    chars += paragraph.length
  }
  return { paragraphs: out, chars, truncated }
}

/**
 * 把 AIHOT 条目页 HTML 抽成正文段落（纯函数，可单测）。
 *
 * 条目页是服务端渲染的静态 HTML：`<article>` 里有头部（来源 / 时间）、`<h1>` 标题、
 * 以及正文 `<p>`。这里优先只要 `<p>`，避免把站点导航、评分徽标之类的行当正文。
 *
 * @param {string} html 条目页 HTML
 * @returns {{title: string, description: string, source: string, publishedAt: string,
 *   paragraphs: string[], chars: number, truncated: boolean, fallback: boolean}}
 */
export function extractArticle(html) {
  const page = typeof html === 'string' ? html : ''
  const region = stripNoiseBlocks(articleRegion(page))

  const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(region)?.[1]
  const title = plainText(heading || metaContent(page, 'og:title') || /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(page)?.[1] || '')
  const description = metaContent(page, 'og:description')

  const timeMatch = /<time\b[^>]*datetime=["']([^"']+)["']/i.exec(region) ?? /"datePublished"\s*:\s*"([^"]+)"/i.exec(page)
  const publishedAt = timeMatch ? timeMatch[1] : ''

  const source = plainText(/<span class="font-semibold text-ink-2">([\s\S]*?)<\/span>/i.exec(region)?.[1] || '')

  let paragraphs = cleanParagraphs(paragraphsFromTags(region), title)
  let fallback = false
  if (paragraphs.length < 3) {
    const blocks = cleanParagraphs(paragraphsFromBlocks(region), title)
    if (blocks.length > paragraphs.length) {
      paragraphs = blocks
      fallback = true
    }
  }

  const split = []
  for (const paragraph of paragraphs) {
    if (paragraph.length <= ARTICLE_MAX_PARAGRAPH_CHARS) {
      split.push(paragraph)
      continue
    }
    for (let start = 0; start < paragraph.length; start += ARTICLE_MAX_PARAGRAPH_CHARS) {
      split.push(paragraph.slice(start, start + ARTICLE_MAX_PARAGRAPH_CHARS))
    }
  }

  const capped = capParagraphs(split)
  return {
    title,
    description,
    source,
    publishedAt,
    paragraphs: capped.paragraphs,
    chars: capped.chars,
    truncated: capped.truncated,
    fallback,
  }
}

/* --------------------------------------- 站点页（SSR HTML）抽取（v2.0） */

/**
 * 站点页路径。这些页面没有 JSON 接口，只能抓服务端渲染的 HTML 再抽取；
 * 页面改版会让抽取退化（字段留空串，不编造），改版时集中改这里和下面的抽取函数。
 */
export const SSR_PATHS = {
  leaderboard: '/leaderboard',
  freeTokens: '/free-tokens',
  resetCalendar: '/resets',
  agentAccess: '/agent',
}

export const AGENT_MODE_IDS = ['skill', 'mcp', 'rss', 'api']

const PENDING_SECTION_LIMIT = 20000

/** 取标签里某个属性（属性顺序无关），实体解码后压成一行。 */
function attributeOf(tag, name) {
  const match = new RegExp(`${name}=["']([\\s\\S]*?)["']`, 'i').exec(String(tag ?? ''))
  return match ? decodeEntities(match[1]).replace(/\s+/g, ' ').trim() : ''
}

/** 第一个捕获组的纯文本；没匹配到就是空串。 */
function firstText(html, pattern) {
  const match = pattern.exec(String(html ?? ''))
  return match ? plainText(match[1]) : ''
}

/**
 * 按开标签切块：用零宽前瞻切，每个块都以完整开标签开头（交给 plainText 去标签），
 * 第一块是首个开标签之前的页面噪声，丢掉。
 */
function splitChunks(html, pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  const boundary = new RegExp(`(?=${pattern.source})`, flags)
  return String(html ?? '').split(boundary).slice(1)
}

/** `<pre><code>` 这类可复制文本：只去 HTML 注释与实体，保留原始换行。 */
function codeText(html) {
  return decodeEntities(String(html ?? '').replace(/<!--[\s\S]*?-->/g, '')).replace(/\u00a0/g, ' ').trim()
}

/** 在块里找第一个带 title 的 span（可再按 class 片段过滤）。 */
function titledSpan(chunk, classPattern) {
  for (const tag of String(chunk ?? '').match(/<span\b[^>]*>/gi) ?? []) {
    if (!/title=["']/i.test(tag)) continue
    if (classPattern && !classPattern.test(tag)) continue
    return tag
  }
  return ''
}

/** 取某个开标签之后的纯文本，直到它自己的闭合标签。 */
function textAfterTag(chunk, tag) {
  const index = String(chunk ?? '').indexOf(tag)
  if (index < 0 || !tag) return ''
  const rest = String(chunk).slice(index + tag.length)
  const end = rest.indexOf('</span>')
  return plainText(end >= 0 ? rest.slice(0, end) : rest)
}

/**
 * 排行榜页：`<table>` 逐行抽模型名次/价格/评分，「暂不排名」区块单独收。
 * @param {string} html /leaderboard 页面 HTML
 */
export function extractLeaderboard(html) {
  const page = stripNoiseBlocks(typeof html === 'string' ? html : '')
  const table = /<table\b[\s\S]*?<\/table>/i.exec(page)?.[0] ?? ''

  const rows = []
  for (const chunk of splitChunks(table, /<tr[\s>]/i)) {
    if (/<th[\s>]/i.test(chunk)) continue
    const cells = splitChunks(chunk, /<td[\s>]/i)
    if (cells.length < 8) continue
    const name = firstText(cells[1], /<strong\b[^>]*>([\s\S]*?)<\/strong>/i)
    if (!name) continue
    const coverageText = plainText(cells[3])
    const scoreText = /评分\s*([\d.]+)/i.exec(cells[7])?.[1] ?? plainText(cells[7]).match(/^[\d.]+/) ?? ''
    rows.push({
      rank: Number(plainText(cells[0]).match(/\d+/)?.[0] ?? '') || rows.length + 1,
      name,
      org: firstText(cells[1], /<small\b[^>]*class="[^"]*hidden[^"]*"[^>]*>([\s\S]*?)<\/small>/i),
      slug: /href="\/leaderboard\/([^"?#]+)"/i.exec(cells[1])?.[1] ?? '',
      launchedAt: plainText(cells[2]),
      evaluations: Number(/\d+/.exec(coverageText)?.[0] ?? '') || 0,
      coverage: Number(/([\d.]+)\s*%/.exec(coverageText)?.[1] ?? '') || 0,
      priceCache: plainText(cells[4]),
      priceInput: plainText(cells[5]),
      priceOutput: plainText(cells[6]),
      score: Number(String(scoreText).trim()) || 0,
    })
  }

  const other = []
  const pendingStart = page.indexOf('id="lb-pending-title"')
  if (pendingStart >= 0) {
    const region = page.slice(pendingStart, pendingStart + PENDING_SECTION_LIMIT)
    const list = /<ul\b[\s\S]*?<\/ul>/i.exec(region)?.[0] ?? ''
    for (const chunk of splitChunks(list, /<li[\s>]/i)) {
      const name = firstText(chunk, /<span\b[^>]*class="[^"]*block truncate[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
      if (!name) continue
      const score = Number(/[\d.]+/.exec(plainText(/<span\b[^>]*class="[^"]*mono[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(chunk)?.[1] ?? ''))?.[0] ?? '') || 0
      other.push({
        name,
        slug: /href="\/leaderboard\/([^"?#]+)"/i.exec(chunk)?.[1] ?? '',
        org: /\/model-providers\/([a-z0-9-]+)\.svg/i.exec(chunk)?.[1] ?? '',
        note: firstText(chunk, /<small\b[^>]*>([\s\S]*?)<\/small>/i),
        score,
      })
    }
  }

  return { rows, other, total: rows.length, pendingTotal: other.length, updatedAt: '' }
}

const FREE_TOKEN_SECTIONS = ['每天都能领', '每月都能领', '其他福利']

/**
 * 羊毛页：三个福利分区（每天/每月/其他）+「我的卡册」。
 * @param {string} html /free-tokens 页面 HTML
 */
export function extractFreeTokens(html) {
  const page = stripNoiseBlocks(typeof html === 'string' ? html : '')

  const sections = []
  for (const title of FREE_TOKEN_SECTIONS) {
    const anchor = page.indexOf(`aria-label="${title}"`)
    if (anchor < 0) continue
    const nextStarts = FREE_TOKEN_SECTIONS.filter((name) => name !== title)
      .map((name) => page.indexOf(`aria-label="${name}"`, anchor + 1))
      .filter((index) => index > anchor)
    const end = nextStarts.length > 0 ? Math.min(...nextStarts) : page.length
    const region = page.slice(anchor, end)

    const items = []
    for (const chunk of splitChunks(region, /<li[\s>]/i)) {
      const itemTitle = firstText(chunk, /<span\b[^>]*class="[^"]*text-\[15px\][^"]*"[^>]*>([\s\S]*?)<\/span>/i)
      if (!itemTitle) continue
      const descTag = titledSpan(chunk, /mt-1\b/)
      const amountTag = titledSpan(chunk, /min-w-16/)
      const amountTitle = attributeOf(amountTag, 'title')
      items.push({
        title: itemTitle,
        desc: attributeOf(descTag, 'title') || textAfterTag(chunk, descTag),
        link: decodeEntities(/<a\b[^>]*href="(https?:\/\/[^"]+)"/i.exec(chunk)?.[1] ?? ''),
        period: amountTitle.split('·')[0].trim(),
        badge: textAfterTag(chunk, amountTag),
        validity: firstText(chunk, /有效期：([\s\S]*?)<\/p>/i),
      })
    }
    if (items.length > 0) sections.push({ title, items })
  }

  let album = null
  const albumStart = page.indexOf('我的卡册')
  if (albumStart >= 0) {
    const dailyStart = page.indexOf('aria-label="每天都能领"')
    const region = page.slice(albumStart, dailyStart > albumStart ? dailyStart : page.length)
    const cards = []
    for (const chunk of splitChunks(region, /<li class="ft-slot"/i)) {
      const button = /<button\b[^>]*>/i.exec(chunk)?.[0] ?? ''
      const label = attributeOf(button, 'aria-label') || attributeOf(button, 'title')
      if (!label) continue
      const parts = label.split('，')
      cards.push({
        title: parts[0] ?? label,
        state: parts[1] ?? '',
        badge: firstText(chunk, /<span class="ft-cd-val"[^>]*>([\s\S]*?)<\/span>/i),
      })
    }
    album = {
      summary: firstText(region, /(\d+ 张，还没收)/i),
      total: Number(/(\d+) 张/.exec(plainText(region))?.[1] ?? '') || cards.length,
      cards,
    }
  }

  return { sections, album, updatedAt: '' }
}

const RESET_BADGE_LIMIT = 24

/**
 * 重置监控页：最近一次发卡 + 日历里「有事件」的日期（额度重置 / 发重置卡）。
 * @param {string} html /resets 页面 HTML
 */
export function extractResetCalendar(html) {
  const raw = typeof html === 'string' ? html : ''
  const page = stripNoiseBlocks(raw)

  const stats = []
  for (const match of page.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)) {
    const label = plainText(match[1])
    const value = plainText(match[2])
    if (label && value) stats.push({ label, value })
  }

  const days = []
  for (const match of page.matchAll(/<a\b[^>]*role="gridcell"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const tag = match[0]
    const date = attributeOf(tag.slice(0, tag.indexOf('>') + 1), 'data-day')
    if (!date) continue
    const ariaLabel = attributeOf(tag.slice(0, tag.indexOf('>') + 1), 'aria-label')
    const services = []
    for (const badge of match[1].matchAll(/class="[^"]*rounded-mark[^"]*"[^>]*>([\s\S]*?)<\/span>/gi)) {
      const label = plainText(badge[1])
      if (label && !services.includes(label)) services.push(label)
    }
    if (services.length === 0) continue
    days.push({
      date,
      services: services.slice(0, RESET_BADGE_LIMIT),
      today: /今天/.test(ariaLabel),
      label: ariaLabel,
    })
  }
  days.sort((left, right) => (left.date < right.date ? 1 : left.date > right.date ? -1 : 0))

  const historyDates = []
  for (const match of raw.matchAll(/\/codex-reset\/history\/(\d{4}-\d{2}-\d{2})/g)) {
    if (!historyDates.includes(match[1])) historyDates.push(match[1])
  }
  historyDates.sort((left, right) => (left < right ? 1 : left > right ? -1 : 0))

  const monthMatch = /(\d{4}) 年 (\d{1,2}) 月重置记录/.exec(page) ?? /(\d{4}) 年 (\d{1,2}) 月/.exec(page)

  let lastCard = ''
  for (const match of page.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)) {
    const text = plainText(match[1])
    const index = text.indexOf('上一次重置卡发放：')
    if (index >= 0) {
      lastCard = text.slice(index + '上一次重置卡发放：'.length).trim()
      break
    }
  }

  return {
    lastCard,
    month: monthMatch ? `${monthMatch[1]}-${String(monthMatch[2]).padStart(2, '0')}` : '',
    monthLabel: monthMatch ? `${monthMatch[1]} 年 ${monthMatch[2]} 月` : '',
    days,
    stats,
    historyDates: historyDates.slice(0, 60),
    updatedAt: '',
  }
}

function agentTabs(page) {
  const tabs = []
  for (const chunk of splitChunks(page, /<a\b[^>]*role="tab"/i)) {
    const id = /id="agent-tab-([a-z]+)"/i.exec(chunk)?.[1] ?? ''
    if (!AGENT_MODE_IDS.includes(id)) continue
    const clipped = chunk.slice(0, chunk.indexOf('</a>') >= 0 ? chunk.indexOf('</a>') : chunk.length)
    tabs.push({
      id,
      title: firstText(clipped, /<span\b[^>]*class="[^"]*mt-3\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i),
      desc: firstText(clipped, /<span\b[^>]*class="[^"]*mt-1\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i),
      clients: firstText(clipped, /<span\b[^>]*class="[^"]*mt-2\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i),
      href: attributeOf(/<a\b[^>]*>/.exec(clipped)?.[0] ?? '', 'href'),
    })
  }
  return tabs
}

/** 从一个「接入方式」面板里抽标题、版本标签、第一段可复制文本、RSS 订阅地址。 */
function agentPanel(page) {
  if (!page) return null
  const id = /id="agent-panel"[^>]*aria-labelledby="agent-tab-([a-z]+)"/i.exec(page)?.[1]
    ?? /aria-labelledby="agent-tab-([a-z]+)"[^>]*class="[^"]*"[^>]*id="agent-panel"/i.exec(page)?.[1]
    ?? ''
  const panelStart = page.indexOf('id="agent-panel"')
  if (!id || panelStart < 0) return null
  const mainEnd = page.indexOf('</main>')
  const region = page.slice(panelStart, mainEnd > panelStart ? mainEnd : page.length)

  const label = firstText(region, /class="mono text-\[11\.5px\][^"]*"[^>]*>([\s\S]*?)<\/div>/i)
  const heading = firstText(region, /<h2\b[^>]*>([\s\S]*?)<\/h2>/i)
  const copyText = codeText(/<pre\b[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code>/i.exec(region)?.[1] ?? '')

  const feeds = []
  const seen = new Set()
  for (const chunk of splitChunks(region, /<div class="card flex flex-col/i)) {
    const title = firstText(chunk, /<span class="text-\[15px\] font-semibold text-ink"[^>]*>([\s\S]*?)<\/span>/i)
    if (!title) continue
    const url = codeText(/<code\b[^>]*>([\s\S]*?)<\/code>/i.exec(chunk)?.[1] ?? '')
    if (!url || seen.has(url)) continue
    seen.add(url)
    feeds.push({
      title,
      desc: firstText(chunk, /<p class="[^"]*flex-1[^"]*"[^>]*>([\s\S]*?)<\/p>/i),
      url,
    })
  }

  return {
    id,
    label,
    version: /·\s*(\d+\.\d+\.\d+)/.exec(label)?.[1] ?? '',
    heading,
    copyText: copyText || feeds[0]?.url || '',
    feeds,
  }
}

/**
 * 接入页：四种方式（Skill / MCP / RSS / API）的标题、适用客户端与可复制文本。
 * 其余三个方式各自在 `?tab=` 的页面里，所以入参是多份 HTML。
 * @param {string[]} pages /agent 与 /agent?tab=mcp|rss|api 的 HTML
 */
export function extractAgentAccess(pages) {
  const list = (Array.isArray(pages) ? pages : [pages]).filter((page) => typeof page === 'string' && page)
  if (list.length === 0) return { version: '', modes: [], updatedAt: '' }

  const tabs = agentTabs(stripNoiseBlocks(list[0]))
  const panels = new Map()
  for (const page of list) {
    const panel = agentPanel(page)
    if (panel && !panels.has(panel.id)) panels.set(panel.id, panel)
  }

  const modes = []
  for (const tab of tabs) {
    const panel = panels.get(tab.id) ?? null
    modes.push({
      id: tab.id,
      title: tab.title,
      desc: tab.desc,
      clients: tab.clients,
      heading: panel?.heading ?? '',
      copyText: panel?.copyText ?? '',
      label: panel?.label ?? '',
      ...(panel && panel.feeds.length > 0 ? { feeds: panel.feeds } : {}),
    })
  }

  const version = modes.map((mode) => panels.get(mode.id)?.version).find(Boolean) ?? ''
  return { version, modes, updatedAt: '' }
}