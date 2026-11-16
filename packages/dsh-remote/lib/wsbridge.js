// A minimal RFC 6455 server side: exactly what the VNC bridge needs, nothing more.
//
// The DSH web carrier only answers GET/HEAD at the HTTP layer, but the host webserver exposes
// `registerUpgrade` for protocol negotiation on a raw socket (see
// dsh/node_modules/@deepseek-ai/dsh-host-webserver/src/index.ts). That is how a browser
// WebSocket reaches plugin code without opening a second port, so this module performs the
// handshake and the framing itself instead of pulling in a `ws` dependency.

import { createHash } from 'node:crypto'

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024

export const OPCODE = Object.freeze({ CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa })

/** RFC 6455 §4.2.2 accept value for a client key. */
export function acceptKey(key) {
  return createHash('sha1').update(String(key) + WEBSOCKET_GUID).digest('base64')
}

/** Refuse an upgrade with a plain HTTP response and drop the socket. */
export function refuseUpgrade(socket, status, message, headers = {}) {
  const reason = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Bad Request'
  const body = Buffer.from(String(message), 'utf8')
  const lines = [
    `HTTP/1.1 ${status} ${reason}`,
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${body.length}`,
    'Connection: close',
  ]
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`)
  try { socket.write(Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1'), body])) } catch { /* peer gone */ }
  try { socket.destroy() } catch { /* peer gone */ }
}

/**
 * Complete the opening handshake. Returns the accept header value on success, or null after
 * writing an error response (the caller then must not touch the socket).
 */
export function performHandshake(request, socket, head = Buffer.alloc(0)) {
  const upgrade = String(request?.headers?.upgrade || '').toLowerCase()
  const connection = String(request?.headers?.connection || '').toLowerCase()
  const key = request?.headers?.['sec-websocket-key']
  const version = String(request?.headers?.['sec-websocket-version'] || '')
  if (upgrade !== 'websocket' || !connection.split(',').map((part) => part.trim()).includes('upgrade')) {
    refuseUpgrade(socket, 400, '需要 WebSocket 升级请求')
    return null
  }
  if (!key) {
    refuseUpgrade(socket, 400, '缺少 Sec-WebSocket-Key')
    return null
  }
  if (version && version !== '13') {
    refuseUpgrade(socket, 400, '只支持 WebSocket 版本 13', { 'Sec-WebSocket-Version': '13' })
    return null
  }
  const accept = acceptKey(key)
  try {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
  } catch {
    return null
  }
  if (head?.length) socket.unshift(head)
  return accept
}

/** Encode one server-to-client frame. Servers never mask (RFC 6455 §5.1). */
export function encodeFrame(payload, opcode = OPCODE.BINARY) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '')
  const length = data.length
  let header
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length])
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, data])
}

/**
 * A byte-stream ↔ WebSocket pump. Messages arriving as binary (or text, which noVNC never
 * sends) are unmasked and handed to `write`; data pushed through `send` becomes one binary
 * frame each. Fragmentation is supported; control frames are answered immediately.
 */
export class WebSocketPeer {
  constructor(socket, { write, onClose, onError, maxMessageBytes = MAX_MESSAGE_BYTES } = {}) {
    this.socket = socket
    this.write = typeof write === 'function' ? write : () => {}
    this.onClose = typeof onClose === 'function' ? onClose : () => {}
    this.onError = typeof onError === 'function' ? onError : () => {}
    this.maxMessageBytes = maxMessageBytes
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    this.fragmentBytes = 0
    this.closed = false
    this.closeSent = false
    socket.on('data', (chunk) => this.ingest(chunk))
    socket.on('close', () => this.finish('socket-close'))
    socket.on('error', (error) => { this.onError?.(error); this.finish('socket-error') })
  }

  ingest(chunk) {
    if (this.closed) return
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    while (this.buffer.length >= 2) {
      const first = this.buffer[0]
      const second = this.buffer[1]
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        const big = this.buffer.readBigUInt64BE(2)
        if (big > BigInt(this.maxMessageBytes)) { this.fail(1009, 'message too large'); return }
        length = Number(big)
        offset = 10
      }
      if (length > this.maxMessageBytes) { this.fail(1009, 'message too large'); return }
      const maskLength = masked ? 4 : 0
      if (this.buffer.length < offset + maskLength + length) return
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null
      let payload = this.buffer.subarray(offset + maskLength, offset + maskLength + length)
      if (mask) {
        const unmasked = Buffer.alloc(length)
        for (let index = 0; index < length; index += 1) unmasked[index] = payload[index] ^ mask[index & 3]
        payload = unmasked
      } else {
        payload = Buffer.from(payload)
      }
      this.buffer = this.buffer.subarray(offset + maskLength + length)
      this.handleFrame(fin, opcode, payload)
    }
  }

  handleFrame(fin, opcode, payload) {
    if (opcode === OPCODE.CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
      if (!this.closeSent) this.writeFrame(Buffer.from([code >> 8, code & 0xff]), OPCODE.CLOSE)
      this.closeSent = true
      this.finish('client-close')
      try { this.socket.end() } catch { /* already gone */ }
      return
    }
    if (opcode === OPCODE.PING) {
      this.writeFrame(payload, OPCODE.PONG)
      return
    }
    if (opcode === OPCODE.PONG) return
    if (opcode === OPCODE.CONTINUATION) {
      this.fragments.push(payload)
      this.fragmentBytes += payload.length
    } else {
      this.fragments = [payload]
      this.fragmentBytes = payload.length
    }
    if (this.fragmentBytes > this.maxMessageBytes) { this.fail(1009, 'message too large'); return }
    if (!fin) return
    const message = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments)
    this.fragments = []
    this.fragmentBytes = 0
    if (message.length) this.write(message)
  }

  writeFrame(payload, opcode = OPCODE.BINARY) {
    if (this.closed || this.socket.destroyed) return false
    try {
      this.socket.write(encodeFrame(payload, opcode))
      return true
    } catch {
      this.finish('write-failed')
      return false
    }
  }

  /** Push stream bytes to the browser as one binary frame. */
  send(data) {
    return this.writeFrame(data, OPCODE.BINARY)
  }

  ping() {
    return this.writeFrame(Buffer.alloc(0), OPCODE.PING)
  }

  fail(code, reason) {
    if (this.closed) return
    this.closeSent = true
    const text = Buffer.from(String(reason || ''), 'utf8')
    const payload = Buffer.alloc(2 + text.length)
    payload.writeUInt16BE(code, 0)
    text.copy(payload, 2)
    this.writeFrame(payload, OPCODE.CLOSE)
    this.finish(reason || 'protocol-error')
    try { this.socket.end() } catch { /* already gone */ }
  }

  /** Idempotent teardown: closes the socket and reports the reason once. */
  finish(reason = 'closed') {
    if (this.closed) return
    this.closed = true
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    try { this.socket.end() } catch { /* already gone */ }
    try { this.onClose?.(reason) } catch { /* observer threw */ }
  }
}