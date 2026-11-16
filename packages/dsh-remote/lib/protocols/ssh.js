// SSH adapter. All real work still lives in lib/ssh.js; this only exposes the capability shape so
// the registry (and the page) treat SSH as one protocol among several.

export const sshProtocol = {
  id: 'ssh',
  label: 'SSH',
  description: '加密 shell、SFTP 文件管理、本地端口转发与交互终端',
  capabilities: { exec: true, sftp: true, tunnel: true, pty: true, gui: false },
  defaults: { port: 22 },
  async connect(host, { pool } = {}) {
    if (!pool || typeof pool.acquire !== 'function') throw new Error('SSH adapter 缺少连接池')
    return pool.acquire(host)
  },
}