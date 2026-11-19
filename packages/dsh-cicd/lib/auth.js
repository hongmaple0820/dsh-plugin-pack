/**
 * 身份与会话（v3.0-P0）。
 *
 * 为什么需要它：v2 的 `requireWrite` 只看「同源 + 自定义头 + confirm 参数」，
 * 任何一个本地端口上的页面都能部署 prod，且事后查不出是谁。P0 的最低目标是
 * 「每条写操作都能落到一个具体主体上」。
 *
 * 三个设计约束：
 * 1. **不引入原生依赖**。方案里写的 argon2id 需要 argon2 npm 包（编译），本包坚持纯 JS，
 *    因此改用 Node 内置 `scrypt`（OWASP 推荐参数 N=2^15, r=8, p=1）。
 * 2. **口令与 token 只存哈希**。`password_hash` 存 `scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>`；
 *    session/API token 也只存 sha256，等价于「泄露 DB 不等于泄露凭据」。
 * 3. **引导期不锁死**。库里一个用户都没有时，系统处于 bootstrap 状态：写操作仍允许，
 *    但 actor 记为 `anonymous`、审计 reason 记 `bootstrap_no_users`。
 *    一旦创建了第一个用户，写路由立刻要求凭据（可用 `auth.bootstrapAllowAnonymous: false` 提前收紧）。
 *    这是 Grafana/Jenkins 首次安装的通行做法，也让现有 smoke 场景继续可用。
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE = 'dsh_cicd_session'
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32 }

/**
 * scrypt 的内存需求是 `128 * N * r` 字节：N=2^15、r=8 时正好 32 MiB，
 * 而 Node 的默认 maxmem 也是 32 MiB —— 刚好卡在边界上，会抛
 * `ERR_CRYPTO_INVALID_SCRYPT_PARAMS: memory limit exceeded`。
 * 也就是说：不显式放行 maxmem，建用户/登录一律 500。
 * 这里按参数算出需求再留一倍余量，既够用又不会把参数调虚。
 */
function scryptOptions(n, r, p) {
  return { N: n, r, p, maxmem: 128 * n * r * 2 }
}
const SESSION_TTL_SEC = 12 * 60 * 60
const TOKEN_PREFIX = 'cicd_'

export const ROLES = Object.freeze(['viewer', 'operator', 'admin', 'owner'])
const ROLE_RANK = { viewer: 1, operator: 2, admin: 3, owner: 4 }

export function roleAtLeast(role, minimum) {
  return (ROLE_RANK[String(role)] ?? 0) >= (ROLE_RANK[String(minimum)] ?? 99)
}

function nowIso() {
  return new Date().toISOString()
}

function iso(ms) {
  return new Date(ms).toISOString()
}

function randomId(prefix, bytes = 8) {
  return `${prefix}-${randomBytes(bytes).toString('hex')}`
}

export function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

export function hashPassword(password) {
  const salt = randomBytes(16)
  const derived = scryptSync(String(password), salt, SCRYPT.keylen, scryptOptions(SCRYPT.N, SCRYPT.r, SCRYPT.p))
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${derived.toString('base64')}`
}

export function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, saltB64, hashB64] = parts
  try {
    const salt = Buffer.from(saltB64, 'base64')
    const expected = Buffer.from(hashB64, 'base64')
    const derived = scryptSync(String(password), salt, expected.length, scryptOptions(Number(n), Number(r), Number(p)))
    return derived.length === expected.length && timingSafeEqual(derived, expected)
  } catch {
    return false
  }
}

/** 从 Cookie 头里取一个 cookie 值（不引 cookie 解析依赖）。 */
export function readCookie(request, name) {
  const header = request?.headers?.get?.('cookie') || ''
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    if (part.slice(0, idx).trim() !== name) continue
    return decodeURIComponent(part.slice(idx + 1).trim())
  }
  return ''
}

/** 从请求里取会话 id：优先 `x-dsh-cicd-session` 头（登出用），其次会话 token 本身。 */
export function readSessionId(request) {
  const header = request?.headers?.get?.('x-dsh-cicd-session')
  if (header) return String(header).slice(0, 128)
  const token = readCookie(request, SESSION_COOKIE)
  if (!token) return ''
  // 会话 id 不落在 cookie 里（cookie 只放 token），登出路由必须显式传 sessionId。
  return ''
}

export function createAuth({ db, sessionTtlSec = SESSION_TTL_SEC, bootstrapAllowAnonymous = true, now = () => Date.now() } = {}) {
  if (!db) throw new Error('createAuth 需要 db 句柄')
  const api = {
    selectUserByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    selectUser: db.prepare('SELECT * FROM users WHERE id = ?'),
    selectUsers: db.prepare('SELECT * FROM users ORDER BY created_at ASC'),
    insertUser: db.prepare('INSERT INTO users (id, email, display_name, password_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    updateUser: db.prepare('UPDATE users SET email = ?, display_name = ?, password_hash = ?, status = ?, updated_at = ? WHERE id = ?'),
    countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
    selectMemberships: db.prepare('SELECT * FROM memberships WHERE user_id = ? ORDER BY project_id ASC'),
    upsertMembership: db.prepare(`INSERT INTO memberships (user_id, project_id, role, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, project_id) DO UPDATE SET role = excluded.role`),
    deleteMembership: db.prepare('DELETE FROM memberships WHERE user_id = ? AND project_id = ?'),
    insertSession: db.prepare('INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, source_ip, user_agent, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    selectSessionByHash: db.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
    revokeSession: db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    insertToken: db.prepare('INSERT INTO api_tokens (id, user_id, token_hash, name, project_scope, expires_at, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    selectTokenByHash: db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?'),
    selectTokens: db.prepare('SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC'),
    revokeToken: db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ?'),
    touchToken: db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?'),
  }

  const ttlMs = () => (Number(sessionTtlSec) > 0 ? Number(sessionTtlSec) : SESSION_TTL_SEC) * 1000

  function userOut(row) {
    return row ? {
      id: String(row.id),
      email: String(row.email),
      displayName: String(row.display_name ?? ''),
      status: String(row.status ?? 'active'),
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? ''),
      roles: membershipsOf(String(row.id)),
    } : null
  }

  function membershipsOf(userId) {
    return api.selectMemberships.all(String(userId)).map((row) => ({ projectId: String(row.project_id ?? '*'), role: String(row.role ?? 'viewer') }))
  }

  /** 用项目存在则用项目级角色，否则退回全局 `*` 角色；未授予返回 ''（默认拒绝）。 */
  function roleOf(userId, projectId = '') {
    const rows = membershipsOf(userId)
    if (projectId) {
      const hit = rows.find((row) => row.projectId === String(projectId))
      if (hit) return hit.role
    }
    const global = rows.find((row) => row.projectId === '*')
    return global ? global.role : ''
  }

  function hasUsers() {
    return Number(api.countUsers.get()?.n ?? 0) > 0
  }

  function createUser({ email, password = '', displayName = '', role = 'viewer', projectId = '*' } = {}) {
    const mail = String(email || '').trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      const error = new Error('email 不合法')
      error.code = 'USER_INVALID'
      throw error
    }
    if (api.selectUserByEmail.get(mail)) {
      const error = new Error(`用户已存在：${mail}`)
      error.code = 'USER_EXISTS'
      throw error
    }
    if (password && String(password).length < 8) {
      const error = new Error('口令至少 8 位')
      error.code = 'USER_INVALID'
      throw error
    }
    const at = nowIso()
    const id = randomId('usr')
    api.insertUser.run(id, mail, String(displayName || mail.split('@')[0]), password ? hashPassword(password) : '', 'active', at, at)
    if (!ROLES.includes(String(role))) {
      const error = new Error(`未知角色：${role}`)
      error.code = 'USER_INVALID'
      throw error
    }
    setRole({ userId: id, projectId, role })
    return userOut(api.selectUser.get(id))
  }

  function setRole({ userId, projectId = '*', role = 'viewer' } = {}) {
    if (!ROLES.includes(String(role))) {
      const error = new Error(`未知角色：${role}`)
      error.code = 'USER_INVALID'
      throw error
    }
    api.upsertMembership.run(String(userId), String(projectId || '*'), String(role), nowIso())
    return { userId: String(userId), projectId: String(projectId || '*'), role: String(role) }
  }

  function removeRole({ userId, projectId = '*' } = {}) {
    api.deleteMembership.run(String(userId), String(projectId || '*'))
    return true
  }

  function setPassword({ userId, password } = {}) {
    if (String(password || '').length < 8) {
      const error = new Error('口令至少 8 位')
      error.code = 'USER_INVALID'
      throw error
    }
    const row = api.selectUser.get(String(userId))
    if (!row) {
      const error = new Error('用户不存在')
      error.code = 'USER_NOT_FOUND'
      throw error
    }
    api.updateUser.run(String(row.email), String(row.display_name ?? ''), hashPassword(password), String(row.status ?? 'active'), nowIso(), String(userId))
    return true
  }

  /** 登录：校验口令 → 发会话（随机 32 字节，库里只存 sha256）。 */
  function login({ email, password, sourceIp = '', userAgent = '' } = {}) {
    const mail = String(email || '').trim().toLowerCase()
    const row = api.selectUserByEmail.get(mail)
    if (!row || !row.password_hash || !verifyPassword(password, row.password_hash)) {
      const error = new Error('邮箱或口令不正确')
      error.code = 'AUTH_INVALID'
      throw error
    }
    if (String(row.status) !== 'active') {
      const error = new Error('账号已停用')
      error.code = 'AUTH_DISABLED'
      throw error
    }
    const token = randomBytes(32).toString('hex')
    const at = now()
    const id = randomId('ses')
    api.insertSession.run(id, String(row.id), sha256(token), iso(at), iso(at + ttlMs()), String(sourceIp), String(userAgent).slice(0, 300), '')
    try { api.purgeSessions.run(iso(at)) } catch { /* 清理不是关键路径 */ }
    return { sessionId: id, token, cookie: `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`, expiresAt: iso(at + ttlMs()), user: userOut(row) }
  }

  function logout(sessionId) {
    if (!sessionId) {
      const error = new Error('缺少 sessionId')
      error.code = 'SESSION_INVALID'
      throw error
    }
    api.revokeSession.run(nowIso(), String(sessionId))
    return true
  }

  /** 签发 API token：明文只在这一刻出现一次，之后只能凭哈希校验。 */
  function createToken({ userId, name = '', projectScope = '*', ttlSec = 0 } = {}) {
    const row = api.selectUser.get(String(userId))
    if (!row) {
      const error = new Error('用户不存在')
      error.code = 'USER_NOT_FOUND'
      throw error
    }
    const secret = randomBytes(24).toString('hex')
    const id = randomId('tok', 6)
    const at = now()
    const expiresAt = Number(ttlSec) > 0 ? iso(at + Number(ttlSec) * 1000) : ''
    api.insertToken.run(id, String(userId), sha256(secret), String(name || id), String(projectScope || '*'), expiresAt, iso(at), '', '')
    return { id, token: `${TOKEN_PREFIX}${id}_${secret}`, name: String(name || id), projectScope: String(projectScope || '*'), expiresAt }
  }

  function revokeToken(tokenId) {
    api.revokeToken.run(nowIso(), String(tokenId))
    return true
  }

  function tokensOf(userId) {
    return api.selectTokens.all(String(userId)).map((row) => ({
      id: String(row.id),
      name: String(row.name ?? ''),
      projectScope: String(row.project_scope ?? '*'),
      expiresAt: String(row.expires_at ?? ''),
      createdAt: String(row.created_at ?? ''),
      lastUsedAt: String(row.last_used_at ?? ''),
      revokedAt: String(row.revoked_at ?? ''),
    }))
  }

  /**
   * 解析请求主体。返回 `{ actor, error }`：
   * - actor 非空 → 已认证；authMethod ∈ session | token | bootstrap | anonymous
   * - error 形如 `{ code, message }`，供路由转成 401
   */
  function authenticate(request) {
    const at = now()
    // 1) API token（`Authorization: Bearer cicd_...` 或 `x-dsh-cicd-token`）
    const authHeader = request?.headers?.get?.('authorization') || ''
    const headerToken = String(authHeader).toLowerCase().startsWith('bearer ')
      ? String(authHeader).slice(7).trim()
      : String(request?.headers?.get?.('x-dsh-cicd-token') || '').trim()
    if (headerToken.startsWith(TOKEN_PREFIX)) {
      const raw = headerToken.slice(TOKEN_PREFIX.length)
      const sep = raw.indexOf('_')
      const tokenId = sep > 0 ? raw.slice(0, sep) : ''
      const secret = sep > 0 ? raw.slice(sep + 1) : ''
      const row = tokenId ? api.selectTokenByHash.get(sha256(secret)) : null
      if (!row || String(row.id) !== tokenId) return { actor: null, error: { code: 'TOKEN_INVALID', message: 'API token 无效' } }
      if (String(row.revoked_at ?? '')) return { actor: null, error: { code: 'TOKEN_REVOKED', message: 'API token 已吊销' } }
      if (String(row.expires_at ?? '') && String(row.expires_at) <= iso(at)) return { actor: null, error: { code: 'TOKEN_EXPIRED', message: 'API token 已过期' } }
      try { api.touchToken.run(iso(at), String(row.id)) } catch { /* 记录最后使用时间失败不影响鉴权 */ }
      const user = api.selectUser.get(String(row.user_id))
      if (!user) return { actor: null, error: { code: 'TOKEN_INVALID', message: 'API token 的账号已不存在' } }
      return {
        actor: {
          id: String(user.id),
          email: String(user.email),
          displayName: String(user.display_name ?? ''),
          authMethod: 'token',
          tokenId: String(row.id),
          projectScope: String(row.project_scope ?? '*'),
          role: roleOf(String(user.id)),
        },
        error: null,
      }
    }
    // 2) 会话 cookie
    const sessionToken = readCookie(request, SESSION_COOKIE)
    if (sessionToken) {
      const row = api.selectSessionByHash.get(sha256(sessionToken))
      if (row) {
        if (String(row.revoked_at ?? '')) return { actor: null, error: { code: 'SESSION_REVOKED', message: '会话已注销' } }
        if (String(row.expires_at) <= iso(at)) return { actor: null, error: { code: 'SESSION_EXPIRED', message: '会话已过期' } }
        const user = api.selectUser.get(String(row.user_id))
        if (!user) return { actor: null, error: { code: 'SESSION_INVALID', message: '会话的账号已不存在' } }
        return {
          actor: {
            id: String(user.id),
            email: String(user.email),
            displayName: String(user.display_name ?? ''),
            authMethod: 'session',
            tokenId: String(row.id),
            projectScope: '*',
            role: roleOf(String(user.id)),
          },
          error: null,
        }
      }
      return { actor: null, error: { code: 'SESSION_INVALID', message: '会话无效' } }
    }
    // 3) 引导期 / 完全放开
    if (!hasUsers()) {
      if (!bootstrapAllowAnonymous) return { actor: null, error: { code: 'AUTH_REQUIRED', message: '尚未创建任何账号，且已禁用匿名引导' } }
      return {
        actor: { id: 'anonymous', email: '', displayName: 'anonymous', authMethod: 'bootstrap', tokenId: '', projectScope: '*', role: 'owner' },
        error: null,
        bootstrap: true,
      }
    }
    return { actor: null, error: { code: 'AUTH_REQUIRED', message: '需要登录' } }
  }

  function listUsers() {
    return api.selectUsers.all().map(userOut)
  }

  function user(id) {
    return userOut(api.selectUser.get(String(id)))
  }

  return {
    authenticate, login, logout, createUser, listUsers, user, setRole, removeRole, setPassword,
    createToken, revokeToken, tokensOf, roleOf, hasUsers, membershipsOf,
    bootstrapAllowAnonymous: Boolean(bootstrapAllowAnonymous),
  }
}
