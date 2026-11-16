// SFTP helpers. They take an open SFTPWrapper, so no connection logic or ssh2 import lives here.

import { readFileSync } from 'node:fs'
import { LIMITS, createByteSink } from './truncate.js'

const MODE_DIR = 0o040000
const MODE_LINK = 0o120000

/** Open one SFTP channel and return it; the caller owns closing it. */
export function openSftp(client) {
  if (!client || typeof client.sftp !== 'function') return Promise.reject(new Error('SSH 连接不可用：无法打开 SFTP'))
  return new Promise((resolve, reject) => {
    client.sftp((error, channel) => {
      if (error) reject(new Error(`打开 SFTP 通道失败：${error.message}`))
      else resolve(channel)
    })
  })
}

/** Open one SFTP channel, run `fn`, and close the channel afterwards. */
export async function withSftp(client, fn) {
  const sftp = await openSftp(client)
  try {
    return await fn(sftp)
  } finally {
    try { sftp.end() } catch { /* channel already closed */ }
  }
}

/** stat() with a friendlier error; resolves {size, mode, mtime, isDir}. */
export function sftpStat(sftp, path) {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (error, stats) => {
      if (error) {
        reject(new Error(`stat ${path} 失败：${error.message}`))
        return
      }
      const mode = stats.mode ?? 0
      resolve({
        path,
        size: Number(stats.size) || 0,
        mode,
        isDir: (mode & MODE_DIR) === MODE_DIR,
        mtime: stats.mtime ? new Date(stats.mtime * 1000).toISOString() : null,
      })
    })
  })
}

/** rename() over an existing target. */
export function sftpRename(sftp, from, to) {
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (error) => {
      if (error) reject(new Error(`重命名 ${from} → ${to} 失败：${error.message}`))
      else resolve({ from, to })
    })
  })
}

/** unlink(), treating "already gone" as success. */
export function sftpUnlink(sftp, path) {
  return new Promise((resolve) => {
    sftp.unlink(path, () => resolve({ path }))
  })
}

function codedSftpError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** Create exactly one directory; an existing target is a conflict, not a silent success. */
export function sftpMkdir(sftp, path) {
  return new Promise((resolve, reject) => {
    sftp.mkdir(path, (error) => {
      if (error) reject(codedSftpError('SFTP_MKDIR', `新建目录 ${path} 失败：${error.message}`))
      else resolve({ path, created: true })
    })
  })
}

function sftpRmDir(sftp, path) {
  return new Promise((resolve, reject) => {
    sftp.rmdir(path, (error) => (error ? reject(error) : resolve()))
  })
}

function removeTree(sftp, path) {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (statError, stats) => {
      if (statError) {
        reject(codedSftpError('SFTP_NOT_FOUND', `stat ${path} 失败：${statError.message}`))
        return
      }
      if ((stats.mode & MODE_DIR) !== MODE_DIR) {
        sftp.unlink(path, (error) => (error ? reject(error) : resolve()))
        return
      }
      sftp.readdir(path, (readError, list) => {
        if (readError) {
          reject(readError)
          return
        }
        const base = path.endsWith('/') ? path.slice(0, -1) : path
        Promise.all(list.map((item) => removeTree(sftp, `${base}/${item.filename}`)))
          .then(() => sftpRmDir(sftp, path))
          .then(resolve, reject)
      })
    })
  })
}

/** Delete a file, or a directory when `recursive` is true. A directory without it is a 409. */
export function sftpDelete(sftp, path, { recursive = false } = {}) {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (statError, stats) => {
      if (statError) {
        reject(codedSftpError('SFTP_NOT_FOUND', `stat ${path} 失败：${statError.message}`))
        return
      }
      const isDir = (stats.mode & MODE_DIR) === MODE_DIR
      if (!isDir) {
        sftp.unlink(path, (error) => (error
          ? reject(codedSftpError('SFTP_DELETE', `删除 ${path} 失败：${error.message}`))
          : resolve({ path, deleted: true, directory: false })))
        return
      }
      if (!recursive) {
        reject(codedSftpError('DIRECTORY_NEEDS_RECURSIVE', `目录 ${path} 必须带 recursive=1 才能删除`))
        return
      }
      removeTree(sftp, path)
        .then(() => resolve({ path, deleted: true, directory: true }))
        .catch((error) => reject(codedSftpError('SFTP_DELETE', `删除目录 ${path} 失败：${error.message}`)))
    })
  })
}

export function sftpChmod(sftp, path, mode) {
  return new Promise((resolve, reject) => {
    sftp.chmod(path, mode, (error) => (error
      ? reject(codedSftpError('SFTP_CHMOD', `修改 ${path} 权限失败：${error.message}`))
      : resolve({ path, mode })))
  })
}

export function sftpChown(sftp, path, uid, gid) {
  return new Promise((resolve, reject) => {
    sftp.chown(path, uid, gid, (error) => (error
      ? reject(codedSftpError('SFTP_CHOWN', `修改 ${path} 属主失败：${error.message}`))
      : resolve({ path, uid, gid })))
  })
}

/** Write text with overwrite (truncate), append, or create (fail when the target exists). */
export function sftpWriteText(sftp, path, content, { mode = 'overwrite' } = {}) {
  return new Promise((resolve, reject) => {
    const text = typeof content === 'string' ? content : String(content ?? '')
    const flags = mode === 'append' ? 'a' : mode === 'create' ? 'wx' : 'w'
    let stream
    try {
      stream = sftp.createWriteStream(path, { flags })
    } catch (error) {
      reject(codedSftpError('SFTP_WRITE', `写入 ${path} 失败：${error.message}`))
      return
    }
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve({ path, bytes: Buffer.byteLength(text, 'utf8'), mode })
    }
    stream.on('error', (error) => {
      if (settled) return
      settled = true
      reject(codedSftpError(mode === 'create' ? 'SFTP_EXISTS' : 'SFTP_WRITE', `写入 ${path} 失败：${error.message}`))
    })
    stream.on('close', finish)
    stream.on('finish', finish)
    stream.end(text)
  })
}

/** Bounded, breadth-first filename search under `dir`; skips nothing but caps scanned entries. */
export async function sftpSearch(sftp, dir, query, { limit = 50, maxScan = 20000, maxDepth = 12 } = {}) {
  const needle = String(query || '').trim().toLowerCase()
  if (!needle) throw codedSftpError('SFTP_SEARCH', '搜索关键词不能为空')
  const matches = []
  const queue = [{ path: dir, depth: 0 }]
  let scanned = 0
  let truncated = false
  while (queue.length > 0) {
    const current = queue.shift()
    let list
    try {
      list = await new Promise((resolve, reject) => {
        sftp.readdir(current.path, (error, entries) => (error ? reject(error) : resolve(entries)))
      })
    } catch {
      continue
    }
    for (const item of list) {
      scanned += 1
      if (scanned > maxScan) { truncated = true; break }
      const base = current.path.endsWith('/') ? current.path.slice(0, -1) : current.path
      const childPath = `${base}/${item.filename}`
      const mode = item.attrs?.mode ?? 0
      const isDir = (mode & MODE_DIR) === MODE_DIR
      if (String(item.filename).toLowerCase().includes(needle)) {
        matches.push({
          path: childPath,
          name: String(item.filename),
          type: isDir ? 'dir' : (mode & 0o170000) === MODE_LINK ? 'link' : 'file',
          size: isDir ? null : Number(item.attrs?.size) || 0,
          mtime: item.attrs?.mtime ? new Date(item.attrs.mtime * 1000).toISOString() : null,
        })
        if (matches.length >= limit) { truncated = true; break }
      }
      if (isDir && current.depth < maxDepth) queue.push({ path: childPath, depth: current.depth + 1 })
    }
    if (matches.length >= limit || scanned > maxScan) break
  }
  return { dir, query, entries: matches, total: matches.length, scanned, truncated }
}

/**
 * Read up to `maxBytes` of a remote file as raw bytes (binary-safe). Refuses directories.
 * Returns the full size so callers can tell a prefix from the whole file.
 */
export function sftpReadBuffer(sftp, path, { maxBytes = LIMITS.sftpReadBytes } = {}) {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (statError, stats) => {
      if (statError) {
        reject(new Error(`stat ${path} 失败：${statError.message}`))
        return
      }
      if ((stats.mode & MODE_DIR) === MODE_DIR) {
        reject(new Error(`${path} 是目录：请用 remote_ls 列目录，remote_download 只读文件`))
        return
      }
      const size = Number(stats.size) || 0
      const readBytes = Math.min(size, Math.max(0, Math.floor(maxBytes)))
      const entry = {
        path,
        size,
        mode: stats.mode ?? 0,
        mtime: stats.mtime ? new Date(stats.mtime * 1000).toISOString() : null,
      }
      if (readBytes <= 0) {
        resolve({ entry, buffer: Buffer.alloc(0), size, bytes: 0, truncated: size > 0 })
        return
      }
      const chunks = []
      let received = 0
      const stream = sftp.createReadStream(path, { start: 0, end: readBytes - 1 })
      stream.on('data', (chunk) => {
        if (received >= readBytes) return
        const room = readBytes - received
        const piece = chunk.length > room ? chunk.subarray(0, room) : chunk
        chunks.push(piece)
        received += piece.length
      })
      stream.on('error', (error) => reject(new Error(`读取 ${path} 失败：${error.message}`)))
      stream.on('close', () => {
        const buffer = Buffer.concat(chunks)
        resolve({ entry, buffer, size, bytes: buffer.length, truncated: size > readBytes })
      })
    })
  })
}

/** List one remote directory, directories first, capped at `limit` entries. */
export function sftpList(sftp, path, { limit = LIMITS.listingEntries, sort = 'name', hidden = true } = {}) {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (error, list) => {
      if (error) {
        reject(new Error(`列目录 ${path} 失败：${error.message}`))
        return
      }
      const order = sort === 'size' || sort === 'mtime' ? sort : 'name'
      const entries = list
        .filter((item) => hidden || !String(item.filename).startsWith('.'))
        .map((item) => {
          const mode = item.attrs?.mode ?? 0
          const isDir = (mode & MODE_DIR) === MODE_DIR
          return {
            name: item.filename,
            isDir,
            type: isDir ? 'dir' : (mode & 0o170000) === MODE_LINK ? 'link' : 'file',
            size: item.attrs?.size ?? null,
            mtime: item.attrs?.mtime ? new Date(item.attrs.mtime * 1000).toISOString() : null,
          }
        })
        .sort((left, right) => {
          if (left.isDir !== right.isDir) return left.isDir ? -1 : 1
          if (order === 'size') return (Number(left.size) || 0) - (Number(right.size) || 0) || left.name.localeCompare(right.name)
          if (order === 'mtime') return String(left.mtime || '').localeCompare(String(right.mtime || '')) || left.name.localeCompare(right.name)
          return left.name.localeCompare(right.name)
        })
      resolve({ entries: entries.slice(0, limit), total: entries.length, truncated: entries.length > limit, sort: order, hidden: Boolean(hidden) })
    })
  })
}

/**
 * Read up to `maxBytes` of a remote text file. Refuses directories and reports the full size so
 * the model knows whether it only saw a prefix.
 */
export function sftpRead(sftp, path, { maxBytes = LIMITS.sftpReadBytes } = {}) {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (statError, stats) => {
      if (statError) {
        reject(new Error(`stat ${path} 失败：${statError.message}`))
        return
      }
      if ((stats.mode & MODE_DIR) === MODE_DIR) {
        reject(new Error(`${path} 是目录：请用 remote_ls 列目录，remote_download 只读文件`))
        return
      }
      const size = Number(stats.size) || 0
      const readBytes = Math.min(size, Math.max(0, Math.floor(maxBytes)))
      if (readBytes <= 0) {
        resolve({ content: '', size, bytes: 0, truncated: size > 0 })
        return
      }
      const sink = createByteSink(readBytes)
      const stream = sftp.createReadStream(path, { start: 0, end: readBytes - 1 })
      stream.on('data', (chunk) => sink.push(chunk))
      stream.on('error', (error) => reject(new Error(`读取 ${path} 失败：${error.message}`)))
      stream.on('close', () => {
        const result = sink.result()
        resolve({ content: result.text, size, bytes: result.bytes, truncated: size > readBytes })
      })
    })
  })
}

/** Overwrite a remote file with the given text (UTF-8). */
export function sftpWrite(sftp, path, content) {
  return new Promise((resolve, reject) => {
    const text = typeof content === 'string' ? content : String(content ?? '')
    const stream = sftp.createWriteStream(path)
    stream.on('error', (error) => reject(new Error(`写入 ${path} 失败：${error.message}`)))
    stream.on('close', () => resolve({ path, bytes: Buffer.byteLength(text, 'utf8') }))
    stream.end(text)
  })
}

/** Copy a local file to the remote host through SFTP (binary-safe; the model passes a local path). */
export function sftpUploadFile(sftp, localPath, remotePath) {
  let data
  try {
    data = readFileSync(localPath)
  } catch (error) {
    return Promise.reject(new Error(`读取本地文件 ${localPath} 失败：${error.message}`))
  }
  return new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(remotePath)
    stream.on('error', (error) => reject(new Error(`写入 ${remotePath} 失败：${error.message}`)))
    stream.on('close', () => resolve({ localPath, remotePath, bytes: data.length }))
    stream.end(data)
  })
}

/** Ancestor directories of a path, from the shallowest to the path itself. */
export function ancestorPaths(path) {
  const value = String(path ?? '').trim()
  if (!value) throw new Error('目录路径不能为空')
  const windows = /^[A-Za-z]:[\\/]/.test(value) || (!value.startsWith('/') && value.includes('\\'))
  const separator = windows ? '\\' : '/'
  const absolute = windows || value.startsWith('/')
  const parts = value.split(/[\\/]+/).filter(Boolean)
  const list = []
  for (let index = 1; index <= parts.length; index += 1) {
    let next = parts.slice(0, index).join(separator)
    if (absolute && !windows && !next.startsWith(separator)) next = separator + next
    // A Windows drive root ("C:") is not a directory to create; skip it and start from its children.
    if (/^[A-Za-z]:$/.test(next)) continue
    list.push(next)
  }
  return list
}

/**
 * Create a remote directory, creating missing parents. Existing directories are reported instead
 * of treated as failures.
 */
export async function sftpEnsureDir(sftp, path) {
  const exists = await new Promise((resolve) => {
    sftp.stat(path, (error, stats) => resolve(!error && Boolean(stats)))
  })
  if (exists) return { path, created: false, existed: true }
  const targets = ancestorPaths(path)
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index]
    const isLast = index === targets.length - 1
    try {
      await new Promise((resolve, reject) => {
        sftp.mkdir(target, (error) => (error ? reject(error) : resolve()))
      })
    } catch (error) {
      // Parents may already exist or be created concurrently; only the last one is authoritative.
      if (isLast) throw new Error(`创建目录 ${target} 失败：${error.message}`)
    }
  }
  return { path, created: true, existed: false }
}