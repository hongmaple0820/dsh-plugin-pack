// Client half of @local/dsh-remote: one full-page view in the conversation view switcher.
// Plain JavaScript only, React from the host module table, colors from --dsw-alias-* tokens.

window.__ModuleLoader__.load({
  id: '@local/dsh-remote',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const T = {
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      base: 'var(--dsw-alias-bg-base)',
      surface: 'var(--dsw-alias-bg-layer-1)',
      surface2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      accent: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      mono: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
    }

    const API = {
      hosts: '/api/plugins/remote/hosts',
      exec: '/api/plugins/remote/exec',
      tunnels: '/api/plugins/remote/tunnels',
      tunnelOpen: '/api/plugins/remote/tunnel-open',
      files: '/api/plugins/remote/files',
      file: '/api/plugins/remote/file',
      fileDownload: '/api/plugins/remote/file-download',
      uploadBegin: '/api/plugins/remote/file-upload-begin',
      uploadChunk: '/api/plugins/remote/file-upload-chunk',
      uploadFinish: '/api/plugins/remote/file-upload-finish',
      uploadAbort: '/api/plugins/remote/file-upload-abort',
      hostSave: '/api/plugins/remote/host-save',
      hostDelete: '/api/plugins/remote/host-delete',
      shellOpen: '/api/plugins/remote/shell-open',
      shellAttach: '/api/plugins/remote/shell-attach',
      shellSend: '/api/plugins/remote/shell-send',
      shellRead: '/api/plugins/remote/shell-read',
      shellClose: '/api/plugins/remote/shell-close',
      shellResize: '/api/plugins/remote/shell-resize',
      shellLog: '/api/plugins/remote/shell-log',
      protocols: '/api/plugins/remote/protocols',
      guiOpen: '/api/plugins/remote/gui-open',
      novnc: '/api/plugins/remote/novnc.js',
      desktopStatus: '/api/plugins/remote/desktop-status',
      desktopStart: '/api/plugins/remote/desktop-start',
      desktopConnect: '/api/plugins/remote/desktop-connect',
      desktopStop: '/api/plugins/remote/desktop-stop',
      desktopInstall: '/api/plugins/remote/desktop-install',
      fileWrite: '/api/plugins/remote/file-write',
      fileMkdir: '/api/plugins/remote/file-mkdir',
      fileRename: '/api/plugins/remote/file-rename',
      fileDelete: '/api/plugins/remote/file-delete',
      fileChmod: '/api/plugins/remote/file-chmod',
      fileChown: '/api/plugins/remote/file-chown',
      fileSearch: '/api/plugins/remote/file-search',
    }

    // The carrier only serves GET/HEAD, so writes are GET query parameters gated by this header.
    const WRITE_HEADERS = { 'x-dsh-remote-exec': '1' }

    async function callApi(url, init) {
      let response
      try {
        response = await fetch(url, init)
      } catch (error) {
        throw new Error('无法连接 DSH Host：' + (error && error.message ? error.message : String(error)))
      }
      let data = null
      try { data = await response.json() } catch { data = null }
      if (!response.ok || !data || data.ok === false) {
        const detail = data && data.error ? data.error : 'HTTP ' + response.status
        const failure = new Error(detail)
        // 路由的结构化字段（例如 gui-open 的 install 引导）挂在 payload 上供调用方使用。
        failure.payload = data
        failure.status = response.status
        throw failure
      }
      return data
    }

    // Terminal transport: the page speaks base64 so control bytes and CJK survive a GET query string.
    function encodeBase64(text) {
      const bytes = new TextEncoder().encode(text)
      let binary = ''
      const step = 0x8000
      for (let index = 0; index < bytes.length; index += step) {
        binary += String.fromCharCode.apply(null, bytes.subarray(index, index + step))
      }
      return btoa(binary)
    }

    function decodeBase64(value) {
      if (!value) return ''
      const binary = atob(value)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      return new TextDecoder().decode(bytes)
    }

    // Binary file transport: the download route speaks base64 too, but must not pass through
    // TextDecoder (it would corrupt non-UTF-8 bytes).
    function encodeBytesBase64(bytes) {
      let binary = ''
      const step = 0x8000
      for (let index = 0; index < bytes.length; index += step) {
        binary += String.fromCharCode.apply(null, bytes.subarray(index, index + step))
      }
      return btoa(binary)
    }

    function decodeBase64Bytes(value) {
      if (!value) return new Uint8Array(0)
      const binary = atob(value)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      return bytes
    }

    /** Browser download without a navigation: attach the link to the document root and revoke later. */
    function saveBlob(blob, filename) {
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      link.style.display = 'none'
      document.documentElement.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }

    // Drop ANSI/OSC sequences and normalize terminal line endings before showing text in a <pre>.
    function cleanTerminalOutput(text) {
      return String(text || '')
        .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b[PX^_].*?\x1b\\/g, '')
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
        .replace(/\x1b[@-Z\\-_]/g, '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
    }

    /** Map a browser KeyboardEvent to the bytes a PTY expects, or null when the key is ours to ignore. */
    function terminalKeySequence(event) {
      if (event.ctrlKey || event.metaKey) {
        if (event.key === 'c' || event.key === 'C') return '\x03'
        if (event.key === 'd' || event.key === 'D') return '\x04'
        if (event.key === 'l' || event.key === 'L') return '\x0c'
        return null
      }
      if (event.altKey) return null
      switch (event.key) {
        case 'Enter': return '\r'
        case 'Backspace': return '\x7f'
        case 'Tab': return '\t'
        case 'Escape': return '\x1b'
        case 'ArrowUp': return '\x1b[A'
        case 'ArrowDown': return '\x1b[B'
        case 'ArrowRight': return '\x1b[C'
        case 'ArrowLeft': return '\x1b[D'
        case 'Home': return '\x1b[H'
        case 'End': return '\x1b[F'
        case 'Delete': return '\x1b[3~'
        case 'PageUp': return '\x1b[5~'
        case 'PageDown': return '\x1b[6~'
        default: break
      }
      if (event.key.length === 1) return event.key
      return null
    }

    const TERMINAL_CHAR_WIDTH = 7.2
    const TERMINAL_LINE_HEIGHT = 17

    /** Turn the visible terminal box into PTY cols/rows, clamped to the server's 20-500 / 5-200. */
    function computeTerminalGrid({ width, height, charWidth = TERMINAL_CHAR_WIDTH, lineHeight = TERMINAL_LINE_HEIGHT } = {}) {
      const safeWidth = Number.isFinite(width) ? width : 0
      const safeHeight = Number.isFinite(height) ? height : 0
      const usableWidth = Math.max(0, safeWidth - 22) // 10px padding + 1px border per side
      const usableHeight = Math.max(0, safeHeight - 18) // 8px padding + 1px border per side
      const rawCols = charWidth > 0 ? Math.floor(usableWidth / charWidth) : 0
      const rawRows = lineHeight > 0 ? Math.floor(usableHeight / lineHeight) : 0
      return {
        cols: Math.min(500, Math.max(20, rawCols)),
        rows: Math.min(200, Math.max(5, rawRows)),
      }
    }

    const TERMINAL_HISTORY_LIMIT = 20
    const MAX_DISPLAY_LINES = 2000
    const MAX_LOCAL_LINES = 20000
    const SHELL_STORAGE_PREFIX = 'dsh-remote.shell.'
    const UPLOAD_CHUNK_BYTES = 8192
    const UPLOAD_MAX_BYTES = 64 * 1024 * 1024
    const FILE_EDIT_MAX_BYTES = 256 * 1024

    /** Record one submitted command: trim, drop duplicates, newest first, cap at 20. */
    function pushCommandHistory(history, command, limit = TERMINAL_HISTORY_LIMIT) {
      const text = String(command == null ? '' : command).replace(/\r/g, '').trim()
      const items = Array.isArray(history) ? history : []
      if (!text) return items.slice()
      return [text, ...items.filter((entry) => entry !== text)].slice(0, limit)
    }

    /**
     * Step the local history ring. index -1 is the fresh editing line; 'up' walks toward older
     * commands and stops at the oldest, 'down' walks back and stops at the fresh line.
     */
    function resolveHistoryStep(history, index, direction) {
      const items = Array.isArray(history) ? history : []
      if (items.length === 0) return { index: -1, text: '' }
      if (direction === 'up') {
        const next = Math.min(items.length - 1, Math.max(-1, index) + 1)
        return { index: next, text: items[next] }
      }
      const next = Math.max(-1, index - 1)
      return { index: next, text: next >= 0 ? items[next] : '' }
    }

    /** execCommand fallback for browsers that reject navigator.clipboard (non-secure origins). */
    function copyTextFallback(text, container) {
      const node = document.createElement('textarea')
      node.value = text
      node.setAttribute('readonly', '')
      node.style.position = 'fixed'
      node.style.top = '-1000px'
      node.style.opacity = '0'
      const mount = container || document.documentElement
      mount.appendChild(node)
      let copied = false
      try {
        node.select()
        copied = document.execCommand('copy')
      } finally {
        mount.removeChild(node)
      }
      if (!copied) throw new Error('execCommand copy failed')
    }

    function shellStorageKey(host) {
      return SHELL_STORAGE_PREFIX + String(host == null ? '' : host)
    }

    /** Session-scoped record of the live panel PTY, so a refresh can re-attach instead of reopening. */
    function readStoredShellSession(host) {
      try {
        if (typeof window === 'undefined' || !window.sessionStorage) return null
        const raw = window.sessionStorage.getItem(shellStorageKey(host))
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed.sessionId !== 'string' || !parsed.sessionId) return null
        return { sessionId: parsed.sessionId, openedAt: Number(parsed.openedAt) || 0 }
      } catch {
        return null
      }
    }

    function writeStoredShellSession(host, sessionId) {
      try {
        if (typeof window === 'undefined' || !window.sessionStorage) return
        const record = JSON.stringify({ sessionId: String(sessionId), openedAt: Date.now() })
        window.sessionStorage.setItem(shellStorageKey(host), record)
      } catch {
        // Private mode / disabled storage: the panel simply opens a fresh PTY next time.
      }
    }

    function clearStoredShellSession(host, sessionId) {
      try {
        if (typeof window === 'undefined' || !window.sessionStorage) return
        const key = shellStorageKey(host)
        if (sessionId) {
          const current = readStoredShellSession(host)
          if (current && current.sessionId !== sessionId) return
        }
        window.sessionStorage.removeItem(key)
      } catch {
        // ignore storage failures
      }
    }

    /** Local-time stamp for downloaded transcripts: YYYYMMDD-HHmmss. */
    function formatLogStamp(date) {
      const value = date instanceof Date ? date : new Date()
      const pad = (number) => String(number).padStart(2, '0')
      return (
        String(value.getFullYear()) +
        pad(value.getMonth() + 1) +
        pad(value.getDate()) +
        '-' +
        pad(value.getHours()) +
        pad(value.getMinutes()) +
        pad(value.getSeconds())
      )
    }

    const fieldStyle = {
      width: '100%',
      boxSizing: 'border-box',
      font: 'inherit',
      fontSize: '11px',
      lineHeight: '16px',
      color: T.text,
      background: T.base,
      border: '1px solid ' + T.border,
      borderRadius: '6px',
      padding: '3px 6px',
    }

    const fieldLabelStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
      fontSize: '11px',
      color: T.muted,
      minWidth: 0,
    }

    const buttonStyle = (accent) => ({
      appearance: 'none',
      font: 'inherit',
      fontSize: '12px',
      lineHeight: '18px',
      padding: '3px 10px',
      borderRadius: '6px',
      cursor: 'pointer',
      color: accent ? T.accent : T.text,
      background: 'transparent',
      border: '1px solid ' + (accent ? T.accent : T.borderStrong),
    })

    function StatusDot({ tone }) {
      return h('span', {
        'aria-hidden': true,
        style: {
          display: 'inline-block',
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          background: tone,
          marginRight: '6px',
          flex: '0 0 auto',
        },
      })
    }

    const smallButtonStyle = (disabled) => ({
      ...buttonStyle(false),
      padding: '1px 5px',
      fontSize: '10px',
      lineHeight: '14px',
      opacity: disabled ? 0.45 : 1,
      cursor: disabled ? 'not-allowed' : 'pointer',
    })

    // 折叠箭头：SVG 描边，不用 unicode 字形当图标。
    function Chevron({ open }) {
      return h('svg', {
        width: '10',
        height: '10',
        viewBox: '0 0 10 10',
        'aria-hidden': true,
        style: { flex: '0 0 auto', transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform 0.12s ease' },
      },
      h('path', {
        d: 'M2 3.2 L5 6.6 L8 3.2',
        fill: 'none',
        stroke: T.muted,
        strokeWidth: '1.4',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }))
    }

    // 主机按 group 分层：'生产/web' 拆成两级；没分组的挂到根上。
    const splitGroupPath = (group) => {
      const raw = typeof group === 'string' ? group.trim() : ''
      if (!raw) return []
      return raw.split('/').map((part) => part.trim()).filter(Boolean)
    }

    const buildHostTree = (hosts) => {
      const root = { name: '', path: '', groups: new Map(), hosts: [] }
      for (const host of hosts) {
        let node = root
        let path = ''
        for (const part of splitGroupPath(host.group)) {
          path = path ? path + '/' + part : part
          if (!node.groups.has(part)) node.groups.set(part, { name: part, path, groups: new Map(), hosts: [] })
          node = node.groups.get(part)
        }
        node.hosts.push(host)
      }
      return root
    }

    const countHosts = (node) => node.hosts.length
      + [...node.groups.values()].reduce((sum, child) => sum + countHosts(child), 0)

    function HostList({
      hosts, selected, onSelect, configError, source, notice,
      canWrite, editHint, deleteConfirm, actionError,
      onNew, onEdit, onDelete,
    }) {
      const writeTitle = canWrite ? undefined : editHint
      const [collapsed, setCollapsed] = useState([])
      const toggleGroup = (path) => {
        setCollapsed((previous) => (previous.includes(path)
          ? previous.filter((item) => item !== path)
          : [...previous, path]))
      }

      const hostRow = (host) => {
        const selectedRow = selected === host.alias
        const jump = Array.isArray(host.jump) ? host.jump : []
        const detail = (host.protocol || 'ssh') + ' · ' + host.user
        return h('div', {
          key: host.alias,
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '3px',
            minWidth: 0,
            borderRadius: '6px',
            background: selectedRow ? T.surface2 : 'transparent',
            border: '1px solid ' + (selectedRow ? T.accent : 'transparent'),
            padding: '5px 6px',
            boxSizing: 'border-box',
          },
        },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '4px', minWidth: 0 } },
          h(StatusDot, { tone: host.disabled ? T.idle : host.ready ? T.success : T.warn }),
          h('button', {
            type: 'button',
            'aria-pressed': selectedRow,
            onClick: () => onSelect(host.alias),
            title: host.issue || host.user + '@' + host.host + ':' + host.port,
            style: {
              appearance: 'none',
              font: 'inherit',
              fontSize: '12px',
              fontWeight: 500,
              lineHeight: '16px',
              textAlign: 'left',
              padding: 0,
              cursor: 'pointer',
              color: T.text,
              background: 'transparent',
              border: 'none',
              minWidth: 0,
              flex: '1 1 auto',
              display: 'flex',
              alignItems: 'center',
            },
          },
          h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, host.alias)),
          h('button', {
            type: 'button',
            onClick: () => onEdit(host),
            disabled: !canWrite,
            title: writeTitle,
            style: { ...smallButtonStyle(!canWrite), flex: '0 0 auto', whiteSpace: 'nowrap' },
          }, '编辑'),
          h('button', {
            type: 'button',
            onClick: () => onDelete(host.alias),
            disabled: !canWrite,
            title: writeTitle,
            style: { ...smallButtonStyle(!canWrite), flex: '0 0 auto', whiteSpace: 'nowrap', color: canWrite ? T.error : T.muted },
          }, deleteConfirm === host.alias ? '确认删除？' : '删除')),
        h('div', {
          style: {
            marginLeft: '16px',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: '11px',
            lineHeight: '15px',
            color: T.muted,
          },
        },
        jump.length > 0
          ? h('span', {
            className: 'remote-host-jump',
            title: '经跳板：' + jump.join(' → '),
            style: { marginRight: '6px', color: host.jumpIssue ? T.warn : T.muted },
          }, '经 ' + jump.join('→'))
          : null,
        h('span', { style: { fontFamily: T.mono } }, detail)))
      }

      const groupNode = (node, depth) => {
        const open = !collapsed.includes(node.path)
        const children = []
        for (const child of [...node.groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))) {
          children.push(groupNode(child, depth + 1))
        }
        for (const host of [...node.hosts].sort((a, b) => a.alias.localeCompare(b.alias, 'zh-Hans-CN'))) {
          children.push(hostRow(host))
        }
        return h('div', { key: 'group:' + node.path, style: { minWidth: 0 } },
          h('button', {
            type: 'button',
            'aria-expanded': open,
            onClick: () => toggleGroup(node.path),
            title: '分组：' + node.path,
            style: {
              appearance: 'none',
              font: 'inherit',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              width: '100%',
              textAlign: 'left',
              padding: depth === 0 ? '3px 4px' : '2px 4px',
              cursor: 'pointer',
              color: T.muted,
              background: 'transparent',
              border: 'none',
              borderRadius: '4px',
              fontSize: '11px',
              fontWeight: 500,
              lineHeight: '15px',
              minWidth: 0,
            },
          },
          h(Chevron, { open }),
          h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, node.name),
          h('span', { style: { flex: '0 0 auto', fontSize: '10px', color: T.idle } }, String(countHosts(node)))),
          open
            ? h('div', {
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
                paddingLeft: depth === 0 ? '6px' : '10px',
                marginTop: '2px',
                minWidth: 0,
              },
            }, children)
            : null)
      }

      const root = buildHostTree(hosts)
      const body = []
      if (root.groups.size > 0) {
        for (const child of [...root.groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))) {
          body.push(groupNode(child, 0))
        }
        if (root.hosts.length > 0) {
          body.push(groupNode({ name: '未分组', path: '', groups: new Map(), hosts: root.hosts }, 0))
        }
      } else {
        for (const host of [...root.hosts].sort((a, b) => a.alias.localeCompare(b.alias, 'zh-Hans-CN'))) {
          body.push(hostRow(host))
        }
      }

      const empty = h('p', { style: { fontSize: '12px', color: T.muted, margin: 0, lineHeight: '18px' } },
        canWrite
          ? '还没有主机。点上方「＋ 新建」添加第一台；也可以在 cordis.patch.yml 的 dsh-remote 行写 config.hosts。'
          : '没有可用主机。请在 cordis.patch.yml 的 dsh-remote 行写 config.hosts，或把主机 JSON 路径放进 DSH_REMOTE_HOSTS。')

      return h('aside', {
        style: {
          width: '240px',
          flex: '0 0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          minHeight: 0,
          paddingRight: '12px',
          borderRight: '1px solid ' + T.border,
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
        h('div', { style: { fontSize: '12px', color: T.muted, letterSpacing: '0.02em' } }, '主机（' + hosts.length + '）'),
        h('button', {
          type: 'button',
          onClick: onNew,
          disabled: !canWrite,
          title: writeTitle,
          style: { ...smallButtonStyle(!canWrite), marginLeft: 'auto', color: canWrite ? T.accent : T.muted },
        }, '＋ 新建')),
      h('p', { style: { fontSize: '11px', color: T.muted, margin: 0 } }, '来源：' + source),
      configError
        ? h('p', { style: { fontSize: '11px', color: T.warn, margin: 0, lineHeight: '16px', wordBreak: 'break-word' } }, configError)
        : null,
      canWrite ? null : h('p', { style: { fontSize: '10px', color: T.muted, margin: 0, lineHeight: '14px' } }, editHint),
      actionError
        ? h('p', { role: 'alert', style: { fontSize: '11px', color: T.error, margin: 0, lineHeight: '16px', wordBreak: 'break-word' } }, actionError)
        : null,
      notice
        ? h('p', { style: { fontSize: '11px', color: T.warn, margin: 0, lineHeight: '16px', wordBreak: 'break-word' } }, notice)
        : null,
      h('div', {
        style: { flex: '1 1 auto', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px', minHeight: 0 },
      }, hosts.length === 0 ? empty : body))
    }

    const modalFieldStyle = { ...fieldStyle, fontSize: '12px', lineHeight: '18px', padding: '4px 8px' }
    const modalFieldLabelStyle = { ...fieldLabelStyle, fontSize: '12px', gap: '3px' }
    const modalButtonStyle = (disabled) => ({
      ...buttonStyle(false),
      fontSize: '12px',
      lineHeight: '18px',
      padding: '4px 14px',
      opacity: disabled ? 0.45 : 1,
      cursor: disabled ? 'not-allowed' : 'pointer',
    })

    function HostForm({ form, error, busy, onChange, onSubmit, onCancel, protocols }) {
      const editing = form.mode === 'edit'
      const auth = form.auth
      const protocol = form.protocol || 'ssh'
      const sshOnly = protocol === 'ssh'
      const set = (field) => (event) => onChange(field, event.target.value)
      const options = Array.isArray(protocols) && protocols.length > 0
        ? protocols
        : [{ id: 'ssh', label: 'SSH' }, { id: 'telnet', label: 'Telnet' }, { id: 'rdp', label: 'RDP' }, { id: 'vnc', label: 'VNC' }]
      return h('form', {
        onSubmit,
        style: { display: 'flex', flexDirection: 'column', gap: '8px', margin: 0 },
      },
      h('label', { style: modalFieldLabelStyle },
        '别名',
        h('input', {
          value: form.alias,
          onChange: set('alias'),
          disabled: editing,
          autoFocus: !editing,
          placeholder: 'app01',
          spellCheck: false,
          style: { ...modalFieldStyle, opacity: editing ? 0.65 : 1 },
        })),
      h('label', { style: modalFieldLabelStyle },
        '主机',
        h('input', {
          value: form.host,
          onChange: set('host'),
          autoFocus: editing,
          placeholder: '10.0.0.11',
          spellCheck: false,
          style: modalFieldStyle,
        })),
      h('div', { style: { display: 'flex', gap: '8px' } },
        h('label', { style: { ...modalFieldLabelStyle, flex: '1 1 0' } },
          '端口',
          h('input', { value: form.port, onChange: set('port'), inputMode: 'numeric', placeholder: '22', style: modalFieldStyle })),
        h('label', { style: { ...modalFieldLabelStyle, flex: '1 1 0' } },
          '用户',
          h('input', { value: form.user, onChange: set('user'), placeholder: 'root', spellCheck: false, style: modalFieldStyle }))),
      h('div', { style: { display: 'flex', gap: '8px' } },
        h('label', { style: { ...modalFieldLabelStyle, flex: '1 1 0' } },
          '环境',
          h('input', {
            value: form.env || '',
            onChange: set('env'),
            placeholder: 'prod / test（可选）',
            spellCheck: false,
            style: modalFieldStyle,
          })),
        h('label', { style: { ...modalFieldLabelStyle, flex: '1 1 0' } },
          '分组',
          h('input', {
            value: form.group || '',
            onChange: set('group'),
            placeholder: '如 生产/web（可选）',
            spellCheck: false,
            style: modalFieldStyle,
          }),
          h('span', { style: { fontSize: '10px', color: T.muted, lineHeight: '14px' } },
            '用 / 分层，主机列表按层级折叠显示。'))),
      h('label', { style: modalFieldLabelStyle },
        '标签',
        h('input', {
          value: form.tags || '',
          onChange: set('tags'),
          placeholder: 'edge,cdn（逗号分隔，可选）',
          spellCheck: false,
          style: modalFieldStyle,
        }),
        h('span', { style: { fontSize: '10px', color: T.muted, lineHeight: '14px' } },
          '小写字母、数字、连字符。流水线可按 env/group/tag 选主机。')),
      h('label', { style: modalFieldLabelStyle },
        '协议',
        h('select', {
          value: protocol,
          onChange: (event) => {
            const next = event.target.value
            const found = options.find((item) => item.id === next)
            onChange('protocol', next)
            if (found && found.defaultPort) onChange('port', String(found.defaultPort))
            if (next !== 'ssh') onChange('auth', 'none')
          },
          style: modalFieldStyle,
        }, options.map((item) => h('option', { key: item.id, value: item.id }, item.label + '（' + (item.defaultPort || '?') + '）')))),
      sshOnly ? null : h('p', { style: { margin: 0, fontSize: '11px', color: T.muted, lineHeight: '15px' } },
        protocol === 'telnet' ? 'Telnet 只提供交互终端，不提供文件与隧道。' : '此协议只负责打开本机桌面客户端（RDP/VNC），不提供命令、文件与隧道。'),
      sshOnly ? h('label', { style: modalFieldLabelStyle },
        '认证方式',
        h('select', { value: auth, onChange: set('auth'), style: modalFieldStyle },
          h('option', { value: 'password' }, '密码'),
          h('option', { value: 'password-env' }, '密码环境变量'),
          h('option', { value: 'key' }, '私钥'),
          h('option', { value: 'none' }, '无凭据'))) : null,
      sshOnly && (auth === 'password' || auth === 'password-env')
        ? h('label', { style: modalFieldLabelStyle },
          auth === 'password' ? '密码' : '密码环境变量名',
          h('input', {
            value: form.secret,
            onChange: set('secret'),
            type: auth === 'password' ? 'password' : 'text',
            autoComplete: 'new-password',
            spellCheck: false,
            placeholder: editing
              ? (auth === 'password-env' && form.currentPasswordEnv ? '留空则不改（当前 ' + form.currentPasswordEnv + '）' : '留空则不改')
              : (auth === 'password' ? '必填' : 'ALPHA_PASSWORD'),
            style: modalFieldStyle,
          }))
        : null,
      sshOnly && auth === 'key'
        ? h('label', { style: modalFieldLabelStyle },
          '私钥路径',
          h('input', {
            value: form.privateKeyPath,
            onChange: set('privateKeyPath'),
            placeholder: 'C:\\Users\\me\\.ssh\\id_ed25519',
            spellCheck: false,
            style: modalFieldStyle,
          }))
        : null,
      sshOnly ? h('label', { style: modalFieldLabelStyle },
        '跳板链（可选）',
        h('input', {
          value: form.jump || '',
          onChange: set('jump'),
          placeholder: 'jump-a,jump-b（最多 3 跳）',
          spellCheck: false,
          style: modalFieldStyle,
        }),
        h('span', { style: { fontSize: '10px', color: T.muted, lineHeight: '14px' } },
          '目标机只能经跳板访问时填这里，顺序即连接顺序。')) : null,
      h('label', { style: modalFieldLabelStyle },
        '备注',
        h('input', { value: form.note, onChange: set('note'), placeholder: '可选', style: modalFieldStyle })),
      h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: T.muted } },
        h('input', {
          type: 'checkbox',
          checked: Boolean(form.disabled),
          onChange: (event) => onChange('disabled', event.target.checked),
        }),
        '禁用该主机'),
      error
        ? h('p', { role: 'alert', style: { margin: 0, fontSize: '12px', color: T.error, wordBreak: 'break-word' } }, error)
        : null,
      h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '2px' } },
        h('button', {
          type: 'submit',
          disabled: busy,
          style: { ...modalButtonStyle(busy), color: T.accent, borderColor: T.accent },
        }, busy ? '保存中…' : '保存'),
        h('button', { type: 'button', onClick: onCancel, disabled: busy, style: modalButtonStyle(busy) }, '取消')))
    }

    // 新建/编辑主机改成居中弹窗：240px 侧栏里塞表单太挤，字段在弹窗里也能放宽。
    // Esc 与点遮罩关闭（保存中不允许关，避免丢一次进行中的提交）。
    function HostFormModal({ form, error, busy, protocols, onChange, onSubmit, onCancel }) {
      const editing = form.mode === 'edit'
      useEffect(() => {
        if (busy) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onCancel()
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [busy, onCancel])
      return h('div', {
        role: 'presentation',
        onClick: (event) => { if (!busy && event.target === event.currentTarget) onCancel() },
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: 1000,
          background: 'rgba(15,17,20,0.4)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
        },
      },
      h('div', {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': editing ? '编辑主机 ' + form.alias : '新建主机',
        style: {
          width: '440px',
          maxWidth: '100%',
          maxHeight: '100%',
          overflowY: 'auto',
          background: T.base,
          border: '1px solid ' + T.borderStrong,
          borderRadius: '10px',
          padding: '14px 16px 16px',
          boxShadow: '0 16px 40px rgba(0,0,0,0.2)',
          boxSizing: 'border-box',
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' } },
        h('h3', {
          style: {
            margin: 0,
            fontSize: '13px',
            fontWeight: 600,
            flex: '1 1 auto',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          },
        }, editing ? '编辑主机 · ' + form.alias : '新建主机'),
        h('button', {
          type: 'button',
          onClick: onCancel,
          disabled: busy,
          title: '关闭（Esc）',
          'aria-label': '关闭',
          style: {
            appearance: 'none',
            font: 'inherit',
            background: 'transparent',
            border: 'none',
            padding: '2px',
            cursor: busy ? 'not-allowed' : 'pointer',
            color: T.muted,
            display: 'flex',
            alignItems: 'center',
            flex: '0 0 auto',
          },
        },
        h('svg', { width: '14', height: '14', viewBox: '0 0 14 14', 'aria-hidden': true },
          h('path', { d: 'M3 3 L11 11 M11 3 L3 11', fill: 'none', stroke: T.muted, strokeWidth: '1.4', strokeLinecap: 'round' })))),
      h(HostForm, { form, error, busy, onChange, onSubmit, onCancel, protocols })))
    }

    function TunnelPanel({ tunnels, onClose, host, onCreated }) {
      const [remoteHost, setRemoteHost] = useState('127.0.0.1')
      const [remotePort, setRemotePort] = useState('')
      const [localPort, setLocalPort] = useState('')
      const [creating, setCreating] = useState(false)
      const [formError, setFormError] = useState(null)

      const submit = async (event) => {
        event.preventDefault()
        if (creating) return
        if (!host) {
          setFormError('先在左侧选择一台主机')
          return
        }
        const port = Number(remotePort)
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          setFormError('远端端口必须是 1-65535 的整数')
          return
        }
        let local = ''
        if (localPort.trim() !== '') {
          const value = Number(localPort)
          if (!Number.isInteger(value) || value < 1 || value > 65535) {
            setFormError('本地端口留空（自动分配）或填 1-65535 的整数')
            return
          }
          local = String(value)
        }
        setCreating(true)
        setFormError(null)
        try {
          const query = new URLSearchParams({
            host,
            remoteHost: remoteHost.trim() || '127.0.0.1',
            remotePort: String(port),
          })
          if (local) query.set('localPort', local)
          await callApi(`${API.tunnelOpen}?${query.toString()}`, { headers: WRITE_HEADERS })
          setRemotePort('')
          setLocalPort('')
          await onCreated()
        } catch (failure) {
          setFormError(failure.message)
        } finally {
          setCreating(false)
        }
      }

      return h('aside', {
        style: {
          width: '100%',
          flex: '0 1 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          minHeight: 0,
          paddingBottom: '8px',
          borderBottom: '1px solid ' + T.border,
        },
      },
      h('div', { style: { fontSize: '12px', color: T.muted } }, '本地隧道（' + tunnels.length + '）'),
      h('div', {
        style: { flex: '1 1 auto', maxHeight: '190px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px', minHeight: 0 },
      },
      tunnels.length === 0
        ? h('p', { style: { fontSize: '12px', color: T.muted, margin: 0, lineHeight: '18px' } },
          '没有打开的隧道。可以在下面新建，或让 Agent 调用 remote_tunnel_open。')
        : tunnels.map((tunnel) => h('div', {
          key: tunnel.tunnelId,
          style: {
            padding: '7px 8px',
            borderRadius: '6px',
            background: T.surface,
            border: '1px solid ' + T.border,
            fontSize: '11px',
            lineHeight: '16px',
          },
        },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          h('span', { style: { color: T.muted } }, tunnel.tunnelId),
          h('button', {
            type: 'button',
            onClick: () => onClose(tunnel.tunnelId),
            style: { ...buttonStyle(false), marginLeft: 'auto', padding: '1px 7px', fontSize: '11px' },
          }, '关闭')),
        h('div', { style: { fontFamily: T.mono, wordBreak: 'break-all' } }, tunnel.local + ' → ' + tunnel.remote),
        h('div', { style: { color: T.muted } }, '经 ' + tunnel.host)),
      )),
      h('form', {
        onSubmit: submit,
        style: {
          flex: '0 0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '5px',
          padding: '8px',
          borderRadius: '6px',
          border: '1px dashed ' + T.border,
          background: T.surface,
        },
      },
      h('div', { style: { fontSize: '11px', color: T.muted } },
        '新建隧道 · 经 ' + (host || '未选主机')),
      h('label', { style: fieldLabelStyle },
        '远端主机',
        h('input', {
          value: remoteHost,
          onChange: (event) => setRemoteHost(event.target.value),
          placeholder: '127.0.0.1',
          spellCheck: false,
          style: fieldStyle,
        })),
      h('div', { style: { display: 'flex', gap: '5px' } },
        h('label', { style: { ...fieldLabelStyle, flex: '1 1 0' } },
          '远端端口',
          h('input', {
            value: remotePort,
            onChange: (event) => setRemotePort(event.target.value),
            inputMode: 'numeric',
            placeholder: '5432',
            style: fieldStyle,
          })),
        h('label', { style: { ...fieldLabelStyle, flex: '1 1 0' } },
          '本地端口',
          h('input', {
            value: localPort,
            onChange: (event) => setLocalPort(event.target.value),
            inputMode: 'numeric',
            placeholder: '自动',
            style: fieldStyle,
          }))),
      formError
        ? h('p', { role: 'alert', style: { margin: 0, fontSize: '11px', color: T.error, wordBreak: 'break-word' } }, formError)
        : null,
      h('button', {
        type: 'submit',
        disabled: creating || !host || !remotePort.trim(),
        style: { ...buttonStyle(true), opacity: creating || !host || !remotePort.trim() ? 0.55 : 1 },
      }, creating ? '建立中…' : '新建隧道')))
    }

    /** Parent of a POSIX path; '/' is its own parent. */
    function parentPath(path) {
      const clean = String(path || '/').replace(/\/+$/, '') || '/'
      if (clean === '/') return '/'
      const index = clean.lastIndexOf('/')
      return index <= 0 ? '/' : clean.slice(0, index)
    }

    function joinPath(base, name) {
      return base === '/' ? '/' + name : base.replace(/\/+$/, '') + '/' + name
    }

    function formatBytes(size) {
      if (typeof size !== 'number' || !Number.isFinite(size)) return ''
      if (size < 1024) return size + ' B'
      if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB'
      return (size / (1024 * 1024)).toFixed(1) + ' MB'
    }

    function formatMtime(value) {
      if (!value || typeof value !== 'string') return ''
      return value.slice(0, 16).replace('T', ' ')
    }

// File browser for SSH hosts: list, preview, download/upload, context actions and an inline editor.
    // Every write is a GET route gated by x-dsh-remote-exec, so no POST is ever attempted.
    function FilesPanel({ host }) {
      const [cwd, setCwd] = useState('/')
      const [pathInput, setPathInput] = useState('/')
      const [entries, setEntries] = useState([])
      const [total, setTotal] = useState(0)
      const [truncated, setTruncated] = useState(false)
      const [loading, setLoading] = useState(false)
      const [listError, setListError] = useState(null)
      const [selectedFile, setSelectedFile] = useState(null)
      const [preview, setPreview] = useState(null)
      const [previewLoading, setPreviewLoading] = useState(false)
      const [previewError, setPreviewError] = useState(null)
      const [downloadBusy, setDownloadBusy] = useState(false)
      const [uploading, setUploading] = useState(false)
      const [uploadProgress, setUploadProgress] = useState(null)
      const [fileActionError, setFileActionError] = useState(null)
      const [fileNotice, setFileNotice] = useState(null)
      const [sortMode, setSortMode] = useState('name')
      const [showHidden, setShowHidden] = useState(true)
      const [menu, setMenu] = useState(null)
      const [dialog, setDialog] = useState(null)
      const [editor, setEditor] = useState(null)
      const [busyAction, setBusyAction] = useState(false)
      const uploadTargetRef = useRef(null)
      const fileInputRef = useRef(null)
      const loadSeq = useRef(0)
      const previewSeq = useRef(0)

      const load = useCallback(async (targetPath) => {
        const seq = loadSeq.current + 1
        loadSeq.current = seq
        if (!host) {
          setListError('先在左侧选择一台主机')
          return
        }
        setLoading(true)
        setListError(null)
        try {
          const query = new URLSearchParams({
            host,
            path: targetPath,
            sort: sortMode,
            hidden: showHidden ? '1' : '0',
          })
          const data = await callApi(API.files + '?' + query.toString(), { headers: WRITE_HEADERS })
          if (seq !== loadSeq.current) return
          const nextPath = typeof data.path === 'string' && data.path ? data.path : targetPath
          setCwd(nextPath)
          setPathInput(nextPath)
          setEntries(Array.isArray(data.entries) ? data.entries : [])
          setTotal(Number(data.total) || 0)
          setTruncated(Boolean(data.truncated))
          setSelectedFile(null)
          setPreview(null)
          setPreviewError(null)
          setPreviewLoading(false)
        } catch (failure) {
          if (seq !== loadSeq.current) return
          setEntries([])
          setTotal(0)
          setTruncated(false)
          setListError(failure.message)
        } finally {
          if (seq === loadSeq.current) setLoading(false)
        }
      }, [host, showHidden, sortMode])

      useEffect(() => {
        loadSeq.current += 1 // invalidate a listing still in flight for the previous host
        previewSeq.current += 1
        if (!host) {
          setCwd('/')
          setPathInput('/')
          setEntries([])
          setTotal(0)
          setTruncated(false)
          setSelectedFile(null)
          setPreview(null)
          setPreviewError(null)
          setListError(null)
          setLoading(false)
          setMenu(null)
          setDialog(null)
          setEditor(null)
          return
        }
        setCwd('/')
        setPathInput('/')
        setPreview(null)
        setSelectedFile(null)
        setPreviewError(null)
        setMenu(null)
        setDialog(null)
        setEditor(null)
        load('/')
      }, [host, load])

      useEffect(() => {
        if (!fileNotice) return undefined
        const timer = setTimeout(() => setFileNotice(null), 3000)
        return () => clearTimeout(timer)
      }, [fileNotice])

      const openFile = useCallback(async (entry) => {
        if (!host) return
        const path = joinPath(cwd, entry.name)
        const seq = previewSeq.current + 1
        previewSeq.current = seq
        setSelectedFile(path)
        setPreview(null)
        setPreviewError(null)
        setPreviewLoading(true)
        try {
          const query = new URLSearchParams({ host, path })
          const data = await callApi(API.file + '?' + query.toString(), { headers: WRITE_HEADERS })
          if (seq !== previewSeq.current) return
          setPreview(data)
        } catch (failure) {
          if (seq !== previewSeq.current) return
          setPreviewError(failure.message)
        } finally {
          if (seq === previewSeq.current) setPreviewLoading(false)
        }
      }, [cwd, host])

      const goUp = () => {
        if (cwd === '/') return
        const next = parentPath(cwd)
        setPathInput(next)
        load(next)
      }

      const submitPath = (event) => {
        event.preventDefault()
        const next = pathInput.trim()
        if (!next) {
          setListError('路径不能为空')
          return
        }
        if (!next.startsWith('/')) {
          setListError('路径必须是绝对路径（以 / 开头）')
          return
        }
        load(next)
      }

      const openEntry = (entry) => {
        setMenu(null)
        if (entry.type === 'dir') {
          const next = joinPath(cwd, entry.name)
          setPathInput(next)
          load(next)
        } else if (entry.type === 'file' || entry.type === 'link') {
          setPreview(null)
          setPreviewError(null)
          setPreviewLoading(true) // show the reading state before the request starts
          openFile(entry)
        }
      }

      const previewMeta = preview
        ? preview.binary
          ? '二进制文件 · ' + formatBytes(preview.size)
          : (preview.truncated ? '已截断 · ' : '') + (preview.truncated ? '前 ' : '') + formatBytes(preview.bytes) + (preview.truncated ? ' / 共 ' + formatBytes(preview.size) : '')
        : ''

      const beginEdit = async (entry) => {
        if (!host) return
        const path = joinPath(cwd, entry.name)
        setMenu(null)
        setFileActionError(null)
        setFileNotice(null)
        try {
          const query = new URLSearchParams({ host, path })
          const data = await callApi(API.fileDownload + '?' + query.toString(), { headers: WRITE_HEADERS })
          const bytes = decodeBase64Bytes(data.content)
          if (data.truncated) {
            setEditor({ path, content: '', size: Number(data.size) || bytes.length, readOnly: true, note: '文件超过可下载上限，只能查看，不能就地编辑' })
            return
          }
          if (bytes.includes(0)) {
            setFileActionError('二进制文件不能就地编辑')
            return
          }
          const text = new TextDecoder().decode(bytes)
          const readOnly = bytes.length > FILE_EDIT_MAX_BYTES
          setEditor({ path, content: text, size: bytes.length, readOnly, note: readOnly ? '文件超过 256KB，只读' : null })
        } catch (error) {
          setFileActionError('读取文件失败：' + (error && error.message ? error.message : String(error)))
        }
      }

      const saveEditor = async (asPath) => {
        if (!editor || !host || busyAction) return
        const target = asPath ? joinPath(parentPath(editor.path), asPath.trim()) : editor.path
        if (asPath && !asPath.trim()) { setFileActionError('另存路径不能为空'); return }
        setBusyAction(true)
        setFileActionError(null)
        setFileNotice(null)
        try {
          const bytes = new TextEncoder().encode(editor.content)
          if (bytes.length > FILE_EDIT_MAX_BYTES) throw new Error('内容超过 256KB 上限')
          const query = new URLSearchParams({
            host,
            path: target,
            data: encodeBytesBase64(bytes),
            mode: asPath ? 'create' : 'overwrite',
          })
          await callApi(API.fileWrite + '?' + query.toString(), { headers: WRITE_HEADERS })
          setEditor(asPath ? { ...editor, path: target } : null)
          setFileNotice((asPath ? '已另存 ' : '已保存 ') + target)
          await load(cwd)
        } catch (error) {
          setFileActionError('保存失败：' + (error && error.message ? error.message : String(error)))
        } finally {
          setBusyAction(false)
        }
      }

      const downloadSelected = async () => {
        if (!host || !selectedFile || downloadBusy) return
        setDownloadBusy(true)
        setFileActionError(null)
        setFileNotice(null)
        try {
          const query = new URLSearchParams({ host, path: selectedFile })
          const data = await callApi(API.fileDownload + '?' + query.toString(), { headers: WRITE_HEADERS })
          const bytes = decodeBase64Bytes(data.content)
          const name = data.name || selectedFile.split('/').filter(Boolean).pop() || 'download.bin'
          saveBlob(new Blob([bytes], { type: 'application/octet-stream' }), name)
          setFileNotice(data.truncated
            ? '已截断，只下载了前 ' + formatBytes(Number(data.bytes) || bytes.length) + '（原文件 ' + formatBytes(Number(data.size) || 0) + '）'
            : '已下载 ' + name + '（' + formatBytes(Number(data.bytes) || bytes.length) + '）')
        } catch (error) {
          setFileActionError('下载失败：' + (error && error.message ? error.message : String(error)))
        } finally {
          setDownloadBusy(false)
        }
      }

      const downloadEntry = async (entry) => {
        const path = joinPath(cwd, entry.name)
        setMenu(null)
        if (!host) return
        setDownloadBusy(true)
        setFileActionError(null)
        setFileNotice(null)
        try {
          const query = new URLSearchParams({ host, path })
          const data = await callApi(API.fileDownload + '?' + query.toString(), { headers: WRITE_HEADERS })
          const bytes = decodeBase64Bytes(data.content)
          saveBlob(new Blob([bytes], { type: 'application/octet-stream' }), entry.name)
          setFileNotice(data.truncated
            ? '已截断，只下载了前 ' + formatBytes(Number(data.bytes) || bytes.length)
            : '已下载 ' + entry.name + '（' + formatBytes(Number(data.bytes) || bytes.length) + '）')
        } catch (error) {
          setFileActionError('下载失败：' + (error && error.message ? error.message : String(error)))
        } finally {
          setDownloadBusy(false)
        }
      }

      const onFileChosen = async (event) => {
        const input = event.target
        const file = input.files && input.files[0]
        input.value = '' // allow choosing the same file again
        if (!file || !host || uploading) return
        const targetDir = uploadTargetRef.current || cwd
        uploadTargetRef.current = null
        setFileActionError(null)
        setFileNotice(null)
        if (file.size > UPLOAD_MAX_BYTES) {
          setFileActionError('文件超过 ' + formatBytes(UPLOAD_MAX_BYTES) + ' 上限，请改用 Agent 的 remote_upload 工具')
          return
        }
        setUploading(true)
        setUploadProgress({ sent: 0, total: file.size })
        let uploadId = null
        try {
          const beginQuery = new URLSearchParams({
            host,
            path: joinPath(targetDir, file.name),
            size: String(file.size),
            mode: 'overwrite',
          })
          const begin = await callApi(API.uploadBegin + '?' + beginQuery.toString(), { headers: WRITE_HEADERS })
          uploadId = begin.uploadId
          const bytes = new Uint8Array(await file.arrayBuffer())
          const chunkBytes = Number.isInteger(begin.chunkBytes) && begin.chunkBytes > 0 ? begin.chunkBytes : UPLOAD_CHUNK_BYTES
          for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
            const piece = bytes.subarray(offset, Math.min(bytes.length, offset + chunkBytes))
            const chunkQuery = new URLSearchParams({
              uploadId,
              offset: String(offset),
              data: encodeBytesBase64(piece),
            })
            const result = await callApi(API.uploadChunk + '?' + chunkQuery.toString(), { headers: WRITE_HEADERS })
            setUploadProgress({ sent: Number(result.received) || offset + piece.length, total: file.size })
          }
          const done = await callApi(API.uploadFinish + '?' + new URLSearchParams({ uploadId }).toString(), { headers: WRITE_HEADERS })
          setFileNotice('已上传 ' + file.name + '（' + formatBytes(Number(done.bytes) || file.size) + '）')
          await load(cwd)
        } catch (error) {
          if (uploadId) {
            try {
              await callApi(API.uploadAbort + '?' + new URLSearchParams({ uploadId }).toString(), { headers: WRITE_HEADERS })
            } catch { /* the session may already be gone */ }
          }
          setFileActionError('上传失败：' + (error && error.message ? error.message : String(error)))
        } finally {
          setUploading(false)
          setUploadProgress(null)
        }
      }

      const entryPath = (entry) => joinPath(cwd, entry.name)

      const startUploadHere = (entry) => {
        setMenu(null)
        uploadTargetRef.current = joinPath(cwd, entry.name)
        if (fileInputRef.current) fileInputRef.current.click()
      }

      const openDialog = (kind, entry) => {
        setMenu(null)
        setFileActionError(null)
        setFileNotice(null)
        const path = entry ? entryPath(entry) : cwd
        if (kind === 'mkdir') setDialog({ kind, path, value: '' })
        else if (kind === 'newfile') setDialog({ kind, path, value: '' })
        else if (kind === 'rename') setDialog({ kind, path, value: entry.name })
        else if (kind === 'delete') setDialog({ kind, path, name: entry.name, recursive: Boolean(entry.type === 'dir') })
        else if (kind === 'chmod') setDialog({ kind, path, name: entry.name, mode: entry.type === 'dir' ? '0755' : '0644', recursive: false })
        else if (kind === 'chown') setDialog({ kind, path, name: entry.name, uid: '0', gid: '0', recursive: false })
      }

      const updateDialog = (patch) => setDialog((previous) => (previous ? { ...previous, ...patch } : previous))

      const runDialog = async () => {
        if (!dialog || !host || busyAction) return
        const value = String(dialog.value || '').trim()
        setBusyAction(true)
        setFileActionError(null)
        setFileNotice(null)
        try {
          if (dialog.kind === 'mkdir' || dialog.kind === 'newfile') {
            if (!value) throw new Error('名称不能为空')
            const target = joinPath(dialog.path, value)
            if (dialog.kind === 'mkdir') {
              await callApi(API.fileMkdir + '?' + new URLSearchParams({ host, path: target }).toString(), { headers: WRITE_HEADERS })
              setFileNotice('已新建目录 ' + target)
            } else {
              await callApi(API.fileWrite + '?' + new URLSearchParams({ host, path: target, data: '', mode: 'create' }).toString(), { headers: WRITE_HEADERS })
              setFileNotice('已新建文件 ' + target)
            }
          } else if (dialog.kind === 'rename') {
            if (!value || value.includes('/')) throw new Error('新名称不能为空，且不能包含 /')
            const target = joinPath(parentPath(dialog.path), value)
            await callApi(API.fileRename + '?' + new URLSearchParams({ host, from: dialog.path, to: target }).toString(), { headers: WRITE_HEADERS })
            setFileNotice('已重命名为 ' + target)
            if (selectedFile === dialog.path) setSelectedFile(target)
          } else if (dialog.kind === 'saveas') {
            if (!editor) throw new Error('没有正在编辑的文件')
            if (!value || value.includes('/')) throw new Error('另存文件名不能为空，且不能包含 /')
            const target = joinPath(parentPath(editor.path), value)
            const bytes = new TextEncoder().encode(editor.content)
            if (bytes.length > FILE_EDIT_MAX_BYTES) throw new Error('内容超过 256KB 上限')
            await callApi(API.fileWrite + '?' + new URLSearchParams({ host, path: target, data: encodeBytesBase64(bytes), mode: 'create' }).toString(), { headers: WRITE_HEADERS })
            setEditor({ ...editor, path: target })
            setFileNotice('已另存 ' + target)
          } else if (dialog.kind === 'delete') {
            const query = new URLSearchParams({ host, path: dialog.path })
            if (dialog.recursive) query.set('recursive', '1')
            await callApi(API.fileDelete + '?' + query.toString(), { headers: WRITE_HEADERS })
            setFileNotice('已删除 ' + dialog.path)
            if (selectedFile === dialog.path) { setSelectedFile(null); setPreview(null) }
            if (editor && editor.path === dialog.path) setEditor(null)
          } else if (dialog.kind === 'chmod') {
            if (!/^[0-7]{3,4}$/.test(dialog.mode)) throw new Error('权限必须是八进制数字，如 0644')
            await callApi(API.fileChmod + '?' + new URLSearchParams({ host, path: dialog.path, mode: dialog.mode }).toString(), { headers: WRITE_HEADERS })
            setFileNotice('已设置权限 ' + dialog.mode + ' · ' + dialog.path)
          } else if (dialog.kind === 'chown') {
            const uid = Number(dialog.uid)
            const gid = Number(dialog.gid)
            if (!Number.isInteger(uid) || uid < 0 || !Number.isInteger(gid) || gid < 0) throw new Error('uid 与 gid 必须是非负整数')
            await callApi(API.fileChown + '?' + new URLSearchParams({ host, path: dialog.path, uid: String(uid), gid: String(gid) }).toString(), { headers: WRITE_HEADERS })
            setFileNotice('已设置所有者 ' + uid + ':' + gid + ' · ' + dialog.path)
          }
          setDialog(null)
          await load(cwd)
        } catch (error) {
          setFileActionError((error && error.message ? error.message : String(error)))
        } finally {
          setBusyAction(false)
        }
      }

      const copyPath = (entry) => {
        setMenu(null)
        const path = entryPath(entry)
        const fallback = () => {
          try {
            copyTextFallback(path)
            setFileNotice('已复制路径 ' + path)
          } catch {
            setFileActionError('复制失败，请手动选择路径')
          }
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(path).then(() => setFileNotice('已复制路径 ' + path)).catch(fallback)
        } else {
          fallback()
        }
      }

      const toggleModeBit = (offset, checked) => {
        if (!dialog) return
        const digits = String(dialog.mode || '0644').padStart(4, '0').slice(-3).split('').map((digit) => Number(digit))
        const bit = offset % 3
        const weights = [4, 2, 1]
        const index = Math.floor(offset / 3)
        if (checked) digits[index] |= weights[bit]
        else digits[index] &= ~weights[bit]
        updateDialog({ mode: '0' + digits.join('') })
      }

      const modeChar = (digit, offset) => {
        const weights = [4, 2, 1]
        return (Number(digit) & weights[offset % 3]) !== 0
      }

      const menuItems = (entry) => {
        const items = []
        if (entry.type === 'dir') {
          items.push({ label: '打开', run: () => openEntry(entry) })
          items.push({ label: '上传到此处', run: () => startUploadHere(entry) })
          items.push({ label: '新建文件', run: () => openDialog('newfile', entry) })
          items.push({ label: '新建目录', run: () => openDialog('mkdir', entry) })
        } else {
          items.push({ label: '预览', run: () => openEntry(entry) })
          items.push({ label: '编辑', run: () => beginEdit(entry) })
          items.push({ label: '下载', run: () => downloadEntry(entry) })
        }
        items.push({ label: '重命名', run: () => openDialog('rename', entry) })
        items.push({ label: '复制路径', run: () => copyPath(entry) })
        items.push({ label: '权限…', run: () => openDialog('chmod', entry) })
        items.push({ label: '所有者…', run: () => openDialog('chown', entry) })
        items.push({ label: '删除', danger: true, run: () => openDialog('delete', entry) })
        return items
      }

      const dialogTitle = dialog
        ? ({
          mkdir: '新建目录', newfile: '新建文件', rename: '重命名', delete: '删除', chmod: '修改权限', chown: '修改所有者', saveas: '另存为',
        })[dialog.kind]
        : ''

      const dialogNode = dialog
        ? h('div', {
          style: {
            position: 'absolute',
            inset: 0,
            zIndex: 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--dsw-alias-bg-overlay)',
            padding: '8px',
          },
        },
        h('div', {
          style: {
            width: '100%',
            maxWidth: '280px',
            padding: '10px',
            borderRadius: 'var(--dsw-radius-sm, 6px)',
            border: '1px solid ' + T.borderStrong,
            background: T.surface,
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          },
        },
        h('div', { style: { fontSize: '12px', color: T.text } }, dialogTitle),
        dialog.kind === 'mkdir' || dialog.kind === 'newfile' || dialog.kind === 'rename' || dialog.kind === 'saveas'
          ? h('label', { style: fieldLabelStyle }, '名称',
            h('input', {
              value: dialog.value,
              onChange: (event) => updateDialog({ value: event.target.value }),
              spellCheck: false,
              autoFocus: true,
              style: fieldStyle,
            }))
          : null,
        dialog.kind === 'delete'
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
            h('p', { style: { margin: 0, fontSize: '11px', color: T.error, wordBreak: 'break-all' } }, dialog.path),
            h('p', { style: { margin: 0, fontSize: '10px', color: T.muted } }, '删除后无法恢复，确认继续？'))
          : null,
        dialog.kind === 'chmod'
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            h('div', { style: { fontSize: '10px', color: T.muted, wordBreak: 'break-all' } }, dialog.path),
            h('div', { style: { display: 'flex', gap: '4px' } },
              ['r', 'w', 'x'].map((label, offset) => h('label', {
                key: label,
                style: { flex: '1 1 0', fontSize: '10px', color: T.muted, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' },
              }, label,
              h('input', {
                type: 'checkbox',
                checked: modeChar(String(dialog.mode || '0644').padStart(4, '0').slice(-3).split('')[0], offset),
                onChange: (event) => toggleModeBit(offset, event.target.checked),
              })))),
            h('div', { style: { display: 'flex', gap: '4px' } },
              ['r', 'w', 'x'].map((label, offset) => h('label', {
                key: 'g' + label,
                style: { flex: '1 1 0', fontSize: '10px', color: T.muted, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' },
              }, label,
              h('input', {
                type: 'checkbox',
                checked: modeChar(String(dialog.mode || '0644').padStart(4, '0').slice(-3).split('')[1], offset),
                onChange: (event) => toggleModeBit(offset + 3, event.target.checked),
              })))),
            h('div', { style: { display: 'flex', gap: '4px' } },
              ['r', 'w', 'x'].map((label, offset) => h('label', {
                key: 'o' + label,
                style: { flex: '1 1 0', fontSize: '10px', color: T.muted, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' },
              }, label,
              h('input', {
                type: 'checkbox',
                checked: modeChar(String(dialog.mode || '0644').padStart(4, '0').slice(-3).split('')[2], offset),
                onChange: (event) => toggleModeBit(offset + 6, event.target.checked),
              })))),
            h('input', {
              value: dialog.mode,
              onChange: (event) => updateDialog({ mode: event.target.value }),
              placeholder: '0644',
              spellCheck: false,
              style: { ...fieldStyle, fontFamily: T.mono },
            }))
          : null,
        dialog.kind === 'chown'
          ? h('div', { style: { display: 'flex', gap: '6px' } },
            h('label', { style: { ...fieldLabelStyle, flex: '1 1 0' } }, 'UID',
              h('input', { value: dialog.uid, onChange: (event) => updateDialog({ uid: event.target.value }), inputMode: 'numeric', style: fieldStyle })),
            h('label', { style: { ...fieldLabelStyle, flex: '1 1 0' } }, 'GID',
              h('input', { value: dialog.gid, onChange: (event) => updateDialog({ gid: event.target.value }), inputMode: 'numeric', style: fieldStyle })))
          : null,
        h('div', { style: { display: 'flex', gap: '6px', justifyContent: 'flex-end' } },
          h('button', {
            type: 'button',
            onClick: () => setDialog(null),
            disabled: busyAction,
            style: { ...buttonStyle(false), height: '28px', padding: '0 10px' },
          }, '取消'),
          h('button', {
            type: 'button',
            onClick: runDialog,
            disabled: busyAction,
            style: {
              ...buttonStyle(false),
              height: '28px',
              padding: '0 10px',
              borderColor: dialog.kind === 'delete' ? T.error : T.accent,
              color: dialog.kind === 'delete' ? T.error : T.accent,
              opacity: busyAction ? 0.55 : 1,
            },
          }, busyAction ? '处理中…' : dialog.kind === 'delete' ? '确认删除' : '确定'))))
        : null

      const editorNode = editor
        ? h('div', {
          style: {
            flex: '1 1 0',
            minHeight: '140px',
            display: 'flex',
            flexDirection: 'column',
            border: '1px solid ' + T.borderStrong,
            borderRadius: '8px',
            background: T.base,
            overflow: 'hidden',
          },
        },
        h('div', {
          style: {
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '4px 8px',
            borderBottom: '1px solid ' + T.border,
            background: T.surface,
            fontSize: '11px',
            color: T.muted,
          },
        },
        h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: T.mono, color: T.text } },
          '编辑 · ' + editor.path),
        editor.note ? h('span', { style: { color: T.warn, fontSize: '10px' } }, editor.note) : null,
        h('button', {
          type: 'button',
          onClick: () => saveEditor(null),
          disabled: editor.readOnly || busyAction,
          style: { ...smallButtonStyle(editor.readOnly || busyAction), marginLeft: 'auto', height: '28px', padding: '0 10px' },
        }, busyAction ? '保存中…' : '保存'),
        h('button', {
          type: 'button',
          onClick: () => setDialog({ kind: 'saveas', value: editor.path.split('/').pop() + '.copy' }),
          disabled: busyAction,
          style: { ...smallButtonStyle(busyAction), height: '28px', padding: '0 10px' },
        }, '另存'),
        h('button', {
          type: 'button',
          onClick: () => setEditor(null),
          disabled: busyAction,
          style: { ...smallButtonStyle(busyAction), height: '28px', padding: '0 10px' },
        }, '放弃')),
        h('textarea', {
          value: editor.content,
          onChange: (event) => setEditor({ ...editor, content: event.target.value }),
          readOnly: editor.readOnly,
          spellCheck: false,
          'aria-label': '就地文件编辑器',
          style: {
            flex: '1 1 auto',
            minHeight: 0,
            resize: 'none',
            border: 'none',
            outline: 'none',
            padding: '8px',
            background: T.base,
            color: T.text,
            fontFamily: T.mono,
            fontSize: '12px',
            lineHeight: '17px',
          },
        }))
        : null

      return h('aside', {
        style: {
          width: '100%',
          flex: '1 1 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          minHeight: 0,
          position: 'relative',
        },
      },
      h('div', { style: { fontSize: '12px', color: T.muted } },
        '文件' + (host ? '（' + host + '）' : '')),
      h('form', {
        onSubmit: submitPath,
        style: { display: 'flex', gap: '5px', alignItems: 'center', flex: '0 0 auto' },
      },
      h('input', {
        value: pathInput,
        onChange: (event) => setPathInput(event.target.value),
        placeholder: '/',
        spellCheck: false,
        'aria-label': '远端目录路径',
        style: { ...fieldStyle, flex: '1 1 0', minWidth: 0, fontFamily: T.mono },
      }),
      h('button', {
        type: 'submit',
        disabled: !host || loading,
        style: { ...buttonStyle(false), height: '28px', padding: '0 10px', opacity: !host || loading ? 0.55 : 1 },
      }, loading ? '…' : '转到')),
      h('div', { style: { display: 'flex', gap: '6px', flex: '0 0 auto', alignItems: 'center', flexWrap: 'wrap' } },
        h('button', {
          type: 'button',
          onClick: goUp,
          disabled: !host || cwd === '/',
          style: { ...buttonStyle(false), height: '28px', padding: '0 10px', opacity: !host || cwd === '/' ? 0.55 : 1 },
        }, '上一级'),
        h('button', {
          type: 'button',
          onClick: () => load(cwd),
          disabled: !host || loading,
          style: { ...buttonStyle(false), height: '28px', padding: '0 10px', opacity: !host || loading ? 0.55 : 1 },
        }, '刷新'),
        h('input', {
          ref: fileInputRef,
          type: 'file',
          className: 'remote-upload-input',
          onChange: onFileChosen,
          style: { display: 'none' },
          'aria-hidden': true,
        }),
        h('button', {
          type: 'button',
          className: 'remote-file-upload remote-upload-button',
          title: '上传到 ' + cwd,
          onClick: () => { uploadTargetRef.current = cwd; if (fileInputRef.current) fileInputRef.current.click() },
          disabled: !host || loading || uploading,
          style: {
            ...buttonStyle(false),
            height: '28px',
            padding: '0 10px',
            opacity: !host || loading || uploading ? 0.55 : 1,
          },
        }, uploading && uploadProgress
          ? '上传中 ' + Math.round(uploadProgress.total > 0 ? (uploadProgress.sent / uploadProgress.total) * 100 : 100) + '%'
          : '上传文件'),
        h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px', alignItems: 'center' } },
          h('select', {
            value: sortMode,
            onChange: (event) => setSortMode(event.target.value),
            'aria-label': '排序方式',
            style: { ...fieldStyle, height: '28px', padding: '0 4px', fontSize: '11px' },
          },
          h('option', { value: 'name' }, '名称'),
          h('option', { value: 'size' }, '大小'),
          h('option', { value: 'mtime' }, '时间')),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: '3px', fontSize: '10px', color: T.muted } },
            h('input', { type: 'checkbox', checked: showHidden, onChange: (event) => setShowHidden(event.target.checked) }),
            '隐藏文件'))),
      listError
        ? h('p', { role: 'alert', style: { margin: 0, fontSize: '11px', color: T.error, wordBreak: 'break-word' } }, listError)
        : null,
      uploadProgress
        ? h('p', { style: { margin: 0, fontSize: '10px', color: T.muted } },
          '已上传 ' + formatBytes(uploadProgress.sent) + ' / ' + formatBytes(uploadProgress.total))
        : null,
      fileActionError
        ? h('p', { role: 'alert', style: { margin: 0, fontSize: '11px', color: T.error, wordBreak: 'break-word' } }, fileActionError)
        : null,
      fileNotice
        ? h('p', { role: 'status', style: { margin: 0, fontSize: '10px', color: T.success, wordBreak: 'break-word' } }, fileNotice)
        : null,
      h('div', {
        style: {
          flex: '1 1 0',
          minHeight: '96px',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '1px',
          border: '1px solid ' + T.border,
          borderRadius: '8px',
          background: T.base,
          padding: '4px',
        },
      },
      loading && entries.length === 0
        ? h('p', { style: { margin: 0, padding: '6px', fontSize: '11px', color: T.muted } }, '加载中…')
        : entries.length === 0
          ? h('p', { style: { margin: 0, padding: '6px', fontSize: '11px', color: T.muted } },
            host ? '空目录' : '先在左侧选择一台主机')
          : entries.map((entry) => h('div', {
            key: entry.name,
            className: 'remote-files-row',
            style: { display: 'flex', alignItems: 'center', gap: '2px' },
          },
          h('button', {
            type: 'button',
            title: entry.name,
            onClick: () => openEntry(entry),
            onDoubleClick: () => { if (entry.type === 'file' || entry.type === 'link') beginEdit(entry) },
            onContextMenu: (event) => {
              event.preventDefault()
              setMenu({ x: event.clientX, y: event.clientY, entry })
            },
            style: {
              appearance: 'none',
              font: 'inherit',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              flex: '1 1 auto',
              minWidth: 0,
              textAlign: 'left',
              padding: '4px 6px',
              borderRadius: 'var(--dsw-radius-sm, 6px)',
              cursor: 'pointer',
              color: T.text,
              background: selectedFile === joinPath(cwd, entry.name) ? T.surface2 : 'transparent',
              border: '1px solid transparent',
            },
          },
          h('span', {
            'aria-hidden': true,
            style: { width: '12px', flex: '0 0 auto', color: entry.type === 'dir' ? T.accent : T.muted },
          }, entry.type === 'dir' ? '▸' : entry.type === 'link' ? '↪' : '·'),
          h('span', {
            style: {
              flex: '1 1 auto',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: '11px',
              fontFamily: entry.type === 'dir' ? 'inherit' : T.mono,
            },
          }, entry.name),
          h('span', { style: { flex: '0 0 auto', fontSize: '10px', color: T.muted } },
            entry.type === 'dir' ? '' : formatBytes(entry.size)),
          h('span', { style: { flex: '0 0 auto', fontSize: '10px', color: T.muted } },
            formatMtime(entry.mtime))),
          // 右键菜单的可点击入口：按钮不能嵌套按钮，行是 div + 主按钮 + 「⋯」。
          h('button', {
            type: 'button',
            className: 'remote-files-more',
            'aria-label': '更多操作：' + entry.name,
            title: '更多操作',
            onClick: (event) => {
              event.preventDefault()
              event.stopPropagation()
              const rect = event.currentTarget.getBoundingClientRect()
              setMenu({ x: rect.left, y: Math.round(rect.bottom + 2), entry })
            },
            style: {
              appearance: 'none',
              font: 'inherit',
              flex: '0 0 auto',
              width: '20px',
              height: '20px',
              padding: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              border: '1px solid transparent',
              borderRadius: 'var(--dsw-radius-sm, 6px)',
              background: 'transparent',
              color: T.muted,
              fontSize: '12px',
              lineHeight: '1',
            },
          }, '⋯')))),
      editorNode || h('div', {
        style: {
          flex: '1 1 0',
          minHeight: '120px',
          display: 'flex',
          flexDirection: 'column',
          border: '1px solid ' + T.border,
          borderRadius: '8px',
          background: T.base,
          overflow: 'hidden',
        },
      },
      h('div', {
        style: {
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '4px 8px',
          borderBottom: '1px solid ' + T.border,
          background: T.surface,
          fontSize: '11px',
          color: T.muted,
        },
      },
      h('span', {
        style: {
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontFamily: T.mono,
          color: T.text,
        },
      }, selectedFile || '文件预览'),
      h('button', {
        type: 'button',
        className: 'remote-files-download remote-file-download',
        title: selectedFile ? '下载 ' + selectedFile : '先选择一个文件',
        onClick: downloadSelected,
        disabled: !selectedFile || downloadBusy,
        style: { ...smallButtonStyle(!selectedFile || downloadBusy), flex: '0 0 auto', marginLeft: 'auto', height: '28px', padding: '0 10px' },
      }, downloadBusy ? '下载中…' : '下载'),
      h('span', { style: { flex: '0 0 auto' } }, previewLoading ? '读取中…' : previewMeta)),
      h('div', { style: { flex: '1 1 auto', minHeight: 0, overflow: 'auto' } },
        previewLoading
          ? h('p', { style: { margin: 0, padding: '8px', fontSize: '11px', color: T.muted } }, '读取中…')
          : previewError
            ? h('p', { role: 'alert', style: { margin: 0, padding: '8px', fontSize: '11px', color: T.error, wordBreak: 'break-word' } }, previewError)
            : preview
              ? preview.binary
                ? h('p', { style: { margin: 0, padding: '8px', fontSize: '11px', color: T.muted } }, '二进制文件，不预览')
                : h('pre', {
                  style: {
                    margin: 0,
                    padding: '8px',
                    fontFamily: T.mono,
                    fontSize: '11px',
                    lineHeight: '16px',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    color: T.text,
                  },
                }, preview.content || '（空文件）')
              : h('p', { style: { margin: 0, padding: '8px', fontSize: '11px', color: T.muted } }, '点上面的文件预览内容，双击文本文件可就地编辑'))),
      menu
        ? h('div', {
          style: { position: 'fixed', inset: 0, zIndex: 40 },
          onMouseDown: () => setMenu(null),
          onContextMenu: (event) => { event.preventDefault(); setMenu(null) },
        },
        h('div', {
          style: {
            position: 'fixed',
            left: Math.min(menu.x, Math.max(8, (window.innerWidth || 800) - 180)),
            top: Math.min(menu.y, Math.max(8, (window.innerHeight || 600) - 240)),
            width: '168px',
            padding: '4px',
            borderRadius: 'var(--dsw-radius-sm, 6px)',
            border: '1px solid ' + T.borderStrong,
            background: T.surface,
            boxShadow: '0 6px 18px rgba(0, 0, 0, 0.28)',
            display: 'flex',
            flexDirection: 'column',
            gap: '1px',
          },
        }, menuItems(menu.entry).map((item) => h('button', {
          key: item.label,
          type: 'button',
          onClick: item.run,
          style: {
            appearance: 'none',
            font: 'inherit',
            fontSize: '11px',
            textAlign: 'left',
            padding: '5px 8px',
            height: '28px',
            borderRadius: '4px',
            border: 'none',
            cursor: 'pointer',
            color: item.danger ? T.error : T.text,
            background: 'transparent',
          },
        }, item.label))))
        : null,
      dialogNode)
    }

    // Interactive PTY for the selected host: opens a panel-flagged shell, polls shell-read for
    // incremental output, and forwards keydown/paste bytes through shell-send.
    function TerminalPanel({ host }) {
      const [sessionId, setSessionId] = useState(null)
      const [status, setStatus] = useState('idle')
      const [display, setDisplay] = useState('')
      const [lineNotice, setLineNotice] = useState(null)
      const [restored, setRestored] = useState(false)
      const [error, setError] = useState(null)
      const [history, setHistory] = useState([])
      const [historyOpen, setHistoryOpen] = useState(false)
      const [copied, setCopied] = useState(false)
      const sessionRef = useRef(null)
      const aliveRef = useRef(false)
      const hostRef = useRef(host)
      hostRef.current = host
      const previousHostRef = useRef(host)
      const outputRef = useRef({ lines: [''], dropped: 0 })
      const pollRef = useRef(null)
      const sendChainRef = useRef(Promise.resolve())
      const preRef = useRef(null)
      const resizeRetryRef = useRef(null)
      const copyTimerRef = useRef(null)
      const lineRef = useRef('')
      const cursorRef = useRef(0)
      const historyIndexRef = useRef(-1)
      const [grid, setGrid] = useState({ cols: 100, rows: 30 })
      const gridRef = useRef({ cols: 100, rows: 30 })
      const statusRef = useRef('idle')
      statusRef.current = status

      const stopPolling = () => {
        if (pollRef.current) {
          clearInterval(pollRef.current)
          pollRef.current = null
        }
      }

      const updateDisplay = (state) => {
        const total = state.lines.length + state.dropped
        const start = Math.max(0, state.lines.length - MAX_DISPLAY_LINES)
        setDisplay(state.lines.slice(start).join('\n'))
        setLineNotice(total > MAX_DISPLAY_LINES ? { shown: state.lines.length - start, total } : null)
      }

      const resetOutput = (text) => {
        const lines = String(text == null ? '' : text).split('\n')
        let dropped = 0
        if (lines.length > MAX_LOCAL_LINES) {
          dropped = lines.length - MAX_LOCAL_LINES
          lines.splice(0, dropped)
        }
        outputRef.current = { lines, dropped }
        updateDisplay(outputRef.current)
      }

      // Keep the transcript as lines and only render the last MAX_DISPLAY_LINES, so a long-running
      // PTY cannot force React to re-render a multi-megabyte string.
      const append = (chunk) => {
        const text = cleanTerminalOutput(chunk)
        if (!text) return
        const state = outputRef.current
        const parts = (state.lines[state.lines.length - 1] + text).split('\n')
        state.lines[state.lines.length - 1] = parts[0]
        for (let index = 1; index < parts.length; index += 1) state.lines.push(parts[index])
        if (state.lines.length > MAX_LOCAL_LINES) {
          const excess = state.lines.length - MAX_LOCAL_LINES
          state.lines.splice(0, excess)
          state.dropped += excess
        }
        updateDisplay(state)
      }

      const closeRemoteSession = useCallback((sid) => {
        if (!sid) return
        const query = new URLSearchParams({ sessionId: sid })
        callApi(`${API.shellClose}?${query.toString()}`, { headers: WRITE_HEADERS }).catch(() => { /* already gone */ })
      }, [])

      // Drop the local side only: stop polling and forget the id, leaving the PTY alive on the host so
      // a page refresh can re-attach to it through shell-attach.
      const detachLocal = useCallback(() => {
        stopPolling()
        if (resizeRetryRef.current) {
          clearTimeout(resizeRetryRef.current)
          resizeRetryRef.current = null
        }
        lineRef.current = ''
        cursorRef.current = 0
        historyIndexRef.current = -1
        sessionRef.current = null
        setSessionId(null)
        setRestored(false)
      }, [])

      const closeSession = useCallback((quiet, options = {}) => {
        const forget = options.forget !== false
        stopPolling()
        if (resizeRetryRef.current) {
          clearTimeout(resizeRetryRef.current)
          resizeRetryRef.current = null
        }
        lineRef.current = ''
        cursorRef.current = 0
        historyIndexRef.current = -1
        const sid = sessionRef.current
        sessionRef.current = null
        setSessionId(null)
        setRestored(false)
        if (!sid) return
        if (forget) clearStoredShellSession(hostRef.current, sid)
        closeRemoteSession(sid)
        if (!quiet) setStatus('idle')
      }, [closeRemoteSession])

      const readOnce = useCallback(async () => {
        const sid = sessionRef.current
        if (!sid || !aliveRef.current) return
        try {
          const query = new URLSearchParams({ sessionId: sid })
          const data = await callApi(`${API.shellRead}?${query.toString()}`, { headers: WRITE_HEADERS })
          if (!aliveRef.current || hostRef.current !== host || sessionRef.current !== sid) return
          append(decodeBase64(data.output))
          if (data.exited) {
            stopPolling()
            setStatus('exited')
          }
        } catch (failure) {
          if (!aliveRef.current || hostRef.current !== host) return
          stopPolling()
          setStatus('exited')
          setError(failure.message)
        }
      }, [host])

      const startPolling = useCallback(() => {
        stopPolling()
        pollRef.current = setInterval(() => { readOnce() }, 800)
      }, [readOnce])

      // Re-measure the visible <pre> and push the real size to the PTY. Needed because the panel can be
      // laid out at a narrow width while the session is still opening; openSession opens with whatever
      // the grid was then, so the first observation after "live" must be replayed to the server.
      const syncMeasuredDims = useCallback((sessionId, opened) => {
        const node = preRef.current
        if (!node) return
        const rect = node.getBoundingClientRect()
        const next = computeTerminalGrid({ width: rect.width, height: rect.height })
        gridRef.current = next
        setGrid(next)
        if (!sessionId) return
        if (opened && next.cols === opened.cols && next.rows === opened.rows) return
        const query = new URLSearchParams({ sessionId, cols: String(next.cols), rows: String(next.rows) })
        callApi(`${API.shellResize}?${query.toString()}`, { headers: WRITE_HEADERS }).catch((failure) => {
          if (aliveRef.current && !/不存在/.test(failure.message)) setError(failure.message)
        })
      }, [])

      const openSession = useCallback(async () => {
        if (!host) { setError('先在左侧选择一台主机'); setStatus('idle'); return }
        closeSession(true)
        resetOutput('')
        setRestored(false)
        setError(null)
        setStatus('connecting')
        aliveRef.current = true
        try {
          const query = new URLSearchParams({ host, cols: String(gridRef.current.cols), rows: String(gridRef.current.rows) })
          const data = await callApi(`${API.shellOpen}?${query.toString()}`, { headers: WRITE_HEADERS })
          if (!aliveRef.current || hostRef.current !== host) {
            const opened = data.session && data.session.id
            if (opened) closeRemoteSession(opened)
            return
          }
          sessionRef.current = data.session.id
          setSessionId(data.session.id)
          writeStoredShellSession(host, data.session.id)
          const opened = { cols: data.session.cols || gridRef.current.cols, rows: data.session.rows || gridRef.current.rows }
          gridRef.current = opened
          setGrid(opened)
          setStatus('live')
          startPolling()
          syncMeasuredDims(data.session.id, opened)
          if (resizeRetryRef.current) clearTimeout(resizeRetryRef.current)
          resizeRetryRef.current = setTimeout(() => {
            resizeRetryRef.current = null
            if (aliveRef.current && sessionRef.current === data.session.id) syncMeasuredDims(data.session.id)
          }, 600)
          readOnce()
        } catch (failure) {
          if (!aliveRef.current || hostRef.current !== host) return
          setStatus('idle')
          setError(failure.message)
        }
      }, [host, closeSession, startPolling, readOnce, syncMeasuredDims, closeRemoteSession])

      // Re-attach to the PTY recorded for this host. Returns 'missing' on 404 so the caller can open a
      // fresh session; 'failed' keeps the inline error and does not silently spawn a second shell.
      const attachSession = useCallback(async (stored) => {
        setError(null)
        setStatus('connecting')
        try {
          const query = new URLSearchParams({
            sessionId: stored.sessionId,
            cols: String(gridRef.current.cols),
            rows: String(gridRef.current.rows),
          })
          const data = await callApi(`${API.shellAttach}?${query.toString()}`, { headers: WRITE_HEADERS })
          if (!aliveRef.current || hostRef.current !== host) return 'stale'
          const session = data.session || {}
          sessionRef.current = session.id || stored.sessionId
          setSessionId(sessionRef.current)
          const opened = { cols: session.cols || gridRef.current.cols, rows: session.rows || gridRef.current.rows }
          gridRef.current = opened
          setGrid(opened)
          resetOutput(decodeBase64(data.backlog))
          setRestored(true)
          setStatus('live')
          startPolling()
          readOnce()
          return 'attached'
        } catch (failure) {
          if (!aliveRef.current || hostRef.current !== host) return 'stale'
          if (/不存在/.test(failure.message)) {
            clearStoredShellSession(host, stored.sessionId)
            return 'missing'
          }
          setStatus('idle')
          setError(failure.message)
          return 'failed'
        }
      }, [host, startPolling, readOnce])

      const restoreOrOpen = useCallback(async () => {
        if (!host) { setError('先在左侧选择一台主机'); setStatus('idle'); return }
        detachLocal()
        const stored = readStoredShellSession(host)
        if (stored) {
          const result = await attachSession(stored)
          if (result !== 'missing') return
        }
        await openSession()
      }, [host, detachLocal, attachSession, openSession])

      useEffect(() => {
        const previous = previousHostRef.current
        previousHostRef.current = host
        if (previous && previous !== host) {
          // Switching hosts retires the PTY we were attached to instead of leaving it for the idle sweep.
          const stored = readStoredShellSession(previous)
          if (stored) {
            clearStoredShellSession(previous, stored.sessionId)
            closeRemoteSession(stored.sessionId)
          }
        }
        aliveRef.current = true
        restoreOrOpen()
        return () => {
          aliveRef.current = false
          // 卸载视为主动关闭：别再让 disconnect 事件排重连。
          manualCloseRef.current = true
          detachLocal()
        }
      }, [host, restoreOrOpen, detachLocal, closeRemoteSession])

      useEffect(() => () => {
        if (copyTimerRef.current) {
          clearTimeout(copyTimerRef.current)
          copyTimerRef.current = null
        }
      }, [])

      useEffect(() => {
        const node = preRef.current
        if (node) node.scrollTop = node.scrollHeight
      }, [display])

      useEffect(() => {
        const node = preRef.current
        if (!node || typeof ResizeObserver === 'undefined') return undefined
        let timer = null
        const apply = (width, height) => {
          const next = computeTerminalGrid({ width, height })
          const current = gridRef.current
          if (next.cols === current.cols && next.rows === current.rows) return
          gridRef.current = next
          setGrid(next)
          const sid = sessionRef.current
          if (!sid || statusRef.current !== 'live') return
          const query = new URLSearchParams({ sessionId: sid, cols: String(next.cols), rows: String(next.rows) })
          callApi(`${API.shellResize}?${query.toString()}`, { headers: WRITE_HEADERS }).catch((failure) => {
            if (aliveRef.current && !/不存在/.test(failure.message)) setError(failure.message)
          })
        }
        const observer = new ResizeObserver((entries) => {
          const entry = entries[entries.length - 1]
          const box = entry && entry.contentRect ? entry.contentRect : node.getBoundingClientRect()
          if (timer) clearTimeout(timer)
          timer = setTimeout(() => { timer = null; apply(box.width, box.height) }, 300)
        })
        observer.observe(node)
        return () => {
          if (timer) clearTimeout(timer)
          observer.disconnect()
        }
      }, [])

      const send = (text, options = {}) => {
        const sid = sessionRef.current
        if (!sid || status !== 'live') return
        sendChainRef.current = sendChainRef.current.then(async () => {
          if (options.echo) append(text)
          const query = new URLSearchParams({ sessionId: sid, data: encodeBase64(text) })
          if (options.bracketed) query.set('bracketed', '1')
          const data = await callApi(`${API.shellSend}?${query.toString()}`, { headers: WRITE_HEADERS })
          if (!aliveRef.current || hostRef.current !== host || sessionRef.current !== sid) return
          append(decodeBase64(data.output))
          if (data.exited) {
            stopPolling()
            setStatus('exited')
          }
        }).catch((failure) => {
          if (aliveRef.current) setError(failure.message)
        })
      }

      const insertAtCursor = (text) => {
        const current = lineRef.current
        const at = cursorRef.current
        lineRef.current = current.slice(0, at) + text + current.slice(at)
        cursorRef.current = at + text.length
      }

      const commitLine = () => {
        setHistory((previous) => pushCommandHistory(previous, lineRef.current))
        lineRef.current = ''
        cursorRef.current = 0
        historyIndexRef.current = -1
      }

      // Replace the remote editing line with a history entry. Ctrl-U + Ctrl-K clears the whole
      // readline-style line regardless of the cursor position, then the text is typed once.
      const applyHistoryStep = (direction) => {
        const step = resolveHistoryStep(history, historyIndexRef.current, direction)
        if (step.index === historyIndexRef.current && step.text === lineRef.current) return
        historyIndexRef.current = step.index
        lineRef.current = step.text
        cursorRef.current = step.text.length
        send('\x15\x0b' + step.text)
      }

      const runHistory = (command) => {
        if (statusRef.current !== 'live') return
        setHistoryOpen(false)
        send(command + '\r', { echo: true })
        setHistory((previous) => pushCommandHistory(previous, command))
        lineRef.current = ''
        cursorRef.current = 0
        historyIndexRef.current = -1
      }

      const clearScreen = () => {
        resetOutput('')
        if (statusRef.current === 'live') {
          resetOutput('已清屏\n')
          send('\x0c')
        }
      }

      const copyOutput = async () => {
        const text = display
        if (!text) return
        let copiedNow = false
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(text)
            copiedNow = true
          }
        } catch (failure) {
          copiedNow = false
        }
        if (!copiedNow) {
          try {
            copyTextFallback(text, preRef.current)
            copiedNow = true
          } catch (failure) {
            copiedNow = false
          }
        }
        if (!copiedNow) {
          setError('复制失败：浏览器拒绝了剪贴板访问')
          return
        }
        setError(null)
        setCopied(true)
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
        copyTimerRef.current = setTimeout(() => {
          copyTimerRef.current = null
          setCopied(false)
        }, 2000)
      }

      // Fetch the full transcript (the server keeps up to 4MB) and hand it to the browser as a file.
      const downloadLog = async () => {
        const sid = sessionRef.current
        if (!sid) {
          setError('终端未连接，无法下载日志')
          return
        }
        try {
          const query = new URLSearchParams({ sessionId: sid })
          const data = await callApi(`${API.shellLog}?${query.toString()}`, { headers: WRITE_HEADERS })
          const blob = new Blob([decodeBase64(data.output)], { type: 'text/plain;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          link.download = `remote-${host}-${formatLogStamp(new Date())}.log`
          link.style.display = 'none'
          document.documentElement.appendChild(link)
          link.click()
          document.documentElement.removeChild(link)
          setTimeout(() => URL.revokeObjectURL(url), 0)
        } catch (failure) {
          setError(`下载日志失败：${failure.message}`)
        }
      }

      const onPaste = (event) => {
        event.preventDefault()
        const text = (event.clipboardData && event.clipboardData.getData('text/plain')) || ''
        if (!text || !sessionRef.current || statusRef.current !== 'live') return
        // One bracketed write for the whole clipboard: never replay it as individual keydowns.
        insertAtCursor(text)
        send(text, { bracketed: true, echo: true })
      }

      const onKeyDown = (event) => {
        if (status !== 'live') return
        const sequence = terminalKeySequence(event)
        if (sequence === null) return
        event.preventDefault()

        if (sequence === '\x1b[A' || sequence === '\x1b[B') {
          // Local history only takes over when it has entries; otherwise the arrow is the PTY's.
          if (history.length === 0) {
            send(sequence)
            return
          }
          applyHistoryStep(sequence === '\x1b[A' ? 'up' : 'down')
          return
        }

        if (sequence === '\r') {
          send(sequence)
          commitLine()
          return
        }

        if (sequence === '\x7f') {
          if (cursorRef.current > 0) {
            const current = lineRef.current
            const at = cursorRef.current
            lineRef.current = current.slice(0, at - 1) + current.slice(at)
            cursorRef.current = at - 1
          }
          send(sequence)
          return
        }

        if (sequence === '\x03') {
          // Ctrl-C cancels the editing line, matching readline-style shells.
          lineRef.current = ''
          cursorRef.current = 0
          historyIndexRef.current = -1
          send(sequence)
          return
        }

        if (sequence === '\x1b[D' || sequence === '\x1b[C' || sequence === '\x1b[H' || sequence === '\x1b[F') {
          const length = lineRef.current.length
          if (sequence === '\x1b[D') cursorRef.current = Math.max(0, cursorRef.current - 1)
          else if (sequence === '\x1b[C') cursorRef.current = Math.min(length, cursorRef.current + 1)
          else if (sequence === '\x1b[H') cursorRef.current = 0
          else cursorRef.current = length
          send(sequence)
          return
        }

        if (sequence.length === 1 && !/[\x00-\x1f\x7f]/.test(sequence)) insertAtCursor(sequence)
        send(sequence)
      }

      const statusText = status === 'live' ? (restored ? '已恢复 · ' + sessionId : '已连接') : status === 'connecting' ? '连接中…'
        : status === 'exited' ? '进程已退出' : '未连接'

      return h('div', {
        style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: '6px' },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', rowGap: '4px', flexWrap: 'wrap', fontSize: '11px', color: T.muted } },
        h('span', null, 'PTY · ' + host + ' · ' + grid.cols + 'x' + grid.rows),
        h('span', { style: { color: status === 'exited' ? T.warn : status === 'live' ? T.success : T.muted } }, statusText),
        h('span', {
          style: {
            marginLeft: 'auto',
            color: T.muted,
            maxWidth: '96px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          },
        }, sessionId || ''),
        h('button', {
          type: 'button',
          className: 'remote-term-clear',
          title: '清空本地回显，并发送 Ctrl-L 让远端重画',
          onClick: clearScreen,
          style: smallButtonStyle(false),
        }, '清屏'),
        h('button', {
          type: 'button',
          className: 'remote-term-copy',
          title: '复制已去除 ANSI 的终端回显',
          onClick: copyOutput,
          disabled: !display,
          style: smallButtonStyle(!display),
        }, copied ? '已复制' : '复制输出'),
        h('button', {
          type: 'button',
          className: 'remote-term-download',
          title: '下载完整会话日志（服务端最多保留 4MB）',
          onClick: downloadLog,
          disabled: !sessionId,
          style: smallButtonStyle(!sessionId),
        }, '下载日志'),
        h('button', {
          type: 'button',
          className: 'remote-term-history',
          title: '本地命令历史（本次面板会话内，最多 20 条）',
          'aria-expanded': historyOpen ? 'true' : 'false',
          onClick: () => setHistoryOpen((previous) => !previous),
          disabled: history.length === 0,
          style: smallButtonStyle(history.length === 0),
        }, '历史'),
        h('button', {
          type: 'button',
          onClick: openSession,
          disabled: status === 'connecting',
          style: { ...smallButtonStyle(status === 'connecting'), color: T.accent },
        }, status === 'exited' ? '重新连接' : '连接'),
        h('button', {
          type: 'button',
          onClick: () => closeSession(false, { forget: true }),
          disabled: !sessionId,
          style: smallButtonStyle(!sessionId),
        }, '断开')),
      historyOpen && history.length > 0
        ? h('div', {
          className: 'remote-term-history-list',
          role: 'list',
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
            maxHeight: '132px',
            overflow: 'auto',
            padding: '4px',
            border: '1px solid ' + T.border,
            borderRadius: '8px',
            background: T.surface,
          },
        }, history.map((entry, index) => h('button', {
          key: entry + '-' + index,
          type: 'button',
          role: 'listitem',
          onClick: () => runHistory(entry),
          style: {
            fontFamily: T.mono,
            fontSize: '11px',
            lineHeight: '16px',
            textAlign: 'left',
            padding: '3px 6px',
            border: 'none',
            borderRadius: '4px',
            background: 'transparent',
            color: T.text,
            cursor: 'pointer',
            whiteSpace: 'pre',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          },
        }, entry)))
        : null,
      lineNotice
        ? h('p', {
          style: { margin: 0, fontSize: '10px', color: T.warn },
        }, '仅显示最近 ' + lineNotice.shown + ' 行（共 ' + lineNotice.total + ' 行），完整日志请下载')
        : null,
      error
        ? h('p', { role: 'alert', style: { margin: 0, fontSize: '11px', color: T.error, wordBreak: 'break-word' } }, error)
        : null,
      h('pre', {
        ref: preRef,
        tabIndex: 0,
        onClick: (event) => event.currentTarget.focus(),
        onKeyDown,
        onPaste,
        spellCheck: false,
        'aria-label': '交互终端',
        style: {
          flex: '1 1 auto',
          minHeight: 0,
          margin: 0,
          overflow: 'auto',
          fontFamily: T.mono,
          fontSize: '12px',
          lineHeight: '17px',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          color: T.text,
          background: T.surface,
          border: '1px solid ' + T.border,
          borderRadius: '8px',
          padding: '8px 10px',
          outline: 'none',
          cursor: 'text',
        },
      },
      display || (status === 'connecting' ? '正在连接…' : status === 'exited' ? '进程已退出' : '点「连接」打开交互终端')))
    }

    /* ------------------------------------------- v2.2 内嵌桌面（noVNC 画布） */

    const DESKTOP_GEOMETRY = '1280x800'
    // 意外断线自动重连的间隔（毫秒）：1s / 2s / 4s，最多 3 次。
    const DESKTOP_RETRY_DELAYS = [1000, 2000, 4000]

    // vendored noVNC bundle 由 Host 用一条 GET 路由吐出，执行后把自己挂到 globalThis.DSHNoVNC。
    // 只 import 一次：失败时清掉缓存，好让「重新连接」还有机会重试。
    let noVncPromise = null
    function loadNoVnc() {
      if (noVncPromise) return noVncPromise
      noVncPromise = import(API.novnc)
        .then((mod) => {
          const RFB = (typeof globalThis !== 'undefined' && globalThis.DSHNoVNC && globalThis.DSHNoVNC.RFB) || (mod && mod.RFB)
          if (typeof RFB !== 'function') throw new Error('noVNC 模块没有导出 RFB')
          return RFB
        })
        .catch((failure) => {
          noVncPromise = null
          throw new Error('加载 noVNC 失败：' + (failure && failure.message ? failure.message : String(failure)))
        })
      return noVncPromise
    }

    /**
     * 桌面模式：hero（读 desktop-status）→ 启动/连接 → RFB 画布 + 工具条 + 剪贴板面板。
     * 画面在浏览器里渲染，VNC 服务只在目标上监听 127.0.0.1，靠 Host 的 SSH 隧道 + WS 桥送达。
     */
    function DesktopPanel({ host }) {
      const [statusInfo, setStatusInfo] = useState(null)
      const [statusError, setStatusError] = useState('')
      const [statusBusy, setStatusBusy] = useState(false)
      const [install, setInstall] = useState(null)
      const [installBusy, setInstallBusy] = useState(false)
      const [installLog, setInstallLog] = useState([])
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [stage, setStage] = useState(false)
      const [connState, setConnState] = useState('idle')
      const [reason, setReason] = useState('')
      const [resolution, setResolution] = useState('')
      const [desktopName, setDesktopName] = useState('')
      const [fit, setFit] = useState(true)
      const [copied, setCopied] = useState('')
      const [remoteClip, setRemoteClip] = useState('')
      const [clipInput, setClipInput] = useState('')
      const [clipMessage, setClipMessage] = useState('')
      const [retrying, setRetrying] = useState(0)
      const [fullscreen, setFullscreen] = useState(false)
      const canvasRef = useRef(null)
      const rfbRef = useRef(null)
      const aliveRef = useRef(true)
      const copyTimer = useRef(null)
      const sizeTimer = useRef(null)
      const manualCloseRef = useRef(false)
      const retryCount = useRef(0)
      const retryTimer = useRef(null)
      const retryScheduler = useRef(null)
      const stageRef = useRef(null)

      const stopSizeTimer = useCallback(() => {
        if (sizeTimer.current) {
          clearInterval(sizeTimer.current)
          sizeTimer.current = null
        }
      }, [])

      // 卸载 / 切主机：断开 RFB、停掉本地计时器，别把会话和定时器留在页面里。
      useEffect(() => {
        aliveRef.current = true
        return () => {
          aliveRef.current = false
          if (copyTimer.current) clearTimeout(copyTimer.current)
          if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null }
          stopSizeTimer()
          const rfb = rfbRef.current
          rfbRef.current = null
          if (rfb) {
            try { rfb.disconnect() } catch { /* 已经断开就算了 */ }
          }
        }
      }, [stopSizeTimer])

      // 全屏可能被 ESC 或浏览器自身退出，所以按钮文案由 fullscreenchange 兜底同步。
      useEffect(() => {
        const sync = () => {
          const el = stageRef.current
          setFullscreen(Boolean(el && document.fullscreenElement && document.fullscreenElement === el))
        }
        document.addEventListener('fullscreenchange', sync)
        return () => document.removeEventListener('fullscreenchange', sync)
      }, [])

      const checkStatus = useCallback(async () => {
        if (!host) return
        setStatusBusy(true)
        setStatusError('')
        try {
          const data = await callApi(API.desktopStatus + '?' + new URLSearchParams({ host }).toString(), { headers: WRITE_HEADERS })
          if (!aliveRef.current) return
          setStatusInfo(data.vnc || null)
        } catch (failure) {
          if (!aliveRef.current) return
          setStatusInfo(null)
          setStatusError(failure.message)
        } finally {
          if (aliveRef.current) setStatusBusy(false)
        }
      }, [host])

      useEffect(() => { checkStatus() }, [checkStatus])

      const readResolution = useCallback(() => {
        const rfb = rfbRef.current
        if (!rfb) return
        const width = rfb._fbWidth || (rfb._display && rfb._display.width) || 0
        const height = rfb._fbHeight || (rfb._display && rfb._display.height) || 0
        if (width > 0 && height > 0) setResolution(width + 'x' + height)
      }, [])

      /** 用 Host 给的 session 参数挂上 RFB；canvas 要等 stage 渲染完才存在。 */
      const attach = useCallback(async (session) => {
        setStage(true)
        setConnState('connecting')
        setReason('')
        setError('')
        // 让 stage 先落进 DOM，canvasRef 才有值。
        await new Promise((resolve) => { setTimeout(resolve, 0) })
        if (!aliveRef.current) return
        const canvas = canvasRef.current
        if (!canvas) {
          setConnState('stopped')
          setError('画布还没准备好，请重新连接')
          return
        }
        try {
          const RFB = await loadNoVnc()
          if (!aliveRef.current) return
          if (rfbRef.current) {
            try { rfbRef.current.disconnect() } catch { /* 旧连接可能已经断了 */ }
            rfbRef.current = null
          }
          const proto = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss' : 'ws'
          const url = proto + '://' + location.host + session.wsPath + '?token=' + encodeURIComponent(session.token)
          try { console.debug('[dsh-remote] RFB open', url) } catch { /* debug */ }
          const rfb = new RFB(canvas, url, { credentials: {} })
          rfb.scaleViewport = fit
          rfb.resizeSession = false
          rfb.clipViewport = false
          rfb.viewOnly = false
          rfbRef.current = rfb
          rfb.addEventListener('connect', () => {
            if (!aliveRef.current) return
            setConnState('connected')
            retryCount.current = 0
            setRetrying(0)
            readResolution()
            stopSizeTimer()
            // FB 尺寸会随远端分辨率变化，1 秒看一眼就够，断开/卸载时清掉。
            sizeTimer.current = setInterval(readResolution, 1000)
          })
          rfb.addEventListener('disconnect', (event) => {
            if (!aliveRef.current) return
            stopSizeTimer()
            const detail = event && event.detail ? event.detail : {}
            if (manualCloseRef.current) {
              setRetrying(0)
              setConnState('stopped')
              setReason('手动断开')
              return
            }
            setConnState('stopped')
            setReason(detail.clean ? '已正常断开' : (detail.reason || '连接中断'))
            // 意外断线（远端重启 / 隧道掉线）自动重连；主动「断开」在上一分支已 return。
            retryCount.current += 1
            if (retryCount.current > DESKTOP_RETRY_DELAYS.length) {
              setRetrying(0)
              setReason('自动重连已停止')
              return
            }
            if (retryScheduler.current) retryScheduler.current(retryCount.current)
          })
          rfb.addEventListener('credentialsrequired', () => {
            try { rfb.sendCredentials({}) } catch { /* 目标没配认证就算了 */ }
          })
          rfb.addEventListener('desktopname', (event) => {
            const name = event && event.detail ? event.detail.name : ''
            if (name) setDesktopName(name)
          })
          rfb.addEventListener('clipboard', (event) => {
            const text = event && event.detail ? event.detail.text : ''
            if (!text) { setRemoteClip(''); return }
            // 不再自动写本机剪贴板（会覆盖用户刚复制的东西），改成面板上一条可点「复制」的提示条。
            setRemoteClip(String(text))
            setClipMessage('')
          })
        } catch (failure) {
          if (!aliveRef.current) return
          setConnState('stopped')
          setReason('')
          setError(failure && failure.message ? failure.message : String(failure))
        }
      }, [fit, readResolution, stopSizeTimer])

      const connectSession = useCallback(async () => {
        // 每次主动连/重连都复位「手动关闭」标记，否则断过一次之后自动重连会被永久禁用。
        manualCloseRef.current = false
        retryCount.current = 0
        try {
          const data = await callApi(API.desktopConnect + '?' + new URLSearchParams({ host }).toString(), { headers: WRITE_HEADERS })
          const session = data.session
          if (!session || !session.wsPath || !session.token) throw new Error('Host 没有返回可用的连接参数')
          await attach(session)
        } catch (failure) {
          if (!aliveRef.current) return
          setStage(false)
          setConnState('idle')
          setError(failure && failure.message ? failure.message : String(failure))
        }
      }, [attach, host])

      // 主按钮：先让目标侧把 VNC 跑起来（必要时），再拿一次性 token 连上。
      const startDesktop = useCallback(async () => {
        if (!host || busy) return
        setBusy(true)
        setError('')
        setInstall(null)
        try {
          try {
            await callApi(API.desktopStart + '?' + new URLSearchParams({ host, geometry: DESKTOP_GEOMETRY }).toString(), { headers: WRITE_HEADERS })
          } catch (failure) {
            const payload = failure && failure.payload ? failure.payload : null
            if (payload && (payload.code === 'VNC_SERVER_MISSING' || payload.install)) {
              setInstall(payload.install || { title: payload.error || '目标上没有 VNC 服务' })
              setError(payload.error || failure.message)
              return
            }
            throw failure
          }
          await connectSession()
          checkStatus()
        } catch (failure) {
          if (aliveRef.current) setError(failure && failure.message ? failure.message : String(failure))
        } finally {
          if (aliveRef.current) setBusy(false)
        }
      }, [busy, checkStatus, connectSession, host])

      /**
       * 目标机缺 VNC 服务时，由插件代它装：Host 侧跑下载 + 静默安装 + 注册服务，装完直接接着起服务、
       * 连画面。用户不用复制任何命令到目标机终端。
       */
      const autoInstall = useCallback(async () => {
        if (!host || busy || installBusy) return
        setInstallBusy(true)
        setInstallLog([])
        setError('')
        try {
          const params = new URLSearchParams({ host, confirm: '1' })
          await callApi(API.desktopInstall + '?' + params.toString(), { headers: WRITE_HEADERS })
          if (!aliveRef.current) return
          setInstall(null)
          checkStatus()
          await startDesktop()
        } catch (failure) {
          if (!aliveRef.current) return
          const payload = failure && failure.payload ? failure.payload : null
          if (payload && Array.isArray(payload.steps) && payload.steps.length > 0) setInstallLog(payload.steps)
          if (payload && payload.install) setInstall(payload.install)
          setError(payload && payload.error ? payload.error : (failure && failure.message ? failure.message : String(failure)))
        } finally {
          if (aliveRef.current) setInstallBusy(false)
        }
      }, [busy, checkStatus, host, installBusy, startDesktop])

      const disconnect = useCallback(() => {
        // 主动断开：置标记，disconnect 事件里就不排自动重连。
        manualCloseRef.current = true
        retryCount.current = 0
        setRetrying(0)
        if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null }
        const rfb = rfbRef.current
        rfbRef.current = null
        stopSizeTimer()
        if (rfb) {
          try { rfb.disconnect() } catch { /* 已经断开 */ }
        }
        setConnState('stopped')
        setReason('手动断开')
      }, [stopSizeTimer])

      const reconnect = useCallback(async () => {
        manualCloseRef.current = false
        retryCount.current = 0
        setRetrying(0)
        if (busy) return
        setBusy(true)
        setError('')
        setReason('')
        await connectSession()
        if (aliveRef.current) setBusy(false)
      }, [busy, connectSession])

      const copyCommand = useCallback(async (command) => {
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(command)
          } else {
            copyTextFallback(command)
          }
          setCopied(command)
          if (copyTimer.current) clearTimeout(copyTimer.current)
          copyTimer.current = setTimeout(() => { if (aliveRef.current) setCopied('') }, 2000)
        } catch {
          setCopied('')
          setError('复制失败：浏览器不允许写剪贴板，请手动选中命令复制')
        }
      }, [])

      // 截图 → 剪贴板：ClipboardItem 在非安全源/旧浏览器会失败，给可读提示而不是抛异常。
      const copyScreen = useCallback(async () => {
        // canvasRef 是 RFB 的容器 div，真正画画面的是 noVNC append 进去的 <canvas>。
        const target = canvasRef.current
        const canvas = target && typeof target.querySelector === 'function' ? target.querySelector('canvas') : null
        if (!canvas || typeof canvas.toBlob !== 'function') {
          setError('画布还没有画面，等画面出来再复制')
          return
        }
        try {
          const blob = await new Promise((resolve) => { canvas.toBlob(resolve, 'image/png') })
          if (!blob) throw new Error('画布还没有画面')
          if (!navigator.clipboard || typeof window.ClipboardItem !== 'function') throw new Error('当前浏览器不支持把图片写进剪贴板')
          await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })])
          setCopied('screen')
          if (copyTimer.current) clearTimeout(copyTimer.current)
          copyTimer.current = setTimeout(() => { if (aliveRef.current) setCopied('') }, 2000)
        } catch (failure) {
          setError('复制全屏失败：' + (failure && failure.message ? failure.message : String(failure)))
        }
      }, [])

      // ---- v2.3：剪贴板互通 / 自动重连 / 全屏 / 粘贴直通 ----
      /** 把远端剪贴板内容复制到本机：copyTextFallback 成功返回 undefined、失败抛异常，必须 try/catch。 */
      const copyRemoteClip = useCallback(async () => {
        if (!remoteClip) return
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(remoteClip)
          } else {
            copyTextFallback(remoteClip)
          }
          setClipMessage('已复制到本机剪贴板')
        } catch {
          setClipMessage('复制失败：浏览器不允许写剪贴板')
        }
      }, [remoteClip])

      /** 本机 → 远端：noVNC 的 clipboardPasteFrom 只在连接存活时有效，先判状态再调。 */
      const sendClipToRemote = useCallback(() => {
        const rfb = rfbRef.current
        if (!rfb || connState !== 'connected' || typeof rfb.clipboardPasteFrom !== 'function') {
          setClipMessage('还没连上远端，暂时发不出去')
          return
        }
        if (!clipInput) return
        try {
          rfb.clipboardPasteFrom(clipInput)
          setClipMessage('已发送到远端剪贴板')
        } catch {
          setClipMessage('发送失败：远端拒绝写入剪贴板')
        }
      }, [clipInput, connState])

      /** 画布上 Ctrl/Cmd+V：读本机剪贴板直送远端；权限被拒只记 debug，不弹错误。 */
      const pasteFromLocal = useCallback(async () => {
        const rfb = rfbRef.current
        if (!rfb || connState !== 'connected' || typeof rfb.clipboardPasteFrom !== 'function') return
        try {
          const text = await navigator.clipboard.readText()
          if (text) rfb.clipboardPasteFrom(text)
        } catch (failure) {
          try { console.debug('[dsh-remote] 读取本机剪贴板被浏览器拒绝', failure) } catch { /* console 不可用 */ }
        }
      }, [connState])

      const toggleFullscreen = useCallback(async () => {
        const el = stageRef.current
        if (!el) return
        try {
          if (document.fullscreenElement === el) {
            await document.exitFullscreen()
          } else if (typeof el.requestFullscreen === 'function') {
            await el.requestFullscreen()
          } else {
            setError('这个浏览器不支持全屏')
          }
        } catch (failure) {
          setError('全屏失败：' + (failure && failure.message ? failure.message : String(failure)))
        }
      }, [])

      // 意外断线自动重连（1s / 2s / 4s）。用普通函数声明 + ref 暴露给 attach，避免 attach 与它互相依赖成环。
      function scheduleRetry(attempt) {
        if (attempt > DESKTOP_RETRY_DELAYS.length) return
        if (retryTimer.current) clearTimeout(retryTimer.current)
        setRetrying(attempt)
        retryTimer.current = setTimeout(async () => {
          retryTimer.current = null
          if (!aliveRef.current || manualCloseRef.current) return
          try {
            const data = await callApi(API.desktopConnect + '?' + new URLSearchParams({ host }).toString(), { headers: WRITE_HEADERS })
            const session = data.session
            if (!session || !session.wsPath || !session.token) throw new Error('Host 没有返回可用的连接参数')
            await attach(session)
          } catch (failure) {
            if (!aliveRef.current || manualCloseRef.current) return
            if (attempt >= DESKTOP_RETRY_DELAYS.length) {
              setRetrying(0)
              setReason('自动重连已停止')
              setError('自动重连失败：' + (failure && failure.message ? failure.message : String(failure)))
              return
            }
            scheduleRetry(attempt + 1)
          }
        }, DESKTOP_RETRY_DELAYS[attempt - 1])
      }
      // 每轮渲染换一次调度器引用，attach 里的监听永远拿到最新的闭包。
      useEffect(() => { retryScheduler.current = scheduleRetry })

      const statusLabel = !statusInfo
        ? (statusError ? '状态未知' : '检测中…')
        : statusInfo.installed === false
          ? '未安装'
          : statusInfo.running
            ? '已运行' + (statusInfo.port ? ' · :' + statusInfo.port : '') + (statusInfo.server ? ' · ' + statusInfo.server : '')
            : '未运行'

      const statusText = retrying > 0
        ? '正在重连（第 ' + retrying + ' 次）…'
        : connState === 'connecting'
        ? '连接中…'
        : connState === 'connected'
          ? '已连接' + (resolution ? ' · ' + resolution : '') + (desktopName ? ' · ' + desktopName : '')
          : connState === 'stopped'
            ? '已断开' + (reason ? ' · ' + reason : '')
            : '未连接'

      const dotTone = retrying > 0 ? T.warn : connState === 'connected' ? T.success : connState === 'connecting' ? T.warn : T.muted

      if (install) {
        return h('div', {
          className: 'remote-desktop',
          style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: '8px' },
        }, h('div', {
          className: 'remote-desktop-install',
          role: 'region',
          'aria-label': 'VNC 服务安装引导',
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            border: '1px solid ' + T.border,
            borderRadius: '8px',
            background: T.surface,
            padding: '12px 14px',
            boxSizing: 'border-box',
          },
        },
        h('div', { style: { fontSize: '13px', color: T.text, fontWeight: 600 } }, install.title || '目标上没有可用的 VNC 服务'),
        install.hint ? h('p', { style: { margin: 0, fontSize: '11px', color: T.muted, lineHeight: '17px' } }, install.hint) : null,
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          h('button', {
            type: 'button',
            className: 'remote-desktop-auto-install',
            onClick: (event) => { event.preventDefault(); autoInstall() },
            disabled: installBusy,
            title: '由插件在目标机上安装并启动 VNC 服务',
            style: { ...buttonStyle(true), height: '28px', padding: '0 12px', opacity: installBusy ? 0.6 : 1 },
          }, installBusy ? '正在安装…' : '自动安装并启动'),
          h('span', { style: { fontSize: '11px', color: T.muted, lineHeight: '17px' } },
            '插件会在目标机上装好服务并直接启动，不用你复制命令。')),
        installLog.length > 0 ? h('pre', {
          className: 'remote-desktop-install-log',
          style: {
            margin: 0,
            maxHeight: '120px',
            overflow: 'auto',
            fontFamily: T.mono,
            fontSize: '11px',
            color: T.muted,
            background: T.surface2,
            border: '1px solid ' + T.border,
            borderRadius: '6px',
            padding: '6px 8px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          },
        }, installLog.join('\n')) : null,
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          (install.commands || []).map((item) => h('div', {
            key: (item.tool || '') + item.command,
            style: { display: 'flex', gap: '4px', alignItems: 'center' },
          },
          h('code', {
            style: {
              flex: '1 1 auto',
              minWidth: 0,
              fontFamily: T.mono,
              fontSize: '11px',
              color: T.text,
              background: T.surface2,
              border: '1px solid ' + T.border,
              borderRadius: '6px',
              padding: '3px 6px',
              overflowX: 'auto',
              whiteSpace: 'nowrap',
            },
          }, item.command),
          h('button', {
            type: 'button',
            className: 'remote-gui-copy',
            title: '复制命令：' + item.command,
            onClick: (event) => { event.preventDefault(); copyCommand(item.command) },
            style: { ...buttonStyle(false), height: '24px', padding: '0 8px', fontSize: '11px', flex: '0 0 auto' },
          }, copied === item.command ? '已复制' : '复制')))),
        h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
          install.url ? h('a', {
            href: install.url,
            target: '_blank',
            rel: 'noreferrer noopener',
            style: { fontSize: '11px', color: T.accent, textDecoration: 'none' },
          }, '打开下载页 ↗') : null,
          h('button', {
            type: 'button',
            className: 'remote-desktop-retry',
            onClick: () => { setInstall(null); setInstallLog([]); setError(''); checkStatus() },
            disabled: statusBusy,
            style: { ...buttonStyle(false), height: '28px', padding: '0 10px', opacity: statusBusy ? 0.55 : 1 },
          }, statusBusy ? '检测中…' : '重新检测')),
        error ? h('p', { role: 'alert', style: { margin: 0, fontSize: '11px', color: T.error, wordBreak: 'break-word' } }, error) : null))
      }

      if (stage) {
        return h('div', {
          className: 'remote-desktop',
          style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: '6px' },
        }, h('div', {
          className: 'remote-desktop-bar',
          style: {
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            flexWrap: 'wrap',
            padding: '4px 6px',
            border: '1px solid ' + T.border,
            borderRadius: 'var(--dsw-radius-sm, 6px)',
            background: T.surface,
          },
        },
        h('span', {
          className: 'remote-desktop-status',
          role: 'status',
          style: { display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: T.muted },
        },
        h('span', { 'aria-hidden': 'true', style: { width: '7px', height: '7px', borderRadius: '50%', background: dotTone } }),
        statusText),
        h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '4px', flexWrap: 'wrap' } },
          h('button', {
            type: 'button',
            className: 'remote-desktop-fit',
            'aria-pressed': fit,
            onClick: () => {
              const next = !fit
              setFit(next)
              if (rfbRef.current) rfbRef.current.scaleViewport = next
            },
            style: { ...smallButtonStyle(fit), height: '24px', padding: '0 8px', fontSize: '11px' },
          }, '缩小适应'),
          h('button', {
            type: 'button',
            className: 'remote-desktop-actual',
            onClick: () => { setFit(false); if (rfbRef.current) rfbRef.current.scaleViewport = false },
            style: { ...smallButtonStyle(false), height: '24px', padding: '0 8px', fontSize: '11px' },
          }, '1:1'),
          h('button', {
            type: 'button',
            onClick: () => { const rfb = rfbRef.current; if (rfb && typeof rfb.sendCtrlAltDel === 'function') rfb.sendCtrlAltDel() },
            style: { ...smallButtonStyle(false), height: '24px', padding: '0 8px', fontSize: '11px' },
          }, '发送 Ctrl-Alt-Del'),
          h('button', {
            type: 'button',
            onClick: copyScreen,
            style: { ...smallButtonStyle(false), height: '24px', padding: '0 8px', fontSize: '11px' },
          }, copied === 'screen' ? '已复制' : '复制全屏'),
          h('button', {
            type: 'button',
            className: 'remote-desktop-fullscreen',
            'aria-label': fullscreen ? '退出全屏' : '全屏显示远端桌面',
            'aria-pressed': fullscreen,
            onClick: toggleFullscreen,
            style: { ...smallButtonStyle(fullscreen), height: '24px', padding: '0 8px', fontSize: '11px' },
          }, fullscreen ? '退出全屏' : '全屏'),
          h('button', {
            type: 'button',
            className: 'remote-desktop-close',
            onClick: disconnect,
            style: { ...smallButtonStyle(false), height: '24px', padding: '0 8px', fontSize: '11px' },
          }, '断开'))),
        h('div', {
          className: 'remote-desktop-stage',
          ref: stageRef,
          style: {
            flex: '1 1 auto',
            minHeight: 0,
            overflow: 'auto',
            border: '1px solid ' + T.border,
            borderRadius: 'var(--dsw-radius-sm, 6px)',
            background: T.surface2,
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
          },
        }, h('div', {
          className: 'remote-desktop-canvas',
          ref: canvasRef,
          tabIndex: 0,
          'aria-label': '远端桌面画面',
          onMouseDown: (event) => { if (event.currentTarget && typeof event.currentTarget.focus === 'function') event.currentTarget.focus() },
          onKeyDown: (event) => {
            const key = typeof event.key === 'string' ? event.key.toLowerCase() : ''
            if ((event.ctrlKey || event.metaKey) && key === 'v') {
              // 浏览器默认会把 Ctrl+V 当作本页粘贴，这里拦下来手动读剪贴板送远端。
              event.preventDefault()
              pasteFromLocal()
            }
          },
          style: { display: 'block', width: '100%', height: '100%', minHeight: '240px', outline: 'none' },
        })),
        remoteClip
          ? h('div', {
            className: 'remote-desktop-clip',
            role: 'group',
            'aria-label': '远端剪贴板',
            style: {
              flex: '0 0 auto',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              minWidth: 0,
              padding: '4px 6px',
              border: '1px solid ' + T.border,
              borderRadius: 'var(--dsw-radius-sm, 6px)',
              background: T.surface,
            },
          },
          h('span', { style: { flex: '0 0 auto', fontSize: '11px', color: T.muted } }, '远端剪贴板'),
          h('code', {
            title: remoteClip,
            style: { flex: '1 1 auto', minWidth: 0, fontFamily: T.mono, fontSize: '11px', color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
          }, remoteClip.length > 200 ? remoteClip.slice(0, 200) + '…' : remoteClip),
          h('button', {
            type: 'button',
            className: 'remote-desktop-clip-copy',
            'aria-label': '复制远端剪贴板内容到本机',
            onClick: copyRemoteClip,
            style: { ...smallButtonStyle(false), height: '22px', padding: '0 8px', fontSize: '11px', flex: '0 0 auto' },
          }, '复制')) : null,
        h('div', {
          className: 'remote-desktop-clip-tools',
          style: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 },
        },
        h('input', {
          type: 'text',
          className: 'remote-desktop-clip-input',
          'aria-label': '要发送到远端剪贴板的文本',
          placeholder: '输入或粘贴文本，一键送进远端剪贴板',
          value: clipInput,
          onChange: (event) => { setClipInput(event.target.value); setClipMessage('') },
          onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); sendClipToRemote() } },
          style: { flex: '1 1 auto', minWidth: 0, font: 'inherit', fontSize: '11px', color: T.text, background: T.surface, border: '1px solid ' + T.border, borderRadius: 'var(--dsw-radius-sm, 6px)', padding: '3px 6px', outline: 'none' },
        }),
        h('button', {
          type: 'button',
          className: 'remote-desktop-clip-send',
          'aria-label': '把文本发送到远端剪贴板',
          onClick: sendClipToRemote,
          disabled: connState !== 'connected' || !clipInput,
          style: { ...smallButtonStyle(false), height: '24px', padding: '0 8px', fontSize: '11px', flex: '0 0 auto', opacity: connState !== 'connected' || !clipInput ? 0.55 : 1 },
        }, '发送到远端'),
        clipMessage
          ? h('span', { role: 'status', style: { flex: '0 0 auto', fontSize: '11px', color: T.muted } }, clipMessage)
          : null),
        connState === 'stopped'
          ? h('div', {
            style: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
          },
          h('span', { style: { fontSize: '11px', color: T.muted } }, reason || '连接已断开'),
          h('button', {
            type: 'button',
            className: 'remote-desktop-reconnect',
            onClick: reconnect,
            disabled: busy,
            style: { ...buttonStyle(true), height: '24px', padding: '0 10px', fontSize: '11px', opacity: busy ? 0.55 : 1 },
          }, busy ? '连接中…' : '重新连接')) : null,
        error ? h('p', { role: 'alert', style: { margin: 0, fontSize: '11px', color: T.error, wordBreak: 'break-word' } }, error) : null)
      }

      return h('div', {
        className: 'remote-desktop',
        style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: '8px' },
      }, h('div', {
        className: 'remote-desktop-hero',
        style: {
          flex: '1 1 auto',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '8px',
          border: '1px dashed ' + T.border,
          borderRadius: '8px',
          padding: '16px',
          boxSizing: 'border-box',
        },
      },
      h('div', { style: { fontSize: '13px', color: T.text } }, 'VNC 服务：' + statusLabel),
      h('p', { style: { margin: 0, fontSize: '11px', color: T.muted, textAlign: 'center', maxWidth: '380px', lineHeight: '17px' } },
        '画面在浏览器里渲染，不需要安装任何客户端；VNC 服务只在目标上监听 127.0.0.1，经 SSH 隧道送达。'),
      h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' } },
        h('button', {
          type: 'button',
          className: 'remote-desktop-start',
          onClick: startDesktop,
          disabled: busy || !host,
          style: { ...buttonStyle(true), height: '32px', padding: '0 16px', opacity: busy || !host ? 0.55 : 1 },
        }, busy ? '启动中…' : '启动远程桌面'),
        h('button', {
          type: 'button',
          onClick: checkStatus,
          disabled: statusBusy,
          style: { ...buttonStyle(false), height: '32px', padding: '0 12px', opacity: statusBusy ? 0.55 : 1 },
        }, statusBusy ? '检查中…' : '检查状态')),
      statusError ? h('p', { style: { margin: 0, fontSize: '11px', color: T.muted, textAlign: 'center' } }, statusError) : null,
      error ? h('p', { role: 'alert', style: { margin: 0, fontSize: '11px', color: T.error, wordBreak: 'break-word', textAlign: 'center' } }, error) : null))

    }

    function RemotePanelIcon({ size }) {
      const edge = typeof size === 'number' && Number.isFinite(size) ? size : 16
      return h('svg', {
        'data-dsh-panel-entry': 'remote',
        viewBox: '0 0 16 16',
        width: edge,
        height: edge,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        style: { display: 'block' },
      },
      h('rect', { x: 1.75, y: 1.75, width: 12.5, height: 5.25, rx: 1.5 }),
      h('rect', { x: 1.75, y: 9, width: 12.5, height: 5.25, rx: 1.5 }),
      h('circle', { cx: 4.5, cy: 4.375, r: 0.9 }),
      h('circle', { cx: 4.5, cy: 11.625, r: 0.9 }),
      h('path', { d: 'M8.4 4.375h3' }),
      h('path', { d: 'M8.4 11.625h3' }))
    }

    // Center-column page for the global panel entry. The shell mounts it only while the panel is
    // selected; the wrapper fills the page height and owns the scroll area.
    function RemotePanelPage() {
      return h('div', {
        'data-dsh-remote-panel': '',
        style: {
          height: '100%',
          minHeight: 0,
          overflow: 'auto',
          background: T.base,
          color: T.text,
        },
      }, h(RemotePage))
    }

    function ExecOutput({ result }) {
      if (!result) {
        return h('div', {
          style: {
            flex: '1 1 auto',
            minHeight: '120px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '12px',
            color: T.muted,
            border: '1px dashed ' + T.border,
            borderRadius: '8px',
          },
        }, '选一台主机、输入命令并执行；输出会显示在这里。')
      }
      const failed = result.exitCode === null || result.exitCode !== 0 || result.timedOut
      return h('div', {
        style: {
          flex: '1 1 auto',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          border: '1px solid ' + T.border,
          borderRadius: '8px',
          background: T.base,
          overflow: 'hidden',
        },
      },
      h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '5px 10px',
          fontSize: '11px',
          borderBottom: '1px solid ' + T.border,
          background: T.surface,
          flex: '0 0 auto',
        },
      },
      h('span', { style: { color: failed ? T.error : T.success, fontFamily: T.mono } },
        'exit ' + (result.exitCode === null ? '—' : result.exitCode)),
      h('span', { style: { color: T.muted } }, (result.durationMs || 0) + ' ms'),
      result.timedOut ? h('span', { style: { color: T.warn } }, '已超时终止') : null,
      result.truncated && (result.truncated.stdout || result.truncated.stderr)
        ? h('span', { style: { color: T.warn } }, '输出已截断')
        : null),
      h('div', {
        style: {
          flex: '1 1 auto',
          minHeight: 0,
          overflow: 'auto',
          padding: '8px 10px',
          fontFamily: T.mono,
          fontSize: '12px',
          lineHeight: '18px',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          color: T.text,
        },
      },
      result.stdout || h('span', { style: { color: T.muted } }, '（stdout 为空）'),
      result.stderr
        ? h('div', { style: { marginTop: '8px', color: T.error } }, result.stderr)
        : null))
    }

    /** 跳到「流水线」面板：点左侧栏那一行（面板由 @local/dsh-cicd 注册）。 */
  function openPipelinePanel() {
    const entry = document.querySelector('[data-dsh-panel-entry="cicd"]')
    const button = entry && entry.closest ? entry.closest('button') : null
    if (button) { button.click(); return true }
    return false
  }

  function RemotePage() {
      const [hosts, setHosts] = useState([])
      const [source, setSource] = useState('none')
      const [configError, setConfigError] = useState(null)
      const [selected, setSelected] = useState(null)
      const [command, setCommand] = useState('')
      const [timeoutSec, setTimeoutSec] = useState(60)
      const [running, setRunning] = useState(false)
      const [result, setResult] = useState(null)
      const [execMode, setExecMode] = useState('command')
      const [desktopMounted, setDesktopMounted] = useState(false)
      const [error, setError] = useState(null)
      const [tunnels, setTunnels] = useState([])
      const [hostForm, setHostForm] = useState(null)
      const [hostFormError, setHostFormError] = useState(null)
      const [hostActionError, setHostActionError] = useState(null)
      const [hostBusy, setHostBusy] = useState(false)
      const [deleteConfirm, setDeleteConfirm] = useState(null)
      const [notice, setNotice] = useState(null)
      const [protocols, setProtocols] = useState([])
      const [terminalTabs, setTerminalTabs] = useState([])
      const [activeTerminal, setActiveTerminal] = useState(null)
      const [guiBusy, setGuiBusy] = useState(false)
      // gui-open 失败且 Host 说明「本机缺客户端」时，路由会带回 install 引导，这里渲染成卡片。
      const [guiInstall, setGuiInstall] = useState(null)
      const [copiedCommand, setCopiedCommand] = useState('')

      useEffect(() => {
        let alive = true
        callApi(API.protocols)
          .then((data) => { if (alive) setProtocols(Array.isArray(data.protocols) ? data.protocols : []) })
          .catch(() => { /* the four built-ins remain available in the form */ })
        return () => { alive = false }
      }, [])

      useEffect(() => {
        let alive = true
        callApi(API.hosts)
          .then((data) => {
            if (!alive) return
            const list = Array.isArray(data.hosts) ? data.hosts : []
            setHosts(list)
            setSource(data.source || 'none')
            setConfigError(data.configError || null)
            setSelected((previous) => previous || (list[0] ? list[0].alias : null))
          })
          .catch((failure) => { if (alive) setConfigError(failure.message) })
        return () => { alive = false }
      }, [])

      const refreshTunnels = useCallback(async () => {
        const data = await callApi(API.tunnels)
        setTunnels(Array.isArray(data.tunnels) ? data.tunnels : [])
      }, [])

      useEffect(() => {
        const load = () => { refreshTunnels().catch(() => { /* errors surface on the next user action */ }) }
        load()
        const timer = setInterval(load, 30000)
        return () => clearInterval(timer)
      }, [refreshTunnels])

      const run = useCallback(async () => {
        if (running) return
        if (!selected) { setError('先选择一台主机'); return }
        if (!command.trim()) { setError('命令不能为空'); return }
        setRunning(true)
        setError(null)
        try {
          const query = new URLSearchParams({
            host: selected,
            command,
            timeoutSec: String(Number(timeoutSec) || 60),
          })
          const data = await callApi(`${API.exec}?${query.toString()}`, { headers: WRITE_HEADERS })
          setResult(data.result || null)
        } catch (failure) {
          setResult(null)
          setError(failure.message)
        } finally {
          setRunning(false)
        }
      }, [command, running, selected, timeoutSec])

      const closeTunnel = useCallback(async (tunnelId) => {
        try {
          const query = new URLSearchParams({ action: 'close', tunnelId })
          await callApi(`${API.tunnels}?${query.toString()}`, { headers: WRITE_HEADERS })
          setTunnels((previous) => previous.filter((item) => item.tunnelId !== tunnelId))
        } catch (failure) {
          setError(failure.message)
        }
      }, [])

      const selectedHost = hosts.find((item) => item.alias === selected) || null
      const capabilities = (selectedHost && selectedHost.capabilities) || { exec: true, sftp: true, tunnel: true, pty: true, gui: false }

      // 换主机就把桌面会话丢掉：DesktopPanel 用 key={selected} 重挂，旧主机的 RFB 不会留在页面里。
      useEffect(() => { setDesktopMounted(false) }, [selected])
      const protocolLabel = selectedHost ? (selectedHost.protocol || 'ssh') : 'ssh'

      const canWrite = source !== 'config'
      const editHint = '主机来自 patch 内联，请先改配置'

      const applyHostData = useCallback((data) => {
        const list = Array.isArray(data.hosts) ? data.hosts : []
        setHosts(list)
        setSource(data.source || 'none')
        setConfigError(null)
        setNotice(data.warning || null)
        setHostActionError(null)
        setDeleteConfirm(null)
        setSelected((previous) => (list.some((item) => item.alias === previous) ? previous : (list[0] ? list[0].alias : null)))
      }, [])

      useEffect(() => {
        if (!deleteConfirm) return undefined
        const timer = setTimeout(() => setDeleteConfirm(null), 3000)
        return () => clearTimeout(timer)
      }, [deleteConfirm])

      const openCreate = () => {
        if (!canWrite) return
        setHostActionError(null)
        setHostFormError(null)
        setHostForm({
          mode: 'create', alias: '', host: '', port: '22', user: 'root', auth: 'none', protocol: 'ssh',
          secret: '', privateKeyPath: '', note: '', disabled: false, currentPasswordEnv: null, jump: '',
          env: '', group: '', tags: '',
        })
      }

      const openEdit = (host) => {
        if (!canWrite) return
        const auth = host.hasPassword ? 'password' : host.passwordEnv ? 'password-env' : host.privateKeyPath ? 'key' : 'none'
        setHostActionError(null)
        setHostFormError(null)
        setHostForm({
          mode: 'edit',
          alias: host.alias,
          host: host.host,
          port: String(host.port || 22),
          user: host.user || 'root',
          protocol: host.protocol || 'ssh',
          auth,
          secret: '',
          privateKeyPath: host.privateKeyPath || '',
          note: host.note || '',
          disabled: Boolean(host.disabled),
          currentPasswordEnv: host.passwordEnv || null,
          jump: Array.isArray(host.jump) ? host.jump.join(',') : '',
          env: host.env || '',
          group: host.group || '',
          tags: Array.isArray(host.tags) ? host.tags.join(',') : '',
        })
      }

      const changeHostForm = (field, value) => {
        setHostForm((previous) => (previous ? { ...previous, [field]: value } : previous))
      }

      const submitHost = async (event) => {
        event.preventDefault()
        if (!hostForm || hostBusy) return
        const alias = hostForm.alias.trim()
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(alias)) {
          setHostFormError('别名只能包含字母、数字、点、下划线和连字符，且 1–64 位')
          return
        }
        const host = hostForm.host.trim()
        if (!host) { setHostFormError('主机不能为空'); return }
        const port = Number(hostForm.port || '22')
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          setHostFormError('端口必须是 1-65535 的整数')
          return
        }
        const protocol = hostForm.protocol || 'ssh'
        const auth = protocol === 'ssh' ? hostForm.auth : 'none'
        const secret = hostForm.secret
        if (auth === 'password' && hostForm.mode === 'create' && !secret) {
          setHostFormError('新建密码主机时密码不能为空')
          return
        }
        if (auth === 'password-env' && !secret && !(hostForm.mode === 'edit' && hostForm.currentPasswordEnv)) {
          setHostFormError('认证方式为密码环境变量时，环境变量名不能为空')
          return
        }
        const keyPath = hostForm.privateKeyPath.trim()
        if (auth === 'key' && !keyPath) { setHostFormError('认证方式为私钥时，私钥路径不能为空'); return }

        setHostBusy(true)
        setHostFormError(null)
        setHostActionError(null)
        try {
          const query = new URLSearchParams({ alias, host, port: String(port), auth, protocol })
          if (hostForm.user.trim()) query.set('user', hostForm.user.trim())
          query.set('env', hostForm.env.trim())
          query.set('group', hostForm.group.trim())
          query.set('tags', hostForm.tags.split(',').map((tag) => tag.trim()).filter(Boolean).join(','))
          if (protocol === 'ssh' && (auth === 'password' || auth === 'password-env')) {
            const value = secret || (auth === 'password-env' ? hostForm.currentPasswordEnv : '')
            if (value) query.set('secret', value)
          }
          if (protocol === 'ssh' && auth === 'key') query.set('privateKeyPath', keyPath)
          if (protocol === 'ssh') query.set('jump', String(hostForm.jump || '').trim())
          query.set('note', hostForm.note.trim())
          query.set('disabled', hostForm.disabled ? '1' : '0')
          const data = await callApi(`${API.hostSave}?${query.toString()}`, { headers: WRITE_HEADERS })
          applyHostData(data)
          // 保存成功即选中该主机：新建后立刻能跑命令，闭环不断。
          setSelected(alias)
          setHostForm(null)
        } catch (failure) {
          setHostFormError(failure.message)
        } finally {
          setHostBusy(false)
        }
      }

      const requestDelete = async (alias) => {
        if (!canWrite) return
        if (deleteConfirm !== alias) {
          setDeleteConfirm(alias)
          return
        }
        setDeleteConfirm(null)
        setHostBusy(true)
        setHostActionError(null)
        setNotice(null)
        try {
          const data = await callApi(`${API.hostDelete}?alias=${encodeURIComponent(alias)}`, { headers: WRITE_HEADERS })
          applyHostData(data)
          setHostForm((previous) => (previous && previous.alias === alias ? null : previous))
        } catch (failure) {
          setHostActionError(failure.message)
        } finally {
          setHostBusy(false)
        }
      }

      const openTerminalTab = () => {
        if (!selected) { setError('先选择一台主机'); return }
        if (!capabilities.pty) { setError('协议 ' + protocolLabel + ' 不支持交互终端'); return }
        const id = 'tab-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
        setTerminalTabs((previous) => [...previous, { id, host: selected, protocol: protocolLabel }])
        setActiveTerminal(id)
        setExecMode('terminal')
      }

      const closeTerminalTab = (id) => {
        setTerminalTabs((previous) => previous.filter((tab) => tab.id !== id))
        setActiveTerminal((previous) => (previous === id ? null : previous))
      }

      const closeAllTerminals = () => {
        setTerminalTabs([])
        setActiveTerminal(null)
      }

      const launchGui = async () => {
        if (!selectedHost || guiBusy) return
        setGuiBusy(true)
        setError(null)
        setNotice(null)
        setGuiInstall(null)
        setCopiedCommand('')
        try {
          const protocol = selectedHost.protocol === 'rdp' || selectedHost.protocol === 'vnc' ? selectedHost.protocol : 'rdp'
          const data = await callApi(API.guiOpen + '?' + new URLSearchParams({ host: selected, protocol }).toString(), { headers: WRITE_HEADERS })
          setNotice('已启动本机 ' + (data.executable || protocol).toUpperCase() + ' 客户端：' + data.target)
        } catch (failure) {
          setError(failure.message)
          setGuiInstall(failure.payload?.install ?? null)
        } finally {
          setGuiBusy(false)
        }
      }

      // 安装引导里的命令复制：与「复制路径」同一套降级（clipboard → textarea + execCommand）。
      const copyInstallCommand = async (command) => {
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(command)
            setCopiedCommand(command)
            return
          }
        } catch {
          /* 掉到下面的兜底 */
        }
        try {
          copyTextFallback(command)
          setCopiedCommand(command)
          return
        } catch {
          setError('复制失败：浏览器不允许写剪贴板，请手动选中命令复制')
        }
      }

      const onCommandKeyDown = (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault()
          run()
        }
      }

      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'row',
          gap: '6px',
          height: '100%',
          minHeight: 0,
          padding: '16px',
          boxSizing: 'border-box',
          color: T.text,
          background: 'transparent',
        },
      },
      h(HostList, {
        hosts, selected, onSelect: setSelected, configError, source, notice,
        canWrite, editHint,
        deleteConfirm, actionError: hostActionError,
        onNew: openCreate, onEdit: openEdit, onDelete: requestDelete,
      }),
      hostForm
        ? h(HostFormModal, {
          form: hostForm, error: hostFormError, busy: hostBusy, protocols,
          onChange: changeHostForm, onSubmit: submitHost, onCancel: () => setHostForm(null),
        })
        : null,
      h('section', {
        style: { flex: '1 1 auto', minWidth: '360px', display: 'flex', flexDirection: 'column', gap: '8px', padding: '0 6px' },
      },
      h('header', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
        h('h2', { style: { margin: 0, fontSize: '14px', fontWeight: 600 } }, '远程主机'),
        h('span', { style: { fontSize: '11px', color: T.muted } }, selected ? selected : '未选择主机'),
        h('button', {
          type: 'button',
          className: 'remote-open-pipeline',
          title: '打开「流水线」面板（本地构建 → 远程部署 → 回滚）',
          onClick: () => {
            if (!openPipelinePanel()) setError('没有找到「流水线」面板：@local/dsh-cicd 还没加载，重启一次 DSH 后左侧栏会出现「流水线」。')
          },
          style: { ...buttonStyle(false), height: '24px', fontSize: '11px', padding: '0 10px' },
        }, '流水线'),
        capabilities.exec || capabilities.pty
          ? h('div', {
            role: 'group',
            'aria-label': '执行方式',
            style: { marginLeft: 'auto', display: 'flex', gap: '2px' },
          },
          capabilities.exec ? h('button', {
            type: 'button',
            'aria-pressed': execMode === 'command',
            onClick: () => setExecMode('command'),
            style: {
              ...buttonStyle(execMode === 'command'),
              height: '28px',
              fontSize: '11px',
              padding: '0 10px',
              background: execMode === 'command' ? T.surface2 : 'transparent',
            },
          }, '命令') : null,
          capabilities.pty ? h('button', {
            type: 'button',
            'aria-pressed': execMode === 'terminal',
            onClick: () => { setExecMode('terminal'); if (terminalTabs.length === 0) openTerminalTab() },
            style: {
              ...buttonStyle(execMode === 'terminal'),
              height: '28px',
              fontSize: '11px',
              padding: '0 10px',
              background: execMode === 'terminal' ? T.surface2 : 'transparent',
            },
          }, '终端') : null,
          h('button', {
            type: 'button',
            className: 'remote-mode-desktop',
            'aria-pressed': execMode === 'desktop',
          onClick: () => { setDesktopMounted(true); setExecMode('desktop') },
            style: {
              ...buttonStyle(execMode === 'desktop'),
              height: '28px',
              fontSize: '11px',
              padding: '0 10px',
              background: execMode === 'desktop' ? T.surface2 : 'transparent',
            },
          }, '桌面'))
          : h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } },
            capabilities.gui ? h('button', {
              type: 'button',
              className: 'remote-gui-open',
              onClick: launchGui,
              disabled: !selected || guiBusy,
              style: { ...buttonStyle(true), height: '28px', padding: '0 12px', opacity: !selected || guiBusy ? 0.55 : 1 },
            }, guiBusy ? '启动中…' : '打开桌面') : null),
        capabilities.gui ? h('span', { style: { fontSize: '10px', color: T.muted } }, '协议 ' + protocolLabel + ' · 使用本机客户端') : null),
        capabilities.exec ? h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: T.muted } },
            '超时',
            h('input', {
              type: 'number',
              min: 1,
              max: 600,
              value: timeoutSec,
              onChange: (event) => setTimeoutSec(event.target.value),
              style: {
                width: '58px',
                font: 'inherit',
                fontSize: '11px',
                color: T.text,
                background: T.surface,
                border: '1px solid ' + T.border,
                borderRadius: '6px',
                padding: '2px 6px',
              },
            }),
            '秒'),
          h('button', {
            type: 'button',
            onClick: run,
            disabled: running || !selected,
            style: { ...buttonStyle(true), height: '28px', padding: '0 12px', opacity: running || !selected ? 0.55 : 1 },
          }, running ? '执行中…' : '执行')) : null,
      // 桌面模式在这条链里让位给下面常挂的 DesktopPanel（见其注释）。
      execMode === 'desktop' && (capabilities.exec || capabilities.pty)
        ? null
        : capabilities.gui
        ? h('div', {
          style: {
            flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: '8px',
            border: '1px dashed ' + T.border, borderRadius: '8px', padding: '16px',
          },
        },
        h('div', { style: { fontSize: '13px', color: T.text } }, protocolLabel.toUpperCase() + ' 桌面会话'),
        h('p', { style: { margin: 0, fontSize: '11px', color: T.muted, textAlign: 'center', maxWidth: '360px', lineHeight: '17px' } },
          '面板不会内嵌桌面画面。点「打开桌面」由 Host 启动本机的 ' + (protocolLabel === 'vnc' ? 'VNC' : 'RDP') + ' 客户端；未安装时会在上方给出安装/替代方案。'),
        h('button', {
          type: 'button',
          onClick: launchGui,
          disabled: guiBusy,
          className: 'remote-gui-open',
          style: { ...buttonStyle(true), height: '32px', padding: '0 16px', opacity: guiBusy ? 0.55 : 1 },
        }, guiBusy ? '启动中…' : '打开桌面'),
        error ? h('p', { role: 'alert', style: { margin: 0, fontSize: '11px', color: T.error, wordBreak: 'break-word' } }, error) : null,
        notice ? h('p', { role: 'status', style: { margin: 0, fontSize: '11px', color: T.success, wordBreak: 'break-word' } }, notice) : null,
        guiInstall ? h('div', {
          className: 'remote-gui-install',
          role: 'region',
          'aria-label': '安装引导',
          style: {
            width: '100%',
            maxWidth: '380px',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            alignItems: 'center',
            border: '1px solid ' + T.border,
            borderRadius: '8px',
            background: T.surface,
            padding: '10px 12px',
            boxSizing: 'border-box',
          },
        },
        h('div', { style: { fontSize: '12px', color: T.text, fontWeight: 600 } }, guiInstall.title || '需要安装客户端'),
        guiInstall.hint ? h('p', { style: { margin: 0, fontSize: '11px', color: T.muted, lineHeight: '17px', textAlign: 'center' } }, guiInstall.hint) : null,
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', width: '100%' } },
          (guiInstall.commands || []).map((item) => h('div', {
            key: item.command,
            style: { display: 'flex', gap: '4px', alignItems: 'center' },
          },
          h('code', {
            style: {
              flex: '1 1 auto',
              minWidth: 0,
              fontFamily: T.mono,
              fontSize: '11px',
              color: T.text,
              background: T.surface2,
              border: '1px solid ' + T.border,
              borderRadius: '6px',
              padding: '3px 6px',
              overflowX: 'auto',
              whiteSpace: 'nowrap',
            },
          }, item.command),
          h('button', {
            type: 'button',
            className: 'remote-gui-copy',
            title: '复制命令：' + item.command,
            onClick: (event) => { event.preventDefault(); copyInstallCommand(item.command) },
            style: { ...buttonStyle(false), height: '24px', padding: '0 8px', fontSize: '11px', flex: '0 0 auto' },
          }, copiedCommand === item.command ? '已复制' : '复制')))),
        h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap' } },
          guiInstall.url ? h('a', {
            href: guiInstall.url,
            target: '_blank',
            rel: 'noreferrer noopener',
            style: { fontSize: '11px', color: T.accent, textDecoration: 'none' },
          }, '打开下载页 ↗') : null,
          h('button', {
            type: 'button',
            className: 'remote-gui-retry',
            onClick: launchGui,
            disabled: guiBusy,
            style: { ...buttonStyle(false), height: '28px', padding: '0 10px', opacity: guiBusy ? 0.55 : 1 },
          }, guiBusy ? '检测中…' : '重新检测'))) : null)
        : capabilities.pty && execMode === 'terminal'
          ? h('div', { style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: '6px' } },
            h('div', {
              role: 'tablist',
              'aria-label': '终端标签',
              style: { flex: '0 0 auto', display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center' },
            },
            terminalTabs.map((tab) => h('div', {
              key: tab.id,
              style: { display: 'flex', alignItems: 'center', borderRadius: 'var(--dsw-radius-sm, 6px)', border: '1px solid ' + (activeTerminal === tab.id ? T.accent : T.border), overflow: 'hidden' },
            },
            h('button', {
              type: 'button',
              role: 'tab',
              'aria-selected': activeTerminal === tab.id,
              onClick: () => setActiveTerminal(tab.id),
              style: {
                appearance: 'none', font: 'inherit', fontSize: '11px', height: '28px', padding: '0 8px',
                border: 'none', cursor: 'pointer',
                color: activeTerminal === tab.id ? T.text : T.muted,
                background: activeTerminal === tab.id ? T.surface2 : 'transparent',
              },
            }, tab.host + ' · ' + tab.protocol),
            h('button', {
              type: 'button',
              title: '关闭标签',
              onClick: () => closeTerminalTab(tab.id),
              style: { appearance: 'none', font: 'inherit', fontSize: '11px', height: '28px', padding: '0 6px', border: 'none', borderLeft: '1px solid ' + T.border, cursor: 'pointer', color: T.muted, background: 'transparent' },
            }, '×'))),
            h('button', {
              type: 'button',
              onClick: openTerminalTab,
              disabled: !selected,
              style: { ...smallButtonStyle(!selected), height: '28px', padding: '0 10px' },
            }, '＋ 终端'),
            terminalTabs.length > 0 ? h('button', {
              type: 'button',
              onClick: closeAllTerminals,
              style: { ...smallButtonStyle(false), height: '28px', padding: '0 10px' },
            }, '全部关闭') : null),
            terminalTabs.length === 0
              ? h('p', { style: { margin: 0, padding: '10px', fontSize: '11px', color: T.muted, border: '1px dashed ' + T.border, borderRadius: '8px' } },
                '点「＋ 终端」为当前主机打开一个交互终端；切到「命令」仍可一次性执行。')
              : h('div', { style: { flex: '1 1 auto', minHeight: 0, position: 'relative' } },
                terminalTabs.map((tab) => h('div', {
                  key: tab.id,
                  style: {
                    display: activeTerminal === tab.id ? 'flex' : 'none',
                    flexDirection: 'column',
                    height: '100%',
                    minHeight: 0,
                  },
                }, h(TerminalPanel, { host: tab.host })))))
          : h('div', {
            style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: '8px' },
          },
          h('textarea', {
            value: command,
            onChange: (event) => setCommand(event.target.value),
            onKeyDown: onCommandKeyDown,
            placeholder: '输入命令，Ctrl+Enter 执行',
            spellCheck: false,
            rows: 3,
            style: {
              width: '100%',
              boxSizing: 'border-box',
              resize: 'vertical',
              fontFamily: T.mono,
              fontSize: '12px',
              lineHeight: '18px',
              color: T.text,
              background: T.surface,
              border: '1px solid ' + T.border,
              borderRadius: '8px',
              padding: '8px 10px',
              outline: 'none',
            },
          }),
          error
            ? h('p', { role: 'alert', style: { margin: 0, fontSize: '11px', color: T.error, wordBreak: 'break-word' } }, error)
            : null,
          h(ExecOutput, { result })),
      // 桌面面板第一次进入后就不再卸载，切到命令/终端只 display:none 隐藏：卸载会触发 RFB.disconnect，
      // 重新挂载还要再握手一次并重拉整屏画面。用「挂住 + 隐藏」换会话连续，代价只是一个隐藏的节点。
      h('div', {
        style: {
          flex: '1 1 auto',
          minHeight: 0,
          display: execMode === 'desktop' ? 'flex' : 'none',
          flexDirection: 'column',
        },
      }, desktopMounted && (capabilities.exec || capabilities.pty)
        ? h(DesktopPanel, { key: selected || 'none', host: selected })
        : null)),
      h('div', {
        style: {
          flex: '0 0 320px',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          paddingLeft: '12px',
          borderLeft: '1px solid ' + T.border,
          boxSizing: 'border-box',
        },
      },
      capabilities.tunnel ? h(TunnelPanel, { tunnels, onClose: closeTunnel, host: selected, onCreated: refreshTunnels }) : null,
      capabilities.sftp ? h(FilesPanel, { host: selected }) : null,
      !capabilities.tunnel && !capabilities.sftp
        ? h('p', { style: { margin: 0, fontSize: '11px', color: T.muted, lineHeight: '17px' } },
          '协议 ' + protocolLabel + ' 没有文件与隧道能力。' + (capabilities.pty ? '切到「终端」使用交互会话。' : ''))
        : null))
    }

    return {
      inject: ['slots'],
      // Pure helpers exposed for the package smoke test; the host ignores unknown module fields.
      internals: { computeTerminalGrid, pushCommandHistory, resolveHistoryStep, formatLogStamp },
      apply(ctx) {
        // 不再注册 conversation.view（v2 起，与 aihot / SPEC.md §4 一致）：会话内 View 与宿主 composer
        // 同属 conversation.content，页面下面永远跟着输入框；整页应用必须走 keyed 'main' 槽。
        // 副作用也一起消失：shell 会把「当前 View」按会话持久化，曾点进来的会话会一直回到这一页。

        // Global panel row in the left sidebar; the shell owns the row chrome and switching.
        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'remote',
          order: 60,
          label: () => '远程主机',
        }, RemotePanelIcon)))

        // Center-column page keyed by the same id the sidebar row activates.
        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'remote',
        }, RemotePanelPage)))
      },
    }
  },
})