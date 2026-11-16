// ssh2 connection pool. ssh2 is imported lazily so importing this module (or the bundle) never
// loads a live native dependency until the first real connection. Passwords stay inside the
// options object handed to ssh2 and are never returned to callers.
//
// Multi-hop support: a resolved host spec may carry `jump: [spec, …]` — an ordered bastion chain.
// Each hop is opened through the previous hop's `forwardOut` stream, and the final target is
// reached through a socket forwarded from the last hop. The target still gets one pooled client;
// the intermediate clients are owned by that pool entry and torn down together with it.

import { readFileSync } from 'node:fs'
import { findDefaultKeyPath } from './hosts.js'

let ssh2Module = null

/** Slack on top of one hop's connect budget. */
const HOP_TIMEOUT_SLACK_MS = 5000

async function loadSsh2() {
  if (!ssh2Module) {
    try {
      ssh2Module = await import('ssh2')
    } catch (error) {
      throw new Error(`缺少依赖 ssh2：请在插件包所在仓库安装 ssh2（${error.message}）`)
    }
  }
  return ssh2Module
}

/** Read the first available default private key; returns `{ path, key }` or null. */
export function loadDefaultKey(home) {
  const path = findDefaultKeyPath(home)
  if (!path) return null
  try {
    return { path, key: readFileSync(path) }
  } catch {
    return null
  }
}

/**
 * Build the ssh2 connect options for a resolved host spec. Throws a readable error when the
 * configured private key is missing. `defaultKey` may be supplied by the caller (cached) or is
 * loaded on demand.
 */
export function buildConnectOptions(spec, { connectTimeoutMs = 15000, defaultKey } = {}) {
  if (!spec || !spec.host) throw new Error('缺少主机地址：无法建立 SSH 连接')
  const options = {
    host: spec.host,
    port: spec.port || 22,
    username: spec.user || 'root',
    readyTimeout: connectTimeoutMs,
    keepaliveInterval: 15000,
    keepaliveCountMax: 4,
  }
  if (spec.password) {
    options.password = spec.password
  } else if (spec.privateKeyPath) {
    try {
      options.privateKey = readFileSync(spec.privateKeyPath)
    } catch (error) {
      throw new Error(`读取私钥 ${spec.privateKeyPath} 失败：${error.message}`)
    }
    if (spec.passphrase) options.passphrase = spec.passphrase
  } else {
    const key = defaultKey || loadDefaultKey()
    if (!key) {
      throw new Error(`主机 ${spec.key || spec.host} 无可用凭据：未找到默认私钥，也没有配置 password / privateKeyPath`)
    }
    options.privateKey = key.key
  }
  return options
}

/** Open one SSH client and resolve on `ready`. `label` prefixes every error message. */
export function openClient(Client, options, { timeoutMs = 20000, label = 'SSH 连接' } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    const client = new Client()
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { client.end() } catch { /* socket already gone */ }
      reject(new Error(`${label} 超时（${timeoutMs}ms）`))
    }, timeoutMs)
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    client.on('ready', () => settle(resolve, client))
    client.on('error', (error) => {
      // After `ready` the pool attaches its own error handling; this listener keeps a late error
      // from crashing the process, and only rejects while the handshake is still in flight.
      settle(reject, new Error(`${label} 失败：${error.message}`))
    })
    try {
      client.connect(options)
    } catch (error) {
      settle(reject, new Error(`${label} 失败：${error.message}`))
    }
  })
}

/** Promise wrapper around `client.forwardOut` (opens a TCP stream through the SSH server). */
export function forwardOutStream(client, destination, { sourceHost = '127.0.0.1', sourcePort = 0, label = '跳板转发' } = {}) {
  return new Promise((resolve, reject) => {
    try {
      client.forwardOut(sourceHost, sourcePort, destination.host, destination.port, (error, stream) => {
        if (error) reject(new Error(`${label} ${destination.host}:${destination.port} 失败：${error.message}`))
        else resolve(stream)
      })
    } catch (error) {
      reject(new Error(`${label} ${destination.host}:${destination.port} 失败：${error.message}`))
    }
  })
}

function hopLabel(hop, index) {
  return `跳板 ${index + 1}（${hop.alias || hop.key || hop.host}）`
}

/**
 * Reach the target through the bastion chain: hop1 → (forwardOut) → hop2 → … → target.
 * Returns `{ client, via, intermediates }`; the caller owns every client and must end them.
 */
export async function connectViaJumps(Client, spec, hops, { connectTimeoutMs = 15000, defaultKey } = {}) {
  const defaults = { connectTimeoutMs, defaultKey }
  const timeoutMs = connectTimeoutMs + HOP_TIMEOUT_SLACK_MS
  const intermediates = []
  let socket = null
  try {
    let current = null
    for (let index = 0; index < hops.length; index += 1) {
      const hop = hops[index]
      const options = buildConnectOptions(hop, defaults)
      if (current && socket) {
        options.sock = socket
        delete options.host
        delete options.port
      }
      const client = await openClient(Client, options, { timeoutMs, label: hopLabel(hop, index) })
      intermediates.push(client)
      current = client
      // Prepare the stream towards the next hop (or the target) on this connection.
      const next = hops[index + 1] || { host: spec.host, port: spec.port || 22 }
      socket = await forwardOutStream(current, next, {
        label: index + 1 === hops.length ? '跳板到目标机' : '跳板之间转发',
      })
    }
    const options = buildConnectOptions(spec, defaults)
    if (socket) {
      options.sock = socket
      delete options.host
      delete options.port
    }
    const client = await openClient(Client, options, { timeoutMs, label: `SSH ${spec.host}:${spec.port}` })
    return { client, via: hops.map((hop) => hop.alias || hop.key || hop.host), intermediates }
  } catch (error) {
    for (const client of intermediates) {
      try { client.end() } catch { /* already closed */ }
    }
    throw error
  }
}

/**
 * Create a connection pool keyed by the resolved host spec key (alias, or the literal inline ref).
 * One TCP+SSH connection is reused per key; keepalive keeps long sessions alive. Hosts configured
 * with a `jump` chain keep the bastion connections alive inside the same pool entry.
 */
export function createConnectionPool({ connectTimeoutMs = 15000, defaultKeyProvider = () => loadDefaultKey() } = {}) {
  const connections = new Map()
  const pending = new Map()
  const meta = new Map()
  /** spec.key → clients of the bastion chain that this pooled connection depends on. */
  const chains = new Map()
  let disposed = false

  function teardown(key) {
    const client = connections.get(key)
    if (client) {
      connections.delete(key)
      try { client.end() } catch { /* already closed */ }
    }
    meta.delete(key)
    const hopClients = chains.get(key)
    if (hopClients) {
      chains.delete(key)
      for (const hopClient of hopClients) {
        try { hopClient.end() } catch { /* already closed */ }
      }
    }
  }

  async function connect(spec) {
    const { Client } = await loadSsh2()
    const hops = Array.isArray(spec.jump) ? spec.jump : []

    if (hops.length > 0) {
      const { client, via, intermediates } = await connectViaJumps(Client, spec, hops, {
        connectTimeoutMs,
        defaultKey: defaultKeyProvider(),
      })
      if (disposed) {
        try { client.end() } catch { /* already gone */ }
        for (const hopClient of intermediates) {
          try { hopClient.end() } catch { /* already gone */ }
        }
        throw new Error('连接池已关闭：插件正在卸载')
      }
      connections.set(spec.key, client)
      chains.set(spec.key, intermediates)
      meta.set(spec.key, {
        key: spec.key,
        host: spec.host,
        port: spec.port,
        user: spec.user,
        auth: spec.auth || null,
        via,
        connectedAt: new Date().toISOString(),
      })
      // A dropped bastion connection invalidates the pooled target connection.
      for (const hopClient of intermediates) {
        hopClient.on('close', () => { if (chains.get(spec.key) === intermediates) teardown(spec.key) })
      }
      client.on('error', () => teardown(spec.key))
      client.on('close', () => teardown(spec.key))
      return client
    }

    const options = buildConnectOptions(spec, { connectTimeoutMs, defaultKey: defaultKeyProvider() })
    const client = await new Promise((resolve, reject) => {
      let settled = false
      const pendingClient = new Client()
      const fail = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      }
      const timer = setTimeout(() => {
        try { pendingClient.end() } catch { /* socket already gone */ }
        fail(new Error(`连接 ${spec.host}:${spec.port} 超时（${connectTimeoutMs + HOP_TIMEOUT_SLACK_MS}ms）`))
      }, connectTimeoutMs + HOP_TIMEOUT_SLACK_MS)

      pendingClient.on('ready', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(pendingClient)
      })
      pendingClient.on('error', (error) => {
        fail(new Error(`SSH ${spec.host}:${spec.port} 连接失败：${error.message}`))
      })
      try {
        pendingClient.connect(options)
      } catch (error) {
        fail(new Error(`SSH ${spec.host}:${spec.port} 连接失败：${error.message}`))
      }
    })

    if (disposed) {
      try { client.end() } catch { /* already gone */ }
      throw new Error('连接池已关闭：插件正在卸载')
    }
    connections.set(spec.key, client)
    meta.set(spec.key, {
      key: spec.key,
      host: spec.host,
      port: spec.port,
      user: spec.user,
      auth: spec.auth || null,
      via: [],
      connectedAt: new Date().toISOString(),
    })
    client.on('error', () => teardown(spec.key))
    client.on('close', () => teardown(spec.key))
    return client
  }

  return {
    /** Reuse a live connection or open one; concurrent callers share the same pending connect. */
    async acquire(spec) {
      if (!spec?.key) throw new Error('内部错误：连接 spec 缺少 key')
      const existing = connections.get(spec.key)
      if (existing) return existing
      if (pending.has(spec.key)) return pending.get(spec.key)
      const promise = connect(spec).finally(() => pending.delete(spec.key))
      pending.set(spec.key, promise)
      return promise
    },
    keys() {
      return [...connections.keys()]
    },
    snapshot() {
      return [...meta.values()]
    },
    close(key) {
      if (!connections.has(key)) return false
      teardown(key)
      return true
    },
    closeAll() {
      disposed = true
      for (const key of [...connections.keys()]) teardown(key)
      connections.clear()
      meta.clear()
      pending.clear()
    },
  }
}