/** Export reads only explicit components and rejects changing files or linked directories. */
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { DEFAULT_LIMITS } from './archive.js'
import { redactYaml, redactSettings } from './redact.js'
import { exportSettings } from './settings.js'

export const PROFILE_FILES = ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml']
export const COMPONENTS = ['profile', 'settings', 'sessions', 'credentials']
export function selection(value) {
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length || value.some(name => !COMPONENTS.includes(name))) throw new Error('Invalid backup components')
  return [...value]
}

/** A snapshot file is bounded and checked through the open descriptor and its current directory entry. */
export async function stableFile(path, limit) {
  const before = await lstat(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(limit)) throw new Error('Backup source is linked, not a file, or too large')
  const file = await open(path, 'r')
  try {
    const opened = await file.stat({ bigint: true })
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('Backup source changed while opening')
    const chunks = []
    let bytes = 0
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      bytes += chunk.length
      if (bytes > limit) throw new Error('Backup source exceeds file limit')
      chunks.push(chunk)
    }
    const after = await file.stat({ bigint: true })
    const named = await lstat(path, { bigint: true })
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs
      || named.isSymbolicLink() || named.dev !== before.dev || named.ino !== before.ino || named.mtimeNs !== before.mtimeNs || BigInt(bytes) !== after.size) throw new Error('Backup source changed while reading')
    return Buffer.concat(chunks)
  } finally { await file.close() }
}

/** Roots come from the active Host profile. Session admission is checked before and after reading. */
export async function collectFiles({ profile, settings, components, isSessionActive, limits = DEFAULT_LIMITS }) {
  const requested = selection(components)
  const files = []
  const observed = new Map()
  const observe = async (path, directory = false) => {
    const stat = await lstat(path, { bigint: true })
    if (stat.isSymbolicLink() || (directory && !stat.isDirectory())) throw new Error('Backup source directory is linked or unavailable')
    const before = observed.get(path)
    if (before && (stat.dev !== before.dev || stat.ino !== before.ino || stat.mtimeNs !== before.mtimeNs || stat.size !== before.size)) throw new Error('Backup sources changed during export')
    observed.set(path, stat)
  }
  const capture = async path => {
    await observe(path)
    const bytes = await stableFile(path, limits.fileBytes)
    await observe(path)
    return bytes
  }
  const home = await realpath(profile.home)
  await observe(home, true)
  let total = 0
  const append = (name, bytes) => {
    total += bytes.length
    if (bytes.length > limits.fileBytes || total > limits.expandedBytes || files.length >= limits.files) throw new Error('Backup exceeds size or file count limit')
    files.push({ name, bytes })
  }
  if (requested.includes('profile')) {
    await observe(profile.dir, true)
    const root = await realpath(profile.dir)
    await observe(root, true)
    for (const name of PROFILE_FILES) {
      let bytes
      try { bytes = await capture(join(root, name)) }
      catch (error) { if (error.code === 'ENOENT') continue; throw error }
      const source = bytes.toString('utf8')
      append('profile/' + name, Buffer.from(name.endsWith('.json') ? JSON.stringify(redactSettings(JSON.parse(source))) : redactYaml(source)))
    }
  }
  if (requested.includes('settings')) {
    if (settings === undefined) throw new Error('Settings service is unavailable')
    append('settings/sections.json', Buffer.from(JSON.stringify(exportSettings(settings))))
  }
  if (requested.includes('sessions')) {
    if (typeof isSessionActive !== 'function') throw new Error('Session admission is unavailable')
    const rootPath = join(home, 'sessions')
    await observe(rootPath, true)
    const root = await realpath(rootPath)
    const visited = []
    async function walk(directory) {
      await observe(directory, true)
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isSymbolicLink()) throw new Error('Session snapshot contains a link')
        if (entry.isDirectory()) { await walk(path); continue }
        const name = relative(root, path).split(sep).join('/')
        if (await isSessionActive(name)) throw new Error('A retained session cannot be exported during use')
        const bytes = await capture(path)
        if (await isSessionActive(name)) throw new Error('Session started during export')
        append('sessions/' + name, bytes)
        visited.push(name)
      }
    }
    await walk(root)
    for (const name of visited) if (await isSessionActive(name)) throw new Error('Session started during export')
  }
  if (requested.includes('credentials')) {
    try { append('credentials/.credentials.yaml', await capture(join(home, '.credentials.yaml'))) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  for (const [path, stat] of observed) await observe(path, stat.isDirectory())
  return files
}
