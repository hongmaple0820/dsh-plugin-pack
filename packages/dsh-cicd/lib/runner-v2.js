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
import { joinTokenMatches } from './executors.js'

export const RUNNER_V2_PATH = '/runner/v2'
/** 长轮询上限：DSH 反向代理常见 60s 超时，留一倍余量。 */
const MAX_WAIT_MS = 25000
/** 单个请求体上限：日志批次可能很大，但不能没有顶。 */
const MAX_BODY_BYTES = 4 * 1024 * 1024

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

/**
 * @param {object} deps
 * @param {ReturnType<import('./runners.js').createRunnerRegistry>} deps.runners 落库注册表
 * @param {ReturnType<import('./executors.js').createTaskBroker>} deps.broker 任务队列
 * @param {object} deps.options 插件配置（runners.joinToken 在这里）
 * @param {object} deps.audit 审计
 * @param {object} deps.store operations 台账
 */
export function createRunnerV2Service({ runners, broker, options, audit, store, log = () => {} } = {}) {
  if (!runners || !broker) throw new Error('createRunnerV2Service 需要 runners 与 broker')

  const errorOf = (status, code, message) => ({ status, body: { ok: false, code, error: message } })
  const ok = (body) => ({ status: 200, body: { ok: true, ...body } })

  /** Bearer token 认证：runnerId 必须已注册、token 摘要必须吻合、未吊销。 */
  function authenticate(runnerId, token) {
    if (!token) return errorOf(401, 'RUNNER_TOKEN_MISSING', '缺少 Authorization: Bearer <runnerToken>（register 时只发一次）')
    const row = runners.describe(runnerId)
    if (!row) return errorOf(401, 'RUNNER_UNREGISTERED', `runner ${runnerId} 未注册，请先 register`)
    if (!tokenEquals(token, runners.tokenSha(runnerId))) {
      return errorOf(401, 'RUNNER_TOKEN_INVALID', 'runner token 无效（可能已被轮换，请重新 register）')
    }
    if (row.revoked) return errorOf(403, 'RUNNER_REVOKED', `runner ${runnerId} 已被吊销`)
    return null
  }

  /** 把 executor 入队的 spec 翻译成 v2 任务描述（M1：单步 run，无 source/secretRefs/caches）。 */
  function taskDescription(task) {
    const spec = task.spec || {}
    const timeoutSec = Number(spec.timeoutSec) > 0 ? Number(spec.timeoutSec) : 60
    return {
      taskId: String(spec.taskId || ''),
      runId: String(spec.runId || ''),
      stepIndex: Number.isInteger(spec.stepIndex) ? spec.stepIndex : 0,
      stageId: String(spec.stageId || ''),
      // 租约给到「步骤超时 + 60s」：命令慢不等于租约丢，宽限只用于网络抖动。
      leaseSec: timeoutSec + 60,
      // workspace.root 相对 runner 的 --workdir；clean=true 每次重建，等价一次性构建目录。
      workspace: { root: `tasks/${spec.runId || spec.taskId}`, clean: true, ttlSec: 3600 },
      // M1：env 由宿主插值后随任务体下发（与 v1 相同）。M3 凭据交换落地后 secretRefs
      // 接管密钥，env 只留非敏感变量——在那之前 env 本来就只在内网/VPN 形态里走。
      env: spec.env && typeof spec.env === 'object' ? { ...spec.env } : {},
      steps: [{ uses: 'run', command: String(spec.command || ''), cwd: String(spec.cwd || '.'), timeoutSec }],
      logStream: { batchMs: 250 },
      artifacts: [],
    }
  }

  const endpoints = {
    /** POST /register：join token 换 runner token（重复注册 = 轮换）。 */
    async register(body) {
      const runnerId = String(body?.runnerId || '').trim()
      if (!runnerId) return errorOf(400, 'BAD_REQUEST', '缺少 runnerId')
      const labels = Array.isArray(body?.labels) ? body.labels.map((item) => String(item)) : String(body?.labels || '').split(',').map((item) => item.trim()).filter(Boolean)
      const capacity = Number.isInteger(body?.capacity) && body.capacity > 0 ? body.capacity : 1
      const version = String(body?.version || '')
      const secret = options.runners?.joinToken
      if (!secret) {
        return errorOf(401, 'RUNNER_JOIN_TOKEN_UNSET', '服务端未配置 runners.joinToken；先在 cordis.patch.yml 里配置再加入')
      }
      if (!joinTokenMatches(String(body?.joinToken || ''), secret)) {
        return errorOf(401, 'RUNNER_JOIN_TOKEN_INVALID', 'join token 校验失败')
      }
      // 落库（吊销过的在这里抛 RUNNER_REVOKED），再登记 broker 队列——顺序与 v1 相同。
      const info = runners.register(runnerId, { labels, version, capacity, protocol: 2 })
      broker.register(runnerId, { labels, version, capacity })
      const runnerToken = 'rt_' + randomBytes(24).toString('hex')
      runners.setToken(runnerId, sha256Hex(runnerToken))
      try { store.appendOperation({ action: 'runner-register-v2', project: runnerId, status: 'ok', detail: JSON.stringify({ labels, version }) }) } catch { /* best effort */ }
      try { audit.record({ action: 'runner.register', actorId: '', authMethod: 'runner-token-v2', resourceType: 'runner', resourceId: runnerId, result: 'allow', reason: `labels:${labels.join(',')}` }) } catch { /* 审计失败不阻断注册 */ }
      log('runner-v2-register', { runnerId })
      return ok({
        runnerId,
        runnerToken,
        heartbeatSec: info.heartbeatSec,
        offlineAfterSec: info.offlineAfterSec,
        serverTime: new Date().toISOString(),
      })
    },

    /** POST /heartbeat：续 last_seen_at。 */
    async heartbeat(body, { token } = {}) {
      const runnerId = String(body?.runnerId || '').trim()
      const denied = authenticate(runnerId, token)
      if (denied) return denied
      const info = runners.heartbeat(runnerId) // 吊销 → RUNNER_REVOKED
      return ok({ runnerId, lastSeenAt: info?.lastSeenAt || '' })
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
      // v2 的 succeeded 对回 v1 broker 的 success——下游判定全部认 'success'。
      broker.resolve(taskId, {
        status: status === 'succeeded' ? 'success' : status,
        exitCode: Number.isInteger(body?.exitCode) ? body.exitCode : -1,
        error: String(body?.error || ''),
      })
      return ok({})
    },
  }

  /**
   * 纯调度入口：path 是去掉 RUNNER_V2_PATH 后的子路径（'/register'）。
   * 返回 { status, body }，调用方负责序列化。
   */
  async function dispatch({ method = 'POST', path = '', token = '', body = null } = {}) {
    if (method !== 'POST') return errorOf(405, 'METHOD_NOT_ALLOWED', '协议 v2 只接受 POST')
    const name = String(path || '').replace(/^\/+/, '').replace(/\/+$/, '')
    const handler = endpoints[name]
    if (!handler || typeof handler !== 'function') return errorOf(404, 'NOT_FOUND', `未知端点 ${RUNNER_V2_PATH}/${name}`)
    try {
      return await handler(body, { token })
    } catch (error) {
      const code = error?.code || 'RUNNER_ERROR'
      const status = code === 'RUNNER_REVOKED' ? 403 : 500
      return errorOf(status, code, error?.message || String(error))
    }
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
    let size = 0
    const chunks = []
    let settledOnce = false
    /** 请求体读完（或 Host 已经替我们读完）之后的唯一出口。 */
    const settle = async () => {
      if (settledOnce) return
      settledOnce = true
      let body = null
      if (chunks.length > 0) {
        const raw = Buffer.concat(chunks).toString('utf8')
        try { body = raw === '' ? null : JSON.parse(raw) } catch { return finish(400, { ok: false, code: 'BAD_REQUEST', error: '请求体不是合法 JSON' }) }
      }
      // req.url 是不带主机名的路径（Node 原样给的就是这个），拼个假 origin 才能用 URL 解析出 pathname。
      const rawPath = typeof req.url === 'string' ? req.url : String(req.pathname || '')
      let path = ''
      try {
        const parsed = new URL(rawPath || '/', 'http://runner-v2.local')
        // 前缀可能在路径中间（Host 已剥掉 /api/plugins/cicd 之类），按首次出现处切。
        const at = parsed.pathname.indexOf(RUNNER_V2_PATH)
        if (at < 0) return finish(404, { ok: false, code: 'NOT_FOUND', error: `缺少 ${RUNNER_V2_PATH} 前缀` })
        path = parsed.pathname.slice(at + RUNNER_V2_PATH.length)
      } catch { return finish(400, { ok: false, code: 'BAD_REQUEST', error: '无法解析请求路径' }) }
      const auth = String(req.headers?.authorization || '')
      const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : ''
      try {
        const outcome = await dispatch({ method: req.method, path, token, body })
        finish(outcome.status, outcome.body)
      } catch (error) {
        finish(500, { ok: false, code: 'RUNNER_ERROR', error: error?.message || String(error) })
      }
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
