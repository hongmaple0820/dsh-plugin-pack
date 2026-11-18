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

export function normalizeEnvironments(targets = {}) {
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
