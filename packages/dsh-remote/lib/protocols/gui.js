// Launch a graphical client that already exists on the Host machine. This plugin never renders
// RDP/VNC itself: if the machine has no viewer we say so plainly instead of showing a dead button.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const IS_WINDOWS = process.platform === 'win32'

function which(name) {
  const probe = spawnSync(IS_WINDOWS ? 'where' : 'which', [name], {
    encoding: 'utf8',
    timeout: 2500,
    windowsHide: true,
  })
  if (probe.error || probe.status !== 0) return null
  const first = String(probe.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean)
  return first || null
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}

function windowsProgramFiles(relative) {
  const roots = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['LocalAppData']]
  return roots.filter(Boolean).map((root) => join(root, relative))
}

/** 缺客户端时给面板的安装引导：命令与下载页都写死在这里，前端只负责渲染与复制。 */
export function installInfo(protocol) {
  if (protocol === 'vnc') {
    return {
      protocol: 'vnc',
      client: 'vncviewer',
      title: '需要安装 VNC 客户端',
      url: 'https://www.realvnc.com/en/connect/download/viewer/',
      hint: '装完可以点「重新检测」，也可以先改用 SSH / telnet。',
      commands: IS_WINDOWS
        ? [
          { tool: 'winget', command: 'winget install -e --id RealVNC.VNCViewer' },
          { tool: 'winget', command: 'winget install -e --id TigerVNC.TigerVNC' },
          { tool: 'choco', command: 'choco install vncviewer' },
        ]
        : [
          { tool: 'apt', command: 'sudo apt install tigervnc-viewer' },
          { tool: 'brew', command: 'brew install --cask vnc-viewer' },
          { tool: 'dnf', command: 'sudo dnf install tigervnc' },
        ],
    }
  }
  return {
    protocol: 'rdp',
    client: IS_WINDOWS ? 'mstsc' : 'remmina',
    title: '需要安装 RDP 客户端',
    url: IS_WINDOWS ? 'https://learn.microsoft.com/windows-server/remote/remote-desktop-services/clients/remote-desktop-clients' : 'https://remmina.org/',
    hint: 'Windows 自带 mstsc；Linux 装 remmina 或 xfreerdp 即可。装完点「重新检测」。',
    commands: IS_WINDOWS
      ? [{ tool: 'mstsc', command: 'mstsc /v:<host>:<port>' }]
      : [
        { tool: 'apt', command: 'sudo apt install remmina remmina-plugin-rdp' },
        { tool: 'brew', command: 'brew install --cask microsoft-remote-desktop' },
        { tool: 'dnf', command: 'sudo dnf install remmina' },
      ],
  }
}

function viewerError(protocol) {
  const message = protocol === 'vnc'
    ? '本机没有 vncviewer（推荐 MobaXterm/TigerVNC），或改用 SSH/Telnet'
    : '本机没有 RDP 客户端（Windows 需 mstsc，Linux 需 remmina/xfreerdp），或改用 SSH/Telnet'
  const error = new Error(message)
  error.code = 'GUI_CLIENT_MISSING'
  error.install = installInfo(protocol)
  return error
}

function candidatesFor(protocol) {
  if (protocol === 'rdp') {
    if (IS_WINDOWS) {
      const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
      return [{ name: 'mstsc', path: firstExisting([join(systemRoot, 'System32', 'mstsc.exe'), which('mstsc')]), args: (target) => [`/v:${target}`] }]
    }
    return [
      { name: 'xfreerdp', path: which('xfreerdp') || which('xfreerdp3'), args: (target) => [`/v:${target}`] },
      { name: 'remmina', path: which('remmina'), args: (target) => [`-c`, `rdp://${target}`] },
    ]
  }
  return [
    {
      name: 'vncviewer',
      path: IS_WINDOWS
        ? firstExisting([
          which('vncviewer'),
          ...windowsProgramFiles('RealVNC\\VNC Viewer\\vncviewer.exe'),
          ...windowsProgramFiles('TigerVNC\\vncviewer.exe'),
          ...windowsProgramFiles('TightVNC\\tvnviewer.exe'),
        ])
        : which('vncviewer'),
      args: (target) => [target],
    },
    { name: 'remmina', path: IS_WINDOWS ? null : which('remmina'), args: (target) => ['-c', `vnc://${target}`] },
    { name: 'vinagre', path: IS_WINDOWS ? null : which('vinagre'), args: (target) => [target] },
  ]
}

/**
 * Launch the local viewer for `protocol` against `host:port`.
 * @returns {{ launched: string, target: string, executable: string }}
 */
export function launchGuiClient(protocol, host, port) {
  const id = String(protocol || '').toLowerCase()
  if (id !== 'rdp' && id !== 'vnc') {
    const error = new Error(`不支持用外部客户端打开协议 ${protocol}；只支持 rdp 与 vnc`)
    error.code = 'GUI_PROTOCOL'
    throw error
  }
  const target = `${host}:${port}`
  const candidate = candidatesFor(id).find((item) => Boolean(item.path))
  if (!candidate) throw viewerError(id)
  const child = spawn(candidate.path, candidate.args(target), {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.once('error', () => { /* surfaced by the next launch attempt; this call already returned */ })
  child.unref()
  return { launched: candidate.name, target, executable: candidate.path }
}