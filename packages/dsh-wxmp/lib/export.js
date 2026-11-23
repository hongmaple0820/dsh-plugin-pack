/**
 * 整号文章导出：纯读本地库（openStore 接口），不触发任何微信抓取。
 * 七格式：md / html / json / xlsx / docx / pdf / epub。
 *   - md / html / json / xlsx：图片引用式（保留原文 URL，不下载）。
 *   - docx / pdf / epub        ：微信图片现抓内嵌（按 URL 去重，单张失败静默跳过）。
 * 全部容器（zip / OOXML / PDF / EPUB）纯 JS 手写，零新增依赖。
 *
 * 上限（对齐参考实现 routes/export.py）：md/html/json/xlsx ≤ 3000，
 * docx/epub ≤ 500，pdf ≤ 200 —— 超限取最新 N 篇并返回 truncated:true。
 */
import { deflateRawSync, inflateSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export const FORMATS = ['md', 'html', 'json', 'xlsx', 'docx', 'pdf', 'epub']

const CAPS = { md: 3000, html: 3000, json: 3000, xlsx: 3000, docx: 500, epub: 500, pdf: 200 }

const CONTENT_TYPES = {
  md: 'application/zip',
  html: 'text/html; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  epub: 'application/epub+zip',
}

const EXT = { md: 'zip', html: 'html', json: 'json', xlsx: 'csv', docx: 'docx', pdf: 'pdf', epub: 'epub' }

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/* ================================================================ 小工具 */

/** Unix 秒 → 北京时间 'YYYY-MM-DD HH:mm'（对齐参考实现的 UTC+8）。 */
export function beijingTime(pt) {
  if (!pt) return ''
  return new Date(Number(pt) * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ')
}

/** 文件名安全化：替换非法字符、压空白、限长（空串返回 fallback）。 */
export function safeFileName(s, fallback = 'untitled') {
  const out = String(s ?? '').replace(/[\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/[\s\u3000]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
  return out || fallback
}

export function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&' + 'amp;').replace(/</g, '&' + 'lt;').replace(/>/g, '&' + 'gt;')
    .replace(/"/g, '&' + 'quot;').replace(/'/g, '&' + 'apos;')
}

const escapeAttr = escapeXml
const escapeHtml = escapeXml

function yamlScalar(s) {
  const v = String(s ?? '')
  return /^-?\d+$/.test(v) ? v : JSON.stringify(v)
}

function sanitizeFakeid(fakeid) {
  return String(fakeid).replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown'
}

function extOf(url, fallback) {
  const base = String(url).split('?')[0]
  const dot = base.lastIndexOf('.')
  const m = dot > 0 && dot < base.length - 1 ? [base.slice(dot + 1)] : null
  return (m ? m[1] : fallback).toLowerCase()
}

const isJpeg = (b) => b.length > 2 && b[0] === 0xff && b[1] === 0xd8
const isPng = (b) => b.length > 8 && b.subarray(0, 8).equals(PNG_SIG)

/* ================================================================ Markdown 解析（块 + 行内） */

/**
 * 块级解析。标题压到 3 级以内（Word/PDF 的标题档位有限）。
 * @returns {{type:string}[]} type ∈ h|p|list|quote|code|hr|image
 */
export function parseBlocks(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let para = []
  let inCode = false
  let code = []
  const flush = () => { if (para.length) { blocks.push({ type: 'p', text: para.join('\n') }); para = [] } }
  for (const line of lines) {
    const t = line.trim()
    if (inCode) {
      if (/^```\w*\s*$/.test(t)) { blocks.push({ type: 'code', text: code.join('\n') }); inCode = false; code = [] } else code.push(line)
      continue
    }
    if (/^```/.test(t)) { flush(); inCode = true; continue }
    if (!t) { flush(); continue }
    let m
    if ((m = t.match(/^(#{1,6})\s+(.*)$/))) { flush(); blocks.push({ type: 'h', level: Math.min(m[1].length, 3), text: m[2].replace(/\s*#*\s*$/, '') }); continue }
    if (/^(\*{3,}|-{3,}|_{3,})$/.test(t)) { flush(); blocks.push({ type: 'hr' }); continue }
    if ((m = t.match(/^>\s?(.*)$/))) { flush(); blocks.push({ type: 'quote', text: m[1] }); continue }
    if ((m = t.match(/^\s*[-*+]\s+(.*)$/)) || (m = t.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flush()
      const last = blocks[blocks.length - 1]
      if (last && last.type === 'list') last.items.push(m[1])
      else blocks.push({ type: 'list', items: [m[1]] })
      continue
    }
    if ((m = t.match(/^!\[[^\]]*\]\((\S+?)(?:\s+"[^"]*")?\)$/))) { flush(); blocks.push({ type: 'image', url: m[1], alt: '' }); continue }
    para.push(t)
  }
  flush()
  return blocks
}

const INLINE_RE = /(\*\*|__)(.+?)\1|(\*|_)(?!\s)([^*]+?)\3|\`([^\`]+)\`|!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

const INLINE_RE_SRC = INLINE_RE.source
/** 行内解析为 [{t:'text'|'bold'|'italic'|'code'|'link'|'image', s?, url?, c?}]。 */
export function parseInline(text) {
  const out = []
  const src = String(text ?? '')
  let last = 0, m
  const re = new RegExp(INLINE_RE_SRC, 'g')
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ t: 'text', s: src.slice(last, m.index) })
    if (m[2] !== undefined) out.push({ t: 'bold', c: parseInline(m[2]) })
    else if (m[4] !== undefined) out.push({ t: 'italic', c: parseInline(m[4]) })
    else if (m[5] !== undefined) out.push({ t: 'code', s: m[5] })
    else if (m[7] !== undefined) out.push({ t: 'image', url: m[7], alt: m[6] || '' })
    else if (m[9] !== undefined) out.push({ t: 'link', s: m[8], url: m[9] })
    last = re.lastIndex
    if (re.lastIndex === m.index) re.lastIndex++
  }
  if (last < src.length) out.push({ t: 'text', s: src.slice(last) })
  return out
}

/** 行内节点转纯文本。 */
function inlineText(nodes) {
  let s = ''
  for (const n of nodes || []) {
    if (n.t === 'text' || n.t === 'code') s += n.s
    else if (n.t === 'link') s += n.s
    else if (n.c) s += inlineText(n.c)
  }
  return s
}

/** 按文档顺序收集一篇文章引用的图片 URL（块级 + 行内），去重保序。 */
export function collectImageUrls(md) {
  const urls = []
  const seen = new Set()
  const push = (u) => { if (u && !seen.has(u)) { seen.add(u); urls.push(u) } }
  for (const b of parseBlocks(md)) {
    if (b.type === 'image') push(b.url)
    else if (b.text) for (const n of parseInline(b.text)) if (n.t === 'image') push(n.url)
    else if (b.items) for (const it of b.items) for (const n of parseInline(it)) if (n.t === 'image') push(n.url)
  }
  return urls
}

/* ================================================================ 纯 JS ZIP writer */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

class ZipWriter {
  constructor() { this.entries = [] }
  add(name, data, opts = {}) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
    const crc = crc32(buf)
    let method = 0, raw = buf
    if (!opts.forceStore) {
      const def = deflateRawSync(buf)
      if (def.length < buf.length) { method = 8; raw = def }
    }
    const date = opts.date ?? new Date()
    this.entries.push({ name: String(name).split('\\').join('/'), buf, raw, crc, method, date })
    return this
  }
  build() {
    const locals = []
    const central = []
    let offset = 0
    for (const e of this.entries) {
      const nameBuf = Buffer.from(e.name, 'utf8')
      const d = e.date
      const dt = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)
      const dd = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
      const localHead = Buffer.alloc(30)
      localHead.writeUInt32LE(0x04034b50, 0)
      localHead.writeUInt16LE(20, 4)
      localHead.writeUInt16LE(e.method === 8 ? 0x0800 : 0, 6)
      localHead.writeUInt16LE(e.method, 8)
      localHead.writeUInt16LE(dt, 10)
      localHead.writeUInt16LE(dd, 12)
      localHead.writeUInt32LE(e.crc, 14)
      localHead.writeUInt32LE(e.raw.length, 18)
      localHead.writeUInt32LE(e.buf.length, 22)
      localHead.writeUInt16LE(nameBuf.length, 26)
      localHead.writeUInt16LE(0, 28)
      locals.push(localHead, nameBuf, e.raw)
      const centralHead = Buffer.alloc(46)
      centralHead.writeUInt32LE(0x02014b50, 0)
      centralHead.writeUInt16LE(20, 4)
      centralHead.writeUInt16LE(20, 6)
      centralHead.writeUInt16LE(e.method === 8 ? 0x0800 : 0, 8)
      centralHead.writeUInt16LE(e.method, 10)
      centralHead.writeUInt16LE(dt, 12)
      centralHead.writeUInt16LE(dd, 14)
      centralHead.writeUInt32LE(e.crc, 16)
      centralHead.writeUInt32LE(e.raw.length, 20)
      centralHead.writeUInt32LE(e.buf.length, 24)
      centralHead.writeUInt16LE(nameBuf.length, 28)
      centralHead.writeUInt32LE(0, 38)
      centralHead.writeUInt32LE(offset, 42)
      central.push(centralHead, nameBuf)
      offset += localHead.length + nameBuf.length + e.raw.length
    }
    const centralBuf = Buffer.concat(central)
    const localBuf = Buffer.concat(locals)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(this.entries.length, 8)
    end.writeUInt16LE(this.entries.length, 10)
    end.writeUInt32LE(centralBuf.length, 12)
    end.writeUInt32LE(localBuf.length, 16)
    return Buffer.concat([localBuf, centralBuf, end])
  }
}

/* ================================================================ range 解析与文章收集 */

/**
 * 归一化 range：
 *   'all' | 'days:N' | {since,until} | 'incremental'
 * 'incremental' 等价 {since: 最近一次导出游标}——本函数只负责归一化，
 * 游标默认 0（首次即全量）；调用方可把 {since: cursor} 直接传给 exportAccount。
 * @returns {{since:number|null, until:number|null}}
 */
export function normalizeRange(range) {
  if (range == null || range === 'all') return { since: null, until: null }
  if (typeof range === 'string') {
    if (range === 'incremental') return { since: null, until: null }
    const m = range.match(/^days:(\d+)$/)
    if (m) return { since: Math.floor(Date.now() / 1000) - Number(m[1]) * 86400, until: null }
    throw new RangeError('不支持的 range 字符串: ' + range)
  }
  if (typeof range === 'object') {
    return {
      since: range.since != null ? Number(range.since) : null,
      until: range.until != null ? Number(range.until) : null,
    }
  }
  throw new RangeError('不支持的 range 类型')
}

/**
 * 从本地库收集文章（倒序，最新在前），应用 until 过滤。
 * listArticles 的 since 语义是「publishTime < since」的游标（store.js 已定）。
 * until 在这里逐篇过滤，保证 {since,until} 区间左闭右开 [until, since)。
 * @returns {Promise<{rows:object[], truncated:boolean, nextSince:number|null}>}
 */
async function collectArticles(store, fakeid, range, cap) {
  const { since, until } = normalizeRange(range)
  const out = []
  let cursor = null
  let truncated = false
  while (out.length < cap) {
    const page = await store.listArticles(fakeid, { since: cursor, limit: Math.min(200, cap - out.length) })
    for (const a of page.articles) {
      const pt = a.publishTime ?? 0
      if (until != null && pt >= until) continue
      if (since != null && pt <= since) return { rows: out, truncated, nextSince: out.length ? out[out.length - 1].publishTime : null }
      out.push(a)
      if (out.length >= cap) break
    }
    if (page.nextSince == null) break
    if (out.length >= cap) { truncated = page.nextSince != null }
    cursor = page.nextSince
    if (out.length >= cap) break
  }
  return { rows: out, truncated, nextSince: out.length ? out[out.length - 1].publishTime : null }
}

/* ================================================================ 微信图片现抓 */

/** 图片扩展名规范化（按魔数），无法识别时保底用 URL 后缀。 */
function imageExt(buf, fallbackExt) {
  if (isJpeg(buf)) return 'jpg'
  if (isPng(buf)) return 'png'
  return String(fallbackExt || 'jpg').toLowerCase().replace(/^jpeg$/, 'jpg').replace(/[^a-z0-9]/g, '') || 'jpg'
}

/**
 * 抓取一批图片，返回 [{url, buf, ext}]（按 URL 去重，单张失败跳过）。
 * 严格只抓微信媒体域，Referer 指向 mp.weixin.qq.com（对齐参考实现）。
 */
async function fetchImages(fetchImpl, urls, timeoutMs) {
  const allowed = /^https?:\/\/(mmbiz\.qpic\.cn|mmbiz\.qlogo\.cn|wx\.qlogo\.cn|res\.wx\.qq\.com)\//
  const unique = [...new Set(urls.filter((u) => allowed.test(u)))]
  const results = []
  for (const url of unique) {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      const res = await fetchImpl(url, { headers: { Referer: 'https://mp.weixin.qq.com/', 'User-Agent': 'Mozilla/5.0' }, signal: ctrl.signal })
      clearTimeout(timer)
      if (!res || res.status !== 200) continue
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length === 0) continue
      results.push({ url, buf, ext: imageExt(buf, extOf(url, 'jpg')) })
    } catch { /* 单张失败跳过 */ }
  }
  return results
}

/* ================================================================ 文章渲染辅助 */

/** 组装一篇 markdown：YAML frontmatter + 正文（对齐参考实现 _build_article_markdown）。 */
export function buildArticleMarkdown(a, nickname) {
  const date = beijingTime(a.publishTime)
  const fm = [
    '---',
    'title: ' + yamlScalar(a.title),
    'author: ' + yamlScalar(a.author || ''),
    'nickname: ' + yamlScalar(nickname || ''),
    'fakeid: ' + yamlScalar(a.fakeid || ''),
    'date: ' + yamlScalar(date),
    'publish_time: ' + yamlScalar(a.publishTime ?? ''),
    'source_url: ' + yamlScalar(a.link || a.sourceUrl || ''),
    '---',
    '',
    '# ' + (a.title || '无标题'),
    '',
  ].join('\n')
  return fm + (a.markdown || '').trim() + '\n'
}

/** 文章 markdown 源：优先使用 getArticle 现算的 markdown，退化用行上内容。 */
async function articleMarkdown(store, a) {
  if (a.markdown !== undefined) return a.markdown ?? ''
  try {
    const full = await store.getArticle(a.id)
    return full?.markdown ?? ''
  } catch { return '' }
}

/** 从 markdown 提取文章内图片 + 封面图（内嵌格式用）。 */
function embeddableUrls(md, cover) {
  const urls = collectImageUrls(md)
  if (cover) urls.unshift(cover)
  return [...new Set(urls)]
}

/* ================================================================ HTML 渲染（引用式，md/html 共用） */

function inlineHtml(nodes) {
  let s = ''
  for (const n of nodes || []) {
    if (n.t === 'text') s += escapeXml(n.s)
    else if (n.t === 'bold') s += '<strong>' + inlineHtml(n.c) + '</strong>'
    else if (n.t === 'italic') s += '<em>' + inlineHtml(n.c) + '</em>'
    else if (n.t === 'code') s += '<code>' + escapeXml(n.s) + '</code>'
    else if (n.t === 'link') s += '<a href="' + escapeAttr(n.url) + '">' + escapeXml(n.s) + '</a>'
    else if (n.t === 'image') s += '<img src="' + escapeAttr(n.url) + '" alt="' + escapeAttr(n.alt || '') + '" loading="lazy">'
  }
  return s
}

export function renderHtmlFragment(md) {
  let out = ''
  for (const b of parseBlocks(md)) {
    if (b.type === 'h') out += '<h' + b.level + '>' + inlineHtml(parseInline(b.text)) + '</h' + b.level + '>'
    else if (b.type === 'p') out += '<p>' + inlineHtml(parseInline(b.text)) + '</p>'
    else if (b.type === 'list') out += '<ul>' + b.items.map((i) => '<li>' + inlineHtml(parseInline(i)) + '</li>').join('') + '</ul>'
    else if (b.type === 'quote') out += '<blockquote>' + inlineHtml(parseInline(b.text)) + '</blockquote>'
    else if (b.type === 'code') out += '<pre><code>' + escapeXml(b.text) + '</code></pre>'
    else if (b.type === 'hr') out += '<hr>'
    else if (b.type === 'image') out += '<p><img src="' + escapeAttr(b.url) + '" alt="" loading="lazy"></p>'
  }
  return out
}

/* ================================================================ md：zip 合集 */

async function buildMd(store, nickname, rows) {
  const zw = new ZipWriter()
  const index = []
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i]
    const md = buildArticleMarkdown({ ...a, markdown: await articleMarkdown(store, a) }, nickname)
    const name = String(i + 1).padStart(3, '0') + '_' + safeFileName(a.title, 'article-' + a.id) + '.md'
    zw.add('md/' + name, md)
    index.push(`${i + 1}. ${a.title} — ${beijingTime(a.publishTime)}`)
  }
  const header = `# ${escapeHtml(nickname || '公众号文章')} 导出\n\n共导出 ${rows.length} 篇。\n\n`
  const truncated = rows.truncated ? '\n> 注意：超出导出上限，仅包含最新 ' + rows.length + ' 篇。\n' : ''
  zw.add('INDEX.md', header + index.map((x) => `- ${x}`).join('\n') + truncated)
  return zw.build()
}

/* ================================================================ html：单文件 + TOC + 暗色 */

async function buildHtml(store, nickname, rows) {
  const toc = []
  const body = []
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i]
    const md = await articleMarkdown(store, a)
    const id = 'art-' + (a.id || i)
    toc.push('<li><a href="#' + id + '">' + escapeXml(a.title || '无标题') + '</a> <span>' + escapeXml(beijingTime(a.publishTime)) + '</span></li>')
    body.push('<article id="' + id + '">' +
      '<h1>' + escapeXml(a.title || '无标题') + '</h1>' +
      '<p class="meta">作者：' + escapeXml(a.author || '') + ' · 发布时间：' + escapeXml(beijingTime(a.publishTime)) + ' · <a href="' + escapeAttr(a.link || a.sourceUrl || '#') + '">原文</a></p>' +
      renderHtmlFragment(md) +
      '</article>')
  }
  const note = rows.truncated ? '<p class="note">超出导出上限，仅包含最新 ' + rows.length + ' 篇。</p>' : ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeXml(nickname || '公众号文章')} 导出</title>
<style>
:root { color-scheme: light dark; }
body { max-width: 760px; margin: 0 auto; padding: 24px 16px 64px; font: 16px/1.75 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
.wx-toc { background: #f5f5f5; border-radius: 8px; padding: 12px 20px; margin-bottom: 32px; }
.wx-toc h2 { font-size: 18px; }
.wx-toc ol { padding-left: 20px; }
.wx-toc li { margin: 6px 0; }
.wx-toc span { color: #888; font-size: 13px; margin-left: 8px; }
article { border-top: 1px solid #e0e0e0; padding: 32px 0; }
article img { max-width: 100%; height: auto; }
.meta { color: #666; font-size: 14px; }
pre { overflow-x: auto; background: #f0f0f0; padding: 12px; border-radius: 6px; }
code { background: #eef; padding: 1px 5px; border-radius: 4px; }
pre code { background: none; padding: 0; }
blockquote { border-left: 4px solid #ccc; margin: 0; padding: 4px 16px; color: #555; }
.note { color: #b26b00; }
@media (prefers-color-scheme: dark) {
  body { background: #141414; color: #d8d8d8; }
  .wx-toc { background: #222; }
  article { border-top-color: #333; }
  .meta, .wx-toc span { color: #999; }
  pre { background: #222; }
  code { background: #332; }
  blockquote { border-left-color: #555; color: #aaa; }
  a { color: #7ab7ff; }
}
</style>
</head>
<body>
<header><h1>${escapeXml(nickname || '公众号文章')} 导出</h1><p>共 ${rows.length} 篇</p>${note}</header>
<nav class="wx-toc"><h2>目录</h2><ol>${toc.join('')}</ol></nav>
${body.join('\n')}
</body>
</html>
`
}

/* ================================================================ json：数组 */

async function buildJson(store, nickname, rows) {
  const out = []
  for (const a of rows) {
    const md = await articleMarkdown(store, a)
    out.push({
      id: a.id, fakeid: a.fakeid, title: a.title, author: a.author,
      link: a.link, sourceUrl: a.sourceUrl ?? a.link, digest: a.digest, cover: a.cover,
      publishTime: a.publishTime, publishTimeStr: a.publishTimeStr ?? beijingTime(a.publishTime),
      markdown: md,
    })
  }
  return JSON.stringify(out, null, 2)
}

/* ================================================================ xlsx：纯 JS 最小 OOXML */

function buildXlsx(rows) {
  const cols = [
    '<cols>' +
    '<col min="1" max="1" width="50" customWidth="1"/>' +
    '<col min="2" max="2" width="30" customWidth="1"/>' +
    '<col min="3" max="3" width="20" customWidth="1"/>' +
    '<col min="4" max="4" width="20" customWidth="1"/>' +
    '<col min="5" max="5" width="60" customWidth="1"/>' +
    '<col min="6" max="6" width="30" customWidth="1"/>' +
    '</cols>',
  ].join('')
  const rowsXml = []
  rowsXml.push('<row r="1">' + ['标题', '作者', '发布时间', '发布时间戳', '原文链接', '公众号'].map((h, i) =>
    '<c r="' + String.fromCharCode(65 + i) + '1" t="inlineStr"><is><t>' + escapeXml(h) + '</t></is></c>').join('') + '</row>')
  for (let r = 0; r < rows.length; r++) {
    const a = rows[r]
    const rn = r + 2
    const cells = [
      a.title, a.author, a.publishTimeStr ?? beijingTime(a.publishTime),
      String(a.publishTime ?? ''), a.link ?? a.sourceUrl ?? '', a.nickname ?? '',
    ]
    const cellXml = cells.map((v, i) => {
      const ref = String.fromCharCode(65 + i) + rn
      if (i === 3 && v !== '') return '<c r="' + ref + '" t="n"><v>' + escapeXml(v) + '</v></c>'
      return '<c r="' + ref + '" t="inlineStr"><is><t>' + escapeXml(v) + '</t></is></c>'
    }).join('')
    rowsXml.push('<row r="' + rn + '">' + cellXml + '</row>')
  }
  const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' + cols +
    '<sheetData>' + rowsXml.join('') + '</sheetData></worksheet>'
  const wb = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="articles" sheetId="1" r:id="rId1"/></sheets></workbook>'
  const ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
  const wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
  const zw = new ZipWriter()
  zw.add('[Content_Types].xml', ct)
  zw.add('_rels/.rels', rels)
  zw.add('xl/workbook.xml', wb)
  zw.add('xl/_rels/workbook.xml.rels', wbRels)
  zw.add('xl/worksheets/sheet1.xml', sheet)
  return zw.build()
}

/* ================================================================ 图片尺寸探测 */

function imageSize(buf) {
  if (isJpeg(buf)) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue }
      const marker = buf[i + 1]
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
      const len = buf.readUInt16BE(i + 2)
      if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
      }
      i += 2 + len
    }
    return { width: 0, height: 0 }
  }
  if (isPng(buf)) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  return { width: 0, height: 0 }
}

/* ================================================================ docx：纯 JS OOXML */

async function buildDocx(store, nickname, rows, fetchImpl, timeoutMs) {
  // 1) 收集全部待内嵌图片并抓取
  const wanted = []
  for (const a of rows) {
    const md = await articleMarkdown(store, a)
    wanted.push(...embeddableUrls(md, a.cover))
  }
  const images = await fetchImages(fetchImpl, wanted, timeoutMs)
  const urlToImage = new Map(images.map((im, i) => [im.url, { ...im, index: i + 1 }]))

  let docPrId = 100
  const docPr = () => ++docPrId
  const drawRun = (im, rid) => {
    const { width, height } = imageSize(im.buf)
    const maxW = 5303520 // 5.8in EMU
    const w = width > 0 ? maxW : maxW
    const h = width > 0 ? Math.round(maxW * height / width) : 2000000
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
      `<wp:extent cx="${w}" cy="${h}"/>` +
      `<wp:docPr id="${docPr()}" name="Picture ${im.index}"/>` +
      `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:pic><pic:nvPicPr><pic:cNvPr id="${docPr()}" name="img${im.index}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
      `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
  }

  const textRun = (text, extra) => `<w:r>${extra ?? ''}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`
  const runsFromNodes = (nodes) => {
    let s = ''
    for (const n of nodes || []) {
      if (n.t === 'text') s += textRun(n.s)
      else if (n.t === 'bold') s += runsFromNodes(n.c).replace(/<w:r>/g, '<w:r><w:rPr><w:b/></w:rPr>')
      else if (n.t === 'italic') s += runsFromNodes(n.c).replace(/<w:r>/g, '<w:r><w:rPr><w:i/></w:rPr>')
      else if (n.t === 'code') s += textRun(n.s, '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr>')
      else if (n.t === 'link') s += textRun(n.s)
      else if (n.t === 'image') {
        const im = urlToImage.get(n.url)
        if (im) s += drawRun(im, 'rIdImg' + im.index)
      }
    }
    return s
  }

  const body = []
  body.push('<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' + textRun(nickname || '公众号文章导出') + '</w:p>')
  for (const a of rows) {
    const md = await articleMarkdown(store, a)
    body.push('<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' + textRun(a.title || '无标题') + '</w:p>')
    body.push('<w:p>' + textRun('作者：' + (a.author || '') + ' · 发布时间：' + beijingTime(a.publishTime)) + '</w:p>')
    for (const b of parseBlocks(md)) {
      if (b.type === 'h') body.push('<w:p><w:pPr><w:pStyle w:val="Heading' + b.level + '"/></w:pPr>' + runsFromNodes(parseInline(b.text)) + '</w:p>')
      else if (b.type === 'p') body.push('<w:p>' + runsFromNodes(parseInline(b.text)) + '</w:p>')
      else if (b.type === 'list') for (const it of b.items) body.push('<w:p><w:pPr><w:ind w:left="360"/></w:pPr>' + textRun('• ' + inlineText(parseInline(it))) + '</w:p>')
      else if (b.type === 'quote') body.push('<w:p><w:pPr><w:ind w:left="360"/><w:jc w:val="left"/></w:pPr>' + runsFromNodes(parseInline(b.text)) + '</w:p>')
      else if (b.type === 'code') for (const ln of b.text.split('\n')) body.push('<w:p><w:pPr><w:ind w:left="240"/></w:pPr>' + textRun(ln, '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr>') + '</w:p>')
      else if (b.type === 'hr') body.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr></w:pPr></w:p>')
      else if (b.type === 'image') { const im = urlToImage.get(b.url); if (im) body.push('<w:p>' + drawRun(im, 'rIdImg' + im.index) + '</w:p>') }
    }
  }

  const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<w:body>' + body.join('') + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>'

  const stylesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体"/>' +
    '<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>' +
    '<w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>' +
    '<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>' +
    '<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>' +
    '</w:styles>'

  const ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="jpg" ContentType="image/jpeg"/>' +
    '<Default Extension="jpeg" ContentType="image/jpeg"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'
  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  const docRels = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>']
  for (const im of images) docRels.push('<Relationship Id="rIdImg' + im.index + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image' + im.index + '.' + im.ext + '"/>')
  docRels.push('</Relationships>')

  const zw = new ZipWriter()
  zw.add('[Content_Types].xml', ct)
  zw.add('_rels/.rels', rootRels)
  zw.add('word/document.xml', documentXml)
  zw.add('word/styles.xml', stylesXml)
  zw.add('word/_rels/document.xml.rels', docRels.join(''))
  for (const im of images) zw.add('word/media/image' + im.index + '.' + im.ext, im.buf)
  return zw.build()
}

/* ================================================================ epub：EPUB3 */

async function buildEpub(store, nickname, rows, fetchImpl, timeoutMs) {
  const wanted = []
  for (const a of rows) {
    const md = await articleMarkdown(store, a)
    wanted.push(...embeddableUrls(md, a.cover))
  }
  const images = await fetchImages(fetchImpl, wanted, timeoutMs)
  const urlToImage = new Map(images.map((im, i) => [im.url, { ...im, index: i + 1 }]))

  const renderXhtml = (md) => {
    let out = ''
    for (const b of parseBlocks(md)) {
      if (b.type === 'h') out += '<h' + b.level + '>' + epubInline(parseInline(b.text), urlToImage) + '</h' + b.level + '>'
      else if (b.type === 'p') out += '<p>' + epubInline(parseInline(b.text), urlToImage) + '</p>'
      else if (b.type === 'list') out += '<ul>' + b.items.map((i) => '<li>' + epubInline(parseInline(i), urlToImage) + '</li>').join('') + '</ul>'
      else if (b.type === 'quote') out += '<blockquote>' + epubInline(parseInline(b.text), urlToImage) + '</blockquote>'
      else if (b.type === 'code') out += '<pre><code>' + escapeXml(b.text) + '</code></pre>'
      else if (b.type === 'hr') out += '<hr/>'
      else if (b.type === 'image') {
        const im = urlToImage.get(b.url)
        if (im) out += '<p class="img"><img src="images/img' + im.index + '.' + im.ext + '" alt=""/></p>'
      }
    }
    return out
  }

  const chs = []
  const navItems = []
  const ncxNav = []
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i]
    const md = await articleMarkdown(store, a)
    const body = '<h1>' + escapeXml(a.title || '无标题') + '</h1>' +
      '<p class="meta">作者：' + escapeXml(a.author || '') + ' · 发布时间：' + escapeXml(beijingTime(a.publishTime)) + '</p>' +
      renderXhtml(md)
    const xhtml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE html>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN">\n<head>' +
      '<meta charset="utf-8"/>' +
      '<title>' + escapeXml(a.title || '无标题') + '</title>' +
      '<link rel="stylesheet" type="text/css" href="style/main.css"/>' +
      '</head>\n<body>' + body + '</body></html>'
    chs.push({ id: 'ch' + (i + 1), file: 'ch' + (i + 1) + '.xhtml', title: a.title || '无标题', xhtml })
    navItems.push('<li><a href="ch' + (i + 1) + '.xhtml">' + escapeXml(a.title || '无标题') + '</a></li>')
    ncxNav.push('<navPoint id="navPoint-' + (i + 1) + '" playOrder="' + (i + 1) + '"><navLabel><text>' + escapeXml(a.title || '无标题') + '</text></navLabel><content src="ch' + (i + 1) + '.xhtml"/></navPoint>')
  }

  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  const uid = 'urn:uuid:' + randomUUID()
  const opf = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">' +
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    '<dc:identifier id="bookid">' + uid + '</dc:identifier>' +
    '<dc:title>' + escapeXml(nickname || '公众号文章') + '</dc:title>' +
    '<dc:language>zh-CN</dc:language>' +
    '<meta property="dcterms:modified">' + now + '</meta>' +
    '</metadata>' +
    '<manifest>' +
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' +
    '<item id="css" href="style/main.css" media-type="text/css"/>' +
    chs.map((c) => '<item id="' + c.id + '" href="' + c.file + '" media-type="application/xhtml+xml"/>').join('') +
    images.map((im) => '<item id="img' + im.index + '" href="images/img' + im.index + '.' + im.ext + '" media-type="image/' + (im.ext === 'png' ? 'png' : 'jpeg') + '"/>').join('') +
    '</manifest>' +
    '<spine>' +
    chs.map((c) => '<itemref idref="' + c.id + '"/>').join('') +
    '</spine>' +
    '</package>'
  const nav = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE html>\n' +
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN">\n<head><meta charset="utf-8"/><title>目录</title></head>' +
    '<body><nav epub:type="toc"><h1>目录</h1><ol>' + navItems.join('') + '</ol></nav></body></html>'
  const ncx = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head>' +
    '<meta name="dtb:uid" content="' + uid + '"/>' +
    '<meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>' +
    '<docTitle><text>' + escapeXml(nickname || '公众号文章') + '</text></docTitle>' +
    '<navMap>' + ncxNav.join('') + '</navMap></ncx>'
  const container = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
    '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
  const css = 'body { font-family: serif; line-height: 1.7; margin: 0 5%; }\nimg { max-width: 100%; }\n.meta { color: #666; font-size: 0.9em; }\npre { white-space: pre-wrap; }\nblockquote { border-left: 4px solid #ccc; margin: 0; padding: 4px 16px; color: #555; }\n'

  const zw = new ZipWriter()
  zw.add('mimetype', 'application/epub+zip', { forceStore: true })
  zw.add('META-INF/container.xml', container)
  zw.add('OEBPS/content.opf', opf)
  zw.add('OEBPS/nav.xhtml', nav)
  zw.add('OEBPS/toc.ncx', ncx)
  zw.add('OEBPS/style/main.css', css)
  for (const c of chs) zw.add('OEBPS/' + c.file, c.xhtml)
  for (const im of images) zw.add('OEBPS/images/img' + im.index + '.' + im.ext, im.buf)
  return zw.build()
}

function epubInline(nodes, urlToImage) {
  let s = ''
  for (const n of nodes || []) {
    if (n.t === 'text') s += escapeXml(n.s)
    else if (n.t === 'bold') s += '<strong>' + epubInline(n.c, urlToImage) + '</strong>'
    else if (n.t === 'italic') s += '<em>' + epubInline(n.c, urlToImage) + '</em>'
    else if (n.t === 'code') s += '<code>' + escapeXml(n.s) + '</code>'
    else if (n.t === 'link') s += '<a href="' + escapeAttr(n.url) + '">' + escapeXml(n.s) + '</a>'
    else if (n.t === 'image') {
      const im = urlToImage.get(n.url)
      if (im) s += '<img src="images/img' + im.index + '.' + im.ext + '" alt="' + escapeAttr(n.alt || '') + '"/>'
    }
  }
  return s
}

/* ================================================================ pdf：纯 JS 最小 PDF 1.4 */

/** 行内节点 → 纯文本（ASCII/拉丁；非 ASCII 由 pdfEscape 折叠）。 */
function pdfTextOf(nodes) {
  let s = ''
  for (const n of nodes || []) {
    if (n.t === 'text' || n.t === 'code') s += n.s
    else if (n.t === 'link') s += n.s
    else if (n.c) s += pdfTextOf(n.c)
  }
  return s
}

function pdfEscape(s) {
  // 标准 14 字体（Helvetica）没有中文 glyph：非 Latin-1 字符折叠为 '?'，
  // PDF 结构真实合法、非伪造；中文标题在 HTML/EPUB/DOCX 格式里完整保留。
  return String(s ?? '')
    .split('').map((ch) => (ch.charCodeAt(0) <= 0xff ? ch : '?')).join('')
    .replace(/([()\\])/g, '\\$1')
}

async function buildPdf(store, nickname, rows) {
  const pages = []
  let cur = []
  let curLines = 0
  const pushPage = () => { if (cur.length) { pages.push(cur); cur = []; curLines = 0 } }
  const addLine = (text, size, bold, indent, gap) => {
    const maxLines = 46
    if (curLines >= maxLines) pushPage()
    cur.push({ text, size: size || 11, bold: !!bold, indent: indent || 0, gap: gap || 0 })
    curLines++
  }
  for (const a of rows) {
    addLine(a.title || '(untitled)', 16, true, 0, 6)
    addLine('author: ' + (a.author || '') + '  date: ' + beijingTime(a.publishTime), 9, false, 0, 4)
    addLine(a.link || a.sourceUrl || '', 8, false, 0, 6)
    const md = await articleMarkdown(store, a)
    for (const b of parseBlocks(md)) {
      if (b.type === 'h') addLine(pdfTextOf(parseInline(b.text)), 13, true, 0, 4)
      else if (b.type === 'p') {
        const t = pdfTextOf(parseInline(b.text))
        for (const seg of wrapText(t, 86)) addLine(seg, 11, false, 0, 2)
      } else if (b.type === 'list') {
        for (const it of b.items) {
          const t = pdfTextOf(parseInline(it))
          for (const seg of wrapText('- ' + t, 82)) addLine(seg, 11, false, 14, 2)
        }
      } else if (b.type === 'quote') {
        const t = pdfTextOf(parseInline(b.text))
        for (const seg of wrapText('"' + t + '"', 80)) addLine(seg, 11, false, 24, 2)
      } else if (b.type === 'code') {
        for (const ln of b.text.split('\n').slice(0, 20)) addLine(ln.slice(0, 90), 9, false, 20, 1)
      } else if (b.type === 'image') {
        addLine('[image: ' + b.url.slice(0, 70) + ']', 9, false, 10, 3)
      }
    }
    pushPage()
  }
  if (!pages.length) pages.push([{ text: '(no articles)', size: 12, bold: false, indent: 0, gap: 0 }])

  const objects = []
  const addObj = (body) => { objects.push(body); return objects.length } // 返回对象号
  // 1: Catalog, 2: Pages (占位，先记号)
  addObj('<< /Type /Catalog /Pages 2 0 R >>')
  const kids = []
  const pageObjNums = []
  for (const pg of pages) {
    const contentLines = []
    let y = 812
    for (const ln of pg) {
      const font = ln.bold ? '/F2' : '/F1'
      y -= ln.gap
      contentLines.push('BT ' + font + ' ' + ln.size + ' Tf ' + (56 + ln.indent) + ' ' + y + ' Td (' + pdfEscape(ln.text) + ') Tj ET')
      y -= Math.round(ln.size * 1.5)
    }
    const stream = contentLines.join('\n')
    const contentNum = addObj('<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream')
    const fontRes = '<< /F1 ' + (objects.length + 2) + ' 0 R /F2 ' + (objects.length + 3) + ' 0 R >>'
    const pageNum = addObj('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font ' + fontRes + ' >> /Contents ' + contentNum + ' 0 R >>')
    pageObjNums.push(pageNum)
  }
  addObj('<< /Type /Pages /Count ' + pages.length + ' /Kids [' + pageObjNums.map((n) => n + ' 0 R').join(' ') + '] >>')
  addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')

  let out = '%PDF-1.4\n'
  const offsets = [0]
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(out))
    out += (i + 1) + ' 0 obj\n' + objects[i] + '\nendobj\n'
  }
  const xrefPos = Buffer.byteLength(out)
  const n = objects.length + 1
  let xref = 'xref\n0 ' + n + '\n0000000000 65535 f \n'
  for (let i = 1; i < n; i++) xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n'
  out += xref
  out += 'trailer\n<< /Size ' + n + ' /Root 1 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF'
  return Buffer.from(out, 'latin1')
}

function wrapText(text, width) {
  const t = String(text ?? '')
  if (!t) return ['']
  const words = t.split(/\s+/)
  const lines = []
  let line = ''
  for (const w of words) {
    if (!line) line = w
    else if (line.length + 1 + w.length <= width) line += ' ' + w
    else { lines.push(line); line = w }
    while (line.length > width) { lines.push(line.slice(0, width)); line = line.slice(width) }
  }
  if (line) lines.push(line)
  return lines
}

/* ================================================================ 主入口 exportAccount */

/**
 * 整号导出主入口。纯读本地库（store.listArticles / getArticle），不触发微信抓取；
 * docx/pdf/epub 的图片内嵌才用 fetchImpl 现抓微信图片（单张失败跳过）。
 *
 * @param {object} store openStore() 实例
 * @param {string} fakeid
 * @param {string} format md|html|json|xlsx|docx|pdf|epub
 * @param {{range?:string|object, fetchImpl?:Function, timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, format:string, fakeid:string, nickname:string,
 *   count:number, truncated:boolean, nextSince:number|null, contentType:string,
 *   ext:string, buf:Buffer, reason?:string}>}
 *   失败时 ok:false + reason，不产出任何文件。
 */
export async function exportAccount(store, fakeid, format, opts = {}) {
  const { range = 'all', fetchImpl = null, timeoutMs = 15000 } = opts
  try {
    if (!store || typeof store.listArticles !== 'function') return { ok: false, format, fakeid, reason: '参数 store 无效' }
    if (!fakeid) return { ok: false, format, fakeid: '', reason: '参数 fakeid 必填' }
    if (!FORMATS.includes(format)) {
      return { ok: false, format: String(format), fakeid, reason: '不支持的导出格式: ' + format + '（可选 ' + FORMATS.join('|') + '）' }
    }
    const { since, until } = normalizeRange(range)
    if (since != null && (!Number.isFinite(since) || since < 0)) {
      return { ok: false, format, fakeid, reason: 'range.since 必须是非负 Unix 秒' }
    }
    if (until != null && (!Number.isFinite(until) || until < 0)) {
      return { ok: false, format, fakeid, reason: 'range.until 必须是非负 Unix 秒' }
    }

    let nickname = ''
    try {
      const sub = (store.listSubscriptions() || []).find((s) => s.fakeid === String(fakeid))
      nickname = sub?.nickname || ''
    } catch { /* 订阅列表读不到不影响导出 */ }

    const cap = CAPS[format]
    const collected = await collectArticles(store, fakeid, range, cap)
    const rows = collected.rows
    const truncated = collected.truncated || false

    let buf
    if (format === 'md') buf = await buildMd(store, nickname, rows)
    else if (format === 'html') buf = Buffer.from(await buildHtml(store, nickname, rows), 'utf8')
    else if (format === 'json') buf = Buffer.from(await buildJson(store, nickname, rows), 'utf8')
    else if (format === 'xlsx') buf = buildXlsx(rows.map((a) => ({ ...a, nickname })))
    else if (format === 'docx') {
      if (typeof fetchImpl !== 'function') {
        return { ok: false, format, fakeid, reason: 'docx 导出需要 fetchImpl（图片内嵌现抓微信图片）' }
      }
      buf = await buildDocx(store, nickname, rows, fetchImpl, timeoutMs)
    } else if (format === 'epub') {
      if (typeof fetchImpl !== 'function') {
        return { ok: false, format, fakeid, reason: 'epub 导出需要 fetchImpl（图片内嵌现抓微信图片）' }
      }
      buf = await buildEpub(store, nickname, rows, fetchImpl, timeoutMs)
    } else if (format === 'pdf') {
      buf = await buildPdf(store, nickname, rows)
    }
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      return { ok: false, format, fakeid, reason: '导出内容为空（buf 未生成）' }
    }

    return {
      ok: true, format, fakeid: String(fakeid), nickname, count: rows.length,
      truncated, nextSince: collected.nextSince ?? null,
      contentType: CONTENT_TYPES[format], ext: EXT[format], buf,
    }
  } catch (err) {
    return { ok: false, format, fakeid, reason: '导出失败: ' + (err?.message || String(err)) }
  }
}
