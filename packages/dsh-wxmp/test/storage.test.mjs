/**
 * storage 域持久化后端测试：openStore(dataDir, { storage }) 注入 DSH storage
 * （hub / DomainFacility 两种形态）时的订阅增删、文章去重、since 游标、
 * 跨实例读写一致性（close 落盘后重开）、以及无注入时的内存兜底与运行期 upgrade。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../lib/store.js'

/* ------------------------------------------------ 最小 DSH storage 模拟（共享介质 = 持久层） */

class FakeKvTable {
  constructor(medium, table) { this.medium = medium; this.table = table }
  get(key) { return this.medium[this.table].get(key) }
  entries() { return [...this.medium[this.table].entries()][Symbol.iterator]() }
  keys() { return [...this.medium[this.table].keys()][Symbol.iterator]() }
  get size() { return this.medium[this.table].size }
  put(key, value) { this.medium[this.table].set(key, value); return Promise.resolve() }
  delete(key) { const had = this.medium[this.table].delete(key); return Promise.resolve(had) }
  close() { return Promise.resolve() }
}

class FakeDomain {
  constructor(medium, spec) {
    assert.equal(spec.name, 'wxmp')
    this.name = spec.name
    this.tables = {
      subscriptions: new FakeKvTable(medium, 'subscriptions'),
      articles: new FakeKvTable(medium, 'articles'),
    }
  }
  table(name) { return this.tables[name] }
  close() { return Promise.resolve() }
}

class FakeFacility {
  /** @param {object} medium 共享介质 {subscriptions:Map, articles:Map}；open 不延迟传 delayMs=0 */
  constructor(medium, delayMs = 0) { this.medium = medium; this.delayMs = delayMs; this.opened = 0 }
  async open(spec) {
    this.opened++
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs))
    return new FakeDomain(this.medium, spec)
  }
}

/** 形如 ctx.storage 的 hub：经 .domain 暴露 facility。 */
class FakeHub { constructor(facility) { this.facility = facility } get domain() { return this.facility } }

const newMedium = () => ({ subscriptions: new Map(), articles: new Map() })

const art = (link, publishTime) => ({ link, title: 't-' + link, publishTime })

/* ---------------------------------------------------------------- 用例 */

test('storage 域后端：订阅增删 + backend 标识', () => {
  const store = openStore('F:/tmp-dsh-wxmp-unused', { storage: new FakeHub(new FakeFacility(newMedium())) })
  assert.equal(store.backend, 'storage')
  assert.equal(store.addSubscription({ fakeid: 'FAKE1', nickname: '甲', alias: 'jia' }), true)
  store.addSubscription({ fakeid: 'FAKE2', nickname: '乙' })
  assert.equal(store.listSubscriptions().length, 2)
  assert.equal(store.removeSubscription('FAKE2'), true)
  assert.equal(store.removeSubscription('FAKE2'), false)
  assert.deepEqual(store.listSubscriptions().map((s) => s.fakeid), ['FAKE1'])
})

test('storage 域后端：文章按 (fakeid,link) 去重', () => {
  const store = openStore('x', { storage: new FakeFacility(newMedium()) })
  assert.equal(store.saveArticles('FAKE1', [art('l1', 300), art('l2', 200)]), 2)
  assert.equal(store.saveArticles('FAKE1', [art('l1', 300)]), 0) // 同 fakeid+link 去重
  assert.equal(store.saveArticles('FAKE2', [art('l1', 300)]), 1) // 不同 fakeid 不去重
  const { articles } = store.listArticles('FAKE1')
  assert.equal(articles.length, 2)
  assert.deepEqual(articles.map((a) => a.link).sort(), ['l1', 'l2'])
})

test('storage 域后端：since 增量游标分页', () => {
  const store = openStore('x', { storage: new FakeFacility(newMedium()) })
  store.saveArticles('F', [art('a', 500), art('b', 400), art('c', 300), art('d', 200), art('e', 100)])
  const page1 = store.listArticles('F', { limit: 2 })
  assert.deepEqual(page1.articles.map((a) => a.link), ['a', 'b'])
  assert.equal(page1.nextSince, 400)
  const page2 = store.listArticles('F', { since: page1.nextSince, limit: 2 })
  assert.deepEqual(page2.articles.map((a) => a.link), ['c', 'd'])
  assert.equal(page2.nextSince, 200)
  const page3 = store.listArticles('F', { since: page2.nextSince, limit: 2 })
  assert.deepEqual(page3.articles.map((a) => a.link), ['e'])
  assert.equal(page3.nextSince, null)
})

test('storage 域后端：持久化读写一致性（close 落盘后重开仍可读）', async () => {
  const medium = newMedium()
  const store = openStore('x', { storage: new FakeHub(new FakeFacility(medium)) })
  store.addSubscription({ fakeid: 'S1', nickname: '订阅一' })
  store.addSubscription({ fakeid: 'GONE', nickname: '待删' })
  store.removeSubscription('GONE')
  store.saveArticles('S1', [art('p1', 900), art('p2', 800)])
  store.touchSubscription('S1', 12345)
  await store.close()

  // 新实例读同一介质：等价于进程重启后的读取。
  const store2 = openStore('x', { storage: new FakeHub(new FakeFacility(medium)) })
  await store2.ready() // 等待域打开并载入持久层记录
  const subs = store2.listSubscriptions()
  assert.equal(subs.length, 1)
  assert.equal(subs[0].fakeid, 'S1')
  assert.equal(subs[0].lastPoll, 12345)
  const { articles } = store2.listArticles('S1')
  assert.deepEqual(articles.map((a) => a.link).sort(), ['p1', 'p2'])
  assert.equal(store2.saveArticles('S1', [art('p1', 900)]), 0) // 去重在重启后仍成立
  const got = store2.getArticle(articles[0].id)
  assert.ok(got && got.link)
  await store2.close()
})

test('storage 域后端：域打开延迟时，先发生的写也会在打开后补写落盘', async () => {
  const medium = newMedium()
  const facility = new FakeFacility(medium, 20) // open 延迟 20ms
  const store = openStore('x', { storage: new FakeHub(facility) })
  store.addSubscription({ fakeid: 'EARLY', nickname: '早写' }) // 域尚未打开
  store.saveArticles('EARLY', [art('early1', 700)])
  await store.close()
  assert.ok(medium.subscriptions.has('EARLY'), '打开前写的订阅已补写持久层')
  assert.ok([...medium.articles.values()].some((r) => r.link === 'early1'), '打开前写的文章已补写持久层')
})

test('内存兜底：无 storage 注入时 backend 为 memory，且可运行期 upgrade 到 storage 域', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wxmp-store-'))
  try {
    const store = openStore(dir)
    assert.equal(store.backend, 'memory')
    const medium = newMedium()
    assert.equal(store.upgrade(new FakeHub(new FakeFacility(medium))), true)
    assert.equal(store.backend, 'storage')
    store.addSubscription({ fakeid: 'U1', nickname: '升级后' })
    store.saveArticles('U1', [art('u1', 600)])
    await store.close()
    assert.ok(medium.subscriptions.has('U1'))
    assert.ok([...medium.articles.values()].some((r) => r.link === 'u1'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('openStore：storage 为不可解析对象 / domain form 未挂载的 hub 时退回非 storage 后端', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wxmp-store-'))
  try {
    const s1 = openStore(dir, { storage: { nope: true } })
    assert.notEqual(s1.backend, 'storage')
    const throwingHub = { get domain() { throw new Error('form-not-mounted') } }
    const s2 = openStore(dir, { storage: throwingHub })
    assert.notEqual(s2.backend, 'storage')
    s1.close(); s2.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
