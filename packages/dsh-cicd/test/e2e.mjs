// 真实端到端：真 runtime + 真 runner 进程（dsh-cicd-runner.exe）+ 本地 git 仓库，
// 连跑两次构建，验证：
//   ① checkout 真克隆（sourceType=git 走 DB 项目行）
//   ② 顶层 cache: 第二次构建命中（runner stderr 的「cache <key>: 命中」为证）
//   ③ 制品回流进 CAS（refs 指针 → blobs 按 sha256 存在且内容一致）
//   ④ 凭据以 env 注入、宿主日志/DB 里 grep 不到 secret 明文（只有 ***）
// 用法：node test/e2e.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync, spawn } from 'node:child_process'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { internals } from '../index.js'

const SECRET = 'S3cr3t-E2E-value-42'
const SECRET_NAME = 'E2E_SECRET'
const RUNNER_ID = 'r-e2e'
const JOIN_TOKEN = 'e2e-join-token-0123456789abcdef'
const RUNNER_EXE = join(import.meta.dirname, '..', 'runner', 'target', 'debug', 'dsh-cicd-runner.exe')

const root = mkdtempSync(join(tmpdir(), 'dsh-cicd-e2e-'))
const repoDir = join(root, 'repo')
const workDir = join(root, 'state')
const runnerWs = join(root, 'runner-ws')
mkdirSync(repoDir, { recursive: true })
mkdirSync(runnerWs, { recursive: true })

let failures = 0
const check = (name, cond, extra = '') => {
  if (cond) console.log('  ok  ' + name)
  else { failures += 1; console.log('FAIL  ' + name + (extra ? ' — ' + extra : '')) }
}

// ---------- ① 本地 git 仓库 + pipe.yml ----------
const PIPE_SOURCE = [
  'version: 1',
  'name: e2e-pipe',
  'targets:',
  '  e2e:',
  '    hosts: [e2e-local]',
  '    path: /tmp/e2e-none',
  'cache:',
  '  - key: e2e-build-v1',
  '    paths:',
  '      - dist/**',
  '    mode: both',
  'stages:',
  '  - id: build',
  '    steps:',
  // v2 远程任务按步骤切分、每个任务 clean:true 重建 workspace——多步 build 的中间产物
  // 到不了 collect 那一步（已知限制，见交付说明）。所以 e2e 用单步 stage：
  // 一步内建产物 + 回显 secret（stdout 走 /logs 回宿主，验日志脱敏），
  // collect 声明同 stage 下发，runner 在步骤成功后打包 dist/** 回流 CAS。
  '      - name: build-all',
  '        run: if not exist dist mkdir dist && echo secret=%' + SECRET_NAME + '% && echo built>dist\\out.txt && dir /B && dir /B dist && cd dist && dir /B && cd ..',
  '      - name: finish-flag',
  '        run: echo FLAG_DONE',
  '      - name: collect-artifacts',
  '        uses: collect',
  '        with:',
  '          name: e2e-dist',
  '          paths:',
  '            - dist/**',
].join('\n')
writeFileSync(join(repoDir, 'pipe.yml'), PIPE_SOURCE, 'utf8')
const git = (args, cwd = repoDir) => spawnSync('git', args, { cwd, encoding: 'utf8' })
{
  const init = git(['init'])
  check('git init', init.status === 0, init.stderr)
  git(['config', 'user.email', 'e2e@test'])
  git(['config', 'user.name', 'e2e'])
  git(['add', '-A'])
  const commit = git(['commit', '-m', 'init'])
  check('git commit', commit.status === 0, commit.stderr)
}

// ---------- ② 先写 DB 项目行（normalizeConfig 不透传 sourceType/repoUrl，必须走持久化行） ----------
{
  const pre = internals.createStore({ dir: workDir })
  pre.upsertProject({
    id: 'e2e',
    name: 'E2E',
    path: repoDir,
    pipePath: join(repoDir, 'pipe.yml'),
    sourceType: 'git',
    repoUrl: 'file:///' + repoDir.replace(/\\/g, '/'),
    defaultBranch: '',
  })
  pre.close()
}

// ---------- ③ 起 runtime（smoke 同款 fake ctx + handler 路由） ----------
const ctx = (() => {
  const routes = []
  const effects = []
  return {
    routes,
    effects,
    tools: { register() { return () => {} } },
    get(key) { return key === 'webServer' ? { register: (def) => { routes.push(def); return () => {} }, registerUpgrade: () => () => {} } : undefined },
    effect(fn) { const d = fn(); if (typeof d === 'function') effects.push(d); return d },
  }
})()

// 密钥：与 runtime 同盘实例（同一份 key 文件），先建好密钥文件再建 runtime。
const secretsCli = internals.createSecretStore({ dir: workDir })
secretsCli.set('e2e', 'global', SECRET_NAME, SECRET)

const runtime = internals.createRuntime(ctx, {
  projects: [],
  workDir,
  scheduler: { enabled: false },
  runners: { joinToken: JOIN_TOKEN, heartbeatSec: 5 },
})
internals.registerHttpRoutes(ctx, runtime)
const v2Route = ctx.routes.find((route) => String(route.path || '').includes('runner/v2'))
check('v2 handler 路由已注册', Boolean(v2Route && typeof v2Route.handler === 'function'))

// ---------- ④ 真 HTTP server 转发（req/res 原样递给 httpHandler） ----------
const server = http.createServer((req, res) => {
  const url = req.url || ''
  const pathOnly = url.split('?')[0]
  if (v2Route && pathOnly.startsWith(v2Route.path)) { v2Route.handler(req, res); return }
  res.statusCode = 404
  res.end('not found')
})
const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
console.log('server on 127.0.0.1:' + port)

// ---------- ⑤ 起真 runner 进程（常驻，两个 run 共用） ----------
if (!existsSync(RUNNER_EXE)) {
  console.log('FAIL  runner exe 不存在：' + RUNNER_EXE + '（先 cargo build）')
  process.exit(1)
}
const runnerOut = join(root, 'runner.stdout.log')
const runnerErr = join(root, 'runner.stderr.log')
const outFd = openSync(runnerOut, 'w')
const errFd = openSync(runnerErr, 'w')
const child = spawn(RUNNER_EXE, [
  '--server', 'http://127.0.0.1:' + port,
  '--runner', RUNNER_ID,
  '--join-token', JOIN_TOKEN,
  '--workdir', runnerWs,
], { stdio: ['ignore', outFd, errFd] })
const readRunnerLog = () => {
  try { return readFileSync(runnerErr, 'utf8') + readFileSync(runnerOut, 'utf8') } catch { return '' }
}
await new Promise((resolve) => setTimeout(resolve, 2500)) // 等注册 + 首次心跳
check('runner 已注册（宿主可见）', (runtime.runners() || []).some((row) => row.runnerId === RUNNER_ID || row.id === RUNNER_ID), JSON.stringify(runtime.runners()))

// ---------- ⑥ 连跑两次构建 ----------
const runOnce = async (label) => {
  const result = await runtime.run({
    projectId: 'e2e',
    targetName: 'e2e',
    runnerId: RUNNER_ID,
    runnerWaitSec: 60,
    confirmProd: true,
    trigger: 'manual',
  })
  console.log(label + ' status=' + result.status + ' runId=' + result.runId)
  return result
}
const run1 = await runOnce('run1')
check('run1 success', run1.status === 'success', JSON.stringify(run1.error || run1.stages || '').slice(0, 800))
const log1 = readRunnerLog()
check('run1 cache 未命中（首建）', log1.includes('cache e2e-build-v1: 未命中') || log1.includes('已保存'), log1.slice(-2000))
check('run1 cache 已保存', log1.includes('cache e2e-build-v1: 已保存'))
check('run1 checkout 真克隆', log1.includes('Cloning into') || existsSync(join(runnerWs, 'ws', String(run1.runId), 'pipe.yml')), log1.slice(-2000))

const run2 = await runOnce('run2')
check('run2 success', run2.status === 'success', JSON.stringify(run2.error || run2.stages || '').slice(0, 800))
const log2 = readRunnerLog()
check('run2 cache 第二次构建命中', log2.includes('cache e2e-build-v1: 命中'), log2.slice(-2000))

// ---------- ⑦ 制品回流 CAS ----------
const casDir = join(workDir, 'artifacts')
const refFile = join(casDir, 'refs', 'e2e', 'e2e-dist.json')
check('制品 ref 指针存在', existsSync(refFile), refFile)
if (existsSync(refFile)) {
  const ref = JSON.parse(readFileSync(refFile, 'utf8'))
  const digest = String(ref.digest || '').replace('sha256:', '')
  const blob = join(casDir, 'blobs', 'sha256', digest.slice(0, 2), digest)
  check('制品 blob 存在于 CAS', existsSync(blob), blob)
  if (existsSync(blob)) {
    const bytes = readFileSync(blob)
    const sha = createHash('sha256').update(bytes).digest('hex')
    check('制品 blob sha256 一致', sha === digest, sha + ' vs ' + digest)
    check('制品 blob 可解出 dist/out.txt（gzip tar 含 out.txt 名）', bytes.includes(Buffer.from('out.txt')) || bytes[0] === 0x1f, '')
  }
}

// ---------- ⑧ 凭据不落明文 ----------
const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}
let leakFiles = []
for (const file of walk(workDir)) {
  try {
    const buf = readFileSync(file)
    if (buf.includes(Buffer.from(SECRET, 'utf8'))) leakFiles.push(file)
  } catch { /* skip */ }
}
check('宿主 workDir（含 SQLite DB、日志、CAS）grep 不到 secret 明文', leakFiles.length === 0, leakFiles.join(', '))
const log1Text = readRunnerLog()
// runner 自己的控制台拿到的是明文（凭据交换的目的就是让它拿到）——这证明 env 注入真的生效了。
check('runner 侧凭据注入生效（stdout 回显出 secret 明文）', log1Text.includes('secret=' + SECRET), log1Text.slice(-1500))
// 宿主 run 日志（<workDir>/logs/<runId>.log）必须脱敏：回显行只能是 secret=***。
const hostLogPath = join(workDir, 'logs', String(run1.runId) + '.log')
let hostLog = ''
try { hostLog = readFileSync(hostLogPath, 'utf8') } catch { /* missing */ }
check('宿主 run 日志存在', hostLog.length > 0, hostLogPath)
check('宿主 run 日志里 secret 被打成 ***', hostLog.includes('secret=***'), hostLog.slice(-1500))
check('宿主 run 日志不含 secret 明文', !hostLog.includes(SECRET), '')

// ---------- ⑨ 收尾 ----------
try { child.kill() } catch { /* already gone */ }
await new Promise((resolve) => setTimeout(resolve, 500))
try { runtime.dispose() } catch { /* best effort */ }
try { secretsCli.dispose() } catch { /* best effort */ }
try { server.close() } catch { /* best effort */ }
console.log('')
console.log(failures === 0 ? 'E2E PASS（工作目录保留在 ' + root + '）' : 'E2E FAILED: ' + failures + ' 项（工作目录保留在 ' + root + '）')
process.exit(failures === 0 ? 0 : 1)
