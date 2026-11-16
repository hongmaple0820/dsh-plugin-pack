// Host configuration: inline config.hosts first, then the DSH_REMOTE_HOSTS file, then the
// package-local hosts.json. Everything here is pure and injectable so tests never touch SSH.
// Secrets (password / private key material) live only in the returned connection spec and are
// never included in a public listing.

import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { DEFAULT_PROTOCOL_ID, getProtocol, hasProtocol, protocolPort } from './protocols/index.js'

const LIB_DIR = dirname(fileURLToPath(import.meta.url))

/** Package root = parent of lib/. */
export const PACKAGE_ROOT = dirname(LIB_DIR)

/** Default in-package hosts file (not shipped; a profile patch or env var usually supplies hosts). */
export const PACKAGE_HOSTS_PATH = join(PACKAGE_ROOT, 'hosts.json')

/** Default private key candidates, best first. */
export const DEFAULT_KEY_NAMES = Object.freeze(['id_ed25519', 'id_rsa', 'id_ecdsa'])

/** Alias shape accepted by the panel's host form and the host-save route. */
export const HOST_ALIAS_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

/** Maximum bastion hops (jump chain length) accepted for one host. */
export const MAX_JUMP_HOPS = 3

/** Environment / group / tag label shape: 1-32 lowercase letters, digits or hyphens. */
export const HOST_LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

/** Maximum tags per host. */
export const MAX_HOST_TAGS = 8

/** The write refusal when hosts come from the inline patch config. */
export const CONFIG_HOSTS_EDIT_HINT = '主机来自 config.hosts（patch 内联），面板改动不会生效；请改 cordis.patch.yml 的 dsh-remote.config.hosts，或先删掉该键改用 hosts 文件'

const DEFAULT_PORT = 22
const INLINE_REF = /^(?:([^@\s]+)@)?([A-Za-z0-9._-]+)(?::(\d{1,5}))?$/

/** Normalize a host's protocol id, defaulting old records to SSH. */
export function normalizeProtocol(value, alias = 'host') {
  const id = typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : DEFAULT_PROTOCOL_ID
  if (!hasProtocol(id)) {
    throw new Error(`主机 "${alias}" 的协议 "${id}" 不支持：可用协议 ssh、telnet、rdp、vnc`)
  }
  return id
}

/** @returns {string|null} the first readable default private key path, or null. */
export function findDefaultKeyPath(home = homedir()) {
  for (const name of DEFAULT_KEY_NAMES) {
    const candidate = join(home, '.ssh', name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Coerce a configured port; throws a readable error for nonsense values. */
export function normalizePort(value, alias = 'host', fallback = DEFAULT_PORT) {
  if (value === undefined || value === null || value === '') return fallback
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`主机 "${alias}" 的端口不合法：${String(value)}（应为 1-65535 的整数）`)
  }
  return port
}

/**
 * Normalize a bastion chain: accepts `"a"`, `"a,b"` or `["a", "b"]`; returns alias list.
 * Rejects unknown shapes, self-reference, duplicates and chains longer than MAX_JUMP_HOPS.
 */
export function normalizeJumpChain(value, alias = 'host') {
  if (value === undefined || value === null || value === '') return []
  const raw = Array.isArray(value) ? value : String(value).split(',')
  const chain = []
  for (const item of raw) {
    const hop = String(item ?? '').trim()
    if (!hop) continue
    if (!HOST_ALIAS_PATTERN.test(hop)) {
      throw new Error(`主机 "${alias}" 的跳板 "${hop}" 不是合法别名（1-64 位字母、数字、点、下划线、连字符）`)
    }
    if (hop === alias) throw new Error(`主机 "${alias}" 的跳板不能是自己`)
    if (chain.includes(hop)) throw new Error(`主机 "${alias}" 的跳板重复：${hop}`)
    chain.push(hop)
  }
  if (chain.length > MAX_JUMP_HOPS) {
    throw new Error(`主机 "${alias}" 的跳板最多 ${MAX_JUMP_HOPS} 跳（当前 ${chain.length} 跳）`)
  }
  return chain
}

function looksLikeHostMap(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0
}

function normalizeHostLabel(value, alias, field) {
  const label = typeof value === 'string' ? value.trim() : ''
  if (label === '') return ''
  if (!HOST_LABEL_PATTERN.test(label)) {
    throw codedError(
      'HOST_META_INVALID',
      `主机 "${alias}" 的 ${field} "${label}" 不合法：应为 1-32 位小写字母、数字或连字符`,
    )
  }
  return label
}

function normalizeHostTags(value, alias) {
  if (value === undefined || value === null || value === '') return []
  const raw = Array.isArray(value) ? value : String(value).split(',')
  const tags = []
  for (const item of raw) {
    const tag = String(item ?? '').trim()
    if (tag === '') continue
    if (!HOST_LABEL_PATTERN.test(tag)) {
      throw codedError(
        'HOST_META_INVALID',
        `主机 "${alias}" 的标签 "${tag}" 不合法：应为 1-32 位小写字母、数字或连字符`,
      )
    }
    if (tags.includes(tag)) {
      throw codedError('HOST_META_INVALID', `主机 "${alias}" 的标签重复：${tag}`)
    }
    tags.push(tag)
  }
  if (tags.length > MAX_HOST_TAGS) {
    throw codedError('HOST_META_INVALID', `主机 "${alias}" 的标签最多 ${MAX_HOST_TAGS} 个（当前 ${tags.length} 个）`)
  }
  return tags
}

/** Normalize the env / group / tags metadata of one host entry. */
export function normalizeHostMeta(alias, entry = {}) {
  return {
    env: normalizeHostLabel(entry.env, alias, 'env'),
    group: normalizeHostLabel(entry.group, alias, 'group'),
    tags: normalizeHostTags(entry.tags, alias),
  }
}

/**
 * Normalize one configured host entry. Does not resolve credentials.
 * @returns {{ host: string, port: number, user: string, password?: string, passwordEnv?: string, privateKeyPath?: string, passphrase?: string, disabled: boolean, note: string|null }}
 */
export function normalizeHostEntry(alias, entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`主机 "${alias}" 的配置不是对象`)
  }
  const host = typeof entry.host === 'string' ? entry.host.trim() : ''
  if (!host) throw new Error(`主机 "${alias}" 缺少 host`)
  const protocol = normalizeProtocol(entry.protocol, alias)
  const meta = normalizeHostMeta(alias, entry)
  const normalized = {
    host,
    protocol,
    port: normalizePort(entry.port, alias, protocolPort(protocol)),
    user: typeof entry.user === 'string' && entry.user.trim() ? entry.user.trim() : 'root',
    jump: normalizeJumpChain(entry.jump ?? entry.jumps, alias),
    env: meta.env,
    group: meta.group,
    tags: meta.tags,
    disabled: entry.disabled === true,
    note: typeof entry.note === 'string' && entry.note.trim() ? entry.note.trim() : null,
  }
  if (typeof entry.password === 'string' && entry.password.length > 0) normalized.password = entry.password
  if (typeof entry.passwordEnv === 'string' && entry.passwordEnv.trim()) normalized.passwordEnv = entry.passwordEnv.trim()
  if (typeof entry.privateKeyPath === 'string' && entry.privateKeyPath.trim()) normalized.privateKeyPath = entry.privateKeyPath.trim()
  if (typeof entry.passphrase === 'string' && entry.passphrase.length > 0) normalized.passphrase = entry.passphrase
  return normalized
}

/** Normalize a whole alias map (config.hosts shape). */
export function normalizeHostMap(raw) {
  if (!looksLikeHostMap(raw)) return {}
  const hosts = {}
  for (const [alias, entry] of Object.entries(raw)) {
    const key = String(alias).trim()
    if (!key) continue
    hosts[key] = normalizeHostEntry(key, entry)
  }
  return hosts
}

/**
 * Parse a hosts JSON document. Accepts either `{ hosts: {...} }` (legacy server.js shape) or a bare
 * alias map. Returns an error instead of throwing so callers can surface it to the model.
 */
export function parseHostsDocument(text, source = 'hosts') {
  let document
  try {
    document = JSON.parse(String(text ?? ''))
  } catch (error) {
    return { hosts: {}, source, error: `主机配置 ${source} 不是合法 JSON：${error.message}` }
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return { hosts: {}, source, error: `主机配置 ${source} 顶层必须是对象` }
  }
  const raw = document.hosts && typeof document.hosts === 'object' ? document.hosts : document
  try {
    const hosts = normalizeHostMap(raw)
    if (Object.keys(hosts).length === 0) {
      return { hosts: {}, source, error: `主机配置 ${source} 里没有任何主机` }
    }
    return { hosts, source, error: null }
  } catch (error) {
    return { hosts: {}, source, error: `主机配置 ${source} 无效：${error.message}` }
  }
}

function readHostsFile(path, source) {
  if (!existsSync(path)) {
    return { hosts: {}, source, path, error: `主机配置文件不存在：${path}` }
  }
  try {
    const parsed = parseHostsDocument(readFileSync(path, 'utf8'), source)
    return { ...parsed, path }
  } catch (error) {
    return { hosts: {}, source, path, error: `读取主机配置文件失败：${path}（${error.message}）` }
  }
}

/**
 * Resolve the active host map with documented precedence.
 * @returns {{ hosts: Record<string, object>, source: 'config'|'env'|'package'|'none', path: string|null, error: string|null }}
 */
export function loadHosts({ inlineHosts, env = process.env, packageHostsPath = PACKAGE_HOSTS_PATH } = {}) {
  if (looksLikeHostMap(inlineHosts)) {
    try {
      return { hosts: normalizeHostMap(inlineHosts), source: 'config', path: null, error: null }
    } catch (error) {
      return { hosts: {}, source: 'config', path: null, error: `config.hosts 无效：${error.message}` }
    }
  }

  const envPath = typeof env?.DSH_REMOTE_HOSTS === 'string' && env.DSH_REMOTE_HOSTS.trim()
    ? env.DSH_REMOTE_HOSTS.trim()
    : null
  if (envPath) return readHostsFile(envPath, 'DSH_REMOTE_HOSTS')

  if (existsSync(packageHostsPath)) return readHostsFile(packageHostsPath, 'package')

  return {
    hosts: {},
    source: 'none',
    path: null,
    error: `未配置任何远程主机：config.hosts 为空、环境变量 DSH_REMOTE_HOSTS 未设置、包内 ${packageHostsPath} 也不存在。请在 cordis.patch.yml 的 dsh-remote 行写 config.hosts，或把 JSON 主机文件路径放进 DSH_REMOTE_HOSTS。`,
  }
}

/**
 * Resolve one configured alias into a connection spec, including its bastion chain.
 * `seen` catches jump cycles (a → b → a) before any socket is opened.
 */
export function resolveAliasSpec(alias, { hosts = {}, env = process.env, hasDefaultKey = () => Boolean(findDefaultKeyPath()) } = {}, seen = new Set()) {
  const reference = String(alias || '').trim()
  const entry = hosts[reference]
  if (!entry) {
    const known = Object.keys(hosts).slice(0, 12).join('、') || '（无）'
    throw new Error(`未知主机别名 "${reference}"：可用别名 ${known}`)
  }
  if (seen.has(reference)) {
    throw new Error(`跳板链存在循环：${[...seen, reference].join(' → ')}`)
  }
  if (entry.disabled) throw new Error(`主机别名 "${reference}" 已禁用：${entry.note || '无说明'}`)
  const protocol = entry.protocol || DEFAULT_PROTOCOL_ID
  const spec = {
    key: reference,
    alias: reference,
    host: entry.host,
    port: entry.port || protocolPort(protocol),
    user: entry.user || 'root',
    protocol,
    note: entry.note || null,
    inline: false,
    jump: [],
  }
  // Non-SSH protocols have no remote credentials to resolve: telnet is a raw socket and
  // rdp/vnc run in a local client. Keep the spec free of key/password probing for them.
  if (protocol !== DEFAULT_PROTOCOL_ID) return spec
  if (entry.password) {
    spec.auth = 'password'
    spec.password = entry.password
  } else if (entry.passwordEnv) {
    const value = env?.[entry.passwordEnv]
    if (!value) {
      throw new Error(`主机 "${reference}" 的密码环境变量 ${entry.passwordEnv} 未设置（当前进程没有该变量）`)
    }
    spec.auth = 'password'
    spec.password = value
    spec.passwordEnv = entry.passwordEnv
  } else if (entry.privateKeyPath) {
    spec.auth = 'key'
    spec.privateKeyPath = entry.privateKeyPath
    if (entry.passphrase) spec.passphrase = entry.passphrase
  } else if (hasDefaultKey()) {
    spec.auth = 'default-key'
  } else {
    throw new Error(`主机 "${reference}" 无可用凭据：在 config.hosts 里配置 password、passwordEnv 或 privateKeyPath（本机也没有 ~/.ssh/id_ed25519 等默认私钥）`)
  }

  const chain = Array.isArray(entry.jump) ? entry.jump : []
  if (chain.length > 0) {
    const nextSeen = new Set([...seen, reference])
    spec.jump = chain.map((hopAlias) => {
      const hop = hosts[hopAlias]
      if (!hop) throw new Error(`主机 "${reference}" 的跳板 "${hopAlias}" 未在主机列表里定义`)
      if ((hop.protocol || DEFAULT_PROTOCOL_ID) !== DEFAULT_PROTOCOL_ID) {
        throw new Error(`主机 "${reference}" 的跳板 "${hopAlias}" 只能用 ssh 协议（当前是 ${hop.protocol}）`)
      }
      const hopSpec = (() => {
        try {
          return resolveAliasSpec(hopAlias, { hosts, env, hasDefaultKey }, nextSeen)
        } catch (error) {
          throw new Error(`主机 "${reference}" 的跳板 "${hopAlias}" 不可用：${error.message}`)
        }
      })()
      hopSpec.key = `jump:${hopAlias}`
      return hopSpec
    })
  }
  return spec
}

/**
 * Resolve a host reference into a connection spec. Accepts an alias from the host map, or the
 * ad-hoc `user@host[:port]` form (which may only use the local default private key — passwords
 * never travel through tool arguments because arguments end up in the session log).
 */
export function resolveHostRef(ref, { hosts = {}, env = process.env, hasDefaultKey = () => Boolean(findDefaultKeyPath()) } = {}, seen = new Set()) {
  const reference = typeof ref === 'string' ? ref.trim() : ''
  if (!reference) throw new Error('缺少主机：请传主机别名或 user@host[:port]')

  if (hosts[reference]) {
    return resolveAliasSpec(reference, { hosts, env, hasDefaultKey }, seen)
  }

  const aliases = Object.keys(hosts)
  // With a configured host map, a bare single-label word is almost always a mistyped alias.
  // Require user@host, a dotted host, or an explicit port before treating it as an ad-hoc host.
  const looksLikeAliasTypo = aliases.length > 0
    && !reference.includes('@')
    && !reference.includes(':')
    && !reference.includes('.')
  if (looksLikeAliasTypo) {
    throw new Error(`未知主机别名 "${reference}"：可用别名 ${aliases.slice(0, 12).join('、')}（临时主机请写 user@host[:port] 或带点的域名）`)
  }

  const inline = INLINE_REF.exec(reference)
  if (inline) {
    if (inline[3] !== undefined && Number(inline[3]) > 65535) {
      throw new Error(`主机 "${reference}" 的端口不合法：${inline[3]}`)
    }
    if (!hasDefaultKey()) {
      throw new Error(`临时主机 "${reference}" 只能使用本机默认私钥登录（未找到 ~/.ssh/id_ed25519 等）；需要密码认证请先在 config.hosts 里配置别名`)
    }
    return {
      key: reference,
      alias: null,
      host: inline[2],
      port: Number(inline[3] || DEFAULT_PORT),
      user: inline[1] || 'root',
      protocol: DEFAULT_PROTOCOL_ID,
      auth: 'default-key',
      inline: true,
      jump: [],
      note: null,
    }
  }

  const hint = aliases.length > 0 ? `可用别名：${aliases.slice(0, 12).join('、')}` : '当前没有任何别名'
  throw new Error(`未知主机 "${reference}"：既不是已配置别名，也不是 user@host[:port] 形式。${hint}（可用 remote_hosts 查看）`)
}

/** Auth readiness of one entry, without ever exposing the secret itself. */
function authStateOf(entry, env, defaultKey) {
  const hasPassword = typeof entry.password === 'string' && entry.password.length > 0
  const passwordEnv = entry.passwordEnv || null
  const privateKeyPath = typeof entry.privateKeyPath === 'string' && entry.privateKeyPath.length > 0 ? entry.privateKeyPath : null
  if (hasPassword) {
    return { auth: 'password', ready: true, issue: null, passwordEnv: null, hasPassword: true, privateKeyPath: null }
  }
  if (passwordEnv) {
    const present = Boolean(env?.[passwordEnv])
    return {
      auth: 'password',
      ready: present,
      issue: present ? null : `密码环境变量 ${passwordEnv} 未设置`,
      passwordEnv,
      hasPassword: false,
      privateKeyPath: null,
    }
  }
  if (privateKeyPath) {
    return { auth: 'key', ready: true, issue: null, passwordEnv: null, hasPassword: false, privateKeyPath }
  }
  if (defaultKey) {
    return { auth: 'default-key', ready: true, issue: null, passwordEnv: null, hasPassword: false, privateKeyPath: null }
  }
  return {
    auth: 'none',
    ready: false,
    issue: '没有 password / passwordEnv / privateKeyPath，且未找到默认私钥',
    passwordEnv: null,
    hasPassword: false,
    privateKeyPath: null,
  }
}

/**
 * Secret-free listing for remote_hosts and the HTTP API. A password value and key material are
 * never copied here; only auth mode, env-var name and the private key path are exposed.
 */
export function publicHosts(hosts, { env = process.env, hasDefaultKey = () => Boolean(findDefaultKeyPath()) } = {}) {
  const defaultKey = hasDefaultKey()
  return Object.entries(hosts || {}).map(([alias, entry]) => {
    const protocol = entry.protocol || DEFAULT_PROTOCOL_ID
    const state = authStateOf(entry, env, defaultKey)
    let { ready, issue } = state
    let auth = state.auth

    if (protocol === 'telnet') {
      ready = true
      auth = 'none'
    } else if (protocol === 'rdp' || protocol === 'vnc') {
      ready = true
      auth = 'none'
      issue = '需要本机安装对应的桌面客户端'
    }

    const jump = Array.isArray(entry.jump) ? [...entry.jump] : []
    let jumpIssue = null
    if (jump.length > 0 && protocol === DEFAULT_PROTOCOL_ID) {
      for (const hopAlias of jump) {
        const hop = hosts[hopAlias]
        if (!hop) {
          jumpIssue = `跳板 "${hopAlias}" 未在主机列表里定义`
          break
        }
        if ((hop.protocol || DEFAULT_PROTOCOL_ID) !== DEFAULT_PROTOCOL_ID) {
          jumpIssue = `跳板 "${hopAlias}" 只能用 ssh 协议`
          break
        }
        if (hop.disabled) {
          jumpIssue = `跳板 "${hopAlias}" 已禁用`
          break
        }
        const hopState = authStateOf(hop, env, defaultKey)
        if (!hopState.ready) {
          jumpIssue = `跳板 "${hopAlias}" 不可用：${hopState.issue || '缺少凭据'}`
          break
        }
      }
      if (jumpIssue) ready = false
    }

    if (entry.disabled) {
      ready = false
      issue = `已禁用：${entry.note || '无说明'}`
    }

    return {
      alias,
      host: entry.host,
      protocol,
      capabilities: getProtocol(protocol)?.capabilities || null,
      port: entry.port || protocolPort(protocol),
      user: entry.user || 'root',
      auth,
      ready,
      issue: jumpIssue || issue,
      jump,
      jumpIssue,
      passwordEnv: state.passwordEnv,
      hasPassword: state.hasPassword,
      privateKeyPath: state.privateKeyPath,
      disabled: Boolean(entry.disabled),
      note: entry.note || null,
      env: typeof entry.env === 'string' ? entry.env : '',
      group: typeof entry.group === 'string' ? entry.group : '',
      tags: Array.isArray(entry.tags) ? [...entry.tags] : [],
    }
  })
}

/**
 * Group hosts by env / group / tag for `GET /api/plugins/remote/groups`. Buckets with no host are
 * omitted; names and host aliases are sorted ascending so the JSON is stable.
 */
export function hostGroups(hosts) {
  const envs = new Map()
  const groups = new Map()
  const tags = new Map()
  const push = (map, name, alias) => {
    if (!name) return
    const list = map.get(name) || []
    list.push(alias)
    map.set(name, list)
  }
  for (const [alias, entry] of Object.entries(hosts || {})) {
    push(envs, typeof entry?.env === 'string' ? entry.env : '', alias)
    push(groups, typeof entry?.group === 'string' ? entry.group : '', alias)
    for (const tag of Array.isArray(entry?.tags) ? entry.tags : []) {
      push(tags, typeof tag === 'string' ? tag : '', alias)
    }
  }
  const buckets = (map) => [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, aliases]) => ({ name, hosts: [...aliases].sort() }))
  return { envs: buckets(envs), groups: buckets(groups), tags: buckets(tags) }
}

// ---------------------------------------------------------------------------------------------
// Writing the hosts file (panel add/edit/delete). Kept pure-ish and injectable: every function
// takes the file path, so tests write into a temp directory and never touch the package hosts.json.
// ---------------------------------------------------------------------------------------------

function codedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** Throw the 403-shaped error when the file or its directory cannot be written. */
export function assertWritableHostFile(filePath) {
  const path = String(filePath || '')
  if (!path) throw codedError('HOST_FILE_NOT_WRITABLE', '主机文件不可写：（路径为空）')
  try {
    accessSync(existsSync(path) ? path : dirname(path), constants.W_OK)
  } catch {
    throw codedError('HOST_FILE_NOT_WRITABLE', `主机文件不可写：${path}`)
  }
}

/**
 * Read the raw hosts document for mutation. Unknown fields and the top-level shape (`{hosts:{…}}`
 * vs a bare alias map) are preserved by the writers below.
 */
function readMutableHostsDocument(filePath) {
  if (!existsSync(filePath)) {
    return { document: { hosts: {} }, map: {}, wrapped: true, exists: false }
  }
  let document
  try {
    document = JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw codedError('HOST_FILE_INVALID', `主机文件不是合法 JSON：${filePath}（${error.message}）`)
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw codedError('HOST_FILE_INVALID', `主机文件顶层必须是对象：${filePath}`)
  }
  const wrapped = Boolean(document.hosts) && typeof document.hosts === 'object' && !Array.isArray(document.hosts)
  const map = wrapped ? document.hosts : document
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    throw codedError('HOST_FILE_INVALID', `主机文件顶层必须是对象：${filePath}`)
  }
  return { document, map, wrapped, exists: true }
}

/** Write JSON next to the target, chmod 0600, then rename over the target (atomic replace). */
function writeJsonAtomic(filePath, document) {
  const directory = dirname(filePath)
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`
  try {
    writeFileSync(temporary, JSON.stringify(document, null, 2) + '\n', { mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, filePath)
    try { chmodSync(filePath, 0o600) } catch { /* best effort on filesystems without POSIX modes */ }
  } finally {
    if (existsSync(temporary)) {
      try { unlinkSync(temporary) } catch { /* already renamed or gone */ }
    }
  }
}

/**
 * Upsert one alias. Optional fields absent from `input` keep their previous value; switching auth
 * clears the fields that belong to the other auth modes.
 *
 * @param {string} filePath hosts JSON file to mutate
 * @param {{alias:string, host:string, port:number, user?:string, auth:'password'|'password-env'|'key'|'none',
 *   secret?:string, privateKeyPath?:string, note?:string, disabled?:boolean, jump?:string[]|string,
 *   env?:string, group?:string, tags?:string[]|string}} input
 */
export function upsertHostFile(filePath, input) {
  assertWritableHostFile(filePath)
  const { document, map, wrapped } = readMutableHostsDocument(filePath)
  const previous = map[input.alias]
  const existing = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : null
  const created = existing === null
  const next = { ...(existing || {}) }

  next.host = input.host
  next.port = input.port
  next.protocol = input.protocol || existing?.protocol || DEFAULT_PROTOCOL_ID
  if (input.user) next.user = input.user
  if (input.jump !== undefined) {
    const chain = normalizeJumpChain(input.jump, input.alias)
    if (chain.length > 0) next.jump = chain
    else delete next.jump
  }
  if (input.env !== undefined) {
    const env = normalizeHostLabel(input.env, input.alias, 'env')
    if (env) next.env = env
    else delete next.env
  }
  if (input.group !== undefined) {
    const group = normalizeHostLabel(input.group, input.alias, 'group')
    if (group) next.group = group
    else delete next.group
  }
  if (input.tags !== undefined) {
    const tags = normalizeHostTags(input.tags, input.alias)
    if (tags.length > 0) next.tags = tags
    else delete next.tags
  }
  if (input.note === undefined) {
    // Leave the existing note untouched.
  } else if (input.note) {
    next.note = input.note
  } else {
    delete next.note
  }
  if (input.disabled) next.disabled = true
  else delete next.disabled

  if (input.auth === 'password') {
    if (input.secret) next.password = input.secret
    else if (!next.password) throw codedError('HOST_CREDENTIAL_REQUIRED', '认证方式为 password 时 secret（密码）不能为空')
    delete next.passwordEnv
    delete next.privateKeyPath
    delete next.passphrase
  } else if (input.auth === 'password-env') {
    if (!input.secret) throw codedError('HOST_CREDENTIAL_REQUIRED', '认证方式为 password-env 时 secret（环境变量名）不能为空')
    next.passwordEnv = input.secret
    delete next.password
    delete next.privateKeyPath
    delete next.passphrase
  } else if (input.auth === 'key') {
    if (!input.privateKeyPath) throw codedError('HOST_CREDENTIAL_REQUIRED', '认证方式为 key 时 privateKeyPath 不能为空')
    next.privateKeyPath = input.privateKeyPath
    delete next.password
    delete next.passwordEnv
    delete next.passphrase
  } else {
    delete next.password
    delete next.passwordEnv
    delete next.privateKeyPath
    delete next.passphrase
  }

  map[input.alias] = next
  if (wrapped) document.hosts = map
  writeJsonAtomic(filePath, document)
  return { alias: input.alias, created, path: filePath }
}

/**
 * Delete one alias, leaving every other entry (including unknown fields) untouched.
 * @returns {{deleted:boolean, alias:string, empty:boolean, path:string}}
 */
export function deleteHostFromFile(filePath, alias) {
  assertWritableHostFile(filePath)
  const { document, map, wrapped } = readMutableHostsDocument(filePath)
  if (!(alias in map)) return { deleted: false, alias, empty: Object.keys(map).length === 0, path: filePath }
  delete map[alias]
  if (wrapped) document.hosts = map
  writeJsonAtomic(filePath, document)
  return { deleted: true, alias, empty: Object.keys(map).length === 0, path: filePath }
}