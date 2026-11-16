// RDP is not implemented as a canvas client: the page asks the host machine to launch its own
// RDP client against the target. See lib/protocols/gui.js for the launcher.

export const rdpProtocol = {
  id: 'rdp',
  label: 'RDP',
  description: '调用本机远程桌面客户端打开（需要本机已安装 mstsc / remmina / xfreerdp）',
  capabilities: { exec: false, sftp: false, tunnel: false, pty: false, gui: true },
  defaults: { port: 3389 },
  async connect() {
    const error = new Error('RDP 不做内嵌连接：请用页面「打开桌面」调用本机 RDP 客户端')
    error.code = 'GUI_REQUIRED'
    throw error
  },
}