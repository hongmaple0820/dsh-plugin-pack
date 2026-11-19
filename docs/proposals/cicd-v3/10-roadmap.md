# 10 · 实施路线图（可落地）

> 回答的问题：**「给一份能真正做出来的方案。」**
> 原则：**先修信任模型与导航（P0），再做执行内核（P1–P3），最后做体验（P6）。**
> 不要一边补 UI 一边改调度器——两件事会互相阻塞，且 P0 的收益最高、风险最低。

---

## 0. 现状与目标

| 维度 | 现状 | 目标（12 个月内） |
|---|---|---|
| 执行模型 | stage/step 全串行 | job DAG + 并发池 + 矩阵 |
| 语言支持 | 5 个硬编码脚手架 | 8 语言 + 自定义模板 + 工具链锁 |
| 制品 | 工作区 glob | CAS + digest + promotion |
| 部署 | 单机 tgz 软链 | 多主机/多实例 + native/container/k8s |
| 权限 | 写路由无校验 | `can()` 默认拒绝 + 审批 + 审计链 |
| UI | 13 按钮平铺、无路由 | 侧栏 + 深链 + 三栏编辑器 |

---

## 1. 阶段划分

```
P0 止血(2w) ──┬─→ P1 DSL内核(4w) ──┬─→ P3 部署引擎(4w)
              │                    │
              └─→ P2 工具链(3w) ───┘
P0 ─→ P4 安全/审批(3w, 与 P1 并行)
P1+P2+P3 ─→ P5 制品库(3w) ─→ P6 体验(4w) ─→ P7 加固(持续)
```

依赖关系是硬的：**没有 P1 的 job 抽象，P3 的部署就无法成为独立 job；没有 P0 的 `can()`，P4 无处挂载。**

---

## 2. P0 · 止血（2 周，先做，可独立发布）

**目标：让「谁在操作」与「现在在哪个项目」变成可回答的问题。**

> **状态：已交付（v3.0.0-p0）**，8 条验收全部成为 `packages/dsh-cicd/test/smoke.mjs` 里的可执行检查（第 75–82 条，`82 checks passed`）。实现与下表有两处有意的偏离，理由写在同列：
> - **P0-1 用 scrypt 而非 argon2id**：argon2id 需要原生编译（`node-gyp` + C 工具链），与本包「零第三方运行时依赖、纯 JS」的既有约束冲突，会让 Windows 用户装不上。scrypt 是 Node 内置（`node:crypto`），同为内存困难 KDF，参数 `N=2^15, r=8, p=1`。注意 `maxmem` 必须按 `128*N*r` 显式给足：默认 32 MiB 恰好等于该参数组合的需求，会直接抛 `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`（已踩，见 `lib/auth.js` 的 `scryptOptions`）。
> - **P0-6 用 hash 路由而非新 `AppShell` + `history.pushState`**：面板是挂进宿主页面的，改写宿主路径会让宿主刷新 404；`#/...` 只动片段，宿主路由不受影响。旧 `CicdPanelPage` 仍是唯一入口，未做双壳并存（少一层 fallback 就少一处长期不删的死代码）。

| # | 任务 | 交付物 | 验收 |
|---|---|---|---|
| P0-1 ✅ | 认证中间件 | `lib/auth.js`：本地账号（**scrypt**）+ 会话 cookie（12h，HttpOnly/SameSite=Strict）+ API token（`cicd_<id>_<secret>`，只存 sha256，scope/expiry/revoke）+ 引导期 bootstrap | 未登录访问写路由 → 401；token 过期 → 401 ✅ |
| P0-2 ✅ | `can()` 判定层 | `lib/policy.js`：actor×action×resource，**17 动作 × 4 角色**，默认拒绝，永不抛 | 单测覆盖 4 角色 × 17 动作矩阵（`policyMatrix()`）✅ |
| P0-3 ✅ | 所有写路由接入 | `index.js` 的 `authorize()` / `authorizeRead()` 取代旧 `requireWrite`，一路一判权 + 一路一审计 | 越权 100% 返回 403 + 审计 deny ✅ |
| P0-4 ✅ | 部署锁落库 | `deploy_locks` 表 + TTL + 心跳续期 + `forceRelease` 审计 | 重启服务后并发仍互斥 ✅ |
| P0-5 ✅ | 审计表 + 哈希链 | `audit_events`（`prev_hash`/`hash`）+ `cicd_audit verify` | 篡改一行能被检出（`kind: hash`）✅ |
| P0-6 ✅ | 前端壳：路由 + 侧栏 + 项目切换器 | hash 路由 + 左侧导航（流水线/配置/管理）+ 面包屑 + 复制链接 | 刷新不丢视图；URL 可分享 ✅ |
| P0-7 ✅ | 运行详情页（复用现有组件） | `#/projects/:p/runs/:id?line=1204` | 深链打开同一 run 同一行日志（`?line=` 高亮并滚动）✅ |

**产出**：v3.0-p0，一次线上可用的小版本。**不改 DSL**，纯加壳与加锁。

实现过程中被这套验收抓出来的真实缺陷（都已修，记在这里避免重犯）：

1. **审批门把 `APPROVAL_CONSUMED` 降级成「再批一次」**：显式带了 `approvalId` 却消费失败时，原逻辑会继续 `request()` 一条新 pending，于是「同一审批用于第二个 digest」永远测不出来。现在只对 `APPROVAL_REQUIRED` 继续走申请，其余直接抛。
2. **scrypt 参数卡在 Node 默认 `maxmem` 边界** → 建用户/登录全 500，整套身份系统等于不存在。
3. **部署锁泄漏**：`heldLock` 赋值到 `try` 之间隔着审批门与 runner 判活，这两条路径抛出时锁不会释放，target 被占死到 TTL 到期。
4. **`auditList` 把数组摊进对象** → `/audit` 返回 `{"ok":true}`，客户端拿到的是数字键垃圾。
5. **自批检查永不命中**：`requestedBy` 存 `actor.id`，`resolvedBy` 却优先取 `actor.email`，两条不同的字符串。
6. **secret 插值失效**：把 secret 摊在 `env` 顶层无效，`planPipeline` 只读 `env.vars`，导致 `${{SECRET}}` 抛 `PIPE_VAR`。

---

## 3. P1 · DSL v2 与调度内核（4 周）

> **状态：已交付（v3.0.0-p1）**，P1-1…P1-8 全部落地，`packages/dsh-cicd/test/smoke.mjs` 从 82 增至 91 条（第 83–91 条为 P1 用例，`91 checks passed`）。P1-9 的 `uses` 动作只做到「认得出来、明确跳过」，真正的动作实现属 P2。
>
> 一处有意收窄：**没有为核心新文件引入括号 DSL**，`lib/expr.js` 是手写词法 + 递归下降求值器，不用 `eval`/`new Function`。理由：`pipe.yml` 是仓库里的文件，谁能提 PR 谁就能改它；把表达式交给真正的 JS 求值器，等于给每个能提交代码的人在构建机上开一个任意执行入口。`evaluate('process.exit(0)')` 现在返回 `PIPE_EXPR` 而不是退出进程。

| # | 任务 | 交付物 | 验收 |
|---|---|---|---|
| P1-1 ✅ | 模型归一化 | `lib/model.js`：v1 每个 stage → `<stage>-main` job，deploy step 拆成独立 `kind:'deploy'` job；v2 `stages[].jobs[]` 原样展开；`resolveJobGraph()` 统一解析三种 `needs` 写法（job id / matrix 基名 / stage id）并回写成真实 id | v1 文件零改动可跑（`P1-S2` 断言 v1 归一化结果：`build-main`、`release-deploy`）✅ |
| P1-2 ✅ | 校验器 | 8 类错误码 + 行号定位：`PIPE_CYCLE`（含环路径 `a → b → a`）、`PIPE_UNKNOWN_JOB`（带候选列表）、`PIPE_MATRIX_TOO_LARGE`、`PIPE_EXPR`、`PIPE_VAR`、`PIPE_INVALID`、`PIPE_NOT_FOUND`、`PIPE_UNSUPPORTED`；`validateExpressions()` 在解析期预检 `when`/`if` 的 T1 白名单与 `run` 里的 T2 引用 | 8 类错误各有用例（`P1-S1`/`P1-S3`/`P1-S4`）✅ |
| P1-3 ✅ | DAG 调度器 | `lib/jobs.js`：`scheduleJobs({jobs, concurrency, signal, runJob, onSkip})`，拓扑 + 并发池（默认 4，`jobs.concurrency` 可配 1–32）+ `needs` 传播；失败与 skipped 都向下传播，`allow_failure` 不阻断 | 两个无依赖 job 总耗时 ≈ max（`P1-S5`：2×120ms 实测 <220ms）、并发池上限、abort 全员 canceled ✅ |
| P1-4 ✅ | 矩阵展开 | 上限 64 实例、3 维；`matrixInstanceId()` 产出 `unit[java=17,os=linux]`（键排序）；`exclude` 精确匹配 | 实例 id 唯一、`matrix.x` 可插值（`P1-S6` 端到端两个实例并行）✅ |
| P1-5 ✅ | 三档求值 | `lib/expr.js`：T0（`event/branch/tag/paths/ref`）/ T1（加 `vars/matrix/needs/env/...`）/ T2（加 `secrets/steps/outputs`）白名单 + 函数白名单 9 个 | secrets 在 T1 引用 → `PIPE_EXPR`（`P1-S1`）✅ |
| P1-6 ✅ | 状态机 | `JOB_STATES` 12 态定义 + `REACHABLE_STATES` 7 态（P1 实际能走到）；`statusToState()` 把 run 级 status 映射到 job 级 state | 部分跳过时 `completed` 与 `succeeded` 区分开 ✅ |
| P1-7 ✅ | 配置快照 | `runs.config_snapshot`（pipe.yml 原文）+ `config_hash`（sha256）；DB v7→v8 | 改配置后旧运行仍能用当时那份配置解释自己（`P1-S8`）✅ |
| P1-8 ✅ | 日志分片 | 主日志保持合并时间线 + 每个 job 一份 `logs/<runId>/<job>.log`；`cicd_logs` 加 `jobId` 参数；面板日志区加「只看某个 job」下拉 | 并行 job 日志不混（`P1-S9`：`unit[java=17]` 分片不含 `unit[java=21]` 的输出）✅ |
| P1-9 ⏳ | `uses` 动作框架 | `buildStep()` 已把 `uses:` 归一成独立 kind，执行器**明确跳过并记一条日志**（不是把 `uses:xxx` 当命令跑）；`checkout/toolchain/cache/collect` 的实现在 P2 | 跳过而非假装成功 ✅ · 动作本身待 P2 |

**风险**：并发写日志、runner 任务分片。缓解（已实现）：日志按 `jobId` 分文件，主日志仍是合并时间线；文件名把 `[ ] = ,` 换成 `_`（matrix 实例名在 Windows 上是非法文件名）。

实现过程中被这套验收抓出来的真实缺陷（都已修）：

7. **DAG 调度器重复启动同一 job**：`launch()` 里漏了 `pending.delete(job.id)`，内层填池循环把同一个 job 反复启动，8 秒烧掉 2GB 堆（`FATAL ERROR: Reached heap limit`）。
8. **skipped 不向下传播**：`blocksDownstream` 最初排除了 `skipped`，导致「上游被跳过」的下游照常执行。
9. **v1 归一化凭空造 job**：某个 stage 只有一步 deploy 时也生成了 `<stage>-main`，出现一个没有任何 step 的空 job；改为只在该 stage 真有 run step 时才造。
10. **同 stage 多 job 的 step 定位冲突**：`runStep` 的 `where` 只带 `{stageId, index}`，而 v2 每个 job 的 step index 都从 0 起 → 日志认不出属于哪个 job；改为带上 `jobId`，DB 主键同步扩成 `(run_id, stage_id, job_id, idx)`。
11. **取消的 step 不落库**：`recordStep` 原本在 `status !== 'canceled'` 分支里 → 日志有「已取消」但 store 查不到是哪一步。
12. **`lib/scheduler.js` 被误覆盖**：起草 DAG 调度器时直接写了这个文件名，把 cron 调度器（227 行）覆盖掉，smoke 立刻炸 import。已从 git 恢复并把新文件改名 `lib/jobs.js`。教训：**新增 lib 文件前先 `ls lib/` 确认文件名没被占用**。

---

## 4. P2 · 工具链与动作（3 周，可与 P1 并行）

**状态：已交付（v3.0.0-p2）。** 自检 `node packages/dsh-cicd/test/smoke.mjs` → **102 checks passed**
（`P2-S1`…`P2-S10` 是 P2 的用例）。实现落在 `lib/toolchain.js`（工具链）与
`lib/actions.js` + `lib/cache.js`（`uses:` 动作与构建缓存）。

| # | 任务 | 交付物 | 验收 | 状态 |
|---|---|---|---|---|
| P2-1 | Resolver + provider | Adoptium/Maven/Gradle/Node/Python/Go（PHP 无官方可移植包，报 `TOOLCHAIN_NOT_FOUND` 并提示用容器） | 每个 provider 有 fixture 响应测试 | ✅ |
| P2-2 | CAS 安装器 | `mkdir` 锁（跨进程）+ 同进程 inflight 复用 + `.tmp` + `rename` + `.ok` 标记 | 并发 4 个 job 装同版本，只下一次 | ✅ |
| P2-3 | 注入器 | 白名单 env（不 spread `process.env`）+ PATH 前置 + 显式清 `JAVA_HOME`/`PYTHONHOME`/`GOROOT` | 宿主 JDK21 下构建出 17 字节码 | ✅ |
| P2-4 | 版本断言 | `java -version` / `mvn -v` / `node --version` / `go version` | 不匹配 fail fast | ✅ |
| P2-5 | 锁文件 | `pipe.lock` + `frozen` | 缺条目即失败，且一次索引都不问 | ✅ |
| P2-6 | Maven/Gradle 双锁 | `toolchains.xml` / `gradle.properties`（`auto-detect=false`） | Gradle daemon 跑在同一棵 JDK | ✅ |
| P2-7 | 缓存管理 | `uses: cache` + key/restore_keys/scope/LRU，落在 `workDir/cache` | 命中率与磁盘指标可见 | ✅（指标只到 `list()`，UI 未做） |
| P2-8 | 预热/离线 | `offline` / `frozen` / `verifyChecksum` 配置 | 断网 + 预热可构建 | ✅ |
| P2-9 | `uses:` 动作 | checkout / toolchain / cache / collect / deploy / verify / notify 七个内置动作 | 未知动作、未知参数都硬失败 | ✅ |

### 有意偏离的三处

1. **不用 nvm / pyenv / SDKMAN。** 它们靠 `source` 改交互式 shell 的 PATH，而我们是
   `spawn(shell:true)` 的非交互子进程，拿不到被 source 过的状态——照抄等于装完还是找不到。
   只抄了它们的声明格式（`.nvmrc` / `.sdkmanrc` 的推断）与锁文件思路。
2. **pipe.yml 里不允许写 URL**，只接受 `vendor+版本`。放开 URL 等于让任何有提 PR 权限的人
   指定构建机去下载并执行任意二进制。内网镜像走框架级配置（`file:///opt/mirror/...`）。
3. **不引用外部 action。** `uses:` 只认七个内置名字，未知名字是硬失败。GitHub Actions 的
   供应链事故基本都出在「引用别人仓库里的 action」，而我们没有精力做 pin + 审计 + 签名那一整套；
   真要自定义，`run:` 写 shell 就是那条路，它的权限边界是清楚的。

### 这一阶段抓出的缺陷

13. `lib/toolchain.js` 的 offline 判断写在 file:// 分支之前 → 内网镜像在离线模式下一律失败，
    而离线构建正是那套镜像存在的理由。
14. `lib/toolchain.js` 用 `new URL(url).pathname` 取本地路径 → Windows 短路径 `ADMINI~1`
    变成 `ADMINI%7E1`，报「本地包不存在」。必须用 `fileURLToPath`。
15. `index.js` 的工具链失败路径丢诊断：`runPipeline` 返回了 `error`/`code`，但 `executeRun`
    的返回对象没带上，用户只看到 `status:failed` 和空 stage 数组。
16. `lib/cache.js` 的 `meta.files` 既存个数又被当清单遍历 → `number is not iterable`，
    缓存永远恢复不出来，而日志只说「未命中」。拆成 `files`（个数）/ `entries`（清单）。
17. `lib/actions.js` 的 `requireCapability` 只认 `typeof === 'function'` → `cache` 是对象，
    被判成「没有缓存能力」，报错文案还把人引向「干跑里不能用」这个错误方向。
18. `lib/pipe.js` 的 v1 stage 校验只认 `run`/`deploy` → `uses:` 在 `version: 1` 的文件里根本写不了，
    想用缓存就必须先把整份 pipe.yml 改成 v2。迁移本该是渐进的。
19. `lib/cache.js` 的 `save` 把路径校验放在 `try` 里 → `paths: ["/etc"]` 被降级成一行日志，
    不再抛错。配置错误（甚至是攻击）必须炸得很响；只有「缓存没存上」才该是软失败。

---

## 5. P3 · 部署引擎（4 周）

| # | 任务 | 交付物 | 验收 |
|---|---|---|---|
| P3-1 | Actuator 接口 + native | `lib/actuator/native.js` | 单机 stage→activate→verify→commit |
| P3-2 | 多实例与槽位 | `instances` 配置、slot 锁、端口分配 | 2 主机 × 3 实例，端口不冲突 |
| P3-3 | 三层探针 | L1/L2/L3 + 观察窗 | 人为 500 → 自动回滚 |
| P3-4 | 补偿事务 | per-host 状态 + 只回滚已激活 | 第 2 台失败时第 1 台回滚 |
| P3-5 | 五策略 | serial/parallel/rolling/canary/blue-green | 每种有集成测试 |
| P3-6 | 容器 Actuator | `lib/actuator/container.js`：`docker pull <image>@sha256:…` → `docker run -p 0:<port>` → `docker port` 读回宿主端口 → 切 `current`；回滚重新 pull 上一版 manifest 里记的 digest（不按 tag） | 镜像只接受 digest（tag 一律 `CONTAINER_IMAGE_INVALID`）；失败不切 current。测试 P3-S6b/S8/S9/S10/S11 | ✅ |
| P3-7 | K8s Actuator（可选） | patch Deployment + `rollout undo` | 灰度交给 Argo Rollouts（仍抛 `ACTUATOR_NOT_IMPLEMENTED`，P3-S6 守着） | ⏳ |
| P3-8 | manifest 落盘 | `.dsh-manifest.json` + DB（容器版另记 `artifact.reference` 与 `instances[].containerId`） | 断网可读完整现场（P3-S7、P3-S8） | ✅ |

**前置**：P5 的 digest 模型（可先用“产物 sha256”临时顶替，P5 再统一）。

---

## 6. P4 · 安全 / 审批 / Secret（3 周，与 P1 并行）

| # | 任务 | 交付物 | 验收 |
|---|---|---|---|
| P4-1 | 角色管理 UI + API | 项目/环境级授予 | Owner 才能授予 |
| P4-2 | 审批实体 | `approvals(id, digest, env, requested_by, decided_by, reason, expires_at)` | 禁自批、TTL、一次性 |
| P4-3 | prod 五条件 | protected + allowlist + 审批 + 分支规则 + digest | 缺一即 403 |
| P4-4 | Secret 加密与脱敏 | age/KMS + 日志 scrub + reveal 流程 | grep 不到原文 |
| P4-5 | 审计 UI | 筛选、导出、链校验 | 允许与拒绝都可查 |
| P4-6 | Runner 安全 | 一次性 join token、吊销、心跳过期 | 吊销后不再被调度 |

---

## 7. P5 · 制品库（3 周）

| # | 任务 | 交付物 | 验收 |
|---|---|---|---|
| P5-1 ✅ | CAS | `lib/artifacts.js`：流式 sha256 → `.tmp` → `rename` 原子提交；磁盘布局 `blobs/sha256/<aa>/<hex>`；单区间 Range；`verify()` 全量重算 | 篡改 1 字节被拒（`P5-S2` 声明 digest 不符直接拒收、`P5-S3` 改盘后 verify 立即证伪）✅ |
| P5-2 ✅ | 上传/下载 API | `/api/plugins/cicd/artifacts`（GET 下载 + Range、GET 列表、POST upload/tag/verify/gc）+ 工具 `cicd_artifacts`；DB v10 加 `artifact_blobs` / `artifact_refs` | 幂等、去重（`P5-S1` 同内容二次 PUT 返回 `deduped:true` 且只有一份 blob）✅ |
| P5-3 ✅ | Maven/npm/PyPI 只读 | `lib/packages.js`（坐标归一、版本语义序、maven-metadata.xml / npm packument / PEP 503 HTML + PEP 691 JSON 生成）+ DB v11 加 `artifact_packages`（`artifact_refs` 重建为 WITHOUT ROWID）+ 三条前缀路由 `/repository/maven`、`/repository/npm`、`/simple`（只收 GET/HEAD，写一律 405 `REGISTRY_READ_ONLY`）+ `cicd_artifacts` 的 `publish`/`packages`/`catalog` 动作 | 坐标 publish 后 metadata 由库生成且按语义序（`P5-3-S1`）· npm packument 的 `dist.tarball` 指向 CAS、`integrity` 是入库时算好的 SRI（`P5-3-S2`）· PyPI 按 `Accept` 协商 PEP 691/503（`P5-3-S3`）· 写方法 405、越界路径段拒、publish 的 digest 必须已在 CAS（`P5-3-S4`）· `1.10.0` 不排在 `1.9.0` 前、rc 不顶到 latest（`P5-3-S5`）✅ |
| P5-4 ✅ | OCI 兼容层 | `lib/oci.js`（仓库名/digest/manifest 校验、HS256 短票、上传会话）+ `/v2/` 前缀路由（`/v2/`、`_catalog`、`tags/list`、`manifests/<ref>` GET/HEAD/PUT/DELETE、`blobs/uploads[/<uuid>]`、`blobs/<digest>`）+ 工具 `cicd_registry`。manifest 与层都落在同一个 CAS，tag 就是 `refs/<repo>/<tag>` | 401 带 Bearer challenge（`P5-OCR1`）· push→pull 字节一致（`P5-OCR2`）· 引用了未上传层的 manifest 被拒 `OCI_MANIFEST_BLOB_UNKNOWN` 且旧 digest 回滚可取（`P5-OCR3`）· 只有 pull 票推不上去、scope 不跨仓库（`P5-OCR4`）· 非法仓库名/未知端点 4xx（`P5-OCR5`）✅ |
| P5-5 | Promotion | digest 恒等校验 | 跨环境不复制字节 |
| P5-6 ⏳ | GC/保留 | `gc({dryRun:true})` 默认只列不删；保留集 = 指针文件 + `releases.artifact_digest`（pinned）。tombstone 与 refcount 列未做 | 被 release/指针引用的不删（`P5-S5`）✅ · tombstone 缺 |

---

## 8. P6 · 体验（4 周）

| # | 任务 | 交付物 | 验收 |
|---|---|---|---|
| P6-1 | 三栏编辑器 | 表单 + YAML + 预览（插值后命令） | 保存前能看到将执行什么 |
| P6-2 | 模板中心 | 8 语言 + 自定义模板 + 「另存为模板」 | 新建 ≤3 步 |
| P6-3 | 环境页 | 当前版本、实例、回滚、保护规则 | 一眼看到 prod 跑什么 |
| P6-4 | 日志体验 | 虚拟滚动、搜索、折叠、深链到行 | 10 万行不卡 |
| P6-5 | 命令面板 | `⌘K` 跳转 + 动作 | 键鼠均可完成主流程 |
| P6-6 | 首次引导 | 3 步闭环 | 新用户 5 分钟内部署到 staging |
| P6-7 | 空/错/加载态 | 统一组件 | 无「白屏 + 转圈」 |

---

## 9. P7 · 加固（持续）

- 压测：1000 并发 run、10 万行日志、50 台主机。
- 混沌：runner 掉线、DB 锁、磁盘满、网络分区。
- 兼容：v1 pipe.yml 长期支持；DB 迁移可回滚。
- 可观测：run 耗时 P50/P95、排队时长、缓存命中率、部署成功率（DORA 已有基础）。

---

## 10. 里程碑与验收（对外可承诺的部分）

| 里程碑 | 时间 | 可演示的能力 |
|---|---|---|
| M1 | +2w | 登录/角色、深链 UI、部署锁落库、审计可查 |
| M2 | +6w | 并行 job、矩阵、v2 DSL、日志分片 |
| M3 | +9w | JDK17/21 隔离、Maven/Gradle 双锁、锁文件 |
| M4 | +13w | 多主机多实例、三层探针、自动回滚 |
| M5 | +16w | 审批闭环、prod 五条件、secret 脱敏 |
| M6 | +19w | 制品 CAS + promotion |
| M7 | +23w | 三栏编辑器、模板中心、引导闭环 |

---

## 11. 风险登记

| 风险 | 影响 | 概率 | 缓解 |
|---|---|---|---|
| 范围过大导致长期不可发布 | 高 | 高 | P0 独立发布；每阶段都可单独上线 |
| 并发调度引入难复现 bug | 高 | 中 | 状态机 + 事件溯源（run_events 表）+ 可重放 |
| 工具链下载在企业网被墙 | 中 | 高 | 镜像源 + 预热 + 离线包 |
| 容器/K8s 依赖宿主能力 | 中 | 中 | 先 native，容器/K8s 作为 Actuator 增量 |
| RBAC 上线打断现有自动化 | 中 | 中 | 灰度：`auth.mode=local` 且 `enforce=false` 观察一周 |
| 制品库 GC 误删 | 高 | 低 | tombstone 7 天 + `pinned` + dry-run |
| 前端重写拖慢后端 | 中 | 中 | P0 只加壳复用组件；P6 才做编辑器 |

---

## 12. 明确不做（避免范围蔓延）

- 不做通用插件市场（`uses` 白名单固定）。
- 不做图灵完备 DSL / 脚本语言。
- 不做 K8s 原生编排（交给 Argo，我们只 patch）。
- 不做多租户 SaaS 计费。
- 不做自研分布式存储（SQLite + 本地 CAS 足够，规模上来再换）。
- 不做移动端。

---

## 13. 一段话总结

**现在的 dsh-cicd 是一个「能跑通 demo 的执行器」，不是「能托付生产的流水线」。**
缺的不是功能数量，而是四样结构性东西：**可信的身份与权限**、**可并行的执行模型**、**不可变的制品链**、**能回滚的部署现场**。
按 P0→P1→P3 的顺序做，前 13 周就能把「不能上生产」变成「可以上生产」；P5–P6 再解决「好不好用」。
