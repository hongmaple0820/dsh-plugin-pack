/**
 * RSS 2.0 输出的纯函数层。
 *
 * 无 Cordis 依赖、无 I/O、无全局状态；输入订阅元数据 + 文章列表，输出 RSS 2.0 XML 字符串。
 * 正文以转义后的 HTML 片段放入 <description>（不用 CDATA：正文可能含 ]]>）。
 */

/** XML 文本节点转义：& < > " ' 五个字符，与参考实现 rss_streaming.py 的 _escape_xml 一致。 */
function escapeXml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Unix 秒/毫秒时间戳 → RFC 822（GMT），无效值返回空串。 */
function rfc822(ts) {
  if (ts === null || ts === undefined || ts === '') return ''
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return ''
  // 毫秒级（> 1e11）归一为秒
  const sec = n > 1e11 ? Math.floor(n / 1000) : Math.floor(n)
  const d = new Date(sec * 1000)
  if (Number.isNaN(d.getTime())) return ''
  return d.toUTCString()
}

/**
 * 生成单账号 RSS 2.0 XML。
 *
 * @param {object} options
 * @param {object} options.subscriptions 订阅元数据 { fakeid, nickname, alias, headImg? } 或其数组（取第一个）
 * @param {Array} options.articles 文章列表（store.listArticles 的行：title/link/digest/cover/author/content/publishTime/publishTimeStr）
 * @param {string} options.siteUrl RSS 根地址（如 https://example.com），atom:link self 与 item link 前缀
 * @param {string|number} [options.buildTime] 构建时间戳（秒或毫秒），缺省用当前时间
 * @param {number} [options.limit=30] 最多输出条数
 * @returns {string} RSS 2.0 XML
 */
export function generateRss({
  subscriptions,
  articles = [],
  siteUrl = '',
  buildTime,
  limit = 30,
} = {}) {
  const sub = Array.isArray(subscriptions) ? subscriptions[0] : subscriptions
  const fakeid = String(sub?.fakeid ?? '')
  const nickname = sub?.nickname || sub?.alias || fakeid || '微信公众号'
  const base = String(siteUrl || '').replace(/\/+$/, '')
  const selfUrl = base ? base + '/api/plugins/wxmp/rss/' + encodeURIComponent(fakeid) + '.xml' : ''

  const buildDate = rfc822(buildTime ?? Date.now())

  const list = Array.isArray(articles) ? articles.slice(0, Math.max(0, limit)) : []

  const channelLink = 'https://mp.weixin.qq.com'
  const description = nickname + ' 的微信公众号文章订阅（由 dsh-wxmp 生成）'

  const out = []
  out.push('<?xml version="1.0" encoding="UTF-8"?>')
  out.push('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">')
  out.push('<channel>')
  out.push('  <title>' + escapeXml(nickname) + '</title>')
  out.push('  <link>' + escapeXml(channelLink) + '</link>')
  out.push('  <description>' + escapeXml(description) + '</description>')
  out.push('  <language>zh-CN</language>')
  if (selfUrl) {
    out.push('  <atom:link href="' + escapeXml(selfUrl) + '" rel="self" type="application/rss+xml"/>')
  }
  if (buildDate) out.push('  <lastBuildDate>' + escapeXml(buildDate) + '</lastBuildDate>')
  out.push('  <generator>dsh-wxmp</generator>')
  if (sub?.headImg) {
    out.push('  <image>')
    out.push('    <url>' + escapeXml(sub.headImg) + '</url>')
    out.push('    <title>' + escapeXml(nickname) + '</title>')
    out.push('    <link>' + escapeXml(channelLink) + '</link>')
    out.push('  </image>')
  }

  for (const a of list) {
    const link = String(a?.link ?? '')
    const title = a?.title || '(无标题)'
    const pubDate = rfc822(a?.publishTime ?? a?.publishTimeStr)
    const guid = link || (fakeid ? fakeid + ':' + (a?.id ?? a?.aid ?? '') : String(a?.id ?? ''))
    const desc = buildDescription(a)
    out.push('  <item>')
    out.push('    <title>' + escapeXml(title) + '</title>')
    if (link) out.push('    <link>' + escapeXml(link) + '</link>')
    out.push('    <guid isPermaLink="' + (link ? 'true' : 'false') + '">' + escapeXml(guid) + '</guid>')
    if (pubDate) out.push('    <pubDate>' + escapeXml(pubDate) + '</pubDate>')
    if (a?.author) out.push('    <author>' + escapeXml(a.author) + '</author>')
    out.push('    <description>' + escapeXml(desc) + '</description>')
    out.push('  </item>')
  }

  out.push('</channel>')
  out.push('</rss>')
  return out.join('\n') + '\n'
}

/**
 * 组装 item 的 description：正文 HTML 片段（<img> 用封面）、摘要与阅读原文链接。
 * 返回未转义的 HTML 字符串，由调用方统一转义。
 */
function buildDescription(article) {
  const a = article || {}
  const parts = []
  const cover = a.cover || a.headImg || ''
  if (cover) parts.push('<p><img src="' + String(cover) + '" alt="' + String(a.title || '') + '"/></p>')
  const text = typeof a.content === 'string' && a.content.trim()
    ? a.content
    : (a.digest || a.summary || a.plainText || '')
  if (text) {
    const clipped = text.length > 2000 ? text.slice(0, 2000) + '…' : text
    parts.push('<div>' + clipped + '</div>')
  }
  if (a.link) parts.push('<p><a href="' + String(a.link) + '">阅读原文</a></p>')
  return parts.join('\n')
}
