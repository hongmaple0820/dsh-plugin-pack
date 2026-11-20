#!/usr/bin/env node
/**
 * dsh-cicd runner：V2-M2 远端执行面（单文件，Node 22+，无第三方依赖）。
 *
 * 用法（在 runner 所在机器上）：
 *   node bin/runner.mjs --server http://192.168.1.10:55788 --runner build-01 \
 *     --labels node,builder [--join-token <secret>] [--workdir /tmp/dsh-cicd-runner]
 *
 * 拉取式协议（server 的 dsh-host-webserver 只放行 GET/HEAD，所以 runner → server 全是 GET + query 参数；server → runner 经轮询下发任务）：
 *   /runner-register   ?runnerId=..&labels=a,b&version=..&capacity=1&token=..   → {ok, serverTime}
 *   /runner-poll       ?runnerId=..                                              → {ok, task: spec|null}（兼心跳）
 *   /runner-result     ?runnerId=..&taskId=..&status=..&exitCode=..&error=..    → {ok}（server 侧幂等）
 *   /runner-log        ?runnerId=..&taskId=..&line=..                           → {ok}
 *   /runners           （同源读，runner 不上报自身，仅面板用）
 *
 * 任务 spec（server → runner）：{taskId, stepIndex, stageId, command, cwd, env, timeoutSec, runId}
 * runner 本地 spawn（shell:true）执行，逐行回报 log（URL 编码），完成/超时/取消时回报 result。
 *
 * journal 幂等（断电续跑）：
 *   journal.jsonl 一行 = {taskId, attempt, status, exitCode, error, at}
 * runner 重启后读 journal：status=success 的任务跳过（不重跑）；
 * 未完成任务 attempt=+1 重跑；结果回报只认第一次（server 侧 resolve 幂等）。
 *
 * 自签 TLS：--insecure 跳过证书校验；--ca 指向 CA 证书（Node fetch 走 undici 全局 dispatcher）。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const VERSION = '0.6.2-m2'

function parseArgs(argv) {
  const out = {
    server: '', runnerId: '', labels: '', version: VERSION, capacity: 1,
    joinToken: '', workdir: '', insecure: false, ca: '',
    heartbeatSec: 15, pollSec: 2, help: false,
  }
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => argv[++i]
    if (arg === '--server') out.server = value()
    else if (arg === '--runner') out.runnerId = value()
    else if (arg === '--labels') out.labels = value()
    else if (arg === '--version') out.version = value()
    else if (arg === '--capacity') out.capacity = Number(value() || '1')
    else if (arg === '--join-token') out.joinToken = value()
    else if (arg === '--workdir') out.workdir = value()
    else if (arg === '--insecure') out.insecure = true
    else if (arg === '--ca') out.ca = value()
    else if (arg === '--heartbeat') out.heartbeatSec = Number(value() || '15')
    else if (arg === '--poll') out.pollSec = Number(value() || '2')
    else if (arg === '--help' || arg === '-h') out.help = true
  }
  return out
}

function printHelp() {
  console.log(`dsh-cicd runner ${VERSION}

  node bin/runner.mjs --server http://host:port --runner <id> [--labels a,b]
    [--join-token <secret>] [--workdir <dir>] [--insecure] [--ca <file>]
    [--heartbeat 15] [--poll 2]

  拉取式远端 runner：轮询领任务 → 本地 spawn → 逐行回报 log → 回 result（幂等）。
  journal.jsonl 记 {taskId, attempt, status, exitCode, error, at}；重启后成功任务不重跑。`)
}

function configureTls({ ca, insecure }) {
  if (!ca && !insecure) return
  // Node 22+ 内置 fetch 由 undici 驱动；undici 不是内置模块，需要显式 import。
  // 这里用动态 import，避免在 http:// 场景（不需要 TLS 定制）时硬依赖 undici。
  import('undici').then(({ setGlobalDispatcher, Agent }) => {
    setGlobalDispatcher(new Agent({
      connect: {
        ...(ca ? { ca: [readFileSync(ca)] } : {}),
        ...(insecure ? { rejectUnauthorized: false } : {}),
      },
    }))
  }).catch((error) => {
    console.warn(`[runner] undici 不可用，TLS 定制不生效：${error.message}`)
  })
}

function loadJournal(file) {
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  const entries = []
  for (const line of lines) {
    try { entries.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
  }
  return entries
}

function journalEntry(taskId, attempt, status, exitCode, error) {
  return JSON.stringify({ taskId, attempt, status, exitCode: Number(exitCode), error: String(error || ''), at: new Date().toISOString() })
}

function killTree(child) {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* best effort */ }
    return
  }
  try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch { /* gone */ } }
  setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ }
  }, 2000).unref?.()
}

/** 本地执行一步；返回 {status, exitCode, error}，cancelHandle.cancel() 可打断。 */
function runStep(spec, workdir, { onLine, cancelSignal } = {}) {
  return new Promise((resolveResult) => {
    const startedAt = Date.now()
    let child
    let cancelled = false
    let timedOut = false
    let timer = null
    try {
      child = spawn(spec.command, {
        shell: true,
        cwd: spec.cwd || workdir,
        // spec.env 是宿主插值后的项目 vars/secrets/toolchain PATH（lib/executors.js execute() 组装）。
        // 早先这里直接丢弃了它，远端命令拿到的只有 runner 自己的 process.env——env/secrets 全部静默失效。
        env: { ...process.env, ...(spec.env || {}), CI: '1', DSH_CICD_RUN_ID: spec.runId || '' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      })
    } catch (error) {
      resolveResult({ status: 'failed', exitCode: -1, error: error.message })
      return
    }
    const emit = (data) => {
      let rest = String(data || '')
      let index
      while ((index = rest.indexOf('\n')) >= 0) {
        const line = rest.slice(0, index).replace(/\r$/, '')
        rest = rest.slice(index + 1)
        onLine?.(line)
      }
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', emit)
    child.stderr?.on('data', emit)
    if (spec.timeoutSec > 0) {
      timer = setTimeout(() => {
        timedOut = true
        killTree(child)
      }, spec.timeoutSec * 1000)
    }
    const cancel = () => {
      cancelled = true
      killTree(child)
    }
    cancelSignal?.cancelSet?.(cancel)
    child.on('close', (code) => {
      const exitCode = Number.isInteger(code) ? code : -1
      if (timer) clearTimeout(timer)
      if (cancelled) {
        resolveResult({ status: 'canceled', exitCode, error: '已取消' })
        return
      }
      const status = !timedOut && exitCode === 0 ? 'success' : 'failed'
      resolveResult({ status, exitCode, error: timedOut ? `步骤超时（${spec.timeoutSec}s）` : '' })
    })
    child.on('error', (error) => {
      if (timer) clearTimeout(timer)
      resolveResult({ status: 'failed', exitCode: -1, error: error.message })
    })
  })
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.help) {
    printHelp()
    return
  }
  if (!args.server || !args.runnerId) {
    console.error('缺少 --server / --runner')
    printHelp()
    process.exit(1)
  }
  configureTls({ ca: args.ca, insecure: args.insecure })

  const workdir = args.workdir ? resolve(args.workdir) : join(homedir(), '.dsh-cicd-runner', args.runnerId)
  mkdirSync(workdir, { recursive: true })
  const journalFile = join(workdir, 'journal.jsonl')
  const journal = loadJournal(journalFile)
  const done = new Set(journal.filter((row) => row.status === 'success').map((row) => row.taskId))

  const labels = String(args.labels || '').split(',').map((item) => item.trim()).filter(Boolean)
  const apiBase = args.server.replace(/\/$/, '')
  const runnerApi = `${apiBase}/api/plugins/cicd`
  let stopping = false
  let activeTask = null

  async function get(pathname, query) {
    const url = new URL(runnerApi + pathname)
    Object.keys(query || {}).forEach((key) => {
      const value = query[key]
      if (value === undefined || value === null || value === '') return
      url.searchParams.set(key, String(value))
    })
    const response = await fetch(url, { method: 'GET', headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`GET ${pathname} → ${response.status}`)
    return await response.json()
  }

  async function register() {
    const data = await get('/runner-register', {
      labels: labels.join(','),
      version: args.version,
      capacity: String(args.capacity),
      token: args.joinToken,
    })
    console.log(`[runner] 已注册 ${args.runnerId} @ ${data?.serverTime || ''}`)
  }

  async function heartbeat() {
    try {
      await get('/runner-poll', {}) // poll 兼心跳：活着就续 lastSeenAt
    } catch { /* 心跳失败不退出，等下一轮 */ }
  }

  function writeJournal(entry) {
    appendFileSync(journalFile, entry + '\n')
  }

  async function executeTask(spec) {
    if (done.has(spec.taskId)) {
      console.log(`[runner] 跳过已完成任务 ${spec.taskId}（journal 幂等）`)
      return
    }
    const attempt = journal.filter((row) => row.taskId === spec.taskId).length + 1
    console.log(`[runner] 领任务 ${spec.taskId}（attempt ${attempt}）：${spec.command}`)

    let cancelFn = null
    const cancelSignal = { cancelSet: (fn) => { cancelFn = fn } }
    const result = await runStep(spec, workdir, {
      onLine: (line) => {
        // 逐行 log 走 GET，失败静默（log 丢行可接受；result 是关键幂等回报）。
        get('/runner-log', { taskId: spec.taskId, line }).catch(() => {})
      },
      cancelSignal,
    })
    writeJournal(journalEntry(spec.taskId, attempt, result.status, result.exitCode, result.error))
    console.log(`[runner] 任务 ${spec.taskId} → ${result.status}（exit ${result.exitCode}）`)
    await get('/runner-result', {
      taskId: spec.taskId,
      status: result.status,
      exitCode: String(result.exitCode),
      error: result.error,
    }).catch((error) => console.error(`[runner] 回报结果失败：${error.message}`))
  }

  async function loop() {
    while (!stopping) {
      try {
        if (!activeTask) {
          const data = await get('/runner-poll', {})
          if (data?.task) activeTask = data.task
        }
        if (activeTask) {
          await executeTask(activeTask)
          activeTask = null
          continue
        }
        await delay(args.pollSec * 1000)
      } catch (error) {
        if (stopping) break
        console.error(`[runner] 轮询失败：${error.message}，${args.pollSec}s 后重试`)
        await delay(args.pollSec * 1000)
      }
    }
  }

  const hbTimer = setInterval(() => {
    if (!stopping) void heartbeat()
  }, Math.max(5, args.heartbeatSec) * 1000)
  hbTimer.unref?.()

  const stop = (name) => {
    if (stopping) return
    stopping = true
    clearInterval(hbTimer)
    if (activeTask) {
      console.log(`[runner] 收到 ${name}，退出（当前任务交给 journal：下次重启重跑）`)
    } else {
      get('/runner-deregister', {}).catch(() => {})
    }
    process.exit(0)
  }

  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))

  await register()
  await heartbeat()
  await loop()
}

main().catch((error) => {
  console.error(`[runner] 启动失败：${error.message}`)
  process.exit(1)
})
