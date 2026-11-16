# dsh-plugin-pack

DSH 插件包：一组可直接装进当前 profile 的 **bundle**（Host 插件 + Web 页面），当前三个方向五个入口：

| 方向 | 包 | 交付 |
|---|---|---|
| 远程控制 | `packages/dsh-remote`（`@local/dsh-remote`） | 13 个 `remote_*` 工具（SSH / SFTP / 本地端口转发 / 持久 PTY / 多机并发），左侧栏「远程主机」全局面板（主机增删改 / 命令 / 面板内交互终端 / 隧道 / 文件浏览）+ 会话内同名 View |
| 流水线 | `packages/dsh-cicd`（`@local/dsh-cicd`） | 8 个 `cicd_*` 工具（项目 / 计划 / 执行 / 状态 / 日志 / 发布 / 回滚 / 目标），读仓库 `pipe.yml` 本地构建，经 dsh-remote 发布与自动回滚，运行记录落本地 SQLite（`node:sqlite`） |
| 社区资讯 | `packages/dsh-aihot`（`@local/dsh-aihot`） | 8 个 `aihot_*` 工具（精选/搜索/热点/日报/周报/月报/额度重置/来龙去脉），左侧栏「AI 资讯」全局面板（精选 / 热点 / 日报+周报+月报期刊 / 福利）+ 会话内同名 View；卡片可展开「来龙去脉」时间线抽屉并复制链接，也可「读正文」就地看全文 |

设计契约：`docs/SPEC.md`。验收闸门：`test/mount.mjs`（无 Host 环境挂载自检）。

## 安装 / 重载

```
plugin_manager(action="install_bundle", target="F:\maple\dsh-plugin-pack\packages\dsh-remote")
plugin_manager(action="install_bundle", target="F:\maple\dsh-plugin-pack\packages\dsh-cicd")
plugin_manager(action="install_bundle", target="F:\maple\dsh-plugin-pack\packages\dsh-aihot")
```

- 装完看 `application: applied` 与 `warnings`（本地目录是 **链接**，不是拷贝）。
- **只改 `client.js`**：刷新页面即可（新 Client 模块随下次页面加载生效）。
- **改了 `index.js` / `lib/`**：需要重载 Host。不用重启 DSH：
  `plugin_manager(action="set_plugin", target="include:dsh-remote", enabled=false)` 再 `enabled=true`
  （实测 16:21 这样重载后新路由立即生效）。
- 卸载：`plugin_manager(action="remove_bundle", target="@local/dsh-remote")`。

## dsh-remote（远程控制，文本优先）

| 工具 | 作用 |
|---|---|
| `remote_hosts` | 列已配置主机（脱敏、标注认证方式、连接池/隧道/shell 概览） |
| `remote_exec` | 单机执行，stdout 64KB / stderr 16KB，超时 KILL 并返回部分输出 |
| `remote_cluster_exec` | 最多 10 台并发同一命令，单台失败隔离，每台各 16KB |
| `remote_ls` / `remote_download` / `remote_upload` / `remote_mkdir` | SFTP 列目录 / 读文本 / 写文本或本机文件 / 递归建目录 |
| `remote_tunnel_open` / `remote_tunnel_close` / `remote_tunnel_list` | 本地端口转发 `127.0.0.1:local → remote:port` |
| `remote_shell_open` / `remote_shell_send` / `remote_shell_close` | 持久交互式 shell（REPL、长驻进程、需要环境状态的连续操作） |

主机配置（按优先级）：`config.hosts`（patch 里内联）→ `DSH_REMOTE_HOSTS` 指向的 JSON →
包内 `packages/dsh-remote/hosts.json`（**已 .gitignore**，本机复用了根目录那份；别名 linux26 / win22 / remote113）。
凭据支持 `password` / `passwordEnv` / `privateKeyPath`，返回值与日志永不出现密码。

面板里可以直接加/改/删主机（v1.4）：主机列有「＋ 新建」、每行「编辑」「删除」（删除需 3 秒内二次确认）。
写操作只落在**包内 `hosts.json`**（原子写：`.tmp-<pid>` + rename，尽量 0600，保留未知字段与原 JSON 形状）；
主机来自 `config.hosts` 或环境变量文件时**拒绝写**（返回 409，面板把按钮置灰），
避免把补丁文件或共享文件改坏。密码请优先用 `passwordEnv`，因为 GET 查询串会留在本机 URL/日志里。

页面路由（全部 GET，见下节）：
`/api/plugins/remote/hosts`、`/api/plugins/remote/exec?host=&command=&timeoutSec=`、
`/api/plugins/remote/tunnels[?action=close&tunnelId=]`、`/api/plugins/remote/tunnel-open?host=&remoteHost=&remotePort=&localPort=`、
`/api/plugins/remote/files?host=&path=`、`/api/plugins/remote/file?host=&path=&maxBytes=`、
`/api/plugins/remote/host-save?alias=&host=&port=&user=&auth=&secret=&privateKeyPath=&note=&disabled=`、
`/api/plugins/remote/host-delete?alias=`
（v1.5 再加面板终端四条：`/api/plugins/remote/shell-open?host=&cols=&rows=`、
`/api/plugins/remote/shell-send?sessionId=&data=<base64>[&cols=&rows][&bracketed=1]`、
`/api/plugins/remote/shell-read?sessionId=`、`/api/plugins/remote/shell-close?sessionId=`；
v1.6 再加 `/api/plugins/remote/shell-resize?sessionId=&cols=&rows=`；
v1.8 再加 `/api/plugins/remote/shell-attach?sessionId=&cols=&rows=`、`/api/plugins/remote/shell-log?sessionId=[&maxBytes=]`；
v1.8.1 再加 `/file-download?host=&path=[&maxBytes=]`、`/file-upload-begin?host=&path=&size=&mode=`、
`/file-upload-chunk?uploadId=&offset=&data=<base64>`、`/file-upload-finish?uploadId=`、`/file-upload-abort?uploadId=`；
v2.0 再加 9 条：`/api/plugins/remote/{file-write,file-mkdir,file-rename,file-delete,file-chmod,file-chown,file-search}`、
`/api/plugins/remote/protocols`（免头）、`/api/plugins/remote/gui-open?host=&protocol=rdp|vnc`）——
共 **29 条**，除 `hosts`、`protocols` 外都要求 `x-dsh-remote-exec: 1` 头 + 同源。

实测（2026-11-13）：面板里对 `linux26` 执行 `echo …; uname -sr; uptime -p` → `exit 0 / 93 ms`
+ `Linux 6.8.0-147-generic`（真 SSH，经连接池）。面板现为四列：主机（可增删改）/ 执行 /
本地隧道（可在面板里新建）/ 文件浏览（列目录 + 点文件看文本预览，走同一连接池的 SFTP）。
v1.4 的写盘已真跑过：`host-save` 新增 `probe1` → `packages/dsh-remote/hosts.json` 里多出该条且
linux26 的 note、win22 的 password 都原样保留；`host-delete` 删除后回到 3 台，重复删返回 404。

v1.5 的**面板内交互终端**（执行列「命令 | 终端」两段）：切到终端会连一台真 PTY（`shell-open` → 800ms
轮询 `shell-read`、按键即发 `shell-send`、卸下面板即关会话）。真实链路验过两遍：
走 HTTP 送 `echo TERM-PROBE-$((1+1))` → 回 `TERM-PROBE-2`、`uname -sr` → `Linux 6.8.0-147-generic`、
`pwd` → `/home/beiang`，`shell-close` 后再读回 404「会话 sh1 不存在（可能已关闭或超时）」；
面板里切到终端自动显示「已连接 · sh2」+ 登录 banner（ANSI 已剥），点 `pre` 后按 `l` `s` `Enter`
→ 屏幕出现 `ls` 的真实输出。上限 8 个会话（409）、空闲 10 分钟自动回收、单次输出 base64 ≤48KB 截断。

v1.6 给这个终端补了**粘贴**与**尺寸跟随**：`Ctrl+V` 走 `onPaste` 一次以 `bracketed=1` 发完整段
（Host 用 `\x1b[200~…\x1b[201~` 包裹并剔除正文里的越界序列，多行粘贴不会被逐字执行）；
面板尺寸变化时 `ResizeObserver` 去抖 300ms 按字符宽高算 `cols×rows`（夹 20–500 / 5–200），
只在格数变化时打 `shell-resize`，状态行显示的尺寸就是真 PTY 的尺寸。
真机验过：`shell-resize` 120×40 → `{ok:true,cols:120,rows:40}`、坏 cols 400、未知会话 404、缺头 403；
`bracketed=1` 粘贴 `echo PASTED-OK` → 回显为反向视频的整段文本，回车的输出就是 `PASTED-OK`。

同一版还修了**面板被挤窄**这个真问题：原来「主机 / 执行 / 隧道 / 文件」4 列并排，1280 宽窗口下文件列把执行列压到
~170px，终端只能夹到 `20×33`（状态行还会竖着换行）。现在把「本地隧道」与「文件」上下叠进右侧 320px 一列，
执行列设 `minWidth: 360px`，同样的窗口下 `<pre>` 实测 371px → 状态行 `PTY · linux26 · 48x38`，
点 `pre` 后按键能直接敲真命令（本轮实测 `l` `s` `Enter` → 回 `apply26.sh`、`cb_v3.py`、`cloudflared.deb` 等目录项）。

v1.7 再给终端加了一条**工具条**（都在状态行里）：`清屏`（`.remote-term-clear`，清本地回显后发 `Ctrl-L`
即 `\x0c` 让远端重画）、`复制输出`（`.remote-term-copy`，复制已剥 ANSI 的回显，`navigator.clipboard`
不可用时回退隐藏 textarea + `execCommand('copy')`，成功按钮文案变「已复制」2 秒复位）、
`历史`（`.remote-term-history` 展开 `.remote-term-history-list`，本次面板会话内最多 20 条，点条目即
`命令 + \r` 重发）。编辑行走本地缓冲（字符 / Backspace / ←→ / Home / End / Ctrl-C 都在前端记账，
`Enter` 提交进历史）；`↑` `↓` 只在历史非空时接管（先发 `\x15\x0b` 清掉远端整行再回填），
否则原样透传 `\x1b[A` / `\x1b[B` 给 PTY。
真机验过：状态行 `PTY · linux26 · 45×34`，点 `pre` 后敲 `l x l l s` + `Enter` → 远端直接回
`lxlls: command not found`（按键真到了 PTY），`历史` 下拉里能看到先前那条 `uname`、点一下即重发。

v1.8 补了**会话恢复**与**日志**：刷新页面／重挂载面板时先用 `shell-attach` 接回同一个 PTY
（404 才重开），会话 id 记 `sessionStorage['dsh-remote.shell.<host>']`，状态行显示「已恢复 · shN」；
回显只渲染最近 2000 行（超出提示可下载），每个会话在 Host 侧另存 4MB 环形日志，
工具条 `下载日志`（`.remote-term-download`）导出 `remote-<host>-YYYYMMDD-HHmmss.log`。
线上实测：`shell-open → shell-attach`（backlog 1426B）→ attach 后 `shell-read` 只回 83 字节（不重放）→
`shell-log` 200 且含标记 → `shell-close` 干净回收。

v1.8.1 给文件列补了**下载**与**分块上传**（`.remote-files-download` / `.remote-upload-input`）：
`/file-download?host=&path=[&maxBytes=]` 走 SFTP 读缓冲，返回 `{content:<base64>,size,bytes,truncated,entry}`
（文本用 `content` 而非 `bytes` 字段，二进制安全；目录 400「是一个目录，不能下载」）；
上传是 `/file-upload-begin`（返回 `uploadId`、`chunkBytes: 8192`）→ 多次 `/file-upload-chunk?uploadId=&offset=&data=<base64>`
（offset 必须等于已写字节数，否则 409）→ `/file-upload-finish`（先写 `.part` 再 rename）或 `/file-upload-abort`；
单块 8192B 是按实测 carrier 查询串上限选的（`?pad=` 24576 字符就 431，8192B 的 base64 ≈10924 字符安全）。
线上真跑：下载 `/etc/hostname` → 200 解码 `beiang-server`；上传 47B 到 `/tmp` 两分块 + finish → 回读 MATCH；
坏 offset 409、未知 uploadId 404、缺头 403、目录 400。

**v2.7.1（2026-11-16）上传挂死修复**：真机 E2E 实测 win22（Windows OpenSSH）对父目录缺失的远端路径
打开写入流后，`stream.write` 回调既不 error 也不 close，chunk 请求无限挂起（后续请求排在死链后面也挂）。
三层防御（`lib/upload.js`）：

1. `begin()` 预检父目录（`stat` 一次，fake sftp 无 `stat` 方法时跳过）→ 缺失直接 400
   `UPLOAD_TARGET`「父目录不存在」，不再进入会挂死的写入流；
2. `writeBuffer` / `endStream` 加 `uploadWriteTimeoutMs`（默认 30s，`LIMITS` 可调）→ 超时抛
   `UPLOAD_WRITE` 502「30s 内没有收到写入确认」，上层（dsh-cicd `uploadFile` catch →
   `file-upload-abort`）能干净收尾；
3. 流死亡后后续 chunk 立即失败（`session.streamError` 记账），不再各等一轮超时。

真机复测（同 E2E）：win22 从挂死 12 分钟 → 秒级 400「父目录不存在：/srv/dsh-fanout/releases/…
（请先创建目录再上传）」，run 整体 failed 但 linux26 成功、releases 记录齐全，E2E 全绿。

**v2.0（2026-11-13，对标 MobaXterm 常用面）** 两条线一起补：

1. **协议可扩展**：新增 `lib/protocols/`（`ssh` / `telnet` / `rdp` / `vnc` 四个适配器 + 注册表），
   每个适配器带 `capabilities:{exec,sftp,tunnel,pty,gui}` 与默认端口；`GET /api/plugins/remote/protocols`
   直接吐能力矩阵（免头），面板按能力显隐列、按协议切默认端口。`hosts.json` 每条加 `protocol`（缺省 `ssh`，
   老记录自动兼容）；非 `ssh` 主机强制 `auth=none`。
   - **Telnet** 是原生实现：同一套面板终端，只是底层换成 TCP socket（端口默认 23）。
   - **RDP / VNC** 只做「调本机客户端」：`GET /gui-open?host=&protocol=rdp|vnc` 在 Host 机器上拉起
     `mstsc.exe`（Windows 自带）/ `vncviewer`·`xfreerdp`·`remmina`·`vinagre`；找不到就给中文 400
     「本机没有 vncviewer（推荐 MobaXterm/TigerVNC），或改用 SSH/Telnet」。
     面板里除「打开桌面」（调本机客户端）外，v2.2 起还支持**VNC 内嵌**（noVNC + Host 侧 WS 桥，见下文 v2.2）；RDP 仍只能调 `mstsc`。
2. **文件区闭环**：`/file-write`（≤256KB，overwrite/append/create）、`/file-mkdir`、`/file-rename`、
   `/file-delete`（目录必须 `recursive=1`，否则 409）、`/file-chmod`、`/file-chown`、`/file-search`（BFS），
   `/files` 加 `sort=name|size|mtime` 与 `hidden`。文件列 UI 补：**右键菜单**（下载、上传到此处、新建文件、
   新建目录、重命名、复制路径、权限、删除、刷新）、**权限对话框**（rwx 九宫格 + 八进制 + 递归）、
   **双击就地编辑**（≤256KB 存 `/file-write`，超了只读并提示）、目录搜索、隐藏文件开关。
3. 多标签终端：执行列可开多个 PTY tab，切走保活、可关闭。

线上实测（linux26，真 SSH）：`protocols` → `ssh:exec+sftp+tunnel+pty | telnet:pty | rdp:gui | vnc:gui`；
`mkdir → write(create) → 回读 "hello v2.0" → write(append) → rename → chmod 0640 → search('b' 命中 b.txt) →
delete（无 recursive 409）→ delete recursive`；`chmod mode=99` → 400「mode 必须是八进制权限（如 0644）」；
`chown 0:0` → 403「Permission denied」（非 root）；`gui-open protocol=bogus` → 400；本机无 vncviewer → 400。

**v2.1（2026-11-13，落地两处「用户会问的缺口」）**：

1. **外部客户端安装引导**（用户问过「没装 MobaXterm / VNC 客户端怎么办」）：`lib/protocols/gui.js` 新增
   `installInfo(protocol)`，缺客户端时 `GUI_CLIENT_MISSING` 的 400 响应体里多带 `code` 与
   `install: {protocol, client, title, url, hint, commands:[{tool,command}]}`；面板把它渲染成
   `.remote-gui-install` 卡片——标题 + 提示 + 命令列表（每条带「复制」按钮，成功变「已复制」）+
   「打开下载页 ↗」+ 「重新检测」（再调一次 `gui-open`）。Windows 给 `winget install -e --id RealVNC.VNCViewer`、
   `choco install vncviewer`；Linux/macOS 给 `apt install tigervnc-viewer`、`brew install --cask vnc-viewer`、
   `sudo dnf install tigervnc`。**不需要 MobaXterm**：本包零外部依赖，SSH/SFTP/隧道/PTY 全走 ssh2 + net。
   两个「打开桌面」按钮都带 `.remote-gui-open` 类（便于点选/自动化），卡片内的复制按钮是 `.remote-gui-copy`、
   重试是 `.remote-gui-retry`。
2. **文件行「⋯」按钮**：右键菜单原本只能在真右键里用（headless 不可测）；现在每行是 `div.remote-files-row`
   = 主按钮 + `.remote-files-more`（`aria-label="更多操作：<name>"`），点它用 `getBoundingClientRect()`
   把同一份 `.remote-menu` 定位到按钮下方。也顺手修掉 `<button>` 套 `<button>` 的非法嵌套。

**v2.2（2026-11-14，VNC 内嵌桌面：面板里直接看到远端画面）**：

1. **可行性来自 DSH 自己的 webserver**：`dsh-host-webserver` 暴露 `registerUpgrade({path, handler(req, socket, head)})`
   （服务名 `ctx.webServer`），所以插件能在 DSH 同一端口上挂 WebSocket——carrier「只放 GET/HEAD」的限制对
   upgrade 不适用，不必自开端口。本包注册 `path: "/api/plugins/remote/vnc-ws"`。
2. **五条桌面路由**（全 resource/GET，除 `novnc.js` 外都要求 `x-dsh-remote-exec: 1`）：
   `novnc.js`（免头，静态资产 `vendor/novnc.bundle.js`，188694B，`application/javascript` + 1h 缓存）、
   `desktop-status`（探 VNC 服务/端口/显示号）、`desktop-start`（缺服务给 `VNC_SERVER_MISSING` + 安装命令，
   拉起命令用 `setsid -f sh -c 'exec … </dev/null'`——**普通 `nohup … &` 会被 exec 层连带杀掉**）、
   `desktop-stop`（只杀本面板起的进程）、`desktop-connect`（复用/新建 `127.0.0.1:vncPort` 隧道，发单次 token，
   60 秒有效，返回 `session{token,wsPath,localPort,vncPort,expiresIn}`）。
3. **WS 桥**：`lib/wsbridge.js` 手写 RFC6455（`acceptKey` / `performHandshake` / `encodeFrame` / `WebSocketPeer`），
   把升级后的 socket 与 `net.connect(127.0.0.1:localPort)` 双向对拷；token 用 `createTokenStore`（单次、60s），
   origin 与 host 头都做同源/回环校验。
4. **客户端**：`DesktopPanel` 动态 `import()` noVNC（`globalThis.DSHNoVNC.RFB`）、三态（未连/连接中/已连）、
   工具条（缩小适应 `.remote-desktop-fit` / 1:1 `.remote-desktop-actual` / 发送 Ctrl-Alt-Del / 复制全屏 / 断开）、
   失败时把 400 的 `install` 命令渲染成引导卡片。noVNC 客户端包用 esbuild `format:"esm", target:"es2022"` 打
   （iife 会因 `core/util/browser.js` 顶层 await 失败）。

**两个真坑（都已修，务必别重踩）**：

- `lib/wsbridge.js` 的 `WEBSOCKET_GUID` 必须**36** 字符 `258EAFA5-E914-47DA-95CA-C5AB0DC85B11`；
  少一位（例如漏掉 `C5A` 的 `C`）时 Node 的 WS 客户端照样握手成功（它只比对摘要），**只有 Chrome 会 1006**，
  所以自搓 E2E 全绿不等于浏览器能用。smoke 里有两条 `acceptKey` 回归锁住这一点。
- noVNC 的 `RFB` 构造函数会 `this._target.appendChild(this._screen)`：target **必须是容器 div**，
  传 `<canvas>` 会让 `<div>` 塞进 canvas（非法嵌套、永不渲染，canvas 卡在默认 300×150）。
  现在 target 是 `div.remote-desktop-canvas`（100% 宽高），noVNC 自建内部 canvas 才正常绘制。

线上实测（linux26，TigerVNC + xterm）：`desktop-status` → `{installed:true, running:true, port:5909, display:":9"}`；
`desktop-start` 复用已起服务 → `{started:false, reused:true}`；`desktop-connect` → 隧道 `127.0.0.1:50679 → 127.0.0.1:5909`；
浏览器里状态行 `已连接：1280x800 · dsh-demo`，画布渲染出真实 xterm 窗口，`1:1` 与「缩小适应」都生效；
同一 token 重放 WS → `401`。
与 `@linxin666/dsh-ssh` 的分工：那个包是「SSH 全家桶」（含 web 终端、跳板机、`ssh_*` 工具）；
本包是原生 DSH 工具 + 多协议统一（SFTP/隧道/PTY）+ 并发 cluster + 与 Agent 会话同屏的面板，工具名 `remote_*` 不冲突。

**v2.3（2026-11-14，内嵌桌面的体验闭环）**：

1. **剪贴板双向**：远端 `clipboard` 事件落到 `.remote-desktop-clip` 条（只读文本 + `.remote-desktop-clip-copy`
   「复制到本机」）；本机侧 `.remote-desktop-clip-input` + `.remote-desktop-clip-send` 走 `rfb.clipboardPasteFrom`。
   画布里按 Ctrl/Cmd+V 也会直接把系统剪贴板贴到远端。
2. **模式切换不重建连接**：桌面面板常挂、切走时 `display:none`（`desktopMounted`），所以「命令 → 桌面」回来
   仍是「已连接」，不会回到 hero 态、也不会重新握手重开隧道。
3. **意外断线自动重连三次**：`DESKTOP_RETRY_DELAYS = [1000, 2000, 4000]`；三次都失败后停手，显示
   「自动重连已停止」+ `.remote-desktop-reconnect`「重新连接」（手动断开不触发重连）。
4. **全屏**：`.remote-desktop-fullscreen` 对 `.remote-desktop-stage` 调 `requestFullscreen`（Esc 退出）。
5. **面板必须挂在执行列的 section 里**：常挂的面板一旦写成 section 的兄弟节点，1280 宽下会多挤出一列
   （实测 93px 宽、整页横向溢出 72px）；它是 `flex: 1 1 auto` 的子项，和命令/终端共用同一格。

实测（linux26，`pkill -f "Xtigervnc :9"` 制造断线）：面板先显示「已断开」，随后按 1s/2s/4s 重试；服务未起时
三次失败 → 「自动重连已停止 / 自动重连失败：目标机还没有正在运行的 VNC 服务，请先点「启动远程桌面」」；
把 `Xtigervnc` 重新拉起后点「重新连接」→ 立即回到「已连接 · 1280x800 · dsh-demo」，画面继续刷新。
剪贴板双向都对过真值：本机 `hello-from-dsh-clipboard-2026` → 远端 `xclip -o -selection clipboard` 同串；
远端 `printf "remote-clip-from-linux26-42" | xclip -selection clipboard` → 面板出现该文本并可「复制到本机」。

**v2.4（2026-11-14，缺什么就由插件代目标机装什么）**：

1. **自动安装 VNC 服务**：`GET /api/plugins/remote/desktop-install?host=&confirm=1`（`resource`，同样要
   `x-dsh-remote-exec: 1`；缺 `confirm=1` 直接 400，因为它会改动目标机）。已装则返回 `already:true`；
   Windows 走 TightVNC MSI（`%TEMP%\dsh-tightvnc.msi` → `msiexec /qn` → 只放行回环的 netsh 阻断规则 →
   `sc config tvnserver start= auto` + `net start`），Linux 走 `apt-get`/`dnf` 装 `tigervnc-standalone-server xterm`。
   面板的 `.remote-desktop-auto-install`「自动安装并启动」一次做完安装 + 启动 + 连接，`.remote-desktop-install-log`
   展示每条命令的退出码 —— 用户不需要下载任何东西、也不用手抄命令。
2. **命令通道只能一行一条**（踩出来的）：目标机 exec 只执行命令串的第一行，`if (…) else (…)` 之后的 `&` 会被吃掉。
   所以 Windows 安装被拆成五条独立命令逐条执行，探针也压成单行（`PROBE-END` 提前、`if exist` 放最后）。
3. **无认证的 VNC 只留回环**：安装完自动加 `dsh-vnc-standalone` 入站阻断规则（TCP 5900），局域网连不上，
   插件自己通过 SSH 隧道把 `127.0.0.1:5900` 送到浏览器。
4. **又一个可空字段 schema bug**：`remote_hosts` 的 `configError` 原来在没有问题时返回 `null`，schema 只声明
   `type: 'string'`，导致整个工具报 `value.configError must be a string`；改成空串（同类问题见 v1.8.1 的 `signal`、
   v2.3 的 cluster `error`/`exitCode`）。
5. **组合包也能过闸门**：`test/mount.mjs` 现在认 `dsh-user-data-backup` 这种只有 patch、没有自有入口的包
   （只校验 `insert:` 里插了真实包名，不尝试挂载）。

实测（win22，`192.168.1.22`，已提权）：先 `msiexec /x` 卸干净并删 MSI 缓存，再逐条跑五步 ——
`CURL-EXIT=0`（9.2s）→ `DSH-DOWNLOAD-OK` → `MSI-EXIT=0`（3.3s）→ netsh「确认。」+ `[SC] ChangeServiceConfig 成功`
→ `STATE : 4 RUNNING`；单行探针一次拿到 `SERVICE_NAME: tvnserver`、`STATE: 4 RUNNING`、`0.0.0.0:5900 LISTENING`、
`DIR-TIGHTVNC`。修复前经路由跑的是 `VNC_INSTALL_FAILED`（`steps:["DSH-DOWNLOAD-OK"]`，就是上面第 2 条截断 bug）。

**v2.5（2026-11-14，跳板机多跳链）**：

1. **`hosts.json` 加 `jump`**：`"jump": ["jump-a", "jump-b"]`（也可写逗号串，最多 **3 跳**，顺序即连接顺序）。
   每一跳都是独立主机、各自解析凭据（`password` / `passwordEnv` / `privateKeyPath`+`passphrase`），
   所以跳板和目标机可以用不同账号。跳板自身必须存在、必须是 `ssh`、不能禁用、不能成环
   （`跳板链存在循环：a → b → a`）、不能重复、不能指自己。
2. **连接池按链管理**：`resolveHostRef` 产出 `spec.jump = [hopSpec…]`（跳板 spec 的 key 统一 `jump:<alias>`）；
   `lib/ssh.js` 的 `connectViaJumps` 逐跳 `forwardOutStream` 打洞（首跳直连、后续跳 `options.sock = socket`），
   成功后 `pool.snapshot()` 的 `meta.via = ['win22']`，`pool.close(key)` 会把目标连接和所有跳板连接一起回收；
   跳板若自己掉线，整组连接跟着拆掉，避免悬挂的半开链路。
3. **面板**：新建/编辑主机表单在「备注」前有「跳板链（可选）」输入（`placeholder: jump-a,jump-b（最多 3 跳）`）；
   主机行在别名后面显示「经 a → b」；链上有问题（跳板不存在/非 ssh/禁用/缺凭据）时该行 `ready:false`
   并在 `jumpIssue` 里给出原因（面板用 warn 色）。写盘走 `host-save?…&jump=`（非 ssh 主机带 `jump` → 400）。

实测（2026-11-14，本机 → `win22` 跳板 → `linux26` 目标）：`.tmp\jump-e2e.mjs` 13/13 通过 ——
`pool.acquire` 后 `hostname; echo JUMP-E2E-OK` 回 `beiang-server` / `JUMP-E2E-OK`（4033ms），
`snapshot()` 里 `via: ["win22"]`，`close` 后 `keys().length === 0`。
门禁：`node packages\dsh-remote\test\smoke.mjs` → **67 checks passed**（新增 14 组跳板断言）；
`node test\mount.mjs` → 3 bundle / 21 工具 / remote **35 路由**。

### dsh-remote v2.6 / v2.7：面板联动 + 主机环境元信息

- **v2.6 联动**：远程主机面板头部有 `流水线` 按钮（`.remote-open-pipeline`）→ 点一下切到「流水线」面板；`@local/dsh-cicd` 没加载时内联提示「重启一次 DSH」。
- **v2.7 环境元信息**：`hosts.json` 每台可写 `env`（`prod|test|stage|dev` 或自定义）、`group`（`web`/`api`/`db`…）、`tags: [...]`；面板显示 env 徽标（prod 红 / test 黄 / stage 橙 / dev 灰 / 自定义蓝）+ `@group` + `#tag`，主机表单可直接编辑。
- **v2.7 汇总路由**：`GET /api/plugins/remote/groups`（免执行头，保留同源检查）→ `{envs:[{name,hosts}], groups:[…], tags:[…]}`，供流水线的 `env:`/`group:`/`tag:` 选择器展开；未配元信息的主机不进任何桶。
- 门禁：remote smoke **70 checks**、`mount` → remote **36 路由**；本仓库 `hosts.json` 已把 linux26/win22 标 `env: test`（group `web`/`build`）、remote113 标 `env: staging`（group `web`），`env:test` 这类选择器因此可直接用。

## dsh-cicd（本地 CI/CD，M0/M1）

`pipe.yml` → 本机构建 → 经 dsh-remote 上传到目标机 → `releases/<runId>` + `current` 软链 + `revisions.log` → 重启 + 健康检查（失败自动回滚）→ SQLite（`cicd.db`）运行记录 + 每次发布产物的 sha256。

| 工具 | 作用 |
|---|---|
| `cicd_projects` / `cicd_targets` | 列出项目与部署目标（target 的 hosts / path / restart / health / current） |
| `cicd_plan` | 打印 stage 计划（不执行） |
| `cicd_run` | 真跑一条流水线（`confirm=1`；`dryRun=1` 只出计划；`stage=<id>` 可只跑单 stage） |
| `cicd_status` / `cicd_logs` | 运行状态与日志（尾部截断） |
| `cicd_releases` / `cicd_rollback` | 发布记录与回滚（`releaseId` 省略=上一条） |

- 路由（10 条，全 GET + `resource`）：`/api/plugins/cicd/{projects,plan,run,runs,log,releases,rollback,targets,operations,notify-test}`；写操作额外要 `x-dsh-cicd: 1` 头 + `confirm=1`。
- 面板：侧栏「流水线」→ 项目切换 / 目标矩阵 / 阶段计划 / Run 详情（含日志跟随）/ Releases（按主机回滚）/ 审计时间线（v0.6）。
- 真机实测（linux26）：首次发布、内容变更发布、双向回滚、404 保护全部验过，细节与 5 个坑见 [packages/dsh-cicd/README.md](packages/dsh-cicd/README.md)。
- 存储（v0.3）：运行/步骤/产物/发布/操作全进 `~/.dsh-cicd/cicd.db`（Node 22 内置 `node:sqlite`，WAL，无需原生编译），日志仍是 `logs/<runId>.log` 文本文件；旧版 `runs.jsonl` 首次打开自动导入并改名 `.migrated`。
- 入口：左侧栏独立一行「流水线」；远程主机面板头部也有 `流水线` 按钮直接跳过去（`@local/dsh-cicd` 未加载时会内联提示重启）。
- **多主机发布（v0.4）**：一个 target 可写 `hosts: [a, b, c]`，逐台独立发布（各自 `previous`/`current`/`revisions.log`/重启/健康检查）；`onHostFailure: stop|continue`（默认 stop）决定某台失败后是否继续；`/rollback` 不带 `host` 即全主机回滚；`/releases?host=` 可单机过滤。
- **运行时预设（v0.4）**：target 可写 `runtime: static|node|python|go|php|docker` + `app`，自动生成重启命令（`pm2 restart <app>` / `systemctl restart <app>` / `php-fpm reload` / `docker compose -f <app> up -d` 等，一律带 `|| true` 兜底）；写 `restart:` 则完全覆盖预设。
- **环境选择器 + 生产护栏（v0.5）**：`hosts` 里可写 `env:test` / `group:web` / `tag:canary`，与别名混写并自动去重；部署前用 `GET /api/plugins/remote/groups` 展开，展开为空 → `PIPE_INVALID`「选择器 env:nope 没有匹配的主机」。展开后只要有 `env: prod` 的主机：`/run`、`/rollback` 必须带 `confirm=prod`，否则 **409 `PROD_CONFIRM_REQUIRED`** 并在错误体里列出受影响主机；`/plan` 会标 `willDeployToProd: true` + `prodHosts`。
- **部署锁（v0.5）**：同一 target 并发发布 → 409 `DEPLOY_IN_PROGRESS`（`finally` 释放；`dryRun` 不占锁、也不触发生产护栏）。
- 存储（v0.5）：`cicd.db` 的 releases 表新增 `env` 列（`SCHEMA_VERSION=2`，旧库 `ALTER TABLE` 自动补列），`/releases?env=` 可按环境过滤。
- **灰度分批（v0.6）**：target 可写 `canary: { first: 1, waitSec: 30 }`——先发 `first` 台，**首批任一台失败立即停止**（不受 `onHostFailure` 影响），首批全绿后等 `waitSec` 再发剩余；每台结果带 `batch: 1|2`，run 结果带 `canary.batches`，等待期写一条 `canary-hold` 审计。
- **通知 webhook（v0.6）**：插件配置 `notify.webhooks: [{ url, secret?, events? }]`，事件 `run.success|run.failed|run.canceled|rollback.success|rollback.failed`；并发 POST，配了 `secret` 就带 `x-dsh-signature: sha256=<hex>`（HMAC-SHA256）；**通知失败只记审计，绝不影响发布**；`GET /notify-test?confirm=1` 可试发（未配置返回 `configured: 0`）。
- **审计时间线（v0.6）**：`operations` 表（schema v3，`ALTER TABLE` 补列 + 回填旧 `kind`）记录 `deploy` / `deploy-failed` / `rollback` / `canary-hold` / `notify`，`GET /operations?project=&runId=&limit=` 按时间倒序，面板有对应表格视图。
- 边界：同层串行、无远端 runner、无定时触发；**数据库变更不可回滚**，回滚只管站点文件。

## dsh-aihot（AI 资讯 / 福利）

工具（返回 AIHOT 整理好的中文 Markdown，给模型省 token）：

| 工具 | 作用 |
|---|---|
| `aihot_latest` | 今天 / 最近一周的精选（`window`、`category`、`mode`、`limit`） |
| `aihot_search` | 关键词检索（最近 7 天 / 24h） |
| `aihot_hot` | 当前最热事件 |
| `aihot_daily` / `aihot_weekly` / `aihot_monthly` | 日报 / 周报 / 月报（可指定日期 / 周 / 月） |
| `aihot_resets` | 额度重置监控（codex / antigravity / claude / grok-bot） |
| `aihot_story` | 某个热点的来龙去脉 |

页面：左侧栏「AI 资讯」全局面板，九个 tab —— 精选（分类过滤 + 刷新）/ 热点 / 日报（内置「日报 / 周报 / 月报」期刊分段与期号选择）/ 福利（四家额度重置状态）/ 收藏（v1.7 新增，纯前端）/ 排行榜 / 羊毛 / 重置日历 / 接入（后四个 v2.0）。
数据由 Host 代理 JSON 端点（`/api/plugins/aihot/{items,hot,daily,period,resets,story,article,search,leaderboard,free-tokens,reset-calendar,agent-access}`），避免浏览器跨域；标题外链到 aihot.news 阅读页。
每张卡片右侧的「来龙去脉」按钮会就地展开事件时间线抽屉（portal 到 body，Esc/×/遮罩关闭），抽屉里可「复制链接」。
旁边的「读正文」（v1.5）点开即抓：Host 侧取 `https://aihot.news/items/<id>` 的服务端 HTML，去噪后取正文段落
（≤64KB，超了标记 truncated），返回 `{title,url,source,publishedAt,chars,truncated,paragraphs,fallback}`，
面板用同一个抽屉外壳逐段渲染。**点击才抓、不预取**，抓不到就退回原文链接。
实测某条 Latent Space 的帖子：140 段 / 18072 字、fallback=false。

v1.6 再给卡片加了**收藏**与**已读**（纯前端，不新增路由、不发请求）：卡片标题行有星标
（`.aihot-save-link`，☆ 收藏 / ★ 已收藏），精选过滤条多一个「已收藏（N）」chip，可和分类过滤叠加、
没收藏时置灰；点开「读正文」或「来龙去脉」即记已读，已读卡片标题降到次级文字色并带左侧 2px 竖线。
状态存在浏览器两把 key（`dsh.aihot.saved.v1` / `dsh.aihot.read.v1`），各限 500 条、
坏 JSON 回空并覆盖写、隐私模式写失败静默降级（不报错、只是不落盘）。
真机验过：点星标 → 「已收藏（1）」变亮 → 开过滤只剩该条 → 读正文后卡片带 `is-read` → 刷新页面收藏与已读都还在。

v1.7 把收藏做成**独立 tab**：顶栏第五个 tab 文案随收藏数变成「收藏（N）」（N 为 0 时只写「收藏」），
切过去直接由本地状态渲染卡片、**一个请求都不发**，卡片上的星标换成「取消收藏」（`.aihot-unsave-link`，
副标题写明「只影响本机浏览器」），空态是「还没有收藏。在精选/热点里点 ☆ 收藏条目。」。
真机验过：收藏 1 条 → tab 变「收藏（1）」→ 取消 → 立刻空态且 tab 回落成「收藏」→ 回精选再收藏一条 →
tab 马上又是「收藏（1）」，计数跟着本地状态实时走。

v1.8 给收藏 tab 加**导出 / 清空 / 跨标签同步**（仍是纯前端，不新增路由）：
收藏 tab 顶部多一行工具条「N 条收藏 · 只存在本机」+「导出」（`.aihot-export-link`，下载
`aihot-saved-YYYYMMDD-HHmm.json`，载荷 `{version,exportedAt,items[]}`，每条只带 6 个字段、按收藏时间倒序）
+「清空收藏」（`.aihot-clear-link`，第一次点只进入待确认态、按钮变「确认清空（N）」并染错误色，
3 秒不复位就自动撤回，第二次点才真清；**已读记录不动**）。同浏览器多个标签页之间靠 `storage` 事件同步
收藏与已读，卡片变暗/星标/tab 条数立刻跟着变。

**v2.0（2026-11-13）** 对齐 AIHOT 站点能力：

- **顶栏固定**：`.aihot-topbar` 用 `position: sticky; top: 0; z-index: 3`（背景 + 下边 0.5px 分隔线），
  tab 行 `flex-wrap: wrap`（九个 tab 在 1280 宽下换成两行，不横向藏起「接入」）——长列表滚到底部时
  tab / 过滤条 / 工具条始终可见（这是用户提的第一个真 bug）。
- **全局搜索**：顶栏搜索框（300ms 去抖、Esc 清空、`aria-label="搜索资讯"`）→ `GET /api/plugins/aihot/search?q=`
  → 上游 `/api/v1/items?q=`（`q` 必须 2–200 字，否则 400「q 需要 2-200 个字符」）。结果复用同一张卡片
  （星标 / 已读 / 读正文 / 来龙去脉都在），顶部有「N 条结果 · 搜索「xxx」」+ 清除。
- **四个新 tab**（都抓站点 SSR 页面，Host 抽成结构化 JSON，5 分钟缓存、≤64KB、只 GET）：
  - **排行榜** `/leaderboard` → 50 行综合榜（名次/模型/机构/发布时间/评测数/覆盖率/三种价格/评分）+ 9 个「暂不排名」；
  - **羊毛** `/free-tokens` → 「每天都能领」「每月都能领」「其他福利」三分区（15 / 11 / 31 张卡，卡里有额度、有效期、原文链接）；
  - **重置日历** `/reset-calendar` → 最近一次发卡日期 + 当月日历（每天带服务名与「已生效/预计」标签）；
  - **接入** `/agent-access` → Skill / MCP / RSS / REST 四种方式（各带一句接入说明与「复制」）+ 版本号。
- **主题切换**：浅色 / 深色 / 跟随系统（`localStorage['aihot-theme']` + `[data-aihot-theme]`），
  只覆盖本面板的 `--dsw-alias-*` 变量，不动全局 shell；深色下卡片、抽屉、固定顶栏的对比都调过。

线上实测（55378）：`search?q=OpenAI` → 200（38 条）、`q=a` 与缺 `q` → 400；`leaderboard` → 50 行 / 9 待排（首行 Claude Fable 5.2，80.4 分）；
`free-tokens` → 3 分区 15/11/31 张；`reset-calendar` → 「11月13日（按预计时间）」+ 5 个日期；`agent-access` → `skill,mcp,rss,api` + 版本 2.0.0。

数据匿名只读、不需要 Key；内容来自第三方信源，只作资料，重要事实回原文核对。
商用或对外分发须先取得 AIHOT 书面授权（`https://aihot.news/terms`）。

## dsh-sidebar-layout（侧栏布局，纯客户端）

左侧栏被 shell 塞进同一个滚动视口的两块内容——「全局面板导航」（`nav.panelList`，就是你那些
SSH / AI 资讯 / 远程主机 行）与「工作区会话」（`sidebar.workspaces` 槽位）——所以原来是一起滚的，
会话一多就把导航挤出去。这个包只改视口行为，不动 shell 源码：

- 侧栏视口（`[data-sidebar-scrollport]`，只在展开态存在）改成 flex 列、自身 `overflow: hidden`；
  导航区自己滚（`max-height: calc(100% - 232px)`，保证工作区至少还能露 232px），工作区列表自己滚。
- 导航区绑一个 `wheel` 监听并 `stopPropagation`，避免 shell 的滚动接力（`scroll-handoff.ts`）把
  滚导航的滚轮转给工作区。
- 工作区小标题行（`[class*="sectionHeader"]`）右端注入一个 24×24 折叠按钮（`.dswl-ws-toggle`，
  aria-label「折叠工作区会话 / 展开工作区会话」）：折叠时给 `<html>` 打 `data-dswl-collapsed="1"`、
  隐藏工作区列表、导航区占满，状态记 `localStorage['dsh-sidebar-layout.workspace-collapsed']`。
- 只在侧栏**展开态**生效（rail 态没有 scrollport）；shell 重渲染把按钮冲掉时由 `MutationObserver`
  补回去；整块可被 `ctx.effect` 干净卸载（撤样式、删按钮、断开监听）。
- 不写死 CSS Module 哈希前缀，只用 `[class*="…"]` 子串选择器（运行时类名是 `wtg9ga_scrollArea` 这种）。

## 本机踩过的坑（写下来免得重踩）

1. **`dsh-host-webserver` 只服务 GET/HEAD**：`POST` 在 carrier 层就回 405 `Allow: GET, HEAD`，
   请求根本到不了路由代码，`handler` 形态也救不了。写操作只能走 **GET + 查询参数 + 自定义头**
   （`x-dsh-remote-exec: 1`，跨站 `<img>`/表单带不上，天然挡 CSRF）；要真 POST 就走 typert `@Remote`。
2. **改 `index.js` 后刷新页面无效**，`plugin_manager set_plugin` 关闭再打开会真正重载模块（实测）。
3. `pnpm` 在 profile 里跑 install 会重解析依赖（本机每次 `Packages: +1 -22`，且 `cpu-features` 原生编译失败，
   不影响纯 JS 的 ssh2 路径）；`install_bundle` 后仍要确认 `warnings` 为空。
4. app.asar 里的模板文件只能用 `read` 工具读，shell 的 cat/cp 读不了。
5. **工具输出 schema 只认单值 `type`**：`type: ['string','null']` 会被宿主判成
   `JsonSchemaError: unsupported JSON schema: … type must be a single type string`（整包激活失败），
   而 `type: 'string'` 又会在运行时校验返回值——`null` 会报 `value.signal must be a string`，
   工具直接变成不可用（`remote_exec` 就这么坏过一次）。可空字段一律**返回空串/0 而不是 null**。

## 新增一个插件

1. `packages/<name>/` 按 `docs/SPEC.md` 放 `package.json`、`cordis.patch.yml`、`index.js`、`client.js`、
   `lib/`、`locale/{en,zh}.json`、`icon.svg`、`README.md`、`test/smoke.mjs`。
2. 工具名加前缀；HTTP 路由各占一段前缀；两个入口（`sidebar.panellist` + `main` key 相同）才能进左侧栏。
3. `node test/mount.mjs` 必须全绿，再让 Lead 装。

## 历史遗留（不要动）

- `server.js`：早期 MCP 版 SSH/SFTP/隧道服务器，已作为 `dsh-ssh-tunnel` 行注册在 profile，
  `dsh-remote` 是它的原生重写。
- `mobaxterm-mcp`：MobaXterm 会话/SSH/SFTP/PTY/日志 MCP（21 个工具），与本包并行存在。
- 根目录其余 `*.mjs`：别的任务的临时脚本，与本包无关。