# dsh-cicd V2.0 UI/UX 差距报告与改进方案

## 一、现状诊断（基于 m01822–m01826 截图 + 代码审查）

### 1. 面板功能缺失（后端有、前端没暴露）

| 后端能力 | 代码位置 | 面板状态 |
|---|---|---|
| 多项目切换 | `client.js:1757` 单项目时退化为静态文本，无"切换到其它项目"入口 | ❌ 只有一项时看不到选择器 |
| 多主机 fan-out | `lib/deploy.js:hostsOf` + `lib/strategy.js:normalizeStrategy` | ✅ 目标卡片显示 hosts chips（截图2可见 linux26 + test） |
| 5 种发布策略 | `lib/strategy.js` serial/parallel/rolling/canary/blue-green | ❌ 面板无策略选择器，只能在 pipe.yml 里写 |
| 环境/审批门 | `lib/environments.js` + `lib/approval.js` | ❌ 面板无审批页签，`cicd_approve` 工具存在但 UI 没接 |
| RBAC 管理 | `lib/rbac.js` + `/rbac` 路由 | ❌ 面板无 RBAC 入口，`cicd_rbac` 工具存在但 UI 没接 |
| Secrets 管理 | `lib/secrets.js` + `/secrets` 路由 | ❌ 面板无 secrets 入口，`cicd_secrets` 工具存在但 UI 没接 |
| 构建主机管理 | `lib/runner.js` + `bin/runner.mjs` + `/runner-*` 路由 | ⚠️ 工具条有下拉（截图2可见），但无"管理 runner"入口（注册/移除/详情） |
| DORA 指标 | `lib/dora.js` + `/dora` 路由 | ❌ 面板无 DORA 页签 |
| 触发器配置 | `lib/triggers.js` + `lib/cron.js` + `lib/scheduler.js` | ❌ 面板无触发器配置入口（只能在 pipe.yml 里写） |
| 实时日志 | `lib/live.js` + `lib/ws.js` + `/log-ws` | ✅ 已有跟随日志（截图2 Run详情可见） |

### 2. 交互问题（截图直接暴露）

| 问题 | 截图位置 | 根因 |
|---|---|---|
| 项目选择器"不可见" | 截图2：工具条写死「项目 dsh-demo-site」 | 单项目时 `client.js:1757` 退化为静态文本，用户以为不能切 |
| 新建/编辑按钮位置不直观 | 截图1：新建在"创建并登记"按钮下方；截图2：编辑在工具条 | 新建/编辑是独立视图（`view: 'create'` / `view: 'editor'`），但工具条按钮 label 是"回到运行"vs"编辑"，语义不清晰 |
| 多主机部署不显眼 | 截图2：目标卡片 hosts chips 太小（11px） | `client.js:697-704` chips 用 `cicd-host-chip`（11px font），多主机时视觉权重不够 |
| 语言/Docker 部署无配置入口 | — | 脚手架只有 5 种（static/node/python/go/bare），没有 Java/Ruby/Rust/Docker 模板 |
| 没有"我的流水线"总览 | 截图2：三栏是 阶段/目标 → Run详情 → Releases | 缺少跨项目的 pipeline 总览（哪些在跑、哪些失败、最近一次部署时间） |

### 3. 对标市面 CICD 的能力差距

| 能力 | Jenkins | GitLab CI | ArgoCD | GitHub Actions | dsh-cicd 现状 |
|---|---|---|---|---|---|
| 多语言脚手架 | 插件化（2000+） | 内置 10+ 语言模板 | Helm 模板 | 社区 Action | 5 种（static/node/python/go/bare） |
| 原生 + Docker 部署 | 均可 | 均可 | 原生 K8s | 均可 | 原生 ✅ + Docker 预设 ✅（`runtime: docker` 生成 `docker compose`/`docker restart` 命令） |
| 远程 Git 制品库 | Git 仓库 ✅ | GitLab Registry ✅ | GitOps（Git 仓库） | GitHub Packages | Git clone ✅（`cicd_project_create` + `lib/git.js`），制品库 ❌ |
| 构建主机管理 | Agent ✅ | Runner ✅ | 无（K8s 调度） | 无（GitHub 托管） | Runner ✅（`lib/executors.js` + `bin/runner.mjs` 拉取式协议），管理 UI ❌ |
| 用户角色权限 | Matrix Auth ✅ | 项目角色 ✅ | 无 | 无（repo 级） | RBAC ✅（`lib/rbac.js` 三角色 + 项目范围 + TTL token），管理 UI ❌ |
| 审批门 | 插件 | 手动 Job | 无 | 无 | ✅（`lib/approval.js` + `/approve` 路由），管理 UI ❌ |
| DORA 指标 | 插件 | 内置 | 无 | 无 | ✅（`lib/dora.js` + `/dora` 路由），管理 UI ❌ |
| 实时日志 | Web UI ✅ | Web UI ✅ | Web UI ✅ | Web UI ✅ | ✅（`lib/live.js` + `lib/ws.js` + WebSocket） |
| 触发器 | 多种 ✅ | Push/Schedule/Manual | Git 轮询 | Push/Schedule/Workflow_dispatch | Push + Cron + Manual ✅（`lib/triggers.js` + `lib/cron.js` + `lib/scheduler.js`），UI 配置 ❌ |
| 灰度/分批 | 插件 | 内置 | 内置 | 无 | 5 种策略 ✅（`lib/strategy.js`），UI 配置 ❌ |

**结论**：后端能力已接近 GitLab CI（M0–M5 全量实现），但面板只暴露了 ~40% 的功能。核心问题是"功能没有闭环"——用户看不到、操作不到后端已实现的能力。

## 二、改进方案（按优先级分三批）

### 第一批：P0 体验修复（立即可做，纯 client.js 改动）

1. **项目选择器始终可见**：即使单项目也显示 `<select>`（当前退化为静态文本是设计缺陷），加一个 `+ 新建` 选项直接跳 CreateView
2. **工具条按钮语义优化**：
   - "编辑" → "编辑 pipe.yml"（hover 提示"打开编辑器修改流水线配置"）
   - "新建" → "新建项目"（hover 提示"创建新项目并登记"）
   - "回到运行" → "返回运行视图"（hover 提示"切回 阶段/Run详情/Releases 三栏"）
3. **多主机目标卡片视觉增强**：
   - hosts chips 字号从 11px → 12px，加主机数量徽标（`3 台`）
   - 卡片标题行加策略徽标（`serial` / `canary first=1` / `rolling batch=2`）
   - 生产环境主机加 🔒 图标
4. **目标卡片加"当前 release"快捷操作**：hover 时显示「回滚到当前」「查看详情」两个小按钮

### 第二批：P1 功能入口补齐（client.js + index.js 路由）

5. **审批页签**（`view: 'approvals'`）：
   - 调用 `/approvals` 路由（已有）列出待审批 run
   - 每条显示 runId / project / target / requestedAt / requestedBy
   - "通过" / "拒绝" 按钮 → 调 `/approve?runId=&decision=approve/reject&confirm=1`
   - 审批记录落 `operations` 表（已有），页签内可看历史
6. **RBAC 管理页签**（`view: 'rbac'`，仅 server 模式显示）：
   - 用户列表（`/rbac?user=` 无参 → 列用户）
   - 签发 token 表单（user / role / projects / ttlSec）
   - 吊销 token（user）
   - 审计时间线（`/rbac?action=audit`）
7. **Secrets 管理页签**（`view: 'secrets'`）：
   - 列出当前项目的 secrets（`/secrets?project=`）
   - 设置 secret（name / scope / value 表单）
   - 提示：载荷落 `workDir/.secrets.json`（0600），DB 只存 ref
8. **DORA 指标卡片**（Run 详情列顶部）：
   - 调用 `/dora?project=&days=30` 显示四指标
   - 部署频率 / 变更前置时间 / 变更失败率 / MTTR
   - 加 7d / 30d / 90d 切换
9. **构建主机管理页签**（`view: 'runners'`）：
   - 列出已注册 runner（`/runners`）：id / labels / 容量 / 在线状态 / 在跑任务数
   - 注册新 runner 提示（运行 `node bin/runner.mjs --host=... --token=...`）
   - 离线 runner 标灰

### 第三批：P2 对标市面（需要新增脚手架 + 编辑器增强）

10. **语言脚手架扩展**（`lib/scaffold.js`）：
    - 加 `java`（Maven/Gradle 构建 + systemd 重启）
    - 加 `ruby`（bundler + pm2/systemd 重启）
    - 加 `rust`（cargo build + 二进制部署）
    - 加 `docker`（`docker build` + `docker compose up -d`，独立于现有 `runtime: docker` 预设）
    - 每种模板带 `hosts` / `path` / `health` 占位符，创建后自动填入
11. **pipe.yml 编辑器增强**（client.js EditorView）：
    - 加语法高亮（Monaco 或 CodeMirror 6 嵌入，或纯 textarea + 行号）
    - 加 `targets` 快速编辑表单（hosts / runtime / strategy / canary / health / keep 可视化配置）
    - 加 `triggers` 快速编辑表单（push branches / cron / manual 开关）
    - 校验结果逐行标注（现有 `cicd_validate` 已返回 line 号，编辑器加 gutter 标记）
12. **流水线总览视图**（`view: 'overview'`，跨项目）：
    - 所有项目的最近一次 run 状态（success/failed/canceled + 时间）
    - 当前 running 的 run 列表（带进度条）
    - 待审批的 run 列表（点击跳审批页签）
    - DORA 趋势图（sparkline，7d/30d/90d）

### 路线图

| 批次 | 工作量 | 交付物 | 依赖 |
|---|---|---|---|
| P0（1–4） | 0.5 天 | client.js 改动 ~200 行 | 无 |
| P1（5–9） | 2 天 | client.js 改动 ~600 行 + 3 个新页签 | `/approvals` / `/rbac` / `/secrets` / `/dora` / `/runners` 路由已存在 |
| P2（10–12） | 3 天 | scaffold.js 扩展 + 编辑器增强 + 总览视图 | P1 完成后做 |

## 三、关于用户提问的逐条回答

1. **为什么不支持选择项目？** → 支持。`client.js:1757` 多项目时显示 `<select>`，单项目时退化为静态文本（设计缺陷，P0 修复）。
2. **不支持部署到多个主机/实例？** → 支持。`target.hosts: [a, b, c]` 逐台 fan-out（`lib/deploy.js:hostsOf`），5 种策略（`lib/strategy.js`）。截图2 目标卡片已显示 hosts chips（linux26 + test），只是视觉权重不够（P0 修复）。
3. **新建/编辑流水线很奇怪？** → 交互逻辑是：工具条「新建」→ 切到 CreateView（来源二选一 + 脚手架）；「编辑」→ 切到 EditorView（textarea 编辑 pipe.yml + 校验 + 保存）。P0 优化按钮语义，P2 加可视化配置表单。
4. **UI 布局交互差、功能没闭环？** → 核心问题确认：后端 M0–M5 全量实现，面板只暴露 ~40%。P1 补齐 5 个页签（审批/RBAC/Secrets/DORA/Runner 管理）。
5. **是否研究过市面优秀 CICD？** → 本报告第二节对标 Jenkins / GitLab CI / ArgoCD / GitHub Actions。结论：后端能力已接近 GitLab CI，差距在 UI 暴露度。
6. **支持部署哪些语言？** → 原生：static / node / python / go / php / docker（`runtime` 预设 6 种，`lib/deploy.js:restartSpec` 自动生成重启命令）。P2 加 java / ruby / rust 脚手架。
7. **原生 + Docker 都支持？** → 是。`runtime: docker` 生成 `docker compose -f <app> up -d` 或 `docker restart <app>`（`lib/deploy.js:restartSpec` 行 59–60）。
8. **本地项目 / 远程 Git 制品库？** → 本地 ✅（`cicd_project_create` 选本地目录）；Git 仓库 ✅（`lib/git.js:cloneRepo` + `fetchAsync` + `pullFastForward`）；制品库 ❌（无 Docker Registry / npm / PyPI push，P2 可加）。
9. **构建主机是否支持管理？** → 支持。`lib/executors.js` TaskBroker + `bin/runner.mjs` 拉取式协议（claim/心跳/结果回报），`/runner-*` 五条路由 + `cicd_runners` 工具。P1 加管理 UI。
10. **云流水线用户角色权限是否实现闭环？** → 是。`lib/rbac.js` 三角色（viewer/operator/admin）+ 项目范围 + 短 TTL token + 审计时间线（最近 500 条），`/rbac` 路由 + `cicd_rbac` 工具。P1 加管理 UI。
