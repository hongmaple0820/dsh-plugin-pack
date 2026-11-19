/**
 * 只读分发层：把 CAS 里的字节按 Maven / npm / PyPI 各自的协议讲给客户端听。
 *
 * 为什么需要它：构建方已经能直接按 digest 取字节，但 mvn / npm / pip 说的是三种完全不同的语言——
 * 它们要 maven-metadata.xml、要 packument、要 PEP 503 HTML，且都只认「坐标 → 文件」的路径形状。
 * 这一层只做翻译：不复制字节、不缓存文件、不写新的存储；每个响应最终都落到 CAS 的同一个 digest。
 *
 * 三条共同约束：
 * 1. **只读**。写入只有一处（`cicd_artifacts action=upload` + 坐标登记），仓库里没有 PUT。
 * 2. **不可变**。同名同版本只能登记一次（artifact_packages 的唯一索引），重复登记直接拒；
 *    否则上游两次构建会共用一个坐标，锁文件再也说不清到底装的是哪一份字节。
 * 3. **不递归扫盘**。索引在 SQLite（artifact_packages），目录列表由索引生成；
 *    扫描 CAS 目录既慢，又会把「没登记过的 blob」（OCI 层、GC 等待期）混进依赖解析。
 */
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { normalizeDigest, artifactError } from './artifacts.js'

export const ECOSYSTEMS = Object.freeze(['maven', 'npm', 'pypi'])

export const PACKAGE_ERRORS = {
  INVALID: 'PACKAGE_INVALID',
  DUPLICATE: 'PACKAGE_DUPLICATE',
  NOT_FOUND: 'PACKAGE_NOT_FOUND',
  IMMUTABLE: 'PACKAGE_IMMUTABLE',
}

function packageError(code, message, extra = null) {
  const error = new Error(message)
  error.code = code
  if (extra) error.extra = extra
  return error
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// ---- 名字与版本 -------------------------------------------------------------------------------
// 正则都在「本地命名空间」这一侧：它们要挡住的是路径穿越（../）、大小写混用和空白，
// 而不是替上游生态做规范裁决——上游允许什么，最终由各客户端自己解析。
const MAVEN_COORD = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/
const MAVEN_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/
const MAVEN_CLASSIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const MAVEN_EXTENSION = /^[A-Za-z0-9]{1,16}$/
// npm 名字里允许 @scope/name，也允许只有一层的 name；大写会被 npm 客户端自己拒掉，这里一并拒。
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const NPM_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/
// PEP 503：项目名必须归一成小写，`_` 与 `.` 都折成 `-`。分发文件名同理。
const PYPI_NAME = /^[a-z0-9][a-z0-9._-]*$/
const PYPI_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/
// 扩展名也是路径的一段，只允许字母数字：`jar` 可以，`../x` 不行。
const PYPI_EXTENSION = /^[A-Za-z0-9]{1,16}$/

export function mavenCoordinateError(groupId, artifactId, version) {
  if (!MAVEN_COORD.test(String(groupId || ''))) return 'groupId 只能是点分的字母数字段（例如 com.example）'
  if (!MAVEN_COORD.test(String(artifactId || ''))) return 'artifactId 只能是点分的字母数字段'
  if (!MAVEN_VERSION.test(String(version || ''))) return 'version 不合法'
  return ''
}

/** Maven 的目录布局就是坐标本身：groupId 的点换成斜杠。 */
export function mavenGroupPath(groupId) {
  return String(groupId || '').split('.').filter(Boolean).join('/')
}

/** `<artifactId>-<version>[-<classifier>].<ext>` —— Maven 客户端的文件名就是这么拼出来的。 */
export function mavenFileName(artifactId, version, classifier = '', extension = 'jar') {
  const suffix = classifier ? `-${classifier}` : ''
  return `${artifactId}-${version}${suffix}.${extension}`
}

export function parseMavenFileName(artifactId, version, fileName) {
  const head = `${artifactId}-${version}`
  if (!String(fileName || '').startsWith(head)) return null
  const rest = String(fileName).slice(head.length)
  const match = /^(?:-([A-Za-z0-9][A-Za-z0-9._-]*))?\.([A-Za-z0-9]{1,16})$/.exec(rest)
  if (!match) return null
  return { classifier: match[1] || '', extension: match[2] }
}

/** npm：`@scope/name` 拆成 scope 与 name（scope 存成带 @ 的形式）。 */
export function splitNpmName(raw) {
  const value = String(raw || '')
  const match = /^(@[a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)$/.exec(value)
  if (match) return { scope: match[1], name: match[2], full: value }
  return { scope: '', name: value, full: value }
}

/** PEP 503 归一：小写，`.` 与 `_` 折成 `-`，连续折成一个。 */
export function normalizePyPIname(raw) {
  return String(raw || '').toLowerCase().replace(/[-_.]+/g, '-')
}

/**
 * PEP 503 里唯一允许出现在链接上的归一形式是 `-`，但上游历史上 `_` 和 `.` 都用过，
 * 所以索引查询要接受三者等价——否则 `GET /simple/foo_bar/` 会 404，而 pip 完全有权这么问。
 */
export function pypiNameCandidates(raw) {
  const normalized = normalizePyPIname(raw)
  const out = new Set([normalized])
  out.add(normalized.replace(/-/g, '_'))
  out.add(normalized.replace(/-/g, '.'))
  return [...out]
}

/** PEP 503 的 `<a>` 文本：`name-version[-build][-python][-abi][-platform].whl`。 */
export function pypiFilename(project, version, extension, extra = '') {
  const tag = extra ? `-${extra}` : ''
  return `${project}-${version}${tag}.${extension}`
}

/** PEP 691（JSON）要求文件条目带 hashes，键名是算法名（不含 `sha256:` 前缀）。 */
export function pypiHashOf(digest) {
  const normalized = normalizeDigest(digest)
  return { sha256: normalized.slice('sha256:'.length) }
}

/**
 * npm 的 dist.integrity 用 SRI（`sha512-<base64>`）。
 *
 * 本仓库的地址是按 sha256 寻址的，SRI 里的 sha512 是对**同一份字节**另算一遍得到的：
 * 它不改变寻址方式，只是让 npm 客户端在解包前还能自己校验一次。所以这里只在入库时算一次，
 * 存在 artifact_packages.meta 里——每次 GET packument 都重读整个 tarball 是不可接受的。
 */
export function sriOf(hash, encoding = 'sha512') {
  return `${encoding}-${hash.digest('base64')}`
}

/** 收字节；传 Hash 实例时直接在它身上收尾（调用方已流式喂完）。 */
export function sha512Sri(input) {
  if (input && typeof input.update === 'function' && typeof input.digest === 'function') return sriOf(input)
  return sriOf(createHash('sha512').update(input))
}

// ---- 坐标登记（唯一写入口） -------------------------------------------------------------------

/**
 * 登记一个「坐标 → digest」。**不可变**：同坐标第二次登记，只有 digest 相同时才算幂等成功，
 * 不同的 digest 一律 PACKAGE_DUPLICATE——这正是 GitLab Maven「追加入已有 package」那个坑的反面。
 */
export function createPackageIndex({ db, has = () => false, now = () => new Date().toISOString() }) {
  const insert = db.prepare(
    'INSERT INTO artifact_packages (ecosystem, scope, name, version, digest, bytes, media_type, project_id, run_id, classifier, extension, meta, created_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const selectKey = db.prepare(
    'SELECT * FROM artifact_packages WHERE ecosystem = ? AND scope = ? AND name = ? AND version = ? AND classifier = ? AND extension = ?',
  )
  const selectName = db.prepare('SELECT * FROM artifact_packages WHERE ecosystem = ? AND scope = ? AND name = ? ORDER BY created_at ASC')

  function row(row0) {
    if (!row0) return null
    let meta = null
    if (row0.meta) {
      try { meta = JSON.parse(row0.meta) } catch { meta = null }
    }
    return {
      ecosystem: String(row0.ecosystem || ''),
      scope: String(row0.scope || ''),
      name: String(row0.name || ''),
      version: String(row0.version || ''),
      digest: String(row0.digest || ''),
      bytes: Number(row0.bytes || 0),
      mediaType: String(row0.media_type || ''),
      projectId: String(row0.project_id || ''),
      runId: String(row0.run_id || ''),
      classifier: String(row0.classifier || ''),
      extension: String(row0.extension || ''),
      meta,
      createdAt: String(row0.created_at || ''),
    }
  }

  return {
    register(arg = {}) {
      const ecosystem = String(arg.ecosystem || '')
      if (!ECOSYSTEMS.includes(ecosystem)) throw packageError(PACKAGE_ERRORS.INVALID, `未知生态 “${ecosystem}”（只有 ${ECOSYSTEMS.join(' / ')}）`)
      const scope = String(arg.scope || '')
      const name = String(arg.name || '')
      const version = String(arg.version || '')
      const classifier = String(arg.classifier || '')
      const extension = String(arg.extension || '')
      if (!name || !version) throw packageError(PACKAGE_ERRORS.INVALID, '登记坐标需要 name 与 version')
      if (ecosystem === 'npm' && !NPM_NAME.test(scope ? `${scope}/${name}` : name)) throw packageError(PACKAGE_ERRORS.INVALID, `npm 包名 “${scope ? scope + '/' + name : name}” 不合法`)
      if (ecosystem === 'npm' && !NPM_VERSION.test(version)) throw packageError(PACKAGE_ERRORS.INVALID, `npm 版本 “${version}” 不合法`)
      if (ecosystem === 'pypi' && !PYPI_NAME.test(name)) throw packageError(PACKAGE_ERRORS.INVALID, `PyPI 项目名 “${name}” 不合法`)
      if (ecosystem === 'pypi' && !PYPI_VERSION.test(version)) throw packageError(PACKAGE_ERRORS.INVALID, `PyPI 版本 “${version}” 不合法`)
      if (ecosystem === 'pypi' && !PYPI_EXTENSION.test(extension)) throw packageError(PACKAGE_ERRORS.INVALID, 'PyPI 分发文件必须有扩展名')
      if (ecosystem === 'maven' && classifier && !MAVEN_CLASSIFIER.test(classifier)) throw packageError(PACKAGE_ERRORS.INVALID, `classifier “${classifier}” 不合法`)
      if (ecosystem === 'maven' && !MAVEN_EXTENSION.test(extension)) throw packageError(PACKAGE_ERRORS.INVALID, 'Maven 制品必须有扩展名（jar / pom / war…）')
      const digest = normalizeDigest(String(arg.digest || ''))
      if (!has(digest)) throw artifactError('ARTIFACT_NOT_FOUND', `CAS 里没有 ${digest}，不能拿它登记坐标`)
      const existing = selectKey.get(ecosystem, scope, name, version, classifier, extension)
      if (existing) {
        if (String(existing.digest) === digest) return { created: false, ...row(existing) }
        throw packageError(
          PACKAGE_ERRORS.DUPLICATE,
          `${ecosystem} ${scope ? scope + '/' : ''}${name}@${version}${classifier ? '-' + classifier : ''}.${extension} 已经指向 ${existing.digest}，不能改成 ${digest}（坐标不可变）`,
          { registered: String(existing.digest), incoming: digest },
        )
      }
      const meta = isPlainObject(arg.meta) ? JSON.stringify(arg.meta) : ''
      insert.run(
        ecosystem, scope, name, version, digest, Number(arg.bytes || 0), String(arg.mediaType || ''),
        String(arg.projectId || ''), String(arg.runId || ''), classifier, extension, meta, now(),
      )
      return { created: true, ...row(selectKey.get(ecosystem, scope, name, version, classifier, extension)) }
    },

    find(arg = {}) {
      const ecosystem = String(arg.ecosystem || '')
      const scope = String(arg.scope || '')
      const name = String(arg.name || '')
      const version = String(arg.version || '')
      const classifier = String(arg.classifier || '')
      const extension = String(arg.extension || '')
      if (ecosystem && name && version && (classifier || extension)) return row(selectKey.get(ecosystem, scope, name, version, classifier, extension))
      if (ecosystem && name) return listVersions(ecosystem, scope, name)
      return []
    },

    /** 某个包的**全部版本**，按登记顺序（= 构建顺序）。生成 metadata 时由调用方排序。 */
    versions(arg = {}) {
      return listVersions(String(arg.ecosystem || ''), String(arg.scope || ''), String(arg.name || ''))
    },

    /** 一个生态下出现过的所有包名（npm 的 scope、PyPI 的归一候选都靠这里收敛）。 */
    lookupEcosystem(ecosystem) {
      return db.prepare('SELECT DISTINCT scope, name FROM artifact_packages WHERE ecosystem = ? ORDER BY name ASC').all(String(ecosystem || ''))
        .map((item) => ({ scope: String(item.scope || ''), name: String(item.name || '') }))
    },

    remove(digest) {
      const result = db.prepare('DELETE FROM artifact_packages WHERE digest = ?').run(normalizeDigest(digest))
      return Number(result?.changes || 0)
    },

    count() {
      const total = db.prepare('SELECT COUNT(*) AS n FROM artifact_packages').get()
      return Number(total?.n || 0)
    },
  }

  function listVersions(ecosystem, scope, name) {
    return selectName.all(ecosystem, scope, name).map(row)
  }
}

// ---- Maven ------------------------------------------------------------------------------------

/** Maven 版本的可比较形式：数值段按整数比，其余按字典序；`1.0-rc1` < `1.0`（预发布排在正式版前）。 */
export function compareVersions(a, b) {
  const split = (value) => String(value || '').split(/[._+-]/).filter((part) => part !== '')
  const left = split(a)
  const right = split(b)
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i += 1) {
    const x = left[i]
    const y = right[i]
    // 段用尽：短的是正式版（`2.0.0`），长的带着预发布后缀（`2.0.0-rc1`），所以短的那个更大。
    // 反过来会把 rc 顶到 latest 上，客户端一装就装成候选版。
    if (x === undefined) return 1
    if (y === undefined) return -1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      const diff = Number(x) - Number(y)
      if (diff !== 0) return diff < 0 ? -1 : 1
      continue
    }
    // 数字段 > 非数字段：`1.0.1` 要排在 `1.0-alpha` 之后。
    if (nx !== ny) return nx ? 1 : -1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

export function sortVersions(versions) {
  return [...versions].sort(compareVersions)
}

function xmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 每一级目录一份 maven-metadata.xml；`entries` 是那一级的子坐标（组 / 制品 / 版本）。 */
export function buildMavenMetadata({ groupId = '', artifactId = '', version = '', entries = [] }) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<metadata>',
  ]
  if (groupId) lines.push(`  <groupId>${xmlEscape(groupId)}</groupId>`)
  if (artifactId) lines.push(`  <artifactId>${xmlEscape(artifactId)}</artifactId>`)
  if (version) lines.push(`  <version>${xmlEscape(version)}</version>`)
  if (entries.length > 0 && artifactId && !version) {
    const sorted = sortVersions(entries)
    lines.push('  <versioning>')
    lines.push(`    <latest>${xmlEscape(sorted[sorted.length - 1])}</latest>`)
    lines.push(`    <release>${xmlEscape(sorted[sorted.length - 1])}</release>`)
    // 版本顺序必须和 versions 列表一致：客户端会照着第一个/最后一个判断「最新」。
    lines.push('    <versions>')
    for (const item of sorted) lines.push(`      <version>${xmlEscape(item)}</version>`)
    lines.push('    </versions>')
    lines.push('  </versioning>')
  }
  lines.push('</metadata>')
  return `${lines.join('\n')}\n`
}

// ---- npm --------------------------------------------------------------------------------------

/** packument 里 `dist.tarball` 的固定形状：`<base>/repository/npm/<name>/-/<basename>-<version>.tgz`。 */
export function npmTarballName(name, version) {
  return `${String(name).split('/').pop()}-${version}.tgz`
}

export function buildPackument({ fullName, versions = [], tags = {}, baseUrl = '', projectId = '' }) {
  const doc = {
    name: fullName,
    'dist-tags': { ...tags },
    versions: {},
  }
  const times = {}
  for (const entry of versions) {
    const manifest = isPlainObject(entry.meta?.manifest) ? entry.meta.manifest : {}
    const integrity = typeof entry.meta?.integrity === 'string' ? entry.meta.integrity : ''
    doc.versions[entry.version] = {
      ...manifest,
      name: fullName,
      version: entry.version,
      dist: {
        tarball: `${baseUrl}/repository/npm/${fullName}/-/${npmTarballName(fullName, entry.version)}`,
        shasum: entry.digest.slice('sha256:'.length),
        integrity,
      },
      ...(projectId ? { _project: projectId } : {}),
    }
    times[entry.version] = entry.createdAt
  }
  doc.time = times
  if (tags.latest) doc.time.modified = times[tags.latest] || ''
  return doc
}

// ---- PyPI -------------------------------------------------------------------------------------

/** PEP 503：一个项目页就是一串 `<a href>`，后面接 PEP 503 规定的 `#sha256=` 片段。 */
export function buildSimpleHtml({ project, files = [] }) {
  const lines = [
    '<!DOCTYPE html>',
    '<html>',
    '  <head>',
    `    <meta name="pypi:repository-version" content="1.0">`,
    `    <title>Links for ${xmlEscape(project)}</title>`,
    '  </head>',
    '  <body>',
    `    <h1>Links for ${xmlEscape(project)}</h1>`,
  ]
  for (const file of files) {
    const hash = file.digest.slice('sha256:'.length)
    lines.push(`    <a href="${xmlEscape(file.url)}#sha256=${hash}">${xmlEscape(file.filename)}</a><br/>`)
  }
  lines.push('  </body>')
  lines.push('</html>')
  return `${lines.join('\n')}\n`
}

/** PEP 691：同样的信息以 JSON 给出，客户端用 `Accept: application/vnd.pypi.simple.v1+json` 要它。 */
export function buildSimpleJson({ project, files = [] }) {
  return {
    meta: { 'api-version': '1.0' },
    name: project,
    files: files.map((file) => ({
      filename: file.filename,
      url: file.url,
      hashes: { sha256: file.digest.slice('sha256:'.length) },
      ...(Number(file.bytes) > 0 ? { size: Number(file.bytes) } : {}),
      'requires-python': file.requiresPython || '',
    })),
  }
}

/** 按 Accept 协商：JSON 优先（客户端明确要 JSON 时才给 JSON，否则给 HTML——老的 pip 只会解析 HTML）。 */
export function prefersJson(accept) {
  const text = String(accept || '').toLowerCase()
  if (!text) return false
  const jsonIndex = text.indexOf('application/vnd.pypi.simple.v1+json')
  const htmlIndex = text.indexOf('text/html')
  if (jsonIndex < 0) return false
  if (htmlIndex < 0) return true
  return jsonIndex < htmlIndex
}

// ---- 分发：把仓库路径解析成「哪一份字节」 -------------------------------------------------------

const MEDIA = {
  jar: 'application/java-archive',
  pom: 'application/xml',
  war: 'application/java-archive',
  zip: 'application/zip',
  module: 'application/json',
  xml: 'application/xml',
  tgz: 'application/gzip',
  gz: 'application/gzip',
  whl: 'application/zip',
  tar: 'application/x-tar',
}

export function mediaTypeFor(extension) {
  return MEDIA[String(extension || '').toLowerCase()] || 'application/octet-stream'
}

/**
 * 把 `/repository/maven/...` 后面的路径解析成一次查表动作。
 *
 * 支持两种形状：
 * - `<groupPath>/<artifactId>/maven-metadata.xml` —— 制品级版本清单；
 * - `<groupPath>/<artifactId>/<version>/<file>` —— 某个版本的具体文件（可以是 metadata，也可以是制品）。
 * 组级清单（只有 groupPath）不单独支持：Maven 客户端从不请求它，而生成它要把整个仓库扫一遍。
 */
export function parseMavenPath(segments) {
  const parts = (segments || []).filter(Boolean)
  if (parts.length < 3) return null
  const isMetadata = (value) => value === 'maven-metadata.xml' || /^maven-metadata-[A-Za-z0-9._-]+\.xml$/.test(value)
  if (isMetadata(parts[parts.length - 1])) {
    const artifactId = parts[parts.length - 2]
    const groupPath = parts.slice(0, -2)
    if (groupPath.length === 0) return null
    return { kind: 'artifact-metadata', groupPath, groupId: groupPath.join('.'), artifactId }
  }
  if (parts.length < 4) return null
  const fileName = parts[parts.length - 1]
  const version = parts[parts.length - 2]
  const artifactId = parts[parts.length - 3]
  const groupPath = parts.slice(0, -3)
  if (groupPath.length === 0) return null
  return { kind: 'file', groupPath, groupId: groupPath.join('.'), artifactId, version, fileName }
}

/**
 * 仓库对象：所有生态共用的三个入口（resolve / catalog / download）。
 *
 * - resolve：一次 GET 到底要哪份字节（或一份**由索引生成**的清单），调用方负责把它变成 HTTP 响应；
 * - catalog：仓库里有哪些包（运维视图，走只读路由）；
 * - download：按坐标把字节流交出去，和 CAS 下载共用同一段 Range 逻辑。
 */
export function createPackageRepository({ index, store, baseUrl = '', listReleases = () => [] }) {
  // base 已经带上部署前缀（形如 http://host/api/plugins/cicd），各生态再各自接自己的段。
  const trimBase = String(baseUrl || '').replace(/\/+$/, '')

  /** 生产环境里 release 的「最新版本」以部署过的为准；没部署过的包退回登记顺序。 */
  function latestOf(entries, fallback) {
    const deployed = new Set(listReleases().map((item) => String(item || '')).filter(Boolean))
    const sorted = sortVersions(entries.map((entry) => entry.version))
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      if (deployed.has(sorted[i])) return sorted[i]
    }
    return fallback || sorted[sorted.length - 1] || ''
  }

  function fileOf(entry) {
    const fetched = store.open(entry.digest)
    return { digest: entry.digest, bytes: fetched.bytes, path: fetched.path, mediaType: entry.mediaType || mediaTypeFor(entry.extension) }
  }

  function resolveMaven(segments) {
    const parsed = parseMavenPath(segments)
    if (!parsed) return null
    if (parsed.kind === 'artifact-metadata') {
      const entries = index.versions({ ecosystem: 'maven', scope: parsed.groupId, name: parsed.artifactId })
      // 一个版本都没有也要回 200 + 空 metadata：404 会让 mvn 把它当成「仓库坏了」并在多仓库时逐个报错。
      const body = buildMavenMetadata({
        groupId: parsed.groupId,
        artifactId: parsed.artifactId,
        entries: [...new Set(entries.map((entry) => entry.version))],
      })
      return { kind: 'generated', body, mediaType: 'application/xml', filename: 'maven-metadata.xml' }
    }
    const known = index.versions({ ecosystem: 'maven', scope: parsed.groupId, name: parsed.artifactId })
      .filter((item) => item.version === parsed.version)
    if (known.length === 0) return null
    // 文件名要能对上**已登记**的那一份：`foo-1.0.jar` 与 `foo-1.0-sources.jar` 是两个坐标，
    // 允许随意拼文件名就等于允许用一个坐标下载另一份字节。
    for (const candidate of known) {
      const name = mavenFileName(parsed.artifactId, parsed.version, candidate.classifier, candidate.extension)
      if (name === parsed.fileName) return { kind: 'file', entry: candidate, ...fileOf(candidate), filename: name }
    }
    return null
  }

  function resolveNpm(segments) {
    const parts = (segments || []).filter(Boolean)
    if (parts.length === 0) return null
    // 下载：`<name>/-/<basename>-<version>.tgz`（scoped 包前面多两段，由 parts 自己决定）。
    const dashIndex = parts.indexOf('-')
    if (dashIndex > 0) {
      const nameParts = parts.slice(0, dashIndex)
      const fileName = parts[parts.length - 1]
      if (parts.length !== dashIndex + 2) return null
      const split = splitNpmName(nameParts.join('/'))
      const entries = index.versions({ ecosystem: 'npm', scope: split.scope, name: split.name })
      for (const entry of entries) {
        if (npmTarballName(split.full, entry.version) === fileName) {
          const file = fileOf(entry)
          return { kind: 'file', entry, ...file, filename: fileName, mediaType: 'application/gzip' }
        }
      }
      return null
    }
    const split = splitNpmName(parts.join('/'))
    const entries = index.versions({ ecosystem: 'npm', scope: split.scope, name: split.name })
    if (entries.length === 0) return null
    const versions = sortVersions(entries.map((entry) => entry.version))
    const latest = latestOf(entries, versions[versions.length - 1])
    const tags = { latest }
    // `latest` 必须有；其余 tag 由登记时的 meta.tags 决定（发版脚本写 `next` / `beta` 时用得上）。
    for (const entry of entries) {
      for (const tag of Array.isArray(entry.meta?.tags) ? entry.meta.tags : []) {
        if (typeof tag === 'string' && tag && tag !== 'latest') tags[tag] = entry.version
      }
    }
    const doc = buildPackument({ fullName: split.full, versions: entries, tags, baseUrl: trimBase })
    return { kind: 'generated', body: JSON.stringify(doc, null, 2), mediaType: 'application/json', filename: `${split.name}.json` }
  }

  function resolvePypi(segments) {
    const parts = (segments || []).filter(Boolean)
    if (parts.length === 0) return null
    const project = normalizePyPIname(parts[0])
    // 分发文件名：给了就以入库时记下的为准（wheel 的文件名是分发契约，不能被归一改写）。
    const fileNameOf = (entry) => entry.meta?.filename || pypiFilename(project, entry.version, entry.extension, entry.classifier)
    const entries = []
    // PyPI 名字是归一过的（大小写、`_`/`.`/`-` 等价），所以先按归一形式找真实登记名再取版本。
    const wanted = new Set(pypiNameCandidates(parts[0]).map(normalizePyPIname))
    for (const item of index.lookupEcosystem('pypi')) {
      if (!wanted.has(normalizePyPIname(item.name))) continue
      entries.push(...index.versions({ ecosystem: 'pypi', scope: item.scope, name: item.name }))
    }
    if (entries.length === 0) return null
    if (parts.length === 1) {
      const files = entries.map((entry) => ({
        filename: fileNameOf(entry),
        url: `${trimBase}/simple/${project}/${fileNameOf(entry)}`,
        digest: entry.digest,
        bytes: entry.bytes,
        requiresPython: entry.meta?.requires_python || '',
      }))
      return { kind: 'simple', project, files }
    }
    const fileName = parts[parts.length - 1]
    for (const entry of entries) {
      if (fileNameOf(entry) === fileName) {
        const file = fileOf(entry)
        return { kind: 'file', entry, ...file, filename: fileName }
      }
    }
    return null
  }

  return {
    baseUrl: trimBase,
    resolve(ecosystem, segments) {
      if (ecosystem === 'maven') return resolveMaven(segments)
      if (ecosystem === 'npm') return resolveNpm(segments)
      if (ecosystem === 'pypi') return resolvePypi(segments)
      return null
    },
    catalog(ecosystem = '') {
      const list = ecosystem ? [ecosystem] : ECOSYSTEMS
      const out = {}
      for (const current of list) {
        out[current] = index.lookupEcosystem(current).map((item) => ({
          ...item,
          versions: index.versions({ ecosystem: current, scope: item.scope, name: item.name })
            .map((entry) => ({ version: entry.version, digest: entry.digest, bytes: entry.bytes, classifier: entry.classifier, extension: entry.extension })),
        }))
      }
      return { count: index.count(), repos: out }
    },
    latestOf,
    fileOf,
  }
}

export { packageError }