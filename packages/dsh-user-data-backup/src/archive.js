/** Size-limited ZIP bundles verify each manifest digest before exposing files to restore. */
import { createHash } from 'node:crypto'
import { zipSync } from 'fflate'
import yauzl from 'yauzl'
import { uniqueArchivePaths } from './paths.js'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
export const DEFAULT_LIMITS = Object.freeze({ archiveBytes: 64 * 1024 * 1024, fileBytes: 32 * 1024 * 1024,
  expandedBytes: 256 * 1024 * 1024, files: 10000, manifestBytes: 2 * 1024 * 1024 })

/** Exports only caller-selected files; credentials must be separately selected by the Host. */
export function createArchive(files, metadata, limits = DEFAULT_LIMITS) {
  uniqueArchivePaths(files.map(file => file.name))
  if (files.length > limits.files) throw new Error('Too many backup files')
  const contents = Object.create(null)
  let total = 0
  const manifest = { format: 'dsh-user-data', version: 1, createdAt: new Date().toISOString(),
    profile: metadata.profile, ...(metadata.sessionFormatVersion === undefined ? {} : { sessionFormatVersion: metadata.sessionFormatVersion }), files: files.map(file => {
      const bytes = Buffer.from(file.bytes)
      total += bytes.length
      if (bytes.length > limits.fileBytes || total > limits.expandedBytes) throw new Error('Backup exceeds expanded size limit')
      contents[file.name] = bytes
      return { name: file.name, bytes: bytes.length, sha256: digest(bytes) }
    }) }
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  if (manifestBytes.length > limits.manifestBytes) throw new Error('Backup manifest is too large')
  contents['manifest.json'] = manifestBytes
  const bytes = zipSync(contents)
  if (bytes.length > limits.archiveBytes) throw new Error('Backup exceeds archive size limit')
  return { bytes, manifest }
}

/** ZIP metadata and streamed byte counts are both checked before archive contents are returned. */
export async function readArchive(input, limits = DEFAULT_LIMITS) {
  if (input.byteLength > limits.archiveBytes) throw new Error('Backup exceeds archive size limit')
  const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(Buffer.from(input), {
    lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true,
  }, (error, value) => error ? reject(error) : resolve(value)))
  const files = new Map()
  const names = new Set()
  let total = 0
  try {
    await new Promise((resolve, reject) => {
      const fail = error => { zip.close(); reject(error) }
      zip.on('error', fail)
      zip.on('end', resolve)
      zip.on('entry', entry => {
        try {
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000
          if (mode !== 0 && mode !== 0x8000) throw new Error('Backup contains a link or non-regular file')
          if (entry.isEncrypted()) throw new Error('Encrypted ZIP entries are unsupported')
          const name = entry.fileName
          const key = name.normalize('NFC').toLowerCase()
          if (names.has(key)) throw new Error('Duplicate backup path')
          names.add(key)
          if (name !== 'manifest.json') uniqueArchivePaths([name])
          if (names.size > limits.files + 1) throw new Error('Too many backup files')
          const max = name === 'manifest.json' ? limits.manifestBytes : limits.fileBytes
          if (entry.uncompressedSize > max || total + entry.uncompressedSize > limits.expandedBytes) throw new Error('Backup exceeds expanded size limit')
          zip.openReadStream(entry, (error, stream) => {
            if (error) return fail(error)
            const chunks = []
            let size = 0
            stream.on('error', fail)
            stream.on('data', chunk => {
              size += chunk.length
              total += chunk.length
              if (size > max || total > limits.expandedBytes) { stream.destroy(new Error('Backup exceeds expanded size limit')); return }
              chunks.push(chunk)
            })
            stream.on('end', () => { files.set(name, Buffer.concat(chunks)); zip.readEntry() })
          })
        } catch (error) { fail(error) }
      })
      zip.readEntry()
    })
  } finally { zip.close() }
  const rawManifest = files.get('manifest.json')
  if (rawManifest === undefined) throw new Error('Backup manifest is missing')
  const manifest = JSON.parse(rawManifest.toString('utf8'))
  if (manifest.format !== 'dsh-user-data' || manifest.version !== 1 || !Array.isArray(manifest.files)
    || manifest.files.length !== files.size - 1) throw new Error('Invalid backup manifest')
  const parsed = uniqueArchivePaths(manifest.files.map(file => file.name))
  const result = parsed.map((entry, index) => {
    const bytes = files.get(entry.name)
    const record = manifest.files[index]
    if (bytes === undefined || record.bytes !== bytes.length || record.sha256 !== digest(bytes)) throw new Error('Backup file digest mismatch')
    return { name: entry.name, bytes }
  })
  return { manifest, files: result, digest: digest(input) }
}
