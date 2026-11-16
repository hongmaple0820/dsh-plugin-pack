// Local port forwarding: pure record bookkeeping plus one net.createServer wrapper.
// The registry never opens sockets, which keeps it unit-testable without SSH.

import net from 'node:net'

/** Validate and normalize a forward request. `localPort` 0/undefined means "pick a free port". */
export function normalizeForwardTarget({ remoteHost, remotePort, localPort } = {}) {
  const host = typeof remoteHost === 'string' ? remoteHost.trim() : ''
  if (!host) throw new Error('remoteHost 不能为空：写隧道出口主机（可写 127.0.0.1 表示 SSH 主机自身）')
  if (host.includes(':')) throw new Error(`remoteHost "${host}" 不支持带冒号的形式（v1 不做 IPv6）；端口请用 remotePort 参数`)
  const port = Number(remotePort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`remotePort 必须是 1-65535 的整数（收到 ${JSON.stringify(remotePort)}）`)
  }
  let local = 0
  if (localPort !== undefined && localPort !== null && localPort !== '' && Number(localPort) !== 0) {
    local = Number(localPort)
    if (!Number.isInteger(local) || local < 1 || local > 65535) {
      throw new Error(`localPort 必须是 1-65535 的整数或省略（收到 ${JSON.stringify(localPort)}）`)
    }
  }
  return { remoteHost: host, remotePort: port, localPort: local }
}

/** One live tunnel's public description; handles (net.Server) stay private. */
export function describeTunnel(record) {
  return {
    tunnelId: record.id,
    host: record.host,
    remoteHost: record.remoteHost,
    remotePort: record.remotePort,
    localPort: record.localPort,
    local: `127.0.0.1:${record.localPort}`,
    remote: `${record.remoteHost}:${record.remotePort}`,
    createdAt: record.createdAt,
    connections: record.connections || 0,
    error: record.error || null,
  }
}

/** In-memory tunnel records keyed by `tn<N>`. Add/remove/list only; closing is the caller's job. */
export class TunnelRegistry {
  constructor({ now = () => new Date().toISOString() } = {}) {
    this.records = new Map()
    this.sequence = 0
    this.now = now
  }

  get size() {
    return this.records.size
  }

  add({ host = null, remoteHost, remotePort, localPort, handle = null, connections = 0, error = null } = {}) {
    this.sequence += 1
    const record = {
      id: `tn${this.sequence}`,
      host,
      remoteHost,
      remotePort,
      localPort,
      createdAt: this.now(),
      handle,
      connections,
      error,
    }
    this.records.set(record.id, record)
    return record
  }

  get(id) {
    return this.records.get(String(id ?? '')) || null
  }

  remove(id) {
    const key = String(id ?? '')
    const record = this.records.get(key) || null
    if (record) this.records.delete(key)
    return record
  }

  list() {
    return [...this.records.values()].map(describeTunnel)
  }

  /** Drop every record and return them so the caller can close the underlying servers. */
  drain() {
    const records = [...this.records.values()]
    this.records.clear()
    return records
  }
}

/**
 * Open a 127.0.0.1 listener that forwards each accepted socket through the SSH client.
 * Resolves with the actual bound port; rejects when the SSH forward or the local listen fails.
 */
export function openLocalForward(client, { remoteHost, remotePort, localPort = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (!client || typeof client.forwardOut !== 'function') {
      reject(new Error('SSH 连接不可用：无法建立端口转发'))
      return
    }
    const sockets = new Set()
    const channels = new Set()
    let stats = { connections: 0, errors: 0 }

    const server = net.createServer((socket) => {
      sockets.add(socket)
      stats.connections += 1
      socket.on('error', () => socket.destroy())
      socket.on('close', () => sockets.delete(socket))

      client.forwardOut('127.0.0.1', 0, remoteHost, remotePort, (error, channel) => {
        if (error) {
          stats.errors += 1
          socket.destroy()
          return
        }
        channels.add(channel)
        socket.pipe(channel)
        channel.pipe(socket)
        socket.on('close', () => { channels.delete(channel); channel.end() })
        channel.on('close', () => { channels.delete(channel); socket.end() })
        channel.on('error', () => socket.destroy())
      })
    })

    server.on('error', (error) => {
      reject(new Error(`本地监听 127.0.0.1:${localPort || 'auto'} 失败：${error.message}`))
    })

    server.listen(localPort || 0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        localPort: address.port,
        get stats() {
          return { ...stats, openSockets: sockets.size, openChannels: channels.size }
        },
        close() {
          for (const socket of sockets) socket.destroy()
          for (const channel of channels) channel.destroy?.()
          sockets.clear()
          channels.clear()
          server.close()
        },
      })
    })
  })
}