/**
 * 构建工具链（v3.0-P2）：把「项目声明 java: temurin-17」变成「这次构建的子进程里 java 就是 17」。
 *
 * ## 为什么不用 nvm / pyenv / SDKMAN
 *
 * 那些工具都是「改当前 shell 的环境」：`source nvm.sh` 改的是**交互式 shel​l** 的 PATH，
 * `nvm use` 在 Windows 还要管理员权限建符号链接。而我们是 `spawn(shell:true)` 起非交互进程，
 * 拿不到任何被 source 过的状态——所以在它们身上接线只会得到「本机跑得好、runner 上莫名用宿主版本」。
 *
 * 我们只抄它们的**声明格式**（`.nvmrc` / `.python-version` / `.tool-versions`）和
 * **锁文件**思路（每平台一条 URL + checksum），解析、下载、校验、注入全部自己做。
 *
 * ## 四段式
 *
 *   resolve(spec)  → { lang, version, platforms: { 'linux-x64': {url, sha256} } }
 *   install(item)  → CAS 目录 + .ok 标记（mkdir 锁 + .tmp + rename 原子提交）
 *   envFor(items)  → 只改子进程 env，不碰宿主
 *   assertVersions → `java -version` 输出必须含 17.，否则 fail fast
 *
 * ## 三条硬约束
 *
 * 1. **pipe.yml 只允许 vendor + 版本号，不允许 URL**：pipe.yml 是 PR 可改的文件，
 *    放开 URL 等于让每个能提交代码的人在构建机上执行任意二进制。
 * 2. **校验失败 fail closed**：绝不「先装上再说」。供应链投毒的唯一防线就是 checksum。
 * 3. **不改宿主**：不写 shell rc、不建全局链接、不 `export`。父进程的环境在构建前后必须一致。
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 支持的语言。新增一门语言必须同时加 provider、binDir 规则与版本断言参数。 */
export const LANGS = ['java', 'maven', 'gradle', 'node', 'python', 'php', 'go']

export const TOOLCHAIN_ERRORS = {
  SPEC_INVALID: 'TOOLCHAIN_SPEC_INVALID',
  NOT_FOUND: 'TOOLCHAIN_NOT_FOUND',
  CHECKSUM: 'TOOLCHAIN_CHECKSUM',
  LOCK_MISSING: 'TOOLCHAIN_LOCK_MISSING',
  OFFLINE: 'TOOLCHAIN_OFFLINE',
  DOWNLOAD: 'TOOLCHAIN_DOWNLOAD',
  EXTRACT: 'TOOLCHAIN_EXTRACT',
  VERSION_MISMATCH: 'TOOLCHAIN_VERSION_MISMATCH',
}

function toolchainError(message, code, extra = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
  return error
}

/** 当前平台标识，锁文件按它分条。取值与 Node 官方分发包命名一致，便于直接拼 URL。 */
export function currentPlatform(platform = process.platform, arch = process.arch) {
  const os = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux'
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'ia32' ? 'x86' : 'x64'
  return `${os}-${cpu}`
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * 支持的校验算法。Maven 只发布 `.sha512`，Node 只发布 `SHASUMS256.txt`，
 * 所以内部统一写成 `algo:hex`，安装时按 algo 重算——只认 sha256 会逼我们对 maven 放弃校验。
 */
export const CHECKSUM_ALGOS = ['sha256', 'sha512', 'sha1']

/** 把 `sha512:abc…` / `sha256:abc…` / 裸 hex（按 64 位视为 sha256）拆成 `{algo, hex}`。 */
export function parseChecksum(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  const prefixed = /^(sha256|sha512|sha1):([0-9a-f]+)$/i.exec(text)
  if (prefixed) return { algo: prefixed[1].toLowerCase(), hex: prefixed[2].toLowerCase() }
  const bare = /^([0-9a-f]+)$/i.exec(text)
  if (!bare) return null
  const hex = bare[1].toLowerCase()
  if (hex.length === 64) return { algo: 'sha256', hex }
  if (hex.length === 128) return { algo: 'sha512', hex }
  if (hex.length === 40) return { algo: 'sha1', hex }
  return null
}

export function hashFile(file, algo = 'sha256') {
  return createHash(algo).update(readFileSync(file)).digest('hex')
}

/* ------------------------------------------------------------------------------------------------
 * 并发锁：用 mkdir 的原子性，不用 flock
 *
 * flock 在 Windows 上没有原生等价物（Node 也没暴露），而 mkdir 在两个平台上都是原子的。
 * 锁目录里写 owner.json 记录 pid 与时间，超过 staleMs 视为崩溃残留可强夺——否则一次
 * Ctrl-C 会让同版本永久装不上。
 * ---------------------------------------------------------------------------------------------- */

export function mkdirLock(lockDir, { timeoutMs = 120000, staleMs = 600000, now = Date.now } = {}) {
  const ownerFile = join(lockDir, 'owner.json')
  const started = now()
  for (;;) {
    try {
      mkdirSync(lockDir, { recursive: false })
      try {
        writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, at: new Date(now()).toISOString() }))
      } catch { /* owner 文件只是诊断信息 */ }
      let released = false
      return () => {
        if (released) return
        released = true
        try { rmSync(lockDir, { recursive: true, force: true }) } catch { /* best effort */ }
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let stale = false
      try {
        const stat = statSync(lockDir)
        stale = now() - stat.mtimeMs > staleMs
      } catch { /* 对方刚释放，下一轮会拿到 */ }
      if (stale) {
        try { rmSync(lockDir, { recursive: true, force: true }) } catch { /* 抢不到就继续等 */ }
        continue
      }
      if (now() - started > timeoutMs) {
        throw toolchainError(`等待安装锁超时：${lockDir}`, TOOLCHAIN_ERRORS.DOWNLOAD, { lockDir })
      }
      sleepSync(50)
    }
  }
}

/** 同步睡眠：安装是同步流程（CAS 提交要原子），用 Atomics.wait 比 busy loop 省 CPU。 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const until = Date.now() + ms
    while (Date.now() < until) { /* fallback：极端环境没有 SharedArrayBuffer */ }
  }
}

/* ------------------------------------------------------------------------------------------------
 * 下载与解包
 * ---------------------------------------------------------------------------------------------- */

async function downloadTo(url, dest, { fetchImpl, offline = false } = {}) {
  mkdirSync(dirname(dest), { recursive: true })
  const part = `${dest}.part`
  try { rmSync(part, { force: true }) } catch { /* 上一轮的残片 */ }
  // 本地文件（file://）与绝对路径都当「已经下好的 blob」处理：测试、内网离线包、预置镜像走这条。
  //
  // 必须在 offline 判断之前：offline 的含义是「不许上外网」，不是「不许读本地文件」。
  // 反过来写会让内网镜像（file:///opt/mirror/…）在离线模式下一律失败——而离线构建正是
  // 那套镜像存在的理由。
  if (url.startsWith('file://') || /^[A-Za-z]:[\\/]/.test(url) || url.startsWith('/')) {
    // 必须用 fileURLToPath，不能手搓 `new URL(url).pathname`：pathname 是百分号编码的，
    // Windows 短路径（ADMINI~1 → ADMINI%7E1）、空格（%20）、中文目录都会因此变成不存在的路径。
    const local = url.startsWith('file://') ? fileURLToPath(url) : url
    if (!existsSync(local)) throw toolchainError(`本地包不存在：${local}`, TOOLCHAIN_ERRORS.DOWNLOAD, { url })
    writeFileSync(part, readFileSync(local))
    renameSync(part, dest)
    return dest
  }
  if (offline) throw toolchainError(`离线模式不允许下载：${url}`, TOOLCHAIN_ERRORS.OFFLINE, { url })
  const doFetch = fetchImpl || globalThis.fetch
  if (typeof doFetch !== 'function') throw toolchainError('当前运行环境没有 fetch，无法下载工具链', TOOLCHAIN_ERRORS.DOWNLOAD, { url })
  const response = await doFetch(url, { redirect: 'follow' })
  if (!response.ok) throw toolchainError(`下载失败 ${response.status}：${url}`, TOOLCHAIN_ERRORS.DOWNLOAD, { url, status: response.status })
  const buffer = Buffer.from(await response.arrayBuffer())
  writeFileSync(part, buffer)
  // 先 .part 再 rename：中途失败不会留下一个「看起来完整」的半截包
  renameSync(part, dest)
  return dest
}

/** 解包。tar/zip 都交给系统 tar：Windows 自带 bsdtar（能解 zip），Linux 的 GNU tar 只认 tar。 */
export function extractArchive(archive, dest, { platform = process.platform } = {}) {
  mkdirSync(dest, { recursive: true })
  const lower = archive.toLowerCase()
  const isZip = lower.endsWith('.zip')
  const args = isZip && platform !== 'win32'
    ? ['-q', archive, '-d', dest] // unzip 的参数顺序与 tar 不同
    : ['-xf', archive, '-C', dest]
  const bin = isZip && platform !== 'win32' ? 'unzip' : 'tar'
  const result = runSync(bin, args)
  if (result.status !== 0) {
    throw toolchainError(
      `解包失败（${bin} ${args.join(' ')}）：${result.stderr || result.error || `exit ${result.status}`}`,
      TOOLCHAIN_ERRORS.EXTRACT,
      { archive },
    )
  }
  return dest
}

/**
 * 同步跑一条命令。下载是异步 fetch，解包与版本断言是同步子进程：
 * 解包必须同步，否则 `install()` 的 rename 提交会在解压完成前抢跑。
 */
export function runSync(file, args, { cwd, env, timeoutMs = 300000 } = {}) {
  const started = Date.now()
  const out = spawnSync(file, args, {
    cwd,
    env: env || process.env,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  })
  return {
    status: typeof out.status === 'number' ? out.status : -1,
    stdout: out.stdout || '',
    stderr: out.stderr || '',
    error: out.error ? out.error.message : '',
    durationMs: Date.now() - started,
  }
}

/* ------------------------------------------------------------------------------------------------
 * Provider：spec → { version, platforms }
 *
 * 只做「读官方索引」这一件事。实现按官方响应来，**不硬编码 checksum**——checksum 只进锁文件。
 * ---------------------------------------------------------------------------------------------- */

const semverCompare = (a, b) => {
  const pa = String(a).split(/[.+-]/).map((n) => Number.parseInt(n, 10) || 0)
  const pb = String(b).split(/[.+-]/).map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * 解析 spec：`17` / `temurin-17` / `17.0.11+9` / `20` / `3.9.6`。
 * 返回 `{vendor, feature, exact}`，三者按 spec 形状挑一个。
 */
export function parseSpec(lang, spec) {
  const text = String(spec ?? '').trim()
  if (!text) throw toolchainError(`${lang} 的版本声明是空的`, TOOLCHAIN_ERRORS.SPEC_INVALID, { lang })
  // vendor-feature：temurin-17 / zulu-21
  const vendor = /^([a-z]+)-(.+)$/.exec(text)
  if (vendor && LANGS.includes(lang) && lang !== 'maven' && lang !== 'gradle') {
    return { raw: text, vendor: vendor[1], exact: '', spec: vendor[2] }
  }
  return { raw: text, vendor: '', exact: '', spec: text }
}

/** 从版本清单里挑出满足 spec 的最大版本。`20` → 最新 20.x；`20.11.1` → 精确。 */
export function pickVersion(versions, spec) {
  const text = String(spec ?? '').trim()
  const list = (Array.isArray(versions) ? versions : []).map((v) => String(v)).filter(Boolean)
  if (list.length === 0) throw toolchainError(`版本清单是空的（spec ${text}）`, TOOLCHAIN_ERRORS.NOT_FOUND)
  if (/^\d+(\.\d+){1,3}([+-].*)?$/.test(text)) {
    // 精确版本：允许 `17.0.11` 命中 `17.0.11+9`
    if (list.includes(text)) return text
    const prefixed = list.filter((v) => v === text || v.startsWith(`${text}+`) || v.startsWith(`${text}-`))
    if (prefixed.length === 0) throw toolchainError(`没有匹配 ${text} 的版本`, TOOLCHAIN_ERRORS.NOT_FOUND, { spec: text })
    return prefixed.sort(semverCompare).pop()
  }
  if (/^\d+$/.test(text)) {
    const sameFeature = list.filter((v) => v.split(/[.+-]/)[0] === text)
    if (sameFeature.length === 0) throw toolchainError(`没有匹配 ${text}.x 的版本`, TOOLCHAIN_ERRORS.NOT_FOUND, { spec: text })
    return sameFeature.sort(semverCompare).pop()
  }
  throw toolchainError(`看不懂的版本声明 “${text}”（写 17 / 17.0.11+9 / temurin-17）`, TOOLCHAIN_ERRORS.SPEC_INVALID, { spec: text })
}

/** 内置 provider。每个返回 `{ versions }` 或 `{ platforms }`，全部走官方索引，不猜 checksum。 */
export const PROVIDERS = {
  java: {
    lang: 'java',
    async list(ctx) {
      const os = (ctx.platform || currentPlatform()).startsWith('win32') ? 'windows' : 'linux'
      const arch = (ctx.platform || currentPlatform()).endsWith('arm64') ? 'aarch64' : 'x64'
      const url = `https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=${arch}&image_type=jdk&os=${os}&vendor=eclipse`
      const data = await getJson(url, ctx)
      const versions = []
      const platforms = {}
      for (const item of Array.isArray(data) ? data : []) {
        const version = item?.version?.semver || item?.release_name || ''
        if (!version) continue
        versions.push(version)
        platforms[ctx.platform || currentPlatform()] = {
          url: item?.binary?.package?.link || '',
          sha256: item?.binary?.package?.checksum || '',
          size: item?.binary?.package?.size || 0,
        }
      }
      return { versions, platforms }
    },
  },
  maven: {
    lang: 'maven',
    async list(ctx) {
      const data = await getText('https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/maven-metadata.xml', ctx)
      const versions = [...String(data).matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1])
      return { versions, platforms: {} }
    },
    async locate(version, ctx) {
      const base = `https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/${version}`
      const plat = ctx.platform || currentPlatform()
      const file = `apache-maven-${version}-bin.tar.gz`
      return { [plat]: { url: `${base}/${file}`, sha256: await checksumFrom(`${base}/${file}.sha512`, ctx, 'sha512') } }
    },
  },
  gradle: {
    lang: 'gradle',
    async list(ctx) {
      const data = await getJson('https://services.gradle.org/versions/all', ctx)
      const versions = (Array.isArray(data) ? data : []).filter((v) => !v.snapshot && !v.nightly && v.version).map((v) => v.version)
      return { versions, platforms: {} }
    },
    async locate(version, ctx) {
      const plat = ctx.platform || currentPlatform()
      return { [plat]: { url: `https://services.gradle.org/distributions/gradle-${version}-bin.zip`, sha256: '' } }
    },
  },
  node: {
    lang: 'node',
    async list(ctx) {
      const data = await getJson('https://nodejs.org/dist/index.json', ctx)
      const versions = (Array.isArray(data) ? data : []).map((v) => String(v.version || '').replace(/^v/, '')).filter(Boolean)
      return { versions, platforms: {} }
    },
    async locate(version, ctx) {
      const plat = ctx.platform || currentPlatform()
      const os = plat.startsWith('win32') ? 'win' : plat.startsWith('darwin') ? 'darwin' : 'linux'
      const arch = plat.endsWith('arm64') ? 'arm64' : 'x64'
      const ext = os === 'win' ? 'zip' : 'tar.gz'
      const name = `node-v${version}-${os}-${arch}.${ext}`
      const sums = await getText(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`, ctx)
      const line = String(sums).split('\n').find((l) => l.trim().endsWith(name))
      return { [plat]: { url: `https://nodejs.org/dist/v${version}/${name}`, sha256: line ? line.trim().split(/\s+/)[0] : '' } }
    },
  },
  python: {
    lang: 'python',
    async list(ctx) {
      const data = await getJson('https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest', ctx)
      const versions = [...new Set((data?.assets || [])
        .map((a) => /cpython-(\d+\.\d+\.\d+)/.exec(String(a.name || '')))
        .filter(Boolean)
        .map((m) => m[1]))]
      return { versions, platforms: {} }
    },
    async locate(version, ctx) {
      const plat = ctx.platform || currentPlatform()
      const triple = plat.startsWith('win32')
        ? 'x86_64-pc-windows-msvc-shared'
        : plat.endsWith('arm64') ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu'
      const data = await getJson('https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest', ctx)
      const asset = (data?.assets || []).find((a) => String(a.name || '').includes(`cpython-${version}`) && String(a.name || '').includes(triple) && String(a.name || '').includes('install_only'))
      return { [plat]: { url: asset?.browser_download_url || '', sha256: '', size: asset?.size || 0 } }
    },
  },
  php: {
    lang: 'php',
    async list() {
      // Linux 上没有免 root 的官方二进制，PHP 走容器兜底；Windows 只有 windows.php.net 的 zip。
      throw toolchainError('php 暂无免 root 官方二进制：Linux 请用容器（php:8.3-cli），Windows 手动放入 store 后用 toolchain.external 声明', TOOLCHAIN_ERRORS.NOT_FOUND, { lang: 'php' })
    },
  },
  go: {
    lang: 'go',
    async list(ctx) {
      const data = await getJson('https://go.dev/dl/?mode=json', ctx)
      const versions = (Array.isArray(data) ? data : []).map((item) => String(item.version || '').replace(/^go/, '')).filter(Boolean)
      return { versions, platforms: {} }
    },
    async locate(version, ctx) {
      const plat = ctx.platform || currentPlatform()
      const os = plat.startsWith('win32') ? 'windows' : plat.startsWith('darwin') ? 'darwin' : 'linux'
      const arch = plat.endsWith('arm64') ? 'arm64' : 'amd64'
      const data = await getJson('https://go.dev/dl/?mode=json', ctx)
      const file = (data || []).find((item) => String(item.version || '') === `go${version}`)
      const target = (file?.files || []).find((f) => f.os === os && f.arch === arch)
      return { [plat]: { url: `https://go.dev/dl/${target?.filename || ''}`, sha256: target?.sha256 || '' } }
    },
  },
}

async function getJson(url, ctx) {
  return JSON.parse(await getText(url, ctx))
}

async function getText(url, ctx) {
  const doFetch = ctx.fetchImpl || globalThis.fetch
  if (typeof doFetch !== 'function') throw toolchainError('没有 fetch，无法读取工具链索引', TOOLCHAIN_ERRORS.DOWNLOAD, { url })
  const response = await doFetch(url)
  if (!response.ok) throw toolchainError(`读取索引失败 ${response.status}：${url}`, TOOLCHAIN_ERRORS.DOWNLOAD, { url })
  return response.text()
}

/** 从 `.sha512` 之类的小文件里读出校验和。取不到就留空，绝不编一个。 */
async function checksumFrom(url, ctx, algo) {
  try {
    const text = String(await getText(url, ctx)).trim()
    const match = /^([0-9a-f]{32,128})\b/i.exec(text)
    if (!match) return ''
    // 归一成 sha256 长度以便跟 sha256File 比较；非 sha256 的算法在 verify 时按算法重算。
    return `${algo}:${match[1].toLowerCase()}`
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------------------------------------
 * 锁文件
 * ---------------------------------------------------------------------------------------------- */

export const LOCK_VERSION = 1

export function emptyLock() {
  return { version: LOCK_VERSION, toolchain: [] }
}

export function readLock(file) {
  if (!file || !existsSync(file)) return emptyLock()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.toolchain)) return emptyLock()
    return { version: parsed.version || LOCK_VERSION, toolchain: parsed.toolchain, pipelines: parsed.pipelines || {} }
  } catch {
    return emptyLock()
  }
}

export function writeLock(file, lock) {
  mkdirSync(dirname(file), { recursive: true })
  const body = `${JSON.stringify({ version: LOCK_VERSION, toolchain: lock.toolchain || [], pipelines: lock.pipelines || {} }, null, 2)}\n`
  writeFileSync(file, body)
  return file
}

/** 在锁里找一条命中：语言相同、版本满足 spec、且该平台有 URL。 */
export function findLockEntry(lock, lang, spec, platform) {
  for (const entry of lock.toolchain || []) {
    if (entry?.lang !== lang) continue
    const platforms = entry.platforms || {}
    if (!platforms[platform]?.url) continue
    if (entry.resolved === spec) return entry
    if (entry.spec === spec) return entry
    try {
      // `20` 应该命中锁里锁定的 20.11.1——这样加了新发布也不会让 CI 结果漂移
      if (pickVersion([entry.resolved], spec) === entry.resolved) return entry
    } catch { /* 不满足就继续找 */ }
  }
  return null
}

export function upsertLockEntry(lock, entry) {
  const list = (lock.toolchain || []).filter((item) => !(item.lang === entry.lang && item.resolved === entry.resolved))
  list.push(entry)
  lock.toolchain = list
  return lock
}

/* ------------------------------------------------------------------------------------------------
 * 安装后的目录布局与版本断言
 * ---------------------------------------------------------------------------------------------- */

/** 每家发行包解压后「哪一层才是根」不一样，这里统一抹平。 */
export function normalizeRoot(lang, dir) {
  // JDK tar 解出 jdk-17.0.11+9/，Node 解出 node-v20.11.1-linux-x64/
  const entries = safeReaddir(dir)
  if (lang === 'java' || lang === 'node' || lang === 'gradle' || lang === 'go' || lang === 'maven') {
    const only = entries.filter((name) => !name.startsWith('.'))
    if (only.length === 1) {
      const nested = join(dir, only[0])
      try {
        if (statSync(nested).isDirectory()) return nested
      } catch { /* 不是目录就当它是根 */ }
    }
  }
  return dir
}

function safeReaddir(dir) {
  try { return readdirSync(dir) } catch { return [] }
}


/**
 * zip 里没有 POSIX 权限位，解出来 `bin/java` 可能是 0644。
 * 不补这一下，装完能过 checksum、能过 .ok 标记，然后第一次构建说「Permission denied」——
 * 而且报错点在用户的项目里，不在安装器里，极难定位。
 */
function chmodBinaries(dir) {
  let entries = []
  try { entries = readdirSync(dir) } catch { return }
  for (const name of entries) {
    const file = join(dir, name)
    try {
      if (statSync(file).isFile()) chmodSync(file, 0o755)
    } catch { /* 单个文件失败不影响整体，断言阶段还会再暴露 */ }
  }
}

/** 可执行文件目录：注入器前置 PATH 用的就是它。 */
export function binDirOf(lang, root) {
  const candidates = {
    java: ['bin'],
    maven: ['bin'],
    gradle: ['bin'],
    node: ['bin', ''],
    python: ['bin', ''],
    php: [''],
    go: ['bin'],
  }[lang] || ['bin']
  for (const rel of candidates) {
    const dir = rel ? join(root, rel) : root
    if (existsSync(dir)) return dir
  }
  return join(root, 'bin')
}

export function homeOf(lang, root) {
  if (lang === 'java') return root
  if (lang === 'node' || lang === 'python' || lang === 'php' || lang === 'go') return root
  return root
}

/** 版本断言的参数与期望输出片段。 */
export const VERSION_ARGS = {
  java: ['-version'],
  maven: ['-v'],
  gradle: ['--version'],
  node: ['--version'],
  python: ['--version'],
  php: ['--version'],
  go: ['version'],
}

/**
 * 从 `java -version` 这类输出里判断版本对不对。
 *
 * 为什么一定要断言，而不是「装了就对」：PATH 前置只影响「找不到时怎么办」，
 * 如果某个脚本内部写死了 `/usr/bin/java` 或用户 shell 的 alias，前置就白费了。
 * 断言是唯一能证明「真的用了声明的版本」的手段。
 */
export function matchesVersion(output, version) {
  const text = String(output || '')
  const target = String(version || '').split(/[+-]/)[0]
  if (!text || !target) return false
  // 17 要能匹配 17.0.11；17.0.11 要能匹配 17.0.11+9 的输出
  return new RegExp(`(^|[^0-9.])${target.replace(/\./g, '\\.')}([^0-9.]|$)`).test(text)
}

/* ------------------------------------------------------------------------------------------------
 * 主对象
 * ---------------------------------------------------------------------------------------------- */

export function createToolchain({
  storeDir,
  downloadsDir = '',
  lockFile = '',
  platforms = null,
  fetchImpl = null,
  offline = false,
  frozen = false,
  providers = PROVIDERS,
  now = Date.now,
  verifyChecksum = true,
} = {}) {
  if (!storeDir) throw toolchainError('createToolchain 需要 storeDir', TOOLCHAIN_ERRORS.SPEC_INVALID)
  const store = resolvePath(storeDir)
  const downloads = downloadsDir ? resolvePath(downloadsDir) : join(store, '.downloads')
  const locksDir = join(store, '.locks')
  const plat = platforms || currentPlatform()
  mkdirSync(store, { recursive: true })
  mkdirSync(downloads, { recursive: true })
  mkdirSync(locksDir, { recursive: true })

  const lock = readLock(lockFile)
  const inflight = new Map()

  async function resolveOne(lang, spec) {
    if (!LANGS.includes(lang)) {
      throw toolchainError(`不支持的语言 “${lang}”（可用 ${LANGS.join('、')}）`, TOOLCHAIN_ERRORS.SPEC_INVALID, { lang })
    }
    const parsed = parseSpec(lang, spec)
    const honored = findLockEntry(lock, lang, parsed.spec, plat)
    if (honored) {
      return { lang, spec: String(spec), resolved: honored.resolved, platforms: honored.platforms, fromLock: true }
    }
    if (frozen) {
      throw toolchainError(
        `锁文件缺少 ${lang}@${spec}@${plat}，--frozen 下拒绝联网解析（先跑 cicd_toolchain_lock 更新锁）`,
        TOOLCHAIN_ERRORS.LOCK_MISSING,
        { lang, spec: String(spec), platform: plat },
      )
    }
    const provider = providers[lang]
    if (!provider) throw toolchainError(`没有 ${lang} 的 provider`, TOOLCHAIN_ERRORS.NOT_FOUND, { lang })
    const ctx = { platform: plat, fetchImpl }
    const listed = await provider.list(ctx)
    const version = pickVersion(listed.versions, parsed.spec)
    let platformsFor = listed.platforms?.[plat]?.url ? listed.platforms : null
    if (!platformsFor) {
      if (typeof provider.locate !== 'function') {
        throw toolchainError(`${lang} 的 provider 没有给 ${plat} 的下载地址`, TOOLCHAIN_ERRORS.NOT_FOUND, { lang, platform: plat })
      }
      platformsFor = await provider.locate(version, ctx)
    }
    const entry = { lang, spec: String(spec), resolved: version, platforms: platformsFor }
    if (lockFile) upsertLockEntry(lock, entry)
    return { ...entry, fromLock: false }
  }

  /**
   * 解析并（可选）落锁。同一个语言重复声明时后者覆盖前者——`[java: 17, java: 21]` 这种
   * 自相矛盾的声明不应该静默取第一个。
   */
  async function resolve(specs = {}, { writeLock: persist = false } = {}) {
    const out = []
    for (const [lang, spec] of Object.entries(specs)) {
      if (spec === undefined || spec === null || spec === '') continue
      out.push(await resolveOne(lang, spec))
    }
    if (persist && lockFile) writeLock(lockFile, lock)
    return out
  }

  /** 安装一个已解析条目；幂等，按 resolved 缓存。 */
  async function install(item) {
    const key = `${item.lang}/${item.resolved}`
    const target = join(store, item.lang, item.resolved, plat)
    const marker = join(target, '.ok')
    if (existsSync(marker)) return { lang: item.lang, version: item.resolved, dir: target, root: normalizeRoot(item.lang, target), cached: true }

    // 同一个进程里并发装同一版本：复用同一个 Promise（mkdir 锁只能跨进程，跨不掉同进程的 await 间隙）
    if (inflight.has(key)) return inflight.get(key)
    const task = (async () => {
      const unlock = mkdirLock(join(locksDir, `install-${key.replace(/[^A-Za-z0-9_.-]+/g, '_')}-${plat}.lock`), { now })
      try {
        if (existsSync(marker)) return { lang: item.lang, version: item.resolved, dir: target, root: normalizeRoot(item.lang, target), cached: true }
        const platformInfo = item.platforms?.[plat]
        if (!platformInfo?.url) {
          throw toolchainError(`${item.lang}@${item.resolved} 没有 ${plat} 的下载地址`, TOOLCHAIN_ERRORS.NOT_FOUND, { lang: item.lang, platform: plat })
        }
        const fileName = safeFileName(basename(new URL(platformInfo.url, 'https://x/').pathname)) || `${item.lang}-${item.resolved}`
        const parsedSum = parseChecksum(platformInfo.sha256)
        // 用 checksum 当前缀：同一个文件名（如 node-v20.11.1-linux-x64.tar.gz）在不同版本间可能不同，
        // 但同一个 URL 内容变了会被 checksum 变化捕获，缓存键跟着变，不会拿到旧包。
        const blob = join(downloads, parsedSum ? `${parsedSum.hex.slice(0, 16)}-${fileName}` : fileName)
        if (!existsSync(blob)) {
          await downloadTo(platformInfo.url, blob, { fetchImpl, offline })
        }
        const expectedSum = parseChecksum(platformInfo.sha256)
        if (verifyChecksum && expectedSum) {
          const actual = hashFile(blob, expectedSum.algo)
          if (actual !== expectedSum.hex) {
            // 坏包必须删掉：留着它下次会直接命中缓存，永远装不好
            try { rmSync(blob, { force: true }) } catch { /* best effort */ }
            throw toolchainError(
              `${item.lang}@${item.resolved} 校验失败（${expectedSum.algo}）：期望 ${expectedSum.hex.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…（已删除坏包，不写入 store）`,
              TOOLCHAIN_ERRORS.CHECKSUM,
              { lang: item.lang, version: item.resolved },
            )
          }
        }
        const tmp = join(store, `.tmp-${process.pid}-${Math.floor(now() % 1e6)}-${Math.floor(Math.random() * 1e6)}`)
        mkdirSync(tmp, { recursive: true })
        try {
          extractArchive(blob, tmp, { platform: plat })
          const root = normalizeRoot(item.lang, tmp)
          if (process.platform !== 'win32') chmodBinaries(binDirOf(item.lang, root))
          writeFileSync(join(tmp, '.ok'), JSON.stringify({
            lang: item.lang,
            spec: item.spec,
            resolved: item.resolved,
            platform: plat,
            url: platformInfo.url,
            sha256: platformInfo.sha256 || '',
            at: new Date(now()).toISOString(),
          }, null, 2))
          mkdirSync(dirname(target), { recursive: true })
          // rename 到目标：同卷原子，绝不会出现「半个工具链」
          renameSync(tmp, target)
        } catch (error) {
          try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
          throw error
        }
        return { lang: item.lang, version: item.resolved, dir: target, root: normalizeRoot(item.lang, target), cached: false }
      } finally {
        unlock()
      }
    })()
    inflight.set(key, task)
    try {
      return await task
    } finally {
      inflight.delete(key)
    }
  }

  /** 解析 + 安装一体化：给定 `{java:'17', maven:'3.9.6'}` 拿到已就绪的目录清单。 */
  async function ensure(specs = {}, options = {}) {
    const items = await resolve(specs, options)
    const installed = []
    for (const item of items) installed.push(await install(item))
    return installed
  }

  function list() {
    const out = []
    for (const lang of safeReaddir(store)) {
      if (lang.startsWith('.')) continue
      for (const version of safeReaddir(join(store, lang))) {
        for (const platform of safeReaddir(join(store, lang, version))) {
          const dir = join(store, lang, version, platform)
          if (!existsSync(join(dir, '.ok'))) continue
          let meta = {}
          try { meta = JSON.parse(readFileSync(join(dir, '.ok'), 'utf8')) } catch { /* 标记坏了就当空元数据 */ }
          out.push({
            lang,
            version,
            platform,
            dir,
            root: normalizeRoot(lang, dir),
            bytes: dirBytes(dir),
            spec: meta.spec || '',
            installedAt: meta.at || '',
          })
        }
      }
    }
    return out
  }

  function remove(lang, version) {
    const dir = join(store, lang, version)
    if (!existsSync(dir)) return false
    rmSync(dir, { recursive: true, force: true })
    return true
  }

  /** GC：删掉不在 keep 列表里的安装（默认只清下载缓存）。 */
  function gc({ keep = [], downloads: dropDownloads = true } = {}) {
    const removed = []
    const keepKeys = new Set(keep.map((item) => `${item.lang}/${item.version}`))
    for (const item of list()) {
      if (keepKeys.size > 0 && !keepKeys.has(`${item.lang}/${item.version}`)) {
        if (remove(item.lang, item.version)) removed.push(`${item.lang}/${item.version}`)
      }
    }
    let freed = 0
    if (dropDownloads) {
      for (const name of safeReaddir(downloads)) {
        const file = join(downloads, name)
        try {
          freed += statSync(file).size
          rmSync(file, { force: true, recursive: true })
        } catch { /* 正在被别的进程用 */ }
      }
    }
    return { removed, freedBytes: freed }
  }

  return {
    storeDir: store,
    downloadsDir: downloads,
    lockFile,
    platform: plat,
    offline,
    frozen,
    resolve,
    install,
    ensure,
    list,
    remove,
    gc,
    lock: () => lock,
    saveLock: () => (lockFile ? writeLock(lockFile, lock) : ''),
  }
}

/** 文件名消毒：Windows 不允许 `:` `*` `?` `"` `<` `>` `|`，从 URL 取来的名字必须过一遍。 */
function safeFileName(name) {
  return String(name || '').replace(/[^A-Za-z0-9_.+-]+/g, '_').slice(0, 120)
}

function dirBytes(dir) {
  let total = 0
  const walk = (current) => {
    for (const name of safeReaddir(current)) {
      const file = join(current, name)
      try {
        const stat = statSync(file)
        if (stat.isDirectory()) walk(file)
        else total += stat.size
      } catch { /* 正被删除 */ }
    }
  }
  walk(dir)
  return total
}

/* ------------------------------------------------------------------------------------------------
 * 注入器
 * ---------------------------------------------------------------------------------------------- */

/**
 * 只构造子进程 env，**不写任何 shell rc、不改注册表、不做全局 symlink**。
 *
 * 三条铁律（05-toolchain.md §2.4）：
 * 1. PATH 前置，压住宿主版本；同时把「可能让宿主版本复活」的变量显式覆盖或删除
 *    （`JAVA_HOME`、`PYTHONHOME`、`VIRTUAL_ENV`、`GOROOT`）。
 * 2. 不 spread `process.env` 到「什么都能继承」——只带白名单 + PATH，避免宿主的
 *    `MAVEN_OPTS`/`NODE_OPTIONS` 偷偷改变构建行为。
 * 3. 每个语言的缓存目录都指到本次 run 的目录，绝不共享 `~/.m2` 或 `node_modules`。
 */
export const ENV_PASSTHROUGH = [
  'HOME', 'USERPROFILE', 'USERNAME', 'USER', 'PATH', 'SHELL', 'LANG', 'LC_ALL', 'TZ',
  'TEMP', 'TMP', 'TMPDIR', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'windir',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'SSH_AUTH_SOCK', 'GIT_SSH_COMMAND',
]

export function baseEnv(source = process.env) {
  const env = {}
  for (const key of ENV_PASSTHROUGH) if (source[key] !== undefined) env[key] = source[key]
  if (!env.PATH && source.Path) env.PATH = source.Path // Windows 有时键名是 Path
  return env
}

export function envFor(installed = [], { runDirs = {}, base = process.env, extraEnv = {}, platform = process.platform } = {}) {
  const sep = platform === 'win32' ? ';' : ':'
  const env = baseEnv(base)
  const bins = installed.map((item) => item.binDir || binDirOf(item.lang, item.root || item.dir)).filter(Boolean)
  env.PATH = [...bins, env.PATH || ''].filter(Boolean).join(sep)
  env.CI = '1'
  env.DSH_CICD_TOOLCHAIN = installed.map((item) => `${item.lang}=${item.version}`).join(',')
  const by = new Map(installed.map((item) => [item.lang, item]))
  const java = by.get('java')
  if (java) {
    env.JAVA_HOME = java.root || java.dir
    if (runDirs.m2) env.MAVEN_OPTS = `-Dmaven.repo.local=${runDirs.m2}`
  } else {
    // 宿主 JAVA_HOME 指向 JDK21 而项目声明 17：留着它，某些脚本会绕过 PATH 直接用
    delete env.JAVA_HOME
  }
  if (runDirs.m2) env.M2_HOME = runDirs.m2
  if (runDirs.gradle) env.GRADLE_USER_HOME = runDirs.gradle
  const python = by.get('python')
  if (python) {
    env.PYTHONHOME && delete env.PYTHONHOME
    if (runDirs.venv) {
      env.VIRTUAL_ENV = runDirs.venv
      env.PATH = [platform === 'win32' ? join(runDirs.venv, 'Scripts') : join(runDirs.venv, 'bin'), env.PATH].join(sep)
    }
  }
  if (runDirs.pip) env.PIP_CACHE_DIR = runDirs.pip
  if (runDirs.npm) env.NPM_CONFIG_CACHE = runDirs.npm
  if (runDirs.composer) env.COMPOSER_CACHE_DIR = runDirs.composer
  const go = by.get('go')
  if (go) env.GOROOT = go.root || go.dir
  else delete env.GOROOT
  if (runDirs.goBuild) env.GOCACHE = runDirs.goBuild
  if (runDirs.goMod) env.GOMODCACHE = runDirs.goMod
  // GOTOOLCHAIN=local 必须设：否则 go 会「为了满足 go.mod 自动下载另一个工具链」，绕过锁文件
  env.GOTOOLCHAIN = 'local'
  for (const [key, value] of Object.entries(extraEnv || {})) {
    if (value === undefined || value === null) delete env[key]
    else env[key] = String(value)
  }
  return env
}

/** 断言已安装工具链的版本，返回问题清单（空数组 = 全对）。 */
export function assertVersions(installed, { base = process.env, platform = process.platform, run = null } = {}) {
  const problems = []
  for (const item of installed) {
    const args = VERSION_ARGS[item.lang]
    if (!args) continue
    const bin = binName(item.lang, platform)
    const env = envFor(installed, { base, platform })
    const result = (run || runSync)(bin, args, { env })
    const output = `${result.stdout || ''}${result.stderr || ''}`
    if (result.status !== 0) {
      problems.push({
        lang: item.lang,
        version: item.version,
        output,
        message: `${item.lang} 无法执行（${bin} ${args.join(' ')} 退出码 ${result.status}）`,
      })
      continue
    }
    if (!matchesVersion(output, item.version)) {
      problems.push({
        lang: item.lang,
        version: item.version,
        output,
        message: `${item.lang} 版本不符：声明 ${item.version}，实际输出 “${output.trim().split('\n')[0]}”（PATH 可能被宿主版本抢先）`,
      })
    }
  }
  return problems
}

export function binName(lang, platform = process.platform) {
  const exe = platform === 'win32' ? '.cmd' : ''
  const plain = { java: 'java', maven: 'mvn', gradle: 'gradle', node: 'node', python: 'python3', php: 'php', go: 'go' }[lang] || lang
  // Windows 上 npm/mvn 是 .cmd；java/node 是 .exe。这里只用于断言，挑最常见的形态即可。
  if (platform === 'win32') {
    if (lang === 'java' || lang === 'node' || lang === 'python' || lang === 'php' || lang === 'go') return `${plain}.exe`
    return `${plain}.cmd`
  }
  return plain
}

/* ------------------------------------------------------------------------------------------------
 * Maven / Gradle 双锁
 * ---------------------------------------------------------------------------------------------- */

/**
 * Maven 只认 `JAVA_HOME` 是不够的：`mvn` 会用 `toolchains.xml` 覆盖编译器 JDK，
 * 而 `mvn` 自己跑在哪个 JVM 上由 `JAVA_HOME` 决定。两处都指向同一棵树才算「锁死」。
 */
export function mavenToolchainsXml(entries) {
  const body = entries.map((item) => `  <toolchain>
    <type>${item.type || 'jdk'}</type>
    <provides>
      <version>${item.version}</version>${item.vendor ? `\n      <vendor>${item.vendor}</vendor>` : ''}
    </provides>
    <configuration>
      <jdkHome>${item.home}</jdkHome>
    </configuration>
  </toolchain>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<toolchains>
${body}
</toolchains>
`
}

/**
 * Gradle 的 toolchain 优先级里「运行 Gradle 的 JVM」优先，所以不能让 daemon 跑在宿主 JDK21
 * 上却声明 17。把三个开关全关掉、只留我们装的那棵树。
 */
export function gradleProperties(javaHomes) {
  return [
    'org.gradle.java.installations.auto-detect=false',
    'org.gradle.java.installations.auto-download=false',
    `org.gradle.java.installations.paths=${javaHomes.join(',')}`,
    'org.gradle.daemon=false',
    '',
  ].join('\n')
}

/** 写 Maven/Gradle 双锁文件到 run 目录，返回可供 `-t` 使用的路径。 */
export function writeDualLocks({ runDir, java, vendor = '' }) {
  if (!runDir) return { toolchainsXml: '', gradleProperties: '' }
  mkdirSync(runDir, { recursive: true })
  const xml = java
    ? mavenToolchainsXml([{ type: 'jdk', version: String(java.version || '').split(/[+-]/)[0], vendor, home: java.root || java.dir }])
    : ''
  const props = java ? gradleProperties([java.root || java.dir]) : ''
  const xmlPath = xml ? join(runDir, 'toolchains.xml') : ''
  const propsPath = props ? join(runDir, 'gradle.properties') : ''
  if (xmlPath) writeFileSync(xmlPath, xml)
  if (propsPath) writeFileSync(propsPath, props)
  return { toolchainsXml: xmlPath, gradleProperties: propsPath }
}

/* ------------------------------------------------------------------------------------------------
 * 声明推断：读 .nvmrc / .python-version / .tool-versions
 * ---------------------------------------------------------------------------------------------- */

export const DECLARATION_FILES = {
  node: ['.nvmrc', '.node-version'],
  python: ['.python-version'],
  java: ['.java-version', '.sdkmanrc'],
  go: ['go.mod'],
}

/**
 * 从项目里的声明文件推断工具链版本。只作为「pipe.yml 没写时才用」的默认值：
 * 主机级不放版本，项目级 pipe.yml 优先，声明文件是兼容既有仓库的桥。
 */
export function inferFromFiles(projectPath, { exists = existsSync, read = (file) => readFileSync(file, 'utf8') } = {}) {
  const out = {}
  for (const [lang, files] of Object.entries(DECLARATION_FILES)) {
    for (const name of files) {
      const file = join(projectPath, name)
      if (!exists(file)) continue
      let text = ''
      try { text = String(read(file)) } catch { continue }
      const value = parseDeclaration(lang, name, text)
      if (value) { out[lang] = value; break }
    }
  }
  return out
}

function parseDeclaration(lang, name, text) {
  const trimmed = text.trim()
  if (!trimmed) return ''
  if (name === '.nvmrc' || name === '.node-version') return /^v?(\d+(?:\.\d+)*)$/.exec(trimmed.split('\n')[0])?.[1] || ''
  if (name === '.python-version') return /^(\d+\.\d+(?:\.\d+)?)$/.exec(trimmed.split('\n')[0])?.[1] || ''
  if (name === '.java-version') return /^(\d+(?:\.\d+)*)$/.exec(trimmed.split('\n')[0])?.[1] || ''
  if (name === '.sdkmanrc') {
    const line = trimmed.split('\n').find((l) => l.startsWith('java='))
    return line ? line.slice(5).trim().replace(/^(\d+)\..*$/, '$1') : ''
  }
  if (name === 'go.mod') return /^go\s+(\d+\.\d+(?:\.\d+)?)$/m.exec(trimmed)?.[1] || ''
  if (name === '.tool-versions') {
    const line = trimmed.split('\n').find((l) => l.startsWith(`${lang} `))
    return line ? line.split(/\s+/)[1] || '' : ''
  }
  return ''
}
