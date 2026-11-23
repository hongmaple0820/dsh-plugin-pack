/**
 * 订阅定时增量抓取的纯逻辑层。
 *
 * 遍历所有订阅，逐个调 lib/wechat.js 的 listArticles 拉最新文章，
 * 用 fetchArticle + htmlToMarkdown 补正文后入库；带订阅间限频。
 * 无 Cordis 依赖，store/auth/wx/sleep 全部依赖注入，可单测。
 */

import { LoginExpiredError, InvalidFakeidError } from './wechat.js'
import { notifyWebhooks as defaultNotifyWebhook } from './webhook.js'

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 轮询所有订阅。
 *
 * @param {object} ctx 上下文（仅用 ctx.logger?.warn 记日志，可传 {})
 * @param {object} options
 * @param {object} options.store openStore() 返回值（listSubscriptions/saveArticles/touchSubscription/removeSubscription）
 * @param {object} options.auth createAuth() 返回值（getCredentials/isExpired/logout）
 * @param {object} options.wx { listArticles, fetchArticle, htmlToMarkdown }（即 lib/wechat.js）
 * @param {number} [options.limit=10] 每个订阅单次抓取条数
 * @param {number} [options.intervalMs=3000] 订阅间限频间隔
 * @param {Function} [options.sleep] 限频等待函数（测试注入零延迟）
 * @param {string[]} [options.webhooks=[]] 本轮有新文章时通知的 webhook URL 列表（空表示不通知）
 * @param {Function} [options.notifyWebhook] 通知函数，默认 lib/webhook.js 的 notifyWebhooks
 * @returns {Promise<{added:number, failed:Array<{fakeid:string, error:string}>, loginExpired?:boolean, polled:number, webhook?:object}>}
 */
export async function pollSubscriptions(ctx, {
  store,
  auth,
  wx,
  limit = 10,
  intervalMs = 3000,
  sleep = defaultSleep,
  webhooks = [],
  notifyWebhook = defaultNotifyWebhook,
} = {}) {
  if (!store || !auth || !wx) throw new RangeError('pollSubscriptions 需要 store/auth/wx 依赖')
  const log = (...args) => { try { ctx?.logger?.warn?.(...args) } catch { /* 忽略日志错误 */ } }

  const failed = []
  const newItems = [] // 本轮新入库的文章明细（webhook payload 用）
  let added = 0
  let loginExpired = false

  // 登录态前置检查：auth.getCredentials 在未登录/过期时抛普通 Error（非 LoginExpiredError）
  let credentials
  try {
    credentials = auth.getCredentials()
  } catch (error) {
    loginExpired = true
    log('dsh-wxmp 轮询跳过：' + (error?.message || '未登录'))
    return { added: 0, failed: [], loginExpired: true, polled: 0 }
  }

  const subs = store.listSubscriptions()
  const listArticles = wx.listArticles
  const fetchArticle = wx.fetchArticle
  const htmlToMarkdown = wx.htmlToMarkdown

  for (let i = 0; i < subs.length; i++) {
    const sub = subs[i]
    const fakeid = String(sub.fakeid)
    try {
      const page = await listArticles({ fakeid, begin: 0, count: limit }, { credentials })
      const list = Array.isArray(page?.articles) ? page.articles.slice(0, limit) : []
      // 逐篇补正文：抓取失败不阻塞入库（保留元数据）
      for (const item of list) {
        try {
          const detail = await fetchArticle(item.link)
          if (detail?.contentHtml && typeof htmlToMarkdown === 'function') {
            item.content = htmlToMarkdown(detail.contentHtml)
          }
          if (detail?.publishTime) item.publishTime = detail.publishTime
        } catch (error) {
          log('dsh-wxmp 轮询抓正文失败 ' + fakeid + '：' + (error?.message || error))
        }
      }
      // 入库前先记下已存在的链接，saveArticles 之后便能认出本轮真正新增的部分。
      const known = new Set((store.listArticles(String(fakeid), { since: null, limit: 2000 }).articles || []).map((a) => a.link))
      added += store.saveArticles(fakeid, list)
      for (const item of list) {
        if (!item?.link || known.has(item.link)) continue
        newItems.push({
          fakeid, nickname: sub.nickname ?? '', title: item.title ?? '',
          link: item.link, publishTime: item.publishTime ?? null,
        })
      }
      store.touchSubscription(fakeid)
    } catch (error) {
      if (error instanceof LoginExpiredError) {
        // 登录态过期：清理凭证，停止本轮
        loginExpired = true
        try { auth.logout?.() } catch { /* 清理失败不阻塞 */ }
        failed.push({ fakeid, error: '登录已过期：' + (error.message || '请重新扫码登录') })
        break
      }
      if (error instanceof InvalidFakeidError) {
        // 失效订阅：清理
        try { store.removeSubscription(fakeid) } catch { /* 忽略 */ }
        failed.push({ fakeid, error: '订阅已失效，已移除：' + (error.message || String(error)) })
      } else {
        failed.push({ fakeid, error: error?.message || String(error) })
      }
    }
    if (i < subs.length - 1 && intervalMs > 0) await sleep(intervalMs)
  }

  let webhook
  if (added > 0 && Array.isArray(webhooks) && webhooks.length > 0 && typeof notifyWebhook === 'function') {
    try {
      webhook = await notifyWebhook(ctx, {
        webhooks,
        payload: { event: 'articles_added', added, articles: newItems },
      })
    } catch (error) {
      // 通知失败不影响轮询结果，只记日志。
      log('dsh-wxmp webhook 通知失败：' + (error?.message || error))
      webhook = { delivered: 0, failed: [{ url: '', error: error?.message || String(error) }] }
    }
  }

  return { added, failed, loginExpired, polled: subs.length, ...(webhook ? { webhook } : {}) }
}
