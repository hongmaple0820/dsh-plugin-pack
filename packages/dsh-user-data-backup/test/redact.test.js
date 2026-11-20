import test from 'node:test'
import assert from 'node:assert/strict'
import { parse } from 'yaml'
import { redactYaml, redactSettings, REDACTED } from '../src/redact.js'

test('YAML flow maps, anchors and arbitrary environment values are redacted', () => {
  const source = ['connection: &connection { password: sensitive, name: local }', 'other: *connection',
    'env: { CUSTOM_VALUE: sensitive }', 'headers: { X-Custom: sensitive }'].join('\n')
  const text = redactYaml(source)
  assert.equal(text.includes('sensitive'), false)
  const value = parse(text)
  assert.equal(value.connection.password, REDACTED)
  assert.equal(value.other.password, REDACTED)
  assert.equal(value.env, REDACTED)
  assert.equal(value.headers, REDACTED)
  assert.equal(value.connection.name, 'local')
})
test('invalid or duplicate-key YAML fails rather than exporting its source', () => {
  assert.throws(() => redactYaml('a: [unterminated'), /invalid YAML/)
  assert.throws(() => redactYaml('a: 1\na: 2'), /invalid YAML/)
  assert.throws(() => redactYaml('? [complex, key]\n: value'), /complex YAML keys/)
})
test('URLs and authorization values do not retain embedded credentials', () => {
  const value = parse(redactYaml('url: https://name:pass@example.com/?token=sensitive\nvalue: Bearer abcdef'))
  assert.equal(value.url.includes('pass'), false)
  assert.equal(value.url.includes('sensitive'), false)
  assert.equal(value.value, 'Bearer [redacted]')
})
test('profile comments cannot retain removed credentials', () => {
  const source = '# old password: sensitive\nconfig: # sensitive\n  enabled: true # sensitive\n# sensitive\n'
  const text = redactYaml(source)
  assert.equal(text.includes('sensitive'), false)
  assert.deepEqual(parse(text), { config: { enabled: true } })
})
test('settings fields are redacted recursively', () => {
  assert.deepEqual(redactSettings({ safe: [{ password: 'x', enabled: true }], env: { arbitrary: 'x' } }),
    { safe: [{ password: REDACTED, enabled: true }], env: REDACTED })
})
