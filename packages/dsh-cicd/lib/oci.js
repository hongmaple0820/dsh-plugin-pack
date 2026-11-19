/**
 * OCI Distribution v2（P5-4）：让 `docker push` / `docker pull` / `mvn`·`helm` 的镜像层都能落到我们的 CAS 上。
 *
 * 为什么需要它：P3 的容器 Actuator 要按 **digest** 起容器（`docker pull repo@sha256:…`），而
 * registry 的 manifest 是一个 JSON，它引用的 config/layer blob 必须已经存在。没有 registry，
 * 「部署一个镜像」就只能靠 `docker save | ssh docker load`，那条路上 digest 不可信、
 * 回滚也只能按 tag 回滚——正是 07-deploy.md 明令禁止的「按 tag 回滚」。
 *
 * ## 只实现分发协议里部署真正用到的那一段
 *
 *   GET    /v2/                                  版本探针（客户端靠它决定走 v1 还是 v2）
 *   HEAD|GET /v2/<name>/blobs/<digest>           层字节（Range / 302 到别处）
 *   POST   /v2/<name>/blobs/uploads/             开一个上传会话（或 `?digest=` 直接挂已有 blob）
 *   PATCH  /v2/<name>/blobs/uploads/<id>         追加字节（单段上传，跨域也不做分片合并）
 *   PUT    /v2/<name>/blobs/uploads/<id>?digest= 提交，校验 digest 后落 CAS
 *   DELETE /v2/<name>/blobs/uploads/<id>         放弃上传
 *   PUT|GET|HEAD /v2/<name>/manifests/<ref>      manifest（`<ref>` 是 tag 或 digest）
 *   GET    /v2/<name>/tags/list                  标签清单
 *   DELETE /v2/<name>/manifests/<digest>         删 tag（按 digest 删会删掉所有指向它的 tag）
 *
 * ## 三条不能省的判据
 *
 * 1. **blob 必须先于 manifest 存在**。manifest 引用一个不存在的 layer 时宁可 400，也不要收下——
 *    收下了就会在上线那一刻才发现拉不下来，而那一刻正是最不该发现的时刻。
 * 2. **manifest 的 digest 是它自己的 canonical JSON 的 sha256**，不是别的东西。这里用
 *    `canonicalJson()` 重算一遍并和 `Docker-Content-Digest` 对比，客户端算错了就 400。
 * 3. **传了 `expectedDigest`（调用方从 CAS 拿到的）时不信任请求里的 tag**：tag 可以被覆盖，
 *    digest 不会。部署链路一律走 digest 路径。
 *
 * ## 认证
 *
 * 分发协议自己的流程是：匿名请求 → 401 + `WWW-Authenticate: Bearer realm=… service=…` →
 * 客户端去 realm 换 token → 带 token 重试。这里把 **Host 的** `/api/plugins/cicd/oci-token`
 * 当作那个 realm，token 就是 Host 自己的登录会话 / API token，换回来的是一张 scope 受限、
 * 15 分钟过期的 JWT 形态票（`base64url(payload).base64url(hmac)`，没有标准库依赖）。
 *
 * 这样做的代价：一个**没有** Host 账号的 docker 客户端必须先 `docker login` 一个真实用户名密码。
 * 换来的好处：镜像仓库与应用其余部分是同一套身份，吊销一个账号就同时吊销了他的 push 能力。
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export const OCI_ERRORS = {
  NAME_INVALID: 'OCI_NAME_INVALID',
  DIGEST_INVALID: 'OCI_DIGEST_INVALID',
  MANIFEST_INVALID: 'OCI_MANIFEST_INVALID',
  MANIFEST_UNKNOWN: 'OCI_MANIFEST_UNKNOWN',
  MANIFEST_BLOB_UNKNOWN: 'OCI_MANIFEST_BLOB_UNKNOWN',
  BLOB_UNKNOWN: 'OCI_BLOB_UNKNOWN',
  UPLOAD_UNKNOWN: 'OCI_UPLOAD_UNKNOWN',
  UPLOAD_INVALID: 'OCI_UPLOAD_INVALID',
  UNSUPPORTED: 'OCI_UNSUPPORTED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  DENIED: 'DENIED',
}

/**
 * 分发协议错误码 → HTTP 状态。docker 客户端读的是 `code`，所以这张表必须和规范逐字一致：
 * 客户端看到 `MANIFEST_UNKNOWN` 会去 pull fallback，看到 `UNSUPPORTED` 会放弃重试。
 * 状态码写错比写错消息更糟——客户端不会打印消息。
 */
const OCI_STATUS = {
  [OCI_ERRORS.NAME_INVALID]: 400,
  [OCI_ERRORS.DIGEST_INVALID]: 400,
  [OCI_ERRORS.MANIFEST_INVALID]: 400,
  [OCI_ERRORS.MANIFEST_UNKNOWN]: 404,
  [OCI_ERRORS.MANIFEST_BLOB_UNKNOWN]: 400,
  [OCI_ERRORS.BLOB_UNKNOWN]: 404,
  [OCI_ERRORS.UPLOAD_UNKNOWN]: 404,
  [OCI_ERRORS.UPLOAD_INVALID]: 400,
  [OCI_ERRORS.UNSUPPORTED]: 405,
  [OCI_ERRORS.UNAUTHORIZED]: 401,
  [OCI_ERRORS.DENIED]: 403,
}

export function ociStatus(code) {
  return OCI_STATUS[code] || 500
}

export function ociError(code, message, extra = {}) {
  const error = new Error(message || code)
  error.code = code
  error.extra = extra
  return error
}

/**
 * 仓库名：`[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*(/[a-z0-9]+…)*`。
 * 大写是**硬错误**而不是被默默小写化：`docker push MyApp` 和 `docker pull myapp` 是两个仓库，
 * 悄悄改名会让「我推上去了，怎么拉不到」变成一个无法调试的问题。
 */
const NAME_RE = new RegExp('^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*)*$')

export function parseRepository(name) {
  const value = String(name || '')
  if (!value || value.length > 255 || !NAME_RE.test(value)) {
    throw ociError(OCI_ERRORS.NAME_INVALID, `仓库名 “${value}” 不合法（只能小写字母数字与 . _ - ，用 / 分层）`)
  }
  return value
}

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/

export function parseOCIDigest(value) {
  const text = String(value || '').trim().toLowerCase()
  if (!DIGEST_RE.test(text)) throw ociError(OCI_ERRORS.DIGEST_INVALID, `digest “${value}” 不合法（只要 sha256:<64 hex>）`)
  return text
}

/**
 * tag：`[\w][\w.-]{0,127}`。冒号绝不能出现在 tag 里——`repo:tag` 与 `repo@digest` 是两个语法，
 * 混进来会让 `manifests/<ref>` 的解析产生歧义（那正是 registry 实现最常见的注入点）。
 */
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/

export function parseTag(value) {
  const text = String(value || '')
  if (!TAG_RE.test(text)) throw ociError(OCI_ERRORS.DIGEST_INVALID, `tag “${value}” 不合法`)
  return text
}

/** `<ref>` 既可能是 tag 也可能是 digest。返回 {kind:'digest'|'tag', value}。 */
export function parseReference(value) {
  const text = String(value || '')
  if (text.startsWith('sha256:')) return { kind: 'digest', value: parseOCIDigest(text) }
  return { kind: 'tag', value: parseTag(text) }
}

/**
 * Canonical JSON：键排序、无空格、非 ASCII 不转义。manifest 的 digest 由它决定，
 * 所以它必须**稳定**——用 `JSON.stringify` 直接序列化依赖对象键的插入顺序，
 * 客户端和服务端读同一个 manifest 会算出两个 digest，而两者看起来都对。
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

export const MEDIA_TYPES = {
  DOCKER_MANIFEST_V2: 'application/vnd.docker.distribution.manifest.v2+json',
  DOCKER_MANIFEST_LIST: 'application/vnd.docker.distribution.manifest.list.v2+json',
  DOCKER_CONFIG: 'application/vnd.docker.container.image.v1+json',
  DOCKER_LAYER: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
  DOCKER_FOREIGN_LAYER: 'application/vnd.docker.image.rootfs.foreign.diff.tar.gzip',
  DOCKER_PLUGIN_CONFIG: 'application/vnd.docker.plugin.v1+json',
  OCI_MANIFEST: 'application/vnd.oci.image.manifest.v1+json',
  OCI_INDEX: 'application/vnd.oci.image.index.v1+json',
  OCI_CONFIG: 'application/vnd.oci.image.config.v1+json',
  OCI_LAYER: 'application/vnd.oci.image.layer.v1.tar+gzip',
  OCI_LAYER_NONDISTRIBUTABLE: 'application/vnd.oci.image.layer.nondistributable.v1.tar+gzip',
  OCI_REFERrers: 'application/vnd.oci.image.index.v1+json',
  OCI_EMPTY: 'application/vnd.oci.empty.v1+json',
}

/**
 * 我们能收下的 manifest 类型。`MANIFEST_LIST` / `OCI_INDEX` 是「一组平台的 manifest」，
 * 它的 children 也是 manifest——所以校验时要**递归**检查，否则一个 index 可以指向不存在的子 manifest。
 */
const MANIFEST_TYPES = new Set([
  MEDIA_TYPES.DOCKER_MANIFEST_V2,
  MEDIA_TYPES.DOCKER_MANIFEST_LIST,
  MEDIA_TYPES.OCI_MANIFEST,
  MEDIA_TYPES.OCI_INDEX,
])

export function isManifestType(mediaType) {
  return MANIFEST_TYPES.has(String(mediaType || ''))
}

/**
 * 解出 manifest 引用到的 blob / 子 manifest 摘要。
 *
 * 注意 `foreign` 层：`docker save` 出来的 Windows 基础镜像会引用 `foreign` 层，那些字节
 * 本来就不在仓库里（由别的 registry 提供），所以它们**不算缺失**。把它们当缺失会让
 * 一个本来完好的镜像永远推不上去。
 */
export function manifestReferences(manifest) {
  const refs = { blobs: [], manifests: [], config: '' }
  if (!manifest || typeof manifest !== 'object') return refs
  if (manifest.config?.digest) refs.config = String(manifest.config.digest)
  for (const layer of Array.isArray(manifest.layers) ? manifest.layers : []) {
    if (!layer?.digest) continue
    if (layer.mediaType === MEDIA_TYPES.DOCKER_FOREIGN_LAYER) continue
    if (layer.mediaType === MEDIA_TYPES.OCI_LAYER_NONDISTRIBUTABLE) continue
    refs.blobs.push(String(layer.digest))
  }
  for (const child of Array.isArray(manifest.manifests) ? manifest.manifests : []) {
    if (child?.digest) refs.manifests.push({ digest: String(child.digest), mediaType: String(child.mediaType || '') })
  }
  return refs
}

/** 校验 manifest 结构。只查我们真正依赖的字段，不做 JSON Schema 级别的完备性检查。 */
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw ociError(OCI_ERRORS.MANIFEST_INVALID, 'manifest 必须是 JSON 对象')
  }
  if (Number(manifest.schemaVersion) !== 2) {
    throw ociError(OCI_ERRORS.MANIFEST_INVALID, 'manifest.schemaVersion 必须是 2')
  }
  if (!manifest.mediaType) manifest.mediaType = manifest.manifests ? MEDIA_TYPES.OCI_INDEX : MEDIA_TYPES.OCI_MANIFEST
  if (!isManifestType(manifest.mediaType)) {
    throw ociError(OCI_ERRORS.MANIFEST_INVALID, `manifest.mediaType “${manifest.mediaType}” 不支持`)
  }
  const isIndex = Array.isArray(manifest.manifests)
  if (isIndex) {
    for (const child of manifest.manifests) {
      if (!child?.digest) throw ociError(OCI_ERRORS.MANIFEST_INVALID, 'manifests[] 项缺少 digest')
      parseOCIDigest(child.digest)
    }
  } else {
    if (!manifest.config?.digest) throw ociError(OCI_ERRORS.MANIFEST_INVALID, 'manifest.config.digest 缺失')
    parseOCIDigest(manifest.config.digest)
    for (const layer of Array.isArray(manifest.layers) ? manifest.layers : []) {
      if (!layer?.digest) throw ociError(OCI_ERRORS.MANIFEST_INVALID, 'layers[] 项缺少 digest')
      parseOCIDigest(layer.digest)
    }
  }
  return manifest
}

const ALG = 'sha256'

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(text) {
  const padded = String(text).replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64')
}

function hmac(secret, text) {
  return createHmac('sha256', String(secret)).update(text).digest()
}

/**
 * scope 字符串按规范是 `repository:<name>:pull,push`，多个 scope 以空格分隔（同一个 token 可以覆盖多个仓库）。
 * 解析成 [{name, actions:Set}]，比较时**不做前缀匹配**——`library/app` 的权限不能顺带给出 `library/app-evil`。
 */
export function parseScope(text) {
  const out = []
  for (const part of String(text || '').split(/\s+/).filter(Boolean)) {
    const match = /^repository:([^:]+):(.+)$/.exec(part)
    if (!match) continue
    out.push({ name: match[1], actions: new Set(match[2].split(',').map((item) => item.trim()).filter(Boolean)) })
  }
  return out
}

export function scopeAllows(scopes, name, action) {
  for (const scope of scopes) {
    if (scope.name === name && scope.actions.has(action)) return true
  }
  return false
}

/**
 * 签发/校验分发用的票。
 *
 * 为什么不直接复用 Host 会话 cookie：docker 客户端只会发 `Authorization: Bearer`，
 * 而且它会把 token 缓存在内存里跨请求复用——把长效会话 cookie 交给它等于交给它一把长期钥匙。
 * 所以这里签 15 分钟的短票，并且票里写死 scope：拿到 pull 票的客户端推不上去。
 */
export function createTokenIssuer({ secret, ttlSec = 900, issuer = 'dsh-cicd', now = Date.now }) {
  const key = String(secret || '')
  if (key.length < 16) throw new Error('OCI token 密钥至少 16 字节')
  const lifetime = Number(ttlSec) > 0 ? Number(ttlSec) : 900

  function sign(payload) {
    const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    const body = b64url(JSON.stringify(payload))
    const data = `${head}.${body}`
    return `${data}.${b64url(hmac(key, data))}`
  }

  return {
    ttlSec: lifetime,
    issue({ subject = '', scopes = [], audience = 'oci', access = [] } = {}) {
      const at = Math.floor(now() / 1000)
      return {
        token: sign({
          iss: issuer,
          sub: String(subject),
          aud: String(audience),
          scope: String(scopes.join(' ')),
          iat: at,
          nbf: at - 5,
          exp: at + lifetime,
          access,
        }),
        expiresIn: lifetime,
        issuedAt: new Date(at * 1000).toISOString(),
      }
    },
    verify(token) {
      const parts = String(token || '').split('.')
      if (parts.length !== 3) return { ok: false, reason: '格式不对' }
      const expected = hmac(key, `${parts[0]}.${parts[1]}`)
      let actual
      try { actual = fromB64url(parts[2]) } catch { return { ok: false, reason: '签名不可解析' } }
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return { ok: false, reason: '签名不匹配' }
      let payload
      try { payload = JSON.parse(fromB64url(parts[1]).toString('utf8')) } catch { return { ok: false, reason: '载荷不可解析' } }
      const at = Math.floor(now() / 1000)
      if (Number(payload.nbf) > at) return { ok: false, reason: '尚未生效' }
      if (Number(payload.exp) <= at) return { ok: false, reason: '已过期' }
      return { ok: true, payload, scopes: parseScope(payload.scope) }
    },
  }
}

export const UPLOAD_SESSION_TTL_MS = 30 * 60 * 1000

/**
 * 上传会话。**只存在内存里**：一个没提交的上传会话在进程重启后没有任何价值（客户端那边
 * 已经因为连接断开重试了），把它写进 DB 只会留下永远查不清的半个文件。
 * 但**服务端的临时文件**必须能清掉——见 createUploadSessions().sweep()。
 */
export function createUploadSessions({ dir, fs, join, randomId, now = Date.now }) {
  const sessions = new Map()

  function start({ repository, mount = '' }) {
    if (mount) {
      const mounted = parseOCIDigest(mount)
      sessions.set(mounted, { id: mounted, repository, mounted: true, createdAt: now(), file: '' })
      return { id: mounted, mounted }
    }
    const id = randomId()
    const file = join(dir, `${id}.part`)
    sessions.set(id, { id, repository, mounted: false, createdAt: now(), file })
    return { id, mounted: '' }
  }

  function take(id) {
    const session = sessions.get(String(id))
    if (!session) throw ociError(OCI_ERRORS.UPLOAD_UNKNOWN, `上传会话 ${id} 不存在或已过期`)
    if (session.repository !== undefined && now() - session.createdAt > UPLOAD_SESSION_TTL_MS) {
      sessions.delete(String(id))
      try { fs.rmSync(session.file, { force: true }) } catch { /* 临时文件清不掉不影响结论 */ }
      throw ociError(OCI_ERRORS.UPLOAD_UNKNOWN, `上传会话 ${id} 已过期`)
    }
    return session
  }

  function drop(id) {
    const session = sessions.get(String(id))
    if (!session) return false
    sessions.delete(String(id))
    if (session.file) { try { fs.rmSync(session.file, { force: true }) } catch { /* best effort */ } }
    return true
  }

  function sweep() {
    const removed = []
    for (const [id, session] of sessions) {
      if (!session.file) continue
      if (now() - session.createdAt <= UPLOAD_SESSION_TTL_MS) continue
      sessions.delete(id)
      try { fs.rmSync(session.file, { force: true }) } catch { /* best effort */ }
      removed.push(id)
    }
    return removed
  }

  return { start, take, drop, sweep, size: () => sessions.size, _sessions: sessions }
}
