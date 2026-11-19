/**
 * 环境（environment）升格 + 保护规则 + 晋升顺序。
 *
 * pipe.yml 的 target 自动映射为 environment：
 *   - dev/staging 顺序号 1/2（按字母序或显式 order），prod 默认最高
 *   - protected: true 时部署需额外 confirm=prod（复用现有生产护栏）
 *   - approvalRequired: true 时部署停在「待审批」，面板点「通过」才继续
 *
 * 面板「环境」页签显示每个环境当前 release（复用 active 字段）。
 */

const ENV_ORDER = { dev: 1, staging: 2, prod: 3 }

/**
 * 把 pipe 的 targets 与宿主级护栏（options.environments）合并成环境视图。
 *
 * 护栏按**环境名**给出，所以"某个环境只在护栏里、不在这个项目的 pipe 里"也是合法的 ——
 * 那正是共享 prod 的常见形状（生产项目只部署，不构建）。宿主级的 protected 只能**加强**：
 * pipe 里 `protected: true` 而护栏写 false 时，结果仍是受保护（见 withGuards 的说明）。
 */
export function normalizeEnvironments(targets = {}, guards = null) {
  const names = Object.keys(targets).filter((name) => targets[name] && typeof targets[name] === 'object')
  const environments = {}
  for (const name of names) {
    const target = targets[name]
    const order = ENV_ORDER[name.toLowerCase()] ?? 99
    const protected_ = name.toLowerCase() === 'prod' || target.protected === true
    const approvalRequired = name.toLowerCase() === 'prod' || target.approvalRequired === true
    environments[name] = {
      name,
      order,
      protected: protected_,
      approvalRequired,
      strategy: target.strategy || null,
      canary: target.canary || null,
      hosts: target.hosts || [],
    }
  }
  if (!guards || typeof guards.entries !== 'function') return environments
  for (const [name, spec] of guards.entries()) {
    const existing = environments[name]
    if (existing) {
      existing.guard = spec
      continue
    }
    // 只在护栏里出现的环境：顺序号按约定名，hosts 留空（它的主机不在这个项目里）。
    environments[name] = {
      name,
      order: ENV_ORDER[name.toLowerCase()] ?? 99,
      protected: name.toLowerCase() === 'prod' || spec.protected === true,
      approvalRequired: spec.approval === true,
      strategy: null,
      canary: null,
      hosts: [],
      guard: spec,
    }
  }
  return environments
}

export function promotionPath(environments, fromName) {
  const names = Object.keys(environments).filter((n) => environments[n])
  const sorted = names.slice().sort((a, b) => {
    const oa = environments[a].order ?? 99
    const ob = environments[b].order ?? 99
    return oa - ob || a.localeCompare(b)
  })
  const fromIndex = sorted.indexOf(fromName)
  if (fromIndex < 0) return []
  return sorted.slice(fromIndex + 1)
}

export function isProtected(environments, name) {
  const env = environments?.[name]
  return Boolean(env?.protected)
}

export function requiresApproval(environments, name) {
  const env = environments?.[name]
  return Boolean(env?.approvalRequired)
}

// ---------------------------------------------------------------------------
// v3.0-P4-3：受保护环境的「环境级护栏」（08-security-rbac.md §3.2/§4 的 R4）。
//
// 为什么护栏不写在 pipe.yml 的 target 上：target 是**部署目标**（hosts/path/health），
// 而护栏是**谁能把字节放上去**的问题。同一个 prod 环境常被多个项目共享，
// 把 allowlist 抄在每个项目的 target 里，就等于每加一个项目就多一个漏配的机会 ——
// 而漏配的表现是「悄悄放行」，不是报错。所以护栏按**环境名**集中写在插件配置里。
//
// 五条件（缺一即拒，见 assertEnvironmentGuard）：
//   ① protected      —— 环境被标成受保护（prod 永远算，不写也是）
//   ② allowedActors  —— 主体显式在名单里（角色达到 admin **不算**凭据）
//   ③ approval       —— 审批门（部署链路里消费，护栏只回答"要不要"）
//   ④ branchRule     —— 分支 / tag 规则匹配（正则，整串匹配）
//   ⑤ digest         —— 制品闸门（护栏只回答"要不要"，校验在 artifactGate）
// 这里实现 ①②④ 的判定与 ③⑤ 的"适用性"，真正的执行点在 deployStep / artifactGate / 审批门。
// ---------------------------------------------------------------------------

/** 主体标识：`user:<id>` / `token:<id>` / `role:<role>` / `service:<name>`。只认小写，避免同一主体两种写法。 */
const ACTOR_PATTERN = /^(user|token|role|service):([a-z0-9][a-z0-9._:@-]*)$/

/**
 * 解析配置里的护栏。返回 {@code { byEnv: Map, invalid: [] }}：
 * 写错了的条目会被**收进 invalid 并整体拒绝启动判定**，而不是静默忽略 ——
 * 一条 `allowedActors: ["admin"]`（漏了 role: 前缀）如果被当成"没有配置"，
 * 结果就是从"只有名单里的人能发生产"退化成"没有名单，谁都不拦"。
 */
export function parseEnvironmentGuards(input = {}) {
  const byEnv = new Map()
  const invalid = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { byEnv, invalid: input === undefined || input === null ? [] : [{ env: '', message: 'environmentGuards 必须是 map' }] }
  }
  for (const [rawName, rawSpec] of Object.entries(input)) {
    const name = String(rawName || '').trim()
    if (!name) { invalid.push({ env: '', message: 'environmentGuards 里有空的环境名' }); continue }
    if (rawSpec === false || rawSpec === null) {
      // 显式 false 是"这个环境不要护栏"（受保护环境不允许这么写，见 assertEnvironmentGuard）。
      byEnv.set(name, { name, protected: false, allowedActors: [], branchRule: '', approval: false })
      continue
    }
    if (typeof rawSpec !== 'object' || Array.isArray(rawSpec)) {
      invalid.push({ env: name, message: `environmentGuards.${name} 必须是 map（或 false）` })
      continue
    }
    const problems = []
    const actors = []
    const actorList = rawSpec.allowedActors === undefined ? [] : rawSpec.allowedActors
    if (!Array.isArray(actorList)) problems.push(`environmentGuards.${name}.allowedActors 必须是数组`)
    else {
      for (const actor of actorList) {
        // 只小写不 decode：主体 id 是邮箱这类原文，写成 user:admin%40acc.test 的人
        // 期待的就是「谁的 id 长这样」，替他把百分号解开等于替他猜。
        const value = String(actor || '').trim().toLowerCase()
        if (!ACTOR_PATTERN.test(value)) problems.push(`environmentGuards.${name}.allowedActors 里的 "${actor}" 不合法（形如 user:alice / token:ci / role:admin / service:deploy）`)
        else actors.push(value)
      }
    }
    let branchRule = ''
    if (rawSpec.branchRule !== undefined && rawSpec.branchRule !== '') {
      const text = String(rawSpec.branchRule)
      try {
        // 分支规则写错等于把护栏关掉，所以在解析期就编译一次。
        new RegExp(text)
        branchRule = text
      } catch (error) {
        problems.push(`environmentGuards.${name}.branchRule 不是合法的正则：${error?.message || ''}`)
      }
    }
    if (problems.length > 0) { invalid.push(...problems.map((problem) => ({ env: name, message: problem }))); continue }
    byEnv.set(name, {
      name,
      protected: rawSpec.protected !== false,
      allowedActors: actors,
      branchRule,
      approval: rawSpec.approval !== false,
    })
  }
  return { byEnv, invalid }
}

/** 主体在不在名单里：`user:` / `token:` 按 id，`role:` 按角色，`service:` 按 trigger。 */
export function actorMatchesAllowlist(actor, allowedActors = []) {
  if (!Array.isArray(allowedActors) || allowedActors.length === 0) return false
  const who = actor || {}
  const candidates = new Set()
  if (who.id) { candidates.add(`user:${String(who.id).toLowerCase()}`); candidates.add(`service:${String(who.id).toLowerCase()}`) }
  if (who.tokenId) candidates.add(`token:${String(who.tokenId).toLowerCase()}`)
  if (who.role) candidates.add(`role:${String(who.role).toLowerCase()}`)
  return allowedActors.some((item) => candidates.has(item))
}

/** 分支/tag 规则：正则整串匹配；没配规则时视为"不限制"。 */
export function branchMatchesRule(rule, { branch = '', tag = '' } = {}) {
  const text = String(rule || '')
  if (!text) return true
  const re = new RegExp(text)
  const values = [tag, branch].filter(Boolean).map((value) => String(value))
  if (values.length === 0) return false
  return values.some((value) => re.test(value))
}

/**
 * 五条件的判定单点。返回 `{ required, ok, failures: [{condition, code, message}] }`，
 * **永不抛异常** —— 调用方要带着 failures 去写审计，抛异常会让拒绝原因丢掉。
 */
export function assertEnvironmentGuard({ env = '', guard = null, actor = null, branch = '', tag = '', digestPresent = null } = {}) {
  const name = String(env || '')
  const isProd = name.toLowerCase() === 'prod'
  const spec = guard || null
  const protectedEnv = isProd || spec?.protected === true
  if (!protectedEnv) return { required: false, ok: true, failures: [] }
  const failures = []
  const fail = (condition, code, message) => failures.push({ condition, code, message })
  // ① protected：受保护环境不接受"显式关闭护栏"。
  if (spec && spec.protected === false) {
    fail('protected', 'ENV_GUARD_MISCONFIGURED', `环境 ${name} 是受保护环境，不能配置 protected: false`)
  }
  // ② 允许主体：名单为空 = 没有名单 = 谁都进不去（否则漏配等于放行）。
  if (!spec || !Array.isArray(spec.allowedActors) || spec.allowedActors.length === 0) {
    fail('allowedActors', 'ENV_GUARD_NO_ALLOWLIST', `环境 ${name} 是受保护环境，但没有配置 allowedActors（用 deployment.environments.${name}.allowedActors 指定；空名单等于谁都不许部署）`)
  } else if (!actorMatchesAllowlist(actor, spec.allowedActors)) {
    fail('allowedActors', 'ENV_ACTOR_NOT_ALLOWED', `主体 ${actor?.id || '(匿名)'} 不在环境 ${name} 的允许名单里（${spec.allowedActors.join('、')}）`)
  }
  // ③ 审批：只回答"要不要"，消费在审批门。
  if (spec && spec.approval === false) {
    fail('approval', 'ENV_GUARD_MISCONFIGURED', `环境 ${name} 是受保护环境，不能关掉审批`)
  }
  // ④ 分支规则：返回分支/tag 一个都没匹配上时拒绝。
  if (spec && spec.branchRule) {
    if (!branchMatchesRule(spec.branchRule, { branch, tag })) {
      fail('branchRule', 'ENV_BRANCH_NOT_ALLOWED', `分支 ${branch || tag || '(未知)'} 不匹配环境 ${name} 的分支规则 /${spec.branchRule}/`)
    }
  }
  // ⑤ digest：受保护环境必须带内容地址；"有没有晋级过"由 artifactGate 判。
  if (digestPresent === false) {
    fail('digest', 'ENV_DIGEST_REQUIRED', `部署到受保护环境 ${name} 必须带 artifact digest`)
  }
  return { required: true, ok: failures.length === 0, failures }
}
