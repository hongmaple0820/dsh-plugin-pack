/** Persistent remote destinations and a non-overlapping optional backup timer owned by this plugin. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { remoteConfiguration, remoteTransport, uploadVerified } from './remote.js'

/** Secret resolution belongs to credentials; public status never returns resolved values. */
export async function createRemoteManager({ home, data, credentials }) {
  const directory = join(home, 'local-user-data')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const filename = join(directory, 'remote.json')
  let config = null
  try { config = remoteConfiguration(JSON.parse(await readFile(filename, 'utf8'))) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  let closed = false
  let timer = null
  let operation = null
  let last = null
  let nextAt = null
  const assertOpen = () => { if (closed) throw new Error('Remote backup is stopping') }
  const schedule = () => {
    clearTimeout(timer)
    nextAt = null
    if (closed || !config?.intervalMs) return
    nextAt = Date.now() + config.intervalMs
    timer = setTimeout(() => { void run('push').catch(() => { /* Public status records scheduled failure without retaining transport secrets. */ }) }, config.intervalMs)
    timer.unref?.()
  }
  const exclusive = async task => {
    assertOpen()
    if (operation !== null) throw new Error('Another remote operation is running')
    operation = Promise.resolve().then(task)
    try { return await operation }
    finally { operation = null; schedule() }
  }
  async function run(action, name) {
    assertOpen()
    if (config === null) throw new Error('Configure a remote destination first')
    const selected = config
    return exclusive(async () => {
      let transport
      try {
        transport = await remoteTransport(selected, credentials)
        if (action === 'list' || action === 'test') return await transport.list()
        if (action === 'download') return await transport.get(name)
        if (action === 'delete') { await transport.remove(name); return { removed: name } }
        const archive = await data.export({ components: selected.components })
        assertOpen()
        const result = await uploadVerified(transport, archive.bytes, selected.keep)
        last = { at: Date.now(), success: true, name: result.name, bytes: result.bytes, retentionFailed: result.retentionFailed }
        return result
      } catch (error) {
        const message = 'Remote operation failed; check destination access and credential references.'
        if (action === 'push') last = { at: Date.now(), success: false, error: message }
        // Protocol error messages can contain signed URLs or echoed authentication material.
        throw new Error(message, { cause: error })
      } finally { transport?.close() }
    })
  }
  schedule()
  return {
    status() { return { config, busy: operation !== null, last, nextAt, credentialsAvailable: credentials !== undefined } },
    save(value, secrets = {}) {
      return exclusive(async () => {
      const candidate = { ...value }
      const refs = []
      try {
        for (const field of ['username', 'password', 'accessKey', 'secretKey', 'sessionToken']) {
          const secret = secrets[field]
          if (secret === undefined || secret === '') continue
          if (credentials === undefined || typeof secret !== 'string' || secret.length > 16384) throw new Error('A writable credential provider is required')
          const ref = `DSH_LOCAL_BACKUP_${field.toUpperCase()}_${randomUUID().replaceAll('-', '').toUpperCase()}`
          await credentials.set(ref, secret)
          refs.push(ref)
          candidate[`${field}Ref`] = ref
        }
        const normalized = remoteConfiguration(candidate)
        const staging = join(directory, `.remote-${randomUUID()}.tmp`)
        try {
          await writeFile(staging, JSON.stringify(normalized, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
          await rename(staging, filename)
        } finally { await unlink(staging).catch(error => { if (error.code !== 'ENOENT') throw error }) }
        config = normalized
        return { ...this.status(), busy: false }
      } catch (error) {
        await Promise.allSettled(refs.map(ref => credentials.unset(ref)))
        throw error
      }
      })
    },
    run,
    async dispose() {
      closed = true
      clearTimeout(timer)
      nextAt = null
      await operation?.catch(() => { /* The request or scheduled status owns the failed operation. */ })
    },
  }
}
