/**
 * V2-M1：进程内调度器（无第三方依赖）。
 *
 * 两条腿：
 * 1. cron tick：每 tickSec 秒跑一次，用 cronMatches 判断当前分钟是否命中；同一 scheduleId
 *    在同一分钟内只触发一次（状态落盘，DSH 重启后不会重复触发同一分钟）。
 * 2. git push 轮询：每 pollSec 秒 `git fetch` 一次，比较 `origin/<branch>` 的 sha 与上次记录；
 *    sha 变化（或首次基线之后新出现的匹配分支）就触发一次 push 运行。轮询只覆盖分支，
 *    tag push 需要 webhook 入站（`/hooks/<project>`）。
 *
 * 触发动作本身由宿主注入的 run() 完成（宿主负责 deploy lock、生产确认、通知、取消等）。
 * 串行执行：tick / poll 内部持有 busy 标记，避免自重叠；不同项目顺序触发，简单可预测。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { cronMatches, minuteKey } from './cron.js'
import { fetchAsync, remoteBranches } from './git.js'
import { matchPushRef } from './triggers.js'

const STATE_VERSION = 1

function emptyState() {
  return { version: STATE_VERSION, cron: {}, push: {} }
}

function loadState(file) {
  if (!file || !existsSync(file)) return emptyState()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return emptyState()
    return {
      version: STATE_VERSION,
      cron: parsed.cron && typeof parsed.cron === 'object' ? parsed.cron : {},
      push: parsed.push && typeof parsed.push === 'object' ? parsed.push : {},
    }
  } catch {
    return emptyState()
  }
}

function saveState(file, state) {
  if (!file) return
  try {
    mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.tmp`
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    renameSync(temp, file)
  } catch { /* 状态落盘失败不该影响调度本身（最多重启后重复触发一次） */ }
}

function isPlainPush(push) {
  return Boolean(push && (Array.isArray(push.branches) && push.branches.length || Array.isArray(push.tags) && push.tags.length))
}

function errorText(error) {
  return String(error?.message || error || '未知错误')
}

export function createScheduler({
  getProjects = () => [],
  readPipe = () => null,
  run = async () => ({}),
  defaultTarget = '',
  stateFile = '',
  now = () => new Date(),
  tickSec = 20,
  pollSec = 60,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  log = () => {},
} = {}) {
  const state = loadState(stateFile)
  const results = []
  const last = { tickAt: '', pollAt: '', error: '' }
  let tickTimer = null
  let pollTimer = null
  let started = false
  let ticking = false
  let polling = false

  const record = (entry) => {
    results.unshift({ at: new Date().toISOString(), ...entry })
    if (results.length > 20) results.length = 20
  }

  const pipeOf = (project) => {
    try {
      return readPipe(project) || null
    } catch (error) {
      last.error = `读取 ${project?.id || '?'} 的 pipe 失败：${errorText(error)}`
      return null
    }
  }

  const trigger = async (project, { target, kind, branch = '', commit = '' }) => {
    const resolvedTarget = target || defaultTarget
    try {
      log(`触发 ${project.id}（${kind}${branch ? ` ${branch}` : ''}）`)
      const result = await run({ project, target: resolvedTarget, trigger: kind, branch, commit })
      record({ project: project.id, trigger: kind, status: result?.status || 'ok', target: resolvedTarget, branch, commit })
      return result
    } catch (error) {
      last.error = `${project.id} ${kind} 触发失败：${errorText(error)}`
      record({ project: project.id, trigger: kind, status: 'failed', target: resolvedTarget, branch, commit, error: errorText(error) })
      return null
    }
  }

  /** 跑一次 cron 判断（date 可注入，测试用）。返回触发了哪些 schedule。 */
  async function tick(date = now()) {
    if (ticking) return { skipped: true, fired: [] }
    ticking = true
    const fired = []
    const key = minuteKey(date)
    try {
      for (const project of getProjects() || []) {
        const pipe = pipeOf(project)
        const schedule = pipe?.triggers?.schedule
        if (!Array.isArray(schedule) || schedule.length === 0) continue
        for (let index = 0; index < schedule.length; index += 1) {
          const item = schedule[index]
          if (!item || !item.cron) continue
          const scheduleId = `${project.id}#${index}`
          if (state.cron[scheduleId] === key) continue
          let matched = false
          try { matched = cronMatches(item.cron, date) } catch { matched = false }
          if (!matched) continue
          state.cron[scheduleId] = key
          saveState(stateFile, state)
          fired.push({ project: project.id, target: item.target || '', cron: item.cron })
          await trigger(project, { target: item.target || '', kind: 'schedule' })
        }
      }
      last.tickAt = new Date().toISOString()
      return { skipped: false, fired }
    } finally {
      ticking = false
    }
  }

  /** 轮询一次远端分支（可注入调用，测试用）。返回本轮触发的运行。 */
  async function pollOnce() {
    if (polling) return { skipped: true, fired: [] }
    polling = true
    const fired = []
    try {
      for (const project of getProjects() || []) {
        if (!project?.path) continue
        const pipe = pipeOf(project)
        const push = pipe?.triggers?.push
        if (!isPlainPush(push)) continue
        const fetched = await fetchAsync(project.path)
        if (!fetched) continue
        const branches = remoteBranches(project.path)
        if (branches.length === 0) continue
        const projectState = state.push[project.id] && typeof state.push[project.id] === 'object'
          ? state.push[project.id]
          : { ready: false, branches: {} }
        if (!projectState.branches || typeof projectState.branches !== 'object') projectState.branches = {}
        let dirty = false
        for (const branch of branches) {
          const matched = matchPushRef(push, `refs/heads/${branch.name}`).matched
          if (!matched) continue
          const previous = projectState.branches[branch.name]
          const changed = previous !== undefined && previous !== branch.sha
          const appeared = previous === undefined && projectState.ready === true
          projectState.branches[branch.name] = branch.sha
          dirty = true
          if (!changed && !appeared) continue
          fired.push({ project: project.id, branch: branch.name, sha: branch.sha })
          await trigger(project, { target: push.target || '', kind: 'push', branch: branch.name, commit: branch.sha })
        }
        // 首次轮询只建立基线，不触发（否则插件一启动就会把当前 HEAD 当成新 push 跑一遍）。
        if (projectState.ready !== true) { projectState.ready = true; dirty = true }
        state.push[project.id] = projectState
        if (dirty) saveState(stateFile, state)
      }
      last.pollAt = new Date().toISOString()
      return { skipped: false, fired }
    } finally {
      polling = false
    }
  }

  function start() {
    if (started) return false
    started = true
    const tickMs = Math.max(1, Number(tickSec) || 20) * 1000
    tickTimer = setIntervalImpl(() => { tick().catch((error) => { last.error = errorText(error) }) }, tickMs)
    tickTimer?.unref?.()
    if (Number(pollSec) > 0) {
      const pollMs = Math.max(5, Number(pollSec) || 60) * 1000
      pollTimer = setIntervalImpl(() => { pollOnce().catch((error) => { last.error = errorText(error) }) }, pollMs)
      pollTimer?.unref?.()
      // 立刻跑一次，建立 push 基线（首次只记录 sha，不触发运行）。
      pollOnce().catch((error) => { last.error = errorText(error) })
    }
    return true
  }

  function stop() {
    if (tickTimer) clearIntervalImpl(tickTimer)
    if (pollTimer) clearIntervalImpl(pollTimer)
    tickTimer = null
    pollTimer = null
    started = false
  }

  function snapshot() {
    return {
      started,
      tickSec: Number(tickSec) || 0,
      pollSec: Number(pollSec) || 0,
      lastTickAt: last.tickAt,
      lastPollAt: last.pollAt,
      lastError: last.error,
      stateFile: stateFile || '',
      cron: { ...state.cron },
      push: JSON.parse(JSON.stringify(state.push)),
      results: results.slice(0, 10),
    }
  }

  return { start, stop, tick, pollOnce, snapshot, get started() { return started } }
}
