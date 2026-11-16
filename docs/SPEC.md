# dsh-plugin-pack · 插件包规格（v1）

本仓库是 **DSH 插件包**（不是 MCP 服务器包）：每个子目录 = 一个可 `plugin_manager install_bundle`
安装的 DSH bundle（Host 插件 + 可选 Client 页面）。

两个方向（v1）：

| 包目录 | 包名 | 方向 | 交付 |
|---|---|---|---|
| `packages/dsh-remote` | `@local/dsh-remote` | 远程控制（SSH/SFTP/隧道/PTY，文本优先） | 12 个 Host 工具 + `远程主机` 视图 |
| `packages/dsh-aihot` | `@local/dsh-aihot` | AI 资讯平台（AIHOT 接入） | 8 个 Host 工具 + `AI 资讯` 视图 |

历史遗留：根目录 `server.js` 是旧 MCP 服务器（已注册为 `dsh-ssh-tunnel`），**不要动**。
根目录一堆 `*.mjs` 是别的任务的残留脚本，**不要动、不要引用**。

---

## 1. 目录布局（每个 bundle 一致）

```
packages/<pkg>/
  package.json          # name / type:module / exports / files / dsh.bundle.patch / dsh.client
  cordis.patch.yml      # - insert: - id: <row-id>  name: '@local/<pkg>'
  index.js              # Host 半边：export function apply(ctx, config) {}
  client.js             # Client 半边：window.__ModuleLoader__.load({...})
  lib/*.js              # 纯逻辑（可被 node 直接 import 做单元测试）
  locale/en.json        # { "meta": { "title": ..., "description": ... } }
  locale/zh.json        # 同上中文
  icon.svg              # 原创图标，<= 256 KiB
  README.md             # 这个包干什么、怎么配、怎么验证
test/                   # 包级冒烟脚本（node 直接跑，不依赖 Host）
```

`package.json` 骨架（照 `references/host-plugin.md`）：

```json
{
  "name": "@local/dsh-remote",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": ["index.js", "client.js", "lib/*.js", "cordis.patch.yml", "locale/*.json", "icon.svg"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-ui-conversation"] }
  }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-remote
      name: '@local/dsh-remote'
```

**不要**自己写 profile 的 `cordis.patch.yml` / `package.json`，**不要**跑 pnpm install：
由 Lead 用 `plugin_manager install_bundle`（绝对路径 = 包目录）统一安装。

---

## 2. Host 半边：工具注册（已核对当前运行时契约）

```js
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const dispose = ctx.tools.register({
    name: 'remote_exec',                     // 全局唯一；禁止用保留名 run_code
    description: '一句话说清能力与边界（中文，给模型看）',
    parameters: {                            // JSON Schema（手写即可，不要 zod 转换）
      type: 'object',
      properties: { host: { type: 'string', description: '主机别名' } },
      required: ['host'],
      additionalProperties: false,
    },
    output: {                                // 必填
      schema: { type: 'object', properties: { /* 返回值形状 */ } },
      render(args, value) {                  // 返回 ContentBlock[]，模型看到的就是它
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args, exec) {
      // 抛错 = 工具失败；exec.signal 可监听取消
      return result                              // 返回 JSON 值（JsonValue）
    },
  })
  ctx.effect(() => dispose)                  // 注册即 effect，卸载自动注销
}
```

要点：

- `parameters` 用裸 JSON Schema（`JsonSchemaNode`），`type: 'object' | 'array' | 'string' | …`。
- `output.schema` 必填（`ToolOutputDefinition`），`render()` 返回 `ContentBlock[]`（文本用
  `{ type: 'text', text }`）。**长输出自己截断**（远程命令 stdout ≤ 64KB 等），不要指望框架截。
- 工具名加前缀：`remote_*` / `aihot_*`，避免和已装插件（`ssh_*`、`mcp__*`）撞名。
- 错误用 `throw new Error('中文可读原因')`，不要返回 `{ error: ... }` 假装成功。
- **不要** `export const Config`（本包不引入 schemastery）。`apply(ctx, config)` 的 `config`
  就是 patch 里写的原始对象，自己填默认值并在 README 里写清字段。
- 长连接资源（SSH 连接池 / 隧道 / PTY）用模块级 Map 保存，并 `ctx.effect` 里在卸载时全部关闭。

## 3. Host 半边：给 Client 用的 HTTP 路由（已核对契约）

```js
const web = ctx.get('webServer')             // 可选依赖，profile 里没有就不注册
const route = web?.register({
  kind: 'exact',                             // 'exact' | 'prefix'
  path: '/api/plugins/remote/hosts',         // 路径前缀已分配，不要抢别人的
  resource: async (request) => {             // WebResource: (Request) => Promise<Response>
    const url = new URL(request.url)
    return Response.json({ ok: true, hosts })          // Node 22 原生 Response
  },
})
if (route) ctx.effect(() => route)
```

**`resource` 只能答 GET/HEAD，`handler` 也一样**：`dsh-host-webserver` 在 HTTP 层对非 GET/HEAD
统一回 405 `Allow: GET, HEAD`，请求根本到不了路由代码（2026-11 实测：`POST` 拿到 carrier 的
405 + `allow: GET, HEAD`，`GET` 才进 handler）。所以：

- 所有路由都用 `resource`（`(Request) => Promise<Response>`），`kind: 'exact'`。
- 写操作（执行命令、关隧道）走 **GET + 查询参数**，并要求一个自定义请求头，例如
  `x-dsh-remote-exec: 1`：跨站 `<img>`/表单发起的 GET 带不上自定义头，会被 403 挡掉；
  同源 `fetch` 带自定义头不触发预检。
- 额外校验 `Origin`（存在时必须同源）与参数（未知参数 400、缺参 400、超大 413、不存在 404）。
- 需要真正的 RPC 形态（POST/流）时用 typert `@Remote` 服务 + `ctx.remote.*`，本包 v1 不做。

- 只用 `resource` 形态（Request/Response），不要写 `handler(req, res)` 的 Node 原生流。
- 路由前缀（已分配，勿越界）：
  - `dsh-remote` → `/api/plugins/remote/*`
  - `dsh-aihot` → `/api/plugins/aihot/*`
- 只接受本地同源请求；参数一律走查询串（不要设计读 body 的接口——POST 进不来），未知参数给 400。

当前已注册路由（v1.3–v2.0，2026-11-13）：

| 包 | 路由 | 说明 |
|---|---|---|
| dsh-remote | `GET /hosts` | 列主机（免自定义头，脱敏） |
| dsh-remote | `GET /exec?host=&command=&timeoutSec=` | 执行命令，需 `x-dsh-remote-exec: 1` |
| dsh-remote | `GET /tunnels[?action=close&tunnelId=]` | 列 / 关隧道，需头 |
| dsh-remote | `GET /tunnel-open?host=&remoteHost=&remotePort=&localPort=` | 新建本地端口转发，需头 |
| dsh-remote | `GET /files?host=&path=` | 列目录（`entries[{name,type,size,mtime}]`），需头 |
| dsh-remote | `GET /file?host=&path=&maxBytes=` | 文本预览（≤64KB，二进制标 `binary:true`），需头 |
| dsh-remote | `GET /host-save?alias=&host=&port=&user=&auth=&secret=&privateKeyPath=&note=&disabled=` | upsert 主机（写 hosts 文件，config 来源 409），需头 |
| dsh-remote | `GET /host-delete?alias=` | 删除主机（config 来源 409、不存在 404、删空带 `warning`），需头 |
| dsh-remote | `GET /shell-open?host=&cols=&rows=` | 打开面板 PTY 会话（≤8 个，409），需头 |
| dsh-remote | `GET /shell-attach?sessionId=&cols=&rows=` | 刷新后接回活着的 PTY：`{session, backlog(base64 ≤512KB), backlogBytes, truncated}`，并清空未读缓冲，需头；未知/回收 404 |
| dsh-remote | `GET /shell-send?sessionId=&data=&cols=&rows=&bracketed=` | base64 写入 + 约 160ms 回采；`bracketed=1` 用 `\x1b[200~…\x1b[201~` 包裹（剔除正文越界序列），需头 |
| dsh-remote | `GET /shell-read?sessionId=` | 只回增量输出（base64，无新输出 `seq` 不变），需头 |
| dsh-remote | `GET /shell-resize?sessionId=&cols=&rows=` | 调整 PTY 尺寸（20–500 / 5–200，未知会话 404），需头 |
| dsh-remote | `GET /shell-log?sessionId=&maxBytes=` | 完整日志（base64；服务端留 4MB，`maxBytes` 缺省 4MB、上限 8MB，越界 400），需头；未知 404 |
| dsh-remote | `GET /shell-close?sessionId=` | 关闭会话（不存在/已关 404），需头 |
| dsh-remote | `GET /file-download?host=&path=&maxBytes=` | 下载远端文件（base64，缺省 8MB、上限 16MB；目录 400、缺失 404），需头 |
| dsh-remote | `GET /file-upload-begin?host=&path=&size=&mode=` | 开分块上传会话（size ≤64MB，mode overwrite/append/create，chunkBytes 8192；≤4 会话，超 409），需头 |
| dsh-remote | `GET /file-upload-chunk?uploadId=&offset=&data=` | base64 块 ≤8192B；offset 必须连续（否则 409），单块超限 413，未知会话 404，需头 |
| dsh-remote | `GET /file-upload-finish?uploadId=&sha256=` | 校验大小/可选 sha256，`.part` → rename，返回 `{host,path,bytes}`，需头 |
| dsh-remote | `GET /file-upload-abort?uploadId=` | 中止并清理 `.part`，需头；未知会话 404 |
| dsh-remote | `GET /file-write?host=&path=&data=&mode=` | 写文件（base64 ≤256KB，mode overwrite/append/create；create 已存在 409），需头 |
| dsh-remote | `GET /file-mkdir?host=&path=` | 新建目录（已存在 409），需头 |
| dsh-remote | `GET /file-rename?host=&from=&to=` | 重命名（源缺失 404、目标存在 409），需头 |
| dsh-remote | `GET /file-delete?host=&path=&recursive=` | 删除文件/目录（目录需 `recursive=1`，否则 409），需头 |
| dsh-remote | `GET /file-chmod?host=&path=&mode=` | 改权限（八进制 3–4 位，否则 400；远端拒绝 403），需头 |
| dsh-remote | `GET /file-chown?host=&path=&uid=&gid=` | 改所有者（非负整数，否则 400；非 root 通常 403），需头 |
| dsh-remote | `GET /file-search?host=&dir=&q=&limit=` | 名称搜索（广度优先，limit 1–200 缺省 50），需头 |
| dsh-remote | `GET /protocols` | 协议能力矩阵（ssh/telnet/rdp/vnc，免自定义头） |
| dsh-remote | `GET /gui-open?host=&protocol=` | 在本机拉起 RDP/VNC 客户端（仅 rdp/vnc；缺客户端 400），需头 |
| dsh-aihot | `GET /items?window=&category=&mode=&limit=` | 精选条目 |
| dsh-aihot | `GET /hot` | 热点榜 |
| dsh-aihot | `GET /daily` | 最新日报 |
| dsh-aihot | `GET /resets?service=&scope=` | 额度重置监控 |
| dsh-aihot | `GET /story?id=|item=&limit=` | 事件来龙去脉（`item` 走条目页 HTML 兜底解析） |
| dsh-aihot | `GET /period?kind=weekly\|monthly&issue=&limit=` | 周报 / 月报：无 `issue` 出期号索引，有 `issue` 出单期正文 |
| dsh-aihot | `GET /article?id=` | 条目正文预览：抓条目页 HTML 抽 `{title,source,publishedAt,chars,truncated,paragraphs[]}`（≤64KB，5 分钟缓存） |
| dsh-aihot | `GET /search?q=&window=&category=&limit=` | 全局搜索（`q` 2–200 字，否则 400），上游 `/api/v1/items?q=`（v2.0） |
| dsh-aihot | `GET /leaderboard` | 模型排行榜：抓 `/leaderboard` 页 HTML，出 `{rows[50], other[9], total, pendingTotal}`（v2.0） |
| dsh-aihot | `GET /free-tokens` | 羊毛：抓 `/free-tokens`，出三个分区「每天都能领 / 每月都能领 / 其他福利」（v2.0） |
| dsh-aihot | `GET /reset-calendar` | 重置日历：抓 `/resets`，出 `{lastCard, month, monthLabel, days[]}`（v2.0） |
| dsh-aihot | `GET /agent-access` | 接入方式：抓 `/agent`，出 `{version, modes[skill|mcp|rss|api], resources}`（v2.0） |

抓站点页的四条路由（`leaderboard` / `free-tokens` / `reset-calendar` / `agent-access`）与 `/article`
共用同一条链路：Host 端 `fetch` 页面 HTML（8s 超时）→ 纯函数解析 → ≤64KB → 5 分钟进程内缓存；
上游非 200 原样透出，网络失败/超时 → 502 `抓取 XX 失败：…`。**只 GET、只读、不带自定义头**。

写盘约定（`host-save` / `host-delete`）：只写插件自己的 `hosts.json`，原子写（`.tmp-<pid>` + rename、
尽量 0600、清理残留）、保留未知字段与顶层形状（`{hosts:{}}` 或裸 map 均可）；
主机来自 `config.hosts` 或 `DSH_REMOTE_HOSTS` 文件时一律 409，不碰补丁文件与共享文件；
写前 drop 该主机的连接池条目。面板侧对应「＋ 新建 / 编辑 / 删除（3 秒二次确认）」，config 来源时按钮置灰。

## 4. Client 半边：页面（view）

v1 用**已验证可用**的 `conversation.view` 槽（会话顶部 View 切换里的一个整页视图），
照 `templates/decoration/client.js` 的形状写：

```js
window.__ModuleLoader__.load({
  id: '@local/dsh-aihot',
  factory(require) {
    const React = require('react'); const h = React.createElement
    function Page() { /* 自己 fetch('/api/plugins/aihot/...')，用 useState/useEffect */ }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => ctx.slots.inject('conversation.view', () =>
          ctx.slots.register(
            { name: 'conversation.view', id: 'aihot', order: 40, label: () => 'AI 资讯' },
            Page,
          )))
      },
    }
  },
})
```

> **v2 起入口变了（2026-11-14）**：页面只在 `sidebar.panellist` 注册一行、并把本体注册到 layout 的 keyed `main` 槽
> （`key: 'aihot'`），**不再注册 `conversation.view`**。原因是 shell 会把「当前 View」按会话持久化到
> `localStorage['dsh.conversation.<sessionId>'].view`：曾点进 AI 资讯的会话以后每次打开都直接回到资讯页、
> 看不到对话内容（用户报的「只有某个会话会这样」）。全局面板覆盖同一入口，且点侧栏会话时 shell 必定
> `selectPanel(null)`；旧会话残留的 `view: 'aihot'` 由 shell 的 `resolveActiveView` 回落到 `chat`，无需迁移。
> 同理，页面顶栏**不再用 `position: sticky`**：`.aihot-page` 自身不滚动，顶栏是它 `flex:0 0 auto` 的固定行，
> 正文包在 `.aihot-body`（`flex:1 1 auto; min-height:0; overflow-y:auto`）里，从而不依赖滚动祖先是谁。

硬约束（来自 `references/practices.md` / `ui-plugin.md`）：

- 只用 `require('react')`，**不要** require 任何 `@deepseek-ai/dsh-client-ui-*` 包。
- 不要 iframe、不要写别的插件 DOM、不要替换根节点。**浮层抽屉是唯一例外**：宿主 composer 会裁剪
  `position: fixed`，所以抽屉外壳必须 `createPortal(node, document.body)`，并且只挂自己的节点、
  卸载时随 React 一起移除（v1.3 起这样实现，真机验过）。
- 颜色只用主题 token `var(--dsw-alias-*)`（`cordis_inspect_query` Theme 可查），
  除插画/图标外不许写死颜色；间距/字号/圆角照搬宿主页面的密度。
- 组件里 `useEffect` 里 fetch，返回 cleanup；不要轮询快于 30s。
- 文案：宿主 UI 里显示的中文可以直接内联（v1 例外，README 注明）；`locale/*.json`
  的 `meta.title` / `meta.description` 必须写（en + zh），供插件面板显示。
- 所有外链 `target="_blank" rel="noreferrer"`。

已实现的页面形态（v1.3–v1.8.1，Host 单测覆盖，新插件照着做）：

- **面板分段**（`dsh-remote` 执行列）：「命令 | 终端」两个 `aria-pressed` 按钮切分支；终端挂载即
  `shell-open`，800ms 轮询 `shell-read` 追加输出，`pre`（`tabIndex=0`、`aria-label`）上 `onKeyDown`
  直接映射字节（单字符、`Enter→\r`、`Ctrl-C→\x03`、方向键→`\x1b[A…`）；v1.8 起卸载只断开本地
  （PTY 留活），重挂载先 `shell-attach` 回放 backlog，404 才 `shell-open`，显式「断开」才 `shell-close`；
  输出只渲染最近 2000 行，超出提示下载，工具条「下载日志」用 `shell-log` 存 `remote-<host>-YYYYMMDD-HHmmss.log`；
  v1.7 工具条另加「清屏」（清本地回显 + 发 `\x0c`）、「复制输出」（剥 ANSI 的回显进剪贴板，失败回退
  textarea+`execCommand`）、「历史」下拉（内存里最多 20 条去重命令，点击整行重发）；`↑/↓` 仅当本地
  历史非空时由本地环接管（清行后回填），否则原样透传 `\x1b[A` / `\x1b[B`。
- **浮层抽屉**（两个包）：`createPortal` 到 body，`role="dialog"`，Esc / × / 遮罩三路关闭，
  加载 / 空 / 错误三态，同参数 5 分钟缓存，点击才抓不预取。
- **多列面板的列宽预算**（`dsh-remote`，v1.6 返工）：行容器 `display:flex` 时**不要**给所有列
  `flex: 1 1 auto; minWidth: 0`——1280 窗口下文件列会把执行列压到 ~170px，PTY 夹到 `20×33`。
  做法：固定宽度列写 `flex: '0 0 <px>'`，交互列写 `flex: '1 1 auto'; minWidth: '<下限>px'`，
  次要列（本包把「本地隧道」+「文件」）上下叠进同一个 `flex: '0 0 320px'` 的列里；
  外层 `overflow: auto` 兜底，宁可横向滚动也不压扁交互区。
- **期刊分段 + 期号 chips**（`dsh-aihot` 日报 tab）：`日报 / 周报 / 月报` 切换 → 无 `issue` 先取索引，
  有 `issue` 取单期正文；期号按索引顺序渲染 chips，`aria-pressed` 标当前期。
- **sticky 顶栏 + 搜索 + 主题**（`dsh-aihot`，v2.0）：顶栏容器 `position: sticky; top: 0; z-index: 3` +
  背景 `var(--dsw-alias-bg-base)` + 下边 `.5px` 分隔线，用负 margin 抵消面板 padding；tab 行 `flex-wrap: wrap`
  （**不要** `overflow-x: auto` + `nowrap`，否则窄窗口会把靠后的 tab 藏起来），过滤条与工具条一起放进顶栏。
  搜索框 300ms 去抖、词长 < 2 不请求（与上游 `q` 的 2–200 限制对齐）、Esc 与「清除」按钮同一套 reset。
  主题用 `data-aihot-theme="light|dark"` 只覆盖本面板内的 `--dsw-alias-*` 变量，选择存 `localStorage['aihot-theme']`，
  `system` 走 `matchMedia('(prefers-color-scheme: dark)')` 并监听变化，不改全局 shell。
- **收藏 / 已读**（`dsh-aihot`，v1.6）：纯 Client 状态，只存 `window.localStorage`（`dsh.aihot.saved.v1` /
  `dsh.aihot.read.v1`，各限 500 条、按 `at` 倒序、读写全包 try-catch，隐私模式降级成内存态），
  **不上 Host、不新增路由、不发请求**。卡片星标 `.aihot-save-link` toggle，已收藏过滤 chip
  `.aihot-saved-filter`，打开正文 / 来龙去脉即记已读（标题降为次级色 + 左侧 2px 主题 token 竖线）。
  v1.7 起收藏有独立 tab（文案带条数、卡片按钮 `.aihot-unsave-link`），数据仍只来自 localStorage。
- **WebSocket 升级 + 内嵌画面**（`dsh-remote`，v2.2）：`dsh-host-webserver` 的 `registerUpgrade({path, handler(req, socket, head)})`
  允许插件在 DSH 同一端口上接管 upgrade（carrier 的「只放 GET/HEAD」不适用于 upgrade）。要求：
  (a) token 走 query 且**单次**、短 TTL，不能长期裸奔；(b) 握手回包必须用规范 GUID
  `258EAFA5-E914-47DA-95CA-C5AB0DC85B11`（少一位时 Node 客户端能过、Chrome 报 1006 —— 自测要覆盖浏览器）；
  (c) 第三方渲染库的 target 元素类型按其契约给（noVNC 的 `RFB` 会往 target 里 append `<div>`，所以给容器而非 `<canvas>`）；
  (d) 被托管的远端进程要用 `setsid -f sh -c 'exec … </dev/null'` 起，`nohup … &` 会随 exec 通道一起被杀。
- **内嵌桌面的体验闭环**（`dsh-remote`，v2.3）：画面能连上只是第一步，交互要闭环。要求：
  (a) 剪贴板双向——远端 `clipboard` 事件渲染成只读条 + 「复制到本机」，本机侧输入框走 `clipboardPasteFrom`，
  画布内 Ctrl/Cmd+V 直通；(b) 切模式不重建连接——面板常挂、用 `display:none` 保活，别在切 tab 时 dispose RFB；
  (c) 自动重连只针对**意外**断线，重试次数与间隔固定（`[1000, 2000, 4000]`），用尽后停手并给显式「重新连接」按钮，
  绝不能无限重试；(d) 全屏用 `requestFullscreen` 作用在舞台容器上，不要按窗口比例改 canvas 内部分辨率。
  (e) 常挂面板要作为执行列 section 的子项（`flex: 1 1 auto`），不要写成 section 的兄弟——否则 1280 宽会多出一列并横向溢出。
- **缺什么由插件代装**（`dsh-remote`，v2.4）：内嵌画面需要目标机跑 VNC 服务，用户不该为它下载安装包或手抄命令。要求：
  (a) 写操作的 resource 必须带显式 `confirm=1`（它会改动目标机），缺参直接 400；(b) 安装步骤要**一次一条命令**下发——
  目标机 exec 只执行命令串第一行、`if (…) else (…)` 之后的 `&` 会被吞掉，所以 Windows 的五步（下载 / 校验 / msiexec /
  防火墙 / 服务）要拆开逐条跑，探针压成单行；(c) 无认证的 VNC 装完立刻加只放行回环的入站阻断规则（`netsh advfirewall`
  block TCP 5900），画面靠插件自己的 SSH 隧道送到浏览器；(d) 失败要回传每条命令的退出码（`steps`）与安装引导（`install`），
  不能只说「失败」；(e) 输出 schema 里的可空字段一律给 `''`/`0`/`-1`，JSON Schema 不接受 `type` 数组（`signal`、cluster
  `error`/`exitCode`、`configError` 都踩过）。
- **跳板链（`dsh-remote`，v2.5）**：目标机只能经中间机访问时，不能让用户自己在主机上敲 `ssh -J`。要求：
  (a) host 条目用 `jump: [...]` 声明跳板**别名**（不是地址），最多 3 跳、顺序即连接顺序，也接受逗号串；
  (b) 解析期就要拦住坏链——跳板不存在 / 非法别名 / 指自己 / 重复 / 超过上限 / 成环 / 跳板不是 ssh /
  跳板被禁用 / 跳板缺凭据，每一种都给能定位到具体别名的中文错误；(c) 每一跳独立解析凭据（跳板与目标机可以
  用不同账号与不同认证方式），跳板 spec 的 `pool` key 用 `jump:<alias>` 前缀避免与目标 key 撞车；
  (d) 连接池按**链**成组管理：目标连接与所有跳板连接一起建立、一起回收，跳板掉线要带走整条链，
  不能留半开的悬挂连接；(e) 连接的 `meta.via` 记录实际经过的跳板别名（无跳板时是空数组），
  主机列表要把 `jump` 与 `jumpIssue` 一并告诉面板，链上有问题时该主机 `ready: false`；
  (f) 写盘接口（`host-save`）要能保存/清除这个字段，非 ssh 主机带跳板要 400。
- **组合包（只有 patch、无自有入口）**：`test/mount.mjs` 要认这种包——只校验 `cordis.patch.yml` 有 `insert:`、插入的是
  真实 `@scope/name`，不尝试挂载；有入口的包才跑工具/路由契约。
- **行内「⋯」入口 + 引导卡片**（`dsh-remote`，v2.1）：只靠 `onContextMenu` 的功能在 headless/触屏上不可达，
  所以行结构改成 `div`（`display:flex`）= 主按钮 `flex:1 1 auto; minWidth:0` + 行尾 20×20 的 `.remote-files-more`
  （`aria-label="更多操作：<name>"`，`getBoundingClientRect()` 定位同一份菜单）。**禁止 `<button>` 套 `<button>`**。
  宿主侧能力缺失时（本包 `GUI_CLIENT_MISSING`）400 响应体除 `error` 还带机器可读的 `install` 对象，
  面板渲染 `.remote-gui-install` 卡片（命令列表每条一个「复制」、下载页链接、「重新检测」再调一次），
  客户端只渲染不判断平台——平台差异（winget/choco/apt/brew/dnf）留在 `lib/protocols/gui.js`。
  v1.8 起收藏页顶部有 `.aihot-export-link`「导出」（Blob + `<a download>` 存
  `aihot-saved-<YYYYMMDD-HHmm>.json`，`{version:1, exportedAt, items}`，不开后端路由）与
  `.aihot-clear-link`「清空收藏」（3 秒内二次点击才真清、不动已读），并订阅 `window` 的 `storage`
  事件做跨标签同步（只回读 `dsh.aihot.saved.v1` / `dsh.aihot.read.v1`）。

- **纯客户端包 / 改造 shell 外壳**（`dsh-sidebar-layout`，第三个 bundle）：不需要工具与路由时，
  `index.js` 里 `export const inject = []`、`apply(ctx)` 可以为空（只为让 `cordis.patch.yml` 的
  insert 有落点、让 `test/mount.mjs` 能挂载）；`package.json` 的 `dsh.client` 写
  `{ platform: 'web', immediately: true, inject: [] }`。改 shell 的 DOM/样式有两条硬规矩：
  (1) 运行时类名是 CSS Module 的 `<hash>_<localName>`（例如 `wtg9ga_scrollArea`），
  **只用 `[class*="localName"]` 子串选择器**，绝不写死哈希前缀；(2) 注入的东西必须可回滚——
  `ctx.effect(() => install())` 返回的 disposer 要撤样式、删节点、移除挂在 `<html>` 上的标记、
  断开 `MutationObserver` 与事件监听。侧栏的稳定钩子：`[data-sidebar-scrollport]`（仅展开态存在）、
  `nav.panelList`、`[class*="regionArea"]`、`[class*="sectionHeader"]`、`[class*="listArea"]`；
  侧栏视口件（`scroll-handoff.ts`）绑了 `wheel` 并在 `preventDefault` 后把滚动量转给内容区，
  所以想让某个子区域独立滚动，要在它上面 `stopPropagation`。测试闸门对
  「注册了工具却漏 `inject=['tools']`」的包报错，0 工具的包不要求。

- **输出 schema 的可空字段**：宿主只接受单值 `type`（`type: ['string','null']` 会让整包激活失败，
  报 `JsonSchemaError: unsupported JSON schema: … type must be a single type string`）；而声明成
  `type: 'string'` 后返回值再给 `null`，运行时会判 `value.<field> must be a string`、工具直接不可用。
  所以「可能为空的」字段一律**返回 `''` / `0`**（如需区分「正常退出」与「被信号杀」，用另一个
  boolean 字段，或把 signal 的空串当正常），并在 description 里写清语义。

## 5. 图标 / 文案清单（安装前必须齐）

- `locale/en.json`、`locale/zh.json` 至少：
  ```json
  { "meta": { "title": "AI news", "description": "Browse AIHOT selected items, hot topics and the daily report inside DSH." } }
  ```
  英文 sentence case；中文写用户看得懂的名字。
- `icon.svg`：原创（自己画，别拿别人 logo），正方形 viewBox，≤ 256 KiB。

## 6. 验收标准（每个包自证）

1. `node --input-type=module -e "await import('file:///F:/maple/dsh-plugin-pack/packages/<pkg>/index.js')"`
   不报语法/依赖错误（能做到就做；`ssh2` 已在本仓库 `node_modules`，`fetch` 为 Node 22 原生）。
2. 纯逻辑模块（`lib/*.js`）能被 `test/smoke.mjs` 直接 import 并跑断言：
   - `dsh-remote`：hosts 解析 / 命令超时与截断 / 隧道记录增删（不需要真连 SSH）。
   - `dsh-aihot`：URL 构造、markdown/JSON 解析、错误分支（用假 fetch，不联网）。
3. `node test/smoke.mjs` 退出码 0。
4. README 写清：能力、工具清单与参数、配置字段、HTTP 路由、已知限制。
5. 报告给 Lead：改了哪些文件、跑过什么、没验证到什么。

## 7. 禁止

- 不改 profile（`~/.dsh/profiles/desktop/*`）、不装包、不重启 DSH。
- 不碰 `server.js`、根 `package.json`、根 `README.md`、`docs/`、`test/`（这些归 Lead）。
- 不在包目录里放 `node_modules`、不引新依赖（需要依赖先问 Lead）。
- 不写死凭据；密码只从环境变量 / hosts 文件读，且日志与返回值里必须脱敏。
## 8. 本地 CI/CD（`dsh-cicd`，v0.6）

1. **`pipe.yml` 是受限 YAML 子集**：只收 map/sequence/内联数组/标量，块标量与 flow map 直接报错；`${{NAME}}` 缺变量必须报错而不是静默留空。
2. **runId 先于 plan 生成**：`${{RELEASE_ID}}` 要在 plan 阶段就能插值，否则产物文件名是空的（曾经部署了旧包）。
3. **产物多命中取 mtime 最新**，不许按字母序取第一个。
4. **发布不持有凭据**：一律回环调 dsh-remote（`exec` + 8KB 分块上传），本包只存运行记录。
5. **健康检查失败先回滚 `previous`**；没有 `previous` 就撤掉 `current` 指向，不能把坏版本留在线上。
6. **`restart` 命令不能自杀**：`pkill -f <含端口/命令名的字符串>` 会匹配到这条命令自身，按端口杀（`fuser -k <port>/tcp`）。
7. **跨包回包要摊平**：dsh-remote 的 `exec` 返回 `{ok, result:{exitCode,…}}`；等待型重试不许 `unref()`，否则短命进程会在等待期间把事件循环跑空。
8. **记录进 SQLite，不进 JSONL**（v0.3）：用 Node 内置 `node:sqlite` 的 `DatabaseSync`（WAL、`busy_timeout`、`PRAGMA user_version` 管 schema），不引入原生依赖；`commit` 是 SQLite 保留字，列名用 `commit_sha` 再映射回 `commit`；日志继续写文本文件（便于 `tail`/下载）；遗留 `runs.jsonl` 首次打开要导入并改名 `.migrated`。
9. **产物要留指纹**：每次发布记录产物的 `bytes` + `sha256`（写进 artifacts 表与 release.artifact_sha256），回滚时能说清线上跑的到底是哪个包。
10. **多主机发布是逐台独立的**（v0.4）：`hosts` 里每一台各自建 `releases/<id>`、各自 `previous`/`current`、各自 `revisions.log`、各自重启与健康检查；单台失败不 throw，而是把结果写进 `hosts[]` 返回，由 `onHostFailure: stop|continue` 决定后续主机是否继续。已成功的主机**不做**自动回滚。
11. **运行时预设生成的重启命令一律带 `|| true`**（v0.4）：`runtime` 只决定预设命令（pm2/systemctl/php-fpm/fuser+python 等），写 `restart:` 则完全覆盖；预设命令失败不该让「文件已经换好」的发布整体判死。
12. **环境选择器在 Host 侧展开、不在解析期展开**（v0.5）：`hosts` 允许 `env:x`/`group:x`/`tag:x` 与别名混写，解析期只校验 `^(env|group|tag):[a-z0-9._-]{1,32}$`；部署前用 `GET /api/plugins/remote/groups` 展开（保序 + 首次出现去重），展开为空必须报 `PIPE_INVALID`「选择器 env:x 没有匹配的主机」——**静默发布 0 台是最坏的结果**。
13. **生产环境必须在协议层拦**（v0.5）：展开后只要有一台 `env === 'prod'`，`/run` 与 `/rollback` 必须带 `confirm=prod`，否则 409 `PROD_CONFIRM_REQUIRED` 并在错误体里列出受影响主机；`/plan` 提前标 `willDeployToProd`/`prodHosts`。`dryRun` 不改线上，既不触发护栏也不占锁。
14. **同一 target 只允许一条发布在跑**（v0.5）：并发 `/run` 返回 409 `DEPLOY_IN_PROGRESS`，锁在 `finally` 释放，避免两个窗口同时换 `current`。
15. **环境元信息可空但不许是 null**（`dsh-remote` v2.7）：`hosts.json` 的 `env`/`group` 未配置时为 `''`、`tags` 为 `[]`；`GET /api/plugins/remote/groups` 只汇总有值的主机，未配置的不进任何桶。

16. **灰度分批：首批失败即整体停止**（v0.6）：`canary: { first, waitSec }` 两批发布，首批（`first` 台）里任意一台失败立刻停止，剩余主机一律 `skipped`，**不受 `onHostFailure: continue` 影响**；首批全绿才等 `waitSec`（0–3600，默认 30）再发剩余，等待期记一条 `canary-hold` 审计。每台结果带 `batch: 1|2`；`first` 越界或 `waitSec` 越界报 `PIPE_INVALID`。
17. **通知失败绝不影响发布**（v0.6）：`notify.webhooks` 并发 POST（5s 超时），配了 `secret` 才带 `x-dsh-signature: sha256=<hex>`（HMAC-SHA256 对原始 body）；每条结果写 `notify` 审计，异常一律吞掉只记日志；`events` 省略=全发；`/notify-test` 未配置时返回 `configured: 0` 而不是报错。
18. **审计是可查的时间线**（v0.6）：`operations` 表 schema v3（`id,at,action,project,target,host,run_id,release_id,status,detail`，旧库 `ALTER TABLE` 补列并把旧 `kind` 回填 `action`），`GET /operations?project=&runId=&limit=`（默认 50、上限 200）按 `at DESC`；deploy 每台、rollback 每台、`canary-hold`、`notify` 都必须落一条。