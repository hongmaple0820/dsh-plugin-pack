// Telnet adapter: a raw TCP socket to port 23 (or a configured port). No SFTP, no tunnels, no
// exec — just a byte pipe the panel terminal can attach to.

import net from 'node:net'

export function connectTelnet({ host, port = 23, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port })
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new Error(`连接 Telnet ${host}:${port} 超时（${timeoutMs}ms）`))
    }, Math.max(1000, Number(timeoutMs) || 15000))
    if (typeof timer.unref === 'function') timer.unref()

    const fail = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      reject(error)
    }
    socket.once('error', (error) => fail(new Error(`连接 Telnet ${host}:${port} 失败：${error.message}`)))
    socket.once('connect', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeListener('error', fail)
      resolve(socket)
    })
  })
}

export const telnetProtocol = {
  id: 'telnet',
  label: 'Telnet',
  description: '明文 TCP 远程终端（无文件、无隧道）；仅适合可信内网设备',
  capabilities: { exec: false, sftp: false, tunnel: false, pty: true, gui: false },
  defaults: { port: 23 },
  connect(host, opts = {}) {
    return connectTelnet({ host: host.host, port: host.port || 23, timeoutMs: opts.timeoutMs })
  },
}