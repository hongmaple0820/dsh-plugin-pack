import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  internals,
  name as packageName,
  inject,
  apply,
} from '../index.js'
import { parsePipe, planPipeline, interpolate, matchArtifacts, PipeError, defaultRestartCommand, isHostSelector, parseHostSelector, splitTargetHosts } from '../lib/pipe.js'
import { createStore } from '../lib/store.js'
import { openDatabase } from '../lib/db.js'
import { DatabaseSync } from 'node:sqlite'
import { runPipeline, makeRunId } from '../lib/runner.js'
import { createRemote, remoteUnavailable } from '../lib/remote.js'
import { deployRelease, rollbackRelease, shellQuote } from '../lib/deploy.js'
import { dispatchNotifications } from '../lib/notify.js'

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

check('manifest 是 @local/dsh-cicd 0.6.1 且导出 Host 形状', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.name, '@local/dsh-cicd')
  assert.equal(manifest.version, '0.6.1')
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
  const effects = []
  const webServer = {
    port: 4567,
    register(route) { routes.push(route); return () => { const index = routes.indexOf(route); if (index >= 0) routes.splice(index, 1) } },
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
    effects,
  }
}

const ctx = fakeContext()
apply(ctx, {
  projects: [{ id: 'demo', name: 'Demo', path: projectDir, pipe: join(projectDir, 'pipe.yml') }],
  workDir: join(root, 'state'),
  remoteBase: 'http://127.0.0.1:1',
})

function call(routePath, query = '', { headers = {}, origin = '' } = {}) {
  const requestHeaders = { ...headers }
  if (origin) requestHeaders.origin = origin
  const route = ctx.routes.find((item) => item.path === internals.ROUTE_PREFIX + routePath)
  assert.ok(route, `route ${routePath} registered`)
  return route.resource(new Request(`http://x${internals.ROUTE_PREFIX}${routePath}${query}`, { headers: requestHeaders }))
}

check('apply：注册 8 个工具、10 条 exact 路由与 runtime disposer', () => {
  assert.equal(ctx.toolsList.length, 8)
  assert.deepEqual(ctx.toolsList.map((tool) => tool.name).sort(), [
    'cicd_logs', 'cicd_plan', 'cicd_projects', 'cicd_releases', 'cicd_rollback', 'cicd_run', 'cicd_status', 'cicd_targets',
  ])
  for (const tool of ctx.toolsList) {
    assert.equal(typeof tool.description, 'string')
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
  }
  assert.equal(ctx.routes.length, 10)
  assert.deepEqual(ctx.routes.map((route) => route.path).sort(), [
    '/api/plugins/cicd/log', '/api/plugins/cicd/notify-test', '/api/plugins/cicd/operations',
    '/api/plugins/cicd/plan', '/api/plugins/cicd/projects', '/api/plugins/cicd/releases',
    '/api/plugins/cicd/rollback', '/api/plugins/cicd/run', '/api/plugins/cicd/runs', '/api/plugins/cicd/targets',
  ])
  assert.ok(ctx.routes.every((route) => route.kind === 'exact' && typeof route.resource === 'function' && !route.handler))
})

check('冷启动回归：webServer 未就绪时 0 路由，inject 就绪后补注册 10 条；remote() 惰性取 port', () => {
  const coldRoutes = []
  const coldWeb = { port: 55470, register(route) { coldRoutes.push(route); return () => {} } }
  let webReady = false
  let scopeFn = null
  const coldEffects = []
  const coldCtx = {
    tools: { register() { return () => {} } },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') coldEffects.push(dispose) },
    get(key) { return webReady && key === 'webServer' ? coldWeb : undefined },
    inject(deps, fn) { assert.deepEqual(deps, ['webServer']); scopeFn = fn },
  }
  apply(coldCtx, { projects: [{ id: 'demo', path: projectDir }], workDir: join(root, 'state') })
  assert.equal(coldRoutes.length, 0, '冷启动阶段一条路由都不该注册')
  assert.ok(typeof scopeFn === 'function', 'apply 应把路由注册挂到 ctx.inject 上')
  // 模拟 webServer 就绪：cordis 以一个能 get 到服务的 scope 触发回调（真实环境由服务就绪事件驱动）。
  scopeFn({ get: (key) => (key === 'webServer' ? coldWeb : undefined), effect() {} })
  assert.equal(coldRoutes.length, 10, '就绪后应补注册 10 条 exact 路由')

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
  assert.equal(ctx.routes.length, 10)
  for (const route of ctx.routes) assert.equal(route.handler, undefined)
  assert.equal(internals.WRITE_HEADER, 'x-dsh-remote-exec')
  assert.equal(typeof internals.resources.projectsResource, 'function')
  assert.equal(typeof internals.resources.operationsResource, 'function')
  assert.equal(typeof internals.resources.notifyTestResource, 'function')
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

check('v0.5/0.6 DB：v1 库迁移到 user_version=3，补出 env 与 operations 审计列', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cicd-migrate-'))
  const file = join(dir, 'cicd.db')
  const legacy = new DatabaseSync(file)
  legacy.exec("CREATE TABLE releases (id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT '', target TEXT NOT NULL DEFAULT '', host TEXT NOT NULL DEFAULT '', run_id TEXT NOT NULL DEFAULT '', commit_sha TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '', activated_at TEXT NOT NULL DEFAULT '', deactivated_at TEXT NOT NULL DEFAULT '', manifest_path TEXT NOT NULL DEFAULT '', revisions_offset INTEGER NOT NULL DEFAULT 0, previous TEXT NOT NULL DEFAULT '', artifact_sha256 TEXT NOT NULL DEFAULT '')")
  legacy.exec("CREATE TABLE operations (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', at TEXT NOT NULL DEFAULT '')")
  legacy.exec("INSERT INTO operations (run_id, kind, detail, at) VALUES ('r1', 'deploy', '{}', '2026-01-01T00:00:00.000Z')")
  legacy.exec('PRAGMA user_version = 1')
  legacy.close()

  const db = openDatabase(file)
  assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 3)
  assert.ok(db.prepare('PRAGMA table_info(releases)').all().some((row) => row.name === 'env'))
  for (const column of ['action', 'project', 'target', 'host', 'release_id', 'status']) {
    assert.ok(db.prepare('PRAGMA table_info(operations)').all().some((row) => row.name === column), `operations.${column}`)
  }
  assert.equal(db.prepare("SELECT action FROM operations WHERE run_id = 'r1'").get().action, 'deploy')
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_operations_at'").get())
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
  const runIdIndex = runnerSource.indexOf('const runId = makeRunId(now, random)')
  const planIndex = runnerSource.indexOf('const plan = planPipeline(pipe')
  assert.ok(runIdIndex > 0 && planIndex > runIdIndex, 'runner.js 必须在 planPipeline 之前生成 runId')
  assert.ok(runnerSource.includes('releaseId: releaseId || runId'))
  // 首次部署健康检查失败时要把 current 撤掉，不能把坏版本留在线上
  assert.ok(deploySource.includes('rm -f'), '首次部署失败应该撤掉 current 指向')
})

check('工具 render 函数对典型值不抛错', () => {
  const projects = ctx.toolsList.find((tool) => tool.name === 'cicd_projects')
  const status = ctx.toolsList.find((tool) => tool.name === 'cicd_status')
  const logs = ctx.toolsList.find((tool) => tool.name === 'cicd_logs')
  assert.equal(projects.output.render({}, { workDir: '/w', projects: [{ id: 'p', name: 'P', path: '/p', pipe: '/p/pipe.yml', hasPipe: true }] })[0].type, 'text')
  assert.match(status.output.render({}, { runs: [] })[0].text, /还没有运行记录/)
  assert.match(logs.output.render({}, { runId: 'r', status: 'success', totalLines: 0, truncated: false, text: '' })[0].text, /运行 r/)
})

// cleanup
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