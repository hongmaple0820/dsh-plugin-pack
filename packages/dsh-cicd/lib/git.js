/**
 * V2-M0：git 集成。
 *
 * - readGitMeta(path)：同步读取一个本地仓库的 HEAD 元数据（分支/提交/精确 tag/最近提交信息/工作区是否脏/提交时间）。
 *   读取是纯本地、最快的（rev-parse/log/describe/status），失败一律退化为空值而不是抛错——面板和运行记录
 *   都不该因为缺 git 或仓库损坏而崩掉。
 * - cloneRepo(...)：异步 `git clone`（--depth 1），用于“从 git 新建项目”向导；失败给出可读错误码。
 * - V2-M1 追加：fetchAsync（不阻塞事件循环的轮询 fetch）、remoteHead（origin/<branch> 的 sha）、
 *   pullFastForward（push 触发后把工作区快进到远端）。
 */

import { execFileSync, spawn } from 'node:child_process'

const EMPTY_META = Object.freeze({
  isRepo: false,
  branch: '',
  commit: '',
  commitShort: '',
  tag: '',
  message: '',
  dirty: false,
  commitAt: '',
})

/**
 * 跑一条 git 命令并返回去首尾空白的 stdout。失败时按 required 决定抛错还是返回空串。
 */
export function runGit(cwd, args, { required = false, timeoutMs = 5000 } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: timeoutMs,
    }).trim()
  } catch (error) {
    if (required) throw error
    return ''
  }
}

export function isGitRepo(path) {
  return runGit(path, ['rev-parse', '--is-inside-work-tree']) === 'true'
}

/**
 * 同步读取 HEAD 元数据。任何一步失败都退化为空字段；isRepo 之外全是 best-effort。
 */
export function readGitMeta(path) {
  if (!path || !isGitRepo(path)) return EMPTY_META
  // rev-parse --abbrev-ref HEAD 在游离 HEAD 下返回 "HEAD"，此时退化为空分支名。
  const branch = runGit(path, ['symbolic-ref', '--short', 'HEAD'])
  const commit = runGit(path, ['rev-parse', 'HEAD'])
  const commitShort = runGit(path, ['rev-parse', '--short', 'HEAD'])
  const message = runGit(path, ['log', '-1', '--pretty=%s'])
  // 只在 HEAD 恰好指向某个 tag 时才算 tag（--exact-match），否则落入 tag 会干扰 when: tag 判断。
  const tag = runGit(path, ['describe', '--tags', '--exact-match', 'HEAD'])
  const dirty = runGit(path, ['status', '--porcelain']) !== ''
  // V2-M1：提交时间（ISO8601，作者时间即可），供 DORA change_lead_time 计算；失败退化为空。
  const commitAt = runGit(path, ['log', '-1', '--pretty=%cI'])
  return {
    isRepo: true,
    branch,
    commit,
    commitShort,
    tag,
    message,
    dirty,
    commitAt,
  }
}

/**
 * 异步 `git clone`。clone 可能是向导里最慢的一步，所以走 spawn，避免阻塞事件循环。
 */
export function cloneRepo({ url, dir, branch = '', timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['clone', '--depth', '1']
    if (branch) args.push('--branch', branch)
    args.push('--', String(url), dir)

    let child
    try {
      child = spawn('git', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    } catch (error) {
      reject(Object.assign(new Error(`git 不可用：${error.message}`), { code: 'GIT_UNAVAILABLE' }))
      return
    }

    let stderr = ''
    let settled = false
    let timer = null
    const finish = (fn, arg) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      fn(arg)
    }
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => finish(reject, Object.assign(new Error(`git clone 失败：${error.message}`), { code: 'GIT_CLONE_FAILED' })))
    child.on('close', (code) => {
      if (code === 0) finish(resolve, { dir })
      else finish(reject, Object.assign(new Error(`git clone 失败：${stderr.trim() || `exit ${code}`}`), { code: 'GIT_CLONE_FAILED' }))
    })
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        finish(reject, Object.assign(new Error(`git clone 超时（${Math.round(timeoutMs / 1000)}s）`), { code: 'GIT_CLONE_TIMEOUT' }))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    }
  })
}

/**
 * best-effort `git fetch`：运行前刷新远程引用。超时/无远端/离线都静默忽略，不阻断流水线。
 */
export function fetchQuiet(path, { timeoutMs = 15000 } = {}) {
  if (!isGitRepo(path)) return false
  runGit(path, ['fetch', '--quiet', '--depth', '1', '--prune'], { timeoutMs })
  return true
}

/**
 * V2-M1：异步 `git fetch`（spawn，不阻塞事件循环）。scheduler 的 push 轮询用它。
 * 返回 true/false 表示是否尝试了 fetch（是否 git 仓库），失败不抛错。
 */
export function fetchAsync(path, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    if (!isGitRepo(path)) { resolve(false); return }
    const child = spawn('git', ['fetch', '--quiet', '--prune'], {
      cwd: path,
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    })
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(value)
    }
    const timer = timeoutMs > 0 ? setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      finish(false)
    }, timeoutMs) : null
    if (timer && typeof timer.unref === 'function') timer.unref()
    child.on('error', () => finish(false))
    child.on('close', (code) => finish(code === 0))
  })
}

/**
 * V2-M1：fetch 之后读远端分支的 HEAD（`origin/<branch>`）。失败返回空串。
 * branch 为空时读当前分支的远端引用。
 */
export function remoteHead(path, branch = '') {
  const local = branch || runGit(path, ['symbolic-ref', '--short', 'HEAD'])
  if (!local) return ''
  return runGit(path, ['rev-parse', `refs/remotes/origin/${local}`])
}

/**
 * V2-M1：把工作区快进到远端（`git merge --ff-only`）。push 触发后同步本地代码用。
 * 返回 { ok, error }：脏工作区/非快进/离线都算失败，调用方决定是否跳过触发。
 */
export function pullFastForward(path) {
  if (!isGitRepo(path)) return { ok: false, error: '不是 git 仓库' }
  if (runGit(path, ['status', '--porcelain']) !== '') return { ok: false, error: '工作区有未提交改动' }
  const branch = runGit(path, ['symbolic-ref', '--short', 'HEAD'])
  if (!branch) return { ok: false, error: '游离 HEAD' }
  if (!remoteHead(path, branch)) return { ok: false, error: `没有远端分支 origin/${branch}` }
  runGit(path, ['merge', '--ff-only', `origin/${branch}`], { timeoutMs: 60000 })
  // merge --ff-only 在已是最新时输出 "Already up to date."，失败时退出码非 0；
  // 用「HEAD 是否等于 origin/branch」作为最终判据，避免依赖输出文本。
  const head = runGit(path, ['rev-parse', 'HEAD'])
  const remote = remoteHead(path, branch)
  if (head && remote && head === remote) return { ok: true, error: '' }
  return { ok: false, error: '快进失败（本地与远端分叉？）' }
}

/**
 * V2-M1：列出 fetch 之后的远端分支 HEAD（`refs/remotes/origin/*`）。scheduler 用它与上次轮询的 sha 比对。
 * 返回 [{ name, sha }]，name 已去掉 `origin/` 前缀，并排除 `origin/HEAD` 这种符号引用。
 */
export function remoteBranches(path) {
  if (!path) return []
  const out = runGit(path, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/remotes/origin'])
  if (!out) return []
  const rows = []
  for (const line of out.split('\n')) {
    const [rawName, sha] = line.trim().split(/\s+/)
    if (!rawName || !sha) continue
    if (rawName === 'origin' || rawName === 'origin/HEAD') continue
    const name = rawName.replace(/^origin\//, '')
    if (!name) continue
    rows.push({ name, sha })
  }
  return rows
}

/**
 * V2-M1：读某个提交的提交时间（作者时间 ISO8601），供 DORA change lead time 使用。
 * 只接受十六进制 sha，避免把任意字符串当 git rev 传进去。
 */
export function commitDate(path, sha) {
  const text = String(sha || '').trim()
  if (!path || !/^[0-9a-f]{7,40}$/i.test(text)) return ''
  return runGit(path, ['show', '-s', '--format=%cI', text])
}
