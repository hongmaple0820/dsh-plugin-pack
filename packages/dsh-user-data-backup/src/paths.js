/** Portable archive names are restricted to Windows-safe relative paths on every platform. */
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const COMPONENTS = new Set(['profile', 'settings', 'sessions', 'credentials', 'preferences'])

/** Validate a manifest file name before joining it to a host-owned component root. */
export function archivePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024
    || value.includes('\\') || value.startsWith('/') || value.includes(':') || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Invalid backup path')
  }
  const segments = value.split('/')
  if (segments.length < 2 || !COMPONENTS.has(segments[0])) throw new Error('Unknown backup component')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || /[. ]$/.test(segment)
      || /[<>"|?*]/.test(segment) || RESERVED.test(segment)) throw new Error('Unsafe backup path')
  }
  return { component: segments[0], relative: segments.slice(1).join('/'), canonical: value.normalize('NFC').toLowerCase() }
}

/** Reject aliases before any file is extracted or any restore plan is produced. */
export function uniqueArchivePaths(names) {
  const seen = new Set()
  const entries = names.map(name => {
    const parsed = archivePath(name)
    if (seen.has(parsed.canonical)) throw new Error('Duplicate backup path')
    seen.add(parsed.canonical)
    return { name, ...parsed }
  })
  for (const entry of entries) {
    const parts = entry.canonical.split('/')
    while (parts.length > 2) {
      parts.pop()
      if (seen.has(parts.join('/'))) throw new Error('Backup file conflicts with a directory')
    }
  }
  return entries
}
