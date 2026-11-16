// Output budget helpers: every remote payload is clipped here, never by the harness.
// Pure functions only (Buffer is a Node builtin), so test/smoke.mjs can import them directly.

/** Default output budgets, in UTF-8 bytes. */
export const LIMITS = Object.freeze({
  stdoutBytes: 64 * 1024,
  stderrBytes: 16 * 1024,
  shellReadBytes: 32 * 1024,
  sftpReadBytes: 64 * 1024,
  shellBufferBytes: 256 * 1024,
  shellLogBytes: 4 * 1024 * 1024,
  shellBacklogBytes: 512 * 1024,
  shellLogMaxRequestBytes: 8 * 1024 * 1024,
  uploadChunkBytes: 8 * 1024,
  uploadMaxBytes: 64 * 1024 * 1024,
  uploadMaxSessions: 4,
  uploadIdleMs: 10 * 60 * 1000,
  uploadWriteTimeoutMs: 30 * 1000,
  fileDownloadBytes: 8 * 1024 * 1024,
  fileDownloadMaxBytes: 16 * 1024 * 1024,
  listingEntries: 500,
})

/** UTF-8 byte length of a string value. */
export function utf8Bytes(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : String(value ?? ''), 'utf8')
}

/**
 * Clip a string to at most `maxBytes` UTF-8 bytes without splitting a character.
 * @returns {{ text: string, bytes: number, originalBytes: number, truncated: boolean }}
 */
export function clipUtf8(value, maxBytes) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 0
  const buffer = Buffer.from(text, 'utf8')
  const originalBytes = buffer.length
  if (originalBytes <= limit) {
    return { text, bytes: originalBytes, originalBytes, truncated: false }
  }
  let end = limit
  // Walk back over UTF-8 continuation bytes (10xxxxxx) so a multi-byte character is dropped whole.
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1
  const clipped = buffer.subarray(0, end).toString('utf8')
  return { text: clipped, bytes: utf8Bytes(clipped), originalBytes, truncated: true }
}

/** Same as clipUtf8 but returns only the string. */
export function clipText(value, maxBytes) {
  return clipUtf8(value, maxBytes).text
}

/**
 * Byte-bounded stream accumulator. Feed it chunks in arrival order and read `result()`
 * once the stream closes; `truncated` stays false while everything fit.
 */
export function createByteSink(maxBytes) {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 0
  const chunks = []
  let bytes = 0
  let truncated = false

  return {
    push(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''), 'utf8')
      if (buffer.length === 0) return
      const before = bytes
      bytes += buffer.length
      if (bytes <= limit) {
        chunks.push(buffer)
        return
      }
      truncated = true
      const room = limit - before
      if (room > 0) chunks.push(buffer.subarray(0, room))
    },
    result() {
      const clipped = clipUtf8(Buffer.concat(chunks).toString('utf8'), limit)
      return {
        text: clipped.text,
        bytes: clipped.bytes,
        originalBytes: Math.max(bytes, clipped.originalBytes),
        truncated: truncated || clipped.truncated,
      }
    },
    get bytes() {
      return bytes
    },
    get truncated() {
      return truncated
    },
  }
}

/** Keep the tail of a text buffer within `maxBytes` UTF-8 bytes (PTY buffers grow old bytes out). */
export function tailUtf8(value, maxBytes) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 0
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= limit) return text
  let start = buffer.length - limit
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1
  return buffer.subarray(start).toString('utf8')
}