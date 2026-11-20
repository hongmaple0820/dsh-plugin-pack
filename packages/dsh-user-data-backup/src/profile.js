/** Merge redacted profile values against the exact target bytes captured by restore preview. */
import { parseDocument, visit, isMap, isSeq, isScalar, isAlias } from 'yaml'
import { REDACTED } from './redact.js'

function documentOf(source) {
  const document = parseDocument(source, { strict: true, uniqueKeys: true, customTags: [] })
  if (document.errors.length > 0) throw new Error('Cannot restore invalid profile YAML')
  return document
}
function redacted(node) {
  let found = false
  visit(node, (_key, value) => {
    if (isScalar(value) && typeof value.value === 'string' && value.value.includes(REDACTED)) found = true
  })
  return found
}
function retained(current, imported) {
  if (current === null || current === undefined) throw new Error('Redacted profile values have no target value; configure this profile before restoring it')
  const clone = current.clone()
  // Aliases in the imported document continue to refer to its own anchor name.
  if (imported?.anchor) clone.anchor = imported.anchor
  return clone
}
function mergeNode(current, imported) {
  if (!redacted(imported)) return imported
  // A positional sequence may have been reordered; retain it as a unit rather than move secrets between entries.
  if (isSeq(imported) || isScalar(imported)) return retained(current, imported)
  if (!isMap(imported) || !isMap(current)) return retained(current, imported)
  for (const pair of imported.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') throw new Error('Cannot restore complex profile YAML keys')
    const existing = current.items.find(item => isScalar(item.key) && item.key.value === pair.key.value)
    pair.value = mergeNode(existing?.value, pair.value)
  }
  return imported
}
function validateAliases(document) {
  const anchors = new Set()
  visit(document, (_key, node) => {
    if (node?.anchor) {
      if (anchors.has(node.anchor)) throw new Error('Merged profile has duplicate YAML anchors')
      anchors.add(node.anchor)
    }
    if (isAlias(node) && !anchors.has(node.source)) throw new Error('Merged profile contains an unresolved YAML alias')
  })
}
function mergeJson(current, incoming) {
  if (typeof incoming === 'string' && incoming.includes(REDACTED)
    || Array.isArray(incoming) && JSON.stringify(incoming).includes(REDACTED)) {
    if (current === undefined) throw new Error('Redacted profile values have no target value')
    return structuredClone(current)
  }
  if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming
  const result = {}
  for (const [key, value] of Object.entries(incoming)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Profile contains a reserved property')
    result[key] = mergeJson(current?.[key], value)
  }
  return result
}

/** Untouched files retain their archive bytes; only masked values need a target-aware merge. */
export function prepareProfileFile({ name, bytes, original }) {
  if (!name.startsWith('profile/')) return bytes
  const source = Buffer.from(bytes).toString('utf8')
  if (name.endsWith('.json')) {
    const incoming = JSON.parse(source)
    if (!source.includes(REDACTED)) return bytes
    const current = original === null ? undefined : JSON.parse(original.toString('utf8'))
    return Buffer.from(JSON.stringify(mergeJson(current, incoming)))
  }
  const incoming = documentOf(source)
  if (!redacted(incoming)) return bytes
  const current = original === null ? null : documentOf(original.toString('utf8'))
  incoming.contents = mergeNode(current?.contents, incoming.contents)
  validateAliases(incoming)
  return Buffer.from(incoming.toString())
}
