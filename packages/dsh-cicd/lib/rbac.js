/**
 * RBAC（远端服务模式）：三角色 viewer / operator / admin + 项目范围 + token TTL。
 *
 * 设计原则（docs/proposals/cicd-v2.md §6.6）：
 *   user → role(viewer|operator|admin) → environment/project 范围
 *   token 短 TTL，写操作全审计
 *   单机模式仍无角色（本模块只在 server 模式启用）
 *
 * 载荷落 workDir/.rbac.json（0600，原子写 tmp+rename）：
 *   {
 *     "users": {
 *       "alice": { "role": "admin", "projects": ["*"], "tokenHash": "sha256...", "expiresAt": "2026-12-01T00:00:00Z", "createdAt": "..." }
 *     },
 *     "audit": [ { "at", "user", "action", "project", "status", "detail" } ]
 *   }
 *
 * 接口：
 *   createRbac({ dir, file, ttlSec }) →
 *     createToken(user, role, projects, ttlSec) → { token, user, role, projects, expiresAt }
 *     verifyToken(token, now) → { user, role, projects, expiresAt } | throw TOKEN_INVALID / TOKEN_EXPIRED
 *     grant(user, role, projects) → { user, role, projects }
 *     revoke(user) → ok
 *     users() → [{ user, role, projects, expiresAt }]
 *     canRead(user) → true（viewer 以上都可读）
 *     canWrite(user, project) → role=operator 且 project ∈ projects（或 *），admin 全量
 *     canAdmin() → role=admin
 *     audit(action, project, status, detail) → 写审计时间线（最近 500 条）
 *     exportAudit() → 全部审计条目（按时间正序）
 *     dispose()
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

function loadAll(dir, file) {
  const path = file || join(dir, '.rbac.json')
  if (!existsSync(path)) return { users: {}, audit: [] }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return {
      users: raw?.users && typeof raw.users === 'object' ? raw.users : {},
      audit: Array.isArray(raw?.audit) ? raw.audit : [],
    }
  } catch {
    return { users: {}, audit: [] }
  }
}

function saveAll(dir, file, data) {
  const path = file || join(dir, '.rbac.json')
  mkdirSync(dir, { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
  try { chmodSync(path, 0o600) } catch { /* best effort */ }
}

export function createRbac({ dir, file = '', ttlSec = 3600 } = {}) {
  if (!dir) throw new Error('createRbac 需要 dir')
  const data = loadAll(dir, file)

  function hashToken(token) {
    return createHash('sha256').update(String(token)).digest('hex')
  }

  function verifyToken(token, now = Date.now()) {
    const ts = String(token || '')
    const tokenHash = hashToken(ts)
    for (const user of Object.keys(data.users)) {
      const entry = data.users[user]
      if (entry.tokenHash !== tokenHash) continue
      if (entry.expiresAt && new Date(entry.expiresAt).getTime() <= now) {
        const error = new Error(`token 已过期（${entry.expiresAt}）`)
        error.code = 'TOKEN_EXPIRED'
        throw error
      }
      return { user, role: entry.role, projects: entry.projects, expiresAt: entry.expiresAt }
    }
    const error = new Error('token 无效')
    error.code = 'TOKEN_INVALID'
    throw error
  }

  function createToken(user, role, projects = ['*'], ttlOverride = ttlSec) {
    if (!user) {
      const error = new Error('user 不能为空')
      error.code = 'RBAC_INVALID'
      throw error
    }
    if (!['viewer', 'operator', 'admin'].includes(role)) {
      const error = new Error(`role 只能是 viewer/operator/admin（收到 "${role}"）`)
      error.code = 'RBAC_INVALID'
      throw error
    }
    if (!Array.isArray(projects) || projects.length === 0) {
      const error = new Error('projects 必须是非空数组（["*"] 表示全量）')
      error.code = 'RBAC_INVALID'
      throw error
    }
    const token = `rbac-${randomBytes(4).toString('hex')}`
    const expiresAt = new Date(Date.now() + (ttlOverride || ttlSec) * 1000).toISOString()
    data.users[user] = {
      role,
      projects: projects.map(String),
      tokenHash: hashToken(token),
      expiresAt,
      createdAt: new Date().toISOString(),
    }
    saveAll(dir, file, data)
    audit('token-issue', '', 'ok', `user=${user} role=${role} ttl=${ttlOverride || ttlSec}s`)
    return { token, user, role, projects: data.users[user].projects, expiresAt }
  }

  function grant(user, role, projects = ['*']) {
    if (!user || !['viewer', 'operator', 'admin'].includes(role)) {
      const error = new Error('grant 需要 user + role(viewer/operator/admin)')
      error.code = 'RBAC_INVALID'
      throw error
    }
    const prev = data.users[user]
    data.users[user] = {
      role,
      projects: projects.map(String),
      tokenHash: prev?.tokenHash || '',
      expiresAt: prev?.expiresAt || '',
      createdAt: prev?.createdAt || new Date().toISOString(),
    }
    saveAll(dir, file, data)
    audit('grant', '', 'ok', `user=${user} role=${role} projects=${JSON.stringify(data.users[user].projects)}`)
    return { user, role, projects: data.users[user].projects }
  }

  function revoke(user) {
    if (!data.users[user]) return false
    delete data.users[user]
    saveAll(dir, file, data)
    audit('revoke', '', 'ok', `user=${user}`)
    return true
  }

  function users() {
    const rows = []
    for (const user of Object.keys(data.users)) {
      const entry = data.users[user]
      rows.push({
        user,
        role: entry.role,
        projects: entry.projects,
        expiresAt: entry.expiresAt,
        createdAt: entry.createdAt,
      })
    }
    rows.sort((a, b) => String(a.user).localeCompare(String(b.user)))
    return rows
  }

  function canRead(user) {
    return Boolean(data.users[user])
  }

  function canWrite(user, project = '') {
    const entry = data.users[user]
    if (!entry) return false
    if (entry.role === 'admin') return true
    if (entry.role !== 'operator') return false
    if (entry.projects.includes('*')) return true
    if (project && entry.projects.includes(project)) return true
    if (!project) return true
    return false
  }

  function canAdmin(user) {
    return data.users[user]?.role === 'admin'
  }

  function audit(action, project, status, detail = '') {
    data.audit.push({ at: new Date().toISOString(), user: '', action, project, status, detail })
    if (data.audit.length > 500) data.audit.splice(0, data.audit.length - 500)
    saveAll(dir, file, data)
  }

  function exportAudit() {
    return data.audit.slice()
  }

  function dispose() {
    /* 文件已持久化 */
  }

  return {
    createToken,
    verifyToken,
    grant,
    revoke,
    users,
    canRead,
    canWrite,
    canAdmin,
    audit,
    exportAudit,
    dispose,
  }
}
