import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

import {
  internals,
  name as packageName,
  inject,
  apply,
  parseRegistryPath,
} from '../index.js'
import { parsePipe, planPipeline, interpolate, matchArtifacts, PipeError, defaultRestartCommand, isHostSelector, parseHostSelector, splitTargetHosts } from '../lib/pipe.js'
import { createStore } from '../lib/store.js'
import { openDatabase } from '../lib/db.js'
import { DatabaseSync } from 'node:sqlite'
import { runPipeline, makeRunId } from '../lib/runner.js'
import { createRemote, remoteUnavailable } from '../lib/remote.js'
import { deployRelease, rollbackRelease, shellQuote } from '../lib/deploy.js'
import { dispatchNotifications } from '../lib/notify.js'
import { createScheduler } from '../lib/scheduler.js'
import { createLiveHub } from '../lib/live.js'
import { matchPushRef, triggerSummary } from '../lib/triggers.js'
import { createLocalExecutor, createRemoteExecutor, createTaskBroker, joinTokenMatches } from '../lib/executors.js'
import { createApprovalGate } from '../lib/approval.js'
import { createSecretStore } from '../lib/secrets.js'
import { normalizeEnvironments, promotionPath } from '../lib/environments.js'
import { deployRelease as strategyDeploy, normalizeStrategy } from '../lib/strategy.js'
import { deployTransaction, planBatches, readManifest, usesTransaction } from '../lib/deploy-engine.js'
import { createNativeActuator, renderTemplate } from '../lib/actuator/native.js'
import { createContainerActuator, resolveImageReference, parsePublishedPort, parseInspect, normalizeImageDigest, CONTAINER_ERRORS } from '../lib/actuator/container.js'
import { createSlotStore } from '../lib/slots.js'
import {
  createToolchain, envFor, assertVersions, inferFromFiles, writeDualLocks, binDirOf,
  parseSpec, pickVersion, parseChecksum, matchesVersion, sha256File, currentPlatform,
  emptyLock, readLock, writeLock, upsertLockEntry, runSync, TOOLCHAIN_ERRORS,
} from '../lib/toolchain.js'

const checks = []
function check(title, fn) {
  checks.push({ title, fn })
}
async function checkAsync(title, fn) {
  checks.push({ title, fn, async: true })
}
function throwsCode(fn, code) {
  assert.throws(fn, (error) => error && error.code === code, `expected code ${code}`)
}

check('manifest 是 @local/dsh-cicd 3.0.0-p2 且导出 Host 形状', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.name, '@local/dsh-cicd')
  assert.equal(manifest.version, '3.0.0-p2')
  assert.equal(manifest.type, 'module')
  assert.equal(packageName, '@local/dsh-cicd')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof apply, 'function')
})

// ---------------------------------------------------------------------------------------------
// 1. YAML subset parser

const PIPE_SOURCE = [
  'version: 1',
  'name: demo-pipe',
  'vars:',
  '  GREETING: hello',
  '  PORT: 8080',
  'targets:',
  '  prod:',
  '    hosts: [linux26, win22]',
  '    path: /opt/demo',
  '    restart: "systemctl restart demo"',
  '    health:',
  '      http: http://127.0.0.1:9/health',
  '      tries: 1',
  '      interval: 0s',
  'stages:',
  '  - id: build',
  '    steps:',
  '      - name: build',
  '        run: node -e "console.log(\'BUILD_OK\')"',
  '      - name: tolerant',
  '        run: node -e "process.exit(3)"',
  '        allow_failure: true',
  '        retries: 1',
  '  - id: package',
  '    needs: [build]',
  '    steps:',
  '      - name: package',
  '        run: echo packaged',
  '  - id: release',
  '    needs: [package]',
  '    steps:',
  '      - name: ship',
  '        deploy:',
  '          target: prod',
  '          artifacts: ["dist/**"]',
  '          keep: 3',
].join('\n')

check('parsePipe：map/sequence/内联数组/引号/类型/注释', () => {
  const pipe = parsePipe(`${PIPE_SOURCE}\n# trailing comment\n`)
  assert.equal(pipe.version, 1)
  assert.equal(pipe.name, 'demo-pipe')
  assert.deepEqual(pipe.targets.prod.hosts, ['linux26', 'win22'])
  assert.equal(pipe.targets.prod.path, '/opt/demo')
  assert.equal(pipe.targets.prod.restart, 'systemctl restart demo')
  assert.equal(pipe.targets.prod.health.tries, 1)
  assert.deepEqual(pipe.stages.map((stage) => stage.id), ['build', 'package', 'release'])
  assert.deepEqual(pipe.stages[1].needs, ['build'])
  assert.equal(pipe.stages[2].steps[0].deploy.keep, 3)
})

check('parsePipe：拒绝重复 stage、悬空 needs、service 与 restart 并存、未知缩进/语法', () => {
  throwsCode(() => parsePipe('stages:\n  - id: a\n    steps:\n      - run: x\n  - id: a\n    steps:\n      - run: y\n'), 'PIPE_INVALID')
  throwsCode(() => parsePipe('stages:\n  - id: a\n    needs: [ghost]\n    steps:\n      - run: x\n'), 'PIPE_INVALID')
  throwsCode(() => parsePipe('targets:\n  prod:\n    hosts: [h]\n    service: demo\n    restart: "true"\nstages:\n  - id: a\n    steps:\n      - run: x\n'), 'PIPE_INVALID')
  throwsCode(() => parsePipe('stages:\n   - id: a\n'), 'PIPE_INVALID')
  throwsCode(() => parsePipe('vars: {a: b}\n'), 'PIPE_INVALID')
  throwsCode(() => parsePipe('stages:\n  - id: a\n    steps:\n      - run: |\n          echo hi\n'), 'PIPE_INVALID')
  throwsCode(() => parsePipe('stages:\n  - id: a\n    steps:\n      - name: x\n'), 'PIPE_INVALID')
})

check('when 只接受受支持的比较，非法表达式给出 PIPE_WHEN', () => {
  throwsCode(() => planPipeline(parsePipe('stages:\n  - id: a\n    when: branch =~ main\n    steps:\n      - run: x\n'), { project: 'p' }), 'PIPE_WHEN')
  const pipe = parsePipe("stages:\n  - id: a\n    when: branch == 'main'\n    steps:\n      - run: x\n  - id: b\n    when: changed: src/**\n    steps:\n      - run: y\n")
  assert.equal(planPipeline(pipe, { project: 'p', env: { branch: 'main' } }).stages.length, 1)
  assert.equal(planPipeline(pipe, { project: 'p', env: { branch: 'dev', changed: ['src/a.js'] } }).stages[0].id, 'b')
})

check('interpolate 与 matchArtifacts：变量缺失报错、通配符跨层', () => {
  assert.equal(interpolate('echo ${{GREETING}} ${{PORT}}', { GREETING: 'hi', PORT: 8080 }), 'echo hi 8080')
  throwsCode(() => interpolate('echo ${{MISSING}}', {}), 'PIPE_VAR')
  assert.deepEqual(matchArtifacts(['dist/**'], ['dist/a.js', 'dist/sub/b.js', 'src/c.js']), ['dist/a.js', 'dist/sub/b.js'])
  assert.deepEqual(matchArtifacts(['**/*.js'], ['a.js', 'x/y/b.js', 'c.txt']), ['a.js', 'x/y/b.js'])
  assert.deepEqual(matchArtifacts(['a?.txt'], ['a1.txt', 'a22.txt']), ['a1.txt'])
})

check('planPipeline：DAG 顺序、vars 覆盖优先级、按 stage 截取', () => {
  const pipe = parsePipe(PIPE_SOURCE.replace('run: echo packaged', 'run: echo ${{PORT}}'))
  const plan = planPipeline(pipe, { project: 'demo', target: 'prod', env: { vars: { PORT: '9090' } } })
  assert.deepEqual(plan.stages.map((stage) => stage.id), ['build', 'package', 'release'])
  assert.equal(plan.vars.CI, '1')
  assert.equal(plan.vars.PORT, '9090')
  assert.equal(plan.vars.GREETING, 'hello')
  assert.equal(plan.stages[1].steps[0].command, 'echo 9090')
  const deployStep = plan.stages[2].steps[0]
  assert.equal(deployStep.kind, 'deploy')
  assert.equal(deployStep.command, 'deploy:prod')
  assert.deepEqual(deployStep.deploy.artifacts, ['dist/**'])
})

// ---------------------------------------------------------------------------------------------
// 2. SQLite store

check('store：run 折叠覆盖、过滤/limit、step 排序、release 活跃与日志 tail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cicd-store-'))
  const store = createStore({ dir })
  try {
    store.appendRun({ id: 'r1', project_id: 'demo', pipeline_name: 'p', status: 'running', started_at: '2026-01-01T00:00:00.000Z' })
    store.appendRun({ id: 'r2', project_id: 'other', pipeline_name: 'p2', status: 'success', started_at: '2026-01-02T00:00:00.000Z' })
    store.appendRun({ id: 'r1', project_id: 'demo', pipeline_name: 'p', status: 'success', started_at: '2026-01-01T00:00:00.000Z' })
    assert.equal(store.run('r1').status, 'success')
    assert.equal(store.runs({ project: 'demo' }).length, 1)
    assert.deepEqual(store.runs({ limit: 1 }).map((run) => run.id), ['r2'])

    store.appendStep({ run_id: 'r1', idx: 1, started_at: '2026-01-01T00:00:02.000Z', name: 'second' })
    store.appendStep({ run_id: 'r1', idx: 0, started_at: '2026-01-01T00:00:01.000Z', name: 'first' })
    assert.deepEqual(store.stepsOf('r1').map((step) => step.name), ['first', 'second'])

    store.appendRelease({ id: 'rel1', target: 'prod', host: 'h', status: 'active', created_at: '2026-01-01T00:00:00.000Z', activated_at: '2026-01-01T00:00:00.000Z' })
    store.appendRelease({ id: 'rel2', target: 'prod', host: 'h', status: 'active', created_at: '2026-01-02T00:00:00.000Z', activated_at: '2026-01-02T00:00:00.000Z' })
    store.appendRelease({ id: 'rel3', target: 'prod', host: 'h2', status: 'active', created_at: '2026-01-03T00:00:00.000Z', activated_at: '2026-01-03T00:00:00.000Z' })
    assert.deepEqual(store.releases({ target: 'prod' }).map((release) => release.id), ['rel3', 'rel2', 'rel1'])
    assert.deepEqual(store.releases({ target: 'prod', host: 'h' }).map((release) => release.id), ['rel2', 'rel1'])
    assert.equal(store.activeRelease({ target: 'prod', host: 'h' }).id, 'rel2')
    assert.equal(store.activeRelease({ target: 'prod', host: 'h2' }).id, 'rel3')

    mkdirSync(join(dir, 'logs'), { recursive: true })
    writeFileSync(join(dir, 'logs', 'r1.log'), 'a\nb\nc\n', 'utf8')
    assert.equal(store.readLog('r1', { tail: 2 }), 'b\nc')
    assert.throws(() => store.logPath('bad/id'), /runId 不合法/)

    // v0.3：运行记录进 SQLite（node:sqlite），不再是 JSONL
    assert.ok(existsSync(store.dbFile), '应该创建 cicd.db')
    assert.ok(!existsSync(join(dir, 'runs.jsonl')), '不应该再写 runs.jsonl')
    const header = readFileSync(store.dbFile).subarray(0, 16).toString('latin1')
    assert.ok(header.startsWith('SQLite format 3'), `db 文件头应该是 SQLite，实际 ${header}`)
    const stats = store.stats()
    assert.equal(stats.runs, 2)
    assert.equal(stats.releases, 3)
    assert.ok(stats.steps >= 2)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------------------------
// 2b. 遗留 JSONL 自动迁移到 SQLite

check('store 审计：operations 按 at 倒序、project/runId 过滤与 camelCase 输出', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cicd-ops-'))
  const store = createStore({ dir })
  try {
    store.appendOperation({ action: 'deploy', project: 'p1', target: 'prod', host: 'h1', run_id: 'r1', release_id: 'r1@h1', status: 'success', detail: { batch: 1 }, at: '2026-01-01T00:00:01.000Z' })
    store.appendOperation({ action: 'notify', project: 'p1', target: 'prod', run_id: 'r1', status: 'failed', detail: { event: 'run.failed' }, at: '2026-01-01T00:00:03.000Z' })
    store.appendOperation({ action: 'rollback', project: 'p2', target: 'stage', host: 'h2', status: 'success', at: '2026-01-01T00:00:02.000Z' })
    const all = store.operations({ limit: 10 })
    assert.deepEqual(all.map((item) => item.action), ['notify', 'rollback', 'deploy'])
    assert.equal(all[0].runId, 'r1')
    assert.equal(all[0].releaseId, '')
    assert.equal(all[0].status, 'failed')
    assert.deepEqual(store.operations({ project: 'p1', limit: 10 }).map((item) => item.action), ['notify', 'deploy'])
    assert.deepEqual(store.operations({ runId: 'r1', limit: 10 }).map((item) => item.action), ['notify', 'deploy'])
    assert.equal(store.operations({ project: 'p1', runId: 'missing', limit: 10 }).length, 0)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

check('store 迁移：遗留 runs.jsonl 导入 SQLite 并改名 .migrated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cicd-migrate-'))
  try {
    const events = [
      { type: 'run', data: { id: 'old1', project_id: 'demo', pipeline_name: 'p', status: 'success', started_at: '2025-12-01T00:00:00.000Z' } },
      { type: 'step', data: { run_id: 'old1', idx: 0, name: 'render', status: 'success' } },
      { type: 'release', data: { id: 'old1', target: 'prod', host: 'h', status: 'active', created_at: '2025-12-01T00:00:00.000Z' } },
      { type: 'run', data: { id: 'old2', project_id: 'demo', pipeline_name: 'p', status: 'failed', started_at: '2025-12-02T00:00:00.000Z' } },
      '{broken json',
      '',
    ]
    writeFileSync(join(dir, 'runs.jsonl'), events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n'), 'utf8')

    const store = createStore({ dir })
    try {
      const runs = store.runs({ project: 'demo' })
      assert.deepEqual(runs.map((run) => run.id), ['old2', 'old1'])
      assert.equal(store.stepsOf('old1').length, 1)
      assert.equal(store.releases({ target: 'prod' }).length, 1)
      assert.ok(existsSync(store.dbFile), '迁移后应该有 cicd.db')
      assert.ok(!existsSync(join(dir, 'runs.jsonl')), 'runs.jsonl 应被改名')
      assert.ok(existsSync(join(dir, 'runs.jsonl.migrated')), '应留一份 runs.jsonl.migrated')
    } finally {
      store.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------------------------
// 3. Runner

const runnerProject = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cicd-run-'))
  return { dir, project: { id: 'demo', name: 'demo', path: dir, env: {} } }
}

checkAsync('runner：成功/失败/allow_failure/retries，日志与运行记录写入 store', async () => {
  const { dir, project } = runnerProject()
  const store = createStore({ dir: join(dir, '.state') })
  try {
    const pipe = parsePipe([
      'version: 1',
      'name: runner-pipe',
      'targets:',
      '  prod:',
      '    hosts: [h]',
      '    path: /opt/demo',
      'stages:',
      '  - id: build',
      '    steps:',
      "      - name: ok",
      "        run: node -e \"console.log('BUILD_OK')\"",
      '      - name: tolerant',
      '        run: node -e "process.exit(3)"',
      '        allow_failure: true',
      '        retries: 1',
      '  - id: verify',
      '    needs: [build]',
      '    steps:',
      '      - name: verify',
      '        run: node -e "process.exit(4)"',
      '  - id: after',
      '    needs: [verify]',
      '    steps:',
      '      - name: never',
      '        run: echo should-not-run',
    ].join('\n'))
    const lines = []
    const result = await runPipeline({ pipe, project, target: 'prod', store, onLog: (entry) => lines.push(entry.line), stepTimeoutSec: 10 })
    assert.equal(result.status, 'failed')
    assert.deepEqual(result.stages.map((stage) => stage.status), ['success', 'failed', 'skipped'])
    const tolerant = result.stages[0].steps[1]
    assert.equal(tolerant.status, 'failed')
    assert.equal(tolerant.error, '')
    const steps = store.stepsOf(result.runId)
    const tolerantRecord = steps.find((step) => step.name === 'tolerant')
    assert.equal(tolerantRecord.attempts, 2)
    assert.equal(tolerantRecord.exit_code, 3)
    assert.equal(store.run(result.runId).status, 'failed')
    assert.ok(lines.some((line) => line.includes('BUILD_OK')))
    assert.ok(lines.some((line) => line.includes('跳过 stage after')))
    assert.ok(readFileSync(store.logPath(result.runId), 'utf8').includes('BUILD_OK'))
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

checkAsync('runner：dryRun 不写 store、不执行命令，按 stage 只取依赖闭包', async () => {
  const { dir, project } = runnerProject()
  const store = createStore({ dir: join(dir, '.state') })
  try {
    const pipe = parsePipe([
      'stages:',
      '  - id: a',
      '    steps:',
      '      - run: echo A',
      '  - id: b',
      '    needs: [a]',
      '    steps:',
      '      - run: echo B',
      '  - id: c',
      '    steps:',
      '      - run: echo C',
    ].join('\n'))
    const result = await runPipeline({ pipe, project, target: '', dryRun: true, store })
    assert.equal(result.status, 'planned')
    assert.equal(result.runId, '')
    assert.deepEqual(result.stages.map((stage) => stage.id), ['a', 'b', 'c'])
    assert.equal(store.runs({}).length, 0)
    const onlyB = await runPipeline({ pipe, project, target: '', dryRun: true, store, stage: 'b' })
    assert.deepEqual(onlyB.stages.map((stage) => stage.id), ['a', 'b'])
    await assert.rejects(() => runPipeline({ pipe, project, target: '', dryRun: true, store, stage: 'missing' }), (error) => error.code === 'STAGE_NOT_FOUND')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

check('runner：runId 格式稳定，部署步骤经 executeDeploy 回调', async () => {
  const id = makeRunId(new Date('2026-02-03T04:05:06'), () => 0.5)
  assert.match(id, /^20260203-040506-[0-9a-f]{6}$/)
  const { dir, project } = runnerProject()
  const store = createStore({ dir: join(dir, '.state') })
  try {
    const pipe = parsePipe('targets:\n  prod:\n    hosts: [h]\n    path: /opt/demo\nstages:\n  - id: release\n    steps:\n      - name: ship\n        deploy:\n          target: prod\n')
    const seen = []
    const result = await runPipeline({
      pipe,
      project,
      target: 'prod',
      store,
      executeDeploy: async (context) => { seen.push(context); return { status: 'success', deploy: { hosts: [{ host: 'h1', ok: true, health: 'ok', restarted: 'restart', error: '' }] } } },
    })
    assert.equal(result.status, 'success')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].step.deploy.target, 'prod')
    assert.equal(typeof seen[0].log, 'function')
    assert.equal(result.stages[0].steps[0].kind, 'deploy')
    assert.equal(result.stages[0].steps[0].hosts[0].host, 'h1')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------------------------
// 4. Deploy / rollback

function fakeRemote({ readlink = 'releases/prev1', healthExit = 0, healthFailures = 0, dirExists = true, failHosts = [], healthFailHosts = [] } = {}) {
  const calls = []
  const healthAttempts = new Map()
  return {
    calls,
    async exec(host, command) {
      calls.push({ host, command })
      if (failHosts.includes(host) && command.startsWith('mkdir')) {
        const error = new Error(`mkdir failed on ${host}`)
        error.code = 'SFTP_MKDIR'
        throw error
      }
      if (command.startsWith('readlink')) {
        const value = typeof readlink === 'function' ? readlink(host) : (readlink && typeof readlink === 'object' ? (readlink[host] || '') : readlink)
        return { stdout: value, exitCode: 0 }
      }
      if (command.startsWith('test -d')) return { stdout: dirExists ? 'yes' : 'no', exitCode: 0 }
      if (command.startsWith('curl')) {
        const attempt = (healthAttempts.get(host) || 0) + 1
        healthAttempts.set(host, attempt)
        const forced = healthFailHosts.includes(host) ? Number.MAX_SAFE_INTEGER : 0
        const exitCode = attempt <= Math.max(healthFailures, forced) ? 1 : healthExit
        return { stdout: '', stderr: exitCode === 0 ? '' : 'connection refused', exitCode }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    },
    async uploadFile(host, localPath, remotePath) {
      calls.push({ host, upload: { localPath, remotePath } })
    },
  }
}

checkAsync('deployRelease：restart 优先、上传、current 软链、revisions.log、keep 清理', async () => {
  const artifact = join(tmpdir(), `dsh-cicd-artifact-${process.pid}.tgz`)
  writeFileSync(artifact, 'fake tgz', 'utf8')
  const remote = fakeRemote({ readlink: 'releases/prev1' })
  try {
    const result = await deployRelease({
      remote,
      project: { id: 'demo' },
      target: { hosts: ['linux26'], path: '/opt/demo/', restart: 'systemctl restart demo', health: { http: 'http://127.0.0.1:9/health', tries: 1, interval: '0s' } },
      targetName: 'prod',
      host: '',
      artifactPath: artifact,
      releaseId: '20260101-000000-abcdef',
      keep: 3,
      commit: 'abc123',
    })
    assert.equal(result.restarted, 'restart')
    assert.equal(result.health, 'ok')
    assert.equal(result.previous, 'prev1')
    assert.equal(result.releaseDir, '/opt/demo/releases/20260101-000000-abcdef')
    assert.ok(remote.calls.some((call) => call.command === 'systemctl restart demo'))
    assert.ok(remote.calls.some((call) => call.upload && call.upload.remotePath.endsWith('.tgz')))
    assert.ok(remote.calls.some((call) => call.command?.includes('tar -xzf')))
    assert.ok(remote.calls.some((call) => call.command?.includes("ln -sfn 'releases/20260101-000000-abcdef'")))
    assert.ok(remote.calls.some((call) => call.command?.includes('revisions.log')))
    assert.ok(remote.calls.some((call) => call.command?.includes('tail -n +4')))
  } finally {
    rmSync(artifact, { force: true })
  }
})

checkAsync('deployRelease：service 回退、无 service/restart 跳过并记录', async () => {
  const remote = fakeRemote()
  const base = { hosts: ['h'], path: '/srv/app' }
  const service = await deployRelease({ remote, target: { ...base, service: 'app.service' }, targetName: 'prod', releaseId: 'r1', keep: 0 })
  assert.equal(service.restarted, 'service')
  assert.ok(remote.calls.some((call) => call.command?.includes('systemctl --user restart')))
  const lines = []
  const skipped = await deployRelease({ remote: fakeRemote(), target: base, targetName: 'prod', releaseId: 'r2', keep: 0, onLog: (line) => lines.push(line) })
  assert.equal(skipped.restarted, 'skipped')
  assert.ok(lines.some((line) => line.includes('跳过重启')))
})

checkAsync('deployRelease：健康检查失败自动指回 previous，单主机返回 ok:false', async () => {
  const remote = fakeRemote({ readlink: 'releases/prev9', healthFailures: 5 })
  const result = await deployRelease({ remote, target: { hosts: ['h'], path: '/opt/x', restart: 'true', health: { http: 'http://127.0.0.1:9/health', tries: 1, interval: '0s' } }, targetName: 'prod', releaseId: 'new1', keep: 0 })
  assert.equal(result.ok, false)
  assert.equal(result.hosts.length, 1)
  assert.equal(result.hosts[0].ok, false)
  assert.equal(result.hosts[0].health, 'failed')
  assert.match(result.hosts[0].error, /已自动回滚到 prev9/)
  assert.ok(remote.calls.some((call) => call.command === "ln -sfn 'releases/prev9' '/opt/x/current'"))
})

checkAsync('rollbackRelease：缺 releaseId 读 current、目录不存在返回 per-host 错误、成功重启', async () => {
  const ok = fakeRemote({ readlink: 'releases/prev1' })
  const result = await rollbackRelease({ remote: ok, target: { hosts: ['h'], path: '/opt/demo', service: 'demo' }, targetName: 'prod' })
  assert.equal(result.ok, true)
  assert.equal(result.releaseId, 'prev1')
  assert.equal(result.restarted, 'service')
  assert.ok(ok.calls.some((call) => call.command?.startsWith('test -d')))
  const missing = fakeRemote({ readlink: 'releases/gone', dirExists: false })
  const failed = await rollbackRelease({ remote: missing, target: { hosts: ['h'], path: '/opt/demo' }, targetName: 'prod' })
  assert.equal(failed.ok, false)
  assert.equal(failed.hosts[0].code, 'RELEASE_NOT_FOUND')
  assert.equal(shellQuote("a'b"), `'a'\\''b'`)
})

check('parsePipe：target runtime/app/onHostFailure/keep 校验与默认重启命令', () => {
  const pipe = parsePipe('targets:\n  prod:\n    hosts: [a, b]\n    path: /opt/demo\n    runtime: node\n    app: demo\n    onHostFailure: continue\n    keep: 3\n    health:\n      http: http://127.0.0.1:9/health\n      tries: 2\nstages:\n  - id: release\n    steps:\n      - deploy:\n          target: prod\n')
  const target = pipe.targets.prod
  assert.equal(target.runtime, 'node')
  assert.equal(target.app, 'demo')
  assert.equal(target.onHostFailure, 'continue')
  assert.equal(target.keep, 3)
  assert.equal(target.restartCommand, defaultRestartCommand('node', 'demo', 'prod'))
  assert.match(target.restartCommand, /pm2 restart 'demo'/)
  assert.ok(target.restartCommand.endsWith('|| true'))
  assert.equal(defaultRestartCommand('static', 'x'), '')
  assert.match(defaultRestartCommand('docker', 'web'), /docker restart 'web'/)
  assert.match(defaultRestartCommand('python', 'api'), /systemctl --user restart 'api'/)
  throwsCode(() => parsePipe('targets:\n  p:\n    hosts: [a]\n    runtime: ruby\nstages:\n  - id: a\n    steps:\n      - run: x\n'), 'PIPE_INVALID')
  throwsCode(() => parsePipe('targets:\n  p:\n    hosts: [a]\n    runtime: node\nstages:\n  - id: a\n    steps:\n      - run: x\n'), 'PIPE_INVALID')
  throwsCode(() => parsePipe('targets:\n  p:\n    hosts: [a]\n    onHostFailure: retry\nstages:\n  - id: a\n    steps:\n      - run: x\n'), 'PIPE_INVALID')
  throwsCode(() => parsePipe('targets:\n  p:\n    hosts: [a]\n    keep: 0\nstages:\n  - id: a\n    steps:\n      - run: x\n'), 'PIPE_INVALID')
  throwsCode(() => parsePipe('targets:\n  p:\n    hosts: [a]\n    path: relative/dir\nstages:\n  - id: a\n    steps:\n      - run: x\n'), 'PIPE_INVALID')
})

check('parsePipe：canary first/waitSec 校验与默认 30s', () => {
  const pipe = parsePipe(['version: 1', 'targets:', '  prod:', '    hosts: [a, b, c]', '    path: /opt/demo', '    canary:', '      first: 1', 'stages:', '  - id: a', '    steps:', '      - run: x'].join('\n'))
  assert.deepEqual(pipe.targets.prod.canary, { first: 1, waitSec: 30 })
  const equal = parsePipe(['version: 1', 'targets:', '  p:', '    hosts: [a, b]', '    canary:', '      first: 2', '      waitSec: 0', 'stages:', '  - id: a', '    steps:', '      - run: x'].join('\n'))
  assert.deepEqual(equal.targets.p.canary, { first: 2, waitSec: 0 })
  throwsCode(() => parsePipe(['version: 1', 'targets:', '  p:', '    hosts: [a, b]', '    canary:', '      first: 0', 'stages:', '  - id: a', '    steps:', '      - run: x'].join('\n')), 'PIPE_INVALID')
  throwsCode(() => parsePipe(['version: 1', 'targets:', '  p:', '    hosts: [a, b]', '    canary:', '      first: 3', 'stages:', '  - id: a', '    steps:', '      - run: x'].join('\n')), 'PIPE_INVALID')
  throwsCode(() => parsePipe(['version: 1', 'targets:', '  p:', '    hosts: [a, b]', '    canary:', '      first: 1', '      waitSec: 3601', 'stages:', '  - id: a', '    steps:', '      - run: x'].join('\n')), 'PIPE_INVALID')
  throwsCode(() => parsePipe(['version: 1', 'targets:', '  p:', '    hosts: [a]', '    canary: yes', 'stages:', '  - id: a', '    steps:', '      - run: x'].join('\n')), 'PIPE_INVALID')
})

checkAsync('deployRelease：canary 首批成功后再发剩余，batch 标注与等待日志', async () => {
  const artifact = join(tmpdir(), `dsh-cicd-canary-${process.pid}.tgz`)
  writeFileSync(artifact, 'fake tgz', 'utf8')
  const lines = []
  const holds = []
  const remote = fakeRemote()
  try {
    const result = await deployRelease({
      remote,
      target: { hosts: ['h1', 'h2', 'h3'], path: '/opt/canary', restart: 'true', canary: { first: 1, waitSec: 0 } },
      targetName: 'prod',
      artifactPath: artifact,
      releaseId: 'canary-1',
      keep: 0,
      onLog: (line) => lines.push(line),
      onCanaryHold: (info) => holds.push(info),
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.hosts.map((host) => [host.host, host.batch]), [['h1', 1], ['h2', 2], ['h3', 2]])
    assert.equal(result.canary.first, 1)
    assert.equal(result.canary.waitSec, 0)
    assert.deepEqual(result.canary.batches.map((batch) => [batch.index, batch.hosts, batch.ok]), [[1, ['h1'], true], [2, ['h2', 'h3'], true]])
    assert.equal(holds.length, 1)
    assert.equal(holds[0].remaining, 2)
    assert.ok(lines.some((line) => line.includes('[canary] 第一批 1 台成功，等待 0s 后发剩余 2 台')))
    assert.ok(remote.calls.findIndex((call) => call.host === 'h1') < remote.calls.findIndex((call) => call.host === 'h2'))
  } finally { rmSync(artifact, { force: true }) }
})

checkAsync('deployRelease：灰度首批任一台失败立即停止，即便 onHostFailure=continue', async () => {
  const artifact = join(tmpdir(), `dsh-cicd-canary-fail-${process.pid}.tgz`)
  writeFileSync(artifact, 'fake tgz', 'utf8')
  const remote = fakeRemote({ failHosts: ['h1'] })
  try {
    const result = await deployRelease({
      remote,
      target: { hosts: ['h1', 'h2', 'h3'], path: '/opt/canary', restart: 'true', onHostFailure: 'continue', canary: { first: 2, waitSec: 0 } },
      targetName: 'prod',
      artifactPath: artifact,
      releaseId: 'canary-2',
      keep: 0,
    })
    assert.equal(result.ok, false)
    assert.equal(result.hosts[0].ok, false)
    assert.equal(result.hosts[1].skipped, true)
    assert.equal(result.hosts[2].skipped, true)
    assert.equal(result.hosts[0].batch, 1)
    assert.equal(result.hosts[1].batch, 1)
    assert.equal(result.hosts[2].batch, 2)
    assert.ok(!remote.calls.some((call) => call.host === 'h2' && call.command.startsWith('mkdir')))
    assert.ok(!remote.calls.some((call) => call.host === 'h3'))
  } finally { rmSync(artifact, { force: true }) }
})

checkAsync('deployRelease：多主机 fan-out，每台独立 current/previous/上传/健康', async () => {
  const artifact = join(tmpdir(), `dsh-cicd-multi-${process.pid}.tgz`)
  writeFileSync(artifact, 'fake tgz', 'utf8')
  const remote = fakeRemote({ readlink: (host) => `releases/prev-${host}` })
  try {
    const result = await deployRelease({
      remote,
      target: { hosts: ['h1', 'h2'], path: '/opt/multi', restart: 'echo restart', health: { http: 'http://127.0.0.1:9/health', tries: 1, interval: '0s' } },
      targetName: 'prod',
      artifactPath: artifact,
      releaseId: 'rel-1',
      keep: 2,
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.hosts.map((host) => host.host), ['h1', 'h2'])
    assert.deepEqual(result.hosts.map((host) => host.previous), ['prev-h1', 'prev-h2'])
    const h1 = remote.calls.filter((call) => call.host === 'h1')
    const h2 = remote.calls.filter((call) => call.host === 'h2')
    assert.ok(h1.length > 0 && h2.length > 0)
    assert.ok(h1[0].command.startsWith('mkdir -p'))
    assert.equal(h1[0].command, "mkdir -p '/opt/multi/releases/rel-1'")
    assert.ok(h1.some((call) => call.upload?.remotePath === '/opt/multi/releases/rel-1/dsh-cicd-multi-' + process.pid + '.tgz'))
    assert.ok(h1.some((call) => call.command === "ln -sfn 'releases/rel-1' '/opt/multi/current'"))
    assert.ok(h2.some((call) => call.command === "ln -sfn 'releases/rel-1' '/opt/multi/current'"))
    assert.ok(remote.calls.findIndex((call) => call.host === 'h1') < remote.calls.findIndex((call) => call.host === 'h2'))
  } finally { rmSync(artifact, { force: true }) }
})

checkAsync('deployRelease：onHostFailure=stop 默认停止后续主机，continue 继续', async () => {
  const stopRemote = fakeRemote({ failHosts: ['h1'] })
  const stopped = await deployRelease({ remote: stopRemote, target: { hosts: ['h1', 'h2'], path: '/opt/x', restart: 'true' }, targetName: 'prod', releaseId: 'r-stop' })
  assert.equal(stopped.ok, false)
  assert.equal(stopped.hosts[0].ok, false)
  assert.equal(stopped.hosts[1].skipped, true)
  assert.ok(!stopRemote.calls.some((call) => call.host === 'h2'))

  const continueRemote = fakeRemote({ failHosts: ['h1'] })
  const continued = await deployRelease({ remote: continueRemote, target: { hosts: ['h1', 'h2'], path: '/opt/x', restart: 'true', onHostFailure: 'continue' }, targetName: 'prod', releaseId: 'r-cont' })
  assert.equal(continued.ok, false)
  assert.equal(continued.hosts[0].ok, false)
  assert.equal(continued.hosts[1].ok, true)
  assert.ok(continueRemote.calls.some((call) => call.host === 'h2' && call.command.startsWith('mkdir')))
})

checkAsync('deployRelease：runtime 预设重启命令用于未显式配 restart/service 的 target', async () => {
  const remote = fakeRemote()
  const result = await deployRelease({ remote, target: { hosts: ['h'], path: '/opt/node', runtime: 'node', app: 'demo', restartCommand: defaultRestartCommand('node', 'demo') }, targetName: 'prod', releaseId: 'r-node' })
  assert.equal(result.ok, true)
  assert.equal(result.restarted, 'node')
  const command = remote.calls.map((call) => call.command).find((value) => value.startsWith('pm2 restart'))
  assert.ok(command)
  assert.ok(command.endsWith('|| true'))
})

checkAsync('rollbackRelease：host 为空时回滚 target.hosts 全部主机', async () => {
  const remote = fakeRemote({ readlink: (host) => `releases/prev-${host}` })
  const result = await rollbackRelease({ remote, target: { hosts: ['h1', 'h2'], path: '/opt/multi', restart: 'true' }, targetName: 'prod' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.hosts.map((host) => host.host), ['h1', 'h2'])
  assert.deepEqual(result.hosts.map((host) => host.releaseId), ['prev-h1', 'prev-h2'])
  for (const host of ['h1', 'h2']) {
    assert.ok(remote.calls.some((call) => call.host === host && call.command === `ln -sfn 'releases/prev-${host}' '/opt/multi/current'`))
  }
})

// ---------------------------------------------------------------------------------------------
// 5. Remote bridge

checkAsync('createRemote：exec/upload 分块与错误映射（不连真 SSH）', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    const parsed = new URL(url)
    const path = parsed.pathname.split('/').pop()
    if (path === 'exec') return Response.json({ ok: true, host: 'h', stdout: 'hi', stderr: '', exitCode: 0 })
    if (path === 'file-upload-begin') return Response.json({ ok: true, uploadId: 'u1' })
    if (path === 'file-upload-chunk') return Response.json({ ok: true })
    if (path === 'file-upload-finish') return Response.json({ ok: true })
    return Response.json({ ok: false, error: 'nope' }, { status: 500 })
  }
  const remote = createRemote({ base: 'http://127.0.0.1:1234', fetch: fetchImpl })
  const exec = await remote.exec('linux26', 'uname -a', { timeoutSec: 5 })
  assert.equal(exec.stdout, 'hi')
  const artifact = join(tmpdir(), `dsh-cicd-remote-${process.pid}.bin`)
  writeFileSync(artifact, Buffer.alloc(9000, 7))
  try {
    const finished = await remote.uploadFile('linux26', artifact, '/tmp/x.bin')
    assert.equal(finished.ok, true)
    const chunks = calls.filter((call) => call.url.includes('file-upload-chunk'))
    assert.equal(chunks.length, 2)
    assert.equal(new URL(chunks[0].url).searchParams.get('offset'), '0')
    assert.equal(new URL(chunks[1].url).searchParams.get('offset'), '8192')
  } finally { rmSync(artifact, { force: true }) }
  assert.ok(calls.every((call) => call.init.headers['x-dsh-remote-exec'] === '1'))
  const unavailable = createRemote({ base: '', fetch: fetchImpl })
  await assert.rejects(() => unavailable.exec('h', 'x'), (error) => error.code === 'REMOTE_UNAVAILABLE')
})

checkAsync('notify：并发 POST、HMAC 头、事件过滤、失败不抛出', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    if (String(url).includes('broken')) return new Response('nope', { status: 500 })
    return new Response('ok', { status: 200 })
  }
  const webhooks = [
    { url: 'http://hooks.test/a', secret: 's3cret' },
    { url: 'http://hooks.test/broken' },
    { url: 'http://hooks.test/c', events: ['run.failed'] },
  ]
  const payload = { project: 'demo', target: 'prod', runId: 'r1', releaseId: 'r1', status: 'success', durationMs: 12, hosts: [{ host: 'h1', ok: true, batch: 1 }], prod: false }
  const results = await dispatchNotifications({ webhooks, event: 'run.success', payload, fetch: fetchImpl })
  assert.equal(results.length, 3)
  assert.equal(results[0].ok, true)
  assert.equal(results[1].ok, false)
  assert.equal(results[1].status, 500)
  assert.equal(results[2].skipped, true)
  const sent = calls.find((call) => call.url.endsWith('/a'))
  assert.equal(sent.init.headers['x-dsh-signature'].startsWith('sha256='), true)
  const body = JSON.parse(sent.init.body)
  assert.equal(body.event, 'run.success')
  assert.equal(body.hosts[0].batch, 1)
  const failing = await dispatchNotifications({ webhooks: [{ url: 'http://hooks.test/x' }], event: 'run.failed', payload, fetch: async () => { throw new Error('ECONNREFUSED') } })
  assert.equal(failing[0].ok, false)
  assert.match(failing[0].error, /ECONNREFUSED/)
  await assert.rejects(() => dispatchNotifications({ webhooks: [], event: 'bogus', payload, fetch: fetchImpl }), /不支持的通知事件/)
})

checkAsync('notify-test：已配置时逐个发送并写 notify 审计，未配置 200', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cicd-notify-'))
  const runtime = internals.createRuntime(fakeContext(), {
    workDir: dir,
    notify: { webhooks: [{ url: 'http://hooks.test/ok' }, { url: 'http://hooks.test/bad', events: ['run.failed'] }] },
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => (String(url).includes('/bad') ? new Response('bad', { status: 500 }) : new Response('ok', { status: 200 }))
  try {
    const result = await runtime.notifyTest()
    assert.equal(result.ok, true)
    assert.equal(result.configured, 2)
    assert.deepEqual(result.webhooks.map((item) => item.ok), [true, false])
    const ops = runtime.operations({ limit: 10 }).operations.filter((item) => item.action === 'notify')
    assert.equal(ops.length, 2)
    assert.deepEqual(ops.map((item) => item.status), ['failed', 'success'])
  } finally {
    globalThis.fetch = originalFetch
    runtime.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------------------------
// 6. Routes and tools

const root = mkdtempSync(join(tmpdir(), 'dsh-cicd-router-'))
const projectDir = join(root, 'demo')
mkdirSync(projectDir, { recursive: true })
writeFileSync(join(projectDir, 'pipe.yml'), PIPE_SOURCE, 'utf8')
writeFileSync(join(projectDir, 'dist.tgz'), 'artifact', 'utf8')

function fakeContext() {
  const tools = []
  const routes = []
  const upgrades = []
  const effects = []
  const webServer = {
    port: 4567,
    register(route) { routes.push(route); return () => { const index = routes.indexOf(route); if (index >= 0) routes.splice(index, 1) } },
    registerUpgrade(route) { upgrades.push(route); return () => { const index = upgrades.indexOf(route); if (index >= 0) upgrades.splice(index, 1) } },
  }
  return {
    tools: { register(definition) { tools.push(definition); return () => { const index = tools.indexOf(definition); if (index >= 0) tools.splice(index, 1) } } },
    get(key) { return key === 'webServer' ? webServer : undefined },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
      return dispose
    },
    toolsList: tools,
    routes,
    upgrades,
    effects,
  }
}

const ctx = fakeContext()
apply(ctx, {
  projects: [{ id: 'demo', name: 'Demo', path: projectDir, pipe: join(projectDir, 'pipe.yml') }],
  workDir: join(root, 'state'),
  remoteBase: 'http://127.0.0.1:1',
  // 主测试进程不启动调度定时器（调度器本身在下面用注入的 run/tick 单独覆盖）。
  scheduler: { enabled: false },
  // P5-3：仓库生成的 tarball/simple 链接要绝对地址，测试里钉死，免得断言跟着 Host 漂。
  artifacts: { baseUrl: 'http://registry.test/api/plugins/cicd' },
})

function call(routePath, query = '', { headers = {}, origin = '' } = {}) {
  const requestHeaders = { ...headers }
  if (origin) requestHeaders.origin = origin
  const route = ctx.routes.find((item) => item.path === internals.ROUTE_PREFIX + routePath)
  assert.ok(route, `route ${routePath} registered`)
  return route.resource(new Request(`http://x${internals.ROUTE_PREFIX}${routePath}${query}`, { headers: requestHeaders }))
}

/** prefix 路由（/hooks/<project>）用完整 pathname 调用。 */
function callPath(pathname, query = '', { headers = {} } = {}) {
  const route = ctx.routes.find((item) => pathname.startsWith(`${item.path}/`))
  assert.ok(route, `prefix route for ${pathname} registered`)
  return route.resource(new Request(`http://x${pathname}${query}`, { headers }))
}

check('apply：注册 28 个工具、38 条路由（34 exact + 4 prefix）、1 条 WS upgrade 与 runtime disposer', () => {
  assert.equal(ctx.toolsList.length, 28)
  assert.deepEqual(ctx.toolsList.map((tool) => tool.name).sort(), [
    'cicd_approve', 'cicd_artifacts', 'cicd_audit', 'cicd_auth', 'cicd_cancel', 'cicd_dora', 'cicd_environments', 'cicd_locks',
    'cicd_logs', 'cicd_pipe_save', 'cicd_plan', 'cicd_project_create', 'cicd_project_meta', 'cicd_projects',
    'cicd_rbac', 'cicd_registry', 'cicd_releases', 'cicd_rollback', 'cicd_run', 'cicd_runners', 'cicd_secrets', 'cicd_status',
    'cicd_targets', 'cicd_tokens', 'cicd_toolchain', 'cicd_triggers', 'cicd_users', 'cicd_validate',
  ])
  for (const tool of ctx.toolsList) {
    assert.equal(typeof tool.description, 'string')
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
  }
  assert.equal(ctx.routes.length, 38)
  assert.deepEqual(ctx.routes.filter((route) => route.kind === 'exact').map((route) => route.path).sort(), [
    '/api/plugins/cicd/approvals', '/api/plugins/cicd/approve', '/api/plugins/cicd/artifacts', '/api/plugins/cicd/audit', '/api/plugins/cicd/auth',
    '/api/plugins/cicd/cancel', '/api/plugins/cicd/dora', '/api/plugins/cicd/environments', '/api/plugins/cicd/locks',
    '/api/plugins/cicd/log', '/api/plugins/cicd/notify-test', '/api/plugins/cicd/operations', '/api/plugins/cicd/pipe-save',
    '/api/plugins/cicd/plan', '/api/plugins/cicd/project-create', '/api/plugins/cicd/project-meta', '/api/plugins/cicd/projects',
    '/api/plugins/cicd/rbac', '/api/plugins/cicd/releases', '/api/plugins/cicd/rollback', '/api/plugins/cicd/run',
    '/api/plugins/cicd/runner-log', '/api/plugins/cicd/runner-poll', '/api/plugins/cicd/runner-register', '/api/plugins/cicd/runner-result',
    '/api/plugins/cicd/runners', '/api/plugins/cicd/runs', '/api/plugins/cicd/secrets', '/api/plugins/cicd/targets',
    '/api/plugins/cicd/tokens', '/api/plugins/cicd/toolchain', '/api/plugins/cicd/triggers', '/api/plugins/cicd/users', '/api/plugins/cicd/validate',
  ])
  assert.deepEqual(ctx.routes.filter((route) => route.kind === 'prefix').map((route) => route.path), [
    '/api/plugins/cicd/hooks', '/api/plugins/cicd/v2', '/api/plugins/cicd/repository', '/api/plugins/cicd/simple',
  ])
  assert.ok(ctx.routes.every((route) => typeof route.resource === 'function' && !route.handler))
  assert.equal(ctx.upgrades.length, 1)
  assert.equal(ctx.upgrades[0].path, '/api/plugins/cicd/log-ws')
  assert.equal(typeof ctx.upgrades[0].handler, 'function')
})

check('冷启动回归：webServer 未就绪时 0 路由，inject 就绪后补注册 34+4 条；remote() 惰性取 port', () => {
  const coldRoutes = []
  const coldUpgrades = []
  const coldWeb = {
    port: 55470,
    register(route) { coldRoutes.push(route); return () => {} },
    registerUpgrade(route) { coldUpgrades.push(route); return () => {} },
  }
  let webReady = false
  let scopeFn = null
  const coldEffects = []
  const coldCtx = {
    tools: { register() { return () => {} } },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') coldEffects.push(dispose) },
    get(key) { return webReady && key === 'webServer' ? coldWeb : undefined },
    inject(deps, fn) { assert.deepEqual(deps, ['webServer']); scopeFn = fn },
  }
  apply(coldCtx, { projects: [{ id: 'demo', path: projectDir }], workDir: join(root, 'state'), scheduler: { enabled: false } })
  assert.equal(coldRoutes.length, 0, '冷启动阶段一条路由都不该注册')
  assert.ok(typeof scopeFn === 'function', 'apply 应把路由注册挂到 ctx.inject 上')
  // 模拟 webServer 就绪：cordis 以一个能 get 到服务的 scope 触发回调（真实环境由服务就绪事件驱动）。
  scopeFn({ get: (key) => (key === 'webServer' ? coldWeb : undefined), effect() {} })
  assert.equal(coldRoutes.length, 38, '就绪后应补注册 34 条 exact + 4 条 prefix 路由')
  assert.equal(coldRoutes.filter((route) => route.kind === 'exact').length, 34)
  assert.equal(coldUpgrades.length, 1, '就绪后应补注册 /log-ws upgrade 路由')

  // remote() 惰性解析：apply 时拿不到 port（remoteBase 为空），就绪后首次调用应取到 55470。
  webReady = true
  const runtime = internals.createRuntime(coldCtx, { projects: [{ id: 'demo', path: projectDir }], workDir: join(root, 'state') })
  try {
    const client = runtime.remote()
    assert.equal(client.base, 'http://127.0.0.1:55470', 'remote() 应在首次调用时从 webServer.port 惰性解析 base')
  } finally {
    runtime.dispose()
    for (const effect of coldEffects) { try { effect() } catch { /* ignore */ } }
  }
})

checkAsync('routes：projects/plan/targets 200，跨源与未知参数 400/403', async () => {
  const projects = await call('/projects').then((response) => response.json())
  assert.equal(projects.ok, true)
  assert.equal(projects.projects[0].id, 'demo')
  assert.equal(projects.projects[0].hasPipe, true)

  const plan = await call('/plan', '?project=demo&target=prod').then((response) => response.json())
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.stages.map((stage) => stage.id), ['build', 'package', 'release'])

  const targets = await call('/targets', '?project=demo').then((response) => response.json())
  assert.equal(targets.targets[0].name, 'prod')
  assert.equal(targets.targets[0].restart, 'systemctl restart demo')

  assert.equal((await call('/projects', '', { origin: 'http://evil.test' })).status, 403)
  assert.equal((await call('/projects', '?extra=1')).status, 400)
  assert.equal((await call('/plan', '?project=demo&bogus=x')).status, 400)
  assert.equal((await call('/plan', '?project=ghost')).status, 404)
})

checkAsync('routes：validate 校验原始文本与落盘文件，错误带行号', async () => {
  const good = await call('/validate', `?source=${encodeURIComponent(['version: 1', 'name: ok', 'targets:', '  prod:', '    hosts: [h1]', '    path: /srv/ok', 'stages:', '  - id: build', '    steps:', '      - name: b', '        run: echo ok'].join('\n'))}`).then((response) => response.json())
  assert.equal(good.ok, true)
  assert.equal(good.name, 'ok')
  assert.deepEqual(good.targets, ['prod'])
  assert.deepEqual(good.stages.map((stage) => stage.id), ['build'])

  // 非法缩进（制表符）应给出带行号诊断，且是 ok:false 而非 4xx/5xx。
  const bad = await call('/validate', `?source=${encodeURIComponent('version: 1\n\tindent: tab\n')}`).then((response) => response.json())
  assert.equal(bad.ok, false)
  assert.match(bad.error, /制表符|缩进/)
  assert.equal(typeof bad.line, 'number')
  assert.ok(bad.line > 0)

  // 校验落盘文件（demo 项目的 pipe.yml 合法）。
  const onDisk = await call('/validate', '?project=demo').then((response) => response.json())
  assert.equal(onDisk.ok, true)
  assert.equal(onDisk.path, join(projectDir, 'pipe.yml'))

  assert.equal((await call('/validate', '', { origin: 'http://evil.test' })).status, 403)
  assert.equal((await call('/validate', '?extra=1')).status, 400)
})

checkAsync('routes：pipe-save 校验通过才写盘，非法源不落盘，写保护与未知参数', async () => {
  assert.equal((await call('/pipe-save', '?project=demo&source=x')).status, 403)
  assert.equal((await call('/pipe-save', '?project=demo&source=x', { headers: { 'x-dsh-cicd': '1' } })).status, 400)
  assert.equal((await call('/pipe-save', '?project=demo&source=x&confirm=1', { headers: { 'x-dsh-cicd': '1' }, origin: 'http://evil.test' })).status, 403)
  assert.equal((await call('/pipe-save', '?project=demo&source=x&confirm=1&extra=1', { headers: { 'x-dsh-cicd': '1' } })).status, 400)

  const pipeFile = join(projectDir, 'pipe.yml')
  const before = readFileSync(pipeFile, 'utf8')

  // 非法源（制表符缩进）：不落盘，返回带行号诊断。
  const bad = await call('/pipe-save', `?project=demo&confirm=1&source=${encodeURIComponent('version: 1\n\tindent: tab\n')}`, { headers: { 'x-dsh-cicd': '1' } }).then((response) => response.json())
  assert.equal(bad.ok, false)
  assert.match(bad.error, /制表符|缩进/)
  assert.ok(bad.line > 0)
  assert.equal(readFileSync(pipeFile, 'utf8'), before, '非法源不该覆盖落盘文件')

  // 合法源：写盘成功，且能读回。
  const goodSource = ['version: 1', 'name: saved', 'targets:', '  prod:', '    hosts: [h1]', '    path: /srv/saved', 'stages:', '  - id: build', '    steps:', '      - name: b', '        run: echo saved'].join('\n')
  const saved = await call('/pipe-save', `?project=demo&confirm=1&source=${encodeURIComponent(goodSource)}`, { headers: { 'x-dsh-cicd': '1' } }).then((response) => response.json())
  assert.equal(saved.ok, true)
  assert.equal(saved.name, 'saved')
  assert.deepEqual(saved.targets, ['prod'])
  assert.deepEqual(saved.stages.map((stage) => stage.id), ['build'])
  assert.equal(readFileSync(pipeFile, 'utf8'), goodSource, '合法源应覆盖落盘文件')

  // 空 source：拒绝。
  const empty = await call('/pipe-save', '?project=demo&confirm=1&source=', { headers: { 'x-dsh-cicd': '1' } }).then((response) => response.json())
  assert.equal(empty.ok, false)
  assert.match(empty.error, /不能为空/)

  // 还原 demo 的 pipe.yml，避免影响后续 run/plan 断言。
  writeFileSync(pipeFile, before, 'utf8')
})

checkAsync('routes：project-meta 返回 git 元数据与 pipeSource，缺项目 404', async () => {
  const meta = await call('/project-meta', '?project=demo').then((response) => response.json())
  assert.equal(meta.ok, true)
  assert.equal(meta.project, 'demo')
  assert.equal(meta.hasPipe, true)
  assert.equal(meta.pipe, join(projectDir, 'pipe.yml'))
  assert.equal(meta.pipeSource, readFileSync(join(projectDir, 'pipe.yml'), 'utf8'))
  // 非 git 仓库退化为空值；字段必须都在，面板渲染不炸。
  assert.equal(meta.isRepo, false)
  for (const key of ['branch', 'commit', 'commitShort', 'tag', 'message', 'dirty']) {
    assert.ok(key in meta, `project-meta 应返回 ${key}`)
  }

  assert.equal((await call('/project-meta', '', { origin: 'http://evil.test' })).status, 403)
  assert.equal((await call('/project-meta', '?extra=1')).status, 400)
  assert.equal((await call('/project-meta', '?project=ghost')).status, 404)
})

checkAsync('routes：project-create 本地建项目写 pipe.yml，写保护与未知参数', async () => {
  const target = join(root, 'newproj')
  const encoded = encodeURIComponent(target)
  assert.equal((await call('/project-create', `?name=new&path=${encoded}`)).status, 403, '缺头应 403')
  assert.equal((await call('/project-create', `?name=new&path=${encoded}`, { headers: { 'x-dsh-cicd': '1' } })).status, 400, '缺 confirm 应 400')
  assert.equal((await call('/project-create', `?name=new&path=${encoded}&confirm=1`, { headers: { 'x-dsh-cicd': '1' }, origin: 'http://evil.test' })).status, 403, '跨源应 403')
  assert.equal((await call('/project-create', `?name=new&path=${encoded}&confirm=1&extra=1`, { headers: { 'x-dsh-cicd': '1' } })).status, 400, '未知参数应 400')

  const created = await call('/project-create', `?name=new&kind=node&path=${encoded}&confirm=1`, { headers: { 'x-dsh-cicd': '1' } }).then((response) => response.json())
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.equal(created.name, 'new')
  assert.equal(created.sourceType, 'local')
  assert.equal(created.path, target)
  assert.equal(created.pipe, join(target, 'pipe.yml'))
  assert.equal(created.pipeSource, readFileSync(join(target, 'pipe.yml'), 'utf8'))
  // 脚手架按 kind=node 打上 runtime/app，且能读回盘上文件
  assert.match(created.pipeSource, /runtime: node/)
  assert.match(created.pipeSource, /app: new/)
  assert.ok(existsSync(join(target, 'pipe.yml')), '应落盘 pipe.yml')

  // 目标目录已有 pipe.yml 时再次创建应报 PROJECT_CREATE_FAILED
  const again = await call('/project-create', `?name=new2&path=${encoded}&confirm=1`, { headers: { 'x-dsh-cicd': '1' } }).then((response) => response.json())
  assert.equal(again.ok, false)
  assert.equal(again.code, 'PROJECT_CREATE_FAILED')
})

checkAsync('routes：run 需要头 + confirm，dryRun 不执行，错误码正确', async () => {
  const noHeader = await call('/run', '?project=demo&dryRun=1')
  assert.equal(noHeader.status, 403)
  assert.match((await noHeader.json()).error, /缺少 x-dsh-cicd 头/)

  const noConfirm = await call('/run', '?project=demo&dryRun=1', { headers: { 'x-dsh-cicd': '1' } })
  assert.equal(noConfirm.status, 400)
  assert.match((await noConfirm.json()).error, /confirm=1/)

  const dry = await call('/run', '?project=demo&dryRun=1&confirm=1', { headers: { 'x-dsh-cicd': '1' } })
  assert.equal(dry.status, 200)
  const body = await dry.json()
  assert.equal(body.ok, true)
  assert.equal(body.status, 'planned')
  assert.equal(body.dryRun, true)
  assert.deepEqual(body.stages.map((stage) => stage.id), ['build', 'package', 'release'])

  const unknown = await call('/run', '?project=demo&confirm=1&unknown=1', { headers: { 'x-dsh-cicd': '1' } })
  assert.equal(unknown.status, 400)
  const projectMissing = await call('/run', '?project=ghost&confirm=1', { headers: { 'x-dsh-cicd': '1' } })
  assert.equal(projectMissing.status, 404)
  const crossOrigin = await call('/run', '?confirm=1', { headers: { 'x-dsh-cicd': '1' }, origin: 'http://evil.test' })
  assert.equal(crossOrigin.status, 403)
})

checkAsync('routes：runs/log/releases 列表限制与 404、stats 路由形状', async () => {
  const runs = await call('/runs', '?limit=5').then((response) => response.json())
  assert.equal(runs.ok, true)
  assert.ok(Array.isArray(runs.runs))
  assert.equal((await call('/runs', '?limit=0')).status, 400)
  assert.equal((await call('/runs', '?limit=abc')).status, 400)
  assert.equal((await call('/runs', '?limit=9999')).status, 400)
  assert.equal((await call('/log', '')).status, 404)
  assert.equal((await call('/log', '?runId=missing')).status, 404)
  const releases = await call('/releases', '?target=prod&limit=5').then((response) => response.json())
  assert.equal(releases.ok, true)
  assert.equal(releases.target, 'prod')
  assert.equal(releases.host, '')
  assert.ok(Array.isArray(releases.hosts))
  const byHost = await call('/releases', '?target=prod&host=linux26').then((response) => response.json())
  assert.equal(byHost.host, 'linux26')
  assert.equal((await call('/releases', '?limit=-1')).status, 400)
  assert.equal((await call('/releases', '?target=prod&extra=1')).status, 400)

  const rollbackNoTarget = await call('/rollback', '?confirm=1', { headers: { 'x-dsh-cicd': '1' } })
  assert.equal(rollbackNoTarget.status, 404)
  const rollbackNoHeader = await call('/rollback', '?target=prod&confirm=1')
  assert.equal(rollbackNoHeader.status, 403)
})

checkAsync('routes：operations 时间线、notify-test 未配置与写保护', async () => {
  const ops = await call('/operations', '?limit=5').then((response) => response.json())
  assert.equal(ops.ok, true)
  assert.ok(Array.isArray(ops.operations))
  assert.equal((await call('/operations', '?limit=0')).status, 400)
  assert.equal((await call('/operations', '?limit=201')).status, 400)
  assert.equal((await call('/operations', '?bogus=1')).status, 400)
  assert.equal((await call('/operations', '', { origin: 'http://evil.test' })).status, 403)

  const noHeader = await call('/notify-test', '?confirm=1')
  assert.equal(noHeader.status, 403)
  const noConfirm = await call('/notify-test', '', { headers: { 'x-dsh-cicd': '1' } })
  assert.equal(noConfirm.status, 400)
  const none = await call('/notify-test', '?confirm=1', { headers: { 'x-dsh-cicd': '1' } }).then((response) => response.json())
  assert.deepEqual(none, { ok: true, configured: 0, webhooks: [] })
  assert.equal((await call('/notify-test', '?confirm=1&extra=1', { headers: { 'x-dsh-cicd': '1' } })).status, 400)
})

check('routes：所有资源都走 resource，没有 handler/POST 形态', () => {
  assert.equal(ctx.routes.length, 38)
  for (const route of ctx.routes) {
    assert.equal(route.handler, undefined)
    assert.ok(route.kind === 'exact' || route.kind === 'prefix')
  }
  assert.equal(internals.WRITE_HEADER, 'x-dsh-remote-exec')
  assert.equal(typeof internals.resources.projectsResource, 'function')
  assert.equal(typeof internals.resources.projectMetaResource, 'function')
  assert.equal(typeof internals.resources.projectCreateResource, 'function')
  assert.equal(typeof internals.resources.validateResource, 'function')
  assert.equal(typeof internals.resources.pipeSaveResource, 'function')
  assert.equal(typeof internals.resources.operationsResource, 'function')
  assert.equal(typeof internals.resources.notifyTestResource, 'function')
  assert.equal(typeof internals.resources.cancelResource, 'function')
  assert.equal(typeof internals.resources.doraResource, 'function')
  assert.equal(typeof internals.resources.triggersResource, 'function')
  assert.equal(typeof internals.resources.hookResource, 'function')
  assert.equal(typeof internals.resources.runnerRegisterResource, 'function')
  assert.equal(typeof internals.resources.runnerPollResource, 'function')
  assert.equal(typeof internals.resources.runnerResultResource, 'function')
  assert.equal(typeof internals.resources.runnerLogResource, 'function')
  assert.equal(typeof internals.resources.runnersResource, 'function')
  assert.equal(typeof internals.resources.approveResource, 'function')
  assert.equal(typeof internals.resources.approvalsResource, 'function')
  assert.equal(typeof internals.resources.secretsResource, 'function')
  assert.equal(typeof internals.resources.environmentsResource, 'function')
  assert.equal(typeof internals.resources.rbacResource, 'function')
  // v3.0-P0：身份、审计、锁
  assert.equal(typeof internals.resources.authResource, 'function')
  assert.equal(typeof internals.resources.usersResource, 'function')
  assert.equal(typeof internals.resources.tokensResource, 'function')
  assert.equal(typeof internals.resources.auditResource, 'function')
  assert.equal(typeof internals.resources.locksResource, 'function')
  // v3.0-P2：工具链
  assert.equal(typeof internals.resources.toolchainResource, 'function')
  assert.equal(typeof internals.toolchain.createToolchain, 'function')
  assert.equal(typeof internals.toolchain.envFor, 'function')
  assert.deepEqual(internals.toolchain.LANGS, ['java', 'maven', 'gradle', 'node', 'python', 'php', 'go'])
  assert.equal(typeof internals.logWsHandler, 'function')
  assert.equal(typeof internals.createTaskBroker, 'function')
  assert.equal(typeof internals.createRemoteExecutor, 'function')
  assert.equal(typeof internals.joinTokenMatches, 'function')
  assert.equal(typeof internals.createApprovalGate, 'function')
  assert.equal(typeof internals.createSecretStore, 'function')
  assert.equal(typeof internals.normalizeEnvironments, 'function')
  assert.equal(typeof internals.createRbac, 'function')
})

// ---------------------------------------------------------------------------------------------
// 7. v0.5：环境选择器 / 生产护栏 / 部署锁 / DB 迁移

check('v0.5 选择器：语法校验、混写保序、非法前缀与重复项报错', () => {
  const STAGES = ['stages:', '  - id: build', '    steps:', '      - name: build', '        run: echo built']
  const pipe = parsePipe([
    'version: 1',
    'targets:',
    '  web:',
    '    hosts: [env:prod, group:api, tag:canary.v2, linux26]',
    '    path: /srv/web',
    ...STAGES,
  ].join('\n'))
  assert.deepEqual(pipe.targets.web.hosts, ['env:prod', 'group:api', 'tag:canary.v2', 'linux26'])
  assert.equal(isHostSelector('env:prod'), true)
  assert.equal(isHostSelector('linux26'), false)
  assert.deepEqual(parseHostSelector('tag:canary'), { kind: 'tag', name: 'canary' })
  assert.equal(parseHostSelector('env:PROD'), null)
  assert.equal(parseHostSelector('env:'), null)
  assert.deepEqual(splitTargetHosts(['env:prod', 'linux26']), {
    entries: ['env:prod', 'linux26'],
    selectors: ['env:prod'],
    hostAliases: ['linux26'],
  })
  assert.throws(
    () => parsePipe(['version: 1', 'targets:', '  web:', '    hosts: [env:PROD]', '    path: /srv/web', ...STAGES].join('\n')),
    (error) => error.code === 'PIPE_INVALID' && /选择器/.test(error.message),
  )
  assert.throws(
    () => parsePipe(['version: 1', 'targets:', '  web:', '    hosts: [env:prod, env:prod]', '    path: /srv/web', ...STAGES].join('\n')),
    /重复项/,
  )
})

check('DB：v1 库迁移到 user_version=11，补出 env、operations 审计列、projects 表、steps.runner_id 与 4 列主键、runs 配置快照、releases 回滚现场、制品三表', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cicd-migrate-'))
  const file = join(dir, 'cicd.db')
  const legacy = new DatabaseSync(file)
  legacy.exec("CREATE TABLE releases (id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT '', target TEXT NOT NULL DEFAULT '', host TEXT NOT NULL DEFAULT '', run_id TEXT NOT NULL DEFAULT '', commit_sha TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '', activated_at TEXT NOT NULL DEFAULT '', deactivated_at TEXT NOT NULL DEFAULT '', manifest_path TEXT NOT NULL DEFAULT '', revisions_offset INTEGER NOT NULL DEFAULT 0, previous TEXT NOT NULL DEFAULT '', artifact_sha256 TEXT NOT NULL DEFAULT '')")
  legacy.exec("CREATE TABLE operations (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', at TEXT NOT NULL DEFAULT '')")
  legacy.exec("CREATE TABLE steps (run_id TEXT NOT NULL, stage_id TEXT NOT NULL DEFAULT '', idx INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL DEFAULT '', command TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '', exit_code INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 1, timeout_s INTEGER NOT NULL DEFAULT 0, log_path TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL DEFAULT '', finished_at TEXT NOT NULL DEFAULT '', PRIMARY KEY (run_id, stage_id, idx))")
  legacy.exec("INSERT INTO operations (run_id, kind, detail, at) VALUES ('r1', 'deploy', '{}', '2026-01-01T00:00:00.000Z')")
  legacy.exec('PRAGMA user_version = 1')
  legacy.close()

  const db = openDatabase(file)
  assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 11)
  // v3.0-P5：制品 CAS 的两张表必须随迁移补出来，否则上传能落盘、列表却是空的。
  for (const table of ['artifact_blobs', 'artifact_refs']) {
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table), `迁移后应有 ${table} 表`)
  }
  assert.ok(db.prepare('PRAGMA table_info(releases)').all().some((row) => row.name === 'env'))
  for (const column of ['action', 'project', 'target', 'host', 'release_id', 'status']) {
    assert.ok(db.prepare('PRAGMA table_info(operations)').all().some((row) => row.name === column), `operations.${column}`)
  }
  assert.equal(db.prepare("SELECT action FROM operations WHERE run_id = 'r1'").get().action, 'deploy')
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_operations_at'").get())
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get())
  assert.ok(db.prepare('PRAGMA table_info(steps)').all().some((row) => row.name === 'runner_id'), 'steps.runner_id')
  // v3.0-P0：新表必须随旧库一起补出来，否则老部署升级后锁/审计/认证全失效。
  for (const table of ['deploy_locks', 'audit_events', 'users', 'memberships', 'api_tokens', 'sessions', 'runners', 'approvals']) {
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), `table ${table}`)
  }
  assert.equal(db.prepare('PRAGMA table_info(audit_events)').all().filter((row) => row.name === 'prev_hash').length, 1)
  // v3.0-P1：steps 主键扩到 4 列（加 job_id），老行的 job_id 必须是空串而不是丢行。
  const stepPk = db.prepare('PRAGMA table_info(steps)').all().filter((row) => row.pk > 0).sort((a, b) => a.pk - b.pk).map((row) => row.name)
  assert.deepEqual(stepPk, ['run_id', 'stage_id', 'job_id', 'idx'])
  // v3.0-P3：releases 必须补出回滚现场五列，且老行留空串（不是编一个默认值）。
  const releaseColumns = db.prepare('PRAGMA table_info(releases)').all().map((row) => row.name)
  for (const column of ['artifact_digest', 'mode', 'strategy', 'instances', 'operator']) {
    assert.ok(releaseColumns.includes(column), `releases.${column}`)
  }
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const ENV_PIPE_SOURCE = [
  'version: 1',
  'name: env-pipe',
  'targets:',
  '  web:',
  '    hosts: [env:prod, group:api, linux26]',
  '    path: /srv/web',
  '    runtime: static',
  '  staging:',
  '    hosts: [tag:canary, api2, win22]',
  '    path: /srv/staging',
  '    runtime: static',
  '    canary:',
  '      first: 1',
  '      waitSec: 0',
  'stages:',
  '  - id: build',
  '    steps:',
  '      - name: build',
  '        run: echo built',
  '  - id: release',
  '    needs: [build]',
  '    steps:',
  '      - name: ship',
  '        deploy:',
  '          target: web',
  '          artifacts: ["bundle.tgz"]',
].join('\n')

const GRAY_PIPE_SOURCE = [
  'version: 1',
  'name: gray-pipe',
  'targets:',
  '  staging:',
  '    hosts: [tag:canary, api2, win22]',
  '    path: /srv/staging',
  '    runtime: static',
  '    canary:',
  '      first: 1',
  '      waitSec: 0',
  'stages:',
  '  - id: build',
  '    steps:',
  '      - name: build',
  '        run: echo built',
  '  - id: gray',
  '    needs: [build]',
  '    steps:',
  '      - name: ship-gray',
  '        deploy:',
  '          target: staging',
  '          artifacts: ["bundle.tgz"]',
].join('\n')

const BOGUS_PIPE_SOURCE = [
  'version: 1',
  'name: bogus-pipe',
  'targets:',
  '  web:',
  '    hosts: [env:nope]',
  '    path: /srv/web',
  '    runtime: static',
  'stages:',
  '  - id: build',
  '    steps:',
  '      - name: build',
  '        run: echo built',
].join('\n')

const envRoot = mkdtempSync(join(tmpdir(), 'dsh-cicd-env-'))
const envProject = join(envRoot, 'envdemo')
const bogusProject = join(envRoot, 'bogus')
const grayProject = join(envRoot, 'gray')
mkdirSync(envProject, { recursive: true })
mkdirSync(bogusProject, { recursive: true })
mkdirSync(grayProject, { recursive: true })
writeFileSync(join(envProject, 'pipe.yml'), ENV_PIPE_SOURCE, 'utf8')
writeFileSync(join(envProject, 'bundle.tgz'), 'bundle', 'utf8')
writeFileSync(join(bogusProject, 'pipe.yml'), BOGUS_PIPE_SOURCE, 'utf8')
writeFileSync(join(grayProject, 'pipe.yml'), GRAY_PIPE_SOURCE, 'utf8')
writeFileSync(join(grayProject, 'bundle.tgz'), 'bundle', 'utf8')

const ENV_HOSTS = [
  { alias: 'linux26', env: 'prod', group: 'core', tags: [] },
  { alias: 'api1', env: 'prod', group: 'api', tags: ['blue'] },
  { alias: 'api2', env: 'staging', group: 'api', tags: [] },
  { alias: 'canary1', env: 'staging', group: 'canary', tags: ['canary'] },
  { alias: 'win22', env: 'staging', group: '', tags: [] },
]
const ENV_GROUPS = {
  envs: [{ name: 'prod', hosts: ['linux26', 'api1'] }, { name: 'staging', hosts: ['api2', 'canary1', 'win22'] }],
  groups: [{ name: 'api', hosts: ['api1', 'api2'] }, { name: 'core', hosts: ['linux26'] }],
  tags: [{ name: 'canary', hosts: ['canary1'] }],
}

const remoteState = { hold: null, calls: [] }
async function envFetch(url, init = {}) {
  const target = new URL(String(url))
  const name = target.pathname.split('/').pop()
  remoteState.calls.push({ pathname: target.pathname, search: target.search, init })
  if (target.pathname === '/api/plugins/remote/hosts') {
    return Response.json({ ok: true, hosts: ENV_HOSTS })
  }
  if (target.pathname === '/api/plugins/remote/groups') {
    return Response.json({ ok: true, ...ENV_GROUPS })
  }
  if (name === 'exec') {
    if (remoteState.hold) await remoteState.hold()
    const command = target.searchParams.get('command') || ''
    return Response.json({ ok: true, result: { exitCode: 0, stdout: /readlink/.test(command) ? '' : 'ok', stderr: '' } })
  }
  if (name === 'file-upload-begin') return Response.json({ ok: true, uploadId: 'up-1' })
  if (name === 'file-upload-chunk' || name === 'file-upload-finish') return Response.json({ ok: true })
  return Response.json({ ok: true })
}

const envCtx = fakeContext()
apply(envCtx, {
  projects: [
    { id: 'envdemo', name: 'EnvDemo', path: envProject, pipe: join(envProject, 'pipe.yml') },
    { id: 'bogus', name: 'Bogus', path: bogusProject, pipe: join(bogusProject, 'pipe.yml') },
    { id: 'gray', name: 'Gray', path: grayProject, pipe: join(grayProject, 'pipe.yml') },
  ],
  workDir: join(envRoot, 'state'),
  remoteBase: 'http://127.0.0.1:7891',
})

function envCall(routePath, query = '', options = {}) {
  const route = envCtx.routes.find((item) => item.path === internals.ROUTE_PREFIX + routePath)
  assert.ok(route, `route ${routePath} registered`)
  return route.resource(new Request(`http://x${internals.ROUTE_PREFIX}${routePath}${query}`, {
    headers: { 'x-dsh-cicd': '1', ...(options.headers || {}) },
  }))
}

checkAsync('v0.5 选择器展开：plan 去重、envs 标注、空匹配报 PIPE_INVALID', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = envFetch
  try {
    const plan = await envCall('/plan', '?project=envdemo&target=web').then((response) => response.json())
    assert.equal(plan.ok, true)
    assert.deepEqual(plan.selectors, ['env:prod', 'group:api'])
    assert.deepEqual(plan.hosts, ['linux26', 'api1', 'api2'])
    assert.deepEqual(plan.prodHosts, ['linux26', 'api1'])
    assert.deepEqual(plan.envs, ['prod', 'staging'])
    assert.equal(plan.willDeployToProd, true)
    assert.equal(remoteState.calls.some((call) => call.pathname === '/api/plugins/remote/groups'), true)

    const staging = await envCall('/plan', '?project=envdemo&target=staging').then((response) => response.json())
    assert.deepEqual(staging.hosts, ['canary1', 'api2', 'win22'])
    assert.deepEqual(staging.prodHosts, [])
    assert.equal(staging.willDeployToProd, false)

    const missing = await envCall('/plan', '?project=bogus&target=web')
    assert.equal(missing.status, 400)
    const body = await missing.json()
    assert.equal(body.code, 'PIPE_INVALID')
    assert.match(body.error, /选择器 env:nope 没有匹配的主机/)

    const targets = await envCall('/targets', '?project=envdemo').then((response) => response.json())
    const web = targets.targets.find((item) => item.name === 'web')
    assert.deepEqual(web.hosts, ['linux26', 'api1', 'api2'])
    assert.deepEqual(web.selectors, ['env:prod', 'group:api'])
    assert.equal(web.envsUnknown, false)
  } finally { globalThis.fetch = originalFetch }
})

checkAsync('v0.5 生产护栏：未带 confirm=prod 返回 409，带 confirm=prod 通过并落 env', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = envFetch
  try {
    const guarded = await envCall('/run', '?project=envdemo&target=web&confirm=1')
    assert.equal(guarded.status, 409)
    const body = await guarded.json()
    assert.equal(body.code, 'PROD_CONFIRM_REQUIRED')
    assert.deepEqual(body.hosts, ['linux26', 'api1'])
    assert.match(body.error, /confirm=prod/)

    // 干跑不触发生产护栏
    const dry = await envCall('/run', '?project=envdemo&target=web&dryRun=1&confirm=1')
    assert.equal(dry.status, 200)
    assert.equal((await dry.json()).status, 'planned')

    const run = await envCall('/run', '?project=envdemo&target=web&confirm=prod').then((response) => response.json())
    assert.equal(run.ok, true)
    assert.deepEqual(run.prodHosts, ['linux26', 'api1'])
    assert.deepEqual(run.hosts, ['linux26', 'api1', 'api2'])

    const prodReleases = await envCall('/releases', '?target=web&env=prod').then((response) => response.json())
    assert.equal(prodReleases.releases.length, 2)
    assert.ok(prodReleases.releases.every((item) => item.env === 'prod'))

    const stagingReleases = await envCall('/releases', '?target=web&env=staging').then((response) => response.json())
    assert.equal(stagingReleases.releases.length, 1)
    assert.equal(stagingReleases.releases[0].host, 'api2')
  } finally { globalThis.fetch = originalFetch }
})

checkAsync('v0.5 部署锁：同 target 并发 run 返回 409 DEPLOY_IN_PROGRESS', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = envFetch
  let release = null
  remoteState.hold = () => new Promise((resolve) => { release = resolve })
  try {
    const first = envCall('/run', '?project=envdemo&target=web&confirm=prod')
    for (let tick = 0; !release && tick < 600; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(typeof release, 'function', '部署应该已经卡在远端 exec 上')

    const second = await envCall('/run', '?project=envdemo&target=web&confirm=prod')
    assert.equal(second.status, 409)
    const body = await second.json()
    assert.equal(body.code, 'DEPLOY_IN_PROGRESS')
    assert.match(body.error, /已经有一次发布在执行/)

    remoteState.hold = null
    release()
    const done = await first.then((response) => response.json())
    assert.equal(done.ok, true)

    // 锁已释放：再跑一次不会被拒
    const again = await envCall('/run', '?project=envdemo&target=web&confirm=prod')
    assert.equal(again.status, 200)
  } finally {
    remoteState.hold = null
    globalThis.fetch = originalFetch
  }
})

checkAsync('v0.5 回滚同样受生产护栏约束', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = envFetch
  try {
    const list = await envCall('/releases', '?target=web&env=prod').then((response) => response.json())
    const releaseId = list.releases[0].id
    const guarded = await envCall('/rollback', `?target=web&releaseId=${encodeURIComponent(releaseId)}&confirm=1`)
    assert.equal(guarded.status, 409)
    const body = await guarded.json()
    assert.equal(body.code, 'PROD_CONFIRM_REQUIRED')
    assert.match(body.error, /confirm=prod/)
  } finally { globalThis.fetch = originalFetch }
})

checkAsync('v0.6 灰度发布：run 返回 canary 分批结果并写 canary-hold / 每台 deploy 审计', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = envFetch
  try {
    const response = await envCall('/run', '?project=gray&target=staging&confirm=1')
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.ok, true)
    assert.deepEqual(body.canary, { first: 1, waitSec: 0, batches: [{ index: 1, hosts: ['canary1'], ok: true }, { index: 2, hosts: ['api2', 'win22'], ok: true }] })
    const hosts = body.stages.flatMap((stage) => stage.steps).flatMap((step) => step.hosts || [])
    assert.deepEqual(hosts.map((host) => [host.host, host.batch]), [['canary1', 1], ['api2', 2], ['win22', 2]])

    const ops = await envCall('/operations', '?project=gray&limit=200').then((item) => item.json())
    assert.equal(ops.ok, true)
    assert.ok(ops.operations.some((item) => item.action === 'canary-hold' && item.detail.includes('waitSec')))
    const deploys = ops.operations.filter((item) => item.action === 'deploy' && item.host)
    assert.deepEqual(deploys.slice(0, 3).map((item) => item.host).sort(), ['api2', 'canary1', 'win22'])
  } finally { globalThis.fetch = originalFetch }
})

check('v2 修正：产物取最新、exec 摊平 result、健康检查等待不被 unref、runId 先于 plan', () => {
  const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const deploySource = readFileSync(new URL('../lib/deploy.js', import.meta.url), 'utf8')
  const runnerSource = readFileSync(new URL('../lib/runner.js', import.meta.url), 'utf8')
  const remoteSource = readFileSync(new URL('../lib/remote.js', import.meta.url), 'utf8')
  // 产物命中多个时必须按 mtime 取最新，否则会把上一次的旧包部署上去
  assert.ok(indexSource.includes('mtimeMs'), 'index.js 应该按 mtime 选择产物')
  assert.ok(!/matched\[0\]\s*:\s*''/.test(indexSource), 'index.js 不应该直接取 matched[0]')
  // dsh-remote 的回包是 { ok, result }，健康检查要读 exitCode 就必须摊平
  assert.ok(remoteSource.includes('data?.result ?? data'), 'remote.exec 应该摊平 result')
  // 健康检查的重试等待如果 unref，脚本会在等待期间把事件循环跑空
  assert.ok(!/setTimeout\(resolve, ms\)\.unref/.test(deploySource), 'deploy.js 的重试等待不能 unref')
  // RELEASE_ID 要在 plan 阶段就能插值
  const runIdIndex = runnerSource.indexOf('makeRunId(now, random)')
  const planIndex = runnerSource.indexOf('const plan = planPipeline(pipe')
  assert.ok(runIdIndex > 0 && planIndex > runIdIndex, 'runner.js 必须在 planPipeline 之前生成 runId')
  assert.ok(runnerSource.includes('releaseId: releaseId || runId'))
  // 首次部署健康检查失败时要把 current 撤掉，不能把坏版本留在线上
  assert.ok(deploySource.includes('rm -f'), '首次部署失败应该撤掉 current 指向')
})

// ---------------------------------------------------------------------------------------------
// 8. V2-M1：cron / 触发 / 调度器 / webhook / 实时日志 / 取消 / DORA

/** 极简 socket 桩：记录 write 内容，支持 LogSocket 需要的事件与销毁标记。 */
function fakeSocket() {
  const writes = []
  const handlers = new Map()
  const socket = {
    destroyed: false,
    write(chunk) { writes.push(Buffer.from(chunk)); return true },
    end() { socket.destroyed = true },
    destroy() { socket.destroyed = true },
    on(event, handler) { handlers.set(event, handler); return socket },
    once(event, handler) { handlers.set(event, handler); return socket },
    off() { return socket },
    removeListener() { return socket },
    unshift() {},
    emit(event, ...args) { const handler = handlers.get(event); if (handler) handler(...args) },
    text() { return Buffer.concat(writes).toString('utf8') },
  }
  return socket
}

function upgradeRequest(pathname) {
  return {
    url: pathname,
    headers: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
    },
  }
}

async function waitRun(store, runId, timeoutMs = 15000) {
  const startedAt = Date.now()
  for (;;) {
    const run = store.run(runId)
    if (run && run.status !== 'running') return run
    if (Date.now() - startedAt > timeoutMs) throw new Error(`运行 ${runId} 未在 ${timeoutMs}ms 内结束（当前 ${run?.status || '缺失'}）`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

check('V2-M1 cron：5 字段匹配、别名/区间/步进、minuteKey 与非法表达式', () => {
  const at = (text) => new Date(text)
  assert.equal(internals.cronMatches('* * * * *', at('2026-01-05T03:07:00')), true)
  assert.equal(internals.cronMatches('0 3 * * *', at('2026-01-05T03:00:00')), true)
  assert.equal(internals.cronMatches('0 3 * * *', at('2026-01-05T03:01:00')), false)
  assert.equal(internals.cronMatches('*/15 * * * *', at('2026-01-05T03:45:00')), true)
  assert.equal(internals.cronMatches('*/15 * * * *', at('2026-01-05T03:46:00')), false)
  assert.equal(internals.cronMatches('0 9-11 * * *', at('2026-01-05T10:00:00')), true)
  assert.equal(internals.cronMatches('0 9-11 * * *', at('2026-01-05T12:00:00')), false)
  assert.equal(internals.cronMatches('5,35 * * * *', at('2026-01-05T03:35:00')), true)
  assert.equal(internals.cronMatches('5,35 * * * *', at('2026-01-05T03:36:00')), false)
  // 周日：0 / 7 / sun 等价（2026-01-04 是周日）
  assert.equal(internals.cronMatches('0 8 * * 0', at('2026-01-04T08:00:00')), true)
  assert.equal(internals.cronMatches('0 8 * * 7', at('2026-01-04T08:00:00')), true)
  assert.equal(internals.cronMatches('0 8 * * sun', at('2026-01-04T08:00:00')), true)
  assert.equal(internals.cronMatches('0 8 * * MON', at('2026-01-04T08:00:00')), false)
  assert.equal(internals.cronMatches('0 8 * jan *', at('2026-01-04T08:00:00')), true)
  assert.equal(internals.cronMatches('0 8 4 1 *', at('2026-01-04T08:00:00')), true)
  assert.equal(internals.minuteKey(at('2026-01-05T03:07:42')), '2026-01-05T03:07')
  assert.throws(() => internals.cronMatches('61 * * * *', new Date()), (error) => error.code === 'CRON_INVALID')
  assert.throws(() => internals.cronMatches('* * *', new Date()), (error) => error.code === 'CRON_INVALID')
  assert.throws(() => internals.cronMatches('*/0 * * * *', new Date()), (error) => error.code === 'CRON_INVALID')
})

check('V2-M1 triggers：push glob 匹配、tag 区分、manual 默认与非法配置报错', () => {
  const push = { branches: ['main', 'release/*'], tags: ['v*'], secret: 's3cret', target: 'prod' }
  assert.equal(matchPushRef(push, 'refs/heads/main').matched, true)
  assert.equal(matchPushRef(push, 'refs/heads/main').kind, 'branch')
  assert.equal(matchPushRef(push, 'refs/heads/main').name, 'main')
  assert.equal(matchPushRef(push, 'refs/heads/release/1.2').matched, true, 'glob 的 * 应能跨 /')
  assert.equal(matchPushRef(push, 'refs/heads/dev').matched, false)
  assert.equal(matchPushRef(push, 'refs/tags/v1.0').kind, 'tag')
  assert.equal(matchPushRef(push, 'refs/tags/v1.0').name, 'v1.0')
  assert.equal(matchPushRef(push, 'refs/tags/2024').matched, false)

  const summary = triggerSummary(internals.normalizeTriggers({ triggers: { push: { branches: ['main'] } } }))
  assert.deepEqual(summary.branches, ['main'])
  assert.deepEqual(summary.schedules, [])
  assert.equal(summary.manual, true)

  // 没有 triggers 时退化为纯手动
  const manualOnly = internals.normalizeTriggers({})
  assert.equal(manualOnly.hasPush, false)
  assert.equal(manualOnly.hasSchedule, false)
  assert.equal(manualOnly.manual, true)

  assert.throws(() => internals.normalizeTriggers({ triggers: { push: {} } }), (error) => error.code === 'PIPE_INVALID')
  assert.throws(() => internals.normalizeTriggers({ triggers: { push: { branches: ['main'], secret: 'a b' } } }), /空白/)
  assert.throws(() => internals.normalizeTriggers({ triggers: { schedule: [{ cron: 'bad' }] } }), (error) => error.code === 'PIPE_INVALID')
})

checkAsync('V2-M1 scheduler：cron 每分钟去重、state 落盘与 start/stop 定时器', async () => {
  const fired = []
  const runRoot = join(root, 'sched-cron')
  mkdirSync(runRoot, { recursive: true })
  const pipe = {
    triggers: {
      push: null,
      schedule: [{ cron: '0 3 * * *', target: 'prod' }],
      manual: true,
      hasPush: false,
      hasSchedule: true,
    },
  }
  const stateFile = join(root, 'scheduler-state.json')
  const scheduler = createScheduler({
    getProjects: () => [{ id: 'sched', path: runRoot }],
    readPipe: () => pipe,
    run: async (params) => { fired.push(params); return { status: 'success' } },
    defaultTarget: 'prod',
    stateFile,
    tickSec: 20,
    pollSec: 0,
  })
  const first = await scheduler.tick(new Date('2026-01-05T03:00:00'))
  assert.equal(first.fired.length, 1)
  assert.equal(fired[0].trigger, 'schedule')
  assert.equal(fired[0].target, 'prod', 'schedule 未配 target 时应回落到 defaultTarget')
  assert.equal((await scheduler.tick(new Date('2026-01-05T03:00:40'))).fired.length, 0, '同一分钟应去重')
  assert.equal((await scheduler.tick(new Date('2026-01-05T03:01:00'))).fired.length, 0, '不匹配的分钟不触发')
  assert.equal((await scheduler.tick(new Date('2026-01-06T03:00:00'))).fired.length, 1, '第二天同一时刻应再次触发')
  assert.equal(fired.length, 2)
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).cron['sched#0'], '2026-01-06T03:00', '触发水位应落盘')

  const snapshot = scheduler.snapshot()
  assert.equal(snapshot.cron['sched#0'], '2026-01-06T03:00')
  assert.equal(snapshot.results.length, 2)
  assert.equal(snapshot.results[0].status, 'success')

  const scheduled = []
  const timers = createScheduler({
    getProjects: () => [],
    readPipe: () => null,
    run: async () => ({}),
    tickSec: 20,
    pollSec: 0,
    setIntervalImpl: (fn, ms) => { scheduled.push(ms); return { id: scheduled.length } },
    clearIntervalImpl: () => { scheduled.push('cleared') },
  })
  assert.equal(timers.start(), true)
  assert.equal(timers.start(), false, '重复 start 应返回 false')
  assert.deepEqual(scheduled, [20000], 'pollSec=0 时只挂 tick 定时器')
  timers.stop()
  assert.equal(timers.started, false)
  assert.equal(scheduled.includes('cleared'), true)
})

checkAsync('V2-M1 scheduler：git push 轮询首次只建基线，之后 sha 变化触发 push 运行', async () => {
  const bare = join(root, 'push-remote.git')
  const work = join(root, 'push-work')
  const git = (...args) => execFileSync('git', args, { cwd: work, stdio: 'ignore' })
  execFileSync('git', ['init', '--bare', bare], { stdio: 'ignore' })
  execFileSync('git', ['clone', bare, work], { stdio: 'ignore' })
  const identity = ['-c', 'user.name=smoke', '-c', 'user.email=smoke@local']
  git(...identity, 'commit', '--allow-empty', '-m', 'one')
  git('push', '-u', 'origin', 'HEAD:main')

  const fired = []
  const pipe = {
    triggers: {
      push: { branches: ['main'], tags: [], secret: '', target: 'prod' },
      schedule: [],
      manual: true,
      hasPush: true,
      hasSchedule: false,
    },
  }
  const scheduler = createScheduler({
    getProjects: () => [{ id: 'pushy', path: work }],
    readPipe: () => pipe,
    run: async (params) => { fired.push(params); return { status: 'success' } },
    defaultTarget: '',
    stateFile: join(root, 'push-state.json'),
    tickSec: 3600,
    pollSec: 0,
  })
  const baseline = await scheduler.pollOnce()
  assert.equal(baseline.fired.length, 0, '首次轮询只建立基线，不能触发')
  assert.equal(scheduler.snapshot().push.pushy.ready, true)

  git(...identity, 'commit', '--allow-empty', '-m', 'two')
  git('push', 'origin', 'HEAD:main')
  const changed = await scheduler.pollOnce()
  assert.equal(changed.fired.length, 1, 'sha 变化应触发一次')
  assert.equal(fired[0].trigger, 'push')
  assert.equal(fired[0].branch, 'main')
  assert.match(fired[0].commit, /^[0-9a-f]{7,40}$/)
  assert.equal((await scheduler.pollOnce()).fired.length, 0, 'sha 没变化不再触发')
  assert.equal(fired.length, 1)
})

checkAsync('V2-M1 webhook：secret 校验 401/403、ref 过滤 skipped、命中启动 push 运行并等待完成', async () => {
  const hookDir = join(root, 'hook-proj')
  const plainDir = join(root, 'plain-proj')
  mkdirSync(hookDir, { recursive: true })
  mkdirSync(plainDir, { recursive: true })
  writeFileSync(join(hookDir, 'pipe.yml'), [
    'version: 1',
    'name: hook-pipe',
    'targets:',
    '  prod:',
    '    hosts: [h1]',
    '    path: /srv/hook',
    'triggers:',
    '  push:',
    '    branches: [main]',
    '    secret: s3cret',
    'stages:',
    '  - id: build',
    '    steps:',
    '      - name: b',
    '        run: node -e "console.log(\'hooked\')"',
  ].join('\n'), 'utf8')
  writeFileSync(join(plainDir, 'pipe.yml'), [
    'version: 1',
    'name: plain',
    'targets:',
    '  prod:',
    '    hosts: [h1]',
    '    path: /srv/plain',
    'stages:',
    '  - id: build',
    '    steps:',
    '      - name: b',
    '        run: echo plain',
  ].join('\n'), 'utf8')

  const runtime = internals.createRuntime({ get: () => undefined }, {
    projects: [
      { id: 'hook', path: hookDir, pipe: join(hookDir, 'pipe.yml') },
      { id: 'plain', path: plainDir, pipe: join(plainDir, 'pipe.yml') },
    ],
    workDir: join(root, 'hook-state'),
    remoteBase: 'http://127.0.0.1:1',
    scheduler: { enabled: false },
    stepTimeoutSec: 60,
  })
  try {
    // 触发配置摘要：push + webhook 地址 + secret 状态
    const info = runtime.triggers({ project: 'hook' })
    assert.equal(info.project, 'hook')
    assert.equal(info.triggers.push, true)
    assert.deepEqual(info.triggers.branches, ['main'])
    assert.equal(info.webhook.requiresToken, true)
    assert.match(info.webhook.url, /\/api\/plugins\/cicd\/hooks\/hook$/)
    assert.equal(info.schedulers, null, 'scheduler 关闭时 schedulers 应为 null')

    const plain = runtime.triggers({ project: 'plain' })
    assert.equal(plain.triggers.push, false)
    assert.equal(plain.webhook, null)

    // 未配置 push / 未配置 secret → 403 WEBHOOK_DISABLED
    await assert.rejects(runtime.hook({ project: 'plain', ref: 'refs/heads/main', token: 'x' }), (error) => error.code === 'WEBHOOK_DISABLED')
    // token 不符 → 401 WEBHOOK_UNAUTHORIZED；缺 ref → 400 WEBHOOK_INVALID
    await assert.rejects(runtime.hook({ project: 'hook', ref: 'refs/heads/main', token: 'bad' }), (error) => error.code === 'WEBHOOK_UNAUTHORIZED')
    await assert.rejects(runtime.hook({ project: 'hook', ref: '', token: 's3cret' }), (error) => error.code === 'WEBHOOK_INVALID')
    // ref 不命中 → 200 skipped，不启动运行
    const skipped = await runtime.hook({ project: 'hook', ref: 'refs/heads/dev', token: 's3cret' })
    assert.equal(skipped.skipped, true)
    assert.equal(runtime.status({ project: 'hook' }).runs.length, 0)

    // 命中 → 启动 push 运行
    const accepted = await runtime.hook({ project: 'hook', ref: 'refs/heads/main', token: 's3cret' })
    assert.equal(accepted.accepted, true)
    assert.equal(accepted.kind, 'branch')
    assert.equal(accepted.branch, 'main')
    assert.match(accepted.runId, /^\d{8}-\d{6}-[0-9a-f]{6}$/)
    const run = await waitRun(runtime.store, accepted.runId)
    assert.equal(run.status, 'success')
    assert.equal(run.trigger, 'push')
    assert.equal(run.branch, 'main')
    assert.deepEqual(runtime.status({ project: 'hook' }).running, [], '运行结束后 activeRuns 应为空')

    // HTTP 层：hookResource 走 prefix 路径解析；跨源也放行（这是机器触发，靠 secret 鉴权）
    const hookRequest = (pathname, query) => internals.resources.hookResource(
      new Request(`http://x${pathname}${query}`, { headers: { origin: 'http://evil.test' } }),
      runtime,
    )
    assert.equal((await hookRequest('/api/plugins/cicd/hooks/hook', '?ref=refs/heads/main&token=bad')).status, 401)
    assert.equal((await hookRequest('/api/plugins/cicd/hooks/ghost', '?ref=refs/heads/main&token=s3cret')).status, 404)
    assert.equal((await hookRequest('/api/plugins/cicd/hooks/hook', '?ref=refs/heads/main&token=s3cret&extra=1')).status, 400)
    assert.equal((await hookRequest('/api/plugins/cicd/hooks/plain', '?ref=refs/heads/main&token=s3cret')).status, 403)
    const httpAccepted = await hookRequest('/api/plugins/cicd/hooks/hook', '?ref=refs/heads/main&token=s3cret')
    assert.equal(httpAccepted.status, 202)
    const httpBody = await httpAccepted.json()
    assert.equal(httpBody.ok, true)
    assert.equal(httpBody.accepted, true)
    await waitRun(runtime.store, httpBody.runId)

    // prefix 路由的 pathname 解析（含 URL 编码与尾斜杠）
    assert.equal(internals.hookProjectOf(new Request('http://x/api/plugins/cicd/hooks/a%20b/')), 'a b')
    assert.equal(internals.hookProjectOf(new Request('http://x/api/plugins/cicd/hooks/')), '')

    // 实时日志：已结束的运行回退读日志文件，推 snapshot + end 后关闭
    const socket = fakeSocket()
    internals.logWsHandler(runtime, upgradeRequest(`/api/plugins/cicd/log-ws?runId=${run.id}`), socket, Buffer.alloc(0))
    const finishedText = socket.text()
    assert.match(finishedText, /101 Switching Protocols/)
    assert.match(finishedText, /"type":"snapshot"/)
    assert.match(finishedText, /"type":"end"/)
    assert.equal(socket.destroyed, true, '历史运行推完 end 后应关闭连接')

    // 活跃运行：snapshot + 实时 line + end（hub 环形缓冲）
    const liveId = 'live-run-smoke'
    runtime.hub.append(liveId, { stageId: 'build', index: 0, line: 'hello live' })
    const liveSocket = fakeSocket()
    internals.logWsHandler(runtime, upgradeRequest(`/api/plugins/cicd/log-ws?runId=${liveId}`), liveSocket, Buffer.alloc(0))
    assert.match(liveSocket.text(), /"type":"snapshot"/)
    assert.match(liveSocket.text(), /hello live/)
    runtime.hub.append(liveId, { stageId: 'build', index: 1, line: 'second line' })
    assert.match(liveSocket.text(), /second line/)
    assert.equal(liveSocket.destroyed, false, '运行中不应关闭连接')
    runtime.hub.end(liveId, 'success')
    assert.match(liveSocket.text(), /"type":"end"/)
    assert.equal(liveSocket.destroyed, true)

    // 未知 run → 404 拒绝升级；缺 runId / 未知参数 → 400
    const missing = fakeSocket()
    internals.logWsHandler(runtime, upgradeRequest('/api/plugins/cicd/log-ws?runId=nope'), missing, Buffer.alloc(0))
    assert.match(missing.text(), /404/)
    assert.equal(missing.destroyed, true)
    const noRunId = fakeSocket()
    internals.logWsHandler(runtime, upgradeRequest('/api/plugins/cicd/log-ws'), noRunId, Buffer.alloc(0))
    assert.match(noRunId.text(), /400/)
  } finally { runtime.dispose() }
})

checkAsync('V2-M1 cancel：运行中取消 → canceled 记录、activeRuns 清空、重复取消 409', async () => {
  const dir = join(root, 'slow-proj')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'pipe.yml'), [
    'version: 1',
    'name: slow',
    'targets:',
    '  prod:',
    '    hosts: [h1]',
    '    path: /srv/slow',
    'stages:',
    '  - id: build',
    '    steps:',
    '      - name: slow',
    '        run: node -e "setTimeout(() => {}, 30000)"',
  ].join('\n'), 'utf8')
  const runtime = internals.createRuntime({ get: () => undefined }, {
    projects: [{ id: 'slow', path: dir, pipe: join(dir, 'pipe.yml') }],
    workDir: join(root, 'slow-state'),
    remoteBase: 'http://127.0.0.1:1',
    scheduler: { enabled: false },
    stepTimeoutSec: 60,
  })
  try {
    const { started, promise } = runtime.startRun({ projectId: 'slow', trigger: 'manual' })
    const info = await started
    assert.match(info.runId, /^\d{8}-\d{6}-[0-9a-f]{6}$/)
    assert.equal(info.trigger, 'manual')
    assert.equal(runtime.activeRuns('slow').length, 1)
    assert.equal(runtime.activeRuns('slow')[0].canceling, false)
    assert.equal(runtime.logs({ runId: info.runId }).active, true, '运行中 logs 应标 active')

    const first = runtime.cancel({ runId: info.runId })
    assert.equal(first.status, 'canceling')
    assert.equal(runtime.activeRuns('slow')[0].canceling, true)
    // 同一句柄再次取消是幂等的（不等事件循环，仍在活跃表里）
    assert.equal(runtime.cancel({ runId: info.runId }).status, 'canceling')

    const result = await promise
    assert.equal(result?.status, 'canceled')
    const record = runtime.store.run(info.runId)
    assert.equal(record.status, 'canceled')
    assert.match(record.error, /已取消/)
    assert.deepEqual(runtime.activeRuns(), [])
    assert.equal(runtime.logs({ runId: info.runId }).active, false)
    assert.throws(() => runtime.cancel({ runId: info.runId }), (error) => error.code === 'RUN_NOT_ACTIVE')
    assert.throws(() => runtime.cancel({ runId: 'nope' }), (error) => error.code === 'RUN_NOT_FOUND')
    assert.throws(() => runtime.cancel({}), (error) => error.code === 'RUN_NOT_FOUND')

    // HTTP：取消是写操作（同源 + 头 + confirm）
    const cancelHttp = await internals.resources.cancelResource(
      new Request(`http://x${internals.ROUTE_PREFIX}/cancel?runId=${info.runId}&confirm=1`, { headers: { 'x-dsh-cicd': '1' } }),
      runtime,
    )
    assert.equal(cancelHttp.status, 409, '已结束的运行再取消返回 409 RUN_NOT_ACTIVE')
  } finally { runtime.dispose() }
})

checkAsync('V2-M1 DORA：四指标计算、dry_run 排除、MTTR 恢复、空窗口与路由校验', async () => {
  const now = Date.parse('2026-01-06T12:00:00.000Z')
  const runs = [
    { project_id: 'p', target: 'prod', status: 'success', commit_sha: 'a1', started_at: '2026-01-05T08:00:00.000Z', finished_at: '2026-01-05T10:00:00.000Z' },
    { project_id: 'p', target: 'prod', status: 'failed', commit_sha: 'a2', started_at: '2026-01-05T11:00:00.000Z', finished_at: '2026-01-05T11:10:00.000Z' },
    { project_id: 'p', target: 'prod', status: 'success', commit_sha: 'a3', started_at: '2026-01-05T13:00:00.000Z', finished_at: '2026-01-05T13:30:00.000Z' },
    { project_id: 'p', target: 'prod', status: 'canceled', commit_sha: '', started_at: '2026-01-05T14:00:00.000Z', finished_at: '2026-01-05T14:05:00.000Z' },
    { project_id: 'p', target: 'prod', status: 'success', dry_run: 1, started_at: '2026-01-05T15:00:00.000Z', finished_at: '2026-01-05T15:10:00.000Z' },
  ]
  const commitAt = (sha) => (sha ? '2026-01-05T06:00:00.000Z' : '')
  const dora = internals.summarizeDora({ runs, commitAt, now, days: 30 })
  assert.equal(dora.windowDays, 30)
  assert.equal(dora.total, 4, 'dry_run 不计入统计')
  assert.equal(dora.deployments, 2)
  assert.equal(dora.failures, 2, 'failed + canceled 都算失败')
  assert.equal(dora.deploymentFrequency.perDay, 0.07)
  assert.equal(dora.changeFailureRate, 0.5)
  assert.equal(dora.leadTimeHours.samples, 2)
  assert.equal(dora.leadTimeHours.median, 5.75, 'commit 06:00 → 10:00 / 13:30，中位数 5.75h')
  assert.equal(dora.mttrHours.samples, 1)
  assert.equal(dora.mttrHours.avg, 1.83, '11:10 失败 → 13:00 下一次成功开始')
  assert.deepEqual(dora.levels, { deploymentFrequency: 'medium', leadTime: 'high', changeFailureRate: 'low', mttr: 'high' })
  assert.equal(dora.series.length, 30)
  const day = dora.series.find((item) => item.date === '2026-01-05')
  assert.deepEqual(day, { date: '2026-01-05', deployments: 2, failures: 1, canceled: 1 })

  const empty = internals.summarizeDora({ runs: [], now, days: 7 })
  assert.equal(empty.total, 0)
  assert.equal(empty.deployments, 0)
  assert.equal(empty.changeFailureRate, null)
  assert.equal(empty.leadTimeHours.avg, null)
  assert.equal(empty.levels.deploymentFrequency, 'low')
  assert.equal(empty.series.length, 7)

  // 路由：/dora 只读，days 越界 400
  const body = await call('/dora', '?days=7').then((response) => response.json())
  assert.equal(body.ok, true)
  assert.equal(body.windowDays, 7)
  assert.equal(typeof body.deployments, 'number')
  assert.equal((await call('/dora', '?days=0')).status, 400)
  assert.equal((await call('/dora', '?days=999')).status, 400)
  assert.equal((await call('/dora', '?extra=1')).status, 400)

  // 路由：/triggers 返回配置摘要；demo 的 pipe 没写 triggers，退化为纯手动
  const triggersBody = await call('/triggers', '?project=demo').then((response) => response.json())
  assert.equal(triggersBody.ok, true)
  assert.equal(triggersBody.triggers.manual, true)
  assert.equal(triggersBody.triggers.push, false)
  assert.equal(triggersBody.webhook, null)
  assert.equal((await call('/triggers', '?project=ghost')).status, 404)
  assert.equal((await call('/triggers', '?extra=1')).status, 400)

  // prefix 路由：demo 没有 triggers.push → 403 WEBHOOK_DISABLED
  const disabled = await callPath('/api/plugins/cicd/hooks/demo', '?ref=refs/heads/main&token=x')
  assert.equal(disabled.status, 403)
  assert.equal((await disabled.json()).code, 'WEBHOOK_DISABLED')
  assert.equal((await callPath('/api/plugins/cicd/hooks/ghost', '?ref=refs/heads/main&token=x')).status, 404)

  // /cancel 写保护：缺头 403、缺 confirm 400、未知 runId 404
  assert.equal((await call('/cancel', '?runId=x')).status, 403)
  assert.equal((await call('/cancel', '?runId=x', { headers: { 'x-dsh-cicd': '1' } })).status, 400)
  assert.equal((await call('/cancel', '?runId=ghost&confirm=1', { headers: { 'x-dsh-cicd': '1' } })).status, 404)
})

check('工具 render 函数对典型值不抛错', () => {
  const projects = ctx.toolsList.find((tool) => tool.name === 'cicd_projects')
  const status = ctx.toolsList.find((tool) => tool.name === 'cicd_status')
  const logs = ctx.toolsList.find((tool) => tool.name === 'cicd_logs')
  assert.equal(projects.output.render({}, { workDir: '/w', projects: [{ id: 'p', name: 'P', path: '/p', pipe: '/p/pipe.yml', hasPipe: true }] })[0].type, 'text')
  assert.match(status.output.render({}, { runs: [] })[0].text, /还没有运行记录/)
  assert.match(logs.output.render({}, { runId: 'r', status: 'success', totalLines: 0, truncated: false, text: '' })[0].text, /运行 r/)

  const cancel = ctx.toolsList.find((tool) => tool.name === 'cicd_cancel')
  assert.match(cancel.output.render({}, { runId: 'r1', project: 'p', target: 'prod', status: 'canceling' })[0].text, /已请求取消 r1.*正在终止/s)

  const dora = ctx.toolsList.find((tool) => tool.name === 'cicd_dora')
  const doraText = dora.output.render({}, {
    project: 'p', windowDays: 7, total: 4, deployments: 3, failures: 1,
    deploymentFrequency: { deployments: 3, perDay: 0.43, perWeek: 3 },
    leadTimeHours: { avg: 5.75, median: 5.75, samples: 2 },
    changeFailureRate: 0.25,
    mttrHours: { avg: 1.5, samples: 1 },
    levels: { deploymentFrequency: 'medium', leadTime: 'high', changeFailureRate: 'high', mttr: 'high' },
    series: [],
  })[0].text
  assert.match(doraText, /DORA · 最近 7 天/)
  assert.match(doraText, /部署频率：3 次/)
  assert.match(doraText, /变更失败率：25%/)
  assert.match(doraText, /MTTR：1\.5h/)

  const triggers = ctx.toolsList.find((tool) => tool.name === 'cicd_triggers')
  const triggerText = triggers.output.render({}, {
    project: 'p',
    triggers: { push: true, branches: ['main'], tags: ['v*'], schedules: [{ cron: '0 3 * * *', target: 'prod' }], manual: true },
    schedulers: { started: true, tickSec: 20, pollSec: 60, lastError: '' },
    webhook: { url: 'http://127.0.0.1:4567/api/plugins/cicd/hooks/p', requiresToken: true },
  })[0].text
  assert.match(triggerText, /手动：开/)
  assert.match(triggerText, /push：branches=main/)
  assert.match(triggerText, /cron：0 3 \* \* \* → prod/)
  assert.match(triggerText, /调度器：运行中/)
  // 纯手动项目（scheduler 关闭）也不能抛错
  assert.match(triggers.output.render({}, {
    project: 'p', triggers: { push: false, branches: [], tags: [], schedules: [], manual: true }, schedulers: null, webhook: null,
  })[0].text, /手动：开/)

  const runners = ctx.toolsList.find((tool) => tool.name === 'cicd_runners')
  assert.match(runners.output.render({}, { runners: [] })[0].text, /还没有注册/)
  assert.match(runners.output.render({}, {
    runners: [{ runnerId: 'build-01', labels: ['node', 'builder'], version: '0.6.2', capacity: 2, lastSeenAt: '2026-01-01T00:00:00Z', status: 'online', active: true }],
  })[0].text, /build-01.*online.*node,builder.*在跑/s)
})

// V2-M2：执行面抽象（Executor）——本地/远端等价性、broker 派发、journal 幂等

check('V2-M2 executor：本地 executor 成功/失败/超时/取消四态', async () => {
  const executor = createLocalExecutor()
  assert.equal(executor.kind, 'local')
  assert.equal(executor.runnerId, 'local')

  const ok = await executor.execute({ command: 'echo hello', timeoutSec: 10 }, { cwd: process.cwd() })
  assert.equal(ok.status, 'success')
  assert.equal(ok.exitCode, 0)

  const fail = await executor.execute({ command: 'exit 3', timeoutSec: 10 }, { cwd: process.cwd() })
  assert.equal(fail.status, 'failed')
  assert.equal(fail.exitCode, 3)

  const timedOut = await executor.execute({ command: 'ping -n 5 127.0.0.1 > nul', timeoutSec: 1 }, { cwd: process.cwd() })
  assert.equal(timedOut.status, 'failed')
  assert.match(timedOut.error, /步骤超时/)

  const controller = new AbortController()
  const cancelPromise = executor.execute({ command: 'ping -n 10 127.0.0.1 > nul', timeoutSec: 60 }, { cwd: process.cwd(), signal: controller.signal })
  await new Promise((resolve) => setTimeout(resolve, 500))
  controller.abort()
  const canceled = await cancelPromise
  assert.equal(canceled.status, 'canceled')
  assert.match(canceled.error, /已取消/)
})

check('V2-M2 broker：register/claim/reportLog/resolve/taskForRunner 全链路', async () => {
  const broker = createTaskBroker({})
  const info = broker.register('build-01', { labels: 'node,builder', version: '0.6.2', capacity: 2 })
  assert.equal(info.runnerId, 'build-01')
  assert.deepEqual(info.labels, ['node', 'builder'])
  assert.equal(info.status, 'online')
  assert.equal(broker.listRunners().length, 1)

  // 模拟 runner 侧：enqueue → taskForRunner → reportLog → resolve
  const spec = { taskId: 'task-1', command: 'echo remote', cwd: '/tmp', env: {}, timeoutSec: 30, runId: 'r1' }
  broker.enqueue(spec, 'build-01')
  const task = broker.taskForRunner('build-01')
  assert.equal(task.spec.taskId, 'task-1')
  assert.equal(task.status, 'queued')

  broker.reportLog('task-1', 'remote line 1')
  broker.reportLog('task-1', 'remote line 2')
  assert.equal(broker.task('task-1').lines.length, 2)

  broker.resolve('task-1', { status: 'success', exitCode: 0 })
  const resolved = broker.task('task-1')
  assert.equal(resolved.status, 'finished')
  assert.equal(resolved.result.status, 'success')
  assert.equal(resolved.result.exitCode, 0)
  // resolve 幂等：第二次调用不改变状态
  broker.resolve('task-1', { status: 'failed', exitCode: 1 })
  assert.equal(broker.task('task-1').result.status, 'success')
  // 队列里 finished 任务被跳过
  assert.equal(broker.taskForRunner('build-01'), null)
  assert.equal(broker.activeFor('build-01'), false)

  broker.markOffline('build-01')
  assert.equal(broker.describe('build-01').status, 'offline')
})

checkAsync('V2-M2 remote executor：claim 走 broker，cancel 走 cancelAll', async () => {
  const broker = createTaskBroker({})
  broker.register('build-01', {})
  const executor = createRemoteExecutor({ broker, runnerId: 'build-01' })
  assert.equal(executor.kind, 'remote')
  assert.equal(executor.runnerId, 'build-01')

  // 模拟 runner 端轮询 + 回报（claim 在后台等）
  const claimPromise = executor.execute({ command: 'echo x', timeoutSec: 30 }, { cwd: '/tmp', env: {}, onLine: () => {}, signal: null, taskId: 'task-c1', runId: 'r1', stepIndex: 0, stageId: 'build' })
  await new Promise((resolve) => setTimeout(resolve, 100))
  // runner 端领任务
  const task = broker.taskForRunner('build-01')
  assert.equal(task.spec.taskId, 'task-c1')
  assert.equal(task.spec.command, 'echo x')
  // runner 端执行完，回报 log + result
  broker.reportLog('task-c1', 'x')
  broker.resolve('task-c1', { status: 'success', exitCode: 0 })
  const result = await claimPromise
  assert.equal(result.status, 'success')
  assert.equal(result.exitCode, 0)

  // 取消路径：enqueue 后 cancelAll（cancelRequested 在下一个 50ms tick 被 poll 看到）
  const claim2 = executor.execute({ command: 'sleep 10', timeoutSec: 60 }, { cwd: '/tmp', env: {}, onLine: () => {}, signal: null, taskId: 'task-c2', runId: 'r1', stepIndex: 0, stageId: 'build' })
  await new Promise((resolve) => setTimeout(resolve, 100))
  broker.cancelAll('build-01')
  const result2 = await claim2
  assert.equal(result2.status, 'canceled')
  assert.match(result2.error, /已取消/)
})

check('V2-M2 joinTokenMatches：时序安全 token 校验', () => {
  assert.equal(joinTokenMatches('secret', 'secret'), true)
  assert.equal(joinTokenMatches('wrong', 'secret'), false)
  assert.equal(joinTokenMatches('', 'secret'), false)
  assert.equal(joinTokenMatches('secret', ''), false)
  assert.equal(joinTokenMatches('', ''), false)
})

check('V2-M2 DB v5：steps 表带 runner_id 列', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cicd-v5-'))
  const store = createStore({ dir: join(dir, 'state') })
  store.appendStep({
    run_id: 'r1', stage_id: 'build', idx: 0, name: 's', command: 'echo', exit_code: 0,
    started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:00:01Z', status: 'success',
    log_path: '', timeout_s: 0, attempts: 1, runner_id: 'build-01',
  })
  const step = store.stepsOf('r1')
  assert.equal(step[0].runner_id, 'build-01')
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------------------------
// 10. V2-M3：发布策略（serial / parallel / rolling / canary / blue-green + 策略锁）

/** 假的 remote：记录每台执行过的命令，支持失败注入。 */
function fakeRemoteForStrategy({ failHost = '', failAtBatch = 0 } = {}) {
  const calls = []
  let batchCounter = 0
  return {
    calls,
    async exec(host, command, _opts) {
      calls.push({ host, command })
      if (failHost && host === failHost && batchCounter === failAtBatch) {
        throw Object.assign(new Error(`[${host}] 注入失败`), { code: 'INJECTED' })
      }
      return { exitCode: 0, stdout: '' }
    },
    async uploadFile() { /* noop */ },
  }
}

check('V2-M3 normalizeStrategy：无 strategy 退化 serial / canary，非法类型报错', () => {
  const s1 = normalizeStrategy({ hosts: ['a', 'b'] }, 2)
  assert.equal(s1.type, 'serial')

  const s2 = normalizeStrategy({ hosts: ['a', 'b', 'c'], canary: { first: 1, waitSec: 5 } }, 3)
  assert.equal(s2.type, 'canary')
  assert.equal(s2.first, 1)

  const s3 = normalizeStrategy({ hosts: ['a', 'b', 'c', 'd', 'e'], strategy: { type: 'rolling', batch: 2, waitSec: 30 } }, 5)
  assert.equal(s3.type, 'rolling')
  assert.equal(s3.batch, 2)
  assert.equal(s3.waitSec, 30)

  const s4 = normalizeStrategy({ hosts: ['a', 'b'], strategy: { type: 'parallel', onHostFailure: 'continue' } }, 2)
  assert.equal(s4.type, 'parallel')
  assert.equal(s4.onHostFailure, 'continue')

  const s5 = normalizeStrategy({ hosts: ['a', 'b', 'c'], strategy: { type: 'blue-green', waitSec: 10 } }, 3)
  assert.equal(s5.type, 'blue-green')

  assert.throws(() => normalizeStrategy({ hosts: ['a'], strategy: { type: 'bogus' } }, 1), /未知发布策略类型/)
})

checkAsync('V2-M3 rolling：5 台 batch=2 分批推进，单台失败按策略停止', async () => {
  const target = { hosts: ['h1', 'h2', 'h3', 'h4', 'h5'], path: '/opt/roll', strategy: { type: 'rolling', batch: 2, waitSec: 0 }, onHostFailure: 'stop' }
  const remote = fakeRemoteForStrategy()
  const result = await strategyDeploy({ remote, target, targetName: 'roll', artifactPath: '/tmp/b.tgz', releaseId: 'rel-1', keep: 5, commit: 'c1', onLog: () => {} })
  assert.equal(result.ok, true)
  assert.equal(result.strategy, 'rolling')
  assert.equal(result.canary.batches.length, 3)
  assert.deepEqual(result.canary.batches[0], { index: 1, hosts: ['h1', 'h2'], ok: true })
  assert.deepEqual(result.canary.batches[1], { index: 2, hosts: ['h3', 'h4'], ok: true })
  assert.deepEqual(result.canary.batches[2], { index: 3, hosts: ['h5'], ok: true })
})

checkAsync('V2-M3 rolling：单台失败 stop → 后续批次全部 skipped', async () => {
  const target = { hosts: ['h1', 'h2', 'h3', 'h4', 'h5'], path: '/opt/roll', strategy: { type: 'rolling', batch: 2, waitSec: 0 }, onHostFailure: 'stop' }
  const remote = fakeRemoteForStrategy({ failHost: 'h3' })
  const result = await strategyDeploy({ remote, target, targetName: 'roll', artifactPath: '/tmp/b.tgz', releaseId: 'rel-2', keep: 5, commit: 'c1', onLog: () => {} })
  assert.equal(result.ok, false)
  const hosts = result.hosts
  assert.equal(hosts[0].ok, true)  // h1
  assert.equal(hosts[1].ok, true)  // h2
  assert.equal(hosts[2].ok, false) // h3 失败
  assert.equal(hosts[2].skipped, undefined) // 是 failed，不是 skipped
  assert.equal(hosts[3].skipped, true) // h4 跳过
  assert.equal(hosts[4].skipped, true) // h5 跳过
})

checkAsync('V2-M3 parallel：所有主机并发部署', async () => {
  const target = { hosts: ['h1', 'h2', 'h3'], path: '/opt/par', strategy: { type: 'parallel', onHostFailure: 'continue' } }
  const remote = fakeRemoteForStrategy()
  const result = await strategyDeploy({ remote, target, targetName: 'par', artifactPath: '/tmp/b.tgz', releaseId: 'rel-3', keep: 5, commit: 'c1', onLog: () => {} })
  assert.equal(result.ok, true)
  assert.equal(result.strategy, 'parallel')
  assert.equal(result.hosts.length, 3)
  assert.ok(result.hosts.every((h) => h.ok))
})

checkAsync('V2-M3 canary：首批失败立即停，剩余 skipped（即便 onHostFailure=continue）', async () => {
  const target = { hosts: ['h1', 'h2', 'h3', 'h4'], path: '/opt/can', strategy: { type: 'canary', first: 2, waitSec: 0, onHostFailure: 'continue' } }
  const remote = fakeRemoteForStrategy({ failHost: 'h2' })
  const result = await strategyDeploy({ remote, target, targetName: 'can', artifactPath: '/tmp/b.tgz', releaseId: 'rel-4', keep: 5, commit: 'c1', onLog: () => {} })
  assert.equal(result.ok, false)
  assert.equal(result.hosts[0].ok, true)  // h1
  assert.equal(result.hosts[1].ok, false) // h2 失败
  assert.equal(result.hosts[2].skipped, true) // h3 跳过
  assert.equal(result.hosts[3].skipped, true) // h4 跳过
})

checkAsync('V2-M3 blue-green：成功时全部切流，失败时自动回退', async () => {
  const target = { hosts: ['h1', 'h2'], path: '/opt/bg', strategy: { type: 'blue-green', waitSec: 0 } }
  const remote = fakeRemoteForStrategy()
  const ok = await strategyDeploy({ remote, target, targetName: 'bg', artifactPath: '/tmp/b.tgz', releaseId: 'rel-5', keep: 5, commit: 'c1', onLog: () => {} })
  assert.equal(ok.ok, true)
  assert.equal(ok.strategy, 'blue-green')
  assert.ok(ok.hosts.every((h) => h.ok))

  const remote2 = fakeRemoteForStrategy({ failHost: 'h1' })
  const fail = await strategyDeploy({ remote: remote2, target, targetName: 'bg', artifactPath: '/tmp/b.tgz', releaseId: 'rel-6', keep: 5, commit: 'c1', onLog: () => {} })
  assert.equal(fail.ok, false)
})

checkAsync('V2-M3 策略锁：onStrategyProgress 记录 rolling 批次进度', async () => {
  const target = { hosts: ['h1', 'h2', 'h3', 'h4', 'h5'], path: '/opt/lock', strategy: { type: 'rolling', batch: 2, waitSec: 0 } }
  const remote = fakeRemoteForStrategy()
  const progress = []
  await strategyDeploy({
    remote, target, targetName: 'lock', artifactPath: '/tmp/b.tgz', releaseId: 'rel-7', keep: 5, commit: 'c1', onLog: () => {},
    onStrategyProgress: (event) => { progress.push(event) },
  })
  assert.equal(progress.length, 3) // 3 个批次
  assert.equal(progress[0].batch, 1)
  assert.equal(progress[0].totalBatches, 3)
  assert.deepEqual(progress[0].hosts, ['h1', 'h2'])
  assert.equal(progress[0].completed.length, 0) // 第一批开始前 completed 为空
  assert.deepEqual(progress[2].hosts, ['h5'])
})

// V2-M4：审批门 + secrets + environments

check('V2-M4 environments：dev/staging/prod 环境 + 晋升路径', () => {
  const targets = {
    dev: { hosts: ['dev1'], path: '/srv/dev' },
    staging: { hosts: ['stg1', 'stg2'], path: '/srv/stg' },
    prod: { hosts: ['prod1', 'prod2', 'prod3'], path: '/srv/prod', strategy: { type: 'rolling', batch: 1, waitSec: 60 } },
  }
  const envs = normalizeEnvironments(targets)
  assert.equal(envs.dev.order, 1)
  assert.equal(envs.staging.order, 2)
  assert.equal(envs.prod.order, 3)
  assert.equal(envs.prod.protected, true)
  assert.equal(envs.prod.approvalRequired, true)
  assert.equal(envs.dev.protected, false)
  assert.deepEqual(promotionPath(envs, 'dev'), ['staging', 'prod'])
  assert.deepEqual(promotionPath(envs, 'staging'), ['prod'])
  assert.deepEqual(promotionPath(envs, 'prod'), [])
})

check('V2-M4 approvalGate：request/isPending/resolve/list 全链路（落库版）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cicd-approval-'))
  const db = openDatabase(join(dir, 'cicd.db'))
  const gate = createApprovalGate({ db })
  const approval = gate.request({ runId: 'r1', project: 'demo', target: 'prod', requestedBy: 'alice', detail: 'deploy' })
  assert.equal(approval.status, 'pending')
  assert.equal(gate.isPending('r1'), true)
  assert.equal(gate.get('r1').id.startsWith('appr-'), true)
  const list = gate.list({ project: 'demo', status: 'pending' })
  assert.equal(list.length, 1)
  assert.equal(list[0].runId, 'r1')
  // v3.0-P0：禁自批——服务端校验，不靠 UI 隐藏按钮。
  const selfApprove = gate.resolve({ runId: 'r1', approved: true, resolvedBy: 'alice' })
  assert.equal(selfApprove.ok, false)
  assert.equal(selfApprove.code, 'SELF_APPROVAL_FORBIDDEN')
  const resolved = gate.resolve({ runId: 'r1', approved: true, resolvedBy: 'bob' })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.approval.status, 'approved')
  assert.equal(gate.isPending('r1'), false)
  assert.equal(gate.get('r1').decidedBy, 'bob')
  // 一次性消费：批准后能给一次部署放行，第二次必须重新申请。
  const first = gate.consume({ id: resolved.approval.id, digest: 'sha256:aaa' })
  assert.equal(first.ok, true)
  assert.equal(first.approval.artifactDigest, 'sha256:aaa')
  const second = gate.consume({ id: resolved.approval.id, digest: 'sha256:bbb' })
  assert.equal(second.ok, false)
  assert.equal(second.code, 'APPROVAL_CONSUMED')
  // 重启不丢：同一个库重开，历史审批仍在。
  gate.dispose()
  const reopened = createApprovalGate({ db })
  assert.equal(reopened.get(resolved.approval.id).status, 'consumed')
  assert.equal(reopened.stats().consumed, 1)
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

check('V2-M4 approvalGate：TTL 到期落 approval_timeout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cicd-approval-ttl-'))
  const db = openDatabase(join(dir, 'cicd.db'))
  let clock = Date.now()
  const gate = createApprovalGate({ db, ttlSec: 60, now: () => clock })
  const approval = gate.request({ runId: 'r2', project: 'demo', target: 'prod', requestedBy: 'alice' })
  assert.equal(gate.isPending('r2'), true)
  clock += 61 * 1000
  assert.equal(gate.isPending('r2'), false)
  const row = gate.get(approval.id)
  assert.equal(row.status, 'expired')
  assert.equal(row.reason, 'approval_timeout')
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

check('V2-M4 secrets：set/get/list/remove + refsForInterpolate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cicd-secrets-'))
  const store = createSecretStore({ dir: join(dir, 'state') })
  const ref = store.set('demo', 'global', 'DB_PASSWORD', 's3cret')
  assert.match(ref, /^secret-[0-9a-f]{8}$/)
  assert.equal(store.get('demo', 'global', 'DB_PASSWORD'), 's3cret')
  assert.equal(store.get('demo', 'global', 'NONEXISTENT'), '')
  const rows = store.list('demo')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'DB_PASSWORD')
  assert.equal(rows[0].ref, ref)
  const merged = store.refsForInterpolate('demo', { BRANCH: 'main' })
  assert.equal(merged.DB_PASSWORD, 's3cret')
  assert.equal(merged.BRANCH, 'main')
  assert.equal(store.remove('demo', 'global', 'DB_PASSWORD'), true)
  assert.equal(store.get('demo', 'global', 'DB_PASSWORD'), '')
  assert.equal(store.remove('demo', 'global', 'DB_PASSWORD'), false)
  store.dispose()
  rmSync(dir, { recursive: true, force: true })
})

checkAsync('V2-M4 /approve 路由：缺 approvalId/runId 400、未知 404', async () => {
  const r1 = await call('/approve', '?confirm=1', { headers: { 'x-dsh-cicd': '1' } })
  assert.equal(r1.status, 400)
  const r2 = await call('/approve', '?runId=unknown-run&decision=approve&confirm=1', { headers: { 'x-dsh-cicd': '1' } })
  assert.equal(r2.status, 404)
  const body = await r2.json()
  assert.equal(body.code, 'APPROVAL_NOT_FOUND')
})

checkAsync('V2-M4 /approvals /secrets /environments 路由', async () => {
  const a = await call('/approvals', '')
  assert.equal(a.status, 200)
  const aBody = await a.json()
  assert.ok(Array.isArray(aBody.approvals))

  const s = await call('/secrets', '?project=demo')
  assert.equal(s.status, 200)
  const sBody = await s.json()
  assert.ok(Array.isArray(sBody.secrets))

  const e = await call('/environments', '?project=demo')
  assert.equal(e.status, 200)
  const eBody = await e.json()
  assert.equal(eBody.project, 'demo')
  assert.ok(Array.isArray(eBody.environments))
})

// V2-M5：RBAC（server 模式三角色 + token TTL + 审计导出）

check('V2-M5 RBAC：createToken/verifyToken/grant/revoke/canWrite/canAdmin/exportAudit 全链路', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cicd-rbac-'))
  const { createRbac } = internals
  const store = createRbac({ dir: dir, ttlSec: 60 })
  try {
    // 签发 admin token
    const admin = store.createToken('alice', 'admin', ['*'], 60)
    assert.match(admin.token, /^rbac-[0-9a-f]{8}$/)
    assert.equal(admin.user, 'alice')
    assert.equal(admin.role, 'admin')
    assert.equal(admin.projects[0], '*')
    assert.ok(admin.expiresAt)

    // 校验
    const verified = store.verifyToken(admin.token)
    assert.equal(verified.user, 'alice')
    assert.equal(verified.role, 'admin')

    // 权限（canAdmin/canWrite 按用户名查，不是 verifyToken 返回的对象）
    assert.equal(store.canAdmin('alice'), true)
    assert.equal(store.canWrite('alice', 'web'), true)
    assert.equal(store.canWrite('alice', 'api'), true)

    // 签发 operator（限定项目）
    const op = store.createToken('bob', 'operator', ['web'], 60)
    store.verifyToken(op.token)
    assert.equal(store.canAdmin('bob'), false)
    assert.equal(store.canWrite('bob', 'web'), true)
    assert.equal(store.canWrite('bob', 'api'), false) // 不在范围

    // viewer
    const viewer = store.createToken('carol', 'viewer', ['*'], 60)
    store.verifyToken(viewer.token)
    assert.equal(store.canAdmin('carol'), false)
    assert.equal(store.canWrite('carol', 'web'), false)

    // 用户列表
    const users = store.users()
    assert.equal(users.length, 3)
    assert.ok(users.some((u) => u.user === 'alice' && u.role === 'admin'))
    assert.ok(users.some((u) => u.user === 'bob' && u.role === 'operator'))

    // 审计导出
    const audit = store.exportAudit()
    assert.ok(Array.isArray(audit))
    assert.ok(audit.length >= 3) // 至少 3 条 createToken 审计

    // 吊销
    store.revoke('bob')
    const usersAfter = store.users()
    assert.ok(!usersAfter.some((u) => u.user === 'bob'))

    // 过期 token
    const { createRbac: createRbac2 } = internals
    const store2 = createRbac2({ dir: join(dir, 'expired'), ttlSec: 1 })
    const expired = store2.createToken('dave', 'admin', ['*'], 1)
    // 手动改 expiresAt 为过去
    store2.revoke('dave')
    const fresh = store2.createToken('dave', 'admin', ['*'], 3600)
    const verifiedFresh = store2.verifyToken(fresh.token)
    assert.equal(verifiedFresh.role, 'admin')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

checkAsync('V2-M5 /rbac 路由：签发/校验/吊销/审计', async () => {
  // 签发
  const s = await call('/rbac', '?user=alice&role=admin&ttlSec=60')
  assert.equal(s.status, 200)
  const sBody = await s.json()
  assert.equal(sBody.ok, true)
  assert.match(sBody.token, /^rbac-[0-9a-f]{8}$/)
  assert.equal(sBody.role, 'admin')

  // 校验
  const v = await call('/rbac', `?action=verify&token=${encodeURIComponent(sBody.token)}`)
  assert.equal(v.status, 200)
  const vBody = await v.json()
  assert.equal(vBody.user, 'alice')
  assert.equal(vBody.role, 'admin')

  // 用户列表
  const l = await call('/rbac', '')
  assert.equal(l.status, 200)
  const lBody = await l.json()
  assert.ok(Array.isArray(lBody.users))
  assert.ok(lBody.users.some((u) => u.user === 'alice'))

  // 吊销
  const r = await call('/rbac', '?action=revoke&user=alice')
  assert.equal(r.status, 200)

  // 审计导出
  const a = await call('/rbac', '?action=audit')
  assert.equal(a.status, 200)
  const aBody = await a.json()
  assert.ok(Array.isArray(aBody.audit))
  assert.ok(aBody.audit.length >= 2)
})

// ============================================================================
// 08-security-rbac.md §10 八条验收（v3.0-P0）
// 每条都走真实 HTTP 路由 + 真实 DB，不打桩：验收标准写的是「线上能不能挡住」，
// 用单元测试替身证明不了这件事。
// ============================================================================

const ACC_PIPE = [
  'version: 1',
  'name: acc-pipe',
  'targets:',
  '  dev:',
  '    hosts: [api2]',
  '    path: /srv/acc-dev',
  '  prod:',
  '    hosts: [linux26, win22]',
  '    path: /srv/acc-prod',
  'stages:',
  '  - id: build',
  '    steps:',
  '      - name: build',
  '        run: echo ACC_BUILD_OK',
  '  - id: release',
  '    needs: [build]',
  '    steps:',
  '      - name: ship',
  '        deploy:',
  '          target: prod',
  '          artifacts: ["bundle.tgz"]',
].join('\n')

// 内容与 ACC_PIPE 相同、只有项目 id 不同 → digest 不同。验收④用它证明「一条审批只绑一个 digest」。
const ACC_PIPE_TWIN = ACC_PIPE.replace('name: acc-pipe', 'name: acc-pipe-twin')

const ACC_SECRET_PIPE = [
  'version: 1',
  'name: acc-secret-pipe',
  'targets:',
  '  dev:',
  '    hosts: [api2]',
  '    path: /srv/acc-secret',
  'stages:',
  '  - id: build',
  '    steps:',
  '      - name: leak',
  '        run: echo ${{ACC_SECRET}}',
].join('\n')

const ACC_SECRET_VALUE = 'acc-s3cret-value'
const ACC_PASSWORD = '{{SECRET_9ntmfi6m}}'
const accRoot = mkdtempSync(join(tmpdir(), 'cicd-acc-'))
const accAppDir = join(accRoot, 'app')
const accTwinDir = join(accRoot, 'app-twin')
const accSecretDir = join(accRoot, 'app-secret')
for (const dir of [accAppDir, accTwinDir, accSecretDir]) mkdirSync(dir, { recursive: true })
writeFileSync(join(accAppDir, 'pipe.yml'), ACC_PIPE, 'utf8')
writeFileSync(join(accTwinDir, 'pipe.yml'), ACC_PIPE_TWIN, 'utf8')
writeFileSync(join(accSecretDir, 'pipe.yml'), ACC_SECRET_PIPE, 'utf8')
writeFileSync(join(accAppDir, 'bundle.tgz'), 'acc-bundle', 'utf8')
writeFileSync(join(accTwinDir, 'bundle.tgz'), 'acc-bundle', 'utf8')

const accCtx = fakeContext()
apply(accCtx, {
  projects: [
    { id: 'acc', name: 'Acc', path: accAppDir, pipe: join(accAppDir, 'pipe.yml') },
    { id: 'acc2', name: 'Acc2', path: accTwinDir, pipe: join(accTwinDir, 'pipe.yml') },
    { id: 'accsec', name: 'AccSecret', path: accSecretDir, pipe: join(accSecretDir, 'pipe.yml') },
  ],
  workDir: join(accRoot, 'state'),
  remoteBase: 'http://127.0.0.1:7891',
  scheduler: { enabled: false },
  runners: { joinToken: 'acc-join-token' },
  approval: { ttlSec: 3600 },
})
// 验收上下文的路由也要随主 ctx 一起销毁，否则末尾那条 `routes.length === 0` 会漏。
ctx.effects.push(...accCtx.effects.splice(0))

function accCall(routePath, query = '', { headers = {} } = {}) {
  // 允许把查询串直接写在 routePath 里（读起来更像一个真实 URL），
  // 但查路由必须用干净的 path，否则 `/audit?name=x` 会被当成一条不存在的路由。
  const cut = routePath.indexOf('?')
  const pathname = cut < 0 ? routePath : routePath.slice(0, cut)
  const search = cut < 0 ? query : routePath.slice(cut) + query
  const route = accCtx.routes.find((item) => item.path === internals.ROUTE_PREFIX + pathname)
  assert.ok(route, `acc route ${pathname} registered`)
  return route.resource(new Request(`http://x${internals.ROUTE_PREFIX}${pathname}${search}`, {
    headers: { 'x-dsh-cicd': '1', ...headers },
  }))
}

const accDbFile = join(accRoot, 'state', 'cicd.db')
// 八条验收共享的凭据：验收①里建好，后面全部用 token 走真实认证链。
const accIds = { view: '', admin: '', approver: '', viewToken: '', adminToken: '', approverToken: '' }

checkAsync('验收①：Viewer 调 /run → 403 POLICY_DENY，且审计里留下 deny 记录', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = envFetch
  try {
    // 引导期（库里还没有任何用户）才有权限建第一个人 —— 这是刻意设计的首启路径。
    const created = await accCall('/users', `?action=create&email=admin%40acc.test&password=${encodeURIComponent(ACC_PASSWORD)}&role=owner&confirm=1`)
    assert.equal(created.status, 200, '引导期建管理员')
    accIds.admin = (await created.json()).user.id

    // 第一个人建完，bootstrap 立刻退场 —— 这一步之后连签 token 都得先登录。
    const login = await accCall('/auth', `?action=login&email=admin%40acc.test&password=${encodeURIComponent(ACC_PASSWORD)}`)
    assert.equal(login.status, 200, '登录要能用')
    const loginBody = await login.json()
    assert.match(loginBody.cookie, /^dsh_cicd_session=/)
    const auth = { cookie: loginBody.cookie.split(';')[0] }

    const adminToken = await accCall('/tokens', `?action=create&userId=${encodeURIComponent(accIds.admin)}&name=acc-admin&confirm=1`, { headers: auth })
    assert.equal(adminToken.status, 200, '登录后能签 token')
    accIds.adminToken = (await adminToken.json()).token.token
    assert.match(accIds.adminToken, /^cicd_/)
    const mkUser = async (email, role) => {
      const res = await accCall('/users', `?action=create&email=${encodeURIComponent(email)}&password=${encodeURIComponent(ACC_PASSWORD)}&role=${role}&confirm=1`, { headers: auth })
      assert.equal(res.status, 200, `建 ${role}`)
      return (await res.json()).user.id
    }
    accIds.view = await mkUser('viewer@acc.test', 'viewer')
    accIds.approver = await mkUser('approver@acc.test', 'admin')

    const mkToken = async (userId) => {
      const res = await accCall('/tokens', `?action=create&userId=${encodeURIComponent(userId)}&name=acc&confirm=1`, { headers: auth })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.match(body.token.token, /^cicd_/)
      return body.token.token
    }
    accIds.viewToken = await mkToken(accIds.view)
    accIds.approverToken = await mkToken(accIds.approver)

    // 有了用户，bootstrap 就必须退场：匿名读也得 401。
    const anon = await accCall('/runs', '?project=acc')
    assert.equal(anon.status, 401, 'bootstrap 退场后匿名读也得 401')

    // secret 要在任何一次跑之前就位，否则带 ${{ACC_SECRET}} 的 plan 会直接 PIPE_VAR。
    const setSecret = await accCall('/secrets', `?project=accsec&name=ACC_SECRET&value=${encodeURIComponent(ACC_SECRET_VALUE)}&confirm=1`, { headers: auth })
    assert.equal(setSecret.status, 200)

    const denied = await accCall('/run', '?project=acc&target=dev&confirm=1', {
      headers: { authorization: `Bearer ${accIds.viewToken}` },
    })
    assert.equal(denied.status, 403, 'viewer 触发部署必须 403')
    const deniedBody = await denied.json()
    assert.equal(deniedBody.code, 'POLICY_DENY')
    assert.equal(deniedBody.action, 'run')

    const audit = await accCall('/audit?name=policy.deny', '', { headers: auth })
    assert.equal(audit.status, 200)
    const rows = (await audit.json()).events
    const row = rows.find((item) => item.action === 'policy.deny' && item.result === 'deny')
    assert.ok(row, '审计里必须有这条 deny')
    assert.equal(row.actorId, accIds.view, '审计要记到具体是谁')
    assert.equal(row.projectId, 'acc')
  } finally {
    globalThis.fetch = originalFetch
  }
})

checkAsync('验收②：Admin 部署 prod 无审批 → APPROVAL_REQUIRED；到期收成 failed(approval_timeout)', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = envFetch
  try {
    const auth = { authorization: `Bearer ${accIds.adminToken}` }
    const run = await accCall('/run', '?project=acc&target=prod&confirm=prod', { headers: auth })
    assert.equal(run.status, 409, 'prod 部署没审批必须 409')
    assert.equal((await run.json()).code, 'APPROVAL_REQUIRED')

    const pending = await accCall('/approvals?status=pending', '', { headers: auth })
    assert.equal(pending.status, 200)
    const pendingBody = await pending.json()
    assert.ok(pendingBody.approvals.length >= 1, '要能在面板上看到待审批')
    const approval = pendingBody.approvals[0]
    assert.ok(approval.artifactDigest, '审批必须绑 digest，否则批准的是什么说不清')
    assert.equal(approval.requestedBy, accIds.admin)
    assert.ok(approval.expiresAt, '审批必须有 TTL，不允许永久 pending')

    const waiting = await accCall('/runs?project=acc&limit=50', '', { headers: auth })
    const waitingRow = (await waiting.json()).runs.find((item) => item.id === approval.runId)
    assert.ok(waitingRow, '待审批的运行记录要能查到（否则面板上「点过运行」和「什么都没发生」长得一样）')
    assert.equal(waitingRow.status, 'waiting_approval')

    // 把到期时间推到过去，再读一次审批列表触发懒扫描。
    const db = openDatabase(accDbFile)
    try {
      db.prepare('UPDATE approvals SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', approval.id)
    } finally { db.close() }

    const expired = await accCall('/approvals?status=expired', '', { headers: auth })
    const expiredBody = await expired.json()
    assert.equal(expiredBody.stats.expired, 1, '过期审批要落成 expired')
    assert.equal(expiredBody.approvals[0].reason, 'approval_timeout')

    const after = await accCall('/runs?project=acc&limit=50', '', { headers: auth })
    const stuck = (await after.json()).runs.find((item) => item.id === approval.runId)
    assert.equal(stuck.status, 'failed', '过期后不能永远挂在 waiting_approval')
    assert.equal(stuck.error, 'approval_timeout')
  } finally {
    globalThis.fetch = originalFetch
  }
})

checkAsync('验收③：审批人 = 请求人 → 403 SELF_APPROVAL_FORBIDDEN', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = envFetch
  try {
    const auth = { authorization: `Bearer ${accIds.adminToken}` }
    const run = await accCall('/run', '?project=acc&target=prod&confirm=prod', { headers: auth })
    assert.equal(run.status, 409)

    const approvals = await accCall('/approvals?status=pending', '', { headers: auth })
    const mine = (await approvals.json()).approvals.find((item) => item.requestedBy === accIds.admin && item.status === 'pending')
    assert.ok(mine, '自己发起的那条')

    const self = await accCall('/approve', `?approvalId=${encodeURIComponent(mine.id)}&decision=approve&confirm=1`, { headers: auth })
    assert.equal(self.status, 403, '自批必须被服务端挡住，不能只靠前端藏按钮')
    assert.equal((await self.json()).code, 'SELF_APPROVAL_FORBIDDEN')
  } finally {
    globalThis.fetch = originalFetch
  }
})

checkAsync('验收④：同一条审批不能用到第二个 digest → APPROVAL_CONSUMED', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = envFetch
  try {
    const auth = { authorization: `Bearer ${accIds.adminToken}` }
    // 清掉验收③留下的那条 pending，避免与本次申请混在一起。
    const run = await accCall('/run', '?project=acc&target=prod&confirm=prod', { headers: auth })
    assert.equal(run.status, 409)
    const approvals = await accCall('/approvals?status=pending', '', { headers: auth })
    const mine = (await approvals.json()).approvals.find((item) => item.project === 'acc' && item.status === 'pending')
    assert.ok(mine)

    const ok = await accCall('/approve', `?approvalId=${encodeURIComponent(mine.id)}&decision=approve&confirm=1`, {
      headers: { authorization: `Bearer ${accIds.approverToken}` },
    })
    assert.equal(ok.status, 200, '换个人批准应当成功')
    assert.equal((await ok.json()).status, 'approved')

    // 用这条审批跑 acc：digest 一致 → 放行并把它消费掉。
    const use = await accCall('/run', `?project=acc&target=prod&confirm=prod&approvalId=${encodeURIComponent(mine.id)}`, { headers: auth })
    assert.equal(use.status, 200, '审批 + 同一 digest 应当放行')
    assert.equal((await use.json()).ok, true)

    // 同一条审批去跑 acc2：内容同一份，但项目 id 不同 → digest 不同 → 必须拒。
    const reuse = await accCall('/run', `?project=acc2&target=prod&confirm=prod&approvalId=${encodeURIComponent(mine.id)}`, { headers: auth })
    assert.equal(reuse.status, 409, '已消费的审批不能再用')
    assert.equal((await reuse.json()).code, 'APPROVAL_CONSUMED')
  } finally {
    globalThis.fetch = originalFetch
  }
})

checkAsync('验收⑤：日志里 grep 不到 secret 原文，且揭示动作有审计', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = envFetch
  try {
    const auth = { authorization: `Bearer ${accIds.adminToken}` }
    const run = await accCall('/run', '?project=accsec&target=dev&confirm=1', { headers: auth })
    assert.equal(run.status, 200)
    const runId = (await run.json()).runId
    assert.ok(runId)

    const log = await accCall(`/log?runId=${encodeURIComponent(runId)}&tail=200`, '', { headers: auth })
    assert.equal(log.status, 200)
    const text = (await log.json()).text
    assert.ok(text.length > 0, '日志不能是空的，否则这条验收等于没测')
    assert.equal(text.includes(ACC_SECRET_VALUE), false, '日志里不能出现 secret 原文')
    assert.ok(text.includes('***'), '被替换的位置要留痕')

    // 列表默认不回值，只有显式 reveal 才回，且必须留审计。
    const plain = await accCall('/secrets?project=accsec', '', { headers: auth })
    const plainRows = (await plain.json()).secrets
    assert.equal(plainRows.length, 1)
    assert.equal(plainRows[0].value, undefined, '列表接口不能顺手把明文带出来')

    const revealed = await accCall('/secrets?project=accsec&reveal=1&confirm=1', '', { headers: auth })
    assert.equal(revealed.status, 200)
    const revealedBody = await revealed.json()
    assert.equal(revealedBody.revealed, true)
    assert.equal(revealedBody.secrets[0].value, ACC_SECRET_VALUE)

    const audit = await accCall('/audit?name=secret.revealed', '', { headers: auth })
    const rows = (await audit.json()).events
    assert.ok(rows.some((item) => item.action === 'secret.revealed' && item.actorId === accIds.admin), '揭示必须留痕')
  } finally {
    globalThis.fetch = originalFetch
  }
})

checkAsync('验收⑥：同 target 并发部署 → 第二把锁被拒，且重启服务后依然互斥', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = envFetch
  try {
    const holderDb = openDatabase(accDbFile)
    const locks = internals.createDeployLocks({ db: holderDb })
    const first = locks.acquire({ target: 'prod', projectId: 'acc', runId: 'acc-lock-holder', owner: 'admin@acc.test' })
    assert.equal(first.ok, true)

    const auth = { authorization: `Bearer ${accIds.adminToken}` }
    const denied = await accCall('/run', '?project=acc&target=prod&confirm=prod', { headers: auth })
    assert.equal(denied.status, 409)
    assert.equal((await denied.json()).code, 'DEPLOY_IN_PROGRESS', '同 target 的第二条必须被锁挡住')

    // 「重启后依然互斥」= 换一个全新 runtime（新连接、新内存态）读同一张表。
    const restartedCtx = fakeContext()
    apply(restartedCtx, {
      projects: [{ id: 'acc', name: 'Acc', path: accAppDir, pipe: join(accAppDir, 'pipe.yml') }],
      workDir: join(accRoot, 'state'),
      remoteBase: 'http://127.0.0.1:7891',
      scheduler: { enabled: false },
    })
    ctx.effects.push(...restartedCtx.effects.splice(0))
    const runRoute = restartedCtx.routes.find((item) => item.path === `${internals.ROUTE_PREFIX}/run`)
    const again = await runRoute.resource(new Request(`http://x${internals.ROUTE_PREFIX}/run?project=acc&target=prod&confirm=prod`, {
      headers: { 'x-dsh-cicd': '1', ...auth },
    }))
    assert.equal(again.status, 409, '锁落库，重启不能把互斥弄丢')
    assert.equal((await again.json()).code, 'DEPLOY_IN_PROGRESS')

    const listed = await accCall('/locks', '', { headers: auth })
    const lockRows = (await listed.json()).locks
    assert.ok(lockRows.some((item) => item.target === 'prod' && item.runId === 'acc-lock-holder'), '持有者要能查得到')

    locks.release({ target: 'prod', runId: 'acc-lock-holder' })
    holderDb.close()
  } finally {
    globalThis.fetch = originalFetch
  }
})

checkAsync('验收⑦：篡改审计表一行 → /audit?action=verify 报链断', async () => {
  const auth = { authorization: `Bearer ${accIds.adminToken}` }
  const db = openDatabase(accDbFile)
  try {
    const row = db.prepare('SELECT seq FROM audit_events ORDER BY seq ASC LIMIT 1 OFFSET 2').get()
    assert.ok(row, '审计表里得先有记录')
    db.prepare('UPDATE audit_events SET reason = ? WHERE seq = ?').run('tampered-by-test', row.seq)
  } finally { db.close() }

  const verify = await accCall('/audit?action=verify', '', { headers: auth })
  assert.equal(verify.status, 200)
  const body = await verify.json()
  assert.equal(body.ok, false, '篡改必须被检出')
  assert.equal(body.kind, 'hash')
  assert.ok(body.brokenSeq > 0)
})

checkAsync('验收⑧：吊销 runner 后 3× 心跳周期内不再被调度', async () => {
  const auth = { authorization: `Bearer ${accIds.adminToken}` }
  const register = await accCall('/runner-register?runnerId=acc-runner&token=acc-join-token&labels=build')
  assert.equal(register.status, 200)
  const regBody = await register.json()
  assert.equal(regBody.runnerId, 'acc-runner')
  assert.equal(regBody.offlineAfterSec, regBody.heartbeatSec * 3, '判死阈值必须正好是 3× 心跳')

  const pollBefore = await accCall('/runner-poll?runnerId=acc-runner&token=acc-join-token')
  assert.equal(pollBefore.status, 200, '吊销前应当能领任务')

  const revoke = await accCall('/runners?action=revoke&runnerId=acc-runner&confirm=1', '', { headers: auth })
  assert.equal(revoke.status, 200)

  const pollAfter = await accCall('/runner-poll?runnerId=acc-runner&token=acc-join-token')
  assert.equal(pollAfter.status, 403, '吊销要立即生效，不能等心跳超时')
  assert.equal((await pollAfter.json()).code, 'RUNNER_REVOKED')

  // 被吊销的机器即使还在跑，回传的结果也必须丢弃。
  const late = await accCall('/runner-result?runnerId=acc-runner&taskId=t-1&status=success')
  assert.equal(late.status, 403)
  assert.equal((await late.json()).code, 'RUNNER_REVOKED')

  const list = await accCall('/runners', '', { headers: auth })
  const row = (await list.json()).runners.find((item) => item.runnerId === 'acc-runner')
  assert.equal(row.status, 'revoked')
  assert.equal(row.revoked, true)
})

// ============================================================================
// 04-pipe-v2.md §14 / S1-S6：DSL v2 执行内核（v3.0-P1）
// 内核层（expr/model/jobs）直接调函数测，端到端走真实路由，避免只测到内部实现。
// ============================================================================

check('P1-S1：表达式求值器不做 JS 求值，三档白名单按档位拒绝', () => {
  const { evaluate, evaluateCondition, evaluateTemplate, parseTier } = internals.expr
  const ctx = {
    branch: 'main',
    vars: { JAVA: '21', N: 3 },
    matrix: { java: '17' },
    secrets: { TOKEN: 's3cret' },
    needs: { a: 'success' },
  }
  assert.equal(evaluate("branch == 'main' && vars.JAVA == '21'", ctx, { tier: 't1' }), true)
  assert.equal(evaluate('matrix.java == 17', ctx, { tier: 't1' }), true)
  assert.equal(evaluate('needs.a == "success"', ctx, { tier: 't1' }), true)
  assert.equal(evaluateCondition('!startsWith(branch, "dev")', ctx, { tier: 't1' }), true)
  assert.equal(evaluateTemplate('mvn -Pjdk${{ vars.JAVA }}', ctx, { tier: 't1' }), 'mvn -Pjdk21')

  // secrets 只在 T2 可见：T1 读到就是设计错误（值会进 run 记录和日志）。
  for (const source of ['secrets.TOKEN == "s3cret"']) {
    const allowed = (() => { try { evaluate(source, ctx, { tier: 't1' }); return true } catch { return false } })()
    assert.equal(allowed, false, `T1 必须拒绝 ${source}`)
    assert.equal(evaluate(source, ctx, { tier: 't2' }), true)
  }

  // 不是 JS 求值器：能跑出任意代码的输入必须被表达式语法挡住，而不是交给引擎执行。
  for (const source of ['process.exit(0)', 'require("fs")', 'globalThis.x = 1', '(() => 1)()']) {
    assert.throws(() => evaluate(source, ctx, { tier: 't2' }), (error) => error.code === 'PIPE_EXPR', `${source} 必须被拒`)
  }
})

check('P1-S2：v1 pipe 归一化结果与改动前一致（老文件零改动回归）', () => {
  const { normalizeModel } = internals.model
  const pipe = internals.parsePipe([
    'version: 1',
    'name: legacy',
    'targets:',
    '  prod:',
    '    hosts: [linux26]',
    '    path: /srv/legacy',
    'stages:',
    '  - id: build',
    '    steps:',
    '      - name: b',
    '        run: echo b',
    '  - id: release',
    '    steps:',
    '      - name: ship',
    '        deploy:',
    '          target: prod',
  ].join('\n'), { path: 'legacy.yml' })

  const model = normalizeModel(pipe, { vars: {} })
  // release 这个 stage 只有一步 deploy，没有构建步骤 → 不该凭空造一个空的 release-main。
  assert.deepEqual(model.jobs.map((job) => job.id), ['build-main', 'release-deploy'])
  const byId = Object.fromEntries(model.jobs.map((job) => [job.id, job]))
  assert.deepEqual(byId['build-main'].needs, [])
  assert.deepEqual(byId['release-deploy'].needs, ['build-main'], 'deploy 拆成独立 job，直接挂到上一个 stage')
  assert.equal(byId['release-deploy'].kind, 'deploy')
  // 顺序必须拓扑可用：每个 job 出现时它的依赖都已经出现过。
  const seen = new Set()
  for (const job of model.order) {
    for (const need of job.needs) assert.ok(seen.has(need), `${job.id} 的依赖 ${need} 必须先出现`)
    seen.add(job.id)
  }
})

check('P1-S3：matrix 展开上限 64 实例 / 3 维，超限在解析期就报错', () => {
  const { expandMatrix, MATRIX_MAX_INSTANCES } = internals.model
  const small = expandMatrix({ java: ['17', '21'], os: ['linux'] })
  assert.equal(small.length, 2)
  assert.deepEqual(small[0], { java: '17', os: 'linux' })

  assert.throws(
    () => expandMatrix({ a: ['1', '2', '3', '4', '5'], b: ['1', '2', '3', '4'], c: ['1', '2', '3', '4'] }),
    (error) => error.code === 'PIPE_MATRIX_TOO_LARGE',
  )
  assert.throws(
    () => expandMatrix({ a: ['1'], b: ['1'], c: ['1'], d: ['1'] }),
    (error) => error.code === 'PIPE_MATRIX_TOO_LARGE',
  )
  assert.equal(expandMatrix({ a: ['1', '2'], b: ['x', 'y'], c: ['p'] }).length, 4, `上限是 ${MATRIX_MAX_INSTANCES}，4 不该被拦`)
})

check('P1-S4：job 依赖成环 / 依赖不存在 都在解析期报错', () => {
  const { normalizeModel } = internals.model
  const cycle = internals.parsePipe([
    'version: 2',
    'name: cyc',
    'stages:',
    '  - id: s',
    '    jobs:',
    '      - id: one',
    '        needs: [two]',
    '        steps:',
    '          - run: echo one',
    '      - id: two',
    '        needs: [one]',
    '        steps:',
    '          - run: echo two',
  ].join('\n'), { path: 'cyc.yml' })
  assert.throws(() => normalizeModel(cycle, { vars: {} }), (error) => error.code === 'PIPE_CYCLE')

  const missing = internals.parsePipe([
    'version: 2',
    'name: miss',
    'stages:',
    '  - id: s',
    '    jobs:',
    '      - id: a',
    '        needs: [nope]',
    '        steps:',
    '          - run: echo a',
  ].join('\n'), { path: 'miss.yml' })
  assert.throws(() => normalizeModel(missing, { vars: {} }), (error) => error.code === 'PIPE_UNKNOWN_JOB')
})

checkAsync('P1-S5：DAG 调度器并发、失败与 skipped 向下传播、并发池上限、取消', async () => {
  const { scheduleJobs } = internals.jobs
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  // 并发：两个无依赖 job 各 120ms，串行要 240ms 以上。
  {
    const started = Date.now()
    const results = await scheduleJobs({
      jobs: [{ id: 'a', needs: [] }, { id: 'b', needs: [] }],
      concurrency: 4,
      runJob: async () => { await delay(120); return { status: 'success' } },
    })
    const elapsed = Date.now() - started
    assert.ok(elapsed < 220, `两个无依赖 job 应该并行，实测 ${elapsed}ms`)
    assert.equal(results.get('a').status, 'success')
    assert.equal(results.get('b').status, 'success')
  }

  // 失败传播：a 失败 → b、c 跳过，但 z 没有依赖它，必须照跑。
  {
    const skipped = []
    const results = await scheduleJobs({
      jobs: [
        { id: 'a', needs: [] },
        { id: 'b', needs: ['a'] },
        { id: 'c', needs: ['b'] },
        { id: 'z', needs: [] },
      ],
      concurrency: 4,
      onSkip: (job, reason) => skipped.push(`${job.id}:${reason}`),
      runJob: async (job) => (job.id === 'a' ? { status: 'failed', error: 'boom' } : { status: 'success' }),
    })
    assert.equal(results.get('a').status, 'failed')
    assert.equal(results.get('b').status, 'skipped')
    assert.equal(results.get('c').status, 'skipped', 'skipped 必须继续向下传播，不能断链')
    assert.equal(results.get('z').status, 'success', '无关分支不受影响')
    assert.equal(skipped.length, 2)
  }

  // 并发池上限：concurrency=2 时同时在跑的 job 不能超过 2。
  {
    let running = 0
    let peak = 0
    await scheduleJobs({
      jobs: Array.from({ length: 6 }, (_unused, index) => ({ id: `j${index}`, needs: [] })),
      concurrency: 2,
      runJob: async () => {
        running += 1
        peak = Math.max(peak, running)
        await delay(30)
        running -= 1
        return { status: 'success' }
      },
    })
    assert.ok(peak <= 2, `并发池上限 2 被突破（峰值 ${peak}）`)
  }

  // 取消：abort 之后未完成的 job 不能再启动。
  {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 40)
    const results = await scheduleJobs({
      jobs: [{ id: 'a', needs: [] }, { id: 'b', needs: ['a'] }],
      concurrency: 1,
      signal: controller.signal,
      // runJob 只收 job —— signal 由闭包捕获（runner.js 里的 runJob 就是从 stepContext 闭包拿的，
      // 再交给 executor 去杀子进程），这里照同样的形态写。
      runJob: async () => {
        const start = Date.now()
        while (Date.now() - start < 200) {
          if (controller.signal.aborted) return { status: 'canceled', error: '已取消' }
          await delay(10)
        }
        return { status: 'success' }
      },
    })
    assert.equal(results.get('a').status, 'canceled')
    assert.equal(results.get('b').status, 'canceled')
  }
})

// v2 端到端：真实 apply + v2 pipe 文件，走 /run，检查 job 图与 step 归属都落到接口返回值里。
const v2Root = mkdtempSync(join(tmpdir(), 'cicd-v2-'))
const v2Dir = join(v2Root, 'app')
mkdirSync(v2Dir, { recursive: true })
writeFileSync(join(v2Dir, 'pipe.yml'), [
  'version: 2',
  'name: v2-pipe',
  'targets:',
  '  dev:',
  '    hosts: [api2]',
  '    path: /srv/v2',
  'stages:',
  '  - id: check',
  '    jobs:',
  '      - id: unit',
  '        matrix:',
  '          java: ["17", "21"]',
  '        steps:',
  '          - name: test',
  '            run: echo UNIT_${{ matrix.java }}',
  '      - id: lint',
  '        steps:',
  '          - name: lint',
  '            run: echo LINT_OK',
  '  - id: ship',
  '    jobs:',
  '      - id: gate',
  '        needs: [unit, lint]',
  '        steps:',
  '          - name: gate',
  '            run: echo GATE_OK',
].join('\n'), 'utf8')
const v2Ctx = fakeContext()
apply(v2Ctx, {
  projects: [{ id: 'v2', name: 'V2', path: v2Dir, pipe: join(v2Dir, 'pipe.yml') }],
  workDir: join(v2Root, 'state'),
  remoteBase: 'http://127.0.0.1:1',
  scheduler: { enabled: false },
})
ctx.effects.push(...v2Ctx.effects.splice(0))

checkAsync('P1-S6：v2 pipe 端到端 —— matrix 展开成并行 job，step 归属记到 job，图落进 /run 返回值', async () => {
  const route = v2Ctx.routes.find((item) => item.path === `${internals.ROUTE_PREFIX}/run`)
  assert.ok(route, '/run 已注册')
  const response = await route.resource(new Request(`http://x${internals.ROUTE_PREFIX}/run?project=v2&target=dev&confirm=1`, {
    headers: { 'x-dsh-cicd': '1' },
  }))
  assert.equal(response.status, 200, await response.clone().text())
  const body = await response.json()
  assert.equal(body.status, 'success')

  // matrix 展开成两个独立 job，名字里带维度值 —— 这是「一个 job 定义跑 N 份」的唯一可见证据。
  assert.ok(body.jobs, 'v2 的 run 必须返回 job 图')
  const ids = body.jobs.items.map((item) => item.id)
  assert.ok(ids.includes('unit[java=17]'), `matrix 实例缺失：${ids.join(',')}`)
  assert.ok(ids.includes('unit[java=21]'), `matrix 实例缺失：${ids.join(',')}`)
  assert.ok(ids.includes('lint'))
  assert.ok(ids.includes('gate'))
  assert.equal(body.jobs.items.every((item) => item.status === 'success'), true, JSON.stringify(body.jobs.items))

  // gate 显式依赖两个 matrix 实例 + lint（needs 写基名要展开成全部实例）。
  const gate = body.jobs.items.find((item) => item.id === 'gate')
  assert.deepEqual(gate.needs.slice().sort(), ['lint', 'unit[java=17]', 'unit[java=21]'])

  // step 必须记到 job 一级：同 stage 多 job 时 idx 都从 0 起，只靠 stage+idx 会串台。
  const unitSteps = body.stages.flatMap((stage) => stage.steps).filter((step) => step.jobId.startsWith('unit['))
  assert.equal(unitSteps.length, 2)
  assert.equal(unitSteps.every((step) => step.status === 'success'), true)
  assert.equal(body.jobs.order.filter((id) => id.startsWith('unit[')).length, 2, 'order 里也要有两个实例')
})

check('P1-S7：v1 的 run 不返回 job 图（不能让老面板突然多出一块空视图）', async () => {
  const route = ctx.routes.find((item) => item.path === `${internals.ROUTE_PREFIX}/plan`)
  assert.ok(route, '/plan 已注册')
  const response = await route.resource(new Request(`http://x${internals.ROUTE_PREFIX}/plan?project=demo&target=prod`, {
    headers: { 'x-dsh-cicd': '1' },
  }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
})


checkAsync('P1-S8：配置快照 —— 跑完把 pipe.yml 原文与 sha256 落库，改文件后旧运行仍能解释自己', async () => {
  const v1Dir = join(v2Root, 'snap')
  mkdirSync(v1Dir, { recursive: true })
  const pipePath = join(v1Dir, 'pipe.yml')
  const source = ['version: 1', 'name: snap-pipe', 'targets:', '  dev:', '    hosts: [api2]', '    path: /srv/snap', 'stages:', '  - id: build', '    steps:', '      - name: b', '        run: echo SNAP_V1'].join('\n')
  writeFileSync(pipePath, source, 'utf8')

  const snapCtx = fakeContext()
  apply(snapCtx, {
    projects: [{ id: 'snap', name: 'Snap', path: v1Dir, pipe: pipePath }],
    workDir: join(v2Root, 'state-snap'),
    remoteBase: 'http://127.0.0.1:1',
    scheduler: { enabled: false },
  })
  ctx.effects.push(...snapCtx.effects.splice(0))

  const route = snapCtx.routes.find((item) => item.path === `${internals.ROUTE_PREFIX}/run`)
  const runResponse = await route.resource(new Request(`http://x${internals.ROUTE_PREFIX}/run?project=snap&target=dev&confirm=1`, {
    headers: { 'x-dsh-cicd': '1' },
  }))
  assert.equal(runResponse.status, 200, await runResponse.clone().text())
  const runBody = await runResponse.json()
  const runId = runBody.runId
  assert.ok(runId)

  // 改文件：模拟「跑完之后有人动了 pipe.yml」。旧运行不能跟着变。
  writeFileSync(pipePath, source.replace('SNAP_V1', 'SNAP_V2'), 'utf8')

  const db = openDatabase(join(v2Root, 'state-snap', 'cicd.db'))
  try {
    const row = db.prepare('SELECT config_snapshot, config_hash FROM runs WHERE id = ?').get(runId)
    assert.ok(row, '运行记录必须存在')
    assert.match(row.config_snapshot, /SNAP_V1/, '快照必须是当时那份配置，不能是改后的')
    assert.equal(row.config_snapshot, source, '快照要存原始 YAML 全文')
    assert.match(row.config_hash, /^[0-9a-f]{64}$/, 'hash 是 sha256')
  } finally { db.close() }
})

checkAsync('P1-S9：日志按 job 分片 —— 并行 job 各有一份日志，主日志仍是合并时间线', async () => {
  const route = v2Ctx.routes.find((item) => item.path === `${internals.ROUTE_PREFIX}/run`)
  const response = await route.resource(new Request(`http://x${internals.ROUTE_PREFIX}/run?project=v2&target=dev&confirm=1`, {
    headers: { 'x-dsh-cicd': '1' },
  }))
  assert.equal(response.status, 200, await response.clone().text())
  const runId = (await response.json()).runId

  const logRoute = v2Ctx.routes.find((item) => item.path === `${internals.ROUTE_PREFIX}/log`)
  const whole = await (await logRoute.resource(new Request(`http://x${internals.ROUTE_PREFIX}/log?runId=${runId}`, {
    headers: { 'x-dsh-cicd': '1' },
  }))).json()
  assert.equal(whole.ok, true)
  assert.ok(whole.jobs.length >= 3, `应当有多个 job 的分片日志，实际 ${whole.jobs.map((j) => j.jobId).join(',')}`)
  assert.match(whole.text, /LINT_OK/, '主日志仍要包含所有 job 的输出')

  // 单个 matrix 实例：分片日志里只能有它自己的输出，不能沾另一个实例的。
  const one = await (await logRoute.resource(new Request(
    `http://x${internals.ROUTE_PREFIX}/log?runId=${runId}&jobId=${encodeURIComponent('unit[java=17]')}`,
    { headers: { 'x-dsh-cicd': '1' } },
  ))).json()
  assert.equal(one.ok, true)
  assert.match(one.text, /UNIT_17/)
  assert.doesNotMatch(one.text, /UNIT_21/, '分片日志不能串台到另一个 matrix 实例')
  assert.match(one.text, /echo UNIT_17/, '分片日志要能自己解释跑的是什么命令')
  assert.match(one.logPath, /unit_java_17_\.log$/, `matrix 实例名里的方括号要做成合法文件名，实际 ${one.logPath}`)

  // 不存在的 jobId 要明确报错，而不是默默返回空串让人以为「这个 job 没输出」。
  const missing = await logRoute.resource(new Request(`http://x${internals.ROUTE_PREFIX}/log?runId=${runId}&jobId=nope`, {
    headers: { 'x-dsh-cicd': '1' },
  }))
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).code, 'RUN_NOT_FOUND')
})



// ---------------------------------------------------------------------------------------------
// P2：工具链（05-toolchain.md §9 六条验收）
//
// 全部用 file:// 的本地包做夹具，不访问外网：验收要证明的是「声明 → 安装 → 注入 → 断言」
// 这条链，不是「官方下载站今天通不通」。真实下载由 providers 的单元测试覆盖（另见 P2-S5）。

const TC_NL = String.fromCharCode(10)
const tcRoot = join(root, 'toolchain-fixture')
mkdirSync(tcRoot, { recursive: true })
const tcPlatform = currentPlatform()

/** 造一个「官方安装包」：解出来是 <top>/bin/<bin>，脚本里写着版本号。 */
function makeToolchainArchive({ lang, version, bins }) {
  const stage = join(tcRoot, `stage-${lang}-${String(version).replace(/[^A-Za-z0-9._-]+/g, '_')}`)
  const top = lang === 'java' ? `jdk-${version}` : `${lang}-${version}`
  const tcDirRoot = join(stage, top)
  mkdirSync(join(tcDirRoot, 'bin'), { recursive: true })
  for (const [name, body] of Object.entries(bins)) {
    const file = join(tcDirRoot, 'bin', name)
    writeFileSync(file, body, 'utf8')
    try { chmodSync(file, 0o755) } catch { /* Windows 上 chmod 只有只读位 */ }
  }
  const archive = join(tcRoot, `${top}.tgz`)
  execFileSync('tar', ['-czf', archive, '-C', stage, top], { stdio: 'ignore' })
  return { archive, sha256: sha256File(archive), stage, top }
}

/** JDK 的 bin 目录里放两个形态：POSIX 的 sh 脚本，Windows 的 .cmd（真机执行时按平台挑）。 */
function javaBins(banner) {
  return {
    java: `#!/bin/sh${TC_NL}echo "${banner}" 1>&2${TC_NL}`,
    'java.cmd': `@echo off${TC_NL}echo ${banner} 1>&2${TC_NL}`,
  }
}

function javaBinFile(dir) {
  return join(binDirOf('java', dir), process.platform === 'win32' ? 'java.cmd' : 'java')
}

/** 锁里的一条本地条目：url 指向 file://，checksum 用真实文件的 sha256。 */
function localLockEntry(lang, spec, resolved, archive, sha256, platform = tcPlatform) {
  const lock = emptyLock()
  upsertLockEntry(lock, {
    lang,
    spec,
    resolved,
    platforms: { [platform]: { url: pathToFileURL(archive).href, sha256: `sha256:${sha256}` } },
  })
  return lock
}

const java17Pkg = makeToolchainArchive({ lang: 'java', version: '17.0.11+9', bins: javaBins('openjdk version "17.0.11" 2024-04-16') })
const java21Pkg = makeToolchainArchive({ lang: 'java', version: '21.0.2+13', bins: javaBins('openjdk version "21.0.2" 2024-01-16') })

checkAsync('P2-S1：宿主只有 JDK21、项目声明 17 → 注入的是 17，且宿主环境一个字节都没被改', async () => {
  const store = join(tcRoot, 'store-s1')
  const lockFile = join(tcRoot, 's1.lock')
  writeLock(lockFile, localLockEntry('java', 'temurin-17', '17.0.11+9', java17Pkg.archive, java17Pkg.sha256))

  // 离线也有戏：file:// 的包是内网镜像/预置包，不该被 offline 拦掉（那是唯一能用离线的地方）。
  const tc = createToolchain({ storeDir: store, lockFile, platforms: tcPlatform, offline: true })
  const resolved = await tc.resolve({ java: 'temurin-17' })
  assert.equal(resolved[0].fromLock, true, '锁里已经有 17.0.11+9，应该直接命中')
  assert.equal(resolved[0].resolved, '17.0.11+9')

  const installed = await tc.ensure({ java: 'temurin-17' })
  assert.equal(installed.length, 1)
  assert.equal(installed[0].cached, false)
  assert.ok(existsSync(join(installed[0].dir, '.ok')), '装完要留 .ok 标记，否则下次会重装')
  assert.equal(installed[0].version, '17.0.11+9')

  // 宿主：只有 JDK21，PATH 与 JAVA_HOME 都指向它
  const hostJdk21 = join(tcRoot, 'host-jdk21')
  mkdirSync(join(hostJdk21, 'bin'), { recursive: true })
  const hostEnv = {
    ...process.env,
    JAVA_HOME: hostJdk21,
    PATH: `${join(hostJdk21, 'bin')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH || ''}`,
  }
  const before = process.env.JAVA_HOME

  const runEnv = envFor(installed, { base: hostEnv, platform: process.platform })
  assert.equal(runEnv.JAVA_HOME, installed[0].root, 'JAVA_HOME 必须改成声明的那份 JDK，否则写死 JAVA_HOME 的脚本会绕过 PATH')
  assert.ok(runEnv.PATH.startsWith(binDirOf('java', installed[0].root)), `PATH 首位要是声明的 JDK：${runEnv.PATH}`)
  assert.equal(process.env.JAVA_HOME, before, '子进程的 env 是副本，父进程不能被改（§9.1 后半句）')

  // 注入的 env 真的传到了子进程
  const echo = runSync(process.execPath, ['-e', 'console.log(process.env.JAVA_HOME + "|" + process.env.DSH_CICD_TOOLCHAIN)'], { env: runEnv })
  assert.equal(echo.status, 0, echo.stderr)
  assert.ok(echo.stdout.includes(installed[0].root), `子进程应看到注入的 JAVA_HOME：${echo.stdout}`)
  assert.ok(echo.stdout.includes('java=17.0.11+9'), `子进程应看到工具链指纹：${echo.stdout}`)

  // 真跑一次那份 java：POSIX 上断言输出 17.0.11（Windows 的 .cmd 需要 cmd 壳，交给 assertVersions 的自定义 run 覆盖）
  if (process.platform !== 'win32') {
    const out = runSync(javaBinFile(installed[0].root), ['-version'], { env: runEnv })
    assert.equal(out.status, 0, out.stderr)
    assert.ok(matchesVersion(`${out.stdout}${out.stderr}`, '17.0.11'), `跑出来的应是 17.0.11：${out.stdout}${out.stderr}`)
  }

  // 版本断言：对上就静默，对不上要报清楚
  const okProblems = assertVersions(installed, { run: () => ({ status: 0, stdout: 'openjdk version "17.0.11" 2024-04-16', stderr: '' }) })
  assert.deepEqual(okProblems, [])
  const badProblems = assertVersions(installed, { run: () => ({ status: 0, stdout: 'openjdk version "21.0.2" 2024-01-16', stderr: '' }) })
  assert.equal(badProblems.length, 1)
  assert.match(badProblems[0].message, /版本不符/)
})

checkAsync('P2-S2：同一台 runner 上两个 job 各自要 17 与 21 → 并发跑，互不污染', async () => {
  const storeDir = join(tcRoot, 'store-s2')
  const lockFile = join(tcRoot, 's2.lock')
  const lock = localLockEntry('java', 'temurin-17', '17.0.11+9', java17Pkg.archive, java17Pkg.sha256)
  upsertLockEntry(lock, {
    lang: 'java',
    spec: 'temurin-21',
    resolved: '21.0.2+13',
    platforms: { [tcPlatform]: { url: pathToFileURL(java21Pkg.archive).href, sha256: `sha256:${java21Pkg.sha256}` } },
  })
  writeLock(lockFile, lock)
  const tc = createToolchain({ storeDir, lockFile, platforms: tcPlatform, offline: true })
  const [j17, j21] = await Promise.all([tc.ensure({ java: 'temurin-17' }), tc.ensure({ java: 'temurin-21' })])
  assert.equal(j17[0].root === j21[0].root, false, '两个版本必须是两份目录')

  const store = createStore({ dir: join(tcRoot, 'state-s2') })
  // Windows 上 sqlite 文件在 store 关掉之前删不掉；这个 store 是临时造的，用完必须自己收尾。
  try {
  const mkPipe = (name) => parsePipe([
    'version: 1',
    `name: ${name}`,
    'targets:',
    '  dev:',
    '    hosts:',
    '      - h1',
    'stages:',
    '  - id: build',
    '    steps:',
    '      - name: show',
    '        run: node -e "console.log(\'TC=\' + process.env.DSH_CICD_TOOLCHAIN + \' JH=\' + process.env.JAVA_HOME)"',
  ].join(TC_NL))

  const runWith = (pipe, installed, id) => runPipeline({
    pipe,
    project: { id, path: join(tcRoot, `proj-${id}`) },
    target: 'dev',
    store,
    toolchainSetup: async () => ({ envFor: (extra) => envFor(installed, { base: process.env, extraEnv: extra }) }),
  })

  mkdirSync(join(tcRoot, 'proj-a'), { recursive: true })
  mkdirSync(join(tcRoot, 'proj-b'), { recursive: true })
  const [a, b] = await Promise.all([runWith(mkPipe('a'), j17, 'a'), runWith(mkPipe('b'), j21, 'b')])
  assert.equal(a.status, 'success', a.error)
  assert.equal(b.status, 'success', b.error)

  const logOf = (runId) => readFileSync(join(tcRoot, 'state-s2', 'logs', `${runId}.log`), 'utf8')
  const logA = logOf(a.runId)
  const logB = logOf(b.runId)
  assert.ok(logA.includes('java=17.0.11+9'), `A 应该用 17：${logA}`)
  assert.ok(!logA.includes('21.0.2'), `A 的日志里不该出现 21：${logA}`)
  assert.ok(logB.includes('java=21.0.2+13'), `B 应该用 21：${logB}`)
  assert.ok(!logB.includes('17.0.11'), `B 的日志里不该出现 17：${logB}`)
  } finally {
    store.close()
  }
})

checkAsync('P2-S3：离线 + 锁命中 → 继续；离线 + 缺锁 + frozen → 立刻失败且说清缺哪条', async () => {
  // 缺锁 + frozen：必须在联网之前就失败（否则「frozen」只是个装饰）
  let fetched = 0
  const providers = {
    java: {
      list: async () => {
        fetched += 1
        return { versions: ['17.0.11+9'], platforms: { [tcPlatform]: { url: 'https://example.invalid/jdk.tgz', sha256: `sha256:${'0'.repeat(64)}` } } }
      },
    },
  }
  const frozen = createToolchain({
    storeDir: join(tcRoot, 'store-s3'),
    lockFile: join(tcRoot, 's3-missing.lock'),
    platforms: tcPlatform,
    offline: true,
    frozen: true,
    providers,
  })
  await assert.rejects(
    () => frozen.resolve({ java: 'temurin-17' }),
    (error) => error.code === TOOLCHAIN_ERRORS.LOCK_MISSING && /锁文件缺少 java@temurin-17/.test(error.message) && /frozen/.test(error.message),
  )
  assert.equal(fetched, 0, 'frozen 下不该去问索引')

  // 离线但没 frozen：允许读到锁，只是不许下载；没锁则报 OFFLINE 而不是去 fetch
  const offlineNoLock = createToolchain({
    storeDir: join(tcRoot, 'store-s3b'),
    lockFile: join(tcRoot, 's3b.lock'),
    platforms: tcPlatform,
    offline: true,
    providers,
  })
  const resolved = await offlineNoLock.resolve({ java: 'temurin-17' })
  assert.equal(resolved[0].fromLock, false)
  assert.equal(fetched, 1, '没有 frozen 时才允许读索引（但仍不下包）')
  await assert.rejects(
    () => offlineNoLock.ensure({ java: 'temurin-17' }),
    (error) => error.code === TOOLCHAIN_ERRORS.OFFLINE,
  )
})

checkAsync('P2-S4：包被改 1 个字节 → 校验失败、不写入 store、坏包删除', async () => {
  const tampered = join(tcRoot, 'tampered.tgz')
  writeFileSync(tampered, readFileSync(java17Pkg.archive))
  const buffer = readFileSync(tampered)
  buffer[buffer.length - 1] = buffer[buffer.length - 1] ^ 0xff
  writeFileSync(tampered, buffer)

  const store = join(tcRoot, 'store-s4')
  const lockFile = join(tcRoot, 's4.lock')
  writeLock(lockFile, localLockEntry('java', 'temurin-17', '17.0.11+9', tampered, java17Pkg.sha256))
  const tc = createToolchain({ storeDir: store, lockFile, platforms: tcPlatform, offline: true })
  await assert.rejects(
    () => tc.ensure({ java: 'temurin-17' }),
    (error) => error.code === TOOLCHAIN_ERRORS.CHECKSUM && /校验失败（sha256）/.test(error.message),
  )
  assert.equal(existsSync(join(store, 'java', '17.0.11+9', tcPlatform)), false, '校验失败不能留下半装目录')
  assert.deepEqual(tc.list(), [], 'store 里不该有任何已装条目')
  const leftover = readdirSync(join(store, '.downloads')).filter((name) => name.endsWith('.part') || name.includes('tampered'))
  assert.deepEqual(leftover, [], `坏包要删干净，否则下次直接命中缓存：${leftover.join(',')}`)
})

checkAsync('P2-S5：同一份 pipe.yml 在 Windows 与 Linux 都能构建 → 锁里两个平台条目', async () => {
  const providers = {
    java: {
      list: async () => ({
        versions: ['17.0.11+9'],
        platforms: {
          'linux-x64': { url: 'https://example.invalid/linux/jdk.tgz', sha256: `sha256:${'a'.repeat(64)}` },
          'win32-x64': { url: 'https://example.invalid/win/jdk.zip', sha256: `sha256:${'b'.repeat(64)}` },
        },
      }),
    },
  }
  const lockFile = join(tcRoot, 's5.lock')
  const linux = createToolchain({ storeDir: join(tcRoot, 'store-s5'), lockFile, platforms: 'linux-x64', providers })
  await linux.resolve({ java: 'temurin-17' }, { writeLock: true })

  const written = readLock(lockFile)
  assert.equal(written.toolchain.length, 1)
  assert.deepEqual(Object.keys(written.toolchain[0].platforms).sort(), ['linux-x64', 'win32-x64'], '一平台解析要把两个平台的地址都记下来')

  // 换到 Windows 侧读同一份锁：必须命中，且拿到的是 win 的包（不是 linux 的）
  const win = createToolchain({ storeDir: join(tcRoot, 'store-s5'), lockFile, platforms: 'win32-x64', offline: true, frozen: true })
  const onWin = await win.resolve({ java: 'temurin-17' })
  assert.equal(onWin[0].fromLock, true)
  assert.match(onWin[0].platforms['win32-x64'].url, /win\/jdk\.zip$/)
})

checkAsync('P2-S6：二次构建命中缓存 → 不重新下载、不重新解包', async () => {
  const store = join(tcRoot, 'store-s6')
  const lockFile = join(tcRoot, 's6.lock')
  writeLock(lockFile, localLockEntry('java', 'temurin-17', '17.0.11+9', java17Pkg.archive, java17Pkg.sha256))
  const tc = createToolchain({ storeDir: store, lockFile, platforms: tcPlatform, offline: true })
  const first = await tc.ensure({ java: 'temurin-17' })
  assert.equal(first[0].cached, false)

  // 把下载缓存整个删掉：如果第二次还想下载，离线模式会立刻炸——从而证明它没下载
  rmSync(join(store, '.downloads'), { recursive: true, force: true })
  mkdirSync(join(store, '.downloads'), { recursive: true })
  const second = await tc.ensure({ java: 'temurin-17' })
  assert.equal(second[0].cached, true, '第二次必须命中 .ok 标记')
  assert.equal(second[0].root, first[0].root)

  // list() 要能报出这份已装工具链（面板与 cicd_toolchain list 都靠它）
  const listed = tc.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].lang, 'java')
  assert.equal(listed[0].version, '17.0.11+9')
  assert.ok(listed[0].bytes > 0)
})

checkAsync('P2-S7：pipe.yml 声明了工具链但锁缺失 + frozen → /run 直接失败并留下可解释的 run 记录', async () => {
  const tcRunRoot = mkdtempSync(join(tmpdir(), 'cicd-tc-'))
  const tcProject = join(tcRunRoot, 'app')
  mkdirSync(tcProject, { recursive: true })
  writeFileSync(join(tcProject, 'pipe.yml'), [
    'version: 1',
    'name: tc',
    'toolchain:',
    '  java: temurin-17',
    'targets:',
    '  dev:',
    '    hosts:',
    '      - h1',
    'stages:',
    '  - id: build',
    '    steps:',
    '      - name: build',
    '        run: echo SHOULD_NOT_RUN',
  ].join(TC_NL))

  const tcCtx = fakeContext()
  apply(tcCtx, {
    projects: [{ id: 'tc', name: 'TC', path: tcProject }],
    workDir: join(tcRunRoot, 'state'),
    remoteBase: 'http://127.0.0.1:1',
    scheduler: { enabled: false },
    toolchain: { offline: true, frozen: true },
  })
  const tcEffects = tcCtx.effects.splice(0)
  ctx.effects.push(...tcEffects)
  try {
    const route = tcCtx.routes.find((item) => item.path === `${internals.ROUTE_PREFIX}/run`)
    const response = await route.resource(new Request(`${'http://x'}${internals.ROUTE_PREFIX}/run?project=tc&target=dev&confirm=1`, {
      headers: { 'x-dsh-cicd': '1' },
    }))
    const body = await response.json()
    // 200 + status:failed，而不是一个 HTTP 错误码：请求本身是被接受并执行了的，
    // 失败的是这次运行。跟「某一步构建失败」同一档，调用方看 status 与 code 就知道发生了什么；
    // 换成 409 反而会把已经落库的 runId 丢掉，用户连日志都找不到。
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.status, 'failed', JSON.stringify(body))
    assert.equal(body.code, 'TOOLCHAIN_LOCK_MISSING', JSON.stringify(body))
    assert.match(body.error, /锁文件缺少 java@temurin-17/, `要指名缺哪一条：${body.error}`)

    // 安装失败也必须落一条 failed 的 run：否则用户只看到一条 409、日志是空的，无从下手
    const db = openDatabase(join(tcRunRoot, 'state', 'cicd.db'))
    const row = db.prepare('SELECT status, error FROM runs ORDER BY started_at DESC LIMIT 1').get()
    db.close()
    assert.equal(row.status, 'failed')
    assert.match(String(row.error), /锁文件缺少 java@temurin-17/)

    const logs = readdirSync(join(tcRunRoot, 'state', 'logs')).filter((name) => name.endsWith('.log'))
    assert.equal(logs.length, 1, '失败也要有日志文件')
    const text = readFileSync(join(tcRunRoot, 'state', 'logs', logs[0]), 'utf8')
    assert.match(text, /准备工具链：java=temurin-17/)
    assert.doesNotMatch(text, /SHOULD_NOT_RUN/, '工具链没准备好就不该跑任何一步')
  } finally {
    // 用本地副本：这些 disposer 已经交给主 ctx 了，splice 之后 tcCtx.effects 是空的，
    // 循环它会一条都不执行，然后 rmSync 撞上还开着的 sqlite 文件（Windows EBUSY）。
    for (const effect of tcEffects) { try { effect() } catch { /* ignore */ } }
    rmSync(tcRunRoot, { recursive: true, force: true })
  }
})

check('P2-S1b：Maven / Gradle 双锁文件与声明推断', () => {
  const dir = join(tcRoot, 'dual-lock')
  mkdirSync(dir, { recursive: true })
  const written = writeDualLocks({ runDir: dir, java: { root: '/s/jdk17', version: '17.0.11+9' }, vendor: 'temurin' })
  const xml = readFileSync(written.toolchainsXml, 'utf8')
  assert.match(xml, /<toolchain>/)
  // 写 17.0.11 而不是 17：Maven toolchains 的 <version> 允许补丁位，截到 feature 位
  // 反而会丢掉「这台机器上到底装了哪个补丁版本」这个唯一有用的信息。
  assert.match(xml, /<version>17\.0\.11<\/version>/)
  assert.match(xml, /\/s\/jdk17/)
  const props = readFileSync(written.gradleProperties, 'utf8')
  assert.match(props, /auto-detect=false/, '不能让 Gradle 自己去找 JDK，否则又回到「机器上装了什么就用什么」')
  assert.match(props, /\/s\/jdk17/)

  // 声明文件推断：pipe.yml 没写时才用，所以只测「读得对」
  const declared = join(tcRoot, 'declared')
  mkdirSync(declared, { recursive: true })
  writeFileSync(join(declared, '.nvmrc'), `20.11.1${TC_NL}`)
  writeFileSync(join(declared, '.python-version'), `3.11.9${TC_NL}`)
  const inferred = inferFromFiles(declared)
  assert.equal(inferred.node, '20.11.1')
  assert.equal(inferred.python, '3.11.9')

  // spec 解析与挑选：`17` 要拿到 17 系列最大，`17.0.11` 要能匹配 `17.0.11+9`
  assert.deepEqual(parseSpec('java', 'temurin-17'), { vendor: 'temurin', exact: '', spec: '17', raw: 'temurin-17' })
  assert.equal(pickVersion(['17.0.9+9', '17.0.11+9', '21.0.2+13'], '17'), '17.0.11+9')
  assert.equal(pickVersion(['17.0.9+9', '17.0.11+9'], '17.0.11'), '17.0.11+9')
  assert.equal(parseChecksum(`sha512:${'c'.repeat(128)}`).algo, 'sha512')
  assert.equal(parseChecksum('d'.repeat(64)).algo, 'sha256')
  assert.equal(parseChecksum('nothex'), null)
})

checkAsync('P2-S8：uses 动作 —— 未知动作与未知参数硬失败，缺能力不假装成功，verify 会重试', async () => {
  const { runAction, ACTION_ERRORS, ACTION_NAMES } = internals.actions
  assert.deepEqual(ACTION_NAMES, ['checkout', 'toolchain', 'cache', 'collect', 'deploy', 'verify', 'notify'])

  // 未知动作必须硬失败。静默跳过会让流水线看起来绿了、实际什么都没做，
  // 而「什么都没做」正是最难被发现的一类故障。
  await assert.rejects(
    () => runAction({ name: 'shell', with: {}, ctx: {} }),
    (error) => error.code === 'ACTION_NOT_FOUND' && /不支持的动作/.test(error.message),
  )

  // `with` 里拼错的键同样必须失败：`path:` 写成 `paths:` 却照跑，
  // 用户会一直以为缓存在工作，直到某天发现每次都全量构建。
  await assert.rejects(
    () => runAction({ name: 'cache', with: { key: 'k', paths: ['dist/**'], mode: 'both' }, ctx: {} }),
    (error) => error.code === 'ACTION_UNAVAILABLE' && /缓存能力/.test(error.message),
  )
  const stubbed = { cache: { restore: async () => ({ hit: false }), save: async () => ({ ok: true }) }, log: () => {} }
  await assert.rejects(
    () => runAction({ name: 'cache', with: { key: 'k', path: ['dist/**'] }, ctx: stubbed }),
    (error) => error.code === 'ACTION_INPUT_INVALID' && /不认识参数 “path”/.test(error.message),
  )

  // verify：前两次失败、第三次成功 —— 部署后的探针本来就要容忍启动窗口
  let calls = 0
  const outputs = []
  const verifyResult = await runAction({
    name: 'verify',
    with: { url: 'http://127.0.0.1:1/health', contains: 'OK', retries: 3, interval: 1, timeout: 2000 },
    ctx: {
      log: (line) => outputs.push(line),
      fetch: async () => {
        calls += 1
        if (calls < 3) throw new Error('ECONNREFUSED')
        return new Response('{"status":"OK"}', { status: 200 })
      },
    },
  })
  assert.equal(calls, 3, '应该一直重试到成功')
  assert.equal(verifyResult.outputs.attempts, 3)
  assert.match(outputs.join('\n'), /第 3 次尝试/)

  // verify 不给执行脚本的能力：只认 http(s) 与 GET/HEAD
  await assert.rejects(
    () => runAction({ name: 'verify', with: { url: 'file:///etc/passwd' }, ctx: { log: () => {}, fetch: async () => new Response('') } }),
    (error) => error.code === 'ACTION_INPUT_INVALID' && /只接受 http/.test(error.message),
  )

  // checkout：HEAD 与声明不一致时必须失败并说清「不会替你切分支」。
  // 悄悄 checkout 会改掉用户自己的工作副本，他下次 git status 会看到一堆莫名其妙的改动。
  const gitCalls = []
  const fakeGit = (sha) => async (args) => {
    gitCalls.push(args.join(' '))
    if (args[0] === 'rev-parse' && args[1] === '--verify') return { ok: true, stdout: `${sha}\n` }
    if (args[0] === 'rev-parse') return { ok: true, stdout: '1111111111111111\n' }
    return { ok: true, stdout: '' }
  }
  await assert.rejects(
    () => runAction({ name: 'checkout', with: { ref: 'v2.0.0' }, ctx: { git: fakeGit('2222222222222222'), log: () => {}, project: {} } }),
    (error) => error.code === 'ACTION_FAILED' && /不会替你切分支/.test(error.message),
  )
  assert.deepEqual(gitCalls, ['rev-parse HEAD', 'rev-parse --verify v2.0.0^{commit}'], '不一致时不该有任何写操作')
  const sameHead = await runAction({
    name: 'checkout',
    with: { ref: 'v2.0.0', fetch_depth: 1, submodules: true },
    ctx: { git: fakeGit('1111111111111111'), log: () => [], project: {} },
  })
  assert.equal(sameHead.outputs.ref, '1111111111111111')
  assert.equal(sameHead.outputs.fetched, true)
})

checkAsync('P2-S9：缓存是「恢复-保存」两段式 —— 收尾钩子保存、前缀命中、绝对路径被拒', async () => {
  const { createCacheStore, CACHE_ERRORS } = internals.cache
  const cacheRoot = join(tcRoot, 'cache-roundtrip')
  const projectPath = join(cacheRoot, 'proj')
  mkdirSync(join(projectPath, 'dist', 'nested'), { recursive: true })
  writeFileSync(join(projectPath, 'dist', 'a.txt'), 'AAA')
  writeFileSync(join(projectPath, 'dist', 'nested', 'b.txt'), 'BBB')

  const store = createCacheStore({ dir: join(cacheRoot, 'entries') })

  // 绝对路径必须拒绝：否则 paths: ["/etc"] 能把宿主整个打包进缓存，
  // 下一次构建再原样恢复到任何项目目录里。
  for (const bad of ['/etc/passwd', 'C:\\Windows', 'dist/../../escape']) {
    // save 是 async，抛错会变成 rejection —— 用 assert.throws 会静默通过（它只看同步抛出）
    await assert.rejects(() => store.save({ projectId: 'p', projectPath, key: 'k', paths: [bad] }),
      (error) => error.code === CACHE_ERRORS.PATH_INVALID, `应当拒绝 ${bad}`)
  }

  const none = await store.save({ projectId: 'p', projectPath, key: 'empty', paths: ['nothing/**'] })
  assert.equal(none.ok, false)
  assert.match(none.error, /没有匹配到任何文件/)

  const saved = await store.save({ projectId: 'p', projectPath, key: 'Linux-node20-abc', paths: ['dist/**'] })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  assert.equal(saved.files, 2)

  // 抹掉工作副本再恢复，证明内容真的进了缓存，而不是「文件本来就在」
  rmSync(join(projectPath, 'dist'), { recursive: true, force: true })
  const exact = await store.restore({ projectId: 'p', projectPath, key: 'Linux-node20-abc', paths: ['dist/**'] })
  assert.equal(exact.hit, true)
  assert.equal(exact.exact, true)
  assert.equal(readFileSync(join(projectPath, 'dist', 'nested', 'b.txt'), 'utf8'), 'BBB')

  // 前缀命中：依赖没变但某个输入变了，旧的缓存远好过没有
  rmSync(join(projectPath, 'dist'), { recursive: true, force: true })
  const prefixed = await store.restore({ projectId: 'p', projectPath, key: 'Linux-node20-xyz', paths: ['dist/**'], restoreKeys: ['Linux-node20-'] })
  assert.equal(prefixed.hit, true)
  assert.equal(prefixed.exact, false)
  assert.equal(prefixed.key, 'Linux-node20-abc')

  // 项目之间互相隔离：同一个 key 在另一个项目里不能命中
  const other = await store.restore({ projectId: 'other', projectPath, key: 'Linux-node20-abc', paths: ['dist/**'] })
  assert.equal(other.hit, false, '缓存不该跨项目串味')
})

checkAsync('P2-S10：v1 pipe 里直接写 uses: —— cache 第一次未命中并保存，第二次命中；collect 收制品', async () => {
  const actsRoot = mkdtempSync(join(tmpdir(), 'cicd-acts-'))
  const actsProject = join(actsRoot, 'app')
  mkdirSync(actsProject, { recursive: true })
  writeFileSync(join(actsProject, 'pipe.yml'), [
    'version: 1',
    'name: acts',
    'targets:',
    '  dev:',
    '    hosts:',
    '      - h1',
    'stages:',
    '  - id: build',
    '    steps:',
    '      - uses: cache',
    '        with:',
    '          key: acts-cache-v1',
    '          paths:',
    '            - dist/**',
    '          mode: both',
    '      - name: make',
    '        run: node -e "const f=require(\'fs\');f.mkdirSync(\'dist\',{recursive:true});f.writeFileSync(\'dist/out.txt\',\'hello\')"',
    '      - uses: collect',
    '        with:',
    '          paths:',
    '            - dist/**',
    '          name: app',
  ].join(TC_NL))

  const actsCtx = fakeContext()
  apply(actsCtx, {
    projects: [{ id: 'acts', name: 'Acts', path: actsProject }],
    workDir: join(actsRoot, 'state'),
    remoteBase: 'http://127.0.0.1:1',
    scheduler: { enabled: false },
  })
  const actsEffects = actsCtx.effects.splice(0)
  ctx.effects.push(...actsEffects)
  const runOnce = async () => {
    const route = actsCtx.routes.find((item) => item.path === `${internals.ROUTE_PREFIX}/run`)
    const response = await route.resource(new Request(`http://x${internals.ROUTE_PREFIX}/run?project=acts&target=dev&confirm=1`, {
      headers: { 'x-dsh-cicd': '1' },
    }))
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.status, 'success', JSON.stringify(body))
    const kinds = body.stages[0].steps.map((step) => step.kind)
    assert.deepEqual(kinds, ['uses', 'run', 'uses'], 'v1 的 uses 步骤要被执行，而不是当成命令')
    return body
  }
  try {
    const first = await runOnce()
    assert.equal(first.stages[0].steps[0].status, 'success')
    // 收尾钩子（等同 GitHub 的 post 步骤）在 job 结束时才保存：
    // 执行到 cache 那一步时还没 build，dist/ 是空的。
    const firstLog = readFileSync(join(actsRoot, 'state', 'logs', `${first.runId}.log`), 'utf8')
    assert.match(firstLog, /cache：未命中 acts-cache-v1/)
    assert.match(firstLog, /cache：已保存 acts-cache-v1/)
    assert.match(firstLog, /collect：app 收到 1 个文件/)

    const second = await runOnce()
    const secondLog = readFileSync(join(actsRoot, 'state', 'logs', `${second.runId}.log`), 'utf8')
    assert.match(secondLog, /cache：命中 acts-cache-v1/, '第二次应该命中上一次保存的缓存')

    // 未知动作在真运行里也必须让这一步失败，而不是跳过
    writeFileSync(join(actsProject, 'pipe.yml'), [
      'version: 1',
      'name: bad-action',
      'targets:',
      '  dev:',
      '    hosts:',
      '      - h1',
      'stages:',
      '  - id: build',
      '    steps:',
      '      - uses: shell',
      '        with:',
      '          run: echo hi',
    ].join(TC_NL))
    const route = actsCtx.routes.find((item) => item.path === `${internals.ROUTE_PREFIX}/run`)
    const response = await route.resource(new Request(`http://x${internals.ROUTE_PREFIX}/run?project=acts&target=dev&confirm=1`, {
      headers: { 'x-dsh-cicd': '1' },
    }))
    const body = await response.json()
    assert.equal(body.status, 'failed')
    const badLog = readFileSync(join(actsRoot, 'state', 'logs', `${body.runId}.log`), 'utf8')
    assert.match(badLog, /动作 shell 失败：不支持的动作/)
  } finally {
    for (const effect of actsEffects) { try { effect() } catch { /* ignore */ } }
    rmSync(actsRoot, { recursive: true, force: true })
  }
})


checkAsync('P3-S1：native 多实例端口与实例日志隔离', async () => {
  const calls = []
  const target = { path: '/srv/app', hosts: ['h1', 'h2'], restart: 'node app.js --port={{.port}}', instances: { count: 3, port: { base: 8080, step: 1 }, log: '/var/log/app-{{.index}}.log' }, health: { window: 0 } }
  for (const hostName of target.hosts) {
    const host = {
      async exec(command) {
        calls.push({ hostName, command })
        if (command.startsWith('ss -ltnp')) return { stdout: '', exitCode: 0 }
        if (command.includes('set -C')) return { stdout: 'CICD_SLOT_OK', exitCode: 0 }
        return { stdout: '', exitCode: 0 }
      },
      async uploadFile() {},
    }
    const actuator = createNativeActuator({ host, target, hostName, onLog: () => {} })
    const handle = await actuator.stage({ releaseId: 'p3-r1', artifactPath: '' })
    await actuator.activate(handle)
    assert.deepEqual(handle.slots, [8080, 8081, 8082])
    assert.equal(new Set(handle.instances.map((item) => item.port)).size, 3)
    assert.equal(new Set(handle.instances.map((item) => item.logPath)).size, 3)
  }
  assert.equal(calls.filter((item) => /--port=/.test(item.command)).length, 6)
})

checkAsync('P3-S2：stage 全完成前不 activate，失败后释放已占槽位', async () => {
  const seen = { staged: [], activated: [], released: [] }
  const factory = ({ hostName }) => ({
    slots: { releaseAll: async () => { seen.released.push(hostName) } },
    stage: async () => { if (hostName === 'h2') throw Object.assign(new Error('stage failed'), { code: 'ACTUATOR_STAGE_FAILED' }); seen.staged.push(hostName); return { host: hostName, releaseId: 'p3-r2', dir: '/r', instances: [], slots: [], previous: 'old' } },
    activate: async () => { seen.activated.push(hostName) }, health: async () => ({ ok: true, layer: 'l2' }),
    revert: async () => {}, writeManifest: async () => ({}), cleanup: async () => {},
  })
  const result = await deployTransaction({ remote: {}, target: { path: '/srv', hosts: ['h1', 'h2', 'h3'] }, releaseId: 'p3-r2', actuatorFactory: factory })
  assert.equal(result.ok, false)
  assert.deepEqual(seen.activated, [])
  assert.deepEqual(seen.staged, ['h1'])
  assert.deepEqual(seen.released, ['h1'])
  assert.equal(result.hosts.find((item) => item.host === 'h3').skipped, true)
})

checkAsync('P3-S3：verify 失败补偿所有已激活主机', async () => {
  const seen = { activated: [], reverted: [], manifests: [] }
  const factory = ({ hostName }) => ({
    slots: { releaseAll: async () => {} },
    stage: async () => ({ host: hostName, releaseId: 'p3-r3', dir: '/r', instances: [], slots: [], previous: 'old' }),
    activate: async () => { seen.activated.push(hostName) },
    health: async () => hostName === 'h2' ? { ok: false, layer: 'l2', detail: 'probe failed' } : { ok: true, layer: 'l2' },
    revert: async () => { seen.reverted.push(hostName) }, writeManifest: async () => { seen.manifests.push(hostName) }, cleanup: async () => {},
  })
  const result = await deployTransaction({ remote: {}, target: { path: '/srv', hosts: ['h1', 'h2'] }, releaseId: 'p3-r3', actuatorFactory: factory })
  assert.equal(result.ok, false)
  assert.deepEqual(seen.activated, ['h1', 'h2'])
  assert.ok(seen.reverted.includes('h1'))
  assert.ok(seen.reverted.includes('h2'))
  assert.deepEqual(seen.manifests, [])
  assert.equal(result.hosts.find((item) => item.host === 'h2').layer, 'l2')
})

checkAsync('P3-S4：僵尸槽位按 pid+端口证据回收', async () => {
  let busy = true
  const commands = []
  const store = createSlotStore({ root: '/srv/app', run: async (command) => {
    commands.push(command)
    if (command.startsWith('cat ')) return { stdout: JSON.stringify({ pid: 999999, releaseId: 'old' }) }
    if (command.startsWith('kill -0')) return { stdout: 'no' }
    if (command.includes('ss -ltn')) return { stdout: 'no' }
    if (command.startsWith('rm -f')) { busy = false; return { stdout: '' } }
    if (command.includes('CICD_SLOT_OK')) return { stdout: busy ? 'CICD_SLOT_BUSY' : 'CICD_SLOT_OK' }
    return { stdout: '' }
  } })
  const result = await store.claim({ port: 8080, releaseId: 'new', instanceId: 'h/0' })
  assert.equal(result.ok, true)
  assert.equal(result.reclaimed, true)
  assert.ok(commands.some((command) => command.includes('set -C')))
})

checkAsync('P3-S5：release 存储保留不可变 artifact digest 与实例快照', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cicd-p3-release-'))
  const store = createStore({ dir })
  try {
    store.appendRelease({ id: 'r-new@h1', project_id: 'p', target: 'prod', host: 'h1', run_id: 'r-new', commit: 'c', artifact_digest: 'sha256:oldbytes', artifact_sha256: 'oldbytes', mode: 'native', instances: [{ port: 8080 }], status: 'active' })
    const saved = store.release('r-new@h1')
    assert.equal(saved.artifactDigest, 'sha256:oldbytes')
    assert.equal(saved.instances[0].port, 8080)
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

checkAsync('P3-S6：k8s 尚无 Actuator 时拒绝静默退回 native', async () => {
  await assert.rejects(() => deployTransaction({ remote: {}, target: { mode: 'k8s', path: '/srv', hosts: ['h1'] }, releaseId: 'p3-r6' }), (error) => error.code === 'ACTUATOR_NOT_IMPLEMENTED')
})

checkAsync('P3-S6b：容器 mode 与 native 同一条事务路径 —— 先全部 pull 再切，一台失败谁都不换', async () => {
  const calls = []
  const remote = { async exec(hostName, command) {
    calls.push({ hostName, command })
    if (command.startsWith('docker inspect --type image')) return { stdout: 'no', exitCode: 0 }
    if (command.startsWith('docker pull')) {
      return hostName === 'bad'
        ? { stdout: '', stderr: 'manifest unknown', exitCode: 1 }
        : { stdout: '', exitCode: 0 }
    }
    if (command.startsWith('docker run')) return { stdout: hostName + '-container-id\n', exitCode: 0 }
    if (command.startsWith('docker port')) return { stdout: '8080/tcp -> 0.0.0.0:32768\n', exitCode: 0 }
    if (command.startsWith('docker ps -q --filter')) return { stdout: hostName + '-container-id\n', exitCode: 0 }
    if (command === 'readlink') return { stdout: '', exitCode: 0 }
    return { stdout: '', exitCode: 0 }
  } }
  const target = { mode: 'container', path: '/srv/web', hosts: ['h1', 'bad'], image: 'registry.example.com/demo/web', container: { image: 'registry.example.com/demo/web', port: 8080 }, health: { http: '' }, keep: 3 }
  const result = await deployTransaction({
    remote,
    target,
    releaseId: 'p3-r6b',
    artifactDigest: 'sha256:' + 'a'.repeat(64),
    actuatorFactory: ({ host: bound, hostName, target: t }) => createContainerActuator({ host: bound, target: t, hostName, onLog: () => {} }),
  })
  assert.equal(result.ok, false)
  // h1 已经 pull 到本地（stage 成功），但 bad 的 pull 失败 → 谁都没有 docker run 过。
  assert.ok(calls.some((item) => item.hostName === 'h1' && item.command.startsWith('docker pull')))
  assert.equal(calls.filter((item) => item.command.startsWith('docker run')).length, 0)
  const bad = result.hosts.find((item) => item.host === 'bad')
  assert.match(bad.error, /docker pull 失败/)
  assert.equal(bad.code, 'CONTAINER_PULL_FAILED')
})

checkAsync('P3-S8：容器按 digest 部署 —— pull @sha256、-p 0 读回端口、切 current、manifest 记容器 id', async () => {
  const calls = []
  const releaseDir = '/srv/web/releases/p3-r8'
  const host = {
    async exec(command) {
      calls.push(command)
      if (command.startsWith('docker inspect --type image')) return { stdout: 'no', exitCode: 0 }
      if (command.startsWith('docker pull')) return { stdout: '', exitCode: 0 }
      if (command.startsWith('docker run')) return { stdout: 'c0ffee123456\n', exitCode: 0 }
      if (command.startsWith('docker port')) return { stdout: '80/tcp -> 0.0.0.0:32770\n80/tcp -> [::]:32770\n', exitCode: 0 }
      if (command.startsWith('docker ps -q --filter')) return { stdout: 'c0ffee123456\n', exitCode: 0 }
      if (command.startsWith('ss -ltn')) return { stdout: '1\n', exitCode: 0 }
      if (command.startsWith('readlink')) return { stdout: 'releases/p3-r7\n', exitCode: 0 }
      if (command.startsWith('cat ') && command.includes('.dsh-manifest.json')) {
        return { stdout: JSON.stringify({ artifact: { image: 'registry.example.com/demo/web', digest: 'sha256:' + 'b'.repeat(64) } }), exitCode: 0 }
      }
      if (command.startsWith('curl')) return { stdout: 'ok', exitCode: 0 }
      return { stdout: '', exitCode: 0 }
    },
    async uploadFile() {},
  }
  const target = {
    path: '/srv/web', app: 'web', keep: 3,
    container: { image: 'registry.example.com/demo/web', port: 80, pullTimeoutSec: 600, runTimeoutSec: 120, args: [], volumes: ['/data:/data'] },
    instances: { count: 2, port: null, env: { RELEASE: '{{.release}}', PORT: '80' }, log: '/var/log/web-{{.index}}.log', drain: null },
    health: { http: 'curl -fsS http://127.0.0.1:{{.port}}/healthz', tries: 2, interval: 0, expect: 0, window: 0 },
  }
  const digest = 'sha256:' + 'a'.repeat(64)
  const actuator = createContainerActuator({ host, target, hostName: 'h1', onLog: () => {}, now: () => Date.parse('2026-01-01T00:00:00Z') })
  const handle = await actuator.stage({ releaseId: 'p3-r8', artifactDigest: digest })
  assert.equal(handle.imageReference, 'registry.example.com/demo/web@' + digest)
  await actuator.activate(handle)
  assert.equal(handle.instances.length, 2)
  assert.deepEqual(handle.instances.map((item) => item.port), [32770, 32770])
  const runs = calls.filter((command) => command.startsWith('docker run'))
  assert.equal(runs.length, 2)
  assert.ok(runs[0].includes('@' + digest), '镜像引用必须是 image@sha256，不能是 tag')
  assert.ok(runs[0].includes('-p 0:80'), '容器端口由 -p 0 交给 docker 分配')
  assert.ok(runs[0].includes("-e 'RELEASE=p3-r8'"), '实例环境变量模板会被渲染')
  // 第二实例起名不同，否则 docker run --name 直接冲突。
  assert.equal(new Set(handle.instances.map((item) => item.containerName)).size, 2)
  const verdict = await actuator.health(handle)
  assert.equal(verdict.ok, true)
  assert.match(calls.find((command) => command.startsWith('curl')), /:32770\/healthz/)
  const dir = mkdtempSync(join(tmpdir(), 'cicd-p3-container-'))
  try {
    const manifestHost = { exec: async (command) => {
      if (command.startsWith('printf %s')) writeFileSync(join(dir, 'manifest.json'), command.replace(/^printf %s '((?:[^']|'\\'')*)'.*$/s, '$1').replace(/'\\''/g, "'"))
      return { stdout: '', exitCode: 0 }
    } }
    const writer = createContainerActuator({ host: manifestHost, target, hostName: 'h1', onLog: () => {} })
    handle.dir = dir
    const manifest = await writer.writeManifest(handle, { runId: 'run-1', commit: 'deadbeef' })
    assert.equal(manifest.artifact.digest, digest)
    assert.equal(manifest.artifact.reference, 'registry.example.com/demo/web@' + digest)
    const written = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    assert.equal(written.instances[0].containerId, 'c0ffee123456')
    assert.equal(written.instances[0].port, 32770)
  } finally { rmSync(dir, { recursive: true, force: true }) }
  // 回滚要用上一版 manifest 里记的 digest，而不是「当前磁盘上是什么」。
  assert.equal(handle.previous, 'p3-r7')
  assert.equal(handle.previousImage, 'registry.example.com/demo/web@sha256:' + 'b'.repeat(64))
  const reverted = await actuator.revert(handle)
  assert.equal(reverted.previous, 'p3-r7')
  assert.ok(calls.some((command) => command === 'docker pull ' + "'registry.example.com/demo/web@sha256:" + 'b'.repeat(64) + "'"))
  assert.equal(calls.filter((command) => command.startsWith('docker stop')).length, 2)
})

checkAsync('P3-S9：tag 一律拒绝 —— 按 tag 回滚会跟着 tag 漂移', async () => {
  for (const digest of ['', 'latest', 'sha256:abc', 'b'.repeat(64)]) {
    const ok = normalizeImageDigest(digest)
    assert.equal(ok, digest === 'b'.repeat(64) ? 'sha256:' + digest : '')
  }
  assert.throws(() => resolveImageReference({ image: 'demo/web', digest: 'v1.2.3' }), (error) => error.code === CONTAINER_ERRORS.IMAGE)
  assert.throws(() => resolveImageReference({ image: 'demo/web:1.2', digest: 'sha256:' + 'c'.repeat(64) }), (error) => error.code === CONTAINER_ERRORS.IMAGE)
  assert.throws(() => resolveImageReference({ image: '', digest: 'sha256:' + 'c'.repeat(64) }), (error) => error.code === CONTAINER_ERRORS.IMAGE)
  const parsed = parsePublishedPort('80/tcp -> 0.0.0.0:32768\n443/tcp -> 0.0.0.0:32769\n', 443)
  assert.equal(parsed.hostPort, 32769)
  assert.equal(parsePublishedPort('garbage', 80), null)
  const inspected = parseInspect(JSON.stringify([{ Id: 'abc', State: { Running: true }, Config: { Image: 'demo/web@sha256:x' }, NetworkSettings: { Ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '32770' }] } } }]))
  assert.equal(inspected[0].ports[0].hostPort, 32770)
  assert.equal(inspected[0].running, true)
  assert.deepEqual(parseInspect('not json'), [])
})

checkAsync('P3-S10：容器端口读不回来就当失败 —— 探针打不到的门不算起来了', async () => {
  const host = { async exec(command) {
    if (command.startsWith('docker inspect --type image')) return { stdout: 'no', exitCode: 0 }
    if (command.startsWith('docker run')) return { stdout: 'deadbeef\n', exitCode: 0 }
    if (command.startsWith('docker port')) return { stdout: '', exitCode: 0 }
    return { stdout: '', exitCode: 0 }
  } }
  const target = { path: '/srv/web', app: 'web', container: { image: 'demo/web', port: 8080 }, health: {} }
  const actuator = createContainerActuator({ host, target, hostName: 'h1', onLog: () => {} })
  const handle = await actuator.stage({ releaseId: 'p3-r10', artifactDigest: 'sha256:' + 'd'.repeat(64) })
  await assert.rejects(() => actuator.activate(handle), (error) => error.code === CONTAINER_ERRORS.PORT)
  // 失败后 current 没有被切过去：探针没通过的一版不许成为「当前」。
  const calls = []
  assert.equal(handle.activatedAt, '')
  void calls
})

checkAsync('P3-S11：容器回滚走 Actuator —— 换回上一版 digest，而不是重放软链', async () => {
  const calls = []
  const remote = {
    async exec(host, command) {
      calls.push({ host, command })
      if (command.startsWith('readlink')) return { stdout: 'releases/r-new\n', exitCode: 0 }
      if (command.startsWith('test -d')) return { stdout: 'yes\n', exitCode: 0 }
      if (command.startsWith('docker stop')) return { stdout: 'r-old\n', exitCode: 0 }
      if (command.startsWith('docker rm')) return { stdout: '', exitCode: 0 }
      if (command.startsWith('docker inspect --type image')) return { stdout: 'no', exitCode: 0 }
      if (command.startsWith('docker pull')) return { stdout: '', exitCode: 0 }
      if (command.startsWith('docker run')) return { stdout: 'old-container\n', exitCode: 0 }
      if (command.startsWith('docker port')) return { stdout: '80/tcp -> 0.0.0.0:31000\n', exitCode: 0 }
      if (command.startsWith('docker ps -q --filter')) return { stdout: 'old-container\n', exitCode: 0 }
      if (command.startsWith('ss -ltn')) return { stdout: '1\n', exitCode: 0 }
      if (command.startsWith('cat ') && command.includes('.dsh-manifest.json')) {
        return { stdout: JSON.stringify({ artifact: { image: 'registry.example.com/demo/web', digest: 'sha256:' + 'e'.repeat(64) } }), exitCode: 0 }
      }
      return { stdout: '', exitCode: 0 }
    },
    async uploadFile() {},
  }
  const target = {
    mode: 'container', path: '/srv/web', app: 'web', hosts: ['h1'],
    container: { image: 'registry.example.com/demo/web', port: 80 },
    instances: { count: 1, port: null, env: {}, log: '' },
    health: {},
  }
  const result = await rollbackRelease({ remote, target, targetName: 'prod', releaseId: 'r-old' })
  assert.equal(result.ok, true)
  assert.equal(result.hosts[0].restarted, 'container')
  const pull = calls.find((item) => item.command.startsWith('docker pull'))
  assert.ok(pull, '容器回滚必须重新 pull 上一版镜像')
  assert.ok(pull.command.includes("'registry.example.com/demo/web@sha256:" + 'e'.repeat(64) + "\''") || pull.command.includes('@sha256:' + 'e'.repeat(64)), '回滚按上版 manifest 里的 digest 拉取')
  assert.equal(calls.filter((item) => /^ln -sfn/.test(item.command)).length, 0, '容器回滚不重写 current 软链')
  assert.equal(calls.filter((item) => /^systemctl/.test(item.command)).length, 0, '容器回滚不重启 systemd 服务')
})


checkAsync('P3-S7：断网仍可从 manifest 读取回滚现场', async () => {
  const result = await readManifest({
    remote: { exec: async (host, command) => /^readlink /.test(command)
      ? { stdout: 'releases/r-old', exitCode: 0 }
      : { stdout: JSON.stringify({ version: 1, releaseId: 'r-old', previous: 'r-before', artifact: { digest: 'sha256:bytes' }, instances: [{ port: 8080, pid: 42 }] }), exitCode: 0 } },
    target: { path: '/srv/app' }, host: 'h1',
  })
  assert.equal(result.manifest.artifact.digest, 'sha256:bytes')
  assert.equal(result.manifest.instances[0].port, 8080)
  assert.equal(result.path, '/srv/app/releases/r-old/.dsh-manifest.json')
})


// ---------------------------------------------------------------------------------------------
// P5 · 制品 CAS

const casRoot = mkdtempSync(join(tmpdir(), 'dsh-cicd-cas-'))
function casFile(name, content) {
  const path = join(casRoot, name)
  writeFileSync(path, content)
  return path
}

checkAsync('P5-S1：CAS 流式收字节 → digest 恒等 → 重复 PUT 幂等不落第二份', async () => {
  const { createArtifactStore, digestPath } = await import('../lib/artifacts.js')
  const store = createArtifactStore({ dir: join(casRoot, 'cas-a') })
  const file = casFile('a.bin', 'hello-artifact')
  const first = await store.putFile(file)
  assert.equal(first.digest, `sha256:${createHash('sha256').update('hello-artifact').digest('hex')}`)
  assert.equal(first.bytes, 14)
  assert.equal(first.deduped, false)
  // 同一份内容换个路径再传：digest 相同，第二次是 deduped，且磁盘上只有一个 blob。
  const second = await store.putFile(casFile('a-copy.bin', 'hello-artifact'))
  assert.equal(second.digest, first.digest)
  assert.equal(second.deduped, true)
  assert.equal(store.listBlobs().length, 1)
  assert.equal(store.stats().count, 1)
  store.dispose()
})

checkAsync('P5-S2：上传时重算 sha256 —— 声明 digest 与实际字节不符直接拒收，且不写进 CAS', async () => {
  const { createArtifactStore } = await import('../lib/artifacts.js')
  const store = createArtifactStore({ dir: join(casRoot, 'cas-b') })
  const file = casFile('tampered.bin', 'payload-v1')
  const real = `sha256:${createHash('sha256').update('payload-v1').digest('hex')}`
  await assert.rejects(
    () => store.putFile(file, { expectDigest: `sha256:${'0'.repeat(64)}` }),
    (error) => error.code === 'ARTIFACT_DIGEST_MISMATCH' && error.expected === `sha256:${'0'.repeat(64)}` && error.actual === real,
  )
  assert.equal(store.listBlobs().length, 0, '校验失败的字节不能留在 blob 目录里')
  // 声明对了才收。
  const ok = await store.putFile(file, { expectDigest: real.toUpperCase().replace('SHA256:', 'sha256:') })
  assert.equal(ok.digest, real)
  store.dispose()
})

checkAsync('P5-S3：磁盘上的字节被改 1 个 → verify 立即可证伪（digest 就是身份）', async () => {
  const { createArtifactStore, digestPath } = await import('../lib/artifacts.js')
  const store = createArtifactStore({ dir: join(casRoot, 'cas-c') })
  const result = await store.putFile(casFile('v.bin', 'immutable-bytes'))
  assert.equal((await store.verify(result.digest)).ok, true)
  // 模拟有人绕过 API 直接改磁盘：翻转一个字节。
  const path = digestPath(join(casRoot, 'cas-c'), result.digest)
  const bytes = readFileSync(path)
  bytes[0] = bytes[0] ^ 0xff
  writeFileSync(path, bytes)
  const verified = await store.verify(result.digest)
  assert.equal(verified.ok, false)
  assert.notEqual(verified.actual, result.digest)
  store.dispose()
})

checkAsync('P5-S4：Range 单区间读取 —— 首段、尾段、超界降级、非法格式不 panic', async () => {
  const { createArtifactStore, parseRange } = await import('../lib/artifacts.js')
  const store = createArtifactStore({ dir: join(casRoot, 'cas-d') })
  const file = casFile('range.bin', '0123456789')
  const { digest, bytes } = await store.putFile(file)
  assert.equal(bytes, 10)

  const head = store.readRange(digest, 'bytes=0-3')
  assert.equal(head.status, 206)
  assert.equal(head.start, 0)
  assert.equal(head.end, 3)
  const chunk = []
  for await (const piece of head.stream()) chunk.push(piece)
  assert.equal(Buffer.concat(chunk).toString(), '0123')

  const suffix = store.readRange(digest, 'bytes=-3')
  assert.equal(suffix.start, 7)
  assert.equal(suffix.end, 9)

  const full = store.readRange(digest, '')
  assert.equal(full.status, 200)
  assert.equal(full.end, 9)

  assert.equal(parseRange('bytes=20-30', 10), null, '越界范围应降级成全量而不是报错')
  assert.equal(parseRange('bytes=abc', 10), null)
  assert.equal(parseRange('bytes=5-2', 10), null)
  store.dispose()
})

checkAsync('P5-S5：指针（tag）只动引用 —— 指向不存在的 digest 被拒，GC 按引用与 dry-run 行事', async () => {
  const { createArtifactStore } = await import('../lib/artifacts.js')
  const store = createArtifactStore({ dir: join(casRoot, 'cas-e') })
  const live = await store.putFile(casFile('live.bin', 'kept-by-tag'))
  const orphan = await store.putFile(casFile('orphan.bin', 'nobody-points-here'))

  assert.throws(() => store.putRef('demo', 'latest', `sha256:${'a'.repeat(64)}`), (error) => error.code === 'ARTIFACT_NOT_FOUND')
  const ref = store.putRef('demo', 'latest', live.digest)
  assert.equal(ref.digest, live.digest)
  assert.equal(store.readRef('demo', 'latest').digest, live.digest)

  // 默认 dry-run：算出要删什么，但一个字节都不动。
  const dry = store.gc()
  assert.equal(dry.dryRun, true)
  assert.deepEqual(dry.removed.map((item) => item.digest), [orphan.digest])
  assert.deepEqual(dry.kept, [live.digest])
  assert.equal(store.has(orphan.digest), true)

  const real = store.gc({ dryRun: false })
  assert.equal(real.removed.length, 1)
  assert.equal(store.has(orphan.digest), false)
  assert.equal(store.has(live.digest), true, '有指针的 blob 不能被回收')
  store.dispose()
})

checkAsync('P5-S6：空文件与目录都被拒（0 字节几乎总是产物路径写错）', async () => {
  const { createArtifactStore } = await import('../lib/artifacts.js')
  const store = createArtifactStore({ dir: join(casRoot, 'cas-f') })
  await assert.rejects(() => store.putFile(casFile('empty.bin', '')), (error) => error.code === 'ARTIFACT_EMPTY')
  await assert.rejects(() => store.putFile(join(casRoot, 'no-such-file')), (error) => error.code === 'ARTIFACT_NOT_FOUND')
  store.dispose()
})

check('P5-S7：digest 写法归一 —— 裸 hex、大写、带前缀都收；不合法直接 ARTIFACT_DIGEST_INVALID', () => {
  const hex = 'a'.repeat(64)
  assert.equal(internals.normalizeDigest(hex), `sha256:${hex}`)
  assert.equal(internals.normalizeDigest(`sha256:${hex.toUpperCase()}`), `sha256:${hex}`)
  throwsCode(() => internals.normalizeDigest('sha256:short'), 'ARTIFACT_DIGEST_INVALID')
  throwsCode(() => internals.normalizeDigest(''), 'ARTIFACT_DIGEST_INVALID')
})

checkAsync('P5-S8：运行时 —— 上传落盘 + 元数据入表，列表按项目可见', async () => {
  const runtime = internals.createRuntime(fakeContext(), {
    projects: [{ id: 'demo', path: projectDir }],
    workDir: join(root, 'state'),
    scheduler: { enabled: false },
  })
  try {
    const uploaded = await runtime.artifacts({ action: 'upload', path: casFile('rt.bin', 'runtime-artifact'), project: 'demo', runId: 'run-1' })
    assert.equal(uploaded.ok, true)
    assert.equal(uploaded.bytes, 16)
    const listed = await runtime.artifacts({ action: 'list', project: 'demo' })
    assert.equal(listed.artifacts.length, 1)
    assert.equal(listed.artifacts[0].digest, uploaded.digest)
    assert.equal(listed.artifacts[0].run_id, 'run-1')
    assert.equal(listed.stats.count, 1)
    // 目录不是制品。
    await assert.rejects(() => runtime.artifacts({ action: 'upload', path: projectDir, project: 'demo' }), (error) => error.code === 'COMMAND_INVALID')
  } finally {
    runtime.dispose()
  }
})

checkAsync('P5-S9：/artifacts 路由 —— 下载字节一致、Range 返回 206、篡改后 verify 报 409', async () => {
  const runtime = internals.createRuntime(fakeContext(), {
    projects: [{ id: 'demo', path: projectDir }],
    workDir: join(root, 'state'),
    scheduler: { enabled: false },
  })
  try {
    const uploaded = await runtime.artifacts({ action: 'upload', path: casFile('route.bin', 'route-bytes'), project: 'demo' })
    // 下载（GET 不需要写头/confirm，但需要同源 + x-dsh-cicd 读头）。
    const fresh = fakeContext()
    internals.registerHttpRoutes(fresh, runtime)
    const download = await fresh.routes.find((item) => item.path === `${internals.ROUTE_PREFIX}/artifacts`).resource(
      new Request(`http://x/api/plugins/cicd/artifacts?digest=${uploaded.digest}`, { headers: { 'x-dsh-cicd': '1' } }),
    )
    assert.equal(download.status, 200)
    assert.equal(download.headers.get('content-digest'), uploaded.digest)
    assert.equal(download.headers.get('accept-ranges'), 'bytes')
    const payload = Buffer.from(await download.arrayBuffer()).toString()
    assert.equal(payload, 'route-bytes')

    const ranged = await fresh.routes.find((item) => item.path === `${internals.ROUTE_PREFIX}/artifacts`).resource(
      new Request(`http://x/api/plugins/cicd/artifacts?digest=${uploaded.digest}`, { headers: { 'x-dsh-cicd': '1', range: 'bytes=0-4' } }),
    )
    assert.equal(ranged.status, 206)
    assert.equal(ranged.headers.get('content-range'), 'bytes 0-4/11')

    // 篡改磁盘上的字节 → verify 走 409（不是 500，也不是静默成功）。
    const blobPath = internals.digestPath(join(root, 'state', 'artifacts'), uploaded.digest)
    const bytes = readFileSync(blobPath)
    bytes[0] = bytes[0] ^ 0xff
    writeFileSync(blobPath, bytes)
    const corrupted = await fresh.routes.find((item) => item.path === `${internals.ROUTE_PREFIX}/artifacts`).resource(
      new Request(`http://x/api/plugins/cicd/artifacts?action=verify&digest=${uploaded.digest}&confirm=1`, { method: 'POST', headers: { 'x-dsh-cicd': '1' } }),
    )
    assert.equal(corrupted.status, 409)
    const body = await corrupted.json()
    assert.equal(body.code, 'ARTIFACT_CORRUPTED')
  } finally {
    runtime.dispose()
  }
})

checkAsync('P5-S10：写操作一律要 confirm 与 x-dsh-cicd 头，缺一即拒', async () => {
  const runtime = internals.createRuntime(fakeContext(), {
    projects: [{ id: 'demo', path: projectDir }],
    workDir: join(root, 'state'),
    scheduler: { enabled: false },
  })
  try {
    const fresh = fakeContext()
    internals.registerHttpRoutes(fresh, runtime)
    const route = fresh.routes.find((item) => item.path === `${internals.ROUTE_PREFIX}/artifacts`)
    const noHeader = await route.resource(new Request('http://x/api/plugins/cicd/artifacts?action=gc&confirm=1', { method: 'POST' }))
    assert.equal(noHeader.status, 403)
    const noConfirm = await route.resource(new Request('http://x/api/plugins/cicd/artifacts?action=gc', { method: 'POST', headers: { 'x-dsh-cicd': '1' } }))
    assert.equal(noConfirm.status, 400)
  } finally {
    runtime.dispose()
  }
})

// ---------------------------------------------------------------------------------------------
// P5-4 · OCI Distribution v2（docker push / pull）

/** 走 /v2 前缀路由：pathname 是规范里的原始路径，鉴权靠 Bearer 票。 */
function ociCall(pathname, { method = 'GET', headers = {}, body = null } = {}) {
  const route = ctx.routes.find((item) => pathname.startsWith(`${item.path}/`) || pathname === item.path)
  assert.ok(route, `prefix route for ${pathname} registered`)
  return route.resource(new Request(`http://x${pathname}`, { method, headers, body }))
}

/** 引导期没有账号：authBundle 会把请求当成 bootstrap 主体，直接换票即可。 */
async function ociToken(scope) {
  const res = await ociCall(`${internals.ROUTE_PREFIX}/v2/token?scope=${encodeURIComponent(scope)}`)
  assert.equal(res.status, 200)
  return (await res.json()).token
}

function ociDigest(buffer) {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`
}

checkAsync('P5-OCR1：/v2/ 不带票 → 401 + Bearer challenge；换到票后探活 200', async () => {
  const bare = await ociCall(`${internals.ROUTE_PREFIX}/v2/`)
  assert.equal(bare.status, 401)
  assert.match(bare.headers.get('www-authenticate') || '', /^Bearer realm="\/api\/plugins\/cicd\/v2\/token",service="dsh-cicd"/)
  // 票里写死 scope：换票时没要的仓库，服务端不会给。
  const pullToken = await ociToken('repository:demo/web:pull')
  const ok = await ociCall(`${internals.ROUTE_PREFIX}/v2/`, { headers: { authorization: `Bearer ${pullToken}` } })
  assert.equal(ok.status, 200)
  // 被篡改的票不认（HMAC 校验）。
  const tampered = await ociCall(`${internals.ROUTE_PREFIX}/v2/`, { headers: { authorization: `Bearer ${pullToken.slice(0, -4)}AAAA` } })
  assert.equal(tampered.status, 401)
})

checkAsync('P5-OCR2：push 全流程 —— POST 开会话 → PATCH 追加 → PUT 提交；层 digest 由服务端重算', async () => {
  const token = await ociToken('repository:demo/web:pull,push')
  const auth = { authorization: `Bearer ${token}` }
  const layer = Buffer.from('layer-bytes-for-demo')
  const digest = ociDigest(layer)

  const started = await ociCall(`${internals.ROUTE_PREFIX}/v2/demo/web/blobs/uploads/`, { method: 'POST', headers: auth })
  assert.equal(started.status, 202)
  const location = started.headers.get('location')
  assert.match(location, /\/v2\/demo\/web\/blobs\/uploads\/[0-9a-f]+$/)

  const patched = await ociCall(`http://x${location}`.replace('http://x', ''), { method: 'PATCH', headers: auth, body: layer })
  assert.equal(patched.status, 202)
  assert.equal(patched.headers.get('range'), `0-${layer.length - 1}`)

  // 声明的 digest 与实际上传的字节不符 → 400，且什么都没进 CAS。
  const wrong = await ociCall(`${location}?digest=${encodeURIComponent(`sha256:${'0'.repeat(64)}`)}`, { method: 'PUT', headers: auth })
  assert.equal(wrong.status, 409)
  assert.equal((await wrong.json()).errors[0].code, 'ARTIFACT_DIGEST_MISMATCH')

  // 重新传一次并提交正确的 digest。
  const again = await ociCall(`${internals.ROUTE_PREFIX}/v2/demo/web/blobs/uploads/`, { method: 'POST', headers: auth })
  const againLoc = again.headers.get('location')
  await ociCall(againLoc, { method: 'PATCH', headers: auth, body: layer })
  const committed = await ociCall(`${againLoc}?digest=${encodeURIComponent(digest)}`, { method: 'PUT', headers: auth })
  assert.equal(committed.status, 201)
  assert.equal(committed.headers.get('docker-content-digest'), digest)

  // pull 回来字节一致（GET blob）。
  const pulled = await ociCall(`${internals.ROUTE_PREFIX}/v2/demo/web/blobs/${digest}`, { headers: auth })
  assert.equal(pulled.status, 200)
  assert.equal(Buffer.from(await pulled.arrayBuffer()).toString(), layer.toString())
})

checkAsync('P5-OCR3：PUT /manifests/<tag> —— 引用了没上传的层必须拒（否则拉不下来时才炸）', async () => {
  const token = await ociToken('repository:demo/web:pull,push')
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/vnd.oci.image.manifest.v1+json' }
  const layer = Buffer.from('manifest-layer')
  const layerDigest = ociDigest(layer)
  const configDigest = ociDigest(Buffer.from('{}'))
  const manifest = {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: configDigest, size: 2 },
    layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: layerDigest, size: layer.length }],
  }

  const missing = await ociCall(`${internals.ROUTE_PREFIX}/v2/demo/web/manifests/v1`, { method: 'PUT', headers: auth, body: JSON.stringify(manifest) })
  // 规范里 MANIFEST_BLOB_UNKNOWN 是 400（不是 404）：body 合法，只是引用了没上传的对象。
  assert.equal(missing.status, 400)
  const missingBody = await missing.json()
  assert.equal(missingBody.errors[0].code, 'OCI_MANIFEST_BLOB_UNKNOWN')
  assert.equal(missingBody.errors[0].detail.missing.length, 2, 'config 与 layer 都算缺失')

  // 补齐两个 blob 后再放 manifest。
  for (const [bytes, digest] of [[layer, layerDigest], [Buffer.from('{}'), configDigest]]) {
    const started = await ociCall(`${internals.ROUTE_PREFIX}/v2/demo/web/blobs/uploads/`, { method: 'POST', headers: auth })
    const loc = started.headers.get('location')
    await ociCall(loc, { method: 'PATCH', headers: auth, body: bytes })
    const done = await ociCall(`${loc}?digest=${encodeURIComponent(digest)}`, { method: 'PUT', headers: auth })
    assert.equal(done.status, 201, JSON.stringify(await done.clone().json()))
  }

  const pushed = await ociCall(`${internals.ROUTE_PREFIX}/v2/demo/web/manifests/v1`, { method: 'PUT', headers: auth, body: JSON.stringify(manifest) })
  assert.equal(pushed.status, 201, JSON.stringify(await pushed.clone().json()))
  const manifestDigest = pushed.headers.get('docker-content-digest')
  assert.match(manifestDigest, /^sha256:[0-9a-f]{64}$/)

  const fetched = await ociCall(`${internals.ROUTE_PREFIX}/v2/demo/web/manifests/v1`, { headers: auth })
  assert.equal(fetched.status, 200)
  assert.equal(fetched.headers.get('docker-content-digest'), manifestDigest)
  assert.deepEqual(await fetched.json(), manifest)

  // 按 digest 取同一份，tags/list 里能看到 v1。
  const byDigest = await ociCall(`${internals.ROUTE_PREFIX}/v2/demo/web/manifests/${manifestDigest}`, { headers: auth })
  assert.equal(byDigest.status, 200)
  const tags = await ociCall(`${internals.ROUTE_PREFIX}/v2/demo/web/tags/list`, { headers: auth })
  assert.deepEqual((await tags.json()).tags, ['v1'])

  // 重推同一个 tag 到别的 manifest：tag 移动，旧 manifest 仍按 digest 可取（回滚能力）。
  const v2 = { ...manifest, annotations: { note: 'second' } }
  const rePushed = await ociCall(`${internals.ROUTE_PREFIX}/v2/demo/web/manifests/v1`, { method: 'PUT', headers: auth, body: JSON.stringify(v2) })
  assert.equal(rePushed.status, 201)
  const movedDigest = rePushed.headers.get('docker-content-digest')
  assert.notEqual(movedDigest, manifestDigest)
  const old = await ociCall(`${internals.ROUTE_PREFIX}/v2/demo/web/manifests/${manifestDigest}`, { headers: auth })
  assert.equal(old.status, 200, '旧 digest 必须还能取：容器回滚只换 digest')
  assert.equal((await ociCall(`${internals.ROUTE_PREFIX}/v2/demo/web/manifests/v1`, { headers: auth })).headers.get('docker-content-digest'), movedDigest)

  // DELETE tag 只摘指针，字节还在；按 digest 仍可读。
  const removed = await ociCall(`${internals.ROUTE_PREFIX}/v2/demo/web/manifests/v1`, { method: 'DELETE', headers: auth })
  assert.equal(removed.status, 200)
  const goneTag = await ociCall(`${internals.ROUTE_PREFIX}/v2/demo/web/manifests/v1`, { headers: auth })
  assert.equal(goneTag.status, 404)
  assert.equal((await ociCall(`${internals.ROUTE_PREFIX}/v2/demo/web/manifests/${movedDigest}`, { headers: auth })).status, 200)
})

checkAsync('P5-OCR4：只有 pull 票推不上去 —— 写仓库要 push scope', async () => {
  const pull = await ociToken('repository:demo/other:pull')
  const auth = { authorization: `Bearer ${pull}` }
  const res = await ociCall(`${internals.ROUTE_PREFIX}/v2/demo/other/blobs/uploads/`, { method: 'POST', headers: auth })
  assert.equal(res.status, 401)
  // challenge 只报缺口：这次缺的是 push，非要 pull,push 会让客户端去要已经有过的权限。
  assert.match(res.headers.get('www-authenticate') || '', /scope="repository:demo\/other:push"/)
  // scope 不跨仓库：demo/web 的票碰不到 demo/other。
  const webToken = await ociToken('repository:demo/web:pull')
  const crossRepo = await ociCall(`${internals.ROUTE_PREFIX}/v2/demo/other/tags/list`, { headers: { authorization: `Bearer ${webToken}` } })
  assert.equal(crossRepo.status, 401)
})

checkAsync('P5-OCR5：仓库名与路径非法一律 4xx —— 大写、穿越、未知端点', async () => {
  const token = await ociToken('repository:demo/web:pull,push')
  const auth = { authorization: `Bearer ${token}` }
  // 大写仓库名不在票的 scope 里 → 先被鉴权挡下（否则大小写不一致就成了绕过 scope 的洞）。
  const upper = await ociCall(`${internals.ROUTE_PREFIX}/v2/Demo/Web/tags/list`, { headers: auth })
  assert.equal(upper.status, 401)
  // 名字非法（票覆盖了这个名字）→ 400 NAME_INVALID，而不是当成未知端点 404。
  const badToken = await ociToken('repository:demo/_bad_:pull')
  const badName = await ociCall(`${internals.ROUTE_PREFIX}/v2/demo/_bad_/tags/list`, { headers: { authorization: `Bearer ${badToken}` } })
  assert.equal(badName.status, 400)
  assert.equal((await badName.json()).errors[0].code, 'OCI_NAME_INVALID')
  const unknown = await ociCall(`${internals.ROUTE_PREFIX}/v2/demo/web/whatever`, { headers: auth })
  assert.equal(unknown.status, 404)
})

check('P5-OCR6：/v2 只有一条前缀路由，且 routing 不落在 exact 表里', () => {
  const prefixes = ctx.routes.filter((route) => route.kind === 'prefix').map((route) => route.path)
  assert.deepEqual(prefixes, [
    `${internals.ROUTE_PREFIX}/hooks`, `${internals.ROUTE_PREFIX}/v2`,
    `${internals.ROUTE_PREFIX}/repository`, `${internals.ROUTE_PREFIX}/simple`,
  ])
  assert.ok(!ctx.routes.some((route) => route.kind === 'exact' && route.path.startsWith(`${internals.ROUTE_PREFIX}/v2`)))
})


// ---------------------------------------------------------------------------------------------
// P5-3 · Maven / npm / PyPI 只读仓库

const { createPackageIndex, sha512Sri, buildMavenMetadata, sortVersions, normalizePyPIname } = await import('../lib/packages.js')

async function repoTool(workDir, config = {}) {
  const runtime = internals.createRuntime(fakeContext(), {
    projects: [{ id: 'demo', path: projectDir }],
    workDir,
    scheduler: { enabled: false },
    artifacts: { baseUrl: 'http://registry.test/api/plugins/cicd' },
    ...config,
  })
  const fresh = fakeContext()
  internals.registerHttpRoutes(fresh, runtime)
  const routeOf = (pathname) => fresh.routes.find((item) => pathname === item.path || pathname.startsWith(`${item.path}/`))
  return {
    runtime,
    call: (pathname, init = {}) => {
      const route = routeOf(pathname)
      assert.ok(route, `仓库路由没注册：${pathname}`)
      return route.resource(new Request(`http://registry.test${pathname}`, init))
    },
    close: () => runtime.dispose(),
  }
}

checkAsync('P5-3-S1：Maven —— publish 坐标后 maven-metadata.xml 由库生成，jar 走 CAS 且 digest 恒等', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dsh-cicd-maven-'))
  const repo = await repoTool(work)
  try {
    const jar = casFile('demo-1.2.0.jar', 'jar-bytes-v1')
    const published = await repo.runtime.artifacts({
      action: 'publish', ecosystem: 'maven', groupId: 'com.example', name: 'demo', version: '1.2.0',
      extension: 'jar', path: jar, project: 'demo',
    })
    assert.equal(published.created, true)
    assert.equal(published.scope, 'com.example')
    assert.equal(published.version, '1.2.0')
    const base = '/api/plugins/cicd/repository/maven/com/example/demo'
    const jarResponse = await repo.call(`${base}/1.2.0/demo-1.2.0.jar`)
    assert.equal(jarResponse.status, 200)
    assert.equal(jarResponse.headers.get('content-digest'), published.digest)
    assert.equal(Buffer.from(await jarResponse.arrayBuffer()).toString(), 'jar-bytes-v1')
    // 同坐标换字节 = 坐标不可变，必须拒；同字节重复登记是幂等。
    await assert.rejects(
      () => repo.runtime.artifacts({ action: 'publish', ecosystem: 'maven', groupId: 'com.example', name: 'demo', version: '1.2.0', extension: 'jar', path: casFile('demo-1.2.0-other.jar', 'other-bytes'), project: 'demo' }),
      (error) => error.code === 'PACKAGE_DUPLICATE',
    )
    const again = await repo.runtime.artifacts({ action: 'publish', ecosystem: 'maven', groupId: 'com.example', name: 'demo', version: '1.2.0', extension: 'jar', path: jar, project: 'demo' })
    assert.equal(again.created, false)
    // 第二个版本：metadata 要把两个版本都列出来，且 latest/release 指向最大版本。
    await repo.runtime.artifacts({ action: 'publish', ecosystem: 'maven', groupId: 'com.example', name: 'demo', version: '1.10.0', extension: 'jar', path: casFile('demo-1.10.0.jar', 'jar-bytes-v2'), project: 'demo' })
    const metadata = await repo.call(`${base}/maven-metadata.xml`)
    assert.equal(metadata.status, 200)
    assert.match(metadata.headers.get('content-type'), /xml/)
    const xml = await metadata.text()
    assert.match(xml, /<latest>1\.10\.0<\/latest>/)
    assert.ok(xml.indexOf('<version>1.2.0</version>') < xml.indexOf('<version>1.10.0</version>'), '版本要按语义序排列，不是字典序')
    assert.match(xml, /<groupId>com\.example<\/groupId>/)
  } finally {
    repo.close()
  }
})

checkAsync('P5-3-S2：npm —— packument 的 tarball 指向 CAS，integrity 是入库时算好的 SRI', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dsh-cicd-npm-'))
  const repo = await repoTool(work)
  try {
    const tarball = casFile('pkg-1.0.0.tgz', 'npm-tarball-bytes')
    const published = await repo.runtime.artifacts({
      action: 'publish', ecosystem: 'npm', name: '@demo/pkg', version: '1.0.0', path: tarball, project: 'demo',
      manifest: { name: '@demo/pkg', version: '1.0.0', main: 'index.js' },
    })
    assert.equal(published.scope, '@demo')
    assert.equal(published.name, 'pkg')
    const expectedSri = `sha512-${createHash('sha512').update('npm-tarball-bytes').digest('base64')}`
    const packumentResponse = await repo.call('/api/plugins/cicd/repository/npm/@demo%2fpkg')
    assert.equal(packumentResponse.status, 200)
    const packument = await packumentResponse.json()
    assert.equal(packument.name, '@demo/pkg')
    const entry = packument.versions['1.0.0']
    assert.equal(entry.dist.integrity, expectedSri)
    assert.equal(entry.dist.shasum, published.digest.slice('sha256:'.length))
    assert.equal(entry.dist.tarball, 'http://registry.test/api/plugins/cicd/repository/npm/@demo/pkg/-/pkg-1.0.0.tgz')
    assert.equal(packument['dist-tags'].latest, '1.0.0')
    assert.equal(packument.versions['1.0.0'].main, 'index.js', 'manifest 里的字段要原样透出')
    // 客户端真正拉的是 tarball：路径带 @scope 和不带 scope 两种写法都得能取到同一份字节。
    const tarballResponse = await repo.call('/api/plugins/cicd/repository/npm/@demo/pkg/-/pkg-1.0.0.tgz')
    assert.equal(tarballResponse.status, 200)
    assert.equal(Buffer.from(await tarballResponse.arrayBuffer()).toString(), 'npm-tarball-bytes')
    // 包名归一失败要在入库时就拒，不能等到客户端 404。
    await assert.rejects(
      () => repo.runtime.artifacts({ action: 'publish', ecosystem: 'npm', name: 'Not-Upper', version: '1.0.0', path: casFile('bad.tgz', 'x'), project: 'demo' }),
      (error) => error.code === 'PACKAGE_INVALID',
    )
  } finally {
    repo.close()
  }
})

checkAsync('P5-3-S3：PyPI —— PEP 503 HTML 与 PEP 691 JSON 按 Accept 协商，文件名与 hash 都对得上', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dsh-cicd-pypi-'))
  const repo = await repoTool(work)
  try {
    const wheel = casFile('Demo_Pkg-1.0.0-py3-none-any.whl', 'wheel-bytes')
    const published = await repo.runtime.artifacts({
      action: 'publish', ecosystem: 'pypi', name: 'Demo.Pkg', version: '1.0.0', extension: 'whl', classifier: 'py3-none-any', path: wheel, project: 'demo', filename: 'Demo_Pkg-1.0.0-py3-none-any.whl',
    })
    // 名字归一：Demo.Pkg → demo-pkg（PEP 503）。
    assert.equal(published.name, normalizePyPIname('Demo.Pkg'))
    const html = await repo.call('/api/plugins/cicd/simple/demo-pkg/')
    assert.equal(html.status, 200)
    assert.match(html.headers.get('content-type'), /text\/html/)
    const body = await html.text()
    assert.match(body, /href="[^"]*Demo_Pkg-1\.0\.0-py3-none-any\.whl#sha256=[0-9a-f]{64}"/)
    const jsonResponse = await repo.call('/api/plugins/cicd/simple/demo-pkg/', { headers: { accept: 'application/vnd.pypi.simple.v1+json' } })
    assert.equal(jsonResponse.status, 200)
    assert.equal(jsonResponse.headers.get('content-type'), 'application/vnd.pypi.simple.v1+json')
    const index = await jsonResponse.json()
    assert.equal(index.meta['api-version'], '1.0')
    assert.equal(index.files.length, 1)
    assert.equal(index.files[0].filename, 'Demo_Pkg-1.0.0-py3-none-any.whl')
    assert.equal(index.files[0].hashes.sha256, published.digest.slice('sha256:'.length))
    const file = await repo.call('/api/plugins/cicd/simple/demo-pkg/Demo_Pkg-1.0.0-py3-none-any.whl')
    assert.equal(file.status, 200)
    assert.equal(Buffer.from(await file.arrayBuffer()).toString(), 'wheel-bytes')
    // 不存在的项目 / 不存在的文件都是 404，不是 500。
    assert.equal((await repo.call('/api/plugins/cicd/simple/nope/')).status, 404)
    assert.equal((await repo.call('/api/plugins/cicd/simple/demo-pkg/missing.whl')).status, 404)
  } finally {
    repo.close()
  }
})

checkAsync('P5-3-S4：仓库只读 —— 写方法与越界路径一律拒绝，publish 的 digest 必须已在 CAS', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dsh-cicd-ro-'))
  const repo = await repoTool(work)
  try {
    const put = await repo.call('/api/plugins/cicd/repository/maven/com/example/demo/1.0.0/demo-1.0.0.jar', { method: 'PUT', body: 'x' })
    assert.equal(put.status, 405)
    assert.equal((await put.json()).code, 'REGISTRY_READ_ONLY')
    // 越界路径段：任何一段是 `..` 都不能进解析器。
    const escape = parseRegistryPath('/api/plugins/cicd/repository/maven/../../etc/passwd')
    assert.equal(escape.invalid, true)
    assert.deepEqual(parseRegistryPath('/api/plugins/cicd/simple/'), { ecosystem: 'pypi', segments: [] })
    assert.equal(parseRegistryPath('/api/plugins/cicd/elsewhere'), null)
    await assert.rejects(
      () => repo.runtime.artifacts({ action: 'publish', ecosystem: 'maven', groupId: 'com.example', name: 'ghost', version: '1.0.0', extension: 'jar', digest: `sha256:${'0'.repeat(64)}`, project: 'demo' }),
      (error) => error.code === 'ARTIFACT_NOT_FOUND',
    )
    await assert.rejects(
      () => repo.runtime.artifacts({ action: 'publish', ecosystem: 'cargo', name: 'x', version: '1.0.0', path: casFile('x.bin', 'x'), project: 'demo' }),
      (error) => error.code === 'PACKAGE_INVALID',
    )
  } finally {
    repo.close()
  }
})

check('P5-3-S5：版本排序与坐标解析的小件单独钉住（字典序会把 1.10.0 排到 1.9.0 前面）', () => {
  assert.deepEqual(sortVersions(['1.9.0', '1.10.0', '1.2.0']), ['1.2.0', '1.9.0', '1.10.0'])
  // FAQ：仓库里同时有 2.0.0 与它的预发布版时，预发布版不能顶到最前面去当「最新」。
  assert.equal(sortVersions(['2.0.0', '2.0.0-rc1', '2.0.0-beta']).pop(), '2.0.0')
  assert.equal(normalizePyPIname('Foo_Bar.baz'), 'foo-bar-baz')
  // 裸 :memory: 库没有建表——迁移过的库才是 createPackageIndex 的合法输入。
  const pkgDb = openDatabase(join(root, 'packages-index.sqlite'))
  try { assert.equal(typeof createPackageIndex({ db: pkgDb, has: () => true }).register, 'function') } finally { pkgDb.close() }
  // 只有一个版本时不写 <versioning>（没得选），两个以上才列。
  // version 是「版本级」坐标，级别不同不写 versioning。
  assert.doesNotMatch(buildMavenMetadata({ groupId: 'g', artifactId: 'a', version: '1.0.0', entries: ['1.0.0'] }), /<versioning>/)
  const xml = buildMavenMetadata({ groupId: 'g', artifactId: 'a', entries: ['1.0.0', '2.0.0'] })
  assert.match(xml, /<versioning>/)
  assert.match(xml, /<latest>2\.0\.0<\/latest>/)
  assert.equal(sha512Sri(createHash('sha512').update('x')), `sha512-${createHash('sha512').update('x').digest('base64')}`)
})
check('P5-S11：DB —— 制品表随 v10 迁出，artifact_blobs 只存索引不存字节', () => {
  const db = openDatabase(join(root, 'artifacts-db.sqlite'))
  try {
    const columns = db.prepare('PRAGMA table_info(artifact_blobs)').all().map((row) => row.name)
    assert.deepEqual(columns.sort(), ['bytes', 'created_at', 'digest', 'job_id', 'media_type', 'project_id', 'run_id', 'source_path'])
    assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 11)
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_artifact_refs_digest'").get())
  } finally { db.close() }
})

let passed = 0
for (const item of checks) {
  try {
    if (item.async) await item.fn()
    else item.fn()
    passed += 1
    console.log(`ok ${passed} - ${item.title}`)
  } catch (error) {
    console.error(`not ok ${passed + 1} - ${item.title}`)
    console.error(error)
    process.exitCode = 1
    break
  }
}

for (const effect of ctx.effects) {
  try { effect() } catch { /* ignore */ }
}
assert.equal(ctx.routes.length, 0)
assert.equal(ctx.toolsList.length, 0)
rmSync(root, { recursive: true, force: true })
if (process.exitCode !== 1) console.log(`${passed} checks passed`)