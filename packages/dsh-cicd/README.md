# @local/dsh-cicd

本地优先的轻量 CI/CD：读仓库里的 `pipe.yml`，构建步骤在本机跑，发布/回滚复用 **dsh-remote** 的 SSH 通道，运行记录落在本地 **SQLite**（Node 22 内置 `node:sqlite`，不需要原生编译），日志仍是文本文件。v0.4 起一个 target 可以 fan-out 到多台主机，并按 `runtime` 预设决定重启命令；v0.6 增加灰度分批、webhook 通知和审计时间线。不新增第三方依赖、不自己持有任何 SSH 凭据。

## 组成

| 文件 | 职责 |
| --- | --- |
| `index.js` | Host 入口：8 个工具 + 10 条 GET 路由，装配 runtime |
| `lib/pipe.js` | YAML 子集解析、`${{VAR}}` 插值、`when` 受限表达式、glob、stage DAG 计划 |
| `lib/runner.js` | 本地执行器：逐 stage 串行跑步骤，写日志与运行记录 |
| `lib/db.js` | SQLite 打开/DDL/迁移：runs、steps、artifacts、releases、operations 五表 + 索引，`PRAGMA user_version` 记录 schema 版本 |
| `lib/store.js` | SQLite 存储层（`cicd.db`，WAL），对外 API 与旧 JSONL 版一致；首次打开会把遗留 `runs.jsonl` 导入并改名 `runs.jsonl.migrated` |
| `lib/remote.js` | dsh-remote 回环 HTTP 客户端：exec + 分块上传 |
| `lib/deploy.js` | releases/current 软链发布、多主机 fan-out、灰度分批、runtime 预设重启、健康检查、自动回滚 |
| `lib/notify.js` | webhook 通知：并发 POST + HMAC-SHA256 签名，失败不影响发布 |
| `lib/db.js` | SQLite 打开/DDL/迁移：runs、steps、artifacts、releases、operations 五表 + 索引，`PRAGMA user_version` 记录 schema 版本（当前 v3） |
| `lib/store.js` | SQLite 存储层（`cicd.db`，WAL），对外 API 与旧 JSONL 版一致；首次打开会把遗留 `runs.jsonl` 导入并改名 `runs.jsonl.migrated` |

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

## 工具

`cicd_projects` / `cicd_plan` / `cicd_run`（`dryRun`、`stage`、`confirm`）/ `cicd_status` / `cicd_logs` / `cicd_releases`（可按 `host` 过滤）/ `cicd_rollback`（可选 `host`）/ `cicd_targets`（含 runtime/app/onHostFailure/keep/restartCommand 与每台 active）。

## HTTP 路由（全部 GET + resource）

`/api/plugins/cicd/{projects,plan,run,runs,log,releases,rollback,targets,operations,notify-test}`；`releases` 支持 `target`/`host`/`env`/`limit`，`rollback` 支持可选 `host`，`operations` 支持 `project`/`runId`/`limit`。写操作（`run`、`rollback`、`notify-test`）额外要求：同源请求 + `x-dsh-cicd: 1` 头 + `confirm=1` 查询参数（目标含生产主机时必须是 `confirm=prod`，见上节），三者缺一返回 403/400/409。读操作只要求同源。所有路由都会拒绝未知查询参数。

## 安全边界

- 不解析任意 YAML：只认 map/sequence/内联数组/标量，块标量（`|`、`>`）与 flow map 直接报错。
- 构建命令只来自 `pipe.yml` 的 `run`，在项目目录里以 shell 执行；`dryRun` 只打印计划。
- 发布不新增凭据：全部经 dsh-remote 的回环路由，上传走 8KB 分块，单文件上限 64MB。
- webhook 只发到配置里写死的 http(s) URL，payload 不含任何凭据；失败只记审计，不重试、不阻塞发布。
- 日志读取有 `maxLogBytes` 截断；`runId` 做了字符白名单校验。

## 自检

```bash
node packages/dsh-cicd/test/smoke.mjs   # 42 项：解析/计划/存储/执行/发布/灰度/通知/审计/路由/选择器/护栏/锁/迁移
node test/mount.mjs                     # 全包挂载闸门
```

不连真实 SSH：remote 用假 fetch，deploy 用记录命令的假 remote。
## 冷启动路由注册与惰性 remote（v0.6.1）

与 dsh-remote 同病：冷启动时 `webServer` 晚于插件 `apply()`，v0.6.0 起在 apply 里同步 `ctx.get('webServer')` 拿不到服务 → 整包路由 404。v0.6.1 起路由注册挂到 `ctx.inject(['webServer'], …)`（就绪后补注册 10 条）；`remote()` 改惰性解析——`options.remoteBase` 为空时首次调用从 `ctx.get('webServer').port` 取，取不到返回未缓存客户端（保持可重试的 `REMOTE_UNAVAILABLE`）。smoke 有冷启动回归（0 路由 → 10 条 + remote base 断言）。

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
