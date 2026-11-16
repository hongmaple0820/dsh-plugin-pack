/**
 * Host half of @local/dsh-remote.
 *
 * Registers 13 `remote_*` tools (SSH exec, SFTP, local forwards, PTY shells, parallel cluster exec)
 * and, when the profile has a web server, the same capabilities for the browser page at
 * /api/plugins/remote/*.
 *
 * Every long-lived resource (pool connection, tunnel, PTY session) is owned by this plugin's
 * context and closed when it unloads.
 */

import net from 'node:net'
import { readFile } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import {
  CONFIG_HOSTS_EDIT_HINT,
  HOST_ALIAS_PATTERN,
  HOST_LABEL_PATTERN,
  MAX_HOST_TAGS,
  deleteHostFromFile,
  hostGroups,
  loadHosts,
  normalizeJumpChain,
  normalizeProtocol,
  publicHosts,
  resolveHostRef,
  upsertHostFile,
} from './lib/hosts.js'
import { createConnectionPool, loadDefaultKey } from './lib/ssh.js'
import {
  DEFAULT_TIMEOUT_SEC,
  MAX_TIMEOUT_SEC,
  MIN_TIMEOUT_SEC,
  normalizeTimeoutSec,
  runExec,
} from './lib/exec.js'
import {
  openSftp,
  sftpChmod,
  sftpChown,
  sftpDelete,
  sftpEnsureDir,
  sftpList,
  sftpMkdir,
  sftpRead,
  sftpReadBuffer,
  sftpRename,
  sftpSearch,
  sftpStat,
  sftpUploadFile,
  sftpWrite,
  sftpWriteText,
  withSftp,
} from './lib/sftp.js'
import { DEFAULT_PROTOCOL_ID, assertProtocolCapability, getProtocol, listProtocols, protocolPort } from './lib/protocols/index.js'
import { connectTelnet } from './lib/protocols/telnet.js'
import { launchGuiClient } from './lib/protocols/gui.js'
import { UPLOAD_CHUNK_BYTES, UploadRegistry } from './lib/upload.js'
import { TunnelRegistry, describeTunnel, normalizeForwardTarget, openLocalForward } from './lib/tunnel.js'
import { ShellRegistry, openShellChannel } from './lib/shell.js'
import {
  VNC_DISPLAY_DEFAULT,
  VNC_PORT_DEFAULT,
  VNC_PORT_MAX,
  VNC_PORT_MIN,
  createTokenStore,
  linuxInstallScript,
  normalizeDisplay,
  normalizeGeometry,
  normalizeVncPort,
  parseInstallLog,
  parseProbe,
  parseWindowsProbe,
  pidScript,
  probeScript,
  startScript,
  stopScript,
  vncServerInstallInfo,
  waitForPortScript,
  windowsInstallSteps,
  windowsProbeCommand,
  windowsWaitScript,
} from './lib/vnc.js'
import { WebSocketPeer, encodeFrame, performHandshake, refuseUpgrade } from './lib/wsbridge.js'
import { LIMITS, clipUtf8 } from './lib/truncate.js'

export const name = '@local/dsh-remote'

export const inject = ['tools']

const CONFIG_DEFAULTS = Object.freeze({
  defaultTimeoutSec: DEFAULT_TIMEOUT_SEC,
  connectTimeoutMs: 15000,
  clusterMaxHosts: 10,
  clusterStdoutBytes: 16 * 1024,
  clusterStderrBytes: 16 * 1024,
})

const SHELL_WAIT_DEFAULT_MS = 1000
const SHELL_WAIT_MIN_MS = 50
const SHELL_WAIT_MAX_MS = 10000
// Panel terminal limits: 8 concurrent sessions, 10-minute idle close, 48KB of base64 per response.
const SHELL_PANEL_MAX_SESSIONS = 8
const SHELL_PANEL_IDLE_MS = 10 * 60 * 1000
const SHELL_PANEL_WAIT_MS = 160
const SHELL_PANEL_RESPONSE_BASE64_BYTES = 48 * 1024
const SHELL_PANEL_RAW_BYTES = Math.floor(SHELL_PANEL_RESPONSE_BASE64_BYTES / 4) * 3
const SHELL_PANEL_DATA_MAX_BYTES = 64 * 1024
const SHELL_BACKLOG_BYTES = LIMITS.shellBacklogBytes
const SHELL_LOG_BYTES = LIMITS.shellLogBytes
const SHELL_LOG_MAX_REQUEST_BYTES = LIMITS.shellLogMaxRequestBytes
const SHELL_COLS_MIN = 20
const SHELL_COLS_MAX = 500
const SHELL_ROWS_MIN = 5
const SHELL_ROWS_MAX = 200
const SHELL_COLS_DEFAULT = 100
const SHELL_ROWS_DEFAULT = 30
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'

/** Wrap clipboard text so the remote shell treats it as one paste, never as typed input. */
export function wrapBracketedPaste(text) {
  const body = String(text).split(BRACKETED_PASTE_END).join('')
  return `${BRACKETED_PASTE_START}${body}${BRACKETED_PASTE_END}`
}

const ROUTE_PREFIX = '/api/plugins/remote'

/** Coerce the user patch's config object into the runtime options this plugin understands. */
export function normalizeConfig(config = {}) {
  const source = config && typeof config === 'object' ? config : {}
  const positiveInt = (value, fallback, min, max) => {
    const number = Number(value)
    if (!Number.isFinite(number)) return fallback
    return Math.min(max, Math.max(min, Math.floor(number)))
  }
  return {
    defaultTimeoutSec: positiveInt(source.defaultTimeoutSec, CONFIG_DEFAULTS.defaultTimeoutSec, MIN_TIMEOUT_SEC, MAX_TIMEOUT_SEC),
    connectTimeoutMs: positiveInt(source.connectTimeoutMs, CONFIG_DEFAULTS.connectTimeoutMs, 1000, 120000),
    clusterMaxHosts: positiveInt(source.clusterMaxHosts, CONFIG_DEFAULTS.clusterMaxHosts, 2, 10),
    clusterStdoutBytes: positiveInt(source.clusterStdoutBytes, CONFIG_DEFAULTS.clusterStdoutBytes, 1024, LIMITS.stdoutBytes),
    clusterStderrBytes: positiveInt(source.clusterStderrBytes, CONFIG_DEFAULTS.clusterStderrBytes, 1024, LIMITS.stderrBytes),
    packageHostsPath: typeof source.packageHostsPath === 'string' && source.packageHostsPath.trim()
      ? source.packageHostsPath.trim()
      : null,
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** All mutable state for one plugin instance; disposed as a unit. */
function createRuntime(config = {}) {
  const options = normalizeConfig(config)
  const pool = createConnectionPool({ connectTimeoutMs: options.connectTimeoutMs })
  const tunnels = new TunnelRegistry()
  const shells = new ShellRegistry()
  const uploads = new UploadRegistry({ openSftp })

  const hostSource = () => loadHosts({
    inlineHosts: config.hosts,
    env: process.env,
    packageHostsPath: options.packageHostsPath || undefined,
  })
  const hasDefaultKey = () => Boolean(loadDefaultKey())

  const resolve = (ref) => {
    const info = hostSource()
    return resolveHostRef(ref, { hosts: info.hosts, env: process.env, hasDefaultKey })
  }

  async function connection(ref) {
    const spec = resolve(ref)
    if (spec.protocol !== DEFAULT_PROTOCOL_ID) {
      assertProtocolCapability(spec.protocol, 'exec')
    }
    const client = await pool.acquire(spec)
    return { spec, client }
  }

  /** Protocol-aware terminal attach: SSH channels and raw Telnet sockets share ShellRegistry. */
  async function openTerminalSession(spec, ref, { term = 'xterm-256color', cols = 120, rows = 40, panel = false } = {}) {
    if (spec.protocol === 'telnet') {
      const socket = await connectTelnet({ host: spec.host, port: spec.port, timeoutMs: options.connectTimeoutMs })
      socket.on('error', () => { /* close handler marks the session exited */ })
      return shells.attach({ host: ref, stream: socket, term: 'telnet', cols, rows, panel })
    }
    if (spec.protocol !== DEFAULT_PROTOCOL_ID) {
      assertProtocolCapability(spec.protocol, 'pty')
    }
    const client = await pool.acquire(spec)
    let session = null
    await openShellChannel(client, { term, cols, rows }, (stream) => {
      session = shells.attach({ host: ref, stream, term, cols, rows, panel })
    })
    if (!session) throw new Error('打开 shell 失败：通道未就绪')
    return session
  }

  function listHosts() {
    const info = hostSource()
    return {
      hosts: publicHosts(info.hosts, { env: process.env, hasDefaultKey }),
      protocols: listProtocols(),
      source: info.source,
      path: info.path,
      configError: info.error || '',
      pooled: pool.snapshot(),
      tunnels: tunnels.list(),
      shells: shells.list(),
    }
  }

  /** The listing shape returned after a write: no pool details, no secrets. */
  function hostListSnapshot() {
    const info = hostSource()
    return {
      source: info.source,
      path: info.path,
      hosts: publicHosts(info.hosts, { env: process.env, hasDefaultKey }),
    }
  }

  /** Env / group / tag buckets for the read-only /groups route and cicd selectors. */
  function groups() {
    return hostGroups(hostSource().hosts)
  }

  /** Refuse panel writes when hosts come from inline config or no writable file exists. */
  function hostWriteTarget() {
    const info = hostSource()
    if (info.source === 'config' || !info.path) {
      const error = new Error(CONFIG_HOSTS_EDIT_HINT)
      error.code = 'HOST_SOURCE_FIXED'
      throw error
    }
    return info
  }

  function dropConnection(alias) {
    try { pool.close?.(alias) } catch { /* no pooled connection for this alias */ }
  }

  /** Panel upsert. `input` is already validated by hostSaveResource. */
  function saveHost(input) {
    const info = hostWriteTarget()
    upsertHostFile(info.path, input)
    dropConnection(input.alias)
    return hostListSnapshot()
  }

  /** Panel delete. Refuses unknown aliases instead of silently rewriting the file. */
  function deleteHost(alias) {
    const info = hostWriteTarget()
    if (!Object.prototype.hasOwnProperty.call(info.hosts, alias)) {
      const error = new Error(`主机 "${alias}" 不存在`)
      error.code = 'HOST_NOT_FOUND'
      throw error
    }
    const result = deleteHostFromFile(info.path, alias)
    dropConnection(alias)
    const snapshot = hostListSnapshot()
    if (result.empty) snapshot.warning = '现在没有任何主机了'
    return snapshot
  }

  async function execCommand(ref, command, timeoutSec, { abortSignal = null } = {}) {
    const { client } = await connection(ref)
    const timeoutMs = normalizeTimeoutSec(timeoutSec, { fallback: options.defaultTimeoutSec }) * 1000
    const result = await runExec(client, command, { timeoutMs, abortSignal })
    return { host: ref, ...result }
  }

  async function clusterExec(hosts, command, timeoutSec) {
    if (!Array.isArray(hosts) || hosts.length === 0) throw new Error('hosts 必须是非空的主机别名数组')
    if (hosts.length > options.clusterMaxHosts) {
      throw new Error(`一次最多并发 ${options.clusterMaxHosts} 台主机（收到 ${hosts.length} 台）`)
    }
    const references = hosts.map((ref) => {
      if (typeof ref !== 'string' || !ref.trim()) throw new Error('hosts 每一项都必须是非空字符串')
      return ref.trim()
    })
    if (new Set(references).size !== references.length) throw new Error('hosts 里有重复主机：请去重后再试')

    const timeoutMs = normalizeTimeoutSec(timeoutSec, { fallback: options.defaultTimeoutSec }) * 1000
    const limits = { stdoutBytes: options.clusterStdoutBytes, stderrBytes: options.clusterStderrBytes }
    const startedAt = Date.now()

    const results = await Promise.all(references.map(async (ref) => {
      const hostStartedAt = Date.now()
      try {
        const { client } = await connection(ref)
        const result = await runExec(client, command, { timeoutMs, limits })
        return {
          host: ref,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
          truncated: result.truncated,
          error: '',
        }
      } catch (error) {
        return {
          host: ref,
          exitCode: -1,
          stdout: '',
          stderr: '',
          durationMs: Date.now() - hostStartedAt,
          timedOut: false,
          truncated: { stdout: false, stderr: false },
          error: error?.message || String(error),
        }
      }
    }))

    const succeeded = results.filter((item) => !item.error && item.exitCode === 0).length
    return {
      command,
      total: results.length,
      succeeded,
      failed: results.length - succeeded,
      durationMs: Date.now() - startedAt,
      results,
    }
  }

  async function listRemote(ref, path, { sort = 'name', hidden = true } = {}) {
    const { client } = await connection(ref)
    const listing = await withSftp(client, (sftp) => sftpList(sftp, path, { sort, hidden }))
    return { host: ref, path, ...listing }
  }

  async function download(ref, path, maxBytes) {
    const { client } = await connection(ref)
    const read = await withSftp(client, (sftp) => sftpRead(sftp, path, { maxBytes }))
    return { host: ref, path, ...read }
  }

  /** Binary download for the page: same connection pool and SFTP helper as remote_download. */
  async function downloadFile(ref, path, maxBytes) {
    const { client } = await connection(ref)
    const read = await withSftp(client, (sftp) => sftpReadBuffer(sftp, path, { maxBytes }))
    return { host: ref, path, ...read }
  }

  // --- Panel file operations (v2.0). Every one reuses the pooled SSH connection. ---

  async function writeFile(ref, path, content, mode = 'overwrite') {
    const { client } = await connection(ref)
    const written = await withSftp(client, (sftp) => sftpWriteText(sftp, path, content, { mode }))
    return { host: ref, ...written }
  }

  async function makeDirectory(ref, path) {
    const { client } = await connection(ref)
    const created = await withSftp(client, (sftp) => sftpMkdir(sftp, path))
    return { host: ref, ...created }
  }

  async function renamePath(ref, from, to) {
    const { client } = await connection(ref)
    const renamed = await withSftp(client, (sftp) => sftpRename(sftp, from, to))
    return { host: ref, ...renamed }
  }

  async function deletePath(ref, path, { recursive = false } = {}) {
    const { client } = await connection(ref)
    const deleted = await withSftp(client, (sftp) => sftpDelete(sftp, path, { recursive }))
    return { host: ref, ...deleted }
  }

  async function chmodPath(ref, path, mode) {
    const { client } = await connection(ref)
    const changed = await withSftp(client, (sftp) => sftpChmod(sftp, path, mode))
    return { host: ref, ...changed }
  }

  async function chownPath(ref, path, uid, gid) {
    const { client } = await connection(ref)
    const changed = await withSftp(client, (sftp) => sftpChown(sftp, path, uid, gid))
    return { host: ref, ...changed }
  }

  async function searchFiles(ref, dir, query, { limit = FILE_SEARCH_LIMIT_DEFAULT } = {}) {
    const { client } = await connection(ref)
    const found = await withSftp(client, (sftp) => sftpSearch(sftp, dir, query, { limit }))
    return { host: ref, ...found }
  }

  /** Capability matrix for the page; no host names or secrets. */
  function protocols() {
    return { protocols: listProtocols() }
  }

  /** Launch a local RDP/VNC viewer; the Host machine must already have one installed. */
  function guiOpen(ref, protocol) {
    const spec = resolve(ref)
    const id = normalizeProtocol(protocol, ref || 'host')
    if (!GUI_PROTOCOLS.has(id)) {
      const error = new Error(`gui-open 只支持 rdp 或 vnc（收到 ${id}）`)
      error.code = 'GUI_PROTOCOL'
      throw error
    }
    const adapter = getProtocol(id)
    if (!adapter?.capabilities.gui) {
      const error = new Error(`协议 ${id} 不能打开外部桌面客户端`)
      error.code = 'GUI_PROTOCOL'
      throw error
    }
    return { host: spec.alias || ref, protocol: id, ...launchGuiClient(id, spec.host, spec.port) }
  }

  async function uploadBegin(ref, { path, size, mode }) {
    const { client } = await connection(ref)
    return uploads.begin({ client, host: ref, path, size, mode })
  }

  function uploadChunk(uploadId, offset, buffer) {
    return uploads.chunk(uploadId, offset, buffer)
  }

  function uploadFinish(uploadId, sha256 = null) {
    return uploads.finish(uploadId, { sha256 })
  }

  function uploadAbort(uploadId) {
    return uploads.abort(uploadId)
  }

  async function upload(ref, { remotePath, content, localPath }) {
    const hasContent = typeof content === 'string'
    const hasLocal = typeof localPath === 'string' && localPath.trim().length > 0
    if (hasContent === hasLocal) throw new Error('content 和 localPath 必须二选一：文本内容用 content，本地文件用 localPath')
    const { client } = await connection(ref)
    const written = await withSftp(client, (sftp) => (
      hasContent ? sftpWrite(sftp, remotePath, content) : sftpUploadFile(sftp, localPath, remotePath)
    ))
    return { host: ref, remotePath, ...written }
  }

  async function mkdir(ref, path) {
    const { client } = await connection(ref)
    const created = await withSftp(client, (sftp) => sftpEnsureDir(sftp, path))
    return { host: ref, ...created }
  }

  async function tunnelOpen(ref, target) {
    const normalized = normalizeForwardTarget(target)
    const { client } = await connection(ref)
    const handle = await openLocalForward(client, normalized)
    const record = tunnels.add({
      host: ref,
      remoteHost: normalized.remoteHost,
      remotePort: normalized.remotePort,
      localPort: handle.localPort,
      handle,
    })
    return describeTunnel(record)
  }

  function tunnelClose(tunnelId) {
    const record = tunnels.get(tunnelId)
    if (!record) return { closed: false, tunnelId: String(tunnelId ?? '') }
    try { record.handle?.close?.() } catch { /* listener already gone */ }
    tunnels.remove(record.id)
    return { closed: true, tunnelId: record.id }
  }

  async function shellOpen(ref, { term, cols, rows } = {}) {
    const spec = resolve(ref)
    const normalizedTerm = typeof term === 'string' && term.trim() ? term.trim() : 'xterm-256color'
    const normalizedCols = Math.min(500, Math.max(20, Number(cols) || 120))
    const normalizedRows = Math.min(200, Math.max(5, Number(rows) || 40))
    const session = await openTerminalSession(spec, ref, {
      term: spec.protocol === 'telnet' ? 'telnet' : normalizedTerm,
      cols: normalizedCols,
      rows: normalizedRows,
      panel: false,
    })
    return {
      sessionId: session.id,
      host: ref,
      protocol: spec.protocol,
      term: session.term,
      cols: normalizedCols,
      rows: normalizedRows,
      openedAt: session.openedAt,
    }
  }

  async function shellSend(sessionId, input, waitMs) {
    const session = shells.get(sessionId)
    if (!session) throw new Error(`shell 会话 ${sessionId} 不存在（可能已关闭）；先 remote_shell_open`)
    const wait = Math.min(SHELL_WAIT_MAX_MS, Math.max(SHELL_WAIT_MIN_MS, Number.isFinite(Number(waitMs)) ? Math.floor(Number(waitMs)) : SHELL_WAIT_DEFAULT_MS))
    shells.write(sessionId, input)
    await delay(wait)
    const taken = shells.take(sessionId)
    return {
      sessionId: session.id,
      host: session.host,
      waitMs: wait,
      output: taken ? taken.output : '',
      bytes: taken ? taken.bytes : 0,
      truncated: taken ? taken.truncated : false,
      closed: taken ? taken.closed : true,
    }
  }

  function shellClose(sessionId) {
    return { closed: shells.close(sessionId), sessionId: String(sessionId ?? '') }
  }

  // --- Panel terminal (v1.5). Shares the pool and ShellRegistry with the remote_shell_* tools. ---

  function sweepPanelShells() {
    shells.sweepIdle({ maxIdleMs: SHELL_PANEL_IDLE_MS, panelOnly: true })
  }

  function panelSession(sessionId) {
    sweepPanelShells()
    const id = String(sessionId ?? '')
    const session = shells.get(id)
    if (!session || !session.panel) {
      const error = new Error(`会话 ${id} 不存在（可能已关闭或超时）`)
      error.code = 'SHELL_NOT_FOUND'
      throw error
    }
    return session
  }

  function encodePanelOutput(session) {
    const taken = shells.take(session.id, SHELL_PANEL_RAW_BYTES)
    const output = taken ? taken.output : ''
    return {
      sessionId: session.id,
      seq: taken ? taken.seq : session.seq,
      output: Buffer.from(output, 'utf8').toString('base64'),
      bytes: taken ? taken.bytes : 0,
      truncated: taken ? Boolean(taken.truncated) : false,
      exited: Boolean(taken ? taken.closed : session.closed),
    }
  }

  async function shellPanelOpen(ref, { cols = SHELL_COLS_DEFAULT, rows = SHELL_ROWS_DEFAULT } = {}) {
    sweepPanelShells()
    const activePanels = [...shells.sessions.values()].filter((session) => session.panel && !session.closed).length
    if (activePanels >= SHELL_PANEL_MAX_SESSIONS) {
      const error = new Error(`终端会话已达上限（${SHELL_PANEL_MAX_SESSIONS}），先关闭一个`)
      error.code = 'SHELL_LIMIT'
      throw error
    }
    const spec = resolve(ref)
    const session = await openTerminalSession(spec, ref, { cols, rows, panel: true })
    return { id: session.id, host: ref, protocol: spec.protocol, cols: session.cols, rows: session.rows }
  }

  function shellPanelResize(session, cols, rows) {
    if (cols === undefined && rows === undefined) return
    shells.resize(session.id, cols === undefined ? session.cols : cols, rows === undefined ? session.rows : rows)
  }

  async function shellPanelSend(sessionId, input, { cols, rows } = {}) {
    const session = panelSession(sessionId)
    shellPanelResize(session, cols, rows)
    if (input && !session.closed) {
      // Preserve bytes the panel has not polled yet: the send response should not swallow them.
      shells.write(session.id, input, { clearBuffer: false })
    }
    await delay(SHELL_PANEL_WAIT_MS)
    return encodePanelOutput(session)
  }

  function shellPanelRead(sessionId) {
    return encodePanelOutput(panelSession(sessionId))
  }

  function shellSessionMeta(session) {
    return {
      id: session.id,
      host: session.host,
      cols: session.cols,
      rows: session.rows,
      createdAt: session.openedAt,
      lastActiveAt: new Date(session.lastActiveAt).toISOString(),
      closed: Boolean(session.closed),
    }
  }

  /** Re-attach a refreshed page to a live panel PTY and replay the transcript tail. */
  function shellPanelAttach(sessionId, { cols, rows } = {}) {
    const session = panelSession(sessionId)
    shellPanelResize(session, cols, rows)
    const backlog = shells.logTail(session.id, SHELL_BACKLOG_BYTES)
    // The backlog already includes unread bytes, so drop the pending read buffer; otherwise the
    // next poll would replay the same tail on top of the replayed backlog.
    shells.clearBuffer(session.id)
    return {
      session: shellSessionMeta(session),
      backlog: Buffer.from(backlog ? backlog.output : '', 'utf8').toString('base64'),
      backlogBytes: backlog ? backlog.bytes : 0,
      truncated: backlog ? Boolean(backlog.truncated) : false,
    }
  }

  function shellPanelLog(sessionId, maxBytes = SHELL_LOG_BYTES) {
    const session = panelSession(sessionId)
    const tail = shells.logTail(session.id, maxBytes)
    return {
      sessionId: session.id,
      bytes: tail ? tail.bytes : 0,
      total: tail ? tail.total : 0,
      truncated: tail ? Boolean(tail.truncated) : false,
      output: Buffer.from(tail ? tail.output : '', 'utf8').toString('base64'),
    }
  }

  /** Resize a panel PTY; throws SHELL_NOT_FOUND for an unknown/closed/swept session. */
  function shellPanelResizeSession(sessionId, cols, rows) {
    const session = panelSession(sessionId)
    shells.resize(session.id, cols, rows)
    return { cols, rows }
  }

  function shellPanelClose(sessionId) {
    const session = panelSession(sessionId)
    shells.close(session.id)
    return { closed: true, sessionId: session.id }
  }

  // --- Embedded desktop: VNC on the target, SSH tunnel to loopback, WebSocket to the page ------
  // The browser never needs a viewer: noVNC speaks RFB over a WebSocket that the host webserver
  // upgrades into this runtime, and the bytes travel the same SSH forward the tunnel column shows.
  const vncTokens = createTokenStore()
  const vncDesktops = new Map()
  const platformCache = new Map()

  async function platformOf(ref) {
    if (platformCache.has(ref)) return platformCache.get(ref)
    const probe = await execCommand(ref, 'uname -s 2>/dev/null || ver', 15)
    const text = `${probe.stdout || ''}${probe.stderr || ''}`.toLowerCase()
    const platform = text.includes('windows') ? 'win32' : 'linux'
    platformCache.set(ref, platform)
    return platform
  }

  function desktopUnsupported(protocol) {
    const error = new Error(`协议 ${protocol} 不支持内嵌桌面（远程桌面需要 SSH 主机）`)
    error.code = 'DESKTOP_UNSUPPORTED_PROTOCOL'
    return error
  }

  async function desktopStatus(ref) {
    const spec = resolve(ref)
    if (spec.protocol !== DEFAULT_PROTOCOL_ID) throw desktopUnsupported(spec.protocol)
    const platform = await platformOf(ref)
    const probe = platform === 'win32'
      ? await execCommand(ref, windowsProbeCommand(), 25)
      : await execCommand(ref, probeScript(), 25)
    const vnc = platform === 'win32' ? parseWindowsProbe(probe.stdout) : parseProbe(probe.stdout)
    const owned = vncDesktops.get(ref) || null
    return {
      host: ref,
      protocol: spec.protocol,
      platform,
      vnc,
      ownedByPanel: Boolean(owned),
      ownedDisplay: owned?.display ?? null,
    }
  }

  /** Start (or reuse) a loopback-only VNC server on the target. Throws coded errors for the page. */
  async function desktopStart(ref, { geometry, display, port } = {}) {
    const status = await desktopStatus(ref)
    if (status.vnc.running) {
      return {
        host: ref,
        started: false,
        reused: true,
        port: status.vnc.port,
        display: status.vnc.display ?? vncDesktops.get(ref)?.display ?? null,
        server: status.vnc.server,
      }
    }
    if (!status.vnc.installed) {
      const error = new Error('目标机没有可用的 VNC 服务（Xtigervnc / x11vnc / tvnserver 都没找到）')
      error.code = 'VNC_SERVER_MISSING'
      error.install = vncServerInstallInfo(status.platform)
      throw error
    }
    const chosenDisplay = normalizeDisplay(display) ?? VNC_DISPLAY_DEFAULT
    const chosenGeometry = normalizeGeometry(geometry)
    const chosenPort = normalizeVncPort(port) ?? VNC_PORT_DEFAULT
    if (status.platform === 'win32') {
      const attempt = await execCommand(ref, 'sc start tvnserver 2>&1 || net start tvnserver 2>&1', 40)
      const waited = await execCommand(ref, windowsWaitScript(chosenPort), 40)
      if (!/READY/.test(waited.stdout || '')) {
        const error = new Error(`启动 tvnserver 失败：${clipUtf8(`${attempt.stdout}${attempt.stderr}`, 400).text.trim() || '服务没有在 5900 上监听'}`)
        error.code = 'VNC_START_FAILED'
        throw error
      }
      vncDesktops.set(ref, { display: null, port: 5900, pid: null, startedAt: Date.now() })
      return { host: ref, started: true, reused: false, port: 5900, display: null, server: 'tvnserver' }
    }
    const binary = status.vnc.binaries.includes('Xtigervnc')
      ? 'Xtigervnc'
      : status.vnc.binaries.includes('vncserver') ? 'vncserver' : 'x11vnc'
    const launched = await execCommand(ref, startScript({
      display: chosenDisplay,
      geometry: chosenGeometry,
      port: chosenPort,
      binary,
    }), 30)
    if (/MISSING/.test(launched.stdout || '')) {
      const error = new Error(`目标机缺少 ${binary}`)
      error.code = 'VNC_SERVER_MISSING'
      error.install = vncServerInstallInfo(status.platform)
      throw error
    }
    const waited = await execCommand(ref, waitForPortScript(chosenPort), 30)
    if (!/READY/.test(waited.stdout || '')) {
      const log = await execCommand(ref, 'tail -n 12 /tmp/dsh-vnc.log 2>/dev/null || true', 15)
      const error = new Error(`VNC 服务没有在 127.0.0.1:${chosenPort} 就绪：${clipUtf8(log.stdout || '', 600).text.trim() || '启动超时'}`)
      error.code = 'VNC_START_FAILED'
      throw error
    }
    const pidResult = await execCommand(ref, pidScript({ display: chosenDisplay, port: chosenPort }), 15)
    const pid = Number(String(pidResult.stdout || '').trim().split(/\s+/)[0]) || null
    vncDesktops.set(ref, { display: chosenDisplay, port: chosenPort, pid, startedAt: Date.now() })
    return {
      host: ref,
      started: true,
      reused: false,
      port: chosenPort,
      display: chosenDisplay,
      server: binary,
    }
  }

  /** Stop only the instance this panel started; somebody else's VNC keeps running. */
  async function desktopStop(ref) {
    const record = vncDesktops.get(ref)
    if (!record) return { host: ref, stopped: false, reason: '本插件没有启动过该主机的桌面' }
    const platform = await platformOf(ref)
    if (platform === 'win32') {
      await execCommand(ref, 'sc stop tvnserver 2>&1 || net stop tvnserver 2>&1', 40)
      vncDesktops.delete(ref)
      return { host: ref, stopped: true, display: null }
    }
    const result = await execCommand(ref, stopScript({ display: record.display, pid: record.pid }), 20)
    vncDesktops.delete(ref)
    return { host: ref, stopped: /STOPPED/.test(result.stdout || ''), display: record.display }
  }

  /**
   * Install a VNC server on the target itself when the target has no browser-viewable desktop
   * service. Windows: TightVNC MSI, silent, service auto-start, loopback-only + firewall block.
   * Linux: distro package manager. The user never copies a command into a terminal.
   */
  async function desktopInstall(ref) {
    const before = await desktopStatus(ref)
    if (before.vnc.installed) {
      return {
        host: ref,
        platform: before.platform,
        installed: true,
        already: true,
        exitCode: 0,
        steps: [],
        vnc: before.vnc,
      }
    }
    const script = before.platform === 'win32' ? null : linuxInstallScript()
    const lines = []
    let installExit = 0
    if (before.platform === 'win32') {
      // 目标机的 exec 通道只跑第一行、`if (...)` 之后还会截断，所以按步执行并逐条收集输出。
      for (const step of windowsInstallSteps()) {
        const run = await execCommand(ref, step.command, step.id === 'install' || step.id === 'download' ? 300 : 60)
        if (step.id === 'install') installExit = run.exitCode
        lines.push(`[${step.id}] exit ${run.exitCode}`)
        const text = `${run.stdout || ''}${run.stderr || ''}`.trim()
        if (text) lines.push(text)
      }
    } else {
      const run = await execCommand(ref, script, 300)
      lines.push(`[install] exit ${run.exitCode}`)
      const text = `${run.stdout || ''}${run.stderr || ''}`.trim()
      if (text) lines.push(text)
    }
    const parsed = parseInstallLog(lines.join('\n'))
    if (before.platform === 'win32' && parsed.downloaded) {
      await execCommand(ref, windowsWaitScript(VNC_PORT_DEFAULT), 40)
    }
    const after = await desktopStatus(ref)
    const result = {
      host: ref,
      platform: after.platform,
      installed: Boolean(after.vnc.installed),
      already: false,
      exitCode: installExit,
      steps: parsed.tail,
      vnc: after.vnc,
    }
    if (!result.installed) {
      const error = new Error(
        parsed.noPackageManager
          ? '目标机既没有 apt/dnf 也没有可用的安装源，无法自动安装 VNC 服务'
          : `目标机上自动安装 VNC 服务没有成功${parsed.msiExitCode !== null ? `（MSI 退出码 ${parsed.msiExitCode}）` : ''}`,
      )
      error.code = 'VNC_INSTALL_FAILED'
      error.steps = parsed.tail
      error.install = vncServerInstallInfo(after.platform)
      throw error
    }
    vncDesktops.delete(ref)
    return result
  }

  /** Issue a one-time upgrade token bound to an already-running loopback tunnel. */
  async function desktopConnect(ref, { port } = {}) {
    const status = await desktopStatus(ref)
    if (!status.vnc.running) {
      const error = new Error('目标机还没有正在运行的 VNC 服务，请先点「启动远程桌面」')
      error.code = 'VNC_NOT_RUNNING'
      throw error
    }
    const vncPort = normalizeVncPort(port) ?? status.vnc.port ?? VNC_PORT_DEFAULT
    const existing = tunnels.list().find((record) =>
      record.host === ref && record.remoteHost === '127.0.0.1' && Number(record.remotePort) === vncPort)
    const tunnel = existing ?? await tunnelOpen(ref, { remoteHost: '127.0.0.1', remotePort: vncPort })
    const localPort = Number(String(tunnel.local || '').split(':').pop())
    const issued = vncTokens.issue({ host: ref, localPort, vncPort })
    return {
      host: ref,
      session: {
        token: issued.token,
        wsPath: `${ROUTE_PREFIX}/vnc-ws`,
        localPort,
        vncPort,
        expiresIn: issued.expiresIn,
      },
    }
  }

  /**
   * The upgraded-socket handler: validate the one-time token and same-origin, finish the
   * WebSocket handshake, then pump frames into the loopback tunnel that reaches the target.
   */
  function bridgeDesktop(request, socket, head) {
    let token = ''
    try { token = new URL(request.url || '/', 'http://localhost').searchParams.get('token') || '' } catch { token = '' }
    const origin = request?.headers?.origin
    const hostHeader = request?.headers?.host
    if (origin && hostHeader) {
      try {
        const source = new URL(origin)
        if (source.host !== hostHeader && !(LOOPBACK_HOSTS.has(source.hostname) && LOOPBACK_HOSTS.has(String(hostHeader).split(':')[0]))) {
          refuseUpgrade(socket, 403, '只接受本地同源请求')
          return
        }
      } catch {
        refuseUpgrade(socket, 403, '来源地址无法解析')
        return
      }
    }
    const claim = vncTokens.take(token)
    if (!claim) {
      refuseUpgrade(socket, 401, 'token 无效或已过期，请重新连接')
      return
    }
    if (!performHandshake(request, socket, head)) {
      return
    }
    const upstream = net.connect({ host: '127.0.0.1', port: claim.localPort })
    let peer = null
    const teardown = (reason) => {
      try { upstream.destroy() } catch { /* already closed */ }
      peer?.finish?.(reason)
    }
    upstream.once('connect', () => {
      peer = new WebSocketPeer(socket, {
        write: (chunk) => { try { upstream.write(chunk) } catch { teardown('upstream-write-failed') } },
        onClose: (reason) => teardown(reason),
      })
    })
    upstream.on('data', (chunk) => { peer?.send(chunk) })
    upstream.once('error', (error) => {
      const message = `隧道连接失败：${error?.message || error}`
      if (peer) peer.fail(1011, message)
      else refuseUpgrade(socket, 502, message)
    })
    upstream.once('close', () => { peer?.finish('upstream-close') })
    socket.on('close', () => { try { upstream.destroy() } catch { /* already closed */ } })
  }

  function dispose() {
    for (const record of tunnels.drain()) {
      try { record.handle?.close?.() } catch { /* listener already gone */ }
    }
    shells.drain()
    uploads.drain().catch(() => { /* best effort */ })
    pool.closeAll()
  }

  return {
    options,
    listHosts,
    groups,
    execCommand,
    clusterExec,
    listRemote,
    download,
    downloadFile,
    writeFile,
    makeDirectory,
    renamePath,
    deletePath,
    chmodPath,
    chownPath,
    searchFiles,
    protocols,
    guiOpen,
    uploadBegin,
    uploadChunk,
    uploadFinish,
    uploadAbort,
    upload,
    mkdir,
    tunnelOpen,
    tunnelClose,
    tunnels,
    shellOpen,
    shellSend,
    shellClose,
    shellPanelOpen,
    shellPanelSend,
    shellPanelRead,
    shellPanelAttach,
    shellPanelLog,
    shellPanelClose,
    shellPanelResizeSession,
    shells,
    vncTokens,
    desktopStatus,
    desktopStart,
    desktopInstall,
    desktopStop,
    desktopConnect,
    bridgeDesktop,
    saveHost,
    deleteHost,
    dispose,
  }
}

// ---------------------------------------------------------------------------------------------
// Renderers: what the model reads. Rendering is separate from the JSON value in output.schema.
// ---------------------------------------------------------------------------------------------

const textBlocks = (text) => [{ type: 'text', text }]

function renderJson(_args, value) {
  return textBlocks(JSON.stringify(value, null, 2))
}

function renderHosts(_args, value) {
  const lines = [`主机来源：${value.source}${value.path ? `（${value.path}）` : ''}`]
  if (value.configError) lines.push(`注意：${value.configError}`)
  if (value.hosts.length === 0) {
    lines.push('（没有可用主机）')
  } else {
    for (const host of value.hosts) {
      const auth = host.auth === 'password' ? '密码' : host.auth === 'key' ? '私钥' : host.auth === 'default-key' ? '默认私钥' : '无凭据'
      const flags = [host.ready ? '可用' : '不可用', host.disabled ? '禁用' : null, host.note].filter(Boolean).join('，')
      const via = Array.isArray(host.jump) && host.jump.length > 0 ? `  经跳板 ${host.jump.join(' → ')}` : ''
      const meta = [
        host.env ? `env:${host.env}` : null,
        host.group ? `group:${host.group}` : null,
        Array.isArray(host.tags) && host.tags.length > 0 ? `tags:${host.tags.join(',')}` : null,
      ].filter(Boolean).join(' ')
      lines.push(`- ${host.alias}  ${host.user}@${host.host}:${host.port}  ${auth}${via}${meta ? `  ${meta}` : ''}  ${flags}`)
      if (host.issue) lines.push(`    问题：${host.issue}`)
    }
  }
  if (value.pooled.length > 0) lines.push(`已连接：${value.pooled.map((item) => item.key).join('、')}`)
  if (value.tunnels.length > 0) lines.push(`隧道：${value.tunnels.map((item) => `${item.tunnelId} ${item.local}→${item.remote}`).join('；')}`)
  if (value.shells.length > 0) lines.push(`Shell 会话：${value.shells.map((item) => item.sessionId).join('、')}`)
  return textBlocks(lines.join('\n'))
}

function renderExec(_args, value) {
  const lines = [`主机 ${value.host} · exit ${value.exitCode ?? '—'}${value.timedOut ? '（超时被终止）' : ''} · ${value.durationMs ?? 0}ms`]
  if (value.truncated?.stdout) lines.push(`stdout 已截断：原始 ${value.stdoutBytes} 字节，只保留前 ${LIMITS.stdoutBytes} 字节`)
  if (value.truncated?.stderr) lines.push(`stderr 已截断：原始 ${value.stderrBytes} 字节，只保留前 ${LIMITS.stderrBytes} 字节`)
  lines.push('--- stdout ---', value.stdout || '（空）')
  if (value.stderr) lines.push('--- stderr ---', value.stderr)
  return textBlocks(lines.join('\n'))
}

function renderListing(_args, value) {
  const lines = [`${value.host}:${value.path}（${value.total} 项${value.truncated ? '，已截断' : ''}）`]
  for (const entry of value.entries) {
    const size = entry.isDir ? '-' : String(entry.size ?? '-')
    lines.push(`${entry.isDir ? 'd' : '-'} ${size.padStart(10)} ${entry.mtime || ''} ${entry.name}`)
  }
  if (value.entries.length === 0) lines.push('（空目录）')
  return textBlocks(lines.join('\n'))
}

function renderDownload(_args, value) {
  const header = `${value.host}:${value.path}（${value.size} 字节${value.truncated ? '，仅返回前缀' : ''}）`
  return textBlocks(`${header}\n--- 内容 ---\n${value.content || '（空文件）'}`)
}

function renderTunnels(_args, value) {
  if (value.tunnels.length === 0) return textBlocks('（没有打开的隧道）')
  return textBlocks(value.tunnels.map((tunnel) => (
    `${tunnel.tunnelId}  ${tunnel.local} → ${tunnel.remote}  经 ${tunnel.host}  建于 ${tunnel.createdAt}`
  )).join('\n'))
}

function renderCluster(_args, value) {
  const lines = [`集群执行：${value.total} 台（成功 ${value.succeeded}，失败 ${value.failed}）· ${value.durationMs}ms`, `命令：${value.command}`]
  for (const item of value.results) {
    lines.push('')
    lines.push(`=== ${item.host} · exit ${typeof item.exitCode === 'number' && item.exitCode >= 0 ? item.exitCode : '—'}${item.timedOut ? '（超时）' : ''} · ${item.durationMs ?? 0}ms${item.error ? ' · 错误' : ''} ===`)
    if (item.error) lines.push(`连接/执行失败：${item.error}`)
    if (item.truncated?.stdout) lines.push('stdout 已按每台 16KB 截断')
    if (item.stdout) lines.push(item.stdout.replace(/\n+$/, ''))
    if (item.stderr) lines.push(`--- stderr ---\n${item.stderr.replace(/\n+$/, '')}`)
  }
  return textBlocks(lines.join('\n'))
}

// ---------------------------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------------------------

const HOST_PARAM = {
  type: 'string',
  description: '主机别名（config.hosts / DSH_REMOTE_HOSTS 文件里的键）或临时写法 user@host[:port]（临时写法只支持默认私钥）',
}

const TIMEOUT_PARAM = {
  type: 'number',
  minimum: MIN_TIMEOUT_SEC,
  maximum: MAX_TIMEOUT_SEC,
  description: `命令超时秒数，默认 60，上限 ${MAX_TIMEOUT_SEC}；超时后命令被 KILL 并返回已收到的部分输出`,
}

const EXEC_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    host: { type: 'string' },
    exitCode: { description: '退出码；超时或信号终止时为 null' },
    signal: { type: 'string', description: '终止信号（如 KILL），正常退出为空字符串' },
    stdout: { type: 'string', description: '标准输出，最多 64KB' },
    stderr: { type: 'string', description: '标准错误，最多 16KB' },
    stdoutBytes: { type: 'number', description: '截断前 stdout 的字节数' },
    stderrBytes: { type: 'number', description: '截断前 stderr 的字节数' },
    truncated: {
      type: 'object',
      properties: { stdout: { type: 'boolean' }, stderr: { type: 'boolean' } },
    },
    durationMs: { type: 'number' },
    timedOut: { type: 'boolean' },
    aborted: { type: 'boolean' },
  },
  required: ['host', 'stdout', 'stderr'],
  additionalProperties: true,
}

function registerTool(ctx, definition) {
  const dispose = ctx.tools.register(definition)
  ctx.effect(() => dispose)
}

function registerTools(ctx, runtime) {
  registerTool(ctx, {
    name: 'remote_hosts',
    description: '列出可用的 SSH 主机（别名、user@host:port、认证方式、env/group/tags、是否可用）以及当前连接池/隧道/shell 会话。先调它确认有哪些主机。密码永远不返回。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          hosts: { type: 'array', items: { type: 'object', additionalProperties: true } },
          source: { type: 'string', description: 'config | env | package | none' },
          path: { type: 'string', description: '主机 JSON 路径；内联 config.hosts 时为 null' },
          configError: { type: 'string', description: '配置问题说明；没有问题时为空串' },
          pooled: { type: 'array', items: { type: 'object', additionalProperties: true } },
          tunnels: { type: 'array', items: { type: 'object', additionalProperties: true } },
          shells: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
        additionalProperties: true,
      },
      render: renderHosts,
    },
    async execute() {
      return runtime.listHosts()
    },
  })

  registerTool(ctx, {
    name: 'remote_exec',
    description: '在一台 SSH 主机执行一条命令，返回 stdout/stderr/退出码。连接按主机复用；stdout 截断 64KB、stderr 16KB。适合查看状态、跑一次性脚本；需要连续状态或 REPL 时用 remote_shell_*。',
    parameters: {
      type: 'object',
      properties: { host: HOST_PARAM, command: { type: 'string', description: '要执行的命令（交给远端 shell 解释）' }, timeoutSec: TIMEOUT_PARAM },
      required: ['host', 'command'],
      additionalProperties: false,
    },
    output: { schema: EXEC_OUTPUT_SCHEMA, render: renderExec },
    async execute(args, exec) {
      const result = await runtime.execCommand(args.host, args.command, args.timeoutSec, { abortSignal: exec?.signal || null })
      // 宿主的工具输出校验要求 signal 是 string（null 会被判成 "must be a string"），正常退出给空串。
      return { ...result, signal: result?.signal || '' }
    },
  })

  registerTool(ctx, {
    name: 'remote_cluster_exec',
    description: '在最多 10 台主机并发执行同一条命令，返回每台的退出码/stdout/stderr/耗时/错误。单台连接或执行失败不影响其它台；每台 stdout、stderr 各截断 16KB。用于跨机器巡检、批量确认。',
    parameters: {
      type: 'object',
      properties: {
        hosts: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10, description: '主机别名数组，最多 10 台，不能重复' },
        command: { type: 'string', description: '每台主机执行同一条命令' },
        timeoutSec: TIMEOUT_PARAM,
      },
      required: ['hosts', 'command'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          total: { type: 'number' },
          succeeded: { type: 'number', description: 'exitCode 为 0 且没有连接错误的主机数' },
          failed: { type: 'number' },
          durationMs: { type: 'number' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                host: { type: 'string' },
                exitCode: { type: 'number', description: '退出码；连接失败时为 -1' },
                stdout: { type: 'string', description: '每台最多 16KB' },
                stderr: { type: 'string', description: '每台最多 16KB' },
                durationMs: { type: 'number' },
                timedOut: { type: 'boolean' },
                error: { type: 'string', description: '连接或执行失败原因；成功为空串' },
              },
              additionalProperties: true,
            },
          },
        },
        additionalProperties: true,
      },
      render: renderCluster,
    },
    async execute(args) {
      return runtime.clusterExec(args.hosts, args.command, args.timeoutSec)
    },
  })

  registerTool(ctx, {
    name: 'remote_ls',
    description: '用 SFTP 列远程目录（目录在前），返回名字/是否目录/大小/mtime，最多 500 项。',
    parameters: {
      type: 'object',
      properties: { host: HOST_PARAM, path: { type: 'string', description: '远端目录绝对路径' } },
      required: ['host', 'path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          host: { type: 'string' },
          path: { type: 'string' },
          total: { type: 'number' },
          truncated: { type: 'boolean' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                isDir: { type: 'boolean' },
                size: { description: '字节数；目录为 null' },
                mtime: { type: 'string' },
              },
              additionalProperties: true,
            },
          },
        },
        additionalProperties: true,
      },
      render: renderListing,
    },
    async execute(args) {
      return runtime.listRemote(args.host, args.path)
    },
  })

  registerTool(ctx, {
    name: 'remote_download',
    description: '用 SFTP 读取远端文本文件内容（最多 64KB），truncated 标注是否只拿到前缀，size 是文件真实大小。二进制文件不适合此工具。',
    parameters: {
      type: 'object',
      properties: {
        host: HOST_PARAM,
        path: { type: 'string', description: '远端文件绝对路径' },
      },
      required: ['host', 'path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          host: { type: 'string' },
          path: { type: 'string' },
          content: { type: 'string', description: 'UTF-8 文本，最多 64KB（默认）' },
          size: { type: 'number', description: '文件真实大小' },
          bytes: { type: 'number', description: '本次返回的字节数' },
          truncated: { type: 'boolean' },
        },
        required: ['host', 'path', 'content'],
        additionalProperties: true,
      },
      render: renderDownload,
    },
    async execute(args) {
      return runtime.download(args.host, args.path, LIMITS.sftpReadBytes)
    },
  })

  registerTool(ctx, {
    name: 'remote_upload',
    description: '用 SFTP 写远端文件：文本用 content（整体覆盖），本机已有文件用 localPath（二进制安全）。content 与 localPath 必须二选一。',
    parameters: {
      type: 'object',
      properties: {
        host: HOST_PARAM,
        remotePath: { type: 'string', description: '远端目标文件绝对路径' },
        content: { type: 'string', description: '要写入的 UTF-8 文本（与 localPath 二选一）' },
        localPath: { type: 'string', description: '本机源文件路径（与 content 二选一）' },
      },
      required: ['host', 'remotePath'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          host: { type: 'string' },
          remotePath: { type: 'string' },
          path: { type: 'string' },
          bytes: { type: 'number' },
          localPath: { type: 'string' },
        },
        additionalProperties: true,
      },
      render: renderJson,
    },
    async execute(args) {
      return runtime.upload(args.host, { remotePath: args.remotePath, content: args.content, localPath: args.localPath })
    },
  })

  registerTool(ctx, {
    name: 'remote_mkdir',
    description: '用 SFTP 创建远端目录，缺失的父目录一起创建；已存在时返回 existed:true。',
    parameters: {
      type: 'object',
      properties: { host: HOST_PARAM, path: { type: 'string', description: '要创建的远端目录路径' } },
      required: ['host', 'path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          host: { type: 'string' },
          path: { type: 'string' },
          created: { type: 'boolean' },
          existed: { type: 'boolean' },
        },
        additionalProperties: true,
      },
      render: renderJson,
    },
    async execute(args) {
      return runtime.mkdir(args.host, args.path)
    },
  })

  registerTool(ctx, {
    name: 'remote_tunnel_open',
    description: '经 SSH 主机建立本地端口转发：127.0.0.1:localPort → remoteHost:remotePort。localPort 省略则自动分配。用于访问远端内网 Web/数据库。',
    parameters: {
      type: 'object',
      properties: {
        host: HOST_PARAM,
        remoteHost: { type: 'string', description: '隧道出口主机（从 SSH 主机视角看），可写 127.0.0.1 表示 SSH 主机自身' },
        remotePort: { type: 'number', minimum: 1, maximum: 65535, description: '远端端口' },
        localPort: { type: 'number', minimum: 1, maximum: 65535, description: '本地监听端口；省略自动分配' },
      },
      required: ['host', 'remoteHost', 'remotePort'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          tunnelId: { type: 'string' },
          host: { type: 'string' },
          localPort: { type: 'number' },
          local: { type: 'string' },
          remote: { type: 'string' },
          createdAt: { type: 'string' },
        },
        additionalProperties: true,
      },
      render: renderJson,
    },
    async execute(args) {
      return runtime.tunnelOpen(args.host, {
        remoteHost: args.remoteHost,
        remotePort: args.remotePort,
        localPort: args.localPort,
      })
    },
  })

  registerTool(ctx, {
    name: 'remote_tunnel_close',
    description: '关闭一个本地转发隧道（隧道 id 来自 remote_tunnel_open / remote_tunnel_list）。',
    parameters: {
      type: 'object',
      properties: { tunnelId: { type: 'string', description: '隧道 id，如 tn1' } },
      required: ['tunnelId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { tunnelId: { type: 'string' }, closed: { type: 'boolean' } },
        additionalProperties: true,
      },
      render: renderJson,
    },
    async execute(args) {
      return runtime.tunnelClose(args.tunnelId)
    },
  })

  registerTool(ctx, {
    name: 'remote_tunnel_list',
    description: '列出当前打开的本地转发隧道（id、本地端口、远端目标、经过哪台主机）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: { tunnels: { type: 'array', items: { type: 'object', additionalProperties: true } } },
        additionalProperties: true,
      },
      render: renderTunnels,
    },
    async execute() {
      return { tunnels: runtime.tunnels.list() }
    },
  })

  registerTool(ctx, {
    name: 'remote_shell_open',
    description: '在 SSH 主机打开持久交互式 PTY（xterm-256color，默认 120x40），返回 sessionId。适合 REPL、需要连续环境状态的排障。输出会累积到会话缓冲，用 remote_shell_send 读回。',
    parameters: {
      type: 'object',
      properties: {
        host: HOST_PARAM,
        term: { type: 'string', description: '终端类型，默认 xterm-256color' },
        cols: { type: 'number', minimum: 20, maximum: 500, description: '列数，默认 120' },
        rows: { type: 'number', minimum: 5, maximum: 200, description: '行数，默认 40' },
      },
      required: ['host'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          host: { type: 'string' },
          term: { type: 'string' },
          cols: { type: 'number' },
          rows: { type: 'number' },
          openedAt: { type: 'string' },
        },
        additionalProperties: true,
      },
      render: renderJson,
    },
    async execute(args) {
      return runtime.shellOpen(args.host, { term: args.term, cols: args.cols, rows: args.rows })
    },
  })

  registerTool(ctx, {
    name: 'remote_shell_send',
    description: '向已打开的 shell 会话写入输入（原样写入，要回车请自带 \\n），等待 waitMs 后返回这期间到达的输出（最多 32KB，可能含 ANSI 控制符）。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'remote_shell_open 返回的 sessionId' },
        input: { type: 'string', description: '原样写入的内容；执行命令请以 \\n 结尾' },
        waitMs: { type: 'number', minimum: SHELL_WAIT_MIN_MS, maximum: SHELL_WAIT_MAX_MS, description: '等待输出的毫秒数，默认 1000' },
      },
      required: ['sessionId', 'input'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          host: { type: 'string' },
          output: { type: 'string', description: '最多 32KB' },
          bytes: { type: 'number' },
          truncated: { type: 'boolean' },
          closed: { type: 'boolean' },
          waitMs: { type: 'number' },
        },
        additionalProperties: true,
      },
      render: (_args, value) => textBlocks(`[${value.sessionId}@${value.host} 等待 ${value.waitMs}ms${value.closed ? '，会话已关闭' : ''}]\n${value.output || '（无输出）'}`),
    },
    async execute(args) {
      return runtime.shellSend(args.sessionId, args.input, args.waitMs)
    },
  })

  registerTool(ctx, {
    name: 'remote_shell_close',
    description: '关闭一个交互式 shell 会话（SSH 连接保留在池里，供其它工具继续复用）。',
    parameters: {
      type: 'object',
      properties: { sessionId: { type: 'string', description: 'remote_shell_open 返回的 sessionId' } },
      required: ['sessionId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { sessionId: { type: 'string' }, closed: { type: 'boolean' } },
        additionalProperties: true,
      },
      render: renderJson,
    },
    async execute(args) {
      return runtime.shellClose(args.sessionId)
    },
  })
}

// ---------------------------------------------------------------------------------------------
// HTTP routes for the Client page.
//
// The web carrier serves only GET/HEAD at the HTTP layer: POST is rejected with
// 405 + `Allow: GET, HEAD` before any plugin code runs, whether the route is a resource or a
// raw Node handler (measured on the real carrier). Writes therefore travel as GET query
// parameters, gated by a custom header that a cross-site <img>/<form> GET cannot set.
// A typert Remote would be the POST-shaped alternative; this package stays GET-only.
// ---------------------------------------------------------------------------------------------

function json(value, status = 200) {
  return Response.json(value, { status })
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const EXEC_HEADER = 'x-dsh-remote-exec'
const EXEC_HEADER_VALUE = '1'
const EXEC_QUERY_PARAMS = new Set(['host', 'command', 'timeoutSec'])
const TUNNEL_QUERY_PARAMS = new Set(['action', 'tunnelId'])
const TUNNEL_OPEN_QUERY_PARAMS = new Set(['host', 'remoteHost', 'remotePort', 'localPort'])
const FILES_QUERY_PARAMS = new Set(['host', 'path', 'sort', 'hidden'])
const FILE_QUERY_PARAMS = new Set(['host', 'path', 'maxBytes'])
const FILE_WRITE_QUERY_PARAMS = new Set(['host', 'path', 'data', 'mode'])
const FILE_MKDIR_QUERY_PARAMS = new Set(['host', 'path'])
const FILE_RENAME_QUERY_PARAMS = new Set(['host', 'from', 'to'])
const FILE_DELETE_QUERY_PARAMS = new Set(['host', 'path', 'recursive'])
const FILE_CHMOD_QUERY_PARAMS = new Set(['host', 'path', 'mode'])
const FILE_CHOWN_QUERY_PARAMS = new Set(['host', 'path', 'uid', 'gid'])
const FILE_SEARCH_QUERY_PARAMS = new Set(['host', 'dir', 'q', 'limit'])
const PROTOCOLS_QUERY_PARAMS = new Set([])
const GROUPS_QUERY_PARAMS = new Set([])
const GUI_OPEN_QUERY_PARAMS = new Set(['host', 'protocol'])
const FILE_DOWNLOAD_QUERY_PARAMS = new Set(['host', 'path', 'maxBytes'])
const UPLOAD_BEGIN_QUERY_PARAMS = new Set(['host', 'path', 'size', 'mode'])
const UPLOAD_CHUNK_QUERY_PARAMS = new Set(['uploadId', 'offset', 'data'])
const UPLOAD_FINISH_QUERY_PARAMS = new Set(['uploadId', 'sha256'])
const UPLOAD_ABORT_QUERY_PARAMS = new Set(['uploadId'])
const HOST_SAVE_QUERY_PARAMS = new Set(['alias', 'host', 'protocol', 'port', 'user', 'auth', 'secret', 'privateKeyPath', 'note', 'disabled', 'jump', 'env', 'group', 'tags'])
const HOST_DELETE_QUERY_PARAMS = new Set(['alias'])
const SHELL_OPEN_QUERY_PARAMS = new Set(['host', 'cols', 'rows'])
const SHELL_SEND_QUERY_PARAMS = new Set(['sessionId', 'data', 'cols', 'rows', 'bracketed'])
const SHELL_READ_QUERY_PARAMS = new Set(['sessionId'])
const SHELL_RESIZE_QUERY_PARAMS = new Set(['sessionId', 'cols', 'rows'])
const SHELL_ATTACH_QUERY_PARAMS = new Set(['sessionId', 'cols', 'rows'])
const SHELL_LOG_QUERY_PARAMS = new Set(['sessionId', 'maxBytes'])
const SHELL_CLOSE_QUERY_PARAMS = new Set(['sessionId'])
const EXEC_COMMAND_MAX_BYTES = 8 * 1024
const HOST_NAME_MAX_BYTES = 255
const HOST_USER_MAX_BYTES = 64
const HOST_SECRET_MAX_BYTES = 4096
const HOST_KEY_PATH_MAX_BYTES = 1024
const HOST_NOTE_MAX_BYTES = 200
const HOST_AUTH_MODES = new Set(['password', 'password-env', 'key', 'none'])
const HOST_ALIAS_ERROR = 'alias 只能包含字母、数字、点、下划线和连字符，且 1–64 位'
const TUNNEL_HOST_MAX_BYTES = 512
const TUNNEL_REMOTE_HOST_MAX_BYTES = 255
const FILE_HOST_MAX_BYTES = 512
const FILE_PATH_MAX_BYTES = 4 * 1024
const FILE_MAX_BYTES_DEFAULT = 32 * 1024
const FILE_MAX_BYTES_LIMIT = 64 * 1024
const FILE_DOWNLOAD_BYTES_DEFAULT = LIMITS.fileDownloadBytes
const FILE_DOWNLOAD_BYTES_LIMIT = LIMITS.fileDownloadMaxBytes
const FILE_WRITE_MAX_BYTES = 256 * 1024
const FILE_SORT_MODES = new Set(['name', 'size', 'mtime'])
const FILE_WRITE_MODES = new Set(['overwrite', 'append', 'create'])
const FILE_SEARCH_LIMIT_DEFAULT = 50
const FILE_SEARCH_LIMIT_MAX = 200
const GUI_PROTOCOLS = new Set(['rdp', 'vnc'])
const UPLOAD_SIZE_LIMIT = LIMITS.uploadMaxBytes
const UPLOAD_CHUNK_LIMIT = UPLOAD_CHUNK_BYTES
const UPLOAD_MODES = new Set(['overwrite', 'append', 'create'])

function isSameOrigin(request) {
  let origin = null
  try { origin = request.headers?.get?.('origin') || null } catch { origin = null }
  // A same-origin GET (and every non-CORS request) carries no Origin header at all.
  if (!origin) return true
  let source
  try { source = new URL(origin) } catch { return false }

  // The carrier builds the Fetch Request against a placeholder base ("http://x/..."), so the
  // Request URL's host is not the host the browser actually used. The Host header is.
  const hosts = []
  try { const target = new URL(request.url); if (target.hostname && target.hostname !== 'x') hosts.push(target.hostname) } catch { /* keep going */ }
  try {
    const header = request.headers?.get?.('host')
    if (header) hosts.push(String(header).split(':')[0])
  } catch { /* keep going */ }
  if (hosts.includes(source.hostname)) return true
  // The desktop shell may reach the same local server through localhost vs 127.0.0.1;
  // both are local-only, so treat them as the same origin instead of breaking the page.
  return hosts.length > 0
    && LOOPBACK_HOSTS.has(source.hostname)
    && hosts.every((host) => LOOPBACK_HOSTS.has(host))
}

/**
 * The write gate. A cross-site page can issue a GET (img/script/form/link) but cannot attach a
 * custom request header without a CORS preflight, which this server never approves.
 */
function hasExecuteHeader(request) {
  try {
    return request.headers?.get?.(EXEC_HEADER) === EXEC_HEADER_VALUE
  } catch {
    return false
  }
}

function queryOf(request) {
  try {
    return new URL(request.url).searchParams
  } catch {
    return new URLSearchParams()
  }
}

function unsupportedParams(params, allowed) {
  const names = [...new Set([...params.keys()].filter((name) => !allowed.has(name)))]
  return names.length > 0 ? `不支持的查询参数：${names.join('、')}` : null
}

/** Parse an optional integer query param inside `[min,max]`; returns `{value}` or `{error}`. */
function shellIntParam(params, name, { min, max, fallback, message }) {
  const raw = params.get(name)
  if (raw === null || raw === '') return { value: fallback }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    return { error: json({ ok: false, error: message }, 400) }
  }
  return { value }
}

/** Strict standard-base64 decode. Returns a Buffer, or null when the text is not valid base64. */
function decodeShellData(value) {
  if (value === '') return Buffer.alloc(0)
  if (!BASE64_PATTERN.test(value)) return null
  const bytes = Buffer.from(value, 'base64')
  // Buffer.from is lenient; reject inputs that do not round-trip so padding mistakes are 400s.
  if (bytes.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) return null
  return bytes
}

function shellRouteError(error) {
  if (error?.code === 'SHELL_NOT_FOUND') return json({ ok: false, error: error.message }, 404)
  if (error?.code === 'SHELL_LIMIT') return json({ ok: false, error: error.message }, 409)
  if (/^未知主机/.test(error?.message || '')) return json({ ok: false, error: error.message }, 404)
  return json({ ok: false, error: error?.message || String(error) }, 500)
}

/** GET /api/plugins/remote/hosts — read-only listing; no header required. */
async function hostsResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  try {
    return json({ ok: true, ...runtime.listHosts() })
  } catch (error) {
    return json({ ok: false, error: error?.message || String(error) }, 500)
  }
}

/**
 * GET /api/plugins/remote/exec?host=&command=&timeoutSec=
 * Runs one command. Requires `x-dsh-remote-exec: 1`, an 8KB command cap, and no extra params.
 */
async function execResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  if (!hasExecuteHeader(request)) return json({ ok: false, error: `缺少 ${EXEC_HEADER} 头` }, 403)

  const params = queryOf(request)
  const unsupported = unsupportedParams(params, EXEC_QUERY_PARAMS)
  if (unsupported) return json({ ok: false, error: unsupported }, 400)

  const host = (params.get('host') || '').trim()
  const command = params.get('command') || ''
  if (!host) return json({ ok: false, error: 'host 必须是非空字符串' }, 400)
  if (!command.trim()) return json({ ok: false, error: 'command 必须是非空字符串' }, 400)
  if (Buffer.byteLength(command, 'utf8') > EXEC_COMMAND_MAX_BYTES) {
    return json({ ok: false, error: `command 超过 ${EXEC_COMMAND_MAX_BYTES} 字节上限（GET 查询参数不宜传大文本，长输入请用 remote_upload 或 shell）` }, 413)
  }

  let timeoutSec
  try {
    timeoutSec = normalizeTimeoutSec(params.get('timeoutSec'), { fallback: runtime.options.defaultTimeoutSec })
  } catch (error) {
    return json({ ok: false, error: error.message }, 400)
  }

  try {
    const result = await runtime.execCommand(host, command, timeoutSec)
    return json({ ok: true, result })
  } catch (error) {
    return json({ ok: false, error: error?.message || String(error) }, 500)
  }
}

/**
 * GET /api/plugins/remote/tunnels            → list (no header)
 * GET /api/plugins/remote/tunnels?action=close&tunnelId=tn1 → close (requires the write header)
 */
async function tunnelsResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)

  const params = queryOf(request)
  if ([...params.keys()].length === 0) {
    return json({ ok: true, tunnels: runtime.tunnels.list() })
  }

  if (!hasExecuteHeader(request)) return json({ ok: false, error: `缺少 ${EXEC_HEADER} 头` }, 403)

  const unsupported = unsupportedParams(params, TUNNEL_QUERY_PARAMS)
  if (unsupported) return json({ ok: false, error: unsupported }, 400)
  if (params.get('action') !== 'close') {
    return json({ ok: false, error: "action 只支持 'close'（隧道请通过 Agent 工具 remote_tunnel_open 建立）" }, 400)
  }
  const tunnelId = (params.get('tunnelId') || '').trim()
  if (!tunnelId) return json({ ok: false, error: 'tunnelId 必须是非空字符串' }, 400)

  const result = runtime.tunnelClose(tunnelId)
  if (!result.closed) return json({ ok: false, error: `隧道 ${tunnelId} 不存在（可能已关闭）` }, 404)
  return json({ ok: true, closed: true, tunnelId: result.tunnelId })
}

/**
 * GET /api/plugins/remote/tunnel-open?host=&remoteHost=&remotePort=&localPort=
 * Opens a local forward through the same runtime/connection pool the `remote_tunnel_open` tool
 * uses. Requires `x-dsh-remote-exec: 1`; host defaults for remoteHost is 127.0.0.1; localPort may
 * be omitted for an auto-assigned port.
 */
async function tunnelOpenResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  if (!hasExecuteHeader(request)) return json({ ok: false, error: `缺少 ${EXEC_HEADER} 头` }, 403)

  const params = queryOf(request)
  const unsupported = unsupportedParams(params, TUNNEL_OPEN_QUERY_PARAMS)
  if (unsupported) return json({ ok: false, error: unsupported }, 400)

  const host = (params.get('host') || '').trim()
  if (!host) return json({ ok: false, error: 'host 必须是非空字符串' }, 400)
  if (Buffer.byteLength(host, 'utf8') > TUNNEL_HOST_MAX_BYTES) {
    return json({ ok: false, error: `host 超过 ${TUNNEL_HOST_MAX_BYTES} 字节上限` }, 413)
  }

  const remoteHost = (params.get('remoteHost') || '').trim() || '127.0.0.1'
  if (Buffer.byteLength(remoteHost, 'utf8') > TUNNEL_REMOTE_HOST_MAX_BYTES) {
    return json({ ok: false, error: `remoteHost 超过 ${TUNNEL_REMOTE_HOST_MAX_BYTES} 字节上限` }, 413)
  }

  let target
  try {
    target = normalizeForwardTarget({
      remoteHost,
      remotePort: params.get('remotePort'),
      localPort: params.get('localPort'),
    })
  } catch (error) {
    return json({ ok: false, error: error.message }, 400)
  }

  try {
    const record = await runtime.tunnelOpen(host, target)
    return json({
      ok: true,
      tunnel: { id: record.tunnelId, local: record.local, remote: record.remote, host: record.host },
    })
  } catch (error) {
    return json({ ok: false, error: error?.message || String(error) }, 500)
  }
}

/** Validate the (host, path) pair shared by the two read-only file routes. */
function fileTarget(params) {
  const host = (params.get('host') || '').trim()
  if (!host) return { error: json({ ok: false, error: 'host 必须是非空字符串' }, 400) }
  if (Buffer.byteLength(host, 'utf8') > FILE_HOST_MAX_BYTES) {
    return { error: json({ ok: false, error: `host 超过 ${FILE_HOST_MAX_BYTES} 字节上限` }, 413) }
  }

  const path = params.get('path')
  if (path === null || path === '') return { error: json({ ok: false, error: 'path 必须是非空字符串' }, 400) }
  if (!path.startsWith('/')) {
    return { error: json({ ok: false, error: 'path 必须是绝对路径（以 / 开头）' }, 400) }
  }
  if (Buffer.byteLength(path, 'utf8') > FILE_PATH_MAX_BYTES) {
    return { error: json({ ok: false, error: `path 超过 ${FILE_PATH_MAX_BYTES} 字节上限` }, 413) }
  }
  return { host, path }
}

/** Validate one absolute remote path parameter (rename uses `from`/`to` instead). */
function filePathParam(params, name = 'path', maxBytes = FILE_PATH_MAX_BYTES) {
  const value = params.get(name)
  if (value === null || value === '') return { error: json({ ok: false, error: `${name} 必须是非空字符串` }, 400) }
  if (!value.startsWith('/')) return { error: json({ ok: false, error: `${name} 必须是绝对路径（以 / 开头）` }, 400) }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    return { error: json({ ok: false, error: `${name} 超过 ${maxBytes} 字节上限` }, 413) }
  }
  return { value }
}

/** Map SFTP write/delete errors onto the page's documented status codes. */
function sftpRouteError(error) {
  const message = error?.message || String(error)
  const code = error?.code || ''
  if (code === 'PROTOCOL_UNSUPPORTED') return json({ ok: false, error: message }, 400)
  if (code === 'GUI_PROTOCOL' || code === 'GUI_CLIENT_MISSING') return json({ ok: false, error: message }, 400)
  if (code === 'DIRECTORY_NEEDS_RECURSIVE') return json({ ok: false, error: message }, 409)
  if (code === 'SFTP_EXISTS') return json({ ok: false, error: message }, 409)
  if (code === 'SFTP_NOT_FOUND' || /No such file|not found/i.test(message)) {
    return json({ ok: false, error: message }, 404)
  }
  if (code === 'SFTP_CHOWN' || code === 'SFTP_CHMOD' || /permission denied|Permission denied/i.test(message)) {
    return json({ ok: false, error: message }, 403)
  }
  if (/unknown host|未知主机|不存在：既不是/i.test(message)) return json({ ok: false, error: message }, 404)
  return json({ ok: false, error: message }, 502)
}

/**
 * GET /api/plugins/remote/files?host=&path=
 * Lists one remote directory through the same SFTP runtime the `remote_ls` tool uses.
 */
async function filesResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  if (!hasExecuteHeader(request)) return json({ ok: false, error: `缺少 ${EXEC_HEADER} 头` }, 403)

  const params = queryOf(request)
  const unsupported = unsupportedParams(params, FILES_QUERY_PARAMS)
  if (unsupported) return json({ ok: false, error: unsupported }, 400)

  const target = fileTarget(params)
  if (target.error) return target.error

  const sort = params.get('sort') || 'name'
  if (!FILE_SORT_MODES.has(sort)) {
    return json({ ok: false, error: 'sort 必须是 name、size 或 mtime' }, 400)
  }
  const rawHidden = params.get('hidden')
  if (rawHidden !== null && rawHidden !== '0' && rawHidden !== '1') {
    return json({ ok: false, error: 'hidden 只能是 0 或 1' }, 400)
  }
  const hidden = rawHidden !== '0'

  try {
    const listing = await runtime.listRemote(target.host, target.path, { sort, hidden })
    const entries = (Array.isArray(listing.entries) ? listing.entries : []).map((entry) => ({
      name: String(entry.name),
      type: entry.type === 'dir' || entry.type === 'link' ? entry.type : entry.isDir ? 'dir' : 'file',
      size: entry.size === null || entry.size === undefined ? null : Number(entry.size),
      mtime: entry.mtime || null,
    }))
    return json({
      ok: true,
      host: target.host,
      path: target.path,
      entries,
      total: Number.isFinite(listing.total) ? listing.total : entries.length,
      truncated: Boolean(listing.truncated),
      sort: listing.sort || sort,
      hidden,
    })
  } catch (error) {
    return sftpRouteError(error)
  }
}

/**
 * GET /api/plugins/remote/file?host=&path=&maxBytes=
 * Reads a UTF-8 text prefix for the page preview. Directories are a client error; a file with NUL
 * bytes is reported as binary without content; other read failures surface the upstream message.
 */
async function fileResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  if (!hasExecuteHeader(request)) return json({ ok: false, error: `缺少 ${EXEC_HEADER} 头` }, 403)

  const params = queryOf(request)
  const unsupported = unsupportedParams(params, FILE_QUERY_PARAMS)
  if (unsupported) return json({ ok: false, error: unsupported }, 400)

  const target = fileTarget(params)
  if (target.error) return target.error

  let maxBytes = FILE_MAX_BYTES_DEFAULT
  const rawMaxBytes = params.get('maxBytes')
  if (rawMaxBytes !== null) {
    const value = Number(rawMaxBytes)
    if (!Number.isInteger(value) || value < 1 || value > FILE_MAX_BYTES_LIMIT) {
      return json({ ok: false, error: `maxBytes 必须是 1-${FILE_MAX_BYTES_LIMIT} 的整数` }, 400)
    }
    maxBytes = value
  }

  try {
    const read = await runtime.download(target.host, target.path, maxBytes)
    const content = typeof read.content === 'string' ? read.content : ''
    if (content.includes('\u0000')) {
      return json({
        ok: true,
        host: target.host,
        path: target.path,
        binary: true,
        size: Number(read.size) || 0,
        truncated: true,
      })
    }
    return json({
      ok: true,
      host: target.host,
      path: target.path,
      size: Number(read.size) || 0,
      bytes: Number(read.bytes) || 0,
      truncated: Boolean(read.truncated),
      content,
    })
  } catch (error) {
    const message = error?.message || String(error)
    if (/是目录/.test(message)) return json({ ok: false, error: message }, 400)
    return json({ ok: false, error: message }, 502)
  }
}

/**
 * GET /api/plugins/remote/file-download?host=&path=&maxBytes=
 * Binary-safe download. The whole response is base64 JSON (no streaming through this carrier), so
 * maxBytes defaults to 8MB and is capped at 16MB; the page then turns it into a Blob.
 */
async function fileDownloadResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  if (!hasExecuteHeader(request)) return json({ ok: false, error: `缺少 ${EXEC_HEADER} 头` }, 403)

  const params = queryOf(request)
  const unsupported = unsupportedParams(params, FILE_DOWNLOAD_QUERY_PARAMS)
  if (unsupported) return json({ ok: false, error: unsupported }, 400)

  const target = fileTarget(params)
  if (target.error) return target.error

  let maxBytes = FILE_DOWNLOAD_BYTES_DEFAULT
  const rawMaxBytes = params.get('maxBytes')
  if (rawMaxBytes !== null) {
    const value = Number(rawMaxBytes)
    if (!Number.isInteger(value) || value < 1 || value > FILE_DOWNLOAD_BYTES_LIMIT) {
      return json({ ok: false, error: `maxBytes 必须是 1-${FILE_DOWNLOAD_BYTES_LIMIT} 的整数` }, 400)
    }
    maxBytes = value
  }

  try {
    const read = await runtime.downloadFile(target.host, target.path, maxBytes)
    const buffer = Buffer.isBuffer(read.buffer) ? read.buffer : Buffer.from(read.buffer || [])
    const name = target.path.split('/').filter(Boolean).pop() || target.path
    const entry = read.entry || { path: target.path, size: Number(read.size) || 0, mode: null, mtime: null }
    return json({
      ok: true,
      host: target.host,
      path: target.path,
      name,
      size: Number(read.size) || 0,
      bytes: buffer.length,
      truncated: Boolean(read.truncated),
      content: buffer.toString('base64'),
      entry,
    })
  } catch (error) {
    const message = error?.message || String(error)
    if (/^未知主机/.test(message)) return json({ ok: false, error: message }, 404)
    if (/是目录/.test(message)) return json({ ok: false, error: '是一个目录，不能下载' }, 400)
    if (/stat .* 失败|No such file|not exist/i.test(message)) {
      return json({ ok: false, error: `文件不存在：${target.path}` }, 404)
    }
    return json({ ok: false, error: message }, 502)
  }
}

/** Map upload-registry failures to the same JSON error shape the read routes use. */
function uploadRouteError(error) {
  if (typeof error?.status === 'number') return json({ ok: false, error: error?.message || String(error) }, error.status)
  const code = error?.code
  if (code === 'UPLOAD_NOT_FOUND') return json({ ok: false, error: error.message }, 404)
  if (code === 'UPLOAD_LIMIT' || code === 'UPLOAD_OFFSET' || code === 'UPLOAD_INCOMPLETE' || code === 'UPLOAD_EXISTS') {
    return json({ ok: false, error: error.message }, 409)
  }
  if (code === 'UPLOAD_CHUNK' || code === 'UPLOAD_SIZE') return json({ ok: false, error: error.message }, 413)
  if (code === 'UPLOAD_CHECKSUM') return json({ ok: false, error: error.message }, 400)
  const message = error?.message || String(error)
  if (/^未知主机/.test(message)) return json({ ok: false, error: message }, 404)
  return json({ ok: false, error: message }, 500)
}

/** GET /api/plugins/remote/file-upload-begin?host=&path=&size=&mode= */
async function fileUploadBeginResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  if (!hasExecuteHeader(request)) return json({ ok: false, error: `缺少 ${EXEC_HEADER} 头` }, 403)

  const params = queryOf(request)
  const unsupported = unsupportedParams(params, UPLOAD_BEGIN_QUERY_PARAMS)
  if (unsupported) return json({ ok: false, error: unsupported }, 400)

  const target = fileTarget(params)
  if (target.error) return target.error

  const rawSize = params.get('size')
  const size = rawSize === null || rawSize.trim() === '' ? Number.NaN : Number(rawSize)
  if (!Number.isInteger(size) || size < 0 || size > UPLOAD_SIZE_LIMIT) {
    return json({ ok: false, error: `size 必须是 0-${UPLOAD_SIZE_LIMIT} 的整数` }, 400)
  }
  const rawMode = params.get('mode')
  const mode = rawMode === null || rawMode.trim() === '' ? 'overwrite' : rawMode.trim()
  if (!UPLOAD_MODES.has(mode)) {
    return json({ ok: false, error: 'mode 必须是 overwrite、append 或 create' }, 400)
  }

  try {
    const created = await runtime.uploadBegin(target.host, { path: target.path, size, mode })
    return json({ ok: true, uploadId: created.uploadId, chunkBytes: created.chunkBytes })
  } catch (error) {
    return uploadRouteError(error)
  }
}

/** GET /api/plugins/remote/file-upload-chunk?uploadId=&offset=&data=<base64> */
async function fileUploadChunkResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  if (!hasExecuteHeader(request)) return json({ ok: false, error: `缺少 ${EXEC_HEADER} 头` }, 403)

  const params = queryOf(request)
  const unsupported = unsupportedParams(params, UPLOAD_CHUNK_QUERY_PARAMS)
  if (unsupported) return json({ ok: false, error: unsupported }, 400)

  const uploadId = (params.get('uploadId') || '').trim()
  if (!uploadId) return json({ ok: false, error: 'uploadId 不能为空' }, 400)

  const rawOffset = params.get('offset')
  const offset = rawOffset === null || rawOffset.trim() === '' ? Number.NaN : Number(rawOffset)
  if (!Number.isInteger(offset) || offset < 0) {
    return json({ ok: false, error: 'offset 必须是非负整数' }, 400)
  }

  const rawData = params.get('data')
  if (rawData === null || rawData === '') return json({ ok: false, error: 'data 必须是 base64' }, 400)
  const buffer = decodeShellData(rawData)
  if (!buffer) return json({ ok: false, error: 'data 必须是合法的 base64' }, 400)
  if (buffer.length > UPLOAD_CHUNK_LIMIT) {
    return json({ ok: false, error: `单块数据超过 ${UPLOAD_CHUNK_LIMIT} 字节上限` }, 413)
  }

  try {
    const result = await runtime.uploadChunk(uploadId, offset, buffer)
    return json({ ok: true, uploadId: result.uploadId, received: result.received, total: result.total })
  } catch (error) {
    return uploadRouteError(error)
  }
}

/** GET /api/plugins/remote/file-upload-finish?uploadId=[&sha256=] */
async function fileUploadFinishResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  if (!hasExecuteHeader(request)) return json({ ok: false, error: `缺少 ${EXEC_HEADER} 头` }, 403)

  const params = queryOf(request)
  const unsupported = unsupportedParams(params, UPLOAD_FINISH_QUERY_PARAMS)
  if (unsupported) return json({ ok: false, error: unsupported }, 400)

  const uploadId = (params.get('uploadId') || '').trim()
  if (!uploadId) return json({ ok: false, error: 'uploadId 不能为空' }, 400)

  let sha256 = null
  const rawSha = params.get('sha256')
  if (rawSha !== null && rawSha !== '') {
    if (!/^[0-9a-fA-F]{64}$/.test(rawSha)) {
      return json({ ok: false, error: 'sha256 必须是 64 位十六进制字符串' }, 400)
    }
    sha256 = rawSha.toLowerCase()
  }

  try {
    const result = await runtime.uploadFinish(uploadId, sha256)
    return json({ ok: true, host: result.host, path: result.path, bytes: result.bytes })
  } catch (error) {
    return uploadRouteError(error)
  }
}

/** GET /api/plugins/remote/file-upload-abort?uploadId= */
async function fileUploadAbortResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  if (!hasExecuteHeader(request)) return json({ ok: false, error: `缺少 ${EXEC_HEADER} 头` }, 403)

  const params = queryOf(request)
  const unsupported = unsupportedParams(params, UPLOAD_ABORT_QUERY_PARAMS)
  if (unsupported) return json({ ok: false, error: unsupported }, 400)

  const uploadId = (params.get('uploadId') || '').trim()
  if (!uploadId) return json({ ok: false, error: 'uploadId 不能为空' }, 400)

  try {
    const result = await runtime.uploadAbort(uploadId)
    return json({ ok: true, aborted: Boolean(result.aborted) })
  } catch (error) {
    return uploadRouteError(error)
  }
}

/** GET /api/plugins/remote/file-write?host=&path=&data=<base64>[&mode=] — save text in place. */
async function fileWriteResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  if (!hasExecuteHeader(request)) return json({ ok: false, error: `缺少 ${EXEC_HEADER} 头` }, 403)

  const params = queryOf(request)
  const unsupported = unsupportedParams(params, FILE_WRITE_QUERY_PARAMS)
  if (unsupported) return json({ ok: false, error: unsupported }, 400)

  const target = fileTarget(params)
  if (target.error) return target.error

  const mode = params.get('mode') || 'overwrite'
  if (!FILE_WRITE_MODES.has(mode)) {
    return json({ ok: false, error: 'mode 必须是 overwrite、append 或 create' }, 400)
  }
  const data = params.get('data')
  if (data === null) return json({ ok: false, error: 'data 必须是非空 base64 字符串' }, 400)
  const bytes = decodeShellData(data)
  if (!bytes) return json({ ok: false, error: 'data 必须是合法的 base64' }, 400)
  if (bytes.length > FILE_WRITE_MAX_BYTES) {
    return json({ ok: false, error: `文件内容超过 ${FILE_WRITE_MAX_BYTES} 字节上限（就地编辑最多 256KB）` }, 413)
  }

  try {
    const written = await runtime.writeFile(target.host, target.path, bytes.toString('utf8'), mode)
    return json({ ok: true, host: target.host, path: target.path, bytes: bytes.length, mode, saved: written.saved !== false })
  } catch (error) {
    return sftpRouteError(error)
  }
}

/** GET /api/plugins/remote/file-mkdir?host=&path= — create exactly one directory. */
async function fileMkdirResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  if (!hasExecuteHeader(request)) return json({ ok: false, error: `缺少 ${EXEC_HEADER} 头` }, 403)

  const params = queryOf(request)
  const unsupported = unsupportedParams(params, FILE_MKDIR_QUERY_PARAMS)
  if (unsupported) return json({ ok: false, error: unsupported }, 400)
  const target = fileTarget(params)
  if (target.error) return target.error

  try {
    const result = await runtime.makeDirectory(target.host, target.path)
    return json({ ok: true, host: target.host, path: target.path, created: result.created !== false })
  } catch (error) {
    return sftpRouteError(error)
  }
}

/** GET /api/plugins/remote/file-rename?host=&from=&to= */
async function fileRenameResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  if (!hasExecuteHeader(request)) return json({ ok: false, error: `缺少 ${EXEC_HEADER} 头` }, 403)

  const params = queryOf(request)
  const unsupported = unsupportedParams(params, FILE_RENAME_QUERY_PARAMS)
  if (unsupported) return json({ ok: false, error: unsupported }, 400)
  const host = (params.get('host') || '').trim()
  if (!host) return json({ ok: false, error: 'host 必须是非空字符串' }, 400)
  const from = filePathParam(params, 'from')
  if (from.error) return from.error
  const to = filePathParam(params, 'to')
  if (to.error) return to.error

  try {
    await runtime.renamePath(host, from.value, to.value)
    return json({ ok: true, host, from: from.value, to: to.value, renamed: true })
  } catch (error) {
    return sftpRouteError(error)
  }
}

/** GET /api/plugins/remote/file-delete?host=&path=[&recursive=1] */
async function fileDeleteResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  if (!hasExecuteHeader(request)) return json({ ok: false, error: `缺少 ${EXEC_HEADER} 头` }, 403)

  const params = queryOf(request)
  const unsupported = unsupportedParams(params, FILE_DELETE_QUERY_PARAMS)
  if (unsupported) return json({ ok: false, error: unsupported }, 400)
  const target = fileTarget(params)
  if (target.error) return target.error
  const rawRecursive = params.get('recursive')
  if (rawRecursive !== null && rawRecursive !== '0' && rawRecursive !== '1') {
    return json({ ok: false, error: 'recursive 只能是 0 或 1' }, 400)
  }
  const recursive = rawRecursive === '1'

  try {
    const result = await runtime.deletePath(target.host, target.path, { recursive })
    return json({ ok: true, host: target.host, path: target.path, deleted: true, directory: Boolean(result.directory), recursive })
  } catch (error) {
    return sftpRouteError(error)
  }
}

/** GET /api/plugins/remote/file-chmod?host=&path=&mode=0644 */
async function fileChmodResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  if (!hasExecuteHeader(request)) return json({ ok: false, error: `缺少 ${EXEC_HEADER} 头` }, 403)

  const params = queryOf(request)
  const unsupported = unsupportedParams(params, FILE_CHMOD_QUERY_PARAMS)
  if (unsupported) return json({ ok: false, error: unsupported }, 400)
  const target = fileTarget(params)
  if (target.error) return target.error
  const rawMode = (params.get('mode') || '').trim()
  if (!/^[0-7]{3,4}$/.test(rawMode)) {
    return json({ ok: false, error: 'mode 必须是八进制权限（如 0644）' }, 400)
  }
  const mode = Number.parseInt(rawMode, 8)

  try {
    await runtime.chmodPath(target.host, target.path, mode)
    return json({ ok: true, host: target.host, path: target.path, mode: `0${mode.toString(8).padStart(3, '0')}` })
  } catch (error) {
    return sftpRouteError(error)
  }
}

/** GET /api/plugins/remote/file-chown?host=&path=&uid=&gid= */
async function fileChownResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  if (!hasExecuteHeader(request)) return json({ ok: false, error: `缺少 ${EXEC_HEADER} 头` }, 403)

  const params = queryOf(request)
  const unsupported = unsupportedParams(params, FILE_CHOWN_QUERY_PARAMS)
  if (unsupported) return json({ ok: false, error: unsupported }, 400)
  const target = fileTarget(params)
  if (target.error) return target.error
  const uid = Number(params.get('uid'))
  const gid = Number(params.get('gid'))
  if (!Number.isInteger(uid) || uid < 0 || !Number.isInteger(gid) || gid < 0) {
    return json({ ok: false, error: 'uid 与 gid 必须是非负整数' }, 400)
  }

  try {
    await runtime.chownPath(target.host, target.path, uid, gid)
    return json({ ok: true, host: target.host, path: target.path, uid, gid })
  } catch (error) {
    return sftpRouteError(error)
  }
}

/** GET /api/plugins/remote/file-search?host=&dir=&q=&limit= — bounded recursive name search. */
async function fileSearchResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  if (!hasExecuteHeader(request)) return json({ ok: false, error: `缺少 ${EXEC_HEADER} 头` }, 403)

  const params = queryOf(request)
  const unsupported = unsupportedParams(params, FILE_SEARCH_QUERY_PARAMS)
  if (unsupported) return json({ ok: false, error: unsupported }, 400)
  const host = (params.get('host') || '').trim()
  if (!host) return json({ ok: false, error: 'host 必须是非空字符串' }, 400)
  const dir = filePathParam(params, 'dir')
  if (dir.error) return dir.error
  const q = (params.get('q') || '').trim()
  if (!q) return json({ ok: false, error: 'q 必须是非空字符串' }, 400)
  const rawLimit = params.get('limit')
  const limit = rawLimit === null || rawLimit === '' ? FILE_SEARCH_LIMIT_DEFAULT : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > FILE_SEARCH_LIMIT_MAX) {
    return json({ ok: false, error: `limit 必须是 1-${FILE_SEARCH_LIMIT_MAX} 的整数` }, 400)
  }

  try {
    const found = await runtime.searchFiles(host, dir.value, q, { limit })
    return json({ ok: true, host, dir: dir.value, q, ...found })
  } catch (error) {
    return sftpRouteError(error)
  }
}

/** GET /api/plugins/remote/protocols — capability matrix for the page; read-only, no header. */
async function protocolsResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  const params = queryOf(request)
  const unsupported = unsupportedParams(params, PROTOCOLS_QUERY_PARAMS)
  if (unsupported) return json({ ok: false, error: unsupported }, 400)
  try {
    return json({ ok: true, ...runtime.protocols() })
  } catch (error) {
    return json({ ok: false, error: error?.message || String(error) }, 500)
  }
}

/**
 * GET /api/plugins/remote/groups — env / group / tag buckets for the page and the cicd plugin.
 * Read-only like /protocols: same-origin only, no execute header, unknown query params rejected.
 */
async function groupsResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  const params = queryOf(request)
  const unsupported = unsupportedParams(params, GROUPS_QUERY_PARAMS)
  if (unsupported) return json({ ok: false, error: unsupported }, 400)
  try {
    return json({ ok: true, ...runtime.groups() })
  } catch (error) {
    return json({ ok: false, error: error?.message || String(error) }, 500)
  }
}

/** GET /api/plugins/remote/gui-open?host=&protocol=rdp|vnc — launch the Host's own viewer. */
async function guiOpenResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  if (!hasExecuteHeader(request)) return json({ ok: false, error: `缺少 ${EXEC_HEADER} 头` }, 403)

  const params = queryOf(request)
  const unsupported = unsupportedParams(params, GUI_OPEN_QUERY_PARAMS)
  if (unsupported) return json({ ok: false, error: unsupported }, 400)
  const host = (params.get('host') || '').trim()
  if (!host) return json({ ok: false, error: 'host 必须是非空字符串' }, 400)
  const protocol = (params.get('protocol') || '').trim()
  if (!GUI_PROTOCOLS.has(protocol)) {
    return json({ ok: false, error: 'protocol 必须是 rdp 或 vnc' }, 400)
  }

  try {
    return json({ ok: true, ...runtime.guiOpen(host, protocol) })
  } catch (error) {
    // 缺外部客户端时把安装引导一起带回，面板据此渲染「复制命令 / 下载页 / 重新检测」卡片。
    if (error?.code === 'GUI_CLIENT_MISSING') {
      return json(
        { ok: false, error: error.message, code: error.code, install: error.install ?? null },
        400,
      )
    }
    return sftpRouteError(error)
  }
}

/**
 * Validate `GET /api/plugins/remote/host-save` query parameters. Optional fields stay `undefined`
 * when absent so upsert keeps the previous value; an empty `note` means "clear the note".
 */
function hostLabelParam(params, name, alias) {
  const raw = params.get(name)
  if (raw === null) return { value: undefined }
  const value = raw.trim()
  if (value === '') return { value: '' }
  if (!HOST_LABEL_PATTERN.test(value)) {
    return {
      error: json({
        ok: false,
        error: `主机 "${alias}" 的 ${name} "${value}" 不合法：应为 1-32 位小写字母、数字或连字符`,
      }, 400),
    }
  }
  return { value }
}

function hostTagsParam(params, alias) {
  const raw = params.get('tags')
  if (raw === null) return { value: undefined }
  const tags = raw.split(',').map((tag) => tag.trim()).filter(Boolean)
  for (const tag of tags) {
    if (!HOST_LABEL_PATTERN.test(tag)) {
      return {
        error: json({
          ok: false,
          error: `主机 "${alias}" 的标签 "${tag}" 不合法：应为 1-32 位小写字母、数字或连字符`,
        }, 400),
      }
    }
  }
  if (new Set(tags).size !== tags.length) {
    return { error: json({ ok: false, error: `主机 "${alias}" 的标签不能重复` }, 400) }
  }
  if (tags.length > MAX_HOST_TAGS) {
    return { error: json({ ok: false, error: `主机 "${alias}" 的标签最多 ${MAX_HOST_TAGS} 个` }, 400) }
  }
  return { value: tags }
}

function hostSaveInput(params) {
  const alias = (params.get('alias') || '').trim()
  if (!HOST_ALIAS_PATTERN.test(alias)) return { error: json({ ok: false, error: HOST_ALIAS_ERROR }, 400) }

  const host = (params.get('host') || '').trim()
  if (!host) return { error: json({ ok: false, error: 'host 必须是非空字符串' }, 400) }
  if (Buffer.byteLength(host, 'utf8') > HOST_NAME_MAX_BYTES) {
    return { error: json({ ok: false, error: `host 超过 ${HOST_NAME_MAX_BYTES} 字节上限` }, 413) }
  }

  const rawProtocol = (params.get('protocol') || '').trim()
  let protocol
  try {
    protocol = normalizeProtocol(rawProtocol || DEFAULT_PROTOCOL_ID, alias)
  } catch (error) {
    return { error: json({ ok: false, error: error.message }, 400) }
  }

  const rawPort = params.get('port')
  const port = rawPort === null || rawPort.trim() === '' ? protocolPort(protocol) : Number(rawPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: json({ ok: false, error: 'port 必须是 1-65535 的整数' }, 400) }
  }

  const user = (params.get('user') || '').trim()
  if (Buffer.byteLength(user, 'utf8') > HOST_USER_MAX_BYTES) {
    return { error: json({ ok: false, error: `user 超过 ${HOST_USER_MAX_BYTES} 字节上限` }, 413) }
  }

  const rawAuth = (params.get('auth') || '').trim() || 'none'
  const auth = protocol === DEFAULT_PROTOCOL_ID ? rawAuth : 'none'
  if (!HOST_AUTH_MODES.has(rawAuth)) {
    return { error: json({ ok: false, error: 'auth 必须是 password、password-env、key 或 none' }, 400) }
  }

  const secret = protocol === DEFAULT_PROTOCOL_ID ? (params.get('secret') || '') : ''
  if (Buffer.byteLength(secret, 'utf8') > HOST_SECRET_MAX_BYTES) {
    return { error: json({ ok: false, error: `secret 超过 ${HOST_SECRET_MAX_BYTES} 字节上限` }, 413) }
  }
  if (auth === 'password-env') {
    if (!secret) return { error: json({ ok: false, error: 'auth=password-env 时 secret（环境变量名）不能为空' }, 400) }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(secret)) {
      return { error: json({ ok: false, error: 'secret 必须是合法的环境变量名' }, 400) }
    }
  }

  const privateKeyPath = protocol === DEFAULT_PROTOCOL_ID ? (params.get('privateKeyPath') || '').trim() : ''
  if (auth === 'key' && !privateKeyPath) {
    return { error: json({ ok: false, error: 'auth=key 时 privateKeyPath 不能为空' }, 400) }
  }
  if (Buffer.byteLength(privateKeyPath, 'utf8') > HOST_KEY_PATH_MAX_BYTES) {
    return { error: json({ ok: false, error: `privateKeyPath 超过 ${HOST_KEY_PATH_MAX_BYTES} 字节上限` }, 413) }
  }

  const rawNote = params.get('note')
  const note = rawNote === null ? undefined : rawNote.trim()
  if (note !== undefined && Buffer.byteLength(note, 'utf8') > HOST_NOTE_MAX_BYTES) {
    return { error: json({ ok: false, error: `note 超过 ${HOST_NOTE_MAX_BYTES} 字节上限` }, 413) }
  }

  const env = hostLabelParam(params, 'env', alias)
  if (env.error) return env
  const group = hostLabelParam(params, 'group', alias)
  if (group.error) return group
  const tags = hostTagsParam(params, alias)
  if (tags.error) return tags

  const rawDisabled = params.get('disabled')
  if (rawDisabled !== null && rawDisabled !== '0' && rawDisabled !== '1') {
    return { error: json({ ok: false, error: 'disabled 只能是 1 或 0' }, 400) }
  }

  // Bastion chain: `jump=a,b` (ssh only). Absent means "leave the stored chain untouched".
  const rawJump = params.get('jump')
  let jump
  if (rawJump !== null) {
    if (protocol !== DEFAULT_PROTOCOL_ID && rawJump.trim()) {
      return { error: json({ ok: false, error: '只有 ssh 协议的主机可以配跳板链' }, 400) }
    }
    try {
      jump = normalizeJumpChain(rawJump, alias)
    } catch (error) {
      return { error: json({ ok: false, error: error.message }, 400) }
    }
  }

  return {
    input: {
      alias,
      host,
      protocol,
      port,
      user: user || undefined,
      auth,
      secret,
      privateKeyPath: privateKeyPath || undefined,
      note,
      disabled: rawDisabled === '1',
      jump,
      env: env.value,
      group: group.value,
      tags: tags.value,
    },
  }
}

/** Map write errors onto the documented status codes. */
function hostWriteError(error) {
  const code = error?.code
  if (code === 'HOST_SOURCE_FIXED') return json({ ok: false, error: error.message }, 409)
  if (code === 'HOST_FILE_NOT_WRITABLE' || code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return json({ ok: false, error: error.message || '主机文件不可写' }, 403)
  }
  if (code === 'HOST_CREDENTIAL_REQUIRED' || code === 'HOST_META_INVALID') return json({ ok: false, error: error.message }, 400)
  return json({ ok: false, error: error?.message || String(error) }, 500)
}

/**
 * GET /api/plugins/remote/host-save?alias=&host=&… → upsert one alias in the active hosts file.
 * Requires the write header; inline `config.hosts` is read-only (409 with a fix-it hint).
 */
async function hostSaveResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  if (!hasExecuteHeader(request)) return json({ ok: false, error: `缺少 ${EXEC_HEADER} 头` }, 403)

  const params = queryOf(request)
  const unsupported = unsupportedParams(params, HOST_SAVE_QUERY_PARAMS)
  if (unsupported) return json({ ok: false, error: unsupported }, 400)

  const parsed = hostSaveInput(params)
  if (parsed.error) return parsed.error

  try {
    return json({ ok: true, ...runtime.saveHost(parsed.input) })
  } catch (error) {
    return hostWriteError(error)
  }
}

/** GET /api/plugins/remote/host-delete?alias= → remove one alias from the active hosts file. */
async function hostDeleteResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  if (!hasExecuteHeader(request)) return json({ ok: false, error: `缺少 ${EXEC_HEADER} 头` }, 403)

  const params = queryOf(request)
  const unsupported = unsupportedParams(params, HOST_DELETE_QUERY_PARAMS)
  if (unsupported) return json({ ok: false, error: unsupported }, 400)

  const alias = (params.get('alias') || '').trim()
  if (!HOST_ALIAS_PATTERN.test(alias)) return json({ ok: false, error: HOST_ALIAS_ERROR }, 400)

  try {
    return json({ ok: true, ...runtime.deleteHost(alias) })
  } catch (error) {
    if (error?.code === 'HOST_NOT_FOUND') return json({ ok: false, error: error.message }, 404)
    return hostWriteError(error)
  }
}

/**
 * GET /api/plugins/remote/shell-open?host=&cols=&rows=
 * Opens a panel PTY through the same runtime/pool the remote_shell_* tools use.
 */
async function shellOpenResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  if (!hasExecuteHeader(request)) return json({ ok: false, error: `缺少 ${EXEC_HEADER} 头` }, 403)

  const params = queryOf(request)
  const unsupported = unsupportedParams(params, SHELL_OPEN_QUERY_PARAMS)
  if (unsupported) return json({ ok: false, error: unsupported }, 400)

  const host = (params.get('host') || '').trim()
  if (!host) return json({ ok: false, error: 'host 不能为空' }, 400)

  const cols = shellIntParam(params, 'cols', {
    min: SHELL_COLS_MIN,
    max: SHELL_COLS_MAX,
    fallback: SHELL_COLS_DEFAULT,
    message: `cols 必须是 ${SHELL_COLS_MIN}-${SHELL_COLS_MAX} 的整数`,
  })
  if (cols.error) return cols.error
  const rows = shellIntParam(params, 'rows', {
    min: SHELL_ROWS_MIN,
    max: SHELL_ROWS_MAX,
    fallback: SHELL_ROWS_DEFAULT,
    message: `rows 必须是 ${SHELL_ROWS_MIN}-${SHELL_ROWS_MAX} 的整数`,
  })
  if (rows.error) return rows.error

  try {
    const session = await runtime.shellPanelOpen(host, { cols: cols.value, rows: rows.value })
    return json({ ok: true, session })
  } catch (error) {
    return shellRouteError(error)
  }
}

function shellSessionParam(params) {
  const sessionId = (params.get('sessionId') || '').trim()
  return sessionId || null
}

function shellSizes(params) {
  const cols = shellIntParam(params, 'cols', {
    min: SHELL_COLS_MIN,
    max: SHELL_COLS_MAX,
    fallback: undefined,
    message: `cols 必须是 ${SHELL_COLS_MIN}-${SHELL_COLS_MAX} 的整数`,
  })
  if (cols.error) return cols
  const rows = shellIntParam(params, 'rows', {
    min: SHELL_ROWS_MIN,
    max: SHELL_ROWS_MAX,
    fallback: undefined,
    message: `rows 必须是 ${SHELL_ROWS_MIN}-${SHELL_ROWS_MAX} 的整数`,
  })
  if (rows.error) return rows
  return { cols: cols.value, rows: rows.value }
}

/** GET /api/plugins/remote/shell-send?sessionId=&data=&cols=&rows= — base64 input, short read-back. */
async function shellSendResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  if (!hasExecuteHeader(request)) return json({ ok: false, error: `缺少 ${EXEC_HEADER} 头` }, 403)

  const params = queryOf(request)
  const unsupported = unsupportedParams(params, SHELL_SEND_QUERY_PARAMS)
  if (unsupported) return json({ ok: false, error: unsupported }, 400)

  const sessionId = shellSessionParam(params)
  if (!sessionId) return json({ ok: false, error: 'sessionId 不能为空' }, 400)

  const raw = params.get('data')
  const bytes = raw === null ? null : decodeShellData(raw)
  if (!bytes) return json({ ok: false, error: 'data 必须是合法的 base64' }, 400)
  if (bytes.length > SHELL_PANEL_DATA_MAX_BYTES) {
    return json({ ok: false, error: `data 超过 ${SHELL_PANEL_DATA_MAX_BYTES} 字节上限` }, 413)
  }

  const rawBracketed = params.get('bracketed')
  let bracketed = false
  if (rawBracketed !== null) {
    if (rawBracketed !== '0' && rawBracketed !== '1') {
      return json({ ok: false, error: 'bracketed 只能是 1 或 0' }, 400)
    }
    bracketed = rawBracketed === '1'
  }

  const sizes = shellSizes(params)
  if (sizes.error) return sizes.error

  const text = bytes.toString('utf8')
  const payload = bracketed ? wrapBracketedPaste(text) : text

  try {
    const result = await runtime.shellPanelSend(sessionId, payload, sizes)
    return json({ ok: true, seq: result.seq, output: result.output, exited: result.exited, truncated: result.truncated })
  } catch (error) {
    return shellRouteError(error)
  }
}

/** GET /api/plugins/remote/shell-read?sessionId= — only bytes the previous read did not take. */
async function shellReadResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  if (!hasExecuteHeader(request)) return json({ ok: false, error: `缺少 ${EXEC_HEADER} 头` }, 403)

  const params = queryOf(request)
  const unsupported = unsupportedParams(params, SHELL_READ_QUERY_PARAMS)
  if (unsupported) return json({ ok: false, error: unsupported }, 400)

  const sessionId = shellSessionParam(params)
  if (!sessionId) return json({ ok: false, error: 'sessionId 不能为空' }, 400)

  try {
    const result = runtime.shellPanelRead(sessionId)
    return json({ ok: true, seq: result.seq, output: result.output, exited: result.exited, truncated: result.truncated })
  } catch (error) {
    return shellRouteError(error)
  }
}

/** GET /api/plugins/remote/shell-close?sessionId= */
async function shellCloseResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  if (!hasExecuteHeader(request)) return json({ ok: false, error: `缺少 ${EXEC_HEADER} 头` }, 403)

  const params = queryOf(request)
  const unsupported = unsupportedParams(params, SHELL_CLOSE_QUERY_PARAMS)
  if (unsupported) return json({ ok: false, error: unsupported }, 400)

  const sessionId = shellSessionParam(params)
  if (!sessionId) return json({ ok: false, error: 'sessionId 不能为空' }, 400)

  try {
    runtime.shellPanelClose(sessionId)
    return json({ ok: true, closed: true })
  } catch (error) {
    return shellRouteError(error)
  }
}

/** GET /api/plugins/remote/shell-resize?sessionId=&cols=&rows= — PTY window size follows the panel. */
async function shellResizeResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  if (!hasExecuteHeader(request)) return json({ ok: false, error: `缺少 ${EXEC_HEADER} 头` }, 403)

  const params = queryOf(request)
  const unsupported = unsupportedParams(params, SHELL_RESIZE_QUERY_PARAMS)
  if (unsupported) return json({ ok: false, error: unsupported }, 400)

  const sessionId = shellSessionParam(params)
  if (!sessionId) return json({ ok: false, error: 'sessionId 不能为空' }, 400)

  const cols = shellIntParam(params, 'cols', {
    min: SHELL_COLS_MIN,
    max: SHELL_COLS_MAX,
    fallback: undefined,
    message: `cols 必须是 ${SHELL_COLS_MIN}-${SHELL_COLS_MAX} 的整数`,
  })
  if (cols.error) return cols.error
  if (cols.value === undefined) return json({ ok: false, error: `cols 必须是 ${SHELL_COLS_MIN}-${SHELL_COLS_MAX} 的整数` }, 400)
  const rows = shellIntParam(params, 'rows', {
    min: SHELL_ROWS_MIN,
    max: SHELL_ROWS_MAX,
    fallback: undefined,
    message: `rows 必须是 ${SHELL_ROWS_MIN}-${SHELL_ROWS_MAX} 的整数`,
  })
  if (rows.error) return rows.error
  if (rows.value === undefined) return json({ ok: false, error: `rows 必须是 ${SHELL_ROWS_MIN}-${SHELL_ROWS_MAX} 的整数` }, 400)

  try {
    const size = runtime.shellPanelResizeSession(sessionId, cols.value, rows.value)
    return json({ ok: true, cols: size.cols, rows: size.rows })
  } catch (error) {
    return shellRouteError(error)
  }
}

/**
 * GET /api/plugins/remote/shell-attach?sessionId=&cols=&rows=
 * Re-attach to a panel PTY after a page refresh; replays the transcript tail as base64 backlog.
 */
async function shellAttachResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  if (!hasExecuteHeader(request)) return json({ ok: false, error: `缺少 ${EXEC_HEADER} 头` }, 403)

  const params = queryOf(request)
  const unsupported = unsupportedParams(params, SHELL_ATTACH_QUERY_PARAMS)
  if (unsupported) return json({ ok: false, error: unsupported }, 400)

  const sessionId = shellSessionParam(params)
  if (!sessionId) return json({ ok: false, error: 'sessionId 不能为空' }, 400)

  const sizes = shellSizes(params)
  if (sizes.error) return sizes.error

  try {
    return json({ ok: true, ...runtime.shellPanelAttach(sessionId, sizes) })
  } catch (error) {
    return shellRouteError(error)
  }
}

/** GET /api/plugins/remote/shell-log?sessionId=&maxBytes= — base64 transcript, default 4MB, max 8MB. */
async function shellLogResource(request, runtime) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  if (!hasExecuteHeader(request)) return json({ ok: false, error: `缺少 ${EXEC_HEADER} 头` }, 403)

  const params = queryOf(request)
  const unsupported = unsupportedParams(params, SHELL_LOG_QUERY_PARAMS)
  if (unsupported) return json({ ok: false, error: unsupported }, 400)

  const sessionId = shellSessionParam(params)
  if (!sessionId) return json({ ok: false, error: 'sessionId 不能为空' }, 400)

  const rawMaxBytes = params.get('maxBytes')
  let maxBytes = SHELL_LOG_BYTES
  if (rawMaxBytes !== null) {
    const parsed = Number(rawMaxBytes)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > SHELL_LOG_MAX_REQUEST_BYTES) {
      return json({ ok: false, error: `maxBytes 必须是 1-${SHELL_LOG_MAX_REQUEST_BYTES} 的整数` }, 400)
    }
    maxBytes = parsed
  }

  try {
    return json({ ok: true, ...runtime.shellPanelLog(sessionId, maxBytes) })
  } catch (error) {
    return shellRouteError(error)
  }
}

function normalizeDisposer(handle) {
  if (!handle) return null
  if (typeof handle === 'function') return handle
  if (typeof handle.dispose === 'function') return () => handle.dispose()
  if (typeof handle[Symbol.dispose] === 'function') return () => handle[Symbol.dispose]()
  return null
}

// ---------------------------------------------------------------------------------------------
// Embedded desktop routes (v2.2): the page gets a canvas, the Host gets these five endpoints.
// The WebSocket itself is an upgrade route (see registerDesktopUpgrade), not a GET resource.
// ---------------------------------------------------------------------------------------------

const DESKTOP_STATUS_QUERY_PARAMS = new Set(['host'])
const DESKTOP_START_QUERY_PARAMS = new Set(['host', 'geometry', 'display', 'port'])
const DESKTOP_STOP_QUERY_PARAMS = new Set(['host'])
const DESKTOP_CONNECT_QUERY_PARAMS = new Set(['host', 'port'])
const DESKTOP_INSTALL_QUERY_PARAMS = new Set(['host', 'confirm'])
const NOVNC_QUERY_PARAMS = new Set([])
const NOVNC_ASSET_URL = new URL('./vendor/novnc.bundle.js', import.meta.url)
let novncAssetCache = null

/** Shared guard for the desktop routes: same-origin, execute header, known params, non-empty host. */
function desktopParams(request, allowed) {
  if (!isSameOrigin(request)) return { error: json({ ok: false, error: '只接受本地同源请求' }, 403) }
  if (!hasExecuteHeader(request)) return { error: json({ ok: false, error: `缺少 ${EXEC_HEADER} 头` }, 403) }
  const params = queryOf(request)
  const unsupported = unsupportedParams(params, allowed)
  if (unsupported) return { error: json({ ok: false, error: unsupported }, 400) }
  const host = (params.get('host') || '').trim()
  if (!host) return { error: json({ ok: false, error: 'host 必须是非空字符串' }, 400) }
  if (Buffer.byteLength(host, 'utf8') > FILE_HOST_MAX_BYTES) {
    return { error: json({ ok: false, error: `host 超过 ${FILE_HOST_MAX_BYTES} 字节上限` }, 413) }
  }
  return { host, params }
}

/** Map a desktop runtime error onto an HTTP status plus its machine-readable code. */
function desktopRouteError(error) {
  const message = error?.message || String(error)
  const code = error?.code || null
  if (/^未知主机|unknown host|不存在：既不是/i.test(message)) return json({ ok: false, error: message, code }, 404)
  if (code === 'VNC_SERVER_MISSING') {
    return json({ ok: false, error: message, code, install: error.install ?? null }, 400)
  }
  if (code === 'DESKTOP_UNSUPPORTED_PROTOCOL') return json({ ok: false, error: message, code }, 400)
  if (code === 'VNC_NOT_RUNNING') return json({ ok: false, error: message, code }, 409)
  if (code === 'VNC_INSTALL_FAILED') {
    return json({ ok: false, error: message, code, steps: error.steps ?? [], install: error.install ?? null }, 502)
  }
  if (code === 'VNC_START_FAILED') return json({ ok: false, error: message, code }, 502)
  return json({ ok: false, error: message, code }, 500)
}

/** GET /api/plugins/remote/novnc.js — the vendored noVNC module; a public asset, no header. */
async function novncAssetResource(request) {
  if (!isSameOrigin(request)) return json({ ok: false, error: '只接受本地同源请求' }, 403)
  const params = queryOf(request)
  const unsupported = unsupportedParams(params, NOVNC_QUERY_PARAMS)
  if (unsupported) return json({ ok: false, error: unsupported }, 400)
  if (novncAssetCache === null) novncAssetCache = await readFile(NOVNC_ASSET_URL, 'utf8')
  return new Response(novncAssetCache, {
    status: 200,
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  })
}

async function desktopStatusResource(request, runtime) {
  const guard = desktopParams(request, DESKTOP_STATUS_QUERY_PARAMS)
  if (guard.error) return guard.error
  try {
    const status = await runtime.desktopStatus(guard.host)
    return json({ ok: true, ...status })
  } catch (error) {
    return desktopRouteError(error)
  }
}

async function desktopStartResource(request, runtime) {
  const guard = desktopParams(request, DESKTOP_START_QUERY_PARAMS)
  if (guard.error) return guard.error
  const geometry = guard.params.get('geometry')
  const display = guard.params.get('display')
  const rawPort = guard.params.get('port')
  if (geometry && normalizeGeometry(geometry) === null) {
    return json({ ok: false, error: 'geometry 必须是 <宽>x<高>（如 1280x800）' }, 400)
  }
  if (display && normalizeDisplay(display) === null) {
    return json({ ok: false, error: 'display 必须是 :<数字>（如 :9）' }, 400)
  }
  if (rawPort !== null && rawPort !== '' && normalizeVncPort(rawPort) === null) {
    return json({ ok: false, error: `port 必须是 ${VNC_PORT_MIN}-${VNC_PORT_MAX} 的整数` }, 400)
  }
  try {
    const started = await runtime.desktopStart(guard.host, {
      geometry: geometry || undefined,
      display: display || undefined,
      port: rawPort ? Number(rawPort) : undefined,
    })
    return json({ ok: true, ...started })
  } catch (error) {
    return desktopRouteError(error)
  }
}

async function desktopStopResource(request, runtime) {
  const guard = desktopParams(request, DESKTOP_STOP_QUERY_PARAMS)
  if (guard.error) return guard.error
  try {
    const stopped = await runtime.desktopStop(guard.host)
    return json({ ok: true, ...stopped })
  } catch (error) {
    return desktopRouteError(error)
  }
}

async function desktopConnectResource(request, runtime) {
  const guard = desktopParams(request, DESKTOP_CONNECT_QUERY_PARAMS)
  if (guard.error) return guard.error
  const rawPort = guard.params.get('port')
  if (rawPort !== null && rawPort !== '' && normalizeVncPort(rawPort) === null) {
    return json({ ok: false, error: `port 必须是 ${VNC_PORT_MIN}-${VNC_PORT_MAX} 的整数` }, 400)
  }
  try {
    const connected = await runtime.desktopConnect(guard.host, { port: rawPort ? Number(rawPort) : undefined })
    return json({ ok: true, ...connected })
  } catch (error) {
    return desktopRouteError(error)
  }
}

async function desktopInstallResource(request, runtime) {
  const guard = desktopParams(request, DESKTOP_INSTALL_QUERY_PARAMS)
  if (guard.error) return guard.error
  if (guard.params.get('confirm') !== '1') {
    return json({
      ok: false,
      error: '自动安装会在目标机上安装 VNC 服务，请带 confirm=1 确认',
    }, 400)
  }
  try {
    const installed = await runtime.desktopInstall(guard.host)
    return json({ ok: true, ...installed })
  } catch (error) {
    return desktopRouteError(error)
  }
}

function registerHttpRoutes(ctx, runtime) {
  const web = ctx.get('webServer')
  if (!web || typeof web.register !== 'function') return

  const routes = [
    { kind: 'exact', path: `${ROUTE_PREFIX}/hosts`, resource: (request) => hostsResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/exec`, resource: (request) => execResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/tunnels`, resource: (request) => tunnelsResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/tunnel-open`, resource: (request) => tunnelOpenResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/files`, resource: (request) => filesResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/file`, resource: (request) => fileResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/file-download`, resource: (request) => fileDownloadResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/file-write`, resource: (request) => fileWriteResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/file-mkdir`, resource: (request) => fileMkdirResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/file-rename`, resource: (request) => fileRenameResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/file-delete`, resource: (request) => fileDeleteResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/file-chmod`, resource: (request) => fileChmodResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/file-chown`, resource: (request) => fileChownResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/file-search`, resource: (request) => fileSearchResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/protocols`, resource: (request) => protocolsResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/groups`, resource: (request) => groupsResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/gui-open`, resource: (request) => guiOpenResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/file-upload-begin`, resource: (request) => fileUploadBeginResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/file-upload-chunk`, resource: (request) => fileUploadChunkResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/file-upload-finish`, resource: (request) => fileUploadFinishResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/file-upload-abort`, resource: (request) => fileUploadAbortResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/host-save`, resource: (request) => hostSaveResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/host-delete`, resource: (request) => hostDeleteResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/shell-open`, resource: (request) => shellOpenResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/shell-attach`, resource: (request) => shellAttachResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/shell-send`, resource: (request) => shellSendResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/shell-read`, resource: (request) => shellReadResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/shell-resize`, resource: (request) => shellResizeResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/shell-log`, resource: (request) => shellLogResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/shell-close`, resource: (request) => shellCloseResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/novnc.js`, resource: (request) => novncAssetResource(request) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/desktop-status`, resource: (request) => desktopStatusResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/desktop-start`, resource: (request) => desktopStartResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/desktop-stop`, resource: (request) => desktopStopResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/desktop-connect`, resource: (request) => desktopConnectResource(request, runtime) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/desktop-install`, resource: (request) => desktopInstallResource(request, runtime) },
  ]

  for (const route of routes) {
    try {
      const handle = web.register(route)
      const dispose = normalizeDisposer(handle)
      if (dispose) ctx.effect(() => dispose)
    } catch {
      // A missing/partial web server must not break the tools; the page simply has no data source.
    }
  }

  // One socket, one protocol owner: the VNC bridge is an upgrade route, not a GET resource.
  if (typeof web.registerUpgrade === 'function') {
    try {
      const handle = web.registerUpgrade({
        path: `${ROUTE_PREFIX}/vnc-ws`,
        handler: (request, socket, head) => runtime.bridgeDesktop(request, socket, head),
      })
      const dispose = normalizeDisposer(handle)
      if (dispose) ctx.effect(() => dispose)
    } catch {
      // Older hosts without upgrade support simply keep the desktop column unavailable.
    }
  }
}

/** Host plugin entry. */
export function apply(ctx, config = {}) {
  const runtime = createRuntime(config)
  ctx.effect(() => () => runtime.dispose())
  registerTools(ctx, runtime)
  // 冷启动时 webServer 往往晚于本插件 apply：同步 ctx.get 拿不到服务会静默跳过，结果是页面能渲染、
  // 但整包路由 404（fiber 仍是 active，从插件列表里看不出毛病）。改用 inject 等服务就绪再注册：
  // 服务迟到自动补注册、服务被替换/卸载时连同路由一起销毁。测试用的最小 ctx 没有 inject，
  // 退化成同步注册（此时 webServer 一定已就位）。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => registerHttpRoutes(scope, runtime))
  } else {
    registerHttpRoutes(ctx, runtime)
  }
}

/** Exposed for tests and for the package README examples. */
export const internals = {
  createTokenStore,
  createRuntime,
  normalizeConfig,
  ROUTE_PREFIX,
  clipUtf8,
  wrapBracketedPaste,
  performHandshake,
  encodeFrame,
  WebSocketPeer,
  // Route resources are exposed so tests can drive them with a fake runtime (no SSH).
  resources: {
    hostsResource,
    execResource,
    tunnelsResource,
    tunnelOpenResource,
    filesResource,
    fileResource,
    fileDownloadResource,
    fileWriteResource,
    fileMkdirResource,
    fileRenameResource,
    fileDeleteResource,
    fileChmodResource,
    fileChownResource,
    fileSearchResource,
    protocolsResource,
    groupsResource,
    guiOpenResource,
    fileUploadBeginResource,
    fileUploadChunkResource,
    fileUploadFinishResource,
    fileUploadAbortResource,
    hostSaveResource,
    hostDeleteResource,
    shellOpenResource,
    shellAttachResource,
    shellSendResource,
    shellReadResource,
    shellResizeResource,
    shellLogResource,
    shellCloseResource,
    novncAssetResource,
    desktopStatusResource,
    desktopStartResource,
    desktopStopResource,
    desktopConnectResource,
    desktopInstallResource,
  },
}