// VNC, like RDP, runs in a local viewer rather than inside the page.

export const vncProtocol = {
  id: 'vnc',
  label: 'VNC',
  description: '调用本机 VNC Viewer 打开（需要本机已安装 vncviewer / remmina / vinagre）',
  capabilities: { exec: false, sftp: false, tunnel: false, pty: false, gui: true },
  defaults: { port: 5900 },
  async connect() {
    const error = new Error('VNC 不做内嵌连接：请用页面「打开桌面」调用本机 VNC 客户端')
    error.code = 'GUI_REQUIRED'
    throw error
  },
}