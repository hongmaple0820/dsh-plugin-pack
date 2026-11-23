/**
 * 微信公众平台接口的纯逻辑层（无 Cordis 依赖、无全局状态）。
 *
 * 所有请求经注入的 fetchImpl（参数 { fetchImpl, timeoutMs, signal }），便于单测。
 * 端点依据 mp.weixin.qq.com 逆向分析结果：
 * - searchbiz：搜索公众号
 * - appmsgpublish：历史文章列表，publish_page / publish_info 是双层 JSON 字符串
 * - authorinfo：账号认证信息
 * - 文章页：无 cookie 抓正文，标题/作者/时间/正文多层正则兜底
 */

export const BASE = 'https://mp.weixin.qq.com'

/** 微信后台浏览器 UA（公众平台页面要求，缺失会被风控）。 */
export const WXMP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 登录已过期（ret=-1/需要重新登录）。 */
export class LoginExpiredError extends Error {
  constructor(message = '微信公众平台登录已过期，请重新扫码登录') {
    super(message)
    this.name = 'LoginExpiredError'
  }
}

/** fakeid 无效（ret=200002）。 */
export class InvalidFakeidError extends Error {
  constructor(fakeid) {
    super('fakeid 无效：' + (fakeid ?? '') + '（微信返回 200002 / invalid arg）')
    this.name = 'InvalidFakeidError'
  }
}

/* ---------------------------------------------------------------- 校验 */

function assertNonEmpty(value, name) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new RangeError('参数 ' + name + ' 必填')
  }
  return String(value)
}

function pickInt(value, { min, max, def }, name) {
  if (value === undefined || value === null || value === '') return def
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new RangeError('参数 ' + name + ' 必须是 ' + min + '-' + max + ' 之间的整数')
  }
  return n
}

/* ---------------------------------------------------------------- 请求封装 */

/**
 * 统一 GET 请求：拼 query、带 UA/Cookie、解析 JSON（f=json）或返回文本。
 * @param {object} opts { url, query?, credentials?{token,cookie}, headers? }
 * @param {object} ctx 注入项 { fetchImpl, timeoutMs, signal }
 * @returns {Promise<{status:number, text:string, json:object|null}>}
 */
export async function requestWechat(url, { query, credentials, headers } = {}, ctx = {}) {
  const { fetchImpl, timeoutMs = 15000, signal } = ctx
  if (typeof fetchImpl !== 'function') {
    throw new Error('缺少 fetchImpl：请通过 ctx 注入（纯逻辑层不访问全局 fetch）')
  }
  const full = url.startsWith('http') ? url : BASE + url
  const u = new URL(full)
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v))
  }
  const h = { 'User-Agent': WXMP_UA, ...(headers || {}) }
  if (credentials?.cookie) h.Cookie = credentials.cookie
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const onOuter = () => ac.abort()
  if (signal) {
    if (signal.aborted) { clearTimeout(timer); throw new Error('请求已取消') }
    signal.addEventListener('abort', onOuter, { once: true })
  }
  try {
    const res = await fetchImpl(u.toString(), { method: 'GET', headers: h, redirect: 'manual', signal: ac.signal })
    // 同时保留原始字节与文本：text() 是 UTF-8 解码，二进制（登录二维码图片）经它会损坏。
    const buf = typeof res.arrayBuffer === 'function' ? await res.arrayBuffer() : null
    const text = buf ? new TextDecoder('utf-8', { fatal: false }).decode(buf) : String(res.text)
    let json = null
    const t = text.trim()
    if (t.startsWith('{') || t.startsWith('[')) {
      try { json = JSON.parse(t) } catch { /* 容忍非 JSON */ }
    }
    return { status: res.status, headers: res.headers, text, json, buf }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onOuter)
  }
}

/** 校验 ret 字段并抛出对应错误（LoginExpiredError / InvalidFakeidError）。 */
function assertRet(json, label) {
  if (!json) throw new Error(label + '：返回不是合法 JSON')
  const ret = json.base_resp?.ret ?? json.ret
  if (ret === 0) return
  if (ret === 200013) throw new Error('触发微信接口频控（freq control）：请求过于频繁或触达上限，请等待几分钟后再试')
  if (ret === -1) throw new LoginExpiredError()
  if (ret === 200002) throw new InvalidFakeidError(json.base_resp?.err_msg || '')
  throw new Error(label + '失败：ret=' + ret + '，err_msg=' + (json.base_resp?.err_msg ?? json.err_msg ?? '未知'))
}

/** 深层字段可能是 JSON 字符串，安全解析。 */
export function parseMaybeJson(v) {
  if (v === undefined || v === null) return null
  if (typeof v === 'object') return v
  try { return JSON.parse(v) } catch { return null }
}

/* ---------------------------------------------------------------- 接口 */

/**
 * 搜索公众号。GET /cgi-bin/searchbiz?action=search_biz
 * @returns {Promise<{list:{fakeid,nickname,alias,roundHeadImg,serviceType}[], total:number}>}
 */
export async function searchBiz({ query, begin = 0, count = 5, credentials } = {}, ctx = {}) {
  const q = assertNonEmpty(query, 'query')
  const b = pickInt(begin, { min: 0, max: 1e9, def: 0 }, 'begin')
  const c = pickInt(count, { min: 1, max: 20, def: 5 }, 'count')
  const cred = credentials ?? ctx.credentials
  const res = await requestWechat('/cgi-bin/searchbiz', {
    query: {
      action: 'search_biz',
      token: cred?.token,
      random: Math.random().toString(36).slice(2),
      query: q,
      begin: b,
      count: 5,
    },
    // credentials 既可放第一个参数（index.js 的调用形态），也可放 ctx（poll.js/测试的形态）。
    credentials: credentials ?? ctx.credentials,
  }, ctx)
  assertRet(res.json, '搜索公众号')
  const list = Array.isArray(res.json.list) ? res.json.list : []
  return {
    list: list.map((it) => ({
      fakeid: it.fakeid,
      nickname: it.nickname,
      alias: it.alias ?? '',
      roundHeadImg: it.round_head_img ?? '',
      serviceType: it.service_type ?? 0,
    })),
    total: res.json.total ?? list.length,
  }
}

/**
 * 公众号历史文章列表。GET /cgi-bin/appmsgpublish?sub=list|search
 * publish_page 与每个 publish_list[].publish_info 都是 JSON 字符串，需双层解析。
 * @returns {Promise<{articles:{aid,title,link,updateTime,createTime,digest,cover,author}[], nextBegin:number, hasMore:boolean}>}
 */
export async function listArticles({ fakeid, begin = 0, count = 10, keyword = '', credentials } = {}, ctx = {}) {
  const fid = assertNonEmpty(fakeid, 'fakeid')
  const b = pickInt(begin, { min: 0, max: 1e9, def: 0 }, 'begin')
  const c = pickInt(count, { min: 1, max: 100, def: 10 }, 'count')
  const isSearch = String(keyword ?? '') !== ''
  const cred = credentials ?? ctx.credentials
  const res = await requestWechat('/cgi-bin/appmsgpublish', {
    query: {
      sub: isSearch ? 'search' : 'list',
      begin: b,
      count: c,
      query: isSearch ? String(keyword) : '',
      fakeid: fid,
      type: '101_1',
      free_publish_type: 1,
      sub_action: 'list_ex',
      token: cred?.token,
      f: 'json',
      ajax: 1,
    },
    credentials: cred,
    headers: { Referer: BASE + '/' },
  }, ctx)
  assertRet(res.json, '拉取文章列表')
  const page = parseMaybeJson(res.json.publish_page) || {}
  const publishList = Array.isArray(page.publish_list) ? page.publish_list : []
  const articles = []
  for (const item of publishList) {
    const info = parseMaybeJson(item.publish_info)
    const msgs = info?.appmsgex
    if (Array.isArray(msgs)) {
      for (const m of msgs) {
        articles.push({
          aid: m.aid,
          title: m.title ?? '',
          link: m.link ?? '',
          updateTime: m.update_time,
          createTime: m.create_time,
          digest: m.digest ?? '',
          cover: m.cover ?? '',
          author: m.author ?? '',
        })
      }
    }
  }
  return {
    articles,
    nextBegin: b + c,
    hasMore: articles.length > 0 && page.is_continue === 1,
  }
}

/**
 * 账号认证信息。GET /mp/authorinfo?wxtoken=777&biz=fakeid&__biz=fakeid&x5=0&f=json
 * @returns {Promise<{identityName:string,isVerify:boolean,originalCount:number}>}
 */
export async function accountInfo({ fakeid, credentials } = {}, ctx = {}) {
  const fid = assertNonEmpty(fakeid, 'fakeid')
  const res = await requestWechat('/mp/authorinfo', {
    query: { fakeid: fid, wxtoken: '777&biz=fakeid&__biz=fakeid&x5=0&f=json' },
    credentials: credentials ?? ctx.credentials,
    headers: { Referer: BASE + '/', Origin: BASE },
  }, ctx)
  assertRet(res.json, '查询账号信息')
  const d = res.json
  return {
    identityName: d.identity_name ?? '',
    isVerify: Boolean(d.is_verify),
    originalCount: Number(d.original_article_count ?? 0),
  }
}

/* ---------------------------------------------------------------- 文章页解析 */

/**
 * 抓取文章正文（无 cookie，仅 Referer）。
 * @returns {Promise<{title,author,contentHtml,plainText,images:string[],publishTime,publishTimeStr}>}
 */
export async function fetchArticle(url, ctx = {}) {
  assertNonEmpty(url, 'url')
  const res = await requestWechat(url, { headers: { Referer: BASE + '/' } }, ctx)
  if (res.status !== 200) throw new Error('抓取文章失败：HTTP ' + res.status + '（' + url + '）')
  const article = parseArticleHtml(res.text)
  if (!article) {
    throw new Error('解析文章失败：页面中找不到正文容器（js_content / rich_media_content），可能文章已被删除：' + url)
  }
  return article
}

/**
 * 从文章页 HTML 提取结构化正文。找不到正文容器时返回 null（由 fetchArticle 转成中文错误）。
 */
export function parseArticleHtml(html) {
  const title =
    matchOr(html, /<h1[^>]*class="rich_media_title"[^>]*>([\s\S]*?)<\/h1>/i) ??
    matchOr(html, /window\.msg_title\s*=\s*'([^']*)'/) ??
    matchOr(html, /window\.msg_title\s*=\s*"([^"]*)"/) ??
    matchOr(html, /<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i)
  const author =
    matchOr(html, /<span[^>]*id="js_name"[^>]*>([\s\S]*?)<\/span>/i) ??
    matchOr(html, /var\s+nickname\s*=\s*'([^']*)'/) ??
    matchOr(html, /var\s+nickname\s*=\s*"([^"]*)"/)
  let timeSec = matchOr(html, /var\s+publish_time\s*=\s*["']?(\d{9,11})/)
  if (timeSec === null) timeSec = matchOr(html, /[?&]ct=(\d{9,11})/)
  const mContent =
    html.match(/<div[^>]*id="js_content"[^>]*>([\s\S]*?)<\/div>/i) ||
    html.match(/<div[^>]*class="[^"]*rich_media_content[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
  if (!mContent) return null
  const contentHtml = decodeEntities(stripTags(mContent[1], 'script|style')).trim()
  const plainText = decodeEntities(stripTags(contentHtml)).replace(/[ \t\r]+/g, ' ').trim()
  const images = []
  for (const tag of contentHtml.match(/<img[^>]*>/gi) || []) {
    const src = tag.match(/data-src="([^"]+)"/)?.[1] ?? tag.match(/\ssrc="([^"]+)"/)?.[1]
    if (src && !images.includes(src)) images.push(src)
  }
  return {
    title: decodeEntities((title ?? '').trim()),
    author: decodeEntities((author ?? '').trim()),
    contentHtml,
    plainText,
    images,
    publishTime: timeSec ? Number(timeSec) : null,
    publishTimeStr: timeSec ? new Date(Number(timeSec) * 1000).toISOString() : null,
  }
}

function matchOr(text, re) {
  const m = text.match(re)
  if (!m) return null
  return decodeEntities(m[1].replace(/<[^>]+>/g, '')).trim() || null
}

/** 去掉指定标签（含内容）或全部标签。 */
function stripTags(html, names) {
  if (names) return html.replace(new RegExp('<\\s*(?:' + names + ')[\\s\\S]*?<\\s*\\/\\s*(?:' + names + ')\\s*>', 'gi'), '')
  return html.replace(/<[^>]+>/g, '')
}

/** 常见 HTML 实体反转义。 */
export function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

/* ---------------------------------------------------------------- HTML -> Markdown */

const MD_FENCE = '\x60\x60\x60'

/**
 * 简单 HTML -> Markdown 转换，覆盖 h1-h6/p/strong/em/a/img/ul/ol/li/blockquote/code/pre。
 * 不追求完整：未覆盖的标签剥壳保留文字。
 */
export function htmlToMarkdown(contentHtml) {
  if (typeof contentHtml !== 'string' || !contentHtml.trim()) return ''
  let s = contentHtml.replace(/<\s*(?:script|style)[\s\S]*?<\s*\/\s*(?:script|style)\s*>/gi, '')
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => {
    return '\n\n' + MD_FENCE + '\n' + decodeEntities(stripTags(code)).replace(/\n{3,}/g, '\n\n').trim() + '\n' + MD_FENCE + '\n\n'
  })
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, c) => '\x60' + decodeEntities(stripTags(c)).trim() + '\x60')
  for (let i = 1; i <= 6; i++) {
    s = s.replace(new RegExp('<h' + i + '[^>]*>([\\s\\S]*?)<\\/h' + i + '>', 'gi'),
      (_, t) => '\n\n' + '#'.repeat(i) + ' ' + decodeEntities(stripTags(t)).trim() + '\n\n')
  }
  s = s.replace(/<img[^>]*>/gi, (tag) => {
    const src = tag.match(/data-src="([^"]+)"/)?.[1] ?? tag.match(/\ssrc="([^"]+)"/)?.[1] ?? ''
    const alt = tag.match(/alt="([^"]*)"/)?.[1] ?? ''
    return '![' + decodeEntities(alt) + '](' + src + ')'
  })
  s = s.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) =>
    '[' + decodeEntities(stripTags(t)).trim() + '](' + href + ')')
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, b) =>
    '\n\n' + decodeEntities(stripTags(b)).trim().split(/\n+/).map((l) => '> ' + l.trim()).join('\n') + '\n\n')
  s = s.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, ul) =>
    '\n' + [...ul.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((li) => '- ' + decodeEntities(stripTags(li[1])).trim()).join('\n') + '\n')
  s = s.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, ol) => {
    const items = [...ol.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
    return '\n' + items.map((li, i) => (i + 1) + '. ' + decodeEntities(stripTags(li[1])).trim()).join('\n') + '\n'
  })
  s = s.replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, (_, t) => '**' + decodeEntities(stripTags(t)).trim() + '**')
  s = s.replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, (_, t) => '*' + decodeEntities(stripTags(t)).trim() + '*')
  s = s.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, t) => '\n\n' + decodeEntities(stripTags(t)).trim() + '\n\n')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<hr\s*\/?>/gi, '\n\n---\n\n')
  s = decodeEntities(stripTags(s))
  return s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}
