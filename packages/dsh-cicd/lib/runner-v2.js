/**
 * 云流水线 Runner 协议 v2（M1：协议骨架）。
 *
 * v1（bin/runner.mjs 走的 /runner-register 等 GET 路由）受 DSH webserver 的 resource 路由
 * 限制只能 GET，参数全在 query 里，日志一行一跳。v2 挂在 handler 路由上（auth: 'anonymous'，
 * handler 内部自验 token），支持 POST + JSON body + 批量日志 + 长轮询 claim。
 *
 * 认证模型：
 *   - register 用 join token（cordis.patch.yml 的 runners.joinToken，sha256 + timingSafeEqual）；
 *   - 注册成功发一张 runner token（rt_ 前缀，明文只在响应里出现一次，库里只存 sha256 摘要）；
 *   - 其余端点一律 Authorization: Bearer <runnerToken>，按 runnerId 查摘要比对；
 *   - 吊销立刻生效（注册表读库，与 v1 同一套）。
 *
 * 本文件是纯调度层（不碰 socket），HTTP 适配器 httpHandler() 只用 IncomingMessage/ServerResponse
 * 的最小表面（method/url/headers/on('data')、writeHead/end），webserver handler 路由与测试的
 * 假 req/res 都能满足。
 */

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { createWriteStream, mkdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { joinTokenMatches } from './executors.js'

export const RUNNER_V2_PATH = '/runner/v2'

/**
 * M5：协议版本握手。v2 端点只服务 v2 runner；v1 runner（bin/runner.mjs 的
 * /runner-register + /runner-poll 轮询）继续跑，但两条路径互不借道——
 * 一台机器走错协议时应该拿到一句「你该去哪」，而不是 401/404 那种指向凭据的假线索。
 */
export const RUNNER_PROTOCOL_V2 = 2
export const RUNNER_PROTOCOL_V1 = 1
/** 长轮询上限：DSH 反向代理常见 60s 超时，留一倍余量。 */
const MAX_WAIT_MS = 25000
/** 单个请求体上限：日志批次可能很大，但不能没有顶。 */
const MAX_BODY_BYTES = 4 * 1024 * 1024
/** 缓存 blob 上限（gzip 后的 tar）：一次 PUT 的字节顶。 */
const MAX_CACHE_BYTES = 256 * 1024 * 1024
/** 缓存 PUT 的临时文件前缀：先进临时文件算摘要，再决定收不收进 CAS。 */
const CACHE_TMP_PREFIX = 'dsh-cicd-cache-'

// M4：单个回流制品的上限。缓存包与制品包都进同一个 CAS，但用途不同（制品要原样上传到目标机），
// 所以分成两个常量：调大缓存不该顺带放宽制品的口径。
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024
const ARTIFACT_TMP_PREFIX = 'dsh-cicd-artifact-'
// 制品名会进 URL 路径（PUT /artifacts/:taskId/:name）与 CAS 指针，所以只收一个窄字符集。
const ARTIFACT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function sha256Hex(text) {
  return createHash('sha256').update(String(text)).digest('hex')
}

/** 库里存的是 token 的 sha256（hex），所以比的是「明文的摘要」与「库里的摘要」本身。 */
function tokenEquals(provided, storedSha) {
  if (!provided || !storedSha) return false
  const a = Buffer.from(sha256Hex(provided), 'utf8')
  const b = Buffer.from(String(storedSha).trim(), 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 数字字段归一：非数字一律丢弃（宁可这次不更新，也不拿坏数据覆盖上一份好数据）。 */
function finiteNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * 心跳负载（M3）：在跑任务数 / 磁盘剩余百分比 / 缓存命中统计。
 * 字段全部可选——runner 不知道就省略，宿主不替它编 0。
 */
function normalizeStats(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const out = {}
  const running = finiteNumber(raw.running)
  if (running !== null) out.running = Math.max(0, Math.trunc(running))
  const disk = finiteNumber(raw.diskFreePct)
  if (disk !== null) out.diskFreePct = Math.min(100, Math.max(0, disk))
  if (raw.cache && typeof raw.cache === "object" && !Array.isArray(raw.cache)) {
    const cache = {}
    for (const key of ["hits", "misses", "saves"]) {
      const n = finiteNumber(raw.cache[key])
      if (n !== null) cache[key] = Math.max(0, Math.trunc(n))
    }
    if (Object.keys(cache).length > 0) out.cache = cache
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * 缓存声明归一（M3）：key 必填且非空，paths 只留相对路径，mode 只认 restore/save/both。
 * 一条都不合法就返回空数组——runner 侧因此永远不会因为坏声明去动磁盘。
 */
function normalizeCache(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const key = String(item.key || '').trim()
    if (!key) continue
    const paths = (Array.isArray(item.paths) ? item.paths : [])
      .map((value) => String(value || '').trim())
      .filter((value) => value && !value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value))
    if (paths.length === 0) continue
    const restoreKeys = (Array.isArray(item.restoreKeys) ? item.restoreKeys : Array.isArray(item.restore_keys) ? item.restore_keys : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
    const mode = ['restore', 'save', 'both'].includes(item.mode) ? item.mode : 'both'
    out.push({ key, paths, restoreKeys, mode })
  }
  return out
}

/**
 * M4：任务级制品声明。来源是 pipe 里同 stage 的 `uses: collect` 步骤（name/paths），
 * 由 runner 在步骤全部成功后按它 glob 自己的 workspace 并逐个 PUT 回宿主。
 * 形状不合法的条目直接丢弃：它既不能 glob 也不能命名，留着只会让 runner 报一个
 * 与本意无关的错。
 */
function normalizeArtifacts(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const name = String(item.name || '').trim()
    if (!ARTIFACT_NAME_RE.test(name) || seen.has(name)) continue
    const paths = (Array.isArray(item.paths) ? item.paths : [item.paths])
      .map((value) => String(value || '').trim())
      .filter((value) => value && !value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value) && !value.split(/[\\/]/).includes('..'))
    if (paths.length === 0) continue
    seen.add(name)
    out.push({ name, paths, optional: Boolean(item.optional) })
  }
  return out
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./runners.js').createRunnerRegistry>} deps.runners 落库注册表
 * @param {ReturnType<import('./executors.js').createTaskBroker>} deps.broker 任务队列
 * @param {object} deps.options 插件配置（runners.joinToken 在这里）
 * @param {object} deps.audit 审计
 * @param {object} deps.store operations 台账
 */
export function createRunnerV2Service({ runners, broker, options, audit, store, secrets = null, artifacts = null, log = () => {} } = {}) {
  if (!runners || !broker) throw new Error('createRunnerV2Service 需要 runners 与 broker')

  const errorOf = (status, code, message) => ({ status, body: { ok: false, code, error: message } })
  const ok = (body) => ({ status: 200, body: { ok: true, ...body } })

  // M4：本进程内「某个任务已经上传了哪些制品」。complete 用它做「声明的必须到齐」的校验。
  // 只存在于内存是刻意的：任务本身也活在 broker 的内存队列里，进程重启后两边一起消失；
  // 真正要长期留的是 CAS 字节与 artifacts 表的那几行（部署/晋级只认它们）。
  const taskArtifacts = new Map()
  function noteTaskArtifact(taskId, entry) {
    const list = taskArtifacts.get(taskId) || []
    const next = list.filter((item) => item.name !== entry.name)
    next.push(entry)
    taskArtifacts.set(taskId, next)
    return next
  }

  /** Bearer token 认证：runnerId 必须已注册、token 摘要必须吻合、未吊销。 */
  function authenticate(runnerId, token) {
    if (!token) return errorOf(401, 'RUNNER_TOKEN_MISSING', '缺少 Authorization: Bearer <runnerToken>（register 时只发一次）')
    const row = runners.describe(runnerId)
    if (!row) return errorOf(401, 'RUNNER_UNREGISTERED', `runner ${runnerId} 未注册，请先 register`)
    // 协议错位要在 token 之前报：一台先注册过 v2、后来又用 v1 注册的机器会留下 v1 的
    // protocol 与 v2 的 token 摘要，报 401 会把人引去查凭据，而真正的原因是走错了端点。
    if (Number(row.protocol || 1) !== RUNNER_PROTOCOL_V2) {
      return errorOf(409, 'RUNNER_PROTOCOL_MISMATCH', `runner ${runnerId} 是按 v1 协议注册的，${RUNNER_V2_PATH} 只服务 v2；v1 runner 请用 /runner-poll /runner-result，或重新以 v2 注册（会换发新 token）`)
    }
    if (!tokenEquals(token, runners.tokenSha(runnerId))) {
      return errorOf(401, 'RUNNER_TOKEN_INVALID', 'runner token 无效（可能已被轮换，请重新 register）')
    }
    if (row.revoked) return errorOf(403, 'RUNNER_REVOKED', `runner ${runnerId} 已被吊销`)
    return null
  }

  // ---- 缓存（M3）：字节进制品 CAS，指针进 refs，键名用 sha256(projectId\0key) ---------------

  /** 一个项目一棵指针树：owner 里的冒号会被 refPath 归一成下划线，两侧用法一致。 */
  const cacheOwner = (projectId) => `cache:${String(projectId || '')}`
  /** 键名不能带斜杠/冒号（会被 refPath 归一，可能撞名），所以存摘要、把真实 key 记在记录里。 */
  const cacheRefName = (projectId, key) => sha256Hex(`${String(projectId || '')}\u0000${String(key || '')}`)

  /** 任务申报了哪些缓存：没申报的 key（含 restoreKeys 前缀）一律不许读写。 */
  /** M4：制品名必须先在任务描述里声明过——否则 runner 可以往 CAS 里塞任意名字。 */
function declaredArtifact(described, name) {
  const decl = (described.artifacts || []).find((item) => item.name === name)
  if (!decl) {
    return { error: { status: 403, body: { ok: false, code: 'ARTIFACT_NOT_DECLARED', error: `制品 ${name} 不在任务声明里（${(described.artifacts || []).map((i) => i.name).join('、') || '空'}）` } } }
  }
  return { decl }
}

function declaredCache(described, key, { write = false } = {}) {
    const list = Array.isArray(described?.cache) ? described.cache : []
    const decl = list.find((item) => item.key === key)
    if (!decl) return { error: errorOf(403, 'CACHE_NOT_DECLARED', `任务 ${described?.taskId || ''} 未申报缓存 key "${key}"`) }
    if (write && !(decl.mode === 'save' || decl.mode === 'both')) {
      return { error: errorOf(403, 'CACHE_SAVE_FORBIDDEN', `缓存 key "${key}" 的 mode 是 ${decl.mode}，不允许保存`) }
    }
    return { decl }
  }

  /** 精确 key 优先，其后按 restoreKeys 前缀取最新的一条（与本机 `uses: cache` 同义）。 */
  function lookupCacheRef(projectId, key, restoreKeys) {
    if (!artifacts) return null
    const owner = cacheOwner(projectId)
    const exact = artifacts.readRef(owner, cacheRefName(projectId, key))
    if (exact && artifacts.has(exact.digest)) return exact
    const prefixes = (Array.isArray(restoreKeys) ? restoreKeys : []).map((item) => String(item || '')).filter(Boolean)
    if (prefixes.length === 0) return null
    let best = null
    for (const record of artifacts.listRefs(owner)) {
      if (!record || !record.key || record.key === key) continue
      if (!prefixes.some((prefix) => String(record.key).startsWith(prefix))) continue
      if (!artifacts.has(record.digest)) continue
      if (!best || String(record.updatedAt || '') > String(best.updatedAt || '')) best = record
    }
    return best
  }

  /** 这条 digest 是不是本项目的某个缓存指针——GET 拿字节前要过这一关。 */
  function cacheRecordByDigest(projectId, digest) {
    if (!artifacts) return null
    const wanted = String(digest || '').trim()
    if (!wanted) return null
    for (const record of artifacts.listRefs(cacheOwner(projectId))) {
      if (record && record.digest === wanted && artifacts.has(record.digest)) return record
    }
    return null
  }

  /** 读 body/query 里的一对必填字段（GET 走 query，POST/PUT 走 body 或 query）。 */
  function taskAndKey(source) {
    const taskId = String(source?.taskId || '').trim()
    const key = String(source?.key || '').trim()
    if (!taskId || !key) return { error: errorOf(400, 'BAD_REQUEST', '缺少 taskId 或 key') }
    return { taskId, key }
  }

  /** 把 executor 入队的 spec 翻译成 v2 任务描述（M1：单步 run，无 source/secretRefs/caches）。 */
  /** M2：源码信息只认 git；缺 url 的视为没有源码（避免 runner 拿到半截描述去做注定失败的 clone）。 */
  function normalizeSource(source) {
    if (!source || typeof source !== 'object' || String(source.type || 'git') !== 'git') return null
    const url = String(source.url || '').trim()
    if (!url) return null
    return {
      type: 'git',
      url,
      ref: String(source.ref || 'HEAD'),
      sha: String(source.sha || ''),
      depth: Number(source.depth) > 0 ? Number(source.depth) : 1,
    }
  }

  /** M2：带 source 的任务在 steps 前面补一个显式 checkout 步骤——协议上「先取源码」是任务的一部分，
   *  而不是 runner 的隐式副作用，这样 mock/测试 runner 也能按同一份描述决定自己要不要 checkout。 */
  function buildSteps(spec, timeoutSec) {
    const run = { uses: 'run', command: String(spec.command || ''), cwd: String(spec.cwd || '.'), timeoutSec }
    return normalizeSource(spec.source) ? [{ uses: 'checkout' }, run] : [run]
  }

  /** 项目 secret 的「名字 → 明文」表。没有 secrets 依赖（v1 形态/单测）时返回空表，
   *  任务描述就与 M1 完全一致——M3 的能力是叠加的，不是替换。 */
  function secretMap(projectId) {
    const id = String(projectId || '').trim()
    if (!id || !secrets || typeof secrets.refsForInterpolate !== 'function') return {}
    try { return secrets.refsForInterpolate(id, {}) || {} } catch { return {} }
  }

  /** 明文 → 名字的反查表，长值优先（短值先替换会把长值切碎，漏掉真正的匹配）。
   *  短于 4 字符的值不参与改写：长度 0 会把整段文本打成占位符，极短值多半是配置错误，
   *  两种情况下「不动任务体」都比「改错」安全。 */
  function secretLookup(map) {
    const pairs = Object.entries(map || {}).filter(([, value]) => typeof value === 'string' && value.length >= 4)
    pairs.sort((a, b) => b[1].length - a[1].length)
    return pairs
  }

  /** 把文本里的明文改写成 shell 占位符 ${NAME}；runner 注入 env 后由 shell 展开成真值。 */
  function scrubText(text, lookup, used) {
    let out = String(text ?? '')
    for (const [name, value] of lookup) {
      if (!out.includes(value)) continue
      out = out.split(value).join('${' + name + '}')
      used.add(name)
    }
    return out
  }

  function taskDescription(task) {
    const spec = task.spec || {}
    const timeoutSec = Number(spec.timeoutSec) > 0 ? Number(spec.timeoutSec) : 60
    const projectId = String(spec.projectId || '')
    const lookup = secretLookup(secretMap(projectId))
    const used = new Set()
    // env：整值就是一个密钥的，抽成 secretEnv 映射（任务体里连值的影子都不留）；
    // 其余值里混着明文的，就地改写成 ${NAME}。
    const env = {}
    const secretEnv = []
    for (const [key, raw] of Object.entries(spec.env && typeof spec.env === 'object' ? spec.env : {})) {
      const value = raw === null || raw === undefined ? '' : String(raw)
      const exact = lookup.find(([, secretValue]) => secretValue === value)
      if (exact) {
        used.add(exact[0])
        secretEnv.push({ env: key, ref: exact[0] })
        continue
      }
      env[key] = scrubText(value, lookup, used)
    }
    const steps = buildSteps(spec, timeoutSec).map((step) => (step.command ? { ...step, command: scrubText(step.command, lookup, used) } : step))
    return {
      taskId: String(spec.taskId || ''),
      runId: String(spec.runId || ''),
      projectId,
      stepIndex: Number.isInteger(spec.stepIndex) ? spec.stepIndex : 0,
      stageId: String(spec.stageId || ''),
      // 租约给到「步骤超时 + 60s」：命令慢不等于租约丢，宽限只用于网络抖动。
      leaseSec: timeoutSec + 60,
      // workspace.root 相对 runner 的 --workdir；clean=true 每次重建，等价一次性构建目录。
      // M2：tasks/ 前缀是 M1 的历史形态，新任务统一 ws/<runId>（runner 两种都认）。
      workspace: { root: `ws/${spec.runId || spec.taskId}`, clean: true, ttlSec: 3600 },
      // M2：git 项目把源码信息下发，runner 先 checkout 再跑步骤；本地项目没有 source，
      // 行为与 M1 完全一致（workspace 只是执行目录，不含项目文件）。
      source: normalizeSource(spec.source),
      // M3：env 只剩非敏感变量；密钥由 runner 拿 secretRefs 去 /credentials 换短期值，
      // 所以任务体（进而日志、DB、v2 响应）里没有明文可 grep。
      env,
      secretRefs: [...used],
      secretEnv,
      steps,
      logStream: { batchMs: 250 },
      // M4：制品回流声明（name/paths/optional）。宿主按它校验上传，runner 按它 glob。
      artifacts: normalizeArtifacts(spec.artifacts),
      // M3：缓存声明（key 命中即恢复，任务成功后保存）。宿主侧的 uses: cache 步骤照旧；
      // 这里是给「整任务级」缓存用的，M3 先打通协议，pipe 侧的 job 级 cache 随后接。
      cache: normalizeCache(spec.cache),
    }
  }

  const endpoints = {
    /** POST /register：join token 换 runner token（重复注册 = 轮换）。 */
    async register(body) {
      const runnerId = String(body?.runnerId || '').trim()
      if (!runnerId) return errorOf(400, 'BAD_REQUEST', '缺少 runnerId')
      const labels = Array.isArray(body?.labels) ? body.labels.map((item) => String(item)) : String(body?.labels || '').split(',').map((item) => item.trim()).filter(Boolean)
      // M2：能力上报（tools:['git']）并入 labels（tool:<name>）——注册表结构不用动，
      // 调度侧（claim 过滤）和 GUI 就都能用一个字段读到「这台机器能干什么」。
      const tools = Array.isArray(body?.tools) ? body.tools.map((item) => String(item).trim()).filter(Boolean) : []
      const toolLabels = tools.map((tool) => `tool:${tool}`)
      const allLabels = [...new Set([...labels, ...toolLabels])]
      const capacity = Number.isInteger(body?.capacity) && body.capacity > 0 ? body.capacity : 1
      const version = String(body?.version || '')
      const secret = options.runners?.joinToken
      if (!secret) {
        return errorOf(401, 'RUNNER_JOIN_TOKEN_UNSET', '服务端未配置 runners.joinToken；先在 cordis.patch.yml 里配置再加入')
      }
      if (!joinTokenMatches(String(body?.joinToken || ''), secret)) {
        return errorOf(401, 'RUNNER_JOIN_TOKEN_INVALID', 'join token 校验失败')
      }
      // 握手：客户端可以自报协议（可选），自报得不对就当场说清楚支持范围。
      // 不报的按 v2 处理——它已经在敲 /runner/v2/register 了。
      const claimed = body?.protocol === undefined || body?.protocol === null || body?.protocol === ''
        ? null
        : Number(body.protocol)
      if (claimed !== null && claimed !== RUNNER_PROTOCOL_V2) {
        return errorOf(426, 'RUNNER_PROTOCOL_UNSUPPORTED', `这台 runner 报的是协议 ${Number.isFinite(claimed) ? claimed : JSON.stringify(body.protocol)}，${RUNNER_V2_PATH} 只接受 v2（${RUNNER_PROTOCOL_V2}）；v1 runner 请继续用 /runner-register + /runner-poll`)
      }
      // 落库（吊销过的在这里抛 RUNNER_REVOKED），再登记 broker 队列——顺序与 v1 相同。
      const info = runners.register(runnerId, { labels: allLabels, version, capacity, protocol: 2 })
      broker.register(runnerId, { labels: allLabels, version, capacity })
      const runnerToken = 'rt_' + randomBytes(24).toString('hex')
      runners.setToken(runnerId, sha256Hex(runnerToken))
      try { store.appendOperation({ action: 'runner-register-v2', project: runnerId, status: 'ok', detail: JSON.stringify({ labels: allLabels, tools, version }) }) } catch { /* best effort */ }
      try { audit.record({ action: 'runner.register', actorId: '', authMethod: 'runner-token-v2', resourceType: 'runner', resourceId: runnerId, result: 'allow', reason: `labels:${allLabels.join(',')}` }) } catch { /* 审计失败不阻断注册 */ }
      log('runner-v2-register', { runnerId })
      return ok({
        runnerId,
        runnerToken,
        protocol: RUNNER_PROTOCOL_V2,
        minProtocol: RUNNER_PROTOCOL_V2,
        heartbeatSec: info.heartbeatSec,
        offlineAfterSec: info.offlineAfterSec,
        serverTime: new Date().toISOString(),
      })
    },

    /** POST /heartbeat：续 last_seen_at，并带走 runner 的运行时统计（M3）。 */
    async heartbeat(body, { token } = {}) {
      const runnerId = String(body?.runnerId || '').trim()
      const denied = authenticate(runnerId, token)
      if (denied) return denied
      const info = runners.heartbeat(runnerId) // 吊销 → RUNNER_REVOKED
      // 形状不合法就整块丢弃：心跳本身不能因为统计字段写错而失败，
      // 也不能拿半截数据覆盖上一份好数据。
      const stats = normalizeStats(body?.stats)
      if (stats) {
        try { runners.recordStats(runnerId, stats) } catch { /* 入库失败不影响心跳续期 */ }
      }
      return ok({ runnerId, lastSeenAt: info?.lastSeenAt || '', stats: stats || null })
    },

    /** POST /credentials：把任务申报过的 secretRefs 换成短期值（M3/H4）。
     *  值只出现在这个响应里：不入库、不进日志、不进任务体。 */
    async credentials(body, { token } = {}) {
      const runnerId = String(body?.runnerId || '').trim()
      const denied = authenticate(runnerId, token)
      if (denied) return denied
      const taskId = String(body?.taskId || '').trim()
      const names = Array.isArray(body?.names) ? body.names.map((item) => String(item || '').trim()).filter(Boolean) : []
      if (!taskId) return errorOf(400, 'BAD_REQUEST', '缺少 taskId')
      if (names.length === 0) return errorOf(400, 'BAD_REQUEST', 'names 不能为空')
      const task = broker.task(taskId)
      if (!task) return errorOf(404, 'TASK_UNKNOWN', `任务 ${taskId} 不存在或已结束`)
      const described = taskDescription(task)
      // 只认这个任务自己申报过的名字，否则 runner 拿一个任务就能把整个项目的 secret 拉一遍。
      const allowed = new Set([...described.secretRefs, ...described.secretEnv.map((item) => item.ref)])
      const undeclared = names.filter((name) => !allowed.has(name))
      if (undeclared.length > 0) {
        return errorOf(403, 'SECRET_NOT_DECLARED', `任务 ${taskId} 未申报凭据 ${undeclared.join(',')}`)
      }
      const map = secretMap(described.projectId)
      const values = {}
      const missing = []
      for (const name of names) {
        if (typeof map[name] === 'string') values[name] = map[name]
        else missing.push(name)
      }
      // TTL 跟租约走，封顶 15 分钟、下限 1 分钟：够一次步骤用，也不至于被长期复用。
      const ttlSec = Math.max(60, Math.min(Number(described.leaseSec) || 300, 900))
      const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString()
      try {
        audit.record({
          action: 'secret.reveal',
          actorId: '',
          authMethod: 'runner-token-v2',
          resourceType: 'runner',
          resourceId: runnerId,
          projectId: described.projectId,
          result: 'allow',
          reason: `task:${taskId} names:${names.join(',')}`,
        })
      } catch { /* 审计失败不阻断取凭据 */ }
      log('runner-v2-credentials', { runnerId, taskId, names: names.length, missing: missing.length })
      return ok({ values, missing, expiresAt, ttlSec })
    },

    /** POST /claim：长轮询领任务。poll 兼心跳（与 v1 的 /runner-poll 同一条不变量）。 */
    async claim(body, { token } = {}) {
      const runnerId = String(body?.runnerId || '').trim()
      const denied = authenticate(runnerId, token)
      if (denied) return denied
      try { runners.heartbeat(runnerId) } catch { /* 刚被吊销，下面再判一次 */ }
      const verdict = runners.isRunnable(runnerId)
      if (!verdict.ok) {
        return errorOf(403, verdict.code, verdict.message)
      }
      const waitMs = Math.min(Math.max(Number(body?.waitMs) || 0, 0), MAX_WAIT_MS)
      const deadline = Date.now() + waitMs
      for (;;) {
        const task = broker.taskForRunner(runnerId)
        if (task) return ok({ task: taskDescription(task) })
        // 等到截止就回空任务——runner 会立刻再发一次 claim，等于长轮询续期。
        if (waitMs <= 0 || Date.now() >= deadline) return ok({ task: null })
        await sleep(Math.min(100, Math.max(1, deadline - Date.now())))
      }
    },

    /** POST /logs：批量日志，(taskId, seq) 去重。未知任务回执 TASK_UNKNOWN，但仍是 200。 */
    async logs(body, { token } = {}) {
      const runnerId = String(body?.runnerId || '').trim()
      const denied = authenticate(runnerId, token)
      if (denied) return denied
      const taskId = String(body?.taskId || '')
      const entries = Array.isArray(body?.lines) ? body.lines : []
      const receipt = broker.reportLogBatch(taskId, entries)
      if (receipt.unknown) return ok({ accepted: 0, dropped: entries.length, code: 'TASK_UNKNOWN' })
      return ok({ accepted: receipt.accepted, dropped: receipt.dropped })
    },

    /** POST /complete：终态回报，幂等；未知任务也回 200（防重试风暴）。 */
    async complete(body, { token } = {}) {
      const runnerId = String(body?.runnerId || '').trim()
      const denied = authenticate(runnerId, token)
      if (denied) return denied
      const taskId = String(body?.taskId || '')
      const status = String(body?.status || '')
      if (!['succeeded', 'failed', 'canceled'].includes(status)) {
        return errorOf(400, 'BAD_REQUEST', `status 只能是 succeeded/failed/canceled（收到 "${status}"）`)
      }
      const task = broker.task(taskId)
      if (!task) return ok({ code: 'TASK_UNKNOWN' })
      // M4：制品回流的验收点。「构建退出码 0」不等于「产物回来了」——少了非 optional 的
      // 制品，这次运行对下游（deploy/promote）来说是无米之炊，所以这里把状态改成失败，
      // 并且保留 runner 报告的 exitCode 与原始 artifacts 清单，便于对照是哪一步丢了。
      const uploaded = taskArtifacts.get(taskId) || []
      taskArtifacts.delete(taskId)
      const declared = taskDescription(task).artifacts || []
      const got = new Set(uploaded.map((item) => item.name))
      const missing = declared.filter((item) => !item.optional && !got.has(item.name)).map((item) => item.name)
      const succeeded = status === 'succeeded' && missing.length === 0
      const errorText = missing.length > 0
        ? `ARTIFACT_MISSING: 声明的制品没有全部回流（缺 ${missing.join('、')}）`
        : String(body?.error || '')
      // v2 的 succeeded 对回 v1 broker 的 success——下游判定全部认 'success'。
      broker.resolve(taskId, {
        status: succeeded ? 'success' : status === 'succeeded' ? 'failed' : status,
        exitCode: Number.isInteger(body?.exitCode) ? body.exitCode : -1,
        error: errorText,
        code: missing.length > 0 ? 'ARTIFACT_MISSING' : '',
        artifacts: Array.isArray(body?.artifacts) ? body.artifacts : uploaded,
      })
      if (missing.length > 0) {
        try {
          audit.record({
            action: 'artifact.missing',
            actorId: '',
            authMethod: 'runner-token-v2',
            resourceType: 'runner',
            resourceId: runnerId,
            projectId: taskDescription(task).projectId,
            result: 'deny',
            reason: `task:${taskId} missing:${missing.join(',')}`,
          })
        } catch { /* 审计失败不改变判定 */ }
      }
      return ok({ missing, artifacts: uploaded.map((item) => item.name) })
    },

    /** POST /cache/lookup：命中就回指针，未命中回 hit:false（未命中不是错误）。 */
    async cacheLookup(body, { token } = {}) {
      const runnerId = String(body?.runnerId || '').trim()
      const denied = authenticate(runnerId, token)
      if (denied) return denied
      if (!artifacts) return errorOf(503, 'CACHE_UNAVAILABLE', '服务端没有配置制品仓库，缓存不可用')
      const { taskId, key, error } = taskAndKey(body)
      if (error) return error
      const task = broker.task(taskId)
      if (!task) return errorOf(404, 'TASK_UNKNOWN', `任务 ${taskId} 不存在或已结束`)
      const described = taskDescription(task)
      const gate = declaredCache(described, key)
      if (gate.error) return gate.error
      const restoreKeys = Array.isArray(body?.restoreKeys) ? body.restoreKeys.map((item) => String(item || '').trim()).filter(Boolean) : []
      const allowedPrefixes = new Set(gate.decl.restoreKeys || [])
      const undeclared = restoreKeys.filter((item) => !allowedPrefixes.has(item))
      if (undeclared.length > 0) {
        return errorOf(403, 'CACHE_NOT_DECLARED', `缓存 key "${key}" 未申报 restoreKeys ${undeclared.join(',')}`)
      }
      const record = lookupCacheRef(described.projectId, key, restoreKeys)
      if (!record) {
        log('runner-v2-cache-miss', { runnerId, taskId, key })
        return ok({ hit: false, key, digest: '', bytes: 0, paths: [] })
      }
      log('runner-v2-cache-hit', { runnerId, taskId, key, hit: record.key })
      return ok({
        hit: true,
        key: record.key || key,
        digest: record.digest,
        bytes: Number(record.bytes) || 0,
        paths: Array.isArray(record.paths) ? record.paths : gate.decl.paths,
      })
    },

    /** GET /cache/blob：按 digest 把字节原样流回去（digest 必须是本项目的缓存指针）。 */
    async cacheBlobGet(_body, { token, query } = {}) {
      const runnerId = String(query?.runnerId || '').trim()
      const denied = authenticate(runnerId, token)
      if (denied) return denied
      if (!artifacts) return errorOf(503, 'CACHE_UNAVAILABLE', '服务端没有配置制品仓库，缓存不可用')
      const taskId = String(query?.taskId || '').trim()
      const digest = String(query?.digest || '').trim()
      if (!taskId || !digest) return errorOf(400, 'BAD_REQUEST', '缺少 taskId 或 digest')
      const task = broker.task(taskId)
      if (!task) return errorOf(404, 'TASK_UNKNOWN', `任务 ${taskId} 不存在或已结束`)
      const described = taskDescription(task)
      const record = cacheRecordByDigest(described.projectId, digest)
      if (!record) return errorOf(403, 'CACHE_NOT_DECLARED', `${digest} 不是项目 ${described.projectId} 的缓存`)
      const blob = artifacts.open(record.digest)
      try {
        audit.record({
          action: 'cache.restore',
          actorId: '',
          authMethod: 'runner-token-v2',
          resourceType: 'runner',
          resourceId: runnerId,
          projectId: described.projectId,
          result: 'allow',
          reason: `task:${taskId} key:${record.key} bytes:${blob.bytes}`,
        })
      } catch { /* 审计失败不阻断下载 */ }
      log('runner-v2-cache-restore', { runnerId, taskId, key: record.key, bytes: blob.bytes })
      return {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(blob.bytes),
          'cache-control': 'no-store',
          'x-cicd-cache-key': String(record.key || ''),
          'x-cicd-cache-digest': blob.digest,
        },
        stream: blob.stream(),
      }
    },

    /** PUT /cache/blob：收字节进 CAS，再把 key 的指针挪到新 digest 上。 */
    async cacheBlobPut(_body, { token, query, rawPath } = {}) {
      const runnerId = String(query?.runnerId || '').trim()
      const denied = authenticate(runnerId, token)
      if (denied) return denied
      if (!artifacts) return errorOf(503, 'CACHE_UNAVAILABLE', '服务端没有配置制品仓库，缓存不可用')
      const { taskId, key, error } = taskAndKey(query)
      if (error) return error
      const task = broker.task(taskId)
      if (!task) return errorOf(404, 'TASK_UNKNOWN', `任务 ${taskId} 不存在或已结束`)
      const described = taskDescription(task)
      const gate = declaredCache(described, key, { write: true })
      if (gate.error) return gate.error
      if (!rawPath) return errorOf(400, 'BAD_REQUEST', '请求体为空')
      const bytes = statSync(rawPath).size
      if (bytes === 0) return errorOf(400, 'BAD_REQUEST', '缓存内容为空')
      if (bytes > MAX_CACHE_BYTES) {
        return errorOf(413, 'CACHE_TOO_LARGE', `缓存 ${bytes} 字节，超过上限 ${MAX_CACHE_BYTES}`)
      }
      const stored = await artifacts.putFile(rawPath, { expectDigest: String(query?.digest || '') })
      artifacts.putRef(cacheOwner(described.projectId), cacheRefName(described.projectId, key), stored.digest, {
        projectId: described.projectId,
        key,
        paths: gate.decl.paths,
        bytes: stored.bytes,
        taskId,
      })
      try {
        audit.record({
          action: 'cache.save',
          actorId: '',
          authMethod: 'runner-token-v2',
          resourceType: 'runner',
          resourceId: runnerId,
          projectId: described.projectId,
          result: 'allow',
          reason: `task:${taskId} key:${key} bytes:${stored.bytes} digest:${stored.digest}`,
        })
      } catch { /* 审计失败不阻断保存 */ }
      log('runner-v2-cache-save', { runnerId, taskId, key, bytes: stored.bytes, deduped: Boolean(stored.deduped) })
      return ok({ key, digest: stored.digest, bytes: stored.bytes, deduped: Boolean(stored.deduped) })
    },

    /**
     * PUT /artifacts/:taskId/:name：把 runner workspace 里的产物字节收回宿主 CAS。
     * 三件事一起做，缺一条闭环就断：
     * 1) putFile 收字节（内容寻址，同内容自动去重）；
     * 2) putRef 把 `name` 指针挪到新 digest 上——部署/晋级按 digest 认这包字节；
     * 3) 落一行 artifacts（run_id + path=name），让 run 详情与 deploy 的取件回退看得见它。
     */
    async artifactPut(_body, { token, runnerId: runnerIdRaw = '', taskId, artifactName, rawPath, digest = '' } = {}) {
      const runnerId = String(runnerIdRaw || '').trim()
      const denied = authenticate(runnerId, token)
      if (denied) return denied
      if (!artifacts) return errorOf(503, 'CACHE_UNAVAILABLE', '服务端没有配置制品仓库，制品无法回流')
      const id = String(taskId || '').trim()
      const name = String(artifactName || '').trim()
      if (!id || !name) return errorOf(400, 'BAD_REQUEST', '缺少 taskId 或制品名')
      if (!ARTIFACT_NAME_RE.test(name)) return errorOf(400, 'BAD_ARTIFACT_NAME', `制品名不合法：${name}`)
      const task = broker.task(id)
      if (!task) return errorOf(404, 'TASK_UNKNOWN', `任务 ${id} 不存在或已结束`)
      const described = taskDescription(task)
      const gate = declaredArtifact(described, name)
      if (gate.error) return gate.error
      if (!rawPath) return errorOf(400, 'BAD_REQUEST', '请求体为空')
      const bytes = statSync(rawPath).size
      if (bytes === 0) return errorOf(400, 'BAD_REQUEST', `制品 ${name} 的内容为空`)
      if (bytes > MAX_ARTIFACT_BYTES) {
        return errorOf(413, 'ARTIFACT_TOO_LARGE', `制品 ${name} 有 ${bytes} 字节，超过上限 ${MAX_ARTIFACT_BYTES}`)
      }
      const stored = await artifacts.putFile(rawPath, { expectDigest: String(digest || '') })
      const ref = artifacts.putRef(described.projectId, name, stored.digest, {
        projectId: described.projectId,
        runId: described.runId,
        taskId: id,
        name,
        bytes: stored.bytes,
        source: 'runner',
      })
      try {
        store?.appendArtifact?.({
          run_id: described.runId,
          path: name,
          bytes: stored.bytes,
          sha256: String(stored.digest || '').replace(/^sha256:/, ''),
        })
      } catch { /* 台账写不进去不影响字节已经进了 CAS */ }
      noteTaskArtifact(id, { name, digest: stored.digest, bytes: stored.bytes })
      try {
        audit.record({
          action: 'artifact.upload',
          actorId: '',
          authMethod: 'runner-token-v2',
          resourceType: 'runner',
          resourceId: runnerId,
          projectId: described.projectId,
          result: 'allow',
          reason: `task:${id} name:${name} bytes:${stored.bytes} digest:${stored.digest}`,
        })
      } catch { /* 审计失败不阻断回收 */ }
      log('runner-v2-artifact-put', { runnerId, taskId: id, name, bytes: stored.bytes, digest: stored.digest, deduped: Boolean(stored.deduped) })
      return ok({ name, digest: stored.digest, bytes: stored.bytes, deduped: Boolean(stored.deduped), ref: ref?.digest || stored.digest })
    },
  }

  /**
   * 纯调度入口：path 是去掉 RUNNER_V2_PATH 后的子路径（'/register'）。
   * 返回 { status, body }，调用方负责序列化。
   */
  async function dispatch({ method = 'POST', path = '', token = '', body = null, query = null, rawPath = '' } = {}) {
    const name = String(path || '').replace(/^\/+/, '').replace(/\/+$/, '')
    const guard = async (run) => {
      try {
        return await run()
      } catch (error) {
        const code = error?.code || 'RUNNER_ERROR'
        const status = code === 'RUNNER_REVOKED' ? 403 : 500
        return errorOf(status, code, error?.message || String(error))
      }
    }
    // 缓存字节走裸流：GET 下载、PUT 上传。其余端点仍是 POST + JSON。
    if (name === 'cache/blob') {
      if (method === 'GET') return guard(() => endpoints.cacheBlobGet(null, { token, query }))
      if (method === 'PUT') return guard(() => endpoints.cacheBlobPut(null, { token, query, rawPath }))
      return errorOf(405, 'METHOD_NOT_ALLOWED', 'cache/blob 只接受 GET 与 PUT')
    }
    // M4：PUT /artifacts/:taskId/:name——taskId 与制品名在路径里，runnerId 与可选 digest 在 query 里。
    if (name === 'artifacts' || name.startsWith('artifacts/')) {
      if (method !== 'PUT') return errorOf(405, 'METHOD_NOT_ALLOWED', 'artifacts 只接受 PUT')
      const parts = name.split('/').slice(1).filter(Boolean)
      if (parts.length < 2) return errorOf(400, 'BAD_REQUEST', '路径应为 /artifacts/:taskId/:name')
      const taskIdPart = decodeURIComponent(parts[0])
      const namePart = decodeURIComponent(parts.slice(1).join('/'))
      const runnerId = String(query?.runnerId || '').trim()
      return guard(() => endpoints.artifactPut(null, { token, runnerId, taskId: taskIdPart, artifactName: namePart, rawPath, digest: String(query?.digest || '') }))
    }
    if (method !== 'POST') return errorOf(405, 'METHOD_NOT_ALLOWED', '协议 v2 只接受 POST')
    // 路径里带斜杠的端点（cache/lookup）对应手写方法名，其余端点名与路径一致。
    const handler = endpoints[name] || endpoints[name === 'cache/lookup' ? 'cacheLookup' : '']
    if (!handler || typeof handler !== 'function') return errorOf(404, 'NOT_FOUND', `未知端点 ${RUNNER_V2_PATH}/${name}`)
    return guard(() => handler(body, { token }))
  }

  /**
   * HTTP 适配器：DSH webserver handler 路由直接挂它。只用 req/res 的最小表面，
   * 测试可以用假 req/res 走同一条代码路径。
   */
  function httpHandler(req, res) {
    let settled = false
    const finish = (status, payload) => {
      if (settled || res.writableEnded) return
      settled = true
      const text = JSON.stringify(payload)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(text)
    }
    /** 裸流出口（只有 GET /cache/blob 用）：headers 由端点给，字节直接 pipe 给响应。 */
    const finishStream = (outcome) => {
      if (settled || res.writableEnded) {
        try { outcome.stream?.destroy?.() } catch { /* 已结束，丢弃流 */ }
        return
      }
      settled = true
      res.writeHead(outcome.status, outcome.headers || {})
      const stream = outcome.stream
      stream.on('error', () => { try { res.destroy?.() } catch { /* 客户端已断开 */ } })
      stream.pipe(res)
    }
    // req.url 是不带主机名的路径（Node 原样给的就是这个），拼个假 origin 才能用 URL 解析。
    // 路径先解析：缓存 blob 是裸流，其余端点仍是 JSON，两者读 body 的方式不一样。
    let path = ''
    let query = null
    try {
      const parsed = new URL(typeof req.url === 'string' ? req.url : String(req.pathname || ''), 'http://runner-v2.local')
      // 前缀可能在路径中间（Host 已剥掉 /api/plugins/cicd 之类），按首次出现处切。
      const at = parsed.pathname.indexOf(RUNNER_V2_PATH)
      if (at < 0) return finish(404, { ok: false, code: 'NOT_FOUND', error: `缺少 ${RUNNER_V2_PATH} 前缀` })
      path = parsed.pathname.slice(at + RUNNER_V2_PATH.length)
      query = Object.fromEntries(parsed.searchParams.entries())
    } catch { return finish(400, { ok: false, code: 'BAD_REQUEST', error: '无法解析请求路径' }) }
    const auth = String(req.headers?.authorization || '')
    const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : ''
    const sub = String(path).replace(/^\/+/, '').replace(/\/+$/, '')
    const isBlob = sub === 'cache/blob'
    // M4：制品上传也是裸流，只是落盘目录与上限不同（制品要原样发到目标机，口径比缓存宽）。
    const isArtifactPut = req.method === 'PUT' && (sub === 'artifacts' || sub.startsWith('artifacts/'))
    let settledOnce = false
    const runDispatch = async (extra) => {
      if (settledOnce) return
      settledOnce = true
      try {
        const outcome = await dispatch({ method: req.method, path, token, query, ...extra })
        if (outcome && outcome.stream) finishStream(outcome)
        else finish(outcome.status, outcome.body)
      } catch (error) {
        finish(500, { ok: false, code: 'RUNNER_ERROR', error: error?.message || String(error) })
      }
    }
    // GET /cache/blob 没有请求体：直接结算（GET 的 'end' 可能在 handler 之前就触发过）。
    if (isBlob && req.method === 'GET') {
      void runDispatch({})
      return
    }
    // PUT /cache/blob：请求体是裸字节，落临时文件后再进 CAS（4MB 的 JSON 顶撑不住缓存包）。
    if ((isBlob || isArtifactPut) && req.method === 'PUT') {
      const maxBytes = isArtifactPut ? MAX_ARTIFACT_BYTES : MAX_CACHE_BYTES
      const tooLargeCode = isArtifactPut ? 'ARTIFACT_TOO_LARGE' : 'CACHE_TOO_LARGE'
      const tmpDir = join(tmpdir(), isArtifactPut ? 'dsh-cicd-artifacts' : 'dsh-cicd-cache')
      mkdirSync(tmpDir, { recursive: true })
      const rawPath = join(tmpDir, `${isArtifactPut ? ARTIFACT_TMP_PREFIX : CACHE_TMP_PREFIX}${randomBytes(8).toString('hex')}.tmp`)
      const out = createWriteStream(rawPath)
      let size = 0
      let aborted = false
      const cleanup = () => { try { rmSync(rawPath, { force: true }) } catch { /* 临时文件已不在 */ } }
      req.on('data', (chunk) => {
        if (aborted) return
        size += chunk.length
        if (size > maxBytes) {
          aborted = true
          out.destroy()
          cleanup()
          finish(413, { ok: false, code: tooLargeCode, error: `上传内容超过 ${maxBytes} 字节` })
          req.destroy?.()
          return
        }
        out.write(chunk)
      })
      req.on('error', () => { aborted = true; out.destroy(); cleanup(); finish(400, { ok: false, code: 'BAD_REQUEST', error: '读取请求体失败' }) })
      req.on('end', () => {
        if (aborted) return
        out.end(() => { void runDispatch({ rawPath }).finally(cleanup) })
      })
      // 兜底：Host 若不推流，30s 后按已落盘的内容结算（与 JSON 分支同一条不变量）。
      setTimeout(() => { if (settled || settledOnce || aborted) return; out.end(() => { void runDispatch({ rawPath }).finally(cleanup) }) }, 30000)
      return
    }
    let size = 0
    const chunks = []
    /** 请求体读完（或 Host 已经替我们读完）之后的唯一出口。 */
    const settle = async () => {
      if (settledOnce) return
      let body = null
      if (chunks.length > 0) {
        const raw = Buffer.concat(chunks).toString('utf8')
        try { body = raw === '' ? null : JSON.parse(raw) } catch {
          settledOnce = true
          return finish(400, { ok: false, code: 'BAD_REQUEST', error: '请求体不是合法 JSON' })
        }
      }
      await runDispatch({ body })
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        finish(413, { ok: false, code: 'PAYLOAD_TOO_LARGE', error: `请求体超过 ${MAX_BODY_BYTES} 字节` })
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', () => finish(400, { ok: false, code: 'BAD_REQUEST', error: '读取请求体失败' }))
    req.on('end', () => { void settle() })
    // 防止 Host 在 handler 之前就把请求流消费掉（那样 'end' 不会再触发），
    // 也防某些适配器只调用 handler 不推流：下一轮事件循环若还没结算，就按已读到的字节结算。
    setTimeout(() => { void settle() }, 30000)
  }

  return { dispatch, httpHandler, taskDescription }
}
