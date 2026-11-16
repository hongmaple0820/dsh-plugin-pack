/**
 * Host half of @local/dsh-cicd — a local-first CI/CD for DSH.
 *
 * 8 tools and 10 GET-only HTTP routes. Builds run locally (child_process); releases reuse the
 * dsh-remote plugin over loopback HTTP, so this package owns no SSH code and no credentials.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative } from 'node:path'
import { parsePipe, planPipeline, interpolate, matchArtifacts, isHostSelector, parseHostSelector } from './lib/pipe.js'
import { createStore, DEFAULT_WORK_DIR } from './lib/store.js'
import { runPipeline } from './lib/runner.js'
import { createRemote } from './lib/remote.js'
import { deployRelease, rollbackRelease } from './lib/deploy.js'
import { dispatchNotifications } from './lib/notify.js'

export const name = '@local/dsh-cicd'
export const inject = ['tools']

const ROUTE_PREFIX = '/api/plugins/cicd'
const CICD_HEADER = 'x-dsh-cicd'
const CICD_HEADER_VALUE = '1'
const WRITE_HEADER = 'x-dsh-remote-exec'

const textBlocks = (text) => [{ type: 'text', text }]

function json(value, status = 200) {
  return Response.json(value, { status })
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function isSameOrigin(request) {
  let origin = null
  try { origin = request.headers?.get?.('origin') || null } catch { origin = null }
  if (!origin) return true
  let source
  try { source = new URL(origin) } catch { return false }
  const hosts = []
  try {
    const target = new URL(request.url)
    if (target.hostname && target.hostname !== 'x') hosts.push(target.hostname)
  } catch { /* the carrier's Request base carries no real host */ }
  try {
    const header = request.headers?.get?.('host')
    if (header) hosts.push(String(header).split(':')[0])
  } catch { /* keep going */ }
  if (hosts.includes(source.hostname)) return true
  return hosts.length > 0 && LOOPBACK_HOSTS.has(source.hostname) && hosts.every((host) => LOOPBACK_HOSTS.has(host))
}

function hasCicdHeader(request) {
  try { return request.headers?.get?.(CICD_HEADER) === CICD_HEADER_VALUE } catch { return false }
}

function queryOf(request) {
  try { return new URL(request.url).searchParams } catch { return new URLSearchParams() }
}

function unsupportedParams(params, allowed) {
  const names = [...new Set([...params.keys()].filter((key) => !allowed.has(key)))]
  return names.length > 0 ? `不支持的查询参数：${names.join('、')}` : null
}

function intParam(params, name, { fallback, min, max }) {
  const raw = params.get(name)
  if (raw === null || raw === '') return { value: fallback }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) return { error: `${name} 必须是 ${min}-${max} 的整数` }
  return { value }
}

function normalizeConfig(config = {}, ctx) {
  const baseConfig = config && typeof config === 'object' ? config : {}
  const workDir = typeof baseConfig.workDir === 'string' && baseConfig.workDir.trim()
    ? baseConfig.workDir.trim()
    : DEFAULT_WORK_DIR
  let remoteBase = baseConfig.remoteBase || ''
  if (typeof remoteBase === 'number') remoteBase = `http://127.0.0.1:${remoteBase}`
  else if (/^\d+$/.test(String(remoteBase))) remoteBase = `http://127.0.0.1:${remoteBase}`
  else remoteBase = String(remoteBase).replace(/\/+$/, '')
  if (!remoteBase) {
    const port = ctx?.get?.('webServer')?.port
    if (port) remoteBase = `http://127.0.0.1:${port}`
  }
  const projects = Array.isArray(baseConfig.projects) ? baseConfig.projects.filter((item) => item && item.id && item.path) : []
  if (projects.length === 0) {
    const cwd = process.cwd()
    const pipePath = join(cwd, 'pipe.yml')
    if (existsSync(pipePath)) {
      projects.push({ id: basename(cwd), name: basename(cwd), path: cwd, pipe: pipePath })
    }
  }
  const rawWebhooks = Array.isArray(baseConfig.notify?.webhooks) ? baseConfig.notify.webhooks : []
  const notifyWebhooks = rawWebhooks
    .filter((item) => item && typeof item === 'object' && typeof item.url === 'string' && /^https?:\/\//i.test(item.url))
    .map((item) => ({
      url: String(item.url),
      secret: typeof item.secret === 'string' ? item.secret : '',
      events: Array.isArray(item.events)
        ? item.events.map((event) => String(event)).filter((event) => event !== '')
        : [],
    }))
  return {
    projects: projects.map((project) => ({
      id: String(project.id),
      name: project.name || String(project.id),
      path: project.path,
      pipe: project.pipe || join(project.path, 'pipe.yml'),
      env: project.env || {},
    })),
    workDir,
    remoteBase,
    defaultTarget: baseConfig.defaultTarget || '',
    stepTimeoutSec: Number.isInteger(baseConfig.stepTimeoutSec) && baseConfig.stepTimeoutSec > 0 ? baseConfig.stepTimeoutSec : 600,
    maxLogBytes: Number.isInteger(baseConfig.maxLogBytes) && baseConfig.maxLogBytes > 0 ? baseConfig.maxLogBytes : 256 * 1024,
    notifyWebhooks,
  }
}

function projectError(projects, id) {
  const error = new Error(`项目 “${id}” 不存在（可用：${projects.map((item) => item.id).join('、') || '无'}）`)
  error.code = 'PROJECT_NOT_FOUND'
  return error
}

function pickProject(options, id) {
  if (!options.projects.length) throw new Error('没有配置任何项目：请在 config.projects 里配置，或把 pipe.yml 放在当前工作目录')
  if (!id) return options.projects[0]
  const project = options.projects.find((item) => item.id === id)
  if (!project) throw projectError(options.projects, id)
  return project
}

function readPipe(project) {
  if (!existsSync(project.pipe)) {
    const error = new Error(`找不到 pipe 文件：${project.pipe}`)
    error.code = 'PIPE_NOT_FOUND'
    throw error
  }
  return parsePipe(readFileSync(project.pipe, 'utf8'), { path: project.pipe })
}

function resolveTarget(pipe, options, name) {
  const targetName = name || options.defaultTarget || Object.keys(pipe.targets)[0] || ''
  if (!targetName) throw Object.assign(new Error('pipe 里没有定义任何 target'), { code: 'PIPE_INVALID' })
  if (!pipe.targets[targetName]) {
    throw Object.assign(new Error(`target “${targetName}” 不存在（可用：${Object.keys(pipe.targets).join('、')}）`), { code: 'TARGET_NOT_FOUND' })
  }
  return { targetName, target: pipe.targets[targetName] }
}

function walkFiles(root, limit = 5000) {
  const result = []
  const visit = (dir) => {
    if (result.length >= limit) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (result.length >= limit) return
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.dsh-cicd') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile()) result.push(relative(root, full).replace(/\\/g, '/'))
    }
  }
  visit(root)
  return result
}

function artifactFor(project, patterns) {
  if (!patterns || patterns.length === 0) return ''
  const files = walkFiles(project.path)
  const matched = matchArtifacts(patterns, files)
  if (matched.length === 0) return ''
  // 多个产物命中时取「最新修改」的那个：按字母序取第一个会把上一次构建的旧包部署上去
  let best = matched[0]
  let bestTime = -Infinity
  for (const rel of matched) {
    try {
      const time = statSync(join(project.path, rel)).mtimeMs
      if (time > bestTime) { bestTime = time; best = rel }
    } catch { /* 拿不到 mtime 就退回第一个命中 */ }
  }
  return join(project.path, best)
}

function clampLog(text, maxBytes) {
  const buffer = Buffer.from(String(text || ''), 'utf8')
  if (buffer.length <= maxBytes) return { text: buffer.toString('utf8'), truncated: false }
  return { text: buffer.subarray(buffer.length - maxBytes).toString('utf8'), truncated: true }
}

function runSummary(run) {
  return {
    id: run.id,
    projectId: run.project_id || '',
    pipelineName: run.pipeline_name || '',
    status: run.status || '',
    target: run.target || '',
    branch: run.branch || '',
    commit: run.commit || '',
    startedAt: run.started_at || '',
    finishedAt: run.finished_at || '',
    error: run.error || '',
  }
}

function publicReleaseId(release) {
  if (!release) return ''
  return release.run_id || release.id || ''
}

function releaseSummary(release) {
  return {
    id: publicReleaseId(release),
    recordId: release.id || '',
    projectId: release.project_id || '',
    target: release.target || '',
    host: release.host || '',
    env: release.env || '',
    runId: release.run_id || '',
    commit: release.commit || '',
    status: release.status || '',
    createdAt: release.created_at || '',
    activatedAt: release.activated_at || '',
    deactivatedAt: release.deactivated_at || '',
  }
}

function createRuntime(ctx, config) {
  const options = normalizeConfig(config, ctx)
  const store = createStore({ dir: options.workDir })
  let remoteClient = null

  function remote() {
    if (remoteClient) return remoteClient
    // 冷启动时 apply 阶段 webServer 可能未就绪（normalizeConfig 拿不到 port，remoteBase 为空）。
    // 首次使用时再取一次 port：取到才缓存客户端，取不到保持可重试的「插件未就绪」错误。
    let base = options.remoteBase
    if (!base) {
      const port = ctx?.get?.('webServer')?.port
      if (port) base = `http://127.0.0.1:${port}`
    }
    const client = createRemote({ base })
    if (base) remoteClient = client
    return client
  }

  function findTargetAnywhere(name) {
    if (!name) throw Object.assign(new Error('必须指定 target'), { code: 'TARGET_NOT_FOUND' })
    for (const project of options.projects) {
      let pipe
      try { pipe = readPipe(project) } catch { continue }
      if (pipe.targets[name]) return { project, pipe, targetName: name, target: pipe.targets[name] }
    }
    throw Object.assign(new Error(`target “${name}” 不在任何项目的 pipe 里`), { code: 'TARGET_NOT_FOUND' })
  }

  function markPreviousSuperseded(targetName, host) {
    const previous = store.activeRelease({ target: targetName, host })
    if (previous && previous.id) {
      store.appendRelease({ ...previous, status: 'superseded', deactivated_at: new Date().toISOString() })
    }
    return previous
  }

  function recordArtifact(runId, filePath) {
    try {
      const stat = statSync(filePath)
      if (!stat.isFile()) return null
      const sha256 = createHash('sha256').update(readFileSync(filePath)).digest('hex')
      store.appendArtifact({ run_id: runId, path: filePath, bytes: stat.size, sha256 })
      return { path: filePath, bytes: stat.size, sha256 }
    } catch { return null }
  }

  // ---- v0.5：env/group/tag 选择器展开 + 生产护栏 + 部署锁 --------------------------------
  const deployLocks = new Map()
  const CATALOG_TTL_MS = 5000
  let catalogCache = null
  let catalogAt = 0

  /** `/hosts` + `/groups` 的合并快照（5 秒缓存，避免 plan/run/targets 各拉一次）。 */
  async function catalog() {
    const now = Date.now()
    if (catalogCache && now - catalogAt < CATALOG_TTL_MS) return catalogCache
    const client = remote()
    const [list, buckets] = await Promise.all([client.hosts(), client.groups()])
    const meta = new Map()
    for (const entry of Array.isArray(list) ? list : []) {
      const alias = String(entry?.alias || '').trim()
      if (!alias) continue
      meta.set(alias, {
        env: String(entry?.env || ''),
        group: String(entry?.group || ''),
        tags: Array.isArray(entry?.tags) ? entry.tags.map((tag) => String(tag)) : [],
      })
    }
    catalogCache = { meta, byKind: { env: buckets.envs, group: buckets.groups, tag: buckets.tags } }
    catalogAt = now
    return catalogCache
  }

  /** 把 target.hosts 里的选择器展开成别名：混写保序，重复别名只留第一次。 */
  async function expandTarget(targetName, target) {
    const entries = Array.isArray(target?.hosts) ? target.hosts.map((host) => String(host).trim()).filter(Boolean) : []
    const selectors = entries.filter((host) => isHostSelector(host))
    const info = await catalog()
    const expanded = []
    for (const entry of entries) {
      const selector = parseHostSelector(entry)
      if (!selector) { expanded.push(entry); continue }
      const bucket = (info.byKind[selector.kind] || []).find((item) => item.name === selector.name)
      const matched = bucket ? bucket.hosts : []
      if (matched.length === 0) {
        throw Object.assign(new Error(`选择器 ${entry} 没有匹配的主机（target ${targetName}）`), { code: 'PIPE_INVALID' })
      }
      expanded.push(...matched)
    }
    const hosts = []
    const seen = new Set()
    for (const host of expanded) {
      if (seen.has(host)) continue
      seen.add(host)
      hosts.push(host)
    }
    const envs = []
    const prodHosts = []
    for (const host of hosts) {
      const env = info.meta.get(host)?.env || ''
      if (env && !envs.includes(env)) envs.push(env)
      if (env === 'prod') prodHosts.push(host)
    }
    return { hosts, selectors, envs, prodHosts, meta: info.meta }
  }

  /** 只读路径（plan/targets）用：dsh-remote 不可用时退化成「只列别名」，但选择器必须展开。 */
  async function tryExpandTarget(targetName, target) {
    try {
      return await expandTarget(targetName, target)
    } catch (error) {
      const selectors = (Array.isArray(target?.hosts) ? target.hosts : []).filter((host) => isHostSelector(host))
      if (selectors.length > 0) throw error
      return {
        hosts: (Array.isArray(target?.hosts) ? target.hosts : []).slice(),
        selectors: [],
        envs: [],
        prodHosts: [],
        meta: new Map(),
        degraded: Boolean(error),
      }
    }
  }

  function prodGuardError(prodHosts, action = '发布') {
    const error = new Error(`这次${action}会改动生产环境（${prodHosts.join('、')}），请带 confirm=prod`)
    error.code = 'PROD_CONFIRM_REQUIRED'
    error.hosts = prodHosts
    return error
  }

  function lockError(targetName) {
    const error = new Error(`target ${targetName} 已经有一次发布在执行，等它结束后再试`)
    error.code = 'DEPLOY_IN_PROGRESS'
    return error
  }

  async function notifyEvent(event, payload) {
    if (!options.notifyWebhooks.length) return []
    let results = []
    try {
      results = await dispatchNotifications({ webhooks: options.notifyWebhooks, event, payload })
    } catch (error) {
      results = [{ index: -1, ok: false, status: 0, error: error.message }]
    }
    for (const item of results) {
      try {
        store.appendOperation({
          action: 'notify',
          project: payload.project || '',
          target: payload.target || '',
          run_id: payload.runId || '',
          release_id: payload.releaseId || '',
          status: item.ok ? 'success' : 'failed',
          detail: { event, index: item.index, ok: item.ok, status: item.status, error: item.error || '', skipped: Boolean(item.skipped) },
        })
      } catch { /* audit must never break a release */ }
    }
    return results
  }

  async function deployStep({ project, step, runId, commit, log }) {
    const { targetName, target } = resolveTargetForStep(project, step)
    // 选择器在部署前展开成真实别名：deploy.js 只认别名清单，不认 env:/group:/tag:。
    const expanded = await expandTarget(targetName, target)
    const deployTarget = { ...target, hosts: expanded.hosts }
    const artifactPath = artifactFor(project, step.deploy?.artifacts || [])
    if (!artifactPath) {
      throw Object.assign(new Error(`stage 的 deploy.artifacts 没有匹配到任何文件（target ${targetName}）`), { code: 'ARTIFACT_NOT_FOUND' })
    }
    const digest = recordArtifact(runId, artifactPath)
    const result = await deployRelease({
      remote: remote(),
      project,
      target: deployTarget,
      targetName,
      artifactPath,
      releaseId: runId,
      keep: step.deploy?.keep || target.keep || 5,
      commit,
      onLog: (line) => { try { log?.(line) } catch { /* log observers must not break a deploy */ } },
      onCanaryHold: ({ waitSec, first, remaining }) => {
        try {
          store.appendOperation({
            action: 'canary-hold',
            project: project.id,
            target: targetName,
            run_id: runId,
            release_id: runId,
            status: 'waiting',
            detail: { waitSec, first, remaining },
          })
        } catch { /* audit is best effort */ }
      },
    })

    // 成功的主机各自一条 release 记录：id 用 <runId>@<host> 保证多主机不互相覆盖，
    // run_id 仍指向用户看到的运行 id。
    const succeeded = result.hosts.filter((item) => item.ok)
    for (const host of succeeded) {
      const previous = markPreviousSuperseded(targetName, host.host)
      store.appendRelease({
        id: `${runId}@${host.host}`,
        project_id: project.id,
        target: targetName,
        host: host.host,
        env: expanded.meta.get(host.host)?.env || '',
        run_id: runId,
        commit,
        artifact_sha256: digest?.sha256 || '',
        created_at: host.activated_at,
        activated_at: host.activated_at,
        deactivated_at: '',
        status: 'active',
        manifest_path: host.releaseDir,
        revisions_offset: 0,
        previous: host.previous || publicReleaseId(previous) || '',
      })
    }
    store.appendOperation({
      action: 'deploy',
      project: project.id,
      target: targetName,
      run_id: runId,
      release_id: result.releaseId,
      status: result.ok ? 'success' : 'failed',
      detail: { target: targetName, releaseId: result.releaseId, ok: result.ok, canary: result.canary, hosts: result.hosts },
    })
    for (const host of result.hosts) {
      store.appendOperation({
        action: host.ok ? 'deploy' : 'deploy-failed',
        project: project.id,
        target: targetName,
        host: host.host,
        run_id: runId,
        release_id: `${runId}@${host.host}`,
        status: host.ok ? 'success' : 'failed',
        detail: { batch: host.batch || 1, health: host.health || '', restarted: host.restarted || '', previous: host.previous || '', error: host.error || '', skipped: Boolean(host.skipped) },
      })
    }

    if (!result.ok) {
      const error = new Error(`部署失败：${result.error || '有主机未完成发布'}`)
      error.code = 'HOST_FAILED'
      error.hosts = result.hosts
      throw error
    }
    return { status: 'success', deploy: result }
  }

  function resolveTargetForStep(project, step) {
    const pipe = readPipe(project)
    const { targetName, target } = resolveTarget(pipe, options, step.deploy?.target || '')
    return { targetName, target }
  }

  async function executeRun({ projectId, targetName, stage = '', dryRun = false, confirmProd = false }) {
    const project = pickProject(options, projectId)
    const pipe = readPipe(project)
    const { targetName: resolvedTarget, target: resolvedSpec } = resolveTarget(pipe, options, targetName)
    // 先展开选择器：生产护栏与部署锁都以「真实会部署到哪些主机」为准。
    const resolution = await tryExpandTarget(resolvedTarget, resolvedSpec)
    if (!dryRun && resolution.prodHosts.length > 0 && !confirmProd) throw prodGuardError(resolution.prodHosts)
    if (!dryRun) {
      if (deployLocks.has(resolvedTarget)) throw lockError(resolvedTarget)
      deployLocks.set(resolvedTarget, { at: new Date().toISOString() })
    }
    try {
      const run = await runPipeline({
        pipe,
        project,
        target: resolvedTarget,
        stage,
        dryRun,
        store,
        stepTimeoutSec: options.stepTimeoutSec,
        executeDeploy: dryRun ? null : (context) => deployStep({ project, step: context.step, runId: context.runId, commit: project.commit || '', log: context.log }),
      })
      if (!dryRun && run.runId) {
        for (const stageInfo of run.stages) {
          for (const step of stageInfo.steps) {
            if (!Array.isArray(step.artifact) || step.artifact.length === 0) continue
            for (const file of matchArtifacts(step.artifact, walkFiles(project.path))) recordArtifact(run.runId, file)
          }
        }
      }
      const releases = run.runId ? store.releases({ target: resolvedTarget, limit: 200 }).filter((release) => release.run_id === run.runId) : []
      const deploySteps = run.stages.flatMap((stageInfo) => stageInfo.steps).filter((step) => step.deploy)
      const canary = deploySteps.find((step) => step.deploy?.canary)?.deploy.canary || { first: 0, waitSec: 0, batches: [] }
      const hostRows = deploySteps.flatMap((step) => (Array.isArray(step.hosts) ? step.hosts : []))
      if (!dryRun && run.runId) {
        await notifyEvent(`run.${run.status === 'failed' ? 'failed' : 'success'}`, {
          at: new Date().toISOString(),
          project: project.id,
          target: resolvedTarget,
          runId: run.runId,
          releaseId: releases.length > 0 ? publicReleaseId(releases[0]) : run.runId,
          status: run.status,
          durationMs: run.stages.reduce((total, stageInfo) => total + (stageInfo.durationMs || 0), 0),
          hosts: hostRows.map((host) => ({
            host: host.host || '',
            ok: Boolean(host.ok),
            batch: host.batch || 1,
            health: host.health || '',
            error: host.error || '',
          })),
          prod: resolution.prodHosts.length > 0,
        })
      }
      return {
        runId: run.runId || '',
        status: run.status,
        project: project.id,
        target: resolvedTarget,
        dryRun: Boolean(dryRun),
        hosts: resolution.hosts,
        selectors: resolution.selectors,
        envs: resolution.envs,
        prodHosts: resolution.prodHosts,
        canary,
        stages: run.stages.map((item) => ({
          id: item.id,
          status: item.status,
          durationMs: item.durationMs || 0,
          steps: item.steps.map((step) => ({
            index: step.index ?? 0,
            name: step.name || '',
            kind: step.kind || 'run',
            status: step.status || '',
            exitCode: Number.isInteger(step.exitCode) ? step.exitCode : -1,
            durationMs: step.durationMs || 0,
            error: step.error || '',
            hosts: (Array.isArray(step.hosts) ? step.hosts : []).map((host) => ({
              host: host.host || '',
              ok: Boolean(host.ok),
              batch: host.batch || 1,
              health: host.health || '',
              restarted: host.restarted || '',
              error: host.error || '',
            })),
          })),
        })),
        releases: releases.map(releaseSummary),
      }
    } finally {
      if (!dryRun) deployLocks.delete(resolvedTarget)
    }
  }

  return {
    options,
    remote,
    store,
    listProjects() {
      return {
        workDir: options.workDir,
        projects: options.projects.map((project) => ({
          id: project.id,
          name: project.name,
          path: project.path,
          pipe: project.pipe,
          hasPipe: existsSync(project.pipe),
        })),
      }
    },
    async plan({ project: projectId, target: targetName } = {}) {
      const project = pickProject(options, projectId)
      const pipe = readPipe(project)
      const { targetName: resolved, target: spec } = resolveTarget(pipe, options, targetName)
      const resolution = await tryExpandTarget(resolved, spec)
      const plan = planPipeline(pipe, { project, target: resolved, env: { ...(project.env || {}), branch: project.branch || '', commit: project.commit || '' } })
      return {
        project: project.id,
        target: resolved,
        name: plan.name,
        hosts: resolution.hosts,
        selectors: resolution.selectors,
        envs: resolution.envs,
        prodHosts: resolution.prodHosts,
        willDeployToProd: resolution.prodHosts.length > 0,
        envsUnknown: Boolean(resolution.degraded) || resolution.hosts.length === 0,
        stages: plan.stages.map((stage) => ({
          id: stage.id,
          needs: stage.needs,
          manual: Boolean(stage.manual),
          steps: stage.steps.map((step) => ({
            index: step.index,
            name: step.name,
            command: step.command,
            kind: step.kind,
            when: step.when || '',
            manual: Boolean(step.manual),
            timeoutSec: step.timeoutSec,
            retries: step.retries,
            allowFailure: Boolean(step.allowFailure),
            target: step.deploy?.target || '',
          })),
        })),
      }
    },
    run: executeRun,
    status({ project: projectId, limit = 20 } = {}) {
      return { runs: store.runs({ project: projectId, limit }).map(runSummary) }
    },
    logs({ runId, tail = 200 } = {}) {
      if (!runId) throw Object.assign(new Error('runId 不能为空'), { code: 'RUN_NOT_FOUND' })
      const run = store.run(runId)
      if (!run) throw Object.assign(new Error(`运行 ${runId} 不存在`), { code: 'RUN_NOT_FOUND' })
      const raw = store.readLog(runId, { tail })
      const clipped = clampLog(raw, options.maxLogBytes)
      const totalLines = raw ? raw.split('\n').length : 0
      return { runId, status: run.status, logPath: store.logPath(runId), totalLines, tail, truncated: clipped.truncated, text: clipped.text }
    },
    releases({ target, host = '', env = '', limit = 20 } = {}) {
      const releases = store.releases({ target, host, env, limit })
      return {
        target: target || '',
        host: host || '',
        env: env || '',
        hosts: [...new Set(releases.map((release) => release.host).filter(Boolean))],
        envs: [...new Set(releases.map((release) => release.env).filter(Boolean))],
        releases: releases.map(releaseSummary),
      }
    },
    async rollback({ target: targetName, releaseId = '', project: projectId, host = '', confirmProd = false } = {}) {
      let found
      if (projectId) {
        const project = pickProject(options, projectId)
        const pipe = readPipe(project)
        const { targetName: resolved, target } = resolveTarget(pipe, options, targetName)
        found = { project, targetName: resolved, target }
      } else {
        found = findTargetAnywhere(targetName)
      }
      const resolution = await expandTarget(found.targetName, found.target)
      if (resolution.prodHosts.length > 0 && !confirmProd) throw prodGuardError(resolution.prodHosts, '回滚')
      const result = await rollbackRelease({
        remote: remote(),
        target: { ...found.target, hosts: resolution.hosts },
        targetName: found.targetName,
        host,
        releaseId,
        commit: found.project.commit || '',
      })
      for (const item of result.hosts.filter((entry) => entry.ok)) {
        markPreviousSuperseded(found.targetName, item.host)
        store.appendRelease({
          id: `${item.releaseId}@${item.host}`,
          project_id: found.project.id,
          target: found.targetName,
          host: item.host,
          env: resolution.meta.get(item.host)?.env || '',
          run_id: '',
          commit: found.project.commit || '',
          artifact_sha256: '',
          created_at: item.activated_at,
          activated_at: item.activated_at,
          deactivated_at: '',
          status: 'active',
          manifest_path: item.releaseDir,
          revisions_offset: 0,
        })
      }
      store.appendOperation({
        action: 'rollback',
        project: found.project.id,
        target: found.targetName,
        status: result.ok ? 'success' : 'failed',
        release_id: result.releaseId || '',
        detail: { target: found.targetName, releaseId: result.releaseId, ok: result.ok, hosts: result.hosts },
      })
      for (const item of result.hosts) {
        store.appendOperation({
          action: 'rollback',
          project: found.project.id,
          target: found.targetName,
          host: item.host,
          release_id: item.releaseId || '',
          status: item.ok ? 'success' : 'failed',
          detail: { releaseId: item.releaseId || '', health: item.health || '', restarted: item.restarted || '', error: item.error || '', code: item.code || '' },
        })
      }
      await notifyEvent(result.ok ? 'rollback.success' : 'rollback.failed', {
        at: new Date().toISOString(),
        project: found.project.id,
        target: found.targetName,
        runId: '',
        releaseId: result.releaseId || '',
        status: result.ok ? 'success' : 'failed',
        durationMs: 0,
        hosts: result.hosts.map((item) => ({
          host: item.host || '',
          ok: Boolean(item.ok),
          batch: item.batch || 1,
          health: item.health || '',
          error: item.error || '',
        })),
        prod: resolution.prodHosts.length > 0,
      })
      return {
        releaseId: result.releaseId,
        ok: result.ok,
        target: found.targetName,
        hosts: result.hosts,
        host: result.host || '',
        health: result.health || '',
        restarted: result.restarted || '',
        error: result.error || '',
        code: result.code || '',
        prodHosts: resolution.prodHosts,
        envs: resolution.envs,
      }
    },
    async targets({ project: projectId } = {}) {
      const project = pickProject(options, projectId)
      const pipe = readPipe(project)
      const entries = Object.entries(pipe.targets)
      // v0.5：目标卡片要显示 env 徽标，这里一次性把选择器展开（dsh-remote 不可用时留空）。
      const resolutions = new Map()
      for (const [targetName, target] of entries) {
        resolutions.set(targetName, await tryExpandTarget(targetName, target).catch(() => null))
      }
      return {
        project: project.id,
        targets: entries.map(([targetName, target]) => {
          const resolution = resolutions.get(targetName)
          const hosts = resolution ? resolution.hosts : target.hosts
          const active = hosts.map((host) => {
            const release = store.activeRelease({ target: targetName, host })
            return { host, releaseId: publicReleaseId(release) }
          })
          return {
            name: targetName,
            hosts,
            selectors: resolution ? resolution.selectors : [],
            envs: resolution ? resolution.envs : [],
            prodHosts: resolution ? resolution.prodHosts : [],
            envsUnknown: !resolution || Boolean(resolution.degraded),
            path: target.path || '',
            runtime: target.runtime || 'static',
            app: target.app || '',
            onHostFailure: target.onHostFailure || 'stop',
            keep: Number.isInteger(target.keep) ? target.keep : 5,
            canary: target.canary || null,
            restartCommand: target.restartCommand || '',
            service: target.service || '',
            restart: target.restart || '',
            health: target.health?.http || '',
            current: active[0]?.releaseId || '',
            active,
          }
        }),
      }
    },
    operations({ project = '', runId = '', limit = 50 } = {}) {
      return { operations: store.operations({ project, runId, limit }) }
    },
    async notifyTest() {
      const configured = options.notifyWebhooks.length
      if (configured === 0) return { ok: true, configured: 0, webhooks: [] }
      const results = await notifyEvent('test', {
        at: new Date().toISOString(),
        project: '',
        target: '',
        runId: '',
        releaseId: '',
        status: 'test',
        durationMs: 0,
        hosts: [],
        prod: false,
      })
      return { ok: true, configured, webhooks: results }
    },
    dispose() {
      store.close()
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Tools

const PROJECT_PARAM = { type: 'string', description: '项目 id（省略时用第一个项目）' }
const TARGET_PARAM = { type: 'string', description: '部署目标名（省略时用 defaultTarget 或第一个 target）' }

const CANARY_SCHEMA = {
  type: 'object',
  properties: {
    first: { type: 'number' },
    waitSec: { type: 'number' },
    batches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'number' },
          hosts: { type: 'array', items: { type: 'string' } },
          ok: { type: 'boolean' },
        },
      },
    },
  },
}

const RUN_SCHEMA = {
  type: 'object',
  properties: {
    runId: { type: 'string' },
    status: { type: 'string' },
    project: { type: 'string' },
    target: { type: 'string' },
    dryRun: { type: 'boolean' },
    hosts: { type: 'array', items: { type: 'string' } },
    selectors: { type: 'array', items: { type: 'string' } },
    envs: { type: 'array', items: { type: 'string' } },
    prodHosts: { type: 'array', items: { type: 'string' } },
    canary: CANARY_SCHEMA,
    stages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string' },
          durationMs: { type: 'number' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'number' }, name: { type: 'string' }, kind: { type: 'string' },
                status: { type: 'string' }, exitCode: { type: 'number' }, durationMs: { type: 'number' }, error: { type: 'string' },
                hosts: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { host: { type: 'string' }, ok: { type: 'boolean' }, batch: { type: 'number' }, health: { type: 'string' }, restarted: { type: 'string' }, error: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
    },
    releases: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, recordId: { type: 'string' }, projectId: { type: 'string' }, target: { type: 'string' }, host: { type: 'string' },
          runId: { type: 'string' }, commit: { type: 'string' }, status: { type: 'string' },
          createdAt: { type: 'string' }, activatedAt: { type: 'string' }, deactivatedAt: { type: 'string' },
        },
      },
    },
  },
}

function renderProjects(_args, value) {
  const lines = [`工作目录：${value.workDir}`, `项目 ${value.projects.length} 个`]
  for (const project of value.projects) lines.push(`- ${project.id}  ${project.path}  ${project.hasPipe ? project.pipe : '（缺 pipe.yml）'}`)
  return textBlocks(lines.join('\n'))
}

function renderPlan(_args, value) {
  const lines = [`计划：${value.name} · 项目 ${value.project} · target ${value.target}`]
  for (const stage of value.stages) {
    lines.push(`stage ${stage.id}${stage.needs.length ? `（needs: ${stage.needs.join(', ')}）` : ''}${stage.manual ? '（manual）' : ''}`)
    for (const step of stage.steps) lines.push(`  ${step.index + 1}. [${step.kind}] ${step.name}: ${step.command}${step.allowFailure ? '  (allow_failure)' : ''}`)
  }
  return textBlocks(lines.join('\n'))
}

function renderRun(_args, value) {
  const lines = [`运行 ${value.runId || '（dry-run）'} · ${value.status} · 项目 ${value.project} · target ${value.target}`]
  if (value.canary && value.canary.first > 0) lines.push(`灰度：首批 ${value.canary.first} 台，等待 ${value.canary.waitSec}s`)
  for (const stage of value.stages) {
    lines.push(`stage ${stage.id}: ${stage.status}（${stage.durationMs}ms）`)
    for (const step of stage.steps) {
      lines.push(`  ${step.index + 1}. ${step.name}: ${step.status}${step.exitCode >= 0 ? ` exit ${step.exitCode}` : ''}${step.error ? ` — ${step.error}` : ''}`)
      for (const host of step.hosts || []) {
        lines.push(`     ${host.host}: ${host.ok ? 'ok' : 'failed'}${host.batch ? ` · batch ${host.batch}` : ''} · health ${host.health || '-'}${host.restarted ? ` · ${host.restarted}` : ''}${host.error ? ` — ${host.error}` : ''}`)
      }
    }
  }
  for (const release of value.releases) lines.push(`release ${release.id} → ${release.host} (${release.status})`)
  return textBlocks(lines.join('\n'))
}

function renderStatus(_args, value) {
  if (value.runs.length === 0) return textBlocks('（还没有运行记录）')
  return textBlocks(value.runs.map((run) => `${run.id}  ${run.status}  ${run.projectId}/${run.pipelineName}  ${run.target}  ${run.startedAt}`).join('\n'))
}

function renderLogs(_args, value) {
  return textBlocks(`运行 ${value.runId} · ${value.status} · ${value.totalLines} 行${value.truncated ? '（已截断）' : ''}\n--- 日志 ---\n${value.text || '（空）'}`)
}

function renderReleases(_args, value) {
  if (value.releases.length === 0) return textBlocks('（没有发布记录）')
  return textBlocks(value.releases.map((release) => `${release.id}  ${release.target}@${release.host}  ${release.status}  ${release.activatedAt}`).join('\n'))
}

function renderRollback(_args, value) {
  if (Array.isArray(value.hosts) && value.hosts.length > 0) {
    const lines = [`回滚 ${value.target} → ${value.releaseId || 'current'}（${value.ok ? '成功' : '部分失败'}）`]
    for (const host of value.hosts) {
      lines.push(`- ${host.host}: ${host.ok ? 'ok' : 'failed'} · health ${host.health || '-'}${host.restarted ? ` · ${host.restarted}` : ''}${host.error ? ` — ${host.error}` : ''}`)
    }
    return textBlocks(lines.join('\n'))
  }
  return textBlocks(`已回滚：${value.target}@${value.host} → ${value.releaseId}（健康检查：${value.health}）`)
}

function renderTargets(_args, value) {
  if (value.targets.length === 0) return textBlocks('（pipe 里没有 target）')
  const lines = [`项目 ${value.project} 的目标：`]
  for (const target of value.targets) {
    lines.push(`- ${target.name}  hosts=${target.hosts.join(',')}  path=${target.path}  runtime=${target.runtime}${target.app ? `  app=${target.app}` : ''}  onHostFailure=${target.onHostFailure}${target.canary ? `  canary=${target.canary.first}/${target.canary.waitSec}s` : ''}`)
    if (target.service) lines.push(`    service: ${target.service}`)
    if (target.restart) lines.push(`    restart: ${target.restart}`)
    if (target.restartCommand) lines.push(`    runtime 预设重启: ${target.restartCommand}`)
    if (target.health) lines.push(`    health: ${target.health}`)
    for (const host of target.active || []) lines.push(`    ${host.host}: ${host.releaseId || '（无记录）'}`)
    if (!target.active || target.active.length === 0) lines.push(`    current: ${target.current || '（无记录）'}`)
  }
  return textBlocks(lines.join('\n'))
}

function registerTools(ctx, runtime) {
  const register = (definition) => {
    const handle = ctx.tools.register(definition)
    const dispose = typeof handle === 'function' ? handle : handle?.dispose ? () => handle.dispose() : null
    if (dispose) ctx.effect(() => dispose)
  }

  register({
    name: 'cicd_projects',
    description: '列出 dsh-cicd 配置的项目、路径与 pipe.yml 是否存在。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        properties: {
          workDir: { type: 'string' },
          projects: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, path: { type: 'string' }, pipe: { type: 'string' }, hasPipe: { type: 'boolean' } } } },
        },
      },
      render: renderProjects,
    },
    async execute() { return runtime.listProjects() },
  })

  register({
    name: 'cicd_plan',
    description: '解析 pipe.yml 并返回执行计划（stage DAG、插值后的命令、deploy 步骤），不执行任何命令。',
    parameters: {
      type: 'object',
      properties: { project: PROJECT_PARAM, target: TARGET_PARAM },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          project: { type: 'string' }, target: { type: 'string' }, name: { type: 'string' },
          hosts: { type: 'array', items: { type: 'string' } },
          selectors: { type: 'array', items: { type: 'string' } },
          envs: { type: 'array', items: { type: 'string' } },
          prodHosts: { type: 'array', items: { type: 'string' } },
          willDeployToProd: { type: 'boolean' },
          envsUnknown: { type: 'boolean' },
          stages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' }, needs: { type: 'array', items: { type: 'string' } }, manual: { type: 'boolean' },
                steps: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      index: { type: 'number' }, name: { type: 'string' }, command: { type: 'string' }, kind: { type: 'string' },
                      when: { type: 'string' }, manual: { type: 'boolean' }, timeoutSec: { type: 'number' }, retries: { type: 'number' },
                      allowFailure: { type: 'boolean' }, target: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: renderPlan,
    },
    async execute(args) { return runtime.plan(args) },
  })

  register({
    name: 'cicd_run',
    description: '执行一次流水线：本地构建步骤、SSH 发布与自动回滚。dryRun 只返回计划；confirm 必须为 true。',
    parameters: {
      type: 'object',
      properties: {
        project: PROJECT_PARAM,
        target: TARGET_PARAM,
        stage: { type: 'string', description: '只跑到指定 stage（含它的 needs）' },
        dryRun: { type: 'boolean', description: '只打印计划，不执行命令、不写运行记录' },
        confirm: { type: 'boolean', description: '确认执行（默认 true；显式 false 会被拒绝）' },
        confirmProd: { type: 'boolean', description: '目标展开后含 env=prod 的主机时才需要；为 true 表示已确认生产发布' },
      },
    },
    output: { schema: RUN_SCHEMA, render: renderRun },
    async execute(args = {}) {
      if (args.confirm === false) throw new Error('取消执行：confirm=false')
      return runtime.run({
        projectId: args.project,
        targetName: args.target,
        stage: args.stage || '',
        dryRun: Boolean(args.dryRun),
        confirmProd: Boolean(args.confirmProd),
      })
    },
  })

  register({
    name: 'cicd_status',
    description: '列出最近的运行记录（JSONL 存储），可按项目过滤。',
    parameters: { type: 'object', properties: { project: PROJECT_PARAM, limit: { type: 'number', description: '最多返回多少条（默认 20）' } } },
    output: {
      schema: { type: 'object', properties: { runs: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, projectId: { type: 'string' }, pipelineName: { type: 'string' }, status: { type: 'string' }, target: { type: 'string' }, branch: { type: 'string' }, commit: { type: 'string' }, startedAt: { type: 'string' }, finishedAt: { type: 'string' }, error: { type: 'string' } } } } } },
      render: renderStatus,
    },
    async execute(args = {}) { return runtime.status({ project: args.project, limit: args.limit || 20 }) },
  })

  register({
    name: 'cicd_logs',
    description: '读取一次运行的构建日志（可只返回末尾 N 行）；日志文件在 workDir/logs/<runId>.log。',
    parameters: { type: 'object', properties: { runId: { type: 'string' }, tail: { type: 'number', description: '只返回末尾多少行（默认 200）' } }, required: ['runId'] },
    output: {
      schema: { type: 'object', properties: { runId: { type: 'string' }, status: { type: 'string' }, logPath: { type: 'string' }, totalLines: { type: 'number' }, tail: { type: 'number' }, truncated: { type: 'boolean' }, text: { type: 'string' } } },
      render: renderLogs,
    },
    async execute(args) { return runtime.logs({ runId: args.runId, tail: args.tail || 200 }) },
  })

  register({
    name: 'cicd_releases',
    description: '列出发布记录（release 目录、active/superseded 状态），可按 target 过滤。',
    parameters: { type: 'object', properties: { target: TARGET_PARAM, host: { type: 'string', description: '只看某台主机的 release' }, limit: { type: 'number', description: '最多返回多少条（默认 20）' } } },
    output: {
      schema: { type: 'object', properties: { target: { type: 'string' }, host: { type: 'string' }, hosts: { type: 'array', items: { type: 'string' } }, releases: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, recordId: { type: 'string' }, projectId: { type: 'string' }, target: { type: 'string' }, host: { type: 'string' }, runId: { type: 'string' }, commit: { type: 'string' }, status: { type: 'string' }, createdAt: { type: 'string' }, activatedAt: { type: 'string' }, deactivatedAt: { type: 'string' } } } } } },
      render: renderReleases,
    },
    async execute(args = {}) { return runtime.releases({ target: args.target, host: args.host || '', limit: args.limit || 20 }) },
  })

  register({
    name: 'cicd_rollback',
    description: '把 target 的 current 软链指回指定 release（省略 releaseId 时读取当前 current 指向的版本），重启并复检健康。',
    parameters: {
      type: 'object',
      properties: { target: { type: 'string', description: '要回滚的 target 名' }, releaseId: { type: 'string', description: '目标 release id（可选；省略时读各主机 current）' }, host: { type: 'string', description: '只回滚某台主机（可选；省略时回滚 target.hosts 全部）' }, project: PROJECT_PARAM, confirmProd: { type: 'boolean', description: '目标展开后含 env=prod 主机时才需要；为 true 表示已确认生产回滚' } },
      required: ['target'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          releaseId: { type: 'string' }, ok: { type: 'boolean' }, host: { type: 'string' }, target: { type: 'string' },
          health: { type: 'string' }, restarted: { type: 'string' }, error: { type: 'string' }, code: { type: 'string' },
          hosts: {
            type: 'array',
            items: { type: 'object', properties: { host: { type: 'string' }, ok: { type: 'boolean' }, health: { type: 'string' }, restarted: { type: 'string' }, error: { type: 'string' } } },
          },
        },
      },
      render: renderRollback,
    },
    async execute(args) { return runtime.rollback({ target: args.target, releaseId: args.releaseId || '', project: args.project, host: args.host || '', confirmProd: Boolean(args.confirmProd) }) },
  })

  register({
    name: 'cicd_targets',
    description: '列出一个项目 pipe.yml 里的部署目标、主机、服务/重启命令与当前活跃 release。',
    parameters: { type: 'object', properties: { project: PROJECT_PARAM } },
    output: {
      schema: { type: 'object', properties: { project: { type: 'string' }, targets: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, hosts: { type: 'array', items: { type: 'string' } }, path: { type: 'string' }, runtime: { type: 'string' }, app: { type: 'string' }, onHostFailure: { type: 'string' }, keep: { type: 'number' }, canary: { type: 'object', properties: { first: { type: 'number' }, waitSec: { type: 'number' } } }, restartCommand: { type: 'string' }, service: { type: 'string' }, restart: { type: 'string' }, health: { type: 'string' }, current: { type: 'string' }, selectors: { type: 'array', items: { type: 'string' } }, envs: { type: 'array', items: { type: 'string' } }, prodHosts: { type: 'array', items: { type: 'string' } }, envsUnknown: { type: 'boolean' }, active: { type: 'array', items: { type: 'object', properties: { host: { type: 'string' }, releaseId: { type: 'string' } } } } } } } } },
      render: renderTargets,
    },
    async execute(args = {}) { return runtime.targets({ project: args.project }) },
  })
}

// ---------------------------------------------------------------------------------------------
// HTTP routes

function errorStatus(error) {
  const code = error?.code || ''
  if (code === 'PROJECT_NOT_FOUND' || code === 'TARGET_NOT_FOUND' || code === 'RUN_NOT_FOUND' || code === 'RELEASE_NOT_FOUND' || code === 'STAGE_NOT_FOUND') return 404
  if (code === 'REMOTE_UNAVAILABLE') return 503
  if (code === 'HEALTH_FAILED') return 502
  if (code === 'PIPE_NOT_FOUND') return 404
  if (code === 'PROD_CONFIRM_REQUIRED' || code === 'DEPLOY_IN_PROGRESS') return 409
  if (code.startsWith('PIPE_') || code === 'ARTIFACT_NOT_FOUND' || code === 'COMMAND_INVALID') return 400
  return 500
}

function errorJson(error) {
  return json({ ok: false, error: error.message || String(error), code: error.code || '', hosts: error.hosts || [] }, errorStatus(error))
}

const WRITE_CONFIRMS = new Set(['1', 'prod'])

function requireWrite(request, params, { confirms = WRITE_CONFIRMS } = {}) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  if (!hasCicdHeader(request)) return json({ ok: false, error: '缺少 x-dsh-cicd 头' }, 403)
  if (!confirms.has(params.get('confirm'))) {
    return json({ ok: false, error: `写操作需要 confirm=${[...confirms].join(' 或 ')}` }, 400)
  }
  return null
}

async function projectsResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set())
  if (bad) return json({ ok: false, error: bad }, 400)
  return json({ ok: true, ...runtime.listProjects() })
}

async function planResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['project', 'target']))
  if (bad) return json({ ok: false, error: bad }, 400)
  try {
    const data = await runtime.plan({ project: params.get('project') || '', target: params.get('target') || '' })
    return json({ ok: true, ...data })
  } catch (error) { return errorJson(error) }
}

async function runResource(request, runtime) {
  const params = queryOf(request)
  const guard = requireWrite(request, params)
  if (guard) return guard
  const bad = unsupportedParams(params, new Set(['project', 'target', 'stage', 'dryRun', 'confirm']))
  if (bad) return json({ ok: false, error: bad }, 400)
  try {
    const data = await runtime.run({
      projectId: params.get('project') || '',
      targetName: params.get('target') || '',
      stage: params.get('stage') || '',
      dryRun: params.get('dryRun') === '1' || params.get('dryRun') === 'true',
      confirmProd: params.get('confirm') === 'prod',
    })
    return json({ ok: true, ...data })
  } catch (error) { return errorJson(error) }
}

async function runsResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['project', 'limit']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const limit = intParam(params, 'limit', { fallback: 20, min: 1, max: 200 })
  if (limit.error) return json({ ok: false, error: limit.error }, 400)
  try { return json({ ok: true, ...runtime.status({ project: params.get('project') || '', limit: limit.value }) }) } catch (error) { return errorJson(error) }
}

async function logResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['runId', 'tail']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const tail = intParam(params, 'tail', { fallback: 200, min: 1, max: 5000 })
  if (tail.error) return json({ ok: false, error: tail.error }, 400)
  try { return json({ ok: true, ...runtime.logs({ runId: params.get('runId') || '', tail: tail.value }) }) } catch (error) { return errorJson(error) }
}

async function releasesResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['target', 'host', 'env', 'limit']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const limit = intParam(params, 'limit', { fallback: 20, min: 1, max: 200 })
  if (limit.error) return json({ ok: false, error: limit.error }, 400)
  try { return json({ ok: true, ...runtime.releases({ target: params.get('target') || '', host: params.get('host') || '', env: params.get('env') || '', limit: limit.value }) }) } catch (error) { return errorJson(error) }
}

async function rollbackResource(request, runtime) {
  const params = queryOf(request)
  const guard = requireWrite(request, params)
  if (guard) return guard
  const bad = unsupportedParams(params, new Set(['target', 'releaseId', 'project', 'host', 'confirm']))
  if (bad) return json({ ok: false, error: bad }, 400)
  try {
    const data = await runtime.rollback({ target: params.get('target') || '', releaseId: params.get('releaseId') || '', project: params.get('project') || '', host: params.get('host') || '', confirmProd: params.get('confirm') === 'prod' })
    if (!data.ok) return json({ ok: false, error: data.error, code: data.code, ...data }, errorStatus({ code: data.code }))
    return json({ ok: true, ...data })
  } catch (error) { return errorJson(error) }
}

async function targetsResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['project']))
  if (bad) return json({ ok: false, error: bad }, 400)
  try {
    const data = await runtime.targets({ project: params.get('project') || '' })
    return json({ ok: true, ...data })
  } catch (error) { return errorJson(error) }
}

async function operationsResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['project', 'runId', 'limit']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const limit = intParam(params, 'limit', { fallback: 50, min: 1, max: 200 })
  if (limit.error) return json({ ok: false, error: limit.error }, 400)
  try {
    return json({ ok: true, ...runtime.operations({ project: params.get('project') || '', runId: params.get('runId') || '', limit: limit.value }) })
  } catch (error) { return errorJson(error) }
}

async function notifyTestResource(request, runtime) {
  const params = queryOf(request)
  const guard = requireWrite(request, params)
  if (guard) return guard
  const bad = unsupportedParams(params, new Set(['confirm']))
  if (bad) return json({ ok: false, error: bad }, 400)
  try {
    return json(await runtime.notifyTest())
  } catch (error) { return errorJson(error) }
}

function registerHttpRoutes(ctx, runtime) {
  const web = ctx.get('webServer')
  if (!web || typeof web.register !== 'function') return
  const routes = [
    { kind: 'exact', path: `${ROUTE_PREFIX}/projects`, resource: (request) => projectsResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/plan`, resource: (request) => planResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/run`, resource: (request) => runResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/runs`, resource: (request) => runsResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/log`, resource: (request) => logResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/releases`, resource: (request) => releasesResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/rollback`, resource: (request) => rollbackResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/targets`, resource: (request) => targetsResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/operations`, resource: (request) => operationsResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/notify-test`, resource: (request) => notifyTestResource(request, runtime) },
  ]
  for (const route of routes) {
    try {
      const handle = web.register(route)
      const dispose = typeof handle === 'function' ? handle : handle?.dispose ? () => handle.dispose() : null
      if (dispose) ctx.effect(() => dispose)
    } catch { /* the tools still work without a page host */ }
  }
}

export function apply(ctx, config = {}) {
  const runtime = createRuntime(ctx, config)
  ctx.effect(() => () => runtime.dispose())
  registerTools(ctx, runtime)
  // 冷启动时 webServer 往往晚于本插件 apply：同步 ctx.get 拿不到服务会静默跳过，结果是页面能渲染、
  // 但整包路由 404（fiber 仍是 active，从插件列表里看不出毛病）。改用 inject 等服务就绪再注册：
  // 服务迟到自动补注册、服务被替换/卸载时连同路由一起销毁。测试用的最小 ctx 没有 inject，
  // 退化成同步注册（此时 webServer 一定已就位）。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => registerHttpRoutes(scope, runtime))
  } else {
    registerHttpRoutes(ctx, runtime)
  }
}

export const internals = {
  createRuntime,
  normalizeConfig,
  ROUTE_PREFIX,
  WRITE_HEADER,
  parsePipe,
  planPipeline,
  interpolate,
  matchArtifacts,
  createStore,
  runPipeline,
  createRemote,
  deployRelease,
  rollbackRelease,
  resources: { projectsResource, planResource, runResource, runsResource, logResource, releasesResource, rollbackResource, targetsResource, operationsResource, notifyTestResource },
}