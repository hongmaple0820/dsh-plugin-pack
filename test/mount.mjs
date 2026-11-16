// 无 Host 环境的挂载自检（Lead 的验收闸门）
// 用法：node test/mount.mjs [--exec]
// 做的事：把 packages/*/index.js 挂到一个假 ctx 上，检查工具契约 / 路由 / manifest / locale / icon。
// 不联网、不写文件、不碰 profile。--exec 会额外真跑不依赖远程主机的工具（会联网打 AIHOT）。

import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = 'F:/maple/dsh-plugin-pack'
const PKG_DIR = join(ROOT, 'packages')
const EXEC = process.argv.includes('--exec')

const problems = []
const notes = []
const fail = (msg) => problems.push(msg)
const ok = (msg) => notes.push(msg)

/** 最小可用 ctx：工具注册、effect、可选 webServer、日志。 */
function fakeCtx() {
  const registered = []
  const effects = []
  const routes = []
  const ctx = {
    tools: {
      register(definition, options) {
        registered.push({ definition, options })
        return () => registered.splice(registered.indexOf(definition), 1)
      },
    },
    get(name) {
      if (name === 'webServer') {
        return {
          register(route) {
            routes.push(route)
            return () => routes.splice(routes.indexOf(route), 1)
          },
          getOrigin: () => 'http://127.0.0.1:0',
          tapIndex: () => () => {},
        }
      }
      if (name === 'webServerOrigin') return undefined
      return undefined
    },
    effect(fn) {
      const disposer = fn()
      effects.push(disposer)
      return () => { if (typeof disposer === 'function') disposer() }
    },
    on() { return () => {} },
    logger: { debug() {}, info() {}, warn() {}, error() {}, success() {} },
    logger_: undefined,
    command() {},
  }
  ctx.logger = Object.assign(() => {}, ctx.logger)
  return { ctx, registered, effects, routes }
}

function checkJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
    fail(`${file}: JSON 解析失败 ${error.message}`); return undefined
  }
}

function checkLocale(dir, pkgName) {
  for (const lang of ['en', 'zh']) {
    const file = join(dir, 'locale', `${lang}.json`)
    if (!existsSync(file)) { fail(`${pkgName}: 缺 locale/${lang}.json`); continue }
    const json = checkJson(file)
    if (!json) continue
    const meta = json.meta || {}
    for (const key of ['title', 'description']) {
      if (typeof meta[key] !== 'string' || meta[key].trim() === '') fail(`${pkgName}: locale/${lang}.json meta.${key} 缺失或为空`)
    }
    if (lang === 'en' && typeof meta.title === 'string' && /^[A-Z][a-z]+ [A-Z]/.test(meta.title) === false && meta.title.split(' ').length > 3) {
      // 只是提醒，不算失败
      ok(`${pkgName}: en title = "${meta.title}"`)
    }
  }
}

function checkIcon(dir, pkgName) {
  const file = join(dir, 'icon.svg')
  if (!existsSync(file)) { fail(`${pkgName}: 缺 icon.svg`); return }
  const size = statSync(file).size
  if (size > 256 * 1024) fail(`${pkgName}: icon.svg 超过 256 KiB（${size}）`)
  if (!/<svg[\s>]/i.test(readFileSync(file, 'utf8'))) fail(`${pkgName}: icon.svg 不是 SVG`)
}

function checkManifest(dir, pkgName) {
  const file = join(dir, 'package.json')
  if (!existsSync(file)) { fail(`${pkgName}: 缺 package.json`); return undefined }
  const pkg = checkJson(file)
  if (!pkg) return undefined
  if (pkg.name !== pkgName) fail(`${pkgName}: package.json name = ${pkg.name}`)
  if (pkg.type !== 'module') fail(`${pkgName}: package.json 需要 "type": "module"`)
  if (!pkg.dsh?.bundle?.patch) fail(`${pkgName}: 缺 dsh.bundle.patch`)
  // 组合包（composition-only bundle）：自己没有 index.js/client.js，patch 只把别处已有的插件插进
  // profile。它不需要 exports/client/locale/icon，只是把别人的页面装进来。
  const compositionOnly = !existsSync(join(dir, 'index.js')) && !existsSync(join(dir, 'client.js'))
  const patchFile = join(dir, pkg.dsh?.bundle?.patch || 'cordis.patch.yml')
  if (compositionOnly && !pkg.dsh?.client) {
    if (!existsSync(patchFile)) { fail(`${pkgName}: patch 文件不存在`); return pkg }
    const text = readFileSync(patchFile, 'utf8')
    if (!text.includes('insert:')) fail(`${pkgName}: patch 缺 insert:`)
    if (!/^\s*-\s*id:\s*\S+/m.test(text)) fail(`${pkgName}: patch 里没有行 id`)
    if (!/@[a-z0-9][\w-]*\/[\w.-]+/i.test(text)) fail(`${pkgName}: patch 里没有插入任何包`)
    return pkg
  }
  if (!pkg.dsh?.client) fail(`${pkgName}: 缺 dsh.client（本包应该有页面）`)
  const exportsMap = pkg.exports || {}
  for (const key of ['.', './client']) {
    if (!exportsMap[key]) fail(`${pkgName}: exports 缺 ${key}`)
    else if (!existsSync(join(dir, exportsMap[key]))) fail(`${pkgName}: exports[${key}] -> ${exportsMap[key]} 不存在`)
  }
  checkLocale(dir, pkgName)
  checkIcon(dir, pkgName)
  if (!existsSync(patchFile)) fail(`${pkgName}: patch 文件不存在`)
  else {
    const text = readFileSync(patchFile, 'utf8')
    if (!text.includes('insert:')) fail(`${pkgName}: patch 缺 insert:`)
    if (!text.includes(`'${pkgName}'`) && !text.includes(`"${pkgName}"`)) fail(`${pkgName}: patch 里没引用包名 ${pkgName}`)
    if (!/^\s*-\s*id:\s*\S+/m.test(text)) fail(`${pkgName}: patch 里没有行 id`)
  }
  return pkg
}

function checkToolContract(pkgName, { definition: tool }) {
  const label = `${pkgName} / ${tool?.name || '<无名>'}`
  if (typeof tool?.name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(tool.name)) fail(`${label}: 工具名不合法`)
  if (typeof tool?.description !== 'string' || tool.description.trim().length < 8) fail(`${label}: description 太短`)
  if (tool?.parameters?.type !== 'object') fail(`${label}: parameters.type 必须是 object`)
  if (!tool?.output || typeof tool.output.schema !== 'object' || tool.output.schema === null) fail(`${label}: 缺 output.schema`)
  if (typeof tool?.output?.render !== 'function') fail(`${label}: 缺 output.render`)
  if (typeof tool?.execute !== 'function') fail(`${label}: 缺 execute`)
}

const dirs = existsSync(PKG_DIR)
  ? readdirSync(PKG_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  : []

if (dirs.length === 0) fail('packages/ 下没有子目录')

const seenToolNames = new Map()
const mounted = []

for (const dirName of dirs) {
  const dir = join(PKG_DIR, dirName)
  const pkg = checkManifest(dir, `@local/${dirName}`) || {}
  const pkgName = pkg.name || dirName
  const entry = join(dir, 'index.js')
  if (!existsSync(entry)) {
    // 组合包没有自己的入口：它只是把别处已有的插件插进 profile，能在装包时生效即可。
    if (!pkg.exports?.['.'] && !pkg.dsh?.client) { ok(`${pkgName}: 组合包（只插入现有插件，无自有入口）`); continue }
    fail(`${pkgName}: 缺 index.js`); continue
  }

  let mod
  try {
    mod = await import(pathToFileURL(entry).href)
  } catch (error) {
    fail(`${pkgName}: index.js 导入失败 ${error.message}`); continue
  }
  if (typeof mod.apply !== 'function') { fail(`${pkgName}: 缺 export function apply`); continue }
  // 纯客户端包（只有 client.js 干活）不注册工具，也就不需要 inject 'tools'；
  // 只有真的注册了工具的包才必须声明依赖（下面 registered 循环之后校验）。
  if (mod.inject !== undefined && !Array.isArray(mod.inject)) fail(`${pkgName}: inject 必须是数组`)

  const { ctx, registered, routes } = fakeCtx()
  try {
    await mod.apply(ctx, {})
  } catch (error) {
    fail(`${pkgName}: apply() 抛错 ${error.message}`); continue
  }

  for (const item of registered) {
    checkToolContract(pkgName, item)
    const name = item.definition?.name
    if (name) {
      if (seenToolNames.has(name)) fail(`工具名重复：${name}（${seenToolNames.get(name)} 与 ${pkgName}）`)
      else seenToolNames.set(name, pkgName)
    }
  }
  if (registered.length > 0 && !(Array.isArray(mod.inject) && mod.inject.includes('tools'))) {
    fail(`${pkgName}: 注册了工具但 inject 缺 'tools'`)
  }

  const routerPrefix = dirName === 'dsh-remote' ? '/api/plugins/remote/' : dirName === 'dsh-aihot' ? '/api/plugins/aihot/' : undefined
  for (const route of routes) {
    if (!['exact', 'prefix'].includes(route.kind)) fail(`${pkgName}: 路由 kind 只能是 exact/prefix`)
    if (typeof route.path !== 'string' || !route.path.startsWith('/')) fail(`${pkgName}: 路由 path 必须以 / 开头`)
    if (routerPrefix && !route.path.startsWith(routerPrefix)) fail(`${pkgName}: 路由 ${route.path} 越界（应为 ${routerPrefix}* ）`)
    // webserver 只服务 GET/HEAD（POST 在 carrier 层就被 405），所以路由必须是 resource。
    const hasResource = typeof route.resource === 'function'
    const hasHandler = typeof route.handler === 'function'
    if (hasHandler) fail(`${pkgName}: 路由 ${route.path} 不要用 handler——carrier 只服务 GET/HEAD，写操作走 GET+自定义头`)
    if (!hasResource) fail(`${pkgName}: 路由 ${route.path} 需要 resource()`)
  }

  mounted.push({ pkgName, dir, mod, ctx, registered, routes })
  ok(`${pkgName}: 工具 ${registered.length} 个，路由 ${routes.length} 条`)
}

// 业务预期计数
const remote = mounted.find((item) => item.pkgName === '@local/dsh-remote')
const aihot = mounted.find((item) => item.pkgName === '@local/dsh-aihot')
if (remote && remote.registered.length < 12) fail(`@local/dsh-remote 工具数 ${remote.registered.length} < 12`)
if (aihot && aihot.registered.length < 8) fail(`@local/dsh-aihot 工具数 ${aihot.registered.length} < 8`)
for (const item of mounted) {
  const names = item.registered.map(({ definition }) => definition.name)
  if (item.pkgName === '@local/dsh-remote' && !names.some((name) => name.startsWith('remote_'))) fail('@local/dsh-remote 工具名需要 remote_* 前缀')
  if (item.pkgName === '@local/dsh-aihot' && !names.some((name) => name.startsWith('aihot_'))) fail('@local/dsh-aihot 工具名需要 aihot_* 前缀')
}

// 真跑：只跑不依赖远程主机、不需要凭据的工具
if (EXEC) {
  for (const item of mounted) {
    if (item.pkgName !== '@local/dsh-aihot') continue
    for (const { definition } of item.registered) {
      if (!['aihot_latest', 'aihot_hot'].includes(definition.name)) continue
      try {
        const value = await definition.execute({ limit: 2 }, { signal: AbortSignal.timeout(30_000) })
        const content = definition.output.render({}, value)
        const text = content.map((block) => block.text || '').join('\n')
        if (!text || text.length < 20) fail(`${definition.name}: 返回内容太短`)
        else ok(`${definition.name}: OK（${text.length} 字符）`)
      } catch (error) {
        fail(`${definition.name}: 执行失败 ${error.message}`)
      }
    }
  }
}

console.log('--- 通过/说明 ---')
for (const line of notes) console.log('  ✓ ' + line)
if (problems.length > 0) {
  console.log('--- 问题 ---')
  for (const line of problems) console.log('  ✗ ' + line)
  process.exitCode = 1
} else {
  console.log(`\n全部通过：${mounted.length} 个 bundle，${seenToolNames.size} 个工具。`)
}