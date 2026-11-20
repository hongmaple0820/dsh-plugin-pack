import test from 'node:test'
import assert from 'node:assert/strict'
import { zipSync } from 'fflate'
import { createArchive, readArchive, DEFAULT_LIMITS } from '../src/archive.js'

const files = [{ name: 'profile/cordis.patch.yml', bytes: Buffer.from('enabled: true\n') }]
test('portable ZIP round-trip retains verified bytes and archive identity', async () => {
  const archive = createArchive(files, { profile: 'desktop' })
  const read = await readArchive(archive.bytes)
  assert.equal(read.manifest.profile, 'desktop')
  assert.equal(read.files[0].bytes.toString(), files[0].bytes.toString())
  assert.match(read.digest, /^[a-f0-9]{64}$/)
})
test('digest mismatch rejects the complete archive before restore', async () => {
  const { manifest } = createArchive(files, { profile: 'desktop' })
  const altered = zipSync({ 'manifest.json': Buffer.from(JSON.stringify(manifest)), 'profile/cordis.patch.yml': Buffer.from('modified') })
  await assert.rejects(readArchive(altered), /digest mismatch/)
})
test('size limits stop both export and import', async () => {
  const limits = { ...DEFAULT_LIMITS, fileBytes: 3 }
  assert.throws(() => createArchive(files, { profile: 'desktop' }, limits), /size limit/)
  const archive = createArchive(files, { profile: 'desktop' })
  await assert.rejects(readArchive(archive.bytes, limits), /size limit/)
  await assert.rejects(readArchive(archive.bytes, { ...DEFAULT_LIMITS, archiveBytes: 1 }), /archive size/)
})
test('missing manifest and undeclared files fail', async () => {
  await assert.rejects(readArchive(zipSync({ 'profile/file': Buffer.from('x') })), /manifest is missing/)
  const { manifest } = createArchive(files, { profile: 'desktop' })
  await assert.rejects(readArchive(zipSync({ 'manifest.json': Buffer.from(JSON.stringify(manifest)),
    'profile/cordis.patch.yml': files[0].bytes, 'profile/extra': Buffer.from('x') })), /Invalid backup manifest/)
})
