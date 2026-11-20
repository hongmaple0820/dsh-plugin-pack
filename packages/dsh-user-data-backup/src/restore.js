/** Restore plans bind bytes and target revisions; each replacement has a recovery copy. */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, realpath, mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { uniqueArchivePaths } from './paths.js'
import { DEFAULT_LIMITS } from './archive.js'
import { stableFile } from './collect.js'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
async function inspect(path) {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Restore target is not a regular file')
    if (stat.size > DEFAULT_LIMITS.fileBytes) throw new Error('Restore target exceeds file limit')
    return digest(await stableFile(path, DEFAULT_LIMITS.fileBytes))
  } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function target(root, relative) {
  const path = resolve(root, relative)
  if (!path.startsWith(root + sep)) throw new Error('Restore target escapes component directory')
  let parent = dirname(path)
  while (parent !== root) {
    try {
      const stat = await lstat(parent)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Restore parent is not a directory')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    parent = dirname(parent)
  }
  return path
}
async function atomicWrite(path, bytes) {
  await mkdir(dirname(path), { recursive: true })
  const staging = join(dirname(path), `.dsh-restore-${randomUUID()}`)
  try {
    const file = await open(staging, 'wx', 0o600)
    try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
    await rename(staging, path)
  } finally { await unlink(staging).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}

/** Roots and active-session checks are supplied by the Host, never by a request. */
export async function createRestoreManager({ roots, recoveryDirectory, isSessionActive, prepareFile = file => file.bytes, ttlMs = 300000, maxPlans = 8 }) {
  const resolved = Object.fromEntries(await Promise.all(Object.entries(roots).map(async ([key, path]) => [key, await realpath(path)])))
  const identities = new Map(await Promise.all(Object.values(resolved).map(async root => [root, await lstat(root)])))
  const recoveryRoot = await realpath(recoveryDirectory)
  const recoveryIdentity = await lstat(recoveryDirectory)
  if (!recoveryIdentity.isDirectory() || recoveryIdentity.isSymbolicLink()) throw new Error('Recovery directory is not a directory')
  async function checkRecoveryDirectory() {
    const stat = await lstat(recoveryDirectory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== recoveryIdentity.dev || stat.ino !== recoveryIdentity.ino
      || await realpath(recoveryDirectory) !== recoveryRoot) throw new Error('Recovery directory changed')
    return recoveryRoot
  }
  const plans = new Map()
  let applying = false
  const expire = () => { for (const [id, plan] of plans) if (plan.expiresAt <= Date.now()) plans.delete(id) }
  async function guard(entry) {
    const root = resolved[entry.component]
    if (root === undefined) throw new Error('Backup component is unavailable')
    const rootStat = await lstat(root)
    const identity = identities.get(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.dev !== identity.dev || rootStat.ino !== identity.ino
      || await realpath(root) !== root) throw new Error('Restore component directory changed')
    if (entry.component === 'sessions' && await isSessionActive(entry.relative)) throw new Error('A running session cannot be overwritten')
    const path = await target(root, entry.relative)
    return { path, revision: await inspect(path) }
  }
  return {
    checkRecoveryDirectory,
    async preview(files) {
      expire()
      if (plans.size >= maxPlans) throw new Error('Too many pending restore plans')
      const entries = uniqueArchivePaths(files.map(file => file.name))
      const prepared = []
      let preparedBytes = 0
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]
        const current = await guard(entry)
        const original = current.revision === null ? null : await stableFile(current.path, DEFAULT_LIMITS.fileBytes)
        if (original !== null && digest(original) !== current.revision) throw new Error('Restore target changed during preview')
        const bytes = Buffer.from(await prepareFile({ name: entry.name, bytes: Buffer.from(files[index].bytes), original }))
        preparedBytes += bytes.length
        if (bytes.length > DEFAULT_LIMITS.fileBytes || preparedBytes > DEFAULT_LIMITS.expandedBytes) throw new Error('Merged restore exceeds size limit')
        if ((await guard(entry)).revision !== current.revision) throw new Error('Restore target changed during preview')
        prepared.push({ ...entry, bytes, digest: digest(bytes), ...current })
      }
      const id = randomUUID()
      const expiresAt = Date.now() + ttlMs
      plans.set(id, { entries: prepared, expiresAt })
      return { planId: id, expiresAt, files: prepared.map(entry => ({ name: entry.name, bytes: entry.bytes.length,
        action: entry.revision === null ? 'create' : 'replace', digest: entry.digest })) }
    },
    async apply(planId) {
      expire()
      if (applying) throw new Error('Another restore is running')
      const plan = plans.get(planId)
      if (plan === undefined) throw new Error('Restore preview has expired')
      plans.delete(planId)
      applying = true
      const operationId = randomUUID()
      let recovery
      const results = []
      try {
        // Preflight the entire plan before the first write, then recheck each file immediately before replacing it.
        for (const entry of plan.entries) if ((await guard(entry)).revision !== entry.revision) throw new Error('Restore target changed after preview')
        const directory = join(await checkRecoveryDirectory(), operationId)
        await mkdir(directory, { mode: 0o700 })
        recovery = directory
        await atomicWrite(join(recovery, 'operation.json'), Buffer.from(JSON.stringify({ operationId, files: plan.entries.map(entry => ({ name: entry.name, revision: entry.revision })) })))
        for (const entry of plan.entries) {
          const current = await guard(entry)
          if (current.revision !== entry.revision) throw new Error('Restore target changed during apply')
          if (entry.revision !== null) {
            const original = await stableFile(current.path, DEFAULT_LIMITS.fileBytes)
            if (digest(original) !== entry.revision) throw new Error('Restore target changed during backup')
            await atomicWrite(join(recovery, entry.name), original)
          }
          if ((await guard(entry)).revision !== entry.revision) throw new Error('Restore target changed before replacement')
          await atomicWrite(current.path, entry.bytes)
          results.push({ name: entry.name, status: 'written' })
          await atomicWrite(join(recovery, 'results.json'), Buffer.from(JSON.stringify(results)))
        }
        return { operationId, recovery, complete: true, results }
      } catch (error) {
        return { operationId, recovery, complete: false, results, error: error.message }
      } finally { applying = false }
    },
    dispose() { plans.clear() },
  }
}
