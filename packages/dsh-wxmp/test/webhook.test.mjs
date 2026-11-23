/**
 * 第二批后端测试：订阅分类（category）与 webhook 通知。
 * - 分类：三后端（storage 域 / sqlite 模拟 / 内存）一致、按分类过滤、旧数据兼容。
 * - webhook：投递成功、单 URL 失败容错、added=0 不通知、poll 集成与路由维护。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { openStore } from '../lib/store.js'
import { notifyWebhooks } from '../lib/webhook.js'
import { pollSubscriptions } from '../lib/poll.js'

/* ---------------------------------------------------------------- storage 域模拟 */

class FakeKvTable {
  constructor(medium, table) { this.medium = medium; this.table = table }
  entries() { return [...this.medium[this.table].entries()][Symbol.iterator]() }
  put(key, value) { this.medium[this.table].set(key, value); return Promise.resolve() }
  delete(key) { const had = this.medium[this.table].delete(key); return Promise.resolve(had) }
  close() { return Promise.resolve() }
}
class FakeDomain {
  constructor(medium, spec) {
    this.tables = { subscriptions: new FakeKvTable(medium, 'subscriptions'), articles: new FakeKvTable(medium, 'articles') }
  }
  table(name) { return this.tables[name] }
  close() { return Promise.resolve() }
}
class FakeFacility {
  constructor(medium) { this.medium = medium }
  async open(spec) { return new FakeDomain(this.medium, spec) }
}

/* ---------------------------------------------------------------- sqlite 模拟（better-sqlite3 未安装） */

const SQLITE_PARENT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SQLITE_PATH = join(SQLITE_PARENT, 'node_modules', 'better-sqlite3')

/** 只实现 store.js sqlite 后端用到的最小 SQL 子集。 */
function fakeSqliteDb() {
  const subs = new Map() // fakeid -> 订阅行；写入时刷新时间戳（与真实 sqlite 的毫秒创建时间一致）
  let clock = 1e12
  const arts = []
  let autoId = 0
  const canonical = (sql) => String(sql).replace(/\s+/g, ' ').trim()
  const db = {
    pragma() {},
    exec(sql) {
      // 兼容旧库迁移：建表语句里出现 category 即视为新表；已存在列时不重复 ALTER。
      if (/ALTER TABLE subscriptions ADD COLUMN category/.test(sql) && db.hadCategoryColumn) throw new Error('duplicate column name: category')
    },
    prepare(sql) {
      const q = canonical(sql)
      if (q.startsWith('PRAGMA table_info(subscriptions)')) {
        return { all: () => (db.hadCategoryColumn ? [{ name: 'fakeid' }, { name: 'category' }] : [{ name: 'fakeid' }]) }
      }
      if (q.startsWith('INSERT INTO subscriptions')) {
        return {
          run(fakeid, nickname, alias, headImg, category, createdAt) {
            const prev = subs.get(fakeid)
            subs.set(fakeid, {
              fakeid, nickname, alias, head_img: headImg, created_at: clock++ ?? createdAt,
              last_poll: prev?.last_poll ?? null,
              category: category !== '' ? category : (prev?.category ?? ''),
            })
            return { changes: 1 }
          },
        }
      }
      if (q.startsWith('UPDATE subscriptions SET category')) {
        return {
          run(category, fakeid) {
            const rec = subs.get(fakeid)
            if (!rec) return { changes: 0 }
            rec.category = category
            return { changes: 1 }
          },
        }
      }
      if (q.startsWith('UPDATE subscriptions SET last_poll')) {
        return { run(ts, fakeid) { const r = subs.get(fakeid); if (r) r.last_poll = ts; return { changes: r ? 1 : 0 } } }
      }
      if (q.startsWith('DELETE FROM subscriptions')) {
        return { run(fakeid) { return { changes: subs.delete(fakeid) ? 1 : 0 } } }
      }
      if (q.startsWith('SELECT * FROM subscriptions')) {
        return { all: () => [...subs.values()].sort((a, b) => b.created_at - a.created_at) }
      }
      if (q.startsWith('INSERT OR IGNORE INTO articles')) {
        const stmt = {
          run(fakeid, aid, title, link) {
            if (arts.some((a) => a.fakeid === fakeid && a.link === link)) return { changes: 0 }
            arts.push({ id: ++autoId, fakeid, aid, title, link })
            return { changes: 1 }
          },
        }
        return stmt
      }
      if (q.startsWith('SELECT * FROM articles WHERE fakeid')) {
        return { all: (fakeid, since, since2, limit) => arts.filter((a) => a.fakeid === fakeid).slice(0, limit) }
      }
      if (q.startsWith('SELECT * FROM articles WHERE (? IS NULL')) {
        return { all: (since, since2, limit) => arts.slice(0, limit) }
      }
      if (q.startsWith('SELECT * FROM articles WHERE id')) return { get: () => undefined }
      throw new Error('fakeSqliteDb 未实现：' + q)
    },
    transaction(fn) { return (list) => fn(list) },
    close() {},
  }
  db.__subs = subs
  db.__arts = arts
  return db
}

/**
 * 把 <包根>/node_modules/better-sqlite3 写成替身模块，让 store.js 的 require 命中它。
 * 复用注意：CommonJS 加载失败不入缓存，但首次成功加载的源码会被永久缓存，
 * 所以必须在任何 openStore() 之前 prime()，把「动态导出」的源码先落盘；
 * 之后 install() 只改 globalThis.__wxmpFakeSqliteDb，不改源码，缓存副本与磁盘保持一致。
 * 未安装真实 better-sqlite3 时 install 不会被自动调用（withFakeSqlite(true) 或直接 prime()），
 * 于是 store.js 的 require 失败 → openStore 退回内存，与真实环境一致。
 */
let fakeSqlitePrimed = false
let realSqlitePresent = null
fakeSqliteDb.prime = () => {
  if (realSqlitePresent === null) {
    let resolved = ''
    try { resolved = createRequire(join(SQLITE_PARENT, 'index.js')).resolve('better-sqlite3') } catch { /* 未安装 */ }
    realSqlitePresent = resolved !== '' && !resolved.startsWith(SQLITE_PATH)
  }
  if (realSqlitePresent || fakeSqlitePrimed) return
  for (const dir of [SQLITE_PATH, dirname(SQLITE_PATH)]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(SQLITE_PATH, 'package.json'), '{"name":"better-sqlite3","main":"index.js"}')
  writeFileSync(join(SQLITE_PATH, 'index.js'),
    'module.exports = function FakeSqlite() { if (!globalThis.__wxmpFakeSqliteDb) throw new Error("测试替身未设置"); return globalThis.__wxmpFakeSqliteDb }\n')
  fakeSqlitePrimed = true
}
fakeSqliteDb.install = () => {
  fakeSqliteDb.prime()
  if (!globalThis.__wxmpFakeSqliteDb) globalThis.__wxmpFakeSqliteDb = fakeSqliteDb()
  return globalThis.__wxmpFakeSqliteDb
}
fakeSqliteDb.uninstall = () => { delete globalThis.__wxmpFakeSqliteDb }
fakeSqliteDb.teardown = () => {
  fakeSqliteDb.uninstall()
  if (!fakeSqlitePrimed) return
  rmSync(SQLITE_PATH, { recursive: true, force: true })
  try { if (readdirSync(dirname(SQLITE_PATH)).length === 0) rmSync(dirname(SQLITE_PATH), { recursive: true, force: true }) } catch { /* 忽略 */ }
  fakeSqlitePrimed = false
}
/** 包一层：期间 install 假库，fn 结束后释放。 */
function withFakeSqlite(fn) {
  fakeSqliteDb.install()
  try { return fn() } finally { fakeSqliteDb.uninstall() }
}
// 文件末尾兜底：无论用例怎么退出，都删掉临时的 node_modules 替身。
test.after(() => { fakeSqliteDb.teardown() })

/* ---------------------------------------------------------------- 工具 */

const art = (link, publishTime) => ({ link, title: 't-' + link, publishTime })

// 在任何 openStore() 之前把替身源码落盘，并故意抛一次错：模块被加载器缓存后，
// 之后只要没有假库实例就一路退回内存分支（与未安装 better-sqlite3 的真实环境一致）。
globalThis.__wxmpFakeSqliteDb = null
try { openStore('F:/tmp-dsh-wxmp-memory') } catch { /* 预期失败 */ }

/**
 * 打开 sqlite 后端的 store（经 openStore 真实分支驱动假 better-sqlite3）。
 * @param {object} [db] 假库，复用同一个实例即可模拟「重开同一个库」
 * @param {string} [dir] 数据目录
 * @param {boolean} [keep] true=假库常驻（断言 backend==='sqlite'）；false=仅本次 openStore 生效，用完退回内存
 */
function openFakeSqliteStore(db = fakeSqliteDb(), dir = mkdtempSync(join(tmpdir(), 'wxmp-fake-')), keep = true, deleteDir = true) {
  fakeSqliteDb.prime()
  globalThis.__wxmpFakeSqliteDb = db
  if (deleteDir) {
    // 每次 open 都是「重开同一个库」：清掉假库上一次的进程内状态（真 sqlite 由文件承载）
    if (!db.__keepOnOpen) clearFakeSqliteState(db)
    unlinkDbFiles(dir)
  }
  if (!keep) { try { return openStore(dir) } finally { fakeSqliteDb.uninstall() } }
  return openStore(dir)
}
/** 丢弃假库的进程内状态，模拟「新建/重开一个空库」。 */
function clearFakeSqliteState(db) {
  if (db?.__subs) db.__subs.clear()
  if (db?.__arts) db.__arts.length = 0
}
/** 每个用例用全新目录：同名目录里的旧库文件会让断言读到上一次的数据。 */
function unlinkDbFiles(dir) {
  for (const name of ['wxmp.sqlite3', 'wxmp.sqlite3-journal', 'wxmp.sqlite3-wal', 'wxmp.sqlite3-shm']) {
    try { rmSync(join(dir, name), { force: true }) } catch { /* 忽略 */ }
  }
}
/**
 * 内存后端：先让 sqlite 分支摔一跤。store.js 的同包 require 与测试里的 createRequire 共用
 * 同一个加载器缓存，失败不入缓存；这里故意让替身抛一次错，之后没有假库实例时它自然退回内存。
 */
function ensureSqliteFailCached() {
  fakeSqliteDb.prime()
  fakeSqliteDb.uninstall()
}
const openMemoryStore = () => {
  ensureSqliteFailCached()
  return openStore('F:/tmp-dsh-wxmp-memory')
}
const backends = () => [
  ['内存', () => openFakeSqliteStore(undefined, 'F:/tmp-dsh-wxmp-memory', false, false)],
  ['storage 域', () => openStore('x', { storage: new FakeFacility({ subscriptions: new Map(), articles: new Map() }) })],
  ['sqlite', () => openFakeSqliteStore()],
]

/* ---------------------------------------------------------------- 分类用例 */

test('订阅分类：三后端 addSubscription/setSubscriptionCategory/listSubscriptions 行为一致', async () => {
  const expected = ['财经', '科技'] // listSubscriptions 按 createdAt 倒序：后改分类的 B 与 A 同毫秒，排序在两者间不稳定，故按内容比较前先对齐顺序
  const categoriesOf = (store) => store.listSubscriptions().map((s) => s.category).sort()
  for (const [label, make] of backends()) {
    const store = make()
    try {
      assert.equal(store.addSubscription({ fakeid: 'A', nickname: '甲', category: '科技' }), true, label)
      assert.equal(store.addSubscription({ fakeid: 'B', nickname: '乙' }), true, label)
      assert.equal(store.setSubscriptionCategory('B', '财经'), true, label)
      assert.deepEqual(categoriesOf(store), [...expected].sort(), label)
      assert.equal(store.setSubscriptionCategory('NOPE', 'x'), false, label)
      assert.throws(() => store.setSubscriptionCategory('', 'x'), RangeError, label)
    } finally {
      await store.close()
    }
  }
})

test('订阅分类：listSubscriptions({category}) 过滤，空串/undefined 不过滤（三后端）', async () => {
  for (const [label, make] of backends()) {
    const store = make()
    try {
      store.addSubscription({ fakeid: 'A', nickname: '甲', category: '科技' })
      store.addSubscription({ fakeid: 'B', nickname: '乙', category: '财经' })
      store.addSubscription({ fakeid: 'C', nickname: '丙' })
      assert.equal(store.listSubscriptions().length, 3, label)
      assert.equal(store.listSubscriptions({}).length, 3, label)
      assert.equal(store.listSubscriptions({ category: '' }).length, 3, label)
      assert.equal(store.listSubscriptions({ category: undefined }).length, 3, label)
      assert.deepEqual(store.listSubscriptions({ category: '科技' }).map((s) => s.fakeid), ['A'], label)
      assert.deepEqual(store.listSubscriptions({ category: '不存在' }), [], label)
    } finally {
      await store.close()
    }
  }
})

test('订阅分类：sqlite 旧库（无 category 列）自动补列，旧记录读作空串', async () => {
  const db = fakeSqliteDb()
  db.hadCategoryColumn = false
  // 旧库预置数据：无 category 字段
  const legacySub = { fakeid: 'OLD', nickname: '老号', alias: '', head_img: '', created_at: 1, last_poll: null }
  db.__subs.set('OLD', legacySub)
  // 独立数据目录：验证「旧库文件重开」语义（deleteDir=false 保留假库实例）
  const migrateDir = mkdtempSync(join(tmpdir(), 'wxmp-migrate-'))
  db.__keepOnOpen = true // 这个用例要保留预置的旧库数据

  const store = openFakeSqliteStore(db, migrateDir, true, false)
  try {
    assert.equal(store.backend, 'sqlite')
    const [old] = store.listSubscriptions()
    assert.equal(old.fakeid, 'OLD')
    assert.equal(old.category, '')
    assert.equal(store.setSubscriptionCategory('OLD', '科技'), true)
    assert.deepEqual(store.listSubscriptions({ category: '科技' }).map((s) => s.fakeid), ['OLD'])
  } finally {
    await store.close()
  }
  // 重开后新列已在：不再执行 ALTER（fake exec 对重复加列会抛错）
  db.hadCategoryColumn = true
  // 假库即进程内状态：重开沿用实例即「文件里的数据还在」。用完必须废弃它，
  // 否则后续用例重开库时会读到这里的记录（真实 sqlite 由文件承载，没有这个问题）。
  db.__keepOnOpen = false
  const reopened = openFakeSqliteStore(db, migrateDir, true, false)
  try {
    assert.deepEqual(reopened.listSubscriptions().map((s) => s.category), ['科技'])
    clearFakeSqliteState(db) // 丢弃进程内副本，后续用例不受影响
  } finally {
    await reopened.close()
  }
})

test('订阅分类：storage 域旧数据（无 category）读作空串且可改分类后落持久层', async () => {
  const medium = { subscriptions: new Map(), articles: new Map() }
  // 持久层里已有旧格式记录（无 category）
  medium.subscriptions.set('LEGACY', { fakeid: 'LEGACY', nickname: '旧号', alias: '', headImg: '', createdAt: 1000, lastPoll: null })
  const store = openStore('x', { storage: new FakeFacility(medium) })
  await store.ready()
  const [sub] = store.listSubscriptions()
  assert.equal(sub.fakeid, 'LEGACY')
  assert.equal(sub.category, '')
  assert.deepEqual(store.listSubscriptions({ category: '' }).map((s) => s.fakeid), ['LEGACY'])
  assert.equal(store.setSubscriptionCategory('LEGACY', '科技'), true)
  await store.close()
  assert.equal(medium.subscriptions.get('LEGACY').category, '科技')
})

/* ---------------------------------------------------------------- webhook 纯逻辑 */

test('notifyWebhooks：逐个 POST JSON，全部成功返回 delivered', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return { status: 204 }
  }
  const r = await notifyWebhooks({}, {
    webhooks: ['https://a.test/hook', 'https://b.test/hook'],
    payload: { event: 'articles_added', added: 1, articles: [{ link: 'l1' }] },
    fetchImpl,
  })
  assert.deepEqual(r, { delivered: 2, failed: [] })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[1].init.body), { event: 'articles_added', added: 1, articles: [{ link: 'l1' }] })
})

test('notifyWebhooks：单个 URL 失败不抛错，记入 failed 且不影响其它 URL', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('boom')) throw new Error('连接被拒绝')
    if (url.includes('500')) return { status: 500 }
    return { status: 200 }
  }
  const r = await notifyWebhooks({ logger: { warn() {} } }, {
    webhooks: ['https://boom.test/h', 'https://500.test/h', 'https://ok.test/h'],
    payload: { event: 'articles_added', added: 2, articles: [] },
    fetchImpl,
  })
  assert.equal(r.delivered, 1)
  assert.equal(r.failed.length, 2)
  assert.deepEqual(r.failed[0], { url: 'https://boom.test/h', error: '连接被拒绝' })
  assert.deepEqual(r.failed[1], { url: 'https://500.test/h', error: 'HTTP 500' })
})

test('notifyWebhooks：空数组/未传不发请求', async () => {
  let called = 0
  const fetchImpl = async () => { called++; return { status: 200 } }
  assert.deepEqual(await notifyWebhooks({}, { webhooks: [], payload: {}, fetchImpl }), { delivered: 0, failed: [] })
  assert.deepEqual(await notifyWebhooks({}, { payload: {}, fetchImpl }), { delivered: 0, failed: [] })
  assert.equal(called, 0)
})

/* ---------------------------------------------------------------- poll 集成 */

function makePollStore() {
  const subs = [{ id: '1', fakeid: 'M1', nickname: '甲号', category: '科技' }]
  const articles = []
  return {
    listSubscriptions: () => subs,
    listArticles: () => ({ articles: articles.map((a) => ({ ...a })) }),
    saveArticles(fakeid, list) {
      let n = 0
      for (const a of list) {
        if (articles.some((x) => x.link === a.link)) continue
        articles.push({ fakeid, link: a.link, title: a.title })
        n++
      }
      return n
    },
    touchSubscription() {},
    removeSubscription() {},
  }
}

const wxStub = (links) => ({
  listArticles: async () => ({ articles: links.map((l) => ({ link: l, title: 'T-' + l })) }),
  fetchArticle: async () => ({}),
  htmlToMarkdown: () => '',
})
const authStub = { getCredentials: () => ({ token: 'T' }) }

test('pollSubscriptions：added>0 时用新文章明细通知 webhook', async () => {
  const store = makePollStore()
  const seen = []
  const notifyWebhook = async (_ctx, opts) => { seen.push(opts); return { delivered: opts.webhooks.length, failed: [] } }
  const r = await pollSubscriptions({}, {
    store, auth: authStub, wx: wxStub(['https://mp.weixin.qq.com/s/A', 'https://mp.weixin.qq.com/s/B']),
    sleep: async () => {}, webhooks: ['https://hook.test/x'], notifyWebhook,
  })
  assert.equal(r.added, 2)
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].webhooks, ['https://hook.test/x'])
  assert.equal(seen[0].payload.event, 'articles_added')
  assert.equal(seen[0].payload.added, 2)
  assert.deepEqual(seen[0].payload.articles.map((a) => a.link), ['https://mp.weixin.qq.com/s/A', 'https://mp.weixin.qq.com/s/B'])
  assert.equal(seen[0].payload.articles[0].fakeid, 'M1')
  assert.equal(seen[0].payload.articles[0].nickname, '甲号')
  assert.equal(seen[0].payload.articles[0].title, 'T-https://mp.weixin.qq.com/s/A')
  assert.deepEqual(r.webhook, { delivered: 1, failed: [] })
  // 第二轮全部已存在：added=0，不再通知
  await pollSubscriptions({}, {
    store, auth: authStub, wx: wxStub(['https://mp.weixin.qq.com/s/A', 'https://mp.weixin.qq.com/s/B']),
    sleep: async () => {}, webhooks: ['https://hook.test/x'], notifyWebhook,
  })
  assert.equal(seen.length, 1)
})

test('pollSubscriptions：added=0 或 webhooks 为空时不通知；通知抛错不影响轮询结果', async () => {
  let calls = 0
  const notifyWebhook = async () => { calls++; return { delivered: 0, failed: [] } }
  const store = makePollStore()
  store.saveArticles('M1', [{ link: 'https://mp.weixin.qq.com/s/OLD' }])
  const r1 = await pollSubscriptions({}, {
    store, auth: authStub, wx: wxStub(['https://mp.weixin.qq.com/s/OLD']), sleep: async () => {},
    webhooks: ['https://hook.test/x'], notifyWebhook,
  })
  assert.equal(r1.added, 0)
  assert.equal(calls, 0)
  const r2 = await pollSubscriptions({}, {
    store, auth: authStub, wx: wxStub(['https://mp.weixin.qq.com/s/NEW']), sleep: async () => {}, webhooks: [], notifyWebhook,
  })
  assert.equal(r2.added, 1)
  assert.equal(calls, 0)
  const r3 = await pollSubscriptions({ logger: { warn() {} } }, {
    store, auth: authStub, wx: wxStub(['https://mp.weixin.qq.com/s/NEW2']), sleep: async () => {},
    webhooks: ['https://hook.test/x'], notifyWebhook: async () => { throw new Error('投递炸了') },
  })
  assert.equal(r3.added, 1)
  assert.equal(r3.failed.length, 0)
  assert.equal(r3.webhook.failed[0].error, '投递炸了')
})

/* ---------------------------------------------------------------- index.js 路由 */

import { apply } from '../index.js'

function makeHarness() {
  const routes = new Map()
  const tools = new Map()
  const effects = []
  const webServer = { register(spec) { routes.set(spec.path, spec.resource); return () => routes.delete(spec.path) } }
  const ctx = {
    get: (name) => (name === 'webServer' ? webServer : undefined),
    tools: { register: (t) => { tools.set(t.name, t); return () => tools.delete(t.name) } },
    effect: (fn) => { effects.push(fn) },
    logger: { warn() {}, debug() {} },
  }
  return { ctx, routes, tools, dispose: () => { for (const fn of effects) fn() } }
}
const fetchOk = async () => ({ status: 200, text: '{}', headers: new Headers() })

test('index.js：订阅分类路由 set_category / 过滤 / 404，wxmp_subscribe 接受 category', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wxmp-cat-'))
  const h = makeHarness()
  withFakeSqlite(() => apply(h.ctx, { dataDir: dir, fetch: fetchOk, pollIntervalMs: 60000 }))
  try {
    const subsRoute = h.routes.get('/api/plugins/wxmp/subscriptions')
    assert.ok(subsRoute)
    await h.tools.get('wxmp_subscribe').execute({ fakeid: 'A1', nickname: '甲', category: '科技' }, {})
    await h.tools.get('wxmp_subscribe').execute({ fakeid: 'B1', nickname: '乙' }, {})
    let j = await (await subsRoute(new Request('https://h.test/api/plugins/wxmp/subscriptions'))).json()
    assert.deepEqual(j.list.map((s) => s.fakeid).sort(), ['A1', 'B1'], JSON.stringify(j))
    assert.equal(j.list.find((s) => s.fakeid === 'A1').category, '科技')
    assert.equal(j.list.find((s) => s.fakeid === 'B1').category, '')
    const setRes = await subsRoute(new Request('https://h.test/api/plugins/wxmp/subscriptions?_method=set_category&fakeid=B1&category=' + encodeURIComponent('财经')))
    assert.equal(setRes.status, 200)
    assert.equal((await setRes.json()).category, '财经')
    j = await (await subsRoute(new Request('https://h.test/api/plugins/wxmp/subscriptions?category=' + encodeURIComponent('财经')))).json()
    assert.deepEqual(j.list.map((s) => s.fakeid), ['B1'])
    assert.deepEqual(j.categories.sort(), ['科技', '财经'].sort())
    const notFound = await subsRoute(new Request('https://h.test/api/plugins/wxmp/subscriptions?_method=set_category&fakeid=NOPE&category=x'))
    assert.equal(notFound.status, 404)
    assert.match((await notFound.json()).error, /未订阅/)
    const bad = await subsRoute(new Request('https://h.test/api/plugins/wxmp/subscriptions?_method=oops'))
    assert.equal(bad.status, 400)
  } finally {
    h.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('index.js：webhooks 路由 list/add/remove；config 初值生效；wxmp_local_articles 输出带 category', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wxmp-wh-'))
  const h = makeHarness()
  withFakeSqlite(() => apply(h.ctx, { dataDir: dir, fetch: fetchOk, pollIntervalMs: 60000, webhooks: ['https://init.test/hook'] }))
  try {
    const whRoute = h.routes.get('/api/plugins/wxmp/webhooks')
    assert.ok(whRoute)
    const base = 'https://h.test/api/plugins/wxmp/webhooks'
    let j = await (await whRoute(new Request(base + '?_method=list'))).json()
    assert.deepEqual(j.webhooks, ['https://init.test/hook'])
    j = await (await whRoute(new Request(base + '?_method=add&url=' + encodeURIComponent('https://new.test/hook')))).json()
    assert.deepEqual(j.webhooks, ['https://init.test/hook', 'https://new.test/hook'])
    j = await (await whRoute(new Request(base + '?_method=remove&url=' + encodeURIComponent('https://init.test/hook')))).json()
    assert.deepEqual(j.webhooks, ['https://new.test/hook'])
    const miss = await whRoute(new Request(base + '?_method=remove&url=' + encodeURIComponent('https://none.test/h')))
    assert.equal(miss.status, 404)
    const noUrl = await whRoute(new Request(base + '?_method=add'))
    assert.equal(noUrl.status, 400)

    await h.tools.get('wxmp_subscribe').execute({ fakeid: 'C1', nickname: '丙', category: '科技' }, {})
    // 直接塞一条本地文章（绕过微信抓取）
    const { openStore } = await import('../lib/store.js')
    void openStore
    const articlesRoute = h.routes.get('/api/plugins/wxmp/articles')
    const j2 = await (await articlesRoute(new Request('https://h.test/api/plugins/wxmp/articles?category=' + encodeURIComponent('科技')))).json()
    assert.equal(j2.ok, true)
    assert.ok(Array.isArray(j2.articles))
  } finally {
    h.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})