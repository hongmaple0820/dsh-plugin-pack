// Command execution on an established ssh2 Client. No ssh2 import here: tests can import this
// module and exercise the pure timeout/truncation helpers without a network.

import { LIMITS, clipUtf8, createByteSink } from './truncate.js'

export const DEFAULT_TIMEOUT_SEC = 60
export const MIN_TIMEOUT_SEC = 1
export const MAX_TIMEOUT_SEC = 600

/**
 * Normalize a user-supplied timeout in seconds: integers only, clamped to 1-600.
 * Throws for values that are not finite numbers so a bad tool/HTTP argument is visible.
 */
export function normalizeTimeoutSec(value, { fallback = DEFAULT_TIMEOUT_SEC, min = MIN_TIMEOUT_SEC, max = MAX_TIMEOUT_SEC } = {}) {
  if (value === undefined || value === null || value === '') return fallback
  const number = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(number)) throw new Error(`timeoutSec 必须是数字（收到 ${JSON.stringify(value)}）`)
  return Math.min(max, Math.max(min, Math.floor(number)))
}

/** Clip a finished exec payload into the documented result shape. Pure. */
export function collectExecResult({
  exitCode = null,
  signal = null,
  stdout = '',
  stderr = '',
  stdoutBytes,
  stderrBytes,
  truncated,
  durationMs = null,
  timedOut = false,
  aborted = false,
  limits = LIMITS,
} = {}) {
  const out = clipUtf8(stdout, limits.stdoutBytes)
  const err = clipUtf8(stderr, limits.stderrBytes)
  return {
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    signal: signal || null,
    stdout: out.text,
    stderr: err.text,
    stdoutBytes: Number.isFinite(stdoutBytes) ? stdoutBytes : out.originalBytes,
    stderrBytes: Number.isFinite(stderrBytes) ? stderrBytes : err.originalBytes,
    truncated: {
      stdout: Boolean(truncated?.stdout) || out.truncated,
      stderr: Boolean(truncated?.stderr) || err.truncated,
    },
    durationMs,
    timedOut: Boolean(timedOut),
    aborted: Boolean(aborted),
  }
}

/**
 * Run one command over an ssh2 Client and collect stdout/stderr under the byte budgets.
 * Resolves (never rejects) for a timeout or abort so the model still sees partial output;
 * rejects only when the channel itself cannot be opened.
 */
export function runExec(client, command, { timeoutMs = DEFAULT_TIMEOUT_SEC * 1000, limits = LIMITS, abortSignal = null } = {}) {
  return new Promise((resolve, reject) => {
    if (!client || typeof client.exec !== 'function') {
      reject(new Error('SSH 连接不可用：无法执行命令'))
      return
    }
    if (typeof command !== 'string' || !command.trim()) {
      reject(new Error('command 不能为空'))
      return
    }
    if (abortSignal?.aborted) {
      reject(new Error('命令已被取消'))
      return
    }

    const startedAt = Date.now()
    const stdoutSink = createByteSink(limits.stdoutBytes)
    const stderrSink = createByteSink(limits.stderrBytes)
    let settled = false
    let timer = null
    let forceTimer = null
    let timedOut = false
    let aborted = false
    let channel = null

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      if (forceTimer) clearTimeout(forceTimer)
      abortSignal?.removeEventListener?.('abort', onAbort)
    }

    const settle = (exitCode, streamSignal) => {
      if (settled) return
      settled = true
      cleanup()
      const out = stdoutSink.result()
      const err = stderrSink.result()
      resolve(collectExecResult({
        exitCode: typeof exitCode === 'number' ? exitCode : null,
        signal: streamSignal || (timedOut ? 'KILL' : null),
        stdout: out.text,
        stderr: err.text,
        stdoutBytes: out.originalBytes,
        stderrBytes: err.originalBytes,
        truncated: { stdout: out.truncated, stderr: err.truncated },
        durationMs: Date.now() - startedAt,
        timedOut,
        aborted,
        limits,
      }))
    }

    const killChannel = () => {
      try { channel?.signal?.('KILL') } catch { try { channel?.close?.() } catch { /* channel already gone */ } }
    }

    function onAbort() {
      aborted = true
      killChannel()
      settle(null, 'ABORT')
    }

    client.exec(command, (error, stream) => {
      if (error) {
        if (!settled) {
          settled = true
          cleanup()
          reject(new Error(`exec 打开通道失败：${error.message}`))
        }
        return
      }
      channel = stream
      abortSignal?.addEventListener?.('abort', onAbort, { once: true })

      stream.on('data', (chunk) => stdoutSink.push(chunk))
      stream.stderr.on('data', (chunk) => stderrSink.push(chunk))

      timer = setTimeout(() => {
        timedOut = true
        killChannel()
        // A killed remote command normally closes the channel; if it does not, report partial output.
        forceTimer = setTimeout(() => settle(null, 'KILL'), 2000)
      }, Math.max(1, timeoutMs))

      stream.on('close', (code, streamSignal) => settle(code, streamSignal))
    })
  })
}