/**
 * 冒烟单测：假 fetch 覆盖登录四步、searchbiz、appmsgpublish 双层解析、
 * 正文解析、htmlToMarkdown、store 增量去重（内存兜底）。
 * 运行：node --test test/*.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  requestWechat, searchBiz, listArticles, accountInfo, fetchArticle,
  parseArticleHtml, htmlToMarkdown, LoginExpiredError, InvalidFakeidError,
} from '../lib/wechat.js'
import { openStore } from '../lib/store.js'
import { createAuth } from '../lib/auth.js'
import {
  APPMSGPUBLISH_JSON, SEARCHBIZ_JSON, EXPIRED_JSON, INVALID_FAKEID_JSON,
  ARTICLE_HTML, BROKEN_HTML,
} from './fixtures.mjs'

/* ---------------------------------------------------------------- 微信接口 */

test('searchBiz：解析列表并映射 snake_case 字段', async () => {
  const seen = []
  const fetchImpl = async (url) => {
    seen.push(url)
    return { status: 200, text: SEARCHBIZ_JSON, headers: new Headers() }
  }
  const r = await searchBiz({ query: '测试号' }, { fetchImpl, credentials: { token: 'T', cookie: 'c=1' } })
  assert.equal(r.total, 2)
  assert.equal(r.list[0].fakeid, 'M1234567890')
  assert.equal(r.list[0].roundHeadImg, 'https://mmbiz.qpic.cn/avatar1.jpg')
  assert.match(seen[0], /action=search_biz/)
  assert.match(seen[0], /query=%E6%B5%8B%E8%AF%95%E5%8F%B7/)
})

test('searchBiz：ret=-1 抛 LoginExpiredError', async () => {
  const fetchImpl = async () => ({ status: 200, text: EXPIRED_JSON, headers: new Headers() })
  await assert.rejects(
    searchBiz({ query: 'x' }, { fetchImpl, credentials: { token: 'T', cookie: 'c' } }),
    (e) => e instanceof LoginExpiredError)
})

test('listArticles：双层 JSON 字符串解析出文章', async () => {
  let sawUrl = ''
  const fetchImpl = async (url) => {
    sawUrl = url
    return { status: 200, text: APPMSGPUBLISH_JSON, headers: new Headers() }
  }
  const r = await listArticles(
    { fakeid: 'M1234567890', begin: 0, count: 10 },
    { fetchImpl, credentials: { token: 'T', cookie: 'c=1' } })
  assert.match(sawUrl, /appmsgpublish/)
  assert.match(sawUrl, /type=101_1/)
  assert.equal(r.articles.length, 2)
  assert.equal(r.articles[0].aid, '2247485712_1')
  assert.equal(r.articles[0].title, '第一篇文章')
  assert.equal(r.articles[0].link, 'https://mp.weixin.qq.com/s/AAA111')
  assert.equal(r.articles[0].updateTime, 1750000000)
  assert.equal(r.hasMore, true)
})

test('回归：credentials 放第一参数（index.js 调用形态）也能带上 Cookie', async () => {
  // 根因回归测试：lib/wechat.js 曾只认 ctx.credentials，index.js 把 credentials 放第一参数，
  // 导致 Cookie 从未发出、真机 searchbiz 返回 HTML / appmsgpublish 返回 200003 invalid session。
  const seen = []
  const fetchImpl = async (url, init = {}) => {
    seen.push(String(init.headers?.Cookie ?? init.headers?.get?.('Cookie') ?? ''))
    const body = url.includes('searchbiz') ? SEARCHBIZ_JSON : APPMSGPUBLISH_JSON
    return { status: 200, text: body, headers: new Headers() }
  }
  await searchBiz({ query: '测试号', credentials: { token: 'T', cookie: 'sid=ok' } }, { fetchImpl })
  await listArticles({ fakeid: 'M1234567890', credentials: { token: 'T', cookie: 'sid=ok' } }, { fetchImpl })
  assert.equal(seen.length, 2)
  assert.ok(seen.every((c) => c.includes('sid=ok')), '两条请求都必须带 Cookie: ' + JSON.stringify(seen))
})

test('listArticles：ret=200002 抛 InvalidFakeidError（instanceof）', async () => {
  const fetchImpl = async () => ({ status: 200, text: INVALID_FAKEID_JSON, headers: new Headers() })
  await assert.rejects(
    listArticles({ fakeid: 'BAD' }, { fetchImpl, credentials: { token: 'T', cookie: 'c' } }),
    (e) => e instanceof InvalidFakeidError)
})

test('requestWechat：缺 fetchImpl 报中文错误；可携带 Cookie 与 UA', async () => {
  await assert.rejects(requestWechat('/x', {}, {}), /fetchImpl/)
  let headers = null
  const fetchImpl = async (_url, init) => {
    headers = init.headers
    return { status: 200, text: '{}', headers: new Headers() }
  }
  await requestWechat('/x', { credentials: { cookie: 'a=b' } }, { fetchImpl })
  assert.equal(headers.Cookie, 'a=b')
  assert.match(headers['User-Agent'], /Chrome/)
})

test('accountInfo：返回认证信息', async () => {
  const fetchImpl = async () => ({
    status: 200,
    text: JSON.stringify({ base_resp: { ret: 0 }, identity_name: '测试号', is_verify: 1, original_article_count: 42 }),
    headers: new Headers(),
  })
  const r = await accountInfo({ fakeid: 'M1234567890' }, { fetchImpl, credentials: { token: 'T', cookie: 'c' } })
  assert.equal(r.identityName, '测试号')
  assert.equal(r.isVerify, true)
  assert.equal(r.originalCount, 42)
})

/* ---------------------------------------------------------------- 正文解析 */

test('fetchArticle + parseArticleHtml：标题/作者/时间/图片', async () => {
  const fetchImpl = async () => ({ status: 200, text: ARTICLE_HTML, headers: new Headers() })
  const a = await fetchArticle('https://mp.weixin.qq.com/s/AAA111', { fetchImpl })
  assert.equal(a.title, '测试文章标题')
  assert.equal(a.author, '测试作者')
  assert.equal(a.publishTime, 1750000000)
  assert.deepEqual(a.images, ['https://mmbiz.qpic.cn/img1.jpg'])
  assert.match(a.plainText, /第一段文字/)
  // 残缺页面直接抛中文错误
  const bad = async () => ({ status: 200, text: BROKEN_HTML, headers: new Headers() })
  await assert.rejects(fetchArticle('https://x', { fetchImpl: bad }), /正文容器/)
})

test('parseArticleHtml：js_content 缺失返回 null', () => {
  assert.equal(parseArticleHtml(BROKEN_HTML), null)
})

test('htmlToMarkdown：标题/强调/图片/链接/列表/引用/代码', () => {
  const md = htmlToMarkdown(
    '<h1>标题一</h1><p>正文 <strong>粗</strong> 与 <em>斜</em> 与' +
    '<a href="https://e.com">链</a></p>' +
    '<img data-src="https://i.png" alt="图">' +
    '<ul><li>甲</li><li>乙</li></ul>' +
    '<blockquote>引</blockquote><pre><code>code1</code></pre>')
  assert.match(md, /^# 标题一/)
  assert.match(md, /\*\*粗\*\*/)
  assert.match(md, /\*斜\*/)
  assert.match(md, /\[链\]\(https:\/\/e\.com\)/)
  assert.match(md, /!\[图\]\(https:\/\/i\.png\)/)
  assert.match(md, /- 甲\n- 乙/)
  assert.match(md, /> 引/)
  assert.match(md, /code1/)
  assert.equal(htmlToMarkdown(''), '')
})

/* ---------------------------------------------------------------- store */

test('store（内存兜底）：订阅与增量去重、listArticles 分页、getArticle 现算 Markdown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wxmp-test-'))
  try {
    const store = openStore(dir)
    assert.equal(store.backend, 'memory')
    store.addSubscription({ fakeid: 'M1', nickname: '测试号', alias: 't', headImg: 'h.png' })
    assert.equal(store.listSubscriptions().length, 1)
    const arts = [
      { aid: 'a1', title: '文一', link: 'https://s/1', publishTime: 1750000000 },
      { aid: 'a2', title: '文二', link: 'https://s/2', publishTime: 1749000000 },
    ]
    assert.equal(store.saveArticles('M1', arts), 2)
    assert.equal(store.saveArticles('M1', arts), 0, '重复链接应被去重')
    const page = store.listArticles('M1', { limit: 1 })
    assert.equal(page.articles.length, 1)
    assert.equal(page.articles[0].title, '文一')
    assert.equal(page.nextSince, 1750000000)
    const page2 = store.listArticles('M1', { since: page.nextSince, limit: 1 })
    assert.equal(page2.articles[0].title, '文二')
    const got = store.getArticle(page.articles[0].id)
    assert.equal(got.title, '文一')
    assert.equal(got.sourceUrl, 'https://s/1')
    store.removeSubscription('M1')
    assert.equal(store.listSubscriptions().length, 0)
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ---------------------------------------------------------------- 登录四步（假 fetch） */

function makeLoginFetch() {
  const calls = []
  let step = 0
  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    calls.push(u)
    if (u.includes('action=startlogin')) {
      assert.equal(init.method, 'POST')
      assert.match(init.body, /login_type=3/)
      return ok('<xml>ok</xml>', { 'set-cookie': ['sess=AAA; Path=/'] })
    }
    if (u.includes('action=getqrcode')) {
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
      return {
        status: 200,
        text: () => Promise.resolve('PNGPNG'),
        arrayBuffer: () => Promise.resolve(png.buffer),
        headers: hdr({ 'content-type': 'image/png', 'set-cookie': ['ticket=T1; Path=/'] }),
      }
    }
    if (u.includes('action=ask')) {
      step++
      // 第一次 pending(2)，第二次已扫(4)，第三次成功(1)
      const status = step === 1 ? 2 : step === 2 ? 4 : 1
      return ok(JSON.stringify({ status }), { 'set-cookie': ['more=M' + step + '; Path=/'] })
    }
    if (u.includes('bizlogin') && init.method === 'POST' && !u.includes('startlogin')) {
      return ok(JSON.stringify({ redirect_url: 'https://mp.weixin.qq.com/cgi-bin/home?t=home/index&token=987654&id=1' }),
        { 'set-cookie': ['slave_sid=FINAL; Path=/'] })
    }
    if (u.includes('/cgi-bin/home')) {
      return ok('<script>var nickname = "测试号";nick_name = "测试号";</script>', { 'set-cookie': [] })
    }
    if (u.includes('searchbiz')) {
      return ok(SEARCHBIZ_JSON, { 'set-cookie': [] })
    }
    throw new Error('unexpected url: ' + u)
  }
  return { fetchImpl, calls }
}

function hdr(map) {
  const h = new Headers()
  for (const [k, v] of Object.entries(map)) {
    if (Array.isArray(v)) v.forEach((x) => h.append(k, x))
    else h.set(k, v)
  }
  return h
}
const ok = (text, extra = {}) => ({ status: 200, text, headers: hdr({ 'content-type': 'text/html', ...extra }) })

test('登录四步：startLogin→qrcode→pollScan 三态→落盘凭证（含 fakeid 与 cookie 合并）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wxmp-auth-'))
  try {
    const { fetchImpl, calls } = makeLoginFetch()
    const auth = createAuth({ dataDir: dir, fetchImpl })
    assert.equal(auth.summary().status, 'none')

    const { sessionId } = await auth.startLogin()
    assert.ok(sessionId)
    const qr = await auth.qrcode(sessionId)
    assert.equal(qr.contentType, 'image/png')
    assert.ok(qr.body.byteLength > 0)

    assert.equal(await auth.pollScan(sessionId), 'pending')
    assert.equal(await auth.pollScan(sessionId), 'scanned')
    assert.equal(await auth.pollScan(sessionId), 'logged_in')

    const credPath = join(dir, '.credentials.json')
    assert.ok(existsSync(credPath))
    const cred = JSON.parse(readFileSync(credPath, 'utf8'))
    assert.equal(cred.token, '987654')
    // cookie 应同时含 startlogin 种的、二维码响应的与 login 响应的
    for (const k of ['sess', 'ticket', 'more', 'slave_sid']) {
      assert.ok(cred.cookie.includes(k + '='), 'cookie 缺少 ' + k)
    }
    assert.equal(cred.fakeid, 'M1234567890')
    assert.equal(cred.nickname, '测试号')
    assert.ok(cred.expireAtMs > Date.now() + 3 * 24 * 3600 * 1000)

    const s = auth.summary()
    assert.equal(s.status, 'logged_in')
    assert.equal(s.nickname, '测试号')
    assert.equal(s.expireAt, Math.floor(cred.expireAtMs / 1000))
    assert.equal(auth.isExpired(), false)
    const c = auth.getCredentials()
    assert.equal(c.token, '987654')
    assert.ok(c.cookie.includes('sess=AAA'))

    auth.logout()
    assert.ok(!existsSync(credPath))
    assert.equal(auth.summary().status, 'none')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
