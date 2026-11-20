import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDocument } from 'yaml'
import { prepareProfileFile } from '../src/profile.js'

const prepare = (incoming, current, name = 'profile/cordis.patch.yml') => prepareProfileFile({
  name, bytes: Buffer.from(incoming), original: current === null ? null : Buffer.from(current),
}).toString()

test('masked YAML maps retain target values while unrelated imported options change', () => {
  const value = prepare('enabled: true\nconfig:\n  password: "[redacted]"\n  model: new\n',
    'enabled: false\nconfig:\n  password: "target-secret"\n  model: old\n')
  assert.deepEqual(parseDocument(value).toJS(), { enabled: true, config: { password: 'target-secret', model: 'new' } })
  assert.equal(value.includes('[redacted]'), false)
})

test('masked sequences retain the target sequence and do not reattach secrets by index', () => {
  const value = prepare('accounts:\n  - name: other-account\n    token: "[redacted]"\n',
    'accounts:\n  - name: original-account\n    token: private\n')
  assert.deepEqual(parseDocument(value).toJS(), { accounts: [{ name: 'original-account', token: 'private' }] })
})

test('missing target values and invalid YAML fail before a restore plan exists', () => {
  assert.throws(() => prepare('token: "[redacted]"\n', null), /no target value/)
  assert.throws(() => prepare('token: "[redacted]"\n', 'enabled: true\n'), /no target value/)
  assert.throws(() => prepare('token: 1\ntoken: 2\n', '{}'), /invalid profile YAML/)
})

test('YAML anchor references remain resolvable after masked scalar replacement', () => {
  const value = prepare('token: &shared "[redacted]"\nother: *shared\n', 'token: local\n')
  assert.deepEqual(parseDocument(value).toJS(), { token: 'local', other: 'local' })
  assert.throws(() => prepare('token: "[redacted]"\n', 'source: &outside private\ntoken: *outside\n'), /unresolved YAML alias/)
})

test('masked JSON preserves target fields and refuses reserved keys', () => {
  assert.deepEqual(JSON.parse(prepare('{"token":"[redacted]","enabled":true}', '{"token":"local"}', 'profile/package.json')),
    { token: 'local', enabled: true })
  assert.throws(() => prepare('{"token":"[redacted]","__proto__":{}}', '{"token":"local"}', 'profile/package.json'), /reserved/)
})
