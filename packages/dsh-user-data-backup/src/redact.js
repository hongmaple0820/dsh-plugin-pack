/** Profile export redacts YAML nodes without evaluating executable tags or expanding aliases. */
import { parseDocument, visit, isScalar, Scalar } from 'yaml'

const SECRET_KEY = /(?:password|passwd|secret|token|credential|authorization|private[-_]?key|api[-_]?key|access[-_]?key|client[-_]?key)/i
const ENV_KEY = /^(?:env|environment|headers)$/i
export const REDACTED = '[redacted]'

/** Malformed documents fail closed; unknown executable tags are retained as inert text. */
export function redactYaml(source) {
  if (typeof source !== 'string') throw new TypeError('YAML source must be text')
  const document = parseDocument(source, { strict: true, uniqueKeys: true, customTags: [], keepSourceTokens: true })
  if (document.errors.length > 0) throw new Error('Cannot export invalid YAML')
  document.comment = null
  document.commentBefore = null
  visit(document, (_key, node) => {
    if (node !== null && typeof node === 'object') {
      delete node.comment
      delete node.commentBefore
    }
  })
  visit(document, {
    Pair(_key, pair) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string') throw new Error('Cannot safely redact complex YAML keys')
      const key = pair.key.value
      // Environment variables and headers can carry secrets under arbitrary names.
      if (SECRET_KEY.test(key) || ENV_KEY.test(key)) pair.value = new Scalar(REDACTED)
    },
    Scalar(_key, node) {
      if (typeof node.value !== 'string') return
      let value = node.value.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_.=:-]+/gi, '$1 [redacted]')
      value = value.replace(/\b(https?:\/\/)([^\s/@]+):([^\s/@]+)@/gi, '$1[redacted]@')
      value = value.replace(/([?&](?:token|key|password|secret|signature|api_key|access_token)=)[^&#\s]+/gi, '$1[redacted]')
      node.value = value
    },
  })
  return document.toString()
}

/** Settings descriptors must already carry host schema redaction; recursively remove secret-looking fields as well. */
export function redactSettings(value) {
  if (Array.isArray(value)) return value.map(redactSettings)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
    [key, SECRET_KEY.test(key) || ENV_KEY.test(key) ? REDACTED : redactSettings(entry)]))
  return value
}
