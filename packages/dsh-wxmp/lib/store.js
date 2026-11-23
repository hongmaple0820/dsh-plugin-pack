/**
 * 订阅/文章本地存储：优先 DSH storage 域（ctx.storage / ctx.storageDomain 提供的
 * domain facility），不可用时退回 better-sqlite3，再退回同接口的内存实现。
 * 导出 openStore(dataDir, opts?)；三种后端方法签名完全一致，调用方无感知。
 *
 * 表结构：
 * - subscriptions(fakeid PK, nickname, alias, head_img, created_at, last_poll)
 * - articles(id PK AUTOINCREMENT, fakeid, aid, title, link, digest, cover, author,
 *            content, publish_time, fetched_at)，UNIQUE(fakeid,link)，索引(fakeid, publish_time DESC)
 *
 * DSH storage 域后端（backend === 'storage'）：同步读写走进程内权威副本，
 * 每次写同时排队一次异步持久写（KV 表 put/delete，键为字符串，值为 JSON 记录）。
 * 域打开是异步的：打开完成前发生的写先落本地副本，打开后按序补写持久层；
 * 打开时载入持久层已有记录，进程内已有同键记录以进程内为准。close() 等待全部持久写落盘。
 */

import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { htmlToMarkdown } from './wechat.js'

const require = createRequire(import.meta.url)

/** 尝试加载 better-sqlite3；失败返回 null（走内存兜底）。 */
function tryLoadSqlite() {
  try {
    return require('better-sqlite3')
  } catch {
    return null
  }
}

/**
 * 打开一个存储实例。优先级：DSH storage 域 > better-sqlite3 > 内存。
 * @param {string} dataDir 数据目录（不存在则创建；仅 sqlite 路径使用）
 * @param {{storage?: object}} [opts] 可注入 DSH storage（ctx.storage hub 或
 *   ctx.storageDomain facility）；提供且能解析出 domain facility 时走 storage 域后端。
 * @returns {{backend:'storage'|'sqlite'|'memory', ...}}
 */
export function openStore(dataDir, opts = {}) {
  if (!dataDir) throw new RangeError('参数 dataDir 必填')
  const storage = opts && typeof opts === 'object' ? opts.storage : undefined
  const facility = storage ? resolveDomainFacility(storage) : null
  if (facility) return openKvStore(facility)
  mkdirSync(dataDir, { recursive: true })
  const Sqlite = tryLoadSqlite()
  if (Sqlite) return openSqliteStore(new Sqlite(join(resolve(dataDir), 'wxmp.sqlite3')))
  return openKvStore(null)
}

/**
 * 从注入的 storage 对象解析出 domain facility：DomainFacility 本身（ctx.storageDomain，
 * 有 async open(spec)），或 storage hub（ctx.storage，经 .domain / .form('domain')）。
 * hub 上 domain form 未挂载时 .domain 会抛错，这里捕获后返回 null（退回 sqlite/内存）。
 * @returns {object|null}
 */
function resolveDomainFacility(storage) {
  if (!storage || typeof storage !== 'object') return null
  if (typeof storage.open === 'function') return storage
  try {
    if (storage.domain && typeof storage.domain.open === 'function') return storage.domain
  } catch { /* domain form 未挂载 */ }
  try {
    if (typeof storage.form === 'function') {
      const facility = storage.form('domain')
      if (facility && typeof facility.open === 'function') return facility
    }
  } catch { /* domain form 未挂载 */ }
  return null
}

/* ---------------------------------------------------------------- storage 域 / 内存后端 */

/** wxmp 的 storage 域声明；记录对本层是透明 JSON，valueSchema 用直通解析。 */
const WXMP_DOMAIN_SPEC = {
  name: 'wxmp',
  version: 1,
  tables: {
    subscriptions: { valueSchema: { parse: (v) => v } },
    articles: { valueSchema: { parse: (v) => v } },
  },
}

/**
 * 建立 storage 域持久化通道。同步方法先改进程内副本再排队持久写；
 * 域打开（异步）完成时载入持久层记录（进程内已有同键的记录以进程内为准，
 * 并把进程内已有记录回写持久层），此后排队的写直接落域表。
 * @param {object} facility DomainFacility（open(spec) → Domain）
 * @param {{subs:Map, arts:Map, seqRef:{value:number}}} core 共享的进程内副本
 */
function createDurable(facility, core) {
  let domain = null
  let openError = null
  const openPromise = facility.open(WXMP_DOMAIN_SPEC)
    .then((d) => { domain = d; mergeFromDomain(d) })
    .catch((error) => { openError = error })
  let chain = openPromise.then(() => {})
  const applyOp = async (op) => {
    await openPromise
    if (!domain) return
    const table = domain.table(op.table)
    if (op.kind === 'put') await table.put(op.key, op.value)
    else await table.delete(op.key)
  }
  const queue = (op) => {
    chain = chain.then(() => applyOp(op)).catch((error) => { openError = openError ?? error })
  }

  /** 打开后把持久层记录并入进程内副本；本地已有同键记录时本地优先。 */
  function mergeFromDomain(d) {
    for (const [key, raw] of d.table('subscriptions').entries()) {
      const rec = normalizeSub(raw)
      if (rec && !core.subs.has(key)) core.subs.set(key, rec)
    }
    for (const [key, raw] of d.table('articles').entries()) {
      const row = normalizeArticle(raw)
      if (!row) continue
      core.seqRef.value = Math.max(core.seqRef.value, row.id)
      if (core.arts.has(key)) continue
      // 同 (fakeid,link) 已被进程内记录占用：持久层这条丢弃，避免重复。
      if ([...core.arts.values()].some((r) => r.fakeid === row.fakeid && r.link === row.link)) continue
      if (String(row.id) !== key) {
        // 键位冲突（重启前后的自增序列交错）：换新 id 入库。
        row.id = ++core.seqRef.value
        core.arts.set(String(row.id), row)
      } else {
        core.arts.set(key, row)
      }
    }
    // 进程内已有记录回写持久层（upgrade 场景下的种子数据）。
    for (const [key, rec] of core.subs) queue({ kind: 'put', table: 'subscriptions', key, value: rec })
    for (const [key, row] of core.arts) queue({ kind: 'put', table: 'articles', key, value: row })
  }

  return {
    put(table, key, value) { queue({ kind: 'put', table, key, value }) },
    delete(table, key) { queue({ kind: 'del', table, key }) },
    error() { return openError },
    /** 域打开（含持久层载入）完成后的回调闸门；打开失败同样落定。 */
    ready() { return openPromise },
    /** 等待全部持久写落盘并释放域。 */
    async close() {
      await openPromise
      await chain
      if (domain) await domain.close()
    },
  }
}

/** 订阅记录规整（持久层旧数据兼容）。 */
function normalizeSub(raw) {
  if (!raw || typeof raw !== 'object') return null
  return {
    fakeid: String(raw.fakeid ?? ''), nickname: raw.nickname ?? '', alias: raw.alias ?? '',
    headImg: raw.headImg ?? '', category: raw.category ?? '',
    createdAt: Number(raw.createdAt) || Date.now(),
    lastPoll: raw.lastPoll ?? null,
  }
}

/** 文章行规整（持久层旧数据兼容）。 */
function normalizeArticle(raw) {
  if (!raw || typeof raw !== 'object' || !raw.link) return null
  return {
    id: Number(raw.id) || 0, fakeid: String(raw.fakeid ?? ''), aid: raw.aid ?? '',
    title: raw.title ?? '', link: String(raw.link), digest: raw.digest ?? '',
    cover: raw.cover ?? '', author: raw.author ?? '', content: raw.content ?? '',
    publishTime: raw.publishTime ?? null, fetchedAt: raw.fetchedAt ?? null,
  }
}

/**
 * KV 后端：进程内 Map 副本 + 可选持久层。facility 为 null 时即纯内存后端（backend 'memory'）。
 * 与 sqlite 后端方法签名完全一致；upgrade() 供运行期 storage 服务可用后从内存升级。
 */
function openKvStore(facility) {
  const subs = new Map() // fakeid -> 订阅记录
  const arts = new Map() // String(id) -> 文章行
  const seqRef = { value: 0 }
  const core = { subs, arts, seqRef }
  let durable = facility ? createDurable(facility, core) : null

  const putSub = (rec) => durable?.put('subscriptions', rec.fakeid, rec)
  const delSub = (key) => durable?.delete('subscriptions', key)
  const putArt = (row) => durable?.put('articles', String(row.id), row)

  return {
    get backend() { return durable ? 'storage' : 'memory' },
    addSubscription({ fakeid, nickname, alias = '', headImg = '', category = '' }) {
      if (!fakeid) throw new RangeError('参数 fakeid 必填')
      const prev = subs.get(String(fakeid))
      const rec = {
        fakeid: String(fakeid), nickname: nickname ?? '', alias: alias ?? '',
        headImg: headImg ?? '', category: category || prev?.category || '',
        createdAt: prev?.createdAt ?? Date.now(), lastPoll: prev?.lastPoll ?? null,
      }
      subs.set(String(fakeid), rec)
      putSub(rec)
      return true
    },
    removeSubscription(fakeid) {
      if (!fakeid) throw new RangeError('参数 fakeid 必填')
      const existed = subs.delete(String(fakeid))
      if (existed) delSub(String(fakeid))
      return existed
    },
    listSubscriptions({ category } = {}) {
      const list = [...subs.values()].sort((a, b) => b.createdAt - a.createdAt)
      return category ? list.filter((s) => (s.category ?? '') === category) : list
    },
    setSubscriptionCategory(fakeid, category) {
      if (!fakeid) throw new RangeError('参数 fakeid 必填')
      const s = subs.get(String(fakeid))
      if (!s) return false
      s.category = String(category ?? '')
      putSub(s)
      return true
    },
    touchSubscription(fakeid, ts = Date.now()) {
      const s = subs.get(String(fakeid))
      if (!s) return
      s.lastPoll = ts
      putSub(s)
    },
    saveArticles(fakeid, articles) {
      if (!fakeid) throw new RangeError('参数 fakeid 必填')
      let added = 0
      const now = Date.now()
      for (const a of Array.isArray(articles) ? articles : []) {
        if (!a?.link) continue
        const dup = [...arts.values()].some((r) => r.fakeid === String(fakeid) && r.link === a.link)
        if (dup) continue
        const row = {
          id: ++seqRef.value, fakeid: String(fakeid), aid: a.aid ?? '', title: a.title ?? '',
          link: a.link, digest: a.digest ?? '', cover: a.cover ?? '', author: a.author ?? '',
          content: a.content ?? '', publishTime: a.publishTime ?? null, fetchedAt: now,
        }
        arts.set(String(row.id), row)
        putArt(row)
        added++
      }
      return added
    },
    listArticles(fakeid, { since = null, limit = 20 } = {}) {
      const rows = [...arts.values()]
        .filter((r) => (!fakeid || r.fakeid === String(fakeid))
          && (since === null || since === undefined || r.publishTime < since))
        .sort((a, b) => (b.publishTime ?? 0) - (a.publishTime ?? 0))
        .slice(0, limit)
      return {
        articles: rows.map(rowToArticle),
        nextSince: rows.length === limit ? rows[rows.length - 1].publishTime : null,
      }
    },
    getArticle(id) {
      const row = arts.get(String(id))
      return row ? toArticleWithMarkdown(row) : null
    },
    /** 等待域打开与持久层载入完成（内存后端立即落定）；供重启后首次读前调用。 */
    async ready() { await durable?.ready() },
    /** 内存后端运行期升级为 storage 域后端（storage 服务晚于 apply 可用时）。 */
    upgrade(storageLike) {
      if (durable) return false
      const nextFacility = resolveDomainFacility(storageLike)
      if (!nextFacility) return false
      durable = createDurable(nextFacility, core)
      return true
    },
    /** 有持久层时等待落盘并释放域；纯内存时无操作。 */
    close() { return durable ? durable.close() : undefined },
  }
}

/* ---------------------------------------------------------------- sqlite 后端 */

function openSqliteStore(db) {
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      fakeid TEXT PRIMARY KEY,
      nickname TEXT,
      alias TEXT,
      head_img TEXT,
      category TEXT NOT NULL DEFAULT '',
      created_at INTEGER,
      last_poll INTEGER
    );
    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fakeid TEXT NOT NULL,
      aid TEXT,
      title TEXT,
      link TEXT NOT NULL,
      digest TEXT,
      cover TEXT,
      author TEXT,
      content TEXT,
      publish_time INTEGER,
      fetched_at INTEGER,
      UNIQUE(fakeid, link)
    );
    CREATE INDEX IF NOT EXISTS idx_articles_fakeid_time
      ON articles(fakeid, publish_time DESC);
  `)
  // 旧库兼容：subscriptions 无 category 列时补上（默认 ''）。
  const subCols = db.prepare('PRAGMA table_info(subscriptions)').all().map((c) => c.name)
  if (!subCols.includes('category')) db.exec('ALTER TABLE subscriptions ADD COLUMN category TEXT NOT NULL DEFAULT \'\'')

  const stAddSub = db.prepare(
    'INSERT INTO subscriptions (fakeid,nickname,alias,head_img,category,created_at) VALUES (?,?,?,?,?,?) ' +
    'ON CONFLICT(fakeid) DO UPDATE SET nickname=excluded.nickname, alias=excluded.alias, head_img=excluded.head_img, ' +
    "category = CASE WHEN excluded.category <> '' THEN excluded.category ELSE subscriptions.category END")
  const stRemoveSub = db.prepare('DELETE FROM subscriptions WHERE fakeid = ?')
  const stListSubs = db.prepare('SELECT * FROM subscriptions ORDER BY created_at DESC')
  const stSetCategory = db.prepare('UPDATE subscriptions SET category = ? WHERE fakeid = ?')
  const stTouchPoll = db.prepare('UPDATE subscriptions SET last_poll = ? WHERE fakeid = ?')
  const stSave = db.prepare(
    'INSERT OR IGNORE INTO articles (fakeid,aid,title,link,digest,cover,author,content,publish_time,fetched_at) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?)')
  const stListArts = db.prepare(
    'SELECT * FROM articles WHERE fakeid = ? AND (? IS NULL OR publish_time < ?) ' +
    'ORDER BY publish_time DESC LIMIT ?')
  const stListArtsAll = db.prepare(
    'SELECT * FROM articles WHERE (? IS NULL OR publish_time < ?) ' +
    'ORDER BY publish_time DESC LIMIT ?')
  const stGetArt = db.prepare('SELECT * FROM articles WHERE id = ?')

  return {
    backend: 'sqlite',
    /** 新增/更新订阅（fakeid 重复时刷新昵称等信息）。 */
    addSubscription({ fakeid, nickname, alias = '', headImg = '', category = '' }) {
      if (!fakeid) throw new RangeError('参数 fakeid 必填')
      stAddSub.run(String(fakeid), nickname ?? '', alias ?? '', headImg ?? '', category ?? '', Date.now())
      return true
    },
    /** 取消订阅。返回是否确实删除了记录。 */
    removeSubscription(fakeid) {
      if (!fakeid) throw new RangeError('参数 fakeid 必填')
      return stRemoveSub.run(String(fakeid)).changes > 0
    },
    listSubscriptions({ category } = {}) {
      const list = stListSubs.all().map((r) => ({
        fakeid: r.fakeid, nickname: r.nickname, alias: r.alias,
        headImg: r.head_img, category: r.category ?? '',
        createdAt: r.created_at, lastPoll: r.last_poll,
      }))
      return category ? list.filter((s) => (s.category ?? '') === category) : list
    },
    setSubscriptionCategory(fakeid, category) {
      if (!fakeid) throw new RangeError('参数 fakeid 必填')
      return stSetCategory.run(String(category ?? ''), String(fakeid)).changes > 0
    },
    /** 标记轮询时间（index.js 用的方法名）。 */
    touchSubscription(fakeid, ts = Date.now()) {
      stTouchPoll.run(ts, String(fakeid))
    },
    /**
     * 批量入库，UNIQUE(fakeid,link) 去重。
     * @returns {number} 实际新增条数
     */
    saveArticles(fakeid, articles) {
      if (!fakeid) throw new RangeError('参数 fakeid 必填')
      let added = 0
      const now = Date.now()
      const tx = db.transaction((list) => {
        for (const a of list) {
          if (!a?.link) continue
          const r = stSave.run(
            String(fakeid), a.aid ?? '', a.title ?? '', a.link,
            a.digest ?? '', a.cover ?? '', a.author ?? '',
            a.content ?? '', a.publishTime ?? null, now)
          added += r.changes
        }
      })
      tx(Array.isArray(articles) ? articles : [])
      return added
    },
    /**
     * 按公众号列文章（publish_time 倒序），since 为上一页最后一篇的 publish_time（游标）。
     * @returns {{articles:object[], nextSince:number|null}}
     */
    listArticles(fakeid, { since = null, limit = 20 } = {}) {
      const rows = fakeid
        ? stListArts.all(String(fakeid), since, since, limit)
        : stListArtsAll.all(since, since, limit)
      return {
        articles: rows.map(rowToArticle),
        nextSince: rows.length === limit ? rows[rows.length - 1].publish_time : null,
      }
    },
    /**
     * 按主键取单篇（含现算 Markdown），供路由 getArticle 使用。
     * @returns {object|null}
     */
    getArticle(id) {
      const row = stGetArt.get(Number(id))
      return row ? toArticleWithMarkdown(row) : null
    },
    close() { db.close() },
  }
}

/* ---------------------------------------------------------------- 公共映射 */

function rowToArticle(r) {
  return {
    id: r.id, fakeid: r.fakeid, aid: r.aid, title: r.title, link: r.link,
    digest: r.digest, cover: r.cover, author: r.author,
    publishTime: r.publish_time ?? r.publishTime ?? null,
    publishTimeStr: tsToStr(r.publish_time ?? r.publishTime),
    fetchedAt: r.fetched_at ?? r.fetchedAt ?? null,
    sourceUrl: r.link,
  }
}

function toArticleWithMarkdown(r) {
  const a = rowToArticle(r)
  const content = r.content ?? ''
  return {
    id: a.id, title: a.title, author: a.author,
    publishTimeStr: a.publishTimeStr, link: a.link, sourceUrl: a.link,
    markdown: content.trim() ? htmlToMarkdown(content) : '',
  }
}

function tsToStr(ts) {
  if (!ts) return null
  return new Date(ts * 1000).toISOString()
}
