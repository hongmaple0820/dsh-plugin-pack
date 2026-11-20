/** Export checks use real files and directory links, without protocol substitutes. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { collectFiles } from '../src/collect.js'

async function fixture(t) {
  await mkdir('.debug/tests', { recursive: true })
  const home = await mkdtemp(join(process.cwd(), '.debug/tests/collect-'))
  const dir = join(home, 'profile')
  await mkdir(dir)
  t.after(() => rm(home, { recursive: true, force: true }))
  return { home, dir, name: 'web' }
}

test('export rejects linked profile roots rather than following their files', async t => {
  const profile = await fixture(t)
  const linked = join(profile.home, 'linked-profile')
  await writeFile(join(profile.dir, 'package.json'), '{"name":"private"}')
  await symlink(profile.dir, linked, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(collectFiles({ profile: { ...profile, dir: linked }, components: ['profile'] }), /linked/)
})

test('session export rejects nested directory links and reads only inactive regular files', async t => {
  const profile = await fixture(t)
  const root = join(profile.home, 'sessions')
  await mkdir(root)
  await mkdir(join(root, 's1'))
  await writeFile(join(root, 's1', 'log.jsonl'), 'committed\n')
  const options = { profile, components: ['sessions'], isSessionActive: () => false }
  const files = await collectFiles(options)
  assert.deepEqual(files.map(file => file.name), ['sessions/s1/log.jsonl'])
  assert.equal(files[0].bytes.toString(), 'committed\n')
  await symlink(profile.dir, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(collectFiles(options), /link/)
})
