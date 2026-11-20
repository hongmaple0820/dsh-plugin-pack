/** Settings use the live provider and its revision check; redacted values preserve current secrets. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { REDACTED, redactSettings } from './redact.js'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const blockedKey = key => ['__proto__', 'prototype', 'constructor'].includes(key)

/** Imported values are a patch: omitted and redacted fields keep their current value. */
export function mergeSettings(current, patch, protectedPaths = [], path = []) {
  if (protectedPaths.some(secret => secret.length <= path.length && secret.every((part, index) => path[index] === part))) return structuredClone(current)
  if (typeof patch === 'string' && patch.includes(REDACTED)) return structuredClone(current)
  if (Array.isArray(patch)) {
    // Positional secret fields must not be attached to another array member after a reorder.
    if (protectedPaths.some(secret => path.every((part, index) => secret[index] === part))
      || JSON.stringify(patch).includes(REDACTED)) return structuredClone(current)
    return structuredClone(patch)
  }
  if (!object(patch)) return patch
  const result = object(current) ? structuredClone(current) : {}
  for (const [key, value] of Object.entries(patch)) {
    if (blockedKey(key)) throw new Error('Settings contain a reserved property')
    const merged = mergeSettings(result[key], value, protectedPaths, [...path, key])
    if (merged !== undefined) result[key] = merged
  }
  return result
}

/** Export schema-redacted user overrides, without base values or resolved credentials. */
export function exportSettings(settings) {
  return { version: 1, sections: settings.describe({ redactSecrets: true })
    .filter(section => section.user !== undefined)
    .map(section => ({ ns: section.ns, values: redactSettings(section.user),
      secrets: (section.secrets ?? []).map(secret => secret.path) })) }
}

/** Capture current revisions and detached replacement values during preview. */
export function prepareSettings(settings, snapshot) {
  if (!object(snapshot) || snapshot.version !== 1 || !Array.isArray(snapshot.sections) || snapshot.sections.length > 512) throw new Error('Invalid settings snapshot')
  const current = new Map(settings.describe({ redactSecrets: false }).map(section => [section.ns, section]))
  const declaredSecrets = new Map(settings.describe({ redactSecrets: true }).map(section => [section.ns, (section.secrets ?? []).map(secret => secret.path)]))
  const seen = new Set()
  return snapshot.sections.map(section => {
    if (!object(section) || typeof section.ns !== 'string' || section.ns.length > 256 || !object(section.values)
      || seen.has(section.ns) || !Array.isArray(section.secrets)
      || !section.secrets.every(path => Array.isArray(path) && path.length <= 64 && path.every(part => typeof part === 'string' && !blockedKey(part)))) throw new Error('Invalid settings section')
    seen.add(section.ns)
    const target = current.get(section.ns)
    if (target === undefined || !Number.isSafeInteger(target.revision)) throw new Error('Settings namespace is unavailable: ' + section.ns)
    const before = structuredClone(target.user ?? {})
    return { ns: section.ns, revision: target.revision, before, digest: hash(before),
      values: mergeSettings(before, section.values, [...section.secrets, ...(declaredSecrets.get(section.ns) ?? [])]) }
  })
}

/** All namespaces are checked before file restore; each provider write checks its revision again. */
export function verifySettings(settings, prepared) {
  const current = new Map(settings.describe({ redactSecrets: false }).map(section => [section.ns, section]))
  for (const item of prepared) {
    const target = current.get(item.ns)
    if (target === undefined || target.revision !== item.revision || hash(target.user ?? {}) !== item.digest) throw new Error('Settings changed after preview: ' + item.ns)
  }
}

/** Recovery contains original settings and must remain private; partial writes are reported individually. */
export async function applySettings(settings, prepared, checkRecoveryDirectory) {
  const results = []
  if (prepared.length === 0) return { complete: true, results }
  let recovery
  try {
    verifySettings(settings, prepared)
    const directory = join(await checkRecoveryDirectory(), 'settings-' + randomUUID())
    await mkdir(directory, { mode: 0o700 })
    recovery = directory
    const file = await open(join(recovery, 'before.json'), 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(prepared.map(item => ({ ns: item.ns, values: item.before })))); await file.sync() }
    finally { await file.close() }
    for (const item of prepared) {
      verifySettings(settings, [item])
      await settings.replace(item.ns, item.values, item.revision)
      results.push({ namespace: item.ns, status: 'written' })
    }
    return { complete: true, recovery, results }
  } catch (error) { return { complete: false, recovery, results, error: error.message } }
}
