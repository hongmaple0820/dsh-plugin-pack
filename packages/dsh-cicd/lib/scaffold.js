import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parsePipe } from './pipe.js'

/**
 * V2-M0：pipe.yml 脚手架模板库；v3.0-P6-2 扩成模板中心。
 *
 * 每种模板都产出一个能直接通过 parsePipe 的最小可运行流水线（build → release 两段）。
 * 模板只给起点，用户随后在编辑器里改。模板全是纯数据（没有可执行内容），
 * 所以「另存为模板」只是把仓库里的 pipe.yml 抽成一条数据、之后照样走同一套渲染。
 *
 * 解析器只认内联数组（`hosts: [a, b]`、`artifacts: ["x"]`），所以这里统一用内联写法。
 */

/** 内置模板。id 是稳定契约（Host 的 /project-create?kind= 直接用它）。 */
export const SCAFFOLD_KINDS = [
  { id: 'static', name: '静态站点 / 产物包', runtime: 'static', description: '打包成 tgz 上传，不重启服务', language: 'HTML/CSS/JS' },
  { id: 'node', name: 'Node.js', runtime: 'node', description: 'npm 构建 + pm2 重启', language: 'JavaScript' },
  { id: 'python', name: 'Python', runtime: 'python', description: 'pip 安装 + systemd --user 重启', language: 'Python' },
  { id: 'go', name: 'Go', runtime: 'static', description: 'go build 出二进制', language: 'Go' },
  { id: 'java', name: 'Java', runtime: 'java', description: 'Maven 打包 + systemd 重启', language: 'Java' },
  { id: 'php', name: 'PHP', runtime: 'php', description: 'Composer 安装 + php-fpm 重载', language: 'PHP' },
  { id: 'rust', name: 'Rust', runtime: 'static', description: 'cargo build --release 出二进制', language: 'Rust' },
  { id: 'docker', name: '容器镜像', runtime: 'static', description: 'docker build 出镜像，按 digest 发布', language: 'Dockerfile' },
  { id: 'bare', name: '空白模板', runtime: 'static', description: '只有一段 echo，改造成自己的流程', language: '' },
]

const BUILDS = {
  static: { command: 'tar -czf dist.tgz .', artifacts: ['dist.tgz'] },
  node: { command: 'npm ci && npm run build', artifacts: ['dist/**'] },
  python: { command: 'pip install -r requirements.txt', artifacts: ['app/**'] },
  go: { command: 'go build -o bin/app .', artifacts: ['bin/**'] },
  java: { command: 'mvn -B package -DskipTests', artifacts: ['target/*.jar'] },
  php: { command: 'composer install --no-dev --optimize-autoloader', artifacts: ['app/**'] },
  rust: { command: 'cargo build --release', artifacts: ['target/release/app'] },
  docker: { command: 'docker build -t "$IMAGE" .', artifacts: ['docker/**'] },
  bare: { command: "echo 'hello from dsh-cicd'", artifacts: ['dist.tgz'] },
}

/** 模板默认 target 名：刻意不叫 prod（见 scaffoldPipe 里的说明）。 */
export const SCAFFOLD_TARGET = 'default'

/** 需要 app 名字写进 target 的运行时装法（其余模板 app 留空，避免发布到不存在的目录）。 */
const APP_KINDS = new Set(['node', 'python', 'go', 'java', 'php'])

function flow(items) {
  return `[${items.map((item) => `"${String(item).replaceAll('"', '\\"')}"`).join(', ')}]`
}

/**
 * 一条模板的形状。template 省略时按 kind 取内置模板；
 * 用户「另存为模板」时只传 name/kind/description，其余字段由这里补齐。
 */
export function normalizeTemplate(input = {}) {
  const id = String(input.id || input.name || 'template').trim() || 'template'
  const base = SCAFFOLD_KINDS.find((item) => item.id === (input.kind || input.id)) || null
  return {
    id,
    name: String(input.name || base?.name || id),
    kind: String(input.kind || base?.id || 'bare'),
    description: String(input.description || ''),
    language: String(input.language || base?.language || ''),
    runtime: String(input.runtime || base?.runtime || 'static'),
    custom: input.custom === true,
    createdAt: String(input.createdAt || ''),
  }
}

/**
 * 模板 → pipe.yml 文本。
 *
 * template 可以是内置 id、模板对象，或 null（= 走旧的 kind 行为）。
 * 所有分支都只产出「能通过 parsePipe」的文本：模板仓库里读到的坏文本不会被这里修复，
 * 它会在编辑器的 /validate 里报出来 —— 这正是模板该给用户看的东西。
 */
export function scaffoldPipe({
  name = 'demo',
  kind = 'static',
  hosts = ['host1'],
  path = `/srv/${name}`,
  template = null,
} = {}) {
  const resolved = template ? normalizeTemplate(template) : null
  const templateId = resolved ? resolved.kind : kind
  const preset = SCAFFOLD_KINDS.find((item) => item.id === templateId) || SCAFFOLD_KINDS[0]
  const runtime = resolved?.runtime || preset.runtime
  const app = APP_KINDS.has(templateId) ? name : ''
  const build = BUILDS[templateId] || BUILDS.static
  const hostList = Array.isArray(hosts) && hosts.length ? hosts : ['host1']

  // 模板的 target 名**不能**叫 prod：prod 是"约定即存在"的受保护环境，没有 allowedActors
  // 就谁都不许发（见 lib/environments.js 的 ENV_GUARD_NO_ALLOWLIST），审批闸门也自动落在这上面。
  // 模板是"从零到第一次发布"的起点，第一次发布不该被自己的脚手架拦住 —— 所以要发生产，
  // 是用户把 target 改名成 prod（或加 protected）并配好名单/审批这一步显式动作。
  // 路径与 app 名仍按用户填的写死，目标代号只用来当部署锁与 release 目录的键。
  const lines = [
    'version: 1',
    `name: ${name}`,
    'targets:',
    `  ${SCAFFOLD_TARGET}:`,
    `    hosts: ${flow(hostList)}`,
    `    path: ${path}`,
    `    runtime: ${runtime}`,
    ...(app ? [`    app: ${app}`] : []),
    '    keep: 5',
    'stages:',
    '  - id: build',
    '    steps:',
    '      - name: build',
    `        run: ${build.command}`,
    '  - id: release',
    '    needs: [build]',
    '    steps:',
    '      - name: ship',
    '        deploy:',
    `          target: ${SCAFFOLD_TARGET}`,
    `          artifacts: ${flow(build.artifacts)}`,
  ]
  return `${lines.join('\n')}\n`
}

/** 模板 id → 目录名：和项目 id 一样只留 [a-z0-9-]，否则 ../ 就能写到仓库外。 */
export function templateSlug(value) {
  const slug = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return slug || 'template'
}

/** 模板仓库目录：<workDir>/templates。 */
export function templatesDirOf(workDir) {
  return join(String(workDir || '.'), 'templates')
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/** 仓库里的一条模板：meta.json + pipe.yml。坏掉时带 problems 照常返回。 */
function readStoredTemplate(dir, id) {
  const meta = readJson(join(dir, id, 'meta.json')) || {}
  const pipePath = join(dir, id, 'pipe.yml')
  let source = ''
  const problems = []
  try { source = readFileSync(pipePath, 'utf8') } catch { problems.push('模板目录里没有 pipe.yml') }
  if (source) {
    try { parsePipe(source) } catch (error) { problems.push(String(error?.message || '模板文本解析失败')) }
  }
  const shape = normalizeTemplate({
    id: String(meta.id || id),
    name: meta.name,
    kind: meta.kind,
    description: meta.description,
    language: meta.language,
    runtime: meta.runtime,
    createdAt: meta.createdAt,
    custom: true,
  })
  return { ...shape, source, custom: true, problems }
}

/** 全部模板：内置（只给元数据，文本按需渲染）+ 仓库（带文本）。 */
export function listTemplates(options = {}) {
  const dir = templatesDirOf(options.workDir)
  const stored = []
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      stored.push(readStoredTemplate(dir, entry.name))
    }
  }
  stored.sort((a, b) => String(a.name).localeCompare(String(b.name)))
  const builtin = SCAFFOLD_KINDS.map((item) => ({ ...normalizeTemplate({ id: item.id, name: item.name, kind: item.id, description: item.description, language: item.language, runtime: item.runtime }), custom: false, problems: [], source: '' }))
  return { dir, templates: [...builtin, ...stored], builtin: builtin.length, custom: stored.length }
}

/** 单条模板：内置模板按目标项目名字现渲染，仓库模板带文本；找不到返回 null。 */
export function readTemplate(options = {}, id = '', { name = 'demo' } = {}) {
  const raw = String(id || '').trim()
  if (!raw) return null
  const dir = templatesDirOf(options.workDir)
  const slug = templateSlug(raw)
  if (existsSync(join(dir, slug))) return readStoredTemplate(dir, slug)
  const preset = SCAFFOLD_KINDS.find((item) => item.id === raw)
  if (!preset) return null
  return { ...normalizeTemplate({ id: preset.id, name: preset.name, kind: preset.id, description: preset.description, language: preset.language, runtime: preset.runtime }), source: scaffoldPipe({ name, kind: preset.id }), custom: false, problems: [] }
}

/** createProject / 路由用的快捷查找：内置或仓库都能找到，找不到给 null（退回按 kind 渲染）。 */
export function findTemplate(options = {}, id = '', extra = {}) {
  return readTemplate(options, id, extra)
}

/** 另存为模板：写 meta.json + pipe.yml。同名覆盖，模板目录跟着模板走。 */
export function writeTemplate(options = {}, { id = '', name = '', description = '', kind = '', source = '' } = {}) {
  const text = String(source || '')
  if (!text.trim()) throw Object.assign(new Error('模板文本为空'), { code: 'TEMPLATE_SOURCE_REQUIRED' })
  const slug = templateSlug(id || name)
  const dir = templatesDirOf(options.workDir)
  const target = join(dir, slug)
  mkdirSync(target, { recursive: true })
  const shape = normalizeTemplate({ id: slug, name: name || id || slug, kind, description, custom: true })
  const meta = { ...shape, createdAt: new Date().toISOString() }
  writeFileSync(join(target, 'pipe.yml'), text, 'utf8')
  writeFileSync(join(target, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8')
  return { ...meta, source: text, problems: [], path: target }
}

/** 删模板：只删仓库里的（内置删不掉），删完目录不存在即成功。 */
export function removeTemplate(options = {}, id = '') {
  const slug = templateSlug(id)
  const target = join(templatesDirOf(options.workDir), slug)
  if (!existsSync(target)) return { removed: false, id: slug }
  rmSync(target, { recursive: true, force: true })
  return { removed: true, id: slug }
}
