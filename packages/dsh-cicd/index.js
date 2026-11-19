/**
 * Host half of @local/dsh-cicd — a local-first CI/CD for DSH.
 *
 * 26 tools, 33 exact GET/JSON HTTP routes, 1 prefix route (inbound webhook), 1 WebSocket
 * upgrade (realtime logs). Builds run locally (child_process) or on registered remote runners
 * (bin/runner.mjs pull protocol + journal idempotency); releases reuse the dsh-remote plugin
 * over loopback HTTP, so this package owns no SSH code and no credentials.
 *
 * v3.0-P0：所有写路由都过 `authorize()`（身份 → `can()` → 审计三件事），
 * 部署锁落 SQLite（重启后仍互斥），审计是哈希链（`/audit/verify` 可自证）。
 * v3.0-P1：DSL v2 调度内核 —— `stages[].jobs[]` + `needs` + `matrix` 归一成 job 图，
 * `lib/jobs.js` 按拓扑并发执行（默认并发 4），每个 job 一份分片日志，
 * run 落 pipe.yml 原文快照与 sha256（历史运行永远能解释自己）。
 * v3.0-P2：工具链（`toolchain:` 只写 vendor+版本，安装器按锁文件下载 + 校验 + 注入白名单 env，
 * 不改宿主）与 `uses:` 动作（checkout/toolchain/cache/collect/deploy/verify/notify 七个内置动作，
 * 不引用任何外部 action —— pipe.yml 是 PR 可改的文件）。
 */

import { createHash, timingSafeEqual, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import fs, { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
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
import { createArtifactStore, normalizeDigest, digestPath, parseRange, artifactError } from './lib/artifacts.js'
import { createApprovalGate } from './lib/approval.js'
import { normalizeEnvironments, promotionPath, isProtected, requiresApproval } from './lib/environments.js'
import { createRbac } from './lib/rbac.js'
import { createAuth, SESSION_COOKIE, ROLES, readSessionId } from './lib/auth.js'
import { createAudit } from './lib/audit.js'
import { createDeployLocks } from './lib/locks.js'
import { createRunnerRegistry } from './lib/runners.js'
import { can, ACTIONS, policyMatrix, isKnownAction } from './lib/policy.js'
import * as expr from './lib/expr.js'
import * as model from './lib/model.js'
import * as jobs from './lib/jobs.js'
import {
  createToolchain, envFor, assertVersions, inferFromFiles, writeDualLocks,
  LANGS as TOOLCHAIN_LANGS, TOOLCHAIN_ERRORS,
} from './lib/toolchain.js'
import { createCacheStore, CACHE_ERRORS } from './lib/cache.js'
import { deployTransaction, usesTransaction, planBatches, readManifest, DEPLOY_ERRORS } from './lib/deploy-engine.js'
import { createNativeActuator, NATIVE_COMMANDS, ACTUATOR_ERRORS, renderTemplate } from './lib/actuator/native.js'
import { createSlotStore, SLOT_ERRORS } from './lib/slots.js'
import { runAction, ACTIONS as PIPELINE_ACTIONS, ACTION_NAMES, ACTION_ERRORS } from './lib/actions.js'
import { runGit } from './lib/git.js'
import {
  OCI_ERRORS, ociStatus, ociError, parseRepository, parseOCIDigest, parseTag, parseReference,
  canonicalJson, validateManifest, manifestReferences, isManifestType,
  MEDIA_TYPES, createTokenIssuer, createUploadSessions, parseScope, scopeAllows,
} from './lib/oci.js'

export const name = '@local/dsh-cicd'
export const inject = ['tools']

const ROUTE_PREFIX = '/api/plugins/cicd'
const CICD_HEADER = 'x-dsh-cicd'
const CICD_HEADER_VALUE = '1'
const WRITE_HEADER = 'x-dsh-remote-exec'

const textBlocks = (text) => [{ type: 'text', text }]

function json(value, status = 200, headers = null) {
  return Response.json(value, { status, headers: headers || undefined })
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
  // v3.0-P0：身份与部署锁的可选配置。默认值刻意保守——引导期允许匿名（否则第一次装完谁也进不去），
  // 部署锁 TTL 30 分钟（足够一次全量部署，又不会让崩溃进程永久占锁）。
  const rawAuth = baseConfig.auth && typeof baseConfig.auth === 'object' ? baseConfig.auth : {}
  const rawDeploy = baseConfig.deploy && typeof baseConfig.deploy === 'object' ? baseConfig.deploy : {}
  const rawApproval = baseConfig.approval && typeof baseConfig.approval === 'object' ? baseConfig.approval : {}
  const rawRunners = baseConfig.runners && typeof baseConfig.runners === 'object' ? baseConfig.runners : {}
  const rawJobs = baseConfig.jobs && typeof baseConfig.jobs === 'object' ? baseConfig.jobs : {}
  const rawArtifacts = baseConfig.artifacts && typeof baseConfig.artifacts === 'object' ? baseConfig.artifacts : {}
  // v3.0-P2：工具链托管。机器级只允许配「放哪儿、能不能联网、信任什么源」，
  // **不放版本**——同一份 pipe.yml 在装了 JDK21 的机器和装了 JDK17 的机器上必须跑出同样的结果。
  const rawToolchain = baseConfig.toolchain && typeof baseConfig.toolchain === 'object' ? baseConfig.toolchain : {}
  // v3.0-P5-4：OCI 分发。token 密钥留空时启动生成一个随机密钥——它只保护「15 分钟内的一次 pull」，
  // 进程重启后旧票自然失效，这比要求运维先配置一个密钥更不容易出错。
  const rawRegistry = baseConfig.registry && typeof baseConfig.registry === 'object' ? baseConfig.registry : {}
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
    auth: {
      sessionTtlSec: clampInt(rawAuth.sessionTtlSec, 12 * 60 * 60, 60, 30 * 24 * 60 * 60),
      bootstrapAllowAnonymous: rawAuth.bootstrapAllowAnonymous !== false,
    },
    deploy: {
      lockTtlSec: clampInt(rawDeploy.lockTtlSec, 30 * 60, 30, 24 * 60 * 60),
    },
    approval: {
      ttlSec: clampInt(rawApproval.ttlSec, 4 * 60 * 60, 60, 7 * 24 * 60 * 60),
    },
    runners: {
      joinToken: typeof rawRunners.joinToken === 'string' ? rawRunners.joinToken : '',
      heartbeatSec: clampInt(rawRunners.heartbeatSec, 30, 5, 3600),
    },
    // v3.0-P5：制品 CAS 的根目录。默认挂在 workDir 下，跟着同一份备份走。
    artifacts: {
      dir: typeof rawArtifacts.dir === 'string' && rawArtifacts.dir ? rawArtifacts.dir : '',
      maxBytes: clampInt(rawArtifacts.maxBytes, 2 * 1024 * 1024 * 1024, 0, Number.MAX_SAFE_INTEGER),
    },
    // v3.0-P1：v2 图的并发度。默认 4 —— 一个 stage 里 4 个 lint/test job 并行够用，
    // 又不会在 2 核构建机上把命令执行器压死（每个 job 可能还在跑自己的子进程）。
    jobs: {
      concurrency: clampInt(rawJobs.concurrency, 4, 1, 32),
    },
    toolchain: {
      enabled: rawToolchain.enabled !== false,
      storeDir: typeof rawToolchain.storeDir === 'string' && rawToolchain.storeDir.trim() ? rawToolchain.storeDir.trim() : '',
      offline: rawToolchain.offline === true,
      // frozen 默认关：本地开发第一次跑没有锁文件也得能用；远端 runner 由部署方在配置里打开。
      frozen: rawToolchain.frozen === true,
      verifyChecksum: rawToolchain.verifyChecksum !== false,
      // 断言每个语言真的跑在声明的版本上。关掉它的唯一理由是「这颗树是交叉编译产物、跑不起来」。
      verify: rawToolchain.verify !== false,
    },
    registry: {
      enabled: rawRegistry.enabled !== false,
      // 密钥可以为空：createRuntime 里没给就现生成一个（进程内有效即可，见上面的注释）。
      secret: typeof rawRegistry.secret === 'string' ? rawRegistry.secret : '',
      tokenTtlSec: clampInt(rawRegistry.tokenTtlSec, 900, 60, 3600),
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
  const source = readFileSync(project.pipe, 'utf8')
  const pipe = parsePipe(source, { path: project.pipe })
  // v3.0-P1：配置快照。原始 YAML 与 sha256 挂在解析结果上，运行时由 runner 写进 runs 表。
  // 存原文而不是存解析后的对象：解析器将来加字段/改默认值时，历史运行仍能用当时那份配置解释。
  pipe.source = source
  pipe.hash = createHash('sha256').update(source).digest('hex')
  return pipe
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

/**
 * 「计划产物摘要」——审批闸门要绑的那串字节，在构建之前就必须能算出来。
 *
 * 为什么不直接 sha256 产物文件：审批请求发生在 run 开始之前（人批了才让它跑），
 * 那时产物还没被构建出来。所以摘要取的是**决定字节内容的全部输入**：
 * 项目 + target + 提交 + 流水线名 + stage 过滤。同一个提交重复部署 → 摘要不变 → 同一条审批可复用；
 * 换了提交或换了 target → 摘要变化 → 旧审批不能放行（`APPROVAL_DIGEST_MISMATCH`）。
 */
function deployDigest({ projectId = '', target = '', commit = '', pipelineName = '', stage = '' } = {}) {
  const material = JSON.stringify({ project: projectId, target, commit, pipeline: pipelineName, stage: stage || '' })
  return `sha256:${createHash('sha256').update(material).digest('hex')}`
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
  const approvalGate = createApprovalGate({ db: store.db, ttlSec: options.approval?.ttlSec })
  const secrets = createSecretStore({ dir: options.workDir })
  // v3.0-P5：制品 CAS。字节落磁盘（<workDir>/artifacts），元数据落 SQLite。
  // 两个方向的引用都要能问出来：GC 问「这个 digest 还有 release/指针指着吗」，
  // 页面问「这个项目最近传了什么」。
  const artifactMeta = {
    put(row) {
      try {
        store.db.prepare('INSERT OR REPLACE INTO artifact_blobs (digest, bytes, project_id, run_id, job_id, source_path, media_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
          String(row.digest || ''), Number(row.bytes || 0), String(row.projectId || ''), String(row.runId || ''),
          String(row.jobId || ''), String(row.sourcePath || ''), String(row.mediaType || ''), new Date().toISOString(),
        )
      } catch { /* 索引失败不影响字节正确性 */ }
    },
    remove(digest) {
      try { store.db.prepare('DELETE FROM artifact_blobs WHERE digest = ?').run(String(digest || '')) } catch { /* best effort */ }
    },
  }
  const artifactStore = createArtifactStore({
    dir: options.artifacts.dir || join(options.workDir, 'artifacts'),
    meta: artifactMeta,
    // 被 release 引用的 digest 永远不删：回滚要拿得住它，删了就等于删掉了回滚能力。
    pinned: [() => {
      const rows = store.db.prepare("SELECT artifact_digest FROM releases WHERE artifact_digest <> ''").all()
      return rows.map((row) => row.artifact_digest).filter((digest) => digest && digest.startsWith('sha256:'))
    }],
  })
  // v3.0-P5-4：OCI registry。manifest 存 artifact_blobs（media_type）并把仓库名放进 source_path，
  // 字节仍由 artifactStore 持有——镜像层和构建产物是同一套 CAS，回滚按 digest 走同一条路。
  const ociTokens = createTokenIssuer({
    secret: options.registry.secret || randomBytes(32).toString('hex'),
    ttlSec: options.registry.tokenTtlSec,
  })
  const ociUploads = createUploadSessions({
    dir: join(artifactStore.dir, 'tmp'),
    fs, join, randomId: () => randomBytes(16).toString('hex'),
  })
  const oci = {
    tokens: ociTokens,
    uploads: ociUploads,
    enabled: options.registry.enabled,
  }
  // V2-M5：RBAC（server 模式）——三角色 viewer/operator/admin + token TTL + 写操作审计
  const rbac = createRbac({ dir: options.workDir })
  // v3.0-P0：身份、授权、审计、部署锁。四者都挂在同一个 DB 句柄上，
  // 保证「谁在什么时候对什么资源做了什么」和「锁」都是持久且可验证的。
  const auth = createAuth({ db: store.db, sessionTtlSec: options.auth?.sessionTtlSec, bootstrapAllowAnonymous: options.auth?.bootstrapAllowAnonymous !== false })
  const audit = createAudit({ db: store.db })
  const locks = createDeployLocks({ db: store.db, ttlSec: options.deploy?.lockTtlSec })
  // v3.0-P0：远端构建机注册表落库（吊销持久生效，心跳超时按 3× 周期判死）。
  const runners = createRunnerRegistry({ db: store.db, heartbeatSec: options.runners?.heartbeatSec })
  // v3.0-P2：工具链托管（JDK/Node/Python/Maven…）。store 在 workDir 下，所以同一台机器上
  // 所有项目共享一份下载与解包结果；锁文件放项目的 pipe.lock，跟着仓库走。
  const toolchainRoot = options.toolchain?.storeDir || join(options.workDir, 'toolchains')
  const toolchainStore = join(toolchainRoot, 'store')
  // v3.0-P2：构建缓存（`uses: cache`）。和工具链一样落在 workDir 下：
  // 宿主的 ~/.npm 之类不碰，删掉 workDir 就等于清空全部缓存。
  const cacheStore = createCacheStore({ dir: join(options.workDir, 'cache', 'entries') })

  /**
   * 把过期未决的审批收成终态（v3.0-P0，验收项②）。
   *
   * 为什么必须有它：审批门抛 `APPROVAL_REQUIRED` 时会给这次运行写一条 `waiting_approval`
   * 记录，如果没人批也没人拒，这条记录就会永远停在「等审批」上——面板上看起来像卡住了，
   * 而实际上已经不可能再放行（审批行早已 `expires_at <= now`）。所以到期必须把它收成
   * `failed(approval_timeout)`：状态机允许的终结态，且审计里能查到是谁申请、什么时候过期。
   *
   * 调用点刻意选在「读审批列表」和 `approvals()` 上（懒扫描），而不是常驻定时器：
   * 没有面板在看的时候，扫不扫这几十行没有任何行为差异，但少一个 timer 就少一处泄漏。
   */
  function reapExpiredApprovals() {
    const expired = approvalGate.resolveExpired()
    if (expired.length === 0) return expired
    for (const approval of expired) {
      // 运行记录只在「还停在 waiting_approval」时才改：如果人已经批了并真跑起来，
      // 后续状态由 runPipeline 覆盖，这里不该倒着写回去。
      try {
        const run = approval.runId ? store.run(approval.runId) : null
        if (run && String(run.status) === 'waiting_approval') {
          store.appendRun({
            id: run.id,
            project_id: run.project_id,
            pipeline_name: run.pipeline_name,
            trigger: run.trigger,
            branch: run.branch,
            commit_sha: run.commit_sha,
            target: run.target,
            status: 'failed',
            error: 'approval_timeout',
            dry_run: run.dry_run,
            started_at: run.started_at,
            finished_at: new Date().toISOString(),
          })
        }
      } catch { /* 运行记录收尾失败不影响审批行已经过期这件事 */ }
      try { store.appendOperation({ action: 'approval-timeout', project: approval.project, target: approval.target, runId: approval.runId, status: 'expired', detail: JSON.stringify(approval) }) } catch { /* best effort */ }
      try {
        audit.record({
          action: 'approval.timeout', actorId: '', authMethod: 'system', tokenId: '',
          resourceType: 'approval', resourceId: approval.id, projectId: approval.project,
          result: 'error', reason: 'approval_timeout', sourceIp: '', requestId: '',
        })
      } catch { /* best effort */ }
    }
    return expired
  }

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
  // v3.0-P0：`deployLocks` 从进程内 Map 换成 SQLite 表（lib/locks.js）。原来的 Map 在
  // 进程重启或多副本下完全失效，是「两个人同时点部署 prod 都成功」的直接原因。
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

  function lockError(targetName, holder = null) {
    const since = holder?.acquiredAt ? `（持有者 ${holder.owner || holder.runId || '?'}，开始于 ${holder.acquiredAt}）` : ''
    const error = new Error(`target ${targetName} 已经有一次发布在执行${since}，等它结束后再试`)
    error.code = 'DEPLOY_IN_PROGRESS'
    error.holder = holder || null
    return error
  }

  /**
   * 把 pipe.yml 里的 `toolchain:` 变成「真的装了、真的断言过、只对这个子进程生效」的环境。
   *
   * 三个决定：
   * ① 声明优先级 pipe.yml > 项目里的声明文件（.nvmrc 等）。主机级永不参与——同一份 pipe.yml
   *    在装了 JDK21 的机器和装了 JDK17 的机器上必须跑出同样的结果。
   * ② 没声明任何工具链时返回 null，runner 保持原来的 `{...process.env}` 行为：
   *    绝大多数既有项目不写 toolchain，不该因为这次升级突然看不到宿主的 PATH 之外的东西。
   * ③ 断言不过就抛，绝不放行。装了 17 却跑出 21 的构建产物是最难查的一类问题
   *    （编译过了、测试过了、上线才发现主版本号不对）。
   */
  async function prepareToolchain({ pipe, project, runId, log }) {
    const declared = pipe?.toolchain && typeof pipe.toolchain === 'object' ? pipe.toolchain : {}
    const infer = declared.infer_from_files !== false
    const specs = {}
    for (const lang of TOOLCHAIN_LANGS) {
      if (typeof declared[lang] === 'string' && declared[lang].trim()) specs[lang] = declared[lang].trim()
    }
    if (infer) {
      // 声明文件只在 pipe.yml 没写这个语言时才生效：pipe.yml 优先，这是「显式压过隐式」。
      const inferred = inferFromFiles(project.path)
      for (const [lang, version] of Object.entries(inferred)) {
        if (!specs[lang] && version) specs[lang] = version
      }
    }
    if (Object.keys(specs).length === 0) return null
    if (!options.toolchain?.enabled) {
      log?.({ stageId: '', index: -1 }, `已在配置里关掉工具链托管，跳过 ${Object.keys(specs).join('、')}`)
      return null
    }

    const instance = createToolchain({
      storeDir: toolchainStore,
      lockFile: join(project.path, 'pipe.lock'),
      offline: options.toolchain.offline,
      frozen: options.toolchain.frozen,
      verifyChecksum: options.toolchain.verifyChecksum,
    })
    const installed = await instance.ensure(specs)
    for (const item of installed) {
      // 「装好了」和「真的能用」是两件事：解包成功但 bin 不可执行、或 PATH 被宿主版本抢先，
      // 都会让构建跑在错误的解释器上。
      log?.({ stageId: '', index: -1 }, `${item.lang} ${item.version}${item.cached ? '（缓存命中）' : ''} → ${item.root || item.dir}`)
    }
    if (options.toolchain.verify) {
      const problems = assertVersions(installed)
      if (problems.length > 0) {
        const error = new Error(`工具链版本断言失败：${problems.map((item) => item.message).join('；')}`)
        error.code = TOOLCHAIN_ERRORS.VERSION_MISMATCH
        throw error
      }
    }

    // 缓存与临时目录全部落在 workDir 下：宿主的 ~/.m2 不碰，两个 job 也不会互相踩。
    const runDirs = {
      m2: join(options.workDir, 'cache', 'm2'),
      gradle: join(options.workDir, 'cache', 'gradle'),
      npm: join(options.workDir, 'cache', 'npm'),
      pip: join(options.workDir, 'cache', 'pip'),
      composer: join(options.workDir, 'cache', 'composer'),
      goBuild: join(options.workDir, 'cache', 'go-build'),
      goMod: join(options.workDir, 'cache', 'go-mod'),
    }
    for (const dir of Object.values(runDirs)) {
      try { mkdirSync(dir, { recursive: true }) } catch { /* 建不出来由子进程自己报错 */ }
    }
    const java = installed.find((item) => item.lang === 'java')
    if (java) {
      // Maven 的 `-t` 与 Gradle 的 installations.paths 都指向同一棵树，双保险锁死编译器 JDK。
      const runDir = join(options.workDir, 'toolchains', 'run', runId)
      try {
        const locks = writeDualLocks({ runDir, java, vendor: /^([a-z]+)-/.exec(specs.java || '')?.[1] || '' })
        if (locks.toolchainsXml) log?.({ stageId: '', index: -1 }, `已生成 ${locks.toolchainsXml}`)
      } catch (error) {
        log?.({ stageId: '', index: -1 }, `生成 toolchains.xml 失败：${error.message}`)
      }
    }
    const describe = installed.map((item) => `${item.lang}=${item.version}`).join(', ')
    return {
      describe,
      installed,
      envFor: (extraEnv) => envFor(installed, { runDirs, base: process.env, extraEnv: extraEnv || {} }),
    }
  }

  /**
   * v3.0-P2：`uses:` 动作的能力供给。
   *
   * 动作本身（lib/actions.js）不知道自己跑在哪儿——它只声明「我要 git / 要工具链 / 要部署器」，
   * 由这里把真实实现递进去。这样 lib/actions.js 能在纯单测里跑，不需要起 HTTP 服务。
   *
   * 注意 `deploy` 是刻意包装成「一个只有 deploy 的假 step」再交给 deployStep 的：
   * 部署的护栏（生产确认、选择器展开、锁、审计、回滚）全部在 deployStep 里，
   * 这里重写一遍必然漏掉其中某一条。
   */
  function createActionRuntime({ project, runId, pipe, log }) {
    return {
      project: { id: project.id, path: project.path, branch: project.branch || '', commit: project.commit || '' },

      /**
       * git 适配：lib/git.js 的 runGit 失败时返回空串（它靠「有没有输出」判断成败），
       * 但动作需要知道「失败」与「没输出」的区别，所以这里统一成 {ok, stdout, stderr}。
       */
      async git(args) {
        const started = Date.now()
        try {
          // required:true 才有异常可抓；默认形态把失败吞成空串，
          // 而「git 挂了」和「git 没输出」在动作里是两种结局。
          const stdout = runGit(project.path, args, { required: true, timeoutMs: 120000 })
          return { ok: true, stdout, stderr: '', durationMs: Date.now() - started }
        } catch (error) {
          // execFileSync 的 stdio 只留了 stdout，stderr 被 ignore 掉了，
          // 所以失败原因只能从 error.message 里取（它已含退出码与命令行）。
          const detail = String(error?.stdout || '').trim()
          return {
            ok: false,
            stdout: detail,
            stderr: String(error?.message || error),
            durationMs: Date.now() - started,
          }
        }
      },

      /** 工具链：复用与 pipe.yml 顶层同一套安装器，只是作用域变成「从这一步起」。 */
      async toolchain(specs) {
        const instance = createToolchain({
          storeDir: toolchainStore,
          lockFile: join(project.path, 'pipe.lock'),
          offline: options.toolchain.offline,
          frozen: options.toolchain.frozen,
          verifyChecksum: options.toolchain.verifyChecksum,
        })
        const installed = await instance.ensure(specs)
        if (options.toolchain.verify) {
          const problems = assertVersions(installed)
          if (problems.length > 0) {
            const error = new Error(`工具链版本断言失败：${problems.map((item) => item.message).join('；')}`)
            error.code = TOOLCHAIN_ERRORS.VERSION_MISMATCH
            throw error
          }
        }
        return installed
      },

      cache: {
        restore: ({ key, paths, restoreKeys }) => cacheStore.restore({ projectId: project.id, projectPath: project.path, key, paths, restoreKeys }),
        save: ({ key, paths }) => cacheStore.save({ projectId: project.id, projectPath: project.path, key, paths }),
      },

      /**
       * 收制品。`name` / `retention` 目前只落在 operations 里：
       * artifacts 表还是 v1 的三列（path/bytes/sha256），改名要动 schema，
       * 而 P5 的制品库会整表重建——现在先保证「用户写的 name 不会凭空消失」。
       */
      async collect({ paths, name, retention }) {
        const files = matchArtifacts(paths, walkFiles(project.path))
        let bytes = 0
        for (const rel of files) {
          const saved = recordArtifact(runId, join(project.path, rel))
          if (saved) bytes += saved.bytes
        }
        try {
          store.appendOperation({
            action: 'collect',
            project: project.id,
            run_id: runId,
            status: files.length > 0 ? 'success' : 'failed',
            detail: { name, retention, paths, files: files.length, bytes },
          })
        } catch { /* 审计行失败不影响收集结果 */ }
        return { files, bytes, name }
      },

      /** 部署：包成只有 deploy 的假 step，交给真正的 deployStep（护栏一条都不重复实现）。 */
      async deploy({ target, artifacts, keep, strategy }) {
        const step = {
          kind: 'deploy',
          index: 0,
          name: `部署 ${target}`,
          deploy: { target, artifacts: artifacts || [], keep: keep || 0, strategy },
        }
        const result = await deployStep({ project, step, runId, commit: project.commit || '', log })
        return { status: result?.status || 'success', ...result }
      },

      notify: async ({ channel, message, level }) => {
        const delivered = await notifyEvent('run.action', {
          at: new Date().toISOString(),
          project: project.id,
          runId,
          channel: channel || 'default',
          level: level || 'info',
          message: message || '',
          pipeline: pipe?.name || '',
        })
        return { delivered: Array.isArray(delivered) ? delivered.filter((item) => item && item.ok).length : 0 }
      },

      fetch: (...args) => globalThis.fetch(...args),
    }
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
    // v3.0-P3：声明了 instances 的 target 走四阶段事务（stage → activate → verify → commit/abort）。
    // 这是「先全部解包好、再统一切流」与「一台机器 N 个端口各一个进程」唯一诚实的实现路径：
    // 老的 deploy.js 逐台 ln -sfn + restart，第 2 台失败时第 1 台已经在新版本上服务了。
    // 没声明 instances 的 target 仍走原路径 —— 它们的回滚现场就是「一个软链」，不需要事务。
    if (usesTransaction(deployTarget)) {
      return await deployStepTransaction({
        project, step, runId, commit, log, targetName, target: deployTarget, artifactPath, digest,
        envOf: (hostName) => expanded.meta.get(hostName)?.env || '',
      })
    }
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
        artifact_digest: digest?.digest || (digest?.sha256 ? `sha256:${digest.sha256}` : ''),
        mode: deployTarget.mode || 'native',
        strategy: deployTarget.strategy?.type || '',
        instances: host.instances || [],
        operator: '',
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

  /**
   * 事务式部署（v3.0-P3）：把 deploy-engine 的四阶段结果翻译成与老路径同形的返回值，
   * 这样 deployStep 的调用方（runner 的 deploy step、uses: deploy 动作、UI）一行都不用改。
   * 每台成功的主机仍然各写一条 release 行，id 仍是 `<runId>@<host>` ——
   * 一个 release 落在一台主机的多个实例上时，实例清单进 instances 列，而不是拆成多行。
   */
  async function deployStepTransaction({ project, step, runId, commit, log, targetName, target, artifactPath, digest, envOf }) {
    const operator = step.operator || ''
    const result = await deployTransaction({
      remote: remote(),
      project,
      target,
      targetName,
      artifactPath,
      artifactDigest: digest?.digest || (digest?.sha256 ? `sha256:${digest.sha256}` : ''),
      releaseId: runId,
      keep: step.deploy?.keep || target.keep || 5,
      commit,
      runId,
      operator,
      onLog: (line) => { try { log?.(line) } catch { /* log observers must not break a deploy */ } },
      onCanaryHold: ({ waitSec, first, remaining }) => {
        try {
          store.appendOperation({
            action: 'canary-hold', project: project.id, target: targetName, run_id: runId, release_id: runId,
            status: 'waiting', detail: { waitSec, first, remaining },
          })
        } catch { /* audit is best effort */ }
      },
      onStrategyProgress: ({ type, batch, totalBatches, hosts, completed }) => {
        try {
          store.appendOperation({
            action: 'strategy-progress', project: project.id, target: targetName, run_id: runId, release_id: runId,
            status: 'progress', detail: { type, batch, totalBatches, hosts, completed },
          })
        } catch { /* audit is best effort */ }
      },
    })

    // 只有真的激活成功的主机才写 active release 行。补偿过的机器写一条 superseded，
    // 否则面板会显示「这次发布成功了 3 台」，而其中 2 台其实已经被撤回旧版本。
    for (const host of result.hosts) {
      if (host.skipped) continue
      const previous = markPreviousSuperseded(targetName, host.host)
      store.appendRelease({
        id: `${runId}@${host.host}`,
        project_id: project.id,
        target: targetName,
        host: host.host,
        env: typeof envOf === 'function' ? (envOf(host.host) || '') : '',
        run_id: runId,
        commit,
        artifact_sha256: digest?.sha256 || '',
        artifact_digest: result.artifactDigest || digest?.digest || '',
        mode: target.mode || 'native',
        strategy: result.strategy?.type || '',
        instances: host.instances || [],
        operator,
        created_at: host.activated_at || new Date().toISOString(),
        activated_at: host.activated_at || '',
        deactivated_at: host.compensated ? new Date().toISOString() : '',
        status: host.ok ? 'active' : (host.compensated ? 'superseded' : 'failed'),
        manifest_path: host.releaseDir,
        revisions_offset: 0,
        previous: host.previous || publicReleaseId(previous) || '',
      })
    }

    store.appendOperation({
      action: 'deploy', project: project.id, target: targetName, run_id: runId, release_id: result.releaseId,
      status: result.ok ? 'success' : 'failed',
      detail: {
        target: targetName, releaseId: result.releaseId, ok: result.ok, strategy: result.strategy,
        batches: result.strategy?.batches || [], hosts: result.hosts, instances: result.instances,
      },
    })
    for (const host of result.hosts) {
      store.appendOperation({
        action: host.ok ? 'deploy' : 'deploy-failed',
        project: project.id, target: targetName, host: host.host, run_id: runId,
        release_id: `${runId}@${host.host}`,
        status: host.ok ? 'success' : 'failed',
        detail: {
          batch: host.batch || 1, phase: host.phase || '', layer: host.layer || '',
          health: host.health || '', previous: host.previous || '', error: host.error || '',
          skipped: Boolean(host.skipped), compensated: Boolean(host.compensated),
        },
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
    actor = null,
    approvalId = '',
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
    const runIdValue = dryRun ? '' : (runId || makeRunId())
    // v3.0-P0：部署锁落库。过期锁会被抢占，`release()` 只放自己的锁。
    let heldLock = null
    /** 心跳句柄必须在外层作用域：finally 里要 clearInterval，而 try 的块作用域外不可见。 */
    let heartbeatHandle = null
    /** 同理：finally 要主动删掉 activeRuns 里的登记，dryRun 下它是 null。 */
    let active = null
    if (!dryRun) {
      const attempt = locks.acquire({
        target: resolvedTarget,
        projectId: project.id,
        runId: runIdValue,
        owner: actor?.id || 'local',
      })
      if (!attempt.ok) {
        try {
          audit.record({
            action: 'deploy.lock_denied', actorId: actor?.id || '', authMethod: actor?.authMethod || '',
            tokenId: actor?.tokenId || '', resourceType: 'target', resourceId: resolvedTarget,
            projectId: project.id, result: 'deny', reason: `locked_by:${attempt.holder?.runId || attempt.holder?.owner || ''}`,
            sourceIp: actor?.sourceIp || '', requestId: actor?.requestId || '',
          })
        } catch { /* 审计写失败不能掩盖真正的锁冲突 */ }
        throw lockError(resolvedTarget, attempt.holder)
      }
      heldLock = attempt.lock
    }
    // 从这里到函数结束必须在同一个 try/finally 里：锁已经拿到手了，
    // 而审批门（APPROVAL_REQUIRED）和 runner 判活（RUNNER_REVOKED）都会在
    // 「跑到 try 之前」抛错。如果 finally 从更靠下的位置才开始，这两条路径
    // 会把锁泄漏到 TTL 到期（默认 30 分钟）——期间 target 像被鬼占着，
    // 面板上没人能部署，也没人知道为什么。
    try {
    // v3.0-P0：审批门（block gate）。prod 环境默认 approvalRequired，
    // 闸门绑 target + artifact digest，而不是绑 run；审批通过后由 consume() 一次性消费。
    // 「要不要审批」= target 显式 approvalRequired / 名字叫 prod（见 lib/pipe.js:369）。
    // 注意不要把「展开出 prod 主机」也算进来：那是生产护栏（confirm=prod）的职责，
    // 两者混在一起会让所有多环境 target 都停在待审批，而本地单用户模式没人能批（自批被禁）→ 部署死锁。
    const needsApproval = resolvedSpec.approvalRequired
    // 引导期（库里还没有任何用户）没有第二个人可以批，批准自己又被禁止，
    // 所以此时不设闸门，只留痕说明「这次没有经过审批人」。
    const bootstrapActor = actor?.authMethod === 'bootstrap'
    if (!dryRun && needsApproval && confirmProd && bootstrapActor) {
      try {
        audit.record({
          action: 'approval.bootstrap_skip', actorId: actor?.id || '', authMethod: 'bootstrap', tokenId: '',
          resourceType: 'target', resourceId: resolvedTarget, projectId: project.id, result: 'allow',
          reason: 'no_user_configured', sourceIp: actor?.sourceIp || '', requestId: actor?.requestId || '',
        })
      } catch { /* best effort */ }
    }
    if (!dryRun && needsApproval && confirmProd && !bootstrapActor) {
      // 审批要保护的是「这批字节」，所以 digest 必须在放行前算出来。
      // 它由 project/target/commit/pipeline/stage 派生：换提交或换 target 都会变，旧审批自然失效。
      const digest = deployDigest({
        projectId: project.id,
        target: resolvedTarget,
        commit: project.commit,
        pipelineName: pipe.name,
        stage,
      })
      // 已有 approved 且未消费的审批 → 直接消费放行（重跑路径）。
      const ready = approvalGate.consume({ id: approvalId || '', digest })
      // 调用方显式带了一条审批 id，却消费不掉：这说明「这条审批不能用」，
      // 而不是「还没申请审批」。此时如果继续去 request() 一条新的 pending，
      // 等于把 APPROVAL_CONSUMED / APPROVAL_DIGEST_MISMATCH 静默降级成
      // 「请再批一次」——验收项 ④（同一审批不能用于第二个 digest）就永远测不出来，
      // 运维也会以为审批系统在放行已作废的凭据。所以这里原样抛出真正的原因。
      if (!ready.ok && approvalId && ready.code && ready.code !== 'APPROVAL_REQUIRED') {
        const error = new Error(`审批 ${approvalId} 不能用于这次部署：${ready.message || ready.code}`)
        error.code = ready.code
        error.approvalId = approvalId
        error.runId = runIdValue
        throw error
      }
      if (!ready.ok) {
        const approval = approvalGate.request({
          runId: runIdValue,
          project: project.id,
          target: resolvedTarget,
          artifactDigest: digest,
          requestedBy: actor?.id || trigger,
          detail: `deploy to ${resolvedTarget} (${resolution.hosts.length} hosts, prod=${resolution.prodHosts.length > 0})`,
        })
        try { store.appendOperation({ action: 'approval-request', project: project.id, target: resolvedTarget, runId: runIdValue, status: 'pending', detail: JSON.stringify(approval) }) } catch { /* best effort */ }
        // 审批期间也要在运行列表里看得见：写一条 waiting_approval 的运行记录，
        // 到期由 reapExpiredApprovals() 收成 failed(approval_timeout)。
        // 不写这条记录的话，面板上「点过运行」和「什么都没发生」长得一模一样。
        try {
          store.appendRun({
            id: runIdValue,
            project_id: project.id,
            pipeline_name: pipe.name,
            trigger: project.trigger,
            branch: project.branch,
            commit_sha: project.commit,
            target: resolvedTarget,
            status: 'waiting_approval',
            dry_run: 0,
            started_at: new Date().toISOString(),
          })
        } catch { /* 运行记录写失败不改变审批语义 */ }
        try {
          audit.record({
            action: 'approval.request', actorId: actor?.id || '', authMethod: actor?.authMethod || '', tokenId: actor?.tokenId || '',
            resourceType: 'target', resourceId: resolvedTarget, projectId: project.id, result: 'allow',
            reason: `approval:${approval.id}`, sourceIp: actor?.sourceIp || '', requestId: actor?.requestId || '',
          })
        } catch { /* 审计失败不改变响应 */ }
        const error = new Error(`部署到 ${resolvedTarget} 需要审批（${approval.id}），请在面板点「通过」；${Math.round(approvalGate.ttlSec / 60)} 分钟内未处理将自动失效`)
        error.code = 'APPROVAL_REQUIRED'
        error.approvalId = approval.id
        error.runId = runIdValue
        error.expiresAt = approval.expiresAt
        throw error
      }
      try { store.appendOperation({ action: 'approval-consumed', project: project.id, target: resolvedTarget, runId: runIdValue, status: 'consumed', detail: JSON.stringify(ready.approval) }) } catch { /* best effort */ }
    }
    // 审批已通过（/approve 路由 resolve 后重跑）：isPending 为 false 且 get 返回 approved 记录 → 跳过 resolve，直接执行。
    // pending 记录不会走到这里（上面已 throw），所以无需额外 resolve。
    const controller = dryRun ? null : new AbortController()
    active = dryRun ? null : {
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
    // v3.0-P0：判活改读 DB 注册表（吊销/心跳超时都算不可用），不再信任内存 Map。
    let executor = null
    if (runnerId && !dryRun) {
      const verdict = runners.isRunnable(runnerId)
      if (!verdict.ok) {
        const error = new Error(verdict.message)
        error.code = verdict.code === 'RUNNER_REVOKED' ? 'RUNNER_REVOKED' : 'RUNNER_NOT_FOUND'
        throw error
      }
      executor = createRemoteExecutor({ broker, runnerId })
    }
    {
      // V2-M4：secrets 注入——interpolate 的 vars 里合并 secrets 值（仅运行时，不落明文到日志/DB）。
      const extraVars = secrets.refsForInterpolate(project.id, {})
      // v3.0-P0：同一次运行取一份「明文值表」交给 runner 做日志脱敏——命令回显也不会漏。
      const secretValues = typeof secrets.valuesFor === 'function' ? secrets.valuesFor(project.id) : []
      // v3.0-P0：长流水线要在跑的过程中给锁续期，否则 TTL 到了会被别的部署抢占。
      const heartbeatHandleLocal = heldLock ? setInterval(() => {
        try { locks.heartbeat({ target: resolvedTarget, runId: runIdValue }) } catch { /* 续期失败让 TTL 兜底 */ }
      }, Math.max(30_000, Math.floor((options.deploy.lockTtlSec * 1000) / 3))) : null
      heartbeatHandle = heartbeatHandleLocal
      if (heartbeatHandle?.unref) heartbeatHandle.unref()
      try { audit.record({ action: 'deploy.start', actorId: actor?.id || '', authMethod: actor?.authMethod || '', tokenId: actor?.tokenId || '', resourceType: 'target', resourceId: resolvedTarget, projectId: project.id, result: 'allow', reason: `hosts:${resolution.hosts.length}`, sourceIp: actor?.sourceIp || '', requestId: actor?.requestId || '' }) } catch { /* 审计失败不阻断部署 */ }
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
        secrets: secretValues,
        concurrency: options.jobs?.concurrency,
        // dryRun 不装工具链：干跑的意义就是「不碰机器、不等下载」，装一遍 JDK 会让它变成真跑。
        toolchainSetup: dryRun ? null : (context) => prepareToolchain({ pipe, project, runId: context.runId, log: context.log }),
        // 动作运行时：干跑不给它，于是 `uses:` 步骤在干跑里显示 skipped 并说明原因。
        // 传工厂而不是实例：动作打印的每一行都必须经过 runner 的 log(where, line)，
        // 否则「哪个 job 的哪一步说了什么」就丢了，分片日志里也找不到。
        actions: dryRun ? null : (lineLog) => createActionRuntime({ project, runId: runIdValue, pipe, log: lineLog }),
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
      // v3.0-P0：部署结果也进哈希链——失败与成功对称留痕，`cicd_audit verify` 能证明没被改过。
      if (!dryRun) {
        try {
          audit.record({
            action: run.status === 'failed' ? 'deploy.fail' : 'deploy.success',
            actorId: actor?.id || '', authMethod: actor?.authMethod || '', tokenId: actor?.tokenId || '',
            resourceType: 'target', resourceId: resolvedTarget, projectId: project.id,
            result: run.status === 'failed' ? 'error' : 'allow',
            reason: `run:${run.runId}`,
            sourceIp: actor?.sourceIp || '', requestId: actor?.requestId || '',
          })
        } catch { /* 审计失败不改变部署结果 */ }
      }
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
            jobId: step.jobId || '',
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
        // v3.0-P1：v2 的 pipe 才有 job 图；v1 返回 null，UI 据此决定是否显示 job 视图。
        jobs: run.jobs || null,
        // 工具链准备失败发生在任何 stage 之前，`stages` 是空的 —— 此时唯一的解释就在这里。
        // 不带出来的话，调用方只看得到 status: failed 和一个空数组，等于没有诊断信息。
        error: run.error || '',
        code: run.code || '',
        releases: releases.map(releaseSummary),
      }
    }
    } finally {
      if (heartbeatHandle) clearInterval(heartbeatHandle)
      if (heldLock) {
        try { locks.release({ target: resolvedTarget, runId: runIdValue }) } catch { /* 释放失败留给 TTL 过期 */ }
      }
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
    // ---------------------------------------------------------------------------------------
    // v3.0-P0：身份、审计、部署锁——三个新内核的对外面
    // ---------------------------------------------------------------------------------------
    /** 解析请求主体。所有路由（读和写）都从这里拿 actor，禁止各自读 header。 */
    authBundle(request) {
      try {
        return auth.authenticate(request)
      } catch (error) {
        return { actor: null, error: { code: error.code || 'AUTH_INVALID', message: error.message || '认证失败' } }
      }
    },
    /** 写审计。调用方一律 try/catch 包住——审计失败不能改变业务结果。 */
    auditRecord(event) {
      return audit.record(event)
    },
    auth,
    audit,
    locks,
    me(request) {
      const bundle = this.authBundle(request)
      if (bundle.error) return { ok: false, code: bundle.error.code, error: bundle.error.message }
      return {
        ok: true,
        actor: bundle.actor,
        memberships: auth.membershipsOf(bundle.actor.id),
        hasUsers: auth.hasUsers(),
        bootstrap: Boolean(bundle.bootstrap),
        policy: policyMatrix(),
      }
    },
    login({ email = '', password = '', sourceIp = '', userAgent = '' } = {}) {
      const result = auth.login({ email, password, sourceIp, userAgent })
      try {
        audit.record({ action: 'auth.login', actorId: result.user.id, authMethod: 'password', resourceType: 'session', resourceId: result.sessionId, result: 'allow', reason: 'password', sourceIp, requestId: '' })
      } catch { /* best effort */ }
      return { ok: true, ...result }
    },
    logout({ sessionId = '', request = null } = {}) {
      const id = sessionId || readSessionId(request)
      const actor = request ? (this.authBundle(request).actor || null) : null
      auth.logout(id)
      try {
        audit.record({ action: 'auth.logout', actorId: actor?.id || '', authMethod: actor?.authMethod || '', resourceType: 'session', resourceId: id, result: 'allow', reason: '', sourceIp: '', requestId: '' })
      } catch { /* best effort */ }
      return { ok: true, sessionId: id }
    },
    users({ action = 'list', id = '', email = '', password = '', displayName = '', role = '', project = '', userId = '' } = {}) {
      if (action === 'create') return { ok: true, user: auth.createUser({ email, password, displayName, role }) }
      if (action === 'set-password') return { ok: true, user: auth.setPassword({ userId: userId || id, password }) }
      if (action === 'set-role') return { ok: true, membership: auth.setRole({ userId: userId || id, project, role }) }
      if (action === 'remove-role') return { ok: true, membership: auth.removeRole({ userId: userId || id, project }) }
      if (action === 'get') return { ok: true, user: auth.user(userId || id) }
      return { ok: true, users: auth.listUsers(), roles: ROLES }
    },
    tokens({ action = 'list', userId = '', name = '', ttlSec = 0, id = '' } = {}) {
      if (action === 'create') return { ok: true, token: auth.createToken({ userId, name, ttlSec }) }
      if (action === 'revoke') return { ok: true, token: auth.revokeToken(id) }
      return { ok: true, tokens: auth.tokensOf(userId) }
    },
    auditList({ limit = 50, actor = '', action = '', project = '', result = '' } = {}) {
      // audit.list() 返回数组：绝不能用 `...` 摊进对象（那会变成 {"0":{…},"1":{…}}，
      // 客户端拿到的是一堆数字键而不是事件列表）。
      const events = audit.list({ limit, actor, action, project, result })
      return { ok: true, events, total: events.length, stats: audit.stats() }
    },
    auditVerify({ limit = 5000 } = {}) {
      return { ok: true, ...audit.verify({ limit }) }
    },
    lockList() {
      return { ok: true, locks: locks.list() }
    },
    lockForceRelease({ target = '', reason = '' } = {}) {
      const result = locks.forceRelease({ target, reason })
      try {
        audit.record({ action: 'deploy.lock_forced', actorId: 'admin', authMethod: 'local', resourceType: 'target', resourceId: target, result: 'allow', reason, sourceIp: '', requestId: '' })
      } catch { /* best effort */ }
      return { ok: true, ...result }
    },
    /**
     * 工具链查询 / 安装 / 锁维护（v3.0-P2）。
     *
     * `action=resolve` 只算「会装什么」，不下载——面板与 CI 都要能在动手之前先看一眼；
     * `install` 才真的下载解包；`lock` 把当前解析结果写回 pipe.lock（这是唯一会产生 diff 的动作）。
     */
    async toolchain({ action = 'list', project: projectId = '', spec = null, lang = '', version = '', platform = '' } = {}) {
      const platformName = platform || ''
      if (action === 'list') {
        const instance = createToolchain({ storeDir: toolchainStore, offline: true })
        const items = instance.list()
        return {
          ok: true,
          storeDir: toolchainStore,
          platform: platformName || instance.platform,
          totalBytes: items.reduce((sum, item) => sum + (item.bytes || 0), 0),
          items: platformName ? items.filter((item) => item.platform === platformName) : items,
        }
      }
      if (action === 'gc') {
        const instance = createToolchain({ storeDir: toolchainStore, offline: true })
        return { ok: true, ...instance.gc({ keep: [], dropDownloads: true }) }
      }
      if (action === 'remove') {
        if (!lang) throw Object.assign(new Error('remove 需要 lang'), { code: 'COMMAND_INVALID' })
        const instance = createToolchain({ storeDir: toolchainStore, offline: true })
        return { ok: true, removed: instance.remove(lang, version) }
      }
      // 下面三个都针对某个项目的 pipe.yml（或显式传入的 spec）
      const project = projectId ? pickProject(options, projectId) : (options.projects[0] || null)
      if (!project && !spec) throw Object.assign(new Error('需要 project 或 spec'), { code: 'PROJECT_NOT_FOUND' })
      let specs = spec && typeof spec === 'object' ? { ...spec } : {}
      if (!spec && project) {
        const pipe = readPipe(project)
        for (const [name, value] of Object.entries(pipe.toolchain || {})) {
          if (name !== 'infer_from_files' && value) specs[name] = value
        }
      }
      if (Object.keys(specs).length === 0) return { ok: true, resolved: [], installed: [], note: '这个项目没有声明任何工具链（pipe.yml 的 toolchain:，或 .nvmrc/.python-version/go.mod）' }
      const instance = createToolchain({
        storeDir: toolchainStore,
        lockFile: project ? join(project.path, 'pipe.lock') : '',
        offline: options.toolchain.offline || action === 'resolve',
        frozen: action === 'install' ? options.toolchain.frozen : false,
        verifyChecksum: options.toolchain.verifyChecksum,
        platforms: platformName || null,
      })
      if (action === 'resolve') {
        const resolved = await instance.resolve(specs)
        return {
          ok: true,
          platform: instance.platform,
          lockFile: instance.lockFile,
          resolved: resolved.map((item) => ({
            lang: item.lang, spec: item.spec, resolved: item.resolved, fromLock: Boolean(item.fromLock),
            url: item.platforms?.[instance.platform]?.url || '',
            sha256: item.platforms?.[instance.platform]?.sha256 || '',
          })),
        }
      }
      if (action === 'lock') {
        const resolved = await instance.resolve(specs, { writeLock: true })
        const written = instance.saveLock()
        return { ok: true, lockFile: written, resolved: resolved.map((item) => `${item.lang}@${item.resolved}`) }
      }
      if (action === 'install') {
        const installed = await instance.ensure(specs)
        let problems = []
        if (options.toolchain.verify) problems = assertVersions(installed)
        return {
          ok: true,
          platform: instance.platform,
          installed: installed.map((item) => ({ lang: item.lang, version: item.version, cached: Boolean(item.cached), root: item.root || item.dir })),
          bytes: installed.reduce((sum, item) => sum + (item.bytes || 0), 0),
          problems,
        }
      }
      throw Object.assign(new Error(`未知 action “${action}”（支持 list / resolve / install / lock / gc / remove）`), { code: 'COMMAND_INVALID' })
    },
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
    // v3.0-P0：runner 列表以 DB 注册表为准（broker 只负责任务队列/在跑计数），
    // 这样重启后机器还在、吊销后立刻消失，不会再出现「面板说 online 但其实早没了」。
    runners: () => runners.list().map((row) => ({ ...row, active: broker.activeFor(row.runnerId) })),
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
      // 先落库（吊销过的会在这里抛 RUNNER_REVOKED），再登记到 broker 的任务队列。
      const info = runners.register(runnerId, { labels, version, capacity })
      broker.register(runnerId, { labels, version, capacity })
      try { store.appendOperation({ action: 'runner-register', project: runnerId, status: 'ok', detail: JSON.stringify({ labels: info.labels, version: info.version }) }) } catch { /* best effort */ }
      try { audit.record({ action: 'runner.register', actorId: '', authMethod: 'runner-token', resourceType: 'runner', resourceId: runnerId, result: 'allow', reason: `labels:${info.labels.join(',')}` }) } catch { /* 审计失败不阻断注册 */ }
      return { ok: true, runnerId: info.runnerId, labels: info.labels, version: info.version, capacity: info.capacity, lastSeenAt: info.lastSeenAt, status: info.status, heartbeatSec: info.heartbeatSec, offlineAfterSec: info.offlineAfterSec, serverTime: new Date().toISOString() }
    },
    runnerHeartbeat({ runnerId } = {}) {
      const info = runners.heartbeat(runnerId)
      return { ok: true, runnerId, lastSeenAt: info?.lastSeenAt || '' }
    },
    runnerPoll({ runnerId } = {}) {
      // poll 兼心跳：runner 活着就续 last_seen_at。吊销/不存在的机器直接拒绝，不给任务。
      if (runnerId) {
        const verdict = runners.isRunnable(runnerId)
        if (!verdict.ok) {
          const error = new Error(verdict.message)
          error.code = verdict.code
          throw error
        }
        try { runners.heartbeat(runnerId) } catch { /* 刚被吊销，下面再判一次 */ }
      }
      const task = broker.taskForRunner(runnerId)
      if (!task) return { ok: true, task: null }
      return { ok: true, task: task.spec }
    },
    runnerResult({ runnerId = '', taskId, status = '', exitCode = -1, error = '' } = {}) {
      // 吊销的 runner 回报的结果一律丢弃：它可能已经不该碰这个任务了。
      if (runnerId) {
        const verdict = runners.isRunnable(runnerId)
        if (!verdict.ok) {
          const err = new Error(verdict.message)
          err.code = verdict.code
          throw err
        }
      }
      broker.resolve(taskId, { status, exitCode, error })
      return { ok: true, taskId }
    },
    runnerLog({ runnerId = '', taskId, line = '' } = {}) {
      if (runnerId) {
        const verdict = runners.isRunnable(runnerId)
        if (!verdict.ok) {
          const err = new Error(verdict.message)
          err.code = verdict.code
          throw err
        }
      }
      broker.reportLog(taskId, line)
      return { ok: true, taskId }
    },
    runnerDeregister({ runnerId } = {}) {
      try { runners.revoke(runnerId, { by: 'self', reason: 'deregister' }) } catch { /* 不存在时按幂等处理 */ }
      broker.markOffline(runnerId)
      broker.cancelAll(runnerId)
      try { store.appendOperation({ action: 'runner-deregister', project: runnerId, status: 'ok', detail: '' }) } catch { /* best effort */ }
      try { audit.record({ action: 'runner.deregister', actorId: '', authMethod: 'runner-token', resourceType: 'runner', resourceId: runnerId, result: 'allow', reason: 'self-deregister' }) } catch { /* best effort */ }
      return { ok: true, runnerId }
    },
    /** 管理员吊销：立即生效（不能等心跳超时），并取消它正在跑的任务。 */
    runnerRevoke({ runnerId, by = '', reason = '' } = {}) {
      const info = runners.revoke(runnerId, { by, reason })
      broker.markOffline(runnerId)
      broker.cancelAll(runnerId)
      try { audit.record({ action: 'runner.revoke', actorId: by, authMethod: 'session', resourceType: 'runner', resourceId: runnerId, result: 'allow', reason: reason || 'manual' }) } catch { /* best effort */ }
      return { ok: true, runnerId, revoked: true, revokedAt: info.revokedAt, revokedBy: info.revokedBy }
    },
    // V2-M4 → v3.0-P0：审批门（落库版）。approvalId 优先，其次按 runId 找最新一条。
    approve({ runId = '', approvalId = '', id = '', approved, resolvedBy = '', reason = '', actor = null } = {}) {
      const target = approvalId || id || ''
      if (!target && !runId) {
        const error = new Error('approve 需要 approvalId 或 runId')
        error.code = 'APPROVAL_NOT_FOUND'
        throw error
      }
      const result = approvalGate.resolve({
        id: target,
        runId: target ? '' : runId,
        approved,
        // 决议人身份必须与申请时记录的 `requestedBy` 用同一套 ID（审批门存的是 actor.id），
        // 否则「张三申请、张三批准」在库里是两条不同的字符串，自批校验永远命中不了。
        // 有已认证主体时以它为准：resolvedBy 只是展示用标签，不能拿来绕过校验。
        resolvedBy: actor?.id || resolvedBy || '',
        reason,
      })
      if (!result.ok) {
        const error = new Error(result.message || '审批失败')
        error.code = result.code || 'APPROVAL_NOT_FOUND'
        error.approval = result.approval || null
        // 自批/已消费/已过期都属于「有人动了不该动的审批」，必须留痕。
        try {
          audit.record({
            action: `approval.${approved ? 'approve' : 'reject'}.deny`, actorId: actor?.id || '', authMethod: actor?.authMethod || '',
            tokenId: actor?.tokenId || '', resourceType: 'approval', resourceId: target || runId,
            projectId: result.approval?.project || '', result: 'deny', reason: result.code || '',
            sourceIp: actor?.sourceIp || '', requestId: actor?.requestId || '',
          })
        } catch { /* best effort */ }
        throw error
      }
      const record = result.approval
      try {
        store.appendOperation({
          action: approved ? 'approval-resolved' : 'approval-rejected',
          project: record.project,
          target: record.target,
          runId: record.runId,
          status: record.status,
          detail: JSON.stringify({ approvalId: record.id, resolvedBy: record.decidedBy, resolvedAt: record.decidedAt }),
        })
      } catch { /* best effort */ }
      try {
        audit.record({
          action: approved ? 'approval.approved' : 'approval.rejected', actorId: actor?.id || '', authMethod: actor?.authMethod || '',
          tokenId: actor?.tokenId || '', resourceType: 'approval', resourceId: record.id, projectId: record.project,
          result: 'allow', reason: `requestedBy:${record.requestedBy}`, sourceIp: actor?.sourceIp || '', requestId: actor?.requestId || '',
        })
      } catch { /* best effort */ }
      return { ok: true, approvalId: record.id, runId: record.runId, status: record.status, approved, resolvedBy: record.decidedBy, resolvedAt: record.decidedAt }
    },
    approvals({ project = '', status = '', limit = 50 } = {}) {
      reapExpiredApprovals()
      const rows = approvalGate.list({ project, status, limit })
      return { approvals: rows, stats: approvalGate.stats(), ttlSec: approvalGate.ttlSec }
    },
    secrets(args = {}) {
      const { project = '', scope = 'global', name = '', value = '', reveal = false } = args
      if (name) {
        if (!value) {
          const error = new Error('设置 secret 需要 value')
          error.code = 'COMMAND_INVALID'
          throw error
        }
        const ref = secrets.set(project, scope, name, value)
        return { ref, project, scope, name }
      }
      const rows = secrets.list(project, scope)
      // reveal 只在显式要求时把值带出来（调用方必须已过 REVEAL_SECRET 判定并写审计）。
      if (!reveal) return { project, scope, secrets: rows }
      const withValues = rows.map((row) => ({ ...row, value: secrets.get(row.project, row.scope, row.name) }))
      return { project, scope, secrets: withValues, revealed: true }
    },
    // 路由层读字节只走这一个入口：它同时给出 status/size/range，避免调用方自己拼 header。
    artifactStream(digest, rangeHeader = '') {
      return artifactStore.readRange(digest, rangeHeader)
    },
    // ---- v3.0-P5：制品 CAS ----------------------------------------------------------------
    // 上传只接受「本地文件系统里的路径」。这不是偷懒：CI 的产物本来就在构建机上，
    // 让人从 HTTP 直接推字节等于把构建机开成对外写入口——鉴权面一下从「本地同源」
    // 变成「公网可写」，收益却只是省了一次 scp。
    async artifacts(args = {}) {
      const { action = 'list' } = args
      const project = args.project ? pickProject(options, args.project) : null
      if (action === 'stats') return { ok: true, stats: artifactStore.stats() }
      if (action === 'verify') {
        const result = await artifactStore.verify(normalizeDigest(args.digest || ''))
        if (!result.ok) throw artifactError('ARTIFACT_CORRUPTED', `制品 ${result.digest} 校验失败：磁盘上的字节不再是 ${result.digest}`, { digest: result.digest })
        return { ok: true, ...result }
      }
      if (action === 'upload') {
        const source = String(args.path || '')
        if (!source) throw artifactError('COMMAND_INVALID', '上传需要 path（构建机上的文件路径）')
        if (isDirectoryPath(source)) throw artifactError('COMMAND_INVALID', `${source} 是目录。CAS 只收单个文件，请先在管道里打包（tar/zip）`)
        const size = (() => { try { return statSync(source).size } catch { return 0 } })()
        if (options.artifacts.maxBytes && size > options.artifacts.maxBytes) {
          throw artifactError('ARTIFACT_TOO_LARGE', `制品 ${size} 字节，超过上限 ${options.artifacts.maxBytes}`)
        }
        const result = await artifactStore.putFile(source, {
          expectDigest: args.digest || '',
          meta: { projectId: project?.id || args.projectId || '', runId: args.runId || '', jobId: args.jobId || '', sourcePath: source, mediaType: args.mediaType || '' },
        })
        return { ok: true, ...result }
      }
      if (action === 'tag') {
        const record = artifactStore.putRef(args.owner || project?.id || '', args.name || '', args.digest || '', { projectId: project?.id || '' })
        try {
          store.db.prepare('INSERT OR REPLACE INTO artifact_refs (owner, name, digest, previous, project_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
            String(record.owner || ''), String(record.name || ''), record.digest, String(record.previous || ''), String(project?.id || ''), record.updatedAt,
          )
        } catch { /* 指针文件是事实来源，表只是索引 */ }
        return { ok: true, ref: record }
      }
      if (action === 'gc') {
        const result = artifactStore.gc({ dryRun: args.dryRun !== false, minAgeMs: 0 })
        return { ok: true, ...result }
      }
      // list：项目维度优先（带上传时间/来源），否则给全仓统计。
      const rows = project
        ? store.db.prepare('SELECT digest, bytes, run_id, job_id, source_path, media_type, created_at FROM artifact_blobs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?').all(project.id, Number(args.limit || 50))
        : store.db.prepare('SELECT digest, bytes, project_id, run_id, source_path, created_at FROM artifact_blobs ORDER BY created_at DESC LIMIT ?').all(Number(args.limit || 50))
      return { ok: true, project: project?.id || '', artifacts: rows, refs: artifactStore.listRefs(project?.id || ''), stats: artifactStore.stats() }
    },
    // ---- v3.0-P5-4：OCI 分发（docker push / pull） -------------------------------------------
    // manifest 也是一个「制品」：它的字节进 CAS，digest 就是它的 sha256；tag 就是 refs/<repo>/<tag>。
    // 这样 pull 一个镜像和下载一个构建产物走的是同一条读路径、同一套鉴权、同一个 GC 保留集。
    ociEnabled() {
      return oci.enabled !== false
    },
    /** 仓库目录：CAS 里所有 refs 的 owner 就是仓库名（去重）。 */
    ociCatalog() {
      return artifactStore.listRefs('')
    },
    ociToken(arg) {
      const scopes = parseScope(arg?.scope || '')
      // 空 scope 是合法的：`docker login` 探活时请求的就是「没有 scope 的票」。
      const issued = ociTokens.issue({ subject: String(arg?.actorId || ''), scopes: scopes.map((item) => `repository:${item.name}:${[...item.actions].join(',')}`) })
      return { ok: true, ...issued }
    },
    /** 校验请求带上来的 Bearer 票。返回的 scopes 决定这个请求能碰哪个仓库。 */
    ociAuthorize(request) {
      const header = String(request?.headers?.get?.('authorization') || '')
      if (!header.toLowerCase().startsWith('bearer ')) return { ok: false, reason: '缺少 Bearer token' }
      const verified = ociTokens.verify(header.slice(7).trim())
      if (!verified.ok) return { ok: false, reason: verified.reason }
      return { ok: true, payload: verified.payload, scopes: verified.scopes }
    },
    ociStartUpload({ repository = '', mount = '', from = '' } = {}) {
      const repo = parseRepository(repository)
      const mountDigest = mount || from
      if (mountDigest) {
        // 跨仓库挂载（`docker buildx` 常用）：源仓库里已经有这个 blob 就直接认，不再上传一次。
        const digest = parseOCIDigest(mountDigest)
        if (artifactStore.has(digest)) return { ok: true, id: digest, mounted: digest, exists: true }
      }
      const session = ociUploads.start({ repository: repo })
      return { ok: true, id: session.id, mounted: '', exists: false }
    },
    ociAppendUpload({ id = '', source = null } = {}) {
      const session = ociUploads.take(id)
      if (session.mounted) throw ociError(OCI_ERRORS.UPLOAD_INVALID, '这个上传会话是挂载来的，没有可追加的内容')
      const out = fs.openSync(session.file, 'a')
      try {
        const hash = createHash('sha256')
        // 会话里可能已经有前一次 PATCH 的内容，所以整体重算而不是增量续算：
        // 断点续传流在提交时只出现一次，续算一次更省代码，也少一个「半截哈希」的状态。
        const existing = fs.createReadStream(session.file)
        return new Promise((resolve, reject) => {
          let bytes = 0
          existing.on('data', (chunk) => { hash.update(chunk); bytes += chunk.length })
          existing.on('error', reject)
          existing.on('end', () => {
            // request.body 已经是 Web ReadableStream；宿主换实现时也接受 Node 流。
            const append = source ? (typeof source.getReader === 'function' ? source : Readable.toWeb(source)) : null
            if (!append) { fs.closeSync(out); resolve({ ok: true, id: session.id, bytes }) ; return }
            const reader = (append).getReader()
            const pump = () => reader.read().then(({ done, value }) => {
              if (done) {
                fs.closeSync(out)
                resolve({ ok: true, id: session.id, bytes })
                return
              }
              const chunk = Buffer.from(value instanceof Uint8Array ? value : new Uint8Array(value))
              fs.writeSync(out, chunk)
              hash.update(chunk)
              bytes += chunk.length
              return pump()
            }).catch(reject)
            return pump()
          })
        })
      } catch (error) {
        try { fs.closeSync(out) } catch { /* already closed */ }
        throw ociError(OCI_ERRORS.UPLOAD_INVALID, `写临时文件失败：${error.message}`)
      }
    },
    async ociCommitUpload({ id = '', digest = '', repository = '', mediaType = '' } = {}) {
      const repo = parseRepository(repository)
      const session = ociUploads.take(id)
      const expected = parseOCIDigest(digest)
      if (session.mounted) {
        if (!artifactStore.has(expected)) throw ociError(OCI_ERRORS.BLOB_UNKNOWN, `挂载的 ${expected} 不在 CAS 里`)
        ociUploads.drop(id)
        return { ok: true, digest: expected, mounted: true }
      }
      let result
      try {
        result = await artifactStore.putFile(session.file, {
          expectDigest: expected,
          meta: { projectId: repo, mediaType: mediaType || 'application/octet-stream' },
        })
      } finally {
        ociUploads.drop(id)
      }
      return { ok: true, digest: result.digest, bytes: result.bytes, deduped: result.deduped }
    },
    ociDropUpload(id) {
      return { ok: true, removed: ociUploads.drop(id) }
    },
    /** 读 manifest。`ref` 可以是 tag（走 refs）或 digest（直接读 CAS）。 */
    _ociManifestDigest(repository, ref) {
      const repo = parseRepository(repository)
      const parsed = parseReference(ref)
      if (parsed.kind === 'digest') return parsed.value
      const record = artifactStore.readRef(repo, parsed.value)
      if (!record?.digest) throw ociError(OCI_ERRORS.MANIFEST_UNKNOWN, `${repo}:${parsed.value} 没有这个 tag`)
      return record.digest
    },
    ociGetManifest({ repository = '', ref = '', expectedDigest = '' } = {}) {
      const digest = this._ociManifestDigest(repository, ref)
      if (expectedDigest && parseOCIDigest(expectedDigest) !== digest) {
        throw ociError(OCI_ERRORS.MANIFEST_UNKNOWN, `${repository}:${ref} 现在指向 ${digest}，不是预期的 ${expectedDigest}`)
      }
      const record = artifactStore.stat(digest)
      if (!record) throw ociError(OCI_ERRORS.MANIFEST_UNKNOWN, `manifest ${digest} 不在 CAS 里`)
      const text = fs.readFileSync(artifactStore.pathOf(digest), 'utf8')
      let manifest
      try { manifest = JSON.parse(text) } catch { throw ociError(OCI_ERRORS.MANIFEST_INVALID, `manifest ${digest} 不是合法 JSON`) }
      return { ok: true, digest, bytes: record.bytes, manifest, mediaType: manifest.mediaType || MEDIA_TYPES.OCI_MANIFEST }
    },
    /**
     * 收下一个 manifest。
     *
     * 三条判据按顺序：结构合法 → 引用的 blob 全都存在 → digest 与客户端声明的一致。
     * 第二条是这里最重要的：收下一个引用缺失层的 manifest，等于把一个必然拉不下来的镜像
     * 存进仓库，而失败会推迟到「上线那一刻」才发生。
     */
    async ociPutManifest({ repository = '', ref = '', manifest = null, raw = '', contentType = '' } = {}) {
      const repo = parseRepository(repository)
      const parsed = parseReference(ref)
      const body = manifest || (() => {
        try { return JSON.parse(String(raw || '')) } catch { throw ociError(OCI_ERRORS.MANIFEST_INVALID, 'manifest 不是合法 JSON') }
      })()
      validateManifest(body)
      if (contentType && isManifestType(contentType) && body.mediaType !== contentType) {
        // Content-Type 与 body.mediaType 不一致时以 body 为准，但要记下来：某些旧客户端会发错。
        body.mediaType = body.mediaType || contentType
      }
      const canonical = canonicalJson(body)
      const digest = `sha256:${createHash('sha256').update(canonical).digest('hex')}`
      if (parsed.kind === 'digest' && parsed.value !== digest) {
        throw ociError(OCI_ERRORS.MANIFEST_INVALID, `manifest 的 digest 是 ${digest}，与 URL 声明的 ${parsed.value} 不符`)
      }
      const refs = manifestReferences(body)
      const missing = []
      if (refs.config && !artifactStore.has(refs.config)) missing.push(refs.config)
      for (const blob of refs.blobs) if (!artifactStore.has(blob)) missing.push(blob)
      for (const child of refs.manifests) if (!artifactStore.has(child.digest)) missing.push(child.digest)
      if (missing.length > 0) {
        // detail 直接拼进 error（ociError 的第三个参数就是 detail），响应体里 errors[0].detail.missing 能直接读。
        throw ociError(OCI_ERRORS.MANIFEST_BLOB_UNKNOWN, `manifest 引用了 ${missing.length} 个还没上传的对象（第一个：${missing[0]}）`, { missing: missing.slice(0, 20) })
      }
      // put 是 async（流式哈希）：不 await 会让紧接着的 putRef 看不到这个 blob。
      await artifactStore.put(Buffer.from(canonical, 'utf8'), {
        expectDigest: digest,
        meta: { projectId: repo, mediaType: body.mediaType },
      })
      let tag = ''
      if (parsed.kind === 'tag') {
        tag = parsed.value
        artifactStore.putRef(repo, tag, digest, { projectId: repo })
        try {
          store.db.prepare('INSERT OR REPLACE INTO artifact_refs (owner, name, digest, previous, project_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
            repo, tag, digest, '', repo, new Date().toISOString(),
          )
        } catch { /* 指针文件是事实来源 */ }
      }
      return { ok: true, digest, tag, mediaType: body.mediaType, bytes: Buffer.byteLength(canonical) }
    },
    ociListTags({ repository = '', limit = 100 } = {}) {
      const repo = parseRepository(repository)
      const tags = artifactStore.listRefs(repo).map((item) => item.name).sort()
      const n = Number(limit) > 0 ? Number(limit) : 100
      return { ok: true, name: repo, tags: tags.slice(0, n) }
    },
    /** 删 tag；按 digest 删会把所有指向它的 tag 一起删掉（规范允许，且这是唯一有意义的「删镜像」）。 */
    ociDeleteManifest({ repository = '', ref = '' } = {}) {
      const repo = parseRepository(repository)
      const parsed = parseReference(ref)
      if (parsed.kind === 'tag') {
        const removed = artifactStore.removeRef(repo, parsed.value)
        return { ok: true, removedTags: removed ? [parsed.value] : [] }
      }
      const owned = artifactStore.listRefs(repo).filter((item) => item.digest === parsed.value)
      for (const item of owned) artifactStore.removeRef(repo, item.name)
      return { ok: true, removedTags: owned.map((item) => item.name) }
    },
    ociStats() {
      return { ok: true, uploads: ociUploads.size(), sessions: ociUploads.sweep().length ? 'swept' : 'idle', stats: artifactStore.stats() }
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
    logs({ runId, tail = 200, jobId = '' } = {}) {
      if (!runId) throw Object.assign(new Error('runId 不能为空'), { code: 'RUN_NOT_FOUND' })
      const run = store.run(runId)
      if (!run) throw Object.assign(new Error(`运行 ${runId} 不存在`), { code: 'RUN_NOT_FOUND' })
      // v3.0-P1：带 jobId 时读分片日志（并行 job 在主日志里是交错的）；
      // 不带时仍是原来的整条时间线，老调用方行为不变。
      const wanted = String(jobId || '').trim()
      const raw = wanted ? store.readJobLog(runId, wanted, { tail }) : store.readLog(runId, { tail })
      if (wanted && !raw) {
        const known = store.jobLogs(runId).map((item) => item.jobId)
        throw Object.assign(
          new Error(`job ${wanted} 没有日志（本次运行的 job：${known.join('、') || '无'}）`),
          { code: 'RUN_NOT_FOUND' },
        )
      }
      const clipped = clampLog(raw, options.maxLogBytes)
      const totalLines = raw ? raw.split('\n').length : 0
      const running = activeRuns.get(runId) || null
      return {
        runId,
        jobId: wanted,
        status: run.status,
        active: Boolean(running),
        canceling: Boolean(running?.canceling),
        logPath: wanted ? store.jobLogPath(runId, wanted) : store.logPath(runId),
        jobs: store.jobLogs(runId),
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
        const deployed = store.release(`${item.releaseId}@${item.host}`)
        const artifactDigest = deployed?.artifactDigest || deployed?.artifact_digest || ''
        store.appendRelease({
          id: `${item.releaseId}@${item.host}`,
          project_id: found.project.id,
          target: found.targetName,
          host: item.host,
          env: resolution.meta.get(item.host)?.env || '',
          run_id: '',
          commit: found.project.commit || '',
          artifact_sha256: artifactDigest.startsWith('sha256:') ? artifactDigest.slice(7) : '',
          artifact_digest: artifactDigest,
          mode: deployed?.mode || found.target.mode || 'native',
          strategy: deployed?.strategy || '',
          instances: item.instances || deployed?.instances || [],
          operator: deployed?.operator || '',
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
        approvalId: { type: 'string', description: '已批准的审批 id（v3.0-P0）；带上它会一次性消费该审批放行部署' },
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
        approvalId: args.approvalId || '',
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
    description: '读取一次运行的构建日志（可只返回末尾 N 行）；日志文件在 workDir/logs/<runId>.log。传 jobId 可只读某个 job 的日志（并行 job 在主日志里是交错的）。',
    parameters: { type: 'object', properties: { runId: { type: 'string' }, jobId: { type: 'string', description: '只看某个 job 的日志（v2 的 matrix 实例名如 unit[java=17]）' }, tail: { type: 'number', description: '只返回末尾多少行（默认 200）' } }, required: ['runId'] },
    output: {
      schema: { type: 'object', properties: { runId: { type: 'string' }, jobId: { type: 'string' }, status: { type: 'string' }, logPath: { type: 'string' }, jobs: { type: 'array', items: { type: 'object', properties: { jobId: { type: 'string' }, bytes: { type: 'number' }, updatedAt: { type: 'string' } } } }, totalLines: { type: 'number' }, tail: { type: 'number' }, truncated: { type: 'boolean' }, text: { type: 'string' } } },
      render: renderLogs,
    },
    async execute(args) { return runtime.logs({ runId: args.runId, tail: args.tail || 200, jobId: args.jobId || '' }) },
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
    description: '列出/吊销远端构建主机（runner）。不传 action 时列出：id、标签、容量、在线状态、在跑任务数。传 action=revoke + runnerId 则立即吊销（持久生效，正在跑的任务会被取消）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['', 'list', 'revoke'], description: 'list（默认）或 revoke' },
        runnerId: { type: 'string', description: 'action=revoke 时要吊销的 runner id' },
        reason: { type: 'string', description: '吊销原因（写进审计）' },
      },
    },
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
                revoked: { type: 'boolean' }, stale: { type: 'boolean' },
                registeredAt: { type: 'string' }, revokedAt: { type: 'string' }, revokedBy: { type: 'string' },
                heartbeatSec: { type: 'number' }, offlineAfterSec: { type: 'number' },
              },
            },
          },
          runnerId: { type: 'string' }, revoked: { type: 'boolean' }, revokedAt: { type: 'string' }, revokedBy: { type: 'string' },
        },
      },
      render(_args, value) {
        if (value && value.revoked) return textBlocks(`已吊销 runner ${value.runnerId}（${value.revokedAt || ''}，操作者 ${value.revokedBy || '未知'}）。它现在无法领任务、无法回报结果。`)
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
    async execute(args = {}) {
      const action = String(args.action || 'list')
      if (action === 'revoke') return runtime.runnerRevoke({ runnerId: args.runnerId || '', by: 'tool', reason: args.reason || '' })
      if (action && action !== 'list') throw Object.assign(new Error(`未知 action "${action}"（支持 list / revoke）`), { code: 'COMMAND_INVALID' })
      return { runners: runtime.runners() }
    },
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
        approvalId: { type: 'string', description: '审批 id（v3.0-P0，优先于 runId）' },
        reason: { type: 'string', description: '审批意见（可选，会写进审计）' },
        resolvedBy: { type: 'string', description: '审批人（默认 ui）' },
      },
      required: [],
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
      // v3.0-P0：审批单有独立 id（appr-…），runId 只是它挂着的运行。
      // 优先用 approvalId，兼容旧调用只给 runId 的写法。
      return runtime.approve({
        runId: args.runId || '',
        approvalId: args.approvalId || '',
        approved: args.decision !== 'reject',
        reason: args.reason || '',
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

  // ---------------------------------------------------------------------------------------
  // v3.0-P0：身份 / 成员 / token / 审计 / 锁——五个新工具，与 HTTP 路由一一对应。
  // 工具层不重复判权：权限在 runtime 方法与 authorize() 里；这里只暴露能力。
  // ---------------------------------------------------------------------------------------

  register({
    name: 'cicd_auth',
    description: '查看当前身份（/auth/me）、登录换会话、登出。返回 actor（角色 + 项目成员关系）与完整策略矩阵；引导期（库中无用户）actor 是 bootstrap owner。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['me', 'login', 'logout'], description: 'me=查看当前身份 / login=邮箱密码换会话 / logout=注销会话' },
        email: { type: 'string', description: 'action=login 时必填' },
        password: { type: 'string', description: 'action=login 时必填' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          actor: { type: 'object', properties: { id: { type: 'string' }, email: { type: 'string' }, displayName: { type: 'string' }, authMethod: { type: 'string' }, role: { type: 'string' } } },
          bootstrap: { type: 'boolean' },
          hasUsers: { type: 'boolean' },
          sessionId: { type: 'string' },
          expiresAt: { type: 'string' },
          policy: { type: 'object' },
        },
      },
      render(_args, value) {
        if (value.actor) return textBlocks(`身份：${value.actor.email || value.actor.id}（${value.actor.role}，${value.actor.authMethod}）${value.bootstrap ? ' · 引导期（尚无本地账号）' : ''}`)
        return textBlocks(value.sessionId ? `已登录，会话 ${value.sessionId}，过期 ${value.expiresAt}` : '已登出')
      },
    },
    async execute(args = {}) {
      const action = args.action || 'me'
      if (action === 'login') return runtime.login({ email: args.email || '', password: args.password || '' })
      if (action === 'logout') return runtime.logout({})
      return runtime.me(null)
    },
  })

  register({
    name: 'cicd_users',
    description: '管理本地账号与项目成员关系：创建用户、改密码、授予/收回项目角色（viewer/operator/admin/owner）、列用户。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'get', 'set-password', 'set-role', 'remove-role'] },
        id: { type: 'string', description: '用户 id（set-password/set-role/remove-role/get 用）' },
        email: { type: 'string', description: 'action=create 时必填' },
        password: { type: 'string', description: 'action=create/set-password 时必填' },
        displayName: { type: 'string' },
        role: { type: 'string', enum: ['viewer', 'operator', 'admin', 'owner'] },
        project: { type: 'string', description: '项目 id，默认 "*" 表示全局授权' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          user: { type: 'object', properties: { id: { type: 'string' }, email: { type: 'string' }, displayName: { type: 'string' }, status: { type: 'string' } } },
          users: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, email: { type: 'string' }, displayName: { type: 'string' }, status: { type: 'string' }, roles: { type: 'array', items: { type: 'object' } } } } },
        },
      },
      render(_args, value) {
        if (value.users) {
          const lines = [`用户 ${value.users.length} 个：`]
          for (const user of value.users) {
            const roles = (user.roles || []).map((item) => `${item.project}:${item.role}`).join(' ') || '（无角色）'
            lines.push(`- ${user.email}（${user.id}，${user.status}）${roles}`)
          }
          return textBlocks(lines.join('\n'))
        }
        return textBlocks(value.user ? `用户 ${value.user.email}（${value.user.id}，${value.user.status}）` : '用户操作完成')
      },
    },
    async execute(args = {}) {
      return runtime.users({
        action: args.action || 'list',
        id: args.id || '', email: args.email || '', password: args.password || '',
        displayName: args.displayName || '', role: args.role || '', project: args.project || '',
      })
    },
  })

  register({
    name: 'cicd_tokens',
    description: '签发/吊销/列出 API token（供 CI 与脚本使用，作用域限定到项目，必须带过期时间）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'revoke'], description: '默认 list' },
        userId: { type: 'string', description: 'token 归属用户 id（create 必填；list 可过滤）' },
        name: { type: 'string', description: 'token 用途备注' },
        ttlSec: { type: 'number', description: '有效秒数（默认 30 天）' },
        id: { type: 'string', description: 'action=revoke 时的 token id' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          token: { type: 'object', properties: { id: { type: 'string' }, secret: { type: 'string' }, name: { type: 'string' }, expiresAt: { type: 'string' } } },
          tokens: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, projectScope: { type: 'string' }, expiresAt: { type: 'string' }, revokedAt: { type: 'string' } } } },
        },
      },
      render(_args, value) {
        if (value.token?.secret) return textBlocks(`已签发 token ${value.token.id}：${value.token.secret}\n（只显示一次，请立即保存；过期 ${value.token.expiresAt}）`)
        const tokens = value.tokens || []
        if (tokens.length === 0) return textBlocks('（没有 token）')
        return textBlocks(tokens.map((item) => `${item.id}  ${item.name || '-'}  scope=${item.projectScope || '*'}  过期 ${item.expiresAt}${item.revokedAt ? '（已吊销）' : ''}`).join('\n'))
      },
    },
    async execute(args = {}) {
      return runtime.tokens({ action: args.action || 'list', userId: args.userId || '', name: args.name || '', ttlSec: Number(args.ttlSec || 0), id: args.id || '' })
    },
  })

  register({
    name: 'cicd_audit',
    description: '查询审计事件（哈希链）并校验链完整性。action=verify 会逐条重算 prev_hash/hash，定位第一处断裂。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'verify'], description: '默认 list' },
        limit: { type: 'number', description: '返回条数（默认 50，最大 500）' },
        actor: { type: 'string', description: '按主体 id 过滤' },
        event: { type: 'string', description: '按动作过滤，如 deploy.start / policy.deny' },
        project: { type: 'string' },
        result: { type: 'string', enum: ['allow', 'deny', 'error'] },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          events: { type: 'array', items: { type: 'object', properties: { seq: { type: 'number' }, ts: { type: 'string' }, actorId: { type: 'string' }, action: { type: 'string' }, resourceType: { type: 'string' }, resourceId: { type: 'string' }, projectId: { type: 'string' }, result: { type: 'string' }, reason: { type: 'string' }, hash: { type: 'string' } } } },
          verified: { type: 'boolean' },
          count: { type: 'number' },
          brokenSeq: { type: 'number' },
          kind: { type: 'string' },
        },
      },
      render(_args, value) {
        if (typeof value.verified === 'boolean') {
          if (value.verified) return textBlocks(`审计链完好：${value.count} 条事件全部校验通过`)
          return textBlocks(`审计链断裂：第 ${value.brokenSeq} 条（${value.kind}）\n期望 ${value.expected}\n实际 ${value.actual}`)
        }
        const events = value.events || []
        if (events.length === 0) return textBlocks('（没有审计事件）')
        return textBlocks(events.map((item) => `${item.ts} #${item.seq} ${item.result.padEnd(5)} ${item.action} ${item.actorId || '-'} ${item.resourceId || ''}${item.reason ? ` — ${item.reason}` : ''}`).join('\n'))
      },
    },
    async execute(args = {}) {
      if ((args.action || '') === 'verify') return runtime.auditVerify({ limit: Number(args.limit || 5000) })
      return runtime.auditList({
        limit: Number(args.limit || 50),
        actor: args.actor || '', action: args.event || '', project: args.project || '', result: args.result || '',
      })
    },
  })

  register({
    name: 'cicd_locks',
    description: '查看部署锁（落库，重启后仍互斥）或强制释放。锁按 target 唯一，带 TTL 与心跳。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'release'], description: '默认 list' },
        target: { type: 'string', description: 'action=release 时必填' },
        reason: { type: 'string', description: '强制释放的原因（会写审计）' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          locks: { type: 'array', items: { type: 'object', properties: { target: { type: 'string' }, projectId: { type: 'string' }, runId: { type: 'string' }, owner: { type: 'string' }, acquiredAt: { type: 'string' }, expiresAt: { type: 'string' }, heartbeatAt: { type: 'string' } } } },
          released: { type: 'boolean' },
        },
      },
      render(_args, value) {
        if (value.released !== undefined) return textBlocks(value.released ? '已强制释放锁' : '该 target 没有锁')
        const rows = value.locks || []
        if (rows.length === 0) return textBlocks('（没有部署锁）')
        return textBlocks(rows.map((item) => `${item.target}  run=${item.runId}  owner=${item.owner}  取得 ${item.acquiredAt}  到期 ${item.expiresAt}`).join('\n'))
      },
    },
    async execute(args = {}) {
      if ((args.action || '') === 'release') return runtime.lockForceRelease({ target: args.target || '', reason: args.reason || 'manual release' })
      return runtime.lockList()
    },
  })

  // v3.0-P5：制品 CAS。上传只收本地路径 —— 见 runtime.artifacts 上的说明。
  register({
    name: 'cicd_artifacts',
    description: '制品 CAS：按 sha256 收字节（幂等去重）、按 digest 取回（支持 Range）、移指针（tag）、回收无引用 blob（默认 dry-run）。上传只接受构建机上的文件路径。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'upload', 'tag', 'verify', 'gc', 'stats'], description: '默认 list' },
        project: PROJECT_PARAM,
        path: { type: 'string', description: 'action=upload 时必填：构建机上的文件路径（不接受目录）' },
        digest: { type: 'string', description: 'sha256:<64 hex>；upload 时作为校验值，tag/verify 时作为目标' },
        runId: { type: 'string', description: 'optional：把这次上传记到某次运行名下' },
        jobId: { type: 'string', description: 'optional：并行 job 的分片归属' },
        mediaType: { type: 'string' },
        owner: { type: 'string', description: 'action=tag：指针归属（默认项目 id）' },
        name: { type: 'string', description: 'action=tag：指针名，如 latest / staging' },
        limit: { type: 'number' },
        dryRun: { type: 'boolean', description: 'action=gc：默认 true，只列出不删除' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          digest: { type: 'string' },
          bytes: { type: 'number' },
          deduped: { type: 'boolean' },
          actual: { type: 'string' },
          ref: { type: 'object' },
          stats: { type: 'object' },
          removed: { type: 'array', items: { type: 'object' } },
          kept: { type: 'array', items: { type: 'string' } },
          reclaimedBytes: { type: 'number' },
          artifacts: { type: 'array', items: { type: 'object' } },
          refs: { type: 'array', items: { type: 'object' } },
        },
      },
      render(_args, value) {
        if (value.digest) return textBlocks(`${value.digest}（${value.bytes ?? 0} 字节${value.deduped ? '，已存在，未重复写入' : ''}）`)
        if (value.ref) return textBlocks(`${value.ref.owner}/${value.ref.name} → ${value.ref.digest}`)
        if (value.removed || value.kept) {
          const lines = [`GC${value.dryRun ? '（dry-run，未删除）' : ''}：可回收 ${(value.removed || []).length} 个，${value.reclaimedBytes || 0} 字节；保留 ${(value.kept || []).length} 个`]
          for (const item of value.removed || []) lines.push(`- ${item.digest} ${item.bytes} 字节`)
          return textBlocks(lines.join('\n'))
        }
        if (value.artifacts) {
          const lines = [`制品 ${value.artifacts.length} 个（共 ${value.stats?.count ?? 0} 个 blob，${value.stats?.bytes ?? 0} 字节）`]
          for (const item of value.artifacts) lines.push(`- ${item.digest} ${item.bytes} 字节 ${item.created_at || ''}`)
          for (const ref of value.refs || []) lines.push(`- 指针 ${ref.owner}/${ref.name} → ${ref.digest}`)
          return textBlocks(lines.join('\n'))
        }
        return textBlocks(value.stats ? `制品库：${value.stats.count} 个 blob，${value.stats.bytes} 字节，${value.stats.refs} 个指针` : '制品操作完成')
      },
    },
    async execute(args = {}) {
      return runtime.artifacts({
        action: args.action || 'list',
        project: args.project || '', path: args.path || '', digest: args.digest || '',
        runId: args.runId || '', jobId: args.jobId || '', mediaType: args.mediaType || '',
        owner: args.owner || '', name: args.name || '', limit: args.limit,
        dryRun: args.dryRun !== false,
      })
    },
  })


  register({
    name: 'cicd_registry',
    description: 'OCI 镜像仓库（docker push/pull）：查仓库与 tag、按 digest 取 manifest、删 tag。推拉请直接用 docker，这里给的是运维侧视图（审计、对账、回滚前查证）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['catalog', 'tags', 'manifest', 'delete', 'stats'], description: 'catalog=仓库列表；tags=某仓库的 tag；manifest=读 manifest；delete=删 tag；stats=用量' },
        repository: { type: 'string', description: '仓库名，如 demo/web（小写，不允许大写）' },
        ref: { type: 'string', description: 'tag 或 sha256 digest' },
        limit: { type: 'number' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          repositories: { type: 'array', items: { type: 'string' } },
          tags: { type: 'array', items: { type: 'string' } },
          digest: { type: 'string' },
          mediaType: { type: 'string' },
          manifest: { type: 'object' },
          removedTags: { type: 'array', items: { type: 'string' } },
          stats: { type: 'object' },
        },
      },
      render(_args, value) {
        if (value.repositories) return textBlocks(`仓库 ${value.repositories.length} 个：\n${value.repositories.map((item) => `- ${item}`).join('\n') || '- （空）'}`)
        if (value.tags) return textBlocks(`${value.name || '仓库'} 的 tag：${value.tags.length ? value.tags.join(', ') : '（空）'}`)
        if (value.manifest) return textBlocks(`${value.digest}（${value.mediaType}）\n${JSON.stringify(value.manifest, null, 2)}`)
        if (value.removedTags) return textBlocks(value.removedTags.length ? `已删除 tag：${value.removedTags.join(', ')}` : '没有匹配的 tag')
        return textBlocks(value.stats ? `仓库用量：${value.stats.count} 个 blob，${value.stats.bytes} 字节，${value.stats.refs} 个指针` : '完成')
      },
    },
    async execute(args = {}) {
      const action = args.action || 'catalog'
      const repository = args.repository || ''
      if (action === 'catalog') {
        const owners = [...new Set(runtime.ociCatalog().map((item) => item.owner))].sort()
        return { ok: true, repositories: owners }
      }
      if (action === 'stats') return { ok: true, stats: runtime.artifacts({ action: 'stats' }).stats }
      if (!repository) throw ociError(OCI_ERRORS.NAME_INVALID, '需要 repository（如 demo/web）')
      if (action === 'tags') return runtime.ociListTags({ repository, limit: args.limit })
      if (action === 'manifest') return runtime.ociGetManifest({ repository, ref: args.ref || '' })
      if (action === 'delete') {
        if (!args.ref) throw ociError(OCI_ERRORS.MANIFEST_UNKNOWN, '需要 ref（tag 或 digest）')
        return runtime.ociDeleteManifest({ repository, ref: args.ref })
      }
      throw ociError(OCI_ERRORS.UNSUPPORTED, `未知的 action ${action}`)
    },
  })

  register({
    name: 'cicd_toolchain',
    description: '工具链托管（JDK / Node / Python / Maven / Gradle / Go）：查看已装、解析会装什么、安装、写锁、清理。版本只由 pipe.yml 的 toolchain: 决定，机器上装了什么版本不影响结果。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'resolve', 'install', 'lock', 'gc', 'remove'], description: 'list=已装清单；resolve=只算不下载；install=真的装；lock=写 pipe.lock；gc/remove=清理' },
        project: { type: 'string', description: '项目 id（resolve/install/lock 必需，除非直接给 spec）' },
        spec: { type: 'object', description: '直接指定语言版本，如 {"java":"temurin-17"}（覆盖 pipe.yml）' },
        lang: { type: 'string', description: 'remove/list 过滤用' },
        version: { type: 'string', description: 'remove 用' },
        platform: { type: 'string', description: '默认当前平台，如 linux-x64' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          storeDir: { type: 'string' },
          platform: { type: 'string' },
          totalBytes: { type: 'number' },
          items: { type: 'array', items: { type: 'object', properties: { lang: { type: 'string' }, version: { type: 'string' }, platform: { type: 'string' }, bytes: { type: 'number' }, root: { type: 'string' } } } },
          resolved: { type: 'array', items: { type: 'object', properties: { lang: { type: 'string' }, spec: { type: 'string' }, resolved: { type: 'string' }, fromLock: { type: 'boolean' }, url: { type: 'string' } } } },
          installed: { type: 'array', items: { type: 'object', properties: { lang: { type: 'string' }, version: { type: 'string' }, cached: { type: 'boolean' }, root: { type: 'string' } } } },
          problems: { type: 'array', items: { type: 'object' } },
          lockFile: { type: 'string' },
        },
      },
      render(_args, value) {
        const items = value.items || []
        if (items.length > 0) {
          const mb = (bytes) => `${(Number(bytes || 0) / 1024 / 1024).toFixed(1)}MB`
          const head = `${value.storeDir}（${value.platform}）`
          const body = items.map((item) => `${item.lang} ${item.version} ${item.platform} ${mb(item.bytes)} ${item.root}`).join(String.fromCharCode(10))
          return textBlocks([head, body].join(String.fromCharCode(10)))
        }
        const installed = value.installed || []
        if (installed.length > 0) return textBlocks(installed.map((item) => `${item.lang} ${item.version}${item.cached ? '（缓存命中）' : ''} → ${item.root}`).join(String.fromCharCode(10)))
        const resolved = value.resolved || []
        if (resolved.length > 0) return textBlocks(resolved.map((item) => `${item.lang} ${item.spec} → ${item.resolved}${item.fromLock ? '（来自锁文件）' : ''}`).join(String.fromCharCode(10)))
        return textBlocks(value.note || '（没有工具链信息）')
      },
    },
    async execute(args = {}) {
      return runtime.toolchain({
        action: args.action || 'list',
        project: args.project || '',
        spec: args.spec && typeof args.spec === 'object' ? args.spec : null,
        lang: args.lang || '',
        version: args.version || '',
        platform: args.platform || '',
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
  if (code === 'PROD_CONFIRM_REQUIRED' || code === 'DEPLOY_IN_PROGRESS' || code === 'DEPLOY_LOCKED') return 409
  // v3.0-P0：身份与授权。401 = 没身份/身份失效；403 = 有身份但没权限。
  if (code === 'AUTH_REQUIRED' || code === 'AUTH_INVALID' || code === 'AUTH_DISABLED') return 401
  if (code === 'SESSION_INVALID' || code === 'SESSION_EXPIRED' || code === 'SESSION_REVOKED') return 401
  if (code === 'TOKEN_INVALID' || code === 'TOKEN_EXPIRED' || code === 'TOKEN_REVOKED') return 401
  if (code === 'POLICY_DENY') return 403
  if (code === 'USER_NOT_FOUND') return 404
  if (code === 'USER_EXISTS' || code === 'USER_INVALID' || code === 'ROLE_INVALID') return 400
  if (code === 'RUN_NOT_ACTIVE') return 409
  // V2-M1：入站 webhook。token 不符按安全模型用 401；未配置 secret / 不是 push 触发用 403。
  if (code === 'WEBHOOK_UNAUTHORIZED') return 401
  if (code === 'WEBHOOK_DISABLED') return 403
  if (code === 'WEBHOOK_INVALID') return 400
  // V2-M2：远端 runner join token 校验失败按 401。
  if (code === 'RUNNER_UNAUTHORIZED') return 401
  // v3.0-P0：runner 注册表——吊销是 403（身份还在但已被剥夺），心跳超时按 409（机器不在线不是权限问题）。
  if (code === 'RUNNER_REVOKED') return 403
  if (code === 'RUNNER_OFFLINE') return 409
  // V2-M4：审批门——需要审批但尚未通过。
  if (code === 'APPROVAL_REQUIRED') return 409
  // v3.0-P0：审批实体（落库）后的细分错误码。
  if (code === 'APPROVAL_NOT_FOUND') return 404
  if (code === 'SELF_APPROVAL_FORBIDDEN') return 403
  if (code === 'APPROVAL_CONSUMED' || code === 'APPROVAL_NOT_PENDING' || code === 'APPROVAL_EXPIRED' || code === 'APPROVAL_DIGEST_MISMATCH') return 409
  // v3.0-P2：工具链。声明写错是客户端问题（400）；校验/版本不符是「这台机器不满足要求」（409）；
  // 离线且锁缺失同样是 409（状态冲突，重试无用，得先补锁）。
  if (code === 'TOOLCHAIN_SPEC_INVALID') return 400
  if (code === 'TOOLCHAIN_NOT_FOUND') return 404
  if (code === 'TOOLCHAIN_CHECKSUM' || code === 'TOOLCHAIN_VERSION_MISMATCH') return 409
  if (code === 'TOOLCHAIN_LOCK_MISSING' || code === 'TOOLCHAIN_OFFLINE') return 409
  if (code === 'TOOLCHAIN_DOWNLOAD') return 502
  if (code === 'TOOLCHAIN_EXTRACT') return 500
  // v3.0-P5：制品 CAS。「找不到」是 404，「字节对不上」是 409（有人动了磁盘，重试无用）。
  if (code === 'ARTIFACT_NOT_FOUND') return 404
  if (code === 'ARTIFACT_DIGEST_INVALID' || code === 'ARTIFACT_EMPTY' || code === 'ARTIFACT_TOO_LARGE') return 400
  if (code === 'ARTIFACT_DIGEST_MISMATCH' || code === 'ARTIFACT_CORRUPTED') return 409
  if (code === 'ARTIFACT_WRITE_FAILED') return 500
  if (code.startsWith('PIPE_') || code === 'COMMAND_INVALID') return 400
  return 500
}

function errorJson(error) {
  return json({ ok: false, error: error.message || String(error), code: error.code || '', hosts: error.hosts || [] }, errorStatus(error))
}

const WRITE_CONFIRMS = new Set(['1', 'prod'])

/** 读一个 JSON 请求体；空体或坏 JSON 都当「没给参数」，交给 query 兜底。 */
async function jsonBodyOf(request) {
  try {
    if (typeof request.json !== 'function') return {}
    const text = await request.clone().text()
    if (!text.trim()) return {}
    const data = JSON.parse(text)
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  } catch { return {} }
}

/** 目录判断只用一次 stat，不走 readdir —— 目录可能很大。 */
function isDirectoryPath(target) {
  try { return statSync(target).isDirectory() } catch { return false }
}

/** 从请求里取一个稳定的关联 id，便于把「同一操作的 N 条审计」串起来。 */
function requestIdOf(request) {
  const existing = request?.headers?.get?.('x-request-id')
  if (existing) return String(existing).slice(0, 64)
  return `req-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
}

function sourceIpOf(request) {
  try {
    const url = new URL(request.url)
    return url.hostname || ''
  } catch { return '' }
}

/**
 * v3.0-P0 的唯一写入口：**身份 → 策略 → 审计**三件事必须一起做。
 *
 * 与 v2 `requireWrite` 的差别：
 * - v2 只判「同源 + 自定义头 + confirm」，任何本地页面都能部署 prod，且查不出是谁。
 * - 这里先 `auth.authenticate()` 解析出主体，再 `can(actor, action, resource)` 判权限，
 *   **无论允许还是拒绝都写一条审计**（R5：一决策一审计）。
 * - 保留同源与自定义头检查作为纵深防御（它们挡的是 CSRF/误触，不是身份）。
 *
 * 返回 Response 或 null；`decision` 通过返回值第二项交给调用方（目前不需要）。
 */
function authorize(request, params, { runtime, action, resource = {}, confirm = true, confirms = WRITE_CONFIRMS } = {}) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求', code: 'CSRF_ORIGIN' }, 403)
  if (!hasCicdHeader(request)) return json({ ok: false, error: '缺少 x-dsh-cicd 头', code: 'CSRF_HEADER' }, 403)
  if (confirm && !confirms.has(params.get('confirm'))) {
    return json({ ok: false, error: `写操作需要 confirm=${[...confirms].join(' 或 ')}`, code: 'CONFIRM_REQUIRED' }, 400)
  }
  const bundle = runtime.authBundle ? runtime.authBundle(request) : { actor: null, error: { code: 'AUTH_REQUIRED', message: '认证未初始化' } }
  if (bundle.error || !bundle.actor) {
    const code = bundle.error?.code || 'AUTH_REQUIRED'
    try {
      runtime.auditRecord?.({
        action: `auth.deny:${action}`, actorId: '', authMethod: '', resourceType: resource.type || '', resourceId: resource.id || '',
        projectId: resource.projectId || '', result: 'deny', reason: code,
        sourceIp: sourceIpOf(request), requestId: requestIdOf(request),
      })
    } catch { /* 审计失败不改变响应 */ }
    const status = code === 'AUTH_REQUIRED' ? 401 : 401
    return json({ ok: false, error: bundle.error?.message || '需要登录', code }, status)
  }
  const actor = { ...bundle.actor, sourceIp: sourceIpOf(request), requestId: requestIdOf(request) }
  const target = { type: resource.type || 'project', id: resource.id || '', projectId: resource.projectId || '', env: resource.env || '', protected: Boolean(resource.protected) }
  const decision = can(actor, action, target, { role: resource.role })
  try {
    runtime.auditRecord?.({
      action: decision.allow ? `${action}.allow` : 'policy.deny',
      actorId: actor.id, authMethod: actor.authMethod, tokenId: actor.tokenId || '',
      resourceType: target.type, resourceId: target.id, projectId: target.projectId,
      result: decision.allow ? 'allow' : 'deny',
      reason: decision.allow ? decision.reason : `${decision.reason} (${decision.policyId})`,
      sourceIp: actor.sourceIp, requestId: actor.requestId,
    })
  } catch { /* 审计失败不改变响应 */ }
  if (!decision.allow) {
    return json({ ok: false, error: `没有权限执行 ${action}：${decision.reason}`, code: 'POLICY_DENY', action, reason: decision.reason, policyId: decision.policyId }, 403)
  }
  request.__cicdActor = actor
  return null
}

/** 读路由也要求身份（至少 viewer）——否则「谁看了什么」完全不可见。 */
function authorizeRead(request, params, { runtime, action = ACTIONS.READ, resource = {} } = {}) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求', code: 'CSRF_ORIGIN' }, 403)
  const bundle = runtime.authBundle ? runtime.authBundle(request) : { actor: null, error: { code: 'AUTH_REQUIRED', message: '认证未初始化' } }
  if (bundle.error || !bundle.actor) {
    const code = bundle.error?.code || 'AUTH_REQUIRED'
    return json({ ok: false, error: bundle.error?.message || '需要登录', code }, 401)
  }
  const actor = { ...bundle.actor, sourceIp: sourceIpOf(request), requestId: requestIdOf(request) }
  const target = { type: resource.type || 'project', id: resource.id || '', projectId: resource.projectId || '', env: '', protected: false }
  const decision = can(actor, action, target)
  if (!decision.allow) {
    try {
      runtime.auditRecord?.({
        action: 'policy.deny', actorId: actor.id, authMethod: actor.authMethod, tokenId: actor.tokenId || '',
        resourceType: target.type, resourceId: target.id, projectId: target.projectId,
        result: 'deny', reason: `${decision.reason} (${decision.policyId})`,
        sourceIp: actor.sourceIp, requestId: actor.requestId,
      })
    } catch { /* best effort */ }
    return json({ ok: false, error: `没有权限读取：${decision.reason}`, code: 'POLICY_DENY' }, 403)
  }
  request.__cicdActor = actor
  return null
}

/** 兼容旧调用点：等价于 authorize 但不带具体动作判定（仅用于低危写操作）。 */
function requireWrite(request, params, options = {}) {
  return authorize(request, params, { ...options, action: options.action || ACTIONS.EDIT_CONFIG, confirm: options.confirm !== false })
}


async function projectsResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求', code: 'CSRF_ORIGIN' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set())
  if (bad) return json({ ok: false, error: bad }, 400)
  // v3.0-P0：读也要身份——「谁能看到所有项目」本身就是权限信息。
  const guard = authorizeRead(request, params, { runtime, resource: { type: 'project', id: '' } })
  if (guard) return guard
  return json({ ok: true, ...runtime.listProjects() })
}

async function projectMetaResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求', code: 'CSRF_ORIGIN' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['project']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const guard = authorizeRead(request, params, { runtime, resource: { type: 'project', id: params.get('project') || '', projectId: params.get('project') || '' } })
  if (guard) return guard
  try {
    const data = await runtime.projectMeta({ project: params.get('project') || '' })
    return json({ ok: true, ...data })
  } catch (error) { return errorJson(error) }
}

async function projectCreateResource(request, runtime) {
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['kind', 'name', 'path', 'repoUrl', 'branch', 'confirm']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const guard = authorize(request, params, { runtime, action: ACTIONS.MANAGE_PROJECT, resource: { type: 'project', id: params.get('name') || '' } })
  if (guard) return guard
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
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求', code: 'CSRF_ORIGIN' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['source', 'project']))
  if (bad) return json({ ok: false, error: bad }, 400)
  // 校验只是解析文本、不落盘也不执行：同源即可，不要求身份（编辑器边打边校验）。
  const data = runtime.validatePipe({ source: params.get('source') || '', project: params.get('project') || '' })
  return json(data)
}

async function pipeSaveResource(request, runtime) {
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['project', 'source', 'confirm']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const guard = authorize(request, params, { runtime, action: ACTIONS.EDIT_CONFIG, resource: { type: 'project', id: params.get('project') || '', projectId: params.get('project') || '' } })
  if (guard) return guard
  const data = runtime.savePipe({ project: params.get('project') || '', source: params.get('source') || '' })
  return json(data)
}

async function planResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求', code: 'CSRF_ORIGIN' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['project', 'target']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const guard = authorizeRead(request, params, { runtime, resource: { type: 'project', id: params.get('project') || '', projectId: params.get('project') || '' } })
  if (guard) return guard
  try {
    const data = await runtime.plan({ project: params.get('project') || '', target: params.get('target') || '' })
    return json({ ok: true, ...data })
  } catch (error) { return errorJson(error) }
}

async function runResource(request, runtime) {
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['project', 'target', 'stage', 'dryRun', 'confirm', 'runner', 'approvalId']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const targetName = params.get('target') || ''
  const projectId = params.get('project') || ''
  const isProd = params.get('confirm') === 'prod'
  const dryRun = params.get('dryRun') === '1' || params.get('dryRun') === 'true'
  // dryRun 只是预览：权限降到 read，但仍要求写头 + confirm（预览也会 fetch，不能当纯读放开）。
  const guard = dryRun
    ? authorize(request, params, { runtime, action: ACTIONS.READ, resource: { type: 'target', id: targetName, projectId } })
    : authorize(request, params, {
      runtime,
      action: isProd ? ACTIONS.DEPLOY_PROD : ACTIONS.RUN,
      resource: { type: 'target', id: targetName, projectId, protected: isProd },
    })
  if (guard) return guard
  try {
    const data = await runtime.run({
      projectId,
      targetName,
      stage: params.get('stage') || '',
      dryRun,
      confirmProd: isProd,
      runnerId: params.get('runner') || '',
      actor: request.__cicdActor || null,
      approvalId: params.get('approvalId') || '',
    })
    return json({ ok: true, ...data })
  } catch (error) { return errorJson(error) }
}

async function runsResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求', code: 'CSRF_ORIGIN' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['project', 'limit']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const limit = intParam(params, 'limit', { fallback: 20, min: 1, max: 200 })
  if (limit.error) return json({ ok: false, error: limit.error }, 400)
  const guard = authorizeRead(request, params, { runtime, resource: { type: 'project', id: params.get('project') || '', projectId: params.get('project') || '' } })
  if (guard) return guard
  try { return json({ ok: true, ...runtime.status({ project: params.get('project') || '', limit: limit.value }) }) } catch (error) { return errorJson(error) }
}

async function logResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求', code: 'CSRF_ORIGIN' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['runId', 'tail', 'jobId']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const tail = intParam(params, 'tail', { fallback: 200, min: 1, max: 5000 })
  if (tail.error) return json({ ok: false, error: tail.error }, 400)
  const guard = authorizeRead(request, params, { runtime, resource: { type: 'run', id: params.get('runId') || '' } })
  if (guard) return guard
  try {
    return json({ ok: true, ...runtime.logs({ runId: params.get('runId') || '', tail: tail.value, jobId: params.get('jobId') || '' }) })
  } catch (error) { return errorJson(error) }
}

async function releasesResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求', code: 'CSRF_ORIGIN' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['target', 'host', 'env', 'limit']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const limit = intParam(params, 'limit', { fallback: 20, min: 1, max: 200 })
  if (limit.error) return json({ ok: false, error: limit.error }, 400)
  const guard = authorizeRead(request, params, { runtime, resource: { type: 'target', id: params.get('target') || '', env: params.get('env') || '' } })
  if (guard) return guard
  try { return json({ ok: true, ...runtime.releases({ target: params.get('target') || '', host: params.get('host') || '', env: params.get('env') || '', limit: limit.value }) }) } catch (error) { return errorJson(error) }
}

async function rollbackResource(request, runtime) {
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['target', 'releaseId', 'project', 'host', 'confirm']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const isProd = params.get('confirm') === 'prod'
  const guard = authorize(request, params, {
    runtime,
    action: isProd ? ACTIONS.ROLLBACK_PROD : ACTIONS.ROLLBACK_NONPROD,
    resource: { type: 'target', id: params.get('target') || '', projectId: params.get('project') || '', protected: isProd },
  })
  if (guard) return guard
  try {
    const data = await runtime.rollback({ target: params.get('target') || '', releaseId: params.get('releaseId') || '', project: params.get('project') || '', host: params.get('host') || '', confirmProd: isProd, actor: request.__cicdActor || null })
    if (!data.ok) return json({ ok: false, error: data.error, code: data.code, ...data }, errorStatus({ code: data.code }))
    return json({ ok: true, ...data })
  } catch (error) { return errorJson(error) }
}

async function targetsResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求', code: 'CSRF_ORIGIN' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['project']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const guard = authorizeRead(request, params, { runtime, resource: { type: 'project', id: params.get('project') || '', projectId: params.get('project') || '' } })
  if (guard) return guard
  try {
    const data = await runtime.targets({ project: params.get('project') || '' })
    return json({ ok: true, ...data })
  } catch (error) { return errorJson(error) }
}

async function operationsResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求', code: 'CSRF_ORIGIN' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['project', 'runId', 'limit']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const limit = intParam(params, 'limit', { fallback: 50, min: 1, max: 200 })
  if (limit.error) return json({ ok: false, error: limit.error }, 400)
  const guard = authorizeRead(request, params, { runtime, action: ACTIONS.AUDIT_READ, resource: { type: 'project', id: params.get('project') || '', projectId: params.get('project') || '' } })
  if (guard) return guard
  try {
    return json({ ok: true, ...runtime.operations({ project: params.get('project') || '', runId: params.get('runId') || '', limit: limit.value }) })
  } catch (error) { return errorJson(error) }
}

async function notifyTestResource(request, runtime) {
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['confirm']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const guard = authorize(request, params, { runtime, action: ACTIONS.EDIT_CONFIG, resource: { type: 'notify', id: 'test' } })
  if (guard) return guard
  try {
    return json(await runtime.notifyTest())
  } catch (error) { return errorJson(error) }
}

// ---- V2-M1 资源：cancel / dora / triggers / hooks（prefix）/ log-ws（upgrade） ----------------

async function cancelResource(request, runtime) {
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['runId', 'confirm']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const guard = authorize(request, params, { runtime, action: ACTIONS.CANCEL, resource: { type: 'run', id: params.get('runId') || '' } })
  if (guard) return guard
  try { return json({ ok: true, ...runtime.cancel({ runId: params.get('runId') || '' }) }) } catch (error) { return errorJson(error) }
}

async function doraResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求', code: 'CSRF_ORIGIN' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['project', 'days']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const raw = params.get('days')
  const days = raw === null || raw === '' ? undefined : Number(raw)
  if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 365)) {
    return json({ ok: false, error: 'days 必须是 1-365 的整数' }, 400)
  }
  const guard = authorizeRead(request, params, { runtime, resource: { type: 'project', id: params.get('project') || '', projectId: params.get('project') || '' } })
  if (guard) return guard
  try { return json({ ok: true, ...runtime.dora({ project: params.get('project') || '', days }) }) } catch (error) { return errorJson(error) }
}

async function triggersResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求', code: 'CSRF_ORIGIN' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['project']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const guard = authorizeRead(request, params, { runtime, resource: { type: 'project', id: params.get('project') || '', projectId: params.get('project') || '' } })
  if (guard) return guard
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
      runnerId: params.get('runnerId') || '',
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
    const data = runtime.runnerLog({ runnerId: params.get('runnerId') || '', taskId: params.get('taskId') || '', line: params.get('line') || '' })
    return json({ ok: true, ...data })
  } catch (error) { return errorJson(error) }
}

async function runnersResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求', code: 'CSRF_ORIGIN' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['action', 'runnerId', 'reason', 'confirm']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const action = params.get('action') || ''
  // v3.0-P0：吊销是管理动作（不是读），要单独判权并留痕。
  if (action === 'revoke') {
    const guard = authorize(request, params, {
      runtime, action: ACTIONS.MANAGE_RUNNER,
      resource: { type: 'runner', id: params.get('runnerId') || '', projectId: params.get('project') || '' },
    })
    if (guard) return guard
    try {
      const actor = request.__cicdActor || null
      const data = runtime.runnerRevoke({
        runnerId: params.get('runnerId') || '',
        by: actor?.email || actor?.id || 'local',
        reason: params.get('reason') || '',
      })
      return json({ ok: true, ...data })
    } catch (error) { return errorJson(error) }
  }
  if (action) return json({ ok: false, error: `未知 action "${action}"（支持 revoke）` }, 400)
  const guard = authorizeRead(request, params, { runtime, resource: { type: 'runner', id: '' } })
  if (guard) return guard
  try { return json({ ok: true, runners: runtime.runners() }) } catch (error) { return errorJson(error) }
}

// V2-M4：审批路由——/approve 通过/拒绝审批，/approvals 列出待审批/已审批记录。
async function approveResource(request, runtime) {
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['runId', 'approvalId', 'id', 'decision', 'resolvedBy', 'reason', 'confirm']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const runId = params.get('runId') || ''
  const approvalId = params.get('approvalId') || params.get('id') || ''
  if (!runId && !approvalId) return json({ ok: false, error: '缺少 approvalId 或 runId' }, 400)
  const decision = params.get('decision') || 'approve'
  if (!['approve', 'reject'].includes(decision)) return json({ ok: false, error: `decision 只能是 approve 或 reject（收到 "${decision}"）` }, 400)
  // v3.0-P0：审批是独立权限（R1 四权分立），不能靠 deploy 权限顺带获得。
  const guard = authorize(request, params, {
    runtime, action: ACTIONS.APPROVE,
    resource: { type: 'approval', id: approvalId || runId, projectId: params.get('project') || '' },
  })
  if (guard) return guard
  try {
    const actor = request.__cicdActor || null
    const result = runtime.approve({
      runId, approvalId, approved: decision === 'approve',
      resolvedBy: params.get('resolvedBy') || '', reason: params.get('reason') || '', actor,
    })
    return json({ ok: true, ...result }, 200)
  } catch (error) { return errorJson(error) }
}

async function approvalsResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求', code: 'CSRF_ORIGIN' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['project', 'status', 'limit']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const guard = authorizeRead(request, params, { runtime, resource: { type: 'project', id: params.get('project') || '' } })
  if (guard) return guard
  try {
    const project = params.get('project') || ''
    const status = params.get('status') || ''
    const limit = intParam(params, 'limit', { fallback: 50, min: 1, max: 200 })
    if (limit.error) return json({ ok: false, error: limit.error }, 400)
    const data = runtime.approvals({ project, status, limit: limit.value })
    return json({ ok: true, ...data })
  } catch (error) { return errorJson(error) }
}

// V2-M4：secrets 路由——/secrets 列出/设置 secret（DB 只存 ref，载荷落 workDir/.secrets.json）。
// v3.0-P0：列表用 manage-secret 读；**取值（reveal）单独一个权限**，且必须留审计。
/**
 * v3.0-P5 制品路由。
 *
 * GET  `/artifacts?digest=…`                          下载（支持单区间 Range，RFC 7233）
 * GET  `/artifacts?project=…`                          列表 + 统计
 * POST `/artifacts?action=upload&path=…`               从构建机路径收字节（重算 digest）
 * POST `/artifacts?action=tag&owner=&name=&digest=`     移指针（不复制字节）
 * POST `/artifacts?action=verify&digest=`              全量重算（人工巡检）
 * POST `/artifacts?action=gc[&dryRun=0]`               回收无引用 blob（默认 dry-run）
 */
/**
 * OCI Distribution v2（`/v2/`）。docker / nerdctl / skopeo 都按这份规范说话，所以这里不发明形状。
 *
 * 鉴权走 Bearer challenge：未带票 → 401 + `www-authenticate: Bearer realm=…,service=…`，
 * 客户端拿 realm 去换票再来。票由 runtime.ociToken 签发，scope 写死票里，服务端不信任客户端自报。
 *
 * 这层的「仓库」不是独立存储：manifest 和层都是 CAS 里的 blob，tag 是 refs/<repo>/<tag>。
 * 好处是 pull 一个镜像、拉一个构建产物、回滚一次发布，三条路读的是同一份字节、同一个 GC 保留集。
 */
async function ociResource(request, runtime, pathname) {
  const method = String(request.method || 'GET').toUpperCase()
  const params = queryOf(request)
  const rest = String(pathname || '').slice(`${ROUTE_PREFIX}/v2`.length).replace(/^\/+/, '').replace(/\/+$/, '')
  const realm = '/api/plugins/cicd/v2/token'
  const challenge = (scope) => new Response(JSON.stringify({ errors: [{ code: 'UNAUTHORIZED', message: 'authentication required' }] }), {
    status: 401,
    headers: { ...baseJsonHeaders(), 'www-authenticate': `Bearer realm="${realm}",service="dsh-cicd",scope="${scope}"` },
  })

  if (!runtime.ociEnabled()) {
    return json({ errors: [{ code: 'UNSUPPORTED', message: 'registry 已被配置关闭' }] }, 405)
  }

  // /v2/token：换票。没有身份就不能换票（客户端会用 docker login 存下来的账号密码 basic auth）。
  if (rest === 'token') {
    const bundle = runtime.authBundle(request)
    if (bundle.error) return json({ errors: [{ code: 'UNAUTHORIZED', message: '需要先登录' }] }, 401)
    const actor = bundle.actor || {}
    // 只签「问到的 scope」里 actor 真有权限的那部分：`docker login` 会问 *,actions=*，
    // 全签等于给所有仓库开写权限。这里按 policy 里真实角色收敛。
    const requested = parseScope(params.get('scope') || '')
    const granted = []
    for (const item of requested) {
      const actions = [...item.actions].filter((action) => ociActionAllowed(actor, action))
      if (actions.length > 0) granted.push(`repository:${item.name}:${actions.join(',')}`)
    }
    const issued = runtime.ociToken({ scope: granted.join(' '), actorId: actor.id || actor.email || '' })
    return json({ token: issued.token, access_token: issued.token, expires_in: issued.expiresIn, issued_at: issued.issuedAt })
  }

  const authorized = runtime.ociAuthorize(request)
  const repoOf = () => {
    const match = /^([a-z0-9][^/]*(?:\/[a-z0-9][^/]*)*)\/(manifests|blobs|tags)\//.exec(rest)
    return match ? match[1] : ''
  }
  if (!authorized.ok) return challenge(repoOf() ? `repository:${repoOf()}:pull,push` : 'registry:catalog:*')
  const allowed = (repository, action) => authorizeOciScope(authorized, repository, action)

  // GET /v2/ —— 探活。docker login 的第一步，只需一张合法票。
  if (rest === '') return json({})

  // GET /v2/_catalog
  if (rest === '_catalog') {
    const owners = new Set()
    for (const ref of runtime.ociCatalog()) owners.add(ref.owner)
    return json({ repositories: [...owners].sort() })
  }

  // /v2/<name>/tags/list
  const tagsMatch = /^(.*)\/tags\/list$/.exec(rest)
  if (tagsMatch) {
    if (method !== 'GET') return json({ errors: [{ code: 'UNSUPPORTED', message: '只支持 GET' }] }, 405)
    if (!allowed(tagsMatch[1], 'pull')) return challenge(`repository:${tagsMatch[1]}:pull`)
    // 名字合法性放在鉴权之后判：先校验会让不合法的名字得到与「无权限」不同的响应，等于给了个探测口。
    try { parseRepository(tagsMatch[1]) } catch (error) { return ociErrorJson(error) }
    try { return json(stripOk(runtime.ociListTags({ repository: tagsMatch[1], limit: params.get('n') || 100 }))) } catch (error) { return ociErrorJson(error) }
  }

  // /v2/<name>/manifests/<ref>
  const manifestMatch = /^(.*)\/manifests\/(.+)$/.exec(rest)
  if (manifestMatch) {
    const repository = manifestMatch[1]
    const ref = decodeURIComponent(manifestMatch[2])
    if (method === 'GET' || method === 'HEAD') {
      if (!allowed(repository, 'pull')) return challenge(`repository:${repository}:pull`)
      try {
        const result = runtime.ociGetManifest({ repository, ref, expectedDigest: '' })
        const body = canonicalJson(result.manifest)
        return new Response(method === 'HEAD' ? null : body, {
          status: 200,
          headers: {
            'content-type': result.mediaType,
            'content-length': String(Buffer.byteLength(body)),
            'docker-content-digest': result.digest,
            etag: `"${result.digest}"`,
          },
        })
      } catch (error) { return ociErrorJson(error) }
    }
    if (method === 'PUT') {
      if (!allowed(repository, 'push')) return challenge(`repository:${repository}:push`)
      const raw = await request.text()
      try {
        const parsed = JSON.parse(raw)
        const result = await runtime.ociPutManifest({ repository, ref, manifest: parsed, raw, contentType: request.headers?.get?.('content-type') || '' })
        return json(stripOk(result), 201, { 'docker-content-digest': result.digest })
      } catch (error) { return ociErrorJson(error) }
    }
    if (method === 'DELETE') {
      // 删 manifest 会让镜像拉不下来，按 push 权限管（OCI 的 delete 动作不是所有客户端都会申请）。
      if (!allowed(repository, 'push')) return challenge(`repository:${repository}:push`)
      try { return json(stripOk(runtime.ociDeleteManifest({ repository, ref }))) } catch (error) { return ociErrorJson(error) }
    }
    return json({ errors: [{ code: 'UNSUPPORTED', message: '只支持 GET/HEAD/PUT/DELETE' }] }, 405)
  }

  // /v2/<name>/blobs/uploads/ —— 开一次上传会话
  const uploadStart = /^(.*)\/blobs\/uploads\/?$/.exec(rest)
  if (uploadStart) {
    const repository = uploadStart[1]
    if (method === 'POST') {
      if (!allowed(repository, 'push')) return challenge(`repository:${repository}:push`)
      try {
        const result = runtime.ociStartUpload({ repository, mount: params.get('mount') || '', from: params.get('from') || '' })
        if (result.mounted) {
          // 挂载成功：规范要求直接 201，Location 指回 blob。
          return json({}, 201, { location: `/api/plugins/cicd/v2/${repository}/blobs/${result.mounted}`, 'docker-content-digest': result.mounted })
        }
        return json({}, 202, { location: `/api/plugins/cicd/v2/${repository}/blobs/uploads/${encodeURIComponent(result.id)}`, 'docker-upload-uuid': result.id, range: '0-0' })
      } catch (error) { return ociErrorJson(error) }
    }
    return json({ errors: [{ code: 'UNSUPPORTED', message: '只支持 POST' }] }, 405)
  }

  // /v2/<name>/blobs/uploads/<uuid> —— PATCH 追加 / PUT 提交 / DELETE 放弃 / GET 查进度
  const uploadMatch = /^(.*)\/blobs\/uploads\/([^/]+)$/.exec(rest)
  if (uploadMatch) {
    const repository = uploadMatch[1]
    const id = decodeURIComponent(uploadMatch[2])
    if (!allowed(repository, 'push')) return challenge(`repository:${repository}:push`)
    try {
      if (method === 'PATCH' || method === 'PUT') {
        const wrote = await runtime.ociAppendUpload({ id, source: request.body })
        if (method === 'PATCH') {
          return json({}, 202, { location: `/api/plugins/cicd/v2/${repository}/blobs/uploads/${encodeURIComponent(id)}`, range: `0-${Math.max(0, wrote.bytes - 1)}` })
        }
        // 一次性 PUT（`docker push` 常用它把整层一次交上来，并带 ?digest=）
        const committed = await runtime.ociCommitUpload({ id, digest: params.get('digest') || '', repository, mediaType: '' })
        return json(stripOk(committed), 201, { location: `/api/plugins/cicd/v2/${repository}/blobs/${committed.digest}`, 'docker-content-digest': committed.digest })
      }
      if (method === 'DELETE') return json(stripOk(runtime.ociDropUpload(id)), 204)
      if (method === 'GET') return json({}, 204, { location: `/api/plugins/cicd/v2/${repository}/blobs/uploads/${encodeURIComponent(id)}` })
      return json({ errors: [{ code: 'UNSUPPORTED', message: '只支持 PATCH/PUT/DELETE' }] }, 405)
    } catch (error) { return ociErrorJson(error) }
  }

  // /v2/<name>/blobs/<digest> —— GET/HEAD 拉层，DELETE 删层（只删 tag 之外没人引用的，规范如此）
  const blobMatch = /^(.*)\/blobs\/(.+)$/.exec(rest)
  if (blobMatch) {
    const repository = blobMatch[1]
    const digest = decodeURIComponent(blobMatch[2])
    if (!allowed(repository, method === 'GET' || method === 'HEAD' ? 'pull' : 'push')) {
      return challenge(`repository:${repository}:pull,push`)
    }
    try {
      if (method === 'GET' || method === 'HEAD') {
        const slice = runtime.artifactStream(digest, request.headers?.get?.('range') || '')
        const headers = {
          'content-type': 'application/octet-stream',
          'content-length': String(slice.end - slice.start + 1),
          'accept-ranges': 'bytes',
          'docker-content-digest': slice.digest,
          etag: `"${slice.digest}"`,
        }
        if (slice.status === 206) headers['content-range'] = `bytes ${slice.start}-${slice.end}/${slice.bytes}`
        return new Response(method === 'HEAD' ? null : Readable.toWeb(slice.stream()), { status: slice.status, headers })
      }
      if (method === 'DELETE') {
        // 直接删字节会让同一个 digest 的其他引用失效，这里只允许删「没有任何 tag 指向的 manifest 层」，
        // 其余交给 GC —— 删 tag + GC 是两个动作，合并成一个会让回滚窗口被悄悄清掉。
        return json({ errors: [{ code: 'UNSUPPORTED', message: '请用 DELETE /manifests/<tag> 删标签，字节请走 GC' }] }, 405)
      }
      return json({ errors: [{ code: 'UNSUPPORTED', message: '只支持 GET/HEAD' }] }, 405)
    } catch (error) { return ociErrorJson(error) }
  }

  return json({ errors: [{ code: 'UNSUPPORTED', message: `未知的 OCI 路径 ${rest}` }] }, 404)
}


/** 票里写死的 scope 是否覆盖 <repository>:<action>。票里没写的仓库一律不放行。 */
function authorizeOciScope(authorized, repository, action) {
  return scopeAllows(authorized.scopes || [], repository, action)
}

/** 生成票时用：角色对某个 OCI 动作有没有权限（push/delete 走 MANAGE_PROJECT，pull 走 READ）。 */
function ociActionAllowed(actor, action) {
  // pull 是读，push/delete 是写。写一律按 MANAGE_PROJECT 判：能推镜像就能改部署内容，那是项目级权限。
  const needed = action === 'pull' ? ACTIONS.READ : ACTIONS.MANAGE_PROJECT
  try {
    return can(actor, needed, { type: 'artifact', id: '' }).allow === true
  } catch { return false }
}

/** 仓库层返回的对象都带 ok:true，HTTP 响应体不需要它。 */
function stripOk(value) {
  if (!value || typeof value !== 'object') return value
  const rest = { ...value }
  delete rest.ok
  return rest
}

function baseJsonHeaders() {
  return { 'content-type': 'application/json; charset=utf-8' }
}

function ociErrorJson(error) {
  const code = error?.code || 'UNKNOWN'
  // CAS 的错（上传/提交时冒出来的）用 artifact 的映射，其余走 OCI 规范的状态码。
  const status = code.startsWith('ARTIFACT_') ? errorStatus(error) : (ociStatus(code) || 500)
  return json({ errors: [{ code, message: String(error?.message || 'registry error'), detail: error?.extra || undefined }] }, status)
}

async function artifactsResource(request, runtime) {
  const params = queryOf(request)
  const method = String(request.method || 'GET').toUpperCase()
  const digest = params.get('digest') || ''
  const project = params.get('project') || ''
  const readOnly = method === 'GET' && digest && !params.get('action')
  // 读字节 = read（viewer 起）；列清单/统计 = read；写字节/移指针/GC = admin。
  const action = readOnly
    ? ACTIONS.READ
    : method === 'GET' ? ACTIONS.READ : ACTIONS.MANAGE_PROJECT
  const resource = { type: 'artifact', id: digest, projectId: project }
  // 下载不需要 x-dsh-cicd 写头和 confirm：它是 GET，且字节本身就是内容寻址的（拿不到 digest 就下载不了）。
  const guard = readOnly || method === 'GET'
    ? authorizeRead(request, params, { runtime, action, resource })
    : authorize(request, params, { runtime, action, resource })
  if (guard) return guard

  if (readOnly) {
    try {
      const range = request.headers?.get?.('range') || ''
      const slice = runtime.artifactStream(digest, range)
      const headers = {
        'content-type': 'application/octet-stream',
        'content-length': String(slice.end - slice.start + 1),
        'accept-ranges': 'bytes',
        'content-digest': slice.digest,
        'cache-control': 'public, max-age=31536000, immutable',
        etag: `"${slice.digest}"`,
      }
      if (slice.status === 206) headers['content-range'] = `bytes ${slice.start}-${slice.end}/${slice.bytes}`
      // 用 Web ReadableStream 交给 host；Host 侧会把 Node 流适配好。
      return new Response(Readable.toWeb(slice.stream()), { status: slice.status, headers })
    } catch (error) { return errorJson(error) }
  }

  const body = await jsonBodyOf(request)
  try {
    const result = await runtime.artifacts({
      action: params.get('action') || body.action || 'list',
      project,
      path: body.path || params.get('path') || '',
      digest: body.digest || digest,
      runId: body.runId || params.get('runId') || '',
      jobId: body.jobId || params.get('jobId') || '',
      mediaType: body.mediaType || params.get('mediaType') || '',
      owner: body.owner || params.get('owner') || '',
      name: body.name || params.get('name') || '',
      limit: params.get('limit') || body.limit,
      dryRun: params.get('dryRun') === '0' || body.dryRun === false ? false : true,
    })
    return json(result)
  } catch (error) { return errorJson(error) }
}

async function secretsResource(request, runtime) {
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['project', 'scope', 'name', 'value', 'reveal', 'confirm']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const project = params.get('project') || ''
  const scope = params.get('scope') || 'global'
  const name = params.get('name') || ''
  const value = params.get('value') || ''
  const reveal = params.get('reveal') === '1' || params.get('reveal') === 'true'
  // 三档：列出名字 = 读（viewer）；读值 = REVEAL_SECRET（admin + 审计）；写入 = MANAGE_SECRET。
  const action = name ? ACTIONS.MANAGE_SECRET : reveal ? ACTIONS.REVEAL_SECRET : ACTIONS.READ
  // 三档：列名 = 读（viewer，不加 confirm/写头）；读值 = REVEAL_SECRET（admin + confirm + 审计）；写入 = MANAGE_SECRET。
  const needsConfirm = Boolean(name) || reveal
  const guard = needsConfirm
    ? authorize(request, params, {
      runtime, action, confirm: true,
      resource: { type: 'secret', id: name ? `${project || scope}/${name}` : '', projectId: project },
    })
    : authorizeRead(request, params, {
      runtime, action: ACTIONS.READ,
      resource: { type: 'secret', id: '', projectId: project },
    })
  if (guard) return guard
  try {
    if (name) {
      if (!value) return json({ ok: false, error: '设置 secret 需要 value' }, 400)
      const ref = runtime.secrets({ project, scope, name, value })
      return json({ ok: true, ref, project, scope, name })
    }
    const listed = runtime.secrets({ project, scope, reveal })
    if (reveal) {
      try {
        runtime.auditRecord?.({
          action: 'secret.revealed', actorId: request.__cicdActor?.id || '', authMethod: request.__cicdActor?.authMethod || '',
          resourceType: 'secret', resourceId: `${project || scope}/*`, projectId: project, result: 'allow', reason: 'reveal=1',
          sourceIp: sourceIpOf(request), requestId: requestIdOf(request),
        })
      } catch { /* best effort */ }
    }
    return json({ ok: true, ...listed })
  } catch (error) { return errorJson(error) }
}

// V2-M4：environments 路由——/environments 列出环境（dev/staging/prod）与晋升路径。
async function environmentsResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求', code: 'CSRF_ORIGIN' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['project']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const guard = authorizeRead(request, params, { runtime, resource: { type: 'project', id: params.get('project') || '' } })
  if (guard) return guard
  try {
    const project = params.get('project') || ''
    return json({ ok: true, ...runtime.environments(project) })
  } catch (error) { return errorJson(error) }
}

// V2-M5：RBAC 路由——/rbac 签发/校验/吊销 token，列用户与审计时间线。
// v3.0-P0：这是旧版 RBAC（文件态 token），与新的 /users /tokens /audit 并存但**不参与判定**；
// 保留是为了不破坏既有客户端，所有判定已收敛到 lib/policy.js 的 can()。
async function rbacResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求', code: 'CSRF_ORIGIN' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['user', 'role', 'projects', 'ttlSec', 'token', 'action', 'confirm']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const action = params.get('action') || ''
  if (action !== 'verify') {
    const guard = authorizeRead(request, params, { runtime, action: ACTIONS.AUDIT_READ, resource: { type: 'rbac', id: params.get('user') || '' } })
    if (guard) return guard
  }
  try {
    const user = params.get('user') || ''
    const role = params.get('role') || ''
    const projectsRaw = params.get('projects') || ''
    const projects = projectsRaw ? projectsRaw.split(',').map((s) => s.trim()).filter(Boolean) : ['*']
    const ttlSec = Number(params.get('ttlSec') || 0)
    const token = params.get('token') || ''
    return json({ ok: true, ...runtime.rbac({ user, role, projects, ttlSec, token, action }) })
  } catch (error) { return errorJson(error) }
}

// ---------------------------------------------------------------------------------------------
// v3.0-P0：身份 / 用户 / token / 审计 / 锁 路由
// ---------------------------------------------------------------------------------------------

/** `/auth` —— 一次调用承担 me / login / logout 三件事，避免再增三条路由。 */
async function authResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求', code: 'CSRF_ORIGIN' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['action', 'email', 'password']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const action = params.get('action') || 'me'
  try {
    if (action === 'login') {
      const email = params.get('email') || ''
      const password = params.get('password') || ''
      if (!email || !password) return json({ ok: false, error: '需要 email 与 password', code: 'AUTH_INVALID' }, 400)
      const data = runtime.login({ email, password, sourceIp: sourceIpOf(request), userAgent: request?.headers?.get?.('user-agent') || '' })
      // 会话 token 通过 Set-Cookie 下发，前端不必自己拼 cookie。
      return json({ ok: true, ...data }, 200, { 'set-cookie': data.cookie, 'cache-control': 'no-store' })
    }
    if (action === 'logout') {
      const data = runtime.logout({ sessionId: params.get('sessionId') || '', request })
      return json({ ok: true, ...data }, 200, { 'set-cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict` })
    }
    const data = runtime.me(request)
    if (!data.ok) return json({ ok: false, error: data.error, code: data.code }, data.code === 'AUTH_REQUIRED' ? 401 : 403)
    return json({ ok: true, ...data })
  } catch (error) { return errorJson(error) }
}

/** `/users` —— 成员与角色管理。只有 manage-members（owner）能做写操作。 */
async function usersResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求', code: 'CSRF_ORIGIN' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['action', 'id', 'email', 'password', 'displayName', 'role', 'project', 'confirm']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const action = params.get('action') || 'list'
  const write = action !== 'list' && action !== 'get'
  try {
    if (write) {
      const guard = authorize(request, params, {
        runtime, action: ACTIONS.MANAGE_MEMBERS, resource: { type: 'project', id: params.get('project') || '*', projectId: params.get('project') || '' },
      })
      if (guard) return guard
    } else {
      const guard = authorizeRead(request, params, { runtime, action: ACTIONS.READ, resource: { type: 'project', id: params.get('project') || '*' } })
      if (guard) return guard
    }
    const data = runtime.users({
      action,
      id: params.get('id') || '',
      email: params.get('email') || '',
      password: params.get('password') || '',
      displayName: params.get('displayName') || '',
      role: params.get('role') || '',
      project: params.get('project') || '',
      userId: params.get('userId') || '',
    })
    return json({ ok: true, ...data })
  } catch (error) { return errorJson(error) }
}

/** `/tokens` —— 每个用户给自己发 API token；签发/吊销需要 manage-secret 级以上。 */
async function tokensResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求', code: 'CSRF_ORIGIN' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['action', 'userId', 'name', 'ttlSec', 'id', 'confirm']))
  if (bad) return json({ ok: false, error: bad }, 400)
  const action = params.get('action') || 'list'
  try {
    if (action === 'create' || action === 'revoke') {
      const guard = authorize(request, params, { runtime, action: ACTIONS.MANAGE_SECRET, resource: { type: 'token', id: params.get('id') || params.get('userId') || '' } })
      if (guard) return guard
    } else {
      const guard = authorizeRead(request, params, { runtime, action: ACTIONS.READ, resource: { type: 'token', id: params.get('userId') || '' } })
      if (guard) return guard
    }
    const ttlSec = Number(params.get('ttlSec') || 0)
    const data = runtime.tokens({ action, userId: params.get('userId') || '', name: params.get('name') || '', ttlSec: Number.isFinite(ttlSec) ? ttlSec : 0, id: params.get('id') || '' })
    return json({ ok: true, ...data })
  } catch (error) { return errorJson(error) }
}

/** `/audit` —— 审计查询；`action=verify` 校验哈希链完整性。 */
async function auditResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求', code: 'CSRF_ORIGIN' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['action', 'limit', 'actor', 'project', 'result', 'name']))
  if (bad) return json({ ok: false, error: bad }, 400)
  try {
    const guard = authorizeRead(request, params, { runtime, action: ACTIONS.AUDIT_READ, resource: { type: 'audit', id: params.get('project') || '' } })
    if (guard) return guard
    const limit = intParam(params, 'limit', { fallback: 50, min: 1, max: 500 })
    if (limit.error) return json({ ok: false, error: limit.error }, 400)
    if ((params.get('action') || '') === 'verify') return json(runtime.auditVerify({ limit: Math.max(limit.value, 1000) }))
    return json(runtime.auditList({
      limit: limit.value,
      actor: params.get('actor') || '',
      action: params.get('name') || '',
      project: params.get('project') || '',
      result: params.get('result') || '',
    }))
  } catch (error) { return errorJson(error) }
}

/** `/locks` —— 部署锁可视化与强制释放（prod 卡住时的唯一出口）。 */
async function locksResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求', code: 'CSRF_ORIGIN' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['action', 'target', 'reason', 'confirm']))
  if (bad) return json({ ok: false, error: bad }, 400)
  try {
    const guard = authorize(request, params, { runtime, action: ACTIONS.MANAGE_RUNNER, resource: { type: 'target', id: params.get('target') || '' }, confirm: false })
    if (guard) return guard
    if ((params.get('action') || 'list') === 'release') {
      if (!params.get('confirm')) return json({ ok: false, error: '强制释放需要 confirm=1', code: 'CONFIRM_REQUIRED' }, 400)
      return json(runtime.lockForceRelease({ target: params.get('target') || '', reason: params.get('reason') || '' }))
    }
    return json(runtime.lockList())
  } catch (error) { return errorJson(error) }
}

/**
 * `/toolchain`：查询 store、解析、安装、写锁、清理。
 *
 * 写动作（install / lock / gc / remove）走 `MANAGE_RUNNER` 级别权限：装一个 JDK 会占几百 MB 磁盘、
 * 还会真的访问外网，和「改 runner 配置」是同一档权力。只读动作（list / resolve）用 READ。
 */
async function toolchainResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求', code: 'CSRF_ORIGIN' }, 403)
  const params = queryOf(request)
  const bad = unsupportedParams(params, new Set(['action', 'project', 'lang', 'version', 'platform', 'confirm']))
  if (bad) return json({ ok: false, error: bad }, 400)
  try {
    const action = params.get('action') || 'list'
    const write = action !== 'list' && action !== 'resolve'
    const project = params.get('project') || ''
    const guard = write
      ? authorize(request, params, { runtime, action: ACTIONS.MANAGE_RUNNER, resource: { type: 'project', id: project, projectId: project } })
      : authorizeRead(request, params, { runtime, action: ACTIONS.READ, resource: { type: 'project', id: project, projectId: project } })
    if (guard) return guard
    return json(await runtime.toolchain({
      action,
      project,
      lang: params.get('lang') || '',
      version: params.get('version') || '',
      platform: params.get('platform') || '',
    }))
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
    // v3.0-P0：身份 / 成员 / token / 审计 / 部署锁
    { kind: 'exact', path: `${ROUTE_PREFIX}/auth`, resource: (request) => authResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/users`, resource: (request) => usersResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/tokens`, resource: (request) => tokensResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/audit`, resource: (request) => auditResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/locks`, resource: (request) => locksResource(request, runtime) },
    // v3.0-P2：工具链托管（JDK/Node/Python/Maven…）
    { kind: 'exact', path: `${ROUTE_PREFIX}/toolchain`, resource: (request) => toolchainResource(request, runtime) },
    // v3.0-P5：制品 CAS（上传 / 下载 / 指针 / GC）
    { kind: 'exact', path: `${ROUTE_PREFIX}/artifacts`, resource: (request) => artifactsResource(request, runtime) },
    // 入站 webhook 是路径带项目名的前缀路由：/hooks/<project>
    { kind: 'prefix', path: `${ROUTE_PREFIX}/hooks`, resource: (request) => hookResource(request, runtime) },
    // v3.0-P5-4：OCI Distribution v2。整段 /v2/ 是一条前缀路由——路径形状是规范定死的，
    // 拆成 exact 只会让 <repo>/manifests/<ref> 这类多段路径没处放。
    { kind: 'prefix', path: `${ROUTE_PREFIX}/v2`, resource: (request) => ociResource(request, runtime, new URL(request.url).pathname) },
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
  // v3.0-P5：制品 CAS 的工具函数，测试与脚本直接复用同一份实现。
  normalizeDigest,
  digestPath,
  parseRange,
  createArtifactStore,
  registerHttpRoutes,
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
  // v3.0-P0：身份 / 策略 / 审计 / 锁
  createAuth,
  createAudit,
  createDeployLocks,
  can,
  ACTIONS,
  policyMatrix,
  authorize,
  authorizeRead,
  SESSION_COOKIE,
  // v3.0-P1：DSL v2 内核（表达式 / 模型归一化 / DAG 调度）
  expr,
  model,
  jobs,
  resources: {
    projectsResource, projectMetaResource, projectCreateResource, validateResource, pipeSaveResource, planResource,
    runResource, runsResource, logResource, releasesResource, rollbackResource, targetsResource,
    operationsResource, notifyTestResource, cancelResource, doraResource, triggersResource, hookResource,
    runnerRegisterResource, runnerPollResource, runnerResultResource, runnerLogResource, runnersResource,
    approveResource, approvalsResource, secretsResource, environmentsResource, rbacResource,
    authResource, usersResource, tokensResource, auditResource, locksResource, toolchainResource,
  },
  // v3.0-P2：工具链（解析 / 安装 / 注入 / 断言）
  toolchain: { createToolchain, envFor, assertVersions, inferFromFiles, writeDualLocks, TOOLCHAIN_ERRORS, LANGS: TOOLCHAIN_LANGS },
  // v3.0-P2：uses 动作（内置白名单，无外部 action）与构建缓存
  actions: { runAction, ACTIONS: PIPELINE_ACTIONS, ACTION_NAMES, ACTION_ERRORS },
  cache: { createCacheStore, CACHE_ERRORS },
  // v3.0-P3：部署引擎（四阶段事务 / 槽位 / Actuator / manifest）
  deploy: {
    deployTransaction,
    usesTransaction,
    planBatches,
    readManifest,
    DEPLOY_ERRORS,
  },
  actuator: {
    createNativeActuator,
    NATIVE_COMMANDS,
    ACTUATOR_ERRORS,
    renderTemplate,
  },
  slots: { createSlotStore, SLOT_ERRORS },
}