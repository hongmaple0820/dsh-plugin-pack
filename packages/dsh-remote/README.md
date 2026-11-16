# @local/dsh-remote

DSH bundle：把 SSH / SFTP / 本地端口转发 / 交互式 PTY 能力做成 **DSH 原生工具**，并附带一个
`远程主机` 页面（会话顶部 View 切换里的整页视图）。文本优先；v2.0 不内嵌 RDP/VNC 画面，只负责在本机拉起对应客户端。

- 包名：`@local/dsh-remote`（bundle 行 id：`dsh-remote`）
- 工具：13 个 `remote_*`（11 个单机能力 + `remote_cluster_exec` 多机并发）
- 页面：`conversation.view`，`id: remote`，`order: 30`，标签「远程主机」。能力按主机协议（ssh/telnet/rdp/vnc）显示：
  - 主机：新建/编辑/删除（v1.4；v2.0 可选协议），来源为 `config.hosts` 时只读；v2.7 起可标 `env`/`group`/`tags`，行内显示徽标与分组。
  - 文件（仅 ssh/sftp）：浏览/预览/下载/8KB 分块上传（v1.3、v1.8.1），v2.0 起右键菜单支持新建文件/目录、重命名、复制路径、chmod/chown、删除（目录需递归确认）、名称搜索、排序与显示隐藏文件，双击文本就地编辑（≤256KB）。
  - 执行（ssh）：命令模式带超时与 exitCode；v1.5 起可切到交互终端，v1.6 括号粘贴/尺寸跟随，v1.7 清屏/复制输出/本地历史，v1.8 刷新恢复与 2000 行窗口/日志下载，v2.0 多标签保活。
  - 桌面（仅 rdp/vnc）：按钮调用 `/gui-open`，由本机 `mstsc`/`vncviewer`/`remmina` 等客户端接管。
  - 隧道（仅 ssh）：列表、新建、关闭（v1.2）。

---

## 与 `@linxin666/dsh-ssh` 的分工

profile 里可能同时装着 `@linxin666/dsh-ssh`（`ssh_list` / `ssh_exec` / `ssh_upload` / `ssh_download` /
`ssh_tunnel` / `ssh_cluster` + web 终端）。本包不重复它的定位：

| 维度 | `@linxin666/dsh-ssh` | `@local/dsh-remote`（本包） |
|---|---|---|
| 形态 | 偏「终端 + 单机命令」 | 原生 Host 工具 + 会话内页面，agent 与人都能用 |
| 协议面 | exec + 上传下载 + 隧道 | exec + SFTP（ls/read/write/mkdir/本地文件上传）+ 隧道 + PTY 统一在一套连接池上 |
| 多机 | `ssh_cluster` 命令分发 | `remote_cluster_exec`：每台独立返回 `{exitCode, stdout, stderr, durationMs, error}`，单台失败不影响其它台 |
| 页面 | web 终端 | 主机列表（可新建/编辑/删除，ssh/telnet/rdp/vnc）+ 命令执行 + 输出（含 exitCode）+ 隧道列表（可新建/关闭）+ 文件浏览/文本预览/下载/分块上传/写文件/建目录/重命名/删除/权限/搜索 + 多标签交互终端 + 协议能力矩阵 |
| 凭据 | 见其 README | `config.hosts` / `DSH_REMOTE_HOSTS` / 包内 `hosts.json`，密码永不返回 |

两者可以共存（工具前缀不同：`ssh_*` vs `remote_*`）。二选一时：要「页面里手动敲终端」用 dsh-ssh；
要「agent 结构化调用 + 分页输出预算 + 多机巡检」用本包。

---

## 工具清单

所有工具名全局唯一，输出都带 `output.schema`，且**自己截断**长输出（不依赖框架）。

| 工具 | 作用 | 主要参数 |
|---|---|---|
| `remote_hosts` | 列出主机（别名、user@host:port、认证方式、可用性）与当前连接池/隧道/shell | — |
| `remote_exec` | 单机执行一条命令，返回 stdout/stderr/exitCode（stdout ≤ 64KB、stderr ≤ 16KB） | `host`、`command`、`timeoutSec`(1–600) |
| `remote_cluster_exec` | 最多 10 台并发执行同一命令，单台失败不影响其它台（每台 stdout/stderr 各 ≤ 16KB） | `hosts[]`、`command`、`timeoutSec` |
| `remote_ls` | SFTP 列目录（目录在前，最多 500 项） | `host`、`path` |
| `remote_download` | SFTP 读远端文本文件（≤ 64KB，truncated 标注前缀） | `host`、`path` |
| `remote_upload` | SFTP 写远端文件：文本用 `content`，本机文件用 `localPath`（二进制安全） | `host`、`remotePath`、`content`/`localPath` |
| `remote_mkdir` | SFTP 建目录（自动补父目录，已存在返回 `existed`） | `host`、`path` |
| `remote_tunnel_open` | 建本地转发 `127.0.0.1:localPort → remoteHost:remotePort` | `host`、`remoteHost`、`remotePort`、`localPort?` |
| `remote_tunnel_close` | 关闭一个隧道 | `tunnelId` |
| `remote_tunnel_list` | 列出当前隧道 | — |
| `remote_shell_open` | 打开持久 PTY（xterm-256color，默认 120×40） | `host`、`term?`、`cols?`、`rows?` |
| `remote_shell_send` | 向 shell 写入输入（要回车自带 `\n`），等 `waitMs` 后读回输出（≤ 32KB） | `sessionId`、`input`、`waitMs?`(50–10000) |
| `remote_shell_close` | 关闭 shell 会话（SSH 连接留在池里） | `sessionId` |

约定：

- `host` 可以是主机别名，也可以是临时写法 `user@host[:port]`。**临时写法只支持本机默认私钥**
  （`~/.ssh/id_ed25519` 优先），因为工具参数会进入会话记录，密码绝不允许内联进参数。
- 连接按主机复用（同一主机一个 TCP+SSH 连接，keepalive 保活），shell 与隧道共用这条连接。
- 错误直接抛 `Error`（工具失败），不会返回 `{ error }` 假装成功。
- 超时命令会被 `KILL`，并返回已收到的部分输出（`timedOut: true`）。

---

## 配置

### `config.hosts`（推荐）

在 profile 的 `cordis.patch.yml` 里给 `dsh-remote` 行写 `config`（注意：**同名 override 会整体替换
config**，改配置时把完整字段一起写上）：

```yaml
- insert:
    - id: dsh-remote
      name: '@local/dsh-remote'
      config:
        hosts:
          app01:
            host: 10.0.0.11
            port: 22
            user: deploy
            privateKeyPath: C:\Users\me\.ssh\deploy_key
            note: 应用主机
          win01:
            host: 10.0.0.12
            port: 22
            user: appuser
            passwordEnv: DSH_WIN01_PASSWORD
        defaultTimeoutSec: 60
```

主机字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `host` | string | 必填，IP 或域名 |
| `port` | number | 默认 22 |
| `user` | string | 默认 `root` |
| `password` | string | 明文密码；仅在 `config.hosts` 里用，**不要**写进任何会被提交的文件 |
| `passwordEnv` | string | 从进程环境变量读密码（推荐；变量没设时报错会点名字） |
| `privateKeyPath` | string | 私钥文件路径 |
| `passphrase` | string | 私钥口令（可选） |
| `disabled` | boolean | 禁用该别名，调用时报「已禁用：note」 |
| `note` | string | 备注，会显示在主机列表里 |
| `env` | string | 环境标签：`prod` / `test` / `staging`（也接受 `stage`）/ `dev`，或 1–32 位小写字母、数字、连字符的自定义值；未配置为 `''` |
| `group` | string | 分组标签：1–32 位小写字母、数字、连字符（如 `web` / `api` / `db`）；未配置为 `''` |
| `tags` | string[] | 最多 8 个自由标签，每项 1–32 位；未配置为 `[]`；写文件时也接受逗号分隔串 |

其它配置字段（都有默认值）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `defaultTimeoutSec` | `60` | `timeoutSec` 省略时的超时秒数（1–600） |
| `connectTimeoutMs` | `15000` | SSH 建连超时毫秒 |
| `clusterMaxHosts` | `10` | `remote_cluster_exec` 单次最多主机数（2–10） |
| `clusterStdoutBytes` | `16384` | 集群执行每台 stdout 上限 |
| `clusterStderrBytes` | `16384` | 集群执行每台 stderr 上限 |
| `packageHostsPath` | 包内 `hosts.json` | 覆盖「包内主机文件」的路径（主要给测试/别处托管的主机文件用） |

### 主机文件（备选）

解析顺序（先命中先用）：

1. `config.hosts`（内联对象）
2. 环境变量 `DSH_REMOTE_HOSTS` 指向的 JSON 文件
3. 包目录内 `hosts.json`（可选，端到端联调常用；已在仓库 `.gitignore` 内，勿提交含密码的文件）

文件形状与旧 `server.js` 的 `hosts.json` 兼容：

```json
{
  "hosts": {
    "alpha": { "host": "10.0.0.1", "port": 22, "user": "root", "passwordEnv": "ALPHA_PASSWORD" }
  }
}
```

也接受裸 `{ "alpha": { ... } }` 别名 map。文件不存在 / JSON 非法 / 缺 `host` 时，`remote_hosts`
返回空列表和清晰的 `configError`，不会静默失败。

面板的新建/编辑/删除写的是「当前生效且可写」的那份文件：`DSH_REMOTE_HOSTS` 指向的文件，或包内
`hosts.json`。`config.hosts` 来自 patch 内联，面板只读（409）。文件写入是原子的、权限 `0600`，只动目标
别名，其它别名与未知字段保留，顶层形状（`{hosts:{…}}` 或裸 map）也保持；删到空时写回空 map 并在响应
里给 `warning`。

### 环境与分组（v2.7）

主机可以带 `env` / `group` / `tags` 三个可选标签，用于「按环境或分组选择主机」而不是逐个记别名：

```json
{
  "hosts": {
    "web01": { "host": "10.0.0.11", "env": "prod", "group": "web", "tags": ["edge", "cdn"] },
    "web02": { "host": "10.0.0.12", "env": "test", "group": "web", "tags": ["edge"] }
  }
}
```

校验规则：

- `env`：`prod` / `test` / `staging`（也接受 `stage`）/ `dev`，或自定义 1–32 位小写字母、数字、连字符（必须以字母或数字开头）。
- `group`：1–32 位小写字母、数字、连字符；不配为空串。
- `tags`：最多 8 个，每项 1–32 位，不允许重复；文件里写数组，`host-save` 用逗号串。
- 非法值报 400，文案带主机别名与字段名，例如
  `主机 "web01" 的 env "Prod" 不合法：应为 1-32 位小写字母、数字或连字符`。
- `publicHosts()` 与 `/hosts`、`/host-save` 始终输出 `env`/`group`/`tags`，未配置是 `''`/`''`/`[]`（不是 `null`）。

`GET /api/plugins/remote/groups` 是只读汇总，不需要执行头：

```json
{
  "ok": true,
  "envs":   [{ "name": "prod", "hosts": ["api01", "web01"] }, { "name": "test", "hosts": ["web02"] }],
  "groups": [{ "name": "api",  "hosts": ["api01"] }, { "name": "web", "hosts": ["web01", "web02"] }],
  "tags":   [{ "name": "cdn",  "hosts": ["api01", "web01"] }, { "name": "edge", "hosts": ["web01", "web02"] }]
}
```

桶按 `name` 升序、桶内主机按别名字典序，空桶不输出。面板在主机行显示 env 徽标（prod 红 / test 黄 /
staging·stage 橙 / dev 灰 / 自定义蓝）、`@group` 灰字与 `#tag`；新建/编辑表单可填这三项，留空即清除。

下游 `dsh-cicd` 的选择器约定：`targets.<name>.hosts` 仍写别名，也可以写 `env:prod` / `group:web` /
`tag:edge` 这类选择器（由 cicd 侧展开成主机列表）；本包只保证 `/groups` 的桶与排序稳定。

### 安全约定

- 密码与私钥内容只存在于内存里的连接 spec，**工具返回值、HTTP JSON、渲染文本里永远不出现**。
  主机列表只暴露 `hasPassword` / `passwordEnv` 名字 / `privateKeyPath`。
- 推荐 `passwordEnv`；`config.hosts` 里的明文 `password` 会落进 profile 的 patch 文件，自己权衡。
- 只接受本地同源 HTTP 请求（带 `Origin` 时校验 host）；写操作还要求 `x-dsh-remote-exec: 1` 头。
- 面板写入密码时密码会作为 GET 查询参数出现在本机 URL/日志里（carrier 只服务 GET/HEAD 的取舍）；
  同源校验 + 自定义头挡住了跨站触发，但不要把这段 URL 转发出去。更好的做法是用 `passwordEnv`。

---

## HTTP 路由（给页面用）

只在 profile 有 `webServer` 服务时注册；没有就跳过（工具照常可用）。

**实测结论**：本机 carrier（`dsh-host-webserver`）在 HTTP 层只服务 GET/HEAD——非 GET/HEAD 在匹配
路由之前就被统一拒绝（`405` + `Allow: GET, HEAD`），`resource` 和 Node 原生 `handler` 都一样
（16:18 实机验证：POST 根本没进 handler）。所以本包**全部 GET**；写操作走查询参数 + 自定义头
`x-dsh-remote-exec: 1`——跨站 `<img>`/表单发起的 GET 带不上自定义头，会被 403 挡掉；同源 fetch
带自定义头不触发预检。需要 POST 语义的集成应走 typert Remote，本包 v1 不做。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/plugins/remote/hosts` | `{ok, hosts, source, path, configError, pooled, tunnels, shells}`（无密码） |
| GET | `/api/plugins/remote/exec` | `?host=&command=&timeoutSec=`；需 `x-dsh-remote-exec: 1`；缺头 403、未知参数/缺参/超时非法 400、`command` > 8KB 413 |
| GET | `/api/plugins/remote/tunnels` | 无参数 → `{ok, tunnels:[…]}` |
| GET | `/api/plugins/remote/tunnels` | `?action=close&tunnelId=tn1` → `{ok, closed}`；需同一 header；`action` 不是 close → 400、隧道不存在 → 404 |
| GET | `/api/plugins/remote/tunnel-open` | `?host=&remoteHost=&remotePort=&localPort=` → `{ok, tunnel:{id, local, remote, host}}`；需同一 header；`remoteHost` 缺省 127.0.0.1、`localPort` 可空（自动分配）；坏端口 400、未知参数 400、超长 413 |
| GET | `/api/plugins/remote/files` | `?host=&path=` → `{ok, host, path, entries:[{name, type:'dir'\|'file'\|'link', size, mtime}], total, truncated}`；需同一 header；`host`/`path` 空 400、非绝对路径 400、`host` > 512B / `path` > 4KB 413、未知参数 400、读失败 502 |
| GET | `/api/plugins/remote/file` | `?host=&path=&maxBytes=` → `{ok, host, path, size, bytes, truncated, content}`；`maxBytes` 1–65536（缺省 32768）；需同一 header；目录 → 400（原文案）、内容含 NUL → `{ok, binary:true, size, truncated:true}` 无 `content`、读失败 502；越界/非整数 400 |
| GET | `/api/plugins/remote/host-save` | `?alias=&host=&port=&user=&protocol=&auth=&secret=&privateKeyPath=&note=&disabled=&env=&group=&tags=` → upsert 一台主机，返回 `{ok, source, path, hosts}`；需同一 header；主机来自 `config.hosts` → 409；alias 非法/端口越界/auth 组合缺参/env·group·tags 非法 400；文件/目录不可写 403 |
| GET | `/api/plugins/remote/host-delete` | `?alias=` → 删除一台主机，返回 `{ok, source, path, hosts}`（删空时附 `warning`）；需同一 header；config 来源 409、别名不存在 404、alias 非法 400 |
| GET | `/api/plugins/remote/shell-open` | `?host=&cols=&rows=` → `{ok, session:{id, host, term, cols, rows, …}}`；需同一 header；`host` 空 400、`cols` 20–500 / `rows` 5–200 越界 400、未知主机 404、面板终端已达 8 个 409 |
| GET | `/api/plugins/remote/shell-attach` | `?sessionId=&cols=&rows=` → `{ok, session:{id, host, cols, rows, createdAt, lastActiveAt}, backlog(base64 ≤512KB), backlogBytes, truncated}`；刷新页面后重新接上仍活着的 PTY 并回放尾部日志（随后清空未读缓冲，避免和轮询重复）；需同一 header；未知/已回收会话 404 |
| GET | `/api/plugins/remote/shell-send` | `?sessionId=&data=&cols=&rows=&bracketed=`；`data` 为 base64，`bracketed=1` 时 Host 用 `\x1b[200~`+`\x1b[201~` 包裹（正文里的 `\x1b[201~` 先剔除），返回 `{ok, seq, output(base64), exited, truncated}`；需同一 header；缺参/非法 base64 400、>64KB 413、写后约 160ms 采集输出、会话不存在 404、单次回包 base64 ≤48KB |
| GET | `/api/plugins/remote/shell-read` | `?sessionId=` → 只回上次读取之后的新字节 `{ok, seq, output(base64), exited, truncated}`；无新输出时 `seq` 不变；需同一 header；会话不存在或空闲 10 分钟被回收 → 404 |
| GET | `/api/plugins/remote/shell-resize` | `?sessionId=&cols=&rows=` → `{ok,cols,rows}`；需同一 header；`cols` 20–500 / `rows` 5–200 越界或缺参 400、未知会话 404（面板 ResizeObserver 去抖 300ms 后调用） |
| GET | `/api/plugins/remote/shell-log` | `?sessionId=&maxBytes=` → `{ok, sessionId, bytes, total, truncated, output(base64)}`；服务端保留最近 4MB，`maxBytes` 缺省 4MB、上限 8MB，非整数/越界 400；需同一 header；未知会话 404（页面「下载日志」用） |
| GET | `/api/plugins/remote/shell-close` | `?sessionId=` → `{ok, closed:true}`；需同一 header；不存在/已关闭 404 |
| GET | `/api/plugins/remote/file-download` | `?host=&path=&maxBytes=` → `{ok, host, path, name, size, bytes, truncated, content(base64), entry:{path,size,mode,mtime}}`；`maxBytes` 1–16MB（缺省 8MB），需同一 header；缺参/越界 400、未知主机或文件不存在 404、目录 → 400「是一个目录，不能下载」 |
| GET | `/api/plugins/remote/file-upload-begin` | `?host=&path=&size=&mode=` → `{ok, uploadId, chunkBytes:8192}`；`size` 0–64MB、`mode` 为 `overwrite`/`append`/`create`（缺省 overwrite），需同一 header；缺参/越界/坏 mode 400、已有 4 个上传会话 409 |
| GET | `/api/plugins/remote/file-upload-chunk` | `?uploadId=&offset=&data=`（data 为 base64，解出 ≤8192B）→ `{ok, uploadId, received, total}`；`offset` 必须等于已收字节，否则 409「偏移不连续，期望 N」；坏 base64/缺参 400、单块 >8192B 413、未知 uploadId 404 |
| GET | `/api/plugins/remote/file-upload-finish` | `?uploadId=&sha256=` → `{ok, host, path, bytes}`；可选 sha256（64 位十六进制）校验；需同一 header；未知会话 404、未收满 409 |
| GET | `/api/plugins/remote/file-upload-abort` | `?uploadId=` → `{ok, aborted:true}`；需同一 header；未知会话 404；临时 `.part` 文件会被清理 |
| GET | `/api/plugins/remote/file-write` | `?host=&path=&data=&mode=` → `{ok, host, path, bytes, mode}`；`data` 为严格 base64（≤256KB，超出 413），`mode` 为 `overwrite`/`append`/`create`（缺省 overwrite，create 目标已存在 409）；需同一 header；缺参/坏 base64/坏 mode 400 |
| GET | `/api/plugins/remote/file-mkdir` | `?host=&path=` → `{ok, host, path}`；递归建目录，已存在 409；需同一 header；缺参 400 |
| GET | `/api/plugins/remote/file-rename` | `?host=&from=&to=` → `{ok, host, from, to}`；需同一 header；缺参/非绝对路径 400、源不存在 404、目标已存在 409 |
| GET | `/api/plugins/remote/file-delete` | `?host=&path=&recursive=` → `{ok, host, path, recursive}`；目录必须 `recursive=1` 否则 409「目录需要 recursive=1」；需同一 header；不存在 404、权限不足 403 |
| GET | `/api/plugins/remote/file-chmod` | `?host=&path=&mode=` → `{ok, host, path, mode}`；`mode` 为八进制 3–4 位（如 `0644`），否则 400；需同一 header；权限不足 403 |
| GET | `/api/plugins/remote/file-chown` | `?host=&path=&uid=&gid=` → `{ok, host, path, uid, gid}`；需同一 header；uid/gid 必须非负整数，否则 400；远端非 root 通常 403（透出远端错误） |
| GET | `/api/plugins/remote/file-search` | `?host=&dir=&q=&limit=` → `{ok, host, dir, query, entries, total, scanned, truncated}`；从 `dir` 广度优先搜索名称包含 `q` 的条目，`limit` 1–200（缺省 50）；需同一 header；缺参 400 |
| GET | `/api/plugins/remote/protocols` | 无参数、无需 header → `{ok, defaultProtocol:'ssh', protocols:[{id,label,description,capabilities,defaultPort}]}`；协议能力矩阵（ssh/telnet/rdp/vnc） |
| GET | `/api/plugins/remote/groups` | 无参数、无需 header → `{ok, envs:[{name,hosts:[alias]}], groups:[…], tags:[…]}`；按 env/group/tag 聚合，name 与 hosts 都升序，空桶不输出；`?env=` 等未知参数 400 |
| GET | `/api/plugins/remote/gui-open` | `?host=&protocol=rdp\|vnc` → `{ok, launched, target}`；在本机打开 RDP/VNC 客户端（Windows `mstsc`、Linux `xfreerdp`/`remmina`、VNC `vncviewer`/`vinagre`）；需同一 header；协议不是 rdp/vnc 400、本机无客户端 400（文案说明需安装或改用 SSH/Telnet） |
| GET | `/api/plugins/remote/gui-open` 的安装引导 | v2.1：缺客户端时 400 响应体带 `code:"GUI_CLIENT_MISSING"` 与 `install:{protocol,client,title,url,hint,commands:[{tool,command}]}`，面板渲染成「复制命令 / 打开下载页 / 重新检测」卡片 |
| GET | `/api/plugins/remote/novnc.js` | 返回 vendored 的 noVNC 打包产物（`vendor/novnc.bundle.js`，188694B，`application/javascript`，1h 缓存）；**不要求**执行头，只做同源校验 |
| GET | `/api/plugins/remote/desktop-status` | `?host=` → `{ok, protocol, vnc:{installed,running,port,display,server,binaries,processes}, ownedByPanel}`；非 ssh 主机 400 `DESKTOP_UNSUPPORTED_PROTOCOL` |
| GET | `/api/plugins/remote/desktop-start` | `?host=[&geometry=1280x800][&display=:9][&port=5900-5999]` → 起 Xtigervnc（`setsid -f`，只听 `127.0.0.1`）并轮询到就绪；缺服务 400 `VNC_SERVER_MISSING` + `install`（TigerVNC/TightVNC 命令）；超时 502 `VNC_START_FAILED` 附日志尾部 |
| GET | `/api/plugins/remote/desktop-stop` | `?host=` → `{ok, stopped, display}`；只杀本面板起的进程 |
| GET | `/api/plugins/remote/desktop-connect` | `?host=[&port=]` → 复用/新建 `127.0.0.1:<vncPort>` 隧道，发**单次** token（60s）→ `{ok, host, session:{token, wsPath:"/api/plugins/remote/vnc-ws", localPort, vncPort, expiresIn}}`；未运行 409 `VNC_NOT_RUNNING` |
| GET | `/api/plugins/remote/desktop-install` | `?host=&confirm=1` → 已装 `already:true`；否则在目标机上装并启动 VNC 服务（缺 `confirm=1` 400） |
| WS | `/api/plugins/remote/vnc-ws?token=` | `webServer.registerUpgrade` 注册的 WebSocket：RFC6455 握手 → `net.connect(127.0.0.1:localPort)` 双向桥接（noVNC 用）；token 无效/过期 401 |

`Origin` 存在时还要求同源（本机 `localhost` 与 `127.0.0.1` 互认）。

页面用这几条路由：主机列表、命令执行、隧道查看/新建/关闭、SFTP 目录浏览/文本预览/下载/分块上传、主机增删改、交互终端
（打开/重连/发送/增量读取/调整尺寸/关闭/下载日志）。新建隧道与 `remote_tunnel_open` 工具、文件浏览与
`remote_ls`/`remote_download` 工具、文件下载/上传与 `remote_download`/`remote_upload` 工具、主机写入与
`remote_hosts`、面板终端与 `remote_shell_*` 工具**共用同一 runtime 与连接池/主机文件解析**（路由层不复制
SSH 或配置逻辑）。每 30s 拉一次隧道列表，不轮询 exec；文件区只在切主机、进入目录、刷新、点文件、右键操作后请求，
不轮询；上传时按 8KB 串行分块。

文件行（v2.1）是 `div.remote-files-row` = 主按钮（点击打开/进入、双击就地编辑、真右键弹菜单）
+ 行尾 `.remote-files-more`「⋯」按钮（`aria-label="更多操作：<name>"`），点它把同一份菜单定位到按钮下方——
这样右键菜单不再只能在真右键里触达（headless 自动化也能点）。同时避免了 `<button>` 嵌套 `<button>`。

RDP/VNC 的「打开桌面」失败时（v2.1），若 Host 回的是 `GUI_CLIENT_MISSING`，面板在空态区渲染
`.remote-gui-install` 卡片：标题 + 提示 + 每条安装命令带「复制」按钮 + 「打开下载页 ↗」+ 「重新检测」。
命令文案由 `lib/protocols/gui.js` 的 `installInfo(protocol)` 决定，面板不做平台判断。

主机写操作只改「当前生效且可写」的 hosts 文件（`DSH_REMOTE_HOSTS` 指向的文件，或包内 `hosts.json`）；
`config.hosts` 是 patch 内联配置，面板改动对它无效，会得到 409 和改配置的提示。写入是**原子**的
（同目录 `.tmp-<pid>` + `rename`），权限 `0600`，只改目标别名，其它别名与未知字段原样保留，顶层
`{hosts:{…}}` / 裸别名映射两种形状都保持。密码通过查询参数传入（同源 + 自定义头，仅限本机），
**永不**出现在响应或主机列表里。

---

## 页面

同一个「远程主机」页面有两个入口，共用页面本体：

- **左侧栏全局面板（v1.1）**：`sidebar.panellist` 一行，`id: remote`、`order: 60`、
  `label: () => '远程主机'`；行框/label/高亮/折叠 rail 由宿主 shell 拥有，本包只贡献一个
  `viewBox 0 0 16 16` 的 `currentColor` SVG 字形（根 svg 带 `data-dsh-panel-entry="remote"`）。
  点开后的中心列页面注册在 `main`，`key: 'remote'`，外层是撑满高度、可滚动的容器。
- **会话内 View（v1，保留）**：`conversation.view`，`id: remote`、`order: 30`、同名 label。

- 布局：左侧主机列表（点击选中，绿/黄/灰点表示可用性；顶部「＋ 新建」，每行「编辑」「删除」；删除需二次
  确认，3 秒无操作复原；主机来自 `config` 时按钮置灰并提示去改 patch）｜中间命令输入 + 执行（Ctrl+Enter，
  可设超时）+ 等宽可滚动输出（显示 exitCode、耗时、截断标记）｜右侧隧道列表（可关闭）+「新建隧道」小表单
  （host 取当前选中主机、远端主机默认 `127.0.0.1`、远端端口必填、本地端口可空自动分配；提交中禁用按钮，
  失败在表单内显示可读错误，成功后刷新列表）｜执行列可在「命令 / 终端」间切换、终端多标签保活，文件区支持右键菜单（新建/重命名/删除/权限/所有者/搜索）与就地编辑（v2.0 多协议：ssh/telnet/rdp/vnc）：终端是面板内的 PTY
  （打开即连接、800ms 轮询增量输出、按键直接发送、括号粘贴一次写入、ResizeObserver 300ms 去抖跟随尺寸、剥 ANSI、切主机时关闭旧会话、卸载只断开本地以便刷新后重连、最多 8 个、空闲 10 分钟回收；v1.7 工具条加「清屏」「复制输出」「历史」：清屏清本地回显并发送 Ctrl-L 让远端重画，复制输出把已剥 ANSI 的回显写入剪贴板（clipboard 失败回退 textarea+execCommand，成功显示「已复制」2 秒），历史是组件内存里最近 20 条去重命令，点下拉整行重发；终端里 ↑/↓ 只在本地历史非空时由本地环接管并回填当前行（Ctrl-U+Ctrl-K 清行后重发），历史为空时照旧透传 \x1b[A / \x1b[B；v1.8 刷新后先用 shell-attach 回放 backlog 接回同一 PTY，终端只渲染最近 2000 行、超出提示下载，「下载日志」拉 shell-log 存 remote-<host>-YYYYMMDD-HHmmss.log）｜再右侧文件区（v1.3：路径框 + 上一级/刷新，目录在前的
  列表含名称/大小/mtime，点目录进入、点文件在下方等宽 `<pre>` 预览；截断标注「已截断」，二进制显示
  「二进制文件，不预览」，加载/空/错误三态内联显示，不弹 alert、不轮询；预览头「下载」按钮把选中文件
  以 Blob 存到本机（超过 8MB 只取前 8MB 并提示「已截断，只下载了前 N」，v1.8.1），「上传文件」按钮选本机
  文件后按 8KB 串行分块上传，进度「上传中 x% / 已上传 x/y KB」，失败自动 abort 并内联报错）。
- 主机表单（v1.4）：别名 / 主机 / 端口 / 用户 / 认证方式（密码、密码环境变量、私钥、无凭据）/ 密码或环境
  变量名 / 私钥路径 / 备注 / 禁用；编辑时密码框永远为空、占位「留空则不改」；成功后用返回的脱敏
  `hosts` 覆盖列表，不整页刷新；错误内联红字。
- 三个注册都在客户端 `apply` 里用 `ctx.effect` 包裹（内部 `ctx.slots.inject`），卸载即释放；
  shell 没声明对应 seat 时面板自然缺席，不报错。
- 只用 `require('react')`；颜色只用 `--dsw-alias-*` token（`--dsw-alias-bg-base`、
  `--dsw-alias-label-primary`、`--dsw-alias-brand-primary`、`--dsw-alias-state-*` 等），无写死颜色、
  无 iframe、不改宿主 DOM。页面中文文案 v1 直接内联。

---

## 目录

```
packages/dsh-remote/
  package.json         # exports / files / dsh.bundle.patch / dsh.client
  cordis.patch.yml     # insert id: dsh-remote
  index.js             # Host 半边：13 个工具 + 36 条 HTTP 路由 + 资源生命周期
  client.js            # Client 半边：左侧栏全局面板 + conversation.view 页面
  lib/hosts.js         # 主机解析（优先级、凭据、脱敏列表、默认私钥探测）+ 原子写 hosts 文件
  lib/ssh.js           # ssh2 懒加载 + 连接池 + connect options
  lib/exec.js          # 超时规范化、输出预算、exec 流收集
  lib/sftp.js          # ls / stat / read / readBuffer / write / local-file upload / rename / unlink / mkdir -p
  lib/upload.js        # 分块上传会话（.part 临时文件、offset 校验、part→rename、空闲回收）
  lib/tunnel.js        # 转发目标校验 + 隧道记录 + net 本地监听
  lib/shell.js         # PTY 会话注册表与 shell 缓冲 + 面板累积日志
  lib/truncate.js      # UTF-8 字节截断 / 字节 sink / 尾部保留
  locale/en.json       # meta.title / meta.description
  locale/zh.json
  icon.svg             # 原创图标
  test/smoke.mjs       # 不连真 SSH 的冒烟测试
```

依赖：只用 Node 22 内置模块 + `ssh2`（从仓库根 `node_modules` 解析；本包不声明依赖、不需要安装）。
`ssh2` 是惰性 `import()`，所以「只导入 index.js」不会加载它。

---

## 验证

```bash
cd F:\maple\dsh-plugin-pack
node --input-type=module -e "await import('file:///F:/maple/dsh-plugin-pack/packages/dsh-remote/index.js')"
node packages/dsh-remote/test/smoke.mjs
```

`smoke.mjs` 覆盖：主机配置解析与优先级、别名/`user@host:port`/缺凭据/禁用/未知主机报错、
密码不泄露、UTF-8 截断（stdout 64KB / stderr 16KB / shell 32KB / byte sink）、超时规范化、
隧道记录增删与目标校验、shell 注册表（假 stream）、36 条 HTTP 路由的鉴权/参数边界、shell 面板路由的 base64 往返/增量读取/关闭 404、resize 参数与 404、attach 的 backlog 形状与 404、log 的 maxBytes 边界与截断形状、bracketed 包裹与越界序列剔除、computeTerminalGrid 限幅与下载时间戳、文件路由的目录
映射/文本预览/二进制判定/maxBytes 截断（假 runtime）、文件下载的 maxBytes/目录/缺失/成功形状、分块上传的
begin/chunk/finish/abort 参数边界、offset 409、单块 413、part→rename 与 abort 清理、并发上限（假 SFTP）、主机写入路由的参数校验/409/原子 upsert/未知字段
保留/删空 warning（临时目录 + 注入 `packageHostsPath`）、13 个工具清单与 `output.schema`、client 语法与
主题 token、README/locale/icon 齐全。

安装（由 Lead 统一执行，本包自己不做）：`plugin_manager` `install_bundle`，target 为本目录绝对路径。
装完在插件面板确认标题「远程主机 / Remote hosts」和图标；页面在会话顶部 View 切换里出现。

---


## 内嵌桌面（v2.2）

- 顶层三个模式：**命令 / 终端 / 桌面**。桌面模式在面板里直接渲染远端画面，不需要本机装 VNC 客户端。
- 链路：面板 `desktop-connect` 拿单次 token → `new WebSocket('/api/plugins/remote/vnc-ws?token=…')` →
  Host 侧 `bridgeDesktop` 校验 token/同源 → RFC6455 101 → `net.connect(127.0.0.1:<隧道本地端口>)` → 双向对拷。
- 目标机没装 VNC 服务时，`desktop-start` 返回 `install{vnc-server}`，面板渲染成可复制的安装命令卡片。
- 两个坑（README 根目录也记了）：`WEBSOCKET_GUID` 必须 36 字符（少一位只有 Chrome 会 1006，Node 客户端测不出来）；
  noVNC 的 `RFB` 会把 `<div._screen>` append 进 target，所以 target 必须是容器 div，不能是 `<canvas>`。
## 内嵌桌面的体验闭环（v2.3）

- **剪贴板双向**：远端 `clipboard` 事件写进 `.remote-desktop-clip`（只读文本，配 `.remote-desktop-clip-copy`「复制到本机」）；
  本机侧 `.remote-desktop-clip-input` + `.remote-desktop-clip-send` 调 `rfb.clipboardPasteFrom`；画布里 Ctrl/Cmd+V 直通远端。
- **模式切换保活**：桌面面板常挂（`desktopMounted` + `display:none`），「命令/终端 → 桌面」不会重建 RFB、不重新握手。
- **自动重连**：`DESKTOP_RETRY_DELAYS = [1000, 2000, 4000]`，只对意外断线生效；三次失败后停止并显示
  「自动重连已停止」+ `.remote-desktop-reconnect`「重新连接」。
- **全屏**：`.remote-desktop-fullscreen` 对 `.remote-desktop-stage` `requestFullscreen`。
- **布局约束**：常挂的桌面面板必须是执行列 `section` 的子项（`flex: 1 1 auto`）；写成它的兄弟节点会多挤出一列，
  1280 宽下把面板压到 93px 并让整页横向溢出。
- 实测：linux26 上停掉 `Xtigervnc` → 面板「已断开」并按 1s/2s/4s 重试三次 →「自动重连失败：目标机还没有正在运行的
  VNC 服务…」；重启服务后点「重新连接」→ 立即「已连接 · 1280x800 · dsh-demo」。剪贴板两个方向都验过真值。

## 缺什么就代目标机装什么（v2.4）

- 新路由 `GET /api/plugins/remote/desktop-install?host=&confirm=1`：已装 → `already:true`；否则 Windows 逐条跑五步
  （MSI 下载 → 校验 → `msiexec /qn` → 只放行回环的 netsh 阻断规则 → `sc config` + `net start`），Linux 走
  `apt-get`/`dnf` 装 `tigervnc-standalone-server xterm`。缺 `confirm=1` 直接 400（它会改动目标机）。
- 面板 `.remote-desktop-install` 卡片里多了 `.remote-desktop-auto-install`「自动安装并启动」：一次完成安装 → 启动 → 连接，
  `.remote-desktop-install-log` 展示每条命令的退出码；用户不用下载任何东西、也不用抄命令。
- **命令通道只能一行一条**：目标机 exec 只跑命令串第一行，`if (…) else (…)` 之后的 `&` 会被吞。所以安装步骤拆成独立命令
  逐条执行，探针（`windowsProbeCommand`）压成单行且 `if exist … DIR-TIGHTVNC` 放最后。
- **安全**：装完立即加 `dsh-vnc-standalone` 入站阻断规则（TCP 5900），VNC 只服务回环，画面经插件自己的 SSH 隧道进浏览器。
- 实测（win22）：卸载重来后五步 `CURL-EXIT=0` / `DSH-DOWNLOAD-OK` / `MSI-EXIT=0` / netsh「确认。」/ `STATE : 4 RUNNING`，
  单行探针拿到 `0.0.0.0:5900 LISTENING` + `DIR-TIGHTVNC`。

## 与「流水线」面板联动（v2.6）

远程主机面板头部有一个 `流水线` 按钮（`.remote-open-pipeline`）：点了会切到左侧栏的「流水线」面板（由 `@local/dsh-cicd` 注册的 `data-dsh-panel-entry="cicd"` 入口）。没装/没启用 `@local/dsh-cicd` 时按钮会内联报错说明「重启一次 DSH」。它只做跳转，不复制流水线的 UI 与状态。

## 跳板机多跳链（v2.5）

- `hosts.json` 每条主机可加 `"jump": ["jump-a", "jump-b"]`（也接受逗号串 `"jump-a,jump-b"`），
  **最多 3 跳**，顺序就是连接顺序：本机 → jump-a → jump-b → 目标机。
- 每一跳都是独立主机条目，各自走自己的凭据（`password` / `passwordEnv` / `privateKeyPath` + `passphrase`），
  所以跳板用密钥、目标机用密码这种混搭也成立。跳板必须是 `ssh` 协议。
- 解析期就拦掉的错误：跳板不存在、非法别名、指自己、重复、超过 3 跳、成环（`跳板链存在循环：a → b → a`）、
  跳板不是 ssh、跳板被禁用、跳板缺凭据（会被包成 `主机 "x" 的跳板 "y" 不可用：…`）。
- 连接池按链成组管理：跳板连接与目标连接一起建立、一起回收，跳板掉线会带走整条链。`remote_hosts` 的
  `meta.via` 里能看到走了哪几跳，`publicHosts` 额外给 `jump` 与 `jumpIssue`。
- 面板：新建/编辑表单里有「跳板链（可选）」，主机行显示「经 a → b」；链上有问题时该行标成未就绪。

```json
{
  "hosts": {
    "win22": { "host": "192.168.1.22", "user": "Administrator", "passwordEnv": "WIN22_PASSWORD" },
    "linux26": {
      "host": "192.168.1.26",
      "user": "bei_ang",
      "privateKeyPath": "C:/Users/me/.ssh/id_ed25519",
      "jump": ["win22"]
    }
  }
}
```

联调脚本（一次性，放在仓库 `.tmp/jump-e2e.mjs`，不随包发布）跑的就是 `win22` 跳板 → `linux26` 目标：
`pool.acquire` 之后 `hostname; echo JUMP-E2E-OK` 回 `beiang-server` / `JUMP-E2E-OK`（约 4s），
`snapshot()` 里 `via: ["win22"]`，`close()` 后 `keys().length === 0`。

## 冷启动路由注册（v2.7.1）

Host 冷启动时 `webServer` 服务晚于插件 `apply()`，v2.7.0 及之前在 apply 里同步 `ctx.get('webServer')` 拿不到服务 → 静默跳过路由注册 → 整包路由 404（插件列表看不出毛病，页面 API 全 401/404）。v2.7.1 起照 aihot 的修法把路由注册挂到 `ctx.inject(['webServer'], …)`：服务就绪后补注册 36 条 exact 路由 + 1 条 upgrade；工具注册保持同步。smoke 有冷启动回归（apply 时 0 路由 → inject 触发后 36+1）。

## 已知限制

- 文本优先：没有 RDP、截图、文件管理器 GUI；`remote_download` 工具只按 UTF-8 文本返回内容，
  面板的「下载」按钮走 `file-download`，可以取二进制（单次最多 8MB，超出截断标注）。
- 只做本地端口转发（`127.0.0.1` 监听）；不做远端转发、SOCKS、IPv6、agent forwarding。
  跳板机从 v2.5 起支持（`jump` 链，最多 3 跳，见上节）。
- 同一主机共享一条连接：池化连接断开后 shell/隧道随之失效（重新 open 即可）。
- PTY 输出不清洗 ANSI 控制符；`remote_shell_send` 只返回写后 `waitMs` 窗口内的输出。
- 输出预算：exec stdout 64KB / stderr 16KB、shell 32KB、SFTP 读 64KB、
  目录列表 500 项、PTY 缓冲保留尾部 256KB；截断都会用 `truncated` 标注。
- 超时上限 600 秒；`KILL` 依赖远端 shell 响应，个别命令可能只收到部分输出。
- 页面从 v1.2 起支持新建/关闭本地隧道，v1.3 起支持 SFTP 文件浏览与 ≤64KB 的文本预览（当时只读），v1.4 起
  支持文件型主机配置的增删改，v1.5 起执行列可切到面板内交互终端（≤8 个会话、空闲 10 分钟回收；v1.6 支持括号粘贴与尺寸跟随，尺寸按固定 7.2px 字符宽/17px 行高估算，夹 20–500 / 5–200；v1.6 同时把「本地隧道」与「文件」上下叠进右侧 320px 一列，1280 宽窗口下 `<pre>` 371px → `48x38`，不再被挤到下限；v1.7 加清屏/复制输出/本地命令历史，历史只存面板内存、不落盘；v1.8 起刷新页面会先用 `shell-attach` 接回同一 PTY（记录在 `sessionStorage`，仅会话级），终端只渲染最近 2000 行并在超出时提示下载，工具条「下载日志」拉 `shell-log` 存为 `remote-<host>-YYYYMMDD-HHmmss.log`；服务端日志上限 4MB，超出从头裁；v1.8.1 文件区支持下载（8MB/16MB 上限）与 8KB 分块上传（单文件 64MB、≤4 个并发会话、先写 `.part` 再 rename）；v2.0 起支持协议适配层（ssh/telnet/rdp/vnc，rdp/vnc 只调本机客户端）、文件区闭环（写文件 ≤256KB、建目录、重命名、删除、chmod/chown、名称搜索、排序/显示隐藏、右键菜单、就地编辑）与终端多标签保活）；建目录已可在页面完成（v2.0）；页面依赖 profile 的
  `webServer`。
- 主机增删改不碰 `config.hosts`（patch 内联只读，409）；改完别名后该主机的池化连接会被主动丢弃，
  生效的是下一次连接。密码以查询参数传输（见「安全约定」），终端历史/日志可能留痕。
- 无自动口令提示：私钥有口令时需在主机配置里写 `passphrase`。
- 未做完整 E2E：面板终端在真实主机上验证过 open/attach/read/log/close（55378），但 SFTP 下载/分块上传、
  隧道真实转发、浏览器 UI（剪贴板、下载、上传进度）未在目标环境跑过；真实连接受网络/远端策略影响。