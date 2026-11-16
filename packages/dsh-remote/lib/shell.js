// Interactive PTY sessions. Pure registry over a stream-like object (EventEmitter with write/end),
// so tests can drive it with a fake stream and no SSH connection.

import { LIMITS, clipUtf8, tailUtf8, utf8Bytes } from './truncate.js'

/** Append a chunk to a growing buffer and keep at most `maxBytes` of its tail. */
export function appendCapped(buffer, chunk, maxBytes = LIMITS.shellBufferBytes) {
  const text = typeof chunk === 'string' ? chunk : String(chunk ?? '')
  const next = buffer + text
  if (utf8Bytes(next) <= maxBytes) return next
  return tailUtf8(next, maxBytes)
}

/** Clip take-output to the shell read budget; `truncated` means older output was cut. */
export function takeOutput(buffer, maxBytes = LIMITS.shellReadBytes) {
  const clipped = clipUtf8(buffer, maxBytes)
  return { output: clipped.text, bytes: clipped.bytes, truncated: clipped.truncated }
}

/**
 * Open a PTY channel on an ssh2 Client. `onStream` runs synchronously inside the ssh2 callback,
 * before the promise resolves, so a caller can attach its data listeners without losing the first
 * prompt bytes.
 */
export function openShellChannel(client, { term = 'xterm-256color', cols = 120, rows = 40 } = {}, onStream = null) {
  return new Promise((resolve, reject) => {
    if (!client || typeof client.shell !== 'function') {
      reject(new Error('SSH 连接不可用：无法打开交互式 shell'))
      return
    }
    client.shell({ term, cols, rows }, (error, stream) => {
      if (error) {
        reject(new Error(`打开 shell 失败：${error.message}`))
        return
      }
      try {
        onStream?.(stream)
      } catch (attachError) {
        reject(attachError)
        return
      }
      resolve(stream)
    })
  })
}

/**
 * Registry of live PTY sessions keyed by `sh<N>`. Attaching subscribes to the channel's data and
 * close events and keeps a byte-bounded tail buffer for the next send's read-back.
 */
export class ShellRegistry {
  constructor({
    now = () => new Date().toISOString(),
    clock = () => Date.now(),
    maxBufferBytes = LIMITS.shellBufferBytes,
    maxLogBytes = LIMITS.shellLogBytes,
  } = {}) {
    this.sessions = new Map()
    this.sequence = 0
    this.now = now
    this.clock = clock
    this.maxBufferBytes = maxBufferBytes
    this.maxLogBytes = maxLogBytes
  }

  get size() {
    return this.sessions.size
  }

  attach({ host = null, stream, term = 'xterm-256color', cols = 120, rows = 40, panel = false } = {}) {
    if (!stream || typeof stream.on !== 'function') throw new Error('内部错误：shell 通道不可用')
    this.sequence += 1
    const session = {
      id: `sh${this.sequence}`,
      host,
      stream,
      term,
      cols,
      rows,
      panel: Boolean(panel),
      buffer: '',
      bufferBytes: 0,
      seq: 0,
      // Panel sessions keep a longer rolling log so a refreshed page can replay the backlog and
      // download the full transcript; tool sessions leave it empty.
      log: '',
      logBytes: 0,
      logTotal: 0,
      logTruncated: false,
      closed: false,
      openedAt: this.now(),
      lastActiveAt: this.clock(),
    }
    stream.on('data', (chunk) => this.append(session.id, chunk))
    stream.on('close', () => {
      session.closed = true
      // Panel sessions keep a tombstone so a poll can report `exited: true` with the last bytes;
      // tool sessions disappear at once, as their callers expect.
      if (!session.panel) this.sessions.delete(session.id)
    })
    this.sessions.set(session.id, session)
    return session
  }

  get(id) {
    return this.sessions.get(String(id ?? '')) || null
  }

  append(id, chunk) {
    const session = this.get(id)
    if (!session) return null
    const text = typeof chunk === 'string' ? chunk : String(chunk ?? '')
    if (!text) return session.buffer
    session.buffer = appendCapped(session.buffer, text, this.maxBufferBytes)
    session.bufferBytes = utf8Bytes(session.buffer)
    if (session.panel) this.appendLog(session, text)
    session.seq += 1
    session.lastActiveAt = this.clock()
    return session.buffer
  }

  /** Append to the panel transcript, trimming old bytes from the head at the 4MB cap. */
  appendLog(session, text) {
    const textBytes = utf8Bytes(text)
    if (textBytes === 0) return
    session.logTotal += textBytes
    if (session.logBytes + textBytes <= this.maxLogBytes) {
      session.log += text
      session.logBytes += textBytes
    } else {
      session.log = tailUtf8(session.log + text, this.maxLogBytes)
      session.logBytes = utf8Bytes(session.log)
    }
    session.logTruncated = session.logTotal > session.logBytes
  }

  /** Tail of the panel transcript, without consuming it (attach backlog / download). */
  logTail(id, maxBytes = LIMITS.shellBacklogBytes) {
    const session = this.get(id)
    if (!session) return null
    const requested = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : LIMITS.shellBacklogBytes
    const limit = Math.min(requested, this.maxLogBytes)
    const output = tailUtf8(session.log, limit)
    const bytes = utf8Bytes(output)
    return {
      output,
      bytes,
      total: session.logTotal,
      truncated: session.logTruncated || bytes < session.logBytes,
    }
  }

  /** Resize the PTY and remember the new size. Returns false for unknown sessions. */
  resize(id, cols, rows) {
    const session = this.get(id)
    if (!session) return false
    session.cols = cols
    session.rows = rows
    session.lastActiveAt = this.clock()
    try { session.stream.setWindow?.(rows, cols, 0, 0) } catch { /* channel already closed */ }
    return true
  }

  /**
   * Close idle sessions. Panel sessions are the only kind swept by the HTTP layer, but the filter is
   * explicit so tool sessions cannot be closed out from under their callers.
   */
  sweepIdle({ maxIdleMs, panelOnly = true } = {}) {
    const now = this.clock()
    const closed = []
    for (const session of [...this.sessions.values()]) {
      if (panelOnly && !session.panel) continue
      if (now - session.lastActiveAt < maxIdleMs) continue
      this.close(session.id)
      closed.push(session.id)
    }
    return closed
  }

  clearBuffer(id) {
    const session = this.get(id)
    if (!session) return false
    session.buffer = ''
    session.bufferBytes = 0
    return true
  }

  /** Write input verbatim (callers include their own newline); clearing is opt-out for polling UIs. */
  write(id, input, { clearBuffer = true } = {}) {
    const session = this.get(id)
    if (!session) throw new Error(`shell 会话 ${id} 不存在（可能已关闭）；先 remote_shell_open`)
    if (session.closed) throw new Error(`shell 会话 ${id} 已关闭`)
    if (clearBuffer) {
      session.buffer = ''
      session.bufferBytes = 0
    }
    session.lastActiveAt = this.clock()
    session.stream.write(String(input ?? ''))
    return true
  }

  take(id, maxBytes = LIMITS.shellReadBytes) {
    const session = this.get(id)
    if (!session) return null
    const result = takeOutput(session.buffer, maxBytes)
    session.buffer = ''
    session.bufferBytes = 0
    session.lastActiveAt = this.clock()
    return { ...result, seq: session.seq, closed: session.closed }
  }

  close(id) {
    const session = this.get(id)
    if (!session) return false
    this.sessions.delete(session.id)
    try { session.stream.end() } catch { /* channel already closed */ }
    return true
  }

  list() {
    return [...this.sessions.values()].map((session) => ({
      sessionId: session.id,
      host: session.host,
      term: session.term,
      cols: session.cols,
      rows: session.rows,
      openedAt: session.openedAt,
      bufferedBytes: session.bufferBytes,
      closed: session.closed,
    }))
  }

  drain() {
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    for (const session of sessions) {
      try { session.stream.end() } catch { /* channel already closed */ }
    }
    return sessions
  }
}