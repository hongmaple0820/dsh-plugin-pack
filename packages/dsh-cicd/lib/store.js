/**
 * 运行记录存储：SQLite（`node:sqlite` 的 DatabaseSync，无原生编译依赖）。
 * 表：runs / steps / artifacts / releases / operations；日志仍按 runId 落成文本文件，便于 tail 与下载。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DB_FILE_NAME, int, openDatabase, text } from './db.js'

export const DEFAULT_WORK_DIR = join(homedir(), '.dsh-cicd')

const RUN_COLUMNS = ['id', 'project_id', 'pipeline_name', 'trigger', 'branch', 'commit_sha', 'target', 'status', 'dry_run', 'error', 'started_at', 'finished_at', 'updated_at', 'config_snapshot', 'config_hash']

const PROJECT_COLUMNS = ['id', 'name', 'source_type', 'repo_url', 'default_branch', 'path', 'pipe_path', 'created_at', 'updated_at']

function projectRow(project = {}) {
  const now = new Date().toISOString()
  return {
    id: text(project.id),
    name: text(project.name || project.id),
    source_type: text(project.source_type ?? project.sourceType) || 'local',
    repo_url: text(project.repo_url ?? project.repoUrl),
    default_branch: text(project.default_branch ?? project.defaultBranch),
    path: text(project.path),
    pipe_path: text(project.pipe_path ?? project.pipePath ?? project.pipe),
    created_at: text(project.created_at ?? project.createdAt) || now,
    updated_at: now,
  }
}

function projectOut(row) {
  return row ? {
    id: text(row.id),
    name: text(row.name),
    sourceType: text(row.source_type),
    repoUrl: text(row.repo_url),
    defaultBranch: text(row.default_branch),
    path: text(row.path),
    pipePath: text(row.pipe_path),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  } : null
}

function runRow(run = {}) {
  return {
    id: text(run.id),
    project_id: text(run.project_id ?? run.projectId),
    pipeline_name: text(run.pipeline_name ?? run.pipelineName),
    trigger: text(run.trigger),
    branch: text(run.branch),
    commit_sha: text(run.commit_sha ?? run.commit),
    target: text(run.target),
    status: text(run.status),
    dry_run: run.dry_run === 1 || run.dry_run === true || run.dryRun === true ? 1 : 0,
    error: text(run.error),
    started_at: text(run.started_at ?? run.startedAt),
    finished_at: text(run.finished_at ?? run.finishedAt),
    updated_at: new Date().toISOString(),
    // v8：配置快照。重跑/重试只用它，不重新读仓库 —— 否则「那次失败跑的到底是哪版 pipe.yml」说不清。
    config_snapshot: text(run.config_snapshot ?? run.configSnapshot),
    config_hash: text(run.config_hash ?? run.configHash),
  }
}

/** 取文本末尾 tail 行；tail<=0 表示整份返回。两个读日志入口共用，避免两处切行逻辑漂移。 */
function sliceTail(content, tail = 0) {
  if (!tail || tail <= 0) return content
  const lines = content.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.slice(-tail).join('\n')
}

export function createStore({ dir = DEFAULT_WORK_DIR, file = '' } = {}) {
  const root = dir
  const dbFile = file || join(root, DB_FILE_NAME)
  const logsDir = join(root, 'logs')
  mkdirSync(logsDir, { recursive: true })
  const db = openDatabase(dbFile)
  let closed = false

  const statements = {
    upsertRun: db.prepare(`INSERT INTO runs (${RUN_COLUMNS.join(', ')}) VALUES (${RUN_COLUMNS.map(() => '?').join(', ')})
      ON CONFLICT(id) DO UPDATE SET ${RUN_COLUMNS.filter((column) => column !== 'id').map((column) => `${column} = excluded.${column}`).join(', ')}`),
    selectRuns: db.prepare('SELECT * FROM runs WHERE (? = \'\' OR project_id = ?) ORDER BY started_at DESC LIMIT ?'),
    selectRun: db.prepare('SELECT * FROM runs WHERE id = ?'),
    upsertStep: db.prepare(`INSERT INTO steps (run_id, stage_id, job_id, idx, name, command, status, exit_code, duration_ms, attempts, timeout_s, log_path, started_at, finished_at, runner_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, stage_id, job_id, idx) DO UPDATE SET name = excluded.name, command = excluded.command, status = excluded.status,
        exit_code = excluded.exit_code, duration_ms = excluded.duration_ms, attempts = excluded.attempts, timeout_s = excluded.timeout_s,
        log_path = excluded.log_path, started_at = excluded.started_at, finished_at = excluded.finished_at,
        runner_id = excluded.runner_id`),
    selectSteps: db.prepare('SELECT * FROM steps WHERE run_id = ? ORDER BY started_at ASC, job_id ASC, idx ASC'),
    insertArtifact: db.prepare('INSERT INTO artifacts (run_id, path, bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?)'),
    selectArtifacts: db.prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY id ASC'),
    upsertRelease: db.prepare(`INSERT INTO releases (id, project_id, target, host, env, run_id, commit_sha, status, created_at, activated_at, deactivated_at, manifest_path, revisions_offset, previous, artifact_sha256, artifact_digest, mode, strategy, instances, operator, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, target = excluded.target, host = excluded.host, env = excluded.env, run_id = excluded.run_id,
        commit_sha = excluded.commit_sha, status = excluded.status, created_at = excluded.created_at, activated_at = excluded.activated_at,
        deactivated_at = excluded.deactivated_at, manifest_path = excluded.manifest_path, revisions_offset = excluded.revisions_offset,
        previous = excluded.previous, artifact_sha256 = excluded.artifact_sha256, artifact_digest = excluded.artifact_digest,
        mode = excluded.mode, strategy = excluded.strategy, instances = excluded.instances, operator = excluded.operator,
        version = excluded.version`),
    selectReleases: db.prepare("SELECT * FROM releases WHERE (? = '' OR target = ?) AND (? = '' OR host = ?) AND (? = '' OR env = ?) ORDER BY created_at DESC LIMIT ?"),
    selectRelease: db.prepare('SELECT * FROM releases WHERE id = ?'),
    selectActive: db.prepare(`SELECT * FROM releases WHERE status = 'active' AND (? = '' OR target = ?) AND (? = '' OR host = ?)
      ORDER BY activated_at DESC, created_at DESC LIMIT 1`),
    insertOperation: db.prepare(`INSERT INTO operations (run_id, kind, action, project, target, host, release_id, status, detail, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    selectOperations: db.prepare(`SELECT * FROM operations
      WHERE (? = '' OR project = ?) AND (? = '' OR run_id = ?)
      ORDER BY at DESC, id DESC LIMIT ?`),
    upsertProject: db.prepare(`INSERT INTO projects (${PROJECT_COLUMNS.join(', ')}) VALUES (${PROJECT_COLUMNS.map(() => '?').join(', ')})
      ON CONFLICT(id) DO UPDATE SET ${PROJECT_COLUMNS.filter((column) => column !== 'id').map((column) => `${column} = excluded.${column}`).join(', ')}`),
    selectProjects: db.prepare('SELECT * FROM projects ORDER BY name ASC, created_at DESC'),
    selectProject: db.prepare('SELECT * FROM projects WHERE id = ?'),
  }

  function guard() {
    if (closed) throw new Error('store 已关闭')
  }

  const runOut = (row) => ({ ...row, dry_run: int(row.dry_run, 0), commit: text(row.commit_sha) })
  const releaseOut = (row) => {
    if (!row) return null
    let instances = []
    // v9：instances 是 JSON 字符串。坏数据不该让整个列表接口 500 —— 一条 release 的实例
    // 清单读不出来时，用户仍然应该能看到「这次发布发生过」，只是看不到端口明细。
    if (typeof row.instances === 'string' && row.instances.trim()) {
      try {
        const parsed = JSON.parse(row.instances)
        if (Array.isArray(parsed)) instances = parsed
      } catch { instances = [] }
    } else if (Array.isArray(row.instances)) {
      instances = row.instances
    }
    return {
      ...row,
      commit: text(row.commit_sha),
      instances,
      artifactDigest: text(row.artifact_digest),
      artifact_digest: text(row.artifact_digest),
    }
  }

  // 老版本写的是 runs.jsonl：首次打开时把历史事件导入 SQLite，然后改名留档，之后只写数据库
  const legacyFile = join(root, 'runs.jsonl')
  function migrateLegacy() {
    if (!existsSync(legacyFile)) return 0
    const empty = db.prepare('SELECT COUNT(*) AS n FROM runs').get()
    if (Number(empty?.n ?? 0) > 0) return 0
    let imported = 0
    const lines = readFileSync(legacyFile, 'utf8').split(/\r?\n/)
    for (const line of lines) {
      if (!line.trim()) continue
      let event
      try { event = JSON.parse(line) } catch { continue }
      const data = event?.data
      if (!data || typeof data !== 'object') continue
      try {
        if (event.type === 'run') { api.appendRun(data); imported += 1 } else if (event.type === 'step') { api.appendStep(data); imported += 1 } else if (event.type === 'release') { api.appendRelease(data); imported += 1 } else if (event.type === 'artifact') { api.appendArtifact(data); imported += 1 } else if (event.type === 'operation') { api.appendOperation(data); imported += 1 }
      } catch { /* 单条坏数据不阻断导入 */ }
    }
    try { renameSync(legacyFile, `${legacyFile}.migrated`) } catch { /* 改名失败就下次再来 */ }
    return imported
  }

  const limitOf = (limit, fallback = 50) => (Number.isInteger(limit) && limit >= 0 ? limit : fallback)

  const api = {
    dir: root,
    dbFile,
    logsDir,
    // v3.0-P0：审计 / 部署锁 / 身份三个子模块共用同一个 DatabaseSync 句柄（各自 prepare 自己的语句），
    // 避免把身份与审计逻辑塞进这个只关心运行记录的模块。
    db,

    appendRun(run = {}) {
      guard()
      const row = runRow(run)
      statements.upsertRun.run(...RUN_COLUMNS.map((column) => row[column]))
      return row
    },

    appendStep(step = {}) {
      guard()
      statements.upsertStep.run(
        text(step.run_id ?? step.runId),
        text(step.stage_id ?? step.stageId),
        text(step.job_id ?? step.jobId),
        int(step.idx, 0),
        text(step.name),
        text(step.command),
        text(step.status),
        int(step.exit_code ?? step.exitCode, 0),
        int(step.duration_ms ?? step.durationMs, 0),
        int(step.attempts, 1),
        int(step.timeout_s ?? step.timeoutSec, 0),
        text(step.log_path ?? step.logPath),
        text(step.started_at ?? step.startedAt),
        text(step.finished_at ?? step.finishedAt),
        text(step.runner_id ?? step.runnerId),
      )
      return step
    },

    appendArtifact(artifact = {}) {
      guard()
      statements.insertArtifact.run(
        text(artifact.run_id ?? artifact.runId),
        text(artifact.path),
        int(artifact.bytes, 0),
        text(artifact.sha256),
        text(artifact.created_at ?? artifact.createdAt) || new Date().toISOString(),
      )
      return artifact
    },

    appendRelease(release = {}) {
      guard()
      statements.upsertRelease.run(
        text(release.id),
        text(release.project_id ?? release.projectId),
        text(release.target),
        text(release.host),
        text(release.env),
        text(release.run_id ?? release.runId),
        text(release.commit ?? release.commit_sha),
        text(release.status),
        text(release.created_at ?? release.createdAt),
        text(release.activated_at ?? release.activatedAt),
        text(release.deactivated_at ?? release.deactivatedAt),
        text(release.manifest_path ?? release.manifestPath),
        int(release.revisions_offset ?? release.revisionsOffset, 0),
        text(release.previous),
        text(release.artifact_sha256 ?? release.artifactSha256),
        text(release.artifact_digest ?? release.artifactDigest),
        text(release.mode),
        text(release.strategy),
        // instances 存 JSON 字符串而不是另开一张表：一份 release 行的实例清单永远是「那一刻的快照」，
        // 它不该跟着别的 release 一起变，也不需要按端口查询。真要做「按实例查历史」时再加派生索引。
        typeof release.instances === 'string'
          ? release.instances
          : JSON.stringify(Array.isArray(release.instances) ? release.instances : []),
        text(release.operator),
        text(release.version),
      )
      return release
    },

    appendOperation(operation = {}) {
      guard()
      const detail = typeof operation.detail === 'string' ? operation.detail : JSON.stringify(operation.detail ?? null)
      const action = text(operation.action ?? operation.kind)
      statements.insertOperation.run(
        text(operation.run_id ?? operation.runId),
        text(operation.kind ?? action),
        action,
        text(operation.project),
        text(operation.target),
        text(operation.host),
        text(operation.release_id ?? operation.releaseId),
        text(operation.status),
        text(detail),
        text(operation.at) || new Date().toISOString(),
      )
      return operation
    },

    runs({ project = '', limit = 50 } = {}) {
      guard()
      return statements.selectRuns.all(text(project), text(project), limitOf(limit)).map(runOut)
    },

    run(id) {
      guard()
      const row = statements.selectRun.get(text(id))
      return row ? runOut(row) : null
    },

    stepsOf(runId) {
      guard()
      return statements.selectSteps.all(text(runId))
    },

    artifactsOf(runId) {
      guard()
      return statements.selectArtifacts.all(text(runId))
    },

    releases({ target = '', host = '', env = '', limit = 50 } = {}) {
      guard()
      return statements.selectReleases
        .all(text(target), text(target), text(host), text(host), text(env), text(env), limitOf(limit))
        .map(releaseOut)
    },

    release(id) {
      guard()
      return releaseOut(statements.selectRelease.get(text(id)))
    },

    activeRelease({ target = '', host = '' } = {}) {
      guard()
      return releaseOut(statements.selectActive.get(text(target), text(target), text(host), text(host)))
    },

    operations({ project = '', runId = '', limit = 50 } = {}) {
      guard()
      return statements.selectOperations
        .all(text(project), text(project), text(runId), text(runId), limitOf(limit))
        .map((row) => ({
          id: int(row.id, 0),
          at: text(row.at),
          action: text(row.action || row.kind),
          project: text(row.project),
          target: text(row.target),
          host: text(row.host),
          runId: text(row.run_id),
          releaseId: text(row.release_id),
          status: text(row.status),
          detail: text(row.detail),
        }))
    },

    projects() {
      guard()
      return statements.selectProjects.all().map(projectOut)
    },

    project(id) {
      guard()
      return projectOut(statements.selectProject.get(text(id)))
    },

    upsertProject(project = {}) {
      guard()
      const row = projectRow(project)
      statements.upsertProject.run(...PROJECT_COLUMNS.map((column) => row[column]))
      return row
    },

    logPath(runId) {
      if (!/^[A-Za-z0-9_-]+$/.test(String(runId))) throw new Error('runId 不合法')
      return join(logsDir, `${runId}.log`)
    },

    /**
     * v3.0-P1：单个 job 的日志文件（`logs/<runId>/<jobId>.log`）。
     * 主日志是一条按时间合并的时间线，并行 job 全写进去必然交错；分开存一份，
     * 「这个 job 到底输出了什么」才能按 job 读，而不是靠人眼在大杂烩里挑。
     * jobId 里的 `[`、`]`、`=`、`,` 会被替换掉：它们是 matrix 实例名的一部分，但在 Windows 上是非法文件名字符。
     */
    jobLogPath(runId, jobId) {
      if (!/^[A-Za-z0-9_-]+$/.test(String(runId))) throw new Error('runId 不合法')
      const safe = String(jobId).replace(/[^A-Za-z0-9_.-]+/g, '_')
      if (!safe) throw new Error('jobId 不合法')
      return join(logsDir, String(runId), `${safe}.log`)
    },

    readJobLog(runId, jobId, { tail = 0 } = {}) {
      const file = this.jobLogPath(runId, jobId)
      if (!existsSync(file)) return ''
      return sliceTail(readFileSync(file, 'utf8'), tail)
    },

    /** 这次运行里所有有独立日志的 job（按文件名排序，便于稳定展示）。 */
    jobLogs(runId) {
      if (!/^[A-Za-z0-9_-]+$/.test(String(runId))) return []
      const dir = join(logsDir, String(runId))
      if (!existsSync(dir)) return []
      return readdirSync(dir)
        .filter((name) => name.endsWith('.log'))
        .sort()
        .map((name) => {
          const file = join(dir, name)
          const stat = statSync(file)
          return { jobId: name.slice(0, -4), bytes: stat.size, updatedAt: stat.mtime.toISOString() }
        })
    },

    readLog(runId, { tail = 0 } = {}) {
      const file = this.logPath(runId)
      if (!existsSync(file)) return ''
      return sliceTail(readFileSync(file, 'utf8'), tail)
    },

    stats() {
      guard()
      const runs = db.prepare('SELECT COUNT(*) AS n FROM runs').get()
      const releases = db.prepare('SELECT COUNT(*) AS n FROM releases').get()
      const steps = db.prepare('SELECT COUNT(*) AS n FROM steps').get()
      return { runs: int(runs?.n, 0), releases: int(releases?.n, 0), steps: int(steps?.n, 0), dbFile }
    },

    close() {
      if (closed) return
      closed = true
      try { db.close() } catch { /* 关闭失败不影响进程退出 */ }
    },
  }

  api.legacyImported = migrateLegacy()
  return api
}