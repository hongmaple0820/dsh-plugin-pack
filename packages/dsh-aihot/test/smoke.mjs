/**
 * @local/dsh-aihot 冒烟测试：只测 lib/aihot.js 的纯逻辑，用假 fetch，不联网。
 *
 * 跑法：node packages/dsh-aihot/test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { apply as applyHost } from '../index.js'
import { agentPages, freeTokensHtml, leaderboardHtml, resetCalendarHtml } from './fixtures/pages.js'
import {
  MARKDOWN_UA,
  JSON_UA,
  ARTICLE_MAX_BYTES,
  buildUrl,
  clearCache,
  extractArticle,
  parseJson,
  requestJson,
  requestMarkdown,
  truncateBytes,
} from '../lib/aihot.js'

let passed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL ${name}\n     ${error?.message || error}`)
  }
}

const ok = (text) => new Response(text, { status: 200, headers: { 'content-type': 'text/markdown' } })
const okJson = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
const status = (code, headers = {}, body = '') => new Response(body, { status: code, headers })
const okHtml = (text) => new Response(text, { status: 200, headers: { 'content-type': 'text/html' } })

/** 按调用序号返回预设响应，并记录每次调用。 */
function scripted(responders) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    const responder = responders[Math.min(calls.length - 1, responders.length - 1)]
    return responder(url, init, calls.length)
  }
  return { fetchImpl, calls }
}

const sleepRecorder = () => {
  const waits = []
  return { waits, sleep: async (ms) => { waits.push(ms) } }
}

const params = (url) => new URL(url)

/* ------------------------------------------------------------ URL 构造 */

await test('latest：默认 window/mode/limit', () => {
  const url = params(buildUrl('latest'))
  assert.equal(url.origin, 'https://aihot.news')
  assert.equal(url.pathname, '/api/v1/agent/latest')
  assert.equal(url.searchParams.get('window'), '24h')
  assert.equal(url.searchParams.get('mode'), 'selected')
  assert.equal(url.searchParams.get('limit'), '10')
  assert.equal(url.searchParams.has('category'), false)
})

await test('latest：window/category/mode/limit 全部透传', () => {
  const url = params(buildUrl('latest', { window: '7d', category: 'paper', mode: 'all', limit: 5 }))
  assert.equal(url.pathname, '/api/v1/agent/latest')
  assert.equal(url.searchParams.get('window'), '7d')
  assert.equal(url.searchParams.get('category'), 'paper')
  assert.equal(url.searchParams.get('mode'), 'all')
  assert.equal(url.searchParams.get('limit'), '5')
})

await test('latest：非法 window / limit 抛错', () => {
  assert.throws(() => buildUrl('latest', { window: '30d' }), /window/)
  assert.throws(() => buildUrl('latest', { limit: 31 }), /limit/)
  assert.throws(() => buildUrl('latest', { limit: 0 }), /limit/)
  assert.throws(() => buildUrl('latest', { category: 'sports' }), /category/)
})

await test('search：中文关键词 URL 编码 + 默认 window=7d', () => {
  const raw = buildUrl('search', { q: 'Gemini 4 发布' })
  const url = params(raw)
  assert.equal(url.pathname, '/api/v1/agent/search')
  assert.equal(url.searchParams.get('q'), 'Gemini 4 发布')
  assert.equal(url.searchParams.get('window'), '7d')
  assert.equal(url.searchParams.get('limit'), '10')
  assert.ok(raw.includes('q=Gemini+4+%E5%8F%91%E5%B8%83'), `原始 URL 应带编码后的 q：${raw}`)
})

await test('search：q 必填且有长度下限', () => {
  assert.throws(() => buildUrl('search', {}), /q/)
  assert.throws(() => buildUrl('search', { q: 'a' }), /q/)
  assert.throws(() => buildUrl('search', { q: 'x'.repeat(201) }), /q/)
})

await test('hot：limit 上限 10', () => {
  const url = params(buildUrl('hot', { limit: 3 }))
  assert.equal(url.pathname, '/api/v1/agent/hot')
  assert.equal(url.searchParams.get('limit'), '3')
  assert.throws(() => buildUrl('hot', { limit: 11 }), /limit/)
})

await test('daily：最新一期与指定日期', () => {
  assert.equal(params(buildUrl('daily')).pathname, '/api/v1/agent/daily')
  assert.equal(params(buildUrl('daily', { date: '2026-11-12' })).pathname, '/api/v1/agent/daily/2026-11-12')
  assert.throws(() => buildUrl('daily', { date: '2026/11/12' }), /YYYY-MM-DD/)
})

await test('weekly / monthly：最新一期与指定期号', () => {
  assert.equal(params(buildUrl('weekly')).pathname, '/api/v1/agent/weekly')
  assert.equal(params(buildUrl('weekly', { week: '2026-W39' })).pathname, '/api/v1/agent/weekly/2026-W39')
  assert.throws(() => buildUrl('weekly', { week: '2026-39' }), /周标签/)
  assert.equal(params(buildUrl('monthly')).pathname, '/api/v1/agent/monthly')
  assert.equal(params(buildUrl('monthly', { month: '2026-09' })).pathname, '/api/v1/agent/monthly/2026-09')
  assert.throws(() => buildUrl('monthly', { month: '2026-9' }), /月份/)
})

await test('resets：四个服务各自映射，缺 service 抛错', () => {
  for (const service of ['codex', 'antigravity', 'claude', 'grok-bot']) {
    assert.equal(params(buildUrl('resets', { service })).pathname, `/api/v1/agent/${service}-resets`)
  }
  assert.throws(() => buildUrl('resets', {}), /service/)
  assert.throws(() => buildUrl('resets', { service: 'copilot' }), /service/)
})

await test('story：publicId 进路径，limit 默认 20', () => {
  const url = params(buildUrl('story', { publicId: 'd01448e7-e6ef-4224-9e13-5f4b350dd6ed' }))
  assert.equal(url.pathname, '/api/v1/agent/stories/d01448e7-e6ef-4224-9e13-5f4b350dd6ed')
  assert.equal(url.searchParams.get('limit'), '20')
  assert.throws(() => buildUrl('story', { publicId: 'a'.repeat(129) }), /publicId/)
  assert.throws(() => buildUrl('story', { publicId: 'bad/id' }), /publicId/)
})

await test('items（页面 JSON）：默认值与过滤', () => {
  const base = params(buildUrl('items'))
  assert.equal(base.pathname, '/api/v1/items')
  assert.equal(base.searchParams.get('window'), '7d')
  assert.equal(base.searchParams.get('mode'), 'selected')
  assert.equal(base.searchParams.get('limit'), '50')
  const filtered = params(buildUrl('items', { window: '24h', category: 'ai-models', mode: 'all', limit: 12 }))
  assert.equal(filtered.searchParams.get('window'), '24h')
  assert.equal(filtered.searchParams.get('category'), 'ai-models')
  assert.equal(filtered.searchParams.get('mode'), 'all')
  assert.equal(filtered.searchParams.get('limit'), '12')
  assert.throws(() => buildUrl('items', { limit: 101 }), /limit/)
})

await test('hot-topics / daily-report / 未知 kind', () => {
  assert.equal(params(buildUrl('hot-topics')).pathname, '/api/v1/hot-topics')
  assert.equal(params(buildUrl('daily-report')).pathname, '/api/v1/dailies/latest')
  assert.throws(() => buildUrl('nope'), /未知/)
})

await test('resets-json（福利 tab）：默认 recent，scope=all 取完整历史', () => {
  for (const service of ['codex', 'antigravity', 'claude', 'grok-bot']) {
    assert.equal(params(buildUrl('resets-json', { service })).pathname, `/api/v1/${service}-resets/recent`)
    assert.equal(params(buildUrl('resets-json', { service, scope: 'all' })).pathname, `/api/v1/${service}-resets`)
    assert.equal(params(buildUrl('resets-json', { service, scope: 'recent' })).pathname, `/api/v1/${service}-resets/recent`)
  }
  assert.throws(() => buildUrl('resets-json', {}), /service/)
  assert.throws(() => buildUrl('resets-json', { service: 'copilot' }), /service/)
  assert.throws(() => buildUrl('resets-json', { service: 'codex', scope: '90d' }), /scope/)
})

await test('story-json：publicId 进路径，且绝不带 limit（上游不接受）', () => {
  const url = params(buildUrl('story-json', { publicId: 'd01448e7-e6ef-4224-9e13-5f4b350dd6ed' }))
  assert.equal(url.pathname, '/api/v1/stories/d01448e7-e6ef-4224-9e13-5f4b350dd6ed')
  assert.equal(url.searchParams.has('limit'), false)
  assert.throws(() => buildUrl('story-json', { publicId: 'bad/id' }), /publicId|id/)
  assert.throws(() => buildUrl('story-json', {}), /publicId|id/)
})

/* ------------------------------------------------------------ 请求与解析 */

await test('requestMarkdown：UA/Accept 正确，Markdown 原样透传', async () => {
  const markdown = '# AIHOT 精选 · 过去 24 小时\n\n1. [标题](https://aihot.news/items/abc)\n'
  const fake = scripted([() => ok(markdown)])
  const url = buildUrl('latest', { limit: 1 })
  const text = await requestMarkdown(url, { fetchImpl: fake.fetchImpl })
  assert.equal(text, markdown)
  assert.equal(fake.calls.length, 1)
  assert.equal(fake.calls[0].url, url)
  assert.equal(fake.calls[0].init.method, 'GET')
  assert.equal(fake.calls[0].init.headers['user-agent'], MARKDOWN_UA)
  assert.match(fake.calls[0].init.headers.accept, /text\/markdown/)
})

await test('requestJson：UA 为 aihot-api，返回解析后的对象', async () => {
  const fake = scripted([() => okJson({ schemaVersion: 1, count: 1, items: [{ id: 'x' }] })])
  const data = await requestJson(buildUrl('hot-topics'), { fetchImpl: fake.fetchImpl })
  assert.equal(fake.calls[0].init.headers['user-agent'], JSON_UA)
  assert.equal(data.count, 1)
  assert.equal(data.items[0].id, 'x')
})

await test('parseJson：非法 JSON 与空响应都抛中文错误', () => {
  assert.throws(() => parseJson('not json'), /不是合法 JSON/)
  assert.throws(() => parseJson('   '), /空响应/)
})

await test('requestJson：空正文抛错', async () => {
  const fake = scripted([() => new Response('', { status: 200 })])
  await assert.rejects(() => requestJson(buildUrl('hot-topics'), { fetchImpl: fake.fetchImpl }), /空响应/)
})

/* ------------------------------------------------------------ 429 / 5xx / 超时 */

await test('429：读 Retry-After 等待后重试一次并成功', async () => {
  const recorder = sleepRecorder()
  const fake = scripted([
    () => status(429, { 'retry-after': '2' }),
    () => ok('# 重试成功\n'),
  ])
  const text = await requestMarkdown('https://aihot.news/api/v1/agent/latest', {
    fetchImpl: fake.fetchImpl,
    sleep: recorder.sleep,
  })
  assert.equal(text, '# 重试成功\n')
  assert.equal(fake.calls.length, 2)
  assert.deepEqual(recorder.waits, [2000])
})

await test('429：Retry-After 最多等 5s', async () => {
  const recorder = sleepRecorder()
  const fake = scripted([() => status(429, { 'retry-after': '30' }), () => ok('# ok\n')])
  await requestMarkdown('https://aihot.news/api/v1/agent/latest', { fetchImpl: fake.fetchImpl, sleep: recorder.sleep })
  assert.deepEqual(recorder.waits, [5000])
})

await test('429 连续两次：抛限流错误，且不再重试', async () => {
  const recorder = sleepRecorder()
  const fake = scripted([() => status(429, { 'retry-after': '1' }), () => status(429, { 'retry-after': '1' })])
  await assert.rejects(
    () => requestMarkdown('https://aihot.news/api/v1/agent/latest', { fetchImpl: fake.fetchImpl, sleep: recorder.sleep }),
    /限流（429）/,
  )
  assert.equal(fake.calls.length, 2)
})

await test('5xx：重试一次成功', async () => {
  const recorder = sleepRecorder()
  const fake = scripted([() => status(503), () => ok('# 好了\n')])
  const text = await requestMarkdown('https://aihot.news/api/v1/agent/hot', { fetchImpl: fake.fetchImpl, sleep: recorder.sleep })
  assert.equal(text, '# 好了\n')
  assert.equal(fake.calls.length, 2)
})

await test('5xx 连续两次：抛服务不可用', async () => {
  const recorder = sleepRecorder()
  const fake = scripted([() => status(500), () => status(502)])
  await assert.rejects(
    () => requestMarkdown('https://aihot.news/api/v1/agent/hot', { fetchImpl: fake.fetchImpl, sleep: recorder.sleep }),
    /暂时不可用（HTTP 502）/,
  )
})

await test('4xx：不重试，错误里带上游详情', async () => {
  const fake = scripted([() => status(400, {}, 'bad q')])
  await assert.rejects(
    () => requestJson('https://aihot.news/api/v1/items', { fetchImpl: fake.fetchImpl }),
    /拒绝了请求（HTTP 400）：bad q/,
  )
  assert.equal(fake.calls.length, 1)
})

await test('超时：重试一次后抛超时错误', async () => {
  const recorder = sleepRecorder()
  const timeout = () => {
    const error = new Error('timed out')
    error.name = 'TimeoutError'
    throw error
  }
  const fake = scripted([timeout, timeout])
  await assert.rejects(
    () => requestMarkdown('https://aihot.news/api/v1/agent/latest', { fetchImpl: fake.fetchImpl, sleep: recorder.sleep }),
    /超时（8000ms）/,
  )
  assert.equal(fake.calls.length, 2)
})

await test('调用方 abort：原样抛出、不重试', async () => {
  const controller = new AbortController()
  controller.abort()
  const fake = scripted([() => {
    const error = new Error('aborted')
    error.name = 'AbortError'
    throw error
  }])
  await assert.rejects(
    () => requestMarkdown('https://aihot.news/api/v1/agent/latest', { fetchImpl: fake.fetchImpl, signal: controller.signal }),
    /aborted/,
  )
  assert.equal(fake.calls.length, 1)
})

/* ------------------------------------------------------------ 缓存与截断 */

await test('缓存：TTL 内同一 URL 只发一次请求', async () => {
  clearCache()
  const fake = scripted([() => ok('# cached\n')])
  const url = 'https://aihot.news/api/v1/agent/latest?window=24h'
  await requestMarkdown(url, { fetchImpl: fake.fetchImpl, cacheTtlMs: 60_000 })
  const second = await requestMarkdown(url, { fetchImpl: fake.fetchImpl, cacheTtlMs: 60_000 })
  assert.equal(second, '# cached\n')
  assert.equal(fake.calls.length, 1)
  clearCache()
})

await test('缓存：cacheTtlMs=0 时每次都请求', async () => {
  clearCache()
  const fake = scripted([() => ok('# a\n')])
  const url = 'https://aihot.news/api/v1/agent/hot?limit=1'
  await requestMarkdown(url, { fetchImpl: fake.fetchImpl, cacheTtlMs: 0 })
  await requestMarkdown(url, { fetchImpl: fake.fetchImpl, cacheTtlMs: 0 })
  assert.equal(fake.calls.length, 2)
})

await test('truncateBytes：UTF-8 字节上限 48KB 并留截断提示', () => {
  const short = '简短内容'
  assert.equal(truncateBytes(short), short)

  const long = '每日AI资讯摘要。'.repeat(8000)
  const out = truncateBytes(long, 48 * 1024)
  const bytes = new TextEncoder().encode(out).length
  assert.ok(bytes <= 48 * 1024, `截断后 ${bytes} 字节，应 ≤ 49152`)
  assert.ok(out.endsWith('…（内容过长，已按 48KB 截断；需要更多请缩小 limit 或窗口）'))
  assert.ok(out.length > 1000, '不能截得只剩提示')
})

/* ------------------------------------------------------------ Host 路由：story */

/** 最小假 Host：只实现 index.js apply 用到的 tools.register / get('webServer') / effect。 */
function fakeHost(fetchImpl) {
  const routes = new Map()
  const tools = []
  const ctx = {
    tools: { register(spec) { tools.push(spec); return () => {} } },
    get(name) {
      if (name !== 'webServer') return undefined
      return { register(spec) { routes.set(spec.path, spec); return () => {} } }
    },
    effect(fn) { fn(); return () => {} },
  }
  applyHost(ctx, { fetch: fetchImpl, cacheTtlMs: 0, timeoutMs: 3000 })
  return { routes, tools }
}

const storyRoute = (fetchImpl) => fakeHost(fetchImpl).routes.get('/api/plugins/aihot/story')?.resource
const call = (route, path, init) => route(new Request(`http://127.0.0.1${path}`, { method: 'GET', ...init }))

const storyBody = (id) => ({
  schemaVersion: 1,
  story: {
    publicId: id,
    title: '黄仁勋辞任英伟达CEO并退出董事会',
    status: 'active',
    sourceCount: 22,
    reportCount: 63,
    reports: [
      { id: 'r1', title: '新', publishedAt: '2026-11-13T04:17:00Z' },
      { id: 'r2', title: '中', publishedAt: '2026-11-12T00:00:00Z' },
      { id: 'r3', title: '旧', publishedAt: '2026-11-09T05:26:00Z' },
    ],
    related: [],
  },
})

await test('路由 story?id：200 透传 story，reports 在本地截断（上游无 limit 参数）', async () => {
  const fake = scripted([() => okJson(storyBody('d01448e7-e6ef-4224-9e13-5f4b350dd6ed'))])
  const route = storyRoute(fake.fetchImpl)
  assert.ok(route, 'apply 应注册 /api/plugins/aihot/story')
  const response = await call(route, '/api/plugins/aihot/story?id=d01448e7-e6ef-4224-9e13-5f4b350dd6ed&limit=2')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.story.title, '黄仁勋辞任英伟达CEO并退出董事会')
  assert.equal(body.story.reports.length, 2, 'limit=2 只应返回 2 条')
  assert.equal(body.story.reportCount, 63, '其余字段原样透传')
  assert.equal(fake.calls.length, 1)
  const upstream = params(fake.calls[0].url)
  assert.equal(upstream.pathname, '/api/v1/stories/d01448e7-e6ef-4224-9e13-5f4b350dd6ed')
  assert.equal(upstream.searchParams.has('limit'), false, '禁止把 limit 传给上游（上游会 400）')
  assert.equal(fake.calls[0].init.headers['user-agent'], JSON_UA)
})

await test('路由 story：缺参 / 双参 / id 非法 / item 非法 / limit 越界 → 400 且不打上游', async () => {
  const fake = scripted([() => okJson(storyBody('x'))])
  const route = storyRoute(fake.fetchImpl)
  const cases = [
    '/api/plugins/aihot/story',
    '/api/plugins/aihot/story?id=d01448e7-e6ef-4224-9e13-5f4b350dd6ed&item=cfh0nazzl7eedgttz8n99fza4',
    '/api/plugins/aihot/story?id=bad%2Fid',
    '/api/plugins/aihot/story?item=SHORT',
    '/api/plugins/aihot/story?id=d01448e7-e6ef-4224-9e13-5f4b350dd6ed&limit=99',
  ]
  for (const path of cases) {
    const response = await call(route, path)
    assert.equal(response.status, 400, `${path} 应为 400`)
    const body = await response.json()
    assert.equal(body.ok, false)
    assert.ok(typeof body.error === 'string' && body.error !== '', `${path} 应带中文错误`)
  }
  assert.equal(fake.calls.length, 0, '参数错误不应请求上游')
})

await test('路由 story：非 GET → 405', async () => {
  const fake = scripted([() => okJson(storyBody('x'))])
  const response = await call(storyRoute(fake.fetchImpl), '/api/plugins/aihot/story?id=abc', { method: 'POST' })
  assert.equal(response.status, 405)
  assert.equal(fake.calls.length, 0)
})

await test('路由 story：上游 404 → 404（错误详情透出）', async () => {
  const fake = scripted([
    () =>
      new Response(JSON.stringify({ detail: 'No public story exists for deadbeef', code: 'not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/problem+json' },
      }),
  ])
  const response = await call(storyRoute(fake.fetchImpl), '/api/plugins/aihot/story?id=deadbeef')
  assert.equal(response.status, 404)
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.match(body.error, /404/)
  assert.match(body.error, /No public story exists/)
})

await test('路由 story：上游 5xx（重试一次后）→ 502', async () => {
  const fake = scripted([() => status(503), () => status(503)])
  const response = await call(storyRoute(fake.fetchImpl), '/api/plugins/aihot/story?id=deadbeef')
  assert.equal(response.status, 502)
  assert.equal((await response.json()).ok, false)
  assert.equal(fake.calls.length, 2, '5xx 应重试一次')
})

await test('路由 story?item：条目页 HTML 兜底解析出 publicId → 200 且 resolvedFrom=item', async () => {
  const html = '<html><body><a href="/story/4949c5a4-62ca-4fd1-a6d4-3c0c9fc5384a">来龙去脉</a></body></html>'
  const fake = scripted([
    () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
    () => okJson(storyBody('4949c5a4-62ca-4fd1-a6d4-3c0c9fc5384a')),
  ])
  const response = await call(storyRoute(fake.fetchImpl), '/api/plugins/aihot/story?item=cfh0nazzl7eedgttz8n99fza4')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.resolvedFrom, 'item')
  assert.equal(body.story.publicId, '4949c5a4-62ca-4fd1-a6d4-3c0c9fc5384a')
  assert.equal(params(fake.calls[0].url).pathname, '/items/cfh0nazzl7eedgttz8n99fza4')
  assert.match(fake.calls[0].init.headers.accept, /text\/html/)
  assert.equal(params(fake.calls[1].url).pathname, '/api/v1/stories/4949c5a4-62ca-4fd1-a6d4-3c0c9fc5384a')
})

await test('路由 story?item：条目页里没有 story 链接 → 404', async () => {
  const fake = scripted([() => new Response('<html><body>没有时间线</body></html>', { status: 200 })])
  const response = await call(storyRoute(fake.fetchImpl), '/api/plugins/aihot/story?item=cfh0nazzl7eedgttz8n99fza4')
  assert.equal(response.status, 404)
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.match(body.error, /没有关联的事件时间线/)
})

/* -------------------------------------------------- 正文抽取（纯函数） */

const articleHtml = `<!doctype html><html><head>
<meta property="og:title" content="OG 备用标题">
<meta property="og:description" content="摘要备份">
</head><body>
<nav>导航链接</nav>
<script>window.__DATA__ = 1</script>
<article><div><span class="font-semibold text-ink-2">公众号：腾讯混元</span><span>·</span><time dateTime="2026-11-13T08:32:39.000Z">2026-11-13 16:32</time><span class="empty:hidden">· 2 小时前</span></div>
<h1 data-page-title>腾讯混元发布实时语音模型</h1>
<p>实时语音模型发布在正文里 &amp; 带实体 &#39;q&#39;。</p>
<p>·</p>
<p>正文第二段</p>
<p>正文第三段，够长。</p>
</article></body></html>`

await test('extractArticle：标题 / 来源 / 发布时间 / 正文段落，噪声行丢掉', () => {
  const article = extractArticle(articleHtml)
  assert.equal(article.title, '腾讯混元发布实时语音模型')
  assert.equal(article.source, '公众号：腾讯混元')
  assert.equal(article.publishedAt, '2026-11-13T08:32:39.000Z')
  assert.deepEqual(article.paragraphs, ['实时语音模型发布在正文里 & 带实体 \'q\'。', '正文第二段', '正文第三段，够长。'])
  assert.equal(article.chars, article.paragraphs.join('').length)
  assert.equal(article.truncated, false)
  assert.equal(article.fallback, false)
  assert.ok(!article.paragraphs.some((line) => line.includes('导航链接')), 'nav 不应进正文')
  assert.ok(!article.paragraphs.some((line) => line.includes('__DATA__')), 'script 不应进正文')
  assert.ok(!article.paragraphs.some((line) => line.includes('2 小时前')), '相对时间行应丢掉')
})

await test('extractArticle：超长段落按 2000 字硬切；总文本超 64KB 标记 truncated', () => {
  const long = 'A'.repeat(2600)
  const split = extractArticle(`<article><h1>t</h1><p>${long}</p><p>第二段</p><p>第三段</p></article>`)
  assert.deepEqual(split.paragraphs.map((p) => p.length), [2000, 600, 3, 3])

  const big = Array.from({ length: 8 }, (_, index) => '<p>' + String(index) + 'B'.repeat(9000) + '</p>').join('')
  const capped = extractArticle(`<article><h1>t</h1>${big}</article>`)
  assert.equal(capped.truncated, true, '超过 64KB 应标记 truncated')
  assert.ok(capped.chars <= ARTICLE_MAX_BYTES, 'chars 不应超过 64KB 上限')
  assert.ok(capped.paragraphs.length < 40, '截断后段落数应少于完整正文')
})

await test('extractArticle：没有 <p> 的页面退回块级解析并标记 fallback；空页面给空数组', () => {
  const fallback = extractArticle('<article><h1>标题</h1><div>第一段</div><div>第二段内容</div><div>第三段内容</div></article>')
  assert.equal(fallback.fallback, true)
  assert.ok(fallback.paragraphs.length >= 3)

  const empty = extractArticle('<html><body></body></html>')
  assert.deepEqual(empty.paragraphs, [])
  assert.equal(empty.chars, 0)
})

/* -------------------------------------------------- Host 路由：article */

const articleRoute = (fetchImpl) => fakeHost(fetchImpl).routes.get('/api/plugins/aihot/article')?.resource

await test('路由 article?id：200 抽正文，上游 URL 与 UA 正确', async () => {
  const fake = scripted([() => okHtml(articleHtml)])
  const route = articleRoute(fake.fetchImpl)
  assert.ok(route, 'apply 应注册 /api/plugins/aihot/article')
  const response = await call(route, '/api/plugins/aihot/article?id=qp41q77z9ge5hsyrh9kra0c7k')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.item.id, 'qp41q77z9ge5hsyrh9kra0c7k')
  assert.equal(body.item.title, '腾讯混元发布实时语音模型')
  assert.equal(body.item.url, 'https://aihot.news/items/qp41q77z9ge5hsyrh9kra0c7k')
  assert.equal(body.item.source, '公众号：腾讯混元')
  assert.equal(body.item.publishedAt, '2026-11-13T08:32:39.000Z')
  assert.equal(body.item.paragraphs.length, 3)
  assert.equal(body.item.chars, body.item.paragraphs.join('').length)
  assert.equal(body.item.truncated, false)
  assert.equal(fake.calls.length, 1)
  const upstream = params(fake.calls[0].url)
  assert.equal(upstream.pathname, '/items/qp41q77z9ge5hsyrh9kra0c7k')
  assert.equal(fake.calls[0].init.headers['user-agent'], JSON_UA)
  assert.equal(fake.calls[0].init.headers.accept, 'text/html')
})

await test('路由 article：缺 id / id 非法 → 400 且不打上游；非 GET → 405', async () => {
  const fake = scripted([() => okHtml(articleHtml)])
  const route = articleRoute(fake.fetchImpl)
  for (const path of ['/api/plugins/aihot/article', '/api/plugins/aihot/article?id=', '/api/plugins/aihot/article?id=../etc']) {
    const response = await call(route, path)
    assert.equal(response.status, 400, `${path} 应为 400`)
    const body = await response.json()
    assert.equal(body.ok, false)
    assert.ok(typeof body.error === 'string' && body.error !== '')
  }
  assert.equal(fake.calls.length, 0, '参数错误不应请求上游')
  const post = await call(route, '/api/plugins/aihot/article?id=qp41q77z9ge5hsyrh9kra0c7k', { method: 'POST' })
  assert.equal(post.status, 405)
})

await test('路由 article：上游 404 → 404「条目 <id> 不存在」', async () => {
  const fake = scripted([() => status(404, { 'content-type': 'application/problem+json' }, '{"detail":"Not Found","code":"not_found"}')])
  const response = await call(articleRoute(fake.fetchImpl), '/api/plugins/aihot/article?id=zzzzzzzzzzzzzzzzzzzz')
  assert.equal(response.status, 404)
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.match(body.error, /条目 zzzzzzzzzzzzzzzzzzzz 不存在/)
})

await test('路由 article：抓取失败 → 502「抓取条目正文失败」', async () => {
  const fake = scripted([() => { throw new Error('network down') }])
  const response = await call(articleRoute(fake.fetchImpl), '/api/plugins/aihot/article?id=qp41q77z9ge5hsyrh9kra0c7k')
  assert.equal(response.status, 502)
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.match(body.error, /^抓取条目正文失败：/)
  assert.equal(fake.calls.length, 2, '抓取失败重试一次')
})

/* ------------------------------------------------------- Host 路由：period */

const periodRoute = (fetchImpl) => fakeHost(fetchImpl).routes.get('/api/plugins/aihot/period')?.resource

const weekliesBody = () => ({
  schemaVersion: 1,
  count: 2,
  items: [
    { week: '2026-W45', periodStart: '2026-11-02', periodEnd: '2026-11-08', generatedAt: '2026-11-09T02:00:00Z', headline: '本周头条', links: { aihot: 'https://aihot.news/weekly/2026-W45' } },
    { week: '2026-W44', periodStart: '2026-10-26', periodEnd: '2026-11-01', generatedAt: '2026-11-02T02:00:00Z', headline: '上周头条', links: { aihot: 'https://aihot.news/weekly/2026-W44' } },
  ],
})

const weeklyReportBody = () => ({
  schemaVersion: 1,
  report: {
    week: '2026-W44',
    periodStart: '2026-10-26',
    periodEnd: '2026-11-01',
    generatedAt: '2026-11-02T02:00:00Z',
    windowStart: '2026-10-26T00:00:00Z',
    windowEnd: '2026-11-01T15:59:59Z',
    links: { aihot: 'https://aihot.news/weekly/2026-W44' },
    headline: '上周头条',
    overview: '一段时间的主线概述。',
    sections: [{ label: '模型', summary: null, items: [{ title: '某模型发布', summary: '摘要', source: { name: '公众号：示例' }, links: { aihot: 'https://aihot.news/i/1' }, publishedAt: '2026-10-30T02:00:00Z' }] }],
  },
})

await test('路由 period：apply 应注册 /period；kind=weekly 索引透传 items，默认 limit=12', async () => {
  const fake = scripted([() => okJson(weekliesBody())])
  const route = periodRoute(fake.fetchImpl)
  assert.ok(route, 'apply 应注册 /api/plugins/aihot/period')
  const response = await call(route, '/api/plugins/aihot/period?kind=weekly')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.kind, 'weekly')
  assert.equal(body.count, 2)
  assert.equal(body.items.length, 2)
  assert.equal(body.items[0].week, '2026-W45')
  const upstream = params(fake.calls[0].url)
  assert.equal(upstream.pathname, '/api/v1/weeklies')
  assert.equal(upstream.searchParams.get('limit'), '12', '默认 limit=12')
  assert.equal(fake.calls[0].init.headers['user-agent'], JSON_UA)
})

await test('路由 period：kind=monthly 索引走 /monthlies，limit 透传', async () => {
  const fake = scripted([() => okJson({ schemaVersion: 1, count: 1, items: [{ month: '2026-10', periodStart: '2026-10-01', periodEnd: '2026-10-31', generatedAt: '2026-11-01T02:30:00Z', headline: '十月头条', links: { aihot: 'https://aihot.news/monthly/2026-10' } }] })])
  const response = await call(periodRoute(fake.fetchImpl), '/api/plugins/aihot/period?kind=monthly&limit=3')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.kind, 'monthly')
  assert.equal(body.items[0].month, '2026-10')
  const upstream = params(fake.calls[0].url)
  assert.equal(upstream.pathname, '/api/v1/monthlies')
  assert.equal(upstream.searchParams.get('limit'), '3')
})

await test('路由 period&issue：weekly 单期走 /weeklies/{week} 并透传 report', async () => {
  const fake = scripted([() => okJson(weeklyReportBody())])
  const response = await call(periodRoute(fake.fetchImpl), '/api/plugins/aihot/period?kind=weekly&issue=2026-W44')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.kind, 'weekly')
  assert.equal(body.report.week, '2026-W44')
  assert.equal(body.report.sections[0].items[0].title, '某模型发布')
  const upstream = params(fake.calls[0].url)
  assert.equal(upstream.pathname, '/api/v1/weeklies/2026-W44')
  assert.equal(upstream.searchParams.has('limit'), false, '单期请求不该带 limit')
})

await test('路由 period：kind 缺失/非法、issue 与 kind 不匹配、未知参数、非 GET → 400/405 且不打上游', async () => {
  const fake = scripted([() => okJson(weekliesBody())])
  const route = periodRoute(fake.fetchImpl)
  const bad = [
    '/api/plugins/aihot/period',
    '/api/plugins/aihot/period?kind=daily',
    '/api/plugins/aihot/period?kind=weekly&issue=2026-09',
    '/api/plugins/aihot/period?kind=monthly&issue=2026-W44',
    '/api/plugins/aihot/period?kind=weekly&issue=2026-9',
    '/api/plugins/aihot/period?kind=weekly&limit=99',
    '/api/plugins/aihot/period?kind=weekly&foo=1',
  ]
  for (const path of bad) {
    const response = await call(route, path)
    assert.equal(response.status, 400, `${path} 应为 400`)
    const body = await response.json()
    assert.equal(body.ok, false)
    assert.ok(typeof body.error === 'string' && body.error !== '', `${path} 应带中文错误`)
  }
  const notGet = await call(route, '/api/plugins/aihot/period?kind=weekly', { method: 'POST' })
  assert.equal(notGet.status, 405)
  assert.equal(fake.calls.length, 0, '参数错误不应请求上游')
})

await test('路由 period&issue：上游 404（未知期号）→ 404，其余结构异常 → 502', async () => {
  const notFound = scripted([
    () => new Response(JSON.stringify({ detail: 'No public weekly for 2026-W01', code: 'not_found' }), { status: 404, headers: { 'content-type': 'application/problem+json' } }),
  ])
  const response = await call(periodRoute(notFound.fetchImpl), '/api/plugins/aihot/period?kind=weekly&issue=2026-W01')
  assert.equal(response.status, 404)
  assert.match((await response.json()).error, /No public weekly/)

  const broken = scripted([() => okJson({ schemaVersion: 1 })])
  const second = await call(periodRoute(broken.fetchImpl), '/api/plugins/aihot/period?kind=monthly&issue=2026-09')
  assert.equal(second.status, 502, '缺 report 应算上游结构异常')
})

await test('路由 period&issue：monthly 单期走 /monthlies/{month} 并透传 report', async () => {
  const fake = scripted([() => okJson({
    schemaVersion: 1,
    report: {
      month: '2026-09',
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      generatedAt: '2026-10-01T02:30:00Z',
      windowStart: '2026-09-01T00:00:00Z',
      windowEnd: '2026-09-30T15:59:59Z',
      links: { aihot: 'https://aihot.news/monthly/2026-09' },
      headline: '九月头条',
      overview: '九月主线概述。',
      sections: [],
    },
  })])
  const response = await call(periodRoute(fake.fetchImpl), '/api/plugins/aihot/period?kind=monthly&issue=2026-09')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.kind, 'monthly')
  assert.equal(body.report.month, '2026-09')
  assert.equal(body.report.headline, '九月头条')
  const upstream = params(fake.calls[0].url)
  assert.equal(upstream.pathname, '/api/v1/monthlies/2026-09')
  assert.equal(upstream.searchParams.has('limit'), false, '单期请求不该带 limit')
})

await test('路由 period：参数错误文案精确（kind / 未知参数 / issue 格式）', async () => {
  const fake = scripted([() => okJson(weekliesBody())])
  const route = periodRoute(fake.fetchImpl)

  const missing = await call(route, '/api/plugins/aihot/period')
  assert.equal(missing.status, 400)
  assert.equal((await missing.json()).error, '参数 kind 必须是 weekly 或 monthly')

  const unknown = await call(route, '/api/plugins/aihot/period?kind=weekly&foo=1')
  assert.equal(unknown.status, 400)
  assert.equal((await unknown.json()).error, '不支持的查询参数：foo')

  const mismatch = await call(route, '/api/plugins/aihot/period?kind=weekly&issue=2026-09')
  assert.equal(mismatch.status, 400)
  assert.match((await mismatch.json()).error, /issue 与 kind=weekly 不匹配/)

  const badMonth = await call(route, '/api/plugins/aihot/period?kind=monthly&issue=2026-9')
  assert.equal(badMonth.status, 400)
  assert.match((await badMonth.json()).error, /kind=monthly/)

  assert.equal(fake.calls.length, 0, '参数错误不应请求上游')
})

/* ------------------------------------------------------------ Host 路由：search（v2.0） */

const searchRoute = (fetchImpl) => fakeHost(fetchImpl).routes.get('/api/plugins/aihot/search')?.resource

const searchBody = {
  schemaVersion: 1,
  query: { q: '英伟达', window: '7d', mode: 'selected' },
  items: [
    {
      id: 't86m3q7vdlqmvm2zmx91vps5a',
      title: '黄仁勋辞去英伟达总裁兼CEO',
      summary: '英伟达宣布管理层调整。',
      source: { name: 'X：Rohan Paul', firstParty: false },
      publishedAt: '2026-11-13T06:56:56.000Z',
      links: { aihot: 'https://aihot.news/items/t86m3q7vdlqmvm2zmx91vps5a', original: 'https://x.com/rohanpaul_ai/status/1' },
    },
  ],
  page: { hasMore: false },
}

await test('路由 search：q/window/limit 透传到 /api/v1/items，形状与 /items 一致', async () => {
  const fake = scripted([() => okJson(searchBody)])
  const response = await call(searchRoute(fake.fetchImpl), '/api/plugins/aihot/search?q=%E8%8B%B1%E4%BC%9F%E8%BE%BE&window=24h&limit=5&category=ai-models')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.items.length, 1)
  assert.equal(body.items[0].id, searchBody.items[0].id)
  assert.equal(fake.calls.length, 1)
  const url = params(fake.calls[0].url)
  assert.equal(url.pathname, '/api/v1/items', '搜索直接复用 items 端点')
  assert.equal(url.searchParams.get('q'), '英伟达')
  assert.equal(url.searchParams.get('window'), '24h')
  assert.equal(url.searchParams.get('limit'), '5')
  assert.equal(url.searchParams.get('category'), 'ai-models')
  assert.equal(fake.calls[0].init.headers['user-agent'], JSON_UA)
})

await test('路由 search：q 太短/太长/缺 q、未知参数、非法 window/limit → 400 且不请求上游', async () => {
  const fake = scripted([() => okJson(searchBody)])
  const route = searchRoute(fake.fetchImpl)
  const bad = [
    '/api/plugins/aihot/search',
    '/api/plugins/aihot/search?q=a',
    `/api/plugins/aihot/search?q=${'x'.repeat(201)}`,
    '/api/plugins/aihot/search?q=%E8%8B%B1%E4%BC%9F%E8%BE%BE&window=30d',
    '/api/plugins/aihot/search?q=%E8%8B%B1%E4%BC%9F%E8%BE%BE&limit=99',
    '/api/plugins/aihot/search?q=%E8%8B%B1%E4%BC%9F%E8%BE%BE&foo=1',
  ]
  for (const path of bad) {
    const response = await call(route, path)
    assert.equal(response.status, 400, `${path} 应为 400`)
    assert.equal((await response.json()).ok, false)
  }
  assert.equal((await call(route, '/api/plugins/aihot/search?q=abc', { method: 'POST' })).status, 405)
  assert.equal(fake.calls.length, 0, '参数错误不应请求上游')
})

await test('路由 search：上游 503 → 502', async () => {
  const fake = scripted([() => status(503, {}, 'upstream down')])
  const response = await call(searchRoute(fake.fetchImpl), '/api/plugins/aihot/search?q=%E8%8B%B1%E4%BC%9F%E8%BE%BE')
  assert.equal(response.status, 502)
  assert.equal(fake.calls.length, 2, '5xx 重试一次')
})

/* ---------------------------------------- Host 路由：四页 SSR（v2.0） */

const ssrOf = (fetchImpl, name) => fakeHost(fetchImpl).routes.get(`/api/plugins/aihot/${name}`)?.resource

await test('路由 leaderboard：解析 50 行结构并按 limit 截断', async () => {
  const fake = scripted([() => okHtml(leaderboardHtml)])
  const response = await call(ssrOf(fake.fetchImpl, 'leaderboard'), '/api/plugins/aihot/leaderboard?limit=1')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.rows.length, 1)
  assert.equal(body.total, 1)
  assert.equal(body.rows[0].name, 'Claude Fable 5.2')
  assert.equal(body.rows[0].org, 'Anthropic')
  assert.equal(body.rows[0].score, 80.4)
  assert.equal(body.rows[0].priceInput, '¥53.35')
  assert.equal(body.other.length, 2)
  assert.equal(body.pendingTotal, 2)
  assert.equal(params(fake.calls[0].url).pathname, '/leaderboard')
  assert.equal(fake.calls[0].init.headers.accept, 'text/html')
})

await test('路由 leaderboard：limit 越界 400、POST 405', async () => {
  const fake = scripted([() => okHtml(leaderboardHtml)])
  const route = ssrOf(fake.fetchImpl, 'leaderboard')
  for (const path of ['/api/plugins/aihot/leaderboard?limit=0', '/api/plugins/aihot/leaderboard?limit=61', '/api/plugins/aihot/leaderboard?foo=1']) {
    assert.equal((await call(route, path)).status, 400, `${path} 应为 400`)
  }
  assert.equal((await call(route, '/api/plugins/aihot/leaderboard', { method: 'POST' })).status, 405)
  assert.equal(fake.calls.length, 0)
})

await test('路由 free-tokens：三分区 + 我的卡册', async () => {
  const fake = scripted([() => okHtml(freeTokensHtml)])
  const response = await call(ssrOf(fake.fetchImpl, 'free-tokens'), '/api/plugins/aihot/free-tokens')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(body.sections.map((section) => `${section.title}:${section.items.length}`), ['每天都能领:1', '每月都能领:1', '其他福利:1'])
  const first = body.sections[0].items[0]
  assert.equal(first.title, '豆包电脑版每天签到领 200 额度')
  assert.equal(first.link, 'https://mp.weixin.qq.com/s?__biz=abc&mid=123')
  assert.equal(first.period, '每天')
  assert.equal(first.badge, '200 额度')
  assert.equal(first.validity, '发放后 30 天')
  assert.equal(body.album.total, 57)
  assert.equal(params(fake.calls[0].url).pathname, '/free-tokens')
})

await test('路由 reset-calendar：最近一张卡、当月格子、统计与历史日期', async () => {
  const fake = scripted([() => okHtml(resetCalendarHtml)])
  const response = await call(ssrOf(fake.fetchImpl, 'reset-calendar'), '/api/plugins/aihot/reset-calendar')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.lastCard, '11月13日（按预计时间）')
  assert.equal(body.month, '2026-11')
  assert.equal(body.monthLabel, '2026 年 11 月')
  assert.deepEqual(body.days.map((day) => `${day.date}:${day.services.join('/')}`), ['2026-11-13:发重置卡', '2026-11-12:额度重置'])
  assert.equal(body.days[0].today, true)
  assert.deepEqual(body.stats.map((stat) => `${stat.label}=${stat.value}`), ['重置间隔中位数=2 天', '上次额度重置=10月28日'])
  assert.deepEqual(body.historyDates, ['2026-11-13', '2026-11-12', '2026-11-11', '2026-10-28'])
})

await test('路由 agent-access：四种接入方式、版本 2.0.0、RSS 订阅地址', async () => {
  const fake = scripted(agentPages.map((page) => () => okHtml(page)))
  const response = await call(ssrOf(fake.fetchImpl, 'agent-access'), '/api/plugins/aihot/agent-access')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.version, '2.0.0')
  assert.deepEqual(body.modes.map((mode) => mode.id), ['skill', 'mcp', 'rss', 'api'])
  assert.deepEqual(body.modes.map((mode) => mode.title), ['Agent Skill', 'MCP', 'RSS', 'REST API'])
  assert.match(body.modes[1].copyText, /claude mcp add --transport http aihot/)
  assert.equal(body.modes[2].feeds.length, 6)
  assert.equal(body.modes[2].copyText, 'https://aihot.news/feed.xml')
  assert.equal(fake.calls.length, 4)
  assert.deepEqual(fake.calls.map((entry) => params(entry.url).pathname + params(entry.url).search), [
    '/agent',
    '/agent?tab=mcp',
    '/agent?tab=rss',
    '/agent?tab=api',
  ])
})

await test('四页 SSR 路由：上游 403 / 网络失败 → 502「抓取 XX 失败：…」', async () => {
  const forbidden = scripted([() => status(403, {}, 'Forbidden')])
  const first = await call(ssrOf(forbidden.fetchImpl, 'free-tokens'), '/api/plugins/aihot/free-tokens')
  assert.equal(first.status, 502)
  assert.match((await first.json()).error, /^抓取羊毛页失败：/)

  const broken = scripted([() => { throw new TypeError('fetch failed') }])
  const second = await call(ssrOf(broken.fetchImpl, 'leaderboard'), '/api/plugins/aihot/leaderboard')
  assert.equal(second.status, 502)
  assert.match((await second.json()).error, /^抓取排行榜失败：/)
})

await test('四页 SSR 路由：上游 404 原样透出 404', async () => {
  const notFound = scripted([() => status(404, {}, 'not found')])
  const response = await call(ssrOf(notFound.fetchImpl, 'reset-calendar'), '/api/plugins/aihot/reset-calendar')
  assert.equal(response.status, 404)
  assert.equal((await response.json()).ok, false)
})

/* ------------------------------------------------------------ Host 路由：webServer 迟到 */

await test('Host 路由：webServer 迟到时由 ctx.inject 补注册 12 条（冷启动全局 404 回归）', async () => {
  const routes = new Map()
  const pending = []
  // 冷启动的真实形态：apply 时 get('webServer') 还是 undefined，只有 inject 可用。
  const ctx = {
    tools: { register() { return () => {} } },
    get() { return undefined },
    effect(fn) { fn(); return () => {} },
    inject(deps, run) { pending.push({ deps, run }); return () => {} },
  }
  applyHost(ctx, { fetch: async () => status(200, {}, '{}'), cacheTtlMs: 0, timeoutMs: 3000 })
  assert.equal(routes.size, 0, 'webServer 未就绪时不应注册路由')
  assert.equal(pending.length, 1, '应通过 ctx.inject 挂一个 webServer 依赖作用域')
  assert.deepEqual(pending[0].deps, ['webServer'])

  const web = { register(spec) { routes.set(spec.path, spec); return () => {} } }
  pending[0].run({ get: (name) => (name === 'webServer' ? web : undefined), effect(fn) { fn(); return () => {} } })
  assert.equal(routes.size, 12, '服务就绪后应补齐 12 条路由')
  assert.ok(routes.has('/api/plugins/aihot/period'), 'period 路由应注册')
})

/* ------------------------------------------------------------ 汇总 */

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  process.exitCode = 1
}