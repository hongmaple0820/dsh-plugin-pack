/**
 * The Kubernetes actuator: set the image to a digest, let the Deployment roll, undo with a rollback.
 *
 * Same phases as the native and container actuators (stage / activate / health / stop / revert /
 * cleanup / writeManifest), so lib/deploy-engine.js does not learn a third vocabulary. What differs
 * is that no process is started here at all: the controller owns pod lifecycle, batch sizing and
 * parking. "Deploying" means writing a new pod template into a Deployment and waiting for it.
 *
 * ## Why this is not the symlink semantics with a different command
 *
 * native and container both answer "which bytes serve traffic" by changing a local pointer we own.
 * Kubernetes answers it through a controller: maxSurge/maxUnavailable decide how many pods are down
 * while the switch happens, and the old ReplicaSet keeps running until the new one is ready. Faking
 * a blue-green by stopping pods ourselves would delete exactly the property people adopt Kubernetes
 * for. So: stage does not touch the workload, activate patches it once, and rollback is delegated to
 * `rollout undo` - which is the only revert that also restores the controller's own bookkeeping.
 *
 * ## Everything is keyed by digest
 *
 * Same rule as the container actuator: a tag is a mutable name, and `kubectl set image` with a tag
 * silently keeps it. The patch therefore always carries `<image>@sha256:...`; the digest comes from
 * the artifact, verified against the CAS before the deploy started. If a rollout produces no new
 * revision, that is reported as a failure rather than "done" - a patch that changed nothing while
 * looking successful is the worst possible outcome for a production deploy.
 *
 * ## The command vocabulary is closed too
 *
 * Every command this file can emit is listed in K8S_COMMANDS; test/smoke.mjs runs a fake kubectl
 * implementing exactly these shapes and fails loudly on anything new.
 */

import { shellQuote } from '../deploy.js'
import { renderTemplate } from './native.js'

/** Every shell command shape the k8s actuator may emit. */
export const K8S_COMMANDS = [
  'kubectl -n <ns> get deployment|rollout',
  'kubectl -n <ns> get pod -l -o json',
  'kubectl -n <ns> set image',
  'kubectl -n <ns> rollout status',
  'kubectl -n <ns> rollout undo',
  'mkdir -p',
  'printf >',
  'echo >>',
  'readlink',
  'ln -sfn',
  'ls -1dt | tail | xargs rm -rf',]

export const K8S_ERRORS = {
  IMAGE: 'K8S_IMAGE_INVALID',
  CLUSTER: 'K8S_CLUSTER_UNREACHABLE',
  WORKLOAD: 'K8S_WORKLOAD_NOT_FOUND',
  PATCH: 'K8S_PATCH_FAILED',
  ROLLOUT: 'K8S_ROLLOUT_FAILED',
  NO_CHANGE: 'K8S_ROLLOUT_NO_CHANGE',
  ROLLBACK: 'K8S_ROLLBACK_FAILED',
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/

function logLine(onLog, line) {
  if (typeof onLog === 'function') {
    try { onLog(line) } catch { /* log observers must not break a deploy */ }
  }
}

function trimEnd(value) {
  return String(value || '').replace(/\/+$/, '')
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

/** 裸 hex / 大写都归一成 sha256:<64 hex>；tag、空串、带 @ 的一律拒绝。 */
export function normalizeK8sDigest(value) {
  const text = String(value || '').trim().toLowerCase()
  if (!text) return ''
  const bare = text.startsWith('sha256:') ? text : 'sha256:' + text
  if (!DIGEST_RE.test(bare)) throw k8sError(K8S_ERRORS.IMAGE, 'digest “' + value + '” 不合法（只接受 sha256:<64 hex>）')
  return bare
}

export function k8sError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra)
}

/**
 * image → 仓库名（去 tag）。与容器 Actuator 不同，K8s 允许 image 带 tag（很多人从 Deployment 抄过来），
 * 但 tag 只当仓库名用，引用里永远是 digest —— 否则 set image 会静默保留一个可变的 tag。
 */
export function k8sImageRepository(image) {
  const raw = String(image || '').trim()
  if (!raw) throw k8sError(K8S_ERRORS.IMAGE, 'mode 是 k8s，必须给 image（如 registry.example.com/demo/web）')
  if (raw.includes('@')) throw k8sError(K8S_ERRORS.IMAGE, 'image “' + raw + '” 不能带 @digest；引用由产物 digest 拼出来')
  // 去掉最后的 tag：registry:5000/a/b:1.2.3 → registry:5000/a/b
  return raw.replace(/:[^/:]+$/, '')
}

export function k8sImageReference({ image, digest }) {
  const repository = k8sImageRepository(image)
  const normalised = normalizeK8sDigest(digest)
  if (!normalised) throw k8sError(K8S_ERRORS.IMAGE, 'K8s 部署必须带产物 digest')
  return { repository, digest: normalised, reference: repository + '@' + normalised }
}

/** `kubectl get deployment -o json` 的最小解析：拿 generation / observedGeneration / 副本数。 */
export function parseDeployment(stdout) {
  const text = String(stdout || '').trim()
  if (!text) return null
  let parsed
  try { parsed = JSON.parse(text) } catch { return null }
  const metadata = parsed.metadata || {}
  const status = parsed.status || {}
  const container = ((((parsed.spec || {}).template || {}).spec || {}).containers || [])[0] || {}
  return {
    name: String(metadata.name || ''),
    generation: Number(metadata.generation || 0),
    observed: Number(status.observedGeneration || 0),
    replicas: Number(status.replicas || 0),
    ready: Number(status.readyReplicas || 0),
    updated: Number(status.updatedReplicas || 0),
    available: Number((status.conditions || []).find((item) => item.type === 'Available')?.status === 'True'),
    image: String(container.image || ''),
  }
}

/** `kubectl get pods -o json` → 还活着的 pod 清单（名字 + phase + image）。 */
export function parsePods(stdout) {
  const text = String(stdout || '').trim()
  if (!text) return []
  let parsed
  try { parsed = JSON.parse(text) } catch { return [] }
  return ((parsed.items) || []).map((item) => ({
    name: String((item.metadata || {}).name || ''),
    phase: String((item.status || {}).phase || ''),
    image: String(((((item.spec || {}).containers) || [])[0] || {}).image || ''),
  }))
}

/** `kubectl rollout status` 的退出码与文本：0 = 完成，其他都算没完成。 */
export function rolloutSucceeded(result) {
  const code = result && result.exitCode
  if (code === undefined || code === null) return true
  return Number(code) === 0
}


/**
 * 创建 k8s Actuator。接口与 native/container 同形，deploy-engine 不需要区分第三种模式。
 *
 * target.k8s 归一后由 lib/pipe.js 保证：kind(Deployment/Rollout)、namespace、container、
 * replicas、progressDeadlineSec、image 都已就位。
 */
export function createK8sActuator({ host, target, hostName, onLog, now = Date.now }) {
  const app = String((target && target.name) || 'app')
  const targetPath = trimEnd((target && target.path) || '')
  const k8s = (target && target.k8s) || {}
  const namespace = String(k8s.namespace || 'default')
  const workload = String(k8s.workload || app)
  const kind = String(k8s.kind || 'Deployment')
  const containerName = String(k8s.container || app)
  const image = String((target && target.image) || '')
  const replicas = Math.max(1, Number(k8s.replicas || 1))
  const progressDeadlineSec = Math.max(1, Number(k8s.progressDeadlineSec || 300))
  const rolloutTimeoutSec = Math.max(1, Number(k8s.rolloutTimeoutSec || progressDeadlineSec + 60))
  const historyDir = targetPath ? targetPath + '/releases' : ''
  const currentLink = targetPath ? targetPath + '/current' : ''

  // kubectl 的 -n 出现在每个子命令里；集中拼一次，避免某个命令忘了带 namespace 而打到 default 上。
  function kubectl(rest) {
    return 'kubectl -n ' + shellQuote(namespace) + ' ' + rest
  }

  async function run(command, options = {}) {
    logLine(onLog, '[' + hostName + '] ' + command)
    return host.exec(command, options)
  }

  function failure(code, message, extra = {}) {
    return k8sError(code, '[' + hostName + '] ' + message, extra)
  }

  function detailOf(result) {
    return String((result && (result.stderr || result.stdout)) || '').trim().slice(0, 300)
  }

  function okOf(result) {
    const code = result && result.exitCode
    return code === undefined || code === null || Number(code) === 0
  }

  // 当前 workload 现场。读不到就说明「集群连不上或对象不存在」，两者都要在改任何东西之前分清楚。
  async function readWorkload() {
    const result = await run(kubectl('get ' + kind.toLowerCase() + ' ' + shellQuote(workload) + ' -o json'))
    if (!okOf(result)) {
      const text = detailOf(result)
      // kubectl 对「对象不存在」与「集群不可达」的文案不同，且这个区别决定了用户该去改 pipe 还是改 kubeconfig。
      if (/not found|NotFound|No resources found/i.test(text || '')) {
        throw failure(K8S_ERRORS.WORKLOAD, '集群里没有 ' + kind + ' ' + namespace + '/' + workload + '（先建它，或改 k8s.workload）', { detail: text })
      }
      throw failure(K8S_ERRORS.CLUSTER, '读不到 ' + kind + ' ' + namespace + '/' + workload + '：' + (text || '(无输出)'), { detail: text })
    }
    const parsed = parseDeployment(result && result.stdout)
    if (!parsed) throw failure(K8S_ERRORS.WORKLOAD, kind + ' ' + namespace + '/' + workload + ' 返回了无法解析的 JSON')
    return parsed
  }

  // 还活着的 pod：名字、phase、镜像。回滚现场与 l1 都读它，而不是读我们自己的账本。
  async function runningPods() {
    const selector = 'app=' + workload
    const result = await run(kubectl('get pod -l ' + shellQuote(selector) + ' -o json'))
    return parsePods(result && result.stdout)
  }

  /**
   * Phase 1 - stage. 只确认集群认识这个 workload，并记下当前镜像。
   *
   * 不拉镜像：K8s 的 kubelet 在 pod 调度时才拉，本机拉不拉与节点能不能拉是两件事。
   * 也不 patch：stage 失败必须是零影响，而 patch 一旦发出控制器就开始动手了。
   */
  async function stage({ releaseId, artifactPath, artifactDigest } = {}) {
    const resolved = k8sImageReference({ image, digest: artifactDigest || (target && target.artifactDigest) || '' })
    logLine(onLog, '[' + hostName + '] stage: ' + kind + ' ' + namespace + '/' + workload + ' -> ' + resolved.reference)
    const current = await readWorkload()
    if (historyDir) await run('mkdir -p ' + shellQuote(historyDir + '/' + releaseId))
    const handle = {
      host: hostName,
      mode: 'k8s',
      releaseId,
      dir: historyDir ? historyDir + '/' + releaseId : '',
      image,
      imageDigest: resolved.digest,
      imageReference: resolved.reference,
      namespace,
      workload,
      kind,
      containerName,
      // 与其它两种模式同形的空壳：k8s 没有「我们自己起的实例」，但补偿路径不该为此分叉。
      slots: { releaseAll: async () => {} },
      instances: Array.from({ length: replicas }, (_unused, index) => ({
        index,
        slot: index,
        port: 0,
        instanceId: hostName + '/' + index,
        podName: '',
        image: resolved.reference,
        env: {},
        envRendered: {},
        logPath: '',
        pid: 0,
        startedAt: '',
        stoppedAt: '',
        releaseId,
      })),
      pods: [],
      previous: '',
      previousImage: current.image,
      revision: '',
      stagedAt: new Date(now()).toISOString(),
      activatedAt: '',
      pids: [],
      artifactName: releaseId,
    }
    return handle
  }
  // rollout status 是唯一知道「控制器干完了没有」的命令；超时由这里的 timeoutSec 兜住。
  async function waitRollout(handle) {
    const timeout = Math.max(1, Math.trunc(Number(rolloutTimeoutSec) || 360)) + 's'
    const result = await run(
      kubectl('rollout status ' + kind.toLowerCase() + ' ' + shellQuote(workload) + ' --timeout=' + shellQuote(timeout)),
      { timeoutSec: Math.trunc(Number(rolloutTimeoutSec) || 360) + 30 },
    )
    return { ok: rolloutSucceeded(result), detail: detailOf(result) || String((result && result.stdout) || '').trim().slice(0, 300) }
  }

  /**
   * Phase 2 - activate. 一次 patch 把镜像换成 image@sha256:…，然后等控制器把 rollout 走完。
   *
   * 为什么用 `set image` 而不是 `kubectl apply`：apply 需要一份完整的 manifest，而那份文件在
   * 我们手里是用户上一次 apply 的副本，早就漂移了。set image 只改一个字段，其余交给集群现状。
   */
  async function activate(handle, options = {}) {
    const switchCurrent = options.switchCurrent !== false
    if (switchCurrent) {
      // 上一版记在 current 软链上 —— 与 native 同一套目录约定，回滚要读的是「当时部署了什么」。
      const read = await run('readlink ' + shellQuote(currentLink) + ' || true')
      const text = String((read && read.stdout) || '').trim()
      const match = text ? /(?:^|\/)releases\/([^\/\s]+)\/?$/.exec(text) : null
      handle.previous = match ? match[1] : (text ? (text.split('/').filter(Boolean).pop() || '') : '')
    }
    const before = await readWorkload()
    handle.previousImage = String(handle.previousImage || before.image || '')

    const patched = await run(
      kubectl('set image ' + kind.toLowerCase() + '/' + shellQuote(workload) + ' ' + shellQuote(containerName + '=' + handle.imageReference)),
      { timeoutSec: 120 },
    )
    if (!okOf(patched)) {
      throw failure(K8S_ERRORS.PATCH, 'patch ' + kind + ' ' + namespace + '/' + workload + ' 失败：' + (detailOf(patched) || '(无输出)'))
    }
    const afterPatch = await readWorkload()
    if (afterPatch.image && afterPatch.image !== handle.imageReference) {
      // 控制器的 spec 里没有换上新引用：要么改错了容器名，要么有人同时改了对象。
      throw failure(K8S_ERRORS.PATCH, 'patch 之后 ' + containerName + ' 的镜像还是 ' + (afterPatch.image || '(空)') + '，期望 ' + handle.imageReference)
    }
    if (before.generation && afterPatch.generation && afterPatch.generation === before.generation && before.image === handle.imageReference) {
      // generation 没动 = 控制器认为 spec 没变。这份 digest 已经在跑了，部署没有产生新版本。
      throw failure(K8S_ERRORS.NO_CHANGE, kind + ' ' + namespace + '/' + workload + ' 的 generation 没有变化（' + handle.imageReference + ' 已经在跑）；这不是一次发布')
    }
    handle.revision = String(afterPatch.generation || '')

    const rolled = await waitRollout(handle)
    if (!rolled.ok) {
      throw failure(K8S_ERRORS.ROLLOUT, 'rollout 未完成（' + kind + ' ' + namespace + '/' + workload + '）：' + (rolled.detail || '(无输出)'))
    }
    handle.pods = await runningPods()
    handle.instances = handle.instances.map((instance, index) => Object.assign({}, instance, {
      podName: handle.pods[index] ? handle.pods[index].name : '',
      image: handle.pods[index] ? handle.pods[index].image : instance.image,
      startedAt: new Date(now()).toISOString(),
    }))
    if (switchCurrent) {
      // 本地这一份软链不是部署状态（集群才是），但它是回滚的候选来源；两份状态必须同时前进。
      if (currentLink) await run('ln -sfn ' + shellQuote('releases/' + handle.releaseId) + ' ' + shellQuote(currentLink))
      if (targetPath) {
        const stamp = new Date(now()).toISOString()
        await run('echo ' + shellQuote(stamp + ' ' + handle.releaseId + ' activate k8s ' + handle.imageDigest) + ' >> ' + shellQuote(targetPath + '/revisions.log'))
      }
    }
    handle.activatedAt = new Date(now()).toISOString()
    logLine(onLog, '[' + hostName + '] activate: ' + kind + ' ' + namespace + '/' + workload + ' -> ' + handle.imageReference + '（generation ' + handle.revision + '）')
    return handle
  }

  /** L1 - 控制器说这份 spec 已经全部就位（updated == replicas == ready）。 */
  async function l1(handle) {
    const state = await readWorkload()
    if (!state.replicas) return { ok: false, layer: 'l1', detail: kind + ' ' + namespace + '/' + workload + ' 没有副本' }
    if (state.observed < state.generation) {
      return { ok: false, layer: 'l1', detail: '控制器还没看到 generation ' + state.generation + '（observed ' + state.observed + '）' }
    }
    if (state.ready < state.replicas || state.updated < state.replicas) {
      return { ok: false, layer: 'l1', detail: '就绪 ' + state.ready + '/' + state.replicas + '，已更新 ' + state.updated + '/' + state.replicas }
    }
    if (state.image && handle.imageReference && state.image !== handle.imageReference) {
      return { ok: false, layer: 'l1', detail: '当前镜像是 ' + state.image + '，不是本次的 ' + handle.imageReference }
    }
    return { ok: true, layer: 'l1', detail: state.ready + '/' + state.replicas + ' 就绪，generation ' + state.generation }
  }

  function probeVars(instance) {
    return {
      host: hostName,
      release: instance.releaseId,
      app,
      index: instance.index,
      port: instance.port,
      slot: String(instance.slot),
      instance: instance.instanceId,
      pod: instance.podName,
    }
  }

  /** L2 - 应用真的答话。模板与 native 同一套，health 块可以照搬。 */
  async function l2(handle) {
    const http = (target.health && target.health.http) || ''
    if (!http) return { ok: true, layer: 'l2', detail: '未配置 health.http，跳过 l2', skipped: true }
    const tries = Math.max(1, Number((target.health && target.health.tries) || 3))
    const interval = Math.max(0, Number((target.health && target.health.interval) || 2))
    const expect = String((target.health && target.health.expect) || '').trim()
    for (const instance of handle.instances || []) {
      const command = renderTemplate(http, probeVars(instance))
      let last = ''
      const seen = new Set()
      for (let attempt = 1; attempt <= tries; attempt += 1) {
        const probe = await host.exec(command, { timeoutSec: Number((target.health && target.health.timeoutSec) || 10) })
        last = String((probe && (probe.stdout || probe.stderr)) || '').trim()
        seen.add(last)
        const code = probe && probe.exitCode
        const passed = (code === undefined || code === null || Number(code) === 0) && (!expect || seen.has(expect))
        if (passed) break
        if (attempt < tries) await delay(interval * 1000)
      }
      if (expect && !seen.has(expect)) {
        return { ok: false, layer: 'l2', detail: instance.instanceId + ' 未返回期望 ' + expect + '，最后一次：' + last.slice(0, 200) }
      }
    }
    return { ok: true, layer: 'l2', detail: http }
  }

  /** L3 - 它一直答话。反复重启是只有时间才看得见的失败，而 k8s 的重启策略会把这种失败藏起来。 */
  async function l3(handle) {
    const window = Number((target.health && target.health.window) || 0)
    if (!(window > 0)) return { ok: true, layer: 'l3', detail: '未配置观察窗，跳过 l3', skipped: true }
    const interval = Math.max(1, Number((target.health && target.health.interval) || 2))
    const deadline = now() + window * 1000
    while (now() < deadline) {
      const alive = await l1(handle)
      if (!alive.ok) return { ok: false, layer: 'l3', detail: '观察窗内副本掉线：' + alive.detail }
      await delay(interval * 1000)
    }
    return { ok: true, layer: 'l3', detail: window + 's 内 ' + replicas + ' 个副本始终就绪' }
  }

  async function health(handle) {
    const layers = {}
    for (const [name, probe] of [['l1', l1], ['l2', l2], ['l3', l3]]) {
      const result = await probe(handle)
      layers[name] = result
      if (!result.ok) return { ok: false, layer: name, detail: result.detail, layers }
    }
    return { ok: true, layer: 'l3', detail: layers.l3.detail, layers }
  }
  /**
   * stop：K8s 里没有「我们自己的进程」可停。
   *
   * 补偿场景要撤掉的是「这次 patch 上去的副本」，而撤法只有一个 —— 把 spec 改回去。
   * 这里刻意不调 stop，也不删 pod：删 pod 只会让控制器按新 spec 再起一个，等于什么也没做。
   */
  async function stop(handle) {
    for (const instance of handle.instances || []) {
      if (instance.stoppedAt) continue
      instance.stoppedAt = new Date(now()).toISOString()
    }
    return handle
  }

  /**
   * Phase 5 (compensation) - 回到 activate 之前。
   *
   * 两条路，取决于 activate 走到哪一步：
   *   - activate 没完成  → 只有 spec 变了。用 rollout undo 退回去（控制器自己知道上一版 RS）。
   *   - activate 完成了  → 同样 rollout undo：它才是唯一会把控制器内部记账一起退回去的操作。
   *
   * 为什么不自己 `set image` 回旧 digest：那样会多出一个新 revision，history 里出现「A→B→A'」，
   * 下一个人的 `rollout undo` 会退到 B —— 回滚应该少产生历史，而不是多产生一条。
   */
  async function revert(handle, options = {}) {
    await stop(handle)
    // 没 patch 过就没有可回滚的东西；判断依据是 revision 为空（activate 在 patch 之后才写它）。
    if (!handle.activatedAt && !handle.revision) {
      logLine(onLog, '[' + hostName + '] revert: activate 未完成，集群未被改动')
      return handle
    }
    const result = await run(
      kubectl('rollout undo ' + kind.toLowerCase() + '/' + shellQuote(workload) + ' --to-revision=0'),
      { timeoutSec: 120 },
    )
    if (!okOf(result)) {
      throw failure(K8S_ERRORS.ROLLBACK, 'rollout undo ' + kind + ' ' + namespace + '/' + workload + ' 失败：' + (detailOf(result) || '(无输出)'))
    }
    const rolled = await waitRollout(handle)
    if (!rolled.ok) {
      throw failure(K8S_ERRORS.ROLLBACK, 'rollback 之后 rollout 未完成（' + kind + ' ' + namespace + '/' + workload + '）：' + (rolled.detail || '(无输出)'))
    }
    if (handle.previous && currentLink) {
      await run('ln -sfn ' + shellQuote('releases/' + handle.previous) + ' ' + shellQuote(currentLink))
    }
    const restored = await readWorkload()
    if (targetPath) {
      const stamp = new Date(now()).toISOString()
      await run('echo ' + shellQuote(stamp + ' ' + handle.releaseId + ' revert k8s ' + (restored.image || '')) + ' >> ' + shellQuote(targetPath + '/revisions.log'))
    }
    logLine(onLog, '[' + hostName + '] revert: rollout undo → ' + (restored.image || '(回滚完成)'))
    return Object.assign({}, handle, {
      reverted: true,
      pods: await runningPods(),
      previousImage: restored.image || handle.previousImage,
    })
  }

  /** 保留最近 N 个 release 目录（本地记录，不是集群对象）。 */
  async function cleanup(handle, options = {}) {
    const keep = Math.max(1, Math.trunc(Number(options.keep || (target && target.keep) || 5)))
    if (targetPath) {
      await run('ls -1dt ' + shellQuote(targetPath + '/releases/') + '* 2>/dev/null | tail -n +' + (keep + 1) + ' | xargs -r rm -rf')
    }
    return handle
  }

  /** 回滚要读的那份记录：这次发布到底是哪个 digest、集群里现在是哪个镜像。 */
  async function writeManifest(handle, extra = {}) {
    const manifest = Object.assign({
      version: 1,
      mode: 'k8s',
      releaseId: handle.releaseId,
      previous: handle.previous,
      target: { name: app, path: targetPath, host: hostName },
      cluster: { namespace, kind, workload, container: containerName, replicas },
      artifact: { image: handle.image, digest: handle.imageDigest, reference: handle.imageReference },
      revision: handle.revision,
      pods: (handle.pods || []).map((pod) => ({ name: pod.name, phase: pod.phase, image: pod.image })),
      health: extra.health || null,
      strategy: extra.strategy || null,
      commit: extra.commit || '',
      runId: extra.runId || '',
      operator: extra.operator || '',
      activatedAt: handle.activatedAt,
    }, extra.extra || {})
    const body = JSON.stringify(manifest, null, 2)
    if (!handle.dir) return manifest
    await run('printf %s ' + shellQuote(body.replace(/'/g, "'\\''")) + ' > ' + shellQuote(handle.dir + '/.dsh-manifest.json'))
    return manifest
  }

  return {
    hostName,
    targetPath,
    mode: 'k8s',
    image,
    namespace,
    workload,
    kind,
    containerName,
    replicas,
    commands: K8S_COMMANDS,
    stage,
    activate,
    revert,
    health,
    l1,
    l2,
    l3,
    stop,
    cleanup,
    writeManifest,
    runningPods,
    readWorkload,
  }
}
