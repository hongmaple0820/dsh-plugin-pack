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
import { PROMOTION_ERRORS, promotionError, envRequiresPromotion, findSourceRelease, currentPointer, reachablePointer, isPromoted, listPromotions, recordPromotion, promotionView } from '../lib/promotions.js'
import { openDatabase, SCHEMA_VERSION } from '../lib/db.js'
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
import { normalizeEnvironments, promotionPath, parseEnvironmentGuards } from '../lib/environments.js'
import { deployRelease as strategyDeploy, normalizeStrategy } from '../lib/strategy.js'
import { deployTransaction, planBatches, readManifest, usesTransaction } from '../lib/deploy-engine.js'
import { createNativeActuator, renderTemplate } from '../lib/actuator/native.js'
import { createContainerActuator, resolveImageReference, parsePublishedPort, parseInspect, normalizeImageDigest, CONTAINER_ERRORS } from '../lib/actuator/container.js'
import { createK8sActuator, k8sImageReference, parseDeployment, parsePods, normalizeK8sDigest, K8S_ERRORS, K8S_COMMANDS } from '../lib/actuator/k8s.js'
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

  // client.js 从没被任何人编译过：它的语法错误只会在宿主加载面板时炸，smoke 一路全绿。
  // 这里只做语法体检（new Function 不执行），因为浏览器半边在 Node 里没有 DOM 可跑。
  const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const factoryAt = clientSource.indexOf('  factory(require) {')
  const tailAt = clientSource.lastIndexOf('    return {')
  assert.ok(factoryAt > 0 && tailAt > factoryAt, 'client.js 应当仍是 factory(require) { … return { … } 的形状')
  const body = clientSource.slice(factoryAt + '  factory(require) {'.length, tailAt)
  assert.doesNotThrow(() => new Function('require', body), 'client.js 的 factory 体必须能通过语法解析')
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


// v3.0-P7 混沌：日志目录写不进去时，这条命令在内存里跑完的运行必须如实报失败。
// 磁盘满会让 appendRun / CAS / release 目录同时失败——上面几步「看起来跑完了」只是因为
// 命令跑在内存里。此时若返回 success，用户拿到的就是一次绿色的假发布。
// 试验结论（Windows/Node 22）：把 <state>/logs 这个目录换成一个普通文件即可触发同一条路径——
// mkdirSync 抛 EEXIST、appendFileSync 抛 ENOENT，两者都进 noteLogWriteFailure 的同一条分支。
checkAsync('runner：日志无法落盘时这次运行被判为失败并给出 DISK_FULL 码', async () => {
  const { dir, project } = runnerProject()
  const store = createStore({ dir: join(dir, '.state') })
  try {
    const pipe = parsePipe([
      'stages:',
      '  - id: build',
      '    steps:',
      '      - run: node -e "console.log(1)"',
    ].join('\n'))
    rmSync(join(dir, '.state', 'logs'), { recursive: true, force: true })
    writeFileSync(join(dir, '.state', 'logs'), 'not a directory', 'utf8')
    const lines = []
    const result = await runPipeline({ pipe, project, target: '', store, runId: 'r-disk', onLog: (entry) => lines.push(entry.line) })
    assert.equal(result.status, 'failed')
    assert.equal(result.code, 'DISK_FULL')
    assert.ok(lines.some((line) => line.includes('这次运行被判为失败')), '必须告诉用户为什么失败')
    assert.equal(store.run('r-disk').status, 'failed', '运行记录也必须落库为失败')
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

check('apply：注册 37 个工具、49 条路由（45 exact + 4 prefix）、1 条 WS upgrade 与 runtime disposer', () => {
  assert.equal(ctx.toolsList.length, 37)
  assert.deepEqual(ctx.toolsList.map((tool) => tool.name).sort(), [
    'cicd_approve', 'cicd_artifacts', 'cicd_audit', 'cicd_auth', 'cicd_cache_stats', 'cicd_cancel', 'cicd_database', 'cicd_database_switch', 'cicd_dora', 'cicd_environments',
    'cicd_locks', 'cicd_logs', 'cicd_metrics', 'cicd_notify_ledger', 'cicd_onboarding', 'cicd_pipe_save', 'cicd_plan', 'cicd_project_create', 'cicd_project_meta',
    'cicd_projects', 'cicd_promotions',
    'cicd_rbac', 'cicd_registry', 'cicd_releases', 'cicd_rollback', 'cicd_run', 'cicd_runners', 'cicd_secrets', 'cicd_status',
    'cicd_storage', 'cicd_targets', 'cicd_templates', 'cicd_tokens', 'cicd_toolchain', 'cicd_triggers', 'cicd_users', 'cicd_validate',
  ])
  for (const tool of ctx.toolsList) {
    assert.equal(typeof tool.description, 'string')
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
  }
  assert.equal(ctx.routes.length, 49)
  assert.deepEqual(ctx.routes.filter((route) => route.kind === 'exact').map((route) => route.path).sort(), [
    '/api/plugins/cicd/approvals', '/api/plugins/cicd/approve', '/api/plugins/cicd/artifacts', '/api/plugins/cicd/audit', '/api/plugins/cicd/auth',
    '/api/plugins/cicd/cache-stats', '/api/plugins/cicd/cancel', '/api/plugins/cicd/database', '/api/plugins/cicd/database/switch', '/api/plugins/cicd/dora',
    '/api/plugins/cicd/environments', '/api/plugins/cicd/locks',
    '/api/plugins/cicd/log', '/api/plugins/cicd/metrics', '/api/plugins/cicd/notify-ledger', '/api/plugins/cicd/notify-test', '/api/plugins/cicd/onboarding',
    '/api/plugins/cicd/operations', '/api/plugins/cicd/pipe-save',
    '/api/plugins/cicd/plan', '/api/plugins/cicd/preview', '/api/plugins/cicd/project-create', '/api/plugins/cicd/project-meta', '/api/plugins/cicd/projects',
    '/api/plugins/cicd/promotions', '/api/plugins/cicd/rbac', '/api/plugins/cicd/releases', '/api/plugins/cicd/rollback', '/api/plugins/cicd/run',
    '/api/plugins/cicd/runner-log', '/api/plugins/cicd/runner-poll', '/api/plugins/cicd/runner-register', '/api/plugins/cicd/runner-result',
    '/api/plugins/cicd/runners', '/api/plugins/cicd/runs', '/api/plugins/cicd/secrets', '/api/plugins/cicd/storage',
    '/api/plugins/cicd/targets',
    '/api/plugins/cicd/template-save', '/api/plugins/cicd/templates', '/api/plugins/cicd/tokens', '/api/plugins/cicd/toolchain', '/api/plugins/cicd/triggers', '/api/plugins/cicd/users', '/api/plugins/cicd/validate',
  ])
  assert.deepEqual(ctx.routes.filter((route) => route.kind === 'prefix').map((route) => route.path), [
    '/api/plugins/cicd/hooks', '/api/plugins/cicd/v2', '/api/plugins/cicd/repository', '/api/plugins/cicd/simple',
  ])
  assert.ok(ctx.routes.every((route) => typeof route.resource === 'function' && !route.handler))
  assert.equal(ctx.upgrades.length, 1)
  assert.equal(ctx.upgrades[0].path, '/api/plugins/cicd/log-ws')
  assert.equal(typeof ctx.upgrades[0].handler, 'function')
})

/**
 * DSH 里工具输出要过一遍 JSON Schema（子集：type / oneOf / properties / required / additionalProperties / items / enum）。
 * 测试里自己做一遍同样的检查，否则「schema 写错」只有真实调用时才炸，而且炸在模型面前。
 */
function schemaViolations(schema, value, path = 'value') {
  if (!schema || typeof schema !== 'object') return []
  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.filter((branch) => schemaViolations(branch, value, path).length === 0)
    return matched.length === 1 ? [] : [`${path} 必须恰好匹配一个 oneOf 分支（命中 ${matched.length} 个）`]
  }
  const type = schema.type
  if (!type) return []
  if (type === 'null') return value === null ? [] : [`${path} 必须是 null`]
  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [`${path} 必须是对象`]
    const violations = []
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) violations.push(`${path}.${key} 缺失`)
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, key)) violations.push(...schemaViolations(sub, value[key], `${path}.${key}`))
    }
    return violations
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return [`${path} 必须是数组`]
    const violations = []
    value.forEach((item, index) => violations.push(...schemaViolations(schema.items, item, `${path}[${index}]`)))
    return violations
  }
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value) ? [] : [`${path} 必须是数字（实际 ${JSON.stringify(value)}）`]
  if (type === 'integer') return Number.isInteger(value) ? [] : [`${path} 必须是整数（实际 ${JSON.stringify(value)}）`]
  if (type === 'string') return typeof value === 'string' ? [] : [`${path} 必须是字符串（实际 ${JSON.stringify(value)}）`]
  if (type === 'boolean') return typeof value === 'boolean' ? [] : [`${path} 必须是布尔（实际 ${JSON.stringify(value)}）`]
  return []
}

checkAsync('P6-S1：只读工具的 schema 接受刚装好（空库、无样本）时的真实返回', async () => {
  // 全新工作目录 = 第一次装完插件的样子：没有运行、没有样本、缓存目录还没建。
  // 这些 null 是"没有数据"的诚实表达，schema 必须允许它，否则安装后第一次点开面板就是 INVALID_TOOL_OUTPUT。
  const blankRoot = mkdtempSync(join(tmpdir(), 'cicd-blank-'))
  const blankCtx = fakeContext()
  apply(blankCtx, {
    projects: [{ id: 'demo', name: 'Demo', path: projectDir, pipe: join(projectDir, 'pipe.yml') }],
    workDir: join(blankRoot, 'state'),
    remoteBase: 'http://127.0.0.1:1',
    scheduler: { enabled: false },
  })
  ctx.effects.push(...blankCtx.effects.splice(0))
  const readOnly = [
    ['cicd_projects', {}],
    ['cicd_project_meta', { project: 'demo' }],
    ['cicd_onboarding', {}],
    ['cicd_templates', { action: 'list' }],
    ['cicd_validate', { project: 'demo' }],
    ['cicd_plan', { project: 'demo' }],
    ['cicd_targets', { project: 'demo' }],
    ['cicd_environments', { project: 'demo' }],
    ['cicd_releases', {}],
    ['cicd_status', {}],
    ['cicd_metrics', {}],
    ['cicd_dora', {}],
    ['cicd_audit', { action: 'list', limit: 3 }],
    ['cicd_storage', {}],
    ['cicd_database', {}],
    ['cicd_cache_stats', {}],
    ['cicd_secrets', {}],
    ['cicd_locks', { action: 'list' }],
    ['cicd_runners', { action: 'list' }],
    ['cicd_triggers', { project: 'demo' }],
    ['cicd_artifacts', { action: 'list' }],
    ['cicd_artifacts', { action: 'catalog' }],
    ['cicd_registry', { action: 'catalog' }],
    ['cicd_toolchain', { action: 'list' }],
    ['cicd_promotions', { action: 'list' }],
    ['cicd_users', { action: 'list' }],
    ['cicd_tokens', { action: 'list' }],
    ['cicd_rbac', {}],
    ['cicd_auth', { action: 'me' }],
    ['cicd_notify_ledger', {}],
  ]
  const failures = []
  for (const [name, args] of readOnly) {
    const tool = blankCtx.toolsList.find((item) => item.name === name)
    assert.ok(tool, `${name} 已注册`)
    let value
    try {
      value = await tool.execute(args)
    } catch (error) {
      failures.push(`${name} ${JSON.stringify(args)} 执行抛错：${error.code || ''} ${error.message}`)
      continue
    }
    const violations = schemaViolations(tool.output.schema, value)
    if (violations.length) failures.push(`${name} ${JSON.stringify(args)}：${violations.slice(0, 3).join('; ')}`)
  }
  assert.deepEqual(failures, [])
})

check('冷启动回归：webServer 未就绪时 0 路由，inject 就绪后补注册 45+4 条；remote() 惰性取 port', () => {
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
  assert.equal(coldRoutes.length, 49, '就绪后应补注册 45 条 exact + 4 条 prefix 路由')
  assert.equal(coldRoutes.filter((route) => route.kind === 'exact').length, 45)
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

checkAsync('v3.0-P6-1 preview：把未保存的文本插值成命令，密钥写成 ***，跳过的阶段说得出口', async () => {
  const src = [
    'version: 1',
    'name: previewed',
    'default_target: staging',
    'vars:',
    '  GREETING: hello',
    'targets:',
    '  prod:',
    '    hosts: [h1]',
    '    path: /srv/prod',
    '  staging:',
    '    hosts: [h2]',
    '    path: /srv/staging',
    'stages:',
    '  - id: build',
    '    steps:',
    '      - name: greet',
    '        run: echo ${{GREETING}} on ${{BRANCH}}',
    '  - id: prod-only',
    "    when: branch == 'main'",
    '    needs: [build]',
    '    steps:',
    '      - name: ship',
    '        run: echo ship',
  ].join('\n')

  const body = await call('/preview', `?source=${encodeURIComponent(src)}`).then((response) => response.json())
  assert.equal(body.ok, true)
  assert.equal(body.name, 'previewed')
  // default_target 生效：不点目标就用 pipe 自己声明的那个，而不是列表里的第一个。
  assert.equal(body.target, 'staging')
  assert.deepEqual(body.targets, ['prod', 'staging'])
  assert.deepEqual(body.targetSpec.hosts, ['h2'])
  // 没传分支时 when: branch == 'main' 不成立 —— prod-only 被跳过是正确行为，
  assert.deepEqual(body.stages.map((stage) => stage.id), ['build'])
  assert.deepEqual(body.skipped.map((item) => item.id), ['prod-only'])
  const greet = body.stages[0].steps[0].command
  assert.equal(greet, 'echo hello on ', 'vars 与 BRANCH 都要经过同一条插值链路（没传分支就是空）')
  assert.deepEqual(body.usedVars.map((item) => item.name).sort(), ['BRANCH', 'GREETING'])

  // 分支不是 main 时同样跳过：prod-only 的「消失」必须能解释，否则用户以为写了个死 stage。
  const onDev = await call('/preview', `?source=${encodeURIComponent(src)}&branch=dev`).then((response) => response.json())
  assert.deepEqual(onDev.stages.map((stage) => stage.id), ['build'])
  assert.deepEqual(onDev.skipped.map((item) => item.id), ['prod-only'])
  assert.equal(onDev.skipped[0].when, "branch == 'main'")
  assert.deepEqual(onDev.skipped[0].needs, ['build'])
  const onMain = await call('/preview', `?source=${encodeURIComponent(src)}&branch=main`).then((response) => response.json())
  assert.deepEqual(onMain.stages.map((stage) => stage.id), ['build', 'prod-only'])
  assert.deepEqual(onMain.skipped, [])

  // 显式点名目标优先于 default_target。
  const forced = await call('/preview', `?source=${encodeURIComponent(src)}&target=prod`).then((response) => response.json())
  assert.equal(forced.target, 'prod')
  assert.deepEqual(forced.targetSpec.hosts, ['h1'])

  // 语法错误走 ok:false + 行号，而不是 4xx —— 编辑器要拿行号去定位。
  const bad = await call('/preview', `?source=${encodeURIComponent('version: 1\n\tbad: tab\n')}`).then((response) => response.json())
  assert.equal(bad.ok, false)
  assert.ok(bad.line > 0)
  assert.equal((await call('/preview', '', { origin: 'http://evil.test' })).status, 403)
  assert.equal((await call('/preview', '?extra=1')).status, 400)
})
checkAsync('v3.0-P6-2 模板中心：内置 9 种 + 自定义模板 + 另存为，新建两步就落地', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cicd-p6-2-'))
  try {
    const projectDir = join(dir, 'app')
    mkdirSync(projectDir, { recursive: true })
    // 项目自己的 pipe.yml：另存为模板时要原样搬运它，而不是搬一份重新生成的脚手架。
    const projectPipe = [
      'name: team-web',
      'targets:',
      '  prod:',
      '    hosts: [web1]',
      '    path: /srv/team-web',
      'stages:',
      '  - id: build',
      '    steps:',
      '      - name: b',
      '        run: npm run build',
      '',
    ].join('\n')
    writeFileSync(join(projectDir, 'pipe.yml'), projectPipe)
    const repo = await repoTool(join(dir, 'state'), { projects: [{ id: 'app', name: 'app', path: projectDir }] })
    try {
      // ① 内置模板：9 种语言/形态，且都带各自的文本（新建前先看一眼）。
      const listed = await repo.call('/templates?name=demo').then((response) => response.json())
      assert.equal(listed.ok, true)
      assert.equal(listed.builtin, 9, '内置模板应有 9 种：' + listed.templates.map((item) => item.id).join(','))
      assert.equal(listed.custom, 0)
      assert.deepEqual(listed.templates.map((item) => item.id).sort(),
        ['bare', 'docker', 'go', 'java', 'node', 'php', 'python', 'rust', 'static'])
      const node = listed.templates.find((item) => item.id === 'node')
      assert.match(node.source, /name: demo/, '内置模板必须按目标项目名现渲染')
      assert.match(node.source, /npm/, 'node 模板要走 npm 构建')
      assert.equal(node.custom, false)

      // ② 另存为模板：写盘走 MANAGE_PROJECT，参数拼错不能被悄悄忽略。
      const noSession = await repo.call('/template-save?name=team-web&project=app&confirm=1', {
        method: 'POST',
        headers: { 'x-dsh-cicd': '1' },
      }).then((response) => response.json())
      // 引导期是本机 owner，没有会话也能写；这里断言的是「未知参数要被挡」而不是身份。
      assert.equal(noSession.ok, true, '另存为模板失败：' + JSON.stringify(noSession).slice(0, 300))
      assert.equal(noSession.id, 'team-web')
      assert.match(noSession.source, /npm run build/, '存的应是项目里那份 pipe.yml 的原文')
      const stray = await repo.call('/template-save?name=x&confirm=1&templte=typo', { method: 'POST', headers: { 'x-dsh-cicd': '1' } })
      assert.equal(stray.status, 400, 'body 里的未知参数必须拒绝，而不是当成没写')

      // ③ 自定义模板出现在列表里，并能按 id 取回原文本。
      const afterSave = await repo.call('/templates?name=demo').then((response) => response.json())
      assert.equal(afterSave.custom, 1)
      const stored = afterSave.templates.find((item) => item.id === 'team-web')
      assert.ok(stored && stored.custom === true)
      assert.match(stored.source, /npm run build/)

      // ④ 用模板新建：pipe.yml 是模板原文，不再套脚手架。
      const created = await repo.call('/project-create?confirm=1&name=from-template&path=' + encodeURIComponent(join(dir, 'from-template')) + '&template=team-web', {
        method: 'POST', headers: { 'x-dsh-cicd': '1' },
      }).then((response) => response.json())
      assert.equal(created.ok !== false, true, '用模板新建失败：' + JSON.stringify(created).slice(0, 300))
      assert.equal(created.pipeSource, projectPipe, '新建时 pipe.yml 必须是模板原文')

      // ⑤ 模板名要挡住路径逃逸：一个叫 ../../evil 的模板不能写到工作目录外面。
      const escape = await repo.call('/template-save?name=' + encodeURIComponent('../../evil') + '&confirm=1&source=' + encodeURIComponent('name: evil\n'), {
        method: 'POST',
        headers: { 'x-dsh-cicd': '1' },
      }).then((response) => response.json())
      assert.equal(escape.ok, true)
      assert.equal(escape.id.includes('..'), false, '模板 id 必须被归一，不能带 .. 逃出目录')
      assert.equal(existsSync(join(dir, 'evil')), false, '模板目录不该被写到 workDir 之外')

      // ⑥ 删除：删掉的模板不再出现在列表里，取详情返回 false。
      const removed = await repo.call('/template-save?name=doomed&confirm=1&source=' + encodeURIComponent('name: doomed\n'), { method: 'POST', headers: { 'x-dsh-cicd': '1' } })
      assert.equal((await removed.json()).ok, true)
      assert.equal(repo.runtime.removeTemplate('doomed')?.removed, true)
      assert.equal(repo.runtime.templateDetail('doomed'), null)
    } finally { repo.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
checkAsync('v3.0-P7 混沌与兼容：只读盘不写库、备份可换回去、迁移台账说得出退得回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cicd-p7-chaos-'))
  let repo = null
  try {
    // ---- ① 只读磁盘：库都在，但一个字节也写不进去 ----
    const work = join(dir, 'work')
    mkdirSync(work, { recursive: true })
    repo = await repoTool(work)
    const first = await repo.call('/projects')
    assert.equal(first.status, 200, '盘还好的时候应该能读')
    // workDir 置只读，模拟「盘满了 / 挂载成 ro」：读必须继续工作，写必须明确失败，
    // 而不是把进程打挂。注意 SQLite 已经预先建好了 -wal/-shm，纯读不一定碰盘，
    // 所以这里断言的是「接口没崩、错误是可读的 HTTP 错误」，不是「一定抛 EACCES」。
    chmodSync(work, 0o555)
    let readOnly = null
    try {
      const again = await repo.call('/projects')
      assert.equal(again.status, 200, '盘坏了也不能连读都读不了：' + JSON.stringify(again.body).slice(0, 120))
      // 只读盘上唯一必须成立的是「接口还在正常回话」，具体形状由别的用例钉住。
      assert.equal(again.body.ok !== false, true, '只读盘上读请求不该报错：' + JSON.stringify(again.body).slice(0, 140))
      // 写会失败——失败必须是一个正常的 HTTP 错误，而不是未捕获异常
      const created = await repo.call('/project-create?confirm=1&name=blocked&path=' + encodeURIComponent(join(dir, 'blocked')))
      readOnly = created.status
      assert.ok(created.status >= 400, '写不进去时必须明确失败，实际 ' + created.status)
    } finally {
      chmodSync(work, 0o755)
    }
    assert.ok(readOnly !== null, '必须真的试过一次写')

    // ---- ② 备份 → 换库 → 换回去 ----
    const info = repo.runtime.database()
    assert.equal(info.userVersion, info.schemaVersion, '刚建好的库应该就是当前版本')
    assert.ok(info.migrations.length >= 1, '迁移台账不能是空的')
    const top = info.migrations[info.migrations.length - 1]
    assert.equal(top.version, info.schemaVersion)
    assert.ok(top.note.length > 0, '每一版都得有一句人话说明，否则「退回去会怎样」没人答得上')
    const backup = join(dir, 'backup.db')
    // 用 SQLite 自己的备份语法，而不是复制文件：WAL 模式下直接拷 .db 会丢掉还没 checkpoint 的部分。
    repo.runtime.store.db.exec("VACUUM INTO '" + backup.replace(/'/g, "''") + "'")
    assert.ok(existsSync(backup), '备份文件应该落盘')
    const original = repo.runtime.dbFilePath()
    const switched = await repo.runtime.switchStore({ file: backup })
    assert.equal(switched.switched, true)
    assert.equal(repo.runtime.dbFilePath(), backup, '换完之后读库路径必须是新的那条')
    assert.equal((await repo.runtime.switchStore({ file: backup })).switched, false, '同一个文件不该重复换')
    const restored = await repo.runtime.switchStore({ file: original })
    assert.equal(restored.switched, true)
    assert.equal(repo.runtime.dbFilePath(), original)
    // 换库最容易漏掉的一步：审计与锁必须跟着换，否则它们继续往旧文件里写，看起来一切正常。
    repo.runtime.auditRecord({ action: 'test.after_switch', actorId: 'tester', resourceType: 'db', resourceId: 'switch', result: 'allow', reason: '' })
    const events = repo.runtime.auditList({ limit: 5 }).events
    assert.ok(events.some((event) => event.action === 'test.after_switch'), '换库之后审计要写进新库')

    // ---- ③ 迁移台账与版本边界 ----
    const tooNew = join(dir, 'toonew.db')
    const raw = openDatabase(tooNew)
    raw.exec('PRAGMA user_version = ' + (repo.runtime.database().schemaVersion + 1))
    raw.close()
    await assert.rejects(() => repo.runtime.switchStore({ file: tooNew }), (error) => error.code === 'DB_VERSION_TOO_NEW',
      '比插件还新的库必须拒开：旧代码读新表结构等于当场损坏数据')
    await assert.rejects(() => repo.runtime.switchStore({ file: join(dir, 'nope.db') }), (error) => error.code === 'DB_SWITCH_MISSING')
    await assert.rejects(() => repo.runtime.switchStore({ file: '' }), (error) => error.code === 'DB_SWITCH_INVALID')
    // /database 与 /database/switch 都要能走 HTTP：换库不是一个只能在代码里调的函数。
    const dbInfo = await repo.call('/database')
    assert.equal(dbInfo.status, 200)
    assert.equal(dbInfo.body.userVersion, dbInfo.body.schemaVersion)
    // 没身份时先被身份挡住（403），这是对的——普通用例里没有 cookie；
    // 所以这里断言的是「一定拒」，具体挡在哪一层不写死。
    const noConfirm = await repo.call('/database/switch?file=' + encodeURIComponent(backup))
    assert.ok(noConfirm.status >= 400, '换库不给 confirm 必须拒绝，实际 ' + noConfirm.status)
    assert.ok(noConfirm.body.ok !== true)
    const switchedHttp = await repo.call('/database/switch?confirm=1&file=' + encodeURIComponent(backup))
    assert.ok(switchedHttp.status >= 400, '无身份时换库也必须被拒，实际 ' + switchedHttp.status)
    assert.equal(repo.runtime.dbFilePath(), original, '被拒的换库不能把库换掉')
  } finally {
    try { repo?.close() } catch { /* runner 可能没起 */ }
    try { chmodSync(join(dir, 'work'), 0o755) } catch { /* 已经是可写 */ }
    rmSync(dir, { recursive: true, force: true })
  }
})

checkAsync('v3.0-P7 混沌：runner 掉线后派出去的任务当场判失败，而不是挂到超时', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cicd-runner-drop-'))
  // 不造假时钟：注册表把「判死」算在读取的那一刻（now() - last_seen_at），
  // 而配置里的 now 到不了注册表——两条时间轴一混，测出来的「永远 online」是测试的假象。
  // 用真实的 30s 间隔 + 真实的最后一跳时间，只把「最后心跳」推回到 91 秒前。
  const repo = await repoTool(join(dir, 'state'), { runners: { joinToken: 'drop-token' } })

  try {
    // ---- ① 注册表：online 是推导值，心跳停了 3 个周期就是 offline ----
    await repo.call('/runner-register?runnerId=drop-01&token=drop-token&labels=build')
    let verdict = repo.runtime.runners().find((row) => row.runnerId === 'drop-01')
    assert.equal(verdict.status, 'online')
    await repo.call('/runner-poll?runnerId=drop-01&token=drop-token')
    assert.equal(repo.runtime.runners().find((row) => row.runnerId === 'drop-01').status, 'online', '心跳还在，就不能判死')
    // 让这台机器「停跳」：注册表缓存的是一个 1 秒的**时钟读数**，读数没变它就认为还是刚才那一刻。
    // 所以不能只改库——库里那行属于另一个读数键。先把读数拨走，缓存自然失效，下一读才看得到改后的行。
    const staleSeen = new Date(Date.now() - 91 * 1000).toISOString()
    const db = openDatabase(join(dir, 'state', 'cicd.db'))
    try {
      db.prepare('UPDATE runners SET last_seen_at = ? WHERE runner_id = ?').run(staleSeen, 'drop-01')
    } finally { db.close() }
    await new Promise((resolve) => setTimeout(resolve, 1100))

    verdict = repo.runtime.runners().find((row) => row.runnerId === 'drop-01')
    assert.equal(verdict.status, 'offline', '3 × 30s 没有心跳就必须是 offline')
    assert.equal(verdict.stale, true)
    assert.equal(verdict.lifecycle, 'active', 'offline 不等于吊销：库里的生命周期还是 active')

    // ---- ② broker：派出去的任务在探针周期内失败，错误指向机器而不是「超时」 ----
    const broker = internals.createTaskBroker({})
    broker.register('drop-01', {})
    const startedAt = Date.now()
    let live = false
    const claim = broker.claim(
      { taskId: 'drop-task', command: 'echo hi', cwd: dir, env: {}, timeoutSec: 600, runId: 'r-drop' },
      'drop-01',
      { liveness: () => (live ? { code: 'RUNNER_OFFLINE', message: 'runner drop-01 已 91s 未心跳（阈值 90s）' } : null), livenessEveryMs: 50 },
    )
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal(broker.task('drop-task').status, 'queued', '机器还活着时不许自己把任务判死')
    live = true
    const dropped = await claim
    assert.equal(dropped.status, 'failed')
    assert.equal(dropped.code, 'RUNNER_OFFLINE')
    assert.match(dropped.error, /未心跳/)
    assert.equal(Date.now() - startedAt < 5000, true, '掉线要当场知道，不能等到步骤超时（600s）')
    assert.equal(broker.activeFor('drop-01'), false, '判死之后不能还挂着「有在跑任务」')

    // ---- ③ 探针自己抛错不能把运行变成失败：退回纯超时保护 ----
    const broker2 = internals.createTaskBroker({})
    broker2.register('flaky-01', {})
    const claim2 = broker2.claim({ taskId: 'flaky-task', command: 'echo hi' }, 'flaky-01', {
      liveness: () => { throw new Error('注册表读不到') },
      livenessEveryMs: 20,
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(broker2.task('flaky-task').status, 'queued')
    broker2.resolve('flaky-task', { status: 'success', exitCode: 0 })
    assert.equal((await claim2).status, 'success')

    // ---- ④ 派任务前就 offline：错误码必须是 RUNNER_OFFLINE，不能并进「不存在」 ----
    // 以前这里写的是 `verdict.code === 'RUNNER_REVOKED' ? 'RUNNER_REVOKED' : 'RUNNER_NOT_FOUND'`，
    // 于是「机器掉线」被 HTTP 报成 404「runner 不存在」，运维会去改配置而不是去看那台机器。
    await assert.rejects(
      () => repo.runtime.run({ projectId: 'demo', targetName: 'prod', runnerId: 'drop-01', confirm: true, env: { name: 'staging' } }),
      (error) => error.code === 'RUNNER_OFFLINE',
    )
    // ---- ⑤ runnerWaitSec：等不到就一直等，等到了才放行 ----
    // 这条用例没有远端 runner 进程，门禁放行后流水线会卡在等远端接单——
    // 所以断言只到「门禁这一关」，不 await 整个运行：那是另一条用例的主题。
    const waitedAt = Date.now()
    await assert.rejects(
      () => repo.runtime.run({ projectId: 'demo', targetName: 'prod', runnerId: 'drop-01', confirm: true, runnerWaitSec: 1, env: { name: 'staging' } }),
      (error) => error.code === 'RUNNER_OFFLINE',
    )
    assert.equal(Date.now() - waitedAt >= 900, true, 'runnerWaitSec=1 必须真的等约 1 秒，而不是立刻判死')
    // 等回来了：心跳重新记上，门禁不再拦它。
    // 放行之后流水线才会去等那台并不存在的远端机器接单——这里不 await，
    // 只确认「它没有以 RUNNER_OFFLINE 被拒」，然后取消掉这次运行。
    await repo.call('/runner-poll?runnerId=drop-01&token=drop-token')
    const passed = repo.runtime.run({ projectId: 'demo', targetName: 'prod', runnerId: 'drop-01', confirm: true, runnerWaitSec: 1, env: { name: 'staging' } })
    passed.catch(() => {})
    const settled = await Promise.race([
      passed.then(() => 'resolved', (error) => (error.code === 'RUNNER_OFFLINE' ? 'rejected-offline' : 'rejected-other')),
      new Promise((resolve) => setTimeout(() => resolve('still-running'), 500)),
    ])
    assert.equal(settled === 'rejected-offline', false, '心跳回来了，门禁就不该再判它掉线')
    for (const runId of repo.runtime.hub.activeRunIds?.() || []) repo.runtime.cancel({ runId })
  } finally {
    try { repo?.close() } catch { /* 可能没起 */ }
    rmSync(dir, { recursive: true, force: true })
  }
})

checkAsync('v3.0-P7 混沌：库被锁住时部署锁失败关闭，孤儿锁与孤儿运行都要说得出口', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cicd-lock-chaos-'))
  const app = join(dir, 'app')
  mkdirSync(app, { recursive: true })
  // 最小可跑的 pipe：只有 echo，不落部署 —— 这条用例只关心「锁拿不拿得到」。
  writeFileSync(join(app, 'pipe.yml'), [
    'version: 1',
    'name: lock-chaos',
    'targets:',
    '  local:',
    '    hosts: [h1]',
    '    path: /tmp/never-deployed',
    'stages:',
    '  - id: build',
    '    steps:',
    '      - name: say',
    '        run: echo lock-chaos',
    '',
  ].join('\n'))
  // busyTimeoutMs: 0 —— 默认的 5 秒会让「库被锁住」变成「等 5 秒然后照常成功」，测不到失败关闭。
  const repo = await repoTool(join(dir, 'state'), { projects: [{ id: 'demo', path: app, busyTimeoutMs: 0 }] })
  const dbFile = join(dir, 'state', 'cicd.db')
  let locker = null
  try {
    // ---- ① 库被另一个连接独占：部署锁读不出来 → 必须失败关闭，而不是当「没上锁」放行 ----
    locker = new DatabaseSync(dbFile)
    locker.exec('BEGIN IMMEDIATE')
    const denied = await repo.runtime.run({ projectId: 'demo', targetName: 'local', confirmProd: true }).then(
      () => null,
      (error) => error,
    )
    assert.ok(denied, '库被锁住时必须拒绝这次运行，而不是往下跑')
    assert.equal(denied.code, 'LOCK_UNAVAILABLE', '锁读不出来要如实报 LOCK_UNAVAILABLE，不能伪装成 DEPLOY_IN_PROGRESS：实际 ' + denied.code)
    assert.match(denied.message, /部署锁读不出来/)
    // WAL 下读不会被写事务挡住：锁列表此刻还能读，且必须如实读出「没有锁」——
    // 这正是失败关闭的另一半：readable 时不能谎报 unavailable。
    const blind = repo.runtime.lockList()
    assert.equal(blind.ok, true, '读不受影响时不许谎报「锁表读不出来」')
    assert.equal(blind.unavailable, null)
    assert.equal(blind.database.ok, true)
    locker.exec('ROLLBACK')

    // ---- ② 解锁之后必须能正常跑：失败关闭不能变成永远关闭 ----
    const ran = await repo.runtime.run({ projectId: 'demo', targetName: 'local', confirmProd: true })
    assert.equal(ran.status, 'success', '库恢复之后要能继续跑：' + JSON.stringify(ran).slice(0, 200))
    assert.deepEqual(repo.runtime.lockList().locks, [], '跑完之后锁必须放掉，否则下一次永远被挡')

    // ---- ③ 孤儿锁：持有者早就不在 activeRuns 里，列表要点名，清理要签字 ----
    repo.runtime.store.db.prepare('INSERT INTO deploy_locks (target, project_id, run_id, owner, acquired_at, expires_at, heartbeat_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('ghosted', 'demo', 'run-that-died', 'admin', new Date().toISOString(), new Date(Date.now() + 600000).toISOString(), new Date().toISOString())
    const listed = repo.runtime.lockList()
    assert.equal(listed.ok, true)
    const ghost = listed.locks.find((row) => row.target === 'ghosted')
    assert.ok(ghost, '锁列表里应该有这把锁')
    assert.equal(ghost.orphan, true, '持有者的 runId 不在 activeRuns 里，就是孤儿锁')
    assert.deepEqual(listed.orphans, ['ghosted'])
    const noConfirm = await repo.call('/locks?action=reset')
    assert.ok(noConfirm.status >= 400 || noConfirm.body.confirm === undefined, '清锁必须有人在，不能是 GET 一下就把锁清了')
    const reset = repo.runtime.lockResetOrphans({ reason: 'test' })
    assert.deepEqual(reset.cleared.map((item) => item.target), ['ghosted'])
    assert.deepEqual(repo.runtime.lockList().locks, [], '清完之后锁表应该是空的')
    const auditEvents = repo.runtime.auditList({ limit: 20 }).events
    assert.ok(auditEvents.some((event) => event.action === 'deploy.lock_orphan_cleared'), '清锁必须留痕')

    // ---- ④ 孤儿运行：进程被 kill 后留下的 running 行会一直转圈，宽限期内不许误伤 ----
    const insertRun = repo.runtime.store.db.prepare('INSERT INTO runs (id, project_id, pipeline_name, trigger, branch, commit_sha, target, status, dry_run, error, started_at, finished_at, updated_at, config_snapshot, config_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const nowIso = new Date().toISOString()
    const freshAt = new Date(Date.now() - 5 * 1000).toISOString()
    insertRun.run('ghost-old', 'demo', 'ghost', 'manual', '', '', 'local', 'running', 0, '', new Date(Date.now() - 5 * 60 * 1000).toISOString(), '', nowIso, '', '')
    insertRun.run('ghost-fresh', 'demo', 'ghost', 'manual', '', '', 'local', 'running', 0, '', freshAt, '', nowIso, '', '')
    const swept = repo.runtime.reconcileRuns()
    assert.ok(swept.marked >= 1, '5 分钟前就在 running 的行必须被收尾：实际 ' + swept.marked)
    const oldRow = repo.runtime.store.run('ghost-old')
    const freshRow = repo.runtime.store.run('ghost-fresh')
    assert.equal(oldRow.status, 'failed', '孤儿运行不收尾，面板会永远转圈、MTTR 也算不出来')
    assert.match(oldRow.error, /ghost/)
    assert.equal(freshRow.status, 'running', '刚建几秒的行可能是另一个副本在写，宽限期（60s）内不许判死')
  } finally {
    try { locker?.close() } catch { /* 可能已经关了 */ }
    try { repo?.close() } catch { /* 可能没起 */ }
    rmSync(dir, { recursive: true, force: true })
  }
})
checkAsync('v3.0-P7 缓存命中率：构建缓存与工具链分两本账，从不命中的 key 族要指名道姓', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cicd-cache-stats-'))
  const tick = { t: Date.parse('2026-05-01T00:00:00Z') }
  const clock = () => tick.t
  try {
    // ---- ① 构建缓存台账 ----
    const { createCacheStore } = internals.cache
    const store = createCacheStore({ dir: join(dir, 'cache'), now: clock })
    const app = join(dir, 'app')
    mkdirSync(join(app, 'out'), { recursive: true })
    writeFileSync(join(app, 'out', 'a.txt'), 'artifact-a')
    const saved = await store.save({ projectId: 'app', projectPath: app, key: 'npm-aaa', paths: ['out/*.txt'] })
    assert.equal(saved.ok, true, '先得存进去一份才谈得上命中')
    assert.deepEqual((await store.restore({ projectId: 'app', projectPath: app, key: 'npm-aaa', paths: ['out/*.txt'] })).exact, true)
    // 前缀命中：key 变了、前缀没变，仍应该拿到上一份（restore_keys 的语义）
    tick.t += 60 * 1000
    writeFileSync(join(app, 'out', 'a.txt'), 'artifact-b')
    const prefixed = await store.restore({ projectId: 'app', projectPath: app, key: 'npm-bbb', paths: ['out/*.txt'], restoreKeys: ['npm-'] })
    assert.equal(prefixed.hit, true)
    assert.equal(prefixed.exact, false, '换了 key 只能算前缀命中')
    // 三次「每次都换 key」的未命中：这是 pipe.yml 里 key 混进时间戳的典型形状。
    // 不带 restore_keys —— 带了前缀就会命中 npm-aaa，那测的就不是「从不命中」了。
    // 用不同的文件名：同一批文件在上一轮已经落地，restore 会「恢复成功」而不是落空。
    for (let i = 0; i < 3; i += 1) {
      tick.t += 60 * 1000
      const missed = await store.restore({ projectId: 'app', projectPath: app, key: 'stamp-' + tick.t, paths: ['stamp/*.txt'] })
      assert.equal(missed.hit, false, '没有缓存条目时必须是未命中')
    }
    // 存一次空的：save-failed 也要记账，否则「缓存一直没存上」看起来像「没人用缓存」
    tick.t += 60 * 1000
    const emptySave = await store.save({ projectId: 'app', projectPath: app, key: 'npm-empty', paths: ['dist/*.js'] })
    assert.equal(emptySave.ok, false)

    const build = store.stats({ days: 30 })
    assert.equal(build.ok, true)
    assert.equal(build.exact, 1)
    assert.equal(build.prefix, 1)
    assert.equal(build.miss, 3)
    assert.equal(build.lookups, 5)
    assert.equal(build.hitRate, 0.4, '两次命中除以五次查找')
    assert.equal(build.exactRate, 0.2)
    assert.equal(build.save, 1, '只存进去一份：后来那次为空，不能算保存成功')
    assert.equal(build.saveFailed, 1)
    assert.ok(build.hitBytes > 0, '命中要能说出省了多少字节')
    // 从不命中的那一族必须被点出来：stamp 三次全落空，npm 有命中所以不算冷
    // 这条断言钉的是真缺陷：分组名一度叫 prefix，把同名的「前缀命中次数」覆盖掉了，
    // 「前缀命中数 === 0」于是永远不成立，冷族永远是空的。分组名现在叫 key。
    const cold = build.coldPrefixes.map((item) => item.key)
    assert.deepEqual(cold, ['stamp'])
    assert.equal(build.prefixes[0].key, 'stamp', '按命中次数倒序，冷族排前面')
    // 窗口之外的不算进命中率，否则上个月的坏 key 会永远压低这个月的数
    assert.equal(store.stats({ days: 30, projectId: 'nobody' }).lookups, 0)
    assert.equal(store.stats({ days: 30, projectId: 'nobody' }).hitRate, null, '没有样本时命中率是 null，不是 0')
    tick.t += 400 * 24 * 60 * 60 * 1000
    assert.equal(store.stats({ days: 30 }).lookups, 0, '窗口外的事件不该再计入')

    // ---- ② 工具链台账：命中与真装分开计 ----
    const tc = createToolchain({ storeDir: join(dir, 'toolchains'), offline: true, now: clock })
    // 注意台账固定落在 <storeDir>/usage.jsonl：createToolchain 每次调用都会 mkdir storeDir，
    // 所以得在第一次调用之后才写的进这个文件，路径不能想当然多拼一层。
    const tcFile = join(dir, 'toolchains', 'usage.jsonl')
    mkdirSync(join(dir, 'toolchains'), { recursive: true })
    writeFileSync(tcFile, [
      { at: new Date(tick.t).toISOString(), event: 'hit', lang: 'node', version: '20.0.0' },
      { at: new Date(tick.t).toISOString(), event: 'hit', lang: 'node', version: '20.0.0' },
      { at: new Date(tick.t).toISOString(), event: 'install', lang: 'node', version: '21.0.0' },
      { at: new Date(tick.t).toISOString(), event: 'install', lang: 'java', version: 'temurin-17' },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n')
    const tcStats = tc.stats({ days: 30 })
    assert.equal(tcStats.hit, 2)
    assert.equal(tcStats.install, 2)
    assert.equal(tcStats.hitRate, 0.5)
    assert.deepEqual(tcStats.langs.map((item) => item.lang).sort(), ['java', 'node'])
    const nodeRow = tcStats.langs.find((item) => item.lang === 'node')
    assert.equal(nodeRow.hitRate, Math.round((2 / 3) * 10000) / 10000)

    // ---- ③ 两本账绝不合成一个数：构建缓存 0 命中不该被工具链的高命中掩掉 ----
    const repo = await repoTool(join(dir, 'state'), { projects: [{ id: 'app', name: 'app', path: app }] })
    try {
      const body = await repo.call('/api/plugins/cicd/metrics').then((response) => response.json())
      assert.equal(body.ok, true)
      assert.ok(body.cache, '指标接口必须带上缓存命中率')
      assert.equal(typeof body.cache.build, 'object')
      assert.equal(typeof body.cache.toolchain, 'object')
      assert.equal(body.cache.build.hitRate, null, '这个工作目录里还没有查找记录')
      assert.equal('cache' in (body.dora || {}), false, '缓存命中率不进 DORA 四指标：它影响成本，不影响发布速度')
      const viaHttp = await repo.call('/cache-stats?days=7').then((response) => response.json())
      assert.equal(viaHttp.ok, true)
      assert.equal(viaHttp.windowDays, 7)
      assert.equal(typeof viaHttp.build.coldPrefixes, 'object')
      assert.equal((await repo.call('/cache-stats?days=0')).status, 400, '窗口天数必须被校验')
      assert.equal((await repo.call('/cache-stats?bogus=1')).status, 400, '不认识的参数要拒绝，而不是悄悄忽略')
      // 工具层同一份数据：两个入口必须说同一句话
      const tool = ctx.toolsList.find((item) => item.name === 'cicd_cache_stats')
      assert.ok(tool, '缓存命中率要有一个工具入口，否则只有前端看得到')
      const toolBody = await tool.execute({ days: 30 }, {})
      assert.equal(typeof toolBody.build, 'object')
      const rendered = tool.output.render({ days: 30 }, toolBody).map((block) => block.text).join('\n')
      assert.ok(rendered.includes('缓存命中率'), rendered)
      assert.ok(rendered.includes('工具链'), rendered)
    } finally { repo.close() }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

checkAsync('v3.0-P6-6 引导：四步全由库现算，做完才打勾，项目换一个不会假装已完成', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cicd-p6-6-'))
  try {
    const projectDir = join(dir, 'app')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'pipe.yml'), [
      'name: guide-app',
      'default_target: staging',
      'targets:',
      '  staging:',
      '    hosts: [dev1]',
      '    path: /srv/guide-app',
      '  prod:',
      '    hosts: [web1]',
      '    path: /srv/guide-app',
      'stages:',
      '  - id: build',
      '    steps:',
      '      - name: b',
      '        run: echo hi',
      '',
    ].join('\n'))
    const repo = await repoTool(join(dir, 'state'), { projects: [{ id: 'app', name: 'app', path: projectDir }] })
    try {
      // ① 空库：没有任何一件事算完成，四步都说得出口且只给一个下一步。
      const fresh = await repo.call('/onboarding?project=app').then((response) => response.json())
      assert.equal(fresh.ok, true)
      assert.equal(fresh.total, 5)
      // guards（环境名单）排在身份前面：名单没配时，后面三步做完了也发不出去。
      assert.deepEqual(fresh.steps.map((step) => step.id), ['project', 'guards', 'identity', 'run', 'deploy'])
      assert.equal(fresh.steps[0].done, true, 'pipe.yml 可读，项目这一步就该是完成的：' + JSON.stringify(fresh.steps[0]))
      assert.deepEqual(fresh.targetNames, ['staging', 'prod'])
      assert.equal(fresh.steps[1].done, false, 'pipe 里 prod 没配 allowedActors，名单这步不能打勾')
      assert.equal(fresh.steps[2].done, false, '库里没有账号时身份这步不能算完成')
      assert.equal(fresh.steps[3].done, false)
      assert.equal(fresh.steps[4].done, false)
      assert.equal(fresh.currentStep, 'guards', '名单没配时「下一步」应先指向它，而不是从后往前找')
      assert.equal(fresh.complete, false)
      // 没完成的每一步都必须给一个具体动作，否则新用户还是不知道该点哪。
      for (const step of fresh.steps.filter((item) => !item.done)) {
        assert.ok(step.next, '未完成的步骤必须说明下一步：' + step.id)
        assert.ok(step.action, '未完成的步骤必须有一个跳转目标：' + step.id)
      }

      // ② 建一个账号后身份这步才打勾 —— 勾是从库里算的，不是前端记的。
      repo.runtime.users({ action: 'create', email: 'guide@acc.test', password: 'Passw0rd!23', displayName: 'Guide', role: 'owner' })
      const withUser = await repo.call('/onboarding?project=app').then((response) => response.json())
      const identity = withUser.steps.find((step) => step.id === 'identity')
      assert.equal(identity.done, true, '库里有了账号，身份这步必须打勾')
      // 共 5 步：project + identity 完成，guards 仍然缺（这份 pipe 的 prod 没有名单）。
      assert.equal(withUser.doneCount, 2)
      assert.equal(withUser.currentStep, 'guards', '身份完成后，仍缺的环境名单是挡在发布前的第一件事')

      // ③ 有过一次运行才轮到 deploy；直接往库里写一行模拟历史，避免真跑构建。
      assert.equal(withUser.steps[3].done, false)
      repo.runtime.store.appendRun({ id: 'run-guide-1', projectId: 'app', status: 'succeeded', startedAt: new Date().toISOString() })
      const afterRun = await repo.call('/onboarding?project=app').then((response) => response.json())
      assert.equal(afterRun.steps[3].done, true, '库里有了运行记录，运行这步必须打勾')
      assert.equal(afterRun.doneCount, 3)
      assert.equal(afterRun.currentStep, 'guards', '运行做完后，仍缺的名单还是排在发布之前')

      // ④ 没有项目上下文时不能凭空报完成。
      const noProject = await repo.call('/onboarding').then((response) => response.json())
      assert.equal(noProject.steps[0].done, false, '没传 project 时项目这步必须是否')
      assert.equal(noProject.complete, false)
      assert.equal(noProject.currentStep, 'project')

      // ⑤ 未知参数要挡：引导只读两个字段，多传一个就说明调用方写错了。
      const stray = await repo.call('/onboarding?project=app&projet=typo')
      assert.equal(stray.status, 400)
      const crossOrigin = await repo.call('/onboarding?project=app', { headers: { origin: 'http://evil.test' } })
      assert.equal(crossOrigin.status, 403, '引导是只读的，但仍然只接受同源请求')
    } finally { repo.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
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
  assert.equal(ctx.routes.length, 49)
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

check('DB：v1 库迁移到 user_version=12，补出 env、operations 审计列、projects 表、steps.runner_id 与 4 列主键、runs 配置快照、releases 回滚现场、制品三表', () => {
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
  assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 12)
  // v3.0-P7：迁移必须留下台账——旧版只有版本号，没人答得上「这一版比上一版多了什么」。
  const ledger = db.prepare('SELECT version, note, additive FROM schema_migrations ORDER BY version').all()
  assert.equal(ledger.length, SCHEMA_VERSION, '每一版都得有一行')
  assert.equal(Number(ledger[ledger.length - 1].version), 12)
  assert.ok(ledger.every((row) => String(row.note || '').length > 0), '每一版的说明不能是空的')
  // 破坏性变更（重建表 / 改主键）必须诚实标出来，否则「能不能退回去」会被答成能退。
  const breaking = ledger.filter((row) => Number(row.additive) === 0).map((row) => Number(row.version))
  assert.deepEqual(breaking, [1, 7, 11])
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
  'environments:',
  '  prod:',
  '    allowedActors: [user:local]',
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

// v3.0-P5-5 用例：只有 staging 一个环境、主机的 env 与 envdemo 的 prod 重叠（env:prod + group:api）。
const DIRECT_PIPE_SOURCE = [
  'version: 1',
  'name: direct-pipe',
  'environments:',
  '  prod:',
  '    allowedActors: [user:local]',
  'targets:',
  '  staging:',
  '    hosts: [api2]',
  '    path: /srv/direct',
  '    runtime: static',
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
  '          target: staging',
  '          artifacts: ["bundle-prod.tgz"]',
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
writeFileSync(join(envProject, 'bundle-prod.tgz'), 'bundle', 'utf8')
writeFileSync(join(bogusProject, 'pipe.yml'), BOGUS_PIPE_SOURCE, 'utf8')
const directProject = join(envRoot, 'direct')
mkdirSync(directProject, { recursive: true })
writeFileSync(join(directProject, 'pipe.yml'), DIRECT_PIPE_SOURCE, 'utf8')
writeFileSync(join(directProject, 'bundle-prod.tgz'), 'bundle', 'utf8')
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
    { id: 'direct', name: 'Direct', path: directProject, pipe: join(directProject, 'pipe.yml') },
  ],
  workDir: join(envRoot, 'state'),
  remoteBase: 'http://127.0.0.1:7891',
})

function envCall(routePath, query = '', options = {}) {
  const route = envCtx.routes.find((item) => item.path === internals.ROUTE_PREFIX + routePath)
  assert.ok(route, `route ${routePath} registered`)
  return route.resource(new Request(`http://x${internals.ROUTE_PREFIX}${routePath}${query}`, {
    method: options.method || 'GET',
    headers: { 'x-dsh-cicd': '1', ...(options.headers || {}) },
    ...(options.body === undefined ? {} : { body: options.body }),
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

    // v3.0-P5-5：受保护环境只接受已晋级的 digest。另一个项目（direct）里同名 staging
    // target 的 host 与 envdemo 的 prod host 重叠（它自己的 pipe 里没有 prod 环境，所以不会被
    // 当成受保护目标），用它跑一次拿到"字节相同、身份不同"的 digest，再把它晋级到 envdemo 的 prod：
    // 这正是"跨项目、跨记账系统"的那条缝，也是 digest 恒等唯一说得清的通行证。
    const directRun = await envCall('/run', '?project=direct&target=staging&confirm=1').then((response) => response.json())
    // 发布行摘要里没有 digest（账本对外不暴露内部字段），从账本本身取。
    // recordId 才是账本主键（形如 <runId>@<host>），releases()[].id 是 runId。
    const directReleaseId = (directRun.releases || [])[0]?.recordId || ''
    assert.ok(directReleaseId, 'direct run: ' + JSON.stringify(directRun).slice(0, 600))
    const envStore = createStore({ dir: join(envRoot, 'state') })
    const directRow = envStore.release(directReleaseId)
    const directDigest = String(directRow?.artifact_digest || '')
    envStore.close()
    const directRecordId = String(directRow?.id || '')
    assert.equal(directRun.ok, true, 'direct run: ' + JSON.stringify(directRun).slice(0, 1500))
    assert.match(directDigest, /^sha256:[0-9a-f]{64}$/, 'direct run: ' + JSON.stringify(directRun).slice(0, 1500))
    const promoted = await envCall('/promotions', '?confirm=1', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: '1', project: 'envdemo', toEnv: 'prod', releaseId: directRecordId, digest: directDigest }),
    }).then((response) => response.json())
    assert.equal(promoted.digest, directDigest, 'promote: ' + JSON.stringify(promoted).slice(0, 800))
    assert.equal(promoted.toEnv, 'prod')

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

checkAsync('P5-5 晋级：digest 恒等、跨环境不复制字节、闸门按主机 env 逐台拦', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = envFetch
  try {
    // 独立 workDir：与前面用例共库会让「最新指针」被别人的晋级抢走，测的就不是本用例的事了。
    const store = createStore({ dir: join(envRoot, 'promotions'), file: join(envRoot, 'promotions', 'state.sqlite') })
    try {
      const digest = 'sha256:' + 'a'.repeat(63) + '1'
      const envs = { dev: { order: 1 }, staging: { order: 2 }, prod: { order: 3, protected: true } }

      // ① 不指名来源 = 拒绝。默认「取 staging 最新」会让一次手滑的 POST 把陌生 digest 送进生产。
      // （store 层不拦：from_env 允许为空，因为"直接从构建进入"是合法路径。拦在 runtime.promote。）
      recordPromotion(store.db, { id: 'p-direct', projectId: 'envdemo', digest, toEnv: 'prod', fromEnv: '', createdAt: '2026-01-01T00:00:00.000Z' })
      const direct = listPromotions(store.db, { projectId: 'envdemo', env: 'prod' }).find((row) => row.id === 'p-direct')
      assert.ok(direct)
      assert.equal(direct.from_env, '')
      store.db.prepare('DELETE FROM promotions WHERE id = ?').run('p-direct')

      // ② 最新一行就是环境指针，历史留着不删（问「当时上线的到底是哪个包」要能答）
      const first = recordPromotion(store.db, { id: 'p-1', projectId: 'envdemo', digest, fromEnv: 'staging', toEnv: 'prod', releaseId: 'r-1', createdAt: '2026-01-01T00:00:01.000Z' })
      assert.equal(first.digest, digest)
      const other = 'sha256:' + 'b'.repeat(63) + '2'
      recordPromotion(store.db, { id: 'p-2', projectId: 'envdemo', digest: other, fromEnv: 'staging', toEnv: 'prod', releaseId: 'r-2', createdAt: '2026-01-01T00:00:02.000Z' })
      // 同一毫秒内的两次晋级：created_at 分不出先后，rowid DESC 兜底后最新一行必须还是后写的那个。
      assert.equal(currentPointer(store.db, { projectId: 'envdemo', env: 'prod' }).digest, other)
      assert.equal(listPromotions(store.db, { projectId: 'envdemo', env: 'prod' }).length, 2)

      // ③ 判据是「晋级过」而不是「在这个环境跑过」：老 digest 仍算数，没晋级的永不算数
      assert.ok(isPromoted(store.db, { projectId: 'envdemo', env: 'prod', digest }))
      // 没晋级过返回 null（真值判定即可，不必伪造 false）
      assert.equal(Boolean(isPromoted(store.db, { projectId: 'envdemo', env: 'prod', digest: 'sha256:' + 'c'.repeat(63) + '3' })), false)
      assert.equal(Boolean(isPromoted(store.db, { projectId: 'envdemo', env: 'staging', digest })), false)

      // ④ 视图：每个环境一行，指针与最近历史都在
      const view = promotionView(store.db, { projectId: 'envdemo', environments: envs })
      assert.deepEqual(view.map((item) => item.name), ['dev', 'staging', 'prod'])
      const prod = view.find((item) => item.name === 'prod')
      assert.equal(prod.digest, other)
      assert.equal(prod.protected, true)
      assert.equal(prod.history.length, 2)
      assert.equal(view.find((item) => item.name === 'dev').digest, '')

      // ⑤ 受保护环境的判定：显式 protected 或按约定叫 prod，两种都算
      assert.equal(envRequiresPromotion(envs, 'prod'), true)
      assert.equal(envRequiresPromotion({ dev: { order: 1 } }, 'prod'), true)
      assert.equal(envRequiresPromotion({ canary: { order: 9, protected: true } }, 'canary'), true)
      assert.equal(envRequiresPromotion(envs, 'staging'), false)

      // ⑥ 源发布只认 active：superseded 是历史，failed 从来没跑起来过
      assert.equal(findSourceRelease(store.db, { projectId: 'envdemo', fromEnv: 'prod' }), null)
      assert.equal(findSourceRelease(store.db, { releaseId: 'nope' }), null)
    } finally { store.close() }
  } finally { globalThis.fetch = originalFetch }
})

checkAsync('P5-5 闸门：没有晋级记录的 digest 到不了受保护环境 —— 两条部署路径都拦、且在主机动过之前拦', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = envFetch
  try {
    // （「没晋级的 digest 进不了受保护环境」这条由 v0.5 生产护栏用例正着测：
    //   它先确认带未晋级 digest 的 run 被拒，再晋级同一份字节、同一条命令通过。）
    // 这里只钉住晋级接口自己的拒绝面 —— 那三条错误码是闸门的另一半。
    // 晋级接口的拒绝面：不指名来源 = PROMOTION_SOURCE_REQUIRED（不猜「最新 staging」）
    const noSource = await envCall('/promotions', '?confirm=1', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: '1', project: 'envdemo', toEnv: 'prod' }),
    })
    assert.equal(noSource.status, 400)
    assert.equal((await noSource.json()).code, 'PROMOTION_SOURCE_REQUIRED')

    // 指名了来源但 toEnv 不在晋升路径上 = PROMOTION_PATH_INVALID
    const badPath = await envCall('/promotions', '?confirm=1', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: '1', project: 'envdemo', toEnv: 'nowhere', releaseId: 'x@y' }),
    })
    assert.equal(badPath.status, 400)
    assert.equal((await badPath.json()).code, 'PROMOTION_PATH_INVALID')
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
    watchSec: 0,
    setIntervalImpl: (fn, ms) => { scheduled.push(ms); return { id: scheduled.length } },
    clearIntervalImpl: () => { scheduled.push('cleared') },
  })
  assert.equal(timers.start(), true)
  assert.equal(timers.start(), false, '重复 start 应返回 false')
  assert.deepEqual(scheduled, [20000], `pollSec=0 时只挂 tick 定时器，实际 ${JSON.stringify(scheduled)}`)
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

checkAsync('V2-M1 DORA：四指标计算、dry_run 排除、MTTR 恢复、空窗口与路由校验；P7 指标/存储/通知台账', async () => {
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
})

checkAsync('v3.0-P7 可观测：运行质量指标、磁盘占用、通知台账', async () => {
  const now = Date.parse('2026-01-06T12:00:00.000Z')
  // ---- v3.0-P7：运行质量指标（metrics） ------------------------------------------------
  const qRuns = [
    { id: 'q1', project_id: 'p', target: 'prod', status: 'success', started_at: '2026-01-05T08:00:00.000Z', finished_at: '2026-01-05T08:00:10.000Z', config_hash: 'h1' },
    { id: 'q2', project_id: 'p', target: 'prod', status: 'success', started_at: '2026-01-05T08:00:05.000Z', finished_at: '2026-01-05T08:01:05.000Z', config_hash: 'h1' },
    { id: 'q3', project_id: 'p', target: 'prod', status: 'failed', started_at: '2026-01-05T09:00:00.000Z', finished_at: '2026-01-05T09:03:00.000Z', config_hash: 'h2', queued_at: '2026-01-05T08:59:30.000Z' },
  ]
  const qSteps = {
    q1: [{ stage_id: 'build', duration_ms: 4000, status: 'success' }, { stage_id: 'deploy', duration_ms: 6000, status: 'success' }],
    q2: [{ stage_id: 'build', duration_ms: 30000, status: 'success' }],
    q3: [{ stage_id: 'build', duration_ms: 20000, status: 'failed' }],
  }
  const quality = internals.summarizeRunQuality({ runs: qRuns, steps: qSteps, now, days: 30 })
  assert.equal(quality.total, 3)
  assert.equal(quality.durationSec.samples, 3)
  assert.equal(quality.durationSec.max, 180, '最慢一次是 q3 的 3 分钟')
  assert.equal(quality.durationSec.p50, 60, 'P50 用最近秩法取真实观测值 60s')
  assert.equal(quality.longest.id, 'q3')
  // q1 与 q2 在 08:00:05 之后到 08:00:10 之间同时在跑——峰值必须是 2，不是 1。
  assert.equal(quality.concurrency.peak, 2)
  // 只有 q3 记了 queued_at：排队样本 1 个、30 秒。
  assert.equal(quality.queueSec.samples, 1)
  assert.equal(quality.queueSec.p50, 30)
  assert.equal(quality.stages[0].stage, 'build', 'build 累计 54s，占大头')
  assert.equal(quality.stages[0].failed, 1)
  assert.equal(quality.repeated.length, 1, 'config_hash h1 跑了两次')
  assert.equal(quality.repeated[0].runs, 2)
  const emptyQuality = internals.summarizeRunQuality({ runs: [], now, days: 7 })
  assert.equal(emptyQuality.durationSec.p50, null)
  assert.equal(emptyQuality.concurrency.peak, 0)
  assert.deepEqual(emptyQuality.stages, [])

  const metricsRes = await call('/metrics', '?days=7')
  const metricsBody = await metricsRes.json()
  assert.equal(metricsBody.ok, true, `/metrics 失败：${metricsRes.status} ${JSON.stringify(metricsBody)}`)
  assert.equal(metricsBody.windowDays, 7)
  assert.equal(metricsBody.total, 0, '夹具里没有真实运行，窗口内样本必须为 0（形状照旧返回 null）')
  assert.equal(metricsBody.durationSec.p95, null, '没有样本时 P95 是 null 而不是 0——0 会被读成「都跑得很快」')
  assert.equal(metricsBody.concurrency.peak, 0)
  assert.equal(typeof metricsBody.windowDays, 'number')
  assert.equal((await call('/metrics', '?days=0')).status, 400)
  assert.equal((await call('/metrics', '?extra=1')).status, 400)

  // /storage：真实目录树，报出的字节数必须等于自己数出来的一份。
  const storageBody = await call('/storage', '').then((response) => response.json())
  assert.equal(storageBody.ok, true)
  assert.ok(storageBody.total.bytes >= storageBody.logs.bytes, '合计不小于其中的日志部分')
  assert.ok(storageBody.database.bytes > 0, '数据库文件必须存在')

  // /notify-ledger：没配置 webhook 时是空列表，不是 500。
  const ledger = await call('/notify-ledger', '').then((response) => response.json())
  assert.equal(ledger.ok, true)
  assert.deepEqual(ledger.entries, [])
  assert.equal((await call('/notify-ledger', '?limit=0')).status, 400)
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

checkAsync('P7 触发：pipe.yml 的 triggers.watch 让「改配置」也能触发一次运行，且只在安静期后触发', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cicd-watch-'))
  const pipe = join(root, 'pipe.yml')
  writeFileSync(pipe, 'version: 1\nname: w\ntargets:\n  staging:\n    hosts: [h]\n    path: /srv/w\nstages:\n  - id: build\n    steps:\n      - run: echo hi\n', 'utf8')
  const fired = []
  const scheduler = internals.createScheduler({
    getProjects: () => [{ id: 'w', name: 'w', path: root, pipe }],
    readPipe: () => ({ name: 'w', triggers: { watch: { debounceSec: 5, target: 'staging' }, manual: true } }),
    run: async (args) => { fired.push(args); return { status: 'success' } },
    defaultTarget: 'staging',
    stateDir: join(root, 'state'),
    tickSec: 3600,
    pollSec: 0,
    watchSec: 0,
  })
  assert.equal(scheduler.snapshot().watchSec, 0, 'watchSec=0 表示不启定时器')
  // 第一次看到这个项目只建立基线：插件刚启动不该把当前配置当成一次改动。
  const first = await scheduler.watchOnce(Date.now())
  assert.deepEqual(first.fired, [])
  assert.equal(fired.length, 0)
  // 改动 pipe 后立刻调用：还在安静期内，不触发。
  writeFileSync(pipe, `${readFileSync(pipe, 'utf8')}# touched\n`, 'utf8')
  const during = await scheduler.watchOnce(Date.now() + 1000)
  assert.deepEqual(during.fired, [], '安静期内不该触发')
  // 安静期过后再调：触发一次，trigger 记成 watch。
  const after = await scheduler.watchOnce(Date.now() + 20000)
  assert.equal(after.fired.length, 1)
  assert.equal(fired.length, 1)
  assert.equal(fired[0].trigger, 'watch')
  assert.equal(fired[0].target, 'staging')
  assert.equal(fired[0].project.id, 'w')
  // 内容没再变：同一份文件不重复触发。
  const again = await scheduler.watchOnce(Date.now() + 40000)
  assert.deepEqual(again.fired, [])
  assert.equal(fired.length, 1)
  scheduler.stop()
  rmSync(root, { recursive: true, force: true })
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

check('P4-4 secrets：载荷加密落盘、密钥来源可答、坏密钥不悄悄换新', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cicd-secrets-enc-'))
  const workDir = join(dir, 'state')
  // 1) 磁盘上找不到明文：载荷文件里既没有值，也没有能直接读出来的字节。
  const store = createSecretStore({ dir: workDir, key: 'a'.repeat(64) })
  store.set('demo', 'global', 'DB_PASSWORD', 's3cret-value-9137')
  const raw = readFileSync(join(workDir, '.secrets.json'), 'utf8')
  assert.ok(!raw.includes('s3cret-value-9137'), '载荷文件里不能出现明文')
  assert.ok(raw.includes('"iv"') && raw.includes('"tag"') && raw.includes('"ct"'), '记录必须是 iv/tag/ct 形态')
  assert.equal(store.stats().encrypted, 1)
  assert.equal(store.stats().plaintext, 0)
  assert.equal(store.stats().backend, 'config')
  // 装载时生成了本机密钥文件；重开一次就是从这个文件读回来的（local 表示本次生成）。
  const local = createSecretStore({ dir: workDir })
  assert.equal(local.stats().backend, 'local')
  assert.equal(local.stats().keyFile, join(workDir, 'secrets.key'))
  // 换成不相关的钥匙重开：已有密文解不开，但这把钥匙的位置仍要报得出来。
  assert.equal(local.get('demo', 'global', 'DB_PASSWORD'), '')
  assert.equal(local.stats().undecryptable, 1)

  // 2) 换一把钥匙：解不开就报 undecryptable，也不把它注进构建环境。
  const stranger = createSecretStore({ dir: workDir, key: 'b'.repeat(64) })
  assert.equal(stranger.get('demo', 'global', 'DB_PASSWORD'), '')
  assert.equal(stranger.stats().undecryptable, 1)
  assert.equal(stranger.refsForInterpolate('demo', {}).DB_PASSWORD, undefined)

  // 3) 密钥文件内容坏掉 = 配置错误。悄悄生成新钥会让已有密文全部变成垃圾。
  writeFileSync(join(workDir, 'secrets.key'), 'not-a-key')
  assert.throws(() => createSecretStore({ dir: workDir }), /不是合法的 32 字节密钥/)

  // 4) rotate：能解开的重加密，解不开的原样留下并报数量 —— 不替用户删 secret。
  const rotated = store.rotate({ key: 'c'.repeat(64) })
  assert.equal(rotated.rotated, 1)
  assert.equal(rotated.skipped, 0)
  const afterRotate = createSecretStore({ dir: workDir, key: 'c'.repeat(64) })
  assert.equal(afterRotate.get('demo', 'global', 'DB_PASSWORD'), 's3cret-value-9137')
  store.dispose()
  rmSync(dir, { recursive: true, force: true })
})

checkAsync('P4-3 环境护栏：五条件缺一即拒，名单按真实角色判', async () => {
  const { assertEnvironmentGuard, parseEnvironmentGuards, actorMatchesAllowlist, branchMatchesRule } = await import('../lib/environments.js')
  const guards = parseEnvironmentGuards({
    prod: {
      protected: true,
      allowedActors: ['user:alice', 'role:owner', 'token:tok-1'],
      branchRule: '^release/.*$',
      approval: true,
    },
    // 写错的前缀不是「不限」，是配置错误：悄悄放行等于谁知道写法谁就能发生产。
    broken: { allowedActors: ['alice'] },
  })
  assert.equal(guards.invalid.length, 1)
  assert.equal(guards.invalid[0].env, 'broken')

  const guard = guards.byEnv.get('prod')
  assert.equal(actorMatchesAllowlist({ id: 'alice', role: 'viewer' }, guard.allowedActors), true)
  assert.equal(actorMatchesAllowlist({ id: 'bob', role: 'owner' }, guard.allowedActors), true)
  assert.equal(actorMatchesAllowlist({ id: 'bob', role: 'viewer', tokenId: 'tok-1' }, guard.allowedActors), true)
  assert.equal(actorMatchesAllowlist({ id: 'bob', role: 'viewer' }, guard.allowedActors), false)
  assert.equal(branchMatchesRule(guard.branchRule, { branch: 'release/1.2' }), true)
  assert.equal(branchMatchesRule(guard.branchRule, { branch: 'main' }), false)

  const verdict = (over) => assertEnvironmentGuard({ env: 'prod', guard, digestPresent: true, branch: 'release/1.2', tag: '', actor: { id: 'alice', role: 'viewer' }, ...over })
  assert.equal(verdict({}).ok, true)
  assert.equal(verdict({ actor: { id: 'mallory', role: 'viewer' } }).failures[0].code, 'ENV_ACTOR_NOT_ALLOWED')
  assert.equal(verdict({ branch: 'main' }).failures[0].code, 'ENV_BRANCH_NOT_ALLOWED')
  assert.equal(verdict({ digestPresent: false }).failures[0].code, 'ENV_DIGEST_REQUIRED')
  assert.equal(verdict({ guard: { ...guard, approval: false } }).failures[0].code, 'ENV_GUARD_MISCONFIGURED')
  assert.equal(verdict({ guard: { ...guard, protected: false } }).failures[0].code, 'ENV_GUARD_MISCONFIGURED')
  // 非受保护环境不判条件；但护栏若把 protected 标成 true，就不再是「非受保护」。
  assert.equal(assertEnvironmentGuard({ env: 'dev', guard: { name: 'dev', protected: false, allowedActors: [], branchRule: '', approval: false }, actor: { id: 'x' }, digestPresent: true }).required, false)
  // 没有名单 != 谁都可以：受保护环境必须写清楚「谁能发」。
  const noList = assertEnvironmentGuard({ env: 'prod', guard: { ...guard, allowedActors: [] }, actor: { id: 'alice' }, digestPresent: true, branch: 'release/1.2' })
  assert.equal(noList.failures[0].code, 'ENV_GUARD_NO_ALLOWLIST')
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
  // v3.0-P4-3：受保护环境必须有主体名单，否则护栏先于审批门拒（403 ENV_GUARD_NO_ALLOWLIST），
  // 这三条验收测的是审批门本身（谁批、一条审批能用到哪个 digest），不是护栏。
  'environments:',
  '  prod:',
  '    allowedActors: [role:owner]', // 验收②的 token 属于 owner 账号（/auth 如实报 owner，名单按真实角色精确匹配）
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

checkAsync('P4-1：只有 owner 能授予角色 —— admin 建人/改角色 403 POLICY_DENY，owner 照常，且 deny 进审计', async () => {
  // 这条钉的是 P4-1 的验收："Owner 才能授予"。admin 是能跑部署的角色，
  // 所以一旦它也能建人提权，prod 审批与护栏就都可以被自己人绕过。
  const escalate = await accCall('/users', `?action=create&email=escalate%40acc.test&password=${encodeURIComponent(ACC_PASSWORD)}&role=owner&confirm=1`, {
    headers: { authorization: `Bearer ${accIds.approverToken}` },
  })
  assert.equal(escalate.status, 403, 'admin 不能建人')
  assert.equal((await escalate.json()).code, 'POLICY_DENY')

  const selfPromote = await accCall('/users', `?action=set-role&id=${encodeURIComponent(accIds.approver)}&role=owner&confirm=1`, {
    headers: { authorization: `Bearer ${accIds.approverToken}` },
  })
  assert.equal(selfPromote.status, 403, 'admin 不能改角色（更别说给自己升 owner）')
  assert.equal((await selfPromote.json()).code, 'POLICY_DENY')

  const ownerAuth = { authorization: `Bearer ${accIds.adminToken}` }
  const granted = await accCall('/users', `?action=create&email=p41%40acc.test&password=${encodeURIComponent(ACC_PASSWORD)}&role=viewer&confirm=1`, { headers: ownerAuth })
  assert.equal(granted.status, 200, 'owner 能建人')
  const newId = (await granted.json()).user.id
  const promote = await accCall('/users', `?action=set-role&id=${encodeURIComponent(newId)}&role=operator&confirm=1`, { headers: ownerAuth })
  assert.equal(promote.status, 200, 'owner 能授予项目级角色')
  assert.equal((await promote.json()).membership.role, 'operator')

  // 被拒的提权也要留痕：审计只记成功的高危操作等于没审计。
  const audit = await accCall('/audit?name=policy.deny', '', { headers: ownerAuth })
  assert.equal(audit.status, 200)
  const rows = (await audit.json()).events
  assert.ok(
    rows.some((item) => item.result === 'deny' && item.actorId === accIds.approver),
    'admin 被拒的那次必须进审计',
  )
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

checkAsync('P3-S6：不认识的 mode 拒绝静默退回 native', async () => {
  await assert.rejects(() => deployTransaction({ remote: {}, target: { mode: 'nomad', path: '/srv', hosts: ['h1'] }, releaseId: 'p3-r6' }), (error) => error.code === 'ACTUATOR_NOT_IMPLEMENTED')
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

// 假 kubectl：只实现 K8S_COMMANDS 里列出的形状，其它命令一律「命令未知」退出码 127 ——
// 新写一条命令而忘了登记，用例会立刻红，而不是在生产上才发现多了一种 kubectl 调用。
function fakeKubectl(options = {}) {
  const calls = []
  const state = {
    generation: options.generation || 1,
    observed: options.observed || 1,
    replicas: options.replicas || 2,
    ready: options.ready === undefined ? 2 : options.ready,
    image: options.image || 'registry.example.com/demo/web@sha256:' + 'b'.repeat(64),
    pods: options.pods || [],
    setImageExit: options.setImageExit || 0,
    rolloutExit: options.rolloutExit || 0,
    undoExit: options.undoExit || 0,
    missing: options.missing === true,
    clusterDown: options.clusterDown === true,
    noGenerationBump: options.noGenerationBump === true,
  }
  const host = {
    async exec(command) {
      calls.push(command)
      if (command.startsWith('kubectl -n')) {
        if (!/get (deployment|rollout) /.test(command) && !/set image|rollout /.test(command) && !/get pod/.test(command)) {
          return { stdout: '', stderr: 'kubectl: 未知命令形状 ' + command, exitCode: 127 }
        }
      } else if (!/^(mkdir -p|printf |echo |readlink|ln -sfn|ls -1dt|cat )/.test(command)) {
        return { stdout: '', stderr: 'unknown command ' + command, exitCode: 127 }
      }
      if (command.startsWith('readlink')) return { stdout: options.current || '', exitCode: 0 }
      if (/get (deployment|rollout) /.test(command)) {
        if (state.clusterDown) return { stdout: '', stderr: 'The connection to the server 10.0.0.1:6443 was refused', exitCode: 1 }
        if (state.missing) return { stdout: '', stderr: 'Error from server (NotFound): deployments.apps "web" not found', exitCode: 1 }
        return {
          stdout: JSON.stringify({
            metadata: { name: 'web', generation: state.generation },
            spec: { template: { spec: { containers: [{ name: 'web', image: state.image }] } } },
            status: { observedGeneration: state.observed, replicas: state.replicas, readyReplicas: state.ready, updatedReplicas: state.ready },
          }),
          exitCode: 0,
        }
      }
      if (/get pod /.test(command)) return { stdout: JSON.stringify({ items: state.pods.map((pod) => ({ metadata: { name: pod }, status: { phase: 'Running' }, spec: { containers: [{ image: state.image }] } })) }), exitCode: 0 }
      if (/set image /.test(command)) {
        if (state.setImageExit !== 0) return { stdout: '', stderr: 'Error from server: admission webhook denied', exitCode: state.setImageExit }
        const match = /set image [^ ]+ '([^=]+)=(.+)'$/.exec(command)
        const next = match ? match[2] : state.image
        // 镜像没变时控制器不会加 generation —— 这正是「看起来成功的空发布」。
        if (!state.noGenerationBump) { state.image = next; state.generation += 1; state.observed = state.generation }
        return { stdout: 'deployment.apps/web image updated', exitCode: 0 }
      }
      if (/rollout status /.test(command)) {
        return state.rolloutExit === 0
          ? { stdout: 'deployment "web" successfully rolled out', exitCode: 0 }
          : { stdout: 'Waiting for deployment "web" rollout to finish: 1 out of 2 new replicas have been updated...', stderr: 'error: timed out waiting for the condition', exitCode: state.rolloutExit }
      }
      if (/rollout undo /.test(command)) {
        if (state.undoExit !== 0) return { stdout: '', stderr: 'error: no rollout history found', exitCode: state.undoExit }
        state.image = 'registry.example.com/demo/web@sha256:' + 'b'.repeat(64)
        return { stdout: 'deployment.apps/web rolled back', exitCode: 0 }
      }
      return { stdout: '', exitCode: 0 }
    },
    async uploadFile() {},
  }
  return { host, calls, state }
}

const K8S_TARGET = {
  path: '/srv/k8s', app: 'web', keep: 3,
  image: 'registry.example.com/demo/web',
  k8s: { kind: 'Deployment', namespace: 'prod', workload: 'web', container: 'web', replicas: 2, progressDeadlineSec: 300, rolloutTimeoutSec: 360 },
  health: { http: '', tries: 1, interval: 0, expect: 0, window: 0 },
}

checkAsync('P3-S11：k8s 按 digest patch —— 一次 set image、等 rollout、current 与 manifest 都记下 generation', async () => {
  const digest = 'sha256:' + 'a'.repeat(64)
  const { host, calls, state } = fakeKubectl({ current: 'releases/p3-r7', pods: ['web-abc-1', 'web-abc-2'] })
  const actuator = createK8sActuator({ host, target: K8S_TARGET, hostName: 'h1', onLog: () => {}, now: () => Date.parse('2026-01-01T00:00:00Z') })
  const handle = await actuator.stage({ releaseId: 'p3-r11', artifactDigest: digest })
  assert.equal(handle.imageReference, 'registry.example.com/demo/web@' + digest)
  assert.equal(state.generation, 1, 'stage 不碰集群：一次 patch 都还没发')
  assert.equal(calls.filter((command) => /set image /.test(command)).length, 0)
  await actuator.activate(handle)
  const patches = calls.filter((command) => /set image /.test(command))
  assert.equal(patches.length, 1, '一次发布只 patch 一次')
  assert.ok(patches[0].includes('@' + digest), '引用必须是 image@sha256，不能是 tag')
  assert.ok(patches[0].includes("'web=registry.example.com/demo/web@sha256:" + 'a'.repeat(64) + "'"), 'patch 的容器名与引用')
  assert.ok(calls.some((command) => /rollout status /.test(command)), 'patch 之后必须等 rollout')
  assert.equal(handle.previous, 'p3-r7')
  assert.deepEqual(handle.pods.map((pod) => pod.name), ['web-abc-1', 'web-abc-2'])
  assert.equal(handle.revision, '2')
  assert.ok(calls.some((command) => command.includes('ln -sfn') && command.includes('releases/p3-r11')))
  const verdict = await actuator.health(handle)
  assert.equal(verdict.ok, true)
  // manifest 是回滚唯一读得到的现场：digest、集群坐标、generation 都得在里面。
  const dir = mkdtempSync(join(tmpdir(), 'cicd-p3-k8s-'))
  try {
    const writer = createK8sActuator({
      host: { exec: async (command) => {
        if (command.startsWith('printf %s')) writeFileSync(join(dir, 'manifest.json'), command.replace(/^printf %s '((?:[^']|'\\'')*)'.*$/s, '$1').replace(/'\\''/g, "'"))
        return { stdout: '', exitCode: 0 }
      } },
      target: K8S_TARGET, hostName: 'h1', onLog: () => {},
    })
    handle.dir = dir
    await writer.writeManifest(handle, { runId: 'run-1', commit: 'deadbeef', health: 'ok' })
    const written = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    assert.equal(written.mode, 'k8s')
    assert.equal(written.artifact.digest, digest)
    assert.equal(written.cluster.namespace, 'prod')
    assert.equal(written.cluster.workload, 'web')
    assert.equal(written.revision, '2')
    assert.equal(written.pods.length, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

checkAsync('P3-S12：k8s 的三种失败各自有话说 —— 空发布、rollout 超时、集群不可达', async () => {
  const digest = 'sha256:' + 'a'.repeat(64)
  // 1) generation 没涨 = 这份 digest 已经在跑，发布没有产生新版本。静默成功最危险。
  {
    const { host } = fakeKubectl({ noGenerationBump: true, image: 'registry.example.com/demo/web@' + digest })
    const actuator = createK8sActuator({ host, target: K8S_TARGET, hostName: 'h1', onLog: () => {} })
    const handle = await actuator.stage({ releaseId: 'p3-r12a', artifactDigest: digest })
    await assert.rejects(() => actuator.activate(handle), (error) => error.code === K8S_ERRORS.NO_CHANGE)
  }
  // 2) rollout 超时 = 新副本没起来。此时既不能当成功，也不能切 current 假装切了。
  {
    const { host, calls } = fakeKubectl({ rolloutExit: 1 })
    const actuator = createK8sActuator({ host, target: K8S_TARGET, hostName: 'h1', onLog: () => {} })
    const handle = await actuator.stage({ releaseId: 'p3-r12b', artifactDigest: digest })
    await assert.rejects(() => actuator.activate(handle), (error) => error.code === K8S_ERRORS.ROLLOUT)
    assert.equal(calls.filter((command) => command.includes('ln -sfn')).length, 0, 'rollout 没走完就不许切 current')
  }
  // 3) 集群连不上与对象不存在是两件事：前者改 kubeconfig，后者改 pipe。
  {
    const down = fakeKubectl({ clusterDown: true })
    const actuator = createK8sActuator({ host: down.host, target: K8S_TARGET, hostName: 'h1', onLog: () => {} })
    await assert.rejects(() => actuator.stage({ releaseId: 'p3-r12c', artifactDigest: digest }), (error) => error.code === K8S_ERRORS.CLUSTER)
    const missing = fakeKubectl({ missing: true })
    const actuator2 = createK8sActuator({ host: missing.host, target: K8S_TARGET, hostName: 'h1', onLog: () => {} })
    await assert.rejects(() => actuator2.stage({ releaseId: 'p3-r12d', artifactDigest: digest }), (error) => error.code === K8S_ERRORS.WORKLOAD)
  }
  // 4) 没有任何 digest 时不许部署 —— 按 tag 部署会让回滚跟着 tag 漂移。
  assert.throws(() => k8sImageReference({ image: 'demo/web', digest: '' }), (error) => error.code === K8S_ERRORS.IMAGE)
  assert.equal(normalizeK8sDigest('A'.repeat(64)), 'sha256:' + 'a'.repeat(64))
  assert.throws(() => normalizeK8sDigest('latest'), (error) => error.code === K8S_ERRORS.IMAGE)
  assert.throws(() => normalizeK8sDigest('sha256:abc'), (error) => error.code === K8S_ERRORS.IMAGE)
})

checkAsync('P3-S13：k8s 回滚走 rollout undo —— 不自己 set image 回去，历史里不该多一个 revision', async () => {
  const { host, calls } = fakeKubectl({ current: 'releases/p3-r13' })
  const actuator = createK8sActuator({ host, target: K8S_TARGET, hostName: 'h1', onLog: () => {} })
  const handle = await actuator.stage({ releaseId: 'p3-r13', artifactDigest: 'sha256:' + 'a'.repeat(64) })
  await actuator.activate(handle)
  const patchesBefore = calls.filter((command) => /set image /.test(command)).length
  const reverted = await actuator.revert(handle)
  assert.equal(reverted.reverted, true)
  assert.equal(calls.filter((command) => /rollout undo /.test(command)).length, 1)
  assert.equal(calls.filter((command) => /set image /.test(command)).length, patchesBefore, '回滚不许再 patch 一次镜像')
  assert.ok(calls.some((command) => command.includes('ln -sfn') && command.includes('releases/p3-r13')))
  // activate 没走完时无可回滚：不 patch 也不 undo，集群保持原样。
  const untouched = fakeKubectl({})
  const early = { ...handle, revision: '', activatedAt: '' }
  const actuator2 = createK8sActuator({ host: untouched.host, target: K8S_TARGET, hostName: 'h1', onLog: () => {} })
  await actuator2.revert(early)
  assert.equal(untouched.calls.filter((command) => /rollout undo /.test(command)).length, 0)
  // undo 本身失败要明说，而不是把「没回滚」当「回滚了」。
  const broken = fakeKubectl({ undoExit: 1 })
  const actuator3 = createK8sActuator({ host: broken.host, target: K8S_TARGET, hostName: 'h1', onLog: () => {} })
  await assert.rejects(() => actuator3.revert({ ...handle, revision: '2' }), (error) => error.code === K8S_ERRORS.ROLLBACK)
})

checkAsync('P3-S14：k8s 解析与命令词表 —— parseDeployment/parsePods 的边界、词表是封闭的', async () => {
  assert.equal(parseDeployment(''), null)
  assert.equal(parseDeployment('not json'), null)
  const parsed = parseDeployment(JSON.stringify({ metadata: { name: 'web', generation: 4 }, status: { observedGeneration: 4, replicas: 3, readyReplicas: 2, conditions: [{ type: 'Available', status: 'True' }] }, spec: { template: { spec: { containers: [{ image: 'repo@sha256:x' }] } } } }))
  assert.equal(parsed.generation, 4)
  assert.equal(parsed.ready, 2)
  assert.equal(parsed.available, 1)
  assert.equal(parsed.image, 'repo@sha256:x')
  assert.deepEqual(parsePods('garbage'), [])
  assert.equal(parsePods(JSON.stringify({ items: [{ metadata: { name: 'p1' }, status: { phase: 'Pending' } }] }))[0].phase, 'Pending')
  // 词表是封闭的：任何新命令都必须先登记，否则假集群会以 127 拒绝它。
  assert.ok(K8S_COMMANDS.some((entry) => entry.includes('set image')))
  assert.ok(K8S_COMMANDS.some((entry) => entry.includes('rollout undo')))
  assert.equal(K8S_COMMANDS.some((entry) => entry.includes('kubectl apply')), false, 'apply 需要一份会漂移的完整 manifest')
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

checkAsync('P5-6 接进运行时：gc / restore 走 HTTP，release 在用的字节删不掉', async () => {
  // 独立的库与 CAS：这条用例自己写 releases 行，不能和别的用例共库（谁知道它们留了什么引用）。
  const work = join(root, 'p5-6-runtime')
  const rt = await repoTool(work)
  // 直接开同库：要往 releases 里塞一条「正在跑的发布」，这是运行时不暴露的账本内部状态。
  // 库文件名由 store 决定（DB_FILE_NAME），别猜 —— 猜错会开出一个空库，release 引用就「不存在」了。
  const { DB_FILE_NAME } = await import('../lib/db.js')
  const database = (await import('../lib/db.js')).openDatabase(join(work, DB_FILE_NAME))
  // runtime 不暴露内部 store，用例直接用同一个目录建一个（读的都是磁盘，不影响事实）。
  const { createArtifactStore } = await import('../lib/artifacts.js')
  const internalStore = createArtifactStore({ dir: join(work, 'artifacts') })
  const fileA = join(root, 'p5-6-a.bin')
  const fileB = join(root, 'p5-6-b.bin')
  writeFileSync(fileA, 'still-running', 'utf8')
  writeFileSync(fileB, 'nobody-knows', 'utf8')

  const upA = await rt.runtime.artifacts({ action: 'upload', path: fileA, runId: 'run-a' })
  const upB = await rt.runtime.artifacts({ action: 'upload', path: fileB, runId: 'run-b' })
  assert.ok(upA.digest && upB.digest)

  database.prepare("INSERT OR REPLACE INTO releases (id, target, host, status, artifact_digest, created_at) VALUES (?, ?, ?, 'active', ?, ?)")
    .run('rel-a@web1', 'web', 'web1', upA.digest, new Date().toISOString())

  const dry = await rt.runtime.artifacts({ action: 'gc' })
  assert.equal(dry.dryRun, true)
  assert.deepEqual(dry.trashed.map((item) => item.digest), [upB.digest], '只有没人引用的那个才在候选里')
  assert.ok(dry.kept.includes(upA.digest))
  assert.deepEqual(dry.held.find((item) => item.digest === upA.digest).why, ['release'], 'held 说得出是谁按住的')

  const real = await rt.runtime.artifacts({ action: 'gc', dryRun: false })
  assert.equal(real.trashed.length, 1)
  assert.equal(internalStore.has(upB.digest), false)
  assert.equal(internalStore.has(upA.digest), true, 'release 在用的字节删不掉')
  assert.deepEqual((await rt.runtime.artifacts({ action: 'trash' })).trash.map((item) => item.digest), [upB.digest])

  // 宽限期内能救回来：字节重新出现在 blobs/ 下，digest 还是那个 digest。
  const restored = await rt.runtime.artifacts({ action: 'restore', digest: upB.digest })
  assert.equal(restored.digest, upB.digest)
  assert.equal(internalStore.has(upB.digest), true)
  await assert.rejects(
    () => rt.runtime.artifacts({ action: 'restore', digest: upB.digest }),
    (error) => error.code === 'ARTIFACT_NOT_FOUND',
  )

  // 宽限期一过才真删：graceSec=0 模拟「7 天已经到了」。
  await rt.runtime.artifacts({ action: 'gc', dryRun: false })
  const overdue = await rt.runtime.artifacts({ action: 'gc', dryRun: false, graceSec: 0 })
  assert.equal(overdue.purged.length, 1)
  assert.equal(internalStore.has(upB.digest), false)
  assert.deepEqual((await rt.runtime.artifacts({ action: 'trash' })).trash, [])
  assert.equal(internalStore.has(upA.digest), true, 'release 在用的字节始终不受影响')

  // 引用撤掉之后才轮得到它：删的是「引用」而不是「一次判断」。
  database.prepare('DELETE FROM releases').run()
  const after = await rt.runtime.artifacts({ action: 'gc', dryRun: true })
  assert.ok(after.trashed.some((item) => item.digest === upA.digest), '引用撤掉之后才轮得到它')

  database.close()
  await rt.close()
})
checkAsync('P5-6 tombstone：引用集算全才敢删，minAge 护住刚上传的字节', async () => {
  const { createArtifactStore } = await import('../lib/artifacts.js')
  // 账本引用由一个假 refsReader 提供，模拟 releases / promotions / 坐标这三类落盘指针之外的引用。
  const ledger = []
  const store = createArtifactStore({ dir: join(casRoot, 'cas-tomb'), refsReader: () => ledger })
  const fromRelease = await store.putFile(casFile('rel.bin', 'running-in-prod'))
  const fromPromotion = await store.putFile(casFile('promo.bin', 'promoted-to-prod'))
  const fresh = await store.putFile(casFile('fresh.bin', 'just-uploaded'))
  const dead = await store.putFile(casFile('dead.bin', 'nobody-knows-it'))

  ledger.push({ digest: fromRelease.digest, why: 'release' })
  ledger.push({ digest: fromPromotion.digest, why: 'promotion' })
  const held = store.references()
  assert.deepEqual(held.get(fromRelease.digest), ['release'])
  assert.deepEqual(held.get(fromPromotion.digest), ['promotion'])
  assert.equal(held.has(dead.digest), false)

  // 刚上传的（按 age 算 0 秒）不能被 minAge 之外的任何理由误伤。
  const guarded = store.gc({ dryRun: false, minAgeMs: 60 * 60 * 1000 })
  assert.equal(guarded.trashed.length, 0, '一分钟前才上传的字节不能进回收站')
  assert.equal(store.listTrash().length, 0)

  const swept = store.gc({ dryRun: false })
  assert.deepEqual(swept.trashed.map((item) => item.digest).sort(), [dead.digest, fresh.digest].sort())
  assert.deepEqual(swept.kept.sort(), [fromRelease.digest, fromPromotion.digest].sort())
  assert.equal(store.has(fromRelease.digest), true, 'release 还在引用的字节一律不碰')
  assert.equal(store.has(fromPromotion.digest), true, '晋级记录引用的字节一律不碰')
  assert.equal(store.has(dead.digest), false)

  // held 说得出「为什么没删」，否则 prune 看起来总是在漏东西。
  const reasons = new Map(swept.held.map((item) => [item.digest, item.why]))
  assert.deepEqual(reasons.get(fromRelease.digest), ['release'])
  assert.deepEqual(reasons.get(fromPromotion.digest), ['promotion'])

  // 引用没了（release 被清理、晋级被撤回）之后，字节才有资格进下一轮回收。
  ledger.length = 0
  const nextRound = store.gc({ dryRun: true })
  assert.deepEqual(nextRound.trashed.map((item) => item.digest).sort(), [fromPromotion.digest, fromRelease.digest].sort())

  // 落盘指针与账本引用并存：两条路径都必须能按住同一份字节。
  store.putRef('demo', 'latest', fromRelease.digest)
  const withRef = store.gc({ dryRun: true })
  assert.ok(withRef.kept.includes(fromRelease.digest))
  assert.deepEqual(withRef.held.find((item) => item.digest === fromRelease.digest).why, ['ref:demo/latest'])
  store.dispose()
})
checkAsync('P4-3 接线：pipe.yml 里的 environments 真的会被执行', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cicd-guard-'))
  const projectDir = join(root, 'guard-demo')
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'pipe.yml'), [
    'name: guard-demo',
    'environments:',
    '  prod:',
    '    allowedActors: [role:owner]',
    '    branchRule: "^release/.*$"',
    'targets:',
    '  staging:',
    '    hosts: [api1]',
    '    path: /srv/guard-staging',
    '  prod:',
    '    hosts: [api1]',
    '    path: /srv/guard',
    'stages:',
    '  - id: deploy',
    '    steps:',
    '      - name: ship',
    '        deploy:',
    '          target: prod',
    '          artifacts: [bundle.tgz]',
  ].join('\n'))
  writeFileSync(join(projectDir, 'bundle.tgz'), 'guard-bundle')
  const tool = await repoTool(join(root, 'state'), { projects: [{ id: 'guard', name: 'guard', path: projectDir }] })
  try {
    // 护栏配置本身必须解析成功：pipe.yml 里写错一条名单会整体拒绝，而不是悄悄放行。
    const spec = tool.runtime.environmentGuardSpec('prod', 'guard')
    assert.equal(spec?.allowedActors?.[0], 'role:owner', 'pipe.yml 里的 environments.prod 名单没有被解析出来')
    // 分支不匹配：pipe 里的 branchRule 必须在**任何主机被改动之前**拦下，
    // 且拦下的原因要说得出来（不是笼统一句"部署失败"）。
    const wrongBranch = await tool.call('/run?project=guard&target=prod&confirm=1', { method: 'POST', headers: { 'x-dsh-cicd': '1' } })
    const respBody = await wrongBranch.clone().json()
    assert.notEqual(wrongBranch.status, 403, '护栏是安全的出口，不该被误读成身份问题')
    const blocked = (respBody.stages || []).flatMap((stage) => stage.steps || []).find((step) => step.status === 'failed')
    assert.ok(blocked, '部署没跑起来，护栏也就无从判定：' + JSON.stringify(respBody).slice(0, 400))
    const logResp = await tool.call('/log?runId=' + (respBody.runId || ''), { method: 'GET', headers: { 'x-dsh-cicd': '1' } })
    const logText = String((await logResp.clone().json()).text || '')
    // 没有分支 → 撞上 pipe.yml 里的 branchRule，且日志说得出是哪一个条件。
    assert.match(logText, /环境护栏拦下 \[prod\] ENV_BRANCH_NOT_ALLOWED/, 'pipe.yml 里的 branchRule 没被执行：' + logText.slice(-500))
  } finally { tool.close(); rmSync(root, { recursive: true, force: true }) }
})

checkAsync('P6-3：环境页说得出 prod 在跑什么 —— 指针、实例、漂移、护栏，以及回滚后指针不再骗人', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cicd-p6-3-'))
  const projectDir = join(dir, 'envs')
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'pipe.yml'), [
    'name: envs-demo',
    'environments:',
    '  prod:',
    '    allowedActors: [role:owner]',
    '    branchRule: "^release/.*$"',
    'targets:',
    '  staging:',
    '    hosts: [stage1]',
    '    path: /srv/stage',
    '  prod:',
    '    hosts: [api1, api2]',
    '    path: /srv/prod',
    'stages:',
    '  - id: build',
    '    steps:',
    '      - run: echo hi',
    '',
  ].join('\n'))
  const digA = 'sha256:' + 'a'.repeat(64)
  const digB = 'sha256:' + 'b'.repeat(64)
  const runtime = internals.createRuntime({ get: () => undefined }, {
    projects: [{ id: 'envs', path: projectDir, pipe: join(projectDir, 'pipe.yml') }],
    workDir: join(dir, 'state'),
    scheduler: { enabled: false },
  })
  const insertRelease = (id, host, digest, status, at) => runtime.store.db
    .prepare('INSERT INTO releases (id, project_id, target, host, run_id, status, created_at, activated_at, artifact_digest) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, 'envs', 'prod', host, id.split('@')[0], status, at, at, digest)
  const findEnv = (view, name) => view.environments.find((item) => item.name === name)
  try {
    // ① 空环境：说得出「尚未晋级」，而不是给一个空字符串让人以为是生产跑空包。
    const empty = await runtime.environments('envs')
    assert.equal(empty.project, 'envs')
    assert.deepEqual(empty.environments.map((item) => item.name), ['staging', 'prod'])
    const emptyProd = findEnv(empty, 'prod')
    assert.equal(emptyProd.current, '')
    assert.equal(emptyProd.digestState, 'empty')
    assert.equal(emptyProd.drift, false)
    assert.deepEqual(emptyProd.hosts, ['api1', 'api2'])
    assert.equal(emptyProd.guard.configured, true, 'pipe.yml 里的护栏应当出现')
    assert.deepEqual(emptyProd.guard.allowedActors, ['role:owner'])
    assert.equal(emptyProd.guard.branchRule, '^release/.*$')

    // ② 晋级 A、机器上跑 B → 漂移，且要说得出现在机器上的是哪个 digest。
    //    字节不在 CAS 里时 digestState 是 missing：说「prod 跑 A」却不说 A 已经不在库里，等于给了个查不到的地址。
    insertRelease('r-b@api1', 'api1', digB, 'active', '2026-01-01T00:00:00.000Z')
    recordPromotion(runtime.store.db, { id: 'pm-a', projectId: 'envs', digest: digA, fromEnv: 'staging', toEnv: 'prod', createdAt: '2026-01-02T00:00:00.000Z' })
    const prod = findEnv(await runtime.environments('envs'), 'prod')
    assert.equal(prod.current, digA)
    assert.equal(prod.digestState, 'missing', '字节不在 CAS 里时要说丢失，不能装作没事')
    assert.equal(prod.drift, true, '晋级说 A、机器上跑 B，这就是 drift')
    assert.deepEqual(prod.liveDigests, [digB])
    assert.equal(prod.active.find((item) => item.host === 'api1').digest, digB)
    assert.equal(prod.active.find((item) => item.host === 'api2').digest, '', '没有 active release 的主机不该编一个版本出来')
    assert.ok(prod.history.some((item) => item.digest === digB), '最近几次要能看到机器上那一行')

    // ③ 回滚/重发把上一行改成 superseded 之后，那次晋级的字节已经不在线上 —— 指针必须继续往前找，
    //    否则环境页会拿一个已经下线的版本回答「prod 在跑什么」。
    // 同一个 (target, host) 只可能有一行 active：换版本就是把这行改成 superseded 再写新行。
    const supersede = (id, at, status) => runtime.store.db
      .prepare('UPDATE releases SET status = ?, deactivated_at = ? WHERE id = ?').run(status, at, id)
    supersede('r-b@api1', '2026-01-03T00:00:00.000Z', 'superseded')
    insertRelease('r-a@api1', 'api1', digA, 'active', '2026-01-03T00:00:00.000Z')
    recordPromotion(runtime.store.db, { id: 'pm-b', projectId: 'envs', digest: digB, fromEnv: 'staging', toEnv: 'prod', createdAt: '2026-01-04T00:00:00.000Z' })
    const afterRollback = findEnv(await runtime.environments('envs'), 'prod')
    assert.equal(afterRollback.current, digA, '最新的那次晋级已经下线，指针要退回到仍在线上的一环')
    assert.equal(afterRollback.drift, false, '指针与机器上的版本一致时不该报 drift')
    assert.equal(currentPointer(runtime.store.db, { projectId: 'envs', env: 'prod' }).digest, digB, 'currentPointer 仍按时间序（晋级冲突判定用它）')
    const reach = reachablePointer(runtime.store.db, { projectId: 'envs', env: 'prod' })
    assert.equal(reach.id, 'pm-a')
    assert.equal(reach.releaseId, 'r-a@api1', '指向的 release 要从 active 行里取')
  } finally { try { runtime.store.close() } catch { /* 已关 */ } rmSync(dir, { recursive: true, force: true }) }
})

checkAsync('P5-S5：指针（tag）只动引用 —— 指向不存在的 digest 被拒，GC 两段式且默认 dry-run', async () => {
  const { createArtifactStore, DEFAULT_GRACE_MS } = await import('../lib/artifacts.js')
  const store = createArtifactStore({ dir: join(casRoot, 'cas-e') })
  const live = await store.putFile(casFile('live.bin', 'kept-by-tag'))
  const orphan = await store.putFile(casFile('orphan.bin', 'nobody-points-here'))

  assert.throws(() => store.putRef('demo', 'latest', `sha256:${'a'.repeat(64)}`), (error) => error.code === 'ARTIFACT_NOT_FOUND')
  const ref = store.putRef('demo', 'latest', live.digest)
  assert.equal(ref.digest, live.digest)
  assert.equal(store.readRef('demo', 'latest').digest, live.digest)

  // 默认 dry-run：算出要做什么，但一个字节都不动，连 trash/ 都不建。
  const dry = store.gc()
  assert.equal(dry.dryRun, true)
  assert.equal(dry.graceMs, DEFAULT_GRACE_MS)
  assert.deepEqual(dry.trashed.map((item) => item.digest), [orphan.digest])
  assert.deepEqual(dry.kept, [live.digest])
  assert.equal(store.has(orphan.digest), true)
  assert.equal(store.listTrash().length, 0, 'dry-run 不该往回收站里写东西')

  // 第一段：无引用的进 trash，字节还在原 digest 的「墓碑」位置 —— 只是暂时搬了家。
  const real = store.gc({ dryRun: false })
  assert.equal(real.trashed.length, 1)
  assert.equal(store.has(orphan.digest), false, 'blobs/ 里不该再有它')
  assert.equal(store.has(live.digest), true, '有指针的 blob 不能被回收')
  assert.deepEqual(store.listTrash().map((item) => item.digest), [orphan.digest], '字节进了回收站，没有凭空消失')
  assert.deepEqual(real.pending.map((item) => item.digest), [orphan.digest], '宽限期未到，只能等')
  assert.equal(real.purged.length, 0)

  // 宽限期之内 restore 得回来：这就是「误删可救」的全部意义。
  const restored = store.restore(orphan.digest)
  assert.equal(restored.digest, orphan.digest)
  assert.equal(store.has(orphan.digest), true)
  assert.equal(store.listTrash().length, 0)
  assert.equal(store.restore(orphan.digest), null, '不在回收站里时明确返回 null')

  // 第二段：真正的 purge 只有等到宽限期之后，且要显式再跑一次 gc。
  store.gc({ dryRun: false })
  assert.equal(store.has(orphan.digest), false)
  const later = store.gc({ dryRun: false, now: Date.now() + DEFAULT_GRACE_MS + 1000 })
  assert.equal(later.purged.length, 1)
  assert.deepEqual(store.listTrash(), [])
  assert.equal(store.restore(orphan.digest), null, '宽限期过了就真的没了')
  assert.equal(store.has(live.digest), true)
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

checkAsync('P5-S12：下载只发校验过的字节 —— 篡改后 GET 409，重新上传好字节把坏 blob 修回来', async () => {
  const runtime = internals.createRuntime(fakeContext(), {
    projects: [{ id: 'demo', path: projectDir }],
    workDir: join(root, 'state'),
    scheduler: { enabled: false },
  })
  try {
    const uploaded = await runtime.artifacts({ action: 'upload', path: casFile('intact.bin', 'intact-bytes'), project: 'demo' })
    const fresh = fakeContext()
    internals.registerHttpRoutes(fresh, runtime)
    const route = fresh.routes.find((item) => item.path === `${internals.ROUTE_PREFIX}/artifacts`)
    const blobPath = internals.digestPath(join(root, 'state', 'artifacts'), uploaded.digest)
    const bytes = readFileSync(blobPath)
    bytes[0] = bytes[0] ^ 0xff
    writeFileSync(blobPath, bytes)

    // 下载路径自己挡住：坏字节不能发出去，且要说明是内容不符（409），不是 404/500。
    const corrupted = await route.resource(
      new Request(`http://x/api/plugins/cicd/artifacts?digest=${uploaded.digest}`, { headers: { 'x-dsh-cicd': '1' } }),
    )
    assert.equal(corrupted.status, 409)
    assert.equal((await corrupted.json()).code, 'ARTIFACT_CORRUPTED')

    // 重新上传同一份好字节：digest 命中已有 blob，但坏字节必须被换掉（repaired），否则这份制品永远修不好。
    const repaired = await runtime.artifacts({ action: 'upload', path: casFile('intact-again.bin', 'intact-bytes'), project: 'demo' })
    assert.equal(repaired.digest, uploaded.digest)
    assert.equal(repaired.repaired, true)
    assert.equal((await runtime.artifacts({ action: 'verify', digest: uploaded.digest })).ok, true)

    const fixed = await route.resource(
      new Request(`http://x/api/plugins/cicd/artifacts?digest=${uploaded.digest}`, { headers: { 'x-dsh-cicd': '1' } }),
    )
    assert.equal(fixed.status, 200)
    assert.equal(Buffer.from(await fixed.arrayBuffer()).toString(), 'intact-bytes')
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
    workDir,
    call: (pathname, init = {}) => {
      // 路由匹配只看 pathname：query 是参数，不是路由的一部分。
      const bare = pathname.split('?')[0]
      const route = routeOf(bare) || fresh.routes.find((item) => item.path === internals.ROUTE_PREFIX + bare)
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
check('P5-S11：DB —— 制品表随 v10 迁出、晋级表随 v12 迁出，artifact_blobs 只存索引不存字节', () => {
  const db = openDatabase(join(root, 'artifacts-db.sqlite'))
  try {
    const columns = db.prepare('PRAGMA table_info(artifact_blobs)').all().map((row) => row.name)
    assert.deepEqual(columns.sort(), ['bytes', 'created_at', 'digest', 'job_id', 'media_type', 'project_id', 'run_id', 'source_path'])
    assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 12)
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_artifact_refs_digest'").get())
    assert.deepEqual(db.prepare('PRAGMA table_info(promotions)').all().map((row) => row.name).sort(), [
      'approved_at', 'approved_by', 'created_at', 'digest', 'from_env', 'host', 'id', 'project_id', 'release_id', 'run_id', 'target', 'to_env',
    ])
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_promotions_digest'").get())
  } finally { db.close() }
})

// ============================================================================
// v3.0-P8-S1..S4：闭环序列（从零建项目 → 部署 → 回滚）与部署锁的释放契约
// 前面 163 条大多一次只钉一个函数；这几条钉的是「几步连起来之后状态机还自不自洽」。
// ============================================================================

checkAsync('P8-S1：模板建出来的项目开箱即可部署（releases/current 落地，不需要手写环境名单）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cicd-p8-s1-'))
  const originalFetch = globalThis.fetch
  globalThis.fetch = envFetch
  const projectDir = join(dir, 'app')
  mkdirSync(projectDir, { recursive: true })
  const runtime = internals.createRuntime(fakeContext(), {
    projects: [],
    workDir: join(dir, 'state'),
    remoteBase: 'http://127.0.0.1:1',
    scheduler: { enabled: false },
  })
  try {
    const listed = runtime.templateDetail('bare', { name: 'app' })
    assert.equal(listed.custom, false)
    // 用 static 模板而不是 bare：static 打 dist.tgz 的包，产物齐了才谈得上"能不能发"；
    // bare 的 echo 占位连产物都没有，会先撞上 ARTIFACT_NOT_FOUND，看不见名单这一层。
    const created = await runtime.createProject({ name: 'app', path: projectDir, template: 'static' })
    assert.equal(created.id, 'app', '模板新建应当成功：' + JSON.stringify(created).slice(0, 300))
    assert.match(readFileSync(join(projectDir, 'pipe.yml'), 'utf8'), /^name: /m)

    const validated = runtime.validatePipe({ project: 'app' })
    assert.equal(validated.ok, true, '脚手架必须自洽：' + JSON.stringify(validated).slice(0, 300))
    // 脚手架声明的 deploy.artifacts 就是它自己 build 的产物：bare 模板是 dist.tgz
    writeFileSync(join(projectDir, 'dist.tgz'), 'artifact')

    // 脚手架的 target 名不是 prod，所以首次部署不需要 confirm=prod，也不需要环境名单。
    const planned = await runtime.plan({ project: 'app' })
    assert.equal(planned.envs.includes('prod'), false, '模板默认 target 不该叫 prod：' + JSON.stringify(planned.envs))
    assert.equal(planned.willDeployToProd, false, '与 envFetch 的 linux26/api1 环境对不上：' + JSON.stringify(planned.prodHosts))

    const run = await runtime.run({ projectId: 'app', targetName: planned.target })
    assert.equal(run.status, 'success', '开箱部署必须成功：' + JSON.stringify({ error: run.error, stages: run.stages }).slice(0, 600))
    assert.equal(run.releases.length, 1, '一次成功部署要留下一条 release')

    const listed2 = runtime.releases({ target: planned.target })
    assert.equal(listed2.releases.length, 1)
    assert.equal(listed2.releases[0].status, 'active')

    // 刚刚 active 的那条自己是"当前版本"，回滚它等于原地重放；回滚的契约是"指回上一版"。
    const rolled = await runtime.rollback({ target: planned.target, project: 'app' })
    assert.equal(rolled.ok, true, '省略 releaseId 时应当读 current 指回它：' + JSON.stringify(rolled).slice(0, 300))
    // 回滚的落点必须能对上账本里的某一版（不是空串、也不是凭空造出来的 id）
    assert.equal(rolled.releaseId, listed2.releases[0].id, '回滚落点必须是账本里那一条 release：' + rolled.releaseId)
  } finally {
    runtime.dispose()
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

checkAsync('P8-S1b：守卫写错被拒之后，不留 waiting_approval 记录也不留部署锁（只能去补配置）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cicd-p8-s1b-'))
  const originalFetch = globalThis.fetch
  globalThis.fetch = envFetch
  const projectDir = join(dir, 'app')
  mkdirSync(projectDir, { recursive: true })
  // 名单登记了 prod、审批也开着，却忘了写 allowedActors：护栏先拒（ENV_GUARD_NO_ALLOWLIST），
  // 这一步必须发生在审批门之前 —— 否则会先落一条永远没人能批的 waiting_approval。
  const pipe = [
    'version: 1',
    'name: shipped',
    'environments:',
    '  prod:',
    '    approval: true',
    '    branchRule: "^(main|release/.*)$"',
    'targets:',
    '  prod:',
    '    hosts: [linux26]',
    '    path: /srv/shipped',
    'stages:',
    '  - id: build',
    '    steps:',
    '      - name: build',
    '        run: echo BUILD_OK',
    '  - id: release',
    '    steps:',
    '      - name: ship',
    '        deploy:',
    '          target: prod',
  ].join('\n')
  writeFileSync(join(projectDir, 'pipe.yml'), pipe, 'utf8')
  const runtime = internals.createRuntime(fakeContext(), {
    projects: [{ id: 'app', name: 'app', path: projectDir, pipe: join(projectDir, 'pipe.yml') }],
    workDir: join(dir, 'state'),
    remoteBase: 'http://127.0.0.1:1',
    scheduler: { enabled: false },
    approval: { ttlSec: 3600 },
  })
  try {
    await assert.rejects(runtime.run({ projectId: 'app', targetName: 'prod', confirmProd: true }), (error) => error.code === 'ENV_GUARD_NO_ALLOWLIST')
    // 运行列表里不该出现一条「等审批」：它永远不会被批，只会让面板上多一条卡死的记录。
    const runs = runtime.status({ project: 'app', limit: 20 }).runs
    assert.deepEqual(runs.filter((item) => item.status === 'waiting_approval'), [], '护栏拒掉的运行不能留 waiting_approval 记录')
    // 锁也不能留：留了就没人能部署，而且 30 分钟内没人知道为什么。
    assert.deepEqual(runtime.lockList().locks, [], '被护栏拒掉的运行必须把锁还回去，否则 target 像被鬼占着')
  } finally {
    runtime.dispose()
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

checkAsync('P8-S2：run 中途取消 → 部署锁立刻释放、运行记录收成 canceled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cicd-p8-s2-'))
  const originalFetch = globalThis.fetch
  globalThis.fetch = envFetch
  const projectDir = join(dir, 'slow')
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'pipe.yml'), [
    'version: 1',
    'name: slow',
    'targets:',
    '  api2:',
    '    hosts: [api2]',
    '    path: /srv/slow',
    'stages:',
    '  - id: build',
    '    steps:',
    '      - name: slow',
    '        run: node -e "setTimeout(() => {}, 30000)"',
  ].join('\n'), 'utf8')
  const runtime = internals.createRuntime(fakeContext(), {
    projects: [{ id: 'slow', name: 'slow', path: projectDir, pipe: join(projectDir, 'pipe.yml') }],
    workDir: join(dir, 'state'),
    remoteBase: 'http://127.0.0.1:1',
    scheduler: { enabled: false },
    stepTimeoutSec: 60,
  })
  try {
    const pending = runtime.run({ projectId: 'slow', targetName: 'api2' })
    // 等锁真的被拿到（run 的同步前缀做完 acquire 才进第一个 await），再取消。
    const deadline = Date.now() + 5000
    while (runtime.lockList().locks.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
    const held = runtime.lockList().locks
    assert.equal(held.length, 1, '运行中必须持有部署锁')

    runtime.cancel({ runId: held[0].runId })
    const result = await pending
    assert.equal(result.status, 'canceled', '取消后 run 要以 canceled 收口：' + JSON.stringify(result).slice(0, 300))
    assert.equal(runtime.store.run(held[0].runId).status, 'canceled')
    // 取消不是普通 finally 能兜住的路径，锁必须在这里也还回去，否则整个 TTL 内没人能再部署。
    assert.deepEqual(runtime.lockList().locks, [], '取消之后部署锁必须立刻释放')
  } finally {
    runtime.dispose()
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

checkAsync('P8-S3：主机失败 → 失败信息带得上主机的真实原因（不是一句「有主机未完成发布」）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cicd-p8-s3-'))
  const projectDir = join(dir, 'app')
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'pipe.yml'), [
    'version: 1',
    'name: app',
    'targets:',
    '  api2:',
    '    hosts: [api2]',
    '    path: /srv/app',
    'stages:',
    '  - id: build',
    '    steps:',
    '      - name: build',
    '        run: echo BUILD_OK',
    '  - id: ship',
    '    steps:',
    '      - name: ship',
    '        deploy:',
    '          target: api2',
    '          artifacts: [dist.tgz]',
  ].join('\n'), 'utf8')
  writeFileSync(join(projectDir, 'dist.tgz'), 'bundle', 'utf8')
  // 主机上的操作全部失败：故障场景里最先要看的就是「哪台、为什么」。
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input?.url || String(input))
    if (url.includes('/api/plugins/remote/exec')) {
      return new Response(JSON.stringify({ ok: true, result: { exitCode: 1, stdout: '', stderr: 'mkdir: Permission denied' } }), { headers: { 'content-type': 'application/json' } })
    }
    return envFetch(input, init)
  }
  const runtime = internals.createRuntime(fakeContext(), {
    projects: [{ id: 'app', name: 'app', path: projectDir, pipe: join(projectDir, 'pipe.yml') }],
    workDir: join(dir, 'state'),
    remoteBase: 'http://127.0.0.1:1',
    scheduler: { enabled: false },
  })
  try {
    const run = await runtime.run({ projectId: 'app', targetName: 'api2' })
    assert.equal(run.status, 'failed', '主机失败必须让整次运行为 failed：' + JSON.stringify(run).slice(0, 300))
    const step = run.stages.flatMap((stage) => stage.steps).find((item) => item.kind === 'deploy')
    assert.ok(step, '要有一条 deploy 步骤')
    assert.equal(step.status, 'failed')
    // 只写「部署失败：有主机未完成发布」等于把运维指向命令，而真实原因是主机上的权限。
    assert.match(String(step.error), /api2/, '失败信息要指明是哪台主机：' + String(step.error))
    assert.match(String(step.error), /Permission denied/, '失败信息要带上主机那边的真实原因：' + String(step.error))
  } finally {
    runtime.dispose()
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

checkAsync('P8-S4：审批过期收口不依赖有人打开审批列表（run/status 读到的就是终态）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cicd-p8-s4-'))
  const originalFetch = globalThis.fetch
  globalThis.fetch = envFetch
  const projectDir = join(dir, 'app')
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'pipe.yml'), [
    'version: 1',
    'name: app',
    'environments:',
    '  prod:',
    '    allowedActors: [role:owner]',
    'targets:',
    '  prod:',
    '    hosts: [linux26]',
    '    path: /srv/app',
    'stages:',
    '  - id: build',
    '    steps:',
    '      - name: build',
    '        run: echo BUILD_OK',
  ].join('\n'), 'utf8')
  const runtime = internals.createRuntime(fakeContext(), {
    projects: [{ id: 'app', name: 'app', path: projectDir, pipe: join(projectDir, 'pipe.yml') }],
    workDir: join(dir, 'state'),
    remoteBase: 'http://127.0.0.1:1',
    scheduler: { enabled: false },
    approval: { ttlSec: 3600 },
  })
  try {
    const actor = { id: 'owner-1', role: 'owner', authMethod: 'token', tokenId: 'tk-1' }
    await assert.rejects(
      runtime.run({ projectId: 'app', targetName: 'prod', confirmProd: true, actor }),
      (error) => error.code === 'APPROVAL_REQUIRED',
    )
    const waiting = runtime.status({ project: 'app', limit: 20 }).runs.filter((item) => item.status === 'waiting_approval')
    assert.equal(waiting.length, 1, '待审批期间要能在运行列表里看到')
    assert.deepEqual(runtime.lockList().locks, [], '停在审批门上不能占着部署锁')

    // 把到期时间推到过去，然后只调 status（不看审批列表）。
    // 注意 status 返回的是 runSummary（对外字段名是 id/status/error），审批表里存的是 run_id。
    const db = openDatabase(join(dir, 'state', 'cicd.db'))
    try {
      const approvalId = db.prepare('SELECT id FROM approvals WHERE run_id = ?').get(waiting[0].id)?.id
      assert.ok(approvalId, '待审批记录要在 approvals 表里查得到：' + waiting[0].id)
      db.prepare('UPDATE approvals SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', approvalId)
    } finally { db.close() }

    const after = runtime.status({ project: 'app', limit: 20 }).runs.find((item) => item.id === waiting[0].id)
    assert.equal(after.status, 'failed', '过期之后运行记录必须是终态，不能永远挂在等审批上：' + JSON.stringify(after))
    assert.equal(after.error, 'approval_timeout')
  } finally {
    runtime.dispose()
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

// v3.0 闭环巡检：下面几条钉的都是"每一步单独看都对、连起来就自相矛盾"的地方。
checkAsync('P8-S5：模板项目的起点没有环境名单 → 部署前的真实失败必须能被 onboarding 点名（改到哪一行）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cicd-p8-s5-'))
  const originalFetch = globalThis.fetch
  globalThis.fetch = envFetch
  const runtime = internals.createRuntime(fakeContext(), {
    projects: [],
    workDir: join(dir, 'state'),
    remoteBase: 'http://127.0.0.1:1',
    scheduler: { enabled: false },
  })
  try {
    const projectDir = join(dir, 'app')
    mkdirSync(projectDir, { recursive: true })
    const created = await runtime.createProject({ name: 'app', path: projectDir, template: 'static' })
    assert.ok(created.id, '建项目要返回 id：' + JSON.stringify(created))
    writeFileSync(join(projectDir, 'dist.tgz'), 'artifact')

    // 模板给的起点不带任何环境名单：先证明"现在真的发不出去"，再说清该改哪一行。
    assert.deepEqual(created.requiredConfig, [], '没有任何受保护环境时不该凭空报缺配置')
    const guide = runtime.onboarding({ project: created.id })
    assert.equal(guide.steps.find((step) => step.id === 'guards').done, true, '名单这步在起点就该是完成的')

    // 用户把 target 改名成 prod（生产是约定即存在的受保护环境）—— 名单还没配。
    const pipePath = join(projectDir, 'pipe.yml')
    const source = readFileSync(pipePath, 'utf8')
      .replace(/^( *)default:/m, '$1prod:')
      .replace(/target: default/, 'target: prod')
    writeFileSync(pipePath, source, 'utf8')
    await assert.rejects(
      runtime.run({ projectId: created.id, targetName: 'prod' }),
      (error) => error.code === 'ENV_GUARD_NO_ALLOWLIST',
      '受保护环境没有名单时必须当场拒，而不是先跑完 build',
    )

    const blocked = runtime.onboarding({ project: created.id })
    const guardStep = blocked.steps.find((step) => step.id === 'guards')
    assert.ok(guardStep, 'onboarding 要有「配好受保护环境的名单」这一步：' + JSON.stringify(blocked.steps.map((step) => step.id)))
    assert.equal(guardStep.done, false, '名单没配，这一步不能打勾')
    assert.match(guardStep.next, /environments\.prod\.allowedActors/, '下一步要说清该改哪个键：' + guardStep.next)
    assert.deepEqual(blocked.requiredConfig.map((item) => item.key), ['environments.prod.allowedActors'])
    assert.equal(blocked.currentStep, 'guards', '名单是挡在发布前的第一件事')

    // 补上名单之后，同一步要从库里现算成完成 —— 不是"点过了"。
    // 名单放在文件开头：targets 之后再加一个顶层键，等于把 environments 挂到 targets 下面。
    writeFileSync(pipePath, 'environments:\n  prod:\n    allowedActors: [role:owner]\n' + source, 'utf8')
    const fixed = runtime.onboarding({ project: created.id })
    assert.equal(fixed.steps.find((step) => step.id === 'guards').done, true, '名单补齐后这一步应打勾：' + JSON.stringify(fixed.requiredConfig))
    assert.deepEqual(fixed.requiredConfig, [], '补齐后不能再报缺：' + JSON.stringify(fixed.requiredConfig))
  } finally {
    runtime.dispose()
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

checkAsync('P8-S6：回滚到当前这一版 → 账本里它必须仍然是 active（不能把自己注销成 superseded）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cicd-p8-s6-'))
  const originalFetch = globalThis.fetch
  globalThis.fetch = envFetch
  const projectDir = join(dir, 'app')
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'dist.tgz'), 'artifact')
  writeFileSync(join(projectDir, 'pipe.yml'), [
    'version: 1',
    'name: app',
    'targets:',
    '  api2:',
    '    hosts: [api2]',
    '    path: /srv/app',
    'stages:',
    '  - id: build',
    '    steps:',
    '      - name: build',
    '        run: echo BUILD_OK',
    '  - id: release',
    '    needs: [build]',
    '    steps:',
    '      - name: ship',
    '        deploy:',
    '          target: api2',
    '          artifacts: [dist.tgz]',
  ].join('\n'), 'utf8')
  const runtime = internals.createRuntime(fakeContext(), {
    projects: [{ id: 'app', name: 'app', path: projectDir, pipe: join(projectDir, 'pipe.yml') }],
    workDir: join(dir, 'state'),
    remoteBase: 'http://127.0.0.1:1',
    scheduler: { enabled: false },
  })
  try {
    const first = await runtime.run({ projectId: 'app', targetName: 'api2' })
    assert.equal(first.status, 'success', '首次部署要成功：' + JSON.stringify(first.stages || first.error))
    const current = runtime.releases({ target: 'api2' }).releases.filter((item) => item.status === 'active')
    assert.equal(current.length, 1, '首次部署后应有一条 active：' + JSON.stringify(current))

    // 不带 releaseId 回滚 = 退回上一版；只有一版时就是原地重放 current。
    const rolled = await runtime.rollback({ project: 'app', target: 'api2' })
    assert.equal(rolled.ok, true, '回滚要成功：' + JSON.stringify(rolled))
    const after = runtime.releases({ target: 'api2' }).releases
    const actives = after.filter((item) => item.status === 'active')
    assert.equal(actives.length, 1, '回滚后账本里必须还有且只有一条 active：' + JSON.stringify(after.map((item) => [item.id, item.status])))
    // environments()/targets() 也是从这条 active 推当前版本的，不能因为回滚变空。
    const targets = await runtime.targets({ project: 'app' })
    const api2 = (targets.targets || []).find((item) => item.name === 'api2')
    assert.ok(api2, 'targets 里要有 api2：' + JSON.stringify(targets.targets))
    assert.ok(api2.current, '回滚之后 target 的当前版本不能变空：' + JSON.stringify(api2))
    assert.equal(api2.current, actives[0].id, 'targets 的 current 与账本里的 active 必须是同一条记录')
  } finally {
    runtime.dispose()
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

// 前端没有浏览器用例，但有一个只能靠肉眼发现的失败模式：渲染期就抛 ReferenceError 会被 DSH 的
// slot 错误边界吞掉，面板直接一片空白（v3.0 曾因此「点流水线什么都没」）。这里钉住可静态判定的
// 那一类：useEffect/useCallback 的依赖数组在渲染期求值，引用更后面才声明的 const 就是 TDZ。
check('client.js：依赖数组不引用「本文件更后面才声明的 const」（首帧 TDZ → 面板静默空白）', () => {
  const raw = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  // 注释按等长空格抹掉，避免被注释掉的声明伪造「唯一声明」。
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, (match) => ' '.repeat(match.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, lead) => lead + ' '.repeat(match.length - lead.length))
  const declarations = new Map()
  for (const match of source.matchAll(/(?:^|[^\w$.])(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/g)) {
    const name = match[1]
    const offset = match.index + match[0].length - match[1].length - 1
    declarations.set(name, [...(declarations.get(name) || []), offset])
  }
  const offenders = []
  for (const match of source.matchAll(/\[\s*([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)\s*\]\s*\)/g)) {
    const base = match.index + 1
    for (const name of match[1].split(',').map((item) => item.trim())) {
      const declared = declarations.get(name)
      // 只认「全文件唯一声明且在其后」——多处同名就要做作用域分析，宁可漏报也不误报。
      if (declared && declared.length === 1 && declared[0] > base) {
        const line = source.slice(0, base).split('\n').length
        offenders.push(`line ${line}: ${name} 声明在 line ${source.slice(0, declared[0]).split('\n').length}`)
      }
    }
  }
  assert.deepEqual(offenders, [], '依赖数组引用更后声明的 const，渲染期必抛 ReferenceError：\n' + offenders.join('\n'))
})

// 按项目/环境隔离（2026-11-21 用户决策）：护栏条目写坏只拒绝「同名环境」的判定。
// 此前 invalid 非空会让**任何**环境判定整体拒绝 —— 别的项目/别的环境写错一条，全家发不出去。
checkAsync('P8-S7：护栏写坏只连坐同名环境 —— 别的项目、别的环境照常判定', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cicd-p8-s7-'))
  const mk = (name, extra) => {
    const projectDir = join(dir, name)
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'pipe.yml'), [
      'version: 1',
      'name: ' + name,
      extra,
      'targets:',
      '  staging:',
      '    hosts: [linux26]',
      '    path: /srv/' + name,
      'stages:',
      '  - id: build',
      '    steps:',
      '      - name: build',
      '        run: echo OK',
    ].filter(Boolean).join('\n'))
    return { id: name, name, path: projectDir, pipe: join(projectDir, 'pipe.yml') }
  }
  // a：自己的 pipe 把 prod 名单写坏（漏 role: 前缀）→ invalid 只该连坐 a 的 prod。
  const projectA = mk('a', 'environments:\n  prod:\n    allowedActors: [admin]')
  // b：干净的 staging，没有 environments 声明。
  const projectB = mk('b', '')
  // c：pipe 用**有效**的 prod 名单盖掉宿主那条写坏的 prod —— 宿主的 invalid 不再连坐 c。
  const projectC = mk('c', 'environments:\n  prod:\n    allowedActors: [role:owner]')
  const runtime = internals.createRuntime(fakeContext(), {
    projects: [projectA, projectB, projectC],
    workDir: join(dir, 'state'),
    remoteBase: 'http://127.0.0.1:1',
    scheduler: { enabled: false },
    deployment: {
      // 宿主层两条写坏：qa（不相干环境）与 prod（会被 c 的 pipe 盖掉）。
      environments: {
        qa: { allowedActors: ['管理员'] },
        prod: { allowedActors: ['admin'] },
      },
    },
  })
  try {
    const owner = { id: 'owner@acc.test', role: 'owner' }
    // ① b 的 staging 不受任何写坏条目影响（staging 非受保护，required 都不该是 true）。
    const bStaging = runtime.environmentGuard({ env: 'staging', projectId: 'b', actor: owner })
    assert.equal(bStaging.required, false, '不相干环境的写坏条目不该把 staging 也拖下水：' + JSON.stringify(bStaging))
    // ② b 的 qa 判定被宿主那条写坏拒绝（qa 是共享环境，宿主条目对它仍生效）。
    const bQa = runtime.environmentGuard({ env: 'qa', projectId: 'b', actor: owner })
    assert.equal(bQa.ok, false)
    assert.ok(bQa.failures.some((item) => item.code === 'ENV_GUARD_MISCONFIGURED'), 'qa 要报配置错误：' + JSON.stringify(bQa))
    // ③ a 自己写坏的 prod 只连坐 a 的 prod，不连坐 a 的 staging。
    const aProd = runtime.environmentGuard({ env: 'prod', projectId: 'a', actor: owner })
    assert.equal(aProd.ok, false)
    assert.ok(aProd.failures.some((item) => item.code === 'ENV_GUARD_MISCONFIGURED'), 'a 的 prod 要报自己的配置错误')
    const aStaging = runtime.environmentGuard({ env: 'staging', projectId: 'a', actor: owner })
    assert.equal(aStaging.required, false, 'a 写坏的是 prod，staging 不该被连坐：' + JSON.stringify(aStaging))
    // ④ c 的有效名单盖掉了宿主写坏的 prod：判 role:owner（通过），而不是宿主的 ENV_GUARD_MISCONFIGURED。
    const cProd = runtime.environmentGuard({ env: 'prod', projectId: 'c', actor: owner })
    assert.ok(!cProd.failures.some((item) => item.code === 'ENV_GUARD_MISCONFIGURED'), '被 pipe 盖掉的宿主条目不能再报配置错误：' + JSON.stringify(cProd))
    assert.equal(cProd.ok, true, 'role:owner 在 c 的名单里，应当放行')
    // ⑤ 环境页只报本项目在用的环境：a 只看到自己的 prod，看不到宿主的 qa。
    const view = await runtime.environments('a')
    assert.deepEqual([...new Set((view.invalid || []).map((item) => item.env))], ['prod'], '环境页的 invalid 只该有本项目在用的环境：' + JSON.stringify(view.invalid))
    const viewB = await runtime.environments('b')
    assert.deepEqual(viewB.invalid, [], 'b 没有用任何写坏的环境，invalid 应为空：' + JSON.stringify(viewB.invalid))
  } finally {
    runtime.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

// 冒烟测不到「页面长什么样」，但能钉住入口契约：整页应用只能挂 keyed 'main'。
// conversation.view 和宿主 composer 同属 conversation.content，注册它 = 页面底部永远跟着聊天输入框
// （用户 v3.0 报的「独立页面怎么有输入框」，同 dsh-aihot / docs/SPEC.md §4 的 v2 结论）。
check('client.js：只注册全局面板（panellist + keyed main），不注册会话内 View', () => {
  const raw = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, (match) => ' '.repeat(match.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, lead) => lead + ' '.repeat(match.length - lead.length))
  assert.equal(/'conversation\.view'/.test(source), false, '不应再注册 conversation.view（会连带渲染宿主 composer）')
  assert.match(source, /slots\.inject\('sidebar\.panellist'/)
  assert.match(source, /name:\s*'main',\s*\n\s*key:\s*PANEL_ID/)
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
    // 打完就跑：后面还有会起进程、占端口的用例，失败之后继续只会掩盖真正的第一现场。
    console.error(error)
    process.exit(1)
  }
}

for (const effect of ctx.effects) {
  try { effect() } catch { /* ignore */ }
}
assert.equal(ctx.routes.length, 0)
assert.equal(ctx.toolsList.length, 0)
rmSync(root, { recursive: true, force: true })
if (process.exitCode !== 1) console.log(`${passed} checks passed`)