/**
 * Secrets：DB 只存 ref，载荷进 OS keychain（或 DSH 配置存储兜底）。
 *
 * pipe.yml 里 ${{SECRET_NAME}} 插值时，interpolate 的 vars 里
 * 会注入 secrets 值（仅运行时，不落明文到日志/DB）。
 *
 * 本机模式（无 keychain 实现）：载荷落 workDir/.secrets.json（0600），
 * 与现有 workDir 目录同级，方便用户手动备份/迁移。
 *
 * 接口：
 *   createSecretStore({ dir, file }) →
 *     set(project, scope, name, value)   → ref
 *     get(project, scope, name)          → value（未设返回 ''）
 *     list(project, scope = '')          → [{ ref, scope, name, createdAt }]
 *     refsForInterpolate(project, vars)  → { ...vars, SECRET_NAME: value, ... }
 *     remove(project, scope, name)       → ok
 *     dispose()
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

function secretFile(dir, file = '') {
  const base = file || join(dir, '.secrets.json')
  return base
}

function loadAll(dir, file) {
  const path = secretFile(dir, file)
  if (!existsSync(path)) return {}
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

function saveAll(dir, file, data) {
  const path = secretFile(dir, file)
  mkdirSync(dir, { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
  try { chmodSync(path, 0o600) } catch { /* best effort */ }
}

export function createSecretStore({ dir, file = '' } = {}) {
  if (!dir) throw new Error('createSecretStore 需要 dir')
  const all = loadAll(dir, file)

  function keyOf(project, scope, name) {
    return `${project}/${scope || 'global'}/${name}`
  }

  function set(project, scope, name, value) {
    const ref = `secret-${randomBytes(4).toString('hex')}`
    const key = keyOf(project, scope, name)
    all[key] = { ref, project, scope: scope || 'global', name, value: String(value ?? ''), createdAt: new Date().toISOString() }
    saveAll(dir, file, all)
    return ref
  }

  function get(project, scope, name) {
    const key = keyOf(project, scope, name)
    const entry = all[key]
    if (!entry) return ''
    return entry.value
  }

  function list(project, scope = '') {
    const rows = []
    for (const key of Object.keys(all)) {
      const entry = all[key]
      if (project && entry.project !== project) continue
      if (scope && entry.scope !== scope) continue
      rows.push({
        ref: entry.ref,
        project: entry.project,
        scope: entry.scope,
        name: entry.name,
        createdAt: entry.createdAt,
      })
    }
    rows.sort((a, b) => String(a.name).localeCompare(String(b.name)))
    return rows
  }

  function remove(project, scope, name) {
    const key = keyOf(project, scope, name)
    if (!(key in all)) return false
    delete all[key]
    saveAll(dir, file, all)
    return true
  }

  function refsForInterpolate(project, vars = {}) {
    const merged = { ...vars }
    for (const key of Object.keys(all)) {
      const entry = all[key]
      if (entry.project !== project) continue
      // 全局 secret 和项目级 secret 都注入；项目级优先
      merged[entry.name] = entry.value
    }
    return merged
  }

  function dispose() {
    /* 文件已持久化，无需额外清理 */
  }

  return { set, get, list, remove, refsForInterpolate, dispose }
}
