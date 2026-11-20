/**
 * 构建缓存 —— v3.0-P2（`uses: cache` 的后端）
 *
 * 为什么自己写而不是包一层 actions/cache：我们没有「每个 job 一份干净工作区」，
 * 缓存必须能和「同一个项目目录被反复用」共存，而且必须能被 `gc` 按 key 精确删掉。
 * 需求只有三件事：按 key 存取、支持 restore_keys 前缀回退、绝不跨项目串味。
 *
 * 目录布局：
 *   <cacheDir>/keys/<sha256(project\u0000key)>/
 *     meta.json          —— { project, key, createdAt, bytes, files, paths }
 *     files/<相对路径>    —— 命中的文件原样拷贝
 *
 * 用 sha256 而不是把 key 直接当目录名：key 里常有 `npm-${{hashFiles(...)}}` 展开出的
 * 斜杠、空格、`:`，在 Windows 上是非法文件名；哈希之后长度固定、跨平台安全。
 *
 * 安全边界：
 * - `paths` 只允许相对项目目录，或以 `~/` 开头的用户级目录（如 `~/.npm`），
 *   绝对路径一律拒绝 —— 否则 pipe.yml 里一句 `paths: ["/etc"]` 就能把宿主整个打包上传。
 * - 恢复时逐条校验目标路径仍落在允许的根里（防 `..` 穿越）。
 * - 不存符号链接，避免把宿主的链接关系带进构建。
 */

import {
  appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path'

export const CACHE_ERRORS = {
  PATH_INVALID: 'CACHE_PATH_INVALID',
  KEY_INVALID: 'CACHE_KEY_INVALID',
  SAVE: 'CACHE_SAVE_FAILED',
}

function cacheError(message, code = CACHE_ERRORS.SAVE, extra = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
  return error
}

const sha256 = (text) => createHash('sha256').update(String(text)).digest('hex')

/** 把一条 path 解析成「根目录 + 相对根的模式」。绝对路径直接拒绝。 */
export function resolvePathSpec(spec, { projectPath, home = homedir() }) {
  const text = String(spec || '').trim()
  if (!text) throw cacheError('cache 的 path 不能是空字符串', CACHE_ERRORS.PATH_INVALID)
  if (isAbsolute(text) || /^[A-Za-z]:[\\/]/.test(text)) {
    throw cacheError(`cache 的 path 必须是相对项目目录或以 ~/ 开头，不能是绝对路径：${text}`, CACHE_ERRORS.PATH_INVALID)
  }
  if (text === '~' || text.startsWith('~/') || text.startsWith('~\\')) {
    // `~/.npm` 这类用户级目录：单列一个根，恢复时同样受这个根约束
    return { root: home, pattern: text.slice(1).replace(/^[\\/]+/, ''), scope: 'home' }
  }
  if (text.split(/[\\/]/).includes('..')) {
    throw cacheError(`cache 的 path 不能含 ..：${text}`, CACHE_ERRORS.PATH_INVALID)
  }
  return { root: projectPath, pattern: text.replace(/^[\\/]+/, ''), scope: 'project' }
}

/** 极简 glob：只支持 `*`、`**`、`?`，与我们 `matchArtifacts` 的语义保持一致（同一个心智模型）。 */
function patternToRegExp(pattern) {
  const source = pattern.replace(/\\/g, '/')
  let regex = ''
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '*' && source[i + 1] === '*') {
      if (source[i + 2] === '/') { regex += '(?:.*/)?'; i += 2 } else { regex += '.*'; i += 1 }
    } else if (ch === '*') regex += '[^/]*'
    else if (ch === '?') regex += '[^/]'
    else regex += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${regex}$`)
}

/** 在 root 下按 pattern 找出所有普通文件（相对 root、正斜杠）。 */
export function expandPattern(root, pattern, { limit = 20000 } = {}) {
  const regex = patternToRegExp(pattern)
  const out = []
  // 模式的第一段可能本身就是通配，散步是最省事且不会漏的实现
  const visit = (dir, depth) => {
    if (out.length >= limit || depth > 16) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (out.length >= limit) return
      const full = join(dir, entry.name)
      const rel = relative(root, full).replace(/\\/g, '/')
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) { visit(full, depth + 1); continue }
      if (entry.isFile() && regex.test(rel)) out.push(rel)
    }
  }
  // 无通配符时直接检查，避免为了一条具体路径遍历整棵树
  if (!/[*?]/.test(pattern)) {
    const full = join(root, ...pattern.split('/'))
    try {
      if (existsSync(full) && statSync(full).isFile()) return [pattern]
      if (existsSync(full) && statSync(full).isDirectory()) {
        visit(full, 0)
        return out.map((rel) => rel)
      }
    } catch { return [] }
    return []
  }
  visit(root, 0)
  return out
}

function dirBytes(dir) {
  let total = 0
  const visit = (current, depth) => {
    if (depth > 16) return
    let entries
    try { entries = readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(current, entry.name)
      try {
        const stat = lstatSync(full)
        if (stat.isSymbolicLink()) continue
        if (stat.isDirectory()) visit(full, depth + 1)
        else if (stat.isFile()) total += stat.size
      } catch { /* 单个文件读不到不影响统计 */ }
    }
  }
  visit(dir, 0)
  return total
}

/**
 * 一次「缓存起了没有作用」的记录。
 *
 * 只记结论不记正文：命中率是「省了多少次下载/编译」的证据，而 key 里常含 hash，
 * 记全文会让台账迅速变成日志。带 projectId 是为了让多项目共用一个 workDir 时还分得清。
 */
const USAGE_FILE = 'usage.jsonl'
const USAGE_KEEP = 500

function emptyUsage() {
  return { exact: 0, prefix: 0, miss: 0, save: 0, saveFailed: 0, restoredBytes: 0, savedBytes: 0 }
}

function addUsage(bucket, entry) {
  const hit = String(entry?.result || entry?.event || '')
  if (hit === 'hit') {
    if (entry.exact === false) bucket.prefix += 1
    else bucket.exact += 1
    bucket.restoredBytes += Number(entry.bytes) || 0
  } else if (hit === 'miss') {
    bucket.miss += 1
  } else if (hit === 'save') {
    bucket.save += 1
    bucket.savedBytes += Number(entry.bytes) || 0
  } else if (hit === 'save-failed') {
    bucket.saveFailed += 1
  }
  return bucket
}

function usageRates(bucket) {
  const lookups = bucket.exact + bucket.prefix + bucket.miss
  return {
    lookups,
    // 唯一有意义的那个数：有多少次「本来要重新下载/编译」被缓存挡掉了。前缀命中单独算，
    // 因为它命中的是上一份 key 的缓存，价值真实但比精确命中低。
    hitRate: lookups > 0 ? Math.round(((bucket.exact + bucket.prefix) / lookups) * 10000) / 10000 : null,
    exactRate: lookups > 0 ? Math.round((bucket.exact / lookups) * 10000) / 10000 : null,
  }
}

export function createCacheStore({ dir, maxBytes = 2 * 1024 * 1024 * 1024, home = homedir(), now = Date.now } = {}) {
  if (!dir) throw cacheError('createCacheStore 需要 dir', CACHE_ERRORS.SAVE)
  const keysDir = join(dir, 'keys')
  mkdirSync(keysDir, { recursive: true })
  const usageFile = join(dir, USAGE_FILE)

  /**
   * 记一条使用记录并返回它。写盘失败只吞掉——台账坏了不该让构建失败，
   * 这和 cache.save 的软失败是同一个原则。
   */
  function record(entry) {
    const row = { at: new Date(now()).toISOString(), project: entry.projectId || '', ...entry }
    try {
      appendFileSync(usageFile, `${JSON.stringify(row)}\n`)
      // 台账只保留最近 USAGE_KEEP 行：它是「最近的命中率」，不是审计账本。
      const lines = readFileSync(usageFile, 'utf8').split(`\n`).filter(Boolean)
      if (lines.length > USAGE_KEEP * 2) writeFileSync(usageFile, `${lines.slice(-USAGE_KEEP).join('\n')}\n`)
    } catch { /* best effort */ }
    return row
  }

  /**
   * 命中率汇总。`days` 是最近窗口（默认 30 天），`projectId` 为空表示全部项目。
   *
   * 除了总体，还按 key 前缀分组：一个项目的缓存常年 0% 命中，往往不是「机器慢」，
   * 而是 key 里混进了每次都会变的东西（时间戳、随机 sha）——分组之后一眼能看出是哪一族 key 从不命中。
   */
  function stats({ projectId = '', days = 30 } = {}) {
    const windowDays = Number.isInteger(days) ? Math.max(1, Math.min(365, days)) : 30
    const from = now() - windowDays * 24 * 60 * 60 * 1000
    const total = emptyUsage()
    const byPrefix = new Map()
    const byProject = new Map()
    let samples = 0
    let lines = []
    try { lines = readFileSync(usageFile, 'utf8').split('\n').filter(Boolean) } catch { lines = [] }
    for (const line of lines) {
      let row
      try { row = JSON.parse(line) } catch { continue }
      const at = Date.parse(String(row.at || ''))
      if (!Number.isFinite(at) || at < from) continue
      if (projectId && row.project !== projectId) continue
      samples += 1
      addUsage(total, row)
      const key = String(row.key || '')
      // 前缀取到第一个变量分隔符为止：`npm-<hash>` 与 `npm-<other>` 应归成一组。
      const prefix = key.split(/[-:/]/)[0] || '(empty)'
      byPrefix.set(prefix, addUsage(byPrefix.get(prefix) || emptyUsage(), row))
      const project = row.project || '(none)'
      byProject.set(project, addUsage(byProject.get(project) || emptyUsage(), row))
    }
    // 分组名放在 key 上：bucket 里本来就有一个叫 prefix 的计数器（前缀命中次数），
    // 用 prefix 当分组名会把它覆盖掉，「前缀命中数 === 0」的判断随后永远不成立，冷族永远是空的。
    const decorate = ([key, bucket]) => ({ key, ...bucket, ...usageRates(bucket), hitBytes: bucket.restoredBytes })
    const prefixes = [...byPrefix.entries()].map(decorate).sort((a, b) => b.lookups - a.lookups)
    const projects = [...byProject.entries()].map(decorate).sort((a, b) => b.lookups - a.lookups)
    // 「从不命中」的 key 族：样本够多（≥3）却一次都没命过，这才是需要改 key 的那一族。
    const coldPrefixes = prefixes.filter((item) => item.lookups >= 3 && item.exact === 0 && item.prefix === 0)
    return {
      ok: true,
      windowDays,
      from: new Date(from).toISOString(),
      to: new Date(now()).toISOString(),
      samples,
      entries: listKeys(projectId).length,
      ...total,
      ...usageRates(total),
      hitBytes: total.restoredBytes,
      prefixes,
      projects,
      coldPrefixes,
    }
  }

  const entryDir = (projectId, key) => join(keysDir, sha256(`${projectId}\u0000${key}`))

  function readMeta(projectId, key) {
    const file = join(entryDir(projectId, key), 'meta.json')
    if (!existsSync(file)) return null
    try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
  }

  /**
   * 恢复。先找精确 key，再按 restore_keys 顺序找「同前缀的最新一份」——
   * 这是 GitHub 的语义，也是真正有用的那部分：依赖缓存没有完全命中时，旧的也远好过没有。
   */
  async function restore({ projectId = '', projectPath = '', key, paths = [], restoreKeys = [] }) {
    if (!key) throw cacheError('cache.restore 需要 key', CACHE_ERRORS.KEY_INVALID)
    const candidates = [key, ...restoreKeys]
    for (const candidate of candidates) {
      const exact = candidate === key
      // 精确命中时只有一个 key；restore_keys 时是「所有同前缀的 key，新的在前」。
      // 两种都必须归一成 key 字符串，否则精确分支拿到 string、前缀分支拿到对象，readMeta 会读到 undefined。
      const entries = exact
        ? [candidate]
        : listKeys(projectId).filter((item) => item.key.startsWith(candidate)).map((item) => item.key)
      for (const entry of entries) {
        const meta = readMeta(projectId, entry)
        if (!meta) continue
        const filesDir = join(entryDir(projectId, entry), 'files')
        if (!existsSync(filesDir)) continue
        let restored = 0
        // meta.files 是「文件个数」（人看的），meta.entries 才是清单。
        // 早先这里读的是 meta.files，于是恢复时拿到一个数字，`for...of` 直接抛
        // “number is not iterable”——缓存永远恢复不出来，而且日志里只说「未命中」。
        for (const file of meta.entries || []) {
          const spec = file.scope === 'home'
            ? { root: home, pattern: file.path, scope: 'home' }
            : { root: projectPath, pattern: file.path, scope: 'project' }
          const target = safeTarget(spec.root, spec.pattern)
          const source = join(filesDir, `${file.scope}-${sha256(file.path).slice(0, 16)}`)
          if (!existsSync(source)) continue
          try {
            mkdirSync(join(target, '..'), { recursive: true })
            cpSync(source, target)
            restored += 1
          } catch { /* 单个文件恢复失败不该让整次构建失败 */ }
        }
        if (restored === 0) continue
        // 命中率要能回答「省了多少」，所以一次命中在台账里是一行（含字节数），
        // 不是只加一个计数器——计数器回答不了「这周比上周省得多吗」。
        record({ result: 'hit', key: entry, exact, bytes: meta.bytes || 0, files: restored, projectId })
        return { hit: true, key: entry, exact, bytes: meta.bytes || 0, files: restored }
      }
    }
    record({ result: 'miss', key, exact: false, bytes: 0, files: 0, projectId })
    return { hit: false, key, exact: false, bytes: 0, files: 0 }
  }

  /** path 里的 `..` 已经在校验阶段拒绝，这里再兜一层：解析结果必须仍在 root 内。 */
  function safeTarget(root, pattern) {
    const resolvedRoot = resolvePath(root)
    const target = resolvePath(resolvedRoot, ...pattern.split('/'))
    const rel = relative(resolvedRoot, target)
    if (rel.startsWith('..') || (rel !== '' && isAbsolute(rel))) {
      throw cacheError(`cache 的目标路径越出了允许的根：${pattern}`, CACHE_ERRORS.PATH_INVALID)
    }
    return target
  }

  /** 保存。返回 `{ok, key, bytes, files}`；失败不抛（缓存坏了不该让构建失败）。 */
  async function save({ projectId = '', projectPath = '', key, paths = [] }) {
    if (!key) throw cacheError('cache.save 需要 key', CACHE_ERRORS.KEY_INVALID)
    // 路径校验放在 try 之外：`paths: ["/etc"]` 是配置错误（甚至是攻击），必须炸得很响；
    // 而 try 里面的失败是「缓存没存上」——那才是软失败，不该让构建挂掉。
    // 两件事混在一个 catch 里，写错的路径会被降级成一行日志，用户永远不知道自己在打包宿主目录。
    const specs = paths.map((spec) => resolvePathSpec(spec, { projectPath, home }))
    const target = entryDir(projectId, key)
    const staging = `${target}.tmp-${process.pid}-${Math.floor(Math.random() * 1e6)}`
    try {
      const files = []
      const filesDir = join(staging, 'files')
      mkdirSync(filesDir, { recursive: true })
      for (const parsed of specs) {
        for (const rel of expandPattern(parsed.root, parsed.pattern)) {
          const source = join(parsed.root, ...rel.split('/'))
          const slot = join(filesDir, `${parsed.scope}-${sha256(rel).slice(0, 16)}`)
          mkdirSync(join(slot, '..'), { recursive: true })
          cpSync(source, slot)
          files.push({ scope: parsed.scope, path: rel })
        }
      }
      if (files.length === 0) {
        rmSync(staging, { recursive: true, force: true })
        record({ result: 'save-failed', key, bytes: 0, files: 0, projectId, error: '没有匹配到任何文件' })
      return { ok: false, key, bytes: 0, files: 0, error: '没有匹配到任何文件' }
      }
      const bytes = dirBytes(filesDir)
      if (bytes > maxBytes) {
        rmSync(staging, { recursive: true, force: true })
        record({ result: 'save-failed', key, bytes, files: 0, projectId, error: `缓存体积 ${bytes} 超过上限 ${maxBytes}` })
        return { ok: false, key, bytes, files: 0, error: `缓存体积 ${bytes} 超过上限 ${maxBytes}` }
      }
      // files 存个数、entries 存清单：两者同名最容易踩「数字当数组遍历」，
      // 这里刻意用两个键，并在 restore 里明确读 entries。
      writeFileSync(join(staging, 'meta.json'), `${JSON.stringify({ project: projectId, key, createdAt: new Date().toISOString(), bytes, files: files.length, paths, entries: files }, null, 2)}\n`)
      // 原子提交：先删旧条目再 rename，避免「写了一半的缓存被当成命中」
      rmSync(target, { recursive: true, force: true })
      renameSync(staging, target)
      record({ result: 'save', key, bytes, files: files.length, projectId })
      return { ok: true, key, bytes, files: files.length }
    } catch (error) {
      try { rmSync(staging, { recursive: true, force: true }) } catch { /* 清理尽力而为 */ }
      record({ result: 'save-failed', key, bytes: 0, files: 0, projectId, error: String(error.message || error).slice(0, 200) })
      return { ok: false, key, bytes: 0, files: 0, error: error.message }
    }
  }

  /** 按 key 前缀列出条目（restore_keys 与 gc 用）。 */
  function listKeys(projectId = '') {
    const out = []
    let entries = []
    try { entries = readdirSync(keysDir, { withFileTypes: true }) } catch { return out }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const file = join(keysDir, entry.name, 'meta.json')
      if (!existsSync(file)) continue
      let parsed
      try { parsed = JSON.parse(readFileSync(file, 'utf8')) } catch { continue }
      if (projectId && parsed.project !== projectId) continue
      out.push({ hash: entry.name, key: parsed.key, project: parsed.project, createdAt: parsed.createdAt, bytes: parsed.bytes || 0 })
    }
    out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    return out
  }

  /** 删条目。不给 key 时删掉该项目全部条目。 */
  function remove({ projectId = '', key = '' } = {}) {
    let removed = 0
    for (const entry of listKeys(projectId)) {
      if (key && entry.key !== key) continue
      rmSync(join(keysDir, entry.hash), { recursive: true, force: true })
      removed += 1
    }
    return removed
  }

  /** 体积超限时按「最久没用」删到限额内。 */
  function gc({ maxBytes: limit = maxBytes, projectId = '' } = {}) {
    const entries = listKeys(projectId)
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0)
    let removed = 0
    for (const entry of [...entries].reverse()) {
      if (total <= limit) break
      rmSync(join(keysDir, entry.hash), { recursive: true, force: true })
      total -= entry.bytes
      removed += 1
    }
    return { removed, bytes: total }
  }

  return { dir, keysDir, restore, save, list: listKeys, remove, gc, entryDir, stats, record }
}
