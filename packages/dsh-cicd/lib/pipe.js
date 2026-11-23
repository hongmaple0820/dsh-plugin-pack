/**
 * `pipe.yml` parser and planner.
 *
 * Deliberately a restricted YAML subset: two-space indentation, maps, sequences, scalars,
 * comments, inline arrays and quoted strings. Anchors, block scalars, flow maps and
 * multi-document streams are rejected with a Chinese error that names the line.
 */

export class PipeError extends Error {
  constructor(message, { line = 0, code = 'PIPE_INVALID' } = {}) {
    super(line > 0 ? `第 ${line} 行：${message}` : message)
    this.name = 'PipeError'
    this.code = code
    this.line = line
  }
}

import { normalizeTriggers } from './triggers.js'

export const RUNTIME_VALUES = ['static', 'node', 'python', 'go', 'php', 'docker']
const RUNTIME_SET = new Set(RUNTIME_VALUES)
const APP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@:/-]*$/
// registry[:port]/namespace/name — 小写、无 tag、无 digest。docker 自己定的形状，抄一份而不是自创。
const DOCKER_IMAGE_PATTERN = /^[a-z0-9]+(?:(?:[._-]|:)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._-])[a-z0-9]+)*)*$/
const HOST_FAILURE_VALUES = new Set(['stop', 'continue'])
// v3.0-P3：三种模式各有自己的 Actuator（lib/actuator/{native,container,k8s}.js），
// 共用 release / rollback / manifest 语义，只把「怎么激活」这一段分出去。
export const DEPLOY_MODES = new Set(['native', 'container', 'k8s'])
// K8s 对象名与容器名同一条规则（RFC 1123 label）。猜名字的成本是 rollout status 挂五分钟。
const WORKLOAD_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const K8S_KINDS = new Set(['Deployment', 'Rollout'])

// image 去掉 tag 部分：registry:5000/a/b:1.2.3 → registry:5000/a/b
export function k8sRepositoryOf(image) {
  return String(image || '').trim().replace(/:[^/:]+$/, '')
}

function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Runtime presets are only used when a target has neither `restart` nor `service`.
 * Every generated command ends with `|| true` so a restart failure is reported by the
 * health check / logs instead of aborting a half-applied multi-host release.
 */
export function defaultRestartCommand(runtime, app = '', fallbackName = '') {
  const name = String(app || fallbackName || '').trim()
  const q = name ? quote(name) : ''
  if (runtime === 'node') {
    return `pm2 restart ${q} || systemctl --user restart ${q} || sudo -n systemctl restart ${q} || true`
  }
  if (runtime === 'python' || runtime === 'go' || runtime === 'php') {
    return `systemctl --user restart ${q} || sudo -n systemctl restart ${q} || true`
  }
  if (runtime === 'docker') {
    return name
      ? `docker restart ${q} || docker compose up -d --no-build || true`
      : 'docker compose up -d --no-build || true'
  }
  return ''
}

const UNSUPPORTED_START = new Map([
  ['&', '锚点（&）'],
  ['*', '锚点引用（*）'],
  ['|', '多行块（|）'],
  ['>', '折叠块（>）'],
  ['{', '流式 map（{…}）'],
])

function stripComment(text) {
  let quote = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === quote && text[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i).trimEnd()
  }
  return text.trimEnd()
}

function prepare(source) {
  const rawLines = String(source).replace(/\r\n?/g, '\n').split('\n')
  const lines = []
  for (let index = 0; index < rawLines.length; index += 1) {
    const withoutComment = stripComment(rawLines[index])
    if (!withoutComment.trim()) continue
    if (withoutComment.includes('\t')) throw new PipeError('缩进不能用制表符，请使用 2 个空格', { line: index + 1 })
    const indent = withoutComment.length - withoutComment.trimStart().length
    if (indent % 2 !== 0) throw new PipeError('缩进必须是 2 个空格的倍数', { line: index + 1 })
    lines.push({ number: index + 1, indent, text: withoutComment.trim() })
  }
  return lines
}

function splitKeyValue(text, line) {
  let quote = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === quote && text[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === ':') {
      if (i + 1 < text.length && text[i + 1] !== ' ') {
        if (!/^[A-Za-z_]\w*$/.test(text.slice(0, i).trim())) continue
      }
      const key = text.slice(0, i).trim()
      if (!key) throw new PipeError('缺少键名', { line })
      if (!/^[A-Za-z_][\w-]*$/.test(key)) {
        throw new PipeError(`不支持的键名 “${key}”（只允许字母、数字、下划线、短横线）`, { line })
      }
      return { key, rest: text.slice(i + 1).trim() }
    }
  }
  return null
}

function parseQuoted(text, line) {
  const quote = text[0]
  if (text[text.length - 1] !== quote || text.length < 2) throw new PipeError('引号没有闭合', { line })
  const body = text.slice(1, -1)
  if (quote === "'") return body.replace(/''/g, "'")
  try { return JSON.parse(`"${body.replace(/\\/g, '\\\\').replace(/\\"/g, '"').replace(/\\\\"/g, '\\"')}"`) } catch {
    throw new PipeError('双引号字符串包含无法解析的转义', { line })
  }
}

function splitInline(body, line) {
  const parts = []
  let quote = null
  let start = 0
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (quote) {
      if (ch === quote && body[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === ',') { parts.push(body.slice(start, i).trim()); start = i + 1 }
  }
  parts.push(body.slice(start).trim())
  if (parts.some((part) => part === '')) throw new PipeError('内联数组里有空项', { line })
  return parts
}

function parseScalar(text, line) {
  const value = text.trim()
  if (!value) return ''
  const first = value[0]
  if (first === '\'' || first === '"') {
    if (value.length > 1 && value[value.length - 1] === first) return parseQuoted(value, line)
    throw new PipeError('引号没有闭合', { line })
  }
  if (first === '[') {
    if (value[value.length - 1] !== ']') throw new PipeError('内联数组缺少 ]', { line })
    const body = value.slice(1, -1).trim()
    return body ? splitInline(body, line).map((part) => parseScalar(part, line)) : []
  }
  if (UNSUPPORTED_START.has(first)) throw new PipeError(`暂不支持 ${UNSUPPORTED_START.get(first)}`, { line })
  if (/^(true|True|TRUE)$/.test(value)) return true
  if (/^(false|False|FALSE)$/.test(value)) return false
  if (/^(null|Null|NULL|~)$/.test(value)) return null
  if (/^-?\d+$/.test(value)) return Number(value)
  if (/^-?\d+\.\d+$/.test(value)) return Number(value)
  return value
}

function parseBlock(lines, index, indent) {
  if (index >= lines.length) return { value: null, next: index }
  const line = lines[index]
  if (line.indent !== indent) throw new PipeError(`缩进不一致（预期 ${indent} 个空格）`, { line: line.number })
  return line.text === '-' || line.text.startsWith('- ') ? parseSequence(lines, index, indent) : parseMap(lines, index, indent)
}

function parseMap(lines, index, indent, firstPair = null) {
  const result = {}
  let i = index
  if (firstPair) {
    const { key, rest, line } = firstPair
    const nextLine = lines[i + 1]
    if (!rest && nextLine && nextLine.indent > indent) {
      const child = parseBlock(lines, i + 1, nextLine.indent)
      result[key] = child.value
      i = child.next
    } else {
      result[key] = rest ? parseScalar(rest, line) : null
      i += 1
    }
  }
  while (i < lines.length) {
    const line = lines[i]
    if (line.indent < indent) break
    if (line.indent > indent) throw new PipeError(`缩进比同级多 ${line.indent - indent} 个空格`, { line: line.number })
    if (line.text === '-' || line.text.startsWith('- ')) break
    const pair = splitKeyValue(line.text, line.number)
    if (!pair) throw new PipeError('这里应该是 “键: 值”', { line: line.number })
    const { key, rest } = pair
    if (Object.prototype.hasOwnProperty.call(result, key)) throw new PipeError(`重复的键 “${key}”`, { line: line.number })
    const nextLine = lines[i + 1]
    if (!rest && nextLine && nextLine.indent > indent) {
      const child = parseBlock(lines, i + 1, nextLine.indent)
      result[key] = child.value
      i = child.next
      continue
    }
    result[key] = rest ? parseScalar(rest, line.number) : null
    i += 1
  }
  return { value: result, next: i }
}

function parseSequence(lines, index, indent) {
  const list = []
  let i = index
  while (i < lines.length) {
    const line = lines[i]
    if (line.indent < indent) break
    if (line.indent !== indent) throw new PipeError('序列项的缩进不一致', { line: line.number })
    if (!(line.text === '-' || line.text.startsWith('- '))) break
    const content = line.text === '-' ? '' : line.text.slice(2).trim()
    if (!content) {
      const nextLine = lines[i + 1]
      if (nextLine && nextLine.indent > indent) {
        const child = parseBlock(lines, i + 1, nextLine.indent)
        list.push(child.value)
        i = child.next
      } else {
        list.push(null)
        i += 1
      }
      continue
    }
    const pair = splitKeyValue(content, line.number)
    if (pair) {
      const child = parseMap(lines, i, indent + 2, { ...pair, line: line.number })
      list.push(child.value)
      i = child.next
      continue
    }
    list.push(parseScalar(content, line.number))
    i += 1
  }
  return { value: list, next: i }
}

function asArray(value, label) {
  if (value === undefined || value === null || value === '') return []
  if (Array.isArray(value)) return value
  if (typeof value === 'string') return [value]
  throw new PipeError(`${label} 必须是数组`)
}

/** 主机选择器：`env:prod` / `group:api` / `tag:canary`（v0.5）。 */
export const HOST_SELECTOR_RE = /^(env|group|tag):([a-z0-9._-]{1,32})$/
const SELECTOR_PREFIX_RE = /^(env|group|tag):/

/** 判断一个 hosts 条目是不是选择器（只做语法形状判断，不展开）。 */
export function isHostSelector(value) {
  return typeof value === 'string' && HOST_SELECTOR_RE.test(value.trim())
}

/** 拆选择器为 `{kind, name}`；不是合法选择器时返回 null。 */
export function parseHostSelector(value) {
  if (typeof value !== 'string') return null
  const match = HOST_SELECTOR_RE.exec(value.trim())
  return match ? { kind: match[1], name: match[2] } : null
}

/** 把 target.hosts 拆成 `{hosts, selectors}`（保持原顺序）。 */
export function splitTargetHosts(hosts) {
  const list = Array.isArray(hosts) ? hosts.map((host) => String(host).trim()).filter(Boolean) : []
  return {
    selectors: list.filter((host) => HOST_SELECTOR_RE.test(host)),
    hostAliases: list.filter((host) => !HOST_SELECTOR_RE.test(host)),
    entries: list,
  }
}

function normalizeTarget(targetName, target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw new PipeError(`target ${targetName} 必须是 map`)
  const hosts = asArray(target.hosts, `target ${targetName} 的 hosts`).map((host) => {
    if (typeof host !== 'string' || !host.trim()) throw new PipeError(`target ${targetName} 的 hosts 必须是非空字符串`)
    const value = host.trim()
    // 选择器只能校验语法：真正展开要等 dsh-remote 运行时（部署前）才知道主机清单。
    if (HOST_SELECTOR_RE.test(value)) return value
    if (SELECTOR_PREFIX_RE.test(value)) {
      const [, kind] = SELECTOR_PREFIX_RE.exec(value)
      throw new PipeError(`target ${targetName} 的 hosts 选择器 “${value}” 不合法（${kind}: 后只允许 1-32 位小写字母、数字、点、下划线、连字符）`)
    }
    return value
  })
  if (hosts.length === 0) throw new PipeError(`target ${targetName} 的 hosts 不能为空`)
  if (new Set(hosts).size !== hosts.length) throw new PipeError(`target ${targetName} 的 hosts 有重复项`)

  const runtime = target.runtime === undefined || target.runtime === null || target.runtime === ''
    ? 'static'
    : String(target.runtime).trim()
  if (!RUNTIME_SET.has(runtime)) {
    throw new PipeError(`target ${targetName} 的 runtime “${runtime}” 不支持（可用 ${RUNTIME_VALUES.join('、')}）`)
  }
  const app = target.app === undefined || target.app === null ? '' : String(target.app).trim()
  if (app && !APP_PATTERN.test(app)) {
    throw new PipeError(`target ${targetName} 的 app “${app}” 不合法（只允许字母、数字、点、下划线、@、:、/、-）`)
  }
  if ((runtime === 'node' || runtime === 'python' || runtime === 'php') && !app) {
    throw new PipeError(`target ${targetName} 的 runtime ${runtime} 需要 app（服务名）`)
  }

  if (target.service !== undefined && (typeof target.service !== 'string' || !target.service.trim())) {
    throw new PipeError(`target ${targetName} 的 service 必须是非空字符串`)
  }
  if (target.restart !== undefined && (typeof target.restart !== 'string' || !target.restart.trim())) {
    throw new PipeError(`target ${targetName} 的 restart 必须是非空字符串`)
  }
  if (target.service && target.restart) throw new PipeError(`target ${targetName} 不能同时配置 service 与 restart`)


  if (target.onHostFailure !== undefined && !HOST_FAILURE_VALUES.has(String(target.onHostFailure))) {
    throw new PipeError(`target ${targetName} 的 onHostFailure 只有 stop 或 continue（收到 “${target.onHostFailure}”）`)
  }
  const onHostFailure = target.onHostFailure === 'continue' ? 'continue' : 'stop'

  const path = target.path === undefined || target.path === null ? '' : String(target.path)
  if (path && !path.startsWith('/')) throw new PipeError(`target ${targetName} 的 path 必须是绝对路径`)
  const keep = target.keep === undefined || target.keep === null ? 5 : target.keep
  if (!Number.isInteger(keep) || keep < 1) throw new PipeError(`target ${targetName} 的 keep 必须是正整数`)

  if (target.health !== undefined && (typeof target.health !== 'object' || Array.isArray(target.health))) {
    throw new PipeError(`target ${targetName} 的 health 必须是 map`)
  }
  if (target.health?.http !== undefined && typeof target.health.http !== 'string') {
    throw new PipeError(`target ${targetName} 的 health.http 必须是字符串`)
  }
  if (target.health?.tries !== undefined && (!Number.isInteger(target.health.tries) || target.health.tries < 1)) {
    throw new PipeError(`target ${targetName} 的 health.tries 必须是正整数`)
  }
  if (target.health?.interval !== undefined && !['string', 'number'].includes(typeof target.health.interval)) {
    throw new PipeError(`target ${targetName} 的 health.interval 必须是字符串或数字`)
  }
  if (target.health?.window !== undefined && !['string', 'number'].includes(typeof target.health.window)) {
    throw new PipeError(`target ${targetName} 的 health.window 必须是字符串或数字`)
  }
  if (target.health?.expect !== undefined && (!Number.isInteger(target.health.expect) || target.health.expect < 100 || target.health.expect > 599)) {
    throw new PipeError(`target ${targetName} 的 health.expect 必须是 100-599 的 HTTP 状态码`)
  }

  // v3.0-P3：mode 只决定「用哪个激活器」；不认识的值直接拒绝，而不是悄悄退回 native ——
  // 用户写 mode: k8s 却拿到 symlink 部署，是那种「看起来成功、生产其实没换」的失败。
  const mode = target.mode === undefined || target.mode === null || target.mode === ''
    ? 'native'
    : String(target.mode).trim().toLowerCase()
  if (!DEPLOY_MODES.has(mode)) {
    throw new PipeError(`target ${targetName} 的 mode “${target.mode}” 不支持（可用 ${[...DEPLOY_MODES].join('、')}）`)
  }
  // 容器由 docker run 起，没有「重启命令」这回事；配了它的人以为自己能改变启动方式，实际上会被忽略。
  if (mode === 'container' && (target.service || target.restart)) {
    throw new PipeError(`target ${targetName} 的 mode 是 container，容器由 docker run 启动，不能配置 service / restart（删掉它们，或改回 mode: native）`)
  }

  // v3.0-P3：实例不是「副本数」而是端口 + pid + 日志。count 必须显式给，
  // 端口基址必须显式给 —— 猜一个 8080 出来，就会与用户机器上别的东西抢端口。
  let instances = null
  if (target.instances !== undefined && target.instances !== null && target.instances !== '') {
    if (typeof target.instances !== 'object' || Array.isArray(target.instances)) {
      throw new PipeError(`target ${targetName} 的 instances 必须是 map`)
    }
    const count = target.instances.count
    if (!Number.isInteger(count) || count < 1 || count > 512) {
      throw new PipeError(`target ${targetName} 的 instances.count 必须是 1-512 的整数`)
    }
    // 容器不挑宿主机端口（-p 0 由 docker 分配再读回），所以 instances.port 只对 native 有意义。
    let portRange = null
    if (mode !== 'container') {
      const portSpec = target.instances.port
      if (!portSpec || typeof portSpec !== 'object' || Array.isArray(portSpec)) {
        throw new PipeError(`target ${targetName} 的 instances.port 必须是 map（含 base，可选 step）`)
      }
      const base = portSpec.base
      if (!Number.isInteger(base) || base < 1 || base > 65535) {
        throw new PipeError(`target ${targetName} 的 instances.port.base 必须是 1-65535 的整数`)
      }
      const step = portSpec.step === undefined || portSpec.step === null ? 1 : portSpec.step
      if (!Number.isInteger(step) || step < 1 || step > 1000) {
        throw new PipeError(`target ${targetName} 的 instances.port.step 必须是 1-1000 的整数`)
      }
      // 越界在这里就报，不留到部署时让第一个实例起在 70000 上。
      const lastPort = base + step * (count - 1)
      if (lastPort > 65535) {
        throw new PipeError(`target ${targetName} 的实例端口会越界（${base} + ${step} × ${count - 1} = ${lastPort} > 65535）`)
      }
      portRange = { base, step }
    }
    if (target.instances.weight !== undefined) {
      const weight = target.instances.weight
      if (!Number.isInteger(weight) || weight < 0 || weight > 100) {
        throw new PipeError(`target ${targetName} 的 instances.weight 必须是 0-100 的整数`)
      }
    }
    const instanceEnv = target.instances.env
    if (instanceEnv !== undefined && (typeof instanceEnv !== 'object' || Array.isArray(instanceEnv))) {
      throw new PipeError(`target ${targetName} 的 instances.env 必须是 map`)
    }
    const instanceLog = target.instances.log
    if (instanceLog !== undefined && typeof instanceLog !== 'string') {
      throw new PipeError(`target ${targetName} 的 instances.log 必须是字符串模板`)
    }
    let drain = null
    if (target.instances.drain !== undefined && target.instances.drain !== null && target.instances.drain !== '') {
      if (typeof target.instances.drain !== 'object' || Array.isArray(target.instances.drain)) {
        throw new PipeError(`target ${targetName} 的 instances.drain 必须是 map`)
      }
      // 0 是合法值（「不等」/「立刻升级到 KILL」），但 parseDuration 把它当非法时长，
      // 所以关闭语义单独判，别让一个诚实的 0 变成解析错误。
      const drainValue = (value, fallback) => {
        if (value === undefined || value === null || value === '') return fallback
        if (Number(value) === 0) return 0
        return parseDuration(value, fallback)
      }
      drain = {
        delay: drainValue(target.instances.drain.delay, 5),
        timeout: drainValue(target.instances.drain.timeout, 30),
      }
    }
    instances = {
      count,
      port: portRange,
      weight: target.instances.weight === undefined ? null : target.instances.weight,
      env: instanceEnv || {},
      log: instanceLog || '',
      drain,
    }
    // v3.0-P3：容器由 docker run 起，没有「重启命令模板」这回事；端口也由 docker 分配，
    // 要求 instances.port 是一次「猜一个 8080 出来」的强制——那正是容器部署要避免的抢端口。
    if (mode !== 'container' && !target.restart) {
      throw new PipeError(`target ${targetName} 声明了 instances 就必须给 restart 命令模板（可用 {{.port}} / {{.slot}} / {{.host}} / {{.release}} / {{.app}} / {{.instance}} / {{.index}}）`)
    }
  }

  let canary = null
  if (target.canary !== undefined && target.canary !== null && target.canary !== '') {
    if (typeof target.canary !== 'object' || Array.isArray(target.canary)) {
      throw new PipeError(`target ${targetName} 的 canary 必须是 map`)
    }
    const first = target.canary.first === undefined || target.canary.first === null ? 1 : target.canary.first
    if (!Number.isInteger(first) || first < 1 || first > hosts.length) {
      throw new PipeError(`target ${targetName} 的 canary.first 必须是 1-${hosts.length} 的整数`)
    }
    const waitSec = target.canary.waitSec === undefined || target.canary.waitSec === null ? 30 : target.canary.waitSec
    if (!Number.isInteger(waitSec) || waitSec < 0 || waitSec > 3600) {
      throw new PipeError(`target ${targetName} 的 canary.waitSec 必须是 0-3600 的整数`)
    }
    canary = { first, waitSec }
  }

  let strategy = null
  if (target.strategy !== undefined && target.strategy !== null && target.strategy !== '') {
    if (typeof target.strategy !== 'object' || Array.isArray(target.strategy)) {
      throw new PipeError(`target ${targetName} 的 strategy 必须是 map`)
    }
    const sType = String(target.strategy.type || 'serial').toLowerCase()
    if (!['serial', 'parallel', 'rolling', 'canary', 'blue-green'].includes(sType)) {
      throw new PipeError(`target ${targetName} 的 strategy.type 只有 serial/parallel/rolling/canary/blue-green（收到 "${target.strategy.type}"）`)
    }
    strategy = {
      type: sType,
      batch: target.strategy.batch,
      waitSec: target.strategy.waitSec,
      first: target.strategy.first,
      onHostFailure: target.strategy.onHostFailure,
    }
  }

  let k8s = null

  // v3.0-P3：容器 target。image 与 container.port 是两件「只能由用户说、猜不得」的事：
  // 猜仓库名会把镜像发到别人的命名空间，猜容器内端口会让探针永远打在一个关闭的门上。
  let container = null
  if (mode === 'container') {
    const rawImage = String(target.image || '').trim()
    if (!rawImage) {
      throw new PipeError(`target ${targetName} 的 mode 是 container，必须给 image（如 registry.example.com/demo/web）`)
    }
    // 镜像名跟着 digest 走：写 <image>@sha256:… 或带 tag 都是误用，引用得在部署时由产物 digest 拼出来。
    if (rawImage.includes('@') || /:[^/]+$/.test(rawImage)) {
      throw new PipeError(`target ${targetName} 的 image “${rawImage}” 不能带 tag 或 digest；容器部署的镜像引用是 image@sha256:<产物 digest>`)
    }
    if (!DOCKER_IMAGE_PATTERN.test(rawImage)) {
      throw new PipeError(`target ${targetName} 的 image “${rawImage}” 不合法（registry[:port]/path 的小写形状）`)
    }
    if (target.container !== undefined && (typeof target.container !== 'object' || Array.isArray(target.container))) {
      throw new PipeError(`target ${targetName} 的 container 必须是 map`)
    }
    const containerPort = target.container?.port
    if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
      throw new PipeError(`target ${targetName} 的 container.port 必须是 1-65535 的整数（容器内监听的端口）`)
    }
    container = {
      image: rawImage,
      port: containerPort,
      pullTimeoutSec: target.container.pullTimeoutSec ?? 600,
      runTimeoutSec: target.container.runTimeoutSec ?? 120,
      args: asArray(target.container.args ?? [], `target ${targetName} 的 container.args`).map((entry) => String(entry)),
      volumes: asArray(target.container.volumes ?? [], `target ${targetName} 的 container.volumes`).map((entry) => String(entry)),
    }
  }


  // v3.0-P3-P7：K8s target。这里能配的都必须是集群里已有的名字 ——
  // 猜一个 Deployment 名会在 rollout status 上挂五分钟然后告诉你「没找到」，
  // 而那时候 patch 可能已经发出去了一半。
  if (mode === 'k8s') {
    if (target.service || target.restart) {
      throw new PipeError(`target ${targetName} 的 mode 是 k8s，起停由控制器负责，不能配置 service / restart`)
    }
    if (target.instances !== undefined && target.instances !== null && target.instances !== '') {
      // replicas 是 spec 里的字段，不是我们能挑的端口；两个概念不能混在一处。
      throw new PipeError(`target ${targetName} 的 mode 是 k8s，副本数写在 k8s.replicas，不能用 instances`)
    }
    if (target.container !== undefined) {
      throw new PipeError(`target ${targetName} 的 mode 是 k8s，容器相关配置写在 k8s 块里`)
    }
    if (target.k8s !== undefined && (typeof target.k8s !== 'object' || Array.isArray(target.k8s))) {
      throw new PipeError(`target ${targetName} 的 k8s 必须是 map`)
    }
    const rawK8s = target.k8s || {}
    const rawImage = String(target.image || '').trim()
    if (!rawImage) {
      throw new PipeError(`target ${targetName} 的 mode 是 k8s，必须给 image（如 registry.example.com/demo/web）`)
    }
    if (!DOCKER_IMAGE_PATTERN.test(k8sRepositoryOf(rawImage))) {
      throw new PipeError(`target ${targetName} 的 image “${rawImage}” 不合法（registry[:port]/path 的小写形状）`)
    }
    const workloadName = String(rawK8s.workload || targetName).trim()
    if (!WORKLOAD_NAME_PATTERN.test(workloadName)) {
      throw new PipeError(`target ${targetName} 的 k8s.workload “${workloadName}” 不是合法的 K8s 对象名（小写字母数字与 -）`)
    }
    const namespace = String(rawK8s.namespace || 'default').trim()
    if (!WORKLOAD_NAME_PATTERN.test(namespace)) {
      throw new PipeError(`target ${targetName} 的 k8s.namespace “${namespace}” 不合法`)
    }
    const kindValue = String(rawK8s.kind || 'Deployment').trim()
    if (!K8S_KINDS.has(kindValue)) {
      throw new PipeError(`target ${targetName} 的 k8s.kind “${kindValue}” 不支持（可用 ${[...K8S_KINDS].join('、')}）`)
    }
    const containerName = String(rawK8s.container || workloadName).trim()
    if (!WORKLOAD_NAME_PATTERN.test(containerName)) {
      throw new PipeError(`target ${targetName} 的 k8s.container “${containerName}” 不是合法的容器名`)
    }
    const replicas = rawK8s.replicas === undefined ? 1 : rawK8s.replicas
    if (!Number.isInteger(replicas) || replicas < 1 || replicas > 512) {
      throw new PipeError(`target ${targetName} 的 k8s.replicas 必须是 1-512 的整数`)
    }
    const progressDeadlineSec = rawK8s.progressDeadlineSec ?? 300
    if (!Number.isInteger(progressDeadlineSec) || progressDeadlineSec < 1 || progressDeadlineSec > 3600) {
      throw new PipeError(`target ${targetName} 的 k8s.progressDeadlineSec 必须是 1-3600 的整数（秒）`)
    }
    const rolloutTimeoutSec = rawK8s.rolloutTimeoutSec ?? progressDeadlineSec + 60
    if (!Number.isInteger(rolloutTimeoutSec) || rolloutTimeoutSec < 1 || rolloutTimeoutSec > 7200) {
      throw new PipeError(`target ${targetName} 的 k8s.rolloutTimeoutSec 必须是 1-7200 的整数（秒）`)
    }
    k8s = {
      kind: kindValue,
      namespace,
      workload: workloadName,
      container: containerName,
      replicas,
      progressDeadlineSec,
      rolloutTimeoutSec,
    }
  }
  // 环境（environment）升格：target 自动映射，带保护/审批标志
  const protected_ = targetName.toLowerCase() === 'prod' || target.protected === true
  const approvalRequired = targetName.toLowerCase() === 'prod' || target.approvalRequired === true

  // health 归一成固定形状：window 是 P3 新增的 L3 观察窗，expect 允许成功的非 200 状态码。
  // 原始 target.health 仍保留在 ...target 里，所以老字段一个都没丢。
  const health = {
    http: target.health?.http || '',
    tries: target.health?.tries === undefined ? 5 : target.health.tries,
    interval: target.health?.interval === undefined ? 2 : parseDuration(target.health.interval, 2),
    expect: target.health?.expect === undefined ? 0 : target.health.expect,
    // window: 0 是「不要观察窗」的显式写法，parseDuration 会把它当非法时长抛错，
    // 所以这一列单独判 0 —— 一个合法的「关闭」值不该被校验器拒绝。
    window: target.health?.window === undefined || Number(target.health.window) === 0
      ? 0
      : parseDuration(target.health.window, 0),
  }

  const restartCommand = target.restart || target.service ? '' : defaultRestartCommand(runtime, app, targetName)
  return {
    ...target,
    hosts,
    runtime,
    app,
    mode,
    container,
    k8s,
    instances,
    health,
    onHostFailure,
    keep,
    path,
    restartCommand,
    canary,
    strategy,
    protected: protected_,
    approvalRequired,
  }
}

export function parsePipe(source, { path = 'pipe.yml' } = {}) {
  if (typeof source !== 'string') throw new PipeError(`${path} 的内容必须是字符串`)
  const lines = prepare(source)
  if (lines.length === 0) throw new PipeError(`${path} 是空文件`)
  const root = parseBlock(lines, 0, lines[0].indent).value
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new PipeError('pipe 根节点必须是 map')

  const version = root.version ?? 1
  if (version !== 1 && version !== 2) {
    throw new PipeError(`不支持的 pipe 版本 ${version}（目前支持 version: 1 与 version: 2）`)
  }
  const name = typeof root.name === 'string' && root.name.trim() ? root.name.trim() : path
  const vars = root.vars ?? {}
  if (vars !== null && (typeof vars !== 'object' || Array.isArray(vars))) throw new PipeError('vars 必须是 map')
  const targets = root.targets ?? {}
  if (targets === null || typeof targets !== 'object' || Array.isArray(targets)) throw new PipeError('targets 必须是 map')
  const stages = root.stages
  if (!Array.isArray(stages) || stages.length === 0) throw new PipeError('stages 必须是非空数组')

  const targetNames = new Set()
  const normalizedTargets = {}
  for (const [targetName, target] of Object.entries(targets)) {
    normalizedTargets[targetName] = normalizeTarget(targetName, target)
    targetNames.add(targetName)
  }

  const stageIds = new Set()
  const normalizedStages = []
  for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
    const stage = stages[stageIndex]
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) throw new PipeError(`第 ${stageIndex + 1} 个 stage 必须是 map`)
    const id = typeof stage.id === 'string' ? stage.id.trim() : ''
    if (!id) throw new PipeError(`第 ${stageIndex + 1} 个 stage 缺少 id`)
    if (stageIds.has(id)) throw new PipeError(`stage id “${id}” 重复`)
    stageIds.add(id)
    const needs = asArray(stage.needs, `stage ${id} 的 needs`).map((need) => {
      if (typeof need !== 'string' || !need.trim()) throw new PipeError(`stage ${id} 的 needs 必须是非空字符串`)
      return need.trim()
    })
    if (needs.includes(id)) throw new PipeError(`stage ${id} 的 needs 不能包含自己`)
    // v2：stage 可以用 jobs[] 代替 steps[]（jobs 之间按 needs 组 DAG）
    // v1：仍是 steps[]，一个 stage 一组串行命令
    const hasJobs = Array.isArray(stage.jobs) && stage.jobs.length > 0
    const hasSteps = Array.isArray(stage.steps) && stage.steps.length > 0
    if (hasJobs && hasSteps) throw new PipeError(`stage ${id} 不能同时有 steps 与 jobs`)
    if (!hasJobs && !hasSteps) throw new PipeError(`stage ${id} 的 steps 或 jobs 必须是非空数组`)
    if (hasJobs && version !== 2) throw new PipeError(`stage ${id} 用了 jobs[]，需要 version: 2`)
    const normalizedJobs = hasJobs
      ? stage.jobs.map((job, jobIndex) => {
        if (!job || typeof job !== 'object' || Array.isArray(job)) throw new PipeError(`stage ${id} 的第 ${jobIndex + 1} 个 job 必须是 map`)
        const jobId = typeof job.id === 'string' ? job.id.trim() : ''
        if (!jobId) throw new PipeError(`stage ${id} 的第 ${jobIndex + 1} 个 job 缺少 id`)
        if (Array.isArray(job.steps)) {
          for (let stepIndex = 0; stepIndex < job.steps.length; stepIndex += 1) {
            const step = job.steps[stepIndex]
            if (!step || typeof step !== 'object' || Array.isArray(step)) {
              throw new PipeError(`job ${id}/${jobId} 的第 ${stepIndex + 1} 个 step 必须是 map`)
            }
            const hasRun = typeof step.run === 'string' && step.run.trim() !== ''
            const hasUses = typeof step.uses === 'string' && step.uses.trim() !== ''
            const hasDeploy = step.deploy !== undefined
            if (hasRun && hasUses) throw new PipeError(`job ${id}/${jobId} 的第 ${stepIndex + 1} 个 step 不能同时有 run 与 uses`)
            if (!hasRun && !hasUses && !hasDeploy) throw new PipeError(`job ${id}/${jobId} 的第 ${stepIndex + 1} 个 step 必须有 run、uses 或 deploy`)
          }
        }
        const deploySpec = job.deploy
        if (deploySpec !== undefined && deploySpec !== null) {
          if (typeof deploySpec !== 'object' || Array.isArray(deploySpec)) throw new PipeError(`job ${id}/${jobId} 的 deploy 必须是 map`)
          if (typeof deploySpec.target !== 'string' || !deploySpec.target.trim()) throw new PipeError(`job ${id}/${jobId} 的 deploy 缺少 target`)
          if (!targetNames.has(deploySpec.target.trim())) throw new PipeError(`job ${id}/${jobId} 的 deploy.target “${deploySpec.target}” 未定义`)
          if (deploySpec.artifacts !== undefined) asArray(deploySpec.artifacts, `job ${id}/${jobId} 的 deploy.artifacts`)
        }
        if (job.matrix !== undefined && job.matrix !== null && (typeof job.matrix !== 'object' || Array.isArray(job.matrix))) {
          throw new PipeError(`job ${id}/${jobId} 的 matrix 必须是 map`)
        }
        return { ...job, id: jobId }
      })
      : undefined
    const normalizedSteps = hasSteps ? stage.steps.map((step, stepIndex) => {
      if (!step || typeof step !== 'object' || Array.isArray(step)) throw new PipeError(`stage ${id} 的第 ${stepIndex + 1} 个 step 必须是 map`)
      const hasRun = typeof step.run === 'string' && step.run.trim() !== ''
      // v1 也要认 `uses`：动作（checkout / cache / collect …）在 v1 的写法里同样有用，
      // 只在 v2 支持等于逼所有想用缓存的人先改写整份 pipe.yml，而 v1→v2 的迁移本来就该是渐进的。
      const hasUses = typeof step.uses === 'string' && step.uses.trim() !== ''
      const hasDeploy = step.deploy !== undefined
      if (!hasRun && !hasUses && !hasDeploy) throw new PipeError(`stage ${id} 的第 ${stepIndex + 1} 个 step 必须有 run、uses 或 deploy`)
      if ([hasRun, hasUses, hasDeploy].filter(Boolean).length > 1) {
        throw new PipeError(`stage ${id} 的第 ${stepIndex + 1} 个 step 的 run / uses / deploy 只能有一个`)
      }
      if (hasUses && (typeof step.with !== 'undefined' && (typeof step.with !== 'object' || Array.isArray(step.with) || step.with === null))) {
        throw new PipeError(`stage ${id} 的第 ${stepIndex + 1} 个 step 的 with 必须是 map`)
      }
      if (hasDeploy) {
        if (!step.deploy || typeof step.deploy !== 'object' || Array.isArray(step.deploy)) throw new PipeError(`stage ${id} 的第 ${stepIndex + 1} 个 deploy 必须是 map`)
        if (typeof step.deploy.target !== 'string' || !step.deploy.target.trim()) throw new PipeError(`stage ${id} 的第 ${stepIndex + 1} 个 deploy 缺少 target`)
        if (!targetNames.has(step.deploy.target.trim())) throw new PipeError(`stage ${id} 的第 ${stepIndex + 1} 个 deploy.target “${step.deploy.target}” 未定义`)
        if (step.deploy.artifacts !== undefined) asArray(step.deploy.artifacts, `stage ${id} 第 ${stepIndex + 1} 个 deploy 的 artifacts`)
      }
      return step
    }) : undefined
    normalizedStages.push({ ...stage, id, needs, steps: normalizedSteps, jobs: normalizedJobs })
  }
  for (const stage of normalizedStages) {
    for (const need of stage.needs) if (!stageIds.has(need)) throw new PipeError(`stage ${stage.id} 的 needs 指向不存在的 stage “${need}”`)
  }

  const triggers = normalizeTriggers(root)
  const toolchain = normalizeToolchain(root.toolchain)
  // M3：顶层 `cache:`（04-pipe-v2 §8）——声明式缓存，任务随 runner 一起走。
  const cache = normalizeCacheSpec(root.cache)
  // v3.0-P4-3：受保护环境的护栏可以写在 pipe 里（`environments:`），也可以写在插件配置里。
  // 解析只做形状检查，语义判定统一在 lib/environments.js 的 parseEnvironmentGuards ——
  // 两处各写一份校验，最后一定会出现"pipe 说合法、运行时说不合法"的分裂。
  const environments = normalizePipeEnvironments(root.environments)
  // v3.0-P6-1：defaultTarget 要让编辑器预览知道「不选目标时会落到哪一个」，否则预览挑的默认值
  // 和真正运行时的选择规则可能不一样（预览显示 prod、实跑 staging 是最坏的一种不一致）。
  const defaultTarget = typeof root.default_target === 'string' ? root.default_target.trim() : ''
  if (defaultTarget && !targetNames.has(defaultTarget)) throw new PipeError(`default_target 指向不存在的 target “${defaultTarget}”`)
  return { version, name, vars: vars || {}, targets: normalizedTargets, defaultTarget, stages: normalizedStages, triggers, toolchain, environments, cache, path }
}

/**
 * 归一 `environments:`（v3.0-P4-3）。
 *
 * 这里只做形状检查：是不是 map、每项是不是 map 或 false。
 * 名单前缀、正则能否编译这类**语义**问题交给 lib/environments.js 的
 * parseEnvironmentGuards，它会把写错的条目集中报出来并让受保护环境一律拒绝 ——
 * 在解析层抛异常反而更糟：一个环境的名单写错会让整条流水线跑不起来，
 * 而正确的反应是"只有那个环境拒绝部署"。
 */
/**
 * 归一顶层 `cache:`（M3）。
 *
 * 只做形状检查与默认值，不做求值：`key` 支持普通插值（${{ vars.x }}），当前不支持
 * `hashFiles()` 这类函数——它会在求值层以「未知函数」明确报错，好过在这里假装支持
 * 然后给出一份永远不命中的 key。
 *
 * paths 只许相对路径且不许 `..`：缓存目录里的文件由 runner 解包回项目目录，
 * 绝对路径与上跳会让一条 pipe.yml 获得写穿 workspace 的能力。
 */
function normalizeCacheSpec(input) {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) throw new PipeError('cache 必须是数组')
  return input.map((item, index) => {
    const where = `cache 第 ${index + 1} 项`
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new PipeError(`${where} 必须是 map`)
    const key = typeof item.key === 'string' ? item.key.trim() : ''
    if (!key) throw new PipeError(`${where} 缺少 key`)
    const paths = asArray(item.paths, `${where} 的 paths`).map((value) => {
      if (typeof value !== 'string' || !value.trim()) throw new PipeError(`${where} 的 paths 必须是非空字符串`)
      const path = value.trim()
      if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) throw new PipeError(`${where} 的 paths 只允许相对项目目录的路径（拿到的“${path}”）`)
      if (path.split(/[\\/]/).includes('..')) throw new PipeError(`${where} 的 paths 不允许跳出项目目录（拿到的“${path}”）`)
      return path
    })
    if (paths.length === 0) throw new PipeError(`${where} 的 paths 不能为空`)
    const restoreKeys = item.restore_keys === undefined
      ? []
      : asArray(item.restore_keys, `${where} 的 restore_keys`).map((value) => {
        if (typeof value !== 'string' || !value.trim()) throw new PipeError(`${where} 的 restore_keys 必须是非空字符串`)
        return value.trim()
      })
    const mode = item.mode === undefined ? 'both' : String(item.mode)
    if (!['restore', 'save', 'both'].includes(mode)) throw new PipeError(`${where} 的 mode 只能是 restore / save / both（拿到的“${mode}”）`)
    return { key, paths, restoreKeys, mode }
  })
}

function normalizePipeEnvironments(input) {
  if (input === undefined || input === null) return {}
  if (typeof input !== 'object' || Array.isArray(input)) throw new PipeError('environments 必须是 map')
  const out = {}
  for (const [rawName, rawSpec] of Object.entries(input)) {
    const name = String(rawName || '').trim()
    if (!name) throw new PipeError('environments 里有空的环境名')
    if (rawSpec === false || rawSpec === null) { out[name] = false; continue }
    if (typeof rawSpec !== 'object' || Array.isArray(rawSpec)) throw new PipeError(`environments.${name} 必须是 map（或 false）`)
    out[name] = rawSpec
  }
  return out
}

// 工具链语言枚举：与 lib/toolchain.js 的 LANGS 必须一致。
// 这里重复写一遍是为了让 pipe.js 不依赖 toolchain.js（解析层不拉网络/子进程模块）。
const TOOLCHAIN_LANGS = ['java', 'maven', 'gradle', 'node', 'python', 'php', 'go']

/**
 * 归一 `toolchain:` 声明。
 *
 * 只允许「vendor 枚举 + 版本表达」，**任何看起来像 URL 的值都直接拒绝**：
 * pipe.yml 是仓库里的文件，谁提 PR 谁就能改；在这里放开 URL，
 * 等于允许任何有提交权限的人让构建机下载并执行任意二进制。
 */
function normalizeToolchain(raw) {
  if (raw === undefined || raw === null || raw === '') return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new PipeError('toolchain 必须是 map')
  const result = {}
  for (const [lang, value] of Object.entries(raw)) {
    if (lang === 'infer_from_files') {
      result.infer_from_files = value !== false && value !== 'false'
      continue
    }
    if (!TOOLCHAIN_LANGS.includes(lang)) {
      throw new PipeError(`toolchain 不支持 “${lang}”（支持：${TOOLCHAIN_LANGS.join('、')}）`)
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new PipeError(`toolchain.${lang} 必须是版本字符串`)
    }
    const text = String(value).trim()
    if (!text) throw new PipeError(`toolchain.${lang} 是空的`)
    if (/[:/\\]/.test(text)) {
      throw new PipeError(`toolchain.${lang} 只接受 vendor+版本（如 temurin-17、20.11.1），不接受路径或 URL：${text}`)
    }
    result[lang] = text
  }
  if (result.maven && result.gradle) {
    throw new PipeError('toolchain 里 maven 与 gradle 只能声明一个（按项目实际用的构建工具选）')
  }
  return result
}

const VAR_PATTERN = /\$\{\{\s*([A-Za-z_]\w*)\s*\}\}/g

export function interpolate(text, vars = {}, { onUse = null } = {}) {
  if (typeof text !== 'string') return text
  return text.replace(VAR_PATTERN, (_match, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) throw new PipeError(`未定义变量 ${name}`, { code: 'PIPE_VAR' })
    // v3.0-P6-1：编辑器预览要知道「这条命令用了哪些变量」，好把密钥类变量显示成占位符而不是明文。
    if (typeof onUse === 'function') onUse(name)
    return String(vars[name] ?? '')
  })
}

export function matchArtifacts(patterns, files) {
  const list = Array.isArray(patterns) ? patterns : patterns === undefined || patterns === null ? [] : [patterns]
  const candidates = (Array.isArray(files) ? files : []).map((file) => String(file).replace(/\\/g, '/').replace(/^\.\//, ''))
  const regexes = list.map((pattern) => {
    const source = String(pattern).replace(/\\/g, '/').replace(/^\.\//, '')
    let regex = ''
    for (let i = 0; i < source.length; i += 1) {
      const ch = source[i]
      if (ch === '*' && source[i + 1] === '*') {
        if (source[i + 2] === '/') { regex += '(?:.*/)?'; i += 2 } else { regex += '.*'; i += 1 }
      } else if (ch === '*') regex += '[^/]*'
      else if (ch === '?') regex += '[^/]'
      else regex += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
    return new RegExp(`^${regex}$`)
  })
  return [...new Set(candidates.filter((file) => regexes.some((regex) => regex.test(file))))]
}

function parseDuration(value, fallbackSec = 600) {
  if (value === undefined || value === null || value === '') return fallbackSec
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
  if (typeof value === 'string') {
    const text = value.trim()
    if (/^\d+$/.test(text)) return Number(text)
    const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(text)
    if (match) {
      const factor = match[2] === 'ms' ? 0.001 : match[2] === 'm' ? 60 : match[2] === 'h' ? 3600 : 1
      return Math.max(1, Math.floor(Number(match[1]) * factor))
    }
  }
  throw new PipeError(`时长 “${value}” 无法解析（支持 30、30s、5m、1h）`)
}

function parseStageWhen(when) {
  if (when === undefined || when === null || when === '') return null
  if (typeof when !== 'string') throw new PipeError('when 必须是字符串', { code: 'PIPE_WHEN' })
  const text = when.trim()
  const match = /^(branch|tag|env|changed)\s*(==|!=)\s*(['"])(.*?)\3$/.exec(text)
  if (match) return { kind: 'eq', field: match[1], operator: match[2], value: match[4] }
  const changed = /^changed\s*:\s*(\S+)$/.exec(text)
  if (changed) return { kind: 'changed', pattern: changed[1] }
  throw new PipeError(`when 只支持 branch == 'x'、tag == 'x'、env == 'x'、changed == 'x' 或 changed: path/**（收到 “${text}”）`, { code: 'PIPE_WHEN' })
}

/** v3.0-P6-1：预览要解释「这个 stage 为什么没出现在计划里」，所以把判定暴露出来。 */
export function explainWhen(condition, context) {
  return evaluateWhen(condition, context)
}

export function stageConditionOf(stage) {
  try { return parseStageWhen(stage && stage.when) } catch { return null }
}

function evaluateWhen(condition, context) {
  if (!condition) return true
  if (condition.kind === 'changed') return matchArtifacts([condition.pattern], context.changed).length > 0
  const equal = condition.field === 'changed'
    ? matchArtifacts([condition.value], context.changed).length > 0
    : String(context[condition.field] ?? '') === condition.value
  return condition.operator === '!=' ? !equal : equal
}

function topological(stages) {
  const byId = new Map(stages.map((stage) => [stage.id, stage]))
  const result = []
  const state = new Map()
  const visit = (stage, trail) => {
    if (state.get(stage.id) === 'done') return
    if (state.get(stage.id) === 'visiting') throw new PipeError(`stage 依赖出现环：${[...trail, stage.id].join(' → ')}`)
    state.set(stage.id, 'visiting')
    for (const need of stage.needs) visit(byId.get(need), [...trail, stage.id])
    state.set(stage.id, 'done')
    result.push(stage)
  }
  for (const stage of stages) visit(stage, [])
  return result
}

/**
 * 把一个原始 step 描述变成可执行的 plan step。
 *
 * 抽成模块级导出是为了让 **v2 的 DAG 执行路径复用同一份归一化逻辑**：v2 的 step 来自
 * `lib/model.js` 的 job（已经过 matrix 展开，还没插值），如果 runner 自己再写一遍
 * kind/deploy 判定，两处迟早对不上（比如 `uses` 在一个地方算 run、在另一个地方算动作）。
 */
export function buildStep(step, { index = 0, jobId = '', vars = {}, target = '', stageManual = false, matrix = null, onInterpolate = null } = {}) {
  const isDeploy = step.deploy !== undefined && step.deploy !== null
  const isUses = !isDeploy && typeof step.uses === 'string' && step.uses.trim() !== ''
  const kind = isDeploy ? 'deploy' : (isUses ? 'uses' : 'run')
  const deploy = step.deploy || null
  const deployTarget = deploy?.target ? deploy.target.trim() : target
  const base = {
    index,
    jobId: jobId || '',
    name: typeof step.name === 'string' && step.name.trim()
      ? step.name.trim()
      : (kind === 'deploy' ? `部署 ${deployTarget || ''}` : `第 ${index + 1} 步`),
    kind,
    when: typeof step.when === 'string' ? step.when : '',
    manual: Boolean(step.manual ?? stageManual),
    timeoutSec: step.timeoutSec !== undefined
      ? Number(step.timeoutSec) || 0
      : parseDuration(step.timeout),
    retries: Number.isInteger(step.retries) && step.retries >= 0 ? step.retries : 0,
    allowFailure: Boolean(step.allow_failure ?? step.allowFailure),
    deploy: deploy ? {
      target: deployTarget,
      artifacts: asArray(deploy.artifacts, 'deploy.artifacts'),
      activate: deploy.activate || 'symlink',
      keep: Number.isInteger(deploy.keep) && deploy.keep > 0 ? deploy.keep : 5,
    } : null,
    matrix: matrix || null,
    source: step,
  }
  if (kind === 'deploy') return { ...base, command: `deploy:${deployTarget || ''}` }
  if (kind === 'uses') return { ...base, command: `uses:${step.uses.trim()}`, uses: step.uses.trim(), with: step.with || null }
  return { ...base, command: interpolate(step.run, vars, { onUse: onInterpolate }) }
}

export function planPipeline(pipe, { project, target, env = {}, onInterpolate = null } = {}) {
  if (!pipe || !Array.isArray(pipe.stages)) throw new PipeError('planPipeline 需要 parsePipe 的结果')
  const projectId = typeof project === 'string' ? project : project?.id || ''
  const envContext = {
    branch: env.branch ?? env.BRANCH ?? '',
    tag: env.tag ?? env.TAG ?? '',
    env: env.name ?? env.env ?? env.ENV ?? '',
    changed: env.changed ?? [],
  }
  const vars = {
    CI: '1',
    PROJECT: projectId,
    TARGET: target ?? env.target ?? '',
    BRANCH: envContext.branch,
    COMMIT: env.commit ?? env.COMMIT ?? '',
    RELEASE_ID: env.releaseId ?? env.RELEASE_ID ?? '',
    ...(pipe.vars || {}),
    ...(env.vars || {}),
  }
  const included = new Set()
  const result = []
  for (const stage of topological(pipe.stages)) {
    if (stage.needs.some((need) => !included.has(need))) continue
    if (!evaluateWhen(parseStageWhen(stage.when), envContext)) continue
    const planStep = (step, index, jobId, matrix) => buildStep(step, {
      index,
      jobId,
      vars,
      target,
      stageManual: Boolean(stage.manual),
      matrix,
      onInterpolate,
    })

    const steps = []
    if (Array.isArray(stage.jobs) && stage.jobs.length > 0) {
      // v2：stage.steps 是「该 stage 全部 job 的 step 拍平」，保留 jobId 供调度器分组。
      // 真正的执行顺序由 model 的 DAG 决定，这里的顺序只用于 plan 展示。
      for (const job of stage.jobs) {
        if (job.when && !evaluateWhen(parseStageWhen(job.when), envContext)) continue
        const jobSteps = Array.isArray(job.steps) ? job.steps : []
        jobSteps.forEach((step, index) => {
          if (!evaluateWhen(parseStageWhen(step.when), envContext)) return
          steps.push(planStep(step, steps.length, job.id))
        })
      }
    } else {
      for (let index = 0; index < stage.steps.length; index += 1) {
        const step = stage.steps[index]
        if (!evaluateWhen(parseStageWhen(step.when), envContext)) continue
        steps.push(planStep(step, index, ''))
      }
    }
    result.push({ id: stage.id, needs: stage.needs, manual: Boolean(stage.manual), steps })
    included.add(stage.id)
  }
  return { name: pipe.name, vars, stages: result }
}