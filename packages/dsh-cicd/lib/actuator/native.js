/**
 * The native actuator: symlink + restart, plus per-instance slots.
 *
 * Everything that differs between "native", "container" and "k8s" lives behind the five methods
 * below (stage / activate / health / stop / cleanup). The transaction, the compensation and the
 * verdicts live in lib/deploy-engine.js and are shared — that is the point: a K8s rollout that
 * pretends to be a symlink swap is a fake rollout, but a compensation table that pretends to know
 * about pods is a fake transaction. One shared transaction, three honest activators.
 *
 * ## The command vocabulary is deliberately closed
 *
 * Every shell command this file can emit is in `NATIVE_COMMANDS` below. That list is part of the
 * contract, not documentation: the test host in test/smoke.mjs implements exactly these shapes and
 * throws on anything else, so a new command added here fails the suite until someone also decides
 * how it behaves on a real box. The only open-ended command is `target.restart`, which is the
 * operator's own business — it is a template rendered per host/instance and executed verbatim.
 *
 * ## Why per-instance slots rather than "replicas"
 *
 * A replica count is a number a scheduler reconciles. An *instance* is a port, a pid, a log file
 * and a log line you can grep. "3 instances" that does not tell you which port the third one took
 * is not deployable by hand, and the day the controller is down is exactly the day you need to
 * deploy by hand. So: ports are allocated explicitly, written to a lock file on the host itself
 * (see lib/slots.js), and the pid is stamped back once the process is up.
 */

import { shellQuote } from '../deploy.js'
import { createSlotStore, SLOT_ERRORS } from '../slots.js'

/**
 * Every shell command shape the native actuator may emit. Kept as data so the test host can
 * implement exactly this list and fail loudly on anything new.
 */
export const NATIVE_COMMANDS = [
  'mkdir -p',
  'readlink',
  'ln -sfn',
  'rm -f',
  'echo >>',
  'test -d',
  'tar -xzf',
  'cat',
  'printf >',
  'printf noclobber',
  'kill -0',
  'kill -TERM',
  'kill -KILL',
  'ls -1',
  'ls -1dt',
  'ss -ltn',
  'ss -ltnp',
  'curl',
  'restart-template',
  'manifest',
]

export const ACTUATOR_ERRORS = {
  STAGE: 'ACTUATOR_STAGE_FAILED',
  ACTIVATE: 'ACTUATOR_ACTIVATE_FAILED',
  HEALTH: 'HEALTH_FAILED',
  STOP: 'ACTUATOR_STOP_FAILED',
  SLOT: 'SLOT_INVALID',
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

function logLine(onLog, line) {
  try { onLog?.(line) } catch { /* observers must never break a deploy */ }
}

function secondsOf(value, fallbackSec) {
  if (value === undefined || value === null || value === '') return fallbackSec
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/.exec(String(value).trim())
  if (!match) return fallbackSec
  const amount = Number(match[1])
  return match[2] === 'ms' ? amount / 1000 : match[2] === 'm' ? amount * 60 : amount
}

function trimEnd(value) {
  return String(value || '').replace(/\/+$/, '')
}

/**
 * Render `{{.port}}` / `{{.slot}}` / `{{.host}}` / `{{.release}}` / `{{.app}}` / `{{.instance}}`.
 * Deliberately not the expression engine from lib/expr.js: this text is going to be handed to a
 * shell on a remote box, and a general expression language there would be a second, quieter
 * injection surface. Only these six placeholders exist; anything else is left as-is so a typo
 * shows up in the log instead of silently expanding to an empty string.
 */
export function renderTemplate(text, vars) {
  if (typeof text !== 'string') return ''
  return text.replace(/\{\{\s*\.([A-Za-z_]\w*)\s*\}\}/g, (whole, key) => (
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? '') : whole
  ))
}

/** Extract the pid that owns a listening port, from `ss -ltnp`. */
export function parseSSpid(stdout, port) {
  const text = String(stdout || '')
  const wanted = Number(port)
  for (const line of text.split('\n')) {
    if (!line.includes(`:${wanted} `) && !line.trimEnd().endsWith(`:${wanted}`)) continue
    const match = /pid=(\d+)/.exec(line)
    if (match) return Number(match[1])
  }
  return 0
}

/**
 * @param {object} options
 * @param {{exec: Function, uploadFile: Function}} options.host  bound to one host
 * @param {object} options.target    normalised target (path / restart / health / instances / keep)
 * @param {string} options.hostName
 * @param {(line:string)=>void} [options.onLog]
 * @param {() => number} [options.now]
 */
export function createNativeActuator({ host, target, hostName, onLog, now = Date.now }) {
  if (!host || typeof host.exec !== 'function') throw new Error('native actuator 需要 host.exec')
  const targetPath = trimEnd(target.path)
  const currentLink = `${targetPath}/current`
  const slots = createSlotStore({ run: (command, opts) => host.exec(command, opts), root: targetPath, now })

  const instancesSpec = target.instances && Number(target.instances.count) > 0 ? target.instances : null
  const instanceCount = instancesSpec ? Math.trunc(Number(instancesSpec.count)) : 0
  const portBase = instancesSpec?.port?.base
  const portStep = Number(instancesSpec?.port?.step) || 1
  const drainSec = secondsOf(instancesSpec?.drain?.delay, 5)
  const drainTimeoutSec = secondsOf(instancesSpec?.drain?.timeout, 30)

  function instanceVars(index, releaseId) {
    const vars = {
      host: hostName,
      release: releaseId,
      app: target.app || '',
      index,
      port: '',
      slot: '',
      instance: '',
    }
    return vars
  }

  async function discoverPid(port) {
    const listed = await host.exec(`ss -ltnp 2>/dev/null || true`)
    const pid = parseSSpid(listed?.stdout, port)
    if (pid > 0) return pid
    return 0
  }

  /**
   * Phase 1 — stage. Put the bytes on disk under releases/<id>/ and allocate slots, without
   * touching `current` and without starting anything that could take traffic.
   */
  async function stage({ releaseId, artifactPath }) {
    const dir = `${targetPath}/releases/${releaseId}`
    await host.exec(`mkdir -p ${shellQuote(dir)}`)
    logLine(onLog, `[${hostName}] stage: ${dir}`)

    if (artifactPath) {
      const name = String(artifactPath).split(/[\\/]/).pop()
      await host.uploadFile(artifactPath, `${dir}/${name}`)
      logLine(onLog, `[${hostName}] stage: uploaded ${name}`)
      if (/\.(tgz|tar\.gz)$/i.test(name)) {
        await host.exec(`tar -xzf ${shellQuote(`${dir}/${name}`)} -C ${shellQuote(dir)}`)
        logLine(onLog, `[${hostName}] stage: extracted ${name}`)
      }
    }

    const handle = {
      host: hostName,
      releaseId,
      dir,
      artifactName: artifactPath ? String(artifactPath).split(/[\\/]/).pop() : '',
      slots: [],
      instances: [],
      previous: '',
      stagedAt: new Date(now()).toISOString(),
      activatedAt: '',
      pids: [],
    }

    if (instanceCount > 0) {
      const allocated = await slots.allocate({
        count: instanceCount,
        base: portBase,
        step: portStep,
        releaseId,
        instancePrefix: `${hostName}`,
        startSlot: 0,
      })
      if (!allocated.ok) {
        const holder = allocated.failed?.holder || {}
        const error = new Error(
          `[${hostName}] 端口 ${allocated.failed?.port} 被占用（pid ${holder.pid || '?'}，release ${holder.releaseId || '?'}）——槽位锁没有回收，先确认那个进程是不是还活着`,
        )
        error.code = SLOT_ERRORS.EXHAUSTED
        error.port = allocated.failed?.port
        error.holder = holder
        throw error
      }
      if (allocated.reclaimed.length > 0) {
        logLine(onLog, `[${hostName}] 回收僵尸槽位：${allocated.reclaimed.map((item) => item.port).join(',')}`)
      }
      handle.slots = allocated.ports
      handle.instances = allocated.ports.map((port, index) => {
        const vars = instanceVars(index, releaseId)
        vars.port = port
        vars.slot = index
        vars.instance = `${hostName}/${index}`
        return {
          index,
          slot: index,
          port,
          instanceId: `${hostName}/${index}`,
          env: { ...(instancesSpec?.env || {}) },
          envRendered: Object.fromEntries(
            Object.entries(instancesSpec?.env || {}).map(([key, value]) => [key, renderTemplate(String(value), vars)]),
          ),
          logPath: renderTemplate(String(instancesSpec?.log || ''), vars),
          pid: 0,
          startedAt: '',
          stoppedAt: '',
        }
      })
      logLine(onLog, `[${hostName}] slots: ${handle.slots.join(',')}`)
    }

    return handle
  }

  /** Phase 2 — activate. Swap `current`, then (re)start the instance processes. */
  async function activate(handle) {
    const read = await host.exec(`readlink ${shellQuote(currentLink)} || true`)
    handle.previous = (() => {
      const text = String(read?.stdout || '').trim()
      if (!text) return ''
      const match = /(?:^|\/)releases\/([^/\s]+)\/?$/.exec(text)
      return match ? match[1] : (text.split('/').filter(Boolean).pop() || '')
    })()

    await host.exec(`ln -sfn ${shellQuote(`releases/${handle.releaseId}`)} ${shellQuote(currentLink)}`)
    logLine(onLog, `[${hostName}] activate: current -> releases/${handle.releaseId}`)

    const stamp = new Date(now()).toISOString()
    await host.exec(
      `echo ${shellQuote(`${stamp} ${handle.releaseId} activate`)} >> ${shellQuote(`${targetPath}/revisions.log`)}`,
    )
    handle.activatedAt = stamp

    if (instanceCount > 0) {
      await startInstances(handle, handle.releaseId)
    } else if (String(target.restart || '').trim()) {
      const command = renderTemplate(String(target.restart), instanceVars(0, handle.releaseId))
      logLine(onLog, `[${hostName}] activate: ${command}`)
      await host.exec(command)
    } else if (target.service) {
      const command = `systemctl --user restart ${shellQuote(target.service)} || sudo -n systemctl restart ${shellQuote(target.service)} || true`
      logLine(onLog, `[${hostName}] activate: ${command}`)
      await host.exec(command)
    } else if (target.restartCommand) {
      logLine(onLog, `[${hostName}] activate: ${target.restartCommand}`)
      await host.exec(target.restartCommand)
    } else {
      logLine(onLog, `[${hostName}] activate: 没有 service / restart / runtime 预设，只切换软链`)
    }
    return handle
  }

  /**
   * Phase 3a — L1: every instance must have a live pid and a listening port.
   * A dead process is not a slow process; retrying it only wastes the observation window.
   */
  async function l1(handle) {
    if (instanceCount === 0) {
      // 单实例/无实例：refresh 后连端口都不由我们持有，L1 只能确认 restart 命令没抛错，
      // 真正的判断交给 L2。不要在这里编造一个「进程存活」的结论。
      return { ok: true, layer: 'l1', detail: 'no per-instance pids to check (single-process target)' }
    }
    const problems = []
    for (const instance of handle.instances) {
      const alive = instance.pid > 0
        ? /yes/.test(String((await host.exec(`kill -0 ${instance.pid} 2>/dev/null && echo yes || echo no`))?.stdout || ''))
        : false
      const listening = /yes/.test(String((await host.exec(
        `(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -qE '[:.]${instance.port}[[:space:]]*$' && echo yes || echo no`,
      ))?.stdout || ''))
      if (!alive || !listening) {
        problems.push({ instanceId: instance.instanceId, port: instance.port, pid: instance.pid, alive, listening })
      }
    }
    return problems.length === 0
      ? { ok: true, layer: 'l1', detail: `${handle.instances.length} 个实例进程存活且端口在听` }
      : { ok: false, layer: 'l1', detail: `${problems.length} 个实例没起来`, problems }
  }

  /**
   * Phase 3b — L2: readiness. One HTTP probe per instance port when `health.http` is templated,
   * otherwise the target-wide probe. This is where "the process is up but cannot reach its DB"
   * gets caught, and it is why L1 alone is not enough.
   */
  async function l2(handle, { tries, intervalSec } = {}) {
    const template = String(target.health?.http || '')
    if (!template) return { ok: true, layer: 'l2', detail: 'target 没有配置 health.http，跳过就绪探针' }
    const attempts = Number.isInteger(tries) && tries > 0 ? tries : (Number.isInteger(target.health?.tries) ? target.health.tries : 5)
    const gap = Number.isFinite(intervalSec) ? intervalSec : secondsOf(target.health?.interval, 2)
    const expect = target.health?.expect === undefined ? 0 : Number(target.health.expect)

    const targets = instanceCount > 0
      ? handle.instances.map((instance) => {
          const vars = instanceVars(instance.index, handle.releaseId)
          vars.port = instance.port
          vars.slot = instance.slot
          vars.instance = instance.instanceId
          return { label: instance.instanceId, url: renderTemplate(template, vars) }
        })
      : [{ label: hostName, url: renderTemplate(template, instanceVars(0, handle.releaseId)) }]

    for (const item of targets) {
      let last = null
      let passed = false
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          const probe = await host.exec(`curl -fsS --max-time 5 ${shellQuote(item.url)}`, { timeoutSec: 10 })
          last = probe
          const code = Number(probe?.exitCode ?? 0)
          if (code === expect) { passed = true; break }
        } catch (error) {
          last = { exitCode: 1, stderr: error.message }
        }
        if (attempt < attempts) await delay(gap * 1000)
      }
      if (!passed) {
        return {
          ok: false,
          layer: 'l2',
          detail: `${item.label} 就绪探针失败：${item.url}${last?.stderr ? `（${String(last.stderr).slice(0, 200)}）` : ''}`,
          url: item.url,
          label: item.label,
        }
      }
      logLine(onLog, `[${hostName}] l2 ok ${item.label} ${item.url}`)
    }
    return { ok: true, layer: 'l2', detail: `${targets.length} 个探针全部通过` }
  }

  /**
   * Phase 3c — L3: the observation window. Deliberately *not* a metric query: this package has no
   * access to the application's metrics, and inventing an error-rate number from health probes
   * would be a lie that gets trusted. What it does is keep probing for the whole window and fail
   * if any probe fails — a real "it came up and then died" detector, with the honest name.
   */
  async function l3(handle, { windowSec, intervalSec } = {}) {
    const window = Number.isFinite(windowSec) ? windowSec : secondsOf(target.health?.window, 0)
    if (!(window > 0)) return { ok: true, layer: 'l3', detail: '未配置观察窗，跳过（health.window=0）' }
    const gap = Number.isFinite(intervalSec) ? intervalSec : Math.max(1, Math.min(5, window / 4))
    const deadline = now() + window * 1000
    let samples = 0
    while (now() < deadline) {
      const result = await l2(handle, { tries: 1, intervalSec: 0 })
      samples += 1
      if (!result.ok) return { ok: false, layer: 'l3', detail: `观察窗第 ${samples} 次探针失败：${result.detail}`, samples }
      const remaining = deadline - now()
      if (remaining <= 0) break
      await delay(Math.min(gap * 1000, remaining))
    }
    return { ok: true, layer: 'l3', detail: `观察窗 ${window}s 内 ${samples} 次探针全部通过`, samples }
  }

  async function health(handle, options = {}) {
    const first = await l1(handle)
    if (!first.ok) return { ok: false, ...first, layers: [first] }
    const second = await l2(handle, options)
    if (!second.ok) return { ok: false, ...second, layers: [first, second] }
    const third = await l3(handle, options)
    if (!third.ok) return { ok: false, ...third, layers: [first, second, third] }
    return { ok: true, layer: third.layer, detail: third.detail, layers: [first, second, third] }
  }

  /**
   * Compensation — put this host back the way it was before `activate`.
   *
   * This is *not* `rollback` (the user-facing operation): nobody asked for it, it happens because a
   * later host failed and the fleet must not be left half-new. So it is deliberately blunt: stop
   * what we started, point `current` back, start the previous code on the same ports, and never
   * throw — the caller is already reporting the original failure, and a compensation that throws
   * replaces the real diagnosis with a second, less useful one.
   */
  async function revert(handle, { drainSec: drainOverride, timeoutSec: timeoutOverride } = {}) {
    const notes = []
    if (instanceCount === 0 && !handle.activatedAt) return { ok: true, reverted: false, notes: ['尚未激活，无需补偿'] }
    try {
      const stopped = await stop(handle, { drainSec: Number.isFinite(drainOverride) ? drainOverride : 0, timeoutSec: timeoutOverride })
      notes.push(`已停 ${stopped.stopped.length} 个实例`)
    } catch (error) {
      notes.push(`停进程失败：${error.message}`)
    }
    const previous = String(handle.previous || '')
    try {
      if (previous) {
        await host.exec(`ln -sfn ${shellQuote(`releases/${previous}`)} ${shellQuote(currentLink)}`)
        const stamp = new Date(now()).toISOString()
        await host.exec(
          `echo ${shellQuote(`${stamp} rollback:${previous} compensate`)} >> ${shellQuote(`${targetPath}/revisions.log`)}`,
        )
        logLine(onLog, `[${hostName}] compensate: current -> releases/${previous}`)
        if (instanceCount > 0) await startInstances(handle, previous)
        else if (String(target.restart || '').trim()) {
          await host.exec(renderTemplate(String(target.restart), instanceVars(0, previous)))
        } else if (target.service) {
          await host.exec(`systemctl --user restart ${shellQuote(target.service)} || sudo -n systemctl restart ${shellQuote(target.service)} || true`)
        } else if (target.restartCommand) {
          await host.exec(target.restartCommand)
        }
        notes.push(`已指回 releases/${previous}`)
      } else {
        await host.exec(`rm -f ${shellQuote(currentLink)}`)
        logLine(onLog, `[${hostName}] compensate: 没有 previous，移除 current 软链`)
        notes.push('没有 previous，已移除 current')
      }
    } catch (error) {
      notes.push(`指回 previous 失败：${error.message}`)
    }
    return { ok: true, reverted: Boolean(previous), previous, notes }
  }

  /**
   * Order matters and is not negotiable: stop traffic (current already points elsewhere when we
   * are rolling back), wait out drain.delay, SIGTERM, wait, SIGKILL. Killing before draining cuts
   * live requests and turns a deploy into an error spike.
   */
  async function stop(handle, { drainSec: drainOverride, timeoutSec: timeoutOverride } = {}) {
    const drainWait = Number.isFinite(drainOverride) ? drainOverride : drainSec
    const killWait = Number.isFinite(timeoutOverride) ? timeoutOverride : drainTimeoutSec
    if (drainWait > 0) {
      logLine(onLog, `[${hostName}] drain: 等待 ${drainWait}s 再停进程`)
      await delay(drainWait * 1000)
    }
    const stopped = []
    for (const instance of handle.instances || []) {
      if (!(instance.pid > 0)) continue
      await host.exec(`kill -TERM ${instance.pid} 2>/dev/null || true`)
      logLine(onLog, `[${hostName}] ${instance.instanceId} SIGTERM ${instance.pid}`)
      const deadline = now() + killWait * 1000
      let dead = false
      while (now() < deadline) {
        const alive = /yes/.test(String((await host.exec(`kill -0 ${instance.pid} 2>/dev/null && echo yes || echo no`))?.stdout || ''))
        if (!alive) { dead = true; break }
        await delay(Math.min(1000, Math.max(100, deadline - now())))
      }
      if (!dead) {
        await host.exec(`kill -KILL ${instance.pid} 2>/dev/null || true`)
        logLine(onLog, `[${hostName}] ${instance.instanceId} SIGKILL ${instance.pid}（${killWait}s 内没有退出）`)
      }
      instance.stoppedAt = new Date(now()).toISOString()
      stopped.push({ instanceId: instance.instanceId, pid: instance.pid, killed: !dead })
    }
    return { ok: true, stopped }
  }

  /**
   * Start (or restart) every instance of `handle` from `releaseId`. Extracted from activate because
   * compensation needs exactly the same loop with a different release: during rollback we stop the
   * new processes and start the *previous* code on the *same* ports.
   */
  async function startInstances(handle, releaseId) {
    const template = String(target.restart || '')
    if (!template.trim()) {
      const error = new Error(
        `[${hostName}] 声明了 instances 却没有任何 restart 命令——多实例重启必须由 target.restart 模板给出（可用 {{.port}} / {{.slot}} / {{.host}} / {{.release}}）`,
      )
      error.code = ACTUATOR_ERRORS.ACTIVATE
      throw error
    }
    for (const instance of handle.instances) {
      const vars = instanceVars(instance.index, releaseId)
      vars.port = instance.port
      vars.slot = instance.slot
      vars.instance = instance.instanceId
      let command = renderTemplate(template, vars)
      // 每个实例有自己的日志：多个进程写同一个文件时，按行交织的日志无法归因到实例。
      if (instance.logPath) {
        command = `mkdir -p ${shellQuote(instance.logPath.replace(/\/[^/]*$/, ''))} && ${command} >> ${shellQuote(instance.logPath)} 2>&1`
      }
      logLine(onLog, `[${hostName}] start: ${instance.instanceId} port ${instance.port}: ${command}`)
      await host.exec(command)
      instance.startedAt = new Date(now()).toISOString()
      instance.releaseId = releaseId
      const pid = await discoverPid(instance.port)
      instance.pid = pid
      handle.pids.push(pid)
      if (pid > 0) {
        await slots.stampPid({
          port: instance.port,
          pid,
          releaseId,
          instanceId: instance.instanceId,
          slot: instance.slot,
        })
      }
      logLine(onLog, `[${hostName}] ${instance.instanceId} pid ${pid || '?'}`)
    }
  }

  /** Phase 4a — commit: keep N releases, release the slots we no longer hold. */
  async function cleanup(handle, { keep } = {}) {
    const keepCount = Number.isInteger(keep) && keep > 0 ? keep : (Number.isInteger(target.keep) ? target.keep : 5)
    const command = `ls -1dt ${shellQuote(`${targetPath}/releases`)}/*/ 2>/dev/null | tail -n +${keepCount + 1} | xargs -r rm -rf`
    try { await host.exec(command) } catch { /* cleanup is best-effort */ }
    return { ok: true, keep: keepCount }
  }

  async function writeManifest(handle, extra = {}) {
    const manifest = {
      version: 1,
      host: hostName,
      releaseId: handle.releaseId,
      previous: handle.previous,
      target: { name: extra.targetName || '', path: targetPath, mode: target.mode || 'native', runtime: target.runtime || '' },
      artifact: { path: extra.artifactPath || '', digest: extra.artifactDigest || '' },
      instances: (handle.instances || []).map((instance) => ({
        instanceId: instance.instanceId,
        slot: instance.slot,
        port: instance.port,
        pid: instance.pid,
        env: instance.envRendered,
        log: instance.logPath,
      })),
      health: { http: target.health?.http || '', window: secondsOf(target.health?.window, 0) },
      strategy: extra.strategy || '',
      commit: extra.commit || '',
      runId: extra.runId || '',
      operator: extra.operator || '',
      activatedAt: handle.activatedAt,
      writtenAt: new Date(now()).toISOString(),
    }
    const body = JSON.stringify(manifest, null, 2)
    await host.exec(`printf '%s' ${shellQuote(body)} > ${shellQuote(`${handle.dir}/.dsh-manifest.json`)}`)
    // 同时写一份「看得懂的」：主机失联时运维只能靠 ssh 手工回滚，而 JSON 需要工具才读得出
    // 端口和 pid。这一行文本不是给程序的，是给人眼看的。
    const summary = [
      `release: ${manifest.releaseId}`,
      `previous: ${manifest.previous || '(none)'}`,
      `path: ${targetPath}`,
      ...manifest.instances.map((item) => `instance: ${item.instanceId} port=${item.port} pid=${item.pid} log=${item.log}`),
    ].join('\n')
    await host.exec(`printf '%s' ${shellQuote(summary)} > ${shellQuote(`${handle.dir}/.dsh-manifest.txt`)}`)
    return manifest
  }

  return { hostName, targetPath, slots, instanceCount, stage, activate, revert, health, l1, l2, l3, stop, cleanup, writeManifest, discoverPid, startInstances }
}
