/**
 * @local/dsh-sidebar-layout · Client 半边。
 *
 * 做两件事，都在左侧栏（DSH shell 的 SidebarRoot）上：
 * 1. **分开滚动**：shell 把「全局面板导航（panelList）」与「工作区会话（regionArea）」
 *    塞在同一个 `[data-sidebar-scrollport]` 滚动视口里，所以上下一起滚。这里把侧栏
 *    视口改成 flex 列、自身不滚：导航区（`nav`）自己滚、工作区（`regionArea`）自己滚。
 * 2. **一键折叠**：在工作区小标题行（`sectionHeader`）右端插一个折叠按钮，点一下把
 *    工作区会话列表收起来，导航区顺势占满，状态记 localStorage。
 *
 * 依赖的 shell 结构（`dsh-client-ui-sidebar` / `dsh-client-ui-workspace`，运行时类名
 * 是 CSS Module 的 `<hash>_<localName>`）：
 * - `[data-sidebar-scrollport]` 只在侧栏展开时存在（rail 态没有），所以下面所有规则
 *   天然只作用于展开态。
 * - 其子节点：`nav.panelList`、`div.regionArea`；`regionArea` 里是工作区根节点，
 *   含 `sectionHeader` 与 `listArea`。
 *
 * 约束：不 iframe、不引第三方依赖、颜色只用 `--dsw-alias-*` token；只用属性选择器，
 * 不写死 CSS Module 哈希前缀；shell 重渲染把按钮冲掉时由 MutationObserver 补回去。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-sidebar-layout',
  factory() {
    const STYLE_ID = '@local/dsh-sidebar-layout/layout.css'
    const STATE_KEY = 'dsh-sidebar-layout.workspace-collapsed'
    /** 折叠状态挂在 <html> 上，CSS 只认它。 */
    const STATE_ATTR = 'data-dswl-collapsed'
    /** 给导航区打的标记：滚轮事件不再往侧栏视口冒（否则 shell 的滚动接力会抢走它）。 */
    const NAV_ATTR = 'data-dswl-nav'

    const CSS = `
/* 1) 侧栏视口自己不滚：导航区与工作区各滚各的 */
[data-sidebar-scrollport] {
  display: flex !important;
  flex-direction: column !important;
  align-content: stretch !important;
  overflow: hidden !important;
}
[data-sidebar-scrollport] > nav {
  flex: 0 1 auto;
  min-height: 0;
  /* 导航区最多占满「视口减去给工作区预留的 232px」，两区都能自己滚 */
  max-height: var(--dswl-nav-max, calc(100% - 232px));
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  margin-bottom: 8px;
}
[data-sidebar-scrollport] > [class*="regionArea"] {
  flex: 1 1 auto;
  min-height: 200px;
  overflow: hidden;
}
/* 工作区根节点撑满这块区域，会话列表才有确定高度、才肯自己滚 */
[data-sidebar-scrollport] [class*="regionArea"] > * {
  flex: 1 1 auto !important;
  max-height: none !important;
  min-height: 0;
}

/* 2) 折叠态：工作区会话列表收起，导航区占满 */
[${STATE_ATTR}="1"] [data-sidebar-scrollport] > [class*="regionArea"] {
  flex: 0 0 auto !important;
}
[${STATE_ATTR}="1"] [data-sidebar-scrollport] [class*="listArea"] {
  display: none !important;
}
[${STATE_ATTR}="1"] [data-sidebar-scrollport] > nav {
  max-height: none;
  flex: 1 1 auto;
  margin-bottom: 8px;
}

/* 2b) 折叠按钮：跟 shell 的 24/28px 图标按钮同一套几何 */
.dswl-ws-toggle {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.dswl-ws-toggle:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dswl-ws-toggle:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
.dswl-ws-toggle svg {
  transition: transform 150ms var(--ds-ease-in-out, ease);
}
[${STATE_ATTR}="1"] .dswl-ws-toggle svg {
  transform: rotate(-90deg);
}
`

    const CHEVRON =
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
      '<path d="M4 6.5 8 10.5 12 6.5" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"/></svg>'

    const readCollapsed = () => {
      try {
        return window.localStorage.getItem(STATE_KEY) === '1'
      } catch {
        return false
      }
    }

    const writeCollapsed = (value) => {
      try {
        window.localStorage.setItem(STATE_KEY, value ? '1' : '0')
      } catch {
        /* 隐私模式下写不进去：本页仍然生效，只是刷新会丢 */
      }
    }

    const applyCollapsed = (collapsed) => {
      document.documentElement.setAttribute(STATE_ATTR, collapsed ? '1' : '0')
      const button = document.querySelector('.dswl-ws-toggle')
      if (button !== null) {
        button.setAttribute('aria-pressed', collapsed ? 'true' : 'false')
        button.setAttribute('aria-label', collapsed ? '展开工作区会话' : '折叠工作区会话')
        button.title = collapsed ? '展开工作区会话' : '折叠工作区会话'
      }
    }

    /** 滚轮守卫：导航区自己滚，别让 shell 的滚动接力把它转给工作区列表。 */
    const guardNavWheel = (nav) => {
      if (nav === null || nav.hasAttribute(NAV_ATTR)) return
      nav.setAttribute(NAV_ATTR, '1')
      nav.addEventListener('wheel', (event) => {
        event.stopPropagation()
      }, { passive: true })
    }

    /**
     * 把折叠按钮塞进工作区小标题行。
     * 别的插件也可能往这一行插东西（本机就有 dsh-claude 的视图切换），所以按钮
     * 排在最后，且用 `:scope >` 判断，不去动别人的节点。
     */
    const ensureButton = (header) => {
      if (header.querySelector(':scope > .dswl-ws-toggle') !== null) return
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'dswl-ws-toggle'
      button.innerHTML = CHEVRON
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        const next = document.documentElement.getAttribute(STATE_ATTR) !== '1'
        writeCollapsed(next)
        applyCollapsed(next)
      })
      header.appendChild(button)
      applyCollapsed(readCollapsed())
    }

    /** 一次对齐：视口在不在、导航要不要守卫、按钮要不要补。 */
    const sync = () => {
      const viewport = document.querySelector('[data-sidebar-scrollport]')
      if (viewport === null) return
      const nav = viewport.querySelector(':scope > nav')
      if (nav !== null) guardNavWheel(nav)
      const region = Array.prototype.find.call(
        viewport.children,
        (child) => child.tagName !== 'NAV',
      )
      if (region === undefined || region === null) return
      const header = region.querySelector('[class*="sectionHeader"]')
      if (header !== null) ensureButton(header)
    }

    const install = () => {
      const tag = document.createElement('style')
      tag.dataset.plugin = '@local/dsh-sidebar-layout'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)

      applyCollapsed(readCollapsed())
      sync()

      let frame = 0
      const schedule = () => {
        if (frame !== 0) return
        frame = window.requestAnimationFrame(() => {
          frame = 0
          sync()
        })
      }
      const observer = new MutationObserver(schedule)
      observer.observe(document.body, { childList: true, subtree: true })
      // 侧栏折叠/展开会整棵重挂，宽度变化也值得重排一次。
      window.addEventListener('resize', schedule)

      // 另一个标签页切了折叠状态：这边跟着走。
      const onStorage = (event) => {
        if (event.key !== STATE_KEY) return
        applyCollapsed(event.newValue === '1')
      }
      window.addEventListener('storage', onStorage)

      return () => {
        observer.disconnect()
        window.removeEventListener('resize', schedule)
        window.removeEventListener('storage', onStorage)
        if (frame !== 0) window.cancelAnimationFrame(frame)
        for (const button of document.querySelectorAll('.dswl-ws-toggle')) button.remove()
        document.documentElement.removeAttribute(STATE_ATTR)
        tag.remove()
      }
    }

    return {
      inject: [],
      apply(ctx) {
        ctx.effect(() => install(), 'dsh-sidebar-layout: sidebar split scroll + workspace collapse')
      },
    }
  },
})