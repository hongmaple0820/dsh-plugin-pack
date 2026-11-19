# 01 · 现状审计：dsh-cicd 到底完成了什么

> 审计基线：`packages/dsh-cicd` v0.6.1 / README 宣称的 v2.0-M0…M5，git 分支 `main`。
> 方法：逐文件读实现 + 追调用链 + 对照 README 自述，不采信文档声明，只看代码路径。
> **注意：本章第 1、2 节是「改造之前」的审计快照（v0.6.1），保留原样作为凭证。**
> 想看现在改到哪儿了，直接跳到 §2.1（P0）、§2.2（P1）、§2.3（P2）。
>
> 结论先行：**这是一条可演示的垂直切片（vertical slice），不是一个闭环的 CI/CD 产品。**
> 它证明了「pipe.yml → 本机/远端执行 → SSH 多主机发布 → 回滚」这条主干能跑通，
> 但缺少 CI/CD 之所以是 CI/CD 的六个一等公民：**流水线、作业、构建环境、制品、环境、身份**。

---

## 1. 一句话架构（读代码得出，不是读 README）

```
┌──────────────────────── DSH 宿主（控制面 + 默认执行面）────────────────────────┐
│  client.js（单页 React-ish，无路由）                                            │
│      │ fetch ?confirm=1 + x-dsh-cicd 头                                        │
│  index.js  ── 20 个 cicd_* 工具 / 28 条 REST / /log-ws / /hooks/<project>       │
│      │                                                                         │
│      ├── lib/pipe.js      自写受限 YAML → 单 target / stage 串行 / step 串行     │
│      ├── lib/runner.js    spawn(shell) 执行 run 步骤；stage/step 全串行          │
│      ├── lib/executors.js 本地 spawn 或远端 broker（runner 拉取任务）            │
│      ├── lib/deploy.js    uploadFile → tar -xzf → ln -sfn current → restart     │
│      ├── lib/strategy.js  serial/parallel/rolling/canary/blue-green（主机批次）  │
│      ├── lib/db.js        SQLite：runs/steps/artifacts/releases/operations/...  │
│      └── lib/{git,secrets,approval,rbac,dora,triggers,cron,scheduler,notify}.js │
└───────────────┬─────────────────────────────────────────────────────────────────┘
                │ dsh-remote（另一插件）SSH
        ┌───────┴────────┐
   目标主机 A/B/C    远端 runner（bin/runner.mjs，只执行 command 字符串）
```

关键点：**执行面是一个「远程 shell 执行器」，不是「构建运行时」**。
`lib/runner.js:188` 把 `{ ...process.env, CI: '1', ...vars }` 直接交给 `spawn`，
`lib/runner.js:198` 的 `cwd` 是项目目录本身——没有工作区隔离、没有环境清理、没有工具链概念。

---

## 2. 能力清单：声称 vs 实际

图例：✅ 闭环可用 · ⚠️ 有实现但没闭环（缺 UI/缺约束/半条链路）· ❌ 不存在

| # | 能力 | 状态 | 代码证据 | 实际边界 |
|---|---|---|---|---|
| 1 | pipe.yml 解析与校验 | ✅ | `lib/pipe.js`（自写解析器，带行号诊断） | 只支持 `version: 1`；拒绝锚点/块标量/flow map；无 include/extends |
| 2 | 多 target / 环境选择器 | ✅ | `lib/pipe.js:normalizeTarget`、`index.js:396 expandTarget` | `env:/group:/tag:` 展开成真实主机别名 |
| 3 | 多主机 fan-out | ✅ | `lib/deploy.js:deployRelease`、`lib/strategy.js` | 按主机批次，不是按「实例」 |
| 4 | 5 种发布策略 | ⚠️ | `lib/strategy.js` | 只能写 YAML；UI 无策略编辑；`blue-green` 只是「先发 B 批再切」，没有流量切换器 |
| 5 | 生产护栏 + 部署锁 | ✅ | `index.js:446 prodGuardError`、`index.js:453 lockError` | confirm=prod + 单进程内存锁（重启即失效，多副本不共享） |
| 6 | 审批门 | ⚠️ | `lib/approval.js`、`index.js:658` | 只拦「手动 + confirm=prod」；scheduler 的 `allowProd` 直接绕过；无审批人角色校验 |
| 7 | RBAC | ❌（装饰性） | `lib/rbac.js`、`index.js:324`、`index.js:2313 requireWrite` | **只提供签发/校验 token 的 API，没有任何一条写路由校验 token**；`requireWrite` 只看同源 + 自定义头 + `confirm=1`，任何能打开面板的人都是 admin |
| 8 | Secrets | ⚠️ | `lib/secrets.js`、`index.js:718` | 明文落 `workDir/.secrets.json`（0600），无加密、无环境作用域、无掩码回写日志 |
| 9 | 触发器 | ⚠️ | `lib/triggers.js`、`lib/cron.js`、`lib/scheduler.js` | push webhook + cron + manual 可用；无 UI；无「同一 commit 去重」；无 PR/MR 语义 |
| 10 | 实时日志 | ✅ | `lib/live.js`、`lib/ws.js`、`/log-ws` | 单 run 单流；无按 job 分片；无 ANSI 渲染 |
| 11 | 远端 runner | ⚠️ | `lib/executors.js:createTaskBroker`、`bin/runner.mjs` | 有 labels/capacity，但**不参与调度**（只能手动选 runner）；不声明工具链能力；无安装/排水/轮换 token 的生命周期 UI |
| 12 | 多项目 | ⚠️ | `index.js:270 persistedProjectOption`、`client.js:2073` | 有下拉框，但项目不是页面上下文：无 URL、无项目主页、刷新丢失、单项目时视觉上像静态文本（用户第一反应就是「不能选项目」） |
| 13 | 制品 | ❌ | `index.js:209 artifactFor`、`lib/db.js:55 artifacts` | 「制品」= 在项目目录里 glob 出**mtime 最新**的文件，DB 只记本地绝对路径；无存储、无 digest 寻址、无提升/保留策略；换台 machine 就读不到 |
| 14 | 构建环境 / 工具链 | ❌ | `lib/runner.js:188` | 用宿主已安装的 `mvn/node/python`；无 JDK/Node/Python 版本声明；无缓存、无锁文件 |
| 15 | 依赖仓库（Nexus/Maven mirror） | ❌ | — | 只能靠宿主 `~/.m2/settings.xml` 手工配 |
| 16 | 容器构建（docker build/push） | ❌ | — | `runtime: docker` 只是生成 `docker restart`/`compose up` 命令（`lib/deploy.js:59 restartSpec`），没有构建、没有镜像、没有 registry |
| 17 | 实例（同机多进程/多端口） | ❌ | `lib/pipe.js:normalizeTarget` | target 只有 `hosts[]`；`app/service/restart` 是单实例语义 |
| 18 | 并行 / matrix / needs DAG | ❌ | `lib/runner.js` | stage 串行、step 串行；`topological()` 只用于校验环和挑 stage |
| 19 | 可复用流水线 / include | ❌ | `lib/pipe.js:395` | `version !== 1` 直接拒绝 |
| 20 | 深链 / 路由 | ❌ | `client.js` 全文无 `location/history/pushState` | 所有视图是 `useState('view')`；分享一条「某次失败运行」的链接做不到 |
| 21 | 自定义脚手架 | ❌ | `lib/scaffold.js:10 SCAFFOLD_KINDS` | 硬编码 5 种：static/node/python/go/bare，无参数、无模板目录、无导入 |
| 22 | 本地 / Git 项目 | ✅ | `index.js:1389 createProject`、`lib/git.js` | 本地目录或 `git clone`；**手动运行只 `fetch` 不 `pull`**（`index.js:636`），构建的是工作区里任意脏状态 |
| 23 | DORA 指标 | ⚠️ | `lib/dora.js` | 有计算、无趋势图；样本来自 runs 表，无「变更」概念（多 commit 合并成一次部署时失真） |
| 24 | 审计 | ⚠️ | `lib/db.js:82 operations` | 追加写但可改可删，无哈希链、无操作者身份（因为无身份） |

**计分（0–5）**：流水线引擎 2 · 构建环境 0 · 制品 0 · 部署 2.5 · 运行面 2 · 权限 0.5 · UX 1.5 · 可观测性 3。

### 2.1 P0 交付后的状态变化（2026-11-18，v3.0.0-p0）

上表是**审计时点**的事实，保留不改，作为「改之前是什么样」的凭证。下表只列 P0 动过的行：

| # | 能力 | P0 后 | 现在的代码证据 | 仍然缺什么 |
|---|---|---|---|---|
| 5 | 生产护栏 + 部署锁 | ✅→✅ | `lib/locks.js`（`deploy_locks` 表 + TTL + 心跳）、`index.js` 的 `locks.acquire` | 多副本共享（同一 SQLite 文件才共享；多机部署仍需外部锁） |
| 6 | 审批门 | ⚠️→✅ | `lib/approval.js`（落库、TTL、禁自批、绑 digest、一次性消费） | scheduler 的 `allowProd` 仍能绕过审批（P4 修）；无审批人**角色**门槛之外的团队策略 |
| 7 | RBAC | ❌→✅ | `lib/auth.js` + `lib/policy.js` + `index.js` 的 `authorize()`；旧 `lib/rbac.js` 不再参与判定 | environment 级授权（现在只到 project 级）；ReBAC 未做（保留 `can()` 契约） |
| 8 | Secrets | ⚠️→✅ | `lib/secrets.js:valuesFor` + `lib/runner.js:redactLine`（三个日志出口之前统一脱敏）、`/secrets?reveal=1` + `secret.revealed` 审计 | 载荷仍是明文文件（0600）；环境作用域未做 |
| 11 | 远端 runner | ⚠️→⚠️ | `lib/runners.js`（落库、心跳判活、吊销持久且立即生效） | **labels 仍不参与自动调度**，只能手动选；无 drain / 轮换 token 的 UI |
| 12 | 多项目 | ⚠️→✅ | `client.js` 的 hash 路由 `#/projects/:p/…` + 左侧导航 + 面包屑 + 项目切换器 | 搜索/最近/收藏、`⌘K` 面板（P6） |
| 20 | 深链 / 路由 | ❌→✅ | `client.js:parseHash/buildHash/useHashRoute`；`?line=1204` 高亮并滚动 | 列表筛选条件尚未全量进 URL（只有 `target`） |
| 24 | 审计 | ⚠️→✅ | `lib/audit.js`（`audit_events` + sha256 哈希链 + `verify()`） | 未做归档/导出到外部 SIEM |

**P0 后的净变化**：✅ 5 → 9，⚠️ 6 → 4（第 4、9、11、23 行），❌ 7 → 4（第 13–19 中仍未动的：制品、工具链、依赖仓库、容器、实例、并行/matrix、include 里剩下的部分）。八条验收的实测见 `10-roadmap.md §2`；P1 之后的变化见下面的 §2.2。

### 2.2 P1 交付后的状态变化（2026-11-19，v3.0.0-p1）

只列 P1 动过的行。测试从 82 增至 91 条（第 83–91 条为 P1 用例）。

| # | 能力 | P1 后 | 现在的代码证据 | 仍然缺什么 |
|---|---|---|---|---|
| 1 | pipe.yml 解析与校验 | ✅→✅ | `lib/pipe.js` 现在接受 `version: 1\|2`；`stages[].jobs[]`、`matrix`、`steps[]` 三选一（`run`/`uses`/`deploy`）都进校验；8 类错误码 | `include` / `extends` 仍未做（P6 模板中心会带上）；`uses` 只做到「认得出来、明确跳过」 |
| 10 | 实时日志 | ✅→✅ | `lib/runner.js` 的 `log()` 同时写合并日志与 `logs/<runId>/<job>.log`；`cicd_logs?jobId=`、`/log?jobId=`；面板日志区有「只看某个 job」下拉 | WS 订阅仍按 run 单流，没有按 job 的游标订阅 |
| 18 | 并行 / matrix / needs DAG | ❌→✅ | `lib/model.js`（归一化 + `resolveJobGraph` + `expandMatrix`）、`lib/jobs.js`（`scheduleJobs` 并发池）、`lib/expr.js`（三档求值）；`jobs.concurrency` 可配 1–32 | 跨 runner 的分布式调度（现在并发池只在本机/单个 runner 内）；job 级 `timeout` 尚未独立于 step |
| 19 | 可复用流水线 / include | ❌→❌ | — | P6 |
| 9 | 触发器 | ⚠️→⚠️ | 未动 | 同一 commit 去重、PR/MR 语义仍缺 |

另外两件 P1 顺带补上的、原表里没有列成行的事：

- **配置快照**（`runs.config_snapshot` + `config_hash`，DB v8）：原表第 24 行「审计」只关心谁做了什么，没有回答「那次到底跑的是哪版配置」。现在每次运行都带走 pipe.yml 原文与 sha256。
- **表达式求值器的安全边界**：`when` / `if` / `${{ }}` 从「正则 + 简单比较」升级为手写词法 + 递归下降解析器，**不用 `eval` / `new Function`**。这不是性能选择，是权限选择：pipe.yml 是谁提 PR 谁能改的文件。

**净变化（累计 P0+P1）**：✅ 5 → 10，⚠️ 6 → 4，❌ 7 → 3（工具链/依赖仓库/容器/实例归到 P2–P3，制品归 P5，`include` 归 P6）。

### 2.3 P2 交付后的状态变化（2026-11-19，v3.0.0-p2）

只列 P2 动过的行。测试从 91 增至 102 条（第 92–102 条为 P2 用例）。

| # | 能力 | P2 后 | 现在的代码证据 | 仍然缺什么 |
|---|---|---|---|---|
| 5 | 构建工具接入（Maven 等） | ⚠️→✅ | `lib/toolchain.js` 装 Maven / Gradle 到自己的 store；`writeDualLocks()` 产出 `toolchains.xml`（`<version>` 带补丁位）与 `gradle.properties`（`auto-detect=false`），保证 daemon 用同一棵 JDK | 内部 mirror 的 `settings.xml` 未生成（要先定下 mirror 配置放在哪个作用域） |
| 6 | JDK 版本隔离 | ❌→✅ | Resolver → CAS 安装（`mkdir` 跨进程锁 + 同进程 inflight 复用 + `.ok` 标记）→ 只改子进程 env（白名单，不 spread `process.env`）→ `assertVersions` 跑 `java -version` 断言 | 无 |
| 7 | Node 用 nvm 切 | ⚠️→✅ | 读 `.nvmrc` / `.node-version`，自己装到 CAS，PATH 前置；**不依赖 nvm shim**（非交互 shell 拿不到 source 过的 PATH） | 无 |
| 8 | Python venv | ❌→⚠️ | 解释器走 python-build-standalone 装进 CAS；`uses: cache` 支持 `~/` 作用域的 wheel 缓存 | 每 run 一个 venv（`$RUN/venv`）尚未自动创建，用户要自己写 `python -m venv` |
| 2 | 脚手架 / 模板 | ❌→❌ | — | P6 |
| 12 | 多实例 | ❌→❌ | — | P3 |
| 16 | 语言数 | ⚠️→✅ | 七门：java / maven / gradle / node / python / php / go（php 无官方可移植包，报 `TOOLCHAIN_NOT_FOUND` 并提示用容器） | 无 |
| 20 附 | `uses:` 动作 | ❌→✅ | `lib/actions.js` 七个内置动作 + `lib/cache.js`（key / restore_keys / 作用域 / LRU）；未知动作与未知参数都硬失败 | 自定义动作（有意不做：外部 action 是供应链风险）；动作级 outputs 尚未在 job 之间传递 |

另外两件 P2 顺带补上的、原表里没有列成行的事：

- **构建缓存**：`uses: cache` 是「恢复 + 收尾保存」两段式（执行到那一步时还没 build，`dist/` 是空的），存 `workDir/cache/entries`，`paths` 只接受相对项目目录或以 `~/` 开头——绝对路径直接拒绝，否则 `paths: ["/etc"]` 能把宿主整个打包进缓存。
- **动作的能力注入**：动作本身不认识环境，只声明「我要 git / 工具链 / 部署器」，由 `createActionRuntime()` 递真实实现。好处是 `lib/actions.js` 能在纯单测里跑；`deploy` 动作刻意包成「只有 deploy 的假 step」再交给 `deployStep`，这样生产确认、选择器展开、锁、审计、回滚一条都不会漏。

**净变化（累计 P0+P1+P2）**：✅ 5 → 13，⚠️ 6 → 2，❌ 7 → 3（制品 CAS、容器/多实例、`include`）。

---

## 3. 逐条回答你的问题

### 3.1 「都完成了是吗？」

没有。README 的 M0–M5 是**按功能点打勾**，不是按用户旅程闭合。真实的完成度是：

- 「手动跑一条静态站/Node 项目，传到两台 Linux，软链切换，失败能切回去」——**这条旅程是通的**。
- 「Java 项目用 JDK 17 + Maven 构建，产物进制品库，部署到 3 台机器的 2 个实例，灰度 10%，失败自动回滚，非运维人员只能看不能发」——**这条旅程一步都走不通**。

差别的根源不是「少写了几个页面」，而是四个结构性错配（见 §4）。所以修法不是继续加按钮，而是补实体、补契约。

### 3.2 「脚手架模板可以支持自定义添加吗？再内置 Java 和 PHP 模板」

现状：不能。`lib/scaffold.js:10` 是 5 个硬编码对象，`scaffoldPipe()` 拼一个固定字符串，创建项目时把 `host1` 和 `/srv/<name>` 写死（`index.js:1411`）。

方案：把脚手架从「代码里的 if/else」变成**模板包（template pack）**——
`templates/<id>/template.yml`（元数据 + 参数 schema）+ `pipe.yml.tmpl` + 可选 `files/**`；
来源三层：内置（java-maven/java-gradle/php-composer/php-laravel/node-*/go/python/docker/static）、用户目录 `workDir/templates/`、Git 仓库或 URL 导入；
参数用 JSON Schema 声明，UI 自动生成表单，预览渲染结果与文件 diff 后再落盘（详见 `04-pipe-v2.md` §7）。

Java/PHP 不是加两行 if，需要工具链、制品类型、重启方式三件套配套：
Java 要 JDK+Maven/Gradle+JAR 产物+`java -jar`/systemd；PHP 要 `composer install --no-dev`+`php-fpm` reload/`systemctl reload`+nginx root 或 symlink 切换。两者都必须有版本声明与缓存，否则模板只是「看起来像」。

### 3.3 「制品库和构建工具（Maven 之类）是如何定义、实现和接入的？」

现状：**没有制品库**。`artifacts` 表只存一个本地绝对路径 + sha256（`lib/db.js:55`），部署时 `artifactFor()` 在项目目录里按 glob 取 mtime 最新的文件（`index.js:209-224`）。这不是制品，是「猜文件」。Maven 也不存在接入层——构建命令就是宿主 shell 里跑 `mvn`，仓库配置读宿主 `~/.m2/settings.xml`。

方案：把两件事分开——

1. **依赖仓库（dependency repository）**：输入侧。项目声明 `repositories.maven.mirror: https://nexus.corp/repository/maven-public`，运行时生成临时 `settings.xml`（`-s` 传入），支持凭据来自 secret、`<mirrorOf>*</mirrorOf>`、离线模式；npm/pip/composer 同理（`npm_config_registry` / `PIP_INDEX_URL` / `COMPOSER_REPOSITORIES`）。
2. **制品库（artifact repository）**：输出侧。构建产物打包成 **blob**，按 `sha256` 内容寻址落 `<workDir>/artifacts/blobs/sha256/ab/cdef…`，清单进 DB，部署只认 `digest`；可选 `publish` 到 Nexus/Artifactory/Harbor/registry（见 `06-artifacts.md`）。

Maven 的「接入」因此有三个明确钩子：**工具链（哪个 mvn）→ 依赖仓库（从哪拉）→ 制品（往哪放）**，每个都有独立配置项与失败语义。

### 3.4 「JDK 版本这些细节怎么处理？Node 用 nvm、Python 用 venv 隔离」

现状：完全不处理。`lib/runner.js:188` 直接 `...process.env`，用的是宿主 PATH 里第一个 `java`/`node`/`python`；同一台机器上两个项目要 JDK 17 和 JDK 21 就必然打架。

方案：内置 **ToolchainResolver**（不依赖用户装 nvm/pyenv，但兼容它们）：
- 声明：`toolchain: { java: temurin-17, maven: 3.9.6, node: 20, python: 3.11 }`
- 解析：range/vendor → 精确版本 → 写入 `pipe.lock`（含 sha256 与平台矩阵）
- 安装：`<workDir>/toolchains/<provider>/<version>/<os>-<arch>/`，下载后校验、原子 rename、文件锁防并发
- 注入：只对子进程构造 `PATH/JAVA_HOME/MAVEN_OPTS/PIP_*`，不修改宿主环境
- 缓存：`m2`/`npm`/`pip`/`composer` 目录共享但按 lock hash 分键，带 LRU 清理
- Node 的 nvm、Python 的 venv 作为**可选的「用户自带」模式**：`toolchain.node.source: system|managed|nvm`，`python.venv: true` 时在 workspace 内建 `.venv` 并激活（详见 `05-toolchain.md`）。

### 3.5 「上面一排菜单混乱、割裂；UI 布局交互不标准；为什么不支持选择项目」

现状（这是事实，不是审美分歧）：
- 工具条一行 13+ 个同权重控件：项目下拉、目标下拉、构建机下拉、计划/干跑/运行/发布/审计/编辑/新建/审批/RBAC/Secrets/Runner/测试通知/刷新（`client.js:2069-2201`）。
- 其中 7 个是**整页替换**的 `view` 开关（editor/create/approvals/rbac/secrets/runners/audit），进去以后主操作区消失，按钮文案变成「切回…」，形成「模式里的模式」。
- 没有路由：`client.js` 全文无 `location/history/pushState`。刷新回到默认三栏，无法分享「这次失败的 run」。
- 项目只是一个 `<select>`（`client.js:2073`），没有项目主页、没有项目内导航；单项目时下拉退化成一行文字，用户合理推断「不能选项目」。
- 目标/构建机/项目三个下拉平铺，没有从属关系（构建机其实是执行面，跟「选哪个项目」不是一个层级）。

方案：改成 **「全局侧栏 + 项目上下文 + 页面级动作」** 三层 IA，所有实体有 URL（`/cicd/p/<project>/runs/<runId>`），工具栏最多保留 1 个主按钮 + 1 个「更多」。线框与页面职责见 `09-ui-ia.md`。

### 3.6 「不支持部署到多个主机，或者多个实例吗？」

- 多主机：**支持**。`target.hosts` 数组 + `env:/group:/tag:` 选择器（`index.js:396`），`deployRelease` 逐台 fan-out，`strategy.js` 分批；失败策略 `onHostFailure: stop|continue`。
- 多实例：**不支持**。target 只有 `hosts[]`，`app/service/restart` 是单实例语义，没有 `instances/ports/weights`，也没有「同机两个进程分别健康检查」的概念。
- 蓝绿：**名不副实**。没有流量切换器（nginx/Caddy/keepalived/SLB），所谓 blue-green 只是「按批次发」。

方案：把部署目标建模成 **Environment → Target → Instance** 三层，`instances` 声明数量/端口/权重/健康检查，driver 负责落成 `systemd@%i`、pm2 cluster 或 compose service；蓝绿/金丝雀由可选 `traffic` 段驱动代理切换，没有代理时明确降级为「滚动 + 健康门」（`07-deploy.md`）。

### 3.7 「新建流水线和编辑流水线很奇怪」

现状：新建是「创建项目 + 选 5 种模板之一 + 写死 host1」三合一（`index.js:1389-1447`）；编辑是一个 `<textarea>` + 校验 + 保存（`client.js:1089 EditorView`），没有表单、没有 diff、没有「保存到 git 分支还是只改本地」。更根本的是：**「流水线」不是实体**——它只是项目目录里的一个 `pipe.yml`，所以没法「一个项目多条流水线」「流水线模板」「流水线版本/回滚」。

方案：引入 `Pipeline` 实体（属于 Project，可有多个），创建走「模板 → 参数 → 预览 → 保存」，编辑走「表单/YAML 双模 + 校验 + diff + 保存（工作区 / 新分支 / 直接提交）」；每次保存留版本，运行记录绑定 pipeline revision（`10-roadmap.md` P2、`04-pipe-v2.md` §2）。

### 3.8 「支持部署哪些语言的项目？原生和 Docker 都支持吗？」

现状：`RUNTIME_VALUES = ['static','node','python','go','php','docker']`（`lib/pipe.js:20`）——这是**重启命令的预设**，不是构建支持。Java 不在列表里；Docker 只是 `docker restart`，不构建镜像。

方案：语言支持分三层，不要混为一谈：
- **构建**：任意语言（因为构建就是执行命令），差异体现在「工具链声明 + 缓存目录 + 产物打包规则」；内置 Java/Maven、Java/Gradle、Node、Python、Go、PHP/Composer、Rust、.NET 的预设。
- **打包**：`files`(tgz) / `jar` / `war` / `npm` / `pypi` / `oci-image` / `static`。
- **运行**：`native`（systemd/pm2/自带启动脚本）、`compose`、`docker`、`k8s`（可选）。原生与 Docker **都支持，且共用同一套 release/rollback 语义**（`07-deploy.md` §2）。

### 3.9 「本地项目或远程 git 制品库是否支持配置？」

- 本地项目：✅（`index.js:1389` 的 else 分支）。
- 远程 Git 仓库：✅ `git clone`，但**手动运行不会 `pull`**（`index.js:636` 只 `fetchQuiet`），webhook 路径才 `pullFastForward`（`index.js:958`）。这是正确性 bug：你以为在发 main，实际发的是昨天的工作区。
- 「Git 制品库」如果指 Git 作为制品存储（GitOps 仓库）：❌ 没有。
- 其他 SCM（SVN/Mercurial）：❌。

方案：`source` 显式化——`{type: local|git, url, ref, depth, submodules, lfs, clean: true}`，每次 run 在**独立 workspace** 里 checkout 到精确 commit（不再用项目目录当构建目录），支持 tag/branch/PR ref；GitOps 作为 P3 可选项（`03-architecture.md` §5）。

### 3.10 「构建主机是否支持管理？」

现状：半条。有拉取式 broker（`lib/executors.js:createTaskBroker`）、`bin/runner.mjs`（`--runner/--labels/--capacity/--join-token`）、`/runner-*` 5 条路由、面板能列出（`client.js:1314 RunnersView`）。但：
- labels/capacity **不参与调度**，run 时只能手动在下拉里选一台（`index.js:2402`）；
- 不声明「装了哪些工具链/有没有 docker/磁盘余量」，无法做能力匹配；
- 没有注册令牌的一次性签发/轮换/吊销 UI，没有 drain（排空）、没有升级、没有工作区清理策略；
- `capacity` 只影响展示，broker 仍可给同一 runner 派多个任务。

方案：Runner 升级为一等实体（`08-security-rbac.md` §5、`03-architecture.md` §6）：能力上报（toolchains/docker/disk/arch）、标签调度、一次性 join token、drain/offline、工作区 TTL 清理、并发按 capacity 真实限流。

### 3.11 「云流水线支持用户角色权限，有实现、有闭环吗？」

**没有闭环，且这是最危险的一项。** `lib/rbac.js` 能签发三角色 token、能 verify、能导审计，`/rbac` 路由和 `cicd_rbac` 工具也能调；但所有写路由的门禁是 `requireWrite()`（`index.js:2313`），它只检查：
1. 同源（`isSameOrigin`），2. 有 `x-dsh-cicd` 头，3. `confirm=1`。
**没有任何一处校验 token 或角色。** 换句话说：能看到面板的人 = 能部署生产的人；token 是拿来看的。

方案：真正的认证 + 授权闭环（`08-security-rbac.md`）：
- 认证：local 模式（单用户，保留现状的 CSRF/origin 防护）/ team 模式（账号 + 会话 cookie + PAT，HttpOnly/SameSite、登录限速）；
- 授权：`authorize(actor, action, resource)` 中间件挂在**每条**路由与工具入口，默认拒绝；项目级成员角色 + 环境保护规则（谁能批 prod）；
- 审批与角色解耦：`approvals` 记 requested_by/approved_by/decision，禁止自批，超时自动拒绝而不是永久 pending；
- 审计：append-only + 哈希链，记录 actor/action/resource/result/来源。

### 3.12 「有去研究市面上的优秀 CI/CD 吗？」

之前的文档（`docs/proposals/cicd-v2-ui-gap.md`）只有一张四列对比表，没有落到设计取舍。这次做了系统调研（引擎/工具链/制品/部署/权限/UX 六个方向，附官方链接），结论集中在 `02-research.md`，可直接落地的差异体现在 `04`–`09` 各章的字段与规则里。

---

## 4. 根因：四个结构性错配

不是「功能少」，是四个抽象错了位。这解释了为什么加页面不解决问题。

| # | 错配 | 表现 | 正确抽象 |
|---|---|---|---|
| 1 | **把「命令」当「步骤」** | step 只有 `run`（shell 字符串），环境准备/依赖/编译/打包/验证全塞进一条命令；无法缓存、无法并行、无法分 job 重试 | Step 有 `uses`（内置动作：checkout/toolchain/cache/artifact/deploy）与 `run` 两类；动作有输入输出契约 |
| 2 | **把「文件」当「制品」** | glob mtime 最新文件 + 记本地路径 | 制品 = 内容寻址 blob + manifest + provenance；部署只认 digest |
| 3 | **把「SSH 传文件」当「部署」** | tgz + symlink + restart；无实例、无流量、无迁移钩子 | Deployment = Release(artifact digest + 配置快照) × Target × Instance，driver 负责落地与验证 |
| 4 | **把「能点」当「有权限」** | 同源 + 自定义头 + confirm=1 | 身份 → 角色 → 权限 → 审批 → 审计，默认拒绝 |

第 1 条还带来一个隐蔽后果：**没有 workspace 生命周期**。构建直接在项目目录里跑，`node_modules`/`target`/`.venv` 与源码混在一起，产物 glob 会命中上一次构建的残留（`index.js:214` 的注释自己都承认「按字母序取第一个会把旧包部署上去」）。这不是靠小心能避免的，必须有「干净工作区 + 显式产物收集」。

---

## 5. 已经做对、不要推翻的部分

重构不等于重写。下面这些设计是对的，应该保留并强化：

1. **拉取式 runner**（runner 主动 poll，服务端不推）——穿过 NAT/防火墙最省事，GitLab/Jenkins 都这么做。
2. **releases/current symlink + 保留 N 份**——Capistrano/Deployer 验证过 15 年的模型，回滚就是切链接，秒级。
3. **生产护栏 + 审批 + 部署锁** 三件套的方向——只是要把「confirm=prod」升级成「角色 + 环境规则 + 审批」。
4. **pipe.yml 单文件 + 带行号诊断**——比 Jenkinsfile 的 Groovy 沙箱简单得多，适合本地优先；不要换成图灵完备的 DSL。
5. **SQLite + 追加式 operations**——单机场景正确；只要补哈希链和 actor 就能当审计。
6. **同源 + 自定义头的 CSRF 防护**——local 模式够用，team 模式再加会话。
7. **WebSocket 实时日志**——已有，别改成轮询。

---

## 6. 本文档集怎么读

| 文件 | 内容 | 读者 |
|---|---|---|
| `01-assessment.md` | 现状审计、逐条回答、根因 | 决策者 |
| `02-research.md` | 六大方向调研与设计取舍（附官方链接） | 架构师 |
| `03-architecture.md` | 目标架构、领域模型、状态机、协议、数据模型 | 架构师/后端 |
| `04-pipe-v2.md` | pipe.yml v2 完整规范（字段表/求值时机/迁移） | 后端/用户 |
| `05-toolchain.md` | 工具链解析、安装、缓存、锁文件、失败模式 | 后端 |
| `06-artifacts.md` | 制品模型、CAS、依赖仓库、提升、保留 | 后端 |
| `07-deploy.md` | 部署驱动、多主机多实例、策略、健康门、回滚 | 后端/运维 |
| `08-security-rbac.md` | 认证、授权矩阵、审批、密钥、审计 | 后端/安全 |
| `09-ui-ia.md` | 信息架构、页面线框、交互规范、空状态 | 前端/设计 |
| `10-roadmap.md` | 分期、验收标准、工作量、迁移、风险 | 所有人 |
| `schemas/pipe.schema.json` | 可机读的 DSL Schema | 实现者 |
| `examples/*.yml` | Java/PHP/Node-Docker/多实例 四个真实样例 | 用户 |
