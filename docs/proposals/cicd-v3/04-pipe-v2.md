# 04 · 流水线 DSL v2（pipe.yml）

> 回答的问题：**「新建/编辑流水线为什么这么奇怪？能不能像成熟 CI 一样表达并行、矩阵、缓存、制品？」**
> 现状：`lib/pipe.js` 是自写受限 YAML 解析器 + 单层 `stages[].steps[]`，**stage 串行、step 串行**，没有 job、并行、矩阵、缓存、制品收集、`uses` 复用。
> v2 的目标：**保留单文件、可读、可 diff**，补齐「并行 + 复用 + 制品 + 环境」四件事。

---

## 1. 设计原则

| 原则 | 说明 | 反面 |
|---|---|---|
| 声明式、非图灵完备 | 只有 `run` 与内置 `uses` 动作；不允许在 YAML 里写控制流 | 把 shell 当编程语言，配置变成不可测试的程序 |
| Job 是执行单位 | 调度/日志/重试/超时/产物的边界是 job，不是 stage | stage 内塞 20 个 step，失败无法定位 |
| 显式依赖 | `needs` 声明 DAG；不写则同 stage 内并行 | 隐式顺序，改一行全乱 |
| 制品是一等公民 | job 声明 `artifacts.paths`，框架负责收集 + digest | 让用户 `scp`，然后谁也不知道部署的是哪份字节 |
| 环境是部署目标 | `deploy` 是 job kind，绑 target/env | 把 `ssh` 命令写在 build job 里 |
| 默认安全 | 默认不注入 secret 到非受信分支；prod 需保护规则 | PR 分支就能拿到 prod 凭据 |

---

## 2. 顶层结构

```yaml
version: 2

name: shop-api
description: 订单服务

# 触发（可多个）
on:
  push:
    branches: [main, "release/*"]
    paths: ["src/**", "pom.xml"]
  pull_request:
    branches: [main]
  tag: ["v*"]
  schedule: "0 2 * * *"
  manual: true

# 变量（可被环境覆盖）
variables:
  JAVA_VERSION: "17"
  NODE_VERSION: "20"

# 环境定义（部署目标）
environments:
  dev:     { autoDeployBranches: [main] }
  staging: { autoDeployBranches: [main] }
  prod:    { protected: true, requireApproval: true, branchRule: main }

# 复用
templates:
  java-build: &java-build
    toolchain: { java: temurin-17, maven: "3.9.6" }
    cache:
      - key: "m2-${{ hashFiles('**/pom.xml') }}"
        paths: [".m2"]
    steps:
      - uses: checkout
      - uses: toolchain
      - run: mvn -B -ntp -Dmaven.repo.local=$RUN_DIR/m2 verify

stages:
  - id: build
    jobs:
      - id: compile
        <<: *java-build
        artifacts:
          paths: ["target/*.jar"]
          retention: default

  - id: test
    needs: [build]
    jobs:
      - id: unit
        matrix:
          java: ["17", "21"]
        toolchain: { java: "temurin-${{ matrix.java }}" }
        steps:
          - uses: checkout
          - uses: toolchain
          - run: mvn -B test

  - id: deploy
    needs: [test]
    jobs:
      - id: staging
        kind: deploy
        environment: staging
        needs: [compile]
        artifact: "target/*.jar"
        target: staging
        strategy: rolling
```

---

## 3. 执行模型

```
Stage（逻辑分组，仅用于 UI 与 needs 聚合）
└── Job（调度单位：可并行、可重试、有超时、有产物、有日志流）
    └── Step（串行执行的最小单元：run 或 uses）
```

- **同 stage 内、`needs` 满足的 job 并行**；跨 stage 由 `needs` 决定，stage 顺序只是默认提示。
- **`needs` 一旦出现，顺序完全由 DAG 决定**，stage 顺序不再是约束；`needs: []` 表示创建后立即启动（GitLab 语义）。没有任何 job 写 `needs` 时，才退化为「stage 串行、stage 内并行」。
- **同一 job id 全局唯一**（含矩阵展开后的实例 id），重名在校验期被拒（Woodpecker 同款规则）。
- Job 级默认：`timeout: 30m`、`retries: 0`、`allow_failure: false`、`continue_on_error: false`。
- Step 级继承 job 的 `env`/`toolchain`/`cwd`。
- 失败语义：step 失败 → job 失败 → 依赖它的 job `skipped` → 整个 run `failed`（除非 `allow_failure`）。

### 3.1 Job 字段

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `id` | string | 必填 | run 内唯一；出现在日志/URL |
| `kind` | `build\|deploy\|verify\|manual` | `build` | 决定可用字段与 UI |
| `needs` | string[] | `[]` | job id 或 stage id |
| `stage` | string | 所在 stage | 覆盖归属 |
| `image` | string | — | 容器执行（`node:20`、`eclipse-temurin:17-jdk`） |
| `toolchain` | map | — | 宿主执行时的版本声明（见 05） |
| `runtime` | `host\|container` | 由 `image` 推断 | 显式覆盖 |
| `matrix` | map<string, array> | — | 笛卡尔积展开为多个 job 实例 |
| `env` | map | — | 仅本 job |
| `variables` | map | — | 覆盖顶层 |
| `cwd` | string | 仓库根 | 相对路径 |
| `timeout` | duration | `30m` | 超时杀进程树 |
| `retries` | int | `0` | 仅对 `run` 步骤重试 |
| `allow_failure` | bool | `false` | 失败不阻断后续 |
| `when` | condition | — | 分支/tag/env/变更路径 |
| `if` | string | — | 简化表达式（见 §5） |
| `artifacts` | object | — | `{paths, exclude, retention, name}` |
| `cache` | object[] | — | `{key, paths, restore_keys}` |
| `services` | object[] | — | 容器模式下 sidecar（postgres/redis） |
| `secrets` | string[] | — | 引用的 secret 名，只注入声明的 |
| `runner` | object | — | `{labels: [linux, docker], capacity: 1}` |
| `concurrency` | object | — | `{group: "deploy-prod", cancel_in_progress: false}` |

### 3.2 Deploy job 专有字段

| 字段 | 说明 |
|---|---|
| `environment` | `dev/staging/prod`，决定保护规则与审批 |
| `target` | 部署目标名（07 的 Target） |
| `artifact` | glob，必须解析到**恰好一个** digest（多个则报错，避免「部署了哪个」含糊） |
| `strategy` | `serial\|parallel\|rolling\|canary\|blue-green` |
| `mode` | `native\|container\|k8s`，默认取 target 配置 |
| `verify` | `{smoke: [...], window: 60s, maxErrorRate: 0.05}` |
| `migrate` | `{expand: [...], contract: [...]}` |
| `approval` | `{reviewers: [...], timeout: 4h, on_timeout: fail\|skip}`，超时默认 `skip`（不能永久 pending） |

---

## 4. Step：`run` 与 `uses`

```yaml
steps:
  - name: 安装依赖
    run: npm ci --prefer-offline
    env: { NODE_ENV: production }
    timeout: 10m
    retries: 2
    allow_failure: false
    shell: bash            # bash | pwsh | sh | cmd
    continue_on_error: false

  - uses: checkout
    with: { fetch_depth: 1, submodules: true }

  - uses: toolchain
    with: { java: "17", maven: "3.9.6" }

  - uses: cache
    with: { key: "npm-${{ hashFiles('**/package-lock.json') }}", paths: ["~/.npm"] }

  - uses: collect
    with: { paths: ["dist/**"], name: "web-dist" }

  - uses: deploy
    with: { target: staging, artifact: "web-dist" }
```

**内置动作白名单**（不可扩展成任意代码，避免把 CI 变成远程执行平台）：

| 动作 | 作用 | 关键参数 |
|---|---|---|
| `checkout` | 拉代码（本地目录或 Git） | `fetch_depth`、`submodules`、`ref` |
| `toolchain` | 安装/注入语言运行时 | 见 05 |
| `cache` | 恢复 + 保存缓存 | `key`、`paths`、`restore_keys` |
| `collect` | 收集制品到 CAS | `paths`、`name`、`retention` |
| `deploy` | 调用部署引擎 | `target`、`artifact`、`strategy` |
| `verify` | 冒烟/探针 | `url`、`expect`、`retries` |
| `notify` | 通知 | `channel`、`template` |

自定义动作只允许 `run`（shell），**不允许用户在 pipe.yml 里引用任意远程 action**（供应链风险）。

---

## 5. 求值时机（三档）与状态机

### 5.1 三档求值

| 档位 | 时机 | 可引用 | 不可引用 | 用途 |
|---|---|---|---|---|
| **T0 trigger** | 配置解析前 | `event/branch/tag/paths` | 其余全部 | 决定是否接受这次触发 |
| **T1 graph** | 创建期（快照化） | `vars`、`needs.*.status`、`matrix` | `secrets`、上一步 `outputs` | 决定进不进图、矩阵展开 |
| **T2 runtime** | 容器/宿主内 | `secrets`、`steps.x.outputs`、`env` | — | 决定命令实际参数 |

**`secrets` 只在 T2 可见。** schema 里对每档可引用集合做白名单校验，越界直接 `PIPE_EXPR`——这防的是「T1 条件里误用 secret 导致值进日志」。

`when` 决定「这个 job 是否进图」，`if` 决定「进图后要不要跑」；失败默认沿 `needs` 传播，要跑必须显式 `if: always()`（GitHub 语义）。

### 5.2 状态机

```
queued → assigned → preparing → running
       → waiting_approval | waiting_resource | waiting_callback | canceling
       → succeeded | failed | skipped | canceled | completed
```

- `completed` = 整体成功但有 skipped（Tekton 同款）——必须与 `succeeded` 区分，否则「部分部署成功」会被误报绿色。
- `canceling` 是独立态：取消请求已受理但清理（post 步骤）仍在跑，UI 不能提前显示「已取消」。

### 5.3 配置快照

每次 run 存 `config_snapshot`（原始 YAML）+ `config_hash`（sha256）：
- 重跑/重试**只用快照**，不重新读仓库（GitLab 同款语义）；
- 配置变更检测：`hash != 当前 pipe.yml 的 hash` 时，UI 提示「配置已变更，此为旧快照」；
- 手动「用最新配置重跑」是显式动作，产生新 run。

---

## 6. 条件与表达式

支持的函数（白名单，不是 JS）：

| 表达式 | 含义 |
|---|---|
| `branch == 'main'` | 分支名 |
| `startsWith(branch, 'release/')` | 前缀 |
| `tag =~ /^v\d+\.\d+\.\d+$/` | 正则 |
| `env == 'prod'` | 目标环境 |
| `changed('src/**')` | 本次提交是否触及路径 |
| `matrix.java == '21'` | 矩阵变量 |
| `variables.FOO` | 变量 |
| `secrets.HAS_DEPLOY_KEY` | secret 是否存在（不泄露值） |

组合：`&&`、`||`、`!`、括号。**不支持任意函数调用**；解析期求值，未知变量报 `PIPE_EXPR`。

**语法约定**：所有插值统一写成 `${{ ... }}`（与 v1 的 `${{VAR}}` 兼容），不要写成 `{{ ... }}`——后者是模板渲染期的占位符（见 §13），两套语法在管道里不会同时出现，但混用会让人误判求值时机。

```yaml
run: mvn -B -DskipTests=${{ matrix.skip }} package
cache: [{ key: "m2-${{ hashFiles('**/pom.xml') }}", paths: [".m2"] }]
if: ${{ needs.build.status == 'succeeded' && variables.ENV != 'prod' }}
```

---

## 7. 矩阵

```yaml
matrix:
  java: ["17", "21"]
  os: [ubuntu, windows]
  exclude:
    - { java: "21", os: windows }
```

展开为 `2×2 - 1 = 3` 个 job 实例，`id` 为 `unit[java=17,os=ubuntu]`；`matrix.<key>` 可在 `toolchain`/`env`/`run` 中使用。

限制：总实例 ≤ 64；矩阵维度 ≤ 3（防止误写 1000 个 job 打爆调度器）。

---

## 8. 缓存与制品

```yaml
cache:
  - key: "m2-${{ hashFiles('**/pom.xml') }}"
    restore_keys: ["m2-"]
    paths: [".m2", "target/classes"]
```

- `key` 命中则恢复；未命中则用 `restore_keys` 找最近的；job 成功后才保存。
- 缓存**不跨 fork PR**（防止投毒）；`pull_request` 触发的缓存只读。
- 制品：`artifacts.paths` 收集 → CAS（06）→ 返回 digest；deploy job 只能引用 digest。

---

## 9. 触发与并发

```yaml
on:
  push:   { branches: [main], paths: ["src/**"] }
  tag:    ["v*"]
  manual: true              # 允许面板/工具手动触发
  schedule: "0 2 * * *"     # cron，按 runner 时区 UTC
concurrency:
  group: "deploy-${{ environment }}"
  cancel_in_progress: false  # 部署不取消，排队
```

- `cancel_in_progress: true` 仅允许用于构建/测试；部署必须排队（否则两次部署交叉切流量）。
- Webhook 触发时校验签名（GitHub `X-Hub-Signature-256`、GitLab `X-Gitlab-Token`），失败 `401`。

---

## 10. 从 v1 迁移

v1 → v2 是**加法**：`stages[].steps[]` 仍可解析，内部包装成单 job。

```yaml
# v1（仍支持）
stages:
  - id: build
    steps:
      - run: npm ci && npm run build
      - deploy: { target: prod, artifacts: ["dist/**"] }
```

迁移规则：

1. `stages[].steps[]` → 每个 stage 生成一个 job `id = <stage>-main`，steps 原样保留。
2. `step.deploy` → 拆成独立 `kind: deploy` 的 job，`needs: [<stage>-main]`。
3. `artifacts` 从 deploy 的 `artifacts` 提升到 job 级。
4. `restart_command`/`runtime` 等 target 字段不变（07 兼容）。
5. 提供 `cicd_pipe_migrate` 工具：输出 diff，不自动写盘。

---

## 11. 校验与错误码

| 码 | 场景 | 提示 |
|---|---|---|
| `PIPE_INVALID` | YAML 语法 | 行号 + 期望 |
| `PIPE_VAR` | 未定义变量 | 变量名 + 可用列表 |
| `PIPE_EXPR` | 表达式非法 | 位置 + 允许的函数 |
| `PIPE_CYCLE` | needs 成环 | 环路径 |
| `PIPE_UNKNOWN_JOB` | needs 指向不存在 job | 候选列表 |
| `PIPE_ARTIFACT_AMBIGUOUS` | deploy 的 glob 命中多个产物 | 命中列表 + 建议 |
| `PIPE_MATRIX_TOO_LARGE` | 实例 > 64 | 当前维度乘积 |
| `PIPE_SECRET_UNDECLARED` | 用了未声明的 secret | 名称 |
| `PIPE_PROTECTED_BRANCH` | prod 部署分支不符 | 允许的分支/tag |

`cicd_validate` / `cicd_plan` 必须返回**插值后的真实命令**（现有实现已做，UI 要暴露）。

---

## 12. 与现有代码的差距

| 能力 | 现状 | 改动 |
|---|---|---|
| 并行 | 无（stage/step 全串行） | 调度器改成「job DAG + 并发池」 |
| job 概念 | 无 | 新增 `lib/model.js` 归一化 v1/v2 |
| matrix | 无 | 解析期展开 |
| cache | 无 | `lib/cache.js` |
| 制品 | 部署时 glob | `collect` 动作 + CAS |
| uses 动作 | 无 | `lib/actions/` |
| 容器 | 无 | `lib/runtime/docker.js` |
| 条件 | 仅 `when: branch/tag/env` | 表达式求值器 |
| 并发组 | 无 | `concurrency` 表 + 锁 |

---

## 13. 模板与脚手架（自定义 + 内置 Java/PHP）

**模板 = 一段可渲染的 pipe.yml 骨架 + 元数据**，不是代码生成器。目录约定：

```
<workDir>/templates/                  # 用户模板，可热加载
  java-maven/
    template.yml                      # 元数据 + 参数声明
    pipe.yml.tpl                      # 用 {{param}} 渲染
  my-company-service/                 # 自定义模板同理
<内置>/templates/                     # 随包发布，只读
  static/ node/ python/ go/ php/ java-maven/ java-gradle/ docker/ bare/
```

`template.yml`：

```yaml
id: java-maven
title: Java · Maven
description: JDK + Maven 构建，产出 jar 并部署到 staging
icon: java
detect:                               # 自动识别：满足任一即推荐
  files: ["pom.xml"]
  content: { "pom.xml": "<artifactId>" }
params:
  - { key: java,    label: JDK 版本,  type: enum, values: ["17", "21"], default: "17" }
  - { key: app,     label: 应用名,    type: string, required: true }
  - { key: env,     label: 目标环境,  type: enum, values: ["staging", "prod"], default: "staging" }
```

`pipe.yml.tpl` 里 `{{java}}`、`{{app}}` 由渲染器替换；**渲染结果必须通过 `cicd_validate` 才能保存**（防止模板产出非法配置）。

> 模板占位符用 `{{ param }}`（渲染期，一次性，早于 YAML 解析），与流水线内的 `${{ ... }}`（执行期插值）是两套语法，故意区分开，避免「这个变量到底什么时候求值」的歧义。

内置模板（P6 交付）：`static`、`node`（npm/pnpm）、`python`（uv/venv）、`go`、`php`（Composer）、`java-maven`、`java-gradle`、`docker`（buildx 构建镜像并推送）、`bare`。

**自定义模板的三条规则：**

1. 只能声明参数与文本模板，**不能执行脚本**（模板在服务端渲染，渲染器无 IO 能力）。
2. 模板可以引用内置 `uses` 动作，但不能引用外部 URL。
3. 保存模板需 Admin；使用模板只需 Operator。

示例见 `examples/pipe-java-maven.yml`、`examples/pipe-php.yml`、`examples/pipe-docker.yml`。

---

## 14. 验收标准

1. 同一 stage 两个无依赖 job 并行，总耗时 ≈ 较慢者（不是两者之和）。
2. `matrix.java: [17,21]` 生成 2 个 job，日志/产物按实例隔离，`matrix.java` 可插值。
3. `needs` 成环 → 保存时 `PIPE_CYCLE` 且指出环路径。
4. 缓存命中 → 第二次构建 `npm ci` 耗时下降 ≥50%，日志显示 `cache restored: <key>`。
5. `collect` 后 deploy 只能选 digest；选错 → `ARTIFACT_NOT_FOUND`。
6. v1 旧 pipe.yml 不改一行仍可运行，且 UI 显示为单 job。
7. 非法表达式不执行任何命令即失败（解析期）。
