// Protocol registry. Every remote host names one protocol; adapters advertise what the page may
// offer for it, so an unknown or limited protocol never produces a broken button.
//
// Adding a protocol = one module exporting an adapter + one registerProtocol(...) line here.

import { sshProtocol } from './ssh.js'
import { telnetProtocol } from './telnet.js'
import { rdpProtocol } from './rdp.js'
import { vncProtocol } from './vnc.js'

export const DEFAULT_PROTOCOL_ID = 'ssh'
export const PROTOCOL_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

const registry = new Map()

function normalizeCapabilities(value) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    exec: source.exec === true,
    sftp: source.sftp === true,
    tunnel: source.tunnel === true,
    pty: source.pty === true,
    gui: source.gui === true,
  }
}

/** Register (or replace) one protocol adapter. Pure bookkeeping so tests can add a fake protocol. */
export function registerProtocol(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new Error('协议 adapter 必须是对象')
  const id = typeof adapter.id === 'string' ? adapter.id.trim().toLowerCase() : ''
  if (!PROTOCOL_ID_PATTERN.test(id)) throw new Error(`协议 id 不合法：${String(adapter.id)}`)
  if (typeof adapter.connect !== 'function') throw new Error(`协议 ${id} 缺少 connect()`)
  const port = Number(adapter.defaults?.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`协议 ${id} 的默认端口不合法`)
  const normalized = {
    id,
    label: typeof adapter.label === 'string' && adapter.label.trim() ? adapter.label.trim() : id.toUpperCase(),
    description: typeof adapter.description === 'string' ? adapter.description : '',
    capabilities: normalizeCapabilities(adapter.capabilities),
    defaults: { port },
    connect: adapter.connect,
    launch: typeof adapter.launch === 'function' ? adapter.launch : null,
  }
  registry.set(id, normalized)
  return normalized
}

export function getProtocol(id) {
  const key = String(id || '').trim().toLowerCase()
  return registry.get(key) || null
}

export function hasProtocol(id) {
  return Boolean(getProtocol(id))
}

export function protocolPort(id) {
  return getProtocol(id)?.defaults.port || 22
}

/** Secret-free adapter list for the page's capability matrix. */
export function listProtocols() {
  return [...registry.values()].map((adapter) => ({
    id: adapter.id,
    label: adapter.label,
    description: adapter.description,
    capabilities: { ...adapter.capabilities },
    defaultPort: adapter.defaults.port,
  }))
}

/** Fail with a 400-shaped error when a route needs a capability the host protocol lacks. */
export function assertProtocolCapability(id, capability) {
  const adapter = getProtocol(id) || getProtocol(DEFAULT_PROTOCOL_ID)
  if (!adapter.capabilities[capability]) {
    const label = adapter.label
    const error = new Error(`协议 ${label} 不支持 ${capability}；请改用 SSH 主机，或为该主机换一个协议`)
    error.code = 'PROTOCOL_UNSUPPORTED'
    throw error
  }
  return adapter
}

registerProtocol(sshProtocol)
registerProtocol(telnetProtocol)
registerProtocol(rdpProtocol)
registerProtocol(vncProtocol)