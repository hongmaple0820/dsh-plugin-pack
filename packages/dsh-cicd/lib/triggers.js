/**
 * V2-M1：`pipe.yml` 的 `triggers:` 段解析与匹配。
 *
 * 形状（在 version: 1 的现有子集上增量，不破坏旧文件——没有 triggers 的旧 pipe 一切照旧）：
 *
 *   triggers:
 *     push:
 *       branches: [main, release-*]
 *       tags: ['v*']
 *       secret: my-shared-secret      # 入站 GET 回调（/hooks/<project>?token=…）的共享密钥
 *     schedule:
 *       - cron: '0 3 * * *'
 *         target: prod                 # 可选：指定部署目标（缺省用 pipe 的 defaultTarget）
 *     manual: true
 *
 * - push 的 branches/tags 用 glob（`*` 匹配任意字符，含 `/`，与文件 glob 的跨目录语义一致）。
 * - schedule 的 cron 在 lib/cron.js 校验。
 * - manual 缺省 true（现状就是手动触发）。
 */

import { PipeError } from './pipe.js'
import { assertCron } from './cron.js'

/** glob → 正则：`*` 匹配任意字符（分支名里的 `/` 也算），其余按字面量。 */
function globToRegExp(pattern) {
  let source = ''
  for (const ch of String(pattern)) {
    if (ch === '*') source += '.*'
    else source += ch.replace(/[.+^${}()|[\]\\?]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

/** 判断 ref（`refs/heads/main` 或裸分支/tag 名）是否命中 push 规则。 */
export function matchPushRef(push, ref) {
  if (!push || !ref) return { matched: false, kind: '', name: '' }
  const name = String(ref).replace(/^refs\/heads\//, '').replace(/^refs\/tags\//, '')
  const isTag = String(ref).startsWith('refs/tags/')
  const patterns = isTag ? push.tags : push.branches
  for (const pattern of patterns) {
    if (globToRegExp(pattern).test(name)) return { matched: true, kind: isTag ? 'tag' : 'branch', name, pattern }
  }
  return { matched: false, kind: isTag ? 'tag' : 'branch', name }
}

function asStringArray(value, label) {
  if (value === undefined || value === null || value === '') return []
  const list = Array.isArray(value) ? value : [value]
  return list.map((item) => {
    if (typeof item !== 'string' || !item.trim()) throw new PipeError(`${label} 必须是非空字符串`)
    return item.trim()
  })
}

/** 解析并规范化 triggers 段；root 没有 triggers 时返回默认（manual-only）。 */
export function normalizeTriggers(root) {
  if (root.triggers === undefined || root.triggers === null) {
    return { push: null, schedule: [], manual: true, hasPush: false, hasSchedule: false }
  }
  if (typeof root.triggers !== 'object' || Array.isArray(root.triggers)) {
    throw new PipeError('triggers 必须是 map')
  }
  const triggers = root.triggers

  let push = null
  if (triggers.push !== undefined && triggers.push !== null && triggers.push !== false) {
    if (typeof triggers.push !== 'object' || Array.isArray(triggers.push)) throw new PipeError('triggers.push 必须是 map')
    const branches = asStringArray(triggers.push.branches, 'triggers.push.branches')
    const tags = asStringArray(triggers.push.tags, 'triggers.push.tags')
    if (branches.length === 0 && tags.length === 0) throw new PipeError('triggers.push 至少要有一个 branches 或 tags 规则')
    const secret = triggers.push.secret === undefined || triggers.push.secret === null ? '' : String(triggers.push.secret).trim()
    if (secret && /\s/.test(secret)) throw new PipeError('triggers.push.secret 不能包含空白字符')
    push = { branches, tags, secret }
  }

  const schedule = []
  if (triggers.schedule !== undefined && triggers.schedule !== null && triggers.schedule !== '') {
    const list = Array.isArray(triggers.schedule) ? triggers.schedule : [triggers.schedule]
    for (const [index, entry] of list.entries()) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new PipeError(`triggers.schedule 第 ${index + 1} 项必须是 map`)
      }
      const cron = entry.cron === undefined || entry.cron === null ? '' : String(entry.cron).trim()
      if (!cron) throw new PipeError(`triggers.schedule 第 ${index + 1} 项缺少 cron`)
      try {
        assertCron(cron)
      } catch (error) {
        throw new PipeError(`triggers.schedule 第 ${index + 1} 项的 cron 无效：${error.message}`)
      }
      const target = entry.target === undefined || entry.target === null ? '' : String(entry.target).trim()
      schedule.push({ cron, target })
    }
  }

  const manual = triggers.manual === undefined || triggers.manual === null ? true : Boolean(triggers.manual)
  return { push, schedule, manual, hasPush: Boolean(push), hasSchedule: schedule.length > 0 }
}

/** 面板/工具输出用的摘要。 */
export function triggerSummary(triggers) {
  if (!triggers) return { push: false, branches: [], tags: [], schedules: [], manual: true }
  return {
    push: triggers.hasPush,
    branches: triggers.push?.branches || [],
    tags: triggers.push?.tags || [],
    schedules: triggers.schedule || [],
    manual: triggers.manual,
  }
}
