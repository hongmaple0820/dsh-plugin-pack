import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createDataManager } from '../src/service.js'
import { createArchive, readArchive } from '../src/archive.js'
import { mergeSettings } from '../src/settings.js'

async function fixture(t, isSessionRetained = () => false) {
  await mkdir('.debug/tests', { recursive: true })
  const home = await mkdtemp(join(process.cwd(), '.debug/tests/service-'))
  const dir = join(home, 'profiles', 'web')
  await mkdir(dir, { recursive: true })
  t.after(() => rm(home, { recursive: true, force: true }))
  const manager = await createDataManager({ profile: { name: 'web', home, dir }, sessionFormatVersion: 4,
    isSessionActive: () => false, isSessionRetained })
  t.after(() => manager.dispose())
  return { manager, dir, home }
}

test('export and one-use restore use only selected profile files', async t => {
  const { manager, dir } = await fixture(t)
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'profile', token: 'private' }))
  await writeFile(join(dir, 'unrelated.txt'), 'not exported')
  const archive = await manager.export({ components: ['profile'] })
  const snapshot = await readArchive(archive.bytes)
  assert.deepEqual(snapshot.files.map(file => file.name), ['profile/package.json'])
  assert.equal(Buffer.from(snapshot.files[0].bytes).toString().includes('private'), false)
  const plan = await manager.preview(archive.bytes, { components: ['profile'] })
  assert.equal(plan.files[0].action, 'replace')
  const result = await manager.apply(plan.planId)
  assert.equal(result.complete, true)
  const restored = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  assert.equal(restored.name, 'profile')
  assert.equal(restored.token, 'private')
  await assert.rejects(manager.apply(plan.planId), /expired/)
})

test('preview rejects unexpected profile files and incompatible session generations', async t => {
  const { manager } = await fixture(t)
  const profile = createArchive([{ name: 'profile/arbitrary.js', bytes: Buffer.from('x') }], { profile: 'web' })
  await assert.rejects(manager.preview(profile.bytes, { components: ['profile'] }), /not allowed/)
  const sessions = createArchive([{ name: 'sessions/s1/log.jsonl', bytes: Buffer.from('x') }], { profile: 'web', sessionFormatVersion: 3 })
  await assert.rejects(manager.preview(sessions.bytes, { components: ['sessions'] }), /format differs/)
})

test('credential export requires explicit confirmation and manager disposal closes admission', async t => {
  const { manager } = await fixture(t)
  await assert.rejects(manager.export({ components: ['credentials'] }), /explicit confirmation/)
  manager.dispose()
  await assert.rejects(manager.export({ components: ['profile'] }), /unavailable/)
})

test('archive preparation excludes overlapping previews and restores', async t => {
  const { manager, dir } = await fixture(t)
  await writeFile(join(dir, 'package.json'), '{"name":"profile"}')
  const archive = await manager.export({ components: ['profile'] })
  const first = manager.preview(archive.bytes, { components: ['profile'] })
  await assert.rejects(manager.preview(archive.bytes, { components: ['profile'] }), /operation is running/)
  await assert.rejects(manager.apply('not-a-plan'), /operation is running/)
  const plan = await first
  assert.equal((await manager.apply(plan.planId)).complete, true)
  assert.ok((await manager.export({ components: ['profile'] })).bytes.length > 0)
})

test('profile secret merging is bound to preview target revisions', async t => {
  const { manager, dir } = await fixture(t)
  const path = join(dir, 'cordis.patch.yml')
  await writeFile(path, 'enabled: false\npassword: old-private\n')
  const archive = await manager.export({ components: ['profile'] })
  await writeFile(path, 'enabled: true\npassword: current-private\n')
  const plan = await manager.preview(archive.bytes, { components: ['profile'] })
  assert.equal((await manager.apply(plan.planId)).complete, true)
  const restored = await readFile(path, 'utf8')
  assert.match(restored, /enabled: false/)
  assert.match(restored, /password: current-private/)
  assert.equal(restored.includes('[redacted]'), false)
  const next = await manager.preview(archive.bytes, { components: ['profile'] })
  await writeFile(path, 'enabled: true\npassword: newest-private\n')
  const refused = await manager.apply(next.planId)
  assert.equal(refused.complete, false)
  assert.deepEqual(refused.files.results, [])
  assert.match(await readFile(path, 'utf8'), /newest-private/)
})

test('partial restore reports written files, recovery bytes and the need to restart', async t => {
  let intervene = false
  let profilePath
  let sessionPath
  const { manager, dir, home } = await fixture(t, async () => {
    if (intervene && await readFile(profilePath, 'utf8') === '{"name":"restored"}') {
      intervene = false
      await writeFile(sessionPath, 'external edit')
    }
    return false
  })
  profilePath = join(dir, 'package.json')
  sessionPath = join(home, 'sessions', 's1', 'log.jsonl')
  await mkdir(join(home, 'sessions', 's1'))
  await writeFile(profilePath, '{"name":"original"}')
  await writeFile(sessionPath, 'original log')
  const archive = createArchive([
    { name: 'profile/package.json', bytes: Buffer.from('{"name":"restored"}') },
    { name: 'sessions/s1/log.jsonl', bytes: Buffer.from('restored log') },
  ], { profile: 'web', sessionFormatVersion: 4 })
  const plan = await manager.preview(archive.bytes, { components: ['profile', 'sessions'] })
  intervene = true
  const result = await manager.apply(plan.planId)
  assert.equal(result.complete, false)
  assert.equal(result.restartRequired, true)
  assert.equal(result.settings.skipped, true)
  assert.deepEqual(result.files.results, [{ name: 'profile/package.json', status: 'written' }])
  assert.match(result.files.error, /changed during apply/)
  assert.equal(await readFile(join(result.files.recovery, 'profile', 'package.json'), 'utf8'), '{"name":"original"}')
  assert.equal(await readFile(sessionPath, 'utf8'), 'external edit')
})

test('settings patches preserve omitted and declared secrets and never relocate array secrets', () => {
  const current = { password: 'private', enabled: false, accounts: [{ name: 'one', value: 'secret' }], retained: true }
  const patch = { password: 'hostile', enabled: true, accounts: [{ name: 'two', value: 'new' }] }
  const merged = mergeSettings(current, patch, [['password'], ['accounts', '0', 'value']])
  assert.deepEqual(merged, { ...current, enabled: true })
  assert.deepEqual(mergeSettings(current, { password: '[redacted]' }), current)
  assert.throws(() => mergeSettings({}, JSON.parse('{"__proto__":{"x":1}}')), /reserved/)
})
