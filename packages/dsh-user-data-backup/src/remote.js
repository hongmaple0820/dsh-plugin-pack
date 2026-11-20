/** Maintained protocol clients transport bounded, uniquely named archives; retention follows read-back verification. */
import { createHash, randomUUID } from 'node:crypto'
import { createClient } from 'webdav'
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { DEFAULT_LIMITS } from './archive.js'
import { archivePath } from './paths.js'

export const REMOTE_NAME = /^dsh-user-data-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f-]{36}\.zip$/
const text = (value, name, maximum = 500) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\u0000-\u001f]/.test(value)) throw new Error(`Invalid ${name}`)
  return value
}
/** Configuration contains references only; secret values stay in the credential provider. */
export function remoteConfiguration(value) {
  if (value === null || typeof value !== 'object' || !['webdav', 's3'].includes(value.kind)) throw new Error('Invalid remote type')
  const endpoint = new URL(text(value.endpoint, 'remote endpoint'))
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !['https:', 'http:'].includes(endpoint.protocol)) throw new Error('Remote endpoint must not contain credentials, query or fragment')
  if (endpoint.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)) throw new Error('Remote endpoint requires HTTPS')
  const prefix = value.prefix === undefined || value.prefix === '' ? 'dsh-backups' : text(value.prefix, 'remote directory', 200)
  archivePath(`profile/${prefix}/probe`)
  const keep = value.keep ?? 20
  const intervalMs = value.intervalMs ?? 0
  if (!Number.isInteger(keep) || keep < 1 || keep > 1000) throw new Error('Retention must be between 1 and 1000')
  if (!Number.isSafeInteger(intervalMs) || (intervalMs !== 0 && (intervalMs < 60000 || intervalMs > 30 * 86400000))) throw new Error('Automatic backup interval must be zero or between one minute and thirty days')
  const components = value.components ?? ['profile', 'settings']
  if (!Array.isArray(components) || components.length === 0 || new Set(components).size !== components.length || components.some(component => !['profile', 'settings', 'sessions'].includes(component))) throw new Error('Automatic backups support profile, settings and inactive sessions only')
  const config = { kind: value.kind, endpoint: endpoint.href, prefix, keep, intervalMs, components }
  for (const field of value.kind === 'webdav' ? ['usernameRef', 'passwordRef'] : ['accessKeyRef', 'secretKeyRef', 'sessionTokenRef']) {
    if (value[field] !== undefined && value[field] !== '') {
      if (typeof value[field] !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,199}$/.test(value[field])) throw new Error('Invalid credential reference')
      config[field] = value[field]
    }
  }
  if (value.kind === 's3') {
    config.bucket = text(value.bucket, 'S3 bucket', 63)
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket)) throw new Error('Invalid S3 bucket')
    config.region = text(value.region ?? 'us-east-1', 'S3 region', 100)
    config.forcePathStyle = value.forcePathStyle === true
    if (!config.accessKeyRef || !config.secretKeyRef) throw new Error('S3 requires access and secret credential references')
  }
  return config
}

async function boundedBody(body) {
  const parts = []
  let size = 0
  for await (const part of body) {
    size += part.length
    if (size > DEFAULT_LIMITS.archiveBytes) throw new Error('Remote archive exceeds the size limit')
    parts.push(Buffer.from(part))
  }
  return Buffer.concat(parts)
}

/** Resolves credentials for this operation and releases network resources on every path. */
export async function remoteTransport(config, credentials) {
  const resolve = async ref => {
    if (ref === undefined) return undefined
    const resolved = await credentials?.resolve(ref)
    if (resolved === undefined) throw new Error('A configured remote credential is unavailable')
    return resolved.value
  }
  const key = name => {
    if (!REMOTE_NAME.test(name)) throw new Error('Invalid backup name')
    return `${config.prefix}/${name}`
  }
  if (config.kind === 'webdav') {
    const client = createClient(config.endpoint, { username: await resolve(config.usernameRef), password: await resolve(config.passwordRef) })
    const request = { timeout: 30000 }
    return {
      async list() {
        const entries = await client.getDirectoryContents(config.prefix, request)
        if (entries.length > 10000) throw new Error('Remote listing exceeds the limit')
        return entries.filter(item => item.type === 'file' && REMOTE_NAME.test(item.basename)).map(item => ({ name: item.basename, bytes: item.size })).sort((a, b) => b.name.localeCompare(a.name))
      },
      async put(name, bytes) {
        await client.createDirectory(config.prefix, { ...request, recursive: true })
        await client.putFileContents(key(name), Buffer.from(bytes), { ...request, overwrite: false })
      },
      async get(name) { return boundedBody(client.createReadStream(key(name), request)) },
      async remove(name) { await client.deleteFile(key(name), request) },
      close() {},
    }
  }
  const client = new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: await resolve(config.accessKeyRef), secretAccessKey: await resolve(config.secretKeyRef),
      ...(config.sessionTokenRef ? { sessionToken: await resolve(config.sessionTokenRef) } : {}) }, maxAttempts: 2 })
  const send = command => client.send(command, { abortSignal: AbortSignal.timeout(30000) })
  return {
    async list() {
      const result = []
      const seenTokens = new Set()
      let scanned = 0
      let token
      do {
        const page = await send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: `${config.prefix}/`, ContinuationToken: token }))
        scanned += page.Contents?.length ?? 0
        if (scanned > 10000) throw new Error('Remote listing exceeds the limit')
        for (const item of page.Contents ?? []) {
          const name = item.Key?.slice(config.prefix.length + 1)
          if (name && REMOTE_NAME.test(name)) result.push({ name, bytes: item.Size ?? 0 })
        }
        if (result.length > 10000) throw new Error('Remote listing exceeds the limit')
        token = page.IsTruncated ? page.NextContinuationToken : undefined
        if (page.IsTruncated && (!token || seenTokens.has(token))) throw new Error('Remote listing was truncated or repeated a cursor')
        if (token) seenTokens.add(token)
      } while (token)
      return result.sort((a, b) => b.name.localeCompare(a.name))
    },
    async put(name, bytes) { await send(new PutObjectCommand({ Bucket: config.bucket, Key: key(name), Body: bytes, IfNoneMatch: '*', ContentType: 'application/zip' })) },
    async get(name) {
      const response = await send(new GetObjectCommand({ Bucket: config.bucket, Key: key(name) }))
      if (!response.Body || (response.ContentLength ?? 0) > DEFAULT_LIMITS.archiveBytes) {
        response.Body?.destroy?.()
        throw new Error('Remote archive is missing or exceeds the size limit')
      }
      return boundedBody(response.Body)
    },
    async remove(name) { await send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key(name) })) },
    close() { client.destroy() },
  }
}

/** Retention cannot delete a previous archive until the new archive has been read back byte-for-byte. */
export async function uploadVerified(transport, bytes, keep) {
  const name = `dsh-user-data-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.zip`
  await transport.put(name, bytes)
  const downloaded = await transport.get(name)
  const digest = value => createHash('sha256').update(value).digest('hex')
  if (digest(downloaded) !== digest(bytes)) throw new Error('Remote backup verification failed; previous backups were retained')
  const removed = []
  let retentionFailed = false
  try {
    const listing = await transport.list()
    for (const item of listing.slice(keep)) {
      if (item.name === name) continue
      await transport.remove(item.name)
      removed.push(item.name)
    }
  } catch (error) {
    // A verified backup remains usable; transport errors can contain credentials.
    retentionFailed = true
  }
  return { name, bytes: bytes.length, digest: digest(bytes), removed, retentionFailed }
}
