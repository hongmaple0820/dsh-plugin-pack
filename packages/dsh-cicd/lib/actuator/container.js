/**
 * The container actuator: pull by digest, run a new container, verify, swap traffic.
 *
 * Same five phases as lib/actuator/native.js (stage / activate / health / stop / cleanup), because
 * the transaction and the compensation table live in lib/deploy-engine.js and must not know which
 * kind of host they are talking to. What differs is only how a version reaches the host and how it
 * starts:
 *
 *   native      symlink swap + restart the process on a fixed port
 *   container   docker pull repo@sha256:... + docker run -p 0 + read the assigned port back
 *
 * ## Everything is keyed by digest, never by tag
 *
 * A tag is a mutable name. Deploying app:latest and then rolling back to "the previous one" is a
 * promise nobody can keep - by the time you roll back, latest may already point at the new bytes.
 * So the reference this actuator ever pulls is <image>@sha256:<digest>: the digest recorded with the
 * artifact, the same sha256 the CAS and the OCI registry already speak. A tag reaching this code is
 * a bug in the caller, and it is rejected rather than resolved.
 *
 * ## Why -p 0 and then read the port back
 *
 * Asking Docker for an ephemeral port and then asking which one it chose is the only allocation that
 * cannot race: any port we pick ourselves can be taken between the check and the docker run. The
 * assigned port is what the L2/L3 probes use, so "the container is up" and "the container serves"
 * stay two different questions with two different answers.
 *
 * ## The command vocabulary is closed too
 *
 * Every command this file can emit is listed in CONTAINER_COMMANDS. Like NATIVE_COMMANDS that list
 * is a contract, not documentation: test/smoke.mjs runs a fake docker implementing exactly these
 * shapes and fails loudly on anything new, so a feature added here has to be accompanied by a
 * decision about how it behaves on a real box.
 */

import { shellQuote } from '../deploy.js'
import { renderTemplate } from './native.js'

/** Every shell command shape the container actuator may emit. */
export const CONTAINER_COMMANDS = [
  'docker inspect --type image',
  'docker pull',
  'docker run',
  'docker port',
  'docker ps',
  'docker inspect',
  'docker stop',
  'docker rm',
  'mkdir -p',
  'ln -sfn',
  'readlink',
  'echo >>',
  'printf >',
  'cat',
  'ls -1dt',
  'curl',
  'ss -ltn',
]

export const CONTAINER_ERRORS = {
  IMAGE: 'CONTAINER_IMAGE_INVALID',
  PULL: 'CONTAINER_PULL_FAILED',
  RUN: 'CONTAINER_RUN_FAILED',
  PORT: 'CONTAINER_PORT_UNKNOWN',
  STOP: 'CONTAINER_STOP_FAILED',
}

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/

function logLine(onLog, line) {
  try { onLog?.(line) } catch { /* observers must never break a deploy */ }
}

function trimEnd(value) {
  return String(value || '').replace(/\/+$/, '')
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) });

/** sha256:... only. A bare hex is normalised; a tag is refused. */
export function normalizeImageDigest(value) {
  const text = String(value || '').trim().toLowerCase()
  if (DIGEST_RE.test(text)) return text
  if (/^[a-f0-9]{64}$/.test(text)) return 'sha256:' + text
  return ''
}

/**
 * Resolve the image reference to pull: <image>@sha256:<artifactDigest>.
 *
 * The digest must be a sha256 - that is what sha256sum produces and what the CAS stores. A digest
 * that is not one is a refusal, not something to fall back from: pulling app:latest because the
 * digest was unreadable is precisely the silent tag drift this whole design exists to prevent.
 */
export function resolveImageReference({ image, digest } = {}) {
  const name = String(image || '').trim()
  const normalised = normalizeImageDigest(digest)
  if (!name) {
    const error = new Error('容器部署需要 target.image（如 registry.example.com/demo/web）')
    error.code = CONTAINER_ERRORS.IMAGE
    throw error
  }
  if (!normalised) {
    const got = String(digest || '').trim() || '（空）'
    const error = new Error('容器部署只接受 sha256 digest，收到 "' + got + '"；按 tag 部署会让回滚跟着 tag 漂移')
    error.code = CONTAINER_ERRORS.IMAGE
    throw error
  }
  const lastSegment = name.split('/').pop() || ''
  if (lastSegment.includes(':')) {
    const error = new Error('target.image "' + name + '" 带了 tag；容器部署请只写仓库名，镜像引用由 digest 决定')
    error.code = CONTAINER_ERRORS.IMAGE
    throw error
  }
  return { reference: name + '@' + normalised, image: name, digest: normalised }
}

/** docker inspect output -> [{containerId, running, image, ports[]}]. */
export function parseInspect(stdout) {
  const text = String(stdout || '').trim()
  if (!text) return []
  let parsed = null
  try { parsed = JSON.parse(text) } catch { return [] }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  return list.filter(Boolean).map((item) => ({
    containerId: String(item.Id || ''),
    running: Boolean(item.State && item.State.Running),
    image: String((item.Config && item.Config.Image) || item.Image || ''),
    ports: Object.entries((item.NetworkSettings && item.NetworkSettings.Ports) || {})
      .flatMap((pair) => (pair[1] || []).map((binding) => ({
        containerPort: Number(String(pair[0]).split('/')[0]) || 0,
        hostPort: Number(binding.HostPort) || 0,
        hostIp: String(binding.HostIp || ''),
      })))
      .filter((entry) => entry.hostPort > 0),
  }))
}

/** docker ps --format '{{.ID}}' output -> ids. */
export function parseContainerIds(stdout) {
  return String(stdout || '').split('\n').map((line) => line.trim()).filter(Boolean)
}

/** Read one published host port back out of docker port ('80/tcp -> 0.0.0.0:32768'). */
export function parsePublishedPort(stdout, containerPort) {
  const wanted = Number(containerPort) || 0
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.trim()
    const match = /^(\d+)\/(?:tcp|udp)\s+(?:->|→)\s+(\S+):(\d+)$/.exec(line)
    if (!match) continue
    if (wanted && Number(match[1]) !== wanted) continue
    return { containerPort: Number(match[1]), hostIp: match[2], hostPort: Number(match[3]) }
  }
  return null
}

/**
 * @param {object} options
 * @param {{exec: Function, uploadFile: Function}} options.host bound to one host
 * @param {object} options.target normalised target (path / image / container / health / keep)
 * @param {string} options.hostName
 * @param {(line:string)=>void} [options.onLog]
 * @param {() => number} [options.now]
 */
export function createContainerActuator({ host, target, hostName, onLog, now = Date.now }) {
  if (!host || typeof host.exec !== 'function') throw new Error('container actuator 需要 host.exec')
  const targetPath = trimEnd(target.path)
  const currentLink = targetPath + '/current'
  const spec = target.container || {}
  const image = String(target.image || spec.image || '').trim()
  // 容器内监听端口：只有用户知道容器里开在哪个端口，猜一个 8080 出来就是猜。
  const containerPort = Number(spec.port) || 0
  const app = String(target.app || '')
  const instanceCount = target.instances && Number(target.instances.count) > 0 ? Math.trunc(Number(target.instances.count)) : 1
  const instancesSpec = target.instances || null
  const killWait = instancesSpec && instancesSpec.drain && Number.isFinite(Number(instancesSpec.drain.timeout))
    ? Number(instancesSpec.drain.timeout)
    : 30
  const label = 'dsh.cicd.target=' + (app || 'app')

  function instanceVars(index, releaseId) {
    return { host: hostName, release: releaseId, app, index, port: '', slot: String(index), instance: hostName + '/' + index }
  }

  function containerName(releaseId, index) {
    return (app || 'app') + '-' + releaseId + '-' + index
  }

  async function imagePresent(reference) {
    // docker inspect --type image 是唯一不需要先拉就能问「本机有没有这份字节」的命令；
    // 解析 docker images 的文本会把 digest 前缀匹配当成命中。
    const probe = await host.exec('docker inspect --type image ' + shellQuote(reference) + ' >/dev/null 2>&1 && echo yes || echo no')
    return /yes/.test(String((probe && probe.stdout) || ''))
  }
  /**
   * Phase 1 - stage. Get the exact bytes onto the host. No container is started, nothing listens,
   * nothing can take traffic; if this fails the fleet is untouched by construction.
   */
  async function stage({ releaseId, artifactPath, artifactDigest } = {}) {
    const resolved = resolveImageReference({ image, digest: artifactDigest || target.artifactDigest || '' })
    const reference = resolved.reference
    const digest = resolved.digest
    const dir = targetPath + '/releases/' + releaseId
    await host.exec('mkdir -p ' + shellQuote(dir))
    logLine(onLog, '[' + hostName + '] stage: ' + reference)

    const present = await imagePresent(reference)
    if (present) {
      logLine(onLog, '[' + hostName + '] stage: 本机已有 ' + digest + '，跳过 pull')
    } else {
      const pull = await host.exec('docker pull ' + shellQuote(reference), { timeoutSec: Number(spec.pullTimeoutSec) || 600 })
      const code = pull && pull.exitCode
      if (code !== undefined && code !== null && Number(code) !== 0) {
        const detail = String((pull && (pull.stderr || pull.stdout)) || '').trim().slice(0, 300)
        const error = new Error('[' + hostName + '] docker pull 失败（' + reference + '）：' + detail)
        error.code = CONTAINER_ERRORS.PULL
        throw error
      }
    }

    const handle = {
      host: hostName,
      mode: 'container',
      releaseId,
      dir,
      image,
      imageDigest: digest,
      imageReference: reference,
      // 容器不占固定端口（-p 0 由 docker 分配），slots 留空但保留同形接口，
      // 让 deploy-engine 的补偿路径不必为两种模式各写一遍。
      slots: { releaseAll: async () => {} },
      instances: Array.from({ length: instanceCount }, (_unused, index) => ({
        index,
        slot: index,
        port: 0,
        instanceId: hostName + '/' + index,
        containerId: '',
        containerName: containerName(releaseId, index),
        image: reference,
        env: Object.assign({}, (instancesSpec && instancesSpec.env) || {}),
        envRendered: Object.fromEntries(
          Object.entries((instancesSpec && instancesSpec.env) || {}).map((pair) => [
            pair[0],
            renderTemplate(String(pair[1]), instanceVars(index, releaseId)),
          ]),
        ),
        logPath: renderTemplate(String((instancesSpec && instancesSpec.log) || ''), instanceVars(index, releaseId)),
        pid: 0,
        startedAt: '',
        stoppedAt: '',
        releaseId,
      })),
      containers: [],
      previous: '',
      previousImage: '',
      stagedAt: new Date(now()).toISOString(),
      activatedAt: '',
      pids: [],
      artifactName: releaseId,
    }
    return handle
  }

  /** 还在跑的、属于这个 target 的容器：从 label 读，而不是从我们自己的记忆里读。 */
  async function runningContainers() {
    const listed = await host.exec('docker ps -q --filter ' + shellQuote('label=' + label))
    const ids = parseContainerIds(listed && listed.stdout)
    if (ids.length === 0) return []
    const inspected = await host.exec('docker inspect ' + ids.map((id) => shellQuote(id)).join(' '))
    return parseInspect(inspected && inspected.stdout)
  }

  function runCommand(instance, digestOfRelease) {
    const parts = ['docker run -d']
    parts.push('--name ' + shellQuote(instance.containerName))
    parts.push('--label ' + shellQuote(label))
    parts.push('--label ' + shellQuote('dsh.cicd.release=' + instance.releaseId))
    parts.push('--label ' + shellQuote('dsh.cicd.instance=' + instance.instanceId))
    parts.push('--label ' + shellQuote('dsh.cicd.digest=' + digestOfRelease))
    // -p 0：让 docker 分配一个空闲的宿主端口，再用 docker port 读回来。自己挑端口会在
    // 「检查可用」与「docker run」之间被别人抢走，而那个竞态在生产上是百分百会遇到的。
    parts.push(containerPort > 0 ? '-p 0:' + containerPort : '-p 0')
    for (const pair of Object.entries(instance.envRendered || {})) {
      parts.push('-e ' + shellQuote(pair[0] + '=' + pair[1]))
    }
    for (const volume of Array.isArray(spec.volumes) ? spec.volumes : []) parts.push('-v ' + shellQuote(String(volume)))
    for (const extra of Array.isArray(spec.args) ? spec.args : []) parts.push(String(extra))
    parts.push(shellQuote(instance.image || ''))
    return parts.join(' ')
  }

  /** Phase 2 - activate. 起新容器，读回端口，切 current。任何一步失败都不能留下一个没人认识的容器。 */
  async function activate(handle, options = {}) {
    // options.switchCurrent === false：回滚重放的场景 —— current 已经指着要回去的那一版，
    // 再读一遍会把「上一版」覆盖成它自己，再写一遍只是把同一条软链重放一次。
    const switchCurrent = options.switchCurrent !== false
    const read = switchCurrent ? await host.exec('readlink ' + shellQuote(currentLink) + ' || true') : { stdout: '', exitCode: 0 }
    const text = String((read && read.stdout) || '').trim()
    const carried = handle.previous
    handle.previous = !switchCurrent ? String(handle.previous || '') : (() => {
      if (!text) return ''
      const match = /(?:^|\/)releases\/([^\/\s]+)\/?$/.exec(text)
      return match ? match[1] : (text.split('/').filter(Boolean).pop() || '')
    })()
    // 上一版的镜像引用读上一版自己的 manifest，而不是「磁盘上现在是什么」——
    // 回滚要的是当时部署了什么，这两者在有人手改过镜像之后不是一回事。
    // manifest 里 artifact.reference 是完整的 image@sha256:…；artifact.image 只是仓库名。
    if (switchCurrent) {
      handle.previousImage = ''
    } else if (!handle.previousImage && carried) {
      // 回滚重放：previous 是调用方指定的目标版本，它的 digest 只在自己的 manifest 里。
      const manifest = await host.exec('cat ' + shellQuote(targetPath + '/releases/' + carried + '/.dsh-manifest.json') + ' 2>/dev/null || true')
      try {
        const artifact = JSON.parse(String((manifest && manifest.stdout) || '').trim() || '{}').artifact || {}
        handle.previousImage = String(artifact.reference || (artifact.image && artifact.digest ? artifact.image + '@' + artifact.digest : ''))
      } catch { /* 没有 manifest：下面按 CONTAINER_IMAGE_INVALID 明说 */ }
    }
    if (switchCurrent && handle.previous) {
      const file = targetPath + '/releases/' + handle.previous + '/.dsh-manifest.json'
      const manifest = await host.exec('cat ' + shellQuote(file) + ' 2>/dev/null || true')
      try {
        const parsed = JSON.parse(String((manifest && manifest.stdout) || '').trim() || '{}')
        const recorded = (parsed && parsed.artifact) || {}
        handle.previousImage = String(recorded.reference || (recorded.image && recorded.digest ? recorded.image + '@' + recorded.digest : ''))
      } catch { /* 老版本没有 manifest：补偿时按 previous 目录尽力而为，见 revert */ }
    }

    for (const instance of handle.instances) {
      if (!instance.envRendered.port && containerPort) instance.envRendered.port = String(containerPort)
      const command = runCommand(instance, handle.imageDigest)
      logLine(onLog, '[' + hostName + '] activate: ' + command)
      const started = await host.exec(command, { timeoutSec: Number(spec.runTimeoutSec) || 120 })
      const code = started && started.exitCode
      if (code !== undefined && code !== null && Number(code) !== 0) {
        const detail = String((started && (started.stderr || started.stdout)) || '').trim().slice(0, 300)
        const error = new Error('[' + hostName + '] docker run 失败（' + instance.containerName + '）：' + detail)
        error.code = CONTAINER_ERRORS.RUN
        throw error
      }
      instance.containerId = String((started && started.stdout) || '').trim().split('\n').pop().trim()
      if (!instance.containerId) {
        // 没有容器 id 就没有回滚现场：立刻收手，别让一个没人认识的容器继续跑。
        const error = new Error('[' + hostName + '] docker run 没有返回容器 id（' + instance.containerName + '）')
        error.code = CONTAINER_ERRORS.RUN
        throw error
      }
      instance.startedAt = new Date(now()).toISOString()
      handle.containers.push(instance.containerId)
      if (containerPort) {
        const published = await host.exec('docker port ' + shellQuote(instance.containerId))
        const binding = parsePublishedPort(published && published.stdout, containerPort)
        if (!binding) {
          const error = new Error('[' + hostName + '] 读不到 ' + instance.containerId.slice(0, 12) + ' 的发布端口（容器内 ' + containerPort + '/tcp）——端口没发布，探针测不到就是没起来')
          error.code = CONTAINER_ERRORS.PORT
          throw error
        }
        instance.port = binding.hostPort
        instance.hostIp = binding.hostIp
        logLine(onLog, '[' + hostName + '] ' + instance.instanceId + ' 容器 ' + instance.containerId.slice(0, 12) + ' → 宿主端口 ' + binding.hostPort)
      }
      if (instance.logPath) {
        await host.exec('mkdir -p ' + shellQuote(instance.logPath.replace(/\/[^\/]*$/, '')))
      }
    }

    if (switchCurrent) await host.exec('ln -sfn ' + shellQuote('releases/' + handle.releaseId) + ' ' + shellQuote(currentLink))
    const stamp = new Date(now()).toISOString()
    await host.exec('echo ' + shellQuote(stamp + ' ' + handle.releaseId + ' activate container ' + handle.imageDigest) + ' >> ' + shellQuote(targetPath + '/revisions.log'))
    handle.activatedAt = stamp
    logLine(onLog, '[' + hostName + '] activate: current -> releases/' + handle.releaseId + '（' + handle.imageDigest + '）')
    return handle
  }
  /** L1 - the container exists and is running. Nothing about the app inside it yet. */
  async function l1(handle) {
    for (const instance of handle.instances || []) {
      const id = instance.containerId;
      if (!id) return { ok: false, layer: 'l1', detail: instance.instanceId + ' 没有容器 id' };
      const running = await host.exec('docker ps -q --filter ' + shellQuote('id=' + id));
      const ids = parseContainerIds(running && running.stdout);
      if (!ids.includes(id) && !ids.some((entry) => id.startsWith(entry))) {
        return { ok: false, layer: 'l1', detail: instance.instanceId + ' 容器 ' + id.slice(0, 12) + ' 不在运行' };
      }
      if (containerPort) {
        const bound = await host.exec('ss -ltn 2>/dev/null | grep -c ' + shellQuote(':' + instance.port) + ' || true');
        const count = Number(String((bound && bound.stdout) || '').trim()) || 0;
        if (count === 0) {
          // 容器在跑但宿主端口没监听：闭包上的是一台没有代理的机器不值得交付的事。
          return { ok: false, layer: 'l1', detail: instance.instanceId + ' 容器在跑但宿主端口 ' + instance.port + ' 未监听' };
        }
      }
    }
    return { ok: true, layer: 'l1', detail: (handle.instances || []).length + ' 个容器运行中' };
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
    };
  }

  /** L2 - the app answers. Same template language as native, so a health block is portable. */
  async function l2(handle) {
    const http = (target.health && target.health.http) || '';
    if (!http) return { ok: true, layer: 'l2', detail: '未配置 health.http，跳过 l2', skipped: true };
    const tries = Math.max(1, Number((target.health && target.health.tries) || 3));
    const interval = Math.max(0, Number((target.health && target.health.interval) || 2));
    const expect = String((target.health && target.health.expect) || '').trim();
    for (const instance of handle.instances || []) {
      const command = renderTemplate(http, probeVars(instance));
      let last = '';
      let seen = new Set();
      for (let attempt = 1; attempt <= tries; attempt += 1) {
        const probe = await host.exec(command, { timeoutSec: Number((target.health && target.health.timeoutSec) || 10) });
        last = String((probe && (probe.stdout || probe.stderr)) || '').trim();
        seen.add(last);
        const code = probe && probe.exitCode;
        const passed = (code === undefined || code === null || Number(code) === 0) && (!expect || seen.has(expect));
        if (passed) break;
        if (attempt < tries) await delay(interval * 1000);
      }
      if (expect && !seen.has(expect)) {
        return { ok: false, layer: 'l2', detail: instance.instanceId + ' 未返回期望 ' + expect + '，最后一次：' + last.slice(0, 200) };
      }
    }
    return { ok: true, layer: 'l2', detail: '(容器内 ' + containerPort + ') ' + http };
  }

  /** L3 - it keeps answering. Restarts are the failure mode that only time exposes. */
  async function l3(handle) {
    const window = Number((target.health && target.health.window) || 0);
    if (!(window > 0)) return { ok: true, layer: 'l3', detail: '未配置观察窗，跳过 l3', skipped: true };
    const interval = Math.max(1, Number((target.health && target.health.interval) || 2));
    const deadline = now() + window * 1000;
    while (now() < deadline) {
      const alive = await l1(handle);
      if (!alive.ok) return { ok: false, layer: 'l3', detail: '观察窗内容器消失：' + alive.detail };
      await delay(interval * 1000);
    }
    return { ok: true, layer: 'l3', detail: window + 's 内容器始终在线' };
  }

  async function health(handle) {
    const layers = {};
    for (const [name, probe] of [['l1', l1], ['l2', l2], ['l3', l3]]) {
      const result = await probe(handle);
      layers[name] = result;
      if (!result.ok) return { ok: false, layer: name, detail: result.detail, layers };
    }
    return { ok: true, layer: 'l3', detail: layers.l3.detail, layers };
  }

  /** Stop one container: docker stop waits itself, so this is one command and one verdict. */
  async function stopContainer(containerId, name, timeoutSec) {
    if (!containerId) return;
    await host.exec('docker stop -t ' + Math.max(0, Math.trunc(Number(timeoutSec) || 10)) + ' ' + shellQuote(containerId) + ' >/dev/null 2>&1 || true', {
      timeoutSec: Math.max(30, Math.trunc(Number(timeoutSec) || 10) + 30),
    });
    await host.exec('docker rm -f ' + shellQuote(containerId) + ' >/dev/null 2>&1 || true');
    logLine(onLog, '[' + hostName + '] stop: ' + (name || containerId.slice(0, 12)));
  }

  async function stop(handle) {
    for (const instance of handle.instances || []) {
      if (!instance.containerId || instance.stoppedAt) continue;
      await stopContainer(instance.containerId, instance.containerName, killWait);
      instance.stoppedAt = new Date(now()).toISOString();
    }
    return handle;
  }

  /**
   * Phase 5 (compensation) - go back to what was current before activate.
   *
   * Two ways to undo, and which one applies depends on how far activate got:
   *   - activate never finished  → stop only the containers this handle started, leave the
   *     previous release untouched (it is still running; it was never stopped).
   *   - activate finished         → stop the new ones, then re-pull the previous digest and start it.
   * Re-pulling is deliberate: it is the only path where "the previous digest" is proven to still
   * exist. If the previous release has no recorded digest (a pre-v3 target), revert says so instead
   * of quietly starting whatever the mutable tag happens to point at now.
   */
  async function revert(handle, options = {}) {
    await stop(handle);
    if (!handle.activatedAt) {
      logLine(onLog, '[' + hostName + '] revert: activate 未完成，只收拾本次起来的容器');
      return handle;
    }
    const reference = String(handle.previousImage || '').trim();
    const digest = normalizeImageDigest(reference.includes('@') ? reference.split('@')[1] : '');
    if (!handle.previous) {
      await host.exec('rm -f ' + shellQuote(currentLink));
      logLine(onLog, '[' + hostName + '] revert: 没有上一版，current 已移除');
      return handle;
    }
    if (!digest) {
      const error = new Error('[' + hostName + '] 无法回滚到 ' + handle.previous + '：它没有记录镜像 digest（07-deploy.md 阶段一之前的 release），按 tag 回滚会落到它今天指向的东西');
      error.code = CONTAINER_ERRORS.IMAGE;
      throw error;
    }
    // 用上版 reference 里记的仓库名，而不是本次部署的仓库：改名迁移时上一版在旧仓库里。
    const previousRepo = reference.includes('@') ? reference.split('@')[0] : (handle.image || image)
    const pullTarget = previousRepo + '@' + digest;
    const pulled = await host.exec('docker pull ' + shellQuote(pullTarget), { timeoutSec: Number(spec.pullTimeoutSec) || 600 });
    const pullCode = pulled && pulled.exitCode;
    if (pullCode !== undefined && pullCode !== null && Number(pullCode) !== 0) {
      const detail = String((pulled && (pulled.stderr || pulled.stdout)) || '').trim().slice(0, 300);
      const error = new Error('[' + hostName + '] 回滚拉取 ' + pullTarget + ' 失败：' + detail);
      error.code = CONTAINER_ERRORS.PULL;
      throw error;
    }
    const restore = {
      host: hostName,
      mode: 'container',
      releaseId: handle.previous,
      dir: targetPath + '/releases/' + handle.previous,
      image,
      imageDigest: digest,
      imageReference: pullTarget,
      containers: [],
      instances: (handle.instances || []).map((instance, index) => ({
        index,
        slot: index,
        port: 0,
        instanceId: hostName + '/' + index,
        containerId: '',
        containerName: containerName(handle.previous, index),
        image: pullTarget,
        env: instance.env,
        envRendered: instance.envRendered,
        logPath: instance.logPath,
        pid: 0,
        startedAt: '',
        stoppedAt: '',
        releaseId: handle.previous,
      })),
    };
    await activate(restore, { switchCurrent: false });
    await host.exec('echo ' + shellQuote(new Date(now()).toISOString() + ' ' + handle.previous + ' revert container ' + digest) + ' >> ' + shellQuote(targetPath + '/revisions.log'));
    logLine(onLog, '[' + hostName + '] revert: 已回到 ' + handle.previous + '（' + digest + '）');
    // 回滚后的现场（新容器 id、端口、实例清单）交回给调用方：
    // 部署补偿与 rollback 都要拿它写 release 行与 manifest，没人该去猜。
    return { ...restore, reverted: true, digest, previous: handle.previous, previousImage: reference };
  }

  /** Keep the N newest releases, delete the rest. Same shape as native's cleanup. */
  async function cleanup(handle, options = {}) {
    const keep = Math.max(1, Math.trunc(Number(options.keep || target.keep || 5)));
    await host.exec('ls -1dt ' + shellQuote(targetPath + '/releases/') + '* 2>/dev/null | tail -n +' + (keep + 1) + ' | xargs -r rm -rf');
    return handle;
  }

  /** The record a rollback reads: which digest this release actually was. */
  async function writeManifest(handle, extra = {}) {
    const manifest = Object.assign({
      version: 1,
      mode: 'container',
      releaseId: handle.releaseId,
      previous: handle.previous,
      target: { name: app, path: targetPath, host: hostName },
      artifact: { image: handle.image, digest: handle.imageDigest, reference: handle.imageReference },
      instances: (handle.instances || []).map((instance) => ({
        instanceId: instance.instanceId,
        slot: instance.slot,
        port: instance.port,
        containerId: instance.containerId,
        containerName: instance.containerName,
        image: instance.image,
        env: instance.envRendered,
      })),
      health: extra.health || null,
      strategy: extra.strategy || null,
      commit: extra.commit || '',
      runId: extra.runId || '',
      operator: extra.operator || '',
      activatedAt: handle.activatedAt,
    }, extra.extra || {});
    const body = JSON.stringify(manifest, null, 2);
    const file = handle.dir + '/.dsh-manifest.json'
    await host.exec('printf %s ' + shellQuote(body.replace(/'/g, "'\\''")) + ' > ' + shellQuote(file));
    return manifest;
  }

  return {
    hostName,
    targetPath,
    mode: 'container',
    image,
    containerPort,
    instanceCount,
    commands: CONTAINER_COMMANDS,
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
    runningContainers,
  };
}
