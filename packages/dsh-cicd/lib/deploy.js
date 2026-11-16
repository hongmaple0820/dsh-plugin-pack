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
 */

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function releaseDir(target, releaseId) {
  return `${String(target.path || '').replace(/\/+$/, '')}/releases/${releaseId}`
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
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

function logLine(onLog, line) {
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

async function deployOne({
  remote,
  target,
  host,
  artifactPath,
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
      results.push(await deployOne({ remote, target, host: current, artifactPath, releaseId: release, keep: keepCount, commit, batch, onLog }))
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

async function rollbackOne({ remote, target, host, releaseId, commit, onLog }) {
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

  await remote.exec(host, `ln -sfn ${shellQuote(`releases/${wanted}`)} ${shellQuote(currentLink)}`)
  const stamp = new Date().toISOString()
  await remote.exec(host, `echo ${shellQuote(`${stamp} rollback:${wanted} ${commit}`)} >> ${shellQuote(`${targetPath}/revisions.log`)}`)
  logLine(onLog, `[${host}] current -> releases/${wanted}（回滚）`)
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
      results.push(await rollbackOne({ remote, target, host: current, releaseId: wanted, commit, onLog }))
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