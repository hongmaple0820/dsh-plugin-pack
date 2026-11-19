/**
 * Release / rollback over the dsh-remote route client.
 *
 * Directory convention: <target.path>/releases/<releaseId>, <target.path>/current is a relative
 * symlink to releases/<releaseId>, and revisions.log is append-only. The previous symlink target
 * is the rollback candidate.
 *
 * v0.4: one target may list several hosts. A release is applied to every host in order, each with
 * its own previous/current symlink. `target.onHostFailure: stop|continue` decides whether a failed
 * host aborts the remaining hosts. Successful hosts are never rolled back automatically.
 *
 * v3.0-P3: `target.mode: container` 的目标不走软链 —— 回滚要换回上一版 manifest 里记的不可变
 * digest，所以这里把工作交给容器 Actuator（与部署补偿共用同一段 revert）。
 */

import { createContainerActuator } from './actuator/container.js'
import { createK8sActuator } from './actuator/k8s.js'

// Actuator 要的是 (host, command) 形状的 exec，而 remote 客户端把 host 放在第一个参数上。
// 这一层绑定只做形状对齐，不做任何策略。
function hostBound(remote, host) {
  return {
    exec: (command, options) => remote.exec(host, command, options),
    uploadFile: (localPath, remotePath) => remote.uploadFile(host, localPath, remotePath),
  }
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function releaseDir(target, releaseId) {
  return `${String(target.path || '').replace(/\/+$/, '')}/releases/${releaseId}`
}

/**
 * v3.0-P5-5：回滚必须作用在「当时验过的那份字节」上，而不是当前软链或 manifest 里写的字符串。
 *
 * 从 release 自己的 manifest 读 digest，再把磁盘上那份制品读回来重算一遍：
 * 只有改过的字节会让它不匹配，而那正是最该拦住回滚的情况（回滚到一份已损坏的包等于把事故延长一次）。
 * manifest 缺失或 digest 形状不对时按「无法核对」处理 —— 宁可不回滚，也不猜。
 */
export async function readReleaseDigest({ remote, host, releaseDir }) {
  const out = await remote.exec(host, `cat ${shellQuote(`${releaseDir}/.dsh-manifest.json`)} 2>/dev/null || true`)
  const text = String(out?.stdout || '').trim()
  if (!text) {
    const error = new Error(`[${host}] release 目录里没有 .dsh-manifest.json，无法确认要回滚到哪份字节`)
    error.code = 'RELEASE_NOT_FOUND'
    throw error
  }
  let manifest
  try {
    manifest = JSON.parse(text)
  } catch {
    const error = new Error(`[${host}] .dsh-manifest.json 不是合法 JSON，无法确认要回滚到哪份字节`)
    error.code = 'MANIFEST_INVALID'
    throw error
  }
  const artifact = manifest?.artifact || {}
  const digest = String(artifact.digest || '')
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    const error = new Error(`[${host}] manifest 里没有可用的 sha256 digest，无法确认要回滚到哪份字节`)
    error.code = 'MANIFEST_INVALID'
    error.digest = digest
    throw error
  }
  return { digest, path: String(artifact.path || ''), bytes: Number(artifact.bytes || 0), manifest }
}

/** 把 stage 到主机上的制品读回来重算 sha256。读不到也算不匹配（“拿不到”不等于“没被改过”）。 */
export async function verifyRemoteArtifact({ remote, host, artifactPath, digest }) {
  const out = await remote.exec(host, `sha256sum ${shellQuote(artifactPath)} 2>/dev/null || true`)
  const actual = String(out?.stdout || '').trim().split(/\s+/)[0] || ''
  if (!actual) {
    const error = new Error(`[${host}] 回滚目标制品 ${artifactPath} 不存在或读不出来，无法核对 digest`)
    error.code = 'ARTIFACT_CORRUPTED'
    error.digest = digest
    throw error
  }
  if (`sha256:${actual}` !== digest) {
    const error = new Error(`[${host}] 回滚目标制品的字节已被改动（磁盘 ${actual.slice(0, 12)}… ≠ manifest ${digest.slice(7, 19)}…）`)
    error.code = 'ARTIFACT_CORRUPTED'
    error.digest = digest
    error.actual = `sha256:${actual}`
    throw error
  }
  return { ok: true, digest, actual: `sha256:${actual}`, artifactPath }
}

function parsePrevious(stdout) {
  const text = String(stdout || '').trim()
  if (!text) return ''
  const match = /(?:^|\/)releases\/([^/\s]+)\/?$/.exec(text)
  if (match) return match[1]
  return text.split('/').filter(Boolean).pop() || ''
}

function healthSeconds(value, fallback = 2) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/.exec(String(value).trim())
  if (!match) return fallback
  const amount = Number(match[1])
  return match[2] === 'ms' ? amount / 1000 : match[2] === 'm' ? amount * 60 : amount
}

// 不要 unref：健康检查的重试等待如果被 unref，脚本/短命进程会在等待期间把事件循环跑空
export const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

export function logLine(onLog, line) {
  try { onLog?.(line) } catch { /* observers must not break a deploy */ }
}

function hostsOf(target, explicitHost = '') {
  if (explicitHost) return [String(explicitHost)]
  const hosts = Array.isArray(target?.hosts) ? target.hosts.map((host) => String(host).trim()).filter(Boolean) : []
  return hosts
}

function remoteReleaseId(releaseId, hosts) {
  const value = String(releaseId || '')
  for (const host of hosts) {
    if (host && value.endsWith(`@${host}`)) return value.slice(0, value.length - host.length - 1)
  }
  return value
}

function restartSpec(target) {
  if (target.restart) return { kind: 'restart', command: target.restart }
  if (target.service) {
    return {
      kind: 'service',
      command: `systemctl --user restart ${shellQuote(target.service)} || sudo -n systemctl restart ${shellQuote(target.service)} || true`,
    }
  }
  if (target.restartCommand) return { kind: target.runtime || 'runtime', command: target.restartCommand }
  return null
}

async function restartTarget({ remote, host, target, onLog }) {
  const spec = restartSpec(target)
  if (!spec) {
    logLine(onLog, `[${host}] 目标没有配置 service / restart，也没有 runtime 预设，跳过重启`)
    return 'skipped'
  }
  await remote.exec(host, spec.command)
  logLine(onLog, `[${host}] restart (${spec.kind}): ${spec.command}`)
  return spec.kind
}

async function healthCheck({ remote, host, target, onLog }) {
  const http = target.health?.http
  if (!http) return 'skipped'
  const tries = Number.isInteger(target.health?.tries) && target.health.tries > 0 ? target.health.tries : 5
  const interval = healthSeconds(target.health?.interval, 2)
  const command = `curl -fsS --max-time 5 ${shellQuote(http)}`
  let last = null
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      last = await remote.exec(host, command, { timeoutSec: 10 })
      if (!last || last.exitCode === 0) return 'ok'
    } catch (error) {
      last = { exitCode: 1, stderr: error.message }
    }
    if (attempt < tries) await delay(interval * 1000)
  }
  logLine(onLog, `[${host}] healthcheck 失败：${http}${last?.stderr ? `（${String(last.stderr).slice(0, 200)}）` : ''}`)
  return 'failed'
}

async function previousRelease({ remote, host, currentLink }) {
  try {
    const read = await remote.exec(host, `readlink ${shellQuote(currentLink)} || true`)
    return parsePrevious(read?.stdout)
  } catch {
    return ''
  }
}

async function cleanupReleases({ remote, host, targetPath, keep }) {
  if (!Number.isInteger(keep) || keep <= 0) return false
  const command = `ls -1dt ${shellQuote(`${targetPath}/releases`)}/*/ 2>/dev/null | tail -n +${keep + 1} | xargs -r rm -rf`
  try { await remote.exec(host, command) } catch { /* cleanup is best-effort */ }
  return true
}

export async function deployOne({
  remote,
  target,
  host,
  artifactPath,
  artifactDigest = '',
  releaseId,
  keep,
  commit,
  batch = 1,
  onLog,
}) {
  const dir = releaseDir(target, releaseId)
  const targetPath = String(target.path).replace(/\/+$/, '')
  const currentLink = `${targetPath}/current`

  await remote.exec(host, `mkdir -p ${shellQuote(dir)}`)
  logLine(onLog, `[${host}] release dir: ${dir}`)

  if (artifactPath) {
    const name = String(artifactPath).split(/[\\/]/).pop()
    await remote.uploadFile(host, artifactPath, `${dir}/${name}`)
    logLine(onLog, `[${host}] uploaded: ${name}`)
    if (/\.(tgz|tar\.gz)$/i.test(name)) {
      await remote.exec(host, `tar -xzf ${shellQuote(`${dir}/${name}`)} -C ${shellQuote(dir)}`)
      logLine(onLog, `[${host}] extracted: ${name}`)
    }
  }

  const previous = await previousRelease({ remote, host, currentLink })

  await remote.exec(host, `ln -sfn ${shellQuote(`releases/${releaseId}`)} ${shellQuote(currentLink)}`)
  logLine(onLog, `[${host}] current -> releases/${releaseId}`)

  const stamp = new Date().toISOString()
  await remote.exec(host, `echo ${shellQuote(`${stamp} ${releaseId} ${commit}`)} >> ${shellQuote(`${targetPath}/revisions.log`)}`)

  // v3.0-P5-5：native 路径也要留下「这一版装的是哪份字节」。
  // 没有这份 manifest，回滚就只能信 current 软链，而软链证明不了目录里的包没被换过。
  if (artifactDigest) {
    const artifactName = artifactPath ? String(artifactPath).split(/[\\/]/).filter(Boolean).pop() : ''
    const manifest = {
      version: 1,
      mode: 'native',
      releaseId,
      previous,
      target: { name: target.name || '', path: targetPath, host },
      artifact: { path: artifactName ? `${dir}/${artifactName}` : '', name: artifactName, digest: artifactDigest, commit },
      activatedAt: stamp,
    }
    await remote.exec(host, `printf '%s\\n' ${shellQuote(JSON.stringify(manifest))} > ${shellQuote(`${dir}/.dsh-manifest.json`)}`)
  }

  const restarted = await restartTarget({ remote, host, target, onLog })
  const health = await healthCheck({ remote, host, target, onLog })
  if (health === 'failed') {
    if (previous) {
      await remote.exec(host, `ln -sfn ${shellQuote(`releases/${previous}`)} ${shellQuote(currentLink)}`)
      try { await restartTarget({ remote, host, target, onLog }) } catch { /* rollback restart is best-effort */ }
      const error = new Error(`[${host}] 健康检查失败，已自动回滚到 ${previous}`)
      error.code = 'HEALTH_FAILED'
      error.previous = previous
      error.health = 'failed'
      error.restarted = restarted
      throw error
    }
    // 首次部署失败：撤掉 current 指向，别把「坏版本」留在线上，并尽量停掉刚起的进程
    try { await remote.exec(host, `rm -f ${shellQuote(currentLink)}`) } catch { /* best-effort */ }
    try { await restartTarget({ remote, host, target, onLog }) } catch { /* best-effort */ }
    const error = new Error(`[${host}] 健康检查失败，且没有可回滚的 previous，已撤掉 current 指向`)
    error.code = 'HEALTH_FAILED'
    error.health = 'failed'
    error.restarted = restarted
    throw error
  }

  const cleaned = await cleanupReleases({ remote, host, targetPath, keep })

  return {
    host,
    ok: true,
    batch,
    previous,
    releaseDir: dir,
    restarted,
    health,
    cleaned,
    activated_at: stamp,
    artifactDigest,
    error: '',
    code: '',
  }
}

function failureResult(host, error, batch = 1) {
  return {
    host,
    ok: false,
    batch,
    previous: error?.previous || '',
    releaseDir: '',
    restarted: error?.restarted || '',
    health: error?.health || 'skipped',
    cleaned: false,
    activated_at: '',
    error: error?.message || String(error),
    code: error?.code || '',
  }
}

function skippedResult(host, reason, batch = 1) {
  return {
    host,
    ok: false,
    batch,
    previous: '',
    releaseDir: '',
    restarted: '',
    health: 'skipped',
    cleaned: false,
    activated_at: '',
    error: reason,
    code: 'HOST_SKIPPED',
    skipped: true,
  }
}

export async function deployRelease({
  remote,
  project,
  target,
  targetName = '',
  host = '',
  artifactPath = '',
  artifactDigest = '',
  releaseId,
  keep = 5,
  commit = '',
  onLog = null,
  onCanaryHold = null,
} = {}) {
  if (!remote) throw new Error('deployRelease 需要 remote')
  if (!target || !target.path) throw Object.assign(new Error('target 缺少 path，无法发布'), { code: 'PIPE_INVALID' })
  const release = remoteReleaseId(releaseId, hostsOf(target, host))
  if (!release) throw new Error('deployRelease 需要 releaseId')
  const hosts = hostsOf(target, host)
  if (hosts.length === 0) throw Object.assign(new Error('target.hosts 为空，无法发布'), { code: 'PIPE_INVALID' })
  const keepCount = Number.isInteger(keep) && keep > 0 ? keep : (Number.isInteger(target.keep) ? target.keep : 5)
  const failMode = target.onHostFailure === 'continue' ? 'continue' : 'stop'

  const canarySpec = target.canary && Number.isInteger(target.canary.first) && target.canary.first >= 1
    ? { first: Math.min(target.canary.first, hosts.length), waitSec: Number.isInteger(target.canary.waitSec) ? target.canary.waitSec : 30 }
    : null
  const firstCount = canarySpec ? canarySpec.first : hosts.length
  const split = Boolean(canarySpec) && firstCount < hosts.length
  const batchOf = (index) => (split && index >= firstCount ? 2 : 1)

  const results = []
  let stopped = false
  for (let index = 0; index < hosts.length; index += 1) {
    const current = hosts[index]
    const batch = batchOf(index)
    if (stopped) {
      results.push(skippedResult(current, `前一台主机失败（${batch === 1 ? '灰度首批失败' : `onHostFailure=${failMode}`}），已跳过`, batch))
      continue
    }
    if (split && batch === 2 && index === firstCount) {
      const firstHosts = hosts.slice(0, firstCount)
      const restCount = hosts.length - firstCount
      const waitSec = canarySpec.waitSec
      logLine(onLog, `[canary] 第一批 ${firstCount} 台成功，等待 ${waitSec}s 后发剩余 ${restCount} 台`)
      try { onCanaryHold?.({ waitSec, first: firstCount, remaining: restCount, hosts: firstHosts }) } catch { /* audit observers must not break a deploy */ }
      if (waitSec > 0) await delay(waitSec * 1000)
    }
    logLine(onLog, `[${current}] deploy ${release} 开始（${index + 1}/${hosts.length}，batch ${batch}）`)
    try {
      results.push(await deployOne({ remote, target, host: current, artifactPath, artifactDigest, releaseId: release, keep: keepCount, commit, batch, onLog }))
    } catch (error) {
      const failed = failureResult(current, error, batch)
      results.push(failed)
      logLine(onLog, `[${current}] deploy 失败：${failed.error}`)
      // 灰度首批失败永远停：即便 onHostFailure=continue，也不再发剩余主机。
      // 未启用灰度时，batch 1 就是全部主机，仍按 onHostFailure 决定是否继续。
      if ((split && batch === 1) || failMode !== 'continue') stopped = true
    }
  }

  const ok = results.length > 0 && results.every((item) => item.ok)
  const first = results[0] || {}
  const batchList = split
    ? [
        { index: 1, hosts: hosts.slice(0, firstCount), ok: results.slice(0, firstCount).every((item) => item.ok) },
        { index: 2, hosts: hosts.slice(firstCount), ok: results.slice(firstCount).every((item) => item.ok) },
      ]
    : [{ index: 1, hosts: hosts.slice(), ok: results.every((item) => item.ok) }]
  return {
    releaseId: release,
    target: targetName || '',
    ok,
    hosts: results,
    canary: {
      first: canarySpec ? canarySpec.first : 0,
      waitSec: canarySpec ? canarySpec.waitSec : 0,
      batches: batchList,
    },
    // 单主机兼容字段：老调用方/渲染器仍然读这些键
    host: first.host || '',
    releaseDir: first.releaseDir || '',
    previous: first.previous || '',
    restarted: first.restarted || '',
    health: first.health || 'skipped',
    cleaned: Boolean(first.cleaned),
    activated_at: first.activated_at || '',
    error: ok ? '' : (results.find((item) => !item.ok)?.error || ''),
  }
}

export async function rollbackOne({ remote, target, host, releaseId, commit, onLog, actuatorFactory = null }) {
  const targetPath = String(target.path).replace(/\/+$/, '')
  const currentLink = `${targetPath}/current`
  let wanted = releaseId
  if (!wanted) {
    const previous = await previousRelease({ remote, host, currentLink })
    wanted = previous
  }
  if (!wanted) {
    const error = new Error(`[${host}] 没有指定 releaseId，也没有读到当前 current 指向的版本`)
    error.code = 'RELEASE_NOT_FOUND'
    throw error
  }
  const dir = releaseDir(target, wanted)
  const exists = await remote.exec(host, `test -d ${shellQuote(dir)} && echo yes || echo no`)
  if (!/yes/.test(String(exists?.stdout || ''))) {
    const error = new Error(`[${host}] release ${wanted} 不存在：${dir}`)
    error.code = 'RELEASE_NOT_FOUND'
    throw error
  }

  const stamp = new Date().toISOString()
  if (target.mode === 'k8s') {
    // K8s 的回滚不切镜像、不删 pod：`rollout undo` 是唯一会把控制器内部记账一起退回去的操作。
    // 与部署补偿共用同一个 Actuator 的 revert，两条回滚路径才不会各自漂移。
    const factory = actuatorFactory || createK8sActuator
    const actuator = factory({ host: hostBound(remote, host), target, hostName: host, onLog })
    // 回滚现场只能从那份 release 自己的 manifest 读：集群当前跑的是新版，本地软链也指着新版。
    const handle = {
      host, mode: 'k8s', releaseId: wanted, dir,
      image: target.image || '', imageDigest: '', imageReference: '',
      namespace: target.k8s?.namespace || 'default',
      workload: target.k8s?.workload || target.app || '',
      kind: target.k8s?.kind || 'Deployment',
      containerName: target.k8s?.container || target.k8s?.workload || target.app || '',
      instances: [], pods: [], slots: { releaseAll: async () => {} },
      previous: wanted, previousImage: '', revision: 'rollback', pids: [], activatedAt: stamp,
    }
    let artifactDigest = ''
    try {
      const recorded = await remote.exec(host, `cat ${shellQuote(`${dir}/.dsh-manifest.json`)} 2>/dev/null || true`)
      const artifact = JSON.parse(String(recorded?.stdout || '').trim() || '{}').artifact || {}
      handle.previousImage = String(artifact.reference || (artifact.image && artifact.digest ? `${artifact.image}@${artifact.digest}` : ''))
      artifactDigest = String(artifact.digest || '')
    } catch { /* 没有 manifest 时，undo 由控制器决定退到哪一版，我们只负责如实报告结果 */ }
    const reverted = await actuator.revert(handle)
    logLine(onLog, `[${host}] rollout undo（回滚到 ${wanted} 之前的版本）`)
    const verdict = await actuator.health({ ...handle, pods: reverted?.pods || [] })
    if (verdict && verdict.ok === false) {
      const error = new Error(`[${host}] 回滚后健康检查失败（${verdict.detail || verdict.layer || target.health?.http || ''}）`)
      error.code = 'HEALTH_FAILED'
      error.health = 'failed'
      error.restarted = 'k8s'
      throw error
    }
    return {
      host,
      ok: true,
      batch: 1,
      releaseId: wanted,
      releaseDir: dir,
      restarted: 'k8s',
      health: verdict?.ok === false ? 'failed' : 'ok',
      previous: '',
      cleaned: false,
      activated_at: stamp,
      artifactDigest,
      instances: [],
      pods: reverted?.pods || [],
      error: '',
      code: '',
    }
  }
  if (target.mode === 'container') {
    // 容器的回滚不是「换个软链、重启一下」：上一版跑的是另一个镜像，
    // 旧容器必须停掉、旧 digest 必须重新 pull 起来。走容器 Actuator 的 revert，
    // 与部署补偿用的是同一段代码，避免两条回滚路径各自漂移。
    const factory = actuatorFactory || createContainerActuator
    const actuator = factory({ host: hostBound(remote, host), target, hostName: host, onLog })
    // rollback 只读一条事实：current 现在指向谁。那一版的 digest 从它自己的 manifest 读，
    // 而不是从数据库或本次参数里带 —— 回滚要的是当时部署了什么。
    const handle = {
      host, mode: 'container', releaseId: wanted, dir,
      image: target.container?.image || '', imageDigest: '',
      imageReference: '', containers: [], instances: [],
      previous: wanted, previousImage: '', pids: [], activatedAt: stamp,
    }
    // v3.0-P5-5：容器回滚同样只认 manifest 里的 digest。镜像字节本身由 registry 按 digest 寻址，
    // 但「回滚到哪一版」这件事只能从那一版的 manifest 读，不能从 tag 或本次参数推。
    let artifactDigest = ''
    try {
      const recorded = await remote.exec(host, `cat ${shellQuote(`${dir}/.dsh-manifest.json`)} 2>/dev/null || true`)
      const artifact = JSON.parse(String(recorded?.stdout || '').trim() || '{}').artifact || {}
      handle.previousImage = String(artifact.reference || (artifact.image && artifact.digest ? `${artifact.image}@${artifact.digest}` : ''))
      artifactDigest = String(artifact.digest || '')
    } catch { /* 老 release 没有 manifest：revert 会用 CONTAINER_IMAGE_INVALID 明说，而不是按 tag 猜 */ }
    const reverted = await actuator.revert(handle, { drainSec: target.instances?.drain?.seconds || 0 })
    logLine(onLog, `[${host}] current -> releases/${wanted}（回滚）`)
    const verdict = await actuator.health({ ...handle, activatedAt: stamp, containers: reverted?.containers || [] })
    if (verdict && verdict.ok === false) {
      const error = new Error(`[${host}] 回滚后健康检查失败（${verdict.detail || verdict.layer || target.health?.http || ''}）`)
      error.code = 'HEALTH_FAILED'
      error.health = 'failed'
      error.restarted = 'container'
      throw error
    }
    return {
      host,
      ok: true,
      batch: 1,
      releaseId: wanted,
      releaseDir: dir,
      restarted: 'container',
      health: verdict?.ok === false ? 'failed' : 'ok',
      previous: '',
      cleaned: false,
      activated_at: stamp,
      artifactDigest,
      instances: (reverted?.instances || handle.instances || []),
      error: '',
      code: '',
    }
  }
  // v3.0-P5-5：切软链之前先核对字节。native 的 release 目录里躺着一份制品，
  // 它是回滚现场唯一的实体；这份实体被换掉而软链照切，就是「回滚到一个别的版本」。
  //
  // 核对是「能核对就必须对得上」，不是「必须有 manifest」：v3.0 之前的 release 目录里
  // 没有 .dsh-manifest.json，而那些发布正是此刻最可能被回滚到的东西。没有 manifest 时退回
  // 库里那一行的 digest，仍然拿磁盘字节重算一遍；两处都没有记录才放过 —— 那种情况下
  // 拦住回滚只会让人在事故里手工 ln -sfn，反而更危险。记录在、字节对不上，就一律拦。
  const expectedDigest = String(target.digest || '')
  let manifestDigest = ''
  let manifestPath = ''
  try {
    const target0 = await readReleaseDigest({ remote, host, releaseDir: dir })
    manifestDigest = target0.digest
    manifestPath = String(target0.path || '')
  } catch (error) {
    if (error.code !== 'RELEASE_NOT_FOUND' && error.code !== 'MANIFEST_INVALID') throw error
    logLine(onLog, `[${host}] releases/${wanted} 没有可用的 manifest（${error.code}），改用账本里的 digest 核对`)
  }
  const pinnedDigest = expectedDigest || manifestDigest
  if (pinnedDigest) {
    // manifest 里没有绝对路径时，按 actuator.stage 的落盘约定推回来：<release dir>/<原文件名>。
    const stagedName = String(manifestPath || '').split(/[\\/]/).filter(Boolean).pop() || ''
    await verifyRemoteArtifact({ remote, host, artifactPath: `${dir}/${stagedName}`, digest: pinnedDigest })
  }
  await remote.exec(host, `ln -sfn ${shellQuote(`releases/${wanted}`)} ${shellQuote(currentLink)}`)
  await remote.exec(host, `echo ${shellQuote(`${stamp} rollback:${wanted} ${commit}`)} >> ${shellQuote(`${targetPath}/revisions.log`)}`)
  logLine(onLog, `[${host}] current -> releases/${wanted}（回滚，${pinnedDigest ? pinnedDigest.slice(0, 19) + '… 已核对' : '无 digest 记录，跳过核对'}）`)
  const restarted = await restartTarget({ remote, host, target, onLog })
  const health = await healthCheck({ remote, host, target, onLog })
  if (health === 'failed') {
    const error = new Error(`[${host}] 回滚后健康检查失败（${target.health?.http || ''}）`)
    error.code = 'HEALTH_FAILED'
    error.health = 'failed'
    error.restarted = restarted
    throw error
  }
  return {
    host,
    ok: true,
    batch: 1,
    releaseId: wanted,
    releaseDir: dir,
    restarted,
    health,
    previous: '',
    cleaned: false,
    activated_at: stamp,
    artifactDigest: pinnedDigest,
    error: '',
    code: '',
  }
}

export async function rollbackRelease({
  remote,
  target,
  targetName = '',
  host = '',
  releaseId = '',
  commit = '',
  onLog = null,
  actuatorFactory = null,
} = {}) {
  if (!remote) throw new Error('rollbackRelease 需要 remote')
  if (!target || !target.path) throw Object.assign(new Error('target 缺少 path，无法回滚'), { code: 'PIPE_INVALID' })
  const hosts = hostsOf(target, host)
  if (hosts.length === 0) throw Object.assign(new Error('target.hosts 为空，无法回滚'), { code: 'PIPE_INVALID' })
  const wanted = remoteReleaseId(releaseId, hosts)

  const results = []
  for (const current of hosts) {
    logLine(onLog, `[${current}] rollback ${wanted || 'current'} 开始`)
    try {
      results.push(await rollbackOne({ remote, target, host: current, releaseId: wanted, commit, onLog, actuatorFactory }))
    } catch (error) {
      const failed = failureResult(current, error)
      results.push(failed)
      logLine(onLog, `[${current}] rollback 失败：${failed.error}`)
    }
  }

  const ok = results.length > 0 && results.every((item) => item.ok)
  const first = results[0] || {}
  const failed = results.find((item) => !item.ok)
  return {
    releaseId: first.releaseId || wanted,
    target: targetName || '',
    ok,
    hosts: results,
    host: first.host || '',
    releaseDir: first.releaseDir || '',
    restarted: first.restarted || '',
    health: first.health || 'skipped',
    activated_at: first.activated_at || '',
    error: ok ? '' : (failed?.error || ''),
    code: ok ? '' : (failed?.code || 'HOST_FAILED'),
  }
}