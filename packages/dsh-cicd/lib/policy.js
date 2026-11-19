/**
 * 授权判定层（v3.0-P0）：所有入口收敛到 `can(actor, action, resource) → { allow, reason, policyId }`。
 *
 * 为什么要有独立的一层：v2 里权限判断散落在各资源函数中（有的查 rbac、有的只看同源），
 * 结果就是「同一件事在不同入口有不同判据」。这里把判据集中成一张显式矩阵，
 * 默认拒绝（`DEFAULT_DENY`），任何未列出的组合都返回 deny 且带上可解释的 reason。
 *
 * 四条规则（08-security-rbac.md §3）：
 * R1 读 / 跑 / 改配置 / 批准四权分立——不存在「因为它是 admin 所以什么都能干」的捷径。
 * R2 主体分类：人类（session/token）、引导期匿名（bootstrap）、构建机（runner token）走不同路径。
 * R3 secret 单向：读 secret 明文要求 admin，且必须走 reveal 流程（本层只判 allow/deny）。
 * R4 prod 五条件：protected env + 允许主体 + 审批通过 + 分支规则 + artifact digest 校验，
 *    这里是前三项中的「允许主体」，其余在部署链路里断言。
 */

export const ACTIONS = Object.freeze({
  READ: 'read',
  RUN: 'run',
  CANCEL: 'cancel',
  RETRY: 'retry',
  EDIT_CONFIG: 'edit-config',
  MANAGE_SECRET: 'manage-secret',
  REVEAL_SECRET: 'reveal-secret',
  DEPLOY_NONPROD: 'deploy-nonprod',
  DEPLOY_PROD: 'deploy-prod',
  ROLLBACK_NONPROD: 'rollback-nonprod',
  ROLLBACK_PROD: 'rollback-prod',
  APPROVE: 'approve',
  MANAGE_MEMBERS: 'manage-members',
  MANAGE_ENV: 'manage-env',
  MANAGE_RUNNER: 'manage-runner',
  MANAGE_PROJECT: 'manage-project',
  AUDIT_READ: 'audit-read',
})

/** 每类动作允许的最低角色。`owner` 是 admin 的超集，用于成员与环境管理。 */
const MIN_ROLE = {
  [ACTIONS.READ]: 'viewer',
  [ACTIONS.RUN]: 'operator',
  [ACTIONS.CANCEL]: 'operator',
  [ACTIONS.RETRY]: 'operator',
  [ACTIONS.EDIT_CONFIG]: 'admin',
  [ACTIONS.MANAGE_SECRET]: 'admin',
  [ACTIONS.REVEAL_SECRET]: 'admin',
  [ACTIONS.DEPLOY_NONPROD]: 'operator',
  [ACTIONS.DEPLOY_PROD]: 'admin',
  [ACTIONS.ROLLBACK_NONPROD]: 'operator',
  [ACTIONS.ROLLBACK_PROD]: 'admin',
  // 批准是独立权力：admin 不能既提审又自批，所以判定层只要求 operator 起，
  // 真正的「禁止自批」在审批实体里比对 requested_by/decided_by。
  [ACTIONS.APPROVE]: 'operator',
  [ACTIONS.MANAGE_MEMBERS]: 'owner',
  [ACTIONS.MANAGE_ENV]: 'owner',
  [ACTIONS.MANAGE_RUNNER]: 'admin',
  [ACTIONS.MANAGE_PROJECT]: 'admin',
  [ACTIONS.AUDIT_READ]: 'admin',
}

const ROLE_RANK = { viewer: 1, operator: 2, admin: 3, owner: 4 }

function rank(role) {
  return ROLE_RANK[String(role || '')] ?? 0
}

export function isKnownAction(action) {
  return Object.values(ACTIONS).includes(String(action))
}

/** 资源标识统一成 `{ type, id, projectId, env, protected }`，便于审计与后续 ReBAC 迁移。 */
export function normalizeResource(resource) {
  if (!resource) return { type: '', id: '', projectId: '', env: '', protected: false }
  if (typeof resource === 'string') return { type: 'project', id: resource, projectId: resource, env: '', protected: false }
  return {
    type: String(resource.type || ''),
    id: String(resource.id || ''),
    projectId: String(resource.projectId ?? resource.project ?? resource.id ?? ''),
    env: String(resource.env || ''),
    protected: Boolean(resource.protected),
  }
}

/**
 * 判定一个主体能否对某资源执行某动作。
 * 返回值恒为对象（绝不抛异常），便于调用方统一写审计。
 */
export function can(actor, action, resource, context = {}) {
  const res = normalizeResource(resource)
  const who = actor && actor.id ? actor : null
  const policyId = `policy:${action}`
  const deny = (reason) => ({ allow: false, reason, policyId, actor: who?.id ?? '', action: String(action), resource: res })

  if (!isKnownAction(action)) return deny('unknown_action')
  if (!who) return deny('no_actor')

  // 引导期：库里还没有任何账号。此时放行全部动作，但 policyId 带 `:bootstrap`，
  // 审计里能一眼看出「这是没人登录时干的」，并且 /me 会返回 bootstrap:true 让面板提示建号。
  // 刻意不在这里拦 prod：引导期拦了等于「装完谁都部署不了」，而引导期能做的坏事
  // 与升级前（写路由完全无鉴权）完全一样，拦它并不增加安全性，只增加卡死。
  if (who.authMethod === 'bootstrap') {
    return { allow: true, reason: 'bootstrap_no_users', policyId: `${policyId}:bootstrap`, actor: who.id, action: String(action), resource: res }
  }

  if (String(who.status || 'active') !== 'active') return deny('actor_disabled')

  // token 的项目 scope：scoped token 只能碰自己范围内的项目。
  const scope = String(who.projectScope ?? '*')
  if (scope && scope !== '*' && res.projectId) {
    const list = scope.split(',').map((item) => item.trim()).filter(Boolean)
    if (list.length > 0 && !list.includes(res.projectId)) return deny('token_out_of_scope')
  }

  const minimum = MIN_ROLE[action]
  if (!minimum) return deny('no_policy_for_action')

  // 项目级角色优先，其次全局 `*`。`actor.role` 由 auth 层按项目解析过；
  // 这里再取一次，允许调用方传 context.role 覆盖（例如服务账号以某项目身份行事）。
  const role = String(context.role ?? who.role ?? '')
  if (!role) return deny('no_role')
  if (rank(role) < rank(minimum)) return deny(`role_${role}_below_${minimum}`)

  // R4：prod 是 protected 环境，角色够也只是「候选」，必须是显式允许主体。
  // 这里以「admin 及以上」为默认 allowlist，环境级 allowlist 在部署链路二次校验。
  if (res.protected || res.env === 'prod') {
    const productActions = [ACTIONS.DEPLOY_PROD, ACTIONS.ROLLBACK_PROD, ACTIONS.MANAGE_ENV]
    if (productActions.includes(action) && rank(role) < rank('admin')) return deny('protected_env_requires_admin')
  }

  return { allow: true, reason: 'role_satisfied', policyId, actor: who.id, action: String(action), resource: res }
}

/** 便捷包装：只需要布尔值的调用点。 */
export function allows(actor, action, resource, context) {
  return can(actor, action, resource, context).allow
}

/** 供文档与测试使用：导出完整矩阵（4 角色 × 全部动作）。 */
export function policyMatrix() {
  const rows = []
  for (const role of ['viewer', 'operator', 'admin', 'owner']) {
    for (const action of Object.values(ACTIONS)) {
      const decision = can({ id: 'test', role, status: 'active', authMethod: 'session' }, action, { type: 'project', id: 'p', projectId: 'p' })
      rows.push({ role, action, allow: decision.allow, reason: decision.reason })
    }
  }
  return rows
}
