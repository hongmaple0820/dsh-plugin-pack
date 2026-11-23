# 11 · 云流水线 Runner v2（Rust 重写）详细方案

> 状态：提案（待立项实施）· 2026-11-21
> 前置阅读：03-architecture.md §5（Runner v2 协议设计）、08-security-rbac.md
> 决策记录（2026-11-21，用户已确认）：
> ① Runner 用 **Rust 重写**（弃 Node 单文件方案）；
> ② 部署形态 **先内网/VPN**，公网暴露不在本期范围。

## 0. 一页结论

现状（cloud-parity 审查结论）：远端 runner 只是「远程 shell」——领任务、回日志、断电续跑、吊销判死齐全；workspace 同步、工具链、缓存、制品回流、远端部署全无；认证只在注册时验 join token，poll/result/log 只凭 runnerId；secrets 明文随 GET 出网。

本方案要把它补成 03-architecture.md §5 设计的完整执行面，并换 Rust 实现：

| 缺口 | 本方案落点 |
|---|---|
| 协议只有 4 个 GET 端点 | §3 协议 v2 七端点 + 凭据交换，走 **handler 路由**（全方法） |
| workspace 由人肉指定 | §5.1 控制面分配 + runner 清理 + TTL GC |
| 工具链/缓存宿主独占 | §5.2/§5.3 runner 自托管 + 声明式缓存 |
| 制品不回流 | §5.4 分块 PUT + digest 校验 → 宿主 CAS |
| secrets 明文出网 | §4 短期凭据（TTL=租约），值不进任务体 |
| 认证一次性 | §4 register 换 token、逐请求认证、轮换吊销 |
| 无 TLS 故事 | §6 harness webserver 原生 TLS + VPN 双保险 |

## 1. 现状与根因（为什么 v1 是全 GET）

本节是本次研究的新发现，决定了整个方案的 HTTP 落点。

DSH 宿主 webserver（F:\maple\deepseek-harness\packages\host\webserver\src\index.ts）有两类路由：

- **resource 路由**（dsh-cicd 现在全部 60+ 条路由都是这类）：**只答 GET/HEAD**，
  其它方法一律 405（index.ts:365 `const RESOURCE_METHODS = 'GET, HEAD'`；serveResource
  index.ts:820-823 在读 body 之前就拒）。这就是：
  - runner v1 全 GET 协议的真正根因（runner.mjs 头注释「webserver 只放行 GET/HEAD」是对的，不是历史包袱）；
  - dsh-cicd GUI 客户端全部 GET 的原因（client.js:893-903 callApi 只有 method:'GET'，写操作=GET + query + x-dsh-cicd 头）。
- **handler 路由**（`{kind, path, handler, auth?}`，index.ts:117-124）：handler 直接拿到
  `req: IncomingMessage / res: ServerResponse`（index.ts:631-632 分发），**任意方法、
  流式 body、可长时间持有连接（SSE/上传）**。auth 策略 `'anonymous' | 'required' | 'deny'`
  （index.ts:95）。

另：webserver 原生支持 TLS（`tls.certFile/keyFile` → createSecureServer，index.ts:683-693），
**服务端 TLS 是宿主配置项，不需要插件做什么**。

**结论**：Runner v2 的 POST/PUT 端点必须注册成 handler 路由
（`web.register({ kind:'prefix', path: ROUTE_PREFIX + '/runner/v2', handler, auth:'anonymous' })`），
runner 身份认证在 handler 内部做（runner token），不依赖 DSH Peer。GUI 侧现有 resource 路由
不动——两套面各司其职。

## 2. 总体架构

```
┌────────────── DSH 宿主机（内网/VPN 后） ──────────────────┐
│  dsh-cicd 插件                                            │
│  ├─ resource 路由（GET）：GUI 面板 / v1 runner / 仓库只读   │
│  ├─ handler 路由（新，全方法）：/runner/v2/* 七端点          │
│  │    ├─ 任务 broker v2（任务描述组装、租约、日志 seq）        │
│  │    ├─ 凭据交换（secretRefs → 短期值，TTL=租约）            │
│  │    └─ 制品回流（分块 PUT → CAS + digest 校验）            │
│  └─ SQLite（runs/jobs/leases/runners/audit…）             │
└───────────────────────┬───────────────────────────────────┘
                        │ 内网 / VPN（TLS 可选叠加）
              ┌─────────┴──────────┐
              │  Rust runner（云 VM） │  ×N
              │  ├─ claim 长轮询 + 心跳   │
              │  ├─ workspace 管理（TTL） │
              │  ├─ checkout/toolchain/  │
              │  │  run/collect 步骤执行器 │
              │  ├─ 缓存回写、制品上传     │
              │  └─ journal（断电续跑）    │
              └────────────────────┘
```

不变量（沿用 03-architecture §3.2/§5.3）：
- 租约 `leaseSec=900`，心跳 15s，连续 2 周期失联判死、任务回收重派；
- 重试仅 `attempt < max_attempts && step.idempotent !== false`，deploy 步骤默认不自动重试；
- complete 幂等：重复提交返回既有结果；logs 按 `(taskId, seq)` 去重乱序补发；
- register 重注册 = 轮换 token，旧 token 立即失效。

## 3. 协议 v2（对齐 03-architecture §5，含路径落地）

路径挂在现有插件前缀下（`/api/plugins/cicd/runner/v2`...），handler 路由，auth='anonymous'，
每个请求在 handler 内验 `Authorization: Bearer <runnerToken>`：

| 方法 | 路径 | 用途 | 幂等 |
|---|---|---|---|
| POST | `/runner/v2/register` | join token（一次性）→ runner token + serverTime；重复注册=轮换 | 轮换语义 |
| POST | `/runner/v2/heartbeat` | 心跳 + 负载（在跑数/磁盘/缓存命中率） | 天然幂等 |
| POST | `/runner/v2/claim` | 长轮询领任务（hold 25s 无任务则 204） | 租约原子授予 |
| POST | `/runner/v2/logs` | 批量日志行 `{taskId, lines:[{seq,text}]}` | `(taskId,seq)` 去重 |
| POST | `/runner/v2/credentials` | secretRefs → 短期值（TTL=租约，随租约续） | 租约内缓存 |
| POST | `/runner/v2/complete` | 终态 + exitCode + artifacts 清单 | 返回既有结果 |
| PUT | `/runner/v2/artifacts/:taskId/:name` | 裸 tar.gz 上传（≤ 512 MiB，一个制品一个包） | CAS 去重 |
| POST | `/runner/v2/drain` | 排空：不领新任务，跑完当前 | 幂等 |

与 §5.1 表的差异：路径加 `/runner/v2` 前缀（挂在插件命名空间下，不新起端口）；runnerId
从路径段移到 token（认证即身份，防止改 URL 冒充）；新增 `/credentials`（设计里「runner
用 token 换短期凭据」的落点）。任务描述 JSON 与 §5.2 逐字段一致。

**v1 共存**：v1 四端点（/runner-register 等，GET）保留整个迁移期；register 上报
`protocol: 2` 的 runner 走 v2 broker，否则走 v1——同一张 runners 表，同一个吊销/判死逻辑。

## 4. 认证与 secrets（内网/VPN 前提下的底线）

1. **注册**：管理员在 GUI 生成 join token（一次性，sha256 落库，timingSafeEqual 比较——
   现有 joinTokenMatches 可复用）。register 成功返回随机 32B runner token（sha256 落库，
   明文只出现一次）。
2. **逐请求认证**：v2 所有端点验 runner token（含吊销检查）——修掉 v1「poll/result/log
   只凭 runnerId」的裸奔。401 不区分「token 错」与「已吊销」。
3. **secrets**：任务体只带 `secretRefs`；runner 在步骤执行前 POST /credentials 换值，
   只放进子进程 env，不落盘、不进日志（沿用现有日志 grep 不到原文的测试方法）。
   TTL=租约，过期重换。
4. **传输**：VPN 之内仍建议开 webserver TLS（宿主配置 tls.certFile/keyFile，零插件代码）；
   runner 侧 `--ca` 钉住自签 CA。--insecure 保留给本地开发。
5. **公网前硬门槛**（本期不做，但方案不堵死）：反代终结 TLS + IP 白名单 + 限速；
   handler 里预留 per-runner 速率限制挂点。

## 5. Rust runner 设计

### 5.1 架构与 crate 选型

```
runner/（cargo workspace，单二进制）
├─ main.rs        clap CLI（--server --runner --labels --join-token --workdir --ca --capacity）
├─ api.rs         reqwest client（rustls）：register/claim/heartbeat/logs/complete/upload
├─ lease.rs       心跳 15s + 租约剩余监视（<90s 告警，<0 停止执行当前步骤）
├─ exec.rs        步骤执行器：checkout / toolchain / run / collect（见 5.2）
├─ ws.rs          workspace 管理器：目录分配、clean、TTL GC（后台任务）
├─ cache.rs       声明式缓存（key 目录 + tar.gz 往返）
├─ journal.rs     journal.jsonl + fsync（断电续跑，语义同 v1）
└─ cred.rs        短期凭据获取与刷新
```

| 关注点 | 选择 | 理由 |
|---|---|---|
| async runtime | tokio（full） | 标准答案；claim 长轮询 + 并发步骤 |
| HTTP | reqwest + rustls | 纯 Rust TLS，不依赖系统 openssl；流式上传 body |
| 序列化 | serde + serde_json | 任务描述直接从 §5.2 schema 反序列化 |
| CLI | clap（derive） | 与 v1 参数兼容（迁移期同参数直接换二进制） |
| git | 调系统 `git` CLI（depth=1 + sha checkout） | 不引 libgit2（构建复杂、凭据转发麻烦）；云 VM 装个 git 是合理前提 |
| 哈希 | sha2 | join token/制品 digest |
| 日志/错误 | tracing + tracing-subscriber / anyhow + thiserror | |
| 交叉编译 | cargo-zigbuild + GitHub Actions matrix | 产出 x86_64-linux、aarch64-linux 两个 tar.gz（Windows runner 非目标，容器构建也不依赖本机） |

并发模型：`capacity` 个 worker，每任务一个 tokio task；SIGTERM → drain（不领新任务，
当前步骤收到 kill，journal 记 attempt，退出码 143）——与 v1 行为一致。

### 5.2 步骤执行器（任务描述的四种 step）

- **checkout**：`git clone --depth 1 --branch <ref> <url> && git checkout <sha>`；
  shallow + sha 固定，失败=源不可达，不重试（source 非 idempotent 默认）。
- **toolchain**：按 `toolchain` 声明装到 `~/.dsh-cicd/toolchain/<lang>-<version>`
  （lock 式：存在即跳过）。下载 URL + sha256 校验逻辑与宿主 cicd_toolchain 同源清单
  （清单文件放插件包随版本发布，runner 拉取——两端永远同版本语义）。
- **run**：spawn + env 合并（process env ∪ 任务 env ∪ 短期凭据 ∪ toolchain PATH——
  v1 的 env bug 不复发，合并点在 Rust 侧只有一个）；逐行读 stdout/stderr，250ms 批量
  POST logs（seq 由 runner 单调分配，断线缓存重发，服务端去重）。
- **collect**：glob 匹配 → 复制进 `ws/.artifacts/<name>`，登记进 complete 的清单。

### 5.3 workspace 与缓存

- `<workdir>/ws/<runId>/<jobId>`；`clean:true` → 步骤前清空；TTL 后台 GC（默认 1h）。
- 缓存（M3 落地）：任务体带 `cache: [{key, paths, restoreKeys, mode}]`。runner 在 checkout
  之后、第一个 `run` 步骤之前 `POST /cache/lookup`（精确 key 优先，未命中再按 `restoreKeys`
  前缀回退），命中后 `GET /cache/blob?digest=` 拿 tar.gz 裸字节、用系统 tar 解包到 workspace
  根；`succeeded` 之后按 `save`/`both` 打包存在的 paths，`PUT /cache/blob?key=` 推回宿主。字节
  不进 meta 表：走既有 CAS（`artifactStore.putFile`）并在 refs 里挂一条 `cache:<projectId>`
  指针，所以 `artifacts gc` 不会回收仍在引用的缓存字节。runner 侧 fail-open（任一步失败只记
  miss/日志，不改任务结论）；tar 探测不到就整段跳过并在 `register` 的 `tools` 里省掉 `tar`。
- 命中统计：`hits/misses/saves` 随心跳 `stats.cache` 上报（`runners.stats_json` 落库，
  `cicd_runners` 直接可见）；`stats.running` 是当前在跑任务数，`diskFreePct` 目前留空。
- 心跳是**后台周期任务**（`spawn_heartbeat`），与 claim/execute 解耦：注册成功后立刻一次，之后每
  `heartbeatSec` 一次，任务执行期间照常上报（`stats.running=1`）。原因是宿主 liveness 读库判活、
  阈值 `heartbeatSec×3`（默认 90 s），只在空闲分支发心跳会让任何超过阈值的正常构建被判
  `RUNNER_OFFLINE` 杀掉。心跳失败只记日志、不致命。
- `uses: cache` 步骤仍在宿主侧执行（作用于宿主的项目目录），**远程构建请用顶层 `cache:`**；
  远程 executor 下这条步骤会在日志里被点名提醒（`lib/runner.js` 的 `remoteCacheStepNotice`）。
- 磁盘水位：心跳带 `df`；低于 5% 自动 drain + 告警（宿主侧 P7 混沌逻辑已有磁盘满用例）。

### 5.4 制品回流

PUT handler 流式收 body → 临时文件 → sha256 与 `Content-Digest` 比对 → 原子 rename 进
CAS（复用 artifactStore.put 及其 repaired 语义）→ 关联 (runId, taskId, name)。
大文件分块：`Content-Range` 风格分段，或直接整文件流式（reqwest 流式上传单连接即可，
分块是断点续传的可选项，M4 再定）。complete 的 artifacts 清单里的 name 必须都已 PUT
成功才算 success——否则 failed(ARTIFACT_MISSING)。

### 5.5 发布与分发

- GitHub Releases 挂 `dsh-cicd-runner-<ver>-<target>.tar.gz` + 安装脚本（curl | sh）。
- 插件包**不带二进制**（SPEC 禁止大文件入包）；GUI「构建主机」页加「复制安装命令」。
- 版本握手：register 上报 `version`，宿主低于最低支持版本时在 runners 列表标
  `stale`（不强制拒——迁移期容忍）。

## 6. 宿主侧改造清单（dsh-cicd，Node）

| # | 改动 | 落点 |
|---|---|---|
| H1 | handler 路由注册 `/runner/v2/*`（auth:'anonymous'，内部 token 认证） | index.js 路由表旁新增（resource 路由表不动） |
| H2 | 任务 broker v2：把现有 step 编排翻译成 §5.2 任务描述（pipe 的 run 步骤 → steps；deploy 步骤仍宿主执行，runner 只跑 build——设计如此，见 03 §6） | lib/executors.js createRemoteExecutor |
| H3 | join token 管理：GUI 生成/吊销（现有 joinTokenMatches 复用）+ runner token 存量表（含轮换） | lib/executors.js + index.js runners 资源 |
| ✅ H4 | 短期凭据端点：secretRefs → 值，TTL=租约；审计记「凭据揭示」 | lib/secrets.js + audit |
| H5 | 制品回流 PUT handler + complete 校验 | index.js + lib/artifacts.js |
| ✅ H6 | 心跳负载入库（缓存命中率/在跑数；磁盘水位 runner 侧未采）+ stale 标记 | runners 资源 + client.js 构建主机页 |
| H7 | GUI：构建主机页新增 v2 列（协议版本/缓存命中率/安装命令） | client.js |
| H8 | 测试：fake Rust runner（协议 v2 的 Node 模拟器，风格同现有 fake runner）+ 全链路用例 | test/smoke.mjs P9-* |

## 7. 里程碑与验收

| 里程碑 | 内容 | 验收（红→绿用例） |
|---|---|---|
| ✅ M1 协议骨架 | H1+H3 + Rust api.rs：register/heartbeat/claim/logs/complete；run 步骤执行 | fake runner 走完 build-only 任务；吊销后 401；断链重连日志 seq 去重 |
| ✅ M2 workspace | checkout 步骤 + workspace TTL GC + journal 断电续跑（toolchain 步骤见下方交付说明） | kill -9 后重启续跑不重做成功步骤；GC 只删过期 |
| ✅ M3 缓存+凭据 | cache.rs + H4：缓存命中统计入心跳；secretRefs 换短期值 | 日志/DB grep 不到 secret 原文；缓存第二次构建命中 |
| ✅ M4 制品回流 | collect + H5：PUT → CAS → run 记录关联 digest | 完整 build→upload→promote→deploy 闭环（宿主 P9-S10/S11 + runner 集成用例；P5-S12 的 digest 校验沿用同一 CAS） |
| ✅ M5 迁移 | 版本握手 + v1 runner 兼容跑通 + 文档（README/08-security-rbac 的 runner 章节）+ roadmap V2-M2 勾选 | 双 runner 并存各跑一条 run；文档与实现一致（宿主 P9-S12 + runner 2 个集成用例） |

每个里程碑独立可发布（宿主侧改动向后兼容，v1 不受影响）。

> **M1/M2 交付说明（2026-11-21）**
>
> - M2 的 `toolchain` 步骤没有做，因为当前 v2 broker 根本不下发它：`lib/executors.js`、`lib/runner-v2.js` 构造的任务描述里没有 `toolchain` 步骤，runner 侧实现了也没有东西可跑。工具链安装随 M3 的 cache 层一起进（同一批要碰 `runner-work` 的目录布局与依赖解析），宿主侧 `lib/toolchain.js` 仍是唯一权威。
> - 「journal 断电续跑」之所以用任务级 journal 就能满足「不重做成功步骤」：宿主按 step 派发任务（`spec.stepIndex`，一个 step 一个 taskId），所以任务级 journal 等价于步骤级 checkpoint——已 finished 的步骤重启后只补发 complete 不重跑，被中断的那一步由宿主重派。
> - 验收证据：`packages/dsh-cicd/runner` 的 23 个单测 + 7 个集成用例（含真实 `git clone` 到 `ws/<runId>`、`tools:['git']` 上报、journal 命中不重跑）；宿主侧 `test/smoke.mjs` 的 P9-S3（任务描述）与 P9-S4（无 git 能力的 runner 被 `RUNNER_CAPABILITY_MISSING` 拦下）。

> **M3 交付说明（2026-11-21）**
>
> - 线上契约：`POST /credentials` 只放行任务申报过的名字（否则 403 `SECRET_NOT_DECLARED`，未知任务 404 `TASK_UNKNOWN`），TTL = min(租约, 900) 且 ≥ 60，揭示动作写审计 `secret.reveal`；`POST /cache/lookup`、`GET|PUT /cache/blob`（裸字节，PUT 上限 256 MiB）。三条缓存端点共用 `declaredCache()` 门禁：key 未申报 403 `CACHE_NOT_DECLARED`，`mode` 不含 save 的 key PUT 得 403 `CACHE_SAVE_FORBIDDEN`，超过上限 413 `CACHE_TOO_LARGE`。
> - 任务体脱敏：`secretRefs` 只带名字；`env` 与 `command` 里的明文改写为 `${NAME}`（长度 < 4 的值不碰，免得把普通文本打成占位符）；`env` 里整值等于某个 secret 的条目抽成 `secretEnv: [{env, ref}]`。runner 先按 `secretRefs` 同名注入、再按 `secretEnv` 映射注入（映射优先），换不到值即 fail closed：complete `failed`、exit `-1`、checkout 与所有步骤都不跑。
> - 「缓存第二次构建命中」目前是契约级证据：宿主侧 P9-S8（lookup 命中与 `restoreKeys` 前缀回退、GET/PUT 字节逐字节一致、未申报 403、幽灵任务 404、非 GET/PUT 405），runner 侧集成用例 `cache_hit_restores_files_via_system_tar`（真 tar 打包 → 下载 → 解包 → 步骤里看得见 `dist/hit.txt`）、`cache_save_uploads_blob_and_heartbeat_reports_stats`（成功任务 PUT 的 key 正确、心跳 `stats.cache.saves ≥ 1`）、`cache_lookup_failure_is_fail_open`（lookup 503 时任务照旧 succeeded）。跨进程真跑一条完整流水线留给 M4 的制品回流用例一并做。
> - 交付前修掉一个判活缺陷：runner 原先只在 claim 拿到空任务时发心跳，而宿主 liveness 探针每 5 s 读库判活、阈值 `heartbeatSec×3`（默认 90 s），于是任何超过 90 s 的正常构建都会被判 `RUNNER_OFFLINE` 杀掉，心跳里的 `stats.running` 也恒为 0。现在心跳改为后台周期任务（注册后立刻一次，随主循环退出而 abort），集成用例 `heartbeat_ticks_during_long_task`（`heartbeatSec=1` + 4 s 步骤）断言执行期间 ≥2 次心跳、≥1 次 `stats.running=1`、任务仍 succeeded。
> - tar 是系统依赖（本机 bsdtar 3.5.2），不新增 cargo 依赖；压缩包落 `<workdir>/cache/`（不在 `ws/` 内，workspace 清理删不到在途包），300 s 超时 + `kill_on_drop`。
> - 已知限制：`uses: cache` 是宿主侧动作，缓存的是宿主的项目目录；远程构建必须用顶层 `cache:`（远程 executor 下会打一条点名该 runner 的提醒）。M2 交付说明里「toolchain 随 M3 的 cache 层一起进」没有兑现——v2 任务描述仍没有 `toolchain` 步骤，宿主侧 `lib/toolchain.js` 仍是唯一权威，runner 侧安装器随「加 toolchain 步骤」的那个里程碑走。
> - 验收证据：`cargo test --offline` 37 单测 + 13 集成全绿（新增 cache 3 单测 + 3 集成 + 1 心跳集成）；宿主 `test/smoke.mjs` 180 checks passed（新增 P9-S5 凭据、P9-S6 心跳统计、P9-S7 顶层 cache 声明、P9-S8 缓存字节闭环、P9-S9 远程 `uses: cache` 提醒）。

> **M4 交付说明（2026-11-21）**
>
> - 线上契约：`PUT /runner/v2/artifacts/:taskId/:name?runnerId=` 裸 tar.gz（≤ 512 MiB），响应 `{ok,name,digest,bytes,deduped}`；错误码 401 / 400 `BAD_ARTIFACT_NAME`（name 必须匹配 `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`）/ 404 `TASK_UNKNOWN` / 403 `ARTIFACT_NOT_DECLARED`（名字不在该任务声明里）/ 413 `ARTIFACT_TOO_LARGE`。字节进 CAS 后挂一个 `{projectId,name}` 指针（`artifacts.putRef`），所以 `artifacts gc` 不会回收还在被引用的回流件。
> - 声明按 stage 收敛：`collectDeclarations(pipe, stageId)` 只把当前 stage 的 `uses: collect` 翻成任务声明。runner 每个任务一个干净 workspace，build 的产物不会出现在 deploy 阶段的任务里，声明混在一起只会让后者假失败。
> - 收口在 complete：宿主以「PUT 记录 ∪ 声明的名字」判定，非 optional 的缺失把任务改成 `failed` + `code: ARTIFACT_MISSING`（构建退出码 0 不算数——少了产物，下游 deploy/promote 是无米之炊），并写审计 `artifact.missing`。因为判定看 PUT 记录而不是只看 complete 的 body，journal 重放（`src/app.rs:188` / `src/app.rs:266` 补发的 complete 不带 artifacts）不会误判：字节确实到过宿主就还算到齐；只有在崩溃于上传之前时才会得到 `ARTIFACT_MISSING`，那也正是事实。
> - 远程构建里的 `uses: collect` 不在宿主 glob（host 项目目录里没有远程产物），runStep 会打一条点名 runner 的提醒并把该步骤记成 `skipped`；同时把「只有 `failed` 才拖垮 stage」这条判据收紧——之前 `skipped` 也会让 stage 失败，远程 collect 一上线就会把整条流水线打成红的。
> - 制品与缓存的边界：缓存是「下一轮更快」，制品是「这一次的产物」。两者都走 CAS、都用系统 tar（不新增 cargo 依赖），但制品没有 restoreKeys/回退语义，名字由 pipe.yml 指定。
> - 已知限制：① runner 侧打包是「glob 命中 → 单个 tar.gz」，不做分块断点续传（设计里列作可选项）；② `toolchain` 步骤仍未下发，宿主 `lib/toolchain.js` 仍是唯一权威（M2/M3 遗留，随「加 toolchain 步骤」的里程碑走）。
> - 验收证据：`cargo test --offline` 41 单测 + 16 集成全绿（新增 `collect` 4 个 glob 单测 + 3 个集成：`artifacts_are_uploaded_and_reported_on_complete`、`no_artifacts_declared_uploads_nothing`、`artifact_glob_miss_is_skipped`）；宿主 `test/smoke.mjs` 182 checks passed（新增 P9-S10 制品回流含 403/404/400/405/401 与 `ARTIFACT_MISSING`、P9-S11 按 stage 翻译声明与远程跳过）。

> **M5 交付说明（2026-11-21）**
>
> - 握手是双向的：runner 注册时自报 `protocol: 2`（`RegisterRequest.protocol`，可选字段——不带时老宿主照旧当 v1 收）；宿主回 `protocol` 与 `minProtocol`，runner 见到 `minProtocol > 2` 立刻退出并提示升级，而不是拿旧规矩解释新任务。
> - 三种错法给三种码，因为修法不同：400 缺字段是调用方写错；**426 `RUNNER_PROTOCOL_UNSUPPORTED`** 是「你敲的是 v2 端点但你不是 v2」（`endpoints.register` 协商，且不把机器登记进来）；**409 `RUNNER_PROTOCOL_MISMATCH`** 是「你登记的身份和这条路径不匹配」——既覆盖 v1 机器拿 v2 token 敲 `/claim`（`authenticate()` 在比对 token 之前就判），也覆盖 v2 机器回头轮询 v1 的 `/runner-poll` / 回报 `/runner-result`（那边拿到的是 raw spec，没有 secretRefs/cache 语义，还会绕过 complete 的制品校验）。
> - v1 注册显式写 `protocol: 1`（`index.js` 的 `runnerRegister`），不再靠 `runners.register()` 的默认值：默认值一旦改动，老 runner 会被悄悄当成 v2，而这类错位在日志里长得跟凭据问题一模一样。
> - 并存是既有结构，不是新机制：v1 与 v2 共用一个 broker（`broker.claim(spec, runnerId)`），一台机器走哪条路径由它注册时用的端点决定；用例里两台机器在同一个 runtime 上各跑完一条 run，互不影响。
> - 已知限制：① v1 路径没有制品到齐判定与凭据交换（这是 v1 的定义，不是缺陷），需要这些语义就必须走 v2；② `toolchain` 步骤仍未下发（M2/M3/M4 遗留）；③ 握手只到「版本号」粒度，没有能力位图协商——能力仍走 `tools` 标签过滤。
> - 验收证据：`cargo test --offline` 41 单测 + **18 集成**全绿（新增 `register_declares_protocol_version`、`newer_host_protocol_stops_the_runner`）；宿主 `test/smoke.mjs` **183 checks passed**（新增 P9-S12：协商成功 / 自报 1 得 426 且不登记 / v1 落 protocol=1 / 跨协议 409 / 双 runner 并存各跑一条）。

## 8. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| handler 路由 auth:'anonymous' 的实际放行行为（waterfall/authorize 是否有全局钩子拦 POST） | M1 第一个 spike：注册最小 handler，curl POST 验证（10 分钟定生死） |
| claim 长轮询占用连接 | 25s 上限 + 心跳独立连接；webserver 无 keep-alive 强制限制（handler 可持有响应） |
| reqwest 流式上传大文件内存 | body 用 `Body::wrap_stream`（file stream），不用 `bytes` 全量读 |
| rustls 对自签 CA 的行为 | --ca 已设计；不行则降级 native-tls（构建复杂度换兼容性，最后手段） |
| 云 VM 无 git | register 能力上报 `tools:['git']`，宿主调度时按 label 过滤（M2） |
| 迁移期两套 broker 并存的状态分裂 | 同一张 runners 表 + 同一套判死/吊销；v2 broker 只加不改 v1 代码路径 |

## 9. 本方案不做的事（防滑向 Jenkins）

- 不做容器编排/集群调度（容器=pipe.yml 已有的 docker CLI 路线）；
- 不做 runner 侧的服务器部署（deploy 永远宿主执行，凭据不出宿主）;
- 不做多租户 runner 池（单用户内网场景，YAGNI）;
- 不做公网暴露（VPN 是边界；公网需求出现时按 §4.5 的门槛单独立项）。

## 10. 与既有文档的关系

- 03-architecture.md §5：本方案是它的落地设计（路径/认证细节有偏差，见 §3 差异说明）；
- 10-roadmap.md：V2-M2 执行面按 M1-M5 重述，完成后逐项勾选（已勾，见该文件 V2-M2 行）；
- 08-security-rbac.md：§4 认证设计补进该文档的 runner 章节（实施 M1 时同步）。
