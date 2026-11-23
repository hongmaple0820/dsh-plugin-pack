/**
 * Local pipeline runner: spawns one shell command per step, records a line log, and walks the
 * job graph. v1 files still run through the original stage loop; v2 files go through the DAG
 * scheduler with a concurrency pool.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { planPipeline } from './pipe.js'
import { createLocalExecutor } from './executors.js'
import { normalizeModel } from './model.js'
import { scheduleJobs, DEFAULT_CONCURRENCY, statusToState } from './jobs.js'
import { evaluateTemplate, evaluateCondition } from './expr.js'
import { runAction } from './actions.js'

export function makeRunId(now = new Date(), random = Math.random) {
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const suffix = Math.floor(random() * 0xffffff).toString(16).padStart(6, '0')
  return `${stamp}-${suffix}`
}

/** 脱敏占位符：保留前后缀，让人看得出「这里本来是密钥」，但拿不到值。 */
export const REDACTED = '***'

/**
 * 行内脱敏。`secrets` 是按长度降序的明文值数组（长的先换，避免短值切开长值留残渣）。
 *
 * 为什么放在 runner 而不是 index.js：日志有四个出口（文件、onLog 回调、live hub、远端
 * runner 回传），任何一个漏掉都会泄露；在产生日志行的唯一位置替换，四个出口同时干净。
 */
export function redactLine(line, secrets) {
  if (!secrets || secrets.length === 0) return line
  let out = String(line ?? '')
  for (const secret of secrets) {
    if (!secret) continue
    if (out.includes(secret)) out = out.split(secret).join(REDACTED)
  }
  return out
}

/**
 * 默认本地执行面：spawn 子进程（V2-M2 把执行面抽成 Executor，runner.js 只依赖 execute/kill/active）。
 * 宿主（index.js）可用 createRemoteExecutor 替换：远端 runner 领任务 → 本地 spawn → 回报 log/result。
 */
function createDefaultExecutor() {
  return createLocalExecutor()
}

/**
 * 执行动作登记的收尾钩子（cache 保存、上传等）。
 *
 * 钩子失败只记一行日志：构建本身已经成功了，不该因为「缓存没存上」把一次成功的构建翻成失败
 * ——那会让用户在毫无收益的地方重跑一遍。
 */
async function flushFinalizers(finalizers, log, where) {
  if (!finalizers || finalizers.length === 0) return
  for (const fn of finalizers.splice(0)) {
    try {
      await fn()
    } catch (error) {
      try { log(where || {}, `收尾动作失败：${error.message}`) } catch { /* 日志失败不影响结果 */ }
    }
  }
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

/**
 * 跑单个 step（命令 / 部署 / 未来的 uses），返回 step 结果。
 *
 * 抽出来的原因：v1 的 stage 循环与 v2 的 job 执行器必须用**同一段**执行逻辑。两处各写一遍，
 * 迟早出现「v2 下重试不退避」或「v2 下部署超时不生效」这类只在一条路径上存在的差异。
 */
async function runStep({ step, stageId, jobId, ctx }) {
  const { runId, log, store, logFile, activeExecutor, project, vars, signal, executeDeploy } = ctx
  // jobId 必须带上：v2 里同一个 stage 下多个 job 的 step 序号会重复（都是 0 开始），
  // 日志行只靠 stageId+index 无法定位到是哪个 job 打的。
  const where = { stageId, jobId: jobId || '', index: step.index }

  if (step.kind === 'deploy') {
    if (!executeDeploy) {
      log(where, `跳过部署 ${step.deploy?.target || ''}：当前上下文没有部署器`)
      return { ...step, status: 'skipped', durationMs: 0, exitCode: 0 }
    }
    const started = Date.now()
    try {
      const result = await executeDeploy({ step, stage: { id: stageId }, jobId, runId, vars, log: (line) => log(where, line) })
      const status = result?.status || 'success'
      const hosts = Array.isArray(result?.deploy?.hosts) ? result.deploy.hosts : []
      return {
        ...step,
        status,
        deploy: result?.deploy || null,
        hosts,
        durationMs: Date.now() - started,
        exitCode: status === 'success' ? 0 : 1,
        error: result?.error || '',
      }
    } catch (error) {
      log(where, `部署失败：${error.message}`)
      return {
        ...step,
        status: 'failed',
        deploy: null,
        hosts: Array.isArray(error.hosts) ? error.hosts : [],
        durationMs: Date.now() - started,
        exitCode: 1,
        error: error.message,
      }
    }
  }

  if (step.kind === 'uses') {
    const name = step.uses || ''
    if (name === 'cache') {
      const notice = remoteCacheStepNotice(ctx.activeExecutor)
      if (notice) log(where, notice)
    }
    // M4：远程构建的 collect 由 runner 在步骤全部成功后执行（它在自己的 workspace 里 glob，
    // 再把字节 PUT 回宿主 CAS）。在宿主这边跑同一个动作只会 glob 到一个空项目目录，
    // 然后硬失败「collect 没有匹配到任何文件」——那是个假故障。
    if (name === 'collect' && ctx.activeExecutor?.kind === 'remote') {
      const notice = remoteCollectStepNotice(ctx.activeExecutor)
      if (notice) log(where, notice)
      return { ...step, status: 'skipped', durationMs: 0, exitCode: 0, error: '' }
    }
    if (!ctx.actions) {
      // 干跑（或没有动作运行时）：明确说跳过，而不是假装成功。
      log(where, `跳过动作 ${name}：当前上下文没有动作运行时（干跑不执行动作）`)
      return { ...step, status: 'skipped', durationMs: 0, exitCode: 0, error: '干跑不执行动作' }
    }
    const started = Date.now()
    const actionCtx = {
      // ctx.actions 是工厂：它需要 runner 的 log(where, line) 才能把动作的输出
      // 落到正确的 stage/job 分片里。直接给个实例就只能打一条没有归属的日志。
      ...ctx.actions((line) => log(where, line)),
      log: (line) => log(where, line),
      project: ctx.project,
      runId,
      vars,
      // 动作的收尾钩子（cache 保存要等 build 跑完）挂到当前 job/stage 上，
      // 由外层在 job 结束时统一 flush——在这里执行的话，保存的是还没 build 出来的空目录。
      finalize: (fn) => { if (typeof ctx.finalize === 'function') ctx.finalize(fn) },
    }
    try {
      const result = await runAction({ name, with: step.with, ctx: actionCtx })
      return {
        ...step,
        status: 'success',
        durationMs: Date.now() - started,
        exitCode: 0,
        outputs: result?.outputs || {},
        hosts: Array.isArray(result?.hosts) ? result.hosts : [],
        error: '',
      }
    } catch (error) {
      log(where, `动作 ${name} 失败：${error.message}`)
      return {
        ...step,
        status: 'failed',
        durationMs: Date.now() - started,
        exitCode: 1,
        error: error.message,
        code: error.code || '',
        allowFailure: Boolean(step.allowFailure),
      }
    }
  }

  const command = step.command
  // 有工具链注入时只用白名单 env（宿主 JAVA_HOME/NODE_OPTIONS 之类不许偷偷影响构建）；
  // 没声明工具链的项目保持原样，行为一个字节都不变。
  const runVars = { ...vars, DSH_CICD_RUN_ID: runId, CI: '1' }
  const env = typeof ctx.toolchainEnv === 'function'
    ? ctx.toolchainEnv(runVars)
    : { ...process.env, CI: '1', ...vars, DSH_CICD_RUN_ID: runId }
  let attempt = 0
  let result = null
  const maxAttempts = step.retries + 1
  while (attempt < maxAttempts) {
    attempt += 1
    log(where, `$ ${command}${maxAttempts > 1 ? `（第 ${attempt}/${maxAttempts} 次）` : ''}`)
    result = await activeExecutor.execute(
      { command, timeoutSec: step.timeoutSec },
      {
        cwd: project?.path || process.cwd(),
        env,
        onLine: (line) => log(where, line),
        signal,
        taskId: `run-${runId}-step-${stageId}-${jobId ? `${jobId}-` : ''}${step.index}`,
        runId,
        // M3：凭据按项目取（secretRefs），缓存按任务下发——两个都靠 projectId 定位。
        projectId: project?.id || '',
        stepIndex: step.index,
        stageId,
        source: ctx.source || null,
        cache: ctx.cache || [],
        // M4：制品声明按 stage 下发（同 stage 的 uses: collect 步骤）。
        artifacts: typeof ctx.collectDecls === 'function' ? ctx.collectDecls(stageId) : [],
      },
    )
    if (result.status === 'success') break
    if (result.status === 'canceled' || signal?.aborted) break
  }

  if (result?.status === 'canceled' || signal?.aborted) {
    log(where, '已取消')
    return { ...step, status: 'canceled', durationMs: result?.durationMs || 0, exitCode: -1, error: '已取消', attempts: attempt }
  }

  const status = result.status
  if (status !== 'success') {
    log(where, `步骤${result.timedOut ? '超时' : '失败'}（exit ${result.exitCode}）`)
    if (step.allowFailure) log(where, 'allow_failure：继续执行')
  }
  return { ...step, status, durationMs: result.durationMs, exitCode: result.exitCode, error: result.error || '', attempts: attempt }
}

/** 把 runStep 的结果落一条 step 记录。v1/v2 共用，job_id 为空时就是 v1 的老行。 */
function recordStep({ store, runId, stageId, jobId, step, result, logFile, activeExecutor }) {
  try {
    store?.appendStep({
      run_id: runId,
      stage_id: stageId,
      job_id: jobId || '',
      idx: step.index,
      name: step.name,
      command: step.command,
      exit_code: result.exitCode ?? -1,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      status: result.status,
      log_path: logFile,
      timeout_s: step.timeoutSec,
      attempts: result.attempts ?? 1,
      runner_id: activeExecutor?.runnerId || '',
    })
  } catch { /* step rows are best effort */ }
}

/**
 * `uses: cache` 步骤是宿主侧动作：它打包/解包的是**宿主**的项目目录，而远端 runner 的
 * 构建产物在它自己的 workspace 里，宿主磁盘上根本没有。所以远程构建必须写 pipe.yml 顶层的
 * `cache:`（任务体下发、runner 自己恢复/保存）。这里不改行为，只把这件事在日志里说清楚——
 * 静默缓存一个空目录比报错更坏。
 */
/**
 * M4：把 pipe 里的 `uses: collect` 步骤翻译成任务级的制品声明。
 * 按 stage 取而不是全 pipe 取：runner 每个任务一个干净 workspace（clean:true），
 * build 阶段的产物不会出现在 deploy 阶段的任务里，声明混在一起只会让后者报 ARTIFACT_MISSING。
 */
export function collectDeclarations(pipe, stageId) {
  const stages = Array.isArray(pipe?.stages) ? pipe.stages : []
  const stage = stages.find((item) => item && item.id === stageId)
  if (!stage) return []
  const stepsOf = (job) => (Array.isArray(job?.steps) ? job.steps : [])
  const groups = Array.isArray(stage.jobs) && stage.jobs.length > 0 ? stage.jobs.map(stepsOf) : [stepsOf(stage)]
  const decls = []
  for (const steps of groups) {
    for (const step of steps) {
      // parsePipe 原样保留 pipe.yml 的形状（没有 kind 字段），kind 是 runStep 里现算的；
      // 这里按同一判据认步骤，否则声明永远是空的。
      const isUses = step?.kind === 'uses' || Boolean(step?.uses)
      if (!isUses || step.uses !== 'collect') continue
      const name = String(step.with?.name || '').trim()
      if (!name) continue
      const raw = step.with?.paths
      const paths = (Array.isArray(raw) ? raw : [raw]).map((value) => String(value || '').trim()).filter(Boolean)
      if (paths.length === 0) continue
      decls.push({ name, paths, optional: Boolean(step.with?.optional) })
    }
  }
  return decls
}

export function remoteCollectStepNotice(executor) {
  if (!executor || executor.kind !== 'remote') return ''
  return `uses: collect 由 runner ${executor.runnerId || ''} 执行：它在自己的 workspace 里 glob 声明的 paths，成功后 PUT 回宿主 CAS（本次运行按 digest 认这包字节）`
}

export function remoteCacheStepNotice(executor) {
  if (!executor || executor.kind !== 'remote') return ''
  const id = executor.runnerId || ''
  return `注意：uses: cache 在宿主侧执行，缓存的是宿主的项目目录（runner ${id} 的构建产物不在里面）；远程构建请用 pipe.yml 顶层的 cache: 声明`
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
  secrets = null,
  concurrency = DEFAULT_CONCURRENCY,
  toolchainSetup = null,
  actions = null,
  runnerLiveness = null,
} = {}) {
  // runId 先生成：RELEASE_ID 在 plan 阶段就要能插值，否则产物文件名会是空的。
  // V2-M1：宿主要提前注册 activeRuns（取消要能找到 runId），所以允许传入。
  const runId = runIdOverride || makeRunId(now, random)
  const modelEnv = {
    ...(project?.env || {}),
    branch: project?.branch ?? project?.env?.branch ?? '',
    tag: project?.tag ?? '',
    commit: project?.commit ?? '',
    changed: project?.changed ?? [],
    releaseId: releaseId || runId,
    // secret（extraVars）必须走 env.vars 这一层：planPipeline 只把 `pipe.vars` 与 `env.vars`
    // 合进插值表，摊在 env 顶层等于没传——`${{MY_SECRET}}` 会直接报 PIPE_VAR。
    vars: { ...(project?.env?.vars || {}), ...(extraVars || {}) },
  }
  const plan = planPipeline(pipe, { project, target, env: modelEnv })
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
  /**
   * v3.0-P7 混沌：日志写不进去时（磁盘满、卷被卸载、文件被换）**只喊一次**。
   * 以前这里是裸 appendFileSync 用 try/catch 吞掉：磁盘满之后面板上一个字都不动，
   * 用户看到的就是「设备卡住了」，而真实原因是这条日志根本没落盘。
   * 只喊一次是因为每一行都喊会把同一个事故刷成几十条，反而盖住真正的第一现场。
   * ENOSPC/EDQUOT 要单独说：那种情况下写库、CAS、release 也会跟着失败，
   * 用户需要的是「去清磁盘」，而不是「重启 Host」。
   */
  let logWriteFailed = false
  const noteLogWriteFailure = (error) => {
    if (logWriteFailed) return false
    logWriteFailed = true
    const full = String(error?.code || '') === 'ENOSPC' || String(error?.code || '') === 'EDQUOT'
    return full ? '磁盘满了（' + (error?.message || error || 'ENOSPC') + '）。清出空间后重试——这条运行之后也会继续失败' : (error?.message || String(error || 'unknown'))
  }
  if (logFile) {
    try {
      mkdirSync(join(store.dir, 'logs'), { recursive: true })
      appendFileSync(logFile, '', 'utf8')
    } catch (error) {
      const detail = noteLogWriteFailure(error)
      if (detail) onLog({ runId, stageId: '', index: -1, line: `⚠ 日志无法写入磁盘（${detail}）：这次运行仍会继续，但下面的输出只存在于内存与面板里。` })
    }
  }
  const log = (entry, rawLine) => {
    // 脱敏必须在写文件/推 hub/回调之前——四个出口共用这一行。
    const line = redactLine(rawLine, secrets)
    const lineJobId = entry.jobId || ''
    if (logFile && !logWriteFailed) {
      try {
        appendFileSync(logFile, `${line}\n`, 'utf8')
      } catch (error) {
        const detail = noteLogWriteFailure(error)
        if (detail) onLog({ runId, stageId: '', index: -1, line: `⚠ 日志写入失败（${detail}）：之后的输出不再落盘，只能在本面板看。` })
      }
    }
    // v3.0-P1：并行 job 共享一条主日志必然交错，另存一份按 job 分片的文件，
    // 「这个 job 到底输出了什么」才能单独读。写失败只是少一份副本，不影响运行。
    if (logFile && lineJobId && store?.jobLogPath) {
      try {
        const jobFile = store.jobLogPath(runId, lineJobId)
        mkdirSync(join(jobFile, '..'), { recursive: true })
        appendFileSync(jobFile, `${line}\n`, 'utf8')
      } catch { /* 分片日志是便利副本，写不了就算了 */ }
    }
    try { onLog({ runId, stageId: entry.stageId, index: entry.index, jobId: entry.jobId || '', line }) } catch { /* observer errors are not run errors */ }
    if (hub) {
      try { hub.append(runId, { stageId: entry.stageId, index: entry.index, jobId: entry.jobId || '', line }) } catch { /* hub errors must not kill the run */ }
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
    // v8：配置快照随 run 一起落库。重跑/重试只读这份快照，不重新读仓库文件 ——
    // 否则「昨晚失败的那次到底跑的是哪版 pipe.yml」永远说不清，改完文件重跑还会悄悄换掉行为。
    config_snapshot: pipe?.source || '',
    config_hash: pipe?.hash || '',
  }
  store?.appendRun(runRecord)

  const vars = plan.vars
  // T2 的 `secrets` 上下文：`extraVars` 就是 `secrets.refsForInterpolate()` 交出来的「名字 → 值」表。
  // 另一个入参 `secrets` 是**值列表**（只用于日志脱敏），两者用途不同，别混。
  const secretMap = extraVars || {}
  // runnerLiveness：远端步骤在等结果期间用来判断「那台机器还在不在」的探针（本地执行为 null）。
  // 没有它，派出去的任务只能在超时后失败，而超时原因会把人的注意力引向命令而不是机器。
  // v3.0-P7：步骤级的认领超时。远端 executor 的任务先入队再等某台机器来接，
  // 没有上限的话「没有机器来领」这件事只能靠进程重启收场。本地 spawn 不看这个字段。
  // 云流水线 M2：远端 runner 没有「项目本地目录」，git 项目把源码信息随任务下发，
  // runner 在自己的 workspace 里 checkout。local/非 git 项目 source 为 null，行为不变。
  const source = project?.sourceType === 'git' && project?.repoUrl
    ? { type: 'git', url: String(project.repoUrl), ref: String(project.branch || 'HEAD'), sha: String(project.commit || ''), depth: 1 }
    : null
  // M3：顶层 `cache:` 声明随上下文下发到 executor。宿主侧的 uses: cache 步骤照旧走
  // lib/actions.js；这里给的是「整任务级」缓存——远端 runner 自己恢复/保存，宿主不碰文件。
  const stepContext = { runId, log, store, logFile, activeExecutor, project, vars, signal, executeDeploy, secrets: secretMap, toolchainEnv: null, actions, runnerLiveness, claimTimeoutMs: stepTimeoutSec || 0, source, cache: pipe?.cache || [], collectDecls: (sid) => collectDeclarations(pipe, sid) }

  // 工具链在这里装、在这里断言：放到 runPipeline 之外会让安装失败的构建没有 run 记录，
  // 用户只看到一条 500 和空日志；放进来则失败也是一次可见的、可回看的运行。
  if (typeof toolchainSetup === 'function') {
    log({ stageId: '', index: -1 }, `准备工具链：${pipe?.toolchain ? Object.entries(pipe.toolchain).filter(([k]) => k !== 'infer_from_files').map(([k, v]) => `${k}=${v}`).join(', ') : ''}`)
    let prepared = null
    try {
      prepared = await toolchainSetup({ log, runId, store, project })
    } catch (error) {
      const message = `工具链准备失败：${error.message}`
      log({ stageId: '', index: -1 }, message)
      store?.appendRun({ ...runRecord, finished_at: new Date().toISOString(), status: 'failed', error: message })
      if (hub) hub.end(runId, 'failed')
      return { runId, status: 'failed', stages: [], plan, jobs: null, error: message, code: error.code || '' }
    }
    if (prepared) {
      stepContext.toolchainEnv = prepared.envFor
      log({ stageId: '', index: -1 }, `工具链就绪：${prepared.describe || ''}`)
    }
  }

  // v2 走 DAG；v1 保持原来的 stage 串行循环（零行为改动）。
  const isV2 = (pipe?.version ?? 1) === 2 || (pipe?.stages || []).some((item) => Array.isArray(item.jobs) && item.jobs.length > 0)
  const outcome = isV2
    ? await runJobGraph({ pipe, project, target, stages, stage, runId, hub, store, runRecord, vars, signal, stepContext, concurrency, modelEnv })
    : await runStageLoop({ stages, runId, hub, store, runRecord, stepContext })

  // v3.0-P7 混沌：日志一直写不进去时，这条运行不能算成功。
  // 磁盘满会让 appendRun / CAS / release 目录同时失败——上面几步「看起来跑完了」只是
  // 因为命令在内存里跑完。此时如实报失败，用户才知道要去清磁盘，而不是拿到一次绿色发布。
  const diskBlocked = logWriteFailed && String(outcome.status) === 'success'
  if (diskBlocked) {
    log({ stageId: '', index: -1 }, '⚠ 这次运行被判为失败：日志无法落盘（磁盘满或目录不可写），同一块盘上的运行记录与发布产物也不可能写成功。')
  }
  const finalStatus = diskBlocked ? 'failed' : outcome.status
  const finalError = diskBlocked ? (outcome.error || '磁盘写不进去：日志无法落盘，发布产物与运行记录同样写不了') : outcome.error
  if (hub) hub.end(runId, finalStatus)
  try {
    store?.appendRun({ ...runRecord, finished_at: new Date().toISOString(), status: finalStatus, error: finalError })
  } catch (error) {
    // v3.0-P7：库也写不进去时不能再抛——finally 里的收尾（取消进程、标失败）还没跑。
    log({ stageId: '', index: -1 }, `⚠ 运行记录也没写进去（${error?.message || error}）：这次运行的结果只存在于内存里。`)
  }
  return { runId, status: finalStatus, stages: outcome.stages, plan, jobs: outcome.jobs || null, code: diskBlocked ? 'DISK_FULL' : '' }
}

/* ------------------------------------------------------------------------------------------------
 * v1：stage 串行、step 串行
 * ---------------------------------------------------------------------------------------------- */

async function runStageLoop({ stages, runId, hub, store, runRecord, stepContext }) {
  const { signal, log } = stepContext
  const stageResults = []
  const failedStages = new Set()

  const cancel = () => {
    store?.appendRun({ ...runRecord, finished_at: new Date().toISOString(), status: 'canceled', error: '已取消' })
    return { status: 'canceled', error: '已取消', stages: stageResults }
  }

  for (const item of stages) {
    if (signal?.aborted) return cancel()
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
    const stageFinalizers = []
    const stageCtx = { ...stepContext, finalize: (fn) => stageFinalizers.push(fn) }
    let stageFailed = false
    let canceled = false
    for (const step of item.steps) {
      if (signal?.aborted) { canceled = true; break }
      const result = await runStep({ step, stageId: item.id, jobId: '', ctx: stageCtx })
      stepResults.push(result)
      // 取消的 step 也要留一行：否则日志里有「已取消」，store 里却查不到是哪一步被取消的。
      recordStep({ store, runId, stageId: item.id, jobId: '', step, result, logFile: stepContext.logFile, activeExecutor: stepContext.activeExecutor })
      if (result.status === 'canceled') { canceled = true; break }
      // 只有 failed 才拖垮 stage：skipped 是「这一步没有可做的事」
      // （远程构建把 uses: collect 交给 runner、干跑不执行动作），不是失败。
      if (result.status === 'failed' && !step.allowFailure) { stageFailed = true; break }
    }
    if (canceled) {
      await flushFinalizers(stageFinalizers, log, { stageId: item.id, jobId: '' })
      stageResults.push({ id: item.id, status: 'canceled', durationMs: Date.now() - stageStarted, steps: stepResults })
      return cancel()
    }
    await flushFinalizers(stageFinalizers, log, { stageId: item.id, jobId: '' })
    const stageStatus = stageFailed ? 'failed' : 'success'
    stageResults.push({ id: item.id, status: stageStatus, durationMs: Date.now() - stageStarted, steps: stepResults })
    if (stageFailed) failedStages.add(item.id)
  }

  const status = stageResults.some((item) => item.status === 'failed') ? 'failed' : 'success'
  return { status, error: status === 'failed' ? '有 stage 失败' : '', stages: stageResults }
}

/* ------------------------------------------------------------------------------------------------
 * v2：job 图 + 并发池
 * ---------------------------------------------------------------------------------------------- */

/**
 * 把 model 归一化出的 job 变成可执行计划：每个 job 的 steps 依次跑，前一个失败（且不允许失败）
 * 就停掉这个 job。
 *
 * T2 求值在这里做（真正执行命令的时刻）：`${{ ... }}` 能读 secrets，因为这一刻正是值要交给
 * 子进程的瞬间，而 T1（进不进图）发生在建 run 之前，那时读 secrets 会把密钥写进 run 记录。
 */
function buildJobSteps(job, context) {
  const planSteps = []
  for (let index = 0; index < job.steps.length; index += 1) {
    const step = job.steps[index]
    if (step.when && !evaluateCondition(step.when, context, { tier: 't2' })) continue
    const kind = step.deploy ? 'deploy' : (step.uses ? 'uses' : 'run')
    planSteps.push({
      index,
      jobId: job.id,
      name: step.name || (kind === 'deploy' ? `部署 ${step.deploy?.target || ''}` : `第 ${index + 1} 步`),
      kind,
      command: kind === 'deploy'
        ? `deploy:${step.deploy?.target || ''}`
        : (kind === 'uses' ? `uses:${step.uses}` : evaluateTemplate(step.run, context, { tier: 't2' })),
      uses: step.uses || '',
      with: step.with || null,
      when: '',
      manual: false,
      timeoutSec: step.timeoutSec || job.timeoutSec || 0,
      retries: step.retries || 0,
      allowFailure: Boolean(step.allowFailure),
      deploy: step.deploy ? {
        target: step.deploy.target || '',
        artifacts: Array.isArray(step.deploy.artifacts) ? step.deploy.artifacts : [],
        activate: step.deploy.activate || 'symlink',
        keep: Number.isInteger(step.deploy.keep) && step.deploy.keep > 0 ? step.deploy.keep : 5,
      } : null,
      source: step.source || step,
    })
  }
  // job 自己带 deploy（v2 的 job.deploy 写法）时补一个部署 step
  if (job.deploy && planSteps.every((step) => step.kind !== 'deploy')) {
    planSteps.push({
      index: planSteps.length,
      jobId: job.id,
      name: `部署 ${job.deploy.target || ''}`,
      kind: 'deploy',
      command: `deploy:${job.deploy.target || ''}`,
      uses: '',
      with: null,
      when: '',
      manual: false,
      timeoutSec: job.timeoutSec || 0,
      retries: 0,
      allowFailure: false,
      deploy: {
        target: job.deploy.target || '',
        artifacts: Array.isArray(job.deploy.artifacts) ? job.deploy.artifacts : [],
        activate: job.deploy.activate || 'symlink',
        keep: job.deploy.keep || 5,
      },
      source: job.source || job,
    })
  }
  return planSteps
}

async function runJobGraph({ pipe, project, target, stages, stage, runId, hub, store, runRecord, vars, signal, stepContext, concurrency, modelEnv }) {
  const model = normalizeModel(pipe, {
    branch: modelEnv.branch,
    tag: modelEnv.tag,
    vars: modelEnv.vars,
    env: modelEnv,
    project: { id: project?.id || '', path: project?.path || '' },
    target: target || '',
  })

  // `stage:` 选择器：只跑该 stage 及其上游依赖的 job（与 v1 的 selectedStages 语义一致）。
  let jobs = model.jobs
  if (stage) {
    const wanted = new Set(stages.map((item) => item.id))
    const visible = new Set()
    for (const item of model.stages) if (wanted.has(item.id)) for (const id of item.jobIds) visible.add(id)
    const byId = new Map(model.jobs.map((job) => [job.id, job]))
    const close = (id) => {
      if (visible.has(id) && id !== undefined && byId.has(id)) return
      if (!byId.has(id)) return
      visible.add(id)
      for (const need of byId.get(id).needs || []) close(need)
    }
    for (const id of [...visible]) close(id)
    jobs = model.jobs.filter((job) => visible.has(job.id))
  }

  const jobResults = new Map()
  const results = await scheduleJobs({
    jobs,
    concurrency,
    signal,
    onSkip: (job, reason) => {
      stepContext.log({ stageId: job.stage || '', jobId: job.id, index: -1 }, `跳过 job ${job.id}：${reason}`)
    },
    runJob: async (job) => {
      const context = {
        vars,
        variables: vars,
        secrets: stepContext.secrets || {},
        matrix: job.matrix || {},
        matrixContext: job.matrixContext || {},
        env: job.env || {},
        project: { id: project?.id || '', path: project?.path || '', branch: modelEnv.branch, commit: modelEnv.commit },
        job: { id: job.id, base: job.baseId || job.id, kind: job.kind },
        target: target || '',
        stage: job.stage || '',
        needs: Object.fromEntries((job.needs || []).map((need) => [need, jobResults.get(need)?.status || ''])),
        steps: {},
        outputs: {},
      }
      const steps = buildJobSteps(job, context)
      const started = Date.now()
      const stepResults = []
      // 动作的收尾钩子按 job 分队列：cache 保存要等这个 job 的 build 跑完，
      // 而不是等整条流水线（否则后面的阶段会读到还没写出来的产物）。
      const finalizers = []
      const jobCtx = { ...stepContext, finalize: (fn) => finalizers.push(fn) }
      for (const step of steps) {
        if (signal?.aborted) {
          return { status: 'canceled', error: '已取消', durationMs: Date.now() - started, steps: stepResults, state: 'canceled' }
        }
        const result = await runStep({ step, stageId: job.stage || '', jobId: job.id, ctx: jobCtx })
        stepResults.push(result)
        recordStep({
          store, runId, stageId: job.stage || '', jobId: job.id, step, result,
          logFile: stepContext.logFile, activeExecutor: stepContext.activeExecutor,
        })
        if (result.status === 'canceled') {
          await flushFinalizers(finalizers, stepContext.log, { stageId: job.stage || '', jobId: job.id })
          return { status: 'canceled', error: '已取消', durationMs: Date.now() - started, steps: stepResults, state: 'canceled' }
        }
        if (result.status === 'failed' && !step.allowFailure) {
          const failure = {
            status: 'failed',
            error: result.error || `步骤 ${step.name} 失败（exit ${result.exitCode}）`,
            durationMs: Date.now() - started,
            steps: stepResults,
            state: 'failed',
          }
          // 先落进 jobResults，下游 job 的 `needs` 才能读到「上游失败了」而不是空字符串。
          jobResults.set(job.id, failure)
          await flushFinalizers(finalizers, stepContext.log, { stageId: job.stage || '', jobId: job.id })
          return failure
        }
      }
      await flushFinalizers(finalizers, stepContext.log, { stageId: job.stage || '', jobId: job.id })
      const failed = stepResults.some((item) => item.status === 'failed' && !item.allowFailure)
      const skipped = stepResults.some((item) => item.status === 'skipped')
      const status = failed ? 'failed' : 'success'
      return {
        status,
        error: failed ? '有步骤失败' : '',
        durationMs: Date.now() - started,
        steps: stepResults,
        state: statusToState(status, skipped && !failed),
      }
    },
  })

  // 按 stage 归组，保持 index.js 里 `run.stages.flatMap(s => s.steps)` 的形状不变。
  const stageOrder = [...new Set(model.jobs.map((job) => job.stage || ''))]
  const stageResults = stageOrder.map((stageId) => {
    const stageJobs = model.jobs.filter((job) => (job.stage || '') === stageId)
    const steps = stageJobs.flatMap((job) => results.get(job.id)?.steps || [])
    const statuses = stageJobs.map((job) => results.get(job.id)?.status || 'failed')
    const status = statuses.includes('failed') ? 'failed'
      : (statuses.includes('canceled') ? 'canceled'
        : (statuses.includes('skipped') ? 'skipped' : 'success'))
    return {
      id: stageId,
      status,
      durationMs: stageJobs.reduce((total, job) => Math.max(total, results.get(job.id)?.durationMs || 0), 0),
      steps,
    }
  })

  const overall = stageResults.some((item) => item.status === 'failed') ? 'failed'
    : (stageResults.some((item) => item.status === 'canceled') ? 'canceled' : 'success')

  return {
    status: overall,
    error: overall === 'canceled' ? '已取消' : (overall === 'failed' ? '有 job 失败' : ''),
    stages: stageResults,
    jobs: {
      concurrency,
      order: model.order.map((job) => job.id),
      items: model.jobs.map((job) => ({
        id: job.id,
        baseId: job.baseId || job.id,
        stage: job.stage || '',
        kind: job.kind,
        needs: job.needs || [],
        matrix: job.matrix || null,
        status: results.get(job.id)?.status || 'failed',
        state: results.get(job.id)?.state || 'failed',
        error: results.get(job.id)?.error || '',
        durationMs: results.get(job.id)?.durationMs || 0,
      })),
    },
  }
}
