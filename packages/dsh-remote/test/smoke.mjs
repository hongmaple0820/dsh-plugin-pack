#!/usr/bin/env node
// Smoke tests for @local/dsh-remote. No SSH connection is opened: every assertion below runs
// against pure modules, a fake PTY stream, or the package files themselves.
//
//   node packages/dsh-remote/test/smoke.mjs

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MAX_JUMP_HOPS,
  PACKAGE_HOSTS_PATH,
  findDefaultKeyPath,
  hostGroups,
  loadHosts,
  normalizeHostEntry,
  normalizeHostMeta,
  normalizeJumpChain,
  normalizePort,
  parseHostsDocument,
  publicHosts,
  resolveAliasSpec,
  resolveHostRef,
  upsertHostFile,
} from '../lib/hosts.js'
import { LIMITS, clipUtf8, createByteSink, tailUtf8, utf8Bytes } from '../lib/truncate.js'
import {
  linuxInstallScript,
  parseInstallLog,
  vncServerInstallInfo,
  windowsInstallScript,
  windowsInstallSteps,
} from '../lib/vnc.js'
import { collectExecResult, normalizeTimeoutSec } from '../lib/exec.js'
import { acceptKey } from '../lib/wsbridge.js'
import { TunnelRegistry, normalizeForwardTarget } from '../lib/tunnel.js'
import { ShellRegistry, appendCapped, takeOutput } from '../lib/shell.js'
import { UPLOAD_CHUNK_BYTES, UploadRegistry } from '../lib/upload.js'
import { ancestorPaths } from '../lib/sftp.js'
import { Writable } from 'node:stream'
import { installInfo } from '../lib/protocols/gui.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = dirname(HERE)
const FIXTURE_HOSTS = join(HERE, 'fixtures', 'hosts.json')
const MISSING_HOSTS = join(HERE, 'fixtures', 'does-not-exist.json')

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`ok ${checks} - ${name}`)
}

// RFC 6455 §4.2.2. The GUID is 36 characters: dropping one character still satisfies every
// Node WebSocket client (both sides only compare digests) but makes Chrome reject the
// handshake with 1006 — which is exactly how the missing "C" survived until a browser test.
const RFC_KEY = 'AAAAAAAAAAAAAAAAAAAAAA=='
const RFC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

check('acceptKey 使用完整的 36 字符 GUID', () => {
  assert.equal(RFC_GUID.length, 36, 'WebSocket GUID 必须是 36 个字符')
  assert.equal(acceptKey(RFC_KEY), createHash('sha1').update(RFC_KEY + RFC_GUID).digest('base64'))
})

check('acceptKey 对空 key 也能算出稳定的 base64', () => {
  assert.equal(acceptKey(''), createHash('sha1').update(RFC_GUID).digest('base64'))
})
function throwsMessage(fn, pattern, label) {
  let error = null
  try { fn() } catch (caught) { error = caught }
  assert.ok(error, `${label}: 期望抛错但没有抛`)
  assert.match(error.message, pattern, `${label}: 错误信息不匹配：${error.message}`)
  return error
}

console.log('# hosts: parsing and precedence')

check('parseHostsDocument 接受 { hosts } 形状', () => {
  const result = parseHostsDocument(readFileSync(FIXTURE_HOSTS, 'utf8'), 'fixture')
  assert.equal(result.error, null)
  assert.deepEqual(Object.keys(result.hosts), ['alpha', 'beta', 'gamma', 'delta', 'epsilon'])
  assert.equal(result.hosts.alpha.port, 22)
  assert.equal(result.hosts.beta.port, 2222)
})

check('parseHostsDocument 接受裸别名 map', () => {
  const result = parseHostsDocument(JSON.stringify({ solo: { host: 'example.com' } }), 'bare')
  assert.equal(result.error, null)
  assert.equal(result.hosts.solo.port, 22)
  assert.equal(result.hosts.solo.user, 'root')
})

check('parseHostsDocument 对坏 JSON / 空配置给出错误', () => {
  assert.match(parseHostsDocument('{ not json', 'bad').error, /不是合法 JSON/)
  assert.match(parseHostsDocument('{}', 'empty').error, /没有任何主机/)
  assert.match(parseHostsDocument('{"hosts":{"x":{"user":"root"}}}', 'nohost').error, /缺少 host/)
  assert.match(parseHostsDocument('{"hosts":{"x":{"host":"h","port":"abc"}}}', 'badport').error, /端口不合法/)
})

check('loadHosts 内联 config.hosts 优先级最高', () => {
  const loaded = loadHosts({
    inlineHosts: { inline: { host: '192.0.2.10', user: 'me' } },
    env: { DSH_REMOTE_HOSTS: FIXTURE_HOSTS },
  })
  assert.equal(loaded.source, 'config')
  assert.equal(loaded.error, null)
  assert.equal(loaded.hosts.inline.host, '192.0.2.10')
  assert.equal(loaded.hosts.alpha, undefined)
})

check('loadHosts 其次读 DSH_REMOTE_HOSTS 指向的文件', () => {
  const loaded = loadHosts({ env: { DSH_REMOTE_HOSTS: FIXTURE_HOSTS } })
  assert.equal(loaded.source, 'DSH_REMOTE_HOSTS')
  assert.equal(loaded.path, FIXTURE_HOSTS)
  assert.ok(loaded.hosts.alpha)
})

check('loadHosts 再退到包内 hosts.json，缺失时返回空 + 说明', () => {
  const packaged = loadHosts({ env: {}, packageHostsPath: FIXTURE_HOSTS })
  assert.equal(packaged.source, 'package')
  assert.ok(packaged.hosts.gamma)

  const missing = loadHosts({ env: {}, packageHostsPath: MISSING_HOSTS })
  assert.equal(missing.source, 'none')
  assert.deepEqual(missing.hosts, {})
  assert.match(missing.error, /未配置任何远程主机/)
  assert.match(missing.error, /DSH_REMOTE_HOSTS/)
  assert.equal(PACKAGE_HOSTS_PATH.endsWith('hosts.json'), true)
})

console.log('# hosts: credential resolution')

const fixtureHosts = parseHostsDocument(readFileSync(FIXTURE_HOSTS, 'utf8'), 'fixture').hosts
const noDefaultKey = () => false

check('别名解析：password / passwordEnv / privateKeyPath', () => {
  const alpha = resolveHostRef('alpha', { hosts: fixtureHosts, env: {}, hasDefaultKey: noDefaultKey })
  assert.equal(alpha.auth, 'password')
  assert.equal(alpha.password, 'fixture-secret-value')
  assert.equal(alpha.port, 22)

  const beta = resolveHostRef('beta', {
    hosts: fixtureHosts,
    env: { DSH_REMOTE_FIXTURE_PASSWORD: 'from-env' },
    hasDefaultKey: noDefaultKey,
  })
  assert.equal(beta.auth, 'password')
  assert.equal(beta.password, 'from-env')

  const gamma = resolveHostRef('gamma', { hosts: fixtureHosts, env: {}, hasDefaultKey: noDefaultKey })
  assert.equal(gamma.auth, 'key')
  assert.equal(gamma.privateKeyPath, 'C:/fixtures/gamma-key')
})

check('passwordEnv 未设置时给出可读错误', () => {
  throwsMessage(
    () => resolveHostRef('beta', { hosts: fixtureHosts, env: {}, hasDefaultKey: noDefaultKey }),
    /DSH_REMOTE_FIXTURE_PASSWORD.*未设置/,
    'beta',
  )
})

check('已禁用别名、缺凭据别名都抛错', () => {
  throwsMessage(
    () => resolveHostRef('delta', { hosts: fixtureHosts, env: {}, hasDefaultKey: noDefaultKey }),
    /已禁用.*维护中/,
    'delta',
  )
  throwsMessage(
    () => resolveHostRef('epsilon', { hosts: fixtureHosts, env: {}, hasDefaultKey: noDefaultKey }),
    /无可用凭据/,
    'epsilon',
  )
  const withDefaultKey = resolveHostRef('epsilon', { hosts: fixtureHosts, env: {}, hasDefaultKey: () => true })
  assert.equal(withDefaultKey.auth, 'default-key')
})

check('临时 user@host[:port] 需要默认私钥', () => {
  const inline = resolveHostRef('admin@example.com:2200', { hosts: {}, hasDefaultKey: () => true })
  assert.equal(inline.host, 'example.com')
  assert.equal(inline.user, 'admin')
  assert.equal(inline.port, 2200)
  assert.equal(inline.inline, true)
  assert.equal(inline.password, undefined)

  const defaultUser = resolveHostRef('example.com', { hosts: {}, hasDefaultKey: () => true })
  assert.equal(defaultUser.user, 'root')
  assert.equal(defaultUser.port, 22)

  throwsMessage(
    () => resolveHostRef('root@example.com', { hosts: {}, hasDefaultKey: noDefaultKey }),
    /只能使用本机默认私钥/,
    'inline-no-key',
  )
})

check('未知主机、空主机、坏端口、坏端口配置都抛中文错误', () => {
  throwsMessage(() => resolveHostRef('nope', { hosts: fixtureHosts, hasDefaultKey: noDefaultKey }), /未知主机别名 "nope".*alpha/, 'unknown')
  throwsMessage(() => resolveHostRef('nope', { hosts: fixtureHosts, hasDefaultKey: () => true }), /未知主机别名/, 'unknown-with-key')
  throwsMessage(() => resolveHostRef('  ', { hosts: fixtureHosts }), /缺少主机/, 'empty')
  throwsMessage(() => resolveHostRef('root@example.com:99999', { hosts: {}, hasDefaultKey: () => true }), /端口不合法/, 'inline-port')
  throwsMessage(() => normalizePort(0, 'x'), /端口不合法/, 'normalize-port')
  assert.equal(normalizePort('2200', 'x'), 2200)
  assert.equal(normalizePort(undefined, 'x'), 22)
})

check('主机列表永不泄露密码（password / passwordEnv 值）', () => {
  const listed = publicHosts(fixtureHosts, { env: { DSH_REMOTE_FIXTURE_PASSWORD: 'from-env' }, hasDefaultKey: noDefaultKey })
  const serialized = JSON.stringify(listed)
  assert.equal(serialized.includes('fixture-secret-value'), false)
  assert.equal(serialized.includes('from-env'), false)
  const alpha = listed.find((host) => host.alias === 'alpha')
  assert.equal(alpha.hasPassword, true)
  assert.equal(alpha.auth, 'password')
  assert.equal(alpha.ready, true)
  const beta = listed.find((host) => host.alias === 'beta')
  assert.equal(beta.passwordEnv, 'DSH_REMOTE_FIXTURE_PASSWORD')
  assert.equal(beta.ready, true)
  const delta = listed.find((host) => host.alias === 'delta')
  assert.equal(delta.ready, false)
  assert.match(delta.issue, /已禁用/)
  assert.ok(findDefaultKeyPath(HERE) === null || typeof findDefaultKeyPath(HERE) === 'string')
})

check('env / group / tags：默认值、归一、非法文案、分组汇总排序', () => {
  assert.deepEqual(normalizeHostMeta('alpha', {}), { env: '', group: '', tags: [] })
  assert.deepEqual(
    normalizeHostMeta('alpha', { env: 'prod', group: 'web', tags: ['edge', 'cdn'] }),
    { env: 'prod', group: 'web', tags: ['edge', 'cdn'] },
  )
  assert.deepEqual(normalizeHostMeta('alpha', { tags: 'edge,cdn' }), { env: '', group: '', tags: ['edge', 'cdn'] })

  throwsMessage(
    () => normalizeHostEntry('alpha', { host: '10.0.0.1', env: 'Prod' }),
    /主机 "alpha" 的 env "Prod" 不合法：应为 1-32 位小写字母、数字或连字符/,
    'env-case',
  )
  throwsMessage(
    () => normalizeHostEntry('alpha', { host: '10.0.0.1', group: 'web/api' }),
    /主机 "alpha" 的 group "web\/api" 不合法/,
    'group-slash',
  )
  throwsMessage(
    () => normalizeHostEntry('alpha', { host: '10.0.0.1', tags: ['edge', 'edge'] }),
    /主机 "alpha" 的标签重复：edge/,
    'tag-duplicate',
  )
  throwsMessage(
    () => normalizeHostEntry('alpha', { host: '10.0.0.1', tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }),
    /主机 "alpha" 的标签最多 8 个（当前 9 个）/,
    'tag-limit',
  )

  const plain = publicHosts({ plain: normalizeHostEntry('plain', { host: '192.0.2.10' }) }, { env: {}, hasDefaultKey: noDefaultKey })
  assert.deepEqual(
    { env: plain[0].env, group: plain[0].group, tags: plain[0].tags },
    { env: '', group: '', tags: [] },
    '未配置时必须是空串与空数组，不能是 null',
  )

  const hosts = {
    web02: normalizeHostEntry('web02', { host: '192.0.2.12', env: 'test', group: 'web', tags: ['edge'] }),
    web01: normalizeHostEntry('web01', { host: '192.0.2.11', env: 'prod', group: 'web', tags: ['edge', 'cdn'] }),
    api01: normalizeHostEntry('api01', { host: '192.0.2.21', env: 'prod', group: 'api', tags: ['cdn'] }),
  }
  assert.deepEqual(hostGroups(hosts), {
    envs: [
      { name: 'prod', hosts: ['api01', 'web01'] },
      { name: 'test', hosts: ['web02'] },
    ],
    groups: [
      { name: 'api', hosts: ['api01'] },
      { name: 'web', hosts: ['web01', 'web02'] },
    ],
    tags: [
      { name: 'cdn', hosts: ['api01', 'web01'] },
      { name: 'edge', hosts: ['web01', 'web02'] },
    ],
  })
})

console.log('# truncation')

check('clipUtf8 按 UTF-8 字节截断且不切断多字节字符', () => {
  const ascii = clipUtf8('a'.repeat(100), 10)
  assert.equal(ascii.text.length, 10)
  assert.equal(ascii.originalBytes, 100)
  assert.equal(ascii.truncated, true)

  const chinese = clipUtf8('中文测试', 4)
  assert.equal(chinese.truncated, true)
  assert.equal(chinese.text, '中')
  assert.equal(chinese.bytes, 3)
  assert.equal(chinese.text.includes('\uFFFD'), false)
  assert.equal(utf8Bytes('中文'), 6)

  const fits = clipUtf8('hello', 5)
  assert.equal(fits.truncated, false)
  assert.equal(fits.text, 'hello')
})

check('createByteSink 截断并保留原始字节数', () => {
  const sink = createByteSink(10)
  sink.push('abc')
  sink.push('defghijklmn')
  const result = sink.result()
  assert.equal(result.truncated, true)
  assert.equal(result.text.length, 10)
  assert.equal(result.originalBytes, 14)
  assert.equal(result.text, 'abcdefghij')
})

check('tailUtf8 保留尾部且不产生替换字符', () => {
  assert.equal(tailUtf8('abcdef', 3), 'def')
  assert.equal(tailUtf8('a中', 3), '中')
  assert.equal(tailUtf8('short', 99), 'short')
})

console.log('# exec budgets')

check('normalizeTimeoutSec 默认 60、夹紧 1-600、拒绝非数字', () => {
  assert.equal(normalizeTimeoutSec(undefined), 60)
  assert.equal(normalizeTimeoutSec('30'), 30)
  assert.equal(normalizeTimeoutSec(0), 1)
  assert.equal(normalizeTimeoutSec(9999), 600)
  throwsMessage(() => normalizeTimeoutSec('abc'), /必须是数字/, 'timeout')
})

check('collectExecResult 截断 stdout 64KB / stderr 16KB 并标注', () => {
  const stdout = 'x'.repeat(70 * 1024)
  const stderr = 'y'.repeat(20 * 1024)
  const result = collectExecResult({ exitCode: 0, stdout, stderr, durationMs: 12 })
  assert.equal(utf8Bytes(result.stdout), LIMITS.stdoutBytes)
  assert.equal(utf8Bytes(result.stderr), LIMITS.stderrBytes)
  assert.equal(result.truncated.stdout, true)
  assert.equal(result.truncated.stderr, true)
  assert.equal(result.stdoutBytes, 70 * 1024)
  assert.equal(result.stderrBytes, 20 * 1024)
  assert.equal(result.exitCode, 0)
  assert.equal(result.durationMs, 12)

  const short = collectExecResult({ exitCode: 7, stdout: 'ok', stderr: '', timedOut: true })
  assert.equal(short.truncated.stdout, false)
  assert.equal(short.timedOut, true)
  assert.equal(short.exitCode, 7)
})

console.log('# tunnels')

check('隧道目标校验与默认值', () => {
  const target = normalizeForwardTarget({ remoteHost: ' 10.0.0.9 ', remotePort: 3306 })
  assert.deepEqual(target, { remoteHost: '10.0.0.9', remotePort: 3306, localPort: 0 })
  assert.equal(normalizeForwardTarget({ remoteHost: 'h', remotePort: '8080', localPort: 9000 }).localPort, 9000)
  throwsMessage(() => normalizeForwardTarget({ remoteHost: '', remotePort: 1 }), /remoteHost 不能为空/, 'host')
  throwsMessage(() => normalizeForwardTarget({ remoteHost: 'h', remotePort: 0 }), /remotePort/, 'port')
  throwsMessage(() => normalizeForwardTarget({ remoteHost: 'h', remotePort: 1, localPort: 70000 }), /localPort/, 'local')
  throwsMessage(() => normalizeForwardTarget({ remoteHost: 'a:b', remotePort: 1 }), /不支持带冒号/, 'colon')
})

check('隧道记录增删与列表', () => {
  let tick = 0
  const registry = new TunnelRegistry({ now: () => `2026-01-01T00:00:0${tick++}Z` })
  const first = registry.add({ host: 'alpha', remoteHost: '127.0.0.1', remotePort: 5432, localPort: 15432, handle: { close() {} } })
  const second = registry.add({ host: 'beta', remoteHost: 'db.internal', remotePort: 3306, localPort: 13306 })
  assert.equal(first.id, 'tn1')
  assert.equal(second.id, 'tn2')
  assert.equal(registry.size, 2)

  const listed = registry.list()
  assert.equal(listed.length, 2)
  assert.equal(listed[0].local, '127.0.0.1:15432')
  assert.equal(listed[1].remote, 'db.internal:3306')
  assert.equal(listed[0].host, 'alpha')

  const removed = registry.remove('tn1')
  assert.equal(removed.id, 'tn1')
  assert.equal(registry.get('tn1'), null)
  assert.equal(registry.list().length, 1)
  assert.equal(registry.remove('missing'), null)

  const drained = registry.drain()
  assert.equal(drained.length, 1)
  assert.equal(registry.size, 0)
})

check('sftp 路径祖先推导（unix / windows）', () => {
  assert.deepEqual(ancestorPaths('/a/b/c'), ['/a', '/a/b', '/a/b/c'])
  assert.deepEqual(ancestorPaths('C:\\logs\\app'), ['C:\\logs', 'C:\\logs\\app'])
  assert.deepEqual(ancestorPaths('relative/dir'), ['relative', 'relative/dir'])
  throwsMessage(() => ancestorPaths(''), /不能为空/, 'empty-dir')
})

console.log('# shells')

{
  class FakeStream extends EventEmitter {
    constructor() {
      super()
      this.writes = []
      this.ended = false
    }

    write(value) {
      this.writes.push(value)
      return true
    }

    end() {
      this.ended = true
      this.emit('close')
    }
  }
  check('appendCapped 保留尾部字节，takeOutput 截断 32KB', () => {
    assert.equal(appendCapped('abc', 'def', 4), 'cdef')
    const big = 'z'.repeat(LIMITS.shellReadBytes + 100)
    const taken = takeOutput(big)
    assert.equal(taken.truncated, true)
    assert.equal(utf8Bytes(taken.output), LIMITS.shellReadBytes)
  })

  check('ShellRegistry 打开 / 写入 / 读回 / 关闭', () => {
    const registry = new ShellRegistry({ now: () => '2026-01-01T00:00:00Z' })
    const stream = new FakeStream()
    const session = registry.attach({ host: 'alpha', stream })
    assert.equal(session.id, 'sh1')
    assert.equal(registry.list().length, 1)

    stream.emit('data', Buffer.from('welcome\r\n'))
    const first = registry.take('sh1')
    assert.equal(first.output, 'welcome\r\n')
    assert.equal(first.closed, false)
    const afterTake = registry.take('sh1')
    assert.equal(afterTake.output, '')

    registry.write('sh1', 'echo hi\n')
    assert.deepEqual(stream.writes, ['echo hi\n'])
    stream.emit('data', 'hi\r\n')
    assert.equal(registry.take('sh1').output, 'hi\r\n')

    assert.equal(registry.close('sh1'), true)
    assert.equal(stream.ended, true)
    assert.equal(registry.list().length, 0)
    assert.equal(registry.close('sh1'), false)
  })
}

console.log('# package surface')

const indexSource = readFileSync(join(PACKAGE_DIR, 'index.js'), 'utf8')
const indexModule = await import(new URL('../index.js', import.meta.url))
const clientSource = readFileSync(join(PACKAGE_DIR, 'client.js'), 'utf8')
const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
const patch = readFileSync(join(PACKAGE_DIR, 'cordis.patch.yml'), 'utf8')
const localeEn = JSON.parse(readFileSync(join(PACKAGE_DIR, 'locale', 'en.json'), 'utf8'))
const localeZh = JSON.parse(readFileSync(join(PACKAGE_DIR, 'locale', 'zh.json'), 'utf8'))
const icon = readFileSync(join(PACKAGE_DIR, 'icon.svg'), 'utf8')

check('面板提供「流水线」跳转入口（v2.6）', () => {
  assert.ok(clientSource.includes("className: 'remote-open-pipeline'"), 'client 应该有「流水线」按钮')
  assert.ok(clientSource.includes('data-dsh-panel-entry="cicd"'), '按钮应定位左侧栏 cicd 面板入口')
  assert.ok(clientSource.includes('function openPipelinePanel()'), '应该抽出 openPipelinePanel 兜底')
})

check('package.json 清单完整', () => {
  assert.equal(manifest.name, '@local/dsh-remote')
  assert.equal(manifest.version, '2.7.1')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.private, true)
  assert.equal(manifest.exports['.'], './index.js')
  assert.equal(manifest.exports['./client'], './client.js')
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
  assert.equal(manifest.exports['./icon'], './icon.svg')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.deepEqual(manifest.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-conversation'])
  for (const expected of ['index.js', 'client.js', 'lib/*.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg']) {
    assert.ok(manifest.files.includes(expected), `files 缺少 ${expected}`)
  }
})

check('cordis.patch.yml 插入 dsh-remote 行', () => {
  assert.match(patch, /^\s*-\s*insert:\s*$/m)
  assert.match(patch, /^\s*-\s*id:\s*dsh-remote\s*$/m)
  assert.match(patch, /^\s*name:\s*'@local\/dsh-remote'\s*$/m)
})

check('locale 与 icon 齐全', () => {
  assert.equal(typeof localeEn.meta.title, 'string')
  assert.equal(typeof localeEn.meta.description, 'string')
  assert.equal(typeof localeZh.meta.title, 'string')
  assert.equal(typeof localeZh.meta.description, 'string')
  assert.match(icon, /<svg[^>]*viewBox="0 0 64 64"/)
  assert.ok(Buffer.byteLength(icon, 'utf8') < 256 * 1024)
})

check('index.js 导出 inject/apply 并注册 13 个 remote_* 工具', () => {
  assert.deepEqual(indexModule.inject, ['tools'])
  assert.equal(typeof indexModule.apply, 'function')
  const names = [...indexSource.matchAll(/name:\s*'(remote_[a-z_]+)'/g)].map((match) => match[1])
  assert.equal(names.length, 13, `工具数不是 13：${names.join(', ')}`)
  assert.equal(new Set(names).size, names.length, '工具名重复')
  for (const expected of [
    'remote_hosts',
    'remote_exec',
    'remote_cluster_exec',
    'remote_ls',
    'remote_download',
    'remote_upload',
    'remote_mkdir',
    'remote_tunnel_open',
    'remote_tunnel_close',
    'remote_tunnel_list',
    'remote_shell_open',
    'remote_shell_send',
    'remote_shell_close',
  ]) {
    assert.ok(names.includes(expected), `缺少工具 ${expected}`)
  }
  const outputBlocks = [...indexSource.matchAll(/output:\s*\{\s*schema:/g)].length
  assert.equal(outputBlocks, 13, `output.schema 数量不是 13：${outputBlocks}`)
  const renderBlocks = [...indexSource.matchAll(/\brender[:(]/g)].length
  assert.ok(renderBlocks >= 13, 'render 数量不足')
})

check('client.js 语法可解析，只注册左侧栏面板 + keyed main（不注册会话内 View）', () => {
  assert.doesNotThrow(() => new Function(clientSource), 'client.js 语法错误')
  // v2.8：会话内 View 与宿主 composer 同属 conversation.content —— 整页应用放进去，底部永远跟着聊天输入框，
  // 宿主也没有隐藏 composer 的开关，所以只能走全局面板（同 dsh-aihot / docs/SPEC.md §4 的 v2 结论）。
  assert.equal(/name:\s*'conversation\.view'/.test(clientSource), false, '不应再注册 conversation.view')
  assert.match(clientSource, /id:\s*'remote'/)
  assert.match(clientSource, /label:\s*\(\)\s*=>\s*'远程主机'/)
  assert.match(clientSource, /sidebar\.panellist/)
  assert.match(clientSource, /order:\s*60/)
  assert.match(clientSource, /name:\s*'main',\s*\n\s*key:\s*'remote'/)
  assert.match(clientSource, /data-dsh-panel-entry':\s*'remote'/)
  assert.match(clientSource, /viewBox:\s*'0 0 16 16'/)
  assert.equal((clientSource.match(/ctx\.slots\.inject/g) || []).length, 2, '两个 slot 注册都应走 ctx.slots.inject')
  assert.match(clientSource, /require\('react'\)/)
  assert.equal(clientSource.includes('iframe'), false)
  assert.equal(clientSource.includes('document.body'), false)
  for (const token of [
    '--dsw-alias-label-primary',
    '--dsw-alias-label-secondary',
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-border-l1',
    '--dsw-alias-border-l2',
    '--dsw-alias-brand-primary',
    '--dsw-alias-state-error-primary',
    '--dsw-alias-state-success-primary',
    '--dsw-alias-state-warn-primary',
    '--dsw-alias-state-idle-primary',
  ]) {
    assert.ok(clientSource.includes(token), `client.js 缺少主题 token ${token}`)
  }
  const hardcoded = clientSource.match(/#[0-9a-fA-F]{3,8}\b/g) || []
  assert.equal(hardcoded.length, 0, `client.js 出现写死颜色：${hardcoded.join(', ')}`)
})

check('HTTP 路由与工具共享同一套 runtime', () => {
  assert.equal(indexModule.internals.ROUTE_PREFIX, '/api/plugins/remote')
  for (const path of ['hosts', 'exec', 'tunnels', 'tunnel-open', 'files', 'file', 'file-download', 'file-upload-begin', 'file-upload-chunk', 'file-upload-finish', 'file-upload-abort', 'file-write', 'file-mkdir', 'file-rename', 'file-delete', 'file-chmod', 'file-chown', 'file-search', 'protocols', 'groups', 'gui-open', 'host-save', 'host-delete', 'shell-open', 'shell-attach', 'shell-send', 'shell-read', 'shell-resize', 'shell-log', 'shell-close', 'novnc.js', 'desktop-status', 'desktop-start', 'desktop-stop', 'desktop-connect', 'desktop-install']) {
    assert.ok(indexSource.includes('ROUTE_PREFIX}/' + path), `缺少路由 ${path}`)
  }
  assert.match(indexSource, /kind:\s*'exact'/)
  assert.match(indexSource, /ctx\.get\('webServer'\)/)
  assert.equal(typeof indexModule.internals.createRuntime, 'function')
  const runtime = indexModule.internals.createRuntime({})
  const listed = runtime.listHosts()
  // A local hosts.json may exist for end-to-end runs; either source is legitimate here.
  assert.ok(['package', 'none'].includes(listed.source), `意外的主机来源：${listed.source}`)
  if (listed.source === 'none') assert.match(listed.configError, /未配置任何远程主机/)
  else assert.ok(listed.hosts.length > 0, '包内 hosts.json 应至少列出一台主机')
  runtime.dispose()
})

// v2.3 修的真 bug：remote_cluster_exec 的失败行曾返回 error: null、exitCode: null，
// 而 output schema 里 error 只声明了 type: 'string'（JSON Schema 不接受 type 数组），
// 于是工具在执行成功时反而报 `value.results[0].error must be a string`。
check('cluster 结果的可空字段一律返回字符串/数字', () => {
  assert.ok(indexSource.includes("error: '',"), '成功行的 error 应为空串')
  assert.ok(indexSource.includes('exitCode: -1,'), '连接失败行的 exitCode 应为 -1')
  assert.match(indexSource, /exitCode: \{ type: 'number'/)
})

// v2.4 修的同一个坑：remote_hosts 的 configError 在没有配置问题时是 null，
// schema 却只声明 type: 'string'，于是整个工具报 `value.configError must be a string`。
check('host 列表的 configError 始终是字符串', () => {
  assert.ok(indexSource.includes("configError: info.error || ''"), 'configError 应为空串而不是 null')
  assert.match(indexSource, /configError: \{ type: 'string', description: '配置问题说明；没有问题时为空串' \}/)
})

check('README 覆盖工具、配置、路由与限制', () => {
  const readme = readFileSync(join(PACKAGE_DIR, 'README.md'), 'utf8')
  for (const needle of ['remote_cluster_exec', 'config.hosts', 'DSH_REMOTE_HOSTS', '/api/plugins/remote/exec', '/api/plugins/remote/files', '/api/plugins/remote/file', '/api/plugins/remote/host-save', '/api/plugins/remote/groups', '/api/plugins/remote/file-download', '/api/plugins/remote/file-upload-begin', '/api/plugins/remote/shell-open', '/api/plugins/remote/shell-resize', '/api/plugins/remote/shell-attach', '/api/plugins/remote/shell-log', '/api/plugins/remote/file-write', '/api/plugins/remote/file-mkdir', '/api/plugins/remote/file-chmod', '/api/plugins/remote/protocols', 'x-dsh-remote-exec', 'sidebar.panellist', '已知限制', 'dsh-ssh']) {
    assert.ok(readme.includes(needle), `README 缺少 ${needle}`)
  }
})

// ---------------------------------------------------------------------------------------------
// Plugin wiring: apply() against a fake context, and the HTTP routes against real Request/Response.
// Nothing here opens an SSH connection; the fake host points at an unroutable address and is only
// used for listing/validation paths.
// ---------------------------------------------------------------------------------------------

console.log('# plugin wiring')

async function checkAsync(name, fn) {
  await fn()
  checks += 1
  console.log(`ok ${checks} - ${name}`)
}

const registeredTools = []
const registeredRoutes = []
const registeredDisposers = []
const registeredUpgrades = []
const fakeWeb = {
  getOrigin: () => 'http://127.0.0.1:1',
  register(spec) {
    registeredRoutes.push(spec)
    return () => {}
  },
  registerUpgrade(spec) {
    registeredUpgrades.push(spec)
    return () => {}
  },
}
const fakeCtx = {
  tools: {
    register(definition) {
      registeredTools.push(definition)
      return () => {}
    },
  },
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') registeredDisposers.push(dispose)
  },
  get(name) {
    return name === 'webServer' ? fakeWeb : undefined
  },
}

await checkAsync('apply() 注册 13 个工具与 36 条 exact 路由、1 条 upgrade 路由', async () => {
  indexModule.apply(fakeCtx, {
    hosts: { sandbox: { host: '192.0.2.1', port: 22, user: 'tester', password: 'super-secret-value' } },
    defaultTimeoutSec: 30,
  })
  assert.equal(registeredTools.length, 13)
  assert.equal(new Set(registeredTools.map((tool) => tool.name)).size, 13)
  for (const tool of registeredTools) {
    assert.equal(tool.parameters.type, 'object', `${tool.name} parameters 不是 object`)
    assert.equal(typeof tool.execute, 'function', `${tool.name} 缺 execute`)
    assert.ok(tool.output && tool.output.schema, `${tool.name} 缺 output.schema`)
    assert.equal(typeof tool.output.render, 'function', `${tool.name} 缺 output.render`)
  }
  assert.equal(registeredRoutes.length, 36)
  assert.deepEqual(registeredRoutes.map((route) => route.path).sort(), [
    '/api/plugins/remote/desktop-connect',
    '/api/plugins/remote/desktop-install',
    '/api/plugins/remote/desktop-start',
    '/api/plugins/remote/desktop-status',
    '/api/plugins/remote/desktop-stop',
    '/api/plugins/remote/exec',
    '/api/plugins/remote/file',
    '/api/plugins/remote/file-chmod',
    '/api/plugins/remote/file-chown',
    '/api/plugins/remote/file-delete',
    '/api/plugins/remote/file-download',
    '/api/plugins/remote/file-mkdir',
    '/api/plugins/remote/file-rename',
    '/api/plugins/remote/file-search',
    '/api/plugins/remote/file-upload-abort',
    '/api/plugins/remote/file-upload-begin',
    '/api/plugins/remote/file-upload-chunk',
    '/api/plugins/remote/file-upload-finish',
    '/api/plugins/remote/file-write',
    '/api/plugins/remote/files',
    '/api/plugins/remote/groups',
    '/api/plugins/remote/gui-open',
    '/api/plugins/remote/host-delete',
    '/api/plugins/remote/host-save',
    '/api/plugins/remote/hosts',
    '/api/plugins/remote/novnc.js',
    '/api/plugins/remote/protocols',
    '/api/plugins/remote/shell-attach',
    '/api/plugins/remote/shell-close',
    '/api/plugins/remote/shell-log',
    '/api/plugins/remote/shell-open',
    '/api/plugins/remote/shell-read',
    '/api/plugins/remote/shell-resize',
    '/api/plugins/remote/shell-send',
    '/api/plugins/remote/tunnel-open',
    '/api/plugins/remote/tunnels',
  ])
  assert.ok(registeredRoutes.every((route) => route.kind === 'exact'))
  for (const route of registeredRoutes) {
    assert.equal(typeof route.resource, 'function', `${route.path} 必须用 resource（carrier 只服务 GET/HEAD）`)
    assert.equal(route.handler, undefined, `${route.path} 不能带 handler：carrier 在匹配前就拒绝非 GET/HEAD`)
  }
})

await checkAsync('冷启动回归：webServer 未就绪时 0 路由，inject 就绪后补注册 36+1 条', async () => {
  const coldRoutes = []
  const coldUpgrades = []
  const coldEffects = []
  const coldWeb = {
    register(spec) { coldRoutes.push(spec); return () => {} },
    registerUpgrade(spec) { coldUpgrades.push(spec); return () => {} },
  }
  let scopeFn = null
  const coldCtx = {
    tools: { register() { return () => {} } },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') coldEffects.push(dispose) },
    get() { return undefined },
    inject(deps, fn) { assert.deepEqual(deps, ['webServer']); scopeFn = fn },
  }
  indexModule.apply(coldCtx, {})
  assert.equal(coldRoutes.length, 0, '冷启动阶段一条路由都不该注册')
  assert.equal(coldUpgrades.length, 0)
  assert.ok(typeof scopeFn === 'function', 'apply 应把路由注册挂到 ctx.inject 上')
  // 模拟 webServer 就绪：cordis 以一个能 get 到服务的 scope 触发回调（真实环境由服务就绪事件驱动）。
  scopeFn({ get: (key) => (key === 'webServer' ? coldWeb : undefined), effect() {} })
  assert.equal(coldRoutes.length, 36, '就绪后应补注册 36 条 exact 路由')
  assert.equal(coldUpgrades.length, 1, '就绪后应补注册 1 条 upgrade 路由')
})

await checkAsync('GET /groups：免执行头、同源校验、未知参数 400、桶按 name 升序', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-remote-groups-'))
  const file = join(directory, 'hosts.json')
  writeFileSync(file, JSON.stringify({
    hosts: {
      web02: { host: '192.0.2.12', env: 'test', group: 'web', tags: ['edge'] },
      web01: { host: '192.0.2.11', env: 'prod', group: 'web', tags: ['edge', 'cdn'] },
      api01: { host: '192.0.2.21', env: 'prod', group: 'api', tags: ['cdn'] },
      plain: { host: '192.0.2.99' },
    },
  }), { mode: 0o600 })
  const previousEnv = process.env.DSH_REMOTE_HOSTS
  delete process.env.DSH_REMOTE_HOSTS
  const runtime = indexModule.internals.createRuntime({ packageHostsPath: file })
  const call = (query, headers = {}) => indexModule.internals.resources.groupsResource(
    new Request(`http://127.0.0.1:1/api/plugins/remote/groups?${query}`, { headers }),
    runtime,
  )
  try {
    const body = await call('')
    assert.equal(body.status, 200)
    assert.deepEqual(await body.json(), {
      ok: true,
      envs: [
        { name: 'prod', hosts: ['api01', 'web01'] },
        { name: 'test', hosts: ['web02'] },
      ],
      groups: [
        { name: 'api', hosts: ['api01'] },
        { name: 'web', hosts: ['web01', 'web02'] },
      ],
      tags: [
        { name: 'cdn', hosts: ['api01', 'web01'] },
        { name: 'edge', hosts: ['web01', 'web02'] },
      ],
    })

    const crossOrigin = await call('', { origin: 'http://evil.example' })
    assert.equal(crossOrigin.status, 403)
    assert.match((await crossOrigin.json()).error, /只接受本地同源请求/)

    const unknown = await call('env=prod')
    assert.equal(unknown.status, 400)
    assert.match((await unknown.json()).error, /不支持的查询参数：env/)
  } finally {
    if (previousEnv === undefined) delete process.env.DSH_REMOTE_HOSTS
    else process.env.DSH_REMOTE_HOSTS = previousEnv
    rmSync(directory, { recursive: true, force: true })
  }
})

await checkAsync('参数校验在连网前完成（upload 二选一 / cluster 上限 / 去重）', async () => {
  const uploadTool = registeredTools.find((tool) => tool.name === 'remote_upload')
  await assert.rejects(() => uploadTool.execute({ host: 'sandbox', remotePath: '/tmp/a' }, {}), /二选一/)
  await assert.rejects(
    () => uploadTool.execute({ host: 'sandbox', remotePath: '/tmp/a', content: 'x', localPath: 'C:/x' }, {}),
    /二选一/,
  )

  const clusterTool = registeredTools.find((tool) => tool.name === 'remote_cluster_exec')
  await assert.rejects(() => clusterTool.execute({ hosts: [], command: 'uptime' }, {}), /非空的主机别名数组/)
  await assert.rejects(
    () => clusterTool.execute({ hosts: Array.from({ length: 11 }, (_, index) => 'h' + index), command: 'uptime' }, {}),
    /最多并发 10 台/,
  )
  await assert.rejects(
    () => clusterTool.execute({ hosts: ['sandbox', 'sandbox'], command: 'uptime' }, {}),
    /重复主机/,
  )
})

await checkAsync('remote_hosts 工具与 GET /hosts 都不泄露密码', async () => {
  const hostsTool = registeredTools.find((tool) => tool.name === 'remote_hosts')
  const result = await hostsTool.execute({}, {})
  assert.equal(result.source, 'config')
  assert.equal(result.hosts.length, 1)
  assert.equal(result.hosts[0].alias, 'sandbox')
  assert.equal(result.hosts[0].hasPassword, true)
  const rendered = hostsTool.output.render({}, result)
  assert.equal(rendered[0].type, 'text')
  assert.equal(rendered[0].text.includes('super-secret-value'), false)
  assert.equal(JSON.stringify(result).includes('super-secret-value'), false)

  const hostsRoute = registeredRoutes.find((route) => route.path.endsWith('/hosts'))
  const response = await hostsRoute.resource(new Request('http://127.0.0.1:1/api/plugins/remote/hosts'))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.hosts[0].alias, 'sandbox')
  assert.equal(JSON.stringify(body).includes('super-secret-value'), false)
})

let testServer = null
let testBase = ''

/** Adapt the raw carrier request to the Request a WebResource receives. */
function toWebRequest(request) {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item))
    else if (typeof value === 'string') headers.set(name, value)
  }
  return new Request(`http://${request.headers.host}${request.url}`, {
    method: request.method,
    headers,
  })
}

await checkAsync('启动本地测试 HTTP 服务（resource -> Response 适配，不连远端主机）', async () => {
  testServer = http.createServer((request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname
    const route = registeredRoutes.find((candidate) => candidate.path === path)
    if (!route || typeof route.resource !== 'function') {
      response.statusCode = 404
      response.end()
      return
    }
    Promise.resolve(route.resource(toWebRequest(request)))
      .then(async (webResponse) => {
        response.statusCode = webResponse.status
        webResponse.headers.forEach((value, name) => response.setHeader(name, value))
        response.end(Buffer.from(await webResponse.arrayBuffer()))
      })
      .catch((error) => {
        if (!response.headersSent) {
          response.statusCode = 500
          response.setHeader('content-type', 'application/json; charset=utf-8')
        }
        response.end(JSON.stringify({ ok: false, error: error.message }))
      })
  })
  await new Promise((resolve, reject) => {
    testServer.once('error', reject)
    testServer.listen(0, '127.0.0.1', resolve)
  })
  testBase = `http://127.0.0.1:${testServer.address().port}`
})

await checkAsync('GET /exec：缺头 403、未知参数 400、缺参 400、超长 413、跨源 403', async () => {
  const url = `${testBase}/api/plugins/remote/exec`
  const withHeader = (query, headers = {}) => fetch(`${url}?${query}`, {
    headers: { 'x-dsh-remote-exec': '1', ...headers },
  })

  const noHeader = await fetch(`${url}?host=sandbox&command=uptime`)
  assert.equal(noHeader.status, 403)
  assert.match((await noHeader.json()).error, /缺少 x-dsh-remote-exec 头/)

  const noHost = await withHeader('command=uptime')
  assert.equal(noHost.status, 400)
  assert.match((await noHost.json()).error, /host/)

  const noCommand = await withHeader('host=sandbox')
  assert.equal(noCommand.status, 400)
  assert.match((await noCommand.json()).error, /command/)

  const unknownParam = await withHeader('host=sandbox&command=uptime&extra=1')
  assert.equal(unknownParam.status, 400)
  assert.match((await unknownParam.json()).error, /不支持的查询参数：extra/)

  const badTimeout = await withHeader('host=sandbox&command=uptime&timeoutSec=soon')
  assert.equal(badTimeout.status, 400)
  assert.match((await badTimeout.json()).error, /timeoutSec/)

  const longCommand = await withHeader(`host=sandbox&command=${'a'.repeat(8 * 1024 + 1)}`)
  assert.equal(longCommand.status, 413)
  assert.match((await longCommand.json()).error, /8KB|8192|字节上限/)

  const crossOrigin = await withHeader('host=sandbox&command=uptime', { origin: 'http://evil.example' })
  assert.equal(crossOrigin.status, 403)
  assert.match((await crossOrigin.json()).error, /只接受本地同源请求/)

  // localhost against the bound 127.0.0.1 origin is the same local desktop, not cross-origin.
  const loopbackOrigin = await withHeader('host=no-such-host&command=uptime', { origin: 'http://localhost:1' })
  assert.equal(loopbackOrigin.status, 500)

  const unknownHost = await withHeader('host=no-such-host&command=uptime')
  assert.equal(unknownHost.status, 500)
  assert.match((await unknownHost.json()).error, /未知主机别名/)
})

await checkAsync('GET /tunnels：列表 200、close 缺头 403、action 400、未知隧道 404', async () => {
  const url = `${testBase}/api/plugins/remote/tunnels`
  const close = (query, headers = {}) => fetch(`${url}?${query}`, {
    headers: { 'x-dsh-remote-exec': '1', ...headers },
  })

  const listed = await fetch(url)
  assert.equal(listed.status, 200)
  assert.deepEqual((await listed.json()).tunnels, [])

  const noHeader = await fetch(`${url}?action=close&tunnelId=tn1`)
  assert.equal(noHeader.status, 403)
  assert.match((await noHeader.json()).error, /缺少 x-dsh-remote-exec 头/)

  const badAction = await close('action=open&tunnelId=tn1')
  assert.equal(badAction.status, 400)
  assert.match((await badAction.json()).error, /只支持 'close'/)

  const noTunnelId = await close('action=close')
  assert.equal(noTunnelId.status, 400)
  assert.match((await noTunnelId.json()).error, /tunnelId/)

  const unknownField = await close('action=close&tunnelId=tn9&extra=1')
  assert.equal(unknownField.status, 400)
  assert.match((await unknownField.json()).error, /不支持的查询参数：extra/)

  const missing = await close('action=close&tunnelId=tn9')
  assert.equal(missing.status, 404)
  assert.match((await missing.json()).error, /隧道 tn9 不存在/)

  const crossOrigin = await close('action=close&tunnelId=tn9', { origin: 'http://evil.example' })
  assert.equal(crossOrigin.status, 403)

  const hostsResponse = await fetch(`${testBase}/api/plugins/remote/hosts`)
  assert.equal(hostsResponse.status, 200)
  assert.equal((await hostsResponse.json()).ok, true)
})

await checkAsync('GET /tunnel-open：缺头 403、未知参数 400、坏端口 400、超长 413', async () => {
  const url = `${testBase}/api/plugins/remote/tunnel-open`
  const open = (query, headers = {}) => fetch(`${url}?${query}`, {
    headers: { 'x-dsh-remote-exec': '1', ...headers },
  })

  const noHeader = await fetch(`${url}?host=sandbox&remoteHost=127.0.0.1&remotePort=5432`)
  assert.equal(noHeader.status, 403)
  assert.match((await noHeader.json()).error, /缺少 x-dsh-remote-exec 头/)

  const noHost = await open('remoteHost=127.0.0.1&remotePort=5432')
  assert.equal(noHost.status, 400)
  assert.match((await noHost.json()).error, /host/)

  const unknownParam = await open('host=sandbox&remoteHost=127.0.0.1&remotePort=5432&extra=1')
  assert.equal(unknownParam.status, 400)
  assert.match((await unknownParam.json()).error, /不支持的查询参数：extra/)

  const badRemotePort = await open('host=sandbox&remoteHost=127.0.0.1&remotePort=0')
  assert.equal(badRemotePort.status, 400)
  assert.match((await badRemotePort.json()).error, /remotePort/)

  const badLocalPort = await open('host=sandbox&remoteHost=127.0.0.1&remotePort=5432&localPort=70000')
  assert.equal(badLocalPort.status, 400)
  assert.match((await badLocalPort.json()).error, /localPort/)

  const longRemoteHost = await open(`host=sandbox&remoteHost=${'a'.repeat(300)}&remotePort=5432`)
  assert.equal(longRemoteHost.status, 413)
  assert.match((await longRemoteHost.json()).error, /remoteHost 超过 255 字节/)

  const crossOrigin = await open('host=sandbox&remoteHost=127.0.0.1&remotePort=5432', { origin: 'http://evil.example' })
  assert.equal(crossOrigin.status, 403)
  assert.match((await crossOrigin.json()).error, /只接受本地同源请求/)
})

await checkAsync('tunnel-open 成功 / 失败路径（假 runtime，不连 SSH）', async () => {
  const url = 'http://127.0.0.1:1/api/plugins/remote/tunnel-open'
  const call = (query, runtime) => indexModule.internals.resources.tunnelOpenResource(
    new Request(`${url}?${query}`, { headers: { 'x-dsh-remote-exec': '1' } }),
    runtime,
  )

  const calls = []
  const fakeRuntime = {
    async tunnelOpen(host, target) {
      calls.push({ host, target })
      return {
        tunnelId: 'tn7',
        host,
        remoteHost: target.remoteHost,
        remotePort: target.remotePort,
        localPort: target.localPort || 15432,
        local: `127.0.0.1:${target.localPort || 15432}`,
        remote: `${target.remoteHost}:${target.remotePort}`,
        createdAt: '2026-01-01T00:00:00Z',
      }
    },
  }

  const autoPort = await call('host=sandbox&remoteHost=db.internal&remotePort=5432', fakeRuntime)
  assert.equal(autoPort.status, 200)
  assert.deepEqual(await autoPort.json(), {
    ok: true,
    tunnel: { id: 'tn7', local: '127.0.0.1:15432', remote: 'db.internal:5432', host: 'sandbox' },
  })
  assert.deepEqual(calls[0], {
    host: 'sandbox',
    target: { remoteHost: 'db.internal', remotePort: 5432, localPort: 0 },
  })

  const explicitPort = await call('host=sandbox&remotePort=3306&localPort=13306', fakeRuntime)
  assert.equal(explicitPort.status, 200)
  assert.deepEqual((await explicitPort.json()).tunnel.local, '127.0.0.1:13306')
  assert.deepEqual(calls[1], {
    host: 'sandbox',
    target: { remoteHost: '127.0.0.1', remotePort: 3306, localPort: 13306 },
  })

  const failingRuntime = {
    async tunnelOpen() { throw new Error('连接池不可用') },
  }
  const failed = await call('host=sandbox&remotePort=5432', failingRuntime)
  assert.equal(failed.status, 500)
  assert.match((await failed.json()).error, /连接池不可用/)
})

await checkAsync('GET /files：缺头 403、跨源 403、未知参数 400、空参 400、相对路径 400、超长 413', async () => {
  const url = `${testBase}/api/plugins/remote/files`
  const list = (query, headers = {}) => fetch(`${url}?${query}`, {
    headers: { 'x-dsh-remote-exec': '1', ...headers },
  })

  const noHeader = await fetch(`${url}?host=sandbox&path=%2Ftmp`)
  assert.equal(noHeader.status, 403)
  assert.match((await noHeader.json()).error, /缺少 x-dsh-remote-exec 头/)

  const crossOrigin = await list('host=sandbox&path=%2Ftmp', { origin: 'http://evil.example' })
  assert.equal(crossOrigin.status, 403)
  assert.match((await crossOrigin.json()).error, /只接受本地同源请求/)

  const unknownParam = await list('host=sandbox&path=%2Ftmp&extra=1')
  assert.equal(unknownParam.status, 400)
  assert.match((await unknownParam.json()).error, /不支持的查询参数：extra/)

  const noHost = await list('path=%2Ftmp')
  assert.equal(noHost.status, 400)
  assert.match((await noHost.json()).error, /host/)

  const emptyHost = await list('host=&path=%2Ftmp')
  assert.equal(emptyHost.status, 400)
  assert.match((await emptyHost.json()).error, /host/)

  const noPath = await list('host=sandbox')
  assert.equal(noPath.status, 400)
  assert.match((await noPath.json()).error, /path/)

  const relativePath = await list('host=sandbox&path=tmp%2Fx')
  assert.equal(relativePath.status, 400)
  assert.match((await relativePath.json()).error, /path 必须是绝对路径/)

  const longPath = await list(`host=sandbox&path=%2F${'a'.repeat(4096)}`)
  assert.equal(longPath.status, 413)
  assert.match((await longPath.json()).error, /path 超过 4096 字节/)

  const longHost = await list(`host=${'a'.repeat(513)}&path=%2Ftmp`)
  assert.equal(longHost.status, 413)
  assert.match((await longHost.json()).error, /host 超过 512 字节/)
})

await checkAsync('GET /file：缺头 403、跨源 403、未知参数 400、相对路径 400、maxBytes 越界 400', async () => {
  const url = `${testBase}/api/plugins/remote/file`
  const read = (query, headers = {}) => fetch(`${url}?${query}`, {
    headers: { 'x-dsh-remote-exec': '1', ...headers },
  })

  const noHeader = await fetch(`${url}?host=sandbox&path=%2Fetc%2Fhosts`)
  assert.equal(noHeader.status, 403)
  assert.match((await noHeader.json()).error, /缺少 x-dsh-remote-exec 头/)

  const crossOrigin = await read('host=sandbox&path=%2Fetc%2Fhosts', { origin: 'http://evil.example' })
  assert.equal(crossOrigin.status, 403)
  assert.match((await crossOrigin.json()).error, /只接受本地同源请求/)

  const unknownParam = await read('host=sandbox&path=%2Fetc%2Fhosts&extra=1')
  assert.equal(unknownParam.status, 400)
  assert.match((await unknownParam.json()).error, /不支持的查询参数：extra/)

  const relativePath = await read('host=sandbox&path=etc%2Fhosts')
  assert.equal(relativePath.status, 400)
  assert.match((await relativePath.json()).error, /path 必须是绝对路径/)

  for (const value of ['0', '65537', 'abc', '1.5', '-1']) {
    const badLimit = await read(`host=sandbox&path=%2Fetc%2Fhosts&maxBytes=${value}`)
    assert.equal(badLimit.status, 400, `maxBytes=${value}`)
    assert.match((await badLimit.json()).error, /maxBytes 必须是 1-65536 的整数/)
  }
})

await checkAsync('files / file 成功形状（假 runtime，不连 SSH）', async () => {
  const base = 'http://127.0.0.1:1/api/plugins/remote'
  const files = (query, runtime) => indexModule.internals.resources.filesResource(
    new Request(`${base}/files?${query}`, { headers: { 'x-dsh-remote-exec': '1' } }),
    runtime,
  )
  const file = (query, runtime) => indexModule.internals.resources.fileResource(
    new Request(`${base}/file?${query}`, { headers: { 'x-dsh-remote-exec': '1' } }),
    runtime,
  )

  const listingCalls = []
  const listingRuntime = {
    async listRemote(host, path, options) {
      listingCalls.push({ host, path, options })
      return {
        host,
        path,
        entries: [
          { name: 'sub', type: 'dir', isDir: true, size: 4096, mtime: '2026-01-02T03:04:05Z' },
          { name: 'readme.md', type: 'file', isDir: false, size: 12, mtime: '2026-01-02T03:04:05Z' },
          { name: 'current', type: 'link', isDir: false, size: 7, mtime: null },
          { name: 'legacy-dir', isDir: true },
        ],
        total: 4,
        truncated: true,
      }
    },
  }

  const listed = await files('host=sandbox&path=%2Fvar%2Flog', listingRuntime)
  assert.equal(listed.status, 200)
  assert.deepEqual(await listed.json(), {
    ok: true,
    host: 'sandbox',
    path: '/var/log',
    entries: [
      { name: 'sub', type: 'dir', size: 4096, mtime: '2026-01-02T03:04:05Z' },
      { name: 'readme.md', type: 'file', size: 12, mtime: '2026-01-02T03:04:05Z' },
      { name: 'current', type: 'link', size: 7, mtime: null },
      { name: 'legacy-dir', type: 'dir', size: null, mtime: null },
    ],
    total: 4,
    truncated: true,
    sort: 'name',
    hidden: true,
  })
  assert.deepEqual(listingCalls, [{ host: 'sandbox', path: '/var/log', options: { sort: 'name', hidden: true } }])

  const failingListing = {
    async listRemote() { throw new Error('Permission denied') },
  }
  const listFailed = await files('host=sandbox&path=%2Froot', failingListing)
  assert.equal(listFailed.status, 403)
  assert.match((await listFailed.json()).error, /Permission denied/)

  const readCalls = []
  const readRuntime = {
    async download(host, path, maxBytes) {
      readCalls.push({ host, path, maxBytes })
      if (path === '/binary.bin') return { content: 'a\u0000b', size: 8, bytes: 3, truncated: true }
      if (path === '/big.log') return { content: 'hello', size: 100, bytes: 5, truncated: true }
      if (path === '/protected') throw new Error('/protected 是目录：请用 remote_ls 列目录')
      return { content: 'hello', size: 5, bytes: 5, truncated: false }
    },
  }

  const defaultLimit = await file('host=sandbox&path=%2Fetc%2Fhosts', readRuntime)
  assert.equal(defaultLimit.status, 200)
  assert.deepEqual(await defaultLimit.json(), {
    ok: true, host: 'sandbox', path: '/etc/hosts', size: 5, bytes: 5, truncated: false, content: 'hello',
  })
  assert.deepEqual(readCalls[0], { host: 'sandbox', path: '/etc/hosts', maxBytes: 32768 })

  const explicitLimit = await file('host=sandbox&path=%2Fbig.log&maxBytes=1024', readRuntime)
  assert.equal(explicitLimit.status, 200)
  assert.deepEqual(await explicitLimit.json(), {
    ok: true, host: 'sandbox', path: '/big.log', size: 100, bytes: 5, truncated: true, content: 'hello',
  })
  assert.equal(readCalls[1].maxBytes, 1024)

  const binary = await file('host=sandbox&path=%2Fbinary.bin', readRuntime)
  assert.equal(binary.status, 200)
  const binaryBody = await binary.json()
  assert.deepEqual(binaryBody, { ok: true, host: 'sandbox', path: '/binary.bin', size: 8, binary: true, truncated: true })
  assert.equal('content' in binaryBody, false)

  const directory = await file('host=sandbox&path=%2Fprotected', readRuntime)
  assert.equal(directory.status, 400)
  assert.match((await directory.json()).error, /是目录/)

  const brokenRuntime = {
    async download() { throw new Error('连接已断开') },
  }
  const broken = await file('host=sandbox&path=%2Fetc%2Fhosts', brokenRuntime)
  assert.equal(broken.status, 502)
  assert.match((await broken.json()).error, /连接已断开/)
})

await checkAsync('GET /host-save：缺头 403、跨源 403、未知参数 400、参数校验、config 来源 409', async () => {
  const url = `${testBase}/api/plugins/remote/host-save`
  const save = (query, headers = {}) => fetch(`${url}?${query}`, {
    headers: { 'x-dsh-remote-exec': '1', ...headers },
  })

  const noHeader = await fetch(`${url}?alias=app1&host=10.0.0.9`)
  assert.equal(noHeader.status, 403)
  assert.match((await noHeader.json()).error, /缺少 x-dsh-remote-exec 头/)

  const crossOrigin = await save('alias=app1&host=10.0.0.9', { origin: 'http://evil.example' })
  assert.equal(crossOrigin.status, 403)
  assert.match((await crossOrigin.json()).error, /只接受本地同源请求/)

  const unknownParam = await save('alias=app1&host=10.0.0.9&extra=1')
  assert.equal(unknownParam.status, 400)
  assert.match((await unknownParam.json()).error, /不支持的查询参数：extra/)

  const badAlias = await save('alias=bad%2Falias&host=10.0.0.9')
  assert.equal(badAlias.status, 400)
  assert.match((await badAlias.json()).error, /alias 只能包含/)

  const noAlias = await save('host=10.0.0.9')
  assert.equal(noAlias.status, 400)
  assert.match((await noAlias.json()).error, /alias 只能包含/)

  const noHost = await save('alias=app1')
  assert.equal(noHost.status, 400)
  assert.match((await noHost.json()).error, /host 必须是非空字符串/)

  for (const port of ['0', '70000', 'abc']) {
    const badPort = await save(`alias=app1&host=10.0.0.9&port=${port}`)
    assert.equal(badPort.status, 400, `port=${port}`)
    assert.match((await badPort.json()).error, /port 必须是 1-65535 的整数/)
  }

  const badAuth = await save('alias=app1&host=10.0.0.9&auth=token')
  assert.equal(badAuth.status, 400)
  assert.match((await badAuth.json()).error, /auth 必须是/)

  const keyWithoutPath = await save('alias=app1&host=10.0.0.9&auth=key')
  assert.equal(keyWithoutPath.status, 400)
  assert.match((await keyWithoutPath.json()).error, /privateKeyPath 不能为空/)

  const emptyEnvName = await save('alias=app1&host=10.0.0.9&auth=password-env')
  assert.equal(emptyEnvName.status, 400)
  assert.match((await emptyEnvName.json()).error, /secret（环境变量名）不能为空/)

  const badDisabled = await save('alias=app1&host=10.0.0.9&disabled=2')
  assert.equal(badDisabled.status, 400)
  assert.match((await badDisabled.json()).error, /disabled 只能是 1 或 0/)

  const longHost = await save(`alias=app1&host=${'a'.repeat(256)}`)
  assert.equal(longHost.status, 413)
  assert.match((await longHost.json()).error, /host 超过 255 字节/)

  const configSource = await save('alias=app1&host=10.0.0.9&auth=none')
  assert.equal(configSource.status, 409)
  assert.match((await configSource.json()).error, /主机来自 config\.hosts.*cordis\.patch\.yml/)
})

await checkAsync('GET /host-delete：缺头 403、跨源 403、未知参数 400、alias 校验、config 来源 409', async () => {
  const url = `${testBase}/api/plugins/remote/host-delete`
  const remove = (query, headers = {}) => fetch(`${url}?${query}`, {
    headers: { 'x-dsh-remote-exec': '1', ...headers },
  })

  const noHeader = await fetch(`${url}?alias=sandbox`)
  assert.equal(noHeader.status, 403)
  assert.match((await noHeader.json()).error, /缺少 x-dsh-remote-exec 头/)

  const crossOrigin = await remove('alias=sandbox', { origin: 'http://evil.example' })
  assert.equal(crossOrigin.status, 403)

  const unknownParam = await remove('alias=sandbox&extra=1')
  assert.equal(unknownParam.status, 400)
  assert.match((await unknownParam.json()).error, /不支持的查询参数：extra/)

  const noAlias = await remove('')
  assert.equal(noAlias.status, 400)
  assert.match((await noAlias.json()).error, /alias 只能包含/)

  const badAlias = await remove('alias=has%20space')
  assert.equal(badAlias.status, 400)
  assert.match((await badAlias.json()).error, /alias 只能包含/)

  const configSource = await remove('alias=sandbox')
  assert.equal(configSource.status, 409)
  assert.match((await configSource.json()).error, /主机来自 config\.hosts/)
})

await checkAsync('host-save / host-delete 写临时 hosts.json：原子写、保留其它别名与未知字段、删空 warning', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-remote-hosts-'))
  const file = join(directory, 'hosts.json')
  const oldPassword = 'old' + '-pw'
  writeFileSync(file, JSON.stringify({
    hosts: {
      alpha: { host: '10.0.0.1', user: 'root', password: oldPassword, custom: 'keep-me' },
    },
  }), { mode: 0o600 })

  const previousEnv = process.env.DSH_REMOTE_HOSTS
  delete process.env.DSH_REMOTE_HOSTS
  const runtime = indexModule.internals.createRuntime({ packageHostsPath: file })
  const call = (resource, query) => indexModule.internals.resources[resource](
    new Request(`http://127.0.0.1:1/api/plugins/remote/${resource}?${query}`, {
      headers: { 'x-dsh-remote-exec': '1' },
    }),
    runtime,
  )

  try {
    const created = await call('hostSaveResource', `alias=beta&host=10.0.0.2&port=2222&user=deploy&auth=password&secret=pw-beta&note=${encodeURIComponent('新机')}&env=prod&group=web&tags=edge,cdn`)
    assert.equal(created.status, 200)
    const createdBody = await created.json()
    assert.equal(createdBody.ok, true)
    assert.equal(createdBody.source, 'package')
    assert.equal(createdBody.path, file)
    assert.equal(createdBody.hosts.length, 2)
    assert.equal(JSON.stringify(createdBody).includes('pw-beta'), false, '响应不得回显密码')
    const beta = createdBody.hosts.find((item) => item.alias === 'beta')
    assert.deepEqual(
      { host: beta.host, port: beta.port, user: beta.user, auth: beta.auth, note: beta.note, env: beta.env, group: beta.group, tags: beta.tags },
      { host: '10.0.0.2', port: 2222, user: 'deploy', auth: 'password', note: '新机', env: 'prod', group: 'web', tags: ['edge', 'cdn'] },
    )

    let onDisk = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(onDisk.hosts.alpha.custom, 'keep-me', '其它别名的未知字段必须保留')
    assert.equal(onDisk.hosts.alpha.password, oldPassword)
    assert.deepEqual(
      { host: onDisk.hosts.beta.host, port: onDisk.hosts.beta.port, password: onDisk.hosts.beta.password, env: onDisk.hosts.beta.env, group: onDisk.hosts.beta.group, tags: onDisk.hosts.beta.tags },
      { host: '10.0.0.2', port: 2222, password: 'pw-beta', env: 'prod', group: 'web', tags: ['edge', 'cdn'] },
    )

    const invalidEnv = await call('hostSaveResource', 'alias=beta&host=10.0.0.2&auth=none&env=Prod')
    assert.equal(invalidEnv.status, 400)
    assert.match((await invalidEnv.json()).error, /主机 "beta" 的 env "Prod" 不合法：应为 1-32 位小写字母、数字或连字符/)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).hosts.beta.env, 'prod', '非法 env 不能写盘')

    const kept = await call('hostSaveResource', 'alias=beta&host=10.0.0.2&auth=none')
    assert.equal(kept.status, 200)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).hosts.beta.env, 'prod', 'env 缺省时必须保留旧值')

    const cleared = await call('hostSaveResource', 'alias=beta&host=10.0.0.2&auth=none&env=&group=&tags=')
    assert.equal(cleared.status, 200)
    const clearedDisk = JSON.parse(readFileSync(file, 'utf8')).hosts.beta
    assert.equal(clearedDisk.env, undefined, '空 env 表示清除')
    assert.equal(clearedDisk.group, undefined, '空 group 表示清除')
    assert.equal(clearedDisk.tags, undefined, '空 tags 表示清除')

    const edited = await call('hostSaveResource', `alias=alpha&host=10.0.0.1&auth=key&privateKeyPath=${encodeURIComponent('C:\\keys\\id_ed25519')}`)
    assert.equal(edited.status, 200)
    const editedBody = await edited.json()
    assert.equal(editedBody.hosts.find((item) => item.alias === 'alpha').auth, 'key')
    onDisk = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(onDisk.hosts.alpha.password, undefined, '切换 auth 时必须清掉旧密码')
    assert.equal(onDisk.hosts.alpha.privateKeyPath, 'C:\\keys\\id_ed25519')
    assert.equal(onDisk.hosts.alpha.custom, 'keep-me')

    const missing = await call('hostDeleteResource', 'alias=ghost')
    assert.equal(missing.status, 404)
    assert.match((await missing.json()).error, /主机 "ghost" 不存在/)

    const removedOne = await call('hostDeleteResource', 'alias=alpha')
    assert.equal(removedOne.status, 200)
    assert.equal((await removedOne.json()).hosts.length, 1)

    const removedLast = await call('hostDeleteResource', 'alias=beta')
    assert.equal(removedLast.status, 200)
    const lastBody = await removedLast.json()
    assert.deepEqual(lastBody.hosts, [])
    assert.equal(lastBody.warning, '现在没有任何主机了')
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { hosts: {} })
  } finally {
    if (previousEnv === undefined) delete process.env.DSH_REMOTE_HOSTS
    else process.env.DSH_REMOTE_HOSTS = previousEnv
    rmSync(directory, { recursive: true, force: true })
  }
})

await checkAsync('GET /shell-*：缺头 403、跨源 403、未知参数 400、参数校验、未知主机/会话 404', async () => {
  const base = `${testBase}/api/plugins/remote`
  const call = (name, query, headers = {}) => fetch(`${base}/${name}?${query}`, {
    headers: { 'x-dsh-remote-exec': '1', ...headers },
  })

  const openNoHeader = await fetch(`${base}/shell-open?host=sandbox`)
  assert.equal(openNoHeader.status, 403)
  assert.match((await openNoHeader.json()).error, /缺少 x-dsh-remote-exec 头/)

  const openCrossOrigin = await call('shell-open', 'host=sandbox', { origin: 'http://evil.example' })
  assert.equal(openCrossOrigin.status, 403)
  assert.match((await openCrossOrigin.json()).error, /只接受本地同源请求/)

  const openUnknownParam = await call('shell-open', 'host=sandbox&extra=1')
  assert.equal(openUnknownParam.status, 400)
  assert.match((await openUnknownParam.json()).error, /不支持的查询参数：extra/)

  const openNoHost = await call('shell-open', '')
  assert.equal(openNoHost.status, 400)
  assert.match((await openNoHost.json()).error, /host 不能为空/)

  for (const cols of ['9', '501', 'abc']) {
    const badCols = await call('shell-open', `host=sandbox&cols=${cols}`)
    assert.equal(badCols.status, 400, `cols=${cols}`)
    assert.match((await badCols.json()).error, /cols 必须是 20-500 的整数/)
  }

  const badRows = await call('shell-open', 'host=sandbox&rows=4')
  assert.equal(badRows.status, 400)
  assert.match((await badRows.json()).error, /rows 必须是 5-200 的整数/)

  const unknownHost = await call('shell-open', 'host=ghost')
  assert.equal(unknownHost.status, 404)
  assert.match((await unknownHost.json()).error, /^未知主机/)

  const sendNoSession = await call('shell-send', 'data=ZWNobyBoaQ%3D%3D')
  assert.equal(sendNoSession.status, 400)
  assert.match((await sendNoSession.json()).error, /sessionId 不能为空/)

  const sendBadBase64 = await call('shell-send', 'sessionId=sh-ghost&data=***')
  assert.equal(sendBadBase64.status, 400)
  assert.match((await sendBadBase64.json()).error, /data 必须是合法的 base64/)

  const readNoSession = await call('shell-read', '')
  assert.equal(readNoSession.status, 400)
  assert.match((await readNoSession.json()).error, /sessionId 不能为空/)

  const readGhost = await call('shell-read', 'sessionId=sh-ghost')
  assert.equal(readGhost.status, 404)
  assert.match((await readGhost.json()).error, /不存在/)

  const closeGhost = await call('shell-close', 'sessionId=sh-ghost')
  assert.equal(closeGhost.status, 404)
  assert.match((await closeGhost.json()).error, /不存在/)
})

await checkAsync('shell 面板路由：假 runtime 的 base64 往返、read 只回增量、关闭后 404', async () => {
  const base64Of = (text) => Buffer.from(text, 'utf8').toString('base64')
  const decode = (value) => Buffer.from(value, 'base64').toString('utf8')
  const notFound = () => Object.assign(new Error('会话 sh1 不存在（可能已关闭或超时）'), { code: 'SHELL_NOT_FOUND' })

  let opened = null
  let closed = false
  let seq = 0
  const written = []
  const queue = []
  const fakeRuntime = {
    async shellPanelOpen(host, sizes) {
      opened = { host, sizes }
      return { id: 'sh1', host, term: 'xterm-256color', cols: sizes.cols, rows: sizes.rows, createdAt: 1 }
    },
    async shellPanelSend(sessionId, input, sizes) {
      if (closed) throw notFound()
      assert.equal(sessionId, 'sh1')
      written.push(Buffer.from(input, 'utf8'))
      assert.deepEqual(sizes, { cols: 120, rows: 40 })
      seq += 1
      queue.push('OUT[' + input + ']')
      return { seq, output: base64Of(queue.splice(0).join('')), exited: false, truncated: false }
    },
    shellPanelRead(sessionId) {
      if (closed) throw notFound()
      assert.equal(sessionId, 'sh1')
      return { seq, output: base64Of(queue.splice(0).join('')), exited: false, truncated: false }
    },
    shellPanelClose(sessionId) {
      if (closed) throw notFound()
      assert.equal(sessionId, 'sh1')
      closed = true
      return { closed: true }
    },
  }

  const call = (name, query) => indexModule.internals.resources[{
    'shell-open': 'shellOpenResource',
    'shell-send': 'shellSendResource',
    'shell-read': 'shellReadResource',
    'shell-close': 'shellCloseResource',
  }[name]](new Request(`http://127.0.0.1:1/api/plugins/remote/${name}?${query}`, {
    headers: { 'x-dsh-remote-exec': '1' },
  }), fakeRuntime)

  const openedResponse = await call('shell-open', 'host=sandbox&cols=120&rows=40')
  assert.equal(openedResponse.status, 200)
  const openedBody = await openedResponse.json()
  assert.equal(openedBody.ok, true)
  assert.equal(openedBody.session.id, 'sh1')
  assert.deepEqual(opened, { host: 'sandbox', sizes: { cols: 120, rows: 40 } })

  const input = 'echo hi\n'
  const sent = await call('shell-send', `sessionId=sh1&data=${encodeURIComponent(base64Of(input))}&cols=120&rows=40`)
  assert.equal(sent.status, 200)
  const sentBody = await sent.json()
  assert.equal(sentBody.ok, true)
  assert.equal(sentBody.seq, 1)
  assert.equal(written.length, 1)
  assert.equal(written[0].toString('utf8'), input, '假 runtime 必须收到原始字节')
  assert.equal(decode(sentBody.output), 'OUT[echo hi\n]')

  const firstRead = await call('shell-read', 'sessionId=sh1')
  const firstBody = await firstRead.json()
  assert.equal(firstBody.seq, 1)
  assert.equal(decode(firstBody.output), '')

  const secondRead = await call('shell-read', 'sessionId=sh1')
  const secondBody = await secondRead.json()
  assert.equal(secondBody.seq, 1, '没有新输出时 seq 不应变化')
  assert.equal(decode(secondBody.output), '', 'read 只回增量')

  const closedResponse = await call('shell-close', 'sessionId=sh1')
  assert.equal(closedResponse.status, 200)
  assert.deepEqual(await closedResponse.json(), { ok: true, closed: true })

  const readAfterClose = await call('shell-read', 'sessionId=sh1')
  assert.equal(readAfterClose.status, 404)
  assert.match((await readAfterClose.json()).error, /不存在/)

  const closeAgain = await call('shell-close', 'sessionId=sh1')
  assert.equal(closeAgain.status, 404)

  const sendAfterClose = await call('shell-send', `sessionId=sh1&data=${encodeURIComponent(base64Of('x'))}`)
  assert.equal(sendAfterClose.status, 404)
})

await checkAsync('GET /shell-resize：缺头 403、跨源 403、未知参数 400、缺参/越界 400、未知会话 404、成功调到 runtime', async () => {
  const url = `${testBase}/api/plugins/remote/shell-resize`
  const resize = (query, headers = {}) => fetch(`${url}?${query}`, {
    headers: { 'x-dsh-remote-exec': '1', ...headers },
  })

  const noHeader = await fetch(`${url}?sessionId=sh1&cols=100&rows=30`)
  assert.equal(noHeader.status, 403)
  assert.match((await noHeader.json()).error, /缺少 x-dsh-remote-exec 头/)

  const crossOrigin = await resize('sessionId=sh1&cols=100&rows=30', { origin: 'http://evil.example' })
  assert.equal(crossOrigin.status, 403)

  const unknownParam = await resize('sessionId=sh1&cols=100&rows=30&extra=1')
  assert.equal(unknownParam.status, 400)
  assert.match((await unknownParam.json()).error, /不支持的查询参数：extra/)

  const noSession = await resize('cols=100&rows=30')
  assert.equal(noSession.status, 400)
  assert.match((await noSession.json()).error, /sessionId 不能为空/)

  for (const cols of ['9', '501', 'abc', '']) {
    const badCols = await resize(`sessionId=sh1&cols=${cols}&rows=30`)
    assert.equal(badCols.status, 400, `cols=${cols}`)
    assert.match((await badCols.json()).error, /cols 必须是 20-500 的整数/)
  }

  for (const rows of ['4', '201', 'xyz', '']) {
    const badRows = await resize(`sessionId=sh1&cols=100&rows=${rows}`)
    assert.equal(badRows.status, 400, `rows=${rows}`)
    assert.match((await badRows.json()).error, /rows 必须是 5-200 的整数/)
  }

  const missing = await resize('sessionId=sh-ghost&cols=100&rows=30')
  assert.equal(missing.status, 404)
  assert.match((await missing.json()).error, /不存在/)

  const calls = []
  const fakeRuntime = {
    shellPanelResizeSession(sessionId, cols, rows) {
      calls.push({ sessionId, cols, rows })
      return { cols, rows }
    },
  }
  const response = await indexModule.internals.resources.shellResizeResource(
    new Request('http://127.0.0.1:1/api/plugins/remote/shell-resize?sessionId=sh1&cols=120&rows=40', {
      headers: { 'x-dsh-remote-exec': '1' },
    }),
    fakeRuntime,
  )
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, cols: 120, rows: 40 })
  assert.deepEqual(calls, [{ sessionId: 'sh1', cols: 120, rows: 40 }])
})

await checkAsync('shell-send bracketed=1：包裹、剔除越界序列、bracketed 校验', async () => {
  const base64Of = (text) => Buffer.from(text, 'utf8').toString('base64')
  assert.equal(indexModule.internals.wrapBracketedPaste('hello'), '\x1b[200~hello\x1b[201~')
  assert.equal(
    indexModule.internals.wrapBracketedPaste(`a${'\x1b[201~'}b`),
    `\x1b[200~ab${'\x1b[201~'}`,
    '正文里的 \\x1b[201~ 必须先剔除',
  )

  const written = []
  const fakeRuntime = {
    async shellPanelSend(sessionId, input) {
      written.push(input)
      return { seq: written.length, output: '', exited: false, truncated: false }
    },
  }
  const send = (query) => indexModule.internals.resources.shellSendResource(
    new Request(`http://127.0.0.1:1/api/plugins/remote/shell-send?${query}`, {
      headers: { 'x-dsh-remote-exec': '1' },
    }),
    fakeRuntime,
  )

  const bracketed = await send(`sessionId=sh1&data=${encodeURIComponent(base64Of('echo hi\n'))}&bracketed=1`)
  assert.equal(bracketed.status, 200)
  assert.equal(written[0], `\x1b[200~echo hi\n\x1b[201~`)

  const plain = await send(`sessionId=sh1&data=${encodeURIComponent(base64Of('ls'))}&bracketed=0`)
  assert.equal(plain.status, 200)
  assert.equal(written[1], 'ls')

  const invalid = await send(`sessionId=sh1&data=${encodeURIComponent(base64Of('ls'))}&bracketed=yes`)
  assert.equal(invalid.status, 400)
  assert.match((await invalid.json()).error, /bracketed 只能是 1 或 0/)
})

await checkAsync('GET /shell-attach：缺头/跨源/未知参数/缺参/坏尺寸 400、未知 404、成功返回 backlog', async () => {
  const url = `${testBase}/api/plugins/remote/shell-attach`
  const attach = (query, headers = {}) => fetch(`${url}?${query}`, {
    headers: { 'x-dsh-remote-exec': '1', ...headers },
  })

  const noHeader = await fetch(`${url}?sessionId=sh1&cols=100&rows=30`)
  assert.equal(noHeader.status, 403)
  assert.match((await noHeader.json()).error, /缺少 x-dsh-remote-exec 头/)

  const crossOrigin = await attach('sessionId=sh1&cols=100&rows=30', { origin: 'http://evil.example' })
  assert.equal(crossOrigin.status, 403)

  const unknownParam = await attach('sessionId=sh1&cols=100&rows=30&extra=1')
  assert.equal(unknownParam.status, 400)
  assert.match((await unknownParam.json()).error, /不支持的查询参数：extra/)

  const noSession = await attach('cols=100&rows=30')
  assert.equal(noSession.status, 400)
  assert.match((await noSession.json()).error, /sessionId 不能为空/)

  for (const cols of ['9', '501', 'abc']) {
    const badCols = await attach(`sessionId=sh1&cols=${cols}&rows=30`)
    assert.equal(badCols.status, 400, `cols=${cols}`)
    assert.match((await badCols.json()).error, /cols 必须是 20-500 的整数/)
  }
  for (const rows of ['4', '201', 'xyz']) {
    const badRows = await attach(`sessionId=sh1&cols=100&rows=${rows}`)
    assert.equal(badRows.status, 400, `rows=${rows}`)
    assert.match((await badRows.json()).error, /rows 必须是 5-200 的整数/)
  }

  const missing = await attach('sessionId=sh-ghost&cols=100&rows=30')
  assert.equal(missing.status, 404)
  assert.match((await missing.json()).error, /不存在/)

  const calls = []
  const fakeRuntime = {
    shellPanelAttach(sessionId, sizes) {
      calls.push({ sessionId, sizes })
      return {
        session: {
          id: sessionId,
          host: 'sandbox',
          cols: 120,
          rows: 40,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastActiveAt: '2026-01-01T00:01:00.000Z',
          closed: false,
        },
        backlog: Buffer.from('hello\r\n', 'utf8').toString('base64'),
        backlogBytes: 7,
        truncated: false,
      }
    },
  }
  const response = await indexModule.internals.resources.shellAttachResource(
    new Request('http://127.0.0.1:1/api/plugins/remote/shell-attach?sessionId=sh1&cols=120&rows=40', {
      headers: { 'x-dsh-remote-exec': '1' },
    }),
    fakeRuntime,
  )
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.session.id, 'sh1')
  assert.equal(body.session.host, 'sandbox')
  assert.equal(body.backlog, Buffer.from('hello\r\n', 'utf8').toString('base64'))
  assert.equal(body.backlogBytes, 7)
  assert.equal(body.truncated, false)
  assert.deepEqual(calls, [{ sessionId: 'sh1', sizes: { cols: 120, rows: 40 } }])
})

await checkAsync('GET /shell-log：缺头/跨源/未知参数/缺参 400、maxBytes 越界 400、未知 404、截断形状', async () => {
  const url = `${testBase}/api/plugins/remote/shell-log`
  const log = (query, headers = {}) => fetch(`${url}?${query}`, {
    headers: { 'x-dsh-remote-exec': '1', ...headers },
  })

  const noHeader = await fetch(`${url}?sessionId=sh1`)
  assert.equal(noHeader.status, 403)
  assert.match((await noHeader.json()).error, /缺少 x-dsh-remote-exec 头/)

  const crossOrigin = await log('sessionId=sh1', { origin: 'http://evil.example' })
  assert.equal(crossOrigin.status, 403)

  const unknownParam = await log('sessionId=sh1&extra=1')
  assert.equal(unknownParam.status, 400)
  assert.match((await unknownParam.json()).error, /不支持的查询参数：extra/)

  const noSession = await log('maxBytes=10')
  assert.equal(noSession.status, 400)
  assert.match((await noSession.json()).error, /sessionId 不能为空/)

  for (const maxBytes of ['0', '8388609', 'abc', '1.5', '-1']) {
    const bad = await log(`sessionId=sh1&maxBytes=${maxBytes}`)
    assert.equal(bad.status, 400, `maxBytes=${maxBytes}`)
    assert.match((await bad.json()).error, /maxBytes 必须是 1-8388608 的整数/)
  }

  const missing = await log('sessionId=sh-ghost')
  assert.equal(missing.status, 404)
  assert.match((await missing.json()).error, /不存在/)

  const calls = []
  const fakeRuntime = {
    shellPanelLog(sessionId, maxBytes) {
      calls.push({ sessionId, maxBytes })
      return {
        sessionId,
        bytes: 3,
        total: 10,
        truncated: true,
        output: Buffer.from('abc', 'utf8').toString('base64'),
      }
    },
  }
  const request = (query) => indexModule.internals.resources.shellLogResource(
    new Request(`http://127.0.0.1:1/api/plugins/remote/shell-log?${query}`, {
      headers: { 'x-dsh-remote-exec': '1' },
    }),
    fakeRuntime,
  )

  const defaultResponse = await request('sessionId=sh1')
  assert.equal(defaultResponse.status, 200)
  const defaultBody = await defaultResponse.json()
  assert.equal(defaultBody.ok, true)
  assert.equal(defaultBody.sessionId, 'sh1')
  assert.equal(defaultBody.bytes, 3)
  assert.equal(defaultBody.total, 10)
  assert.equal(defaultBody.truncated, true)
  assert.equal(defaultBody.output, Buffer.from('abc', 'utf8').toString('base64'))

  const cappedResponse = await request('sessionId=sh1&maxBytes=1024')
  assert.equal(cappedResponse.status, 200)
  assert.deepEqual(calls, [
    { sessionId: 'sh1', maxBytes: 4 * 1024 * 1024 },
    { sessionId: 'sh1', maxBytes: 1024 },
  ])
})

await checkAsync('client 纯函数：computeTerminalGrid 限幅、本地历史环去重/20 条/↑↓边界', async () => {
  let definition = null
  const previousWindow = globalThis.window
  globalThis.window = { __ModuleLoader__: { load(value) { definition = value } } }
  try {
    await import(new URL('../client.js?smoke-grid=1', import.meta.url).href)
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
  assert.ok(definition && typeof definition.factory === 'function', 'client.js 未通过 __ModuleLoader__ 暴露 factory')
  const React = {
    createElement() { return null },
    useCallback: (fn) => fn,
    useEffect() {},
    useRef: (value) => ({ current: value }),
    useState: (value) => [value, () => {}],
  }
  const clientModule = definition.factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require: ${id}`)
  })
  assert.ok(clientModule && clientModule.internals, 'client.js 未导出 internals')
  const compute = clientModule.internals.computeTerminalGrid
  assert.equal(typeof compute, 'function')

  assert.deepEqual(compute({ width: 0, height: 0 }), { cols: 20, rows: 5 })
  assert.deepEqual(compute({}), { cols: 20, rows: 5 })
  assert.deepEqual(compute({ width: 800, height: 400 }), { cols: 108, rows: 22 })
  assert.deepEqual(compute({ width: 100000, height: 100000 }), { cols: 500, rows: 200 })
  assert.deepEqual(compute({ width: 800, height: 400, charWidth: 8, lineHeight: 20 }), { cols: 97, rows: 19 })

  const pushHistory = clientModule.internals.pushCommandHistory
  const stepHistory = clientModule.internals.resolveHistoryStep
  assert.equal(typeof pushHistory, 'function')
  assert.equal(typeof stepHistory, 'function')

  let history = []
  history = pushHistory(history, ' ls ')
  history = pushHistory(history, 'pwd')
  history = pushHistory(history, 'ls')
  assert.deepEqual(history, ['ls', 'pwd'], '去重时把重复命令移到最前')
  assert.deepEqual(pushHistory(history, '   '), history, '空白行不记录')
  for (let index = 0; index < 25; index += 1) history = pushHistory(history, 'c' + index)
  assert.equal(history.length, 20, '最多保留 20 条')
  assert.equal(history[0], 'c24', '最近在前')
  assert.equal(history[19], 'c5', '最旧的被挤出')

  assert.deepEqual(stepHistory(['a', 'b'], -1, 'up'), { index: 0, text: 'a' })
  assert.deepEqual(stepHistory(['a', 'b'], 0, 'up'), { index: 1, text: 'b' })
  assert.deepEqual(stepHistory(['a', 'b'], 1, 'up'), { index: 1, text: 'b' }, '到最旧不再循环')
  assert.deepEqual(stepHistory(['a', 'b'], 1, 'down'), { index: 0, text: 'a' })
  assert.deepEqual(stepHistory(['a', 'b'], 0, 'down'), { index: -1, text: '' })
  assert.deepEqual(stepHistory([], 0, 'up'), { index: -1, text: '' })

  const stamp = clientModule.internals.formatLogStamp
  assert.equal(typeof stamp, 'function')
  const fixed = stamp(new Date(2026, 0, 2, 3, 4, 5))
  assert.equal(fixed, '20260102-030405', '下载日志文件名的时间戳用本地时间 YYYYMMDD-HHmmss')
})

await checkAsync('GET /file-download：缺头/跨源/未知参数/缺参/maxBytes 400、目录 400、缺失 404、成功形状', async () => {
  const url = `${testBase}/api/plugins/remote/file-download`
  const call = (query, headers = {}) => fetch(`${url}?${query}`, {
    headers: { 'x-dsh-remote-exec': '1', ...headers },
  })

  const noHeader = await fetch(`${url}?host=sandbox&path=/tmp/a.bin`)
  assert.equal(noHeader.status, 403)
  assert.match((await noHeader.json()).error, /缺少 x-dsh-remote-exec 头/)

  const crossOrigin = await call('host=sandbox&path=/tmp/a.bin', { origin: 'http://evil.example' })
  assert.equal(crossOrigin.status, 403)

  const unknownParam = await call('host=sandbox&path=/tmp/a.bin&extra=1')
  assert.equal(unknownParam.status, 400)
  assert.match((await unknownParam.json()).error, /不支持的查询参数：extra/)

  const missingPath = await call('host=sandbox')
  assert.equal(missingPath.status, 400)
  assert.match((await missingPath.json()).error, /path 必须是非空字符串/)

  for (const maxBytes of ['0', '16777217', 'abc', '1.5']) {
    const bad = await call(`host=sandbox&path=/tmp/a.bin&maxBytes=${maxBytes}`)
    assert.equal(bad.status, 400, `maxBytes=${maxBytes}`)
    assert.match((await bad.json()).error, /maxBytes 必须是 1-16777216 的整数/)
  }

  const request = (query, runtime) => indexModule.internals.resources.fileDownloadResource(
    new Request(`http://127.0.0.1:1/api/plugins/remote/file-download?${query}`, {
      headers: { 'x-dsh-remote-exec': '1' },
    }),
    runtime,
  )

  const calls = []
  const fakeRuntime = {
    downloadFile(host, path, maxBytes) {
      calls.push({ host, path, maxBytes })
      return {
        buffer: Buffer.from([0, 1, 2]),
        size: 10,
        bytes: 3,
        truncated: true,
        entry: { path, size: 10, mode: 0o100644, mtime: '2026-01-01T00:00:00.000Z' },
      }
    },
  }
  const response = await request('host=sandbox&path=/tmp/a.bin', fakeRuntime)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.host, 'sandbox')
  assert.equal(body.path, '/tmp/a.bin')
  assert.equal(body.name, 'a.bin')
  assert.equal(body.size, 10)
  assert.equal(body.bytes, 3)
  assert.equal(body.truncated, true)
  assert.equal(body.content, Buffer.from([0, 1, 2]).toString('base64'))
  assert.equal(body.entry.mode, 0o100644)

  const capped = await request('host=sandbox&path=/tmp/a.bin&maxBytes=1024', fakeRuntime)
  assert.equal(capped.status, 200)
  assert.deepEqual(calls.map((item) => item.maxBytes), [8 * 1024 * 1024, 1024])

  const directory = await request('host=sandbox&path=/tmp/dir', {
    downloadFile() { throw new Error('/tmp/dir 是目录：请用 remote_ls 列目录') },
  })
  assert.equal(directory.status, 400)
  assert.equal((await directory.json()).error, '是一个目录，不能下载')

  const missing = await request('host=sandbox&path=/tmp/none', {
    downloadFile() { throw new Error('stat /tmp/none 失败：No such file') },
  })
  assert.equal(missing.status, 404)
  assert.match((await missing.json()).error, /文件不存在：\/tmp\/none/)

  const unknownHost = await request('host=ghost&path=/tmp/a', {
    downloadFile() { throw new Error('未知主机 "ghost"：可用别名 sandbox') },
  })
  assert.equal(unknownHost.status, 404)
})

await checkAsync('GET /file-upload-begin：缺头/跨源/未知参数/缺参/坏 size/mode 400、并发 409、成功', async () => {
  const url = `${testBase}/api/plugins/remote/file-upload-begin`
  const call = (query, headers = {}) => fetch(`${url}?${query}`, {
    headers: { 'x-dsh-remote-exec': '1', ...headers },
  })

  const noHeader = await fetch(`${url}?host=sandbox&path=/tmp/a&size=1`)
  assert.equal(noHeader.status, 403)

  const crossOrigin = await call('host=sandbox&path=/tmp/a&size=1', { origin: 'http://evil.example' })
  assert.equal(crossOrigin.status, 403)

  const unknownParam = await call('host=sandbox&path=/tmp/a&size=1&extra=1')
  assert.equal(unknownParam.status, 400)
  assert.match((await unknownParam.json()).error, /不支持的查询参数：extra/)

  const missingPath = await call('host=sandbox&size=1')
  assert.equal(missingPath.status, 400)
  assert.match((await missingPath.json()).error, /path 必须是非空字符串/)

  for (const size of ['-1', '67108865', 'abc', '1.5']) {
    const bad = await call(`host=sandbox&path=/tmp/a&size=${size}`)
    assert.equal(bad.status, 400, `size=${size}`)
    assert.match((await bad.json()).error, /size 必须是 0-67108864 的整数/)
  }

  const badMode = await call('host=sandbox&path=/tmp/a&size=1&mode=truncate')
  assert.equal(badMode.status, 400)
  assert.match((await badMode.json()).error, /mode 必须是 overwrite、append 或 create/)

  const request = (query, runtime) => indexModule.internals.resources.fileUploadBeginResource(
    new Request(`http://127.0.0.1:1/api/plugins/remote/file-upload-begin?${query}`, {
      headers: { 'x-dsh-remote-exec': '1' },
    }),
    runtime,
  )

  const calls = []
  const fakeRuntime = {
    uploadBegin(host, input) {
      calls.push({ host, ...input })
      return { uploadId: 'up1', chunkBytes: UPLOAD_CHUNK_BYTES }
    },
  }
  const response = await request('host=sandbox&path=/tmp/a&size=5&mode=append', fakeRuntime)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.uploadId, 'up1')
  assert.equal(body.chunkBytes, 8192)
  assert.deepEqual(calls, [{ host: 'sandbox', path: '/tmp/a', size: 5, mode: 'append' }])

  const limited = await request('host=sandbox&path=/tmp/a&size=5', {
    uploadBegin() {
      const error = new Error('上传会话已达上限（4），请先完成或中止一个')
      error.code = 'UPLOAD_LIMIT'
      throw error
    },
  })
  assert.equal(limited.status, 409)
  assert.match((await limited.json()).error, /上传会话已达上限/)
})

await checkAsync('GET /file-upload-chunk：缺头/跨源/未知参数/缺参/坏 base64/超 8192 413、offset 409、404、成功', async () => {
  const url = `${testBase}/api/plugins/remote/file-upload-chunk`
  const call = (query, headers = {}) => fetch(`${url}?${query}`, {
    headers: { 'x-dsh-remote-exec': '1', ...headers },
  })

  const noHeader = await fetch(`${url}?uploadId=up1&offset=0&data=aGVsbG8=`)
  assert.equal(noHeader.status, 403)

  const crossOrigin = await call('uploadId=up1&offset=0&data=aGVsbG8=', { origin: 'http://evil.example' })
  assert.equal(crossOrigin.status, 403)

  const unknownParam = await call('uploadId=up1&offset=0&data=aGVsbG8=&extra=1')
  assert.equal(unknownParam.status, 400)

  const noId = await call('offset=0&data=aGVsbG8=')
  assert.equal(noId.status, 400)
  assert.match((await noId.json()).error, /uploadId 不能为空/)

  const noOffset = await call('uploadId=up1&data=aGVsbG8=')
  assert.equal(noOffset.status, 400)
  assert.match((await noOffset.json()).error, /offset 必须是非负整数/)

  const noData = await call('uploadId=up1&offset=0')
  assert.equal(noData.status, 400)
  assert.match((await noData.json()).error, /data 必须是 base64/)

  const badBase64 = await call('uploadId=up1&offset=0&data=***')
  assert.equal(badBase64.status, 400)
  assert.match((await badBase64.json()).error, /data 必须是合法的 base64/)

  const oversized = Buffer.alloc(UPLOAD_CHUNK_BYTES + 1, 0x61).toString('base64')
  const tooMuch = await call(new URLSearchParams({ uploadId: 'up1', offset: '0', data: oversized }).toString())
  assert.equal(tooMuch.status, 413)
  assert.match((await tooMuch.json()).error, /单块数据超过 8192 字节上限/)

  const request = (query, runtime) => indexModule.internals.resources.fileUploadChunkResource(
    new Request(`http://127.0.0.1:1/api/plugins/remote/file-upload-chunk?${query}`, {
      headers: { 'x-dsh-remote-exec': '1' },
    }),
    runtime,
  )

  const calls = []
  const fakeRuntime = {
    uploadChunk(uploadId, offset, buffer) {
      calls.push({ uploadId, offset, text: buffer.toString('utf8') })
      return { uploadId, received: offset + buffer.length, total: 10 }
    },
  }
  const successQuery = new URLSearchParams({ uploadId: 'up1', offset: '0', data: Buffer.from('hello').toString('base64') }).toString()
  const response = await request(successQuery, fakeRuntime)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, uploadId: 'up1', received: 5, total: 10 })
  assert.deepEqual(calls, [{ uploadId: 'up1', offset: 0, text: 'hello' }])

  const offsetError = await request('uploadId=up1&offset=5&data=aGVsbG8=', {
    uploadChunk() {
      const error = new Error('偏移不连续，期望 0')
      error.code = 'UPLOAD_OFFSET'
      throw error
    },
  })
  assert.equal(offsetError.status, 409)
  assert.match((await offsetError.json()).error, /偏移不连续，期望 0/)

  const missing = await request('uploadId=up9&offset=0&data=aGVsbG8=', {
    uploadChunk() {
      const error = new Error('上传会话 up9 不存在（可能已关闭或超时）')
      error.code = 'UPLOAD_NOT_FOUND'
      throw error
    },
  })
  assert.equal(missing.status, 404)
  assert.match((await missing.json()).error, /不存在/)
})

await checkAsync('GET /file-upload-finish + abort：缺头/跨源/未知参数/缺参/坏 sha256 400、成功、404', async () => {
  const base = `${testBase}/api/plugins/remote`
  const finishUrl = `${base}/file-upload-finish`
  const abortUrl = `${base}/file-upload-abort`
  const call = (url, query, headers = {}) => fetch(`${url}?${query}`, {
    headers: { 'x-dsh-remote-exec': '1', ...headers },
  })

  const finishNoHeader = await fetch(`${finishUrl}?uploadId=up1`)
  assert.equal(finishNoHeader.status, 403)

  const finishCross = await call(finishUrl, 'uploadId=up1', { origin: 'http://evil.example' })
  assert.equal(finishCross.status, 403)

  const finishUnknown = await call(finishUrl, 'uploadId=up1&extra=1')
  assert.equal(finishUnknown.status, 400)

  const finishNoId = await call(finishUrl, '')
  assert.equal(finishNoId.status, 400)
  assert.match((await finishNoId.json()).error, /uploadId 不能为空/)

  const badSha = await call(finishUrl, 'uploadId=up1&sha256=zz')
  assert.equal(badSha.status, 400)
  assert.match((await badSha.json()).error, /sha256 必须是 64 位十六进制字符串/)

  const abortNoHeader = await fetch(`${abortUrl}?uploadId=up1`)
  assert.equal(abortNoHeader.status, 403)

  const abortUnknown = await call(abortUrl, 'uploadId=up1&extra=1')
  assert.equal(abortUnknown.status, 400)

  const abortNoId = await call(abortUrl, '')
  assert.equal(abortNoId.status, 400)

  const request = (resource, query, runtime) => indexModule.internals.resources[resource](
    new Request(`http://127.0.0.1:1/api/plugins/remote/${resource === 'fileUploadFinishResource' ? 'file-upload-finish' : 'file-upload-abort'}?${query}`, {
      headers: { 'x-dsh-remote-exec': '1' },
    }),
    runtime,
  )

  const finishCalls = []
  const finish = await request('fileUploadFinishResource', 'uploadId=up1', {
    uploadFinish(uploadId, sha256) {
      finishCalls.push({ uploadId, sha256 })
      return { host: 'sandbox', path: '/tmp/a', bytes: 5 }
    },
  })
  assert.equal(finish.status, 200)
  assert.deepEqual(await finish.json(), { ok: true, host: 'sandbox', path: '/tmp/a', bytes: 5 })
  assert.deepEqual(finishCalls, [{ uploadId: 'up1', sha256: null }])

  const finishMissing = await request('fileUploadFinishResource', 'uploadId=up9', {
    uploadFinish() {
      const error = new Error('上传会话 up9 不存在（可能已关闭或超时）')
      error.code = 'UPLOAD_NOT_FOUND'
      throw error
    },
  })
  assert.equal(finishMissing.status, 404)

  const aborted = await request('fileUploadAbortResource', 'uploadId=up1', {
    uploadAbort(uploadId) {
      assert.equal(uploadId, 'up1')
      return { aborted: true }
    },
  })
  assert.equal(aborted.status, 200)
  assert.deepEqual(await aborted.json(), { ok: true, aborted: true })

  const abortMissing = await request('fileUploadAbortResource', 'uploadId=up9', {
    uploadAbort() {
      const error = new Error('上传会话 up9 不存在（可能已关闭或超时）')
      error.code = 'UPLOAD_NOT_FOUND'
      throw error
    },
  })
  assert.equal(abortMissing.status, 404)
})

await checkAsync('UploadRegistry：分块落盘、offset 409、part rename、abort 清理、并发上限', async () => {
  const written = []
  const renamed = []
  const unlinked = []
  let active = null
  const fakeSftp = () => ({
    createWriteStream(target) {
      active = target
      return new Writable({
        write(chunk, _encoding, callback) {
          written.push(chunk.toString('utf8'))
          callback()
        },
      })
    },
    rename(from, to, callback) {
      renamed.push({ from, to })
      callback(null)
    },
    unlink(path, callback) {
      unlinked.push(path)
      callback(null)
    },
    end() {},
  })

  const registry = new UploadRegistry({
    openSftp: async () => fakeSftp(),
    maxSessions: 1,
    timers: false,
  })

  const begun = await registry.begin({ client: {}, host: 'sandbox', path: '/tmp/a.bin', size: 5 })
  assert.equal(begun.uploadId, 'up1')
  assert.equal(begun.chunkBytes, 8192)
  assert.equal(active, '/tmp/a.bin.part')

  const first = await registry.chunk('up1', 0, Buffer.from('hello'))
  assert.deepEqual(first, { uploadId: 'up1', received: 5, total: 5 })
  assert.throws(() => registry.chunk('up1', 5, Buffer.from('x')), /数据超过声明的文件大小/)

  await assert.rejects(
    () => Promise.resolve().then(() => registry.chunk('up1', 0, Buffer.from('hello'))),
    (error) => error.code === 'UPLOAD_OFFSET' && /偏移不连续，期望 5/.test(error.message),
  )

  const finished = await registry.finish('up1')
  assert.deepEqual(finished, { host: 'sandbox', path: '/tmp/a.bin', bytes: 5 })
  assert.deepEqual(renamed, [{ from: '/tmp/a.bin.part', to: '/tmp/a.bin' }])
  assert.deepEqual(written, ['hello'])
  assert.equal(registry.size, 0)

  const second = await registry.begin({ client: {}, host: 'sandbox', path: '/tmp/b.bin', size: 10 })
  const limited = await registry.begin({ client: {}, host: 'sandbox', path: '/tmp/c.bin', size: 1 }).catch((error) => error)
  assert.equal(limited.code, 'UPLOAD_LIMIT')
  assert.equal(limited.status, 409)

  await registry.chunk(second.uploadId, 0, Buffer.from('abc'))
  const aborted = await registry.abort(second.uploadId)
  assert.deepEqual(aborted, { aborted: true })
  assert.deepEqual(unlinked, ['/tmp/b.bin.part'])
  assert.equal(registry.size, 0)
  assert.throws(() => registry.chunk(second.uploadId, 0, Buffer.from('a')), /不存在/)

  // 回归：ssh2 的 WriteStream._final 会先 destroy()，`end(cb)` 的 cb 可能永不触发；只能等 close/finish。
  const closeOnly = new UploadRegistry({
    openSftp: async () => ({
      createWriteStream() {
        const stream = new Writable({ write(_chunk, _encoding, callback) { callback() } })
        stream.end = function end() { setImmediate(() => this.emit('close')) }
        return stream
      },
      rename(_from, _to, callback) { callback(null) },
      unlink(_path, callback) { callback(null) },
      end() {},
    }),
    timers: false,
  })
  const closeBegun = await closeOnly.begin({ client: {}, host: 'sandbox', path: '/tmp/c.bin', size: 1 })
  await closeOnly.chunk(closeBegun.uploadId, 0, Buffer.from('z'))
  const closeFinished = await Promise.race([
    closeOnly.finish(closeBegun.uploadId),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('finish 等不到 end 回调')), 1000)),
  ])
  assert.equal(closeFinished.bytes, 1)
})

await checkAsync('UploadRegistry：写入挂死超时、流失败快速失败、父目录预检、end 挂死超时', async () => {
  // 1) write 回调永远不来（win22 实测形态）→ writeTimeoutMs 兜底成 UPLOAD_WRITE 502
  const stuck = new UploadRegistry({
    openSftp: async () => ({
      createWriteStream() {
        return new Writable({
          write(_chunk, _encoding, callback) { /* 永不回调：模拟 Windows OpenSSH 挂死 */ },
        })
      },
      rename(_from, _to, callback) { callback(null) },
      unlink(_path, callback) { callback(null) },
      end() {},
    }),
    timers: false,
    writeTimeoutMs: 20,
  })
  const stuckBegun = await stuck.begin({ client: {}, host: 'sandbox', path: '/tmp/stuck.bin', size: 4 })
  await assert.rejects(
    () => stuck.chunk(stuckBegun.uploadId, 0, Buffer.from('abcd')),
    (error) => error.code === 'UPLOAD_WRITE' && error.status === 502 && /没有收到写入确认/.test(error.message),
  )
  // 2) 流已死后再来 chunk：立即失败，不再各等一轮超时
  await assert.rejects(
    () => stuck.chunk(stuckBegun.uploadId, 0, Buffer.from('abcd')),
    (error) => error.code === 'UPLOAD_WRITE' && /上传流已失败/.test(error.message),
  )
  await stuck.abort(stuckBegun.uploadId).catch(() => {})

  // 3) 父目录不存在 → begin 直接 400，不再进入会挂死的写入流
  const noParent = new UploadRegistry({
    openSftp: async () => ({
      createWriteStream() { throw new Error('不应到达：父目录预检应先拒绝') },
      stat(path, callback) { callback(new Error(`No such file: ${path}`)) },
      end() {},
    }),
    timers: false,
  })
  const rejected = await noParent.begin({ client: {}, host: 'sandbox', path: '/missing/dir/a.bin', size: 1 }).catch((error) => error)
  assert.equal(rejected.code, 'UPLOAD_TARGET')
  assert.equal(rejected.status, 400)
  assert.match(rejected.message, /父目录不存在/)

  // 4) end() 后 close/finish 永不来 → finish 超时失败并清理会话
  const stuckEnd = new UploadRegistry({
    openSftp: async () => ({
      createWriteStream() {
        const stream = new Writable({ write(_chunk, _encoding, callback) { callback() } })
        stream.end = function end() { /* 什么都不发：模拟关闭挂死 */ }
        return stream
      },
      rename(_from, _to, callback) { callback(null) },
      unlink(_path, callback) { callback(null) },
      end() {},
    }),
    timers: false,
    writeTimeoutMs: 20,
  })
  const endBegun = await stuckEnd.begin({ client: {}, host: 'sandbox', path: '/tmp/end.bin', size: 1 })
  await stuckEnd.chunk(endBegun.uploadId, 0, Buffer.from('q'))
  await assert.rejects(
    () => stuckEnd.finish(endBegun.uploadId),
    (error) => error.code === 'UPLOAD_WRITE' && /没有等到 close\/finish/.test(error.message),
  )
  assert.equal(stuckEnd.size, 0)
})

await checkAsync('v2.0 新路由：鉴权、未知参数与参数边界', async () => {
  const url = (name, query = '') => `${testBase}/api/plugins/remote/${name}?${query}`
  const noHeader = async (name, query) => (await fetch(url(name, query))).status
  const withHeader = async (name, query) => fetch(url(name, query), { headers: { 'x-dsh-remote-exec': '1' } })

  assert.equal(await noHeader('file-write', 'host=sandbox&path=%2Ftmp%2Fa&data=aGk%3D'), 403)
  assert.equal(await noHeader('file-mkdir', 'host=sandbox&path=%2Ftmp%2Fd'), 403)
  assert.equal(await noHeader('file-rename', 'host=sandbox&from=%2Ftmp%2Fa&to=%2Ftmp%2Fb'), 403)
  assert.equal(await noHeader('file-delete', 'host=sandbox&path=%2Ftmp%2Fa'), 403)
  assert.equal(await noHeader('file-chmod', 'host=sandbox&path=%2Ftmp%2Fa&mode=0644'), 403)
  assert.equal(await noHeader('file-chown', 'host=sandbox&path=%2Ftmp%2Fa&uid=0&gid=0'), 403)
  assert.equal(await noHeader('file-search', 'host=sandbox&dir=%2Ftmp&q=a'), 403)
  assert.equal(await noHeader('gui-open', 'host=sandbox&protocol=vnc'), 403)

  const extra = await withHeader('file-mkdir', 'host=sandbox&path=%2Ftmp%2Fd&extra=1')
  assert.equal(extra.status, 400)
  assert.match((await extra.json()).error, /不支持的查询参数/)

  const badChmod = await withHeader('file-chmod', 'host=sandbox&path=%2Ftmp%2Fa&mode=9999')
  assert.equal(badChmod.status, 400)
  assert.match((await badChmod.json()).error, /八进制权限/)

  const badSearch = await withHeader('file-search', 'host=sandbox&dir=%2Ftmp')
  assert.equal(badSearch.status, 400)
  assert.match((await badSearch.json()).error, /q 必须是非空字符串/)

  const badLimit = await withHeader('file-search', 'host=sandbox&dir=%2Ftmp&q=a&limit=201')
  assert.equal(badLimit.status, 400)
  assert.match((await badLimit.json()).error, /limit 必须是 1-200 的整数/)

  const badProtocol = await withHeader('gui-open', 'host=sandbox&protocol=ssh')
  assert.equal(badProtocol.status, 400)
  assert.match((await badProtocol.json()).error, /protocol 必须是 rdp 或 vnc/)

  const badSaveProtocol = await withHeader('host-save', 'alias=x&host=192.0.2.9&protocol=mosh')
  assert.equal(badSaveProtocol.status, 400)
  assert.match((await badSaveProtocol.json()).error, /协议 "mosh" 不支持/)

  const badRecursive = await withHeader('file-delete', 'host=sandbox&path=%2Ftmp%2Fa&recursive=2')
  assert.equal(badRecursive.status, 400)
  assert.match((await badRecursive.json()).error, /recursive 只能是 0 或 1/)

  const saveCalls = []
  const saved = await indexModule.internals.resources.hostSaveResource(
    new Request('http://127.0.0.1:1/api/plugins/remote/host-save?alias=t1&host=192.0.2.9&protocol=telnet', {
      headers: { 'x-dsh-remote-exec': '1' },
    }),
    {
      saveHost(input) {
        saveCalls.push(input)
        return { source: 'package', path: '/tmp/hosts.json', hosts: [] }
      },
    },
  )
  assert.equal(saved.status, 200)
  assert.equal(saveCalls[0].protocol, 'telnet')
  assert.equal(saveCalls[0].port, 23)
  assert.equal(saveCalls[0].auth, 'none')
  assert.equal(saveCalls[0].secret, '')
})

await checkAsync('v2.0 文件写操作：假 runtime 参数与响应形状、目录/权限错误映射', async () => {
  const base = 'http://127.0.0.1:1/api/plugins/remote'
  const call = (name, query, runtime) => indexModule.internals.resources[name](
    new Request(`${base}/${name.replace(/Resource$/, '').replace(/([A-Z])/g, '-$1').toLowerCase()}?${query}`, {
      headers: { 'x-dsh-remote-exec': '1' },
    }),
    runtime,
  )
  const calls = []
  const runtime = {
    async writeFile(host, path, content, mode) { calls.push({ op: 'write', host, path, content, mode }); return { saved: true } },
    async makeDirectory(host, path) { calls.push({ op: 'mkdir', host, path }); return { created: true } },
    async renamePath(host, from, to) { calls.push({ op: 'rename', host, from, to }); return {} },
    async deletePath(host, path, options) { calls.push({ op: 'delete', host, path, options }); return { directory: true } },
    async chmodPath(host, path, mode) { calls.push({ op: 'chmod', host, path, mode }); return {} },
    async chownPath(host, path, uid, gid) { calls.push({ op: 'chown', host, path, uid, gid }); return {} },
    async searchFiles(host, dir, q, options) {
      calls.push({ op: 'search', host, dir, q, options })
      return { entries: [{ name: 'a.txt', type: 'file' }], total: 1, scanned: 3, truncated: false }
    },
  }

  const write = await call('fileWriteResource', 'host=sandbox&path=%2Ftmp%2Fa.txt&data=aGVsbG8%3D&mode=append', runtime)
  assert.equal(write.status, 200)
  assert.deepEqual(await write.json(), { ok: true, host: 'sandbox', path: '/tmp/a.txt', bytes: 5, mode: 'append', saved: true })

  const mkdir = await call('fileMkdirResource', 'host=sandbox&path=%2Ftmp%2Fd', runtime)
  assert.deepEqual(await mkdir.json(), { ok: true, host: 'sandbox', path: '/tmp/d', created: true })

  const rename = await call('fileRenameResource', 'host=sandbox&from=%2Ftmp%2Fa.txt&to=%2Ftmp%2Fb.txt', runtime)
  assert.deepEqual(await rename.json(), { ok: true, host: 'sandbox', from: '/tmp/a.txt', to: '/tmp/b.txt', renamed: true })

  const removed = await call('fileDeleteResource', 'host=sandbox&path=%2Ftmp%2Fd&recursive=1', runtime)
  assert.deepEqual(await removed.json(), { ok: true, host: 'sandbox', path: '/tmp/d', deleted: true, directory: true, recursive: true })

  const chmod = await call('fileChmodResource', 'host=sandbox&path=%2Ftmp%2Fa.txt&mode=0640', runtime)
  assert.deepEqual(await chmod.json(), { ok: true, host: 'sandbox', path: '/tmp/a.txt', mode: '0640' })

  const chown = await call('fileChownResource', 'host=sandbox&path=%2Ftmp%2Fa.txt&uid=1000&gid=1000', runtime)
  assert.deepEqual(await chown.json(), { ok: true, host: 'sandbox', path: '/tmp/a.txt', uid: 1000, gid: 1000 })

  const search = await call('fileSearchResource', 'host=sandbox&dir=%2Ftmp&q=a&limit=10', runtime)
  assert.equal(search.status, 200)
  assert.match(JSON.stringify(await search.json()), /"total":1/)

  assert.deepEqual(calls.map((entry) => entry.op), ['write', 'mkdir', 'rename', 'delete', 'chmod', 'chown', 'search'])
  assert.deepEqual(calls[0], { op: 'write', host: 'sandbox', path: '/tmp/a.txt', content: 'hello', mode: 'append' })
  assert.deepEqual(calls[6].options, { limit: 10 })

  const recursiveError = new Error('目录需要 recursive=1 才能删除')
  recursiveError.code = 'DIRECTORY_NEEDS_RECURSIVE'
  const noRecursive = await call('fileDeleteResource', 'host=sandbox&path=%2Ftmp%2Fd', {
    async deletePath() { throw recursiveError },
  })
  assert.equal(noRecursive.status, 409)

  const permission = new Error('Permission denied')
  permission.code = 'SFTP_CHMOD'
  const denied = await call('fileChmodResource', 'host=sandbox&path=%2Ftmp%2Fa.txt&mode=0640', {
    async chmodPath() { throw permission },
  })
  assert.equal(denied.status, 403)

  const unsupported = new Error('协议 Telnet 不支持 sftp')
  unsupported.code = 'PROTOCOL_UNSUPPORTED'
  const telnetFile = await call('fileWriteResource', 'host=sandbox&path=%2Ftmp%2Fa.txt&data=aGk%3D', {
    async writeFile() { throw unsupported },
  })
  assert.equal(telnetFile.status, 400)
})

await checkAsync('v2.2 desktop 五条路由：守卫、错误码、novnc 资产与 upgrade 契约', async () => {
  assert.equal(registeredUpgrades.length, 1)
  assert.equal(registeredUpgrades[0].path, '/api/plugins/remote/vnc-ws')
  assert.equal(typeof registeredUpgrades[0].handler, 'function')

  const base = 'http://127.0.0.1:1/api/plugins/remote'
  const res = indexModule.internals.resources

  const noHeader = await res.desktopStatusResource(new Request(`${base}/desktop-status?host=sandbox`), {})
  assert.equal(noHeader.status, 403)
  assert.equal((await noHeader.json()).error, '缺少 x-dsh-remote-exec 头')

  const crossOrigin = await res.desktopStatusResource(
    new Request(`${base}/desktop-status?host=sandbox`, { headers: { 'x-dsh-remote-exec': '1', origin: 'http://evil.example' } }),
    {},
  )
  assert.equal(crossOrigin.status, 403)

  // The carrier hands the plugin a Request built on a placeholder base ("http://x/..."); the
  // real browser host only survives in the Host header, so the guard must accept that shape.
  const carrierStyle = await res.desktopStatusResource(
    new Request('http://x/api/plugins/remote/desktop-status?host=sandbox', {
      headers: { 'x-dsh-remote-exec': '1', origin: 'http://127.0.0.1:55378', host: '127.0.0.1:55378' },
    }),
    { async desktopStatus() { return { host: 'sandbox', protocol: 'ssh' } } },
  )
  assert.equal(carrierStyle.status, 200)

  const unknown = await res.desktopStatusResource(
    new Request(`${base}/desktop-status?host=sandbox&zzz=1`, { headers: { 'x-dsh-remote-exec': '1' } }),
    {},
  )
  assert.equal(unknown.status, 400)
  assert.match((await unknown.json()).error, /不支持的查询参数/)

  const emptyHost = await res.desktopStartResource(
    new Request(`${base}/desktop-start?host=`, { headers: { 'x-dsh-remote-exec': '1' } }),
    {},
  )
  assert.equal(emptyHost.status, 400)

  const badGeometry = await res.desktopStartResource(
    new Request(`${base}/desktop-start?host=sandbox&geometry=big`, { headers: { 'x-dsh-remote-exec': '1' } }),
    {},
  )
  assert.equal(badGeometry.status, 400)
  assert.match((await badGeometry.json()).error, /geometry/)

  const badPort = await res.desktopConnectResource(
    new Request(`${base}/desktop-connect?host=sandbox&port=99`, { headers: { 'x-dsh-remote-exec': '1' } }),
    {},
  )
  assert.equal(badPort.status, 400)
  assert.match((await badPort.json()).error, /port 必须是 5900-5999/)

  const missingServer = new Error('目标机没有 VNC 服务')
  missingServer.code = 'VNC_SERVER_MISSING'
  missingServer.install = vncServerInstallInfo('linux')
  const missing = await res.desktopStartResource(
    new Request(`${base}/desktop-start?host=sandbox`, { headers: { 'x-dsh-remote-exec': '1' } }),
    { async desktopStart() { throw missingServer } },
  )
  assert.equal(missing.status, 400)
  const missingBody = await missing.json()
  assert.equal(missingBody.code, 'VNC_SERVER_MISSING')
  assert.equal(missingBody.install.protocol, 'vnc-server')
  assert.ok(missingBody.install.commands.length >= 2)
  assert.ok(missingBody.install.commands.every((item) => typeof item.command === 'string' && item.command.length > 0))

  const notRunning = new Error('VNC 服务未运行')
  notRunning.code = 'VNC_NOT_RUNNING'
  const conflict = await res.desktopConnectResource(
    new Request(`${base}/desktop-connect?host=sandbox`, { headers: { 'x-dsh-remote-exec': '1' } }),
    { async desktopConnect() { throw notRunning } },
  )
  assert.equal(conflict.status, 409)

  const unsupported = new Error('协议 ssh 不支持桌面')
  unsupported.code = 'DESKTOP_UNSUPPORTED_PROTOCOL'
  const badProto = await res.desktopStatusResource(
    new Request(`${base}/desktop-status?host=sandbox`, { headers: { 'x-dsh-remote-exec': '1' } }),
    { async desktopStatus() { throw unsupported } },
  )
  assert.equal(badProto.status, 400)

  const stopped = await res.desktopStopResource(
    new Request(`${base}/desktop-stop?host=sandbox`, { headers: { 'x-dsh-remote-exec': '1' } }),
    { async desktopStop() { return { stopped: true, display: ':9' } } },
  )
  assert.deepEqual(await stopped.json(), { ok: true, stopped: true, display: ':9' })

  const connected = await res.desktopConnectResource(
    new Request(`${base}/desktop-connect?host=sandbox&port=5909`, { headers: { 'x-dsh-remote-exec': '1' } }),
    {
      async desktopConnect() {
        return { host: 'sandbox', session: { token: 'tid', wsPath: '/api/plugins/remote/vnc-ws', localPort: 5000, vncPort: 5909, expiresIn: 60 } }
      },
    },
  )
  const connectedBody = await connected.json()
  assert.equal(connectedBody.ok, true)
  assert.equal(connectedBody.session.wsPath, '/api/plugins/remote/vnc-ws')

  const asset = await res.novncAssetResource(new Request(`${base}/novnc.js`))
  assert.equal(asset.status, 200)
  assert.equal(asset.headers.get('content-type'), 'application/javascript; charset=utf-8')
  const assetBody = await asset.text()
  assert.ok(assetBody.length > 100000, 'novnc 资产过小')
  assert.ok(assetBody.includes('DSHNoVNC'), 'novnc 资产缺 DSHNoVNC 导出')

  const bridge = indexModule.internals
  assert.equal(typeof bridge.createTokenStore, 'function')
  assert.equal(typeof bridge.performHandshake, 'function')
  assert.equal(typeof bridge.WebSocketPeer, 'function')
  const store = bridge.createTokenStore({ ttlMs: 1000, now: () => 0 })
  const issued = store.issue({ host: 'sandbox' })
  assert.equal(store.take(issued.token).host, 'sandbox')
  assert.equal(store.take(issued.token), null, 'token 必须单次使用')
})

await checkAsync('v2.0 /protocols 与 /gui-open：无需头的矩阵、客户端缺失 400', async () => {
  const base = 'http://127.0.0.1:1/api/plugins/remote'
  const runtime = {
    protocols() {
      return {
        defaultProtocol: 'ssh',
        protocols: [
          { id: 'ssh', label: 'SSH', capabilities: { exec: true, sftp: true, tunnel: true, pty: true, gui: false }, defaultPort: 22 },
          { id: 'vnc', label: 'VNC', capabilities: { exec: false, sftp: false, tunnel: false, pty: false, gui: true }, defaultPort: 5900 },
        ],
      }
    },
    guiOpen(host, protocol) { return { launched: true, target: `${host}:5900`, protocol } },
  }
  const protocols = await indexModule.internals.resources.protocolsResource(
    new Request(`${base}/protocols`),
    runtime,
  )
  assert.equal(protocols.status, 200)
  const matrix = await protocols.json()
  assert.equal(matrix.ok, true)
  assert.equal(matrix.defaultProtocol, 'ssh')
  assert.deepEqual(matrix.protocols.map((item) => item.id), ['ssh', 'vnc'])

  const opened = await indexModule.internals.resources.guiOpenResource(
    new Request(`${base}/gui-open?host=sandbox&protocol=vnc`, { headers: { 'x-dsh-remote-exec': '1' } }),
    runtime,
  )
  assert.deepEqual(await opened.json(), { ok: true, launched: true, target: 'sandbox:5900', protocol: 'vnc' })

  const missing = new Error('本机没有 vncviewer（推荐 MobaXterm/TigerVNC），或改用 SSH/Telnet')
  missing.code = 'GUI_CLIENT_MISSING'
  missing.install = installInfo('vnc')
  const missingClient = await indexModule.internals.resources.guiOpenResource(
    new Request(`${base}/gui-open?host=sandbox&protocol=vnc`, { headers: { 'x-dsh-remote-exec': '1' } }),
    { guiOpen() { throw missing } },
  )
  assert.equal(missingClient.status, 400)
  const missingBody = await missingClient.json()
  assert.match(missingBody.error, /MobaXterm/)
  // v2.1：缺客户端时把安装引导一起带回，面板据此渲染「复制命令 / 下载页 / 重新检测」。
  assert.equal(missingBody.code, 'GUI_CLIENT_MISSING')
  assert.equal(missingBody.install.protocol, 'vnc')
  assert.equal(missingBody.install.client, 'vncviewer')
  assert.match(missingBody.install.url, /^https:\/\//)
  assert.ok(missingBody.install.commands.length >= 2)
  assert.ok(missingBody.install.commands.every((item) => typeof item.command === 'string' && item.command.length > 0))
  const rdpInstall = installInfo('rdp')
  assert.equal(rdpInstall.protocol, 'rdp')
  assert.ok(rdpInstall.commands.length >= 1)
})

await checkAsync('v2.4 desktop-install：缺什么由插件代装（confirm 守卫、脚本标记、错误码）', async () => {
  const base = 'http://127.0.0.1:1/api/plugins/remote'
  const res = indexModule.internals.resources
  assert.equal(typeof res.desktopInstallResource, 'function')

  const noHeader = await res.desktopInstallResource(new Request(`${base}/desktop-install?host=sandbox&confirm=1`), {})
  assert.equal(noHeader.status, 403)
  assert.equal((await noHeader.json()).error, '缺少 x-dsh-remote-exec 头')

  const noConfirm = await res.desktopInstallResource(
    new Request(`${base}/desktop-install?host=sandbox`, { headers: { 'x-dsh-remote-exec': '1' } }),
    {},
  )
  assert.equal(noConfirm.status, 400)
  assert.match((await noConfirm.json()).error, /confirm=1/)

  const already = await res.desktopInstallResource(
    new Request(`${base}/desktop-install?host=sandbox&confirm=1`, { headers: { 'x-dsh-remote-exec': '1' } }),
    { async desktopInstall() { return { host: 'sandbox', platform: 'linux', installed: true, already: true, exitCode: 0, steps: [] } } },
  )
  assert.equal(already.status, 200)
  const alreadyBody = await already.json()
  assert.equal(alreadyBody.ok, true)
  assert.equal(alreadyBody.already, true)

  const failed = new Error('目标机上自动安装 VNC 服务没有成功（MSI 退出码 1603）')
  failed.code = 'VNC_INSTALL_FAILED'
  failed.steps = ['DSH-DOWNLOAD-OK', 'DSH-MSI-EXIT=1603']
  failed.install = vncServerInstallInfo('win32')
  const installFailed = await res.desktopInstallResource(
    new Request(`${base}/desktop-install?host=sandbox&confirm=1`, { headers: { 'x-dsh-remote-exec': '1' } }),
    { async desktopInstall() { throw failed } },
  )
  assert.equal(installFailed.status, 502)
  const failedBody = await installFailed.json()
  assert.equal(failedBody.code, 'VNC_INSTALL_FAILED')
  assert.deepEqual(failedBody.steps, ['DSH-DOWNLOAD-OK', 'DSH-MSI-EXIT=1603'])
  assert.equal(failedBody.install.protocol, 'vnc-server')

  const win = windowsInstallScript()
  assert.match(win, /msiexec \/i/)
  assert.match(win, /ADDLOCAL=Server/)
  assert.match(win, /SET_USEVNCAUTHENTICATION=1 VALUE_OF_USEVNCAUTHENTICATION=0/)
  assert.match(win, /SET_ALLOWLOOPBACK=1 VALUE_OF_ALLOWLOOPBACK=1/)
  // 无认证的 VNC 只能走回环：必须有一条入站阻断规则兜底，否则局域网可直连。
  assert.match(win, /netsh advfirewall firewall add rule name="dsh-vnc-standalone" dir=in action=block/)
  assert.match(win, /sc config tvnserver start= auto/)
  assert.match(win, /https:\/\/www\.tightvnc\.com\//)
  // 目标机的 exec 通道只跑第一行、`if (...)` 之后还会截断，所以安装被拆成单行步骤而不是一条长脚本。
  const steps = windowsInstallSteps()
  assert.deepEqual(steps.map((item) => item.id), ['download', 'verify', 'install', 'firewall', 'service'])
  for (const step of steps) {
    assert.ok(!/\r?\n/.test(step.command), `步骤 ${step.id} 必须是单行`)
    if (step.id !== 'verify') assert.ok(!/\bif\b/i.test(step.command), `步骤 ${step.id} 不该用 if`)
  }
  assert.match(steps.find((item) => item.id === 'verify').command, /if exist .*echo DSH-DOWNLOAD-OK/)

  const linux = linuxInstallScript()
  assert.match(linux, /tigervnc-standalone-server/)
  assert.match(linux, /DSH-NO-PKG-MANAGER/)
  assert.ok(linux.includes('DSH-INSTALL-END'))

  const parsed = parseInstallLog('DSH-DOWNLOAD-OK\r\nDSH-MSI-EXIT=0\r\nSTATE : 4  RUNNING\r\nDSH-INSTALL-END')
  assert.equal(parsed.downloaded, true)
  assert.equal(parsed.msiExitCode, 0)
  assert.equal(parsed.finished, true)
  assert.equal(parseInstallLog('DSH-APT-OK\nDSH-INSTALL-END').linuxInstalled, true)
  assert.equal(parseInstallLog('DSH-NO-PKG-MANAGER').noPackageManager, true)
  assert.equal(parseInstallLog('').downloaded, false)
})

await checkAsync('关闭测试 HTTP 服务', async () => {
  await new Promise((resolve) => testServer.close(resolve))
})

await checkAsync('跳板链（jump）解析：形状、循环、协议与凭据闸门', async () => {
  const hasDefaultKey = () => false
  const base = {
    hub: normalizeHostEntry('hub', { host: '10.0.0.1', password: ['hub', 'pass'].join('-') }),
    inner: normalizeHostEntry('inner', { host: '10.0.0.2', password: 'inner-pass' }),
    target: normalizeHostEntry('target', { host: '10.0.0.3', password: 't-pass', jump: ['hub', 'inner'] }),
  }

  assert.deepEqual(normalizeJumpChain('a,b', 'x'), ['a', 'b'])
  assert.deepEqual(normalizeJumpChain(['a', ' b '], 'x'), ['a', 'b'])
  assert.deepEqual(normalizeJumpChain(undefined, 'x'), [])
  assert.throws(() => normalizeJumpChain(['hub'], 'hub'), /不能是自己/)
  assert.throws(() => normalizeJumpChain(['a', 'a'], 'x'), /跳板重复/)
  assert.throws(() => normalizeJumpChain(['a', 'b', 'c', 'd'], 'x'), new RegExp(`最多 ${MAX_JUMP_HOPS} 跳`))
  assert.throws(() => normalizeJumpChain(['bad alias!'], 'x'), /不是合法别名/)

  const spec = resolveAliasSpec('target', { hosts: base, env: {}, hasDefaultKey })
  assert.deepEqual(spec.jump.map((hop) => hop.alias), ['hub', 'inner'])
  assert.deepEqual(spec.jump.map((hop) => hop.key), ['jump:hub', 'jump:inner'])
  assert.equal(spec.jump[0].password, 'hub-pass')
  assert.equal(spec.password, 't-pass')

  // Flat hosts (the common case) keep an empty chain, so nothing in the pool changes.
  const flat = resolveAliasSpec('hub', { hosts: base, env: {}, hasDefaultKey })
  assert.deepEqual(flat.jump, [])
  assert.equal(resolveHostRef('inner', { hosts: base, env: {}, hasDefaultKey }).jump.length, 0)

  const missingHop = { ...base, target: normalizeHostEntry('target', { host: '10.0.0.3', password: 'x', jump: ['nope'] }) }
  assert.throws(() => resolveAliasSpec('target', { hosts: missingHop, env: {}, hasDefaultKey }), /跳板 "nope" 未在主机列表里定义/)

  const disabledHop = { ...base, hub: { ...base.hub, disabled: true } }
  assert.throws(() => resolveAliasSpec('target', { hosts: disabledHop, env: {}, hasDefaultKey }), /跳板 "hub" 不可用：.*已禁用/)

  const cycle = {
    a: normalizeHostEntry('a', { host: '10.0.0.9', password: 'a', jump: ['b'] }),
    b: normalizeHostEntry('b', { host: '10.0.0.9', password: 'b', jump: ['a'] }),
  }
  assert.throws(() => resolveAliasSpec('a', { hosts: cycle, env: {}, hasDefaultKey }), /跳板链存在循环：a → b → a/)

  const vncHop = {
    hub: normalizeHostEntry('hub', { host: '10.0.0.1', protocol: 'vnc' }),
    target: normalizeHostEntry('target', { host: '10.0.0.3', password: 'x', jump: ['hub'] }),
  }
  assert.throws(() => resolveAliasSpec('target', { hosts: vncHop, env: {}, hasDefaultKey }), /只能用 ssh 协议/)

  const noHopCreds = { ...base, inner: normalizeHostEntry('inner', { host: '10.0.0.2', passwordEnv: 'DSH_TEST_MISSING_ENV' }) }
  assert.throws(() => resolveAliasSpec('target', { hosts: noHopCreds, env: {}, hasDefaultKey }), /跳板 "inner" 不可用：.*DSH_TEST_MISSING_ENV/)

  // The public listing exposes the chain but never a secret value.
  const listed = publicHosts(base, { env: {}, hasDefaultKey })
  const targetRow = listed.find((row) => row.alias === 'target')
  assert.deepEqual(targetRow.jump, ['hub', 'inner'])
  assert.equal(targetRow.ready, true)
  assert.ok(!JSON.stringify(listed).includes('hub-pass'))

  const brokenRow = publicHosts(missingHop, { env: {}, hasDefaultKey }).find((row) => row.alias === 'target')
  assert.equal(brokenRow.ready, false)
  assert.match(brokenRow.jumpIssue, /未在主机列表里定义/)

  // host-save writes the chain into the hosts file and clears it on an empty value.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-jump-'))
  const file = join(dir, 'hosts.json')
  try {
    upsertHostFile(file, { alias: 'a-jump', host: '10.0.0.9', port: 22, auth: 'password', secret: 'x', jump: ['hub'] })
    let stored = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual((stored.hosts || stored)['a-jump'].jump, ['hub'])
    upsertHostFile(file, { alias: 'a-jump', host: '10.0.0.9', port: 22, auth: 'password', secret: 'x', jump: '' })
    stored = JSON.parse(readFileSync(file, 'utf8'))
    assert.ok(!('jump' in (stored.hosts || stored)['a-jump']))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await checkAsync('卸载时关闭所有资源（disposer 全部可调用）', async () => {
  assert.ok(registeredDisposers.length >= 43)
  for (const dispose of registeredDisposers) assert.equal(typeof dispose, 'function')
  for (const dispose of registeredDisposers) dispose()
})

console.log(`\n${checks} checks passed.`)
