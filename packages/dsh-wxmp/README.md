# dsh-wxmp

微信公众号（wxmp）插件：扫码登录公众平台、搜索并订阅公众号、同步历史文章、抓正文转 Markdown，工具与页面双半边。标题「公众号」。

## 安装

DSH 侧安装 bundle patch（同 dsh-aihot 挂载方式）：

```
plugin_manager install_bundle target="F:\maple\dsh-plugin-pack\packages\dsh-wxmp"
```

插件 manifest 为 `packages/dsh-wxmp/package.json`（`"dsh".bundle.patch="./cordis.patch.yml"`）；安装后 webServer 路由挂到 `/api/plugins/wxmp/*`，对话侧工具栏出现「公众号」页签。

## 工具（10 个，wxmp_*）

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| wxmp_login_status | 登录态查询；未登录时返回一次性扫码链接与会话码 | 无 |
| wxmp_search_accounts | 搜索公众号 | `query`（必填）、`begin`、`count`（1-20） |
| wxmp_list_articles | 公众号历史文章列表 | `fakeid`（必填）、`begin`、`count`（1-100）、`keyword` |
| wxmp_read_article | 抓单篇文章正文 | `url`（必填） |
| wxmp_subscribe | 订阅/更新订阅 | `fakeid`（必填）、`nickname`、`alias`、`headImg`、`category` |
| wxmp_unsubscribe | 取消订阅 | `fakeid`（必填） |
| wxmp_local_articles | 读本地文章库（增量翻页） | `fakeid`（可选，缺省=全部）、`category`（可选）、`since`（游标）、`limit` |
| wxmp_sync | 同步所有订阅的最新文章 | 无 |
| wxmp_poll | 手动触发一轮增量轮询（同定时任务） | 无 |
| wxmp_get_rss_url | RSS 订阅链接 + 轮询状态（间隔/暂停/最近时间） | `fakeid`（可选，缺省返回全部） |
| wxmp_export_account | 整号导出（七格式） | `fakeid`、`format`、`range` |

登录流程：`wxmp_login_status` 返回 `loginUrl` → 手机扫码 → 状态转 `logged_in`（凭证存 `data/.credentials.json`，公众平台侧凭证约 4 天有效）。全部需要登录的接口会抛出 `LoginExpiredError`（ret=-1）或 `InvalidFakeidError`（ret=200002）。

## 页面（「公众号」）

四个 tab，图片防盗链一律 `referrerpolicy="no-referrer"` 直连，无代理端点：

- **登录**：二维码轮询（pending / scanned / confirmed / expired 四态自动刷新）。
- **订阅**：搜索→订阅；已订阅行可编辑分类、复制 RSS 链接、看上次同步与文章数、按七种格式导出（导出后给出下载链接）；顶部「手动同步 / 立即轮询 / 暂停·恢复轮询」与轮询状态。
- **文章**：本地库列表，按公众号或分类过滤，抽屉内渲染正文 Markdown 与原文链接。
- **Webhook**：列表 / 添加 / 删除；轮询发现新文章时向所有 webhook POST `{event:'articles_added', added, articles:[{fakeid,nickname,title,link,publishTime}]}`。Webhook 列表是运行期状态（config 提供初值），失败只记日志不影响轮询。

## HTTP 路由（/api/plugins/wxmp）

GET 全部走 `?_method=...` 模拟（web 端禁用非 GET），写操作统一 POST `?_method=write`：

| 路由 | 说明 |
| --- | --- |
| GET `/login/status`、`/login/qrcode` | 登录态 / 二维码 PNG |
| POST `?_method=write` `/login/start` | 开始登录 |
| POST `?_method=write` `/login/logout` | 退出登录 |
| GET `/accounts/search` | 搜索公众号 |
| GET `/articles` | 远端文章列表 |
| GET `/local/articles` | 本地文章库 |
| GET `/local/articles/{id}` | 单篇 Markdown |
| GET `/subscriptions` | 订阅列表（含 `category`、`lastPoll`、`articleCount`、`categories` 汇总）；`?category=` 过滤 |
| GET `/subscriptions?_method=set_category&fakeid=&category=` | 改订阅分类（未订阅 404） |
| POST `?_method=write` `/subscribe`、`/unsubscribe` | 订阅 / 取消（`subscribe` 支持 `category=`） |
| POST `?_method=write` `/sync` | 同步全部订阅 |
| GET `/webhooks?_method=list\|add\|remove&url=` | Webhook 管理（运行期列表） |
| GET `/rss/{fakeid}.xml` | RSS 2.0 输出（未订阅 404） |
| GET `/rss/poll?_method=poll\|pause\|resume\|status` | 手动轮询 / 暂停 / 恢复 / 状态 |
| GET `/export/{fakeid}.{format}` | 七格式导出（`?token=` 下载，`?_method=export&range=` 直出） |

## 配置（cordis.patch.yml）

```yaml
timeoutMs: 15000            # 单请求超时
rateLimitGlobalPerMin: 10   # 全局限频
articleIntervalMs: 3000     # 文章抓取最小间隔
cacheTtlMs: 60000           # 搜索结果本地缓存
pollIntervalMs: 600000      # 定时增量抓取间隔（0 = 不注册定时器）
pollLimit: 10               # 每个订阅单次抓取条数
webhooks: []                # webhook 通知 URL 初值（运行期可通过 /webhooks 增删）
```

## 数据与依赖

- 存储三级优先：DSH storage 域（`ctx.get('storage')`，宿主持久化）→ `better-sqlite3`（表 `subscriptions` / `articles`，`UNIQUE(fakeid, link)` 去重，旧库缺 `category` 列自动 ALTER 补列）→ 同接口内存实现（进程重启即丢）。
- 目录：`data/.credentials.json`（登录凭证）、`data/wxmp.sqlite3`（SQLite 库）。
- 依赖仅 `better-sqlite3`（可选）；网络层用注入的 `fetchImpl`，可在测试中替换。除它之外零第三方依赖（zip/OOXML/EPUB/PDF 全为手写）。

## 测试

```
node --check index.js lib/*.js client.js
node --test test/*.mjs
```

当前 54 个用例全过（mock fetch 覆盖：登录四步、searchBiz、双层 publish_info、authorinfo、文章页解析、htmlToMarkdown；三存储后端的去重/游标/持久化/分类；RSS 与轮询 pause-resume；七格式导出；webhook 投递与 poll 集成；新增路由契约）。

## 整号导出（wxmp_export_account + /export 路由）

- 工具 `wxmp_export_account({ fakeid, format, range })`：从本地库导出整号文章，返回下载链接（token 有效 10 分钟）。`format` ∈ md|html|json|xlsx|docx|epub|pdf；`range` ∈ all | days:N | {since,until}（Unix 秒，since 为下界）| incremental（全量并返回 nextSince 供下次 {since} 增量）。
- 路由：`GET /api/plugins/wxmp/export/{fakeid}.{format}?token=…`（token 下载）；`GET …?_method=export&range=days:7`（直接导出下载）。
- 纯读本地库，不触发微信抓取；docx/epub 会现抓微信图片内嵌（失败单张跳过）。
- 上限：md/html/json/xlsx 3000 篇，docx/epub 500，pdf 200（超出截断并标记 truncated）。
- 实现说明：全部为纯 JS 实现（自写最小 zip writer / OOXML / EPUB3 / PDF 1.4），零新增 npm 依赖。PDF 使用内置 Helvetica 非 CID 字体，中文将以可读结构化文本降级呈现（标题/链接引用式，正文文本化）；本环境无中文字体文件可内嵌，属可接受降级。xlsx 为最小 OOXML 工作簿（无需 SheetJS）。
