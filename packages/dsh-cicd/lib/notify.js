/**
 * Outbound webhook notifications (v0.6).
 *
 * Notifications are strictly best-effort: a slow, broken or hostile endpoint must never make a
 * release fail. Every dispatch returns a result row so the caller can write an audit operation.
 */

import { createHmac } from 'node:crypto'

export const NOTIFY_EVENTS = [
  'run.success',
  'run.failed',
  'run.canceled',
  'rollback.success',
  'rollback.failed',
  'test',
]

const EVENT_SET = new Set(NOTIFY_EVENTS)

function eventMatches(webhook, event) {
  if (event === 'test') return true
  if (!Array.isArray(webhook.events) || webhook.events.length === 0) return true
  return webhook.events.map((item) => String(item)).includes(event)
}

function signature(secret, body) {
  if (!secret) return ''
  return `sha256=${createHmac('sha256', String(secret)).update(body).digest('hex')}`
}

/**
 * POST one JSON body to every configured webhook in parallel.
 * Returns one `{index, ok, status, error, skipped?}` row per configured webhook.
 */
export async function dispatchNotifications({
  webhooks = [],
  event,
  payload = {},
  timeoutMs = 5000,
  fetch: fetchImpl = globalThis.fetch,
} = {}) {
  if (!EVENT_SET.has(event)) throw new Error(`不支持的通知事件：${event}`)
  const list = Array.isArray(webhooks) ? webhooks : []
  const body = JSON.stringify({ ...payload, event })
  return Promise.all(list.map(async (webhook, index) => {
    if (!eventMatches(webhook, event)) {
      return { index, ok: true, status: 0, error: '', skipped: true }
    }
    if (!webhook || typeof webhook !== 'object' || typeof webhook.url !== 'string' || !/^https?:\/\//i.test(webhook.url)) {
      return { index, ok: false, status: 0, error: 'webhook.url 必须是 http(s) URL' }
    }
    if (typeof fetchImpl !== 'function') {
      return { index, ok: false, status: 0, error: '当前运行时没有 fetch' }
    }
    const headers = { 'content-type': 'application/json' }
    const sign = signature(webhook.secret, body)
    if (sign) headers['x-dsh-signature'] = sign
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    let timer = null
    try {
      if (controller && timeoutMs > 0) {
        timer = setTimeout(() => controller.abort(), timeoutMs)
        if (typeof timer.unref === 'function') timer.unref()
      }
      const response = await fetchImpl(webhook.url, {
        method: 'POST',
        headers,
        body,
        signal: controller?.signal,
      })
      return { index, ok: Boolean(response?.ok), status: Number(response?.status) || 0, error: response?.ok ? '' : `HTTP ${response?.status || 0}` }
    } catch (error) {
      return { index, ok: false, status: 0, error: error?.name === 'AbortError' ? `超时（${timeoutMs}ms）` : (error?.message || String(error)) }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }))
}