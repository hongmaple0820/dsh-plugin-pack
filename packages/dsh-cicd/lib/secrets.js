/**
 * Secrets（v3.0-P4-4）：DB 只存 ref，载荷**加密**落盘。
 *
 * 为什么不是明文 0600：0600 挡的是别的用户，挡不住「同一账号下的任意进程」——
 * 备份被带走、日志被收集、开发机上随手 `cat` 一下，明文就到了别人手里。
 * 所以载荷一律以 AES-256-GCM 密文落盘，密钥来自 keyring：环境变量 / 密钥文件 / 本机自动生成的密钥文件。
 *
 * 三层地址顺序（与 08-security-rbac.md §2.1 的形态对应）：
 *   env:DSH_CICD_SECRET_KEY（hex 64） —— team 形态：密钥由外部注入，磁盘上永远没有解密材料
 *   file:<path>（`secrets.keyFile` 或 DSH_CICD_SECRET_KEY_FILE）—— 密钥与数据分开备份
 *   local:<workDir>/secrets.key（0600）—— 单机兜底。它确实与密文在同一台机器上，
 *     所以它挡不住本机 root；它的价值是「备份/同步的目录里没有明文」。
 *
 * 版本与迁移：记录形如 `{ v: 2, alg: 'aes-256-gcm', iv, tag, ct }`；
 * 老的明文记录（`{ value: '...' }`）在读取时照样能解出来，并在下一次 set 时被就地加密——
 * 升级不能把已有用户的 secret 弄丢，这比"一次干净的迁移"重要。
 *
 * 接口：
 *   createSecretStore({ dir, file, keyFile, key, env }) →
 *     set(project, scope, name, value)   → ref
 *     get(project, scope, name)          → value（未设/解不开返回 ''）
 *     list(project, scope = '')          → [{ ref, scope, name, createdAt }]
 *     refsForInterpolate(project, vars)  → { ...vars, SECRET_NAME: value, ... }
 *     namesFor(project)                  → [名字...]，编辑器预览用（不返回明文）
 *     valuesFor(project)                 → [明文...]，供日志脱敏
 *     stats()                            → { entries, encrypted, plaintext, backend }
 *     rotate()                           → 用新密钥重加密全部记录
 *     dispose()
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export const SECRET_KEY_ENV = 'DSH_CICD_SECRET_KEY'
export const SECRET_KEY_FILE_ENV = 'DSH_CICD_SECRET_KEY_FILE'
export const SECRET_ALGORITHM = 'aes-256-gcm'
/** 当前记录格式版本。v1 = 明文（升级前写入的），v2 = AES-256-GCM 密文。 */
export const SECRET_RECORD_VERSION = 2

function secretFile(dir, file = '') {
  return file || join(dir, '.secrets.json')
}

/**
 * 解析密钥：优先显式传入，其次环境变量，其次密钥文件，最后在本地生成一枚。
 *
 * 返回值带 `backend`，面板要能回答「我的密钥到底在哪」——这个问题答不上来，
 * 用户就会假设它一定安全。
 */
export function resolveSecretKey({ dir = '', key = '', keyFile = '', env = process.env } = {}) {
  const normalize = (raw) => {
    const text = String(raw || '').trim()
    // hex 64 位；也接受 base64 的 32 字节（很多 KMS 直接吐 base64）。
    if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex')
    if (/^[A-Za-z0-9+/=]{40,}$/.test(text)) {
      const buf = Buffer.from(text, 'base64')
      if (buf.length === 32) return buf
    }
    return null
  }
  const fromEnv = normalize(env?.[SECRET_KEY_ENV])
  if (fromEnv) return { key: fromEnv, backend: 'env' }
  const explicit = normalize(key)
  if (explicit) return { key: explicit, backend: 'config' }
  const explicitKeyFile = String(keyFile || env?.[SECRET_KEY_FILE_ENV] || '').trim()
  const path = explicitKeyFile || (dir ? join(dir, 'secrets.key') : '')
  if (explicitKeyFile && !existsSync(explicitKeyFile)) {
    throw Object.assign(new Error('密钥文件 ' + explicitKeyFile + ' 不存在'), { code: 'SECRET_KEY_INVALID' })
  }
  if (path && existsSync(path)) {
    const loaded = normalize(readFileSync(path, 'utf8'))
    if (loaded) return { key: loaded, backend: explicitKeyFile ? 'file' : 'local', path }
    // 文件在但内容不是密钥：这是配置错误，不是"没有密钥"。悄悄生成一枚新的会让
    // 已有密文全部解不开，而用户只会看到"secret 没了"。
    throw Object.assign(new Error(`密钥文件 ${path} 里不是合法的 32 字节密钥（需要 hex 64 位或 base64）`), { code: 'SECRET_KEY_INVALID' })
  }
  if (!path) throw Object.assign(new Error('没有可用的 secret 密钥（给 keyFile 或 ' + SECRET_KEY_ENV + '）'), { code: 'SECRET_KEY_MISSING' })
  const generated = randomBytes(32)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, generated.toString('hex'), { encoding: 'utf8', mode: 0o600 })
  try { chmodSync(path, 0o600) } catch { /* Windows 上 chmod 只影响只读位 */ }
  return { key: generated, backend: 'local', path }
}

function loadAll(path) {
  if (!existsSync(path)) return {}
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

function saveAll(path, data) {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
  try { chmodSync(path, 0o600) } catch { /* best effort */ }
}

/**
 * @param {object} options
 * @param {string} options.dir      workDir（本地密钥文件默认放这里）
 * @param {string} [options.file]   载荷文件（默认 <dir>/.secrets.json）
 * @param {string} [options.keyFile] 密钥文件路径
 * @param {string} [options.key]    直接给密钥（base64/hex），优先级低于环境变量
 */
export function createSecretStore({ dir, file = '', keyFile = '', key = '', env = process.env } = {}) {
  if (!dir) throw new Error('createSecretStore 需要 dir')
  const path = secretFile(dir, file)
  const all = loadAll(path)
  const material = resolveSecretKey({ dir, key, keyFile, env })
  const backend = material.backend

  function keyOf(project, scope, name) {
    return `${project}/${scope || 'global'}/${name}`
  }

  function encrypt(plaintext) {
    const iv = randomBytes(12)
    const cipher = createCipheriv(SECRET_ALGORITHM, material.key, iv)
    const ct = Buffer.concat([cipher.update(String(plaintext ?? ''), 'utf8'), cipher.final()])
    return { v: SECRET_RECORD_VERSION, alg: SECRET_ALGORITHM, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') }
  }

  /** 解一条记录；解密失败返回 null（而不是抛错），因为调用方是"读一个值"，不是"验证一份签名"。 */
  function decrypt(entry) {
    if (!entry) return null
    if (entry.v === SECRET_RECORD_VERSION && entry.ct !== undefined) {
      try {
        const decipher = createDecipheriv(SECRET_ALGORITHM, material.key, Buffer.from(String(entry.iv), 'base64'))
        decipher.setAuthTag(Buffer.from(String(entry.tag), 'base64'))
        return Buffer.concat([decipher.update(Buffer.from(String(entry.ct), 'base64')), decipher.final()]).toString('utf8')
      } catch {
        // 换过密钥 / 密文被改：GCM 的 tag 校验会失败。此时返回 null，绝不"尽力解一下"。
        return null
      }
    }
    // v1 明文记录：升级前写入的，仍然能读。
    if (typeof entry.value === 'string') return entry.value
    return null
  }

  function reference(project, scope, name, createdAt) {
    return { ref: entry_ref(project, scope, name), project, scope: scope || 'global', name, createdAt }
  }

  function entry_ref(project, scope, name) {
    const key = keyOf(project, scope, name)
    const entry = all[key]
    if (entry && entry.ref) return entry.ref
    // 老记录可能没有 ref（升级前的形状），生成一次并就地写回，保证 ref 稳定。
    const ref = `secret-${randomBytes(4).toString('hex')}`
    if (entry) { entry.ref = ref; saveAll(path, all) }
    return ref
  }

  function set(project, scope, name, value) {
    const applied = encrypt(value)
    const key = keyOf(project, scope, name)
    const previous = all[key]
    const ref = previous?.ref || `secret-${randomBytes(4).toString('hex')}`
    all[key] = { ref, project, scope: scope || 'global', name, createdAt: previous?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), ...applied }
    saveAll(path, all)
    return ref
  }

  function get(project, scope, name) {
    return decrypt(all[keyOf(project, scope, name)]) ?? ''
  }

  function list(project, scope = '') {
    const rows = []
    for (const key of Object.keys(all)) {
      const entry = all[key]
      if (project && entry.project !== project) continue
      if (scope && entry.scope !== scope) continue
      rows.push({ ref: entry.ref, project: entry.project, scope: entry.scope, name: entry.name, createdAt: entry.createdAt })
    }
    rows.sort((a, b) => String(a.name).localeCompare(String(b.name)))
    return rows
  }

  function remove(project, scope, name) {
    const key = keyOf(project, scope, name)
    if (!(key in all)) return false
    delete all[key]
    saveAll(path, all)
    return true
  }

  function refsForInterpolate(project, vars = {}) {
    const merged = { ...vars }
    for (const key of Object.keys(all)) {
      const entry = all[key]
      if (entry.project !== project) continue
      const value = decrypt(entry)
      // 解不开的值不注入：把空串当成 secret 传下去，比缺一个变量更难发现。
      if (value === null) continue
      merged[entry.name] = value
    }
    return merged
  }

  /**
   * 该项目 secret 的**名字**表（v3.0-P6-1）。
   * 编辑器预览要用它把密钥类变量写成占位符：预览把明文命令渲染到屏幕上，
   * 而用户下一步往往是截图或粘贴给别人看 —— 预览里出现明文就等于泄露。
   */
  function namesFor(project) {
    const out = []
    for (const key of Object.keys(all)) {
      const entry = all[key]
      if (entry.project === project) out.push(entry.name)
    }
    return out.sort()
  }

  /** 该项目所有 secret 的**明文值**，按长度降序，供日志脱敏。 */
  function valuesFor(project) {
    const out = []
    for (const key of Object.keys(all)) {
      const entry = all[key]
      if (entry.project !== project) continue
      const value = decrypt(entry)
      if (value === null) continue
      // 太短的值（如 "1"、"true"）替换会毁掉日志可读性，且几乎不可能是密钥。
      if (value.length >= 4) out.push(value)
    }
    return out.sort((a, b) => b.length - a.length)
  }

  /** 面板用：有多少条、有多少条仍是明文、密钥在哪。**永远不返回密钥本身**。 */
  function stats() {
    let encrypted = 0
    let plaintext = 0
    let undecryptable = 0
    for (const key of Object.keys(all)) {
      const entry = all[key]
      if (entry.v === SECRET_RECORD_VERSION) {
        if (decrypt(entry) === null) undecryptable += 1
        else encrypted += 1
      } else if (typeof entry.value === 'string') plaintext += 1
      else undecryptable += 1
    }
    // file 是载荷文件，keyFile 是密钥位置 —— 面板要回答的是「我的密钥在哪」，两个都得给。
  return { entries: Object.keys(all).length, encrypted, plaintext, undecryptable, backend, algorithm: SECRET_ALGORITHM, file: path, keyFile: material.path || '' }
  }

  /**
   * 重新加密全部记录（换密钥后调用）。
   *
   * 只对**当前能解开**的记录生效：解不开的条目原样留下，并在结果里报数量 ——
   * 悄悄丢掉它们等于替用户删 secret。
   */
  function rotate({ key: nextKey = '' } = {}) {
    const next = nextKey ? resolveSecretKey({ dir, key: nextKey, keyFile, env }) : resolveSecretKey({ dir, keyFile, env })
    let rotated = 0
    const skipped = []
    for (const key of Object.keys(all)) {
      const entry = all[key]
      const plain = decrypt(entry)
      if (plain === null) { skipped.push(key); continue }
      const iv = randomBytes(12)
      const cipher = createCipheriv(SECRET_ALGORITHM, next.key, iv)
      const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      all[key] = { ...entry, v: SECRET_RECORD_VERSION, alg: SECRET_ALGORITHM, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64'), updatedAt: new Date().toISOString() }
      rotated += 1
    }
    saveAll(path, all)
    return { rotated, skipped: skipped.length, backend: next.backend }
  }

  function dispose() {
    /* 文件已持久化，无需额外清理 */
  }

  return { set, get, list, remove, refsForInterpolate, valuesFor, namesFor, stats, rotate, dispose, backend, file: path }
}
