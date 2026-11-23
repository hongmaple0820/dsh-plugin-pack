/**
 * Webhook 通知的纯逻辑层：把事件 payload 逐个 POST 到配置的 URL。
 *
 * 无 Cordis 依赖，fetch 可注入，便于单测。任一 URL 投递失败只记入 failed，
 * 不抛错、不影响其它 URL —— 通知失败绝不能打断轮询或入库。
 */

/**
 * 逐个投递 webhook。
 *
 * @param {object} ctx 上下文（仅用 ctx.logger?.warn 记日志，可传 {})
 * @param {object} options
 * @param {string[]} options.webhooks 目标 URL 数组；空数组表示不投递（直接返回零结果）
 * @param {object} options.payload POST 的 JSON 主题
 * @param {typeof fetch} [options.fetchImpl] 可注入 fetch（默认 globalThis.fetch）
 * @param {number} [options.timeoutMs=5000] 单个投递超时（毫秒）
 * @returns {Promise<{delivered:number, failed:Array<{url:string, error:string}>}>}
 */
export async function notifyWebhooks(ctx, { webhooks, payload, fetchImpl, timeoutMs = 5000 } = {}) {
  const urls = Array.isArray(webhooks) ? webhooks.filter((u) => typeof u === 'string' && u) : []
  const result = { delivered: 0, failed: [] }
  if (urls.length === 0) return result
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
  if (typeof doFetch !== 'function') {
    return { delivered: 0, failed: urls.map((url) => ({ url, error: '当前运行环境没有可用的 fetch' })) }
  }
  const body = JSON.stringify(payload ?? {})
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000

  for (const url of urls) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), limit) : null
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: controller?.signal,
      })
      const status = Number(res?.status)
      if (Number.isFinite(status) && (status < 200 || status >= 300)) {
        throw new Error('HTTP ' + status)
      }
      result.delivered++
    } catch (error) {
      const msg = error?.name === 'AbortError' ? '投递超时（' + limit + 'ms）' : (error?.message || String(error))
      result.failed.push({ url, error: msg })
      try { ctx?.logger?.warn?.(('dsh-wxmp webhook 投递失败 ' + url + '：' + msg)) } catch { /* 忽略日志错误 */ }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  return result
}
