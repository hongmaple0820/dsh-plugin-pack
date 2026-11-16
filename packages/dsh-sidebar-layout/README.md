# @local/dsh-sidebar-layout

DSH 左侧栏的两个小改造，纯客户端（Host 侧 `apply()` 不做任何事，只为了能被 patch 挂上）：

1. **分开滚动**：导航区（全局面板行）与工作区（会话列表）各滚各的，不再共用一个滚动视口。
2. **一键折叠**：工作区小标题行右端多一个折叠按钮，收起会话列表、把空间让给导航区，状态记本机。

## 为什么需要它

shell（`@deepseek-ai/dsh-client-ui-sidebar` 的 `SidebarRoot.tsx:407-458`）把

```
div.scrollRegion > div.scrollArea[data-sidebar-scrollport]
                    ├── nav.panelList        ← 全局面板行
                    └── div.regionArea       ← sidebar.workspaces 槽位（工作区会话）
```

两坨内容放在**同一个** `overflow-y: auto` 容器里，所以会话一多就把导航行顶出视野。工作区自己
那份 `listArea`（`WorkspaceBrowser.module.css:350-367`）本来有 `overflow-y: auto`，但被
`@container scroll-state(scrollable: bottom) { overflow-y: hidden }` 关掉了——侧栏视口能滚时它不接管。

## 做法

- `[data-sidebar-scrollport]` 改成 `display: flex; flex-direction: column; overflow: hidden`。
- `> nav` 自己滚：`max-height: calc(100% - 232px)`（可用 `--dswl-nav-max` 覆盖），
  `overscroll-behavior: contain`，并绑一个 `wheel` 监听 `stopPropagation`——否则 shell 的
  `scroll-handoff.ts` 会把滚轮余量转给工作区，滚导航却在动工作区。
- `> [class*="regionArea"]` 撑满剩余高度（`min-height: 200px`），让工作区根节点有确定高度、
  它内部的 `listArea` 才肯自己滚。
- 折叠态（`<html data-dswl-collapsed="1">`）：工作区列表 `display: none`，导航区 `max-height: none`。

## 按钮

`[class*="sectionHeader"]` 右端注入 `.dswl-ws-toggle`（24×24，chevron 图标，折叠时 rotate(-90deg)）：
`aria-label` 在「折叠工作区会话 / 展开工作区会话」之间切换，状态存
`localStorage['dsh-sidebar-layout.workspace-collapsed']`（`'1'` / `'0'`），刷新与跨标签都跟着走。

## 已知边界

- **只在侧栏展开态生效**：`data-sidebar-scrollport` 在 rail（收起）态不存在，CSS 选择器天然不命中。
- shell 重渲染会冲掉按钮，`MutationObserver(document.body, {childList, subtree})` 用 rAF 去抖补回；
  别的插件（比如 `dsh-claude-style`）也往同一行插元素时互不影响（我们只认自己的 `.dswl-ws-toggle`）。
- 只用 `[class*="…"]` 子串选择器，不写死 CSS Module 哈希（运行时是 `wtg9ga_scrollArea` 这种）。
- 颜色只用 `--dsw-*` token，跟随主题。
- 卸载（`ctx.effect` disposer）会撤样式、删按钮、移除 `<html>` 标记、断开观察器与监听。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半边：`export const inject = []`，`apply(ctx)` 只打一条 debug 日志 |
| `client.js` | Client 半边：注入 `<style>` + 折叠按钮 + wheel 守卫 + MutationObserver |
| `cordis.patch.yml` | bundle 补丁，把 `@local/dsh-sidebar-layout` insert 进 profile |
| `locale/{zh,en}.json` / `icon.svg` | 插件元信息 |