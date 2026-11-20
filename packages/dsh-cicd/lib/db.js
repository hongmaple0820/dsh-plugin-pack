/**
 * SQLite 存储：用 Node 内置的 `node:sqlite`（DatabaseSync），不引入原生编译依赖。
 * 表结构与 docs/proposals/cicd-lite.md 的 M1 子集一致：runs / steps / artifacts / releases / operations。
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const DB_FILE_NAME = 'cicd.db'
/**
 * 版本历史：
 * 1 — 初始结构（runs/steps/artifacts/releases/operations）。
 * 2 — v0.5：releases 增加 env 列（记录发布落到哪个环境，便于按 env 过滤与审计）。
 * 3 — v0.6：operations 增加 action/project/target/host/release_id/status，支撑审计时间线。
 * 4 — v2.0-M0：新增 projects 表（向导创建的项目持久化，独立于启动配置）；运行前从 git 回填 branch/commit_sha。
 * 5 — v2.0-M2：steps 增加 runner_id 列（记录这一步在哪个执行面跑的：本地 local 或远端 runnerId）。
 * 6 — v3.0-P0：新增 deploy_locks（部署锁落库，重启后仍互斥）、audit_events（哈希链审计）、
 *     users/sessions/api_tokens/memberships（身份与会话）、approvals（审批落库，绑 digest + TTL）、
 *     runners（远端构建机注册表，支持持久吊销）。旧表只做加法，不重建。
 * 7 — v3.0-P1：steps 增加 job_id 列。v2 里一个 stage 可以有多个 job，step 归属必须记到 job
 *     一级，否则日志分片与「哪个 job 失败」都无从判断；同 stage 内多个 job 的 step 序号也会
 *     互相覆盖（主键是 run_id + stage_id + idx）。
 * 8 — v3.0-P1：runs 增加 config_snapshot / config_hash。重跑与重试只用快照、不重新读仓库，
 *     否则「昨晚失败的那次到底跑的是哪版 pipe.yml」永远说不清；hash 用来提示「配置已变更」。
 * 9 — v3.0-P3：releases 增加 artifact_digest / mode / strategy / instances / operator。
 *     回滚必须只用不可变摘要（tag 会移动，digest 不会）；一个 release 落在一台主机的多个
 *     实例上，端口与 pid 是回滚现场的一部分，不能只记一个 host。
 * 11 — v3.0-P5-3：artifact_refs 重建为 WITHOUT ROWID（owner,name 就是主键），
 *     并新增 artifact_packages —— Maven/npm/PyPI 的坐标（生态 + 名字 + 版本）指向 digest。
 *     没有这张表，`/repository/maven/...` 只能靠扫目录猜版本顺序，maven-metadata.xml 也就无从生成。
 * 12 — v3.0-P5-5：promotions（环境晋级）。一行 = 「这份 digest 在哪个环境验过、被谁晋级到哪个环境」。
 *     它是 prod 部署闸门的唯一凭据，也是环境指针（某个 to_env 的最新一行），所以不可能从 releases 反推：
 *     releases 只记「哪台机器上现在跑着什么」，记不了「谁批准了这份字节去生产」。
 */
export const SCHEMA_VERSION = 13

const DDL = [
  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL DEFAULT '',
    pipeline_name TEXT NOT NULL DEFAULT '',
    trigger TEXT NOT NULL DEFAULT '',
    branch TEXT NOT NULL DEFAULT '',
    commit_sha TEXT NOT NULL DEFAULT '',
    target TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    dry_run INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL DEFAULT '',
    finished_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT '',
    config_snapshot TEXT NOT NULL DEFAULT '',
    config_hash TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_runs_started ON runs (started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_project ON runs (project_id, started_at DESC)`,
  `CREATE TABLE IF NOT EXISTS steps (
    run_id TEXT NOT NULL,
    stage_id TEXT NOT NULL DEFAULT '',
    job_id TEXT NOT NULL DEFAULT '',
    idx INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL DEFAULT '',
    command TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    exit_code INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 1,
    timeout_s INTEGER NOT NULL DEFAULT 0,
    log_path TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL DEFAULT '',
    finished_at TEXT NOT NULL DEFAULT '',
    runner_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (run_id, stage_id, job_id, idx)
  )`,
  `CREATE TABLE IF NOT EXISTS artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL DEFAULT '',
    path TEXT NOT NULL DEFAULT '',
    bytes INTEGER NOT NULL DEFAULT 0,
    sha256 TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts (run_id)`,
  `CREATE TABLE IF NOT EXISTS releases (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL DEFAULT '',
    target TEXT NOT NULL DEFAULT '',
    host TEXT NOT NULL DEFAULT '',
    env TEXT NOT NULL DEFAULT '',
    run_id TEXT NOT NULL DEFAULT '',
    commit_sha TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT '',
    activated_at TEXT NOT NULL DEFAULT '',
    deactivated_at TEXT NOT NULL DEFAULT '',
    manifest_path TEXT NOT NULL DEFAULT '',
    revisions_offset INTEGER NOT NULL DEFAULT 0,
    previous TEXT NOT NULL DEFAULT '',
    artifact_sha256 TEXT NOT NULL DEFAULT '',
    artifact_digest TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL DEFAULT '',
    strategy TEXT NOT NULL DEFAULT '',
    instances TEXT NOT NULL DEFAULT '',
    operator TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_releases_target ON releases (target, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS operations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL DEFAULT '',
    project TEXT NOT NULL DEFAULT '',
    target TEXT NOT NULL DEFAULT '',
    host TEXT NOT NULL DEFAULT '',
    release_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    at TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_operations_run ON operations (run_id, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_operations_at ON operations (at DESC)`,
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    source_type TEXT NOT NULL DEFAULT 'local',
    repo_url TEXT NOT NULL DEFAULT '',
    default_branch TEXT NOT NULL DEFAULT '',
    path TEXT NOT NULL DEFAULT '',
    pipe_path TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_projects_name ON projects (name)`,
  // ---- v3.0-P0 ------------------------------------------------------------------------------
  // 部署锁必须落库：进程内 Map 在重启/多副本场景下会失效，这是 v2 最实际的一个事故来源。
  `CREATE TABLE IF NOT EXISTS deploy_locks (
    target TEXT PRIMARY KEY,
    project_id TEXT NOT NULL DEFAULT '',
    run_id TEXT NOT NULL DEFAULT '',
    owner TEXT NOT NULL DEFAULT '',
    acquired_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_deploy_locks_expires ON deploy_locks (expires_at)`,
  // 审计哈希链：hash = sha256(prev_hash || canonical_json(record))，append-only。
  `CREATE TABLE IF NOT EXISTS audit_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    actor_id TEXT NOT NULL DEFAULT '',
    auth_method TEXT NOT NULL DEFAULT '',
    token_id TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL DEFAULT '',
    resource_id TEXT NOT NULL DEFAULT '',
    project_id TEXT NOT NULL DEFAULT '',
    result TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    source_ip TEXT NOT NULL DEFAULT '',
    request_id TEXT NOT NULL DEFAULT '',
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events (ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events (actor_id, ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_events (project_id, ts DESC)`,
  // 身份：本地账号 + 会话 + API token（token 只存哈希，此处不引入原生依赖）。
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS memberships (
    user_id TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT '*',
    role TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, project_id)
  )`,
  `CREATE TABLE IF NOT EXISTS api_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    project_scope TEXT NOT NULL DEFAULT '*',
    expires_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL DEFAULT '',
    revoked_at TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    source_ip TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    revoked_at TEXT NOT NULL DEFAULT ''
  )`,
  // 审批是「一次具体部署」的闸门，绑 artifact digest 而不是绑 run：run 会被重跑，
  // digest 不会。expires_at 到位后由 resolveExpired() 落为 approval_timeout。
  `CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL DEFAULT '',
    project_id TEXT NOT NULL DEFAULT '',
    target TEXT NOT NULL DEFAULT '',
    artifact_digest TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    requested_by TEXT NOT NULL DEFAULT '',
    requested_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    decided_by TEXT NOT NULL DEFAULT '',
    decided_at TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    consumed_at TEXT NOT NULL DEFAULT ''
  )`,
  // 远端构建机注册表：v2 只存在内存里，重启丢失、无法吊销、死机器永远是 online。
  // status 只存 active/revoked；online/offline 由 last_seen_at 与心跳周期实时推导。
  `CREATE TABLE IF NOT EXISTS runners (
    runner_id TEXT PRIMARY KEY,
    labels TEXT NOT NULL DEFAULT '',
    version TEXT NOT NULL DEFAULT '',
    capacity INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active',
    registered_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    revoked_at TEXT NOT NULL DEFAULT '',
    revoked_by TEXT NOT NULL DEFAULT '',
    token_sha256 TEXT NOT NULL DEFAULT '',
    protocol INTEGER NOT NULL DEFAULT 1,
    joined_at TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_runners_status ON runners (status, last_seen_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals (status, requested_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_approvals_project ON approvals (project_id, requested_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_approvals_digest ON approvals (artifact_digest)`,
  // ---- v3.0-P5 --------------------------------------------------------------------------------
  // 制品 CAS 的元数据索引。**字节不在这个表里**：事实来源是磁盘上按 digest 命名的文件，
  // 这里只记录「谁在哪个项目/运行里上传了什么」，删掉整张表不会丢一份字节。
  // 指针表重建一次（v11）：它靠 (owner,name) 存活，不该另有一个自增 rowid 在 GC 后一路变长。
  `DROP TABLE IF EXISTS artifact_refs`,
  `CREATE TABLE IF NOT EXISTS artifact_blobs (
    digest TEXT PRIMARY KEY,
    bytes INTEGER NOT NULL DEFAULT 0,
    project_id TEXT NOT NULL DEFAULT '',
    run_id TEXT NOT NULL DEFAULT '',
    job_id TEXT NOT NULL DEFAULT '',
    source_path TEXT NOT NULL DEFAULT '',
    media_type TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_artifact_blobs_project ON artifact_blobs (project_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_artifact_blobs_run ON artifact_blobs (run_id)`,
  // 指针（tag）：可变，指向一个不可变 digest。promotion 只动这张表，不复制字节。
  `CREATE TABLE IF NOT EXISTS artifact_refs (
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    digest TEXT NOT NULL,
    previous TEXT NOT NULL DEFAULT '',
    project_id TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (owner, name)
  ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS idx_artifact_refs_digest ON artifact_refs (digest)`,
  // v3.0-P5-3：Maven / npm / PyPI 的坐标。一个版本一个 digest，**永远不覆盖**：
  // 同名同版本再传一次是对「不可变」的违背，宁可在入库时拒掉，也不能让上游的两个构建共用同一个坐标。
  // meta / integrity 存各生态自己的元数据（SRI、classifier 的扩展名等），按 JSON 原样回给客户端。
  `CREATE TABLE IF NOT EXISTS artifact_packages (
    ecosystem TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    digest TEXT NOT NULL,
    bytes INTEGER NOT NULL DEFAULT 0,
    media_type TEXT NOT NULL DEFAULT '',
    project_id TEXT NOT NULL DEFAULT '',
    run_id TEXT NOT NULL DEFAULT '',
    classifier TEXT NOT NULL DEFAULT '',
    extension TEXT NOT NULL DEFAULT '',
    meta TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_packages_key ON artifact_packages (ecosystem, scope, name, version, classifier, extension)`,
  `CREATE INDEX IF NOT EXISTS idx_artifact_packages_name ON artifact_packages (ecosystem, scope, name, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_artifact_packages_digest ON artifact_packages (digest)`,
  // v3.0-P5-5：晋级记录。不存环境指针表 —— 某个 (project_id, to_env) 的最新一行就是指针，
  // 多一份指针就多一个会与事实脱节的真相。
  `CREATE TABLE IF NOT EXISTS promotions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL DEFAULT '',
    digest TEXT NOT NULL DEFAULT '',
    from_env TEXT NOT NULL DEFAULT '',
    to_env TEXT NOT NULL DEFAULT '',
    target TEXT NOT NULL DEFAULT '',
    host TEXT NOT NULL DEFAULT '',
    release_id TEXT NOT NULL DEFAULT '',
    run_id TEXT NOT NULL DEFAULT '',
    approved_by TEXT NOT NULL DEFAULT '',
    approved_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_promotions_digest ON promotions (digest, to_env)`,
  `CREATE INDEX IF NOT EXISTS idx_promotions_env ON promotions (project_id, to_env, created_at DESC)`,
]

const OPERATION_COLUMNS = [
  ['action', `TEXT NOT NULL DEFAULT ''`],
  ['project', `TEXT NOT NULL DEFAULT ''`],
  ['target', `TEXT NOT NULL DEFAULT ''`],
  ['host', `TEXT NOT NULL DEFAULT ''`],
  ['release_id', `TEXT NOT NULL DEFAULT ''`],
  ['status', `TEXT NOT NULL DEFAULT ''`],
]

function hasColumn(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all()
  return rows.some((row) => String(row?.name || '') === column)
}

/**
 * 老库的 steps 主键是 (run_id, stage_id, idx)，v7 要的是 4 列主键。
 * SQLite 不能改主键，只能建新表搬数据——搬的语法在 3.25+ 可用 `RENAME`，但更稳的做法是
 * 建新表 → INSERT SELECT → 删旧表 → 改名，这样在任何版本都一样。
 *
 * 事务由调用方（migrate 的 runInTransaction）负责：自己再 BEGIN 一次会报
 * "cannot start a transaction within a transaction"，而且嵌套事务一旦中途失败，
 * 外层已经写进去的步骤就回不去了。
 */
function rebuildStepsWithJobId(db) {
  const columns = db.prepare('PRAGMA table_info(steps)').all().map((row) => String(row?.name || ''))
  if (columns.includes('job_id')) return false
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    db.exec(`CREATE TABLE steps_v7 (
    run_id TEXT NOT NULL,
    stage_id TEXT NOT NULL DEFAULT '',
    job_id TEXT NOT NULL DEFAULT '',
    idx INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL DEFAULT '',
    command TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    exit_code INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 1,
    timeout_s INTEGER NOT NULL DEFAULT 0,
    log_path TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL DEFAULT '',
    finished_at TEXT NOT NULL DEFAULT '',
    runner_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (run_id, stage_id, job_id, idx)
    )`)
    const hasRunner = columns.includes('runner_id')
    db.exec(`INSERT INTO steps_v7 (run_id, stage_id, job_id, idx, name, command, status, exit_code, duration_ms, attempts, timeout_s, log_path, started_at, finished_at, runner_id)
    SELECT run_id, stage_id, '', idx, name, command, status, exit_code, duration_ms, attempts, timeout_s, log_path, started_at, finished_at, ${hasRunner ? 'runner_id' : "''"}
    FROM steps`)
    db.exec('DROP TABLE steps')
    db.exec('ALTER TABLE steps_v7 RENAME TO steps')
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
  return true
}

/**
 * v10 的 artifact_refs 带隐式 rowid；v11 起改成 WITHOUT ROWID（主键即数据）。
 * 指针会被反复覆盖，rowid 只增不减，长期跑会留下永远用不到的 id 空洞——不是正确性问题，
 * 但一张「只有两列主键」的表没有理由付这个代价。数据要原样搬过去。
 */
function ensureRefsWithoutRowid(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'artifact_refs'").get()
  const sql = String(row?.sql || '')
  if (!sql || /WITHOUT\s+ROWID/i.test(sql)) return false
  // 事务由 migrate 的 runInTransaction 负责（见 rebuildStepsWithJobId 的注释）。
  db.exec(`CREATE TABLE artifact_refs_v11 (
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      digest TEXT NOT NULL,
      previous TEXT NOT NULL DEFAULT '',
      project_id TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (owner, name)
    ) WITHOUT ROWID`)
  db.exec(`INSERT INTO artifact_refs_v11 (owner, name, digest, previous, project_id, updated_at)
      SELECT owner, name, digest, previous, project_id, updated_at FROM artifact_refs`)
  db.exec('DROP TABLE artifact_refs')
  db.exec('ALTER TABLE artifact_refs_v11 RENAME TO artifact_refs')
  return true
}

/**
 * v3.0-P7：迁移说明表。
 *
 * 旧版只有一个 `PRAGMA user_version` 表示「最后是哪一版」，但它没有任何文字说明：
 * 用户备份出一个 v9 的库，第二天想退回 v3.0-P4 的插件版本时，没有任何地方能回答
 * 「v9 到底比 v8 多了什么、能不能回去」。所以除了版本号还写一张 schema_migrations：
 * 每一版一行，带一句人话描述。
 *
 * 注意它记的是**已到过**的版本，不记时点（同一个文件在 WAL 下随进程变化），
 * 所以它是「这批表结构经历过什么」的台账，不是迁移的审计日志。
 */
const MIGRATION_NOTES = {
  1: { note: '初始表：runs / steps / releases / operations', additive: false },
  2: { note: 'releases 增加 env 列', additive: true },
  3: { note: 'operations 补审计列（action / actor / result / reason…）', additive: true },
  4: { note: '审计与身份相关表', additive: true },
  5: { note: 'steps 增加 runner_id', additive: true },
  6: { note: 'approvals / runners / tokens 等', additive: true },
  7: { note: 'steps 主键从 3 列扩到 4 列（加 job_id）——重建表', additive: false },
  8: { note: 'runs 增加 config_snapshot / config_hash', additive: true },
  9: { note: 'releases 增加回滚现场（artifact_digest / mode / strategy / instances / operator）', additive: true },
  10: { note: '制品表（artifact_blobs / artifact_refs）', additive: true },
  11: { note: '指针表改成 WITHOUT ROWID', additive: false },
  12: { note: '晋级表 promotions + releases 增加 version', additive: true },
  13: { note: 'runners 增加协议 v2 的 token 摘要 / 协议号 / 加入时间', additive: true },
}

function migrationNote(version) {
  return MIGRATION_NOTES[version] || { note: '未登记的一版', additive: true }
}

/**
 * 迁移是**一次事务**。
 *
 * 以前每一步 ALTER 各自提交，中途断电就会留下半个版本：例如 runs 已经有了
 * config_snapshot 但 user_version 还停在 7，下一次启动又从头跑一遍这些 ALTER ——
 * 靠 hasColumn 之流能侥幸跑通，但只要有一步不是幂等的，库就再也打不开了。
 * 现在 DDL 与 ALTER 一起包在 BEGIN IMMEDIATE / COMMIT 里：全成或全不成。
 */
function runInTransaction(db, work) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* 事务已经没了，别再遮住原始错误 */ }
    throw error
  }
}

function recordMigration(db, version) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    note TEXT NOT NULL DEFAULT '',
    additive INTEGER NOT NULL DEFAULT 1,
    applied_at TEXT NOT NULL
  )`)
  const info = migrationNote(version)
  db.prepare('INSERT OR REPLACE INTO schema_migrations (version, note, additive, applied_at) VALUES (?, ?, ?, ?)')
    .run(version, info.note, info.additive ? 1 : 0, new Date().toISOString())
}

function migrate(db) {
  const row = db.prepare('PRAGMA user_version').get()
  const version = Number(row?.user_version ?? 0)
  if (version >= SCHEMA_VERSION) return version
  runInTransaction(db, () => {
    for (const sql of DDL) db.exec(sql)
    // v1 → v2：老库的 releases 没有 env 列，CREATE TABLE IF NOT EXISTS 不会补，这里显式加。
    if (!hasColumn(db, 'releases', 'env')) {
      db.exec(`ALTER TABLE releases ADD COLUMN env TEXT NOT NULL DEFAULT ''`)
    }
    // v2 → v3：老库的 operations 只有 run_id/kind/detail/at，按需补审计列。
    for (const [name, definition] of OPERATION_COLUMNS) {
      if (!hasColumn(db, 'operations', name)) {
        db.exec(`ALTER TABLE operations ADD COLUMN ${name} ${definition}`)
      }
    }
    // v4 → v5：老库的 steps 没有 runner_id 列，CREATE TABLE IF NOT EXISTS 不会补，这里显式加。
    if (!hasColumn(db, 'steps', 'runner_id')) {
      db.exec(`ALTER TABLE steps ADD COLUMN runner_id TEXT NOT NULL DEFAULT ''`)
    }
    // v6 → v7：steps 主键从 3 列扩到 4 列（加 job_id）。主键改不了，只能重建表搬数据；
    // v1 的旧行 job_id 一律为空串（v1 没有 job 概念），语义与原来完全等价。
    // 注意必须在 DDL 之后做：DDL 里的 CREATE TABLE IF NOT EXISTS 对老库是空操作，不会帮上忙。
    rebuildStepsWithJobId(db)
    // v7 → v8：runs 增加配置快照两列。重跑必须跑「当时那份配置」，所以快照存原始 YAML 全文，
    // hash 只用来判断「今天的 pipe.yml 和那次运行的是不是同一份」。
    for (const name of ['config_snapshot', 'config_hash']) {
      if (!hasColumn(db, 'runs', name)) {
        db.exec(`ALTER TABLE runs ADD COLUMN ${name} TEXT NOT NULL DEFAULT ''`)
      }
    }
    // v8 → v9：releases 增加回滚现场五列。老行留空串——它们确实没有这些信息，
    // 编一个默认值（比如 mode='native'）会让「这条记录到底有没有实例信息」变得不可判断。
    // v11 → v12：再加 version —— 制品自己的版本号（pip 版本化发布据此排序），与 commit 无关。
    for (const name of ['artifact_digest', 'mode', 'strategy', 'instances', 'operator', 'version']) {
      if (!hasColumn(db, 'releases', name)) {
        db.exec(`ALTER TABLE releases ADD COLUMN ${name} TEXT NOT NULL DEFAULT ''`)
      }
    }
    // v12 → v13：runners 增加协议 v2 三列。token_sha256 存的是 runner token 的 sha256 摘要，
    // 永远不存明文；老行（v1 协议的机器）为空串，等于「没领过 v2 token」。
    if (!hasColumn(db, 'runners', 'token_sha256')) {
      db.exec(`ALTER TABLE runners ADD COLUMN token_sha256 TEXT NOT NULL DEFAULT ''`)
    }
    if (!hasColumn(db, 'runners', 'protocol')) {
      db.exec(`ALTER TABLE runners ADD COLUMN protocol INTEGER NOT NULL DEFAULT 1`)
    }
    if (!hasColumn(db, 'runners', 'joined_at')) {
      db.exec(`ALTER TABLE runners ADD COLUMN joined_at TEXT NOT NULL DEFAULT ''`)
    }
    // v10 → v11：指针表改成 WITHOUT ROWID。v10 的迁移脚本先建过一次普通表（带 rowid），
    // 这里按「有没有 rowid」判新旧——PRAGMA index_list 看不出这个，只能问 sqlite_master 的原始 DDL。
    ensureRefsWithoutRowid(db)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_operations_at ON operations (at DESC)`)
    db.exec(`UPDATE operations SET action = kind WHERE action = '' AND kind <> ''`)
    for (let step = 1; step <= SCHEMA_VERSION; step += 1) recordMigration(db, step)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  })
  return version
}

export function openDatabase(file, { busyTimeoutMs = 5000 } = {}) {
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA busy_timeout = ' + Math.max(0, Math.trunc(busyTimeoutMs)))
  migrate(db)
  return db
}

/** 数据库里的 TEXT/INTEGER 统一转成调用方期望的形状 */
export function text(value) {
  if (value === null || value === undefined) return ''
  return String(value)
}

export function int(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}