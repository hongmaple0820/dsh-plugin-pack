/** Real WebDAV transfers and filesystem-backed profiles exercise remote retention and restoration. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import webdav from 'webdav-server'
import { createDataManager } from '../src/service.js'
import { createRemoteManager } from '../src/remote-manager.js'
import { remoteConfiguration, remoteTransport, REMOTE_NAME } from '../src/remote.js'
import { readArchive } from '../src/archive.js'

async function fixture(t) {
  await mkdir('.debug/tests', { recursive: true })
  const home = await mkdtemp(join(process.cwd(), '.debug/tests/remote-'))
  const dir = join(home, 'profiles', 'web')
  const remoteDirectory = join(home, 'remote')
  await mkdir(dir, { recursive: true })
  await mkdir(remoteDirectory)
  const server = new webdav.v2.WebDAVServer()
  await new Promise((resolve, reject) => server.setFileSystem('/', new webdav.v2.PhysicalFileSystem(remoteDirectory), success => success ? resolve() : reject(new Error('WebDAV filesystem unavailable'))))
  let rejectDeletes = false
  server.beforeRequest((ctx, next) => {
    if (rejectDeletes && ctx.request.method === 'DELETE') { ctx.setCode(403); ctx.exit(); return }
    next()
  })
  const http = await new Promise(resolve => server.start(0, resolve))
  t.after(async () => { http.closeAllConnections?.(); await new Promise(resolve => server.stop(resolve)); await rm(home, { recursive: true, force: true }) })
  const data = await createDataManager({ profile: { home, dir, name: 'web' }, sessionFormatVersion: 4,
    isSessionActive: () => false, isSessionRetained: () => false })
  const manager = await createRemoteManager({ home, data })
  t.after(async () => { await manager.dispose(); data.dispose() })
  const config = { kind: 'webdav', endpoint: `http://127.0.0.1:${http.address().port}`, prefix: 'backups', keep: 1, components: ['profile'] }
  return { manager, data, config, home, dir, remoteDirectory, denyDeletes: () => { rejectDeletes = true } }
}

test('remote configuration rejects exposed credentials, unsafe paths and implicit credential backups', () => {
  const config = { kind: 'webdav', endpoint: 'https://example.com/dav' }
  assert.equal(remoteConfiguration(config).intervalMs, 0)
  assert.throws(() => remoteConfiguration({ ...config, endpoint: 'https://user:secret@example.com/dav' }), /credentials/)
  assert.throws(() => remoteConfiguration({ ...config, endpoint: 'http://example.com' }), /HTTPS/)
  assert.throws(() => remoteConfiguration({ ...config, prefix: '../elsewhere' }), /path|traversal/i)
  assert.throws(() => remoteConfiguration({ ...config, components: ['credentials'] }), /inactive sessions only/)
  assert.throws(() => remoteConfiguration({ ...config, intervalMs: 10 }), /interval/)
  assert.throws(() => remoteConfiguration({ ...config, kind: 's3', bucket: 'backups' }), /credential references/)
})

test('verified WebDAV backups retain the newest archive and restore through a one-use plan', async t => {
  const { manager, data, config, dir, remoteDirectory } = await fixture(t)
  await writeFile(join(dir, 'package.json'), '{"name":"first"}')
  await manager.save(config)
  const first = await manager.run('push')
  assert.match(first.name, REMOTE_NAME)
  await writeFile(join(remoteDirectory, 'backups', 'unrelated.txt'), 'preserve')
  await writeFile(join(dir, 'package.json'), '{"name":"second"}')
  const second = await manager.run('push')
  assert.deepEqual(second.removed, [first.name])
  assert.deepEqual(await manager.run('list'), [{ name: second.name, bytes: second.bytes }])
  assert.equal(await readFile(join(remoteDirectory, 'backups', 'unrelated.txt'), 'utf8'), 'preserve')
  const bytes = await manager.run('download', second.name)
  assert.equal((await readArchive(bytes)).files.length, 1)
  await writeFile(join(dir, 'package.json'), '{"name":"third"}')
  const preview = await data.preview(bytes, { components: ['profile'] })
  assert.equal((await data.apply(preview.planId)).complete, true)
  assert.equal(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).name, 'second')
  await assert.rejects(data.apply(preview.planId), /expired/)
  await manager.run('delete', second.name)
  assert.deepEqual(await readdir(join(remoteDirectory, 'backups')), ['unrelated.txt'])
})

test('a verified upload stays successful when WebDAV denies retention deletes', async t => {
  const { manager, config, dir, denyDeletes } = await fixture(t)
  await writeFile(join(dir, 'package.json'), '{"name":"first"}')
  await manager.save(config)
  const first = await manager.run('push')
  denyDeletes()
  await writeFile(join(dir, 'package.json'), '{"name":"second"}')
  const second = await manager.run('push')
  assert.equal(second.retentionFailed, true)
  assert.deepEqual(second.removed, [])
  assert.deepEqual(new Set((await manager.run('list')).map(item => item.name)), new Set([first.name, second.name]))
  assert.equal((await readArchive(await manager.run('download', second.name))).files.length, 1)
  await assert.rejects(manager.run('delete', first.name), /Remote operation failed/)
  assert.equal(manager.status().last.success, true)
  assert.equal(manager.status().last.retentionFailed, true)
  assert.equal(manager.status().last.name, second.name)
})

test('remote operations reject overlap and configuration persists without a theme dependency', async t => {
  const { manager, data, config, home, dir } = await fixture(t)
  await writeFile(join(dir, 'package.json'), '{"name":"profile"}')
  await manager.save(config)
  const push = manager.run('push')
  await assert.rejects(manager.run('list'), /Another remote operation/)
  await assert.rejects(manager.save(config), /Another remote operation/)
  await push
  await manager.dispose()
  await assert.rejects(manager.run('push'), /stopping/)
  const restored = await createRemoteManager({ home, data })
  t.after(() => restored.dispose())
  assert.equal(restored.status().config.endpoint, config.endpoint + '/')
  assert.equal((await restored.run('list')).length, 1)
  const transport = await remoteTransport(remoteConfiguration(config))
  try { await assert.rejects(transport.get('../escape.zip'), /Invalid backup name/) }
  finally { transport.close() }
})
