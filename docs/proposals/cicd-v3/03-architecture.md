# 03 · 目标架构

> 本章定义「要建成什么」。所有字段、状态、协议以本章为准；`04`–`09` 是各子系统的展开。
> 设计原则：**实体优先于页面，契约优先于命令，默认拒绝优先于默认允许。**

---

## 1. 目标与非目标

### 1.1 目标（本方案要达成的）

| # | 目标 | 可验证的验收 |
|---|---|---|
| G1 | 一条流水线从 checkout 到部署全程可复现 | 同一 commit + 同一 `pipe.lock` 在任意 runner 上产物 digest 相同 |
| G2 | 多语言构建环境隔离 | 同机并发构建 JDK17 与 JDK21 项目互不污染，宿主 PATH 不变 |
| G3 | 制品是一等公民 | 每次构建产出可寻址 digest；部署只引用 digest；可跨主机/跨环境提升 |
| G4 | 原生 / 容器两种部署共用一套 release 语义 | 两种 driver 都能「部署→健康门→失败自动回滚→保留 N 版」 |
| G5 | 多主机 × 多实例 | 一个 target 声明 N 台主机 × M 个实例，逐实例健康检查与权重 |
| G6 | 权限闭环 | 未授权请求在服务端被拒（不是 UI 隐藏）；每次写操作可追到 actor |
| G7 | 交互闭环 | 每个实体有 URL；任一页面刷新不丢上下文；破坏性操作有明确护栏 |
| G8 | 可扩展 | 新增语言 = 加模板 + 工具链 provider；新增部署形态 = 加 driver；不改内核 |

### 1.2 非目标（明确不做，避免滑向 Jenkins）

- ❌ 图灵完备的 DSL（不引入 Groovy/JS 脚本作为流水线语言）
- ❌ 通用工作流编排（不是 Argo Workflows / Temporal）
- ❌ 多租户 SaaS 计费、跨组织联邦
- ❌ 自研容器编排（k8s driver 只做 `kubectl apply/rollout`，不自建 scheduler）
- ❌ 分布式数据库（单机 SQLite 起步，多副本用「单写 + 读副本」而非分片）
- ❌ 在 P1–P2 阶段做 ReBAC（Zanzibar），但权限判定必须收敛到单一 `can()` 函数以便替换

---

## 2. 分层架构

```
┌────────────────────────────── 体验层 (client.js) ──────────────────────────────┐
│ 全局侧栏 · 项目上下文 · 页面级主操作 · 深链路由 · 表单/YAML 双模 · 日志查看器    │
└───────────────────────────────────┬────────────────────────────────────────────┘
                                    │ REST /api/plugins/cicd/v1/*  +  WS /ws/runs/:id
┌───────────────────────────────────┴────────────────────────────────────────────┐
│ 接入层  authn → authz(can) → 参数校验 → 幂等键 → 审计                           │
├────────────────────────────────────────────────────────────────────────────────┤
│ 领域层                                                                          │
│  Project · Pipeline(+Revision) · Run · Job · Step · Artifact · Environment      │
│  Target · Instance · Release · Runner · User/Role · Approval · Secret           │
├────────────────────────────────────────────────────────────────────────────────┤
│ 编排层  Planner（DAG/矩阵/when 求值） · Scheduler（cron/push/manual） ·         │
│         Dispatcher（能力匹配 + 租约） · Reconciler（孤儿/超时/重试）              │
├────────────────────────────────────────────────────────────────────────────────┤
│ 执行层  Runner（local / remote） · WorkspaceManager · ToolchainResolver ·       │
│         StepExecutor（run / uses:*） · CacheManager · ArtifactPacker            │
├────────────────────────────────────────────────────────────────────────────────┤
│ 部署层  Driver: native | compose | docker | k8s · Strategy: serial/parallel/     │
│         rolling/canary/bluegreen · HealthGate · TrafficSwitch · Rollback        │
├────────────────────────────────────────────────────────────────────────────────┤
│ 存储层  SQLite（元数据/状态） · CAS 文件树（制品/缓存/日志/工具链） ·            │
│         可选外部：Nexus/Artifactory/Harbor/OCI Registry                         │
└────────────────────────────────────────────────────────────────────────────────┘
```

三条硬边界：

1. **控制面不执行构建**。DSH 宿主只是一个 runner（`local`），也走同一套 Runner 协议——这样本地与远端行为一致，不存在「本机能跑远端不能跑」的双标。
2. **执行层不碰数据库**。Runner 只通过 HTTP 协议与租约通信，便于换语言重写（Go 版 runner 是 P3）。
3. **部署层不碰构建**。部署输入只有 `artifact digest + target 配置快照`，不允许「部署时再编译」。

---

## 3. 领域模型

### 3.1 实体与关系

```
Project 1─n Pipeline 1─n PipelineRevision
   │                    │
   │                    └─n Run 1─n Job 1─n Step
   │                          │      │
   │                          │      ├─n Artifact（构建产物，CAS）
   │                          │      └─n LogSegment
   │                          └─n Approval（部署审批）
   │
   ├─n Environment 1─n Target 1─n Instance（声明式，来自 pipeline 配置）
   ├─n Secret
   ├─n Membership（user × role）
   └─n Schedule / Webhook

Runner 1─n RunnerToken
Release（= 一次成功部署） n─1 Run，n─1 Environment，1─n InstanceRelease
AuditEvent（append-only，哈希链）
```

### 3.2 不变量（实现时必须断言）

| ID | 不变量 | 违反后果 |
|---|---|---|
| I1 | 一个 Release 必须绑定一个不可变 Artifact digest | 部署「当前目录」导致不可复现 |
| I2 | PipelineRevision 一旦被 Run 引用即不可修改（内容寻址 hash） | 运行中改配置，历史无法解释 |
| I3 | 同一 (project, environment) 同一时刻最多一个 in-flight deployment | 并发发布互相覆盖 |
| I4 | Run 的每个 Job 在任一时刻只被一个 Runner 持有租约 | 重复执行 |
| I5 | Secret 明文永不出现在 API 响应、日志、DB 明文列 | 泄漏 |
| I6 | 所有写操作经过 `can(actor, action, resource)` | 越权 |
| I7 | Artifact blob 一旦写入不可修改（按 digest 校验） | 供应链投毒 |
| I8 | 部署记录必须先于「切换流量」持久化 | 失败后无法回滚 |

### 3.3 实体字段（精简版，完整 DDL 见 §7）

**Project**：`id, name, slug, source{type,url,ref,submodules,lfs}, default_branch, toolchain_defaults, created_at`。
**Pipeline**：`id, project_id, name, path(pipe.yml), revision_id, enabled`。
**PipelineRevision**：`id, pipeline_id, hash(sha256 of normalized config), source_yaml, parsed_json, lock_json, created_by, created_at`。
**Run**：`id(YYYYMMDD-HHmmss-6hex), project_id, pipeline_id, revision_id, trigger{type,actor,ref,sha}, status, env_snapshot, started_at, finished_at, error_code`。
**Job**：`id, run_id, stage_id, name, kind(build|deploy|verify), status, runner_id, lease_until, attempt, max_attempts, started_at, finished_at`。
**Step**：`id, job_id, idx, kind(run|uses), name, command|action, status, exit_code, duration_ms, log_path`。
**Artifact**：`id, run_id, job_id, name, media_type, digest, size, file_count, manifest_path, provenance_json, retention_until`。
**Environment**：`id, project_id, name, protection{approvals_required, allowed_roles, allowed_branches, wait_sec}`。
**Target**：来自 pipeline 配置（不落库为可变实体），运行期快照进 `Run.env_snapshot`。
**Release**：`id, project_id, environment_id, target_name, artifact_digest, config_hash, status, previous_release_id, created_at, activated_at`。
**InstanceRelease**：`release_id, host, instance_index, port, status, health, activated_at`。
**Runner**：`id, name, labels[], platform, arch, capacity, status(online|draining|offline), version, capabilities_json, last_seen_at, disk_free_bytes`。
**User/Role/Membership**：`users(id, email, password_hash, totp_secret, status)`、`memberships(user_id, project_id, role)`。
**Approval**：`id, run_id, release_candidate_digest, environment_id, requested_by, requested_at, expires_at, status, decided_by, decided_at, comment`。
**Secret**：`id, project_id, environment_id, name, ciphertext, nonce, key_version, scope, created_by, rotated_at`。

---

## 4. 状态机

### 4.1 Run

```
queued ──▶ running ──▶ succeeded
   │           │
   │           ├──▶ failed
   │           ├──▶ canceled
   │           └──▶ waiting_approval ──▶ running ──▶ ...
   └──▶ skipped（when 不满足 / 上游失败且非 always）
```

- `waiting_approval` 必须有 `expires_at`；到期 → `failed(approval_timeout)`，**不允许永久 pending**。
- 终态集合：`succeeded | failed | canceled | skipped`。`running` 下的子状态（`waiting_resource`、`waiting_approval`）用 `phase` 字段表达，不污染 status。

### 4.2 Job

```
pending ─▶ assigned(lease) ─▶ running ─▶ succeeded | failed | canceled | skipped
                 │                │
                 └── lease 过期 ──┴─▶ pending(attempt+1)  // 仅幂等 job
```

- 租约默认 `leaseSec=900`，runner 每 15s 心跳续租；连续 2 个周期失联 → 判死、回收。
- 自动重试只对 `attempt < max_attempts && step.idempotent !== false`；`deploy` 默认不自动重试（避免重复发布），改为「回滚 + 人工确认」。

### 4.3 Deployment / Release

```
pending ─▶ preparing(upload/解压/迁移) ─▶ activating(切链接/切流量)
   │              │                              │
   │              └──▶ failed(rolled_back)        ├──▶ healthy ──▶ active
   └──▶ rejected(审批拒)                          └──▶ unhealthy ──▶ rolling_back ──▶ superseded
```

`Release.status ∈ pending|preparing|activating|active|superseded|rolled_back|failed`。
**顺序硬约束**：`preparing` 完成 → 写 `Release` + `InstanceRelease(status=preparing)` → `activating` → 健康检查 → 写 `active`。任何一步失败，`previous_release_id` 已在 `preparing` 阶段持久化，所以回滚不依赖内存。

### 4.4 Approval

```
pending ──▶ approved
   ├──▶ rejected
   └──▶ expired（TTL 到）
```

- `approved` 只对该 `release_candidate_digest` 有效一次。
- `requested_by == decided_by` 一律拒绝（服务端校验，不靠 UI）。

---

## 5. 执行协议（Runner v2）

现有协议只传 `{command, cwd, env}`，是「远程 shell」。v2 改为**任务描述 + 分阶段上报**。

### 5.1 端点

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/v1/runners/register` | 一次性 join token 换长期 runner token + 能力上报 |
| POST | `/v1/runners/:id/heartbeat` | 心跳 + 负载 + 磁盘 + 工具链缓存命中率 |
| POST | `/v1/runners/:id/claim` | 长轮询领取任务（返回任务描述或 204） |
| POST | `/v1/runners/:id/tasks/:taskId/logs` | 批量日志行（带 seq，幂等去重） |
| POST | `/v1/runners/:id/tasks/:taskId/complete` | 终态 + 产物清单 + 退出码 |
| PUT | `/v1/runners/:id/tasks/:taskId/artifacts/:name` | 流式上传制品 blob |
| POST | `/v1/runners/:id/drain` | 排空：不再领新任务，跑完当前 |

### 5.2 任务描述（claim 响应）

```jsonc
{
  "taskId": "tsk_01H...",
  "runId": "20261118-131500-a1b2c3",
  "jobId": "build/package",
  "leaseSec": 900,
  "workspace": {
    "root": "/var/lib/dsh-cicd/ws/20261118-131500-a1b2c3/build-package",
    "clean": true,
    "ttlSec": 3600
  },
  "source": { "type": "git", "url": "git@...", "ref": "main", "sha": "abc123", "depth": 1 },
  "toolchain": { "java": "temurin-17.0.11", "maven": "3.9.6" },
  "env": { "CI": "1", "NODE_ENV": "production" },
  "secretRefs": ["MAVEN_MIRROR_PASSWORD"],          // 值由 runner 用短期凭据拉取，不进任务体
  "caches": [{ "key": "m2-<hash>", "paths": ["~/.m2/repository"], "mode": "rw" }],
  "steps": [
    { "index": 0, "kind": "uses", "action": "checkout" },
    { "index": 1, "kind": "uses", "action": "toolchain" },
    { "index": 2, "kind": "run", "command": "mvn -B -DskipTests package", "timeoutSec": 900 },
    { "index": 3, "kind": "uses", "action": "collect", "with": { "from": "target/*.jar", "name": "app.jar" } }
  ],
  "artifacts": [{ "name": "app.jar", "mediaType": "application/java-archive" }],
  "logStream": { "endpoint": "/v1/runners/r1/tasks/tsk_01H.../logs", "batchMs": 250 }
}
```

设计要点：

- **secret 不进任务体**：只传引用，runner 用 runner token 换短期 secret（TTL 与租约同长），避免任务日志/队列/DB 出现明文。
- **workspace 由控制面分配、runner 执行清理**：解决「项目目录被当构建目录」的根问题。
- **caches 是声明式的**：runner 负责挂载/回写，控制面只存 key 元数据与命中统计。
- **artifact 上传走 runner → 控制面**：跨 NAT 场景下不要求目标机可回连；大文件用分块 PUT + `Content-Digest` 校验。

### 5.3 幂等与去重

- `register`：同一 `runnerId` 重复注册 = 轮换 token，旧 token 立即失效。
- `logs`：按 `(taskId, seq)` 去重，允许乱序补发。
- `complete`：同一 taskId 重复提交返回既有结果（幂等），不重复发通知。
- 触发去重：`(project_id, ref, sha, pipeline_id)` 在 `dedupe_window_sec`（默认 300）内只建一个 Run。

---

## 6. 一次运行的数据流（时序）

```
UI/CLI/Webhook
   └─▶ POST /runs {project, pipeline, ref, target, inputs}
         ├─ authn → authz(can(run, project))
         ├─ Planner: parse(pipe) → normalize → resolve targets → evaluate when/matrix
         │            → build DAG → 生成 Job 列表（含 matrix 展开）
         ├─ 创建 Run(status=queued) + 首个 stage 的 Jobs(status=pending)
         └─ 返回 runId（202）
Dispatcher (loop)
   ├─ 能力匹配: job.requires(labels, toolchain, os) × runner.capabilities
   ├─ 租约: UPDATE jobs SET runner_id=?, lease_until=? WHERE id=? AND status='pending'
   └─ runner.claim 返回任务
Runner
   ├─ checkout → 精确 sha 的独立 workspace
   ├─ toolchain → 解析/安装/注入（内容寻址）
   ├─ caches → 挂载（未命中则空目录）
   ├─ steps → 顺序执行，逐行上报日志
   ├─ collect → 打包 → PUT blob → complete(artifacts[])
   └─ 回写 caches
Dispatcher
   ├─ 校验 digest → 写 artifacts → 解锁下游（needs 满足）
   └─ 全部 job 完成 → Run 终态 → 通知 + 指标
Deploy Job
   ├─ 审批门（environment.protection）→ 可能 waiting_approval
   ├─ Driver.prepare(artifact, target) → 写 Release(preparing)
   ├─ Driver.activate(instance…) → 健康检查
   └─ 成功 → active；失败 → Driver.rollback(previous)
```

---

## 7. 数据模型（SQLite schema v6）

从 v5 迁移：保留 `runs/steps/artifacts/releases/operations`，新增表并与旧列映射。

```sql
-- 项目与流水线
CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE,
  source_type TEXT NOT NULL DEFAULT 'local',      -- local|git
  repo_url TEXT DEFAULT '', default_branch TEXT DEFAULT '',
  path TEXT NOT NULL, pipe_path TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE pipelines (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL, path TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  current_revision_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE pipeline_revisions (
  id TEXT PRIMARY KEY, pipeline_id TEXT NOT NULL REFERENCES pipelines(id),
  hash TEXT NOT NULL,                               -- sha256(normalized)
  source_yaml TEXT NOT NULL, parsed_json TEXT NOT NULL, lock_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT DEFAULT '', created_at TEXT NOT NULL,
  UNIQUE (pipeline_id, hash)
);

-- 运行
CREATE TABLE runs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, pipeline_id TEXT NOT NULL,
  revision_id TEXT NOT NULL, trigger_type TEXT NOT NULL, trigger_actor TEXT DEFAULT '',
  ref TEXT DEFAULT '', sha TEXT DEFAULT '', status TEXT NOT NULL,
  phase TEXT DEFAULT '',                            -- waiting_approval|waiting_resource
  target TEXT DEFAULT '', env_snapshot TEXT DEFAULT '{}', inputs_json TEXT DEFAULT '{}',
  error_code TEXT DEFAULT '', started_at TEXT, finished_at TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX idx_runs_project_status ON runs(project_id, status, started_at DESC);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), stage_id TEXT NOT NULL,
  name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'build',
  status TEXT NOT NULL DEFAULT 'pending', phase TEXT DEFAULT '',
  runner_id TEXT DEFAULT '', lease_until TEXT, attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1, required_json TEXT DEFAULT '{}',
  started_at TEXT, finished_at TEXT
);
CREATE INDEX idx_jobs_run ON jobs(run_id, stage_id);
CREATE INDEX idx_jobs_pending ON jobs(status, run_id) WHERE status='pending';

-- 制品（元数据）；blob 在文件系统 CAS
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, job_id TEXT NOT NULL,
  name TEXT NOT NULL, media_type TEXT NOT NULL,
  digest TEXT NOT NULL,                             -- sha256:<hex>
  size INTEGER NOT NULL, file_count INTEGER NOT NULL DEFAULT 1,
  manifest_path TEXT NOT NULL, provenance_json TEXT NOT NULL DEFAULT '{}',
  retention_until TEXT, created_at TEXT NOT NULL,
  UNIQUE (run_id, job_id, name)
);
CREATE INDEX idx_artifacts_digest ON artifacts(digest);

-- 环境 / 发布
CREATE TABLE environments (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
  protection_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
  UNIQUE (project_id, name)
);
CREATE TABLE releases (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  target_name TEXT NOT NULL, artifact_digest TEXT NOT NULL,
  config_hash TEXT NOT NULL, status TEXT NOT NULL,
  previous_release_id TEXT DEFAULT '', run_id TEXT DEFAULT '',
  created_at TEXT NOT NULL, activated_at TEXT, finished_at TEXT
);
CREATE TABLE instance_releases (
  id TEXT PRIMARY KEY, release_id TEXT NOT NULL REFERENCES releases(id),
  host TEXT NOT NULL, instance_index INTEGER NOT NULL DEFAULT 0, port INTEGER,
  status TEXT NOT NULL, health TEXT DEFAULT '', detail_json TEXT DEFAULT '{}',
  activated_at TEXT, UNIQUE (release_id, host, instance_index)
);

-- 审批
CREATE TABLE approvals (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  artifact_digest TEXT NOT NULL, requested_by TEXT NOT NULL, requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT, decided_at TEXT, comment TEXT DEFAULT ''
);

-- 身份
CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, display_name TEXT DEFAULT '',
  password_hash TEXT DEFAULT '', totp_secret TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL
);
CREATE TABLE memberships (
  user_id TEXT NOT NULL, project_id TEXT NOT NULL, role TEXT NOT NULL,
  PRIMARY KEY (user_id, project_id)
);
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT DEFAULT '',
  token_hash TEXT NOT NULL, scopes TEXT NOT NULL DEFAULT '[]',
  project_scope TEXT DEFAULT '*', expires_at TEXT, last_used_at TEXT, revoked_at TEXT
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT, expires_at TEXT,
  ip TEXT DEFAULT '', user_agent TEXT DEFAULT ''
);

-- 密钥
CREATE TABLE secrets (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, environment_id TEXT DEFAULT '',
  name TEXT NOT NULL, ciphertext BLOB NOT NULL, nonce BLOB NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1, created_by TEXT, rotated_at TEXT,
  UNIQUE (project_id, environment_id, name)
);

-- 审计（哈希链）
CREATE TABLE audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
  actor_id TEXT DEFAULT '', auth_method TEXT DEFAULT '', token_id TEXT DEFAULT '',
  action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
  project_id TEXT DEFAULT '', result TEXT NOT NULL, reason TEXT DEFAULT '',
  source_ip TEXT DEFAULT '', request_id TEXT DEFAULT '',
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);

-- 构建机
CREATE TABLE runners (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, labels TEXT NOT NULL DEFAULT '[]',
  platform TEXT DEFAULT '', arch TEXT DEFAULT '', capacity INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'offline', version TEXT DEFAULT '',
  capabilities_json TEXT DEFAULT '{}', last_seen_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE runner_tokens (
  id TEXT PRIMARY KEY, runner_id TEXT NOT NULL, token_hash TEXT NOT NULL,
  kind TEXT NOT NULL,                               -- join|runner
  expires_at TEXT, used_at TEXT, revoked_at TEXT
);
```

> 说明：`runs.target/env_snapshot` 保存**运行期快照**，而不是外键指向可变的 target 配置——这样历史运行永远能解释「当时部署到哪、用什么配置」。

---

## 8. 一致性、并发与多副本

| 场景 | 单机实现 | 多副本演进（预留） |
|---|---|---|
| 部署锁 | `locks` 表 `INSERT OR IGNORE (project,env)` + 租约到期 | 同上（DB 唯一约束天然跨副本） |
| 任务派发 | 事务内 `UPDATE jobs SET runner_id=? WHERE status='pending' LIMIT 1` | 同上，读副本只读 |
| 日志写入 | 每 job 单文件 append + `fsync` 批量 | 对象存储分段上传 |
| 缓存并发 | 目录锁（`.lock` 文件 + `flock`） | 同上（共享文件系统） |
| 迁移 | `PRAGMA user_version` 顺序迁移 | 迁移前置 advisory lock |

明确不做：内存 `Map` 作为唯一权威（现有 `deployLocks` 就是这种，重启即丢）。

---

## 9. 可观测性

- **日志**：每 job 一个分段文件 `logs/<runId>/<jobId>/0001.log`，行级 `seq`；WS 订阅 `(runId, jobId)`，支持 `?sinceSeq=` 回放；单行超 64KB 截断并标注。
- **事件**：`audit_events`（安全）+ `run_events`（生命周期，可清理）。两者分离，避免审计被日志量淹没。
- **指标**（Prometheus 文本端点 `/metrics`）：`cicd_runs_total{status}`、`cicd_job_duration_seconds`、`cicd_queue_wait_seconds`、`cicd_deploy_total{env,result}`、`cicd_artifact_bytes`、`cicd_cache_hit_ratio`。
- **DORA**：部署频率 = `releases activated`；前置时间 = `first_commit → release.activated_at`（需要 commit 时间，见 `lib/git.js:commitDate`）；失败率 = `releases failed|rolled_back / all`；MTTR = `failed → 下一次 active` 的中位数。

---

## 10. 信任边界

```
[浏览器] --session/PAT--> [控制面] --runner token--> [runner] --ssh key--> [目标主机]
   同源/CSRF             授权/审计            短期 secret        最小权限账号
```

- 浏览器永不接触目标主机凭据；runner 只拿「本次任务需要的」secret（短期）。
- 目标主机凭据由 dsh-remote 管理（已有），CI/CD 不复制私钥，只引用别名。
- 制品 blob 对 runner 只写不读（除非部署任务显式下载），防止横向拉取他项目产物。
- 生产环境额外要求：审批 + 允许分支/tag + artifact digest 与审批时一致（防「批了 A 发了 B」）。

---

## 11. 技术选型

| 关注点 | 选择 | 理由 |
|---|---|---|
| 运行时 | Node.js ≥ 22（现有 `node:sqlite`） | DSH 插件生态即 Node，零外部依赖 |
| 存储 | SQLite（WAL）+ 文件 CAS | 单机零运维；CAS 可直接换成 S3 兼容 |
| YAML | 现有受限解析器 + 显式 schema 校验 | 不引入 `js-yaml` 的隐式类型陷阱（`on:`/`yes`） |
| Schema | JSON Schema 2020-12（`schemas/pipe.schema.json`） | 前后端共用；编辑器可自动补全 |
| HTTP | 现有 webServer 路由 | 不新起端口 |
| 日志流 | 现有 `ws` + 分段文件 | 已可用，改成分 job |
| 工具链下载 | `fetch` + 流式落盘 + sha256/sha512 校验 | 无第三方包管理器依赖 |
| 容器 | `docker`/`podman` CLI（不引 SDK） | 兼容性最好，失败信息直接可见 |
| 测试 | `node:test` + 真实临时目录 + fake runner | 现有 `test/smoke.mjs` 风格 |

---

## 12. 与现有代码的映射（改造清单）

| 现有文件 | 动作 | 说明 |
|---|---|---|
| `lib/pipe.js` | 重写 | 支持 v2；保留 v1 解析器做兼容层 |
| `lib/runner.js` | 拆分 | 变成 `scheduler`（DAG/矩阵）+ `jobRunner`（单 job） |
| `lib/executors.js` | 扩展 | 任务描述协议 v2；保留 broker 拉取模型 |
| `lib/deploy.js` | 重构 | 抽 `Driver` 接口；native driver 沿用 symlink 逻辑 |
| `lib/db.js` | 迁移 | v5 → v6；旧表加列 + 新表 |
| `lib/scaffold.js` | 替换 | 模板包加载器（内置 + 用户目录 + 远程） |
| `lib/rbac.js` | 扩展 | 从「token 工具」变成 `can()` 的存储与判定 |
| `index.js` | 拆分 | 路由按资源拆模块；统一 `authorize` 中间件 |
| `client.js` | 重写外壳 | 保留组件，重做 IA/路由/页面 |
