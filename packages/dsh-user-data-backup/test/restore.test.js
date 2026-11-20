import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm, symlink, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { archivePath, uniqueArchivePaths } from '../src/paths.js'
import { createRestoreManager } from '../src/restore.js'

async function fixture(run) {
  const scratch = fileURLToPath(new URL('../.debug/', import.meta.url))
  await mkdir(scratch, { recursive: true })
  const directory = await mkdtemp(join(scratch, 'restore-'))
  const profile = join(directory, 'profile')
  const sessions = join(directory, 'sessions')
  const recovery = join(directory, 'recovery')
  await Promise.all([profile, sessions, recovery].map(path => mkdir(path)))
  const manager = await createRestoreManager({ roots: { profile, sessions }, recoveryDirectory: recovery, isSessionActive: async () => false })
  try { await run({ manager, directory, profile, sessions, recovery }) }
  finally { manager.dispose(); await rm(directory, { recursive: true, force: true }) }
}

test('rejects escaping, aliased and Windows reserved paths', () => {
  for (const name of ['../file', '/profile/file', 'profile/../file', 'profile/C:/file', 'profile/CON.txt', 'profile/file.', 'profile/a\\b', 'profile//a', 'unknown/a']) {
    assert.throws(() => archivePath(name), undefined, name)
  }
  assert.throws(() => uniqueArchivePaths(['profile/A', 'profile/a']), /Duplicate/)
  assert.throws(() => uniqueArchivePaths(['profile/é', 'profile/e\u0301']), /Duplicate/)
  assert.throws(() => uniqueArchivePaths(['profile/a', 'profile/a/b']), /directory/)
  assert.throws(() => uniqueArchivePaths(['profile/a/b', 'profile/A']), /directory/)
  assert.equal(archivePath('profile/sub/valid.yml').relative, 'sub/valid.yml')
})

test('restore records original bytes before replacing and consumes the plan', () => fixture(async ({ manager, profile }) => {
  await writeFile(join(profile, 'settings.yml'), 'original')
  const plan = await manager.preview([{ name: 'profile/settings.yml', bytes: Buffer.from('replacement') }])
  assert.equal(plan.files[0].action, 'replace')
  const result = await manager.apply(plan.planId)
  assert.equal(result.complete, true)
  assert.equal(await readFile(join(profile, 'settings.yml'), 'utf8'), 'replacement')
  assert.equal(await readFile(join(result.recovery, 'profile/settings.yml'), 'utf8'), 'original')
  assert.deepEqual(result.results, [{ name: 'profile/settings.yml', status: 'written' }])
  await assert.rejects(manager.apply(plan.planId), /expired/)
}))

test('a target edit after preview prevents all writes', () => fixture(async ({ manager, profile }) => {
  await writeFile(join(profile, 'a'), 'old')
  const plan = await manager.preview([{ name: 'profile/new', bytes: Buffer.from('new') }, { name: 'profile/a', bytes: Buffer.from('replacement') }])
  await writeFile(join(profile, 'a'), 'edited')
  const result = await manager.apply(plan.planId)
  assert.equal(result.complete, false)
  assert.deepEqual(result.results, [])
  assert.match(result.error, /changed/)
  await assert.rejects(readFile(join(profile, 'new')), { code: 'ENOENT' })
  assert.equal(await readFile(join(profile, 'a'), 'utf8'), 'edited')
}))

test('preview refuses a symlinked directory', () => fixture(async ({ manager, profile, directory }) => {
  const outside = join(directory, 'outside')
  await mkdir(outside)
  await symlink(outside, join(profile, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(manager.preview([{ name: 'profile/linked/file', bytes: Buffer.from('x') }]), /not a directory/)
}))

test('a component root replaced by a link after preview prevents writes', () => fixture(async ({ manager, profile, directory }) => {
  const outside = join(directory, 'outside')
  await mkdir(outside)
  const plan = await manager.preview([{ name: 'profile/new', bytes: Buffer.from('replacement') }])
  await rename(profile, join(directory, 'original-profile'))
  await symlink(outside, profile, process.platform === 'win32' ? 'junction' : 'dir')
  const result = await manager.apply(plan.planId)
  assert.equal(result.complete, false)
  assert.deepEqual(result.results, [])
  assert.match(result.error, /directory changed/)
  await assert.rejects(readFile(join(outside, 'new')), { code: 'ENOENT' })
}))

for (const replacement of ['file', 'link']) {
  test(`a recovery directory replaced by a ${replacement} prevents writes`, () => fixture(async ({ manager, profile, directory, recovery }) => {
    const path = join(profile, 'package.json')
    await writeFile(path, 'original')
    const plan = await manager.preview([{ name: 'profile/package.json', bytes: Buffer.from('replacement') }])
    const outside = join(directory, 'outside')
    await mkdir(outside)
    await rename(recovery, join(directory, 'original-recovery'))
    if (replacement === 'link') await symlink(outside, recovery, process.platform === 'win32' ? 'junction' : 'dir')
    else await writeFile(recovery, 'not a directory')
    const result = await manager.apply(plan.planId)
    assert.equal(result.complete, false)
    assert.equal(result.recovery, undefined)
    assert.deepEqual(result.results, [])
    assert.match(result.error, /Recovery directory changed/)
    assert.deepEqual(await readdir(outside), [])
    assert.equal(await readFile(path, 'utf8'), 'original')
  }))
}

test('active session writes and expired plans are rejected', () => fixture(async ({ profile, sessions, recovery }) => {
  const manager = await createRestoreManager({ roots: { profile, sessions }, recoveryDirectory: recovery,
    isSessionActive: async () => true, ttlMs: 0 })
  try {
    await assert.rejects(manager.preview([{ name: 'sessions/live.jsonl', bytes: Buffer.from('x') }]), /running session/)
    const plan = await manager.preview([{ name: 'profile/file', bytes: Buffer.from('x') }])
    await assert.rejects(manager.apply(plan.planId), /expired/)
  } finally { manager.dispose() }
}))
