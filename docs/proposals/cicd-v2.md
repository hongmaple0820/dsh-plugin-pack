# dsh-cicd v2：把 CI/CD 插件做成闭环产品 —— 调研与完整方案

> 面向读者：`@local/dsh-cicd` 的维护者与使用它的个人 / 小团队开发者。
> 目标：回答「为什么现在这个插件不是闭环」，并给出一份可以按里程碑落地的完整产品设计。
> 前置文档：`docs/proposals/cicd-lite.md`（v0.1 的调研与 L1/L2/L3 三段式架构），本文在其之上补全「产品闭环」维度，并对照 2026 年的开源现状刷新调研。

---

## 0. 一句话结论

当前 v0.6.1 做完了「**本地构建 → SSH 发布 → 软链回滚 → 记录**」这一段 **CD 后半程**，但它**没有入口**（不能新建流水线、不能选源码）、**没有触发器**（只能手动点）、**没有远端执行面**（构建永远在本机，也没有 server/agent 模式）。所以它是一台「部署执行器」，不是一条「流水线产品」。

要闭环，缺的不是更多命令，而是三样东西按顺序补上：

1. **入口**：项目 / 流水线创建向导（本地目录 or Git 仓库）+ `pipe.yml` 脚手架 / 校验 / 编辑器 —— 让「新建一条流水线」成为一分钟的事。
2. **触发与反馈**：Git webhook 入站 + cron 定时 + 手动，配实时日志流（WS/SSE）与 DORA 指标 —— 让流水线「自己跑起来」并「能被看懂」。
3. **执行面可迁移**：构建主机可选（本地 / 远端 runner）+ 部署到 N 台主机的策略（串行 / 并行 / 滚动 / 蓝绿 / 灰度）—— 让同一套流水线既能本机跑，也能交到远端构建机或常驻流水线服务上跑。

这三样补上后，现有已经做得很扎实的「releases/current 软链 + 健康检查 + 自动回滚 + 审计」就成了完整闭环里最可靠的最后一公里。

---

## 1. 现状盘点（v0.6.1 到底有什么）

先诚实列出今天已经存在的能力，后面所有「差距」都对照这张表。

| 维度 | 现状 | 备注 |
|---|---|---|
| 工具面 | `cicd_projects / plan / run / status / logs / releases / rollback / targets` 8 个 | 给 Agent 用 |
| HTTP 面 | 10 条 GET 路由（`projects/plan/run/runs/log/releases/rollback/targets/operations/notify-test`） | 写操作 `confirm=1` + 同源 + `x-dsh-cicd:1` 头 |
| 流水线 DSL | `pipe.yml` 子集：map/sequence/标量，`${{VAR}}` 插值，受限 `when`（branch/tag/env/changed），glob，stage DAG | 不支持块标量 `\|`、flow map |
| 执行 | **本地** spawn，逐 stage **串行**跑 step | 无并行、无矩阵、无取消 |
| 部署 | 经 dsh-remote SSH 回环：`releases/<id>` + `current` 软链、多主机 fan-out（串行）、2 批灰度、runtime 预设重启、健康检查、失败自动回滚 | 回滚语义扎实 |
| 记录 | SQLite（`node:sqlite`，WAL）五表 runs/steps/artifacts/releases/operations，schema v3 | 含 branch/commit 字段但无 git 来源 |
| 通知 | **出站** webhook（HMAC-SHA256），run/rollback 事件 | 只有「推出去」，没有「收进来」 |
| 安全 | env/group/tag 选择器、生产护栏（`confirm=prod`）、部署锁（`DEPLOY_IN_PROGRESS`）、审计时间线 | 单机单用户，无 RBAC |
| 项目来源 | config.yaml 显式注册，或从当前工作目录自动发现 `pipe.yml` | **没有创建向导、没有 git 仓库来源** |

结论：**部署与回滚这条链是过硬的，缺的是「前面的输入」和「中间的编排/执行面」。**

---

## 2. 用户痛点 → 差距分析

把用户的原话拆成能力点，逐条对照现状：

| # | 用户诉求 | 现状 | 差距结论 |
|---|---|---|---|
| 1 | 新建流水线 | 只能 config.yaml / cwd 发现 | **缺** 创建向导 |
| 2 | 选择本地项目 or git 仓库 | 仅本地路径 | **缺** git clone/fetch/checkout、commit/branch/tag 采集 |
| 3 | 配置工作流脚本 | 手写 `pipe.yml` | **缺** 脚手架 / 校验 / 编辑器 |
| 4 | 选择远程 or 本地构建主机 | 永远本地 | **缺** 远端 runner（M3） |
| 5 | 部署到 N 台目标主机 | fan-out + 2 批灰度 | **弱** 无并行 / 滚动 N 批 / 蓝绿 |
| 6 | 使用远程主机的 CI/CD 流水线服务 | 无 | **缺** server + agent 常驻模式 |

对照成熟产品，还有一批「闭环必需品」当前完全空白：

| 能力 | 成熟产品普遍有 | 我们现状 |
|---|---|---|
| 触发器 | push/PR/tag/release/cron/manual | 只有 manual |
| Secrets 管理 | 环境/仓库级加密变量 | 无（密钥只能放 config） |
| 制品 & 缓存 | artifact 下载、构建缓存 | 有 artifacts 表，无缓存 |
| 取消 / 重试 | 一键 cancel、失败重跑 | 无 cancel |
| 并行 / 矩阵 | stage 级并行、matrix 展开 | 串行，无 matrix |
| 实时日志 | WS/SSE 流 | 轮询 tail |
| 环境 & 晋升 | dev→staging→prod + 审批 | 只有 target 概念 |
| 人工审批 | manual gate / block step / 环境 required reviewer | 无 |
| RBAC | 团队、角色、范围 | 无（单机单用户） |
| 可观测性 | DORA 四指标、耗时分布 | 只有列表 |

---

## 3. 调研：开源 CI/CD 各自的取舍（2026 刷新）

在 `cicd-lite.md` §2 的基础上，补充 GitHub Actions / GitLab CI / Buildkite / ArgoCD / Gitea Actions 的最新事实。核心结论不变：**不要再造一个 Jenkins**，而是把「入口 + 触发 + 执行面可迁移」这三个薄层补到现有 L1/L2/L3 架构上。

| 项目 | 形态 | 值得抄的 | 不抄的 |
|---|---|---|---|
| **GitHub Actions**（[docs](https://docs.github.com/actions)） | 托管 workflow + 可选 self-hosted runner | **environments 的审批门**（required reviewers + wait timer + 环境级 secrets）、reusable workflows、concurrency 组 | workflow 语法绑定 GitHub 事件模型，不可移植 |
| **GitLab CI**（[docs](https://docs.gitlab.com/ee/ci/)） | 单仓库 `.gitlab-ci.yml` + runner | **environments 即「部署标签」**（按环境给权限、看部署历史）、protected environments、manual job 审批、pipeline editor | 平台捆绑重，单机用不上 |
| **Buildkite**（[docs](https://buildkite.com/docs)） | 云控制面 + 自托管 agent，YAML | **`block` step（审批对话框 + allowed_teams + prompt）**、`wait`/`depends_on` 显式依赖、agent 心跳模型 | 商业控制面，本地不适用 |
| **Woodpecker CI**（[woodpecker-ci.org](https://woodpecker-ci.org/)） | Server+Agent，Go，默认 SQLite，单二进制 | **单二进制 + SQLite + agent 多机扩**；push/PR/tag/release/cron/manual 全触发；matrix；fork 审批；live logs | 步骤绑 Docker（个人机常没 Docker）；绑 forge |
| **Gitea Actions / gitea-runner**（[SKILL](https://cdn.jsdelivr.net/npm/k8s-agent-skills@1.10.0/skills/gitea-runner/SKILL.md)） | 仓库内 runner，Go，v1.0.6（原 act_runner） | **注册 token + 标签匹配**（`ubuntu-latest:docker://node:20-bookworm`）、instance/org/repo 三级 token、ephemeral runner | 绑 Gitea；动作生态是 GH 语法子集 |
| **Drone** | Server+Runner，YAML | pipeline 语法简洁 | 社区版停更、已商业化 |
| **Jenkins** | Master+Agent，Java | agent「拉任务 + 心跳」协议 | 太重，Groovy 不透明 |
| **ArgoCD**（[argo-cd.readthedocs.io](https://argo-cd.readthedocs.io/en/stable/)） | K8s 原生 GitOps | **声明式「期望状态 + 自动同步 / 手动同步」**（dev 自动、prod 手动审批）、可审计 | 前提 K8s，与本需求不匹配 |
| **Dagger / Tekton / Concourse** | 容器/CRD 原语 | 可复现、声明式 | 依赖容器运行时或 K8s |

**三条最值钱的结论（沿用并强化 cicd-lite.md）**：

1. **Capistrano 目录约定**（`releases/<id>` + `current` 软链 + `shared/` + `revisions.log`）—— 我们已实现，是回滚的教科书式底座。
2. **Woodpecker 的 backend/agent 分离** —— 执行面与状态面分离，是「本地构建 / 远端构建」二选一的协议边界。
3. **GitHub Actions 的 environment 审批门 + Buildkite 的 block step** —— 是「环境晋升 + 人工审批」最可抄的产品原语，两者本质相同：**在发布路径上插一个「必须有人点头」的闸门**。

---

## 4. 「闭环」到底指什么

一句话：**从「代码进了仓库」到「线上可见新版本」，再回到「这次改动是不是把线上搞坏了」的反馈，全程在面板里可见、可触发、可回滚。**

闭环的三个回路：

```
回路 A（触发）：git push ──webhook──▶ 流水线自动跑          （缺）
回路 B（执行）：流水线 ──本地 or 远端 runner──▶ 部署 N 台   （执行面可迁移，缺）
回路 C（反馈）：运行结果 / 日志流 / DORA 指标 / 一键回滚    （日志流与指标缺，回滚已有）
```

A 是入口，B 是引擎，C 是反馈。C 里「回滚」已经做完了，所以 v2 的增量集中在 A 和 B，以及 C 的「实时日志 + 指标」两小件。

---

## 5. 目标架构（L1/L2/L3 的演进）

沿用 cicd-lite.md 的三段式，做两处增强：**(1) L1 增加「项目/流水线注册表 + 触发器 + 调度器」；(2) L2 从「可选」升为「本地/远端二选一的执行面」，并支持「远端流水线服务」模式。**

```
┌──────────────────────── 控制面（L1 orchestrator，DSH 插件）────────────────────────┐
│  项目注册表（本地路径 / git 仓库 / 远端 runner 引用）                               │
│  流水线（pipe.yml v2：脚手架→校验→编辑）  触发器（webhook 入站 / cron / manual）    │
│  调度器（排队 / 并发上限 / 取消 / 矩阵）  环境与审批（dev→staging→prod + block）    │
│  Secrets（keychain）  Artifacts/Cache   记录（SQLite v4）  DORA 指标              │
└───────┬───────────────────────────────┬───────────────────────────────┬──────────┘
        │ 执行面 A：本地 runner           │ 执行面 B：远端 runner（L2）      │
        │ 直接 spawn，串行/并行            │ 拉取式 claim，心跳，mTLS        │
        ▼                                ▼                                 ▼
   本机 shell                       构建机 / 常驻流水线服务           目标机群（N 台）
                                    （server+agent 模式，支持 RBAC）    releases/current 软链
```

关键取舍（延续 v0.1）：**保留「直连 SSH」这条路**。个人场景最痛的是「为了部署先装一堆东西」，所以 L1 不装 runner 也能部署；runner 只在「需要常驻触发 / 并发 / 缓存 / 目标机在内网 / 想要远端流水线服务」时引入。

---

## 6. 功能设计（按依赖顺序）

下面每一项都落到「要做成什么样」和「验收标准」，里程碑见 §12。

### 6.1 P0 · 入口：项目与流水线创建向导

**目标**：把「新建流水线」从「改 config.yaml」变成一分钟向导。

- **来源二选一**：
  - **本地项目**：选一个目录，检测到 `pipe.yml` 就直接登记；没检测到就进入脚手架。
  - **Git 仓库**：填 URL（+ 可选分支 / 认证 ref），执行 `git clone --depth=1`（或复用已有 checkout），扫描 `pipe.yml`，登记 repo URL / 默认分支。
- **Git 集成（闭环 A 的前提）**：每次运行前 `git fetch` + 记录 `commit_sha / branch / tag / 最近提交信息`，回填到 runs/releases 表（现在这两列是空的）。**不实现**完整 git 客户端，只做「取源码 + 读元数据」。
- **脚手架**：`pipe.yml` 模板库（静态站 / Node / Python / Go / Docker / 裸进程），向导按语言生成最小可用流水线，含 `build → package → deploy` 三阶段和注释。
- **校验**：把现有 `pipe.js` 解析器暴露成「保存前校验」，错误带行列号、给可点击定位；`dry-run` 从编辑器直接触发。
- **编辑器**：`pipe.yml` 的编辑面板（行号 + 语法高亮 + 实时校验 + `${{VAR}}` 提示），不追求完整 IDE。

**验收**：从「点新建」到「第一次 dry-run 通过」≤ 1 分钟；本地目录与 git 仓库两条路径都能登记并跑通。

### 6.2 P0 · 构建主机选择：本地 / 远端 runner

**目标**：同一个 `pipe.yml`，构建在哪跑由运行者选。

- **执行面抽象**：把 `runner.js` 的「spawn 本地进程」抽象成 `Executor` 接口（`start/log/cancel/result`），本地实现保持现状，远端实现走 L2 协议。
- **UI**：运行按钮旁一个「构建主机」下拉：`本机` / 已注册的 runner 列表（含标签、负载、版本）。
- **远端 runner（L2，M3 落地）**：拉取式协议（见 §6.6），Rust 单二进制，负责领任务 → 跑 step → 回传日志/产物。

**验收**：同一 `pipe.yml` 能在「本机」和「远端 runner」两种执行面跑出相同结果；runner 断线重连任务不丢（journal 幂等）。

### 6.3 P0 · 部署到 N 台主机：策略化

**目标**：从「串行 fan-out + 2 批灰度」升级为可配置的发布策略。

| 策略 | 语义 | 现状 |
|---|---|---|
| `serial` | 逐台部署，一台失败即停（现有 fan-out） | ✅ 已有 |
| `parallel` | 所有主机并发部署 | ➕ 新增 |
| `rolling` | 每批 N 台，批间等健康检查通过 | ➕ 新增（把现有 2 批灰度泛化成 N 批） |
| `canary` | 先 1 台 + 观察窗口 + 自动扩量/回退 | ⚠️ 现有是「2 批」，需补自动分析 |
| `blue-green` | 起一套完整新实例，切流量后旧实例退役 | ➕ 新增（容器/反向代理目标） |

- 用 dsh-remote 的主机分组（env/group/tag）做「按环境分组滚动」；`onHostFailure: stop|continue` 语义保留。
- **部署锁**从「一个 target 一把锁」泛化为「一个 target 一把可重入的策略锁」，滚动中记录进度，中断可续。

**验收**：5 台主机用 `rolling: {batch:2, waitSec:30}` 能分批推进、单台失败按策略停止或跳过；回滚仍是一键 `current` 切回。

### 6.4 P0 · 触发器：webhook 入站 + cron + manual

**目标**：让流水线「自己跑」。

- **webhook 入站**：新增一条入站路由 `/api/plugins/cicd/hooks/{project}`，接收 GitHub/GitLab/Gitea/Forgejo 的 push 事件，验签（共享 secret），匹配分支/tag 规则后入队。这是「出站 notify」的镜像补充。
- **cron 调度**：`pipe.yml` 里 `on: schedule`，cron 表达式，落在 L1 常驻进程里跑（单机模式）；远端服务模式落在 server 上。
- **manual**：现状保留。

**验收**：`git push` 到 main 自动触发一次 run；定时任务按 cron 触发；三者都写审计。

### 6.5 P1 · 环境与晋升 + 人工审批

**目标**：补上「dev→staging→prod」和「发布到生产必须有人点头」。

- **环境（environment）**：把现有 `target` 升格为 `environment`，带顺序（dev < staging < prod）与保护规则；面板显示每个环境当前 release（复用 `active` 字段）。
- **审批（block gate）**：抄 Buildkite 的 `block` step + GitHub 的 environment required reviewer。`pipe.yml` 支持 `stage.manual: true`（cicd-lite.md 早就设计了，一直没实现）；生产环境默认 `manual: true`。
- **生产护栏**沿用现有 `confirm=prod`，审批通过后再走它，双重确认。

**验收**：`deploy` 到 prod 阶段会停在「待审批」，面板点「通过」才继续；未授权环境无法部署。

### 6.6 P1 · 远端流水线服务模式（server + agent）

**目标**：让「CI/CD 流水线服务」可以部署在远端主机上，多人共用同一套流水线。

- **拉取式协议**（沿用 cicd-lite.md §8，六条消息）：

```
runner ──register{id,labels,capacity,version}──▶ server
       ◀──token / mTLS 证书──
runner ──heartbeat(15s)──▶
runner ──claim{labels}──▶ ◀──task spec──
runner ──log(chunk,seq)──▶ ◀──cancel──
runner ──result{exit,artifact hash}──▶
```

- **鉴权**：一次性 join token → 换 mTLS 客户端证书（短效 + 续期）。
- **幂等**：`task_id + attempt`，runner 写本地 journal，重启续报。
- **RBAC（远端模式才需要）**：`user → role(viewer|operator|admin) → environment/project 范围`，token 短 TTL，写操作全审计。单机模式仍是无角色单用户。
- **复用而非重造**：跳板机/堡垒机仍走 cicd-lite.md §9 的「复用 ProxyJump / runner 反向隧道 / 集成 Warpgate」三层，不做会话录制。

**验收**：一台远端 server + 两台 runner，并发跑两个 job，日志不丢块；一个 runner 断电重启后任务可续；三角色权限生效。

### 6.7 P1 · Secrets / Artifacts / Cache / 取消 / 并行 / 矩阵 / 实时日志

这些是闭环的「体验件」，一起列：

| 能力 | 设计 | 现状 |
|---|---|---|
| Secrets | 进 OS keychain（DPAPI/Keychain/Secret Service），DB 只存 ref；环境级 + 项目级 | 缺 |
| Artifacts | 已有表；补「面板下载 + 跨 run 复用」 | 半 |
| Cache | 按 `cacheKey`（依赖文件 hash）复用构建目录；远端 runner 本地缓存 | 缺 |
| 取消 | `cicd_cancel` 工具 + `/cancel` 路由；SIGTERM→宽限→SIGKILL | 缺 |
| 并行 stage | 把「逐 stage 串行」改成 DAG 拓扑排序 + 受 `concurrency` 上限约束的并行 | 缺（runner.js 明确「M1 无并行」） |
| Matrix | `matrix:` 字段展开成并行 job | 缺 |
| 实时日志 | WS upgrade（webServer.registerUpgrade，参考本仓库 `/vnc-ws` 先例），轮询兜底 | 轮询 |

### 6.8 P2 · 可观测性：DORA 指标

**目标**：让 C 回路「能看懂」。

- 落库：每次 run/release 记录 `deploy_frequency`（每天/每周部署次数）、`change_lead_time`（commit→上线）、`change_fail_rate`（失败/回滚占比）、`mt_to_recover`（失败到恢复时长）。
- 面板：一个「交付」页，四指标卡片 + 趋势图，数据全部来自现有 SQLite，不需要外部监控。

DORA 四指标定义（[参考](https://engineering.homeoffice.gov.uk/standards/collect-dora-metrics/)）：变更前置时间、部署频率、变更失败率、失败恢复时间。

---

## 7. 流水线 DSL 演进（pipe.yml v2）

在现有子集上**增量**，不破坏已有解析：

```yaml
version: 2
name: shop-web

source:                        # v2 新增：来源（向导填）
  type: git                    # git | local
  url: git@github.com:acme/shop-web.git
  branch: main

triggers:                      # v2 新增：触发
  push: { branches: [main], tags: ['v*'] }
  schedule: [{ cron: '0 3 * * *' }]
  manual: true

vars: { NODE_VERSION: "22", APP: shop-web }

environments:                  # v2 新增：环境（target 升格）
  staging:
    hosts: [linux26]
    strategy: { type: rolling, batch: 2, waitSec: 30 }
  prod:
    hosts: [env:prod]          # 选择器展开
    manual: true               # 发布到生产需审批
    strategy: { type: blue-green }

stages:
  - id: build
    runsOn: [linux, node-22]   # v2 新增：构建主机标签（本机=local）
    matrix: { NODE_VERSION: [20, 22] }   # v2 新增
    steps:
      - run: npm ci
        cacheKey: package-lock.json      # v2 新增
      - run: npm run build
      - run: tar -czf dist/${{APP}}-${{RELEASE_ID}}.tgz -C dist/app .
        artifact: dist/*.tgz
  - id: deploy
    needs: [build]
    steps:
      - deploy: { target: prod, artifacts: [dist/*.tgz] }
```

兼容策略：`version: 1` 的旧 `pipe.yml` 原样可跑；`targets` 自动映射为单环境 `environments`。

---

## 8. 数据模型 v2（SQLite，schema v4）

在现有五表上新增（迁移沿用 `ALTER TABLE` 补列 + `PRAGMA user_version` 的老办法）：

```sql
-- 项目/流水线注册表（向导填的，替代 config.yaml 手工注册）
projects(id PK, name, source_type,     -- git | local
         repo_url, default_branch, pipe_path, created_at)

-- 触发器（webhook 验签 + cron 规则）
triggers(id PK, project_id, kind,      -- webhook | cron | manual
         secret_ref, branch_pattern, tag_pattern, cron_expr, enabled)

-- 环境（target 升格，带保护与晋升顺序）
environments(id PK, project_id, name, ord,   -- dev<staging<prod
             protected, approval_required)

-- 远端 runner 注册表
runners(id PK, labels, capacity, version, last_seen_at, status)

-- secrets 只存 ref，载荷进 keychain
secrets(id PK, project_id, scope, ref, created_at)

-- DORA 指标（可从 runs/releases 派生，但物化一列便于查）
metrics(run_id PK, lead_time_s, deployed_to, failed, recovered_in_s)
```

`runs` 表补 `source_commit / source_branch` 真实 git 元数据；`steps` 补 `runner_id`（区分本地/远端执行）。

---

## 9. HTTP / 工具 API 面（v2 全量）

工具（Agent 用，从 8 → 12 个）：

| 工具 | 作用 |
|---|---|
| `cicd_projects` | 项目/流水线列表（含 source、runner） |
| `cicd_project_create` | **新增** 新建项目（本地/git） |
| `cicd_plan` | dry-run 计划 |
| `cicd_run` | 触发运行（`runner`、`strategy` 可选） |
| `cicd_cancel` | **新增** 取消运行 |
| `cicd_status` | 运行列表/状态 |
| `cicd_logs` | 日志（增量） |
| `cicd_releases` | 版本列表 |
| `cicd_rollback` | 回滚 |
| `cicd_targets` | 环境/目标（含策略、审批状态） |
| `cicd_secrets` | **新增** secrets 读写（ref 化） |
| `cicd_runners` | **新增** runner 列表/状态 |

路由（GET + resource，沿用现有安全约定；新增入站 webhook 与实时日志）：

| 路由 | 说明 |
|---|---|
| `/api/plugins/cicd/projects` / `/project-create` | 项目登记（create 为写，`confirm=1`） |
| `/api/plugins/cicd/hooks/{project}` | **入站 webhook**（验签） |
| `/api/plugins/cicd/log-ws?runId=` | **实时日志 WS**（upgrade） |
| 其余 | 沿用现有 10 条 + `cancel`、`runners`、`secrets` |

写操作安全约定不变：同源 + `x-dsh-cicd:1` 头 + `confirm=1`（生产 `confirm=prod`）+ 拒绝未知参数。

---

## 10. 安全模型（在 v0.6.1 之上加三层）

1. **凭据不落明文**：secrets 进 OS keychain，DB 只存 ref（v0.1 §10 早就设计，一直没做）。
2. **入站 webhook 验签**：共享 secret HMAC 校验，失败 401，杜绝伪造触发。
3. **审批 + 护栏双确认**：生产环境默认 `manual: true`（人工审批）+ 现有 `confirm=prod` 护栏。
4. **远端模式才加 RBAC**：单机模式仍无角色；server 模式 `viewer/operator/admin`，写操作全审计。
5. 沿用：主机指纹固定、最小权限 sudoers 白名单、审计时间线、部署锁。

---

## 11. 路线图（每阶段可验收）

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **V2-M0 入口（1 周）** | 项目/流水线创建向导（本地+git）、`pipe.yml` 脚手架 + 校验 + 编辑器、git 元数据回填 | 一分钟新建并 dry-run 通过；commit/branch 落到 runs |
| **V2-M1 触发与反馈（1–2 周）** | webhook 入站 + cron + 手动、实时日志 WS、取消、DORA 四指标面板 | `git push` 自动触发；日志实时滚动；失败可 cancel；指标页有数 |
| **V2-M2 执行面可迁移（2–3 周）** | Executor 抽象、远端 runner（Rust，拉取式 + mTLS + journal 幂等）、构建主机下拉 | 同一 `pipe.yml` 本机/远端跑出一致结果；runner 断电续跑 |
| **V2-M3 发布策略（1–2 周）** | serial/parallel/rolling/canary/blue-green 策略化 + 策略锁 | 5 台 rolling 分批推进、单台失败按策略处理；回滚仍一键 |
| **V2-M4 环境/审批/secret（1–2 周）** | environment 升格 + block 审批 + secrets(keychain) + 制品/缓存 | prod 部署停在审批；secret 不落明文；缓存复用生效 |
| **V2-M5 远端服务 + RBAC（可选）** | server 常驻模式 + 三角色 RBAC + 审计导出 | 三人三角色、写操作有审计、token 过期自动拒 |

> 建议同 v0.1：**M0–M4 用 TypeScript 直接做**（同栈、快、先验证 UX 与语义）；M2 的 Rust runner 只在协议被 M2 前半段（Node PoC）验证后再上——Rust 是「换实现」不是「赌设计」。

---

## 12. 风险与取舍

| 风险 | 说明 | 对策 |
|---|---|---|
| 入口做重，变成 Jenkins | 向导 + 编辑器 + 矩阵堆下去失控 | 只做「来源 + 脚手架 + 校验 + 编辑」，不做插件市场、不做内置 IDE |
| 触发器引入面攻击 | 入站 webhook 被伪造 | 共享 secret HMAC + 只认受信源 + 落审计 |
| runner 协议自造 | 与 Woodpecker/act_runner 重复 | 只做六条消息最小集；标签模型照抄 act_runner |
| 策略锁复杂 | rolling/blue-green 状态机难写 | 先 serial/parallel/rolling，blue-green 只对容器/反代目标开 |
| secrets 平台差异 | keychain 三平台实现繁琐 | 先用 DSH 既有配置存储兜底，keychain 作为增强 |
| git 依赖扩散 | 每条流水线一把 git 凭据 | 复用 dsh-remote 的 hosts/凭据 ref 模型，不新增凭据体系 |

---

## 13. 参考

- Capistrano 目录结构与回滚 — <https://capistranorb.com/documentation/getting-started/structure/> 、<https://capistranorb.com/documentation/getting-started/rollbacks/>
- Kamal（本地驱动远端、rollback）— <https://kamal-deploy.org/>
- Woodpecker CI（单二进制+SQLite+agent，多触发/matrix/live logs）— <https://woodpecker-ci.org/> 、<https://github.com/woodpecker-ci/woodpecker>
- Gitea Actions / gitea-runner（注册 token + 标签 + ephemeral）— <https://docs.gitea.com/usage/actions/overview>
- GitHub Actions（environments 审批门、reusable workflows、concurrency）— <https://docs.github.com/actions>
- GitLab CI（environments、protected environments、manual job）— <https://docs.gitlab.com/ee/ci/>
- Buildkite（block step / wait / depends_on 审批模型）— <https://buildkite.com/docs/pipelines>
- ArgoCD（GitOps 声明式 + 自动/手动同步）— <https://argo-cd.readthedocs.io/en/stable/>
- Jenkins（master/agent 协议）— <https://www.jenkins.io/>
- DORA 四指标 — <https://engineering.homeoffice.gov.uk/standards/collect-dora-metrics/>
- 发布策略（core strategy + add-ons）— <https://github.com/peterbamuhigire/chwezi-dev-engine/blob/main/skills/devops-cloud/deployment-release-engineering/references/rollout-selection.md>
- 跳板机 / Warpgate / JumpServer / Teleport — 见 `docs/proposals/cicd-lite.md` §9
