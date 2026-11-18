/**
 * Host half of @local/dsh-cicd — a local-first CI/CD for DSH.
 *
 * 16 tools, 19 GET-only HTTP routes, 2 prefix routes (inbound webhook + runner poll), 2 POST
 * upgrade handlers (runner register/heartbeat/result via dsh-remote), 1 WebSocket upgrade
 * (realtime logs). Builds run locally (child_process) or on registered remote runners
 * (bin/runner.mjs pull protocol + journal idempotency); releases reuse the dsh-remote plugin
 * over loopback HTTP, so this package owns no SSH code and no credentials.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative } from 'node:path'
import { parsePipe, planPipeline, interpolate, matchArtifacts, isHostSelector, parseHostSelector } from './lib/pipe.js'
import { createStore, DEFAULT_WORK_DIR } from './lib/store.js'
import { runPipeline, makeRunId } from './lib/runner.js'
import { createRemote } from './lib/remote.js'
import { deployRelease, rollbackRelease } from './lib/deploy.js'
import { deployRelease as strategyDeployRelease } from './lib/strategy.js'
import { dispatchNotifications } from './lib/notify.js'
import { readGitMeta, fetchQuiet, cloneRepo, isGitRepo, fetchAsync, remoteHead, pullFastForward, remoteBranches, commitDate } from './lib/git.js'
import { scaffoldPipe, SCAFFOLD_KINDS } from './lib/scaffold.js'
import { createLiveHub } from './lib/live.js'
import { performHandshake, LogSocket, encodeFrame, refuseUpgrade } from './lib/ws.js'
import { normalizeTriggers, matchPushRef, triggerSummary } from './lib/triggers.js'
import { cronMatches, minuteKey } from './lib/cron.js'
import { createScheduler } from './lib/scheduler.js'
import { summarizeDora } from './lib/dora.js'
import { createTaskBroker, createRemoteExecutor, joinTokenMatches } from './lib/executors.js'
import { createSecretStore } from './lib/secrets.js'
import { createApprovalGate } from './lib/approval.js'
import { normalizeEnvironments, promotionPath, isProtected, requiresApproval } from './lib/environments.js'
import { createRbac } from './lib/rbac.js'

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
  // upgrade 请求拿到的是裸 http.IncomingMessage，req.url 是相对路径（/api/...?x=1），必须给 base。
  try { return new URL(request.url, 'http://localhost').searchParams } catch { return new URLSearchParams() }
}

/** 定长比较 webhook token（sha256 摘要后比较，避免长度/时序泄漏）。 */
function tokenMatches(provided, secret) {
  if (!provided || !secret) return false
  const left = createHash('sha256').update(String(provided)).digest()
  const right = createHash('sha256').update(String(secret)).digest()
  return timingSafeEqual(left, right)
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
  // V2-M1：进程内调度器。enabled=false 可以整体关掉（测试/纯手动部署场景）；
  // pollSec=0 关掉 git push 轮询（只留 cron），allowProd=true 才允许定时/推送运行免 confirm=prod。
  const rawScheduler = baseConfig.scheduler && typeof baseConfig.scheduler === 'object' ? baseConfig.scheduler : {}
  const clampInt = (value, fallback, min, max) => (Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback)
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
    scheduler: {
      enabled: rawScheduler.enabled !== false,
      tickSec: clampInt(rawScheduler.tickSec, 20, 1, 3600),
      pollSec: clampInt(rawScheduler.pollSec, 60, 0, 3600),
      allowProd: rawScheduler.allowProd === true,
    },
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

/** 把 store.projects() 里的持久化行还原成内部 project 形状（供面板与运行复用）。 */
function persistedProjectOption(row) {
  const id = String(row.id)
  const path = String(row.path)
  return {
    id,
    name: String(row.name || id),
    path,
    pipe: String(row.pipePath || row.pipe_path || join(path, 'pipe.yml')),
    env: {},
    sourceType: String(row.sourceType || row.source_type || 'local'),
    repoUrl: String(row.repoUrl || row.repo_url || ''),
    defaultBranch: String(row.defaultBranch || row.default_branch || ''),
  }
}

function slugProjectId(raw) {
  const slug = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return slug || 'project'
}

function uniqueProjectId(projects, base) {
  const taken = new Set(projects.map((project) => project.id))
  let id = slugProjectId(base)
  if (!taken.has(id)) return id
  let index = 2
  while (taken.has(`${id}-${index}`)) index += 1
  return `${id}-${index}`
}

function createRuntime(ctx, config) {
  const options = normalizeConfig(config, ctx)
  const store = createStore({ dir: options.workDir })
  // v2.0-M0：把向导创建并持久化的项目并入启动配置里的项目（按 id 去重，配置里的优先）。
  const configuredIds = new Set(options.projects.map((project) => project.id))
  for (const row of store.projects()) {
    if (configuredIds.has(String(row.id))) continue
    options.projects.push(persistedProjectOption(row))
  }
  let remoteClient = null
  // V2-M1：进程内实时日志中心 + 活跃运行表（runId → AbortController）。取消、WS 日志、running 列表都读写这里。
  const hub = createLiveHub()
  const activeRuns = new Map()
  // V2-M2：远端执行面 broker——runner 端（bin/runner.mjs）通过 /runner-poll 领任务、
  // /runner-result 回结果；join token 校验身份。本地执行不经 broker。
  const broker = createTaskBroker({
    onTaskForRunner: null, // 拉取式：runner 主动 poll，server 不推
    log: (event, data) => {
      try { store.appendOperation({ action: 'runner', project: data?.runnerId || '', runId: data?.taskId || '', status: event, detail: JSON.stringify(data || {}) }) } catch { /* best effort */ }
    },
  })
  // V2-M4：审批门（block gate）+ secrets 存储（DB 只存 ref，载荷落 workDir/.secrets.json）
  const approvalGate = createApprovalGate()
  const secrets = createSecretStore({ dir: options.workDir })
  // V2-M5：RBAC（server 模式）——三角色 viewer/operator/admin + token TTL + 写操作审计
  const rbac = createRbac({ dir: options.workDir })

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
    // v2.0-M3：有 strategy 字段时走策略引擎（serial/parallel/rolling/canary/blue-green）
    const useStrategy = Boolean(deployTarget.strategy?.type)
    const result = useStrategy
      ? await strategyDeployRelease({
          remote: remote(),
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
          onStrategyProgress: ({ type, batch, totalBatches, hosts: batchHosts, completed }) => {
            try {
              store.appendOperation({
                action: 'strategy-progress',
                project: project.id,
                target: targetName,
                run_id: runId,
                release_id: runId,
                status: 'progress',
                detail: { type, batch, totalBatches, hosts: batchHosts, completed },
              })
            } catch { /* audit is best effort */ }
          },
        })
      : await deployRelease({
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

  async function executeRun({
    projectId,
    targetName,
    stage = '',
    dryRun = false,
    confirmProd = false,
    trigger = 'manual',
    branch = '',
    commit = '',
    runId = '',
    skipFetch = false,
    onStarted = null,
    runnerId = '',
  }) {
    const baseProject = pickProject(options, projectId)
    const pipe = readPipe(baseProject)
    // v2.0-M0：运行前回填 git 元数据（branch/commit/tag），供 when 条件、运行记录与发布 commit 使用。
    // dry-run 也读本地元数据（不 fetch），让 `when: branch == ...` 与 `${{BRANCH}}` 插值在 dry-run 下同样可验证。
    // V2-M1：push/定时触发会显式传入 branch/commit（远端最新 sha），此时不再用本地 HEAD 覆盖。
    if (!dryRun && !skipFetch && !runnerId) {
      try { fetchQuiet(baseProject.path) } catch { /* best effort：离线/无远端不阻断 */ }
    }
    const meta = readGitMeta(baseProject.path)
    const project = {
      ...baseProject,
      branch: branch || meta.branch || '',
      commit: commit || meta.commit || '',
      tag: meta.tag || '',
      trigger: trigger || 'manual',
    }
    const { targetName: resolvedTarget, target: resolvedSpec } = resolveTarget(pipe, options, targetName)
    // 先展开选择器：生产护栏与部署锁都以「真实会部署到哪些主机」为准。
    const resolution = await tryExpandTarget(resolvedTarget, resolvedSpec)
    if (!dryRun && resolution.prodHosts.length > 0 && !confirmProd) throw prodGuardError(resolution.prodHosts)
    if (!dryRun) {
      if (deployLocks.has(resolvedTarget)) throw lockError(resolvedTarget)
      deployLocks.set(resolvedTarget, { at: new Date().toISOString(), runId })
    }
    // V2-M4：审批门（block gate）——prod 环境默认 manual: true，部署停在「待审批」，
    // 面板点「通过」（/approve 路由）才继续；审批通过后仍走 confirm=prod 护栏（双重确认）。
    const runIdValue = dryRun ? '' : (runId || makeRunId())
    if (!dryRun && resolvedSpec.approvalRequired && confirmProd && !approvalGate.isPending(runIdValue)) {
      // 只有显式 confirm=prod 的路径（手动 UI 运行）才走审批门；
      // scheduler（cron/push 轮询）的 allowProd 不触发审批，避免无 UI 时卡死。
      const approval = approvalGate.request({
        runId: runIdValue,
        project: project.id,
        target: resolvedTarget,
        requestedBy: trigger,
        detail: `deploy to ${resolvedTarget} (${resolution.hosts.length} hosts, prod=${resolution.prodHosts.length > 0})`,
      })
      try { store.appendOperation({ action: 'approval-request', project: project.id, target: resolvedTarget, runId: runIdValue, status: 'pending', detail: JSON.stringify(approval) }) } catch { /* best effort */ }
      const error = new Error(`部署到 ${resolvedTarget} 需要审批（runId=${runIdValue}），请在面板点「通过」`)
      error.code = 'APPROVAL_REQUIRED'
      error.approvalId = approval.id
      error.runId = runIdValue
      throw error
    }
    // 审批已通过（/approve 路由 resolve 后重跑）：isPending 为 false 且 get 返回 approved 记录 → 跳过 resolve，直接执行。
    // pending 记录不会走到这里（上面已 throw），所以无需额外 resolve。
    const controller = dryRun ? null : new AbortController()
    const active = dryRun ? null : {
      runId: runIdValue,
      projectId: project.id,
      target: resolvedTarget,
      trigger: project.trigger,
      branch: project.branch,
      commit: project.commit,
      startedAt: new Date().toISOString(),
      canceling: false,
      controller,
    }
    if (active) activeRuns.set(runIdValue, active)
    if (typeof onStarted === 'function') {
      try {
        onStarted({
          runId: runIdValue,
          project: project.id,
          target: resolvedTarget,
          trigger: project.trigger,
          branch: project.branch,
          commit: project.commit,
          hosts: resolution.hosts,
          prodHosts: resolution.prodHosts,
          runnerId,
        })
      } catch { /* observer errors must not prevent the run */ }
    }
    // V2-M2：执行面可迁移——runnerId 非空时走远端 broker，缺省本地 spawn。
    let executor = null
    if (runnerId && !dryRun) {
      const info = broker.describe(runnerId)
      if (!info || info.status === 'offline') {
        const error = new Error(`远端 runner ${runnerId} 未注册或已离线`)
        error.code = 'RUNNER_NOT_FOUND'
        throw error
      }
      executor = createRemoteExecutor({ broker, runnerId })
    }
    try {
      // V2-M4：secrets 注入——interpolate 的 vars 里合并 secrets 值（仅运行时，不落明文到日志/DB）。
      const extraVars = secrets.refsForInterpolate(project.id, {})
      const run = await runPipeline({
        pipe,
        project,
        target: resolvedTarget,
        stage,
        dryRun,
        store,
        stepTimeoutSec: options.stepTimeoutSec,
        runId: runIdValue,
        hub,
        signal: controller?.signal || null,
        executor,
        extraVars,
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
        runnerId: runnerId || 'local',
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
      if (active) activeRuns.delete(runIdValue)
    }
  }

  /**
   * V2-M1：异步启动一次运行，拿到 runId 就返回（webhook/调度器用），不阻塞触发方等待整条流水线。
   * started 在 run 真正开始、runId 确定后 resolve；启动前的错误（项目/target/生产护栏/锁）会 reject
   * 并在 operations 里留一条 trigger 失败审计。
   */
  function startRun(params = {}) {
    let settleStarted
    let settleError
    const started = new Promise((resolve, reject) => {
      settleStarted = resolve
      settleError = reject
    })
    const promise = executeRun({
      ...params,
      onStarted: (info) => {
        try { params.onStarted?.(info) } catch { /* observer errors are not run errors */ }
        settleStarted(info)
      },
    }).catch((error) => {
      settleError(error)
      try {
        store.appendOperation({
          action: 'trigger',
          project: params.projectId || '',
          target: params.targetName || '',
          status: 'failed',
          detail: { trigger: params.trigger || 'manual', branch: params.branch || '', error: error.message || String(error), code: error.code || '' },
        })
      } catch { /* audit is best effort */ }
      return null
    })
    return { started, promise }
  }

  function activeRunList(projectId = '') {
    return [...activeRuns.values()]
      .filter((entry) => !projectId || entry.projectId === projectId)
      .map((entry) => ({
        runId: entry.runId,
        projectId: entry.projectId,
        target: entry.target,
        trigger: entry.trigger,
        branch: entry.branch,
        commit: entry.commit,
        startedAt: entry.startedAt,
        canceling: entry.canceling,
      }))
  }

  /** V2-M1：取消一次运行（abort → runner 杀掉步骤进程树 → 运行记录标 canceled）。 */
  function cancelRun({ runId } = {}) {
    if (!runId) throw Object.assign(new Error('runId 不能为空'), { code: 'RUN_NOT_FOUND' })
    const entry = activeRuns.get(runId)
    if (!entry) {
      const run = store.run(runId)
      if (!run) throw Object.assign(new Error(`运行 ${runId} 不存在`), { code: 'RUN_NOT_FOUND' })
      if (run.status !== 'running') throw Object.assign(new Error(`运行 ${runId} 已经结束（${run.status}），无法取消`), { code: 'RUN_NOT_ACTIVE' })
      throw Object.assign(new Error(`运行 ${runId} 没有活跃句柄（可能来自上一次进程），只能等它自己结束`), { code: 'RUN_NOT_ACTIVE' })
    }
    if (entry.canceling) return { runId, status: 'canceling', project: entry.projectId, target: entry.target }
    entry.canceling = true
    entry.controller.abort()
    try { hub.append(runId, { stageId: '', index: -1, line: '收到取消请求，正在终止当前步骤…' }) } catch { /* hub is best effort */ }
    try {
      store.appendOperation({
        action: 'cancel',
        project: entry.projectId,
        target: entry.target,
        run_id: runId,
        status: 'requested',
        detail: { trigger: entry.trigger, branch: entry.branch, commit: entry.commit },
      })
    } catch { /* audit is best effort */ }
    return {
      runId,
      project: entry.projectId,
      target: entry.target,
      status: 'canceling',
      trigger: entry.trigger,
      branch: entry.branch,
      commit: entry.commit,
      startedAt: entry.startedAt,
    }
  }

  function triggersOf(project) {
    try { return readPipe(project).triggers || null } catch { return null }
  }

  /** V2-M1：一次运行的触发方式汇总（push/schedule/manual + 调度器状态 + webhook 地址）。 */
  function projectTriggers({ project: projectId } = {}) {
    const project = pickProject(options, projectId)
    const triggers = triggersOf(project)
    if (!triggers) throw Object.assign(new Error(`找不到 ${project.id} 的 pipe 文件`), { code: 'PIPE_NOT_FOUND' })
    const summary = triggerSummary(triggers)
    const base = options.remoteBase || (ctx?.get?.('webServer')?.port ? `http://127.0.0.1:${ctx.get('webServer').port}` : '')
    return {
      project: project.id,
      triggers: summary,
      schedulers: scheduler ? scheduler.snapshot() : null,
      webhook: triggers.hasPush
        ? {
          url: `${base}${ROUTE_PREFIX}/hooks/${encodeURIComponent(project.id)}`,
          requiresToken: Boolean(triggers.push?.secret),
          target: triggers.push?.target || '',
          branches: triggers.push?.branches || [],
          tags: triggers.push?.tags || [],
        }
        : null,
    }
  }

  /** V2-M1：DORA 四指标（窗口内真实运行；commit 时间从 git 读，缓存同 sha 结果）。 */
  function dora({ project: projectId = '', days = 30 } = {}) {
    const windowDays = Number.isInteger(days) ? Math.max(1, Math.min(365, days)) : 30
    const runs = store.runs({ project: projectId, limit: 5000 })
    const cache = new Map()
    const commitAt = (sha, run) => {
      if (!sha) return ''
      const owner = options.projects.find((item) => item.id === run.projectId)
      if (!owner) return ''
      const key = `${owner.path}|${sha}`
      if (!cache.has(key)) cache.set(key, commitDate(owner.path, sha))
      return cache.get(key)
    }
    return { project: projectId || '', ...summarizeDora({ runs, commitAt, now: Date.now(), days: windowDays }) }
  }

  /**
   * V2-M1：入站 webhook（`/hooks/<project>?ref=refs/heads/main&token=...`）。
   * token 是 pipe 的 triggers.push.secret；无 secret 视为未启用（403），token 不符 401，
   * ref 不匹配 200 skipped。命中就异步启动一次 push 运行（先 fetch + 快进工作区）。
   */
  async function runHook({ project: projectId, ref = '', sha = '', token = '', event = 'push', confirmProd = false } = {}) {
    const project = pickProject(options, projectId)
    const pipe = readPipe(project)
    const triggers = pipe.triggers
    if (!triggers?.hasPush) throw Object.assign(new Error('项目没有配置 triggers.push，webhook 未启用'), { code: 'WEBHOOK_DISABLED' })
    const secret = triggers.push.secret || ''
    if (!secret) throw Object.assign(new Error('triggers.push.secret 未设置，webhook 未启用'), { code: 'WEBHOOK_DISABLED' })
    if (!tokenMatches(token, secret)) throw Object.assign(new Error('webhook token 不匹配'), { code: 'WEBHOOK_UNAUTHORIZED' })
    if (!ref) throw Object.assign(new Error('缺少 ref 参数（如 refs/heads/main）'), { code: 'WEBHOOK_INVALID' })
    const match = matchPushRef(triggers.push, ref)
    if (!match.matched) return { ok: true, skipped: true, project: project.id, ref, reason: `ref ${ref} 没有命中 triggers.push` }
    let branch = match.kind === 'branch' ? match.name : ''
    let commit = sha
    let pulled = ''
    if (match.kind === 'branch' && isGitRepo(project.path)) {
      const meta = readGitMeta(project.path)
      if (meta.branch === match.name) {
        await fetchAsync(project.path)
        const pull = pullFastForward(project.path)
        pulled = pull.ok ? 'fast-forward' : pull.error
        if (pull.ok) commit = readGitMeta(project.path).commit || commit
      } else {
        pulled = `工作区分支是 ${meta.branch || '游离 HEAD'}，未快进`
      }
    }
    const { started } = startRun({
      projectId: project.id,
      targetName: triggers.push.target || '',
      trigger: 'push',
      branch,
      commit,
      confirmProd,
    })
    const info = await started
    return {
      ok: true,
      accepted: true,
      project: project.id,
      ref,
      kind: match.kind,
      name: match.name,
      event: String(event || 'push'),
      target: info.target,
      runId: info.runId,
      branch,
      commit,
      pulled,
    }
  }

  // V2-M1：进程内调度器。构造时读一次落盘状态；apply() 才真正 start()（测试与 createRuntime 不启动定时器）。
  const scheduler = options.scheduler.enabled
    ? createScheduler({
      getProjects: () => options.projects,
      readPipe: (project) => readPipe(project),
      run: async ({ project, target, trigger: firedBy = 'schedule', branch: runBranch = '', commit: runCommit = '' }) => executeRun({
        projectId: project.id,
        targetName: target,
        trigger: firedBy,
        branch: runBranch,
        commit: runCommit,
        confirmProd: options.scheduler.allowProd,
      }),
      defaultTarget: options.defaultTarget,
      stateFile: join(options.workDir, 'scheduler-state.json'),
      tickSec: options.scheduler.tickSec,
      pollSec: options.scheduler.pollSec,
    })
    : null

  return {
    listProjects() {
      return {
        workDir: options.workDir,
        projects: options.projects.map((project) => {
          const triggers = triggersOf(project)
          return {
            id: project.id,
            name: project.name,
            path: project.path,
            pipe: project.pipe,
            hasPipe: existsSync(project.pipe),
            sourceType: project.sourceType || 'local',
            repoUrl: project.repoUrl || '',
            defaultBranch: project.defaultBranch || '',
            triggers: triggers ? triggerSummary(triggers) : null,
          }
        }),
      }
    },
    async plan({ project: projectId, target: targetName } = {}) {
      const project = pickProject(options, projectId)
      const pipe = readPipe(project)
      const { targetName: resolved, target: spec } = resolveTarget(pipe, options, targetName)
      const resolution = await tryExpandTarget(resolved, spec)
      // v2.0-M0：plan 也读本地 git 元数据（只读、不 fetch），让 when: branch/tag 与面板预览和实际一致。
      const meta = readGitMeta(project.path)
      const planProject = { ...project, branch: meta.branch || '', commit: meta.commit || '', tag: meta.tag || '' }
      const plan = planPipeline(pipe, { project: planProject, target: resolved, env: { ...(planProject.env || {}), branch: planProject.branch, commit: planProject.commit } })
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
    startRun,
    cancel: cancelRun,
    activeRuns: activeRunList,
    hub,
    remote,
    store,
    get scheduler() { return scheduler },
    triggers: projectTriggers,
    dora,
    hook: runHook,
    runners: () => broker.listRunners(),
    runnerRegister({ runnerId, labels = '', version = '', capacity = 1, token = '' } = {}) {
      if (!runnerId) {
        const error = new Error('runnerId 不能为空')
        error.code = 'RUNNER_NOT_FOUND'
        throw error
      }
      const secret = options.runners?.joinToken
      if (secret && !joinTokenMatches(token, secret)) {
        const error = new Error('join token 校验失败')
        error.code = 'RUNNER_UNAUTHORIZED'
        throw error
      }
      const info = broker.register(runnerId, { labels, version, capacity })
      try { store.appendOperation({ action: 'runner-register', project: runnerId, status: 'ok', detail: JSON.stringify(info) }) } catch { /* best effort */ }
      return { ok: true, runnerId: info.runnerId, labels: info.labels, version: info.version, capacity: info.capacity, lastSeenAt: info.lastSeenAt, status: info.status, serverTime: new Date().toISOString() }
    },
    runnerHeartbeat({ runnerId } = {}) {
      broker.heartbeat(runnerId)
      return { ok: true, runnerId }
    },
    runnerPoll({ runnerId } = {}) {
      if (runnerId) broker.heartbeat(runnerId) // poll 兼心跳：runner 活着就续 lastSeenAt
      const task = broker.taskForRunner(runnerId)
      if (!task) return { ok: true, task: null }
      return { ok: true, task: task.spec }
    },
    runnerResult({ taskId, status = '', exitCode = -1, error = '' } = {}) {
      broker.resolve(taskId, { status, exitCode, error })
      return { ok: true, taskId }
    },
    runnerLog({ taskId, line = '' } = {}) {
      broker.reportLog(taskId, line)
      return { ok: true, taskId }
    },
    runnerDeregister({ runnerId } = {}) {
      broker.markOffline(runnerId)
      try { store.appendOperation({ action: 'runner-deregister', project: runnerId, status: 'ok', detail: '' }) } catch { /* best effort */ }
      return { ok: true, runnerId }
    },
    // V2-M4：审批门 + secrets + environments
    approve({ runId, approved, resolvedBy = '' } = {}) {
      if (!runId) {
        const error = new Error('runId 不能为空')
        error.code = 'RUN_NOT_FOUND'
        throw error
      }
      const approval = approvalGate.get(runId)
      if (!approval) {
        const error = new Error(`审批 ${runId} 不存在或已处理`)
        error.code = 'RUN_NOT_FOUND'
        throw error
      }
      const result = approvalGate.resolve({ runId, approved, resolvedBy, detail: '' })
      try {
        store.appendOperation({
          action: approved ? 'approval-resolved' : 'approval-rejected',
          project: result.project,
          target: result.target,
          runId,
          status: result.status,
          detail: JSON.stringify({ resolvedBy, resolvedAt: result.resolvedAt }),
        })
      } catch { /* best effort */ }
      return { ok: true, runId, status: result.status, approved, resolvedBy, resolvedAt: result.resolvedAt }
    },
    approvals({ project = '', status = '' } = {}) {
      return approvalGate.list({ project, status })
    },
    secrets(args = {}) {
      const { project = '', scope = 'global', name = '', value = '' } = args
      if (name) {
        if (!value) {
          const error = new Error('设置 secret 需要 value')
          error.code = 'COMMAND_INVALID'
          throw error
        }
        const ref = secrets.set(project, scope, name, value)
        return { ref, project, scope, name }
      }
      return { project, scope, secrets: secrets.list(project, scope) }
    },
    environments(projectId = '') {
      const project = pickProject(options, projectId)
      const pipe = readPipe(project)
      const envs = normalizeEnvironments(pipe.targets)
      const fromName = project.defaultTarget || ''
      const path = promotionPath(envs, fromName)
      return { project: project.id, environments: Object.values(envs).sort((a, b) => a.order - b.order), promotionPath: path }
    },
    // V2-M5：RBAC（server 模式三角色 + token TTL + 审计）
    rbac(args = {}) {
      const { user = '', role = '', projects = ['*'], ttlSec = 0, action = '' } = args
      if (action === 'verify' || args.token) {
        const token = args.token || ''
        const info = rbac.verifyToken(token)
        return { ok: true, user: info.user, role: info.role, projects: info.projects, expiresAt: info.expiresAt }
      }
      if (action === 'audit') {
        return { ok: true, audit: rbac.exportAudit() }
      }
      if (action === 'revoke') {
        if (!user) {
          const error = new Error('revoke 需要 user')
          error.code = 'RBAC_INVALID'
          throw error
        }
        const ok = rbac.revoke(user)
        return { ok, user }
      }
      if (role) {
        if (!user) {
          const error = new Error('签发 token 需要 user')
          error.code = 'RBAC_INVALID'
          throw error
        }
        const result = rbac.createToken(user, role, projects, ttlSec)
        return { ok: true, ...result }
      }
      return { ok: true, users: rbac.users(), audit: rbac.exportAudit().slice(-20) }
    },
    status({ project: projectId, limit = 20 } = {}) {
      return { runs: store.runs({ project: projectId, limit }).map(runSummary), running: activeRunList(projectId) }
    },
    logs({ runId, tail = 200 } = {}) {
      if (!runId) throw Object.assign(new Error('runId 不能为空'), { code: 'RUN_NOT_FOUND' })
      const run = store.run(runId)
      if (!run) throw Object.assign(new Error(`运行 ${runId} 不存在`), { code: 'RUN_NOT_FOUND' })
      const raw = store.readLog(runId, { tail })
      const clipped = clampLog(raw, options.maxLogBytes)
      const totalLines = raw ? raw.split('\n').length : 0
      const running = activeRuns.get(runId) || null
      return {
        runId,
        status: run.status,
        active: Boolean(running),
        canceling: Boolean(running?.canceling),
        logPath: store.logPath(runId),
        totalLines,
        tail,
        truncated: clipped.truncated,
        text: clipped.text,
      }
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
    async projectMeta({ project: projectId } = {}) {
      const project = pickProject(options, projectId)
      const meta = readGitMeta(project.path)
      const hasPipe = existsSync(project.pipe)
      return {
        project: project.id,
        isRepo: meta.isRepo,
        branch: meta.branch,
        commit: meta.commit,
        commitShort: meta.commitShort,
        tag: meta.tag,
        message: meta.message,
        dirty: meta.dirty,
        pipe: project.pipe,
        hasPipe,
        pipeSource: hasPipe ? readFileSync(project.pipe, 'utf8') : '',
        triggers: (() => {
          const triggers = triggersOf(project)
          return triggers ? triggerSummary(triggers) : null
        })(),
      }
    },
    async createProject({ kind = 'static', name = '', path = '', repoUrl = '', branch = '' } = {}) {
      let dir
      if (repoUrl) {
        // 从 git 新建：clone 到 workDir/<name>（名字冲突则加 -2 后缀），再按分支确定默认分支名。
        const base = slugProjectId(name || basename(String(repoUrl).replace(/\.git$/, '')))
        const root = options.workDir
        let candidate = join(root, base)
        let index = 2
        while (existsSync(candidate)) { candidate = join(root, `${base}-${index}`); index += 1 }
        const branchArg = branch || ''
        try { await cloneRepo({ url: repoUrl, dir: candidate, branch: branchArg }) }
        catch (error) { throw Object.assign(new Error(error.message || 'git clone 失败'), { code: error.code || 'GIT_CLONE_FAILED' }) }
        dir = candidate
      } else {
        // 从本地新建：path 给的是目标目录；空则用 workDir/<name>。
        if (typeof path !== 'string' || !path.trim()) throw Object.assign(new Error('本地项目需要指定 path（或提供 repoUrl）'), { code: 'PROJECT_CREATE_FAILED' })
        dir = path.trim()
      }
      const pipePath = join(dir, 'pipe.yml')
      if (existsSync(pipePath)) throw Object.assign(new Error(`目录里已有 pipe.yml：${pipePath}`), { code: 'PROJECT_CREATE_FAILED' })
      mkdirSync(dir, { recursive: true })
      const id = uniqueProjectId(options.projects, name || basename(dir))
      const pipeSource = scaffoldPipe({ name: name || basename(dir), kind, hosts: ['host1'], path: `/srv/${name || basename(dir)}` })
      writeFileSync(pipePath, pipeSource, 'utf8')
      const meta = readGitMeta(dir)
      const defaultBranch = branch || meta.branch || ''
      const project = {
        id,
        name: name || basename(dir),
        path: dir,
        pipe: pipePath,
        env: {},
        sourceType: repoUrl ? 'git' : 'local',
        repoUrl: repoUrl || '',
        defaultBranch,
      }
      store.upsertProject({
        id,
        name: project.name,
        source_type: project.sourceType,
        repo_url: project.repoUrl,
        default_branch: defaultBranch,
        path: dir,
        pipe_path: pipePath,
      })
      options.projects.push(project)
      return {
        id,
        name: project.name,
        path: dir,
        pipe: pipePath,
        sourceType: project.sourceType,
        repoUrl: project.repoUrl,
        defaultBranch,
        branch: meta.branch,
        commit: meta.commit,
        pipeSource,
      }
    },
    validatePipe({ source = '', project: projectId = '' } = {}) {
      // 「保存前校验」：source 给定时校验编辑器里的原始文本；否则校验项目落盘的 pipe.yml。
      // 解析失败不抛异常，而是返回带行号的诊断，供编辑器点击定位。
      let text = source
      let path = 'pipe.yml'
      if (text === '') {
        const project = pickProject(options, projectId)
        if (!existsSync(project.pipe)) {
          return { ok: false, error: `找不到 pipe 文件：${project.pipe}`, code: 'PIPE_NOT_FOUND', line: 0 }
        }
        path = project.pipe
        text = readFileSync(project.pipe, 'utf8')
      }
      try {
        const pipe = parsePipe(text, { path })
        return {
          ok: true,
          path,
          name: pipe.name,
          version: pipe.version,
          targets: Object.keys(pipe.targets),
          stages: pipe.stages.map((stage) => ({
            id: stage.id,
            needs: stage.needs || [],
            manual: Boolean(stage.manual),
            stepCount: (stage.steps || []).length,
          })),
        }
      } catch (error) {
        return { ok: false, error: error.message || String(error), code: error.code || 'PIPE_INVALID', line: error.line || 0 }
      }
    },
    savePipe({ project: projectId = '', source = '' } = {}) {
      // 「保存前校验」的写盘半程：先 parsePipe 校验，解析失败不写盘并返回带行号诊断；
      // 通过则覆盖项目落盘 pipe.yml。这样编辑器可以「校验通过才落盘」，避免把坏配置写坏文件。
      const project = pickProject(options, projectId)
      const text = typeof source === 'string' ? source : ''
      if (!text.trim()) {
        return { ok: false, error: 'source 不能为空', code: 'PIPE_INVALID', line: 0 }
      }
      try {
        const pipe = parsePipe(text, { path: project.pipe })
        writeFileSync(project.pipe, text, 'utf8')
        return {
          ok: true,
          path: project.pipe,
          name: pipe.name,
          version: pipe.version,
          targets: Object.keys(pipe.targets),
          stages: pipe.stages.map((stage) => ({
            id: stage.id,
            needs: stage.needs || [],
            manual: Boolean(stage.manual),
            stepCount: (stage.steps || []).length,
          })),
        }
      } catch (error) {
        return { ok: false, error: error.message || String(error), code: error.code || 'PIPE_INVALID', line: error.line || 0 }
      }
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
      try { scheduler?.stop() } catch { /* scheduler timers are best effort */ }
      try { hub.dispose() } catch { /* hub observers are best effort */ }
      try { approvalGate.dispose() } catch { /* approval gate is in-memory */ }
      activeRuns.clear()
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

const STRATEGY_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string' },
    batch: { type: 'number' },
    waitSec: { type: 'number' },
    first: { type: 'number' },
    onHostFailure: { type: 'string' },
  },
}

const RUN_SCHEMA = {
  type: 'object',
  properties: {
    runId: { type: 'string' },
    status: { type: 'string' },
    project: { type: 'string' },
    target: { type: 'string' },
    runnerId: { type: 'string' },
    dryRun: { type: 'boolean' },
    hosts: { type: 'array', items: { type: 'string' } },
    selectors: { type: 'array', items: { type: 'string' } },
    envs: { type: 'array', items: { type: 'string' } },
    prodHosts: { type: 'array', items: { type: 'string' } },
    canary: CANARY_SCHEMA,
    strategy: STRATEGY_SCHEMA,
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

function renderValidate(_args, value) {
  if (!value.ok) {
    const line = value.line > 0 ? `（第 ${value.line} 行）` : ''
    return textBlocks(`校验失败${line}：${value.error}${value.code ? ` [${value.code}]` : ''}`)
  }
  const lines = [
    `校验通过：${value.name}（version ${value.version}）`,
    `targets: ${value.targets.join('、') || '（无）'}`,
    `stages: ${value.stages.map((stage) => stage.id).join(' → ') || '（无）'}`,
  ]
  return textBlocks(lines.join('\n'))
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
          projects: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, path: { type: 'string' }, pipe: { type: 'string' }, hasPipe: { type: 'boolean' }, sourceType: { type: 'string' }, repoUrl: { type: 'string' }, defaultBranch: { type: 'string' } } } },
        },
      },
      render: renderProjects,
    },
    async execute() { return runtime.listProjects() },
  })

  register({
    name: 'cicd_project_meta',
    description: '读取一个项目的本地 git 元数据（分支、提交、精确 tag、最近提交信息、工作区是否脏）。',
    parameters: { type: 'object', properties: { project: PROJECT_PARAM } },
    output: {
      schema: {
        type: 'object',
        properties: {
          project: { type: 'string' }, isRepo: { type: 'boolean' }, branch: { type: 'string' },
          commit: { type: 'string' }, commitShort: { type: 'string' }, tag: { type: 'string' },
          message: { type: 'string' }, dirty: { type: 'boolean' },
          pipe: { type: 'string' }, hasPipe: { type: 'boolean' }, pipeSource: { type: 'string' },
        },
      },
      render(_args, value) {
        const lines = [`项目 ${value.project}：${value.isRepo ? `分支 ${value.branch || '（游离 HEAD）'} · ${value.commitShort || '?'}${value.tag ? ` · tag ${value.tag}` : ''}${value.dirty ? ' · 工作区脏' : ''}` : '不是 git 仓库'}`]
        if (value.message) lines.push(`最近提交：${value.message}`)
        if (value.hasPipe) { lines.push(`--- ${value.pipe || 'pipe.yml'} ---`, value.pipeSource || '') }
        return textBlocks(lines.join('\n'))
      },
    },
    async execute(args = {}) { return runtime.projectMeta({ project: args.project }) },
  })

  register({
    name: 'cicd_project_create',
    description: '新建一个项目：生成 pipe.yml 脚手架（可选从 git clone），并持久化到项目列表。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: '脚手架模板：static / node / python / go / bare（默认 static）' },
        name: { type: 'string', description: '项目名（缺省取 path 的目录名或 repo 名）' },
        path: { type: 'string', description: '本地目标目录（repoUrl 为空时必填；默认 workDir/<name>）' },
        repoUrl: { type: 'string', description: 'git 仓库地址（给定时 clone 到 workDir/<name>）' },
        branch: { type: 'string', description: 'clone 的分支名（可选）' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' }, name: { type: 'string' }, path: { type: 'string' }, pipe: { type: 'string' },
          sourceType: { type: 'string' }, repoUrl: { type: 'string' }, defaultBranch: { type: 'string' },
          branch: { type: 'string' }, commit: { type: 'string' }, pipeSource: { type: 'string' },
        },
      },
      render(_args, value) {
        const lines = [`已创建项目 ${value.id}（${value.name}）`, `目录：${value.path}`, `来源：${value.sourceType}${value.repoUrl ? ` · ${value.repoUrl}` : ''}`]
        if (value.branch) lines.push(`分支：${value.branch}${value.commit ? `（${value.commit.slice(0, 7)}）` : ''}`)
        lines.push(`--- pipe.yml ---`, value.pipeSource || '')
        return textBlocks(lines.join('\n'))
      },
    },
    async execute(args = {}) {
      return runtime.createProject({ kind: args.kind || 'static', name: args.name || '', path: args.path || '', repoUrl: args.repoUrl || '', branch: args.branch || '' })
    },
  })

  register({
    name: 'cicd_validate',
    description: '校验 pipe.yml（保存前校验）：source 传编辑器里的原始文本，或 project 校验落盘文件；解析失败返回带行号的诊断。',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'pipe.yml 原始文本（校验编辑器里尚未保存的内容；省略则校验项目落盘文件）' },
        project: PROJECT_PARAM,
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          path: { type: 'string' }, name: { type: 'string' }, version: { type: 'number' },
          targets: { type: 'array', items: { type: 'string' } },
          stages: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, needs: { type: 'array', items: { type: 'string' } }, manual: { type: 'boolean' }, stepCount: { type: 'number' } } } },
          error: { type: 'string' }, code: { type: 'string' }, line: { type: 'number' },
        },
      },
      render: renderValidate,
    },
    execute(args = {}) { return runtime.validatePipe({ source: args.source || '', project: args.project || '' }) },
  })

  register({
    name: 'cicd_pipe_save',
    description: '把 pipe.yml 源码写回项目（保存前校验：解析失败不写盘并返回带行号的诊断）。',
    parameters: {
      type: 'object',
      properties: {
        project: PROJECT_PARAM,
        source: { type: 'string', description: '完整的 pipe.yml 原始文本' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          path: { type: 'string' }, name: { type: 'string' }, version: { type: 'number' },
          targets: { type: 'array', items: { type: 'string' } },
          stages: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, needs: { type: 'array', items: { type: 'string' } }, manual: { type: 'boolean' }, stepCount: { type: 'number' } } } },
          error: { type: 'string' }, code: { type: 'string' }, line: { type: 'number' },
        },
      },
      render: renderValidate,
    },
    async execute(args = {}) { return runtime.savePipe({ project: args.project || '', source: args.source || '' }) },
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
    description: '执行一次流水线：本地构建步骤、SSH 发布与自动回滚。dryRun 只返回计划；confirm 必须为 true；runner 可选远端 runner id。',
    parameters: {
      type: 'object',
      properties: {
        project: PROJECT_PARAM,
        target: TARGET_PARAM,
        stage: { type: 'string', description: '只跑到指定 stage（含它的 needs）' },
        dryRun: { type: 'boolean', description: '只打印计划，不执行命令、不写运行记录' },
        confirm: { type: 'boolean', description: '确认执行（默认 true；显式 false 会被拒绝）' },
        confirmProd: { type: 'boolean', description: '目标展开后含 env=prod 的主机时才需要；为 true 表示已确认生产发布' },
        runner: { type: 'string', description: '远端 runner id（V2-M2 执行面）；省略或 local 则本机执行' },
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
        runnerId: args.runner || '',
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
      schema: { type: 'object', properties: { project: { type: 'string' }, targets: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, hosts: { type: 'array', items: { type: 'string' } }, path: { type: 'string' }, runtime: { type: 'string' }, app: { type: 'string' }, onHostFailure: { type: 'string' }, keep: { type: 'number' }, canary: { type: 'object', properties: { first: { type: 'number' }, waitSec: { type: 'number' } } }, strategy: STRATEGY_SCHEMA, restartCommand: { type: 'string' }, service: { type: 'string' }, restart: { type: 'string' }, health: { type: 'string' }, current: { type: 'string' }, selectors: { type: 'array', items: { type: 'string' } }, envs: { type: 'array', items: { type: 'string' } }, prodHosts: { type: 'array', items: { type: 'string' } }, envsUnknown: { type: 'boolean' }, active: { type: 'array', items: { type: 'object', properties: { host: { type: 'string' }, releaseId: { type: 'string' } } } } } } } } },
      render: renderTargets,
    },
    async execute(args = {}) { return runtime.targets({ project: args.project }) },
  })

  // ---- V2-M1：取消 / DORA / 触发配置 --------------------------------------------------------
  register({
    name: 'cicd_runners',
    description: '列出已注册的远端构建主机（runner）：id、标签、容量、在线状态、在跑任务数。V2-M2 执行面。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        properties: {
          runners: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                runnerId: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } },
                version: { type: 'string' }, capacity: { type: 'number' },
                lastSeenAt: { type: 'string' }, status: { type: 'string' }, active: { type: 'boolean' },
              },
            },
          },
        },
      },
      render(_args, value) {
        const runners = Array.isArray(value.runners) ? value.runners : []
        if (runners.length === 0) return textBlocks('（还没有注册的远端 runner；本机执行面始终是 local）')
        const lines = ['远端构建主机：']
        for (const runner of runners) {
          const label = Array.isArray(runner.labels) && runner.labels.length > 0 ? ` [${runner.labels.join(',')}]` : ''
          lines.push(`  ${runner.runnerId} · ${runner.status}${label}${runner.active ? ' · 有在跑任务' : ''}`)
        }
        return textBlocks(lines.join('\n'))
      },
    },
    async execute() { return { runners: runtime.runners() } },
  })

  register({
    name: 'cicd_cancel',
    description: '取消一次正在运行的流水线：终止步骤进程树，运行记录标为 canceled。',
    parameters: { type: 'object', properties: { runId: { type: 'string', description: '运行 id（cicd_run / cicd_status 返回）' } }, required: ['runId'] },
    output: {
      schema: {
        type: 'object',
        properties: {
          runId: { type: 'string' }, project: { type: 'string' }, target: { type: 'string' },
          status: { type: 'string' }, trigger: { type: 'string' }, branch: { type: 'string' },
          commit: { type: 'string' }, startedAt: { type: 'string' },
        },
      },
      render(_args, value) {
        return textBlocks(`已请求取消 ${value.runId}（${value.project || '?'} / ${value.target || '?'}）${value.status === 'canceling' ? '，正在终止当前步骤' : ''}`)
      },
    },
    async execute(args = {}) { return runtime.cancel({ runId: args.runId }) },
  })

  register({
    name: 'cicd_dora',
    description: 'DORA 四指标：部署频率、变更前置时间、变更失败率、MTTR（默认最近 30 天，只看真实运行）。',
    parameters: {
      type: 'object',
      properties: {
        project: PROJECT_PARAM,
        days: { type: 'number', description: '统计窗口天数（1-365，默认 30）' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          project: { type: 'string' }, windowDays: { type: 'number' }, from: { type: 'string' }, to: { type: 'string' },
          total: { type: 'number' }, deployments: { type: 'number' }, failures: { type: 'number' },
          deploymentFrequency: { type: 'object', properties: { deployments: { type: 'number' }, perDay: { type: 'number' }, perWeek: { type: 'number' } } },
          leadTimeHours: { type: 'object', properties: { avg: { type: 'number' }, median: { type: 'number' }, samples: { type: 'number' } } },
          changeFailureRate: { type: 'number' },
          mttrHours: { type: 'object', properties: { avg: { type: 'number' }, samples: { type: 'number' } } },
          levels: { type: 'object', properties: { deploymentFrequency: { type: 'string' }, leadTime: { type: 'string' }, changeFailureRate: { type: 'string' }, mttr: { type: 'string' } } },
          series: { type: 'array', items: { type: 'object', properties: { date: { type: 'string' }, deployments: { type: 'number' }, failures: { type: 'number' }, canceled: { type: 'number' } } } },
        },
      },
      render(_args, value) {
        const frequency = value.deploymentFrequency?.perDay ?? 0
        const lead = value.leadTimeHours?.avg
        const mttr = value.mttrHours?.avg
        const level = (name) => value.levels?.[name] ? `(${value.levels[name]})` : ''
        const lines = [
          `DORA · 最近 ${value.windowDays} 天${value.project ? ` · 项目 ${value.project}` : ''}`,
          `部署频率：${value.deployments} 次，${frequency}/天 ${level('deploymentFrequency')}`,
          `变更前置时间：${lead === null || lead === undefined ? '无样本' : `${lead}h`} ${level('leadTime')}`,
          `变更失败率：${Math.round((value.changeFailureRate || 0) * 100)}% ${level('changeFailureRate')}`,
          `MTTR：${mttr === null || mttr === undefined ? '无样本' : `${mttr}h`} ${level('mttr')}`,
          `合计运行 ${value.total} 次（失败 ${value.failures}）`,
        ]
        return textBlocks(lines.join('\n'))
      },
    },
    async execute(args = {}) { return runtime.dora({ project: args.project, days: args.days }) },
  })

  register({
    name: 'cicd_triggers',
    description: '查看项目的触发配置：push 分支/tag 规则、cron 定时、手动；以及调度器状态与 webhook 地址。',
    parameters: { type: 'object', properties: { project: PROJECT_PARAM } },
    output: {
      schema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          triggers: {
            type: 'object',
            properties: {
              push: { type: 'boolean' }, branches: { type: 'array', items: { type: 'string' } },
              tags: { type: 'array', items: { type: 'string' } },
              schedules: { type: 'array', items: { type: 'object', properties: { cron: { type: 'string' }, target: { type: 'string' } } } },
              manual: { type: 'boolean' },
            },
          },
          schedulers: { type: 'object', properties: { started: { type: 'boolean' }, tickSec: { type: 'number' }, pollSec: { type: 'number' }, lastError: { type: 'string' } } },
          webhook: { type: 'object', properties: { url: { type: 'string' }, requiresToken: { type: 'boolean' }, target: { type: 'string' }, branches: { type: 'array', items: { type: 'string' } }, tags: { type: 'array', items: { type: 'string' } } } },
        },
      },
      render(_args, value) {
        const lines = [`项目 ${value.project} 的触发方式：`]
        lines.push(`- 手动：${value.triggers.manual ? '开' : '关'}`)
        if (value.triggers.push) lines.push(`- push：branches=${value.triggers.branches.join(',') || '无'} tags=${value.triggers.tags.join(',') || '无'}`)
        for (const item of value.triggers.schedules) lines.push(`- cron：${item.cron}${item.target ? ` → ${item.target}` : ''}`)
        if (value.webhook) lines.push(`- webhook：${value.webhook.url || '（无 webServer 端口）'}${value.webhook.requiresToken ? '（需要 token）' : '（未设置 secret，未启用）'}`)
        if (value.schedulers) {
          lines.push(`调度器：${value.schedulers.started ? '运行中' : '未启动'} · tick ${value.schedulers.tickSec}s · poll ${value.schedulers.pollSec}s`)
          if (value.schedulers.lastError) lines.push(`最近错误：${value.schedulers.lastError}`)
        }
        return textBlocks(lines.join('\n'))
      },
    },
    async execute(args = {}) { return runtime.triggers({ project: args.project }) },
  })

  // V2-M4：审批（block gate）
  register({
    name: 'cicd_approve',
    description: '通过或拒绝一条待审批的部署（/approve 路由）。prod 环境默认 manual: true，审批通过后仍走 confirm=prod 护栏。',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: '运行 id（executeRun 返回的 runId）' },
        decision: { type: 'string', enum: ['approve', 'reject'], description: '审批决定' },
        resolvedBy: { type: 'string', description: '审批人（默认 ui）' },
      },
      required: ['runId'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          runId: { type: 'string' },
          status: { type: 'string' },
        },
      },
      render(_args, value) {
        return textBlocks(`审批 ${value.runId}：${value.status || '成功'}`)
      },
    },
    async execute(args = {}) {
      return runtime.approve({
        runId: args.runId,
        approved: args.decision !== 'reject',
        resolvedBy: args.resolvedBy || 'agent',
      })
    },
  })

  // V2-M4：secrets（DB 只存 ref，载荷落 workDir/.secrets.json）
  register({
    name: 'cicd_secrets',
    description: '列出或设置项目的 secret（DB 只存 ref，载荷不落明文到日志/DB）。pipe.yml 里 ${{SECRET_NAME}} 插值时自动注入。',
    parameters: {
      type: 'object',
      properties: {
        project: PROJECT_PARAM,
        scope: { type: 'string', description: '作用域（默认 global）' },
        name: { type: 'string', description: 'secret 名（设置时必填）' },
        value: { type: 'string', description: 'secret 值（设置时必填）' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          project: { type: 'string' },
          scope: { type: 'string' },
          name: { type: 'string' },
          secrets: { type: 'array', items: { type: 'object', properties: { ref: { type: 'string' }, scope: { type: 'string' }, name: { type: 'string' }, createdAt: { type: 'string' } } } },
        },
      },
      render(_args, value) {
        if (value.ref) return textBlocks(`已设置 secret ${value.name}（ref=${value.ref}）`)
        const lines = [`项目 ${value.project || '全局'} 的 secrets：`]
        if (!value.secrets || value.secrets.length === 0) lines.push('- （空）')
        for (const item of value.secrets || []) lines.push(`- ${item.name}（ref=${item.ref}，${item.scope}，${item.createdAt}）`)
        return textBlocks(lines.join('\n'))
      },
    },
    async execute(args = {}) {
      return runtime.secrets(args)
    },
  })

  // V2-M4：environments（dev/staging/prod 环境 + 晋升路径）
  register({
    name: 'cicd_environments',
    description: '列出项目的环境（dev/staging/prod）与晋升路径；prod 默认 protected + approvalRequired。',
    parameters: {
      type: 'object',
      properties: { project: PROJECT_PARAM },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          environments: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, order: { type: 'number' }, protected: { type: 'boolean' }, approvalRequired: { type: 'boolean' } } } },
          promotionPath: { type: 'array', items: { type: 'string' } },
        },
      },
      render(_args, value) {
        const lines = [`项目 ${value.project || '全局'} 的环境：`]
        for (const item of value.environments || []) lines.push(`- ${item.name}（order=${item.order}${item.protected ? '，protected' : ''}${item.approvalRequired ? '，需审批' : ''}）`)
        if (value.promotionPath) lines.push(`晋升路径：${value.promotionPath.join(' → ')}`)
        return textBlocks(lines.join('\n'))
      },
    },
    async execute(args = {}) {
      return runtime.environments(args.project || '')
    },
  })

  // V2-M5：RBAC（server 模式三角色 + token TTL + 审计导出）
  register({
    name: 'cicd_rbac',
    description: '签发/校验/吊销 RBAC token（viewer/operator/admin），列出用户与审计时间线。server 模式启用，单机模式无角色。',
    parameters: {
      type: 'object',
      properties: {
        user: { type: 'string', description: '用户名（签发/吊销时必填）' },
        role: { type: 'string', enum: ['viewer', 'operator', 'admin'], description: '角色（签发时必填）' },
        projects: { type: 'string', description: '项目范围逗号串（如 "web,api"，"*" 表示全量）' },
        ttlSec: { type: 'number', description: 'token 有效秒数（默认 3600）' },
        token: { type: 'string', description: '待校验的 token（action=verify 时填）' },
        action: { type: 'string', enum: ['', 'verify', 'revoke', 'audit'], description: 'verify=校验 token / revoke=吊销用户 / audit=导出审计' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          token: { type: 'string' },
          user: { type: 'string' },
          role: { type: 'string' },
          projects: { type: 'array', items: { type: 'string' } },
          expiresAt: { type: 'string' },
          users: { type: 'array', items: { type: 'object', properties: { user: { type: 'string' }, role: { type: 'string' }, projects: { type: 'array', items: { type: 'string' } }, expiresAt: { type: 'string' } } } },
          audit: { type: 'array', items: { type: 'object', properties: { at: { type: 'string' }, user: { type: 'string' }, action: { type: 'string' }, project: { type: 'string' }, status: { type: 'string' }, detail: { type: 'string' } } } },
        },
      },
      render(_args, value) {
        const lines = []
        if (value.token) lines.push(`已签发 token：${value.user}（${value.role}，projects=${value.projects.join(',') || '*'}，过期 ${value.expiresAt}）`)
        if (value.user && !value.token && value.role) lines.push(`校验 token：${value.user}（${value.role}，过期 ${value.expiresAt}）`)
        if (value.users) {
          lines.push('用户列表：')
          if (value.users.length === 0) lines.push('- （空）')
          for (const item of value.users) lines.push(`- ${item.user}（${item.role}，projects=${item.projects.join(',') || '*'}，过期 ${item.expiresAt}）`)
        }
        if (value.audit && value.audit.length > 0) {
          lines.push('审计（最近 20 条）：')
          for (const item of value.audit.slice(-20)) lines.push(`- ${item.at} ${item.action}${item.project ? ` [${item.project}]` : ''} ${item.status}${item.detail ? ` ${item.detail}` : ''}`)
        }
        return textBlocks(lines.join('\n') || 'RBAC 操作完成')
      },
    },
    async execute(args = {}) {
      return runtime.rbac({
        user: args.user || '',
        role: args.role || '',
        projects: args.projects ? String(args.projects).split(',').map((s) => s.trim()).filter(Boolean) : ['*'],
        ttlSec: Number(args.ttlSec || 0),
        token: args.token || '',
        action: args.action || '',
      })
    },
  })
}

// ---------------------------------------------------------------------------------------------
// HTTP routes

function errorStatus(error) {
  const code = error?.code || ''
  if (code === 'PROJECT_NOT_FOUND' || code === 'TARGET_NOT_FOUND' || code === 'RUN_NOT_FOUND' || code === 'RELEASE_NOT_FOUND' || code === 'STAGE_NOT_FOUND' || code === 'RUNNER_NOT_FOUND') return 404
  if (code === 'REMOTE_UNAVAILABLE') return 503
  if (code === 'HEALTH_FAILED') return 502
  if (code === 'PIPE_NOT_FOUND') return 404
  if (code === 'PROD_CONFIRM_REQUIRED' || code === 'DEPLOY_IN_PROGRESS') return 409
  if (code === 'RUN_NOT_ACTIVE') return 409
  // V2-M1：入站 webhook。token 不符按安全模型用 401；未配置 secret / 不是 push 触发用 403。
  if (code === 'WEBHOOK_UNAUTHORIZED') return 401
  if (code === 'WEBHOOK_DISABLED') return 403
  if (code === 'WEBHOOK_INVALID') return 400
  // V2-M2：远端 runner join token 校验失败按 401。
  if (code === 'RUNNER_UNAUTHORIZED') return 401
  // V2-M4：审批门——需要审批但尚未通过。
  if (code === 'APPROVAL_REQUIRED') return 409
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

async function projectMetaResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['project']))
  if (bad) return json({ ok: false, error: bad }, 400)
  try {
    const data = await runtime.projectMeta({ project: params.get('project') || '' })
    return json({ ok: true, ...data })
  } catch (error) { return errorJson(error) }
}

async function projectCreateResource(request, runtime) {
  const params = queryOf(request)
  const guard = requireWrite(request, params)
  if (guard) return guard
  const bad = unsupportedParams(params, new Set(['kind', 'name', 'path', 'repoUrl', 'branch', 'confirm']))
  if (bad) return json({ ok: false, error: bad }, 400)
  try {
    const data = await runtime.createProject({
      kind: params.get('kind') || 'static',
      name: params.get('name') || '',
      path: params.get('path') || '',
      repoUrl: params.get('repoUrl') || '',
      branch: params.get('branch') || '',
    })
    return json({ ok: true, ...data })
  } catch (error) { return errorJson(error) }
}

async function validateResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['source', 'project']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const data = runtime.validatePipe({ source: params.get('source') || '', project: params.get('project') || '' })
  return json(data)
}

async function pipeSaveResource(request, runtime) {
  const params = queryOf(request)
  const guard = requireWrite(request, params)
  if (guard) return guard
  const bad = unsupportedParams(params, new Set(['project', 'source', 'confirm']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const data = runtime.savePipe({ project: params.get('project') || '', source: params.get('source') || '' })
  return json(data)
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
  const bad = unsupportedParams(params, new Set(['project', 'target', 'stage', 'dryRun', 'confirm', 'runner']))
  if (bad) return json({ ok: false, error: bad }, 400)
  try {
    const data = await runtime.run({
      projectId: params.get('project') || '',
      targetName: params.get('target') || '',
      stage: params.get('stage') || '',
      dryRun: params.get('dryRun') === '1' || params.get('dryRun') === 'true',
      confirmProd: params.get('confirm') === 'prod',
      runnerId: params.get('runner') || '',
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

// ---- V2-M1 资源：cancel / dora / triggers / hooks（prefix）/ log-ws（upgrade） ----------------

async function cancelResource(request, runtime) {
  const params = queryOf(request)
  const guard = requireWrite(request, params)
  if (guard) return guard
  const bad = unsupportedParams(params, new Set(['runId', 'confirm']))
  if (bad) return json({ ok: false, error: bad }, 400)
  try { return json({ ok: true, ...runtime.cancel({ runId: params.get('runId') || '' }) }) } catch (error) { return errorJson(error) }
}

async function doraResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['project', 'days']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const raw = params.get('days')
  const days = raw === null || raw === '' ? undefined : Number(raw)
  if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 365)) {
    return json({ ok: false, error: 'days 必须是 1-365 的整数' }, 400)
  }
  try { return json({ ok: true, ...runtime.dora({ project: params.get('project') || '', days }) }) } catch (error) { return errorJson(error) }
}

async function triggersResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['project']))
  if (bad) return json({ ok: false, error: bad }, 400)
  try { return json({ ok: true, ...runtime.triggers({ project: params.get('project') || '' }) }) } catch (error) { return errorJson(error) }
}

/** prefix 路由：`/hooks/<project>?...`，项目 id 从路径末段取（允许 URL 编码）。 */
function hookProjectOf(request) {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname
    const prefix = `${ROUTE_PREFIX}/hooks/`
    if (!pathname.startsWith(prefix)) return ''
    return decodeURIComponent(pathname.slice(prefix.length).replace(/\/+$/, ''))
  } catch { return '' }
}

/**
 * 入站 webhook。故意不要求同源：请求来自 Git 托管方（GitHub/GitLab/本机 git hook），
 * 身份由 pipe 里的 triggers.push.secret 做 token 校验；无 secret 一律 403。
 */
async function hookResource(request, runtime) {
  const projectId = hookProjectOf(request)
  if (!projectId) return json({ ok: false, error: '缺少项目名：/hooks/<project>' }, 400)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['ref', 'sha', 'event', 'token', 'confirm']))
  if (bad) return json({ ok: false, error: bad }, 400)
  let token = params.get('token') || ''
  if (!token) { try { token = request.headers?.get?.('x-cicd-token') || '' } catch { token = '' } }
  try {
    const data = await runtime.hook({
      project: projectId,
      ref: params.get('ref') || '',
      sha: params.get('sha') || '',
      token,
      event: params.get('event') || 'push',
      confirmProd: params.get('confirm') === 'prod',
    })
    return json({ ok: true, ...data }, 202)
  } catch (error) { return errorJson(error) }
}

/**
 * `/log-ws?runId=` 升级处理器：握手成功后先推一帧 snapshot（hub 环形缓冲；运行已结束时回退读日志文件），
 * 运行中继续推 `line`/`end`；客户端断开或运行结束即关闭。只读，不需要同源头。
 */
function logWsHandler(runtime, request, socket, head) {
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['runId']))
  if (bad) { refuseUpgrade(socket, 400, bad); return }
  const runId = params.get('runId') || ''
  if (!runId) { refuseUpgrade(socket, 400, '缺少 runId'); return }
  const run = runtime.store.run(runId)
  const isActive = runtime.hub.activeRunIds().includes(runId)
  if (!run && !isActive) { refuseUpgrade(socket, 404, `运行 ${runId} 不存在`); return }
  const accept = performHandshake(request, socket, head)
  if (!accept) return
  const logSocket = new LogSocket(socket)
  const subscription = runtime.hub.subscribe(runId, (event) => {
    logSocket.sendJson(event)
    // 运行结束：先把 end 帧发出去，再主动收连接（浏览器端 onclose 可据此收尾）。
    if (event?.type === 'end') logSocket.finish('run-finished')
  })
  if (subscription.active) {
    logSocket.sendJson({ type: 'snapshot', runId, truncated: subscription.truncated, lines: subscription.snapshot })
    logSocket.onClose = () => subscription.unsubscribe()
    return
  }
  subscription.unsubscribe()
  const raw = runtime.store.readLog(runId, { tail: 2000 })
  const lines = String(raw || '').split('\n').filter((line) => line !== '')
  logSocket.sendJson({ type: 'snapshot', runId, truncated: false, lines: lines.map((line) => ({ line })) })
  logSocket.sendJson({ type: 'end', status: run?.status || 'unknown' })
  logSocket.finish('already-finished')
}

// ---- V2-M2 资源：runner-register / runner-poll / runner-result / runner-log / runners ----------------
// 远端 runner 走 /runner-* 路由：不要求同源（跨机调用），靠 join token + runnerId 鉴权。
// /runners 是面板读接口，要求同源。

async function runnerRegisterResource(request, runtime) {
  // 远端 runner 跨机注册：不要求同源，靠 join token + runnerId 鉴权。
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['runnerId', 'labels', 'version', 'capacity', 'token']))
  if (bad) return json({ ok: false, error: bad }, 400)
  try {
    const data = runtime.runnerRegister({
      runnerId: params.get('runnerId') || '',
      labels: params.get('labels') || '',
      version: params.get('version') || '',
      capacity: Number(params.get('capacity') || '1'),
      token: params.get('token') || '',
    })
    return json({ ok: true, ...data })
  } catch (error) { return errorJson(error) }
}

async function runnerPollResource(request, runtime) {
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['runnerId', 'token']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const runnerId = params.get('runnerId') || ''
  if (!runnerId) return json({ ok: false, error: '缺少 runnerId' }, 400)
  try {
    const data = runtime.runnerPoll({ runnerId })
    return json({ ok: true, ...data })
  } catch (error) { return errorJson(error) }
}

async function runnerResultResource(request, runtime) {
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['runnerId', 'taskId', 'status', 'exitCode', 'error']))
  if (bad) return json({ ok: false, error: bad }, 400)
  try {
    const data = runtime.runnerResult({
      taskId: params.get('taskId') || '',
      status: params.get('status') || 'failed',
      exitCode: Number(params.get('exitCode') || '-1'),
      error: params.get('error') || '',
    })
    return json({ ok: true, ...data })
  } catch (error) { return errorJson(error) }
}

async function runnerLogResource(request, runtime) {
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['runnerId', 'taskId', 'line']))
  if (bad) return json({ ok: false, error: bad }, 400)
  try {
    const data = runtime.runnerLog({ taskId: params.get('taskId') || '', line: params.get('line') || '' })
    return json({ ok: true, ...data })
  } catch (error) { return errorJson(error) }
}

async function runnersResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set())
  if (bad) return json({ ok: false, error: bad }, 400)
  try { return json({ ok: true, runners: runtime.runners() }) } catch (error) { return errorJson(error) }
}

// V2-M4：审批路由——/approve 通过/拒绝审批，/approvals 列出待审批/已审批记录。
async function approveResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  if (!hasCicdHeader(request)) return json({ ok: false, error: '缺少 x-dsh-cicd 头' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['runId', 'decision', 'resolvedBy', 'confirm']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const runId = params.get('runId') || ''
  if (!runId) return json({ ok: false, error: '缺少 runId' }, 400)
  const decision = params.get('decision') || 'approve'
  if (!['approve', 'reject'].includes(decision)) return json({ ok: false, error: `decision 只能是 approve 或 reject（收到 "${decision}"）` }, 400)
  if (!WRITE_CONFIRMS.has(params.get('confirm'))) return json({ ok: false, error: `写操作需要 confirm=${[...WRITE_CONFIRMS].join(' 或 ')}` }, 400)
  try {
    const result = runtime.approve({ runId, approved: decision === 'approve', resolvedBy: params.get('resolvedBy') || 'ui' })
    return json({ ok: true, ...result }, 200)
  } catch (error) { return errorJson(error) }
}

async function approvalsResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['project', 'status']))
  if (bad) return json({ ok: false, error: bad }, 400)
  try {
    const project = params.get('project') || ''
    const status = params.get('status') || ''
    return json({ ok: true, approvals: runtime.approvals({ project, status }) })
  } catch (error) { return errorJson(error) }
}

// V2-M4：secrets 路由——/secrets 列出/设置 secret（DB 只存 ref，载荷落 workDir/.secrets.json）。
async function secretsResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['project', 'scope', 'name', 'value']))
  if (bad) return json({ ok: false, error: bad }, 400)
  try {
    const project = params.get('project') || ''
    const scope = params.get('scope') || 'global'
    const name = params.get('name') || ''
    const value = params.get('value') || ''
    if (name) {
      if (!value) return json({ ok: false, error: '设置 secret 需要 value' }, 400)
      const ref = runtime.secrets({ project, scope, name, value })
      return json({ ok: true, ref, project, scope, name })
    }
    return json({ ok: true, secrets: runtime.secrets({ project, scope }).secrets })
  } catch (error) { return errorJson(error) }
}

// V2-M4：environments 路由——/environments 列出环境（dev/staging/prod）与晋升路径。
async function environmentsResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['project']))
  if (bad) return json({ ok: false, error: bad }, 400)
  try {
    const project = params.get('project') || ''
    return json({ ok: true, ...runtime.environments(project) })
  } catch (error) { return errorJson(error) }
}

// V2-M5：RBAC 路由——/rbac 签发/校验/吊销 token，列用户与审计时间线。
async function rbacResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['user', 'role', 'projects', 'ttlSec', 'token', 'action']))
  if (bad) return json({ ok: false, error: bad }, 400)
  try {
    const user = params.get('user') || ''
    const role = params.get('role') || ''
    const projectsRaw = params.get('projects') || ''
    const projects = projectsRaw ? projectsRaw.split(',').map((s) => s.trim()).filter(Boolean) : ['*']
    const ttlSec = Number(params.get('ttlSec') || 0)
    const token = params.get('token') || ''
    const action = params.get('action') || ''
    return json({ ok: true, ...runtime.rbac({ user, role, projects, ttlSec, token, action }) })
  } catch (error) { return errorJson(error) }
}

function registerHttpRoutes(ctx, runtime) {
  const web = ctx.get('webServer')
  if (!web || typeof web.register !== 'function') return
  const routes = [
    { kind: 'exact', path: `${ROUTE_PREFIX}/projects`, resource: (request) => projectsResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/project-meta`, resource: (request) => projectMetaResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/project-create`, resource: (request) => projectCreateResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/validate`, resource: (request) => validateResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/pipe-save`, resource: (request) => pipeSaveResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/plan`, resource: (request) => planResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/run`, resource: (request) => runResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/runs`, resource: (request) => runsResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/log`, resource: (request) => logResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/releases`, resource: (request) => releasesResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/rollback`, resource: (request) => rollbackResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/targets`, resource: (request) => targetsResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/operations`, resource: (request) => operationsResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/notify-test`, resource: (request) => notifyTestResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/cancel`, resource: (request) => cancelResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/dora`, resource: (request) => doraResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/triggers`, resource: (request) => triggersResource(request, runtime) },
    // V2-M2：远端 runner 拉取式协议
    { kind: 'exact', path: `${ROUTE_PREFIX}/runner-register`, resource: (request) => runnerRegisterResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/runner-poll`, resource: (request) => runnerPollResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/runner-result`, resource: (request) => runnerResultResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/runner-log`, resource: (request) => runnerLogResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/runners`, resource: (request) => runnersResource(request, runtime) },
    // V2-M4：审批 + secrets + environments
    { kind: 'exact', path: `${ROUTE_PREFIX}/approve`, resource: (request) => approveResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/approvals`, resource: (request) => approvalsResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/secrets`, resource: (request) => secretsResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/environments`, resource: (request) => environmentsResource(request, runtime) },
    // V2-M5：RBAC（server 模式三角色 + token TTL + 审计导出）
    { kind: 'exact', path: `${ROUTE_PREFIX}/rbac`, resource: (request) => rbacResource(request, runtime) },
    // 入站 webhook 是路径带项目名的前缀路由：/hooks/<project>
    { kind: 'prefix', path: `${ROUTE_PREFIX}/hooks`, resource: (request) => hookResource(request, runtime) },
  ]
  for (const route of routes) {
    try {
      const handle = web.register(route)
      const dispose = typeof handle === 'function' ? handle : handle?.dispose ? () => handle.dispose() : null
      if (dispose) ctx.effect(() => dispose)
    } catch { /* the tools still work without a page host */ }
  }
  // V2-M1：实时日志走 WebSocket upgrade（同源浏览器直连，不需要第二个端口）。
  if (typeof web.registerUpgrade === 'function') {
    try {
      const handle = web.registerUpgrade({
        path: `${ROUTE_PREFIX}/log-ws`,
        handler: (request, socket, head) => {
          try { logWsHandler(runtime, request, socket, head) } catch (error) {
            try { socket.destroy() } catch { /* socket already gone */ }
            void error
          }
        },
      })
      const dispose = typeof handle === 'function' ? handle : handle?.dispose ? () => handle.dispose() : null
      if (dispose) ctx.effect(() => dispose)
    } catch { /* the page falls back to GET /log polling */ }
  }
}

export function apply(ctx, config = {}) {
  const runtime = createRuntime(ctx, config)
  ctx.effect(() => () => runtime.dispose())
  registerTools(ctx, runtime)
  // V2-M1：进程内调度器随插件生命周期启动（dispose 时 stop）。定时器 unref，不会拖住进程退出。
  if (runtime.scheduler) {
    try { runtime.scheduler.start() } catch { /* 调度器起不来不影响手动运行 */ }
  }
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
  strategyDeployRelease,
  createScheduler,
  summarizeDora,
  createLiveHub,
  normalizeTriggers,
  cronMatches,
  minuteKey,
  encodeFrame,
  hookProjectOf,
  logWsHandler,
  createTaskBroker,
  createRemoteExecutor,
  joinTokenMatches,
  createApprovalGate,
  createSecretStore,
  normalizeEnvironments,
  createRbac,
  resources: {
    projectsResource, projectMetaResource, projectCreateResource, validateResource, pipeSaveResource, planResource,
    runResource, runsResource, logResource, releasesResource, rollbackResource, targetsResource,
    operationsResource, notifyTestResource, cancelResource, doraResource, triggersResource, hookResource,
    runnerRegisterResource, runnerPollResource, runnerResultResource, runnerLogResource, runnersResource,
    approveResource, approvalsResource, secretsResource, environmentsResource, rbacResource,
  },
}