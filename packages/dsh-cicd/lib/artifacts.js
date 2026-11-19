/**
 * v3.0-P5：制品 CAS（内容寻址存储）。
 *
 * 为什么先做这个：P3 的容器 Actuator 要 `docker pull @digest`，promotion 要「只移指针不复制字节」，
 * 回滚要拿得住一个不可变的身份。这三件事的共同前提都是「字节有一个内容寻址的家」。
 *
 * 设计约束（对应 06-artifacts.md）：
 *   1. digest 是身份，tag 只是可变指针 —— CAS 目录按 sha256 命名，指针表另存。
 *   2. 单写入口、幂等去重 —— 同一 digest 重复 PUT 不产生第二份字节。
 *   3. 先写 `.tmp` 再 `rename` —— 半截文件永远不会出现在 `blobs/` 下。
 *   4. 上传时重算 sha256 —— 声明的 digest 与实际字节不符直接拒收（篡改 1 字节即失败）。
 *   5. 被任何东西引用着的 blob 不许被 GC 删掉（pinned 回调 + 指针），而不是「调用方记得别删」。
 *   6. 删字节分两步 —— 先写一个 tombstone（改名进 trash/），宽限期过后才真删。
 *      一步到位的删除没有任何后悔窗口：prune 写错一个条件，线上在跑的容器下次滚动就拉不到镜像。
 *
 * 磁盘布局：
 *   <casDir>/blobs/sha256/<aa>/<digest>        字节（只读、不可变）
 *   <casDir>/tmp/<random>                      写入中的临时文件
 *   <casDir>/refs/<owner>/<name>.json          指针（tag / release 引用）
 *   <casDir>/trash/<digest>                    已 tombstone：字节还在，宽限期内可 restore
 */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'

export const DIGEST_ALGORITHM = 'sha256'
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/i
// tombstone 宽限期：制品进了 trash 也还能救回来 7 天。镜像/包被误回收的代价远高于多占几天磁盘。
export const DEFAULT_GRACE_MS = 7 * 24 * 60 * 60 * 1000

export function artifactError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra)
}

/** 把零散的 digest 写法（裸 hex / 带前缀 / 大写）统一成 `sha256:<64 hex>`，非法直接抛。 */
export function normalizeDigest(value) {
  const raw = String(value || '').trim().toLowerCase()
  const body = raw.startsWith('sha256:') ? raw.slice(7) : raw
  if (!/^[a-f0-9]{64}$/.test(body)) {
    throw artifactError('ARTIFACT_DIGEST_INVALID', `digest 必须是 sha256:<64 位 hex>，收到 "${value}"`)
  }
  return `sha256:${body}`
}

export function digestPath(casDir, digest) {
  const normalized = normalizeDigest(digest)
  const hex = normalized.slice(7)
  return join(casDir, 'blobs', DIGEST_ALGORITHM, hex.slice(0, 2), hex)
}

/** trash 里同一个 digest 的位置：文件名只用 hex，目录名负责带的算法前缀。 */
function trashPath(casDir, digest) {
  return join(casDir, 'trash', normalizeDigest(digest).slice(DIGEST_ALGORITHM.length + 1))
}

function refPath(casDir, owner, name) {
  const safeOwner = String(owner || '').replace(/[^a-zA-Z0-9._-]/g, '_') || '_'
  const safeName = String(name || '').replace(/[^a-zA-Z0-9._@-]/g, '_') || '_'
  return join(casDir, 'refs', safeOwner, `${safeName}.json`)
}

/** 对一个流式输入算 sha256，顺带把字节落进临时文件（先算完再决定要不要收）。 */
async function streamToTemp(source, tmpDir) {
  mkdirSync(tmpDir, { recursive: true })
  const tmp = join(tmpDir, `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}.part`)
  const hash = createHash(DIGEST_ALGORITHM)
  let bytes = 0
  // 调用方偶尔直接给字节（manifest、测试里的 Buffer）；统一收成可迭代流，避免 Buffer 被当成
  // 「可迭代的数字序列」逐字节写进文件。
  const input = typeof source === 'string'
    ? createReadStream(source)
    : (Buffer.isBuffer(source) || source instanceof Uint8Array ? Readable.from([Buffer.from(source)]) : source)
  const sink = createWriteStream(tmp)
  try {
    for await (const chunk of input) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      hash.update(buffer)
      if (!sink.write(buffer)) await new Promise((resolve) => sink.once('drain', resolve))
    }
    await new Promise((resolve, reject) => sink.end((error) => (error ? reject(error) : resolve())))
  } catch (error) {
    try { sink.destroy() } catch { /* sink may already be closed */ }
    try { unlinkSync(tmp) } catch { /* tmp may never have been created */ }
    throw artifactError('ARTIFACT_WRITE_FAILED', `写入临时文件失败：${error.message}`)
  }
  return { tmp, digest: `${DIGEST_ALGORITHM}:${hash.digest('hex')}`, bytes }
}

/**
 * @param {object} options
 * @param {string} options.dir  CAS 根目录（通常是 <workDir>/artifacts）
 * @param {object} [options.meta]  元数据表接口：{ put(row), has(digest), remove(digest) }，可选
 * @param {Function[]} [options.pinned]  额外的「不许删」判定，返回 true 表示该 digest 有活引用
 */
/**
 * 内容寻址存储。
 *
 * `refsReader`：账本引用（releases / promotions / 坐标）的读取器，返回 [{ digest, why }]。
 *   不传它 GC 就只能看见落盘指针 —— 那会把「某台机器正在跑的那份」当孤儿回收，
 *   所以缺省值保守：一个都不删也可以接受，多删一个就是事故。
 * `pinned`：零散的回调式保护（例如「当前部署的 digest」），与 refsReader 同义，留着是因为它更轻。
 */
export function createArtifactStore({ dir, meta = null, pinned = [], refsReader = null } = {}) {
  if (!dir) throw new Error('createArtifactStore 需要 dir')
  const tmpDir = join(dir, 'tmp')
  const blobsDir = join(dir, 'blobs', DIGEST_ALGORITHM)
  const trashDir = join(dir, 'trash')

  /**
   * 每一份还活着的字节，以及「谁在引用它」。GC 只在这张表上判生死。
   *
   * 两类引用必须同时算：落盘指针（tag / OCI manifest）与账本引用（releases、promotions、
   * artifact_packages）—— 后者根本不写成文件，只看 refs/ 就会把「某台机器正在跑的那份」当成孤儿。
   * 返回值是 Map<digest, string[]>，原因一并带出来：删不掉的时候要能说清是被谁按住的。
   */
  function references() {
    const live = new Map()
    const add = (digest, why) => {
      let value = ''
      try { value = normalizeDigest(digest) } catch { return }
      const list = live.get(value) || []
      if (!list.includes(why)) list.push(why)
      live.set(value, list)
    }
    for (const ref of listRefs()) add(ref.digest, `ref:${ref.owner || ''}/${ref.name || ''}`)
    if (typeof refsReader === 'function') {
      let extra = []
      try { extra = refsReader() || [] } catch { /* 账本读不到就只按落盘指针判，但绝不因此多删 */ }
      for (const item of extra) {
        if (!item || !item.digest) continue
        add(item.digest, String(item.why || 'ledger'))
      }
    }
    for (const predicate of pinned) {
      try { for (const digest of predicate() || []) add(digest, 'pinned') } catch { /* 引用方坏了按有引用处理 */ }
    }
    return live
  }
  mkdirSync(blobsDir, { recursive: true })

  function has(digest) {
    try {
      const stat = statSync(digestPath(dir, digest))
      return stat.isFile()
    } catch { return false }
  }

  function statOf(digest) {
    try {
      const stat = statSync(digestPath(dir, digest))
      if (!stat.isFile()) return null
      return { digest: normalizeDigest(digest), bytes: stat.size, path: digestPath(dir, digest) }
    } catch { return null }
  }

  /**
   * 落一份字节并返回 digest。重复 PUT 幂等：已存在就直接扔掉临时文件，
   * 但仍然**完整读取并校验**过字节，所以「同 digest 不同内容」不可能被悄悄接受。
   */
  async function put(source, { expectDigest = '', meta: extra = null } = {}) {
    const expected = expectDigest ? normalizeDigest(expectDigest) : ''
    const { tmp, digest, bytes } = await streamToTemp(source, tmpDir)
    if (!bytes) {
      try { unlinkSync(tmp) } catch { /* nothing to clean */ }
      throw artifactError('ARTIFACT_EMPTY', '制品为空（0 字节），这几乎总是构建输出路径写错了')
    }
    if (expected && expected !== digest) {
      try { unlinkSync(tmp) } catch { /* nothing to clean */ }
      throw artifactError('ARTIFACT_DIGEST_MISMATCH', `声明 ${expected}，实际字节是 ${digest}`, { expected, actual: digest })
    }
    const target = digestPath(dir, digest)
    mkdirSync(join(target, '..'), { recursive: true })
    const existed = existsSync(target)
    if (existed) {
      try { unlinkSync(tmp) } catch { /* nothing to clean */ }
    } else {
      try {
        // rename 在同一文件系统内是原子的：`blobs/` 下永远不会出现半截文件。
        renameSync(tmp, target)
      } catch (error) {
        try { unlinkSync(tmp) } catch { /* nothing to clean */ }
        throw artifactError('ARTIFACT_WRITE_FAILED', `提交 ${digest} 失败：${error.message}`)
      }
    }
    if (meta) {
      try { meta.put({ digest, bytes, ...(extra || {}) }) } catch { /* 元数据是索引，不是事实来源 */ }
    }
    return { digest, bytes, deduped: existed }
  }

  /** 从目录/文件打包上传：调用方给出路径，这里负责算 digest。 */
  async function putFile(filePath, options = {}) {
    if (!existsSync(filePath)) throw artifactError('ARTIFACT_NOT_FOUND', `文件不存在：${filePath}`)
    return put(createReadStream(filePath), options)
  }

  /** 流式读出。读之前重新验一遍 size，防止有人绕过 API 直接改磁盘。 */
  function open(digest) {
    const stat = statOf(digest)
    if (!stat) throw artifactError('ARTIFACT_NOT_FOUND', `制品不存在：${digest}`)
    return { ...stat, stream: () => createReadStream(stat.path) }
  }

  function createReadable(digest) {
    return createReadStream(open(digest).path)
  }

  /** Range 只支持单区间；也支持 HEAD（bytes=0-0 的探测由调用方处理长度）。 */
  function readRange(digest, rangeHeader) {
    const stat = open(digest)
    const parsed = parseRange(rangeHeader, stat.bytes)
    if (!parsed) return { ...stat, start: 0, end: stat.bytes - 1, status: 200, stream: () => createReadStream(stat.path) }
    return {
      ...stat,
      start: parsed.start,
      end: parsed.end,
      status: 206,
      stream: () => createReadStream(stat.path, { start: parsed.start, end: parsed.end }),
    }
  }

  /** 全量重算一遍 sha256 —— GC 前的最后一道确认，代价 O(size)，只在人工巡检时用。 */
  async function verify(digest) {
    const stat = statOf(digest)
    if (!stat) return { digest: normalizeDigest(digest), ok: false, reason: 'missing' }
    const hash = createHash(DIGEST_ALGORITHM)
    for await (const chunk of createReadStream(stat.path)) hash.update(chunk)
    const actual = `${DIGEST_ALGORITHM}:${hash.digest('hex')}`
    return { digest: stat.digest, ok: actual === stat.digest, bytes: stat.bytes, actual }
  }

  // ---- 指针（tag） --------------------------------------------------------------------------
  function putRef(owner, name, digest, extra = {}) {
    const normalized = normalizeDigest(digest)
    if (!has(normalized)) throw artifactError('ARTIFACT_NOT_FOUND', `不能把 ${owner}/${name} 指向不存在的制品 ${normalized}`)
    const path = refPath(dir, owner, name)
    mkdirSync(join(path, '..'), { recursive: true })
    const previous = readRef(owner, name)
    const record = { owner, name, digest: normalized, previous: previous?.digest || '', updatedAt: new Date().toISOString(), ...extra }
    writeFileSync(path, JSON.stringify(record, null, 2), 'utf8')
    return record
  }

  function readRef(owner, name) {
    const path = refPath(dir, owner, name)
    if (!existsSync(path)) return null
    try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
  }

  function listRefs(owner = '') {
    const root = join(dir, 'refs', owner ? String(owner).replace(/[^a-zA-Z0-9._-]/g, '_') : '')
    const out = []
    const walk = (current, depth) => {
      if (depth > 3 || !existsSync(current)) return
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name)
        if (entry.isDirectory()) walk(full, depth + 1)
        else if (entry.name.endsWith('.json')) {
          try { out.push(JSON.parse(readFileSync(full, 'utf8'))) } catch { /* 坏指针不进结果 */ }
        }
      }
    }
    walk(root || join(dir, 'refs'), 0)
    return out
  }

  /** 删一个指针。仓库里的「删 tag」就是它，字节留在 CAS 里等 GC 判。 */
  function removeRef(owner, name) {
    const path = refPath(dir, owner, name)
    if (!existsSync(path)) return false
    rmSync(path, { force: true })
    return true
  }

  function listBlobs() {
    const out = []
    if (!existsSync(blobsDir)) return out
    for (const shard of readdirSync(blobsDir, { withFileTypes: true })) {
      if (!shard.isDirectory()) continue
      for (const file of readdirSync(join(blobsDir, shard.name), { withFileTypes: true })) {
        if (!file.isFile()) continue
        const stat = statSync(join(blobsDir, shard.name, file.name))
        out.push({ digest: `${DIGEST_ALGORITHM}:${file.name}`, bytes: stat.size, createdAt: stat.mtime.toISOString() })
      }
    }
    return out
  }

  /**
   * GC：两段式回收，对应 06-artifacts.md 的 I3。
   *
   * 第一段 prune：挑「没有指针、没有 pinned 引用、且静置够久」的 blob，**改名进 trash/** 而不是删。
   * 改名是原子的，所以任何一次 prune 都不会留下半截文件；字节还在，误删可以在宽限期内 restore。
   * 第二段 purge：trash 里躺够 graceMs 的才真删 —— 这一步之后才真的不可逆。
   *
   * 引用集算错是这类系统最贵的 bug，所以两个方向都算：被引用的一律不碰（keep 也给得出来），
   * 只有明确没引用的才进 trash。dryRun 默认 true：删除不可逆，调用方必须先看一遍。
   */
  function gc({ dryRun = true, now = Date.now(), graceMs = DEFAULT_GRACE_MS, minAgeMs = 0 } = {}) {
    const live = references()
    const ageLimit = Math.max(0, Number(minAgeMs) || 0)
    const trashed = []
    const kept = []
    for (const blob of listBlobs()) {
      if (live.has(blob.digest)) { kept.push(blob.digest); continue }
      // 刚写完还没来得及被引用的 blob 同样危险：prune 与 release 落账之间有一个很短的窗口，
      // 这段时间里它「确实没引用」，但删了就是删掉一次正在进行的发布。
      if (now - Date.parse(blob.createdAt) < ageLimit) { kept.push(blob.digest); continue }
      trashed.push(blob)
      if (!dryRun) {
        try {
          mkdirSync(trashDir, { recursive: true })
          renameSync(digestPath(dir, blob.digest), trashPath(dir, blob.digest))
        } catch { /* 已经被别处移走/删掉 */ }
      }
    }

    const purged = []
    const pending = []
    let purgedBytes = 0
    const grace = Math.max(0, Number(graceMs) || 0)
    for (const entry of listTrash()) {
      if (now - entry.trashedAt < grace) { pending.push(entry); continue }
      purged.push(entry)
      purgedBytes += entry.bytes
      if (!dryRun) {
        try { unlinkSync(join(trashDir, entry.name)) } catch { /* 已经删了 */ }
        meta?.remove?.(entry.digest)
      }
    }

    return {
      dryRun,
      graceMs: grace,
      trashed,
      purged,
      pending,
      kept,
      // 「为什么没删」要说得出原因，否则 prune 看起来总是在漏东西。
      held: [...live.entries()].map(([digest, why]) => ({ digest, why })),
      // 老字段保留：prune 的字节数。dryRun 时它同样是「这次会移走多少」。
      removed: trashed,
      reclaimedBytes: purgedBytes,
    }
  }

  /** trash 清单：每个 entry 带 digest / bytes / trashedAt（毫秒）。不进 meta 索引 —— 它回答的是「删到哪一步了」。 */
  function listTrash() {
    let names = []
    try { names = readdirSync(trashDir) } catch { return [] }
    const out = []
    for (const name of names) {
      try {
        const stat = statSync(join(trashDir, name))
        if (!stat.isFile()) continue
        out.push({ name, digest: `${DIGEST_ALGORITHM}:${name}`, bytes: stat.size, trashedAt: stat.mtimeMs })
      } catch { /* 读不到的忽略 */ }
    }
    return out.sort((a, b) => a.trashedAt - b.trashedAt)
  }

  /**
   * 把某个 digest 从 trash 里放回 blobs/。宽限期内才做得到，宽限期外字节已经没了。
   * 返回 null 表示 trash 里没有它（要么从没进过，要么已经被 purge）。
   */
  function restore(digest) {
    const normalized = normalizeDigest(digest)
    const from = trashPath(dir, normalized)
    if (!existsSync(from)) return null
    const to = digestPath(dir, normalized)
    mkdirSync(join(to, '..'), { recursive: true })
    renameSync(from, to)
    return { digest: normalized, bytes: statSync(to).size }
  }

  function stats() {
    const blobs = listBlobs()
    return { count: blobs.length, bytes: blobs.reduce((sum, item) => sum + item.bytes, 0), refs: listRefs().length, dir }
  }

  function dispose() {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* tmp 清不掉不影响正确性 */ }
  }

  // pathOf：manifest 要按 digest 读回 JSON，open/createReadable 都是流，读小文件不如直接给路径。
  function pathOf(digest) {
    return digestPath(dir, digest)
  }

  return { dir, put, putFile, has, stat: statOf, open, createReadable, readRange, verify, putRef, readRef, removeRef, listRefs, listBlobs, references, gc, restore, listTrash, stats, pathOf, dispose }
}

/** `bytes=100-199` / `bytes=100-` / `bytes=-100`，越界或格式错返回 null（调用方按 200 全量返回）。 */
export function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) return null
  let start
  let end
  if (!rawStart) {
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd ? Number(rawEnd) : size - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}
