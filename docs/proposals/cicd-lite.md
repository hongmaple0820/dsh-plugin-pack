# 轻量 CI/CD（个人 / 小团队）：调研与方案设计

> 目标读者：想在自己机器上跑完「编译 → 打包 → 推送 → 部署 → 回滚」的个人开发者与小团队（3–10 人）。
> 前提：部署目标是自己的服务器，不追求企业级流水线平台，**优先本地直连，其次可选远端 runner**，配置要能通吃、可扩展、不引入 K8s。

---

## 0. 一句话结论

**做三段式，而不是再造一个 Jenkins：**

| 层 | 形态 | 职责 | 是否必需 |
|---|---|---|---|
| **L1 编排层** `orchestrator` | DSH 插件（本地面板 + 工具），TypeScript/Node | 读 `pipe.yml`、跑本地构建、算产物、连接部署目标、发指令、存记录 | 必需 |
| **L2 执行层** `runner`（可选） | 单二进制 Rust 服务（本地常驻或部署到一台「构建机」） | 承接远程任务、并发执行、日志流、缓存、制品中转 | 可选，第二里程碑 |
| **L3 交付层** `release` 约定 | 目标机上的目录约定 + 一种激活方式 | `releases/<id>` + `current` 软链（或镜像 tag）实现**原子切换与秒级回滚** | 必需（这是回滚的基础） |

关键取舍：**回滚不是「再跑一次旧流水线」，而是「切回上一个已验证版本」**。这条决定把整个设计从「CI 工具」变成「CD 系统」—— 见 §4。

---

## 1. 需求还原

原始诉求拆成 12 条能力（每条都能落到具体模块）：

1. 本地编译 / 打包 / 构建（任意语言，命令即配置）。
2. 推送：制品推到目标机（scp/sftp/rsync）、或推镜像到 registry。
3. 远程执行脚本部署服务（systemd / docker / compose / 裸进程）。
4. **部署记录**：谁、什么时候、什么版本、来自哪个 commit、结果、耗时、日志。
5. **回滚**：一键回到任意历史版本，且要能「回到部署前的状态」。
6. 配置灵活、通用性高、规范、架构清晰。
7. 本地权限模型简单：不做团队管理、不做角色权限（单用户即管理员）。
8. 支持连远端 runner（类似 Jenkins 的 master/agent，但轻）。
9. 远端 runner 的语言：倾向 **Rust**（单二进制、低内存、无运行时依赖）。
10. 本地面板要能连接远端 runner 并操作它。
11. 远端版才需要用户 / 角色 / 权限（RBAC）。
12. **跳板机**：理解概念、评估能不能支持，以及和 CI/CD 怎么合。

---

## 2. 调研：同类项目各自的取舍

| 项目 | 形态 | 值得抄的 | 不抄的 |
|---|---|---|---|
| **Jenkins**（[jenkins.io](https://www.jenkins.io/)） | Master + Agent（JNLP/SSH），Java | Agent 协议「拉取任务 + 心跳」；插件生态 | 太重（JVM + 内存）；Groovy 脚本不透明；配置散落 |
| **Woodpecker CI**（[woodpecker-ci.org](https://woodpecker-ci.org/)，Drone 分叉） | Server + Agent，Go，**默认 SQLite**，idle 约 100MB(server)/30MB(agent) | 单二进制 + SQLite；YAML pipeline；agent 多机横向扩 | 步骤强绑 Docker（个人机器上常没 Docker 或不想用）；Git 平台绑定 |
| **Drone** | 同上（Woodpecker 的上游） | pipeline 语法简洁 | 已商业化，社区分叉 |
| **Gitea Actions / act_runner** | 仓库内 runner，Go | 「runner 注册 token + 标签匹配」的调度模型 | 绑 Gitea；动作生态是 GitHub 语法子集 |
| **Dagger** | 引擎 + SDK，容器原语 | 可复现构建（dag 图）；本地与 CI 同一套 | 依赖容器运行时；学习曲线 |
| **Kamal**（[kamal-deploy.org](https://kamal-deploy.org/)） | 本地 CLI → SSH → 容器 | **本地驱动远端**的心智模型最贴近本需求；零停机滚动；`rollback` 直接换回旧镜像 | 只要 Docker；不做「构建」环节 |
| **Capistrano**（[结构](https://capistranorb.com/documentation/getting-started/structure/) / [回滚](https://capistranorb.com/documentation/getting-started/rollbacks/)） | 本地 CLI → SSH，Ruby | **`releases/ + current 软链 + shared/ + revisions.log`** 这套目录约定是回滚的教科书 | Ruby DSL；只做部署不做构建 |
| **Deployer**（PHP） | 同上 | recipes 概念、`dep rollback` | 生态小众 |
| **Ansible** | 无 agent，SSH 批量 | 幂等 task；inventory 分组 | 不适合当「构建」工具；YAML 冗长 |
| **ArgoCD / Tekton / Flux** | K8s 原生 | GitOps 声明式同步 | 前提是 K8s，与本需求不匹配 |
| **Warpgate**（[GitHub](https://github.com/warp-tech/warpgate)） | Rust 堡垒机（单二进制） | 见 §9：会话录制、临时凭据、`russh` 实践 | 是「访问代理」不是 CI |

**三条最值钱的结论**

1. **Capistrano 的目录约定**（`releases/<ts>/`、`current -> releases/<ts>`、`shared/` 放持久配置、`revisions.log` 记每次 deploy/rollback）：无需数据库就能做到「部署即文件系统状态机」，切换 `current` 是原子操作，回滚就是重指一次软链。
2. **Kamal 的镜像 tag 模型**：容器化目标用「部署即起一个新容器并挂到代理后面」，回滚 = 用旧 tag 再起一次，`kamal rollback` 就是这套。
3. **Woodpecker 的 backend/agent 分离**：agent 只做「领任务 → 执行 → 回传日志」，状态全在 backend。这直接给出了 L1/L2 的协议边界，也解释了为什么 Rust 很适合写 agent（它就是长期驻留的网络 + 进程管理程序）。

---

## 3. 架构

```
┌──────────────────────────── 你的电脑（DSH 桌面端）────────────────────────────┐
│  L1 orchestrator  @local/dsh-cicd（插件 bundle）                              │
│  ├─ Pipeline 解析器     pipe.yml → 计划（DAG / 阶段 / 矩阵）                    │
│  ├─ LocalRunner         直接在本机 spawn 命令，流式日志                        │
│  ├─ Transport 选择      ssh（复用 dsh-remote 的 ssh2 连接池/隧道）| runner API  │
│  ├─ ReleasePlanner      计算 release id、产物清单、激活方式（symlink / 镜像 tag）│
│  ├─ RecordStore         SQLite（本地）：runs / steps / artifacts / releases     │
│  └─ 面板（client.js）   流水线 / 运行详情 / 日志 / 版本 / 回滚 / repr(o) 视图    │
└──────────────┬───────────────────────────────┬───────────────────────────────┘
               │ (A) 直连 SSH                    │ (B) HTTPS + mTLS
               ▼                                ▼
     目标机（无 agent，零安装）           L2 runner（Rust，单二进制，可选）
     systemd / docker / 裸进程           ├─ 任务队列（本地 SQLite 或内嵌 sled）
                                        ├─ 执行器（子进程 + cgroup/超时/取消）
                                        ├─ 日志总线（SSE/WS 推给 L1）
                                        └─ 制品缓存（按 hash 复用）
                                               │ SSH / 容器
                                               ▼
                                          目标机群（多台、可分组）
```

**为什么保留「直连 SSH」这条路**：个人场景最痛的是「为了部署先装一堆东西」。L1 已经能用 SSH 连目标机，那就让最简路径成立——**不装 runner 也能部署**。runner 只在三种情况下引入：需要常驻定时/Webhook、需要并发与缓存、目标机在内网/需要跳板。

**语言选择建议**

- L1 跟插件包一致用 TypeScript（复用 `ssh2`、`@deepseek-ai/*`、面板 React）。
- L2 用 Rust 是对的，但要先做「协议与数据模型」的 PoC（Node 版 100 行即可验证），确认协议再上 Rust。Rust 技术栈参考 Warpgate 的选型：`axum` + `tokio` + `sqlx/rusqlite` + `russh`（SSH 侧）+ `rustls`（mTLS）+ `tracing`。

---

## 4. 交付层：回滚的真正实现（核心设计）

### 4.1 目录约定（无容器；通用）

目标机：

```
/srv/<app>/
├── releases/
│   ├── 20261114-041502-3f9ac1/     # 每次部署一份完整产物（tar 解开 / rsync）
│   └── 20261114-032211-91bd02/
├── current -> releases/20261114-041502-3f9ac1
├── previous -> releases/20261114-032211-91bd02
├── shared/                          # 跨版本持久化：配置、上传目录、数据库 DSN
├── revisions.log                    # 追加式：时间 / release / commit / 操作者 / 结果
└── releases/.dsh-manifest.json      # 每版本：产物 hash、文件数、入口命令、健康检查结果
```

**激活（activate）步骤**（顺序即使用户中途 Ctrl-C 也不会毁掉线上服务）：

1. 上传到 `releases/.staging-<id>/`，校验 checksum；
2. `mv .staging-<id> releases/<id>`；
3. `ln -sfn shared/*` 需要的持久项（配置、uploads）；
4. `ln -sfn releases/<id> current.new && mv -T current.new current`（**原子替换**）；
5. `systemctl restart <app>`（或 `docker compose up -d`）；
6. **健康检查**（HTTP 200/端口监听/自定义脚本，失败重试 N 次）；
7. 成功：写 `revisions.log` + manifest；把 `previous` 指向旧版本；
   **失败：自动回滚**到 `previous` 并重跑第 4–6 步，记录「自动回滚」。

### 4.2 容器目标

- 产物是镜像：`registry/app:<git-sha>`（tag 用 commit 短 sha，天然不可变）。
- 激活：目标机 `docker compose up -d --no-deps app`（或 `docker service update --image`）。
- 回滚：把 compose 文件里的 image 换回上一个 tag 再 up（Kamal 的做法）；记录表里存 tag。
- **不做**：自己实现滚动发布/灰度（超出轻量范围；需要时交给 Kamal/平台工具）。

### 4.3 回滚语义（要写进 UI 文案，避免误解）

| 操作 | 含义 | 前提 |
|---|---|---|
| `rollback to <release>` | 重指 `current` 到指定 release + 重启 + 健康检查 | 该 release 目录还在 |
| `rollback last` | 回到 `previous` | 有 previous |
| `redeploy <release>` | 用旧产物**重新走一遍**激活（适用于配置变更） | 产物还在 |
| `rollback db` | **不支持**（数据库迁移不可逆）——只在记录里标注「需人工」，并在流水线 DSL 里提供 `migrate:` 阶段 + `migration-lock` 标记，让 UI 提示「该版本含迁移，回滚后需人工处理数据」 |

> 关键洞察：**任何自动化回滚工具都不能替你回滚数据库**。把这点显式化，比假装能回滚更有价值。

---

## 5. 流水线 DSL（`pipe.yml`）

设计原则：**声明式但不发明编程语言**；每一步都是一个 shell 命令（或内置 action），阶段之间有显式依赖；变量/模板可继承。

```yaml
# pipe.yml —— 放在仓库根，由 L1 读取
version: 1
name: shop-web

vars:
  NODE_VERSION: "22"
  APP: shop-web

targets:                      # 部署目标（可在面板里覆盖）
  prod:
    hosts: [prod-1, prod-2]   # 复用 dsh-remote 的主机别名（含跳板链）
    mode: release             # release | container
    path: /srv/shop-web
    service: shop-web.service
    health:
      http: http://127.0.0.1:8080/healthz
      tries: 5
      interval: 2s
  staging:
    hosts: [linux26]
    mode: release
    path: /srv/shop-web-staging
    service: shop-web-staging.service

stages:
  - id: build
    on: [push, manual]        # 触发器
    steps:
      - name: install
        run: npm ci
      - name: compile
        run: npm run build
      - name: package
        run: tar -czf dist/${{APP}}-${{RELEASE_ID}}.tgz -C dist/app .
        artifact: dist/*.tgz

  - id: migrate
    needs: [build]
    when: "branch == 'main'"
    manual: true              # 需要人工点「确认」——迁移类步骤默认不自动跑
    steps:
      - run: ./scripts/migrate.sh
    marks: [db-migration]

  - id: deploy
    needs: [build]
    steps:
      - deploy:
          target: prod
          artifacts: [dist/*.tgz]
          activate: symlink   # symlink | compose
          keep: 5             # 保留最近 5 个 release
```

**执行语义**

- `needs` → DAG；同层可并行（受 runner 并发上限约束）。
- `when` 是受限表达式（`branch`、`tag`、`env`、`changed paths`），**不是脚本**，避免 DSL 变成半门语言。
- `artifact` 与 `deploy.artifacts` 用 glob，产物落 L1 的 `.dsh-cicd/artifacts/<runId>/`，记录 hash。
- 每个 step 有 `timeout`、`retries`、`allow_failure`、`shell`（bash/pwsh）。
- **`--dry-run` 必须能跑**：只打印将要执行的命令与文件差异，不连目标机。这是「配置灵活但安全」的底线。

**配置分层**（优先级从低到高）：内置默认 → `pipe.yml` → `pipe.<env>.yml` → 面板里的临时覆盖 → 环境变量 `DSH_CICD_*`。

---

## 6. 数据模型（L1 本地 SQLite）

```sql
projects(id, name, repo_path, pipe_path, created_at)

runs(id PK, project_id, pipeline_name, trigger, branch, commit, started_at, finished_at,
     status,           -- queued|running|success|failed|canceled
     target,           -- 部署目标名
     dry_run,          -- 0/1
     error)            -- 结构化失败原因

steps(run_id, stage_id, idx, name, command, exit_code, started_at, finished_at,
      status, log_path, timeout_s)

artifacts(run_id, path, size, sha256)

releases(id PK,            -- 20261114-041502-3f9ac1
         project_id, target, host,
         run_id, commit, artifact_sha256,
         created_at, activated_at, deactivated_at,
         status,            -- active|superseded|failed|rolled-back
         manifest_path, revisions_offset)

operations(id, run_id, kind,   -- deploy|rollback|redeploy|activate|healthcheck
           host, detail_json, started_at, finished_at, status)

hosts(alias, protocol, host, port, jump_chain_json, auth_ref)  -- 与 dsh-remote 共库/共配置
secrets(ref PK, cipher, created_at, updated_at)                -- ref → 加密载荷
```

记录的价值在于**可查询**：面板要能回答「上周三那次失败是哪个 commit」、「prod-2 现在跑的是哪个 release」、「这个 release 谁激活的」。

---

## 7. L1 的 HTTP / 面板接口（要绕开 carrier 的两个限制）

已知坑（本仓库踩过，见 `docs/SPEC.md`）：

- carrier 只放 `GET/HEAD` → 所有写操作只能用 `GET + 查询参数 + 自定义头`，或走 typert `@Remote`。
- `new Request()` 的 base 是 `http://x/` → 同源校验不能用 `request.url` 的 host，要看 `host` 头。
- 长任务不能靠 HTTP 轮询拿日志 → 用 `webServer.registerUpgrade` 挂 WS（v2.2 已验证 `/vnc-ws` 这条路），或 SSE。

建议接口（全部 `resource` 形态）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/plugins/cicd/plan?project=&env=` | 解析 `pipe.yml` 后的计划（含 dry-run 命令） |
| GET | `/api/plugins/cicd/run?project=&stage=&target=&confirm=1` | 触发一次 run（写操作 → `confirm=1` + `x-dsh-cicd: 1` 头） |
| GET | `/api/plugins/cicd/runs?project=&limit=` | 运行列表 |
| GET | `/api/plugins/cicd/log?runId=&step=&offset=` | 增量日志（轮询兜底） |
| WS | `/api/plugins/cicd/log-ws?runId=` | 实时日志流（upgrade） |
| GET | `/api/plugins/cicd/releases?project=&target=` | 版本列表 |
| GET | `/api/plugins/cicd/rollback?release=&confirm=1` | 回滚 |
| GET | `/api/plugins/cicd/runners` | 远端 runner 列表与状态 |

工具（给 Agent 用，8–10 个足够）：`cicd_plan`、`cicd_run`、`cicd_status`、`cicd_logs`、`cicd_releases`、`cicd_rollback`、`cicd_targets`、`cicd_runner_list`。

---

## 8. 远端 runner（L2）协议设计

**调度模型：拉取（pull），不是推送。** 理由：目标机在 NAT/内网时，pull 不需要入站端口；runner 断线可自愈；与 Jenkins agent、Woodpecker agent 一致。

```
runner ──(1) register {runner_id, labels, capacity, version}──▶ orchestrator
       ◀─(2) token(短期) / mTLS 证书 ──
runner ──(3) heartbeat 每 15s ──▶
runner ──(4) claim {labels, capacity} ──▶  ◀── task spec(JSON: stages/steps/artifacts/secrets refs)
runner ──(5) log(chunk, seq) ──▶          ◀── cancel
runner ──(6) result {exit, artifacts hash, logs url} ──▶
```

- **鉴权**：首次注册用一次性 join token → 换 mTLS 客户端证书（短有效期 + 自动续期）。比长期静态 token 安全，也便于吊销单个 runner。
- **任务幂等**：`task_id` + `attempt`，runner 执行前写本地 `journal`，重启后可回报「上次已执行到第 N 步」。
- **日志**：chunk 带 `seq`，orchestrator 落 SQLite/文件；断线重连从 `last_ack` 续传。
- **制品**：小文件直接随任务回传（base64/分块）；大文件走 runner 的 `/artifact/<sha>` 下载，orchestrator 按需拉，避免把大包塞进控制通道。
- **取消**：`cancel` 只置标记，runner 在 step 边界与进程组信号（`SIGTERM` → 宽限 → `SIGKILL`）执行。
- **Rust 侧骨架**：`axum` 提供 HTTPS/WS；`tokio::process` 执行；`sqlx` 存 journal；`russh`（可选）做「runner 反向 SSH 到内网目标机」，即把 runner 本身当跳板。

---

## 9. 跳板机：概念、能否支持、怎么合

### 9.1 概念

- **跳板机（jump host / bastion）**：一台公网可达的中间主机，内网机器不暴露公网，运维先登跳板再跳内网。技术上就是 **TCP 转发 + 认证复用**：`ssh -J jump user@10.0.0.5`（OpenSSH ≥ 7.3 的 `ProxyJump`），底层等价于 `ProxyCommand ssh jump -W %h:%p`。
- **堡垒机（bastion/PAM）**：跳板机 + 认证/授权/审计（会话录制、命令审计、临时凭据、4A 合规）。代表：**JumpServer**（开源，资产统一纳管 + 审计）、**Teleport**（证书自动下发，不依赖 SSH key/密码）、**Warpgate**（Rust 单二进制，透明代理 SSH/HTTPS/RDP/VNC/DB，会话录制 + 临时票据 + SSO/2FA）。
- 对 CI/CD 的意义：**构建/部署机往往在跳板后面**。所以「能不能支持跳板」不是可选项，而是连通性问题。

### 9.2 我们的插件怎么支持（三层，按成本递增）

| 层 | 做法 | 适用 | 代价 |
|---|---|---|---|
| **A. 复用 ProxyJump 链** | 主机配置里加 `jump: [jumpA, jumpB]`；`dsh-remote` 的 ssh2 连接用「先连跳板 → `forwardOut` 打洞 → 在隧道上再 kex」实现多跳 | 90% 的个人/小团队 | 中；需要处理每跳的凭据与主机指纹 |
| **B. runner 反向隧道** | L2 runner 部署在跳板机或内网；runner 主动连 orchestrator 的同时，用 `russh` 开 SSH 监听把内网目标机的端口映射出来 | 目标机完全不出网 | 中；等于把 runner 变成微型网关 |
| **C. 集成成熟堡垒机** | 不自己造：把 Warpgate/Teleport 当「前置代理」，我们的 orchestrator 只认「一个出口地址」；临时凭据用 Warpgate tickets | 有审计/合规要求 | 低（对接）；高（自研堡垒机绝不划算） |

**明确不做的**：自研堡垒机的**会话录制与审计回放**。这块 Warpgate/Teleport/JumpServer 已经做到工业级，我们自己写只会既不稳也不安全。若用户需要，走 C。

**对现有 `dsh-remote` 的增量**（可独立先做，1 个小版本）：

1. `hosts.json` 支持 `jump: ["jump-a"]`（有序链）+ 每跳独立认证；
2. `remote_exec` / SFTP / 隧道 / PTY 全部走 chain（现在都直连）；
3. 面板显示「linux26 → 经 jump-a → 经 jump-b」的可视链路，任一跳失败给出**哪一跳**失败；
4. 借 `ControlMaster` 思路做连接复用（我们已有 pool）。

这一条做完，CI/CD 的「远端部署」几乎不需要额外能力——**跳板支持是 CI/CD 的前置条件，而不是附加项**。

---

## 10. 安全模型

个人场景不需要 RBAC，但**必须**有：

1. **凭据不落明文**：密钥/密码进 OS keychain（Windows DPAPI / macOS Keychain / Linux Secret Service），DB 只存 `ref`。
2. **主机指纹固定**：首次连接记录 `known_hosts` 风格指纹，变更要求显式确认（防中间人）。
3. **写操作双保险**：`confirm=1` + 自定义头 + 同源校验（本仓库既定约定）。
4. **最小权限**：部署用户只允许 `systemctl restart <unit>` / `docker compose up`，用 sudoers 白名单；不要给 root。
5. **审计**：每次 `operations` 落库（谁、从哪个 release、到哪个 release、结果）。
6. **远端版才加 RBAC**：`user → role(viewer|operator|admin) → project/target 范围`；token 短 TTL；所有写操作落审计。

---

## 11. 路线图（每阶段都有可验收产物）

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M0 骨架（1 周）** | 新 bundle `@local/dsh-cicd`：`pipe.yml` 解析 + `plan`/`dry-run` + 面板列出流水线；SQLite schema | `node test/mount.mjs` 通过；`plan` 对 3 个样例仓库输出正确步骤 |
| **M1 本地部署闭环（1–2 周）** | LocalRunner（spawn + 流式日志）+ SSH 直连部署 + `releases/current` 软链 + 健康检查 + `revisions.log` | 对 linux26 部署一个真实 demo（静态站/Node 服务），改一次代码再部署，线上可见变化 |
| **M2 记录与回滚（1 周）** | 运行/步骤/产物/版本落库；`rollback last` 与 `rollback <release>`；失败自动回滚；面板「版本 / 运行详情 / 日志」三视图 | 部署 V1 → V2 → 回滚 V1，线上内容回到 V1 且记录完整；人为让健康检查失败，验证自动回滚 |
| **M3 远端 runner（2–3 周）** | Rust runner（register/heartbeat/claim/log/result/cancel）+ mTLS + journal 幂等；L1 侧 runner 管理页 | runner 断电重启后任务可续；两台 runner 并发跑两个 job；日志不丢块 |
| **M4 跳板机 + 多目标（1–2 周）** | `dsh-remote` 多跳 ProxyJump；CI/CD 目标机经跳板部署；多主机分组（串行/并行/滚动） | 关掉目标机公网入站，仅经跳板完成部署与回滚；目标机分组滚动更新不中断服务 |
| **M5（可选）** | RBAC + 审计导出 + 集成 Warpgate/Teleport 临时凭据 | 三账号三角色，写操作有审计，凭证过期自动拒绝 |

> 建议：**M0–M2 用 TypeScript 直接做**（快、与插件包同栈、能马上验证 UX 与回滚语义）；M3 之前再定 Rust —— 那时协议已被真实验证过，Rust 只是「换实现」，不是「赌设计」。

---

## 12. 风险与取舍

| 风险 | 说明 | 对策 |
|---|---|---|
| 回滚被误解为「数据也能回滚」 | 用户以为一键回到昨天 | UI 显式标注 `db-migration` 版本，回滚时提示人工检查；`migrate` 阶段默认人工确认 |
| DSL 变成「半门编程语言」 | 一加 `if/for/函数` 就滑向 Jenkinsfile | `when` 只允许受限表达式；复杂逻辑写进 `scripts/*.sh`，DSL 只调用 |
| 自己造 agent 协议 | 与 Jenkins/Woodpecker 重复劳动 | 只做最小集（§8 六条消息）；不追求跨语言 SDK |
| 直连 SSH 的凭据扩散 | 每台目标机一份凭据 | 统一 `hosts` + 跳板链 + keychain；控制面只在 L1 |
| Rust 上手成本 | 团队若不熟 Rust，M3 会延期 | M0–M2 用 TS；Rust 只做「无状态 + 幂等」的 agent，边界小 |
| 与 `dsh-remote` 功能重叠 | 两个插件都连主机 | 明确分工：`dsh-remote` = 人在回路的手工通道；`dsh-cicd` = 自动化通道，复用同一 `hosts`/连接池 |

---

## 13. 参考

- Capistrano：目录结构与回滚 — https://capistranorb.com/documentation/getting-started/structure/ ，https://capistranorb.com/documentation/getting-started/rollbacks/
- Kamal（本地驱动远端部署、rollback） — https://kamal-deploy.org/
- Woodpecker CI（单二进制 + SQLite + agent 架构，idle 约 100MB/30MB） — https://woodpecker-ci.org/ ，https://github.com/woodpecker-ci/woodpecker
- Jenkins（master/agent 模型） — https://www.jenkins.io/
- SSH 跳板机与 ProxyJump/ProxyCommand — https://4ft35t.github.io/post/ssh-porxy/
- Warpgate（Rust 堡垒机：`russh`、SQLite、会话录制、tickets、SSO） — https://github.com/warp-tech/warpgate
- JumpServer（开源堡垒机 / 4A 审计） — https://www.jumpserver.org/
- Teleport on AWS（证书下发型堡垒机） — https://aws.amazon.com/cn/blogs/china/use-teleport-to-build-a-cloud-native-bastion-machine-on-aws/