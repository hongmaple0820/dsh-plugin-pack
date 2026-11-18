/**
 * Local pipeline runner: spawns one shell command per step, records a line log, and walks the
 * stage DAG serially. M1 has no parallelism by design.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { planPipeline } from './pipe.js'
import { createLocalExecutor } from './executors.js'

export function makeRunId(now = new Date(), random = Math.random) {
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const suffix = Math.floor(random() * 0xffffff).toString(16).padStart(6, '0')
  return `${stamp}-${suffix}`
}

/**
 * 默认本地执行面：spawn 子进程（V2-M2 把执行面抽成 Executor，runner.js 只依赖 execute/kill/active）。
 * 宿主（index.js）可用 createRemoteExecutor 替换：远端 runner 领任务 → 本地 spawn → 回报 log/result。
 */
function createDefaultExecutor() {
  return createLocalExecutor()
}

function selectedStages(plan, stage) {
  if (!stage) return plan.stages
  const byId = new Map(plan.stages.map((item) => [item.id, item]))
  if (!byId.has(stage)) {
    const error = new Error(`stage “${stage}” 不存在`)
    error.code = 'STAGE_NOT_FOUND'
    throw error
  }
  const keep = new Set()
  const visit = (id) => {
    if (keep.has(id)) return
    keep.add(id)
    const item = byId.get(id)
    for (const need of item?.needs || []) visit(need)
  }
  visit(stage)
  return plan.stages.filter((item) => keep.has(item.id))
}

export async function runPipeline({
  pipe,
  project,
  target,
  dryRun = false,
  store,
  onLog = () => {},
  stage = '',
  releaseId = '',
  executeDeploy = null,
  stepTimeoutSec = 0,
  now = new Date(),
  random = Math.random,
  hub = null,
  signal = null,
  runId: runIdOverride = '',
  executor = null,
  extraVars = null,
} = {}) {
  // runId 先生成：RELEASE_ID 在 plan 阶段就要能插值，否则产物文件名会是空的。
  // V2-M1：宿主要提前注册 activeRuns（取消要能找到 runId），所以允许传入。
  const runId = runIdOverride || makeRunId(now, random)
  const plan = planPipeline(pipe, {
    project,
    target,
    env: {
      ...(project?.env || {}),
      branch: project?.branch ?? project?.env?.branch ?? '',
      tag: project?.tag ?? '',
      commit: project?.commit ?? '',
      changed: project?.changed ?? [],
      releaseId: releaseId || runId,
      ...(extraVars || {}),
    },
  })
  const stages = selectedStages(plan, stage)

  if (dryRun) {
    const planned = stages.map((item) => ({
      id: item.id,
      status: 'planned',
      durationMs: 0,
      steps: item.steps.map((step) => {
        onLog({ runId: '', stageId: item.id, index: step.index, line: `$ ${step.command}` })
        return { ...step, status: 'planned', durationMs: 0, exitCode: 0 }
      }),
    }))
    return { runId: '', status: 'planned', stages: planned, plan }
  }

  // V2-M2：执行面可迁移——宿主传入 executor（本地 createLocalExecutor / 远端 createRemoteExecutor），
  // 缺省本地 spawn，行为与旧 spawnStep 一致。
  const activeExecutor = executor || createDefaultExecutor()

  if (stepTimeoutSec > 0) {
    for (const item of stages) {
      for (const step of item.steps) if (!step.source?.timeout) step.timeoutSec = stepTimeoutSec
    }
  }

  const logFile = store?.dir ? join(store.dir, 'logs', `${runId}.log`) : ''
  if (logFile) {
    mkdirSync(join(store.dir, 'logs'), { recursive: true })
    appendFileSync(logFile, '', 'utf8')
  }
  const log = (entry, line) => {
    if (logFile) {
      try { appendFileSync(logFile, `${line}\n`, 'utf8') } catch { /* logging must not kill the run */ }
    }
    try { onLog({ runId, stageId: entry.stageId, index: entry.index, line }) } catch { /* observer errors are not run errors */ }
    if (hub) {
      try { hub.append(runId, { stageId: entry.stageId, index: entry.index, line }) } catch { /* hub errors must not kill the run */ }
    }
  }

  const startedAt = new Date().toISOString()
  const runRecord = {
    id: runId,
    project_id: project?.id || '',
    pipeline_name: plan.name,
    trigger: project?.trigger || 'manual',
    branch: project?.branch || '',
    commit: project?.commit || '',
    started_at: startedAt,
    finished_at: '',
    status: 'running',
    target: target || '',
    dry_run: 0,
    error: '',
  }
  store?.appendRun(runRecord)

  const stageResults = []
  const failedStages = new Set()
  const vars = plan.vars

  for (const item of stages) {
    if (signal?.aborted) {
      const canceledStatus = 'canceled'
      if (hub) hub.end(runId, canceledStatus)
      store?.appendRun({ ...runRecord, finished_at: new Date().toISOString(), status: canceledStatus, error: '已取消' })
      return { runId, status: canceledStatus, stages: stageResults, plan }
    }
    const blocked = item.needs.some((need) => failedStages.has(need))
    if (blocked) {
      const skipped = { id: item.id, status: 'skipped', durationMs: 0, steps: item.steps.map((step) => ({ ...step, status: 'skipped', durationMs: 0, exitCode: -1 })) }
      stageResults.push(skipped)
      failedStages.add(item.id)
      log({ stageId: item.id, index: -1 }, `跳过 stage ${item.id}：上游失败`)
      continue
    }
    const stageStarted = Date.now()
    const stepResults = []
    let stageFailed = false
    for (const step of item.steps) {
      if (signal?.aborted) {
        const canceledStatus = 'canceled'
        if (hub) hub.end(runId, canceledStatus)
        store?.appendRun({ ...runRecord, finished_at: new Date().toISOString(), status: canceledStatus, error: '已取消' })
        return { runId, status: canceledStatus, stages: stageResults, plan }
      }
      if (step.kind === 'deploy') {
        if (!executeDeploy) {
          stepResults.push({ ...step, status: 'skipped', durationMs: 0, exitCode: 0 })
          log({ stageId: item.id, index: step.index }, `跳过部署 ${step.deploy?.target || ''}：当前上下文没有部署器`)
          continue
        }
        const deployStarted = Date.now()
        try {
          const result = await executeDeploy({ step, stage: item, runId, vars, log: (line) => log({ stageId: item.id, index: step.index }, line) })
          const status = result?.status || 'success'
          const hosts = Array.isArray(result?.deploy?.hosts) ? result.deploy.hosts : []
          stepResults.push({ ...step, status, deploy: result?.deploy || null, hosts, durationMs: Date.now() - deployStarted, exitCode: status === 'success' ? 0 : 1, error: result?.error || '' })
          if (status !== 'success' && !step.allowFailure) { stageFailed = true; break }
        } catch (error) {
          log({ stageId: item.id, index: step.index }, `部署失败：${error.message}`)
          stepResults.push({ ...step, status: 'failed', deploy: null, hosts: Array.isArray(error.hosts) ? error.hosts : [], durationMs: Date.now() - deployStarted, exitCode: 1, error: error.message })
          if (!step.allowFailure) { stageFailed = true; break }
        }
        continue
      }

      const command = step.command
      const env = { ...process.env, CI: '1', ...vars, DSH_CICD_RUN_ID: runId }
      let attempt = 0
      let result = null
      const maxAttempts = step.retries + 1
      while (attempt < maxAttempts) {
        attempt += 1
        log({ stageId: item.id, index: step.index }, `$ ${command}${maxAttempts > 1 ? `（第 ${attempt}/${maxAttempts} 次）` : ''}`)
        result = await activeExecutor.execute(
          { command, timeoutSec: step.timeoutSec },
          {
            cwd: project?.path || process.cwd(),
            env,
            onLine: (line) => log({ stageId: item.id, index: step.index }, line),
            signal,
            taskId: `run-${runId}-step-${item.id}-${step.index}`,
            runId,
            stepIndex: step.index,
            stageId: item.id,
          },
        )
        if (result.status === 'success') break
        if (result.status === 'canceled' || signal?.aborted) break
      }
      // 步骤被取消打断：写一条 canceled 的 step 记录后整轮结束（后面的步骤不再跑）。
      if (result?.status === 'canceled' || signal?.aborted) {
        log({ stageId: item.id, index: step.index }, '已取消')
        try {
          store?.appendStep({
            run_id: runId,
            stage_id: item.id,
            idx: step.index,
            name: step.name,
            command,
            exit_code: -1,
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            status: 'canceled',
            log_path: logFile,
            timeout_s: step.timeoutSec,
            attempts: attempt,
            runner_id: activeExecutor?.runnerId || '',
          })
        } catch { /* step rows are best effort */ }
        stepResults.push({ ...step, status: 'canceled', durationMs: result?.durationMs || 0, exitCode: -1, error: '已取消' })
        stageResults.push({ id: item.id, status: 'canceled', durationMs: Date.now() - stageStarted, steps: stepResults })
        if (hub) hub.end(runId, 'canceled')
        store?.appendRun({ ...runRecord, finished_at: new Date().toISOString(), status: 'canceled', error: '已取消' })
        return { runId, status: 'canceled', stages: stageResults, plan }
      }
      const status = result.status
      const stepRecord = {
        run_id: runId,
        stage_id: item.id,
        idx: step.index,
        name: step.name,
        command,
        exit_code: result.exitCode,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        status,
        log_path: logFile,
        timeout_s: step.timeoutSec,
        attempts: attempt,
        runner_id: activeExecutor?.runnerId || '',
      }
      store?.appendStep(stepRecord)
      stepResults.push({ ...step, status, durationMs: result.durationMs, exitCode: result.exitCode, error: result.error || '' })
      if (status !== 'success') {
        log({ stageId: item.id, index: step.index }, `步骤${result.timedOut ? '超时' : '失败'}（exit ${result.exitCode}）`)
        if (!step.allowFailure) { stageFailed = true; break }
        log({ stageId: item.id, index: step.index }, 'allow_failure：继续执行')
      }
    }
    const stageStatus = stageFailed ? 'failed' : 'success'
    stageResults.push({ id: item.id, status: stageStatus, durationMs: Date.now() - stageStarted, steps: stepResults })
    if (stageFailed) failedStages.add(item.id)
  }

  const status = stageResults.some((item) => item.status === 'failed') ? 'failed' : 'success'
  if (hub) hub.end(runId, status)
  store?.appendRun({ ...runRecord, finished_at: new Date().toISOString(), status, error: status === 'failed' ? '有 stage 失败' : '' })
  return { runId, status, stages: stageResults, plan }
}