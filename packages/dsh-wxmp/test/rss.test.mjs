/**
 * RSS 功能单测：generateRss XML 结构与转义、pollSubscriptions 增量抓取（依赖注入假实现）、
 * index.js 路由（RSS XML / 404 / 轮询 pause-resume / 工具注册）。
 * 运行：node --test test/*.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateRss } from '../lib/rss.js'
import { pollSubscriptions } from '../lib/poll.js'
import { LoginExpiredError, InvalidFakeidError } from '../lib/wechat.js'
import { openStore } from '../lib/store.js'
import { apply } from '../index.js'

const mkStore = () => {
  const dir = mkdtempSync(join(tmpdir(), 'wxmp-rss-'))
  return { dir, store: openStore(dir) }
}

/* ---------------------------------------------------------------- generateRss */

test('generateRss：RSS 2.0 基本结构（channel/item/atom:link self）', () => {
  const xml = generateRss({
    subscriptions: { fakeid: 'M123', nickname: '测试号', alias: 'test', headImg: 'https://img/avatar.jpg' },
    articles: [
      { id: 1, title: '第一篇', link: 'https://mp.weixin.qq.com/s/A1', digest: '摘要内容', cover: 'https://img/cover.jpg', author: '作者甲', publishTime: 1700000000, content: '# 正文' },
    ],
    siteUrl: 'https://example.com',
    buildTime: 1700000100,
  })
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/)
  assert.match(xml, /<rss version="2\.0" xmlns:atom="http:\/\/www\.w3\.org\/2005\/Atom">/)
  assert.match(xml, /<channel>/)
  assert.match(xml, /<title>测试号<\/title>/)
  assert.match(xml, /<link>https:\/\/mp\.weixin\.qq\.com<\/link>/)
  assert.match(xml, /<language>zh-CN<\/language>/)
  assert.match(xml, /<atom:link href="https:\/\/example\.com\/api\/plugins\/wxmp\/rss\/M123\.xml" rel="self" type="application\/rss\+xml"\/>/)
  assert.match(xml, /<lastBuildDate>[^<]+GMT<\/lastBuildDate>/)
  assert.match(xml, /<image>/)
  assert.match(xml, /<url>https:\/\/img\/avatar\.jpg<\/url>/)
  assert.match(xml, /<item>/)
  assert.match(xml, /<title>第一篇<\/title>/)
  assert.match(xml, /<link>https:\/\/mp\.weixin\.qq\.com\/s\/A1<\/link>/)
  assert.match(xml, /<guid isPermaLink="true">https:\/\/mp\.weixin\.qq\.com\/s\/A1<\/guid>/)
  assert.match(xml, /<pubDate>[^<]+GMT<\/pubDate>/)
  assert.match(xml, /<author>作者甲<\/author>/)
  assert.match(xml, /<description>[^]*<\/description>/)
  assert.ok(xml.endsWith('</rss>\n'))
})

test('generateRss：XML 转义（& < > " \' 与正文中的标签）', () => {
  const xml = generateRss({
    subscriptions: { fakeid: 'M&1', nickname: '测试<&>"号' },
    articles: [{ title: 'A<&>B "quoted" \'x\'', link: 'https://mp.weixin.qq.com/s/x?y=1&z=2', digest: '<script>alert(1)</script>', publishTime: 0 }],
    siteUrl: 'https://example.com',
    buildTime: 1700000100,
  })
  assert.doesNotMatch(xml, /<script>/)
  assert.match(xml, /&lt;script&gt;/)
  assert.match(xml, /&amp;/)
  // 原始裸引号（属性值内）不应出现
  assert.ok(xml.includes('A&lt;&amp;&gt;B &quot;quoted&quot; &#39;x&#39;'))
})

test('generateRss：无文章输出空 channel，不抛错', () => {
  const xml = generateRss({ subscriptions: { fakeid: 'M1', nickname: '空' }, articles: [], siteUrl: 'https://e.com', buildTime: 1 })
  assert.match(xml, /<channel>[^]*<\/channel>/)
  assert.doesNotMatch(xml, /<item>/)
})

/* ---------------------------------------------------------------- pollSubscriptions */

test('pollSubscriptions：增量抓取入库、正文补全、touchSubscription、限频 sleep', async () => {
  const { store } = mkStore()
  store.addSubscription({ fakeid: 'M1', nickname: '一号' })
  store.addSubscription({ fakeid: 'M2', nickname: '二号' })
  const sleeps = []
  const wx = {
    async listArticles({ fakeid }) {
      return {
        articles: [
          { aid: fakeid + '-1', title: fakeid + ' 文章', link: 'https://mp.weixin.qq.com/s/' + fakeid + '1', publishTime: 1700000000 },
        ],
      }
    },
    async fetchArticle() {
      return { contentHtml: '<p>正文</p>', publishTime: 1700000050 }
    },
    htmlToMarkdown: (html) => html.replace(/<\/?p>/g, '').trim(),
  }
  const auth = { getCredentials: () => ({ token: 'T', cookie: 'c' }) }
  const result = await pollSubscriptions({}, { store, auth, wx, sleep: async (ms) => { sleeps.push(ms) } })
  assert.equal(result.added, 2)
  assert.equal(result.failed.length, 0)
  assert.equal(result.loginExpired, false)
  assert.equal(result.polled, 2)
  assert.deepEqual(sleeps, [3000]) // 两个订阅中间 sleep 一次
  const { articles } = store.listArticles('M1', { limit: 10 })
  assert.equal(articles.length, 1)
  assert.equal(articles[0].publishTime, 1700000050)
  // content 不在 listArticles 输出里，用 getArticle 验证入库的正文
  const detail = store.getArticle(articles[0].id)
  assert.equal(detail.markdown, '正文')
  const subs = store.listSubscriptions()
  assert.ok(subs.every((s) => Number(s.lastPoll) > 0))
  store.close()
})

test('pollSubscriptions：重复抓取不重复入库（去重）', async () => {
  const { store } = mkStore()
  store.addSubscription({ fakeid: 'M1', nickname: '一号' })
  const wx = {
    async listArticles() {
      return { articles: [{ aid: 'a1', title: 'T', link: 'https://mp.weixin.qq.com/s/dup', publishTime: 1700000000 }] }
    },
    async fetchArticle() { return { contentHtml: '', publishTime: 0 } },
    htmlToMarkdown: (h) => h,
  }
  const auth = { getCredentials: () => ({ token: 'T', cookie: 'c' }) }
  const opts = { store, auth, wx, sleep: async () => {} }
  const r1 = await pollSubscriptions({}, opts)
  const r2 = await pollSubscriptions({}, opts)
  assert.equal(r1.added, 1)
  assert.equal(r2.added, 0)
  store.close()
})

test('pollSubscriptions：未登录跳过并返回 loginExpired', async () => {
  const { store } = mkStore()
  store.addSubscription({ fakeid: 'M1', nickname: '一号' })
  let called = 0
  const wx = { listArticles: async () => { called += 1; return { articles: [] } } }
  const auth = { getCredentials: () => { throw new Error('尚未登录微信公众平台') } }
  const result = await pollSubscriptions({}, { store, auth, wx })
  assert.equal(result.loginExpired, true)
  assert.equal(result.added, 0)
  assert.equal(called, 0)
  store.close()
})

test('pollSubscriptions：LoginExpiredError 清理凭证并停止；InvalidFakeidError 移除订阅', async () => {
  const { store } = mkStore()
  store.addSubscription({ fakeid: 'M1', nickname: '一号' })
  store.addSubscription({ fakeid: 'M2', nickname: '二号' })
  let loggedOut = 0
  const wx = {
    async listArticles({ fakeid }) {
      if (fakeid === 'M1') throw new InvalidFakeidError('invalid fakeid')
      throw new LoginExpiredError('登录已过期')
    },
    async fetchArticle() { return {} },
    htmlToMarkdown: (h) => h,
  }
  const auth = { getCredentials: () => ({ token: 'T', cookie: 'c' }), logout: () => { loggedOut += 1 } }
  const result = await pollSubscriptions({}, { store, auth, wx, sleep: async () => {} })
  // M1 失效被移除；M2 登录过期触发 logout 并停止
  assert.equal(result.failed.length, 2)
  assert.equal(loggedOut, 1)
  assert.equal(result.loginExpired, true)
  const subs = store.listSubscriptions()
  assert.equal(subs.length, 1)
  assert.equal(subs[0].fakeid, 'M2')
  store.close()
})

test('pollSubscriptions：普通错误计入 failed 继续下一个', async () => {
  const { store } = mkStore()
  store.addSubscription({ fakeid: 'M1', nickname: '一号' })
  store.addSubscription({ fakeid: 'M2', nickname: '二号' })
  const wx = {
    async listArticles({ fakeid }) {
      if (fakeid === 'M1') throw new Error('网络抖动')
      return { articles: [{ aid: 'a', title: 'T', link: 'https://mp.weixin.qq.com/s/ok', publishTime: 1 }] }
    },
    async fetchArticle() { return {} },
    htmlToMarkdown: (h) => h,
  }
  const auth = { getCredentials: () => ({ token: 'T', cookie: 'c' }) }
  const result = await pollSubscriptions({}, { store, auth, wx, sleep: async () => {} })
  assert.equal(result.added, 1)
  assert.equal(result.failed.length, 1)
  assert.equal(result.failed[0].fakeid, 'M1')
  store.close()
})

/* ---------------------------------------------------------------- index.js 集成 */

/** 假 webServer + 假 tools + 最小 ctx（无 timer / 无 inject）。 */
function makeHarness() {
  const routes = new Map()
  const tools = new Map()
  const effects = []
  const webServer = {
    register(spec) {
      routes.set(spec.path, spec.resource)
      return () => routes.delete(spec.path)
    },
  }
  const ctx = {
    get: (name) => (name === 'webServer' ? webServer : undefined),
    tools: { register: (t) => { tools.set(t.name, t); return () => tools.delete(t.name) } },
    effect: (fn) => { effects.push(fn) },
    logger: { warn: () => {}, debug: () => {} },
  }
  return { ctx, routes, tools, effects, dispose: () => { for (const fn of effects) fn() } }
}

const fetchOk = async () => ({ status: 200, text: '{}', headers: new Headers() })

test('index.js：RSS 路由返回 XML；未订阅 fakeid 返回 404', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wxmp-rss-idx-'))
  // 预置有效凭证（auth 从 dataDir/.credentials.json 读取）
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ token: 'T', cookie: 'c=1', fakeid: 'M999', nickname: '集成号', expireAtMs: Date.now() + 3600_000 }))
  const appmsgpublishJson = JSON.stringify({
    base_resp: { ret: 0 },
    publish_page: JSON.stringify({
      publish_list: [
        { publish_info: JSON.stringify({ appmsgex: [{ aid: 'x', title: '标题<&>', link: 'https://mp.weixin.qq.com/s/999', update_time: 1700000000, create_time: 1700000000, digest: 'D' }] }) },
      ],
    }),
  })
  const fetchImpl = async () => ({ status: 200, text: appmsgpublishJson, headers: new Headers() })

  const h = makeHarness()
  apply(h.ctx, { dataDir: dir, fetch: fetchImpl, pollIntervalMs: 0, articleIntervalMs: 0 })
  try {
    const rssRoute = h.routes.get('/api/plugins/wxmp/rss/')
    assert.ok(rssRoute, 'prefix 路由已注册')
    const res404 = await rssRoute(new Request('https://h.test/api/plugins/wxmp/rss/NOPE.xml'))
    assert.equal(res404.status, 404)
    assert.equal(JSON.parse(await res404.text()).error, '未订阅该公众号：NOPE')
    // 订阅 + 手动轮询拉文章入库（走插件自己的 store 实例）
    await h.tools.get('wxmp_subscribe').execute({ fakeid: 'M999', nickname: '集成号' }, {})
    const polled = JSON.parse(await h.tools.get('wxmp_poll').execute({}, {}))
    assert.equal(polled.added, 1)
    const res = await rssRoute(new Request('https://h.test/api/plugins/wxmp/rss/M999.xml'))
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /application\/rss\+xml/)
    const xml = await res.text()
    assert.match(xml, /<title>标题&lt;&amp;&gt;<\/title>/)
    assert.match(xml, /<atom:link href="https:\/\/h\.test\/api\/plugins\/wxmp\/rss\/M999\.xml"/)
  } finally {
    h.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('index.js：rss/poll?_method=pause|resume 控制轮询状态', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wxmp-rss-idx2-'))
  const h = makeHarness()
  apply(h.ctx, { dataDir: dir, fetch: fetchOk, pollIntervalMs: 0 })
  try {
    const pollRoute = h.routes.get('/api/plugins/wxmp/rss/')
    assert.ok(pollRoute)
    const mkReq = (m) => new Request('https://h.test/api/plugins/wxmp/rss/poll?_method=' + m)
    // 未登录：手动触发返回 loginExpired，不 500
    const r0 = await pollRoute(mkReq('post'))
    assert.equal(r0.status, 200)
    const j0 = await r0.json()
    assert.equal(j0.ok, true)
    const paused = await (await pollRoute(mkReq('pause'))).json()
    assert.equal(paused.paused, true)
    const resumed = await (await pollRoute(mkReq('resume'))).json()
    assert.equal(resumed.paused, false)
    const bad = await pollRoute(new Request('https://h.test/api/plugins/wxmp/rss/poll?_method=wrong'))
    assert.equal(bad.status, 400)
  } finally {
    h.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('index.js：wxmp_get_rss_url 工具返回链接与轮询状态', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wxmp-rss-idx3-'))
  const h = makeHarness()
  apply(h.ctx, { dataDir: dir, fetch: fetchOk, pollIntervalMs: 0 })
  try {
    await h.tools.get('wxmp_subscribe').execute({ fakeid: 'M42', nickname: '状态号' }, {})
    const out = JSON.parse(await h.tools.get('wxmp_get_rss_url').execute({}, {}))
    assert.equal(out.paused, false)
    assert.equal(out.pollIntervalMs, 0)
    assert.equal(out.subscriptions.length, 1)
    assert.equal(out.subscriptions[0].rssPath, '/api/plugins/wxmp/rss/M42.xml')
    const one = JSON.parse(await h.tools.get('wxmp_get_rss_url').execute({ fakeid: 'M42' }, {}))
    assert.equal(one.rssPath, '/api/plugins/wxmp/rss/M42.xml')
    await assert.rejects(
      h.tools.get('wxmp_get_rss_url').execute({ fakeid: 'NOPE' }, {}),
      (e) => e instanceof Error && /未订阅/.test(e.message))
  } finally {
    h.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('index.js：无 timer 服务的测试 ctx 不注册定时器且不报错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wxmp-rss-idx4-'))
  const h = makeHarness()
  let warned = 0
  h.ctx.logger = { warn: () => { warned += 1 }, debug: () => {} }
  apply(h.ctx, { dataDir: dir, fetch: fetchOk, pollIntervalMs: 60000 })
  try {
    // 到这里没抛错即通过；wxmp_poll 工具应已注册
    assert.ok(h.tools.has('wxmp_poll'))
    assert.equal(warned, 0)
  } finally {
    h.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
