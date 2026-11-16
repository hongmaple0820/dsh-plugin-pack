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
 */
export const SCHEMA_VERSION = 3

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
    updated_at TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_runs_started ON runs (started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_project ON runs (project_id, started_at DESC)`,
  `CREATE TABLE IF NOT EXISTS steps (
    run_id TEXT NOT NULL,
    stage_id TEXT NOT NULL DEFAULT '',
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
    PRIMARY KEY (run_id, stage_id, idx)
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
    artifact_sha256 TEXT NOT NULL DEFAULT ''
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

function migrate(db) {
  const row = db.prepare('PRAGMA user_version').get()
  const version = Number(row?.user_version ?? 0)
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
  db.exec(`CREATE INDEX IF NOT EXISTS idx_operations_at ON operations (at DESC)`)
  db.exec(`UPDATE operations SET action = kind WHERE action = '' AND kind <> ''`)
  if (version < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  return version
}

export function openDatabase(file) {
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA busy_timeout = 5000')
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