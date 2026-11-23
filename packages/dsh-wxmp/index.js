/**
 * @local/dsh-wxmp · Host 半边。
 *
 * 交付：
 * 1. 7 个 wxmp_* 工具：登录状态 / 搜公众号 / 文章列表 / 读正文 / 订阅管理 / 本地库增量读取 / 手动同步。
 * 2. /api/plugins/wxmp/* HTTP 路由：登录流程（二维码透传）、订阅与本地文章库，给「公众号」页面用。
 *    webServer carrier 只服务 GET/HEAD，POST/DELETE 用 ?_method= 查询参数模拟。
 *
 * 数据来源：微信公众平台（需公众号管理员扫码登录，凭证 4 天有效）。
 */

import { createAuth } from './lib/auth.js'
import {
  LoginExpiredError,
  InvalidFakeidError,
  fetchArticle,
  htmlToMarkdown,
  searchBiz,
  listArticles as wxListArticles,
} from './lib/wechat.js'
import { openStore } from './lib/store.js'
import { generateRss } from './lib/rss.js'
import { exportAccount } from './lib/export.js'
import { pollSubscriptions } from './lib/poll.js'

class NotFoundError extends Error {
  constructor(message = '资源不存在') {
    super(message)
    this.name = 'NotFoundError'
  }
}

const MAX_OUTPUT_BYTES = 48 * 1024

/** 浏览器 UA（微信公众平台后台）。 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export const inject = ['tools']

/**
 * Host 插件入口。
 * @param {import('cordis').Context} ctx
 * @param {object} [config]
 * @param {number} [config.timeoutMs] 上游请求超时，默认 15000
 * @param {number} [config.rateLimitGlobalPerMin] 全局每分钟微信接口调用上限，默认 10
 * @param {number} [config.articleIntervalMs] 文章正文两次抓取最小间隔，默认 3000
 * @param {number} [config.cacheTtlMs] 进程内缓存，默认 60000（0 关闭）
 * @param {string} [config.dataDir] 数据目录（凭证 + SQLite），默认 DSH 数据目录下 dsh-wxmp
 * @param {typeof fetch} [config.fetch] 可注入 fetch（测试用）
 * @param {string[]} [config.webhooks] webhook 通知 URL 列表（默认 []；轮询有新文章时 POST 通知）
 */
export function apply(ctx, config = {}) {
  const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 15000
  const perMin = Number.isFinite(config.rateLimitGlobalPerMin) && config.rateLimitGlobalPerMin > 0 ? config.rateLimitGlobalPerMin : 10
  const articleIntervalMs = Number.isFinite(config.articleIntervalMs) && config.articleIntervalMs >= 0 ? config.articleIntervalMs : 3000
  const cacheTtlMs = Number.isFinite(config.cacheTtlMs) && config.cacheTtlMs >= 0 ? config.cacheTtlMs : 60000
  const fetchImpl = typeof config.fetch === 'function' ? config.fetch : globalThis.fetch
  const pollIntervalMs = Number.isFinite(config.pollIntervalMs) && config.pollIntervalMs >= 0 ? config.pollIntervalMs : 600000
  const pollLimit = Number.isInteger(config.pollLimit) && config.pollLimit > 0 ? config.pollLimit : 10
  // webhook 列表是运行期可维护的内存态，初值来自 config，路由可增删。
  const webhookUrls = new Set((Array.isArray(config.webhooks) ? config.webhooks : []).filter((u) => typeof u === 'string' && u))
  const listWebhooks = () => [...webhookUrls]

  const dataDir = config.dataDir || '.data/dsh-wxmp'
  const auth = createAuth({ dataDir, fetchImpl, timeoutMs })
  // 优先 DSH storage 域持久化；取不到时 openStore 内部退回 sqlite/内存。
  const storage = (typeof ctx.get === 'function' ? ctx.get('storage') : undefined) ?? ctx.storage ?? undefined
  const store = openStore(dataDir, { storage })
  // 冷启动时 storage 服务可能晚于 apply 可用：到货后把内存后端升级为 storage 域后端。
  if (typeof ctx.inject === 'function' && store.backend === 'memory') {
    ctx.inject(['storage'], (scope) => {
      store.upgrade((typeof scope.get === 'function' ? scope.get('storage') : undefined) ?? scope.storage ?? undefined)
    })
  }

  /* -------------------------------------------------------------- 限频 */

  const windowStart = { at: Date.now(), count: 0 }
  const quota = () => {
    const now = Date.now()
    if (now - windowStart.at >= 60000) { windowStart.at = now; windowStart.count = 0 }
    return windowStart.count >= perMin ? (windowStart.at + 60000 - now) : 0
  }
  const takeQuota = () => { windowStart.count += 1 }

  let lastArticleAt = 0

  async function guard(next) {
    const waitMs = quota()
    if (waitMs > 0) throw new Error(`触发微信接口限频（每分钟 ${perMin} 次），请 ${Math.ceil(waitMs / 1000)} 秒后再试`)
    takeQuota()
    return next()
  }

  async function guardArticle(next) {
    const gap = articleIntervalMs - (Date.now() - lastArticleAt)
    if (gap > 0) await new Promise((r) => setTimeout(r, gap))
    lastArticleAt = Date.now()
    return next()
  }

  const req = (signal) => ({ fetchImpl, timeoutMs, signal })

  const credentials = () => {
    if (auth.isExpired()) throw new LoginExpiredError('微信登录凭证已过期，请在「公众号」页面重新扫码登录')
    return auth.getCredentials()
  }

  /* -------------------------------------------------------------- 缓存 */

  const cache = new Map()
  const cacheGet = (key) => {
    if (cacheTtlMs <= 0) return undefined
    const hit = cache.get(key)
    if (!hit) return undefined
    if (Date.now() - hit.at > cacheTtlMs) { cache.delete(key); return undefined }
    return hit.value
  }
  const cacheSet = (key, value) => {
    if (cacheTtlMs <= 0) return
    if (cache.size >= 64) cache.delete(cache.keys().next().value)
    cache.set(key, { at: Date.now(), value })
  }

  /* -------------------------------------------------------------- 业务动作 */

  const actions = {
    async loginStatus(sessionId) {
      const summary = auth.summary()
      // 轮询态必须覆盖 summary 的 status：先铺 summary 再写 status，否则未登录时
      // summary 的 'none' 会盖掉 pollScan 的 'pending'，二维码一闪而过。
      if (sessionId) return { ...summary, status: await auth.pollScan(sessionId) }
      return summary
    },

    async search(query, exec) {
      const key = 'search:' + query
      const hit = cacheGet(key)
      if (hit) return hit
      const value = await guard(() => searchBiz({ query, credentials: credentials() }, req(exec?.signal)))
      cacheSet(key, value)
      return value
    },
    async articles({ fakeid, begin = 0, count = 10, keyword }, exec) {
      if (!fakeid) throw new RangeError('参数 fakeid 必填')
      return guard(() => wxListArticles({ fakeid, begin, count, keyword, credentials: credentials() }, req(exec?.signal)))
    },
    async readArticle(url, exec) {
      if (!/^https:\/\/mp\.weixin\.qq\.com\//.test(url || '')) throw new RangeError('参数 url 需为 mp.weixin.qq.com 文章链接')
      const hit = cacheGet('article:' + url)
      if (hit) return hit
      const value = await guardArticle(() => fetchArticle(url, req(exec?.signal)))
      value.markdown = htmlToMarkdown(value.contentHtml)
      cacheSet('article:' + url, value)
      return value
    },
    subscribe(info) {
      if (!info?.fakeid) throw new RangeError('参数 fakeid 必填')
      store.addSubscription(info)
      return { ok: true }
    },
    setCategory(fakeid, category) {
      if (!fakeid) throw new RangeError('参数 fakeid 必填')
      if (!store.setSubscriptionCategory(fakeid, category ?? '')) {
        throw new NotFoundError('未订阅该公众号：' + fakeid)
      }
      return { ok: true, fakeid: String(fakeid), category: String(category ?? '') }
    },
    unsubscribe(fakeid) {
      if (!fakeid) throw new RangeError('参数 fakeid 必填')
      store.removeSubscription(fakeid)
      return { ok: true }
    },
    subscriptions({ category } = {}) {
      const normalized = String(category ?? '')
      // 前端订阅行要显示「上次同步」与「文章数」：store 只存 lastPoll，条数按库内实际文章算。
      const all = store.listSubscriptions()
      const counts = new Map()
      for (const s of all) counts.set(String(s.fakeid), store.listArticles(String(s.fakeid), { since: null, limit: 100000 }).articles.length)
      const list = (normalized ? all.filter((s) => (s.category ?? '') === normalized) : all)
        .map((s) => ({ ...s, articleCount: counts.get(String(s.fakeid)) ?? 0 }))
      return { list, category: normalized, categories: [...new Set(all.map((s) => s.category ?? ''))] }
    },
    webhooks({ method = 'list', url } = {}) {
      const m = String(method || 'list').toLowerCase()
      if (m === 'list') return { webhooks: listWebhooks() }
      if (m === 'add') {
        if (!url) throw new RangeError('参数 url 必填')
        webhookUrls.add(String(url))
        return { webhooks: listWebhooks(), added: String(url) }
      }
      if (m === 'remove') {
        if (!url) throw new RangeError('参数 url 必填')
        const removed = webhookUrls.delete(String(url))
        if (!removed) throw new NotFoundError('webhook 不存在：' + url)
        return { webhooks: listWebhooks(), removed: String(url) }
      }
      throw new RangeError('_method 需为 list、add 或 remove')
    },
    localArticles({ fakeid, category, since, limit }) {
      const result = store.listArticles(fakeid, { since, limit: Math.min(Number(limit) || 50, 200) })
      // 输出带 category：按分类过滤时只留该分类的公众号。
      const cats = new Map(store.listSubscriptions().map((s) => [String(s.fakeid), s.category ?? '']))
      const want = category == null ? '' : String(category)
      const articles = result.articles
        .map((a) => ({ ...a, category: cats.get(String(a.fakeid)) ?? '' }))
        .filter((a) => !want || a.category === want)
      return { ...result, articles }
    },
    async sync(exec) {
      const subs = store.listSubscriptions()
      let added = 0
      for (const sub of subs) {
        try {
          const page = await guard(() => wxListArticles({ fakeid: sub.fakeid, begin: 0, count: 10, credentials: credentials() }, req(exec?.signal)))
          added += store.saveArticles(sub.fakeid, page.articles || [])
          store.touchSubscription(sub.fakeid)
          await new Promise((r) => setTimeout(r, 3000))
        } catch (error) {
          if (error instanceof InvalidFakeidError) store.removeSubscription(sub.fakeid)
          else throw error
        }
      }
      return { added, subscriptions: subs.length }
    },

    async poll(exec) {
      return pollSubscriptions(ctx, {
        store,
        auth,
        wx: {
          listArticles: (args) => guard(() => wxListArticles(args, req(exec?.signal))),
          fetchArticle: (url) => guardArticle(() => fetchArticle(url, req(exec?.signal))),
          htmlToMarkdown,
        },
        limit: pollLimit,
        intervalMs: 3000,
        sleep: (ms) => new Promise((r) => setTimeout(r, exec?.signal?.aborted ? 0 : ms)),
        webhooks: listWebhooks(),
      })
    },
    rssStatus(fakeid) {
      const rssUrl = (fakeid, origin) => origin + '/api/plugins/wxmp/rss/' + encodeURIComponent(fakeid) + '.xml'
      const subs = store.listSubscriptions()
      return { pollIntervalMs, pollLimit, paused: pollState.paused, lastPollAt: pollState.lastPollAt, subscriptions: subs.length, rssUrl: fakeid ? rssUrl(fakeid, '') : undefined, rssUrls: subs.map((s) => ({ fakeid: s.fakeid, nickname: s.nickname, url: '/api/plugins/wxmp/rss/' + encodeURIComponent(s.fakeid) + '.xml' })) }
    },
  }

  /* -------------------------------------------------------------- 定时轮询 */

  const pollState = { paused: false, lastPollAt: null, timerService: false }
  let pollBusy = false

  const pollOnce = async () => {
    if (pollBusy || pollState.paused) return { added: 0, failed: [], skipped: true }
    pollBusy = true
    try {
      const result = await actions.poll()
      pollState.lastPollAt = Date.now()
      return result
    } finally {
      pollBusy = false
    }
  }

  const startPollTimer = () => {
    if (pollIntervalMs <= 0) return
    let dispose = null
    try {
      // DSH timer 服务（若提供）：setInterval(ms, fn) 风格
      const timer = ctx.get?.('timer') ?? ctx.timer
      if (timer && typeof timer.setInterval === 'function') {
        dispose = timer.setInterval(pollIntervalMs, pollOnce)
        pollState.timerService = true
      } else if (typeof ctx.setInterval === 'function') {
        // Cordis ctx.setInterval：插件卸载时自动清理
        dispose = ctx.setInterval(pollIntervalMs, pollOnce)
      }
    } catch (error) {
      ctx.logger?.warn?.('dsh-wxmp 定时轮询注册失败：' + (error?.message || error))
    }
    if (dispose) {
      try { ctx.effect(() => { try { dispose() } catch { /* 忽略 */ } }) } catch { /* 测试 ctx 无 effect */ }
    } else {
      ctx.logger?.debug?.('dsh-wxmp 未找到 timer 服务，定时轮询未注册（手动同步仍可用）')
    }
  }
  startPollTimer()

  /* -------------------------------------------------------------- 工具 */

  function registerTool({ name, description, parameters, run }) {
    const dispose = ctx.tools.register({
      name,
      description,
      parameters,
      output: {
        schema: { type: 'string', description: '中文 Markdown 结果（≤48KB）' },
        render(_args, value) {
          return [{ type: 'text', text: String(value ?? '') }]
        },
      },
      async execute(args = {}, exec) {
        const value = await run(args || {}, exec)
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
        return text.length > MAX_OUTPUT_BYTES ? text.slice(0, MAX_OUTPUT_BYTES) + '\n…（已截断）' : text
      },
    })
    ctx.effect(() => dispose)
  }

  registerTool({
    name: 'wxmp_login_status',
    description: '查询微信公众号登录凭证状态（是否已登录、账号昵称、过期时间）。其余 wxmp_* 工具都要求先扫码登录。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    run: () => actions.loginStatus(),
  })
  registerTool({
    name: 'wxmp_search_accounts',
    description: '按名称搜索微信公众号，返回 fakeid（后续列表/订阅使用）、昵称、微信号、头像。需已扫码登录。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 1, maxLength: 64, description: '公众号名称关键词（必填）' } },
      required: ['query'],
      additionalProperties: false,
    },
    run: (a, exec) => actions.search(a.query, exec),
  })

  registerTool({
    name: 'wxmp_list_articles',
    description: '获取指定公众号已发布的文章列表（标题/链接/摘要/时间），支持分页与号内关键词搜索。需已扫码登录。',
    parameters: {
      type: 'object',
      properties: {
        fakeid: { type: 'string', description: '公众号 fakeid（必填，来自 wxmp_search_accounts）' },
        begin: { type: 'integer', minimum: 0, default: 0, description: '偏移量' },
        count: { type: 'integer', minimum: 1, maximum: 100, default: 10, description: '条数（≤100）' },
        keyword: { type: 'string', maxLength: 64, description: '号内搜索关键词（可选）' },
      },
      required: ['fakeid'],
      additionalProperties: false,
    },
    run: (a, exec) => actions.articles(a, exec),
  })

  registerTool({
    name: 'wxmp_read_article',
    description: '抓取微信公众号文章正文（mp.weixin.qq.com 链接），返回标题、作者、发布时间、Markdown 正文与图片列表。无需登录。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '文章链接（https://mp.weixin.qq.com/s/...）' } },
      required: ['url'],
      additionalProperties: false,
    },
    run: (a, exec) => actions.readArticle(a.url, exec),
  })

  registerTool({
    name: 'wxmp_subscribe',
    description: '订阅公众号（入库，供 wxmp_sync 增量拉取）。需先 wxmp_search_accounts 拿 fakeid。',
    parameters: {
      type: 'object',
      properties: {
        fakeid: { type: 'string', description: '必填' },
        nickname: { type: 'string', description: '公众号名称' },
        alias: { type: 'string', description: '微信号' },
        headImg: { type: 'string', description: '头像 URL' },
        category: { type: 'string', maxLength: 64, description: '订阅分类（可选，默认空）' },
      },
      required: ['fakeid'],
      additionalProperties: false,
    },
    run: (a) => actions.subscribe(a),
  })

  registerTool({
    name: 'wxmp_unsubscribe',
    description: '取消订阅公众号。',
    parameters: {
      type: 'object',
      properties: { fakeid: { type: 'string' } },
      required: ['fakeid'],
      additionalProperties: false,
    },
    run: (a) => actions.unsubscribe(a.fakeid),
  })

  registerTool({
    name: 'wxmp_local_articles',
    description: '读取本地已入库的文章（订阅同步过的），支持 since 时间游标增量与按公众号/分类过滤，返回 next_since 供下次增量。',
    parameters: {
      type: 'object',
      properties: {
        fakeid: { type: 'string', description: '只看某个公众号（可选）' },
        category: { type: 'string', maxLength: 64, description: '只看某个订阅分类下的公众号（可选）' },
        since: { type: 'integer', minimum: 0, default: 0, description: 'Unix 秒，返回 publish_time > since 的文章' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
      additionalProperties: false,
    },
    run: (a) => actions.localArticles(a),
  })

  registerTool({
    name: 'wxmp_sync',
    description: '手动同步：遍历所有订阅，从微信拉最新文章入库（限频保护，订阅多时较慢）。返回新增条数。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    run: (_a, exec) => actions.sync(exec),
  })

  registerTool({
    name: 'wxmp_poll',
    description: '手动触发一轮订阅增量轮询（同定时任务），返回新增条数与失败列表。需已扫码登录。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    run: async (_a, exec) => actions.poll(exec),
  })

  registerTool({
    name: 'wxmp_get_rss_url',
    description: '返回 RSS 订阅链接（/api/plugins/wxmp/rss/{fakeid}.xml）与轮询状态（间隔、暂停、最近轮询时间）。传 fakeid 返回该号链接，不传返回全部订阅链接。',
    parameters: {
      type: 'object',
      properties: { fakeid: { type: 'string', description: '公众号 fakeid（可选）' } },
      additionalProperties: false,
    },
    run: (a) => {
      const subs = store.listSubscriptions()
      const rssPath = (fakeid) => '/api/plugins/wxmp/rss/' + encodeURIComponent(fakeid) + '.xml'
      const status = { pollIntervalMs, paused: pollState.paused, lastPollAt: pollState.lastPollAt, timerRegistered: pollState.timerService }
      if (a.fakeid) {
        const sub = subs.find((s) => String(s.fakeid) === String(a.fakeid))
        if (!sub) throw new NotFoundError('未订阅该公众号：' + a.fakeid)
        return { ...status, fakeid: sub.fakeid, nickname: sub.nickname, rssPath: rssPath(sub.fakeid) }
      }
      return { ...status, subscriptions: subs.map((s) => ({ fakeid: s.fakeid, nickname: s.nickname, rssPath: rssPath(s.fakeid), lastPoll: s.lastPoll })) }
    },
  })

  registerTool({
    name: 'wxmp_export_account',
    description: '导出整个公众号的本地文章为 md/html/json/xlsx/docx/epub/pdf（纯读本地库，不触发微信抓取；docx/epub/pdf 会现抓微信图片内嵌）。返回导出信息与下载链接。',
    parameters: {
      type: 'object',
      properties: {
        fakeid: { type: 'string', description: '公众号 fakeid（必填）' },
        format: { type: 'string', enum: ['md', 'html', 'json', 'xlsx', 'docx', 'epub', 'pdf'], description: '导出格式（必填）' },
        range: { description: '范围：all | days:N | {since,until}（Unix 秒，since 下界）| incremental。默认 all' },
      },
      required: ['fakeid', 'format'],
      additionalProperties: false,
    },
    run: async (a) => actions.exportAccount(a),
  })

  // 导出：调 exportAccount，结果缓存在内存（token → Buffer），供下载路由取出。
  const exportCache = new Map() // token -> { buf, contentType, filename, expires }
  const EXPORT_CACHE_MS = 10 * 60 * 1000
  actions.exportAccount = async (a) => {
    const range = a.range == null ? "all" : a.range
    const r = await exportAccount(store, a.fakeid, a.format, { range, timeoutMs: 20000 })
    if (!r || !r.ok) return { ok: false, error: (r && r.reason) || "导出失败" }
    const token = String(Date.now()) + "-" + Math.random().toString(36).slice(2, 10)
    const sub = store.listSubscriptions().find((s) => String(s.fakeid) === String(a.fakeid))
    const nickname = (sub && sub.nickname) || r.nickname || a.fakeid
    const filename = encodeURIComponent(nickname) + "-" + a.format + "." + (r.ext || a.format)
    exportCache.set(token, { buf: r.buf, contentType: r.contentType, filename, expires: Date.now() + EXPORT_CACHE_MS })
    if (exportCache.size > 8) {
      const now = Date.now()
      for (const [k, v] of exportCache) if (v.expires < now) exportCache.delete(k)
    }
    return {
      ok: true, format: r.format, fakeid: r.fakeid, nickname: r.nickname, count: r.count, truncated: r.truncated,
      nextSince: r.nextSince, bytes: r.buf.length, contentType: r.contentType, filename,
      downloadPath: '/api/plugins/wxmp/export/' + encodeURIComponent(a.fakeid) + '.' + a.format + '?token=' + token,
    }
  }

  /* -------------------------------------------------------------- 路由 */

  const registerRoutes = (ctx) => {
    const web = ctx.get?.('webServer') ?? ctx.webServer
    if (!web || typeof web.register !== 'function') {
      throw new Error('dsh-wxmp 路由需要 webServer 服务：webServer.register 不可用')
    }
    const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

    const handle = async (path, request, fn) => {
      const url = new URL(request.url)
      if (request.method !== 'GET' && request.method !== 'HEAD') return json({ ok: false, error: '只支持 GET' }, 405)
      try {
        return json({ ok: true, ...(await fn(url.searchParams, request)) })
      } catch (error) {
        if (error instanceof RangeError) return json({ ok: false, error: error.message }, 400)
        if (error instanceof NotFoundError) return json({ ok: false, error: error.message }, 404)
        if (error instanceof LoginExpiredError) return json({ ok: false, error: error.message, loginExpired: true }, 401)
        return json({ ok: false, error: error?.message || String(error) }, 502)
      }
    }

    const route = (path, fn) => {
      const dispose = web.register({
        kind: 'exact',
        path,
        resource: (request) => handle(path, request, fn),
      })
      ctx.effect(() => dispose)
    }

    route('/api/plugins/wxmp/login/status', async (q) => {
      const sessionId = q.get('sessionId') || undefined
      return actions.loginStatus(sessionId)
    })
    route('/api/plugins/wxmp/login/start', async (q) => {
      if ((q.get('_method') || 'post').toLowerCase() !== 'post') throw new RangeError('只支持 _method=post')
      return auth.startLogin()
    })
    route('/api/plugins/wxmp/login/logout', async (q) => {
      auth.logout()
      return {}
    })

    // 二维码：透传微信 PNG（带微信种下的 cookie），浏览器 <img> 直连。
    const disposeQrcode = web.register({
      kind: 'exact',
      path: '/api/plugins/wxmp/login/qrcode',
      resource: async (request) => {
        const sessionId = new URL(request.url).searchParams.get('sessionId') || ''
        try {
          const { body, contentType } = await auth.qrcode(sessionId)
          // body 是原始二进制（ArrayBuffer），构造 Response 会做 UTF-8 重编码损坏图片，必须走 Uint8Array 视图。
          return new Response(body instanceof ArrayBuffer ? new Uint8Array(body) : body, { headers: { 'content-type': contentType || 'image/png', 'cache-control': 'no-store' } })
        } catch (error) {
          return json({ ok: false, error: error?.message || String(error) }, 502)
        }
      },
    })
    ctx.effect(() => disposeQrcode)

    route('/api/plugins/wxmp/search', async (q) => {
      const query = q.get('query') || ''
      if (query.length < 1) throw new RangeError('query 必填')
      return actions.search(query)
    })
    //   GET /subscriptions               → 订阅列表（带 category 与 categories 汇总）
    //   GET /subscriptions?category=…    → 按分类过滤（分类为空时不过滤）
    //   GET /subscriptions?_method=set_category&fakeid=&category=  → 改分类（未订阅 404）
    route('/api/plugins/wxmp/subscriptions', async (q) => {
      const method = (q.get('_method') || '').toLowerCase()
      if (!method) return actions.subscriptions({ category: q.get('category') ?? '' })
      if (method === 'set_category') return actions.setCategory(q.get('fakeid'), q.get('category') ?? '')
      throw new RangeError('_method 需为 set_category，或不传 _method 直接列表')
    })
    //   GET /webhooks?_method=            → list / add / remove（url=），运行期维护 webhook 列表
    route('/api/plugins/wxmp/webhooks', async (q) => actions.webhooks({
      method: q.get('_method') || 'list',
      url: q.get('url') || undefined,
    }))
    route('/api/plugins/wxmp/subscribe', async (q) => {
      const method = (q.get('_method') || '').toLowerCase()
      if (method === 'delete') return actions.unsubscribe(q.get('fakeid'))
      if (method === 'post') {
        return actions.subscribe({
          fakeid: q.get('fakeid'),
          nickname: q.get('nickname') || '',
          alias: q.get('alias') || '',
          headImg: q.get('headImg') || '',
          category: q.get('category') || '',
        })
      }
      throw new RangeError('_method 需为 post 或 delete')
    })
    route('/api/plugins/wxmp/articles', async (q) => actions.localArticles({
      fakeid: q.get('fakeid') || undefined,
      category: q.get('category') || undefined,
      // since 缺省是 null 而不是 0：0 会被当成 publish_time < 0 的游标，整页文章全被过滤掉。
      since: q.get('since') ? Number(q.get('since')) : null,
      limit: Number(q.get('limit')) || 50,
    }))
    //   GET /article?link=…  → 按链接现抓正文（页面抽屉用；本地库不存正文，id 只对 sqlite 后端有效）
    //   GET /article?id=N     → 读本地库单篇（仅 sqlite 后端有该 id）
    route('/api/plugins/wxmp/article', async (q) => {
      const link = q.get('link') || ''
      if (link) {
        if (!/^https:\/\/mp\.weixin\.qq\.com\//.test(link)) throw new RangeError('link 需为 mp.weixin.qq.com 文章链接')
        const article = await actions.readArticle(link)
        return { article: { ...article, link, sourceUrl: link } }
      }
      const id = Number(q.get('id'))
      if (!Number.isInteger(id) || id <= 0) throw new RangeError('需要 link 或正整数 id')
      const article = store.getArticle(id)
      if (!article) throw new NotFoundError('文章不存在')
      return { article }
    })
    route('/api/plugins/wxmp/sync', async (q) => {
      if ((q.get('_method') || '').toLowerCase() !== 'post') throw new RangeError('只支持 _method=post')
      return actions.sync()
    })

    // RSS 2.0 订阅输出（prefix 段路由统一分发）：
    //   GET /rss/{fakeid}.xml    → RSS 2.0 XML（未订阅返 404）
    //   GET /rss/poll?_method=   → post 手动轮询 / pause / resume / status（_method 模拟 POST 惯例）
    const disposeRss = web.register({
      kind: 'prefix',
      path: '/api/plugins/wxmp/rss/',
      resource: async (request) => {
        const url = new URL(request.url)
        if (request.method !== 'GET' && request.method !== 'HEAD') return json({ ok: false, error: '只支持 GET' }, 405)
        try {
          const rest = url.pathname.slice('/api/plugins/wxmp/rss/'.length)
          if (rest === 'poll') {
            const method = (url.searchParams.get('_method') || 'post').toLowerCase()
            if (method === 'pause') { pollState.paused = true; return json({ ok: true, paused: true, pollIntervalMs, lastPollAt: pollState.lastPollAt }) }
            if (method === 'resume') { pollState.paused = false; return json({ ok: true, paused: false, pollIntervalMs, lastPollAt: pollState.lastPollAt }) }
            if (method === 'status') return json({ ok: true, paused: pollState.paused, pollIntervalMs, lastPollAt: pollState.lastPollAt })
            if (method === 'post') {
              const result = await pollOnce()
              return json({ ok: true, ...result, pollIntervalMs, paused: pollState.paused, lastPollAt: pollState.lastPollAt })
            }
            throw new RangeError('_method 需为 post、pause、resume 或 status')
          }
          const fakeid = decodeURIComponent(rest.replace(/\.xml$/i, ''))
          if (!fakeid) throw new NotFoundError('RSS 路径需为 /rss/{fakeid}.xml')
          const sub = store.listSubscriptions().find((s) => String(s.fakeid) === String(fakeid))
          if (!sub) throw new NotFoundError('未订阅该公众号：' + fakeid)
          const limit = Math.min(Number(url.searchParams.get('limit')) || 30, 50)
          const { articles } = store.listArticles(String(sub.fakeid), { since: null, limit })
          const xml = generateRss({ subscriptions: sub, articles, siteUrl: url.origin, buildTime: Date.now(), limit })
          return new Response(xml, { headers: { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'public, max-age=600' } })
        } catch (error) {
          if (error instanceof RangeError) return json({ ok: false, error: error.message }, 400)
          if (error instanceof NotFoundError) return json({ ok: false, error: error.message }, 404)
          if (error instanceof LoginExpiredError) return json({ ok: false, error: error.message, loginExpired: true }, 401)
          return json({ ok: false, error: error?.message || String(error) }, 502)
        }
      },
    })

    // 导出下载：GET /export/{fakeid}.{format}?token=…（token 由工具/POST 生成，一次有效期内可重复下载）
    //          GET /export/{fakeid}.{format}?_method=export&range=… 直接触发导出（docx/epub 不抓图）
    const disposeExport = web.register({
      kind: 'prefix',
      path: '/api/plugins/wxmp/export/',
      resource: async (request) => {
        const url = new URL(request.url)
        if (request.method !== 'GET' && request.method !== 'HEAD') return json({ ok: false, error: '只支持 GET' }, 405)
        try {
          const rest = url.pathname.slice('/api/plugins/wxmp/export/'.length)
          const dot = rest.lastIndexOf('.')
          if (dot <= 0) throw new RangeError('路径需为 /export/{fakeid}.{format}')
          const fakeid = decodeURIComponent(rest.slice(0, dot))
          const format = rest.slice(dot + 1).toLowerCase()
          const token = url.searchParams.get('token') || ''
          if (token && exportCache.has(token)) {
            const hit = exportCache.get(token)
            return new Response(new Uint8Array(hit.buf), { headers: { 'content-type': hit.contentType, 'content-disposition': 'attachment; filename="' + hit.filename + '"', 'cache-control': 'no-store' } })
          }
          if ((url.searchParams.get('_method') || '') .toLowerCase() !== 'export') throw new NotFoundError('需要 token 或 _method=export')
          const qRange = url.searchParams.get('range')
          let range = 'all'
          if (qRange === 'incremental') range = 'incremental'
          else if (qRange && qRange.startsWith('days:')) range = qRange
          else if (qRange) {
            const since = Number(url.searchParams.get('since'))
            const until = Number(url.searchParams.get('until'))
            range = { since: Number.isFinite(since) && url.searchParams.has('since') ? since : null, until: Number.isFinite(until) && url.searchParams.has('until') ? until : null }
          }
          const r = await exportAccount(store, fakeid, format, { range, timeoutMs: 20000 })
          if (!r || !r.ok) return json({ ok: false, error: (r && r.reason) || '导出失败' }, 400)
          const sub = store.listSubscriptions().find((s) => String(s.fakeid) === String(fakeid))
          const nickname = (sub && sub.nickname) || r.nickname || fakeid
          const filename = encodeURIComponent(nickname) + '-' + format + '.' + (r.ext || format)
          return new Response(new Uint8Array(r.buf), { headers: { 'content-type': r.contentType, 'content-disposition': 'attachment; filename="' + filename + '"', 'cache-control': 'no-store' } })
        } catch (error) {
          if (error instanceof RangeError) return json({ ok: false, error: error.message }, 400)
          if (error instanceof NotFoundError) return json({ ok: false, error: error.message }, 404)
          return json({ ok: false, error: error?.message || String(error) }, 502)
        }
      },
    })
    ctx.effect(() => disposeExport)
  }

  try {
    if (typeof ctx.inject === 'function') ctx.inject(['webServer'], registerRoutes)
    else registerRoutes(ctx)
  } catch (error) {
    ctx.logger?.warn?.('dsh-wxmp 路由注册失败：' + (error?.message || error))
  }
}
