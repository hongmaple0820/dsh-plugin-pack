// Chunked SFTP uploads over the page's GET-only carrier.
//
// Each upload owns one SFTP channel and one write stream. The stream lives across HTTP
// requests, so the registry (not the route) is the long-lived owner: it enforces the
// concurrency cap, checks chunk offsets, renames `<path>.part` only on finish, and aborts
// idle sessions. Pure Node + injected SFTP helpers, so smoke tests can drive it with a fake.

import { createHash } from 'node:crypto'
import { LIMITS } from './truncate.js'
import { openSftp, sftpRename, sftpStat, sftpUnlink } from './sftp.js'

export const UPLOAD_CHUNK_BYTES = LIMITS.uploadChunkBytes
export const UPLOAD_MAX_BYTES = LIMITS.uploadMaxBytes
export const UPLOAD_MAX_SESSIONS = LIMITS.uploadMaxSessions
export const UPLOAD_IDLE_MS = LIMITS.uploadIdleMs
export const UPLOAD_WRITE_TIMEOUT_MS = LIMITS.uploadWriteTimeoutMs

function uploadError(code, message, status = null) {
  const error = new Error(message)
  error.code = code
  if (status) error.status = status
  return error
}

/**
 * stream.write 的回调在个别 ssh2 / 服务端组合下可能永远不来（win22 的 Windows OpenSSH 对
 * 打不开的远端路径既不 error 也不 close，实测挂死 10 分钟）。超时 + 流死亡双保险，把挂死
 * 变成一次可读的 502，让上层（dsh-cicd 的 uploadFile catch → file-upload-abort）能干净收尾。
 */
function writeBuffer(stream, buffer, { timeoutMs = UPLOAD_WRITE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (stream?.destroyed) {
      reject(uploadError('UPLOAD_WRITE', '上传写入失败：流已关闭（远端路径或连接不可用）', 502))
      return
    }
    let settled = false
    let timer = null
    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null }
      stream.off('close', onDead)
      stream.off('error', onError)
    }
    const settle = (error) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(uploadError('UPLOAD_WRITE', `上传写入失败：${error.message}`, 502))
      else resolve()
    }
    const onDead = () => settle(new Error('流已关闭（远端路径或连接不可用）'))
    const onError = (error) => settle(error)
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => settle(new Error(`${Math.round(timeoutMs / 1000)}s 内没有收到写入确认（连接或远端无响应）`)), timeoutMs)
      timer.unref?.()
    }
    stream.once('close', onDead)
    stream.once('error', onError)
    try {
      stream.write(buffer, (error) => settle(error || null))
    } catch (error) {
      settle(error)
    }
  })
}

function endStream(stream, { timeoutMs = UPLOAD_WRITE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null
    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null }
      stream.off('close', onClose)
      stream.off('finish', onFinish)
      stream.off('error', onError)
    }
    const settle = (error) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(uploadError('UPLOAD_WRITE', `关闭上传流失败：${error.message}`, 502))
      else resolve()
    }
    const onClose = () => settle()
    const onFinish = () => settle()
    const onError = (error) => settle(error)
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => settle(new Error(`${Math.round(timeoutMs / 1000)}s 内没有等到 close/finish（连接无响应）`)), timeoutMs)
      timer.unref?.()
    }
    stream.once('close', onClose)
    stream.once('finish', onFinish)
    stream.once('error', onError)
    try {
      // ssh2 的 WriteStream._final 会先 destroy() 再回调；只等 end(cb) 可能永远不回调。
      stream.end()
    } catch (error) {
      settle(error)
    }
  })
}

/** 远端路径的父目录；根 / 盘符 / 裸文件名返回 ''（无从检查）。 */
function parentDirOf(path) {
  const value = String(path ?? '')
  const cut = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  if (cut <= 0) return ''
  const parent = value.slice(0, cut)
  if (!parent || parent === '/' || /^[A-Za-z]:$/.test(parent)) return ''
  return parent
}

/** One upload session and the byte accounting the chunk route checks against. */
export class UploadRegistry {
  constructor({
    openSftp: open = openSftp,
    maxSessions = UPLOAD_MAX_SESSIONS,
    idleMs = UPLOAD_IDLE_MS,
    chunkBytes = UPLOAD_CHUNK_BYTES,
    writeTimeoutMs = UPLOAD_WRITE_TIMEOUT_MS,
    clock = () => Date.now(),
    idPrefix = 'up',
    timers = true,
  } = {}) {
    this.openSftp = open
    this.maxSessions = maxSessions
    this.idleMs = idleMs
    this.chunkBytes = chunkBytes
    this.clock = clock
    this.idPrefix = idPrefix
    this.useTimers = timers
    this.writeTimeoutMs = writeTimeoutMs
    this.sessions = new Map()
    this.counter = 0
  }

  get size() {
    return this.sessions.size
  }

  list() {
    return [...this.sessions.values()].map((session) => ({
      uploadId: session.id,
      host: session.host,
      path: session.path,
      size: session.size,
      received: session.received,
      mode: session.mode,
      idleMs: this.clock() - session.lastActiveAt,
    }))
  }

  schedule(session) {
    if (!this.useTimers) return
    if (session.timer) clearTimeout(session.timer)
    session.timer = setTimeout(() => {
      this.abort(session.id).catch(() => { /* best effort */ })
    }, this.idleMs)
    session.timer.unref?.()
  }

  touch(session) {
    session.lastActiveAt = this.clock()
    this.schedule(session)
  }

  sweep() {
    const now = this.clock()
    for (const session of [...this.sessions.values()]) {
      if (now - session.lastActiveAt >= this.idleMs) this.abort(session.id).catch(() => {})
    }
  }

  require(uploadId) {
    this.sweep()
    const session = this.sessions.get(String(uploadId ?? ''))
    if (!session) {
      throw uploadError(
        'UPLOAD_NOT_FOUND',
        `上传会话 ${uploadId} 不存在（可能已关闭或超时）`,
        404,
      )
    }
    return session
  }

  async begin({ client, host, path, size, mode = 'overwrite', id = null }) {
    this.sweep()
    if (this.sessions.size >= this.maxSessions) {
      throw uploadError('UPLOAD_LIMIT', `上传会话已达上限（${this.maxSessions}），请先完成或中止一个`, 409)
    }
    if (!Number.isInteger(size) || size < 0 || size > UPLOAD_MAX_BYTES) {
      throw uploadError('UPLOAD_SIZE', `size 必须是 0-${UPLOAD_MAX_BYTES} 的整数`, 400)
    }

    // create refuses to replace an existing file; overwrite replaces it atomically at finish.
    if (mode === 'create') {
      try {
        await sftpStatFor(client, path)
        throw uploadError('UPLOAD_EXISTS', `目标文件已存在：${path}`, 409)
      } catch (error) {
        if (error?.code === 'UPLOAD_EXISTS') throw error
        if (!/No such file|not exist|no such|不存在/i.test(error?.message || '')) {
          throw uploadError('UPLOAD_TARGET', `检查目标文件 ${path} 失败：${error?.message || error}`, 502)
        }
      }
    }

    const sftp = await this.openSftp(client)
    const idValue = id || `${this.idPrefix}${(this.counter += 1)}`
    // 预检父目录：远端父目录缺失时，个别 ssh2 / 服务端组合（win22 的 Windows OpenSSH 实测）
    // 打开写入流后既不 error 也不 close，只能靠写入超时兜底；提前 stat 一次把最常见的
    // 「目录没建出来」变成可读的 400。fake sftp 没有 stat 方法时跳过，保持旧行为。
    const parent = parentDirOf(path)
    if (parent && typeof sftp.stat === 'function') {
      const parentExists = await new Promise((resolve) => {
        try {
          sftp.stat(parent, (error, stats) => resolve(!error && Boolean(stats)))
        } catch {
          resolve(true)
        }
      })
      if (!parentExists) {
        try { sftp.end() } catch { /* channel already gone */ }
        throw uploadError('UPLOAD_TARGET', `父目录不存在：${parent}（请先创建目录再上传）`, 400)
      }
    }
    // append must keep the existing bytes, so it writes the target directly; the other modes
    // stage into <path>.part and rename only after the stream finished.
    const append = mode === 'append'
    const target = append ? path : `${path}.part`
    let stream
    try {
      stream = sftp.createWriteStream(target, { flags: append ? 'a' : 'w' })
    } catch (error) {
      try { sftp.end() } catch { /* channel already gone */ }
      throw uploadError('UPLOAD_TARGET', `打开远端文件 ${target} 失败：${error.message}`, 502)
    }

    const session = {
      id: idValue,
      host,
      path,
      target,
      append,
      size,
      mode,
      received: 0,
      lastActiveAt: this.clock(),
      sftp,
      stream,
      streamError: null,
      chain: Promise.resolve(),
      hash: createHash('sha256'),
      timer: null,
    }
    stream.on('error', (error) => { session.streamError = error })
    this.sessions.set(idValue, session)
    this.schedule(session)
    return { uploadId: idValue, chunkBytes: this.chunkBytes }
  }

  /** Queue one chunk behind the previous write so offsets stay meaningful under parallel GETs. */
  chunk(uploadId, offset, buffer) {
    const session = this.require(uploadId)
    const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
    if (data.length > this.chunkBytes) {
      throw uploadError('UPLOAD_CHUNK', `单块数据超过 ${this.chunkBytes} 字节上限`, 413)
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw uploadError('UPLOAD_OFFSET', 'offset 必须是非负整数', 409)
    }
    if (offset + data.length > session.size) {
      throw uploadError('UPLOAD_SIZE', `数据超过声明的文件大小（${session.size} 字节）`, 413)
    }

    const task = session.chain.then(async () => {
      if (session.streamError) {
        throw uploadError('UPLOAD_WRITE', `上传流已失败：${session.streamError.message}`, 502)
      }
      if (session.stream?.destroyed) {
        session.streamError = session.streamError || new Error('流已关闭（远端路径或连接不可用）')
        throw uploadError('UPLOAD_WRITE', `上传流已失败：${session.streamError.message}`, 502)
      }
      if (offset !== session.received) {
        throw uploadError('UPLOAD_OFFSET', `偏移不连续，期望 ${session.received}`, 409)
      }
      if (session.received + data.length > session.size) {
        throw uploadError('UPLOAD_SIZE', `数据超过声明的文件大小（${session.size} 字节）`, 413)
      }
      try {
        await writeBuffer(session.stream, data, { timeoutMs: this.writeTimeoutMs })
      } catch (error) {
        if (!session.streamError) session.streamError = error
        throw error
      }
      session.received += data.length
      session.hash.update(data)
      this.touch(session)
      return { uploadId: session.id, received: session.received, total: session.size }
    })
    session.chain = task.catch(() => { /* the next chunk sees the same session state */ })
    return task
  }

  /** Close the stream, rename the part file into place, and return the final byte count. */
  async finish(uploadId, { sha256 = null } = {}) {
    const session = this.require(uploadId)
    try {
      await session.chain
      if (session.streamError) {
        throw uploadError('UPLOAD_WRITE', `上传流已失败：${session.streamError.message}`, 502)
      }
      if (session.received !== session.size) {
        throw uploadError(
          'UPLOAD_INCOMPLETE',
          `已写入 ${session.received} 字节，与声明的 size ${session.size} 不一致`,
          409,
        )
      }
      const digest = session.hash.digest('hex')
      if (sha256 && sha256.toLowerCase() !== digest) {
        throw uploadError('UPLOAD_CHECKSUM', `sha256 不匹配：收到 ${digest}`, 400)
      }
      await endStream(session.stream, { timeoutMs: this.writeTimeoutMs })
      if (!session.append) await sftpRename(session.sftp, session.target, session.path)
      try { session.sftp.end() } catch { /* channel already closed */ }
      this.clear(session)
      return { host: session.host, path: session.path, bytes: session.received }
    } catch (error) {
      await this.abort(uploadId).catch(() => {})
      throw error
    }
  }

  /** Drop the stream; staged part files are removed, appends keep the bytes already written. */
  async abort(uploadId) {
    const session = this.sessions.get(String(uploadId ?? ''))
    if (!session) {
      throw uploadError('UPLOAD_NOT_FOUND', `上传会话 ${uploadId} 不存在（可能已关闭或超时）`, 404)
    }
    try { await session.chain.catch(() => {}) } catch { /* chain already settled */ }
    try { session.stream.destroy() } catch { /* stream already closed */ }
    if (!session.append) {
      try { await sftpUnlink(session.sftp, session.target) } catch { /* part already gone */ }
    }
    try { session.sftp.end() } catch { /* channel already closed */ }
    this.clear(session)
    return { aborted: true }
  }

  clear(session) {
    if (session.timer) clearTimeout(session.timer)
    this.sessions.delete(session.id)
  }

  drain() {
    const ids = [...this.sessions.keys()]
    return Promise.all(ids.map((id) => this.abort(id).catch(() => {})))
  }
}

async function sftpStatFor(client, path) {
  const sftp = await openSftp(client)
  try {
    return await sftpStat(sftp, path)
  } finally {
    try { sftp.end() } catch { /* channel already closed */ }
  }
}