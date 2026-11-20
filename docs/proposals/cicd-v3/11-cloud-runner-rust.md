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
| PUT | `/runner/v2/artifacts/:taskId/:name` | 流式上传（分块，`Content-Digest` 校验） | CAS 去重 |
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
- 缓存：任务声明 `{key, paths, mode}` → 执行前从 `<workdir>/cache/<key>.tgz` 解包到
  请求路径，任务成功后回写。宿主侧只存 key 元数据与命中统计（心跳上报）。
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
| H4 | 短期凭据端点：secretRefs → 值，TTL=租约；审计记「凭据揭示」 | lib/secrets.js + audit |
| H5 | 制品回流 PUT handler + complete 校验 | index.js + lib/artifacts.js |
| H6 | 心跳负载入库（磁盘/缓存命中率/在跑数）+ stale 标记 | runners 资源 + client.js 构建主机页 |
| H7 | GUI：构建主机页新增 v2 列（协议版本/缓存命中率/安装命令） | client.js |
| H8 | 测试：fake Rust runner（协议 v2 的 Node 模拟器，风格同现有 fake runner）+ 全链路用例 | test/smoke.mjs P9-* |

## 7. 里程碑与验收

| 里程碑 | 内容 | 验收（红→绿用例） |
|---|---|---|
| M1 协议骨架 | H1+H3 + Rust api.rs：register/heartbeat/claim/logs/complete；run 步骤执行 | fake runner 走完 build-only 任务；吊销后 401；断链重连日志 seq 去重 |
| M2 workspace | checkout/toolchain 步骤 + workspace TTL GC + journal 断电续跑 | kill -9 后重启续跑不重做成功步骤；GC 只删过期 |
| M3 缓存+凭据 | cache.rs + H4：缓存命中统计入心跳；secretRefs 换短期值 | 日志/DB grep 不到 secret 原文；缓存第二次构建命中 |
| M4 制品回流 | collect + H5：PUT → CAS → run 记录关联 digest | 完整 build→upload→promote→deploy 闭环（现有 P5-S12 篡改用例扩展到 runner 路径） |
| M5 迁移 | 版本握手 + v1 runner 兼容跑通 + 文档（README/08-security-rbac 的 runner 章节）+ roadmap V2-M2 勾选 | 双 runner 并存各跑一条 run；文档与实现一致 |

每个里程碑独立可发布（宿主侧改动向后兼容，v1 不受影响）。

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
- 10-roadmap.md：V2-M2 执行面按 M1-M5 重述，完成后逐项勾选；
- 08-security-rbac.md：§4 认证设计补进该文档的 runner 章节（实施 M1 时同步）。
