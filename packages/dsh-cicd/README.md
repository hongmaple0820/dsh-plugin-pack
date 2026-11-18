# @local/dsh-cicd

本地优先的轻量 CI/CD：读仓库里的 `pipe.yml`，构建步骤在本机跑，发布/回滚复用 **dsh-remote** 的 SSH 通道，运行记录落在本地 **SQLite**（Node 22 内置 `node:sqlite`，不需要原生编译），日志仍是文本文件。v0.4 起一个 target 可以 fan-out 到多台主机，并按 `runtime` 预设决定重启命令；v0.6 增加灰度分批、webhook 通知和审计时间线；v2.0-M0 增加项目向导（本地新建 / git clone + 脚手架）、`pipe.yml` 编辑器（校验 + 保存）与项目卡上的 git 元信息；v2.0-M1 补齐触发与反馈闭环：入站 webhook（`git push`）、进程内 cron 调度、git 轮询、WebSocket 实时日志、运行取消与 DORA 四指标；v2.0-M2 把执行面变成可插拔的 Executor 抽象：构建步骤默认在本机跑，也可以指定一台注册过的远端 runner 跑（拉取式协议 + journal 幂等 + 自签 TLS），UI 上以「构建主机」下拉呈现；v2.0-M3 把发布从「串行 fan-out + 2 批灰度」升级为五策略引擎（serial / parallel / rolling / canary / blue-green）+ 策略锁，`pipe.yml` 里 `target.strategy` 配置，滚动中记录批次进度、中断可续；v2.0-M4 把 target 升格为 environment（dev < staging < prod 顺序 + 保护/审批标志），prod 默认 `approvalRequired: true`，部署停在「待审批」，面板/`cicd_approve` 点「通过」才继续；secret 走 `cicd_secrets` 存储（DB 只存 ref，载荷落 `workDir/.secrets.json` 0600），`pipe.yml` 里 `${{SECRET_NAME}}` 插值时自动注入；v2.0-M5 增加 RBAC（远端服务模式）：三角色 viewer/operator/admin + 项目范围 + 短 TTL token，写操作全审计，`cicd_rbac` 签发/校验/吊销。不新增第三方依赖、不自己持有任何 SSH 凭据。

## 组成

| 文件 | 职责 |
| --- | --- |
| `index.js` | Host 入口：20 个工具 + 27 条 GET 路由 + 1 条 prefix 路由（webhook）+ 1 条 WebSocket upgrade（实时日志）+ 5 条 runner 路由 + 4 条 V2-M4 路由 + 1 条 RBAC 路由，装配 runtime |
| `lib/pipe.js` | YAML 子集解析、`${{VAR}}` 插值、`when` 受限表达式、glob、stage DAG 计划、`triggers` 归一化 |
| `lib/runner.js` | 本地执行器：逐 stage 串行跑步骤，写日志与运行记录；支持外部 `runId`、`AbortSignal` 取消、实时日志 hub |
| `lib/db.js` | SQLite 打开/DDL/迁移：runs、steps、artifacts、releases、operations、projects 六表 + 索引，`PRAGMA user_version` 记录 schema 版本（当前 v5，v5 补 `steps.runner_id`） |
| `lib/store.js` | SQLite 存储层（`cicd.db`，WAL），对外 API 与旧 JSONL 版一致；首次打开会把遗留 `runs.jsonl` 导入并改名 `runs.jsonl.migrated` |
| `lib/remote.js` | dsh-remote 回环 HTTP 客户端：exec + 分块上传 |
| `lib/deploy.js` | releases/current 软链发布、多主机 fan-out、灰度分批、runtime 预设重启、健康检查、自动回滚 |
| `lib/notify.js` | webhook 通知：并发 POST + HMAC-SHA256 签名，失败不影响发布 |
| `lib/git.js` | git 集成：同步读 HEAD 元数据（分支/提交/精确 tag/是否脏/提交时间）、异步 `clone`/`fetch`、`remoteHead`、远端分支快照、快进 `pullFastForward` |
| `lib/scaffold.js` | `pipe.yml` 脚手架模板库（static/node/python/go/bare 五种），供新建向导起步 |
| `lib/cron.js` | 5 字段 cron 解析与匹配（别名、区间、步进、列表），`minuteKey` 分钟对齐去重 |
| `lib/triggers.js` | `triggers` 归一化（push branches/tags/secret、schedule、manual）与 ref glob 匹配 |
| `lib/scheduler.js` | 进程内调度器：cron tick + git push 轮询，状态落 `scheduler-state.json` |
| `lib/live.js` | 运行日志环形缓冲 hub：订阅/快照/结束事件 |
| `lib/ws.js` | 极简 WebSocket 服务端（握手、TEXT 帧编解码、LogSocket） |
| `lib/dora.js` | DORA 四指标汇总：部署频率、变更前置时间、变更失败率、MTTR |
| `lib/executors.js` | Executor 抽象（本地 / 远端）+ TaskBroker（拉取式任务派发、claim/resolve/cancel）+ join token 校验 |
| `lib/strategy.js` | 发布策略引擎：serial / parallel / rolling / canary / blue-green 五策略 + 策略锁（批次进度回调） |
| `lib/environments.js` | 环境升格：dev/staging/prod 顺序 + 保护/审批标志 + 晋升路径 |
| `lib/approval.js` | 审批（block gate）状态机：request/resolve/isPending/list，prod 默认停在「待审批」 |
| `lib/secrets.js` | Secret 存储：DB 只存 ref，载荷落 `workDir/.secrets.json`（0600），`refsForInterpolate` 注入 |
| `lib/rbac.js` | RBAC（远端服务模式）：三角色 viewer/operator/admin + 项目范围 + 短 TTL token，审计时间线，载荷落 `workDir/.rbac.json`（0600） |
| `bin/runner.mjs` | 单文件远端 runner CLI：拉取式协议 + journal 幂等 + 自签 TLS（可选 undici） |

## 配置

```yaml
# config.yaml（dsh 配置文件里的 plugins.'@local/dsh-cicd'）
workDir: C:\Users\me\.dsh-cicd   # 运行记录/日志目录，默认 ~/.dsh-cicd
remoteBase: 5174                 # dsh-remote 所在端口；数字会拼成 http://127.0.0.1:<port>
defaultTarget: prod
stepTimeoutSec: 600
maxLogBytes: 262144
projects:
  - id: demo
    name: Demo
    path: F:\code\demo           # 仓库根
    pipe: F:\code\demo\pipe.yml  # 省略时用 <path>/pipe.yml
    env: {}
notify:                          # v0.6：可选，失败不影响发布
  webhooks:
    - url: https://hooks.example.com/cicd
      secret: change-me          # 配了才发 x-dsh-signature: sha256=<hex>
      events: [run.success, run.failed, rollback.success]
scheduler:                       # v2.0-M1：进程内调度（cron + git push 轮询）
  enabled: true                  # false 关闭整个调度器
  tickSec: 20                    # cron 检查间隔（1..3600）
  pollSec: 60                    # git 轮询间隔（0 关闭轮询，最长 3600）
  allowProd: false               # true 时调度触发的生产发布会自动带 confirm=prod
```

不配 `projects` 时，若当前工作目录有 `pipe.yml`，会自动注册成一个项目。`remoteBase` 省略时取 `webServer.port`。

## pipe.yml

```yaml
version: 1
name: demo
vars:
  APP: demo

targets:
  prod:
    hosts: [linux26, win22]    # dsh-remote 里的主机别名；按顺序 fan-out
    path: /opt/demo           # 发布根目录
    runtime: python           # static（默认）| node | python | go | php | docker
    app: demo                 # 服务名；node/python/php 必填，go/docker 省略时用 target 名
    onHostFailure: continue   # stop（默认）| continue
    canary:                   # v0.6：首批只发第一台，观察 30s 再发剩余
      first: 1                # 1..hosts.length；等于 hosts.length 时不分批
      waitSec: 30             # 0..3600，默认 30
    # service: demo.service   # 显式 service/restart 优先级高于 runtime 预设
    health:
      http: http://127.0.0.1:8080/health
      tries: 5
      interval: 2s

stages:
  - id: build
    steps:
      - name: install
        run: npm ci
      - name: package
        run: tar -czf dist/${{APP}}.tgz -C dist .
        retries: 1
        allow_failure: false
  - id: release
    needs: [build]
    steps:
      - name: ship
        deploy:
          target: prod
          artifacts: ["dist/*.tgz"]
          keep: 5

triggers:                        # v2.0-M1：省略时只有手动触发
  push:
    branches: [main, "release/*"]  # glob，`*` 也匹配 `/`
    tags: ["v*"]                   # 可选；命中 tag ref 时 branch 留空
    target: prod                   # 可选，默认用 defaultTarget
    secret: s3cret                 # 必填，webhook token；缺省时入站请求一律 403
  schedule:
    - cron: "0 3 * * *"            # 分 时 日 月 周（本地时间），支持别名/区间/步进/列表
      target: staging              # 可选
  manual: true                     # 默认 true
```

- `needs` 组成 DAG；上游失败的 stage 会被跳过。
- `when` 只支持 `branch ==/!= 'x'`、`tag ==/!= 'x'`、`env.NAME ==/!= 'x'`、`changed: <glob>`，不是脚本。
- 变量插值用 `${{NAME}}`；缺失直接报错，不静默留空。
- `deploy` 步骤按 `target.hosts` 顺序逐台发布：每台独立建 `<path>/releases/<runId>`、上传、解包、切 `current`、追加自己的 `revisions.log`、重启、健康检查；每台保留自己的 previous。
- 单台失败默认停止后续主机（`onHostFailure: stop`）；配 `continue` 时继续发剩余主机，已成功的主机不回滚，整体 `ok:false`。
- 回滚省略 `host` 时对全部主机回滚；传 `host` 只回滚该台。每台结果单独返回。

## 灰度分批、通知与审计（v0.6）

`target.canary` 把一次 fan-out 拆成两批：

- 第一批按 `first` 台顺序发布；**任意一台失败就立即停止**，剩余主机不再尝试（即使 `onHostFailure: continue` 也一样），整体 `ok:false`。
- 第一批全部成功 → 记一条 `canary-hold` 审计、日志打 `[canary] 第一批 N 台成功，等待 Xs 后发剩余 M 台` → 等 `waitSec` → 剩余主机按 `onHostFailure` 逐台发。
- 每台结果带 `batch: 1|2`；run 结果带 `canary: {first, waitSec, batches:[{index,hosts,ok}]}`。`first` 等于主机数时等价于不分批。
- `first` 不在 `1..hosts.length`、`waitSec` 不在 `0..3600`、`canary` 不是 map 都报 `PIPE_INVALID`，文案指出 target 与字段。

webhook 通知（配置见上节）：

- 事件：`run.success` / `run.failed` / `run.canceled` / `rollback.success` / `rollback.failed`；`notify-test` 用 `test`。
- 并发 POST JSON；配了 `secret` 才带 `x-dsh-signature: sha256=<hex>`（HMAC-SHA256 对原始 body）。`events` 省略表示全发。
- 结果逐条写 `notify` 审计（`status: success|failed`），**任何失败都只记日志/审计，不影响发布**。`GET /notify-test` 可以试发；没配 webhook 时返回 `configured: 0` 而不是报错。
- payload 固定含 `{event,at,project,target,runId,releaseId,status,durationMs,hosts:[{host,ok,batch,health,error}],prod}`；目标含生产主机时 `prod:true`。

审计时间线：`operations` 表在 schema v3 扩成 `(id,at,action,project,target,host,run_id,release_id,status,detail)`，旧库自动 `ALTER TABLE` 补列并把旧 `kind` 回填到 `action`。`GET /api/plugins/cicd/operations?project=&runId=&limit=`（默认 50、上限 200）按 `at DESC` 返回。deploy 每台、rollback 每台、`canary-hold`、`notify` 都会落一条。

## 多主机 fan-out 与 runtime 预设

`target.hosts` 是顺序执行的发布列表，不是并发池：前一台完成（或失败）后才动下一台。返回结构里 `hosts` 每项形如 `{host,ok,health,restarted,error,code}`，失败的项带 `skipped:true` 表示因前面的主机失败而没执行。

`runtime`（默认 `static`）用来在没写 `restart` / `service` 时生成默认重启命令；命令都带 `|| true` 兜底，避免重启失败把发布卡死。

| runtime | `app` | 默认重启命令 |
| --- | --- | --- |
| `static` | 不需要 | 不重启，日志记「跳过重启」 |
| `node` | 必填 | `pm2 restart '<app>' \|\| systemctl --user restart '<app>' \|\| sudo -n systemctl restart '<app>' \|\| true` |
| `python` / `go` / `php` | 必填 | `systemctl --user restart '<app>' \|\| sudo -n systemctl restart '<app>' \|\| true` |
| `docker` | 可选，省略时用 target 名 | `docker restart '<app>' \|\| docker compose up -d --no-build \|\| true` |

优先级：显式 `restart:` > `service:` > runtime 预设。`service` 与 `restart` 同时写会报 `PIPE_INVALID`；`runtime` 不在上表、`app` 缺失（node/python/php）或含非法字符、`keep` 非正整数、`path` 不是绝对路径、`onHostFailure` 不是 `stop`/`continue` 都会报 `PIPE_INVALID` 并指出 target 与字段。

target 字段清单（client 侧照这个渲染）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `hosts` | `string[]` | 非空、去重后的主机别名 |
| `path` | `string` | 远端发布根目录，绝对路径，空表示默认 |
| `runtime` | `static\|node\|python\|go\|php\|docker` | 默认 `static` |
| `app` | `string` | 服务名；node/python/php 必填 |
| `onHostFailure` | `stop\|continue` | 默认 `stop` |
| `canary` | `{first,waitSec}` | v0.6 灰度分批；不配则一次 fan-out |
| `keep` | `number` | 保留最近 N 个 release，默认 5 |
| `service` / `restart` | `string` | 二选一，优先于 runtime 预设 |
| `restartCommand` | `string` | 只读派生值：最终会执行的重启命令 |
| `health` | `{http,tries,interval}` | 健康检查 |
| `current` | `string` | 当前软链目标（只读） |
| `active` | `{host,releaseId}[]` | 每台主机当前生效的 release（只读） |

## 环境选择器与生产护栏（v0.5）

`target.hosts` 除了主机别名，还可以写选择器：`env:prod`、`group:api`、`tag:canary`，并且可以和别名混写。解析期只校验语法（`^(env|group|tag):[a-z0-9._-]{1,32}$`），**真正展开发生在部署前**：

1. `/plan`、`/targets` 会顺手展开（读 dsh-remote 的 `/api/plugins/remote/hosts` 与 `/groups`，5 秒缓存），返回里多出 `selectors`、`envs`、`prodHosts`，`/plan` 还有 `willDeployToProd`。
2. 展开成空集合 → `400 PIPE_INVALID`「选择器 env:nope 没有匹配的主机」。
3. 混写保序、重复别名只保留第一次出现。

生产护栏：展开后只要有一台主机 `env === 'prod'`，`/run` 与 `/rollback` 就必须用 `confirm=prod`（而不是 `confirm=1`），否则返回：

```json
{ "ok": false, "error": "target web 包含生产主机（linux26、api1），写操作需要 confirm=prod 二次确认", "code": "PROD_CONFIRM_REQUIRED", "hosts": ["linux26", "api1"] }
```

HTTP 状态是 **409**。面板会把这条错误变成一张生产护栏卡（`.cicd-prod-guard`，列出受影响主机），点「确认发布到生产」才带 `confirm=prod` 重发。`dryRun` 不触发护栏。

部署锁：同一个 target 同时只能有一次真发布，第二笔立刻 `409 DEPLOY_IN_PROGRESS`「target web 已经有一次发布在执行，等它结束后再试」。`dryRun` 不占锁，进程内 Map 在 finally 里释放。

release 记录新增 `env` 列（`SCHEMA_VERSION` 1 → 2，旧库用 `ALTER TABLE` 补列，历史记录 `env` 为空串），`/releases` 支持 `env=` 过滤。

## 项目向导、编辑器与 git 元信息（v2.0-M0）

面板工具条新增「新建」「编辑」两个互斥视图，与「发布」「审计」同级：

- **新建向导**：填项目名 / 目标目录（可选 git 仓库地址 + 分支），选一种脚手架模板（static/node/python/go/bare），`/project-create` 会落盘一份能直接通过 `parsePipe` 的最小 `pipe.yml`（build → release 两段）。配了仓库地址就先 `git clone --depth 1`，克隆失败报 `GIT_CLONE_FAILED` / `GIT_CLONE_TIMEOUT`；目标目录已有 `pipe.yml` 时再建报 `PROJECT_CREATE_FAILED`。项目记进 SQLite 的 `projects` 表（schema v4），下次启动照常列出。
- **编辑器**：`/project-meta` 返回 `pipeSource`，在 textarea 里改；「校验」走 `/validate?source=`（或 `?project=` 校验落盘文件），语法错带行号与错误码；「保存」走 `/pipe-save confirm=1`，校验通过才写盘，写盘后自动刷新目标并清掉旧计划。
- **git 元信息**：项目卡上多一行 `分支 · 提交 · tag · 已改动`（来自 `/project-meta` 的同步 `readGitMeta`）；运行前从 git 回填 `branch`/`commit_sha` 到 run 记录，`when: branch/tag` 判断有据可依。git 不可用或仓库损坏时一律退化为空值，不崩面板、不阻断流水线。

新增 4 个工具（`cicd_project_meta` / `cicd_project_create` / `cicd_validate` / `cicd_pipe_save`）与 4 条路由（`/project-meta` `/project-create` `/validate` `/pipe-save`），路由契约与既有资源一致（读只要求同源，写额外要 `x-dsh-cicd` 头 + `confirm=1`，并拒绝未知查询参数）。

## 触发、实时日志、取消与 DORA（v2.0-M1）

三种触发方式并存，手动永远可用：

- **入站 webhook（git push）**：`POST`-等效的 GET 前缀路由 `/api/plugins/cicd/hooks/<project>`，查询参数 `ref`（必填，如 `refs/heads/main`）、`sha`、`event`、`token`（也可放 `x-cicd-token` 头）、`confirm`。`triggers.push.branches`/`tags` 用 glob 匹配 ref（`*` 跨 `/`）；命中分支时先异步 `fetch`，若当前工作区正停在该分支再尝试快进，然后写入一次 `trigger='push'` 的运行并立刻返回 202 + `runId`。不命中的 ref 返回 200 `{ok:true,skipped:true}`，不产生运行记录。鉴权：pipe 里没配 `triggers.push` 或没配 `secret` → 403 `WEBHOOK_DISABLED`；token 不匹配（sha256 + 定长比较）→ 401 `WEBHOOK_UNAUTHORIZED`。因为请求可能来自 GitHub/GitLab，这条路由**不要求同源**，身份只靠 token。
- **cron 调度**：`triggers.schedule` 每项是 5 字段 cron + 可选 target。调度器按 `tickSec` 对齐检查，用 `minuteKey`（`YYYY-MM-DDTHH:mm`）去重，落盘 `scheduler-state.json`，进程重启后同一分钟不会重复触发。
- **git push 轮询**：`pollSec > 0` 时周期性 `git fetch` + 读 `refs/remotes/origin/*`，首次只建基线（不会因为存量分支狂发），之后某个分支 sha 变化或基线后新出现的分支才触发 `trigger='push'` 的运行；同一项目串行，不会叠跑。

实时日志：`ws://<host>/api/plugins/cicd/log-ws?runId=<id>`（`registerUpgrade`，与 HTTP 同端口）。连接后先收到 `{type:'snapshot',runId,truncated,lines}`，随后是逐行 `{type:'line',stageId,index,line}`，结束收到 `{type:'end',status}` 后服务端主动关闭。运行已结束或不在内存 hub 里时回退读 `logs/<runId>.log` 尾部 2000 行再发 `end`；`runId` 缺失 400、未知运行 404。hub 每 run 保留最近 5000 行。

取消：`cicd_cancel` 工具或 `/cancel?runId=&confirm=1`。运行中取消 → `AbortController.abort()`，当前步骤整棵进程树被杀（`taskkill /T /F`），运行记录写 `status='canceled'`、`error='已取消'`；对已结束/不存在的运行分别返回 `RUN_NOT_ACTIVE` / `RUN_NOT_FOUND`（HTTP 409 / 404）。取消是幂等的，重复调用返回 `canceling`。

DORA 四项指标（`cicd_dora` 工具、`/dora` 路由，默认最近 30 天，可传 `days`）：部署频率（按成功运行/天，评 elite/high/medium/low）、变更前置时间（`finished_at - git 提交时间`，中位数）、变更失败率（failed+canceled / 全部非 dryRun 运行）、MTTR（同 project+target 失败到下一次成功的平均间隔）。`dryRun` 与未结束的运行一律排除在指标外，`series` 给出最近最多 60 天的每日 `{deployments,failures,canceled}` 以便画趋势。

新增 3 个工具（`cicd_cancel` / `cicd_dora` / `cicd_triggers`）与 4 条路由（`/cancel` `/dora` `/triggers` + prefix `/hooks/<project>`）加 1 条 WebSocket upgrade（`/log-ws`）。调度器在 `apply()` 里随插件启动，`dispose()` 会 `stop()` 定时器并释放 hub。

## 工具

`cicd_projects` / `cicd_project_meta` / `cicd_project_create` / `cicd_validate` / `cicd_pipe_save` / `cicd_plan` / `cicd_run`（`dryRun`、`stage`、`confirm`、`runner`）/ `cicd_status` / `cicd_logs` / `cicd_releases`（可按 `host` 过滤）/ `cicd_rollback`（可选 `host`）/ `cicd_targets`（含 runtime/app/onHostFailure/keep/restartCommand 与每台 active）/ `cicd_cancel`（`runId`）/ `cicd_dora`（`project`、`days`）/ `cicd_triggers`（`project`，返回 triggers 摘要、webhook URL 与调度器快照）/ `cicd_runners`（列出已注册 runner：labels、容量、在线状态、在跑任务数）。

## HTTP 路由（GET + resource，另加 1 条 prefix 与 1 条 upgrade）

`/api/plugins/cicd/{projects,project-meta,project-create,validate,pipe-save,plan,run,runs,log,releases,rollback,targets,operations,notify-test,cancel,dora,triggers,runner-register,runner-poll,runner-result,runner-log,runners}` 共 22 条精确路由；`run` 支持可选 `runner` 参数指定构建主机；`runner-*` 五条是远端 runner 拉取式协议的入口（register 带 join token、poll 兼心跳、result 回报幂等、log 逐行推送），**不校验同源**（跨机调用），靠 join token 鉴权；`runners` 要求同源。另外两条特殊入口：prefix 路由 `/hooks/<project>`（入站 webhook，靠 token 鉴权、不校验同源）与 upgrade `/log-ws?runId=`（实时日志）。

## 远端 runner（v2.0-M2）

构建步骤默认在本机跑；`pipe.yml` 配了 `targets` 但机器没装 Node 时，可以把构建步骤丢给一台注册过的远端 runner：

1. **注册**：远端机器跑 `node bin/runner.mjs --server https://host:port --runner build-01 --labels node,builder --join-token <secret>`，走 `/runner-register`（join token 校验，sha256 定长比较）。
2. **拉取式协议**：runner 轮询 `/runner-poll` 领任务（兼心跳，15s 一次）；宿主侧 `cicd_run` 带 `runner=build-01` 时，构建步骤经 `TaskBroker` 派发到该 runner，结果走 `/runner-result` 回报（幂等：`resolve` 只认第一次），日志走 `/runner-log` 逐行推（丢行可接受，result 是关键）。
3. **journal 幂等 / 断电续跑**：runner 在本地 `journal.jsonl` 记 `{taskId, attempt, status, exitCode}`，重启后 `status=success` 的任务跳过不重跑，未完成任务 `attempt+1` 重跑——宿主侧的 `resolve` 幂等保证同一 taskId 重复回报不改变状态。
4. **自签 TLS**：`--ca <file>` 指定 CA（undici `setGlobalDispatcher`），`--insecure` 跳过证书校验（仅限内网调试）。
5. **UI**：面板工具条在「目标」后加「构建主机」下拉（本机 / 已注册 runner，离线标 `(离线)`），选中后 `cicd_run` 自动带 `runner` 参数。
6. **取消**：宿主 `cicd_cancel` 对远端运行调 `broker.cancelAll(runnerId)`，runner 端 `cancelSignal` 杀子进程树。

## 发布策略（v2.0-M3）

`pipe.yml` 的 target 可配 `strategy`，把发布从「串行 fan-out + 2 批灰度」升级为五策略引擎：

```yaml
targets:
  prod:
    hosts: [h1, h2, h3, h4, h5]
    path: /srv/app
    runtime: static
    strategy:
      type: rolling        # serial / parallel / rolling / canary / blue-green
      batch: 2             # rolling：每批台数（默认 ceil(hosts/2)）
      waitSec: 30          # rolling/canary/blue-green：批间等待秒数（默认 30）
      onHostFailure: stop  # stop（默认）/ continue
```

| 策略 | 语义 | 备注 |
|---|---|---|
| `serial` | 逐台部署，一台失败即停 | 默认（无 `strategy` 字段时退化） |
| `parallel` | 所有主机并发部署 | 失败按 `onHostFailure` 决定 |
| `rolling` | 每批 N 台，批间等 `waitSec` | 单台失败按策略停/跳；批内串行 |
| `canary` | 先 `first` 台 + 观察窗口 + 自动扩量 | 等价现有 2 批灰度，`first` 可配；首批失败永远停 |
| `blue-green` | 起一套完整新实例，切流量后旧实例退役 | 任一台失败 → 全部自动回退到 previous |

- **策略锁**：滚动中 `onStrategyProgress` 回调记录批次进度（batch index + 已完成主机），宿主侧写 `store.operations`（`action:'strategy-progress'`）；cancel 后重跑时可按 lastBatch 续。
- **兼容**：不配 `strategy` 字段时，按现有 `canary.first/waitSec` 退化；`canary` 字段仍可用。
- 回滚仍是一键 `current` 切回（`cicd_rollback`）。

## 环境与审批（v2.0-M4）

`pipe.yml` 的 target 自动映射为 environment（dev < staging < prod 顺序，`lib/environments.js`）：

- **prod 默认保护**：`targetName === 'prod'`（不区分大小写）→ `protected: true` + `approvalRequired: true`；也可显式配 `protected: true` / `approvalRequired: true` 覆盖。
- **审批门（block gate）**：`approvalRequired` 的 target 在 `executeRun` 里停在「待审批」，抛 `APPROVAL_REQUIRED`（HTTP 409）；面板/`cicd_approve` 点「通过」（`decision=approve`）后重跑 `executeRun`，审批通过 → `approval-resolved` 审计 → 仍走 `confirm=prod` 护栏（双重确认）。拒绝 → `approval-rejected`。
- **secrets**：`cicd_secrets` 工具 / `/secrets` 路由设置/列出 secret；DB 只存 ref，载荷落 `workDir/.secrets.json`（0600，原子写）；`pipe.yml` 里 `${{SECRET_NAME}}` 插值时 `refsForInterpolate` 自动注入，不落明文到日志/DB。
- **晋升路径**：`cicd_environments` 工具 / `/environments` 路由列出环境 + `promotionPath`（dev → staging → prod）。
- **制品缓存**：本次未实现（`lib/cache.js` 留待后续）；现有 `artifacts` 表已记录每次 run 的产物，`keep` 清理策略复用 deploy.js 的 `cleanupReleases`。

## RBAC（v2.0-M5，远端服务模式）

server 模式启用三角色 RBAC（`lib/rbac.js`，单机模式仍无角色）：

| 角色 | 读 | 写 | 管理 |
|---|---|---|---|
| `viewer` | ✅ | ❌ | ❌ |
| `operator` | ✅ | 项目范围内 | ❌ |
| `admin` | ✅ | 全量 | ✅ |

- **token 签发**：`cicd_rbac` 工具 / `/rbac` 路由（`user=alice&role=admin&ttlSec=3600`）→ 返回 `rbac-xxxxxxxx`（sha256 摘要落盘，`workDir/.rbac.json` 0600）；token 短 TTL，过期自动拒（`TOKEN_EXPIRED`）。
- **权限检查**：`canWrite(user, project)` 按角色 + 项目范围（`*` 全量或逗号串）；`canAdmin(user)` 仅 admin。
- **审计**：所有 token 签发/吊销/写操作落审计时间线（最近 500 条），`action=audit` 导出全部（按时间正序）。
- **吊销**：`action=revoke&user=alice` 立即失效该用户所有 token。

## 安全边界

- 不解析任意 YAML：只认 map/sequence/内联数组/标量，块标量（`|`、`>`）与 flow map 直接报错。
- 构建命令只来自 `pipe.yml` 的 `run`，在项目目录里以 shell 执行；`dryRun` 只打印计划。
- 发布不新增凭据：全部经 dsh-remote 的回环路由，上传走 8KB 分块，单文件上限 64MB。
- webhook 只发到配置里写死的 http(s) URL，payload 不含任何凭据；失败只记审计，不重试、不阻塞发布。
- 入站 webhook 不信任来源：必须 pipe 里显式配 `triggers.push.secret`，token 走 sha256 定长比较；没配 secret 的连接一律 403，n 次失败不会触发任何构建。
- 实时日志 WebSocket 与 HTTP 同端口、同源策略：鉴权沿用 DSH webserver 的会话边界，只按 `runId` 推送该次运行的日志（日志本身已在磁盘上，不是新暴露面）。
- 调度触发的生产发布默认被生产护栏拦住（`allowProd: false`），要显式打开才会自动带 `confirm=prod`。
- 远端 runner 的 `runner-*` 路由不校验同源（跨机调用），靠 join token（sha256 定长比较）鉴权；`resolve` 幂等保证同一 taskId 重复回报不改变状态；日志丢行可接受，result 是关键。
- `bin/runner.mjs` 的 `--insecure` 仅限内网调试，生产建议 `--ca <file>` 指定 CA。
- secrets 载荷落 `workDir/.secrets.json`（0600），DB 只存 ref；`refsForInterpolate` 注入后不落明文到日志/DB。
- 审批门（block gate）：prod 默认停在「待审批」，`/approve` 路由解除阻塞后仍走 `confirm=prod` 护栏（双重确认）；审批记录落 `store.operations`（`action='approval-request/approval-resolved/approval-rejected'`）。
- RBAC token 落 `workDir/.rbac.json`（0600），DB 只存 sha256 摘要；token 短 TTL（默认 3600s），过期自动拒；写操作全审计（最近 500 条），`action=audit` 导出全部。
- 日志读取有 `maxLogBytes` 截断；`runId` 做了字符白名单校验。

## 自检

```bash
node packages/dsh-cicd/test/smoke.mjs   # 73 项：解析/计划/存储/执行/发布/灰度/通知/审计/路由/选择器/护栏/锁/迁移/向导/编辑器/脚手架/cron/triggers/scheduler/webhook/log-ws/cancel/DORA/executor/broker/joinToken/strategy(5 策略+策略锁)/environments/approvalGate/secrets/RBAC
node test/mount.mjs                     # 全包挂载闸门（本包 20 工具 / 28 路由）
```

不连真实 SSH：remote 用假 fetch，deploy 用记录命令的假 remote。

## 冷启动路由注册与惰性 remote（v0.6.1）

与 dsh-remote 同病：冷启动时 `webServer` 晚于插件 `apply()`，v0.6.0 起在 apply 里同步 `ctx.get('webServer')` 拿不到服务 → 整包路由 404。v0.6.1 起路由注册挂到 `ctx.inject(['webServer'], …)`（就绪后补注册全部路由，v2.0-M2 起是 23 条 = 22 exact + 1 prefix，外加 1 条 upgrade）；`remote()` 改惰性解析——`options.remoteBase` 为空时首次调用从 `ctx.get('webServer').port` 取，取不到返回未缓存客户端（保持可重试的 `REMOTE_UNAVAILABLE`）。smoke 有冷启动回归（0 路由 → 23 条路由 + 1 条 upgrade + remote base 断言）。

## 实战踩到的坑（v0.2）

真机跑通（linux26 + dsh-remote）时踩到 5 个坑，都已修并进 smoke：

1. **`pkill -f 'http.server 8099'` 会把自己杀掉**：`restart` 命令自身的命令行也含这个字符串，pkill 匹配到它 → exec 返回 exit 空、服务根本没起来。改成按端口杀：`fuser -k 8099/tcp`。
2. **多个产物命中时要取最新的**：`dist/app-*.tgz` 命中多个旧包时，按字母序取第一个会把上一次的包部署上去。现在按 mtime 取最新。
3. **dsh-remote 的 exec 回包是 `{ok, result}`**：健康检查读 `exitCode` 前必须摊平 `result`，否则永远判失败（页面明明 200）。
4. **健康检查的重试等待不能 `unref()`**：脚本/短命进程会在等待期间把事件循环跑空（`unsettled top-level await`）。
5. **`RELEASE_ID` 要在 plan 之前生成**：runId 现在先生成，`${{RELEASE_ID}}` 才插得进产物名（之前一直是 `dist/app-.tgz`）。

另外：首次部署健康检查失败会把 `current` 撤掉（没有 previous 可回滚，不把坏版本留在线上）。

## 真机实测（linux26 / python3 http.server）

- 首次部署：build 144ms + deploy 2326ms，`current -> releases/<runId>`，`curl` 拿到真实页面，`revisions.log` 追加一行。
- 二次部署（改了内容）：页面新增标记出现 → 回滚到上一条：标记消失、`current` 指回旧 release、`revisions.log` 追加 `rollback:<id>`；再滚回去标记又出现。
- 回滚一个被 `keep` 清掉的 release → 404 `RELEASE_NOT_FOUND`，不动线上。
