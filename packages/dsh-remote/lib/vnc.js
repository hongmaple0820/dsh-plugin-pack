// Target-side VNC discovery and lifecycle, plus the one-time tokens that guard the
// WebSocket upgrade. Nothing here opens a socket: the bridge lives in wsbridge.js and the
// machine-to-machine leg is an existing SSH local forward (lib/tunnel.js).
//
// The panel wants a desktop without asking the user to install a viewer. Every helper below
// therefore returns plain JSON-able facts and never throws for an expected "not installed".

import { randomBytes } from 'node:crypto'

export const VNC_PORT_DEFAULT = 5909
export const VNC_PORT_MIN = 5900
export const VNC_PORT_MAX = 5999
export const VNC_DISPLAY_DEFAULT = ':9'
export const VNC_GEOMETRY_DEFAULT = '1280x800'
export const VNC_TOKEN_TTL_MS = 60_000

const DISPLAY_PATTERN = /^:\d{1,3}$/
const GEOMETRY_PATTERN = /^\d{2,4}x\d{2,4}$/

/** Validate the optional `display` query value (`:9`), else fall back to the default. */
export function normalizeDisplay(value) {
  if (value === undefined || value === null || value === '') return VNC_DISPLAY_DEFAULT
  const text = String(value).trim()
  return DISPLAY_PATTERN.test(text) ? text : null
}

/** Validate the optional `geometry` query value (`1280x800`), else fall back to the default. */
export function normalizeGeometry(value) {
  if (value === undefined || value === null || value === '') return VNC_GEOMETRY_DEFAULT
  const text = String(value).trim()
  return GEOMETRY_PATTERN.test(text) ? text : null
}

/** Parse an optional `port` (5900-5999). Returns a number, or null when the text is invalid. */
export function normalizeVncPort(value) {
  if (value === undefined || value === null || value === '') return VNC_PORT_DEFAULT
  const number = Number(String(value).trim())
  if (!Number.isInteger(number) || number < VNC_PORT_MIN || number > VNC_PORT_MAX) return null
  return number
}

/**
 * Where a missing VNC server can be installed from. Same shape as lib/protocols/gui.js
 * `installInfo`, so the panel renders both with one card component.
 */
export function vncServerInstallInfo(platform = 'linux') {
  if (platform === 'win32') {
    return {
      protocol: 'vnc-server',
      client: 'tvnserver',
      title: '目标机需要 VNC 服务（TightVNC）',
      url: 'https://www.tightvnc.com/download.php',
      hint: '装完 TightVNC Server 后会注册 tvnserver 服务，再点「重新检测」。',
      commands: [
        { tool: 'winget', command: 'winget install -e --id TightVNC.TightVNC' },
        { tool: 'choco', command: 'choco install tightvnc -y' },
      ],
    }
  }
  return {
    protocol: 'vnc-server',
    client: 'Xtigervnc',
    title: '目标机需要 VNC 服务（TigerVNC）',
    url: 'https://tigervnc.org/',
    hint: '装完会提供 Xtigervnc；也可以改用 x11vnc 共享已有桌面，再点「重新检测」。',
    commands: [
      { tool: 'apt', command: 'sudo apt install tigervnc-standalone-server' },
      { tool: 'dnf', command: 'sudo dnf install tigervnc-server' },
      { tool: 'x11vnc', command: 'sudo apt install x11vnc' },
    ],
  }
}

/** The remote probe: one shell script, section markers, no assumptions about bash features. */
export function probeScript() {
  return [
    'echo "--bin-Xtigervnc=$(command -v Xtigervnc 2>/dev/null || true)"',
    'echo "--bin-vncserver=$(command -v vncserver 2>/dev/null || true)"',
    'echo "--bin-x11vnc=$(command -v x11vnc 2>/dev/null || true)"',
    'echo "--listen"',
    '(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null || true) | grep -E "127\\.0\\.0\\.1:59[0-9][0-9]|\\[::1\\]:59[0-9][0-9]|0\\.0\\.0\\.0:59[0-9][0-9]" || true',
    'echo "--procs"',
    'pgrep -af "Xtigervnc|Xvnc|x11vnc" 2>/dev/null | grep -v -- "--bin-Xtigervnc" || true',
    'echo "--end"',
  ].join('\n')
}

/**
 * Turn the probe stdout into the status payload the panel shows.
 * `installed` is about binaries, `running` about a live listener.
 */
export function parseProbe(stdout = '') {
  const lines = String(stdout).split(/\r?\n/)
  const binaries = []
  let section = ''
  const listeners = []
  const processes = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('--bin-')) {
      const [, name, path] = line.match(/^--bin-([\w.]+)=(.*)$/) || []
      if (name && path) binaries.push({ name, path })
      continue
    }
    if (line === '--listen') { section = 'listen'; continue }
    if (line === '--procs') { section = 'procs'; continue }
    if (line === '--end') { section = 'end'; continue }
    if (section === 'listen') {
      const match = line.match(/(?:127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(59\d\d)\b/)
      if (match) listeners.push(Number(match[1]))
    } else if (section === 'procs') {
      if (!line.includes('--bin-Xtigervnc') && !line.includes('--procs')) processes.push(line)
    }
  }
  const ports = [...new Set(listeners)].sort((a, b) => a - b)
  const server = binaries.find((b) => b.name === 'Xtigervnc')?.name
    || binaries.find((b) => b.name === 'vncserver')?.name
    || binaries.find((b) => b.name === 'x11vnc')?.name
    || null
  const displayMatch = processes.join(' ').match(/:(\d{1,3})\b/)
  return {
    installed: binaries.length > 0,
    running: ports.length > 0,
    port: ports.length > 0 ? ports[0] : null,
    display: displayMatch ? `:${displayMatch[1]}` : null,
    server,
    binaries: binaries.map((b) => b.name),
    processes: processes.slice(0, 3),
  }
}

/** The detached start line. `setsid -f` survives the SSH channel closing; `nohup` alone does not. */
export function startScript({ display, geometry, port, logPath = '/tmp/dsh-vnc.log', binary = 'Xtigervnc' }) {
  const command = binary === 'x11vnc'
    ? `x11vnc -localhost -rfbport ${port} -forever -shared -nopw -display ${display}`
    : `${binary} ${display} -geometry ${geometry} -depth 24 -rfbport ${port} -localhost ` +
      '-SecurityTypes None -nolisten tcp -AlwaysShared -desktop dsh-desktop'
  return [
    `if [ -x "$(command -v ${binary})" ]; then`,
    `  setsid -f sh -c 'exec ${command} >${logPath} 2>&1 </dev/null'`,
    '  echo STARTED',
    'else',
    '  echo MISSING',
    'fi',
  ].join('\n')
}

/** Wait (in one SSH call) until the loopback port answers, at most ~15s. */
export function waitForPortScript(port, { attempts = 30 } = {}) {
  return [
    `i=0`,
    `while [ $i -lt ${attempts} ]; do`,
    `  if (ss -ltn 2>/dev/null | grep -q "127.0.0.1:${port}"); then echo READY; exit 0; fi`,
    `  i=$((i+1)); sleep 0.5`,
    'done',
    'echo TIMEOUT',
  ].join('\n')
}

/** Read back the pid we just started so a later stop only kills our own instance. */
export function pidScript({ display, port }) {
  return [
    `pgrep -af "Xtigervnc ${display}|x11vnc .*${port}" 2>/dev/null | head -1 | cut -d" " -f1 || true`,
  ].join('\n')
}

export function stopScript({ display, pid }) {
  if (Number.isInteger(pid) && pid > 0) return `kill ${pid} 2>/dev/null && echo STOPPED || echo GONE`
  return `pkill -f "Xtigervnc ${display}" 2>/dev/null && echo STOPPED || echo GONE`
}

/**
 * Windows probe: no POSIX helpers there, so ask `sc` for the TightVNC service and `netstat`
 * for a listener. Output is line based so one regex pass reads both facts.
 */
export function windowsProbeCommand() {
  // 单行：exec 通道只跑命令串的第一行，多行探针会静默丢掉后面的检查。
  return [
    'sc query tvnserver 2>nul',
    'sc query winvnc 2>nul',
    'netstat -an | findstr ":5900"',
    'echo PROBE-END',
    'if exist "%ProgramFiles%\\TightVNC" echo DIR-TIGHTVNC',
  ].join(' & ')
}

export function parseWindowsProbe(stdout = '') {
  const text = String(stdout)
  const serviceRunning = /SERVICE_NAME:\s*tvnserver/i.test(text) && /STATE\s*:\s*4\s+RUNNING/i.test(text)
  const servicePresent = /SERVICE_NAME:\s*(tvnserver|winvnc)/i.test(text)
  const dirPresent = /DIR-TIGHTVNC/.test(text)
  const listening = /:5900\b/.test(text)
  const installed = servicePresent || dirPresent
  const running = serviceRunning || listening
  return {
    installed,
    running,
    port: running ? 5900 : null,
    display: null,
    server: installed ? 'tvnserver' : null,
    binaries: installed ? ['tvnserver'] : [],
    processes: [],
  }
}

/** Wait for the Windows TightVNC listener, mirroring waitForPortScript. */
export function windowsWaitScript(port = 5900) {
  return [
    'powershell -NoProfile -Command "',
    `for ($i = 0; $i -lt 30; $i++) {`,
    `  if (Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue) { Write-Output READY; exit 0 }`,
    '  Start-Sleep -Milliseconds 500',
    '}',
    'Write-Output TIMEOUT"',
  ].join('\n')
}

/**
 * 目标机缺 VNC 服务时由插件代它装（用户不用手抄任何命令）。Windows 走 TightVNC 官方 MSI
 * 静默安装并把服务注册成自动启动；Linux 走发行版包管理器。两条脚本都只打印标记行，
 * 解析交给 parseInstallLog，Host 侧再据此决定是重探状态还是报错。
 */
export const WINDOWS_VNC_MSI_URL = 'https://www.tightvnc.com/download/2.8.84/tightvnc-2.8.84-gpl-setup-64bit.msi'

/**
 * Windows 安装被拆成一串单行命令：目标机的 exec 通道只会执行命令串的第一行，任何 `if`
 * 语句（带括号的那种）之后的 `&` 也会被吃掉，所以不能把「下载 + 安装 + 防火墙 + 起服务」
 * 拼成一条长脚本。
 */
export function windowsInstallSteps({ url = WINDOWS_VNC_MSI_URL, port = 5900 } = {}) {
  const msi = '%TEMP%\\dsh-tightvnc.msi'
  return [
    { id: 'download', command: `curl -sSL --max-time 300 -o "${msi}" "${url}"` },
    { id: 'verify', command: `if exist "${msi}" echo DSH-DOWNLOAD-OK` },
    {
      id: 'install',
      command: `msiexec /i "${msi}" /qn /norestart ADDLOCAL=Server SERVER_PORT=${port}`
        + ' SET_USEVNCAUTHENTICATION=1 VALUE_OF_USEVNCAUTHENTICATION=0'
        + ' SET_ALLOWLOOPBACK=1 VALUE_OF_ALLOWLOOPBACK=1'
        + ' SET_RUNCONTROLINTERFACE=1 VALUE_OF_RUNCONTROLINTERFACE=0',
    },
    {
      id: 'firewall',
      command: 'netsh advfirewall firewall delete rule name="dsh-vnc-standalone"'
        + ` & netsh advfirewall firewall add rule name="dsh-vnc-standalone" dir=in action=block protocol=TCP localport=${port}`,
    },
    { id: 'service', command: 'sc config tvnserver start= auto & net start tvnserver' },
  ]
}

export function windowsInstallScript(options = {}) {
  return windowsInstallSteps(options).map((step) => step.command).join(' & ')
}

export function linuxInstallScript() {
  return [
    'if command -v apt-get >/dev/null 2>&1; then',
    '  sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tigervnc-standalone-server xterm >/dev/null 2>&1 && echo DSH-APT-OK || echo DSH-APT-FAIL;',
    'elif command -v dnf >/dev/null 2>&1; then',
    '  sudo -n dnf install -y tigervnc-server xterm >/dev/null 2>&1 && echo DSH-DNF-OK || echo DSH-DNF-FAIL;',
    'elif command -v apt >/dev/null 2>&1; then',
    '  sudo -n env DEBIAN_FRONTEND=noninteractive apt install -y tigervnc-standalone-server xterm >/dev/null 2>&1 && echo DSH-APT-OK || echo DSH-APT-FAIL;',
    'else',
    '  echo DSH-NO-PKG-MANAGER;',
    'fi',
    'echo DSH-INSTALL-END',
  ].join('\n')
}

export function parseInstallLog(stdout = '') {
  const text = String(stdout ?? '')
  const msi = /DSH-MSI-EXIT=(-?\d+)/.exec(text)
  return {
    downloaded: /DSH-DOWNLOAD-OK/.test(text),
    downloadFailed: /DSH-DOWNLOAD-FAIL/.test(text),
    msiExitCode: msi ? Number(msi[1]) : null,
    linuxInstalled: /DSH-APT-OK|DSH-DNF-OK/.test(text),
    noPackageManager: /DSH-NO-PKG-MANAGER/.test(text),
    finished: /DSH-INSTALL-END/.test(text),
    tail: text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-12),
  }
}

/**
 * One-time upgrade tokens. `take` is destructive: a token opens exactly one socket, so a
 * leaked URL in a page history or a proxy log cannot be replayed.
 */
export function createTokenStore({ ttlMs = VNC_TOKEN_TTL_MS, now = () => Date.now() } = {}) {
  const tokens = new Map()
  const sweep = () => {
    const at = now()
    for (const [token, record] of tokens) if (record.expiresAt <= at) tokens.delete(token)
  }
  return {
    issue(payload = {}) {
      sweep()
      const token = randomBytes(24).toString('hex')
      tokens.set(token, { payload, expiresAt: now() + ttlMs })
      return { token, expiresIn: Math.round(ttlMs / 1000) }
    },
    take(token) {
      if (typeof token !== 'string' || !token) return null
      const record = tokens.get(token)
      if (!record) return null
      tokens.delete(token)
      if (record.expiresAt <= now()) return null
      return record.payload
    },
    get size() { return tokens.size },
  }
}