/**
 * 环境晋级（promotion）：把「在 staging 验过的那份字节」交给 prod，且只移动指针。
 *
 * 三件必须成立的事：
 * ① 跨环境不复制字节。promotion 是一行记录 + 一个环境指针，字节始终只有 CAS 里那一份。
 *    复制字节就等于造出第二个真相，回滚时「当时上线的到底是哪个包」就永远说不清。
 * ② digest 恒等。部署到 prod 的 digest 必须等于某个被晋级过的 digest；tag 不算，
 *    因为 tag 会移动（这是 Docker 世界里最常见的事故：镜像 tag 被覆盖，回滚跟着漂移）。
 * ③ 晋级前要验字节。digest 在 CAS 里存在但磁盘上被改过一个字节，与「不存在」同样危险，
 *    所以写 promotion 行之前必须 verify 一次 —— 这一步顺带把字节钉进 OS 页缓存，下次部署更快。
 *
 * 指针模型：不另设 environments 指针表。某个 (project, toEnv) 的最新一行 promotion 就是指针，
 * 多存一份指针就等于多一个会与事实脱节的真相。
 */

export const PROMOTION_ERRORS = Object.freeze({
  SOURCE_REQUIRED: 'PROMOTION_SOURCE_REQUIRED',
  SOURCE_NOT_FOUND: 'PROMOTION_SOURCE_NOT_FOUND',
  PATH_INVALID: 'PROMOTION_PATH_INVALID',
  DIGEST_REQUIRED: 'PROMOTION_DIGEST_REQUIRED',
  NOT_PROMOTED: 'ARTIFACT_NOT_PROMOTED',
})

export function promotionError(code, message, extra = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
  return error
}

/** 一个环境是不是「必须经过晋级」才算数：显式 protected，或按约定叫 prod。 */
export function envRequiresPromotion(environments, name) {
  const env = environments?.[name]
  if (!env) return String(name).toLowerCase() === 'prod'
  return env.protected === true || String(name).toLowerCase() === 'prod'
}

/**
 * 从源环境往上找「已经验过」的那一行。
 *
 * 只看该环境里 status='active' 的 release —— superseded 是历史，failed 从来没跑起来过，
 * 拿它们当「验证过」等于把一次失败的回滚包装成晋级依据。
 */
/**
 * 找「要晋级的那份发布」的账本行。
 *
 * 按 releaseId 指名时不再限项目：id 本身就是指针，而 staging 与 prod 常常是两个项目
 * （生产项目只部署、不构建），限项目会让跨项目晋级永远找不到源。按环境找时仍限项目 ——
 * 那时没有更强的身份可用，"哪个项目的 staging"只能由调用方说清。
 */
export function findSourceRelease(db, { projectId = '', fromEnv = '', releaseId = '', target = '' } = {}) {
  const scope = releaseId ? '' : projectId
  const stmt = db.prepare(
    `SELECT * FROM releases
      WHERE status = 'active'
        AND (? = '' OR project_id = ?)
        AND (? = '' OR env = ?)
        AND (? = '' OR target = ?)
        AND (? = '' OR id = ?)
      ORDER BY activated_at DESC, created_at DESC
      LIMIT 1`,
  )
  const row = stmt.get(scope, scope, fromEnv, fromEnv, target, target, releaseId, releaseId)
  return row || null
}

/** 某个环境当前指针（最新一次晋级）：没有就是 null。 */
export function currentPointer(db, { projectId = '', env = '' } = {}) {
  const row = db
    // rowid 兜底：同一毫秒写入两次时 created_at 分不出先后，按插入顺序取最后一行才与"最新"一致。
    .prepare('SELECT *, rowid AS seq FROM promotions WHERE project_id = ? AND to_env = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get(projectId, env)
  return row || null
}

/**
 * 「这份 digest 有没有被晋级到过这个环境」。
 *
 * 判据是 promotions 行，不是「这个环境里跑过这个 digest」—— 后者会把一次直接部署
 * （绕过晋级、在 prod 上手动跑的 release）当成合法凭据，闸门就形同虚设。
 */
export function isPromoted(db, { projectId = '', env = '', digest = '' } = {}) {
  if (!digest) return false
  const row = db
    .prepare('SELECT *, rowid AS seq FROM promotions WHERE project_id = ? AND to_env = ? AND digest = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get(projectId, env, digest)
  return row || null
}

export function listPromotions(db, { projectId = '', env = '', limit = 50 } = {}) {
  return db
    .prepare(
      `SELECT *, rowid AS seq FROM promotions
        WHERE (? = '' OR project_id = ?) AND (? = '' OR to_env = ?)
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`,
    )
    .all(projectId, projectId, env, env, Number(limit) || 50)
}

export function recordPromotion(db, row = {}) {
  const insert = db.prepare(
    `INSERT INTO promotions (id, project_id, digest, from_env, to_env, target, host, release_id, run_id, approved_by, approved_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  insert.run(
    String(row.id || ''),
    String(row.projectId || ''),
    String(row.digest || ''),
    String(row.fromEnv || ''),
    String(row.toEnv || ''),
    String(row.target || ''),
    String(row.host || ''),
    String(row.releaseId || ''),
    String(row.runId || ''),
    String(row.approvedBy || ''),
    String(row.approvedAt || ''),
    String(row.createdAt || new Date().toISOString()),
  )
  return db.prepare('SELECT * FROM promotions WHERE id = ?').get(String(row.id || ''))
}

/** 环境视图：每个环境当前指针 + 最近几次晋级。 */
export function promotionView(db, { projectId = '', environments = {} } = {}) {
  const envs = Object.keys(environments || {}).sort((a, b) => (environments[a]?.order ?? 99) - (environments[b]?.order ?? 99) || a.localeCompare(b))
  return envs.map((name) => {
    const pointer = currentPointer(db, { projectId, env: name })
    const history = listPromotions(db, { projectId, env: name, limit: 5 })
    return {
      name,
      order: environments[name]?.order ?? 99,
      protected: Boolean(environments[name]?.protected),
      digest: pointer?.digest || '',
      promotedAt: pointer?.created_at || '',
      fromEnv: pointer?.from_env || '',
      releaseId: pointer?.release_id || '',
      history: history.map((row) => ({ id: row.id, digest: row.digest, fromEnv: row.from_env, at: row.created_at, releaseId: row.release_id })),
    }
  })
}
