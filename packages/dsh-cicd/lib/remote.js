/**
 * Client for the dsh-remote plugin's loopback HTTP routes.
 *
 * This package deliberately does not import dsh-remote's code or ssh2: deployment reuses the
 * credentials, jump-host handling and chunked SFTP upload that dsh-remote already owns.
 */

import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'

const CHUNK_BYTES = 8192
const UPLOAD_MAX_BYTES = 64 * 1024 * 1024

export function remoteUnavailable(detail = '') {
  const error = new Error(`dsh-remote 插件没有就绪：请先启用并重载它${detail ? `（${detail}）` : ''}`)
  error.code = 'REMOTE_UNAVAILABLE'
  return error
}

export function createRemote({ base = '', fetch: fetchImpl = globalThis.fetch, headerName = 'x-dsh-remote-exec', headerValue = '1' } = {}) {
  const root = String(base || '').replace(/\/+$/, '')

  async function call(path, params = {}) {
    if (!root) throw remoteUnavailable('没有拿到 webServer.port')
    if (typeof fetchImpl !== 'function') throw remoteUnavailable('当前 Node 没有 fetch')
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) query.set(key, String(value))
    }
    const url = `${root}/api/plugins/remote/${path}${query.size ? `?${query}` : ''}`
    let response
    try {
      response = await fetchImpl(url, { method: 'GET', headers: { [headerName]: headerValue, accept: 'application/json' } })
    } catch (error) {
      throw remoteUnavailable(error.message)
    }
    let body = null
    try { body = await response.json() } catch { body = null }
    if (response.status === 404) throw remoteUnavailable(body?.error || '路由 404')
    if (!response.ok || body?.ok === false) {
      const error = new Error(body?.error || `dsh-remote 返回 HTTP ${response.status}`)
      error.code = body?.code || 'REMOTE_ERROR'
      error.status = response.status
      throw error
    }
    return body
  }

  return {
    base: root,
    async exec(host, command, { timeoutSec = 60 } = {}) {
      const data = await call('exec', { host, command, timeoutSec })
      // dsh-remote 的回包是 { ok, result:{ exitCode, stdout, stderr, … } }，这里把 result 摊平
      return data?.result ?? data
    },
    async uploadFile(host, localPath, remotePath, { mode = 'overwrite' } = {}) {
      const info = statSync(localPath)
      if (!info.isFile()) throw new Error(`产物不是普通文件：${localPath}`)
      if (info.size > UPLOAD_MAX_BYTES) throw new Error(`产物超过 64MB 上限：${localPath}`)
      const buffer = readFileSync(localPath)
      const begin = await call('file-upload-begin', { host, path: remotePath, size: buffer.length, mode })
      const uploadId = begin.uploadId
      if (!uploadId) throw new Error('dsh-remote 没有返回 uploadId')
      try {
        let offset = 0
        while (offset < buffer.length) {
          const chunk = buffer.subarray(offset, Math.min(offset + CHUNK_BYTES, buffer.length))
          await call('file-upload-chunk', { uploadId, offset, data: chunk.toString('base64') })
          offset += chunk.length
        }
        return await call('file-upload-finish', { uploadId })
      } catch (error) {
        try { await call('file-upload-abort', { uploadId }) } catch { /* best effort */ }
        throw error
      }
    },
    async listTunnels() {
      return await call('tunnels', {})
    },
    /** v0.5：`{envs:[{name,hosts:[alias]}], groups:[…], tags:[…]}`，用于展开 env:/group:/tag: 选择器。 */
    async groups() {
      const data = await call('groups', {})
      return { envs: bucketList(data?.envs), groups: bucketList(data?.groups), tags: bucketList(data?.tags) }
    },
    /** v0.5：主机清单的 env/group/tags 元数据（read-only，不需要执行头）。 */
    async hosts() {
      const data = await call('hosts', {})
      return Array.isArray(data?.hosts) ? data.hosts : []
    },
    name(localPath) { return basename(localPath) },
  }
}

/** `/groups` 的桶结构容错：兼容 `{name, hosts}` 与 `{key, hosts}` 两种命名。 */
function bucketList(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => ({
      name: String(item?.name ?? item?.key ?? '').trim(),
      hosts: Array.isArray(item?.hosts) ? item.hosts.map((host) => String(host).trim()).filter(Boolean) : [],
    }))
    .filter((item) => item.name)
}