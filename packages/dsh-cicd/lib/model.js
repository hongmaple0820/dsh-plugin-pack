/**
 * 流水线模型归一化（v3.0-P1）。
 *
 * 一件事：把「用户写的 pipe.yml」变成「调度器能跑的 job 图」。
 *
 * ## 为什么要单独一层
 *
 * v1 的执行单位是 stage（`lib/runner.js` 里 `for (const item of stages)`），
 * 所以并行、矩阵、单 job 重试、按 job 分片的日志全都做不了——不是缺代码，是数据模型里
 * 没有那个粒度。这里把 stage 归一化成 job：
 *
 * - v1（`stages[].steps[]`）→ 每个 stage 生成一个 job `<stage>-main`，steps 原样保留；
 * - v1 里的 `step.deploy` → 拆成独立 `kind: deploy` 的 job，`needs: [<stage>-main]`；
 * - v2（`stages[].jobs[]`）→ 原样展开，每个 job 拿自己的 needs；
 * - `matrix` 在 T1 展开成多个实例，id 是 `job[key=value,key=value]`。
 *
 * **v1 文件零改动**：`normalizeModel()` 认 `version: 1` 就自动包装，用户不用迁移。
 *
 * ## job 与 stage 的关系
 *
 * Stage 保留，但只做两件事：UI 分组、以及「没写 needs 的 job 默认依赖上一个 stage 的所有 job」。
 * 一旦任何 job 显式写了 `needs`，顺序完全由 DAG 决定（GitLab 语义）。
 */

import { PipeError } from './pipe.js'
import { evaluateCondition, evaluateTemplate, assertTier } from './expr.js'

export const JOB_KINDS = ['build', 'deploy', 'verify', 'manual']
export const MATRIX_MAX_INSTANCES = 64
export const MATRIX_MAX_DIMS = 3

/** 默认值集中在这里，UI 与文档都引用同一份，避免「文档说 30m 代码写 10m」。 */
export const JOB_DEFAULTS = {
  timeout: '30m',
  retries: 0,
  allowFailure: false,
  kind: 'build',
}

/* ------------------------------------------------------------------------------------------------
 * matrix 展开
 * ---------------------------------------------------------------------------------------------- */

/** `{java: ['17','21'], os: ['linux']}` → `[{java:'17',os:'linux'}, {java:'21',os:'linux'}]` */
export function expandMatrix(matrix, exclude = []) {
  if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix)) {
    throw new PipeError('matrix 必须是 map', { code: 'PIPE_MATRIX_TOO_LARGE' })
  }
  const keys = Object.keys(matrix)
  if (keys.length === 0) return [{}]
  if (keys.length > MATRIX_MAX_DIMS) {
    throw new PipeError(`matrix 维度 ${keys.length} 超过上限 ${MATRIX_MAX_DIMS}`, { code: 'PIPE_MATRIX_TOO_LARGE' })
  }
  for (const key of keys) {
    const values = matrix[key]
    if (!Array.isArray(values) || values.length === 0) {
      throw new PipeError(`matrix.${key} 必须是非空数组`, { code: 'PIPE_MATRIX_TOO_LARGE' })
    }
  }
  let combos = [{}]
  for (const key of keys) {
    const next = []
    for (const combo of combos) {
      for (const value of matrix[key]) next.push({ ...combo, [key]: value })
    }
    combos = next
    if (combos.length > MATRIX_MAX_INSTANCES) {
      throw new PipeError(
        `matrix 展开出 ${combos.length} 个实例，超过上限 ${MATRIX_MAX_INSTANCES}（当前维度：${keys.join(' × ')}）`,
        { code: 'PIPE_MATRIX_TOO_LARGE' },
      )
    }
  }
  const excluded = Array.isArray(exclude) ? exclude : []
  const kept = combos.filter((combo) => !excluded.some((rule) => {
    if (!rule || typeof rule !== 'object') return false
    return Object.entries(rule).every(([key, value]) => String(combo[key]) === String(value))
  }))
  if (kept.length === 0) {
    throw new PipeError('matrix 的 exclude 把所有实例都排除了', { code: 'PIPE_MATRIX_TOO_LARGE' })
  }
  return kept
}

/** 实例 id：`unit[java=17,os=linux]`；单实例（无 matrix）就是原 id。 */
export function matrixInstanceId(jobId, combo) {
  const keys = Object.keys(combo || {}).sort()
  if (keys.length === 0) return jobId
  return `${jobId}[${keys.map((key) => `${key}=${combo[key]}`).join(',')}]`
}

/* ------------------------------------------------------------------------------------------------
 * 时长解析（与 pipe.js 的 parseDuration 一致，这里单独导出供 job 级使用）
 * ---------------------------------------------------------------------------------------------- */

export function durationSeconds(value, fallbackSec = 1800) {
  if (value === undefined || value === null || value === '') return fallbackSec
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
  if (typeof value === 'string') {
    const text = value.trim()
    if (/^\d+$/.test(text)) return Number(text)
    const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(text)
    if (match) {
      const factor = match[2] === 'ms' ? 0.001 : match[2] === 'm' ? 60 : match[2] === 'h' ? 3600 : 1
      return Math.max(1, Math.floor(Number(match[1]) * factor))
    }
  }
  throw new PipeError(`时长 “${value}” 无法解析（支持 30、30s、5m、1h）`, { code: 'PIPE_INVALID' })
}

/* ------------------------------------------------------------------------------------------------
 * 归一化
 * ---------------------------------------------------------------------------------------------- */

function asStringArray(value, label) {
  if (value === undefined || value === null || value === '') return []
  const list = Array.isArray(value) ? value : [value]
  return list.map((item) => {
    if (typeof item !== 'string' || !item.trim()) throw new PipeError(`${label} 必须是非空字符串`, { code: 'PIPE_INVALID' })
    return item.trim()
  })
}

/** v1 的一个 step → v2 的 step 形状（`run` / `uses` 二选一，deploy 单独成 job）。 */
function normalizeStep(step, label) {
  const hasRun = typeof step.run === 'string' && step.run.trim() !== ''
  const hasUses = typeof step.uses === 'string' && step.uses.trim() !== ''
  const hasDeploy = step.deploy !== undefined && step.deploy !== null
  if (!hasRun && !hasUses && !hasDeploy) throw new PipeError(`${label} 必须有 run 或 uses`, { code: 'PIPE_INVALID' })
  if ([hasRun, hasUses, hasDeploy].filter(Boolean).length > 1) throw new PipeError(`${label} 不能同时有 run 与 uses`, { code: 'PIPE_INVALID' })
  return {
    name: typeof step.name === 'string' && step.name.trim() ? step.name.trim() : '',
    run: hasRun ? step.run : '',
    uses: hasUses ? step.uses.trim() : '',
    deploy: hasDeploy && typeof step.deploy === 'object' ? step.deploy : null,
    with: step.with && typeof step.with === 'object' && !Array.isArray(step.with) ? step.with : null,
    env: step.env && typeof step.env === 'object' ? step.env : null,
    cwd: typeof step.cwd === 'string' ? step.cwd : '',
    shell: typeof step.shell === 'string' ? step.shell : '',
    timeout: step.timeout,
    timeoutSec: step.timeout === undefined ? 0 : durationSeconds(step.timeout, 600),
    retries: Number.isInteger(step.retries) && step.retries >= 0 ? step.retries : 0,
    allowFailure: Boolean(step.allow_failure ?? step.allowFailure),
    when: typeof step.when === 'string' ? step.when : '',
    source: step,
  }
}

function normalizeDeployJob(stage, step, index, baseNeeds, ordinal) {
  const deploy = step.deploy || {}
  const targetName = typeof deploy.target === 'string' ? deploy.target.trim() : ''
  if (!targetName) throw new PipeError(`stage ${stage.id} 的第 ${index + 1} 个 step 的 deploy 缺少 target`, { code: 'PIPE_INVALID' })
  // id 用「本 stage 里第几个 deploy」（不是第几个 step）：`release-deploy`、`release-deploy-2`。
  // 混用 step 序号会出现 `release-deploy-2` 指代「第 2 个 step」，而它其实是该 stage 唯一一次部署。
  return {
    id: `${stage.id}-deploy${ordinal > 1 ? `-${ordinal}` : ''}`,
    kind: 'deploy',
    stage: stage.id,
    needs: baseNeeds,
    needsExplicit: false,
    matrix: null,
    matrixValues: null,
    when: typeof step.when === 'string' ? step.when : '',
    if: '',
    timeoutSec: durationSeconds(step.timeout, 1800),
    retries: 0,
    allowFailure: false,
    env: null,
    cwd: '',
    steps: [],
    deploy: {
      target: targetName,
      artifacts: asStringArray(deploy.artifacts, `stage ${stage.id} 第 ${index + 1} 个 deploy 的 artifacts`),
      activate: deploy.activate || 'symlink',
      keep: Number.isInteger(deploy.keep) && deploy.keep > 0 ? deploy.keep : 5,
    },
    artifacts: null,
    manual: Boolean(step.manual ?? stage.manual),
    source: step,
  }
}

/**
 * v1（或「没有 jobs[] 的 stage」）→ 一个 stage 一个 build job + 每个 deploy step 一个 deploy job。
 */
function jobsFromStageSteps(stage, stageJobIds, previousStageJobIds) {
  // 注意别和 v2 的 `previousStageJobIds` 搞混：`stageJobIds` 是「stage id → 该 stage 的 job」，
  // 只用于解析显式写的 `needs: [stageId]`；「没写 needs 就依赖上一个 stage」必须读 __prev__，
  // 那个键只在 `previousStageJobIds` 上维护。读错 map 的后果是 v1 的 stage 之间全部解耦，
  // 模型图看起来每个 stage 都能同时跑。
  const baseNeeds = stage.needs.length > 0
    ? stage.needs.flatMap((need) => stageJobIds.get(need) || [])
    : (previousStageJobIds.get('__prev__') || [])
  const buildSteps = []
  const deploySteps = []
  for (let index = 0; index < stage.steps.length; index += 1) {
    const step = stage.steps[index]
    if (step.deploy !== undefined) {
      deploySteps.push({ step, index, ordinal: deploySteps.length + 1 })
      continue
    }
    buildSteps.push(normalizeStep(step, `stage ${stage.id} 的第 ${index + 1} 个 step`))
  }
  const jobs = []
  const mainId = `${stage.id}-main`
  if (buildSteps.length > 0) {
    jobs.push({
      id: mainId,
      kind: 'build',
      stage: stage.id,
      needs: baseNeeds,
      needsExplicit: false,
      matrix: null,
      matrixValues: null,
      when: typeof stage.when === 'string' ? stage.when : '',
      if: '',
      timeoutSec: durationSeconds(stage.timeout, 1800),
      retries: 0,
      allowFailure: Boolean(stage.allow_failure ?? stage.allowFailure),
      env: stage.env && typeof stage.env === 'object' ? stage.env : null,
      cwd: '',
      steps: buildSteps,
      deploy: null,
      artifacts: null,
      manual: Boolean(stage.manual),
      source: stage,
    })
  }
  // deploy 必须排在「本 stage 的构建」之后；本 stage 没有构建步骤就跟 stage 的前置依赖对齐。
  const deployNeeds = buildSteps.length > 0 ? [mainId] : baseNeeds
  for (const item of deploySteps) {
    jobs.push(normalizeDeployJob(stage, item.step, item.index, deployNeeds, item.ordinal))
  }
  if (jobs.length === 0) {
    throw new PipeError(`stage ${stage.id} 没有任何可执行的 step`, { code: 'PIPE_INVALID' })
  }
  return jobs
}

/** v2 的一个 job 描述 → 归一化 job（matrix 稍后展开）。 */
function normalizeJob(stage, job, previousStageJobIds) {
  const id = typeof job.id === 'string' ? job.id.trim() : ''
  if (!id) throw new PipeError(`stage ${stage.id} 里有一个 job 缺少 id`, { code: 'PIPE_INVALID' })
  const explicit = job.needs !== undefined && job.needs !== null
  const needs = explicit
    ? asStringArray(job.needs, `job ${id} 的 needs`).map((need) => need.replace(/^stage:/, ''))
    : (previousStageJobIds.get(stage.id === '' ? '__last__' : '__prev__') || [])
  const steps = Array.isArray(job.steps) ? job.steps.map((step, index) => normalizeStep(step, `job ${id} 的第 ${index + 1} 个 step`)) : []
  const deploySpec = job.deploy && typeof job.deploy === 'object' ? job.deploy : null
  if (steps.length === 0 && !deploySpec) {
    throw new PipeError(`job ${id} 既没有 steps 也没有 deploy`, { code: 'PIPE_INVALID' })
  }
  const kind = deploySpec ? 'deploy' : (JOB_KINDS.includes(job.kind) ? job.kind : JOB_DEFAULTS.kind)
  return {
    id,
    kind,
    stage: stage.id,
    needs,
    needsExplicit: explicit,
    matrix: job.matrix && typeof job.matrix === 'object' ? job.matrix : null,
    matrixValues: job.matrix && typeof job.matrix === 'object' ? job.matrix : null,
    matrixExclude: Array.isArray(job.matrix?.exclude) ? job.matrix.exclude : [],
    when: typeof job.when === 'string' ? job.when : '',
    if: typeof job.if === 'string' ? job.if : '',
    timeoutSec: durationSeconds(job.timeout, durationSeconds(JOB_DEFAULTS.timeout, 1800)),
    retries: Number.isInteger(job.retries) && job.retries >= 0 ? job.retries : JOB_DEFAULTS.retries,
    allowFailure: Boolean(job.allow_failure ?? job.allowFailure ?? JOB_DEFAULTS.allowFailure),
    env: job.env && typeof job.env === 'object' ? job.env : null,
    cwd: typeof job.cwd === 'string' ? job.cwd : '',
    steps,
    deploy: deploySpec ? {
      target: typeof deploySpec.target === 'string' ? deploySpec.target.trim() : '',
      artifacts: asStringArray(deploySpec.artifacts, `job ${id} 的 deploy.artifacts`),
      activate: deploySpec.activate || 'symlink',
      keep: Number.isInteger(deploySpec.keep) && deploySpec.keep > 0 ? deploySpec.keep : 5,
      environment: typeof deploySpec.environment === 'string' ? deploySpec.environment : '',
      strategy: deploySpec.strategy || null,
    } : null,
    artifacts: job.artifacts && typeof job.artifacts === 'object'
      ? {
        paths: asStringArray(job.artifacts.paths ?? job.artifacts, `job ${id} 的 artifacts`),
        name: typeof job.artifacts.name === 'string' ? job.artifacts.name : '',
      }
      : null,
    manual: Boolean(job.manual),
    source: job,
  }
}

/**
 * 把 parsePipe 的结果归一化成 job 图。
 *
 * @param {object} pipe parsePipe 的返回值
 * @param {object} options `{ branch, tag, env, paths, vars, matrixContext }` —— T1 求值上下文
 * @returns {{jobs: object[], stages: object[], order: string[], graph: Map<string, string[]>, byId: Map<string, object>}}
 */
export function normalizeModel(pipe, options = {}) {
  if (!pipe || !Array.isArray(pipe.stages)) throw new PipeError('normalizeModel 需要 parsePipe 的结果', { code: 'PIPE_INVALID' })
  const version = pipe.version ?? 1
  const context = {
    branch: options.branch ?? '',
    tag: options.tag ?? '',
    event: options.event ?? '',
    paths: Array.isArray(options.paths) ? options.paths : [],
    vars: { ...(pipe.vars || {}), ...(options.vars || {}) },
    variables: { ...(pipe.vars || {}), ...(options.vars || {}) },
    env: options.env ?? {},
    project: options.project ?? {},
    target: options.target ?? '',
  }

  const jobs = []
  const stages = []
  /** stage id → 该 stage 所有 job 的 id（v2 里一个 stage 可以多个 job） */
  const stageJobIds = new Map()
  /** 上一个 stage 的全部 job id，供「没写 needs」的 job 默认挂载 */
  const previousStageJobIds = new Map()

  for (const stage of pipe.stages) {
    const stageJobs = []
    // T1 的 when：不满足直接整 stage 不进图（与 v1 的 stage.when 语义一致）
    const stageVisible = stage.when === undefined || stage.when === null || stage.when === ''
      ? true
      : evaluateCondition(stage.when, context, { tier: 't1' })

    // 默认 needs：本 stage 没写 needs 时，依赖上一个 stage 的全部 job
    if (stage.needs.length > 0) {
      previousStageJobIds.set('__prev__', stage.needs.flatMap((need) => stageJobIds.get(need) || []))
    } else {
      previousStageJobIds.set('__prev__', previousStageJobIds.get('__last__') || [])
    }

    if (Array.isArray(stage.jobs) && stage.jobs.length > 0) {
      for (const rawJob of stage.jobs) {
        const job = normalizeJob(stage, rawJob, previousStageJobIds)
        if (!stageVisible) continue
        const visibility = job.when ? evaluateCondition(job.when, context, { tier: 't1' }) : true
        if (!visibility) continue
        // matrix 展开
        const combos = job.matrix ? expandMatrix(job.matrix, job.matrixExclude || []) : [{}]
        for (const combo of combos) {
          const instanceId = matrixInstanceId(job.id, combo)
          const instanceContext = { ...context, matrix: combo, job: { id: instanceId, base: job.id } }
          stageJobs.push({
            ...job,
            id: instanceId,
            baseId: job.id,
            matrix: Object.keys(combo).length > 0 ? combo : null,
            matrixContext: combo,
            env: job.env ? evaluateEnvMap(job.env, instanceContext) : null,
          })
        }
      }
    } else if (Array.isArray(stage.steps) && stage.steps.length > 0) {
      // v1 路径
      const built = jobsFromStageSteps(stage, stageJobIds, previousStageJobIds)
      if (stageVisible) {
        for (const job of built) {
          const visibility = job.when ? evaluateCondition(job.when, context, { tier: 't1' }) : true
          if (visibility) stageJobs.push({ ...job, baseId: job.id, matrixContext: {} })
        }
      }
    } else {
      throw new PipeError(`stage ${stage.id} 既没有 steps 也没有 jobs`, { code: 'PIPE_INVALID' })
    }

    if (stageJobs.length === 0) continue
    stageJobIds.set(stage.id, stageJobs.map((job) => job.id))
    previousStageJobIds.set('__last__', stageJobs.map((job) => job.id))
    // 同 stage 内的 job **互相不依赖**：一个 stage 里写两个 job，本来就是想并行。
    // 需要串行就显式写 needs（跨 stage 或同 stage 的 job id 都行）。
    stages.push({ id: stage.id, jobIds: stageJobs.map((job) => job.id), needs: stage.needs, manual: Boolean(stage.manual) })
    jobs.push(...stageJobs)
  }

  if (jobs.length === 0) throw new PipeError('没有任何 job 会执行（可能全被 when 过滤掉了）', { code: 'PIPE_INVALID' })

  const byId = new Map(jobs.map((job) => [job.id, job]))
  const { graph, order } = resolveJobGraph(jobs)
  return { version, name: pipe.name, jobs, stages, order, graph, byId, vars: context.vars, targets: pipe.targets, triggers: pipe.triggers }
}

/**
 * 把 job 的 `needs` 解析成「真实 job id → 依赖 id 列表」的图，并做拓扑排序。
 *
 * 三种写法都认：
 * - 真实 job id（`unit[java=17]`）
 * - matrix job 的基名（`unit` → 它的全部实例都算依赖，**必须全部跑完**，否则 `needs: [unit]`
 *   只等其中一个实例是随机行为）
 * - stage id 或 `stage:<id>`（→ 该 stage 全部 job）
 *
 * 抽成独立导出是因为 `lib/runner.js` 执行 v2 时也要用同一套解析：两处各写一遍迟早不一致。
 */
export function resolveJobGraph(jobs) {
  const byId = new Map(jobs.map((job) => [job.id, job]))
  const instancesOfBase = new Map()
  for (const job of jobs) {
    if (!job.baseId || job.baseId === job.id) continue
    if (!instancesOfBase.has(job.baseId)) instancesOfBase.set(job.baseId, [])
    instancesOfBase.get(job.baseId).push(job.id)
  }
  /** stage id → 该 stage 的 job id 列表 */
  const stageJobIds = new Map()
  for (const job of jobs) {
    if (!job.stage) continue
    if (!stageJobIds.has(job.stage)) stageJobIds.set(job.stage, [])
    stageJobIds.get(job.stage).push(job.id)
  }

  const graph = new Map()
  for (const job of jobs) {
    const resolved = []
    for (const need of job.needs || []) {
      const bare = String(need).replace(/^stage:/, '')
      if (byId.has(bare)) { resolved.push(bare); continue }
      const instances = instancesOfBase.get(bare)
      if (instances) { resolved.push(...instances); continue }
      const stageIds = stageJobIds.get(bare)
      if (stageIds) { resolved.push(...stageIds); continue }
      throw new PipeError(
        `job ${job.id} 的 needs 指向不存在的 job/stage “${need}”（可用 job：${[...byId.keys()].slice(0, 8).join('、')}${byId.size > 8 ? '…' : ''}）`,
        { code: 'PIPE_UNKNOWN_JOB' },
      )
    }
    // 去重保序，并去掉自依赖；同时回写 job.needs：下游读到的必须是真实 id，不能再是基名
    const unique = [...new Set(resolved)].filter((id) => id !== job.id)
    job.needs = unique
    graph.set(job.id, unique)
  }
  return { graph, order: topologicalJobs(jobs, graph) }
}

function evaluateEnvMap(env, context) {
  const out = {}
  for (const [key, value] of Object.entries(env)) {
    out[key] = typeof value === 'string' ? evaluateTemplate(value, context, { tier: 't1' }) : value
  }
  return out
}

/** 拓扑排序；成环抛 `PIPE_CYCLE` 并给出环路径。 */
export function topologicalJobs(jobs, graph) {
  const state = new Map()
  const order = []
  const byId = new Map(jobs.map((job) => [job.id, job]))
  const visit = (id, trail) => {
    const current = state.get(id)
    if (current === 'done') return
    if (current === 'visiting') {
      const start = trail.indexOf(id)
      const cycle = [...(start >= 0 ? trail.slice(start) : trail), id]
      throw new PipeError(`job 依赖出现环：${cycle.join(' → ')}`, { code: 'PIPE_CYCLE' })
    }
    state.set(id, 'visiting')
    for (const need of graph.get(id) || []) visit(need, [...trail, id])
    state.set(id, 'done')
    order.push(id)
  }
  for (const job of jobs) visit(job.id, [])
  // 返回 job 对象数组，顺序即拓扑序
  return order.map((id) => byId.get(id))
}

/* ------------------------------------------------------------------------------------------------
 * T1 档位预检：把每个 job 的 when/if/插值命令都过一遍白名单
 *
 * 放在「建 run 之前」，这样非法表达式在解析期就失败，一条命令都不跑（04 §14 第 7 条）。
 * ---------------------------------------------------------------------------------------------- */

export function validateExpressions(model) {
  const problems = []
  for (const job of model.jobs) {
    const context = {
      branch: '', tag: '', event: '', paths: [], vars: model.vars || {},
      matrix: job.matrix || {}, env: {}, project: {}, target: '',
    }
    for (const [field, value] of [['when', job.when], ['if', job.if]]) {
      if (!value) continue
      try { assertTier(value, 't1') } catch (error) {
        problems.push({ job: job.id, field, code: error.code || 'PIPE_EXPR', message: error.message })
      }
    }
    for (const step of job.steps) {
      if (!step.run) continue
      const matches = String(step.run).match(/\$\{\{[\s\S]*?\}\}/g) || []
      for (const match of matches) {
        const body = match.slice(3, -2).trim()
        if (/^[A-Za-z_]\w*$/.test(body)) continue // 裸变量：T2 才查，v1 兼容
        try { assertTier(body, 't2') } catch (error) {
          problems.push({ job: job.id, field: 'run', code: error.code || 'PIPE_EXPR', message: error.message })
        }
      }
    }
  }
  return problems
}
