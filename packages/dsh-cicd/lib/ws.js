/**
 * V2-M1：最小 RFC 6455 服务端（只够实时日志流用，无依赖）。
 *
 * 与 dsh-remote/lib/wsbridge.js 同一套路的精简版：DSH web carrier 只答 GET/HEAD，
 * 但 host webserver 暴露 `registerUpgrade` 在裸 socket 上做协议升级，浏览器
 * WebSocket 就这样到达插件代码，不用开第二个端口。这里只发 TEXT 帧（JSON 行），
 * 收到的客户端消息全部忽略（日志流是单向的），控制帧按协议应答。
 */

import { createHash } from 'node:crypto'

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export const OPCODE = Object.freeze({ TEXT: 0x1, CLOSE: 0x8, PING: 0x9, PONG: 0xa })

/** RFC 6455 §4.2.2 accept 值。 */
export function acceptKey(key) {
  return createHash('sha1').update(String(key) + WEBSOCKET_GUID).digest('base64')
}

/** 用普通 HTTP 响应拒绝升级并断开 socket。 */
export function refuseUpgrade(socket, status, message) {
  const reason = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Bad Request'
  const body = Buffer.from(String(message), 'utf8')
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`)
    socket.write(body)
  } catch { /* peer gone */ }
  try { socket.destroy() } catch { /* peer gone */ }
}

/**
 * 完成握手。成功返回 accept 值；失败已写错误响应并返回 null（调用方不得再碰 socket）。
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
    refuseUpgrade(socket, 400, '只支持 WebSocket 版本 13')
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
  } catch { return null }
  if (head?.length) socket.unshift(head)
  return accept
}

/** 服务端→客户端单帧编码（服务端不掩码，RFC 6455 §5.1）。 */
export function encodeFrame(payload, opcode = OPCODE.TEXT) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8')
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
 * 单向日志流连接：握手后只处理控制帧（close/ping），文本帧一律丢弃。
 * `onClose(reason)` 在连接结束（任一方向）时回调一次。
 */
export class LogSocket {
  constructor(socket) {
    this.socket = socket
    this.closed = false
    this.closeSent = false
    this.buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => this.ingest(chunk))
    socket.on('close', () => this.finish('socket-close'))
    socket.on('error', () => this.finish('socket-error'))
  }

  ingest(chunk) {
    if (this.closed) return
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    while (this.buffer.length >= 2) {
      const first = this.buffer[0]
      const second = this.buffer[1]
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
        length = Number(this.buffer.readBigUInt64BE(2))
        offset = 10
      }
      const maskLength = masked ? 4 : 0
      if (this.buffer.length < offset + maskLength + length) return
      const payload = this.buffer.subarray(offset + maskLength, offset + maskLength + length)
      this.buffer = this.buffer.subarray(offset + maskLength + length)
      if (opcode === OPCODE.CLOSE) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
        if (!this.closeSent) {
          this.closeSent = true
          try { this.socket.write(encodeFrame(Buffer.from([code >> 8, code & 0xff]), OPCODE.CLOSE)) } catch { /* gone */ }
        }
        this.finish('client-close')
        try { this.socket.end() } catch { /* gone */ }
        return
      }
      if (opcode === OPCODE.PING) {
        try { this.socket.write(encodeFrame(payload, OPCODE.PONG)) } catch { /* gone */ }
      }
      // TEXT/BINARY：日志流是单向的，客户端消息全部忽略。
    }
  }

  /** 发一条 JSON 文本帧。 */
  sendJson(value) {
    if (this.closed || this.socket.destroyed) return false
    try {
      this.socket.write(encodeFrame(JSON.stringify(value), OPCODE.TEXT))
      return true
    } catch {
      this.finish('write-failed')
      return false
    }
  }

  finish(reason = 'closed') {
    if (this.closed) return
    this.closed = true
    this.buffer = Buffer.alloc(0)
    try { this.socket.end() } catch { /* gone */ }
    try { this.onClose?.(reason) } catch { /* observer threw */ }
  }
}
