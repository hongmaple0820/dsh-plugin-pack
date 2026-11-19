# dsh-cicd v3 方案总览

> **实施状态**
>
> - **P0 已交付（2026-11-18，`3.0.0-p0`）**：身份与策略（`can()` 默认拒绝）、部署锁落库、审计哈希链、审批 TTL/禁自批/绑 digest、深链路由 UI。第 75–82 条 smoke 就是本文档 [08 §10](08-security-rbac.md) 的八条验收。
> - **P1 已交付（2026-11-19，`3.0.0-p1`）**：DSL v2 调度内核 —— `stages[].jobs[]` + `needs` + `matrix`，`lib/jobs.js` 拓扑并发池（默认 4，可配 1–32），三档求值器 `lib/expr.js`（不用 `eval`），每个 job 一份分片日志，run 落 pipe.yml 原文快照 + sha256（DB v8）。
> - **P2 已交付（2026-11-19，`3.0.0-p2`）**：工具链（`toolchain:` 只写 vendor+版本；Resolver → CAS 安装 → 白名单 env 注入 → 版本断言，锁文件 + 离线 + 校验，Maven/Gradle 双锁）与 `uses:` 动作（checkout / toolchain / cache / collect / deploy / verify / notify 七个内置动作，**不引用任何外部 action**）。
> - 当前 `packages/dsh-cicd` 版本 `3.0.0-p2`，自检 **102 checks passed**（`node packages/dsh-cicd/test/smoke.mjs`），`node test/mount.mjs` 全绿（26 工具 / 34 路由）。
> - P3 起的章节仍是设计稿。落地时与设计稿的有意偏离（scrypt 代替 argon2id、hash 路由代替 history API、不用括号 DSL 而用手写解析器、`uses:` 不引用外部 action）与被验收抓出的真实缺陷（P0 六个、P1 六个、P2 七个），记在 [10-roadmap.md](10-roadmap.md) 对应阶段节的末尾。

> 一句话结论：**现在的 dsh-cicd 是一条能演示的垂直切片，不是能托付生产的流水线。**
> 缺的不是功能数量，而是四样结构性东西：**可信的身份与权限**、**可并行的执行模型**、**不可变的制品链**、**能回滚的部署现场**。
> 本方案给出完整设计、数据模型、接口、验收标准与 23 周路线图。
>
> P0–P2 之后，前三样已经有了：身份/权限默认拒绝、job DAG + matrix 并发执行、工具链与缓存可复现。
> **第四样（不可变制品 + 可回滚的部署现场）就是 P3/P5**，也是现在最该做的那块。

---

## 1. 你问的每个问题，答案在哪

| # | 你的问题 | 现状（代码事实） | 方案 | 详见 |
|---|---|---|---|---|
| 1 | 都完成了是吗？ | **没有。** README 宣称 M0–M5，实际 RBAC 不参与任何写路由、制品是 glob 出来的文件、部署锁是进程内 Map | 逐项审计，给出「声称 vs 实际」表 | [01](01-assessment.md) |
| 2 | 脚手架支持自定义吗？ | `lib/scaffold.js` 只有 5 个硬编码 kind，无参数、无检测 | 模板目录 + `template.yml` + `{{param}}` 渲染 + 自动识别技术栈 | [04 §13](04-pipe-v2.md) |
| 3 | 内置 Java / PHP 模板 | 无 | `java-maven`、`java-gradle`、`php`（Composer）+ 示例文件 | [examples](examples/) |
| 4 | 制品库怎么定义/接入？ | 无。`artifactFor()` 在项目目录按 mtime glob | 本地 CAS + digest + 只读 HTTP（Maven/npm/PyPI/OCI）+ promotion | [06](06-artifacts.md) |
| 5 | Maven 等构建工具怎么接？ | 用宿主已装的 `mvn`，读宿主 `~/.m2` | 工具链装 Maven/Gradle，`toolchains.xml` + `gradle.properties` 双锁，内部 mirror 写 `settings.xml` | [05](05-toolchain.md) |
| 6 | JDK 版本细节 | `spawn` 继承 `process.env`，宿主装什么用什么 | Resolver → CAS 安装 → 只改子进程 env → `java -version` 断言 | [05](05-toolchain.md) |
| 7 | Node 能用 nvm 切吗？ | 不能（非交互 shell 拿不到 nvm 的 PATH） | 读 `.nvmrc`，自己装 Node 到 CAS，PATH 前置；**不依赖 nvm shim** | [05 §1](05-toolchain.md) |
| 8 | Python 能用 venv 隔离吗？ | 不能 | 每 run 一个 venv（`$RUN/venv`），解释器用 python-build-standalone，只共享 wheel 缓存 | [05 §2.5](05-toolchain.md) |
| 9 | 顶部菜单混乱、割裂 | 工具条 `client.js:2069–2201` 塞了 13+ 个同权重控件，7 个整页切换 view | 全局侧栏 + 项目上下文，URL 路由可深链 | [09 §1–2](09-ui-ia.md) |
| 10 | UI 布局交互不标准 | 无路由、无总览、无空/错/加载态规范 | 设计系统最小集 + 交互规则 + 三栏编辑器 | [09](09-ui-ia.md) |
| 11 | 为什么不支持选项目？ | 只有 `<select>`，单项目时退化为静态文本 | 项目切换器（搜索/最近/收藏）+ `⌘K` 命令面板 + `/projects/:p` 路由 | [09 §2.3](09-ui-ia.md) |
| 12 | 不支持多主机/多实例？ | 多主机 ✅（按 host 批次）；**多实例 ❌**（target 只有 `hosts[]`） | Target → Host → Instance 三级，槽位/端口/权重/健康 | [07 §3](07-deploy.md) |
| 13 | 新建/编辑流水线很奇怪 | 整页替换三栏，一个 textarea，保存前看不到将执行什么 | 表单 + YAML + 预览三栏，保存前跑 validate 并显示插值后命令 | [09 §3.3](09-ui-ia.md) |
| 14 | 功能没闭环 | 后端能力只暴露约 40%，审批/制品/环境无完整链路 | 每个能力给「数据模型 + 接口 + UI + 验收」四件套 | 全部章节 |
| 15 | 研究过优秀 CI/CD 吗？ | — | 8 套系统对比矩阵 + 10 条硬结论 + 反模式清单 | [02](02-research.md) |
| 16 | 支持哪些语言？ | 5 个脚手架 | 8 种运行时 + 3 种部署形态（native/container/k8s） | [04](04-pipe-v2.md)、[05](05-toolchain.md) |
| 17 | 原生与 Docker 都支持吗？ | 只有 native 软链 | Actuator 抽象：native / container / k8s 共用 stage→activate→verify→commit | [07 §2](07-deploy.md) |
| 18 | 本地项目/远程 Git 都支持吗？ | 都支持（clone 或绝对路径） | 保留，补「接入向导 + 自动识别」 | [09 §3.5](09-ui-ia.md) |
| 19 | 构建主机能管理吗？ | 有注册/心跳，但 **labels 不参与调度** | Runner v2：拉取 + 能力标签（AND）+ 租约 + drain + 吊销 | [03 §Runner](03-architecture.md) |
| 20 | 角色权限实现了吗？ | **没有。** `requireWrite` 只看同源 + 自定义头 + confirm | `can()` 默认拒绝 + 3+1 角色 + prod 五条件 + 审批 TTL + 审计哈希链 | [08](08-security-rbac.md) |

---

## 2. 文档地图

```
docs/proposals/cicd-v3/
├── README.md               ← 你在这里（结论 + 索引）
├── 01-assessment.md        ← 代码审计：声称 vs 实际，逐条证据
├── 02-research.md          ← 调研：8 套系统对比、10 条硬结论、反模式
├── 03-architecture.md      ← 总体架构、模块边界、Runner v2、DB v6 DDL、8 条不变量
├── 04-pipe-v2.md           ← DSL v2：job DAG、matrix、cache、uses、模板、校验错误码
├── 05-toolchain.md         ← JDK/Maven/Node/Python/PHP/Go 的安装、注入、锁文件
├── 06-artifacts.md         ← 制品 CAS、digest、内建仓库、promotion、GC
├── 07-deploy.md            ← 多主机/多实例、Actuator、三层探针、回滚现场
├── 08-security-rbac.md     ← 身份、角色、审批、secret、审计
├── 09-ui-ia.md             ← 信息架构、页面草图、设计系统、日志规范
├── 10-roadmap.md           ← 7 个阶段、23 周、里程碑、风险登记、明确不做
├── schemas/pipe-v2.schema.json
└── examples/{pipe-java-maven,pipe-php,pipe-docker}.yml
```

---

## 3. 十个关键设计决策

1. **保留单文件 pipe.yml，做加法升 v2。** v1 的 `stages[].steps[]` 仍可解析（包装成单 job），不做不兼容重写。
2. **Job 是执行单位，不是 step。** 并行、重试、超时、日志、产物的边界都收敛到 job。
3. **`needs` 一旦出现即 DAG 语义**，`needs: []` 立即启动；没人写 `needs` 才退化为 stage 串行。
4. **三档求值**：T0 trigger / T1 graph / T2 runtime，`secrets` 只在 T2 可见。
5. **制品是一等公民**：CAS + digest；deploy 只引用 digest；tag 只是可变指针。
6. **artifact 与 release 分层**，promotion 只移动指针不复制字节。
7. **部署统一为 `stage → activate → verify → commit`**，三种形态差异收敛到 Actuator 的 5 个方法。
8. **回滚现场预先持久化**（digest、指针、槽位、快照、迁移标记），断网也能手工回滚。
9. **权限默认拒绝**，所有入口收敛到 `can(actor, action, resource)`；审批绑 digest、有 TTL、禁自批。
10. **UI 是侧栏 + 项目上下文 + 路由**，不是「一排按钮 + 整页 view 切换」。

---

## 4. 工期与里程碑

| 里程碑 | 时间 | 可演示 | 状态 |
|---|---|---|---|
| M1 | +2w | 登录/角色、深链 UI、部署锁落库、审计可查 | ✅ **已交付（v3.0.0-p0）** |
| M2 | +6w | 并行 job、矩阵、v2 DSL、日志分片 | ✅ **已交付（v3.0.0-p1）** |
| M3 | +9w | JDK17/21 隔离、Maven/Gradle 双锁、锁文件 | ✅ **已交付（v3.0.0-p2）** |
| M4 | +13w | 多主机多实例、三层探针、自动回滚 | 未开始 |
| M5 | +16w | 审批闭环、prod 五条件、secret 脱敏 | 审批/脱敏随 P0 提前落地；prod 五条件待 P4 |
| M6 | +19w | 制品 CAS + promotion | 未开始 |
| M7 | +23w | 三栏编辑器、模板中心、引导闭环 | 未开始 |

**P0（2 周）可独立发布**，不依赖任何内核改造，先解决「谁在操作、在哪个项目」。

---

## 5. 如何验证本方案自洽

```bash
# 1) 校验示例流水线（schema + 语义）
node -e "JSON.parse(require('fs').readFileSync('docs/proposals/cicd-v3/schemas/pipe-v2.schema.json'))"
# 2) 对照现状：每条「现状」都有文件:行号（P0/P1 已改掉的部分以 10-roadmap.md §2/§3 为准）
grep -n "authorize(" packages/dsh-cicd/index.js
grep -n "SCAFFOLD_KINDS" packages/dsh-cicd/lib/scaffold.js
# 3) P0 的八条验收是可执行测试，不是文字承诺
node packages/dsh-cicd/test/smoke.mjs    # 102 checks passed（75–82 = P0 验收，83–91 = P1 内核，92–102 = P2 工具链与动作）
node test/mount.mjs                      # 全包挂载闸门
```

**一个可执行的判据**：把 01 的 24 项能力表拿出来打勾——P0 交付后 ✅ 由 5 增至 9（身份/权限、审计、部署锁、深链 UI、审批 TTL、secret 脱敏、runner 吊销、审计验真）；P1 交付后再增至 **10**（并行 job / matrix / needs DAG）；P2 交付后增至 **13**（工具链隔离、构建缓存、`uses:` 动作）。⚠️ 剩 2 项，❌ 剩 3 项（制品 CAS、容器/多实例、include），要等 P3/P5/P6 才全绿。

---

## 6. 与旧提案的关系

| 文档 | 关系 |
|---|---|
| `docs/proposals/cicd-v2.md` | 历史设计，其「插件化/多引擎」方向已放弃 |
| `docs/proposals/cicd-lite.md` | 其 `releases/` + `current` + `.dsh-manifest.json` 被 07 继承并发扬 |
| `docs/proposals/cicd-v2-ui-gap.md` | 结论（后端能力只暴露 40%）仍成立；但它列的「缺页签」已被本轮实现覆盖，本方案用 IA 重构替代「加页签」 |
| `docs/proposals/cicd-artifacts-and-deploy.md` | 06/07 的原始调研稿，已整合并补全 |
