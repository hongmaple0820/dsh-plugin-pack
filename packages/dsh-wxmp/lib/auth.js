/**
 * 微信公众平台扫码登录的纯逻辑层。
 *
 * 四步流程（端点经逆向验证）：
 *  1. POST /cgi-bin/bizlogin?action=startlogin —— 种会话 cookie（body 需完整字段集：userlang/redirect_url/login_type/sessionid/token/lang/f/aj4x，否则 ret=200009）
 *  2. GET  /cgi-bin/scanloginqrcode?action=getqrcode&random=... —— 返回二维码 PNG + Set-Cookie
 *  3. 轮询 GET /cgi-bin/scanloginqrcode?action=ask&token=<uuid> —— status 1=成功，4/6=已扫待确认
 *  4. POST /cgi-bin/bizlogin?action=login —— redirect_url 的 query 里提 token，合并浏览器 cookie 与响应新 cookie
 *
 * fakeid：登录后 GET /cgi-bin/home?t=home/index 用正则提 nick_name，再走 searchbiz 精确匹配。
 * 凭证落盘 dataDir/.credentials.json（token/cookie/fakeid/nickname/expireAtMs，now+4 天）。
 * 无 Cordis 依赖、无全局状态，fetchImpl 必须注入。
 */

import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BASE, WXMP_UA, searchBiz } from './wechat.js'

/** 凭证有效期：4 天（微信后台实际约 4 天过期）。 */
const EXPIRE_MS = 4 * 24 * 3600 * 1000

/** 从 Set-Cookie 数组/字符串提取“名=值”合并进 cookieJar。 */
function collectCookies(jar, setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : [])
  for (const line of list) {
    const m = String(line).split(';')[0].trim().match(/^([^=\s]+)=([^]*)$/)
    if (m) jar[m[1]] = m[2]
  }
}

/** cookieJar -> Cookie 头字符串。 */
function jarToHeader(jar) {
  return Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ')
}

/** 简易 JSON body 提取（微信老接口常返回 xxx(json) 或纯 JSON）。 */
function looseJsonParse(text) {
  if (typeof text !== 'string') return null
  const s = text.trim()
  try { return JSON.parse(s) } catch { /* 继续 */ }
  const m = s.match(/^[^(]*\((\{[\s\S]*\})\)\s*;?\s*$/)
  if (m) { try { return JSON.parse(m[1]) } catch { /* 继续 */ } }
  return null
}

/**
 * 创建登录/凭证管理器。
 * @param {object} options { dataDir, fetchImpl, timeoutMs?, signal? }
 * @returns {object} { startLogin, qrcode, pollScan, summary, getCredentials, isExpired, logout }
 */
export function createAuth(options = {}) {
  const { dataDir, fetchImpl, timeoutMs = 15000, signal } = options
  if (!dataDir) throw new RangeError('参数 dataDir 必填')
  if (typeof fetchImpl !== 'function') throw new RangeError('参数 fetchImpl 必须是函数')
  const dir = resolve(dataDir)
  const credPath = join(dir, '.credentials.json')
  /** 会话态：sessionId -> { cookieJar, uuid }（纯内存，重启即失效，可重新 startLogin）。 */
  const sessions = new Map()

  const ctx = { fetchImpl, timeoutMs, signal }

  async function req(url, { method = 'GET', query, headers, body } = {}) {
    const u = new URL(url.startsWith('http') ? url : BASE + url)
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null) u.searchParams.set(k, String(v))
    }
    const h = { 'User-Agent': WXMP_UA, ...(headers || {}) }
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    const onOuter = () => ac.abort()
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); throw new Error('请求已取消') }
      signal.addEventListener('abort', onOuter, { once: true })
    }
    try {
      const res = await fetchImpl(u.toString(), { method, headers: h, body, redirect: 'manual', signal: ac.signal })
      // 保留原始字节：二维码是二进制 JPG，text() 的 UTF-8 解码会损坏它
      const buf = typeof res.arrayBuffer === 'function' ? await res.arrayBuffer() : null
      const text = buf ? new TextDecoder('utf-8', { fatal: false }).decode(buf) : String(res.text)
      return { status: res.status, text, headers: res.headers, buf }
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onOuter)
    }
  }

  /** 读取落盘凭证；不存在或字段缺失返回 null。 */
  function readCred() {
    try {
      if (!existsSync(credPath)) return null
      const c = JSON.parse(readFileSync(credPath, 'utf8'))
      return c && c.token && c.cookie ? c : null
    } catch {
      return null
    }
  }

  /** 判断凭证是否已过期。 */
  function isExpired() {
    const c = readCred()
    if (!c) return true
    return !(c.expireAtMs > Date.now())
  }

  /**
   * 第一步：startlogin 种 cookie，返回 sessionId（后续 qrcode/pollScan 都用它取会话）。
   * @returns {Promise<{sessionId:string}>}
   */
  async function startLogin() {
    const sessionId = randomUUID()
    const jar = {}
    const res = await req('/cgi-bin/bizlogin', {
      query: { action: 'startlogin' },
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: BASE + '/', Origin: BASE },
      // 完整字段集照微信前端（缺 redirect_url/token/userlang/lang 会返回 ret=200009 not found）。
      body: new URLSearchParams({
        userlang: 'zh_CN', redirect_url: '', login_type: '3', sessionid: sessionId.slice(0, 8),
        token: '', lang: 'zh_CN', f: 'json', ajax: '1',
      }).toString(),
    })
    collectCookies(jar, res.headers.getSetCookie?.() ?? res.headers.get?.('set-cookie'))
    sessions.set(sessionId, { jar, uuid: null })
    return { sessionId }
  }

  /**
   * 第二步：取二维码 PNG 原始字节（同时吸收 Set-Cookie）。
   * @returns {Promise<{body:ArrayBuffer|Buffer, contentType:string}>}
   */
  async function qrcode(sessionId) {
    const s = sessions.get(String(sessionId))
    if (!s) throw new RangeError('会话不存在或已失效，请重新调用 startLogin()')
    const res = await req('/cgi-bin/scanloginqrcode', {
      query: { action: 'getqrcode', random: Date.now() },
      headers: { Referer: BASE + '/', Cookie: jarToHeader(s.jar) },
    })
    collectCookies(s.jar, res.headers.getSetCookie?.() ?? res.headers.get?.('set-cookie'))
    const ct = res.headers.get('content-type') ?? 'image/png'
    // 二进制必须走 res.buf（原始字节），text() 是 UTF-8 解码会损坏 JPG/PNG
    if (!res.buf) throw new Error('二维码获取失败：底层 fetch 未返回二进制内容')
    return { body: res.buf, contentType: ct }
  }

  /**
   * 第三步：ask 轮询单次调用。
   * @returns {Promise<'pending'|'scanned'|'logged_in'|'failed'>}
   *   pending=未扫 / scanned=已扫待确认（status 4/6）/ logged_in=成功（内部完成第四步并落盘） / failed=过期或异常
   */
  async function pollScan(sessionId) {
    const s = sessions.get(String(sessionId))
    if (!s) throw new RangeError('会话不存在或已失效，请重新调用 startLogin()')
    // token 固定空串：微信用 startlogin 种下的 uuid cookie 关联会话，随机 token 会让状态查询失败。
    const res = await req('/cgi-bin/scanloginqrcode', {
      query: { action: 'ask', token: '&lang=zh_CN&f=json&ajax=1' },
      headers: { Referer: BASE + '/', Cookie: jarToHeader(s.jar) },
    })
    collectCookies(s.jar, res.headers.getSetCookie?.() ?? res.headers.get?.('set-cookie'))
    const data = looseJsonParse(res.text)
    // 只认 data.status（无 status 视为异常）：base_resp.ret=1 与扫描成功 status=1 同值，
    // 旧写法 ?? 兜到 ret 会把未登录误判成已确认、进而调 finishLogin 报错。
    if (typeof data?.status === 'number') {
      const status = data.status
      if (status === 4 || status === 6) return 'scanned'
      if (status === 1) {
        await finishLogin(s)
        return 'logged_in'
      }
      if (status === 2) return 'pending'
    }
    // 无 status 字段（异常 JSON）也按等待处理：轮询容错，交给下一次或过期
    return 'pending'
  }

  /** 第四步：bizlogin login，提 token、合 cookie、找 fakeid、落盘。 */
  async function finishLogin(s) {
    const res = await req('/cgi-bin/bizlogin', {
      query: { action: 'login' },
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: BASE + '/',
        Cookie: jarToHeader(s.jar)
      },
      // 完整字段集照微信前端（缺 cookie_forbidden/cookie_cleaned/plugin_used 时会跳不到 redirect_url）。
      body: new URLSearchParams({
        userlang: 'zh_CN', redirect_url: '', cookie_forbidden: '0', cookie_cleaned: '0',
        plugin_used: '0', login_type: '3', token: '', lang: 'zh_CN', f: 'json', ajax: '1',
      }).toString(),
    })
    collectCookies(s.jar, res.headers.getSetCookie?.() ?? res.headers.get?.('set-cookie'))
    const data = looseJsonParse(res.text)
    let redirect = data?.redirect_url ?? data?.base_resp?.redirect_url ?? ''
    // 兜底：某些响应把 redirect_url 塞在文本里
    if (!redirect) redirect = res.text.match(/redirect_url["'\s:=]+([^"'\s]+)/)?.[1] ?? ''
    const token = new URL(redirect, BASE).searchParams.get('token')
    if (!token) throw new Error('扫码登录失败：响应中找不到 redirect_url 里的 token，请重试')
    // fakeid：先从首页正则提 nick_name，再 searchbiz 精确匹配
    let nickname = null
    let fakeid = null
    let headImg = ''
    const credentials = { token, cookie: jarToHeader(s.jar) }
    try {
      const home = await req('/cgi-bin/home', {
        query: { t: 'home/index', lang: 'zh_CN', token },
        headers: { Cookie: credentials.cookie, Referer: BASE + '/' },
      })
      const m = home.text.match(/nick_name[^\n]*?["']([^"']{1,64})["']/)
      nickname = m ? decodeURIComponent(m[1]) : null
    } catch { /* 首页失败不阻塞登录，稍后由调用方补 fakeid */ }
    if (nickname) {
      try {
        const found = await searchBiz({ query: nickname }, { fetchImpl, timeoutMs, signal, credentials })
        const hit = found.list.find((it) => it.nickname === nickname)
        if (hit) { fakeid = hit.fakeid; headImg = hit.roundHeadImg }
      } catch { /* 搜索失败不阻塞登录 */ }
    }
    const cred = {
      token,
      cookie: jarToHeader(s.jar),
      fakeid: fakeid ?? '',
      nickname: nickname ?? '',
      headImg,
      expireAtMs: Date.now() + EXPIRE_MS,
      savedAtMs: Date.now(),
    }
    mkdirSync(dir, { recursive: true })
    writeFileSync(credPath, JSON.stringify(cred, null, 2), 'utf8')
    sessions.delete?.(cred.fakeid) // no-op，保持无副作用
    return cred
  }

  /** 凭证概要：status 'logged_in' | 'none' | 'expired'。expireAt 为 Unix 秒。 */
  function summary() {
    const c = readCred()
    if (!c) return { status: 'none' }
    if (!(c.expireAtMs > Date.now())) return { status: 'expired' }
    return {
      status: 'logged_in',
      nickname: c.nickname || undefined,
      headImg: c.headImg || undefined,
      expireAt: Math.floor(c.expireAtMs / 1000),
      fakeid: c.fakeid || undefined,
    }
  }

  /** 取当前凭证 {token, cookie}；未登录或已过期抛中文错误。 */
  function getCredentials() {
    const c = readCred()
    if (!c) throw new Error('尚未登录微信公众平台，请先扫码登录')
    if (!(c.expireAtMs > Date.now())) throw new Error('微信公众平台登录已过期，请重新扫码登录')
    return { token: c.token, cookie: c.cookie, fakeid: c.fakeid, nickname: c.nickname }
  }

  /** 登出：删除凭证文件。 */
  function logout() {
    try { unlinkSync(credPath) } catch { /* 文件不存在视为已登出 */ }
  }

  return { startLogin, qrcode, pollScan, summary, getCredentials, isExpired, logout }
}
