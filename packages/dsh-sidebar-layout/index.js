/**
 * @local/dsh-sidebar-layout · Host 半边（占位）。
 *
 * 这个包全部工作在浏览器侧（client.js）：把左侧栏的「全局面板导航」与
 * 「工作区会话」拆成两个各自滚动的区域，并给工作区加一个一键折叠按钮。
 *
 * Host 侧不需要工具、不需要路由、不需要配置 —— 之所以仍然导出 apply，
 * 是因为 bundle 的 cordis.patch.yml 需要插入一个插件条目（客户端扩展由
 * package.json 的 dsh.client 声明，跟这个条目各自独立生效）。
 */

/** 没有依赖任何 Host 服务。 */
export const inject = []

export const name = '@local/dsh-sidebar-layout'

/**
 * 空实现：本包在 Host 侧不做任何事。
 * 保留它，是为了 patch 里那条 insert 有落点，也让 `test/mount.mjs` 能验证
 * 「这个包确实能被挂载」。
 */
export function apply(ctx) {
  ctx?.logger?.debug?.('dsh-sidebar-layout: 布局调整全在客户端，Host 侧无操作')
}