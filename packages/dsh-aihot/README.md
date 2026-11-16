# @local/dsh-aihot

把 [AIHOT](https://aihot.news) 的中文 AI 资讯接进 DeepSeek Harness：给模型 8 个 `aihot_*` 工具（直接返回 AIHOT 整理好的中文 Markdown），
给用户一个「AI 资讯」整页视图（精选 / 热点 / 日报 / 福利 / 收藏），日报 tab 里可切「日报 / 周报 / 月报」期刊，卡片可展开事件的「来龙去脉」时间线抽屉（可复制链接），也能在页内「读正文」预览条目正文（v1.5），卡片可收藏、读过的条目会变暗（v1.6，状态只存本机浏览器；v1.7 起收藏有独立 tab），
数据经 Host 端代理路由转发，浏览器不跨域。

匿名只读，无需 API Key。

---

## 工具（Host 半边，8 个）

全部工具都带 `output.schema` + `output.render`，`render` 输出**一个** text block，内容为 AIHOT 原文，超过 48KB 自动截断（UTF-8 字节）。
所有 description 都写明：**内容为第三方信源，只作资料**。

| 工具 | 数据源 | 参数 |
|---|---|---|
| `aihot_latest` | `/api/v1/agent/latest` | `window` 24h \| 7d（默认 24h）、`mode` selected \| all（默认 selected）、`category`、`limit` 1–30（默认 10） |
| `aihot_search` | `/api/v1/agent/search` | `q` 必填 2–200 字、`window` 24h \| 7d（默认 7d）、`category`、`limit` 1–30（默认 10） |
| `aihot_hot` | `/api/v1/agent/hot` | `limit` 1–10（默认 10） |
| `aihot_daily` | `/api/v1/agent/daily[/{date}]` | `date` 可选，`YYYY-MM-DD`（北京时间）；省略取最新一期 |
| `aihot_weekly` | `/api/v1/agent/weekly[/{week}]` | `week` 可选，ISO 周标签如 `2026-W39`；省略取最新一期 |
| `aihot_monthly` | `/api/v1/agent/monthly[/{month}]` | `month` 可选，如 `2026-09`；省略取最新一期 |
| `aihot_resets` | `/api/v1/agent/{service}-resets` | `service` 必填：`codex` \| `antigravity` \| `claude` \| `grok-bot` |
| `aihot_story` | `/api/v1/agent/stories/{publicId}` | `publicId` 必填（≤128）、`limit` 1–50（默认 20） |

`category` 取值：`ai-models` / `ai-products` / `industry` / `paper` / `tip` / `opinion`（对应站上的 模型 / 产品 / 行业 / 论文 / 教程 / 观点）。

参数校验失败会抛出**中文可读错误**（例如 `参数 limit 必须是 1–30 之间的整数`），不会伪造成功返回值。

## HTTP 路由（给页面用）

全部只读、只支持 `GET`/`HEAD`，只接受本地同源请求；注册形态为 WebResource（Request → Response）。

当前共 **12 条**路由（v1.3–v2.0）；新增或删除路由时同步本表，并核对 `node test/mount.mjs` 打印的条数。

> **注册时机**：全部路由在 `ctx.inject(['webServer'], …)` 的作用域里注册。冷启动时 `webServer` 常常晚于本插件 `apply`，若同步用 `ctx.get('webServer')` 取服务就会整包跳过注册——页面照常渲染、但 12 条 API 全部 404，且插件在列表里仍是 active（2026-11-14 踩过）。改服务注册方式时保留这个注入作用域。

| 路由 | 上游 | 成功响应 |
|---|---|---|
| `GET /api/plugins/aihot/items` | `/api/v1/items` | `{ ok: true, schemaVersion, query, items, page }`，透传 `window` / `category` / `mode` / `limit` |
| `GET /api/plugins/aihot/hot` | `/api/v1/hot-topics` | `{ ok: true, schemaVersion, count, items }` |
| `GET /api/plugins/aihot/daily` | `/api/v1/dailies/latest` | `{ ok: true, schemaVersion, report }` |
| `GET /api/plugins/aihot/resets` | `/api/v1/{service}-resets[/recent]` | `{ ok: true, schemaVersion, timezone, checkedAt, count, events, monitor, … }`；`service` 必填（`codex` \| `antigravity` \| `claude` \| `grok-bot`），`scope` 可选（`recent` 默认 = 近 7 天快照，`all` = 完整历史） |
| `GET /api/plugins/aihot/story` | `/api/v1/stories/{publicId}` | `{ ok: true, story: { …Story, reports }, resolvedFrom? }`；`id` 与 `item` **必须且只提供一个**（都缺/都给 → 400），`limit` 1–50 默认 20 |
| `GET /api/plugins/aihot/article` | `/items/<itemId>`（条目页 HTML） | `{ ok: true, item: { id, title, url, source, publishedAt, chars, truncated, paragraphs[], fallback } }`；`id` 必填（正则 `[A-Za-z0-9._:-]{1,128}`）。正文按 UTF-8 累计 ≤64KB，超出置 `truncated: true`；单条 5 分钟缓存、8s 超时 |
| `GET /api/plugins/aihot/period` | `/api/v1/weeklies` · `/api/v1/monthlies`（索引用 `?limit=`）／`/api/v1/weeklies/{week}` · `/api/v1/monthlies/{month}`（单期） | 索引 `{ ok: true, kind, count, items }`；单期 `{ ok: true, kind, report }`。`kind` 必填（`weekly` \| `monthly`）；`issue` 可选（`2026-W39` / `2026-09`，与 kind 必须匹配）；`limit` 1–60 默认 12（只在索引生效）；其它查询参数一律 400 |
| `GET /api/plugins/aihot/search` | `/api/v1/items?q=` | `{ ok: true, query, count, items, page }`；`q` 必填且 2–200 个字符（否则 400 `q 需要 2-200 个字符`），可叠加 `window` / `category` / `limit`（v2.0） |
| `GET /api/plugins/aihot/leaderboard` | `/leaderboard`（站点页 HTML） | `{ ok: true, rows: [{ rank, name, org, slug, launchedAt, evaluations, coverage, priceCache, priceInput, priceOutput, score }], other: [{ name, slug, org, note, score }], total, pendingTotal }`（v2.0） |
| `GET /api/plugins/aihot/free-tokens` | `/free-tokens`（站点页 HTML） | `{ ok: true, sections: [{ title, items: [{ title, desc, link, period, badge, validity }] }] }`，三个分区「每天都能领 / 每月都能领 / 其他福利」（v2.0） |
| `GET /api/plugins/aihot/reset-calendar` | `/resets`（站点页 HTML） | `{ ok: true, lastCard, month, monthLabel, days: [{ date, services, today, label }] }`（v2.0） |
| `GET /api/plugins/aihot/agent-access` | `/agent`（站点页 HTML） | `{ ok: true, version, modes: [{ id: skill\|mcp\|rss\|api, … }], resources, installPrompt, troubleshooting }`（v2.0） |

`/story` 的两种入参：

- `?id=<publicId>`：热点卡片自带 `links.story`，直接打 JSON API（首选）。
- `?item=<itemId>`：精选条目只有条目 id，JSON API 不暴露这层映射；Host 端抓条目页 `https://aihot.news/items/<id>` 的 HTML，
  用 `/story/<publicId>` 正则兜底解析出 publicId 再请求 JSON API，响应带 `resolvedFrom: 'item'`。解析不到 → HTTP 404。
  这是兜底路径（依赖条目页结构），条目页改版时可能失效；失效时前端按 404 显示错误态，不影响其它 tab。

上游 `/api/v1/stories/{id}` **不接受 `limit` 参数**（传了直接 400 `Unknown query parameter: limit`），所以 `limit` 只在 Host 本地对
`story.reports` 截断；上游 `reports` 是「新→旧」，正序排序由页面做。

失败形状：`{ ok: false, error }`，参数非法 → HTTP 400，上游失败（4xx/5xx/超时/限流用尽）→ HTTP 502，**上游 404 原样透出 404**，非 GET → HTTP 405。
响应带 `cache-control: no-store`（Host 内部有 60–300s 的进程内缓存，见下）。

> 路由一律 `resource` + GET/HEAD + 查询参数：`dsh-host-webserver` 在 carrier 层只服务 GET/HEAD，POST 会直接 405，`handler` 也救不了。

## 配置（`cordis.patch.yml` 的 `config`）

本包**不导出 `Config`**，`apply(ctx, config)` 直接读原始对象并补默认值：

| 字段 | 默认 | 说明 |
|---|---|---|
| `timeoutMs` | `8000` | 单次上游请求超时（毫秒） |
| `cacheTtlMs` | `120000` | 进程内响应缓存时长（毫秒），`0` 关闭；建议 60–300s，别超过 AIHOT 的 `Cache-Control` 量级 |
| `fetch` | `globalThis.fetch` | 可注入 fetch（只给测试用） |

默认 patch：

```yaml
- insert:
    - id: dsh-aihot
      name: '@local/dsh-aihot'
      config:
        timeoutMs: 8000
        cacheTtlMs: 120000
```

## 页面（Client 半边）

页面本体只挂**一个入口**（id `aihot`）：

**左侧栏全局面板页**：向 shell 的 `sidebar.panellist` 注册一行（`order: 50`）并画一个 16×16 字形（根 svg 带
`data-dsh-panel-entry="aihot"`；行框、label、高亮、折叠 rail 都由 shell 拥有，插件不接管），页面本体注册到 layout 的
keyed `main` 槽（`key: 'aihot'`），只有该面板被选中时 layout 才挂载它。这两个 seat 都由 shell 插件声明，所以注册都包在
`ctx.slots.inject(...)` 里：shell 没声明就自然缺席，不会拖垮启动。

> **不再注册 `conversation.view`。** shell 会把「当前 View」按会话持久化到
> `localStorage['dsh.conversation.<sessionId>'].view`，于是曾点进 AI 资讯的会话以后每次打开都直接回到资讯页、
> 看不到对话内容（且没有明显的退出口），表现为「只有某个会话会这样」。全局面板已覆盖同一入口，且点侧栏会话时
> shell 必定 `selectPanel(null)`。旧会话里残留的 `view: 'aihot'` 由 shell 的 `resolveActiveView` 回落到 `chat`，无需迁移。

九个 tab 的数据来源：

| Tab | 数据来源 |
|---|---|
| 精选 | `GET /api/plugins/aihot/items?window=7d&mode=selected&limit=30[&category=…]`（顶栏搜索框激活时改打 `GET /api/plugins/aihot/search?q=…`） |
| 热点 | `GET /api/plugins/aihot/hot` |
| 日报 | 日报 `GET /api/plugins/aihot/daily`；切到周报/月报时先取期号索引 `GET /api/plugins/aihot/period?kind=weekly|monthly`，再取当期 `…?kind=weekly&issue=2026-W39` |
| 福利 | 四个服务各打一次：`GET /api/plugins/aihot/resets?service=codex` / `…?service=antigravity` / `…?service=claude` / `…?service=grok-bot`（默认 `scope=recent`，即近 7 天快照） |
| 收藏 | 只读 `window.localStorage`（`dsh.aihot.saved.v1`），不发请求（v1.7） |
| 排行榜 | `GET /api/plugins/aihot/leaderboard`（v2.0） |
| 羊毛 | `GET /api/plugins/aihot/free-tokens`（v2.0） |
| 重置日历 | `GET /api/plugins/aihot/reset-calendar`（v2.0） |
| 接入 | `GET /api/plugins/aihot/agent-access`（v2.0） |

- 精选 tab 带分类过滤（全部 / 模型 / 产品 / 行业 / 论文 / 教程 / 观点）与刷新按钮；加载中（骨架）/ 空 / 错误（可重试）三态齐全。
- **固定顶栏**：`.aihot-page` 自身不滚动，顶栏是它的 `flex:0 0 auto` 固定行，正文与页脚包进 `.aihot-body`（`flex:1 1 auto; min-height:0; overflow-y:auto`）。
  顶栏不参与滚动上下文，因此不依赖 `sticky` 的滚动祖先是谁；`height:100%` 的约束链（`.aihot-panel` → `.aihot-page` → `.aihot-body`）保证只有正文区滚动。
- **顶栏排版（v2.0.1）**：主行固定为「tab 段控件 + 工具组（搜索 / 主题 / 刷新）」，所有控件共用 28px 基线、同一圆角与间距刻度；
  9 个 tab 不再折行，宽度不够时只在段控件内部横向滚动。分类 / 期刊分段 / 期号 / 搜索摘要收进第二行 `.aihot-topbar-sub`，
  组与组之间用 1px 竖线分隔，右端放「更新于」时间。窄窗口先收窄搜索（≤1080px），再让工具组整体换到第二行（≤900px），避免挤成碎折行。
- 福利 tab 是四张服务卡片（Codex / Antigravity / Claude / Grok Bot），字段全部来自上游、没有就不显示：
  状态徽标取 `events[0].presentation.status`（缺则退 `events[0].status`，中文映射 announced/in_progress/confirmed/expired_unconfirmed/likely_completed），
  「最近一次」取 `max(events[].confirmedAt)`（没有就显示「暂无已确认的重置」），「下一条」取未确认事件的 `estimate.label`（缺则 `schedule.label`），
  「条数」取 `count`，脚注是 `monitor.status` + `checkedAt`。四个请求并行，单个服务失败时其余照常显示并给一行提示；未选中该 tab 不发请求。
- **期刊分段（v1.4）**：日报 tab 顶部有「日报 / 周报 / 月报」分段控件。周报 / 月报选中后先取期号索引（默认最新一期，期号用横向 chips 换期，最多列 12 期），
  正文用同一套卡片渲染 `headline` / `overview` / `sections[].items`，并标出期号与 `periodStart–periodEnd`、给「阅读原文 ↗」外链；
  切分段或切期号都 abort 上一次请求，不轮询。
- 卡片：标题外链到 `https://aihot.news/items/<id>`（`target="_blank" rel="noreferrer"`）、来源、北京时间、分类徽标、摘要；日报额外有导语与分栏、快讯。
- **来龙去脉抽屉（v1.3）**：精选 / 热点卡片标题行右侧有「来龙去脉」入口，点开右侧抽屉（`aside` + 全屏遮罩，`role="dialog"`）。
  数据走 `GET /api/plugins/aihot/story`：热点卡片用自带的 `links.story` 直接传 `id`，精选条目传 `item`（Host 端条目页兜底解析）。
  抽屉显示事件标题、状态徽标（进行中 / 已结案）、来源数 / 报道数 / 起止时间、AI 摘要（`story.digest`）、按 `publishedAt` **正序**的时间线
  （时间 + 标题外链 + 摘要 + 来源）、相关事件外链、`story.links.aihot` 原文入口；带加载 / 空 / 错误（可重试）三态。
  关闭方式：右上 ×、Esc、点遮罩。同一 story 5 分钟内复用客户端缓存，**不轮询**（未打开不发请求）。
  抽屉用 `require('react-dom')` 的 `createPortal` 挂到 `document.body`：宿主 composer 会裁剪 `position: fixed`，就地渲染会被裁掉。
  抽屉头部还有「复制链接」按钮（v1.4）：复制 `https://aihot.news/story/<publicId>`，成功后按钮文案变「已复制」约 2 秒复原；
  `navigator.clipboard` 不可用时退到临时 textarea + `document.execCommand('copy')`，仍失败则显示「复制失败」。
- **读正文抽屉（v1.5）**：每张卡片标题行右侧还有「读正文」入口（与「来龙去脉」同排、次要色），点开复用同一套抽屉外壳
  （`aside.aihot-drawer` + 遮罩 + `createPortal(document.body)` + Esc / × / 遮罩关闭）。**只在点击时抓取，列表绝不预取正文**。
  正文走 `GET /api/plugins/aihot/article?id=<itemId>`（Host 端抓条目页 HTML 抽段，见上表），抽屉里逐段渲染（`line-height: 1.75`），
  头部给标题、来源、北京时间、`${chars} 字` 与「复制链接」（复制 `https://aihot.news/items/<id>`，复用 v1.4 的 `copyText` 回退链）。
  三态：加载中「正在抓取正文…」、空正文「这条没有正文，去原文看」+「看原文 ↗」、失败 `role="alert"` 红字 + 「重试」。
  打开时焦点移到抽屉（`tabIndex="-1"`），关闭后焦点回到触发按钮；`chars` 截断时提示「正文过长，已截断」+「读全文 ↗」给原站；
  同一条目 5 分钟内复用客户端缓存，不轮询。正文由条目页 HTML 解析（上游没有正文 JSON 接口），排版可能与原文略有差异，
  响应里 `fallback: true` 表示该条走了块级换行兜底解析。
- **收藏与已读（v1.6）**：纯 Client 状态，**不上 Host、不新增路由、不发请求**，全存 `window.localStorage`：
  - `dsh.aihot.saved.v1`：收藏，条目形如 `{ id, title, source, publishedAt, url, at }`；
  - `dsh.aihot.read.v1`：已读，只存 `{ id, at }`。
  两把 key 各限 **500 条**，按 `at` 倒序、超了丢最旧；读写都包了 try-catch（隐私模式 / 配额满 / 键被禁用时
  降级成内存态：页面照常用，只是刷新后丢），坏 JSON 或坏形状会回空数组并覆盖写一次干净值。
  - 精选 / 热点卡片右上角有星标 `.aihot-save-link`（`aria-pressed` 反映状态，☆/★），点一下即时落盘；
    日报 / 期刊 / 福利卡片不带星标。
  - 精选过滤条在分类 chips 后多一个 `.aihot-saved-filter`「已收藏（N）」chip，可叠加分类过滤；没有收藏时置灰不可点，
    收藏被删空后自动退出该视图（不会停在空列表）。
  - 打开「读正文」或「来龙去脉」即把该条目记为已读；已读卡片标题降为 `--dsw-alias-label-secondary`
    并在卡片左侧加 2px 主题 token 竖线（`-border-l3`），刷新页面后状态仍在。
- **收藏页（v1.7）**：第五个 tab「收藏」，文案带条数（`收藏（3）`，0 条时不加括号）。
  内容直接来自 `dsh.aihot.saved.v1`，**不发请求**：每张卡复用同一个 `Card`（标题外链 `url`、来源、北京时间；
  收藏里没存摘要，所以摘要块整块不渲染），右侧按钮换成 `.aihot-unsave-link`「取消收藏」，点一下从存储里删掉并即时刷新列表，
  删空后显示空态「还没有收藏。在精选/热点里点 ☆ 收藏条目。」。
  收藏卡片同样带「读正文」（`/article?id=`）与「来龙去脉」（收藏里没有 story 映射，走 `item=` 兜底解析；解析不到就是既有错误态），
  这两个入口记已读的逻辑和 v1.6 是同一份 `markRead`，没有第二套实现。
  点「刷新」会把两把 key 重新读一次（另一个挂载点刚写过时能同步过来）。
 - **收藏导出 / 清空 / 跨标签同步（v1.8）**：收藏页顶部多了自己的工具条（`div.aihot-filters.aihot-saved-tools`）：
   - 「导出」（`.aihot-export-link`）：纯前端 `Blob` + 临时 `<a download>`，把收藏存成
     `aihot-saved-<YYYYMMDD-HHmm>.json`，内容是 `{ version: 1, exportedAt: <ISO>, items: [{ id, title, source, publishedAt, url, at }] }`。
     不经过任何网络、**不开后端导出路由**；没有收藏时按钮 disabled。
   - 「清空收藏」（`.aihot-clear-link`）：二次确认——第一次点文案变 `确认清空（N）`、按钮转成错误色，**3 秒内再点**才真清；
     超时或切走 tab 自动复位。清空写回 `dsh.aihot.saved.v1` 并刷到空态，**不动已读**（`dsh.aihot.read.v1` 原样保留）。
   - 跨标签同步：订阅 `window` 的 `storage` 事件，只在 `key` 是这两把之一时回读最新值（tab 上的收藏条数也一起同步）；
     坏 JSON 按 v1.6 的策略回空。自己的 `setItem` 不会触发该事件，所以本地写入仍然直接走 `saveStore` 更新状态。
   - 三处纯函数（`parseStoreValue` / `exportFileName` + `buildExportPayload` / `downloadJson`）都在 `client.js` 里，
     读存储、写文件都不依赖 Host。
- 样式只用主题 token（`--dsw-alias-*` 与 `--dsw-radius-*`），不写死颜色；动画只用于骨架，不轮询（切换 tab / 分类 / 点刷新才请求）。
- **固定顶栏 · 全局搜索 · 四个新 tab · 主题（v2.0）**：
  - 顶栏（tab 段控件 + 工具组 + 上下文行）是页面的固定行，带背景与 0.5px 下边线，不随内容滚走。
    **排布见上面「顶栏排版（v2.0.1）」**：tab 不折行、控件同在 28px 基线、过滤/期号收进第二行。**实现不用 `sticky`**：`.aihot-page` 自身 `overflow:hidden`，只有正文容器
    `.aihot-body` 滚动，所以顶栏不受「滚动祖先是谁」影响（v2.0 初版用 `sticky` 时，在会话内 View 那种「外层才是
    scrollport」的上下文里会失效）。
  - 顶栏搜索框（`.aihot-search`，300ms 去抖、Esc 清空、`aria-label="搜索资讯"`）走 `GET /api/plugins/aihot/search`；
    结果复用同一个 `Card`（星标 / 已读 / 读正文 / 来龙去脉都在），顶部横幅「N 条结果 · 搜索「xxx」」+ 清除按钮；
    搜索期间再改分类会带 `category` 重新请求。
  - 四个新 tab 都抓站点 SSR 页面（Host 解析成 JSON，见上表，5 分钟缓存、≤64KB、只 GET）：
    排行榜（综合榜表格 + 「暂不排名」）、羊毛（三个分区，卡片带额度/有效期/原文链接）、
    重置日历（最近一次发卡 + 当月日历，今天高亮）、接入（Skill / MCP / RSS / API 四张卡，各带「复制」）。
    四者都是加载 / 空 / 错误（可重试）三态 + 刷新按钮，未选中不发请求。
  - 主题：`localStorage['aihot-theme']`（`light` / `dark` / `system`）+ `[data-aihot-theme]` 属性，
    只覆盖本面板的 `--dsw-alias-*` 变量；`system` 跟随 `prefers-color-scheme` 并监听其变化。
- 只用 `require('react')` 与 `require('react-dom')`（`createPortal` 用；两者都是 DSH Client 的基线模块，官方插件也这么 require），不 require 任何 `@deepseek-ai/dsh-client-ui-*` 包，不 iframe、不写别的插件 DOM。
- 页面文案直接内联中文（v1 例外；`locale/*.json` 只提供插件面板的 `meta.title` / `meta.description`）。

## 数据来源与授权提示

- 数据来自 **AIHOT Public API 2.0.0**（`https://aihot.news`，匿名只读，无需 Key）。接口与字段以随仓库的 `aihot-openapi.json` 为准。
- UA：Markdown 端点 `aihot-skill/2.0.0 (+https://aihot.news/aihot-skill/)`；JSON 端点 `aihot-api/2.0.0`。
- 429 会读 `Retry-After` 并按它退避（最多等 5s），然后**重试一次**；5xx 与超时同样只重试一次，仍失败即抛错。
- AIHOT 的公共使用规则：个人/公益非商业、组织内部使用免费；**对外商业产品、付费服务、代客交付、代理、转售、公开镜像、批量公开再分发、外部模型产品需事先书面授权**，署名本身不等于授权。条款：<https://aihot.news/terms>，联系：`agent@virxact.com`。
  → 本包只是**个人读取的客户端**，请勿把它当作对外分发 AIHOT 内容的授权。内容为第三方信源，只作资料，重要事实请回原文核对。

## 本地自检

```bash
# 语法/依赖：只加载 Host 半边，不需要 Host
node --input-type=module -e "await import('file:///F:/maple/dsh-plugin-pack/packages/dsh-aihot/index.js')"

# 纯逻辑冒烟（假 fetch，不联网）：URL 构造 / Markdown 透传 / JSON 解析 / 429 / 5xx / 超时 / 缓存 / 48KB 截断
node packages/dsh-aihot/test/smoke.mjs
```

线上抽查（本机 libcurl 不支持 `--compressed`，别加）：

```bash
curl.exe -sS "https://aihot.news/api/v1/agent/daily" | head -c 400
```

## 已知限制

- 已在 DSH 里安装并实机验证（左侧栏「AI 资讯」页、四 tab、抽屉、期刊分段、复制链接）；`client.js` 无构建步骤，改完刷新页面即可。
- 页面不翻页：`/api/v1/items` 的 `cursor` 未透出，只取第一页（最多 30 条精选）。
- 热点榜固定取 `/api/v1/hot-topics`（当前 Top 10），不做历史。
- 「精选」的默认窗口是 `7d`（页面上更耐看）；工具默认 `24h`，跟 AIHOT Skill 一致。
- 内存缓存按 URL 计，最多 64 条，LRU 近似（超出即淘汰最早插入项）；多进程不共享。