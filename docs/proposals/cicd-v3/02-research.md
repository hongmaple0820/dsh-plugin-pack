# 02 · 调研：成熟 CI/CD 到底是怎么做的

> 回答的问题：**「你有没有研究过市面上优秀的流水线？别人怎么定义、怎么调度、怎么部署？」**
> 本文是 04–09 的设计依据。所有结论都标注了出处；凡与直觉冲突的地方，都给了原文链接。

---

## 1. 对比矩阵（8 套系统）

| 维度 | GitHub Actions | GitLab CI | Jenkins | Tekton | Argo Workflows | Woodpecker/Drone | Buildkite | CircleCI |
|---|---|---|---|---|---|---|---|---|
| 执行单元 | job（step 顺序） | job（script 顺序） | stage → steps | Task = 一个 Pod | template = 一个 Pod | step = 一个容器 | job = 一条 command | job → steps |
| 默认并发 | job 全并行 | 同 stage 并行、stage 串行 | stage 串行 | DAG 隐式推导 | DAG / steps 串行 | **step 串行** | 按 `depends_on` | workflow 内并行 |
| 依赖表达 | `needs` | `needs` / stage 顺序 | stage 顺序 | `results→params` 自动建边 + `runAfter` | `dependencies` / `runAfter` | `depends_on`（设了就整体转 DAG） | `depends_on` | `requires` |
| 条件求值 | `if`，按声明点绑定上下文 | `rules`（创建期，首个匹配即定） | `when`（Groovy） | `when {input,operator,values}` | `when` | `when` 过滤器 + `status` | `if` | `when` |
| 复用抽象 | reusable workflow（`workflow_call`） | `include` / `extends` / `!reference` | Shared Library | `taskRef` / `Pipeline` / `templateRef` | `templateRef` | 多 workflow + `depends_on` | plugin + 动态 YAML | orbs（jobs/commands/executors） |
| runner 选择 | `runs-on` label | `tags`（**全部**匹配） | `label 'a && b'` 布尔表达式 | Pod 调度 | Pod | `labels`（全部匹配） | `queue` tag，pull | executor |
| 终态集合 | success / failure / cancelled / skipped | 13 态，含 `waiting_for_resource`、`waiting_for_callback`、`canceling` | success / unstable / aborted | **Succeeded / Completed / Failed** | Succeeded / Failed / Error / Pending | success / failure / killed | passed / failed | success / failed |

出处：GitHub <https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax>、GitLab <https://docs.gitlab.com/ci/yaml/>、Jenkins <https://www.jenkins.io/doc/book/pipeline/syntax/>、Tekton <https://tekton.dev/docs/pipelines/pipelines/>、Argo <https://argo-workflows.readthedocs.io/en/latest/walk-through/the-structure-of-workflow-specs/>、Woodpecker <https://woodpecker-ci.org/docs/usage/workflow-syntax>、Buildkite <https://buildkite.com/docs/agent/v3>、CircleCI <https://circleci.com/docs/orb-intro/>。

---

## 2. 十条硬结论（每条都能直接变成设计决策）

### ① stage 串行只是默认值，DAG 是显式启用的选项，且启用后影响全局

Woodpecker 原文：只要任一 step 写了 `depends_on`，**整个 workflow 转 DAG**，其余 step 立即并行；同时「step 名必须唯一，重名被拒」。

→ **v2 做法**：`stages[].jobs[]` 保留分组（UI 需要），但**一旦出现 `needs`，顺序完全由 DAG 决定，stage 顺序不再是约束**；job id 全局唯一，校验期强制。

### ② 隐式建边 vs 手写 `needs`，选手写

Tekton 由「上游 `results` 出现在下游 `params`/`when` 中」自动推导依赖。图对用户不可见，报错难定位。

→ **v2 做法**：只允许显式 `needs`；当下游引用 `needs.<job>.outputs.<k>` 时，校验该 job 必在 `needs` 中。

### ③ 求值时机必须按「声明点」静态绑定，否则同一表达式在不同层级语义不同

GitHub contexts 表：`jobs.<id>.if` 只支持 `github/needs/vars/inputs`，**没有 env、secrets、steps、matrix**；到 step 级才有。
GitLab：`rules` 在 job 跑之前求值，脚本里产生的 dotenv 变量用不了。

→ **v2 做法**：三档求值时机，schema 里对每档可引用变量做白名单。

| 档位 | 时机 | 可引用 | 用途 |
|---|---|---|---|
| **T0 trigger** | 配置解析前 | `event/branch/tag/paths` | 决定是否接受这次触发 |
| **T1 graph** | 创建期，快照化 | `vars`、`needs.*.status`、`matrix` | 决定进不进图、矩阵展开 |
| **T2 runtime** | 容器/宿主内 | `secrets`、上一步 `outputs`、`env` | 决定命令实际参数 |

**secrets 只在 T2 可见**——这是防止「T1 条件里误用 secret 导致泄露到日志」的硬约束。

### ④ 配置是「创建期快照」，重跑不重新拉配置

GitLab：配置在创建 pipeline 时解析；`include` 有层级与文件数上限；`spec:inputs` 做参数化。

→ **v2 做法**：每次 run 存 `config_snapshot` + `content_hash`；重试用快照；改配置必须新建 run（`PIPE_CONFIG_CHANGED`）。

### ⑤ 二元终态不够用

Tekton 明确三种终态 `Succeeded / Completed / Failed`，`Completed` = 全部成功但有 skipped；GitLab 有 13 态（含 `waiting_for_resource`、`waiting_for_callback`、`canceling`、`manual`）。

→ **v2 状态机**：

```
queued → assigned → preparing → running
       → waiting_approval | waiting_resource | waiting_callback | canceling
       → succeeded | failed | skipped | canceled | completed
```

`completed`（有 skipped 但整体成功）必须与 `succeeded` 区分，否则「部分部署成功」会被误报为绿色。

### ⑥ cache 与 artifact 是两种生命周期完全不同的对象

GitLab 官方选型表：pipeline 内传递 → artifacts；跨 pipeline 可丢 → cache；并警告同路径会因「caches are restored before artifacts」被覆盖。
GitHub：artifact 是 run 内/run 结束后持久化；cache 是 run 之间复用，且 job 必须能在无 cache 时自行重建。

→ **v2 做法**：两条独立 API/两张表（`caches` vs `artifacts`）；cache 路径与 artifact 路径重叠时**校验期报错**（`PIPE_CACHE_ARTIFACT_OVERLAP`）。

### ⑦ cache key 必须绑内容哈希 + 作用域

GitLab 自动加 `-protected` / `-non_protected` 后缀、`cache:key:files`、每 job 最多 4 个 cache、最多 5 个 `fallback_keys`、`policy: pull|push|pull-push`。
GitHub 恢复顺序 key → 前缀 → restore-keys；7 天未访问即删；仓库默认 10GB 按 last access 驱逐。

→ **v2 做法**：`cache.key = hash(lockfiles) + scope(project, protected)`；fork PR **只读**缓存（防投毒）。

### ⑧ 审批必须是一等状态，且有超时降级

GitHub：required reviewers 最多 6 人/团队，只需一人批，可 prevent self-review；**删除 environment 会让正在等待保护规则的 job 直接失败**。
GitLab：`when: manual` 默认 `allow_failure: true`，但 `rules:when: manual` 默认 **false**（同一写法两种默认值——反面教材）。

→ **v2 做法**：`approval` 是 job 的一等字段：`{reviewers, timeout, on_timeout: fail|skip}`，**超时默认 `skip` 而非永久 pending**（无人值守流水线不能卡死）。

### ⑨ 复用只有三个可行粒度：整条流水线、片段、函数

GitHub `workflow_call`（inputs 限 string/number/boolean + secrets，嵌套 ≤10 层，权限只能收窄）；CircleCI orbs 由 jobs/commands/executors + `parameters` 构成，registry orb 语义化版本**不可变**；Argo template 即函数。

→ **v2 做法**：只做两级——`pipeline_call`（强类型 inputs/secrets）+ `templates`（job 片段，YAML 锚点/`extends`）。**不引入第三级图灵完备语言**。

### ⑩ runner 用 pull 模型，label 是「全部匹配」，并发与幂等是同一个问题

Buildkite agent 轮询 API（无需开放入站端口），默认派给该 queue 里最近成功跑过 job 的 agent（缓存亲和）。
GitLab：`tags` 要求 runner 拥有 job 列出的**全部** tag；`resource_group.process_mode: newest_first` 官方要求「每个 job 必须幂等」。
重试语义各家不一致：Jenkins `retry(n)` 重试**整条 pipeline**；Tekton `retries` 是 Task 级且与 `onError: continue` 互斥。

→ **v2 做法**：拉取 + 能力标签（AND 语义）+ 租约；retry 只在 job 级，step 只有 `allow_failure`；同一 `commit + config_hash` 重复触发复用同一 run；部署用 `concurrency_group` 串行化。

---

## 3. 反面教材（明确不抄）

| 反模式 | 出处 | 我们的规避 |
|---|---|---|
| 用通用编程语言当 DSL 核心 | Jenkins Declarative 有代码长度上限；Scripted 为支持控制器重启必须序列化，`collection.each {}` 失效 | 表达式白名单，非图灵完备 |
| 同一个 `if` 在不同层级可用变量不同 | GitHub job 级拿不到 `env`/`secrets`/`steps`/`matrix` | 三档求值时机 + schema 白名单校验 |
| 隐式回退、静默变行为 | GitLab 三连：`=~` 右侧非法正则退化成子串包含；only/except 与 rules 混用行为不一致；`rules:when: manual` 的 `allow_failure` 默认值反转 | 每个歧义都报错，不猜 |
| 把 artifacts 当发布仓库 | GitLab `keep latest` 绕过 `expire_in`，latest URL 每次指向不同文件 | 制品只认 digest，见 06 |
| `stage` 与 `needs` 同时承载顺序 | GitLab `needs: []` 无视 stage 立即启动 | `needs` 出现即 DAG；无 `needs` 才按 stage |
| 审批做成外挂插件 | Tekton 审批只是社区 Custom Task，`finally` 无法定序 | 审批是一等状态 + TTL |
| 无限日志不虚拟化 / 实时 DAG 动画 | NN/g 与各家实践 | 见 09 |
| 依赖 `when: manual` 当审批 | GitLab 两种默认值 | 见 08 §5 |

## 4. 其他三个维度的调研（详见对应章节）

- **制品与部署**（06/07）：artifact 与 release 分层；digest 是唯一身份；promotion 只移动指针不复制字节；三种形态共用 `stage→activate→verify→commit`，差异收敛到 Actuator；多主机/多实例用 Target→Host→Instance 三级；判定用 L1/L2/L3 三层探针；回滚现场必须预先持久化。
- **工具链**（05）：不要依赖 nvm/pyenv/SDKMAN 的 shim（它们假设交互式 shell）；读声明格式、自己做 CAS 安装与 env 注入；锁文件按平台记录 URL+checksum；Maven 用 `toolchains.xml` 双锁，Gradle 必须关掉 auto-detect/auto-download 且 daemon 跑在同一棵 JDK 上。
- **权限与 UX**（08/09）：3+1 角色、四权分立、prod 五条件、审批绑 digest、审计哈希链；全局侧栏 + 项目上下文、路由可深链、日志虚拟滚动、首次引导 3 步闭环。

---

## 5. 结论：我们要做的是「小而正」

不做 Jenkins 的插件宇宙，不做 Argo 的 K8s 原生编排，不做 Dagger 的函数式 DSL。

做的是：
1. **一份可 diff 的 pipe.yml**（v2，加法兼容 v1）；
2. **一个正确的调度器**（job DAG + 并发池 + 租约 + 幂等）；
3. **一条可信的制品链**（CAS + digest + promotion）；
4. **一个能回滚的部署引擎**（三级模型 + 三层探针 + 持久化现场）；
5. **一套默认拒绝的权限**（can() + 审批 + 审计）；
6. **一个能用的界面**（路由 + 项目切换 + 三栏编辑器 + 日志体验）。
