/**
 * 受限表达式求值器（v3.0-P1）。
 *
 * 为什么不用 `eval` / `new Function`：pipe.yml 是仓库里的文件，谁提 PR 谁就能改它。
 * 用一个真 JS 求值器等于给每个能提交代码的人一个在构建机上执行任意代码的入口
 * （`${{ process.exit(0) }}`、`${{ require('fs').rmSync('/') }}`）。
 * 所以这里是一个手写的小语言：只有比较、`&&`/`||`/`!`、括号、和一张函数白名单。
 *
 * ## 三档求值（照 04-pipe-v2.md §5.1）
 *
 * | 档位 | 时机 | 可引用 |
 * |---|---|---|
 * | T0 trigger | 解析完、还没进图 | `event/branch/tag/paths/ref` |
 * | T1 graph | 创建期（快照化） | `vars/variables/needs/matrix/env/project/target` |
 * | T2 runtime | 命令真要跑时 | 上面全部 + `secrets/steps/outputs` |
 *
 * **`secrets` 只在 T2 可见**：T1 里写 `secrets.X` 直接 `PIPE_EXPR`。
 * 这不是洁癖——T1 的求值结果会进 run 记录、进 UI、进日志，一旦 secret 卷进去就泄漏了。
 */

import { PipeError } from './pipe.js'

export const TIERS = { T0: 't0', T1: 't1', T2: 't2' }

/** 每一档允许引用的命名空间根。写死成集合，新增命名空间必须同时改这里。 */
const TIER_ROOTS = {
  t0: new Set(['event', 'branch', 'tag', 'paths', 'ref']),
  // T1 也放 branch/tag/paths：`if: branch == 'main'` 是「进不进图」的判断，
  // 发生在前置 stage 跑完之前，必须能在 T1 求值；而 secrets 依然不可见。
  t1: new Set([
    'event', 'branch', 'tag', 'paths', 'ref',
    'vars', 'variables', 'needs', 'matrix', 'env', 'project', 'target', 'job', 'stage',
  ]),
  t2: new Set([
    'event', 'branch', 'tag', 'paths', 'ref',
    'vars', 'variables', 'needs', 'matrix', 'env', 'project', 'target', 'job', 'stage',
    'secrets', 'steps', 'outputs',
  ]),
}

/** 函数白名单。键是函数名，值是「接受几个参数」，用于报错时说清楚。 */
const FUNCTIONS = new Map([
  ['startsWith', 2],
  ['endsWith', 2],
  ['contains', 2],
  ['matches', 2],
  ['changed', 1],
  ['exists', 1],
  ['always', 0],
  ['success', 0],
  ['failure', 0],
  ['cancelled', 0],
  ['skipped', 0],
])

/* ------------------------------------------------------------------------------------------------
 * 词法
 *
 * 手写扫描而不是正则：正则版本没法给出「第几个字符出错」，而 pipe.yml 的表达式通常一行写完，
 * 没有字符位置的话用户只能猜。
 * ---------------------------------------------------------------------------------------------- */

const PUNCT = ['&&', '||', '==', '!=', '>=', '<=', '>', '<', '!', '(', ')', ',']

function tokenize(source) {
  const tokens = []
  let i = 0
  const text = String(source)
  while (i < text.length) {
    const ch = text[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i += 1; continue }

    // 字符串字面量：单引号或双引号，支持 \\ 转义
    if (ch === "'" || ch === '"') {
      const quoteChar = ch
      let value = ''
      let j = i + 1
      let closed = false
      while (j < text.length) {
        const c = text[j]
        if (c === '\\' && j + 1 < text.length) { value += text[j + 1]; j += 2; continue }
        if (c === quoteChar) { closed = true; j += 1; break }
        value += c
        j += 1
      }
      if (!closed) throw exprError(`字符串少了收尾引号 ${quoteChar}`, i)
      tokens.push({ type: 'string', value, at: i })
      i = j
      continue
    }

    // 数字
    if (ch >= '0' && ch <= '9') {
      let j = i
      while (j < text.length && /[0-9.]/.test(text[j])) j += 1
      const raw = text.slice(i, j)
      const num = Number(raw)
      if (!Number.isFinite(num)) throw exprError(`数字 “${raw}” 不合法`, i)
      tokens.push({ type: 'number', value: num, at: i })
      i = j
      continue
    }

    // 标识符 / 点路径
    if (/[A-Za-z_]/.test(ch)) {
      let j = i
      while (j < text.length && /[A-Za-z0-9_.]/.test(text[j])) j += 1
      const raw = text.slice(i, j)
      tokens.push({ type: 'ident', value: raw, at: i })
      i = j
      continue
    }

    const punct = PUNCT.find((item) => text.startsWith(item, i))
    if (punct) {
      tokens.push({ type: 'punct', value: punct, at: i })
      i += punct.length
      continue
    }

    throw exprError(`表达式里有无法识别的字符 “${ch}”`, i)
  }
  tokens.push({ type: 'eof', value: '', at: text.length })
  return tokens
}

function exprError(message, at) {
  const error = new PipeError(message, { code: 'PIPE_EXPR' })
  error.at = at
  return error
}

/* ------------------------------------------------------------------------------------------------
 * 语法制导翻译（递归下降）
 *
 * 优先级从低到高：or → and → not → compare → primary
 * ---------------------------------------------------------------------------------------------- */

function parseTokens(tokens) {
  let pos = 0

  const peek = () => tokens[pos]
  const eat = (value) => {
    const token = tokens[pos]
    if (token.type === 'punct' && token.value === value) { pos += 1; return true }
    return false
  }
  const expectPunct = (value) => {
    if (!eat(value)) throw exprError(`这里应该是 “${value}”，实际是 “${peek().value || peek().type}”`, peek().at)
  }

  function parseOr() {
    let node = parseAnd()
    while (eat('||')) node = { kind: 'or', left: node, right: parseAnd() }
    return node
  }

  function parseAnd() {
    let node = parseNot()
    while (eat('&&')) node = { kind: 'and', left: node, right: parseNot() }
    return node
  }

  function parseNot() {
    if (eat('!')) return { kind: 'not', value: parseNot() }
    return parseCompare()
  }

  function parseCompare() {
    const left = parsePrimary()
    for (const op of ['==', '!=', '>=', '<=', '>', '<']) {
      if (eat(op)) return { kind: 'compare', operator: op, left, right: parsePrimary() }
    }
    return left
  }

  function parsePrimary() {
    const token = peek()
    if (token.type === 'string') { pos += 1; return { kind: 'literal', value: token.value } }
    if (token.type === 'number') { pos += 1; return { kind: 'literal', value: token.value } }
    if (token.type === 'punct' && token.value === '(') {
      pos += 1
      const node = parseOr()
      expectPunct(')')
      return node
    }
    if (token.type === 'ident') {
      pos += 1
      const raw = token.value
      // 函数调用：标识符后面紧跟括号
      if (peek().type === 'punct' && peek().value === '(') {
        pos += 1
        const args = []
        if (!(peek().type === 'punct' && peek().value === ')')) {
          args.push(parseOr())
          while (eat(',')) args.push(parseOr())
        }
        expectPunct(')')
        return { kind: 'call', name: raw, args, at: token.at }
      }
      if (raw === 'true') return { kind: 'literal', value: true }
      if (raw === 'false') return { kind: 'literal', value: false }
      if (raw === 'null') return { kind: 'literal', value: null }
      return { kind: 'ref', path: raw.split('.'), at: token.at }
    }
    throw exprError(`表达式在这里断了：${token.value || token.type}`, token.at)
  }

  const root = parseOr()
  if (peek().type !== 'eof') throw exprError(`多余的 “${peek().value}”`, peek().at)
  return root
}

/* ------------------------------------------------------------------------------------------------
 * 档位校验：把 AST 里所有引用根收集出来，跟白名单比
 * ---------------------------------------------------------------------------------------------- */

export function referencedRoots(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out
  if (node.kind === 'ref' && Array.isArray(node.path) && node.path.length > 0) out.add(node.path[0])
  if (node.kind === 'call') for (const arg of node.args) referencedRoots(arg, out)
  if (node.left) referencedRoots(node.left, out)
  if (node.right) referencedRoots(node.right, out)
  if (node.value && typeof node.value === 'object') referencedRoots(node.value, out)
  return out
}

export function assertTier(source, tier) {
  const normalized = String(tier || '').toLowerCase()
  const allowed = TIER_ROOTS[normalized]
  if (!allowed) throw exprError(`未知的求值档位 “${tier}”`, 0)
  const roots = referencedRoots(parseTokens(tokenize(source)))
  for (const root of roots) {
    if (allowed.has(root)) continue
    // secrets 的专门提示：这是最容易被误用的一处，说清楚为什么不行。
    const hint = root === 'secrets' && normalized !== 't2'
      ? `secrets 只在 T2（真正执行命令时）可见；${normalized.toUpperCase()} 阶段的求值结果会进 run 记录与日志`
      : `${normalized.toUpperCase()} 档不能引用 “${root}”（可用：${[...allowed].join('、')}）`
    throw new PipeError(hint, { code: 'PIPE_EXPR' })
  }
  return roots
}

/* ------------------------------------------------------------------------------------------------
 * 求值
 * ---------------------------------------------------------------------------------------------- */

function resolvePath(context, path) {
  let current = context
  for (const key of path) {
    if (current === null || current === undefined) return undefined
    current = current[key]
  }
  return current
}

function truthy(value) {
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'string') return value !== '' && value !== 'false'
  return Boolean(value)
}

function compare(operator, left, right) {
  switch (operator) {
    case '==': return left === right || String(left) === String(right)
    case '!=': return !(left === right || String(left) === String(right))
    case '>': return Number(left) > Number(right)
    case '<': return Number(left) < Number(right)
    case '>=': return Number(left) >= Number(right)
    case '<=': return Number(left) <= Number(right)
    default: throw exprError(`不支持的比较符 ${operator}`, 0)
  }
}

function callFunction(name, args, context) {
  switch (name) {
    case 'startsWith': return String(args[0] ?? '').startsWith(String(args[1] ?? ''))
    case 'endsWith': return String(args[0] ?? '').endsWith(String(args[1] ?? ''))
    case 'contains': return String(args[0] ?? '').includes(String(args[1] ?? ''))
    case 'matches': {
      let regex
      try { regex = new RegExp(String(args[1] ?? '')) } catch (error) {
        throw exprError(`matches() 的正则 “${args[1]}” 不合法：${error.message}`, 0)
      }
      return regex.test(String(args[0] ?? ''))
    }
    case 'changed': {
      // 简化：paths 非空即算「触碰过」，精确的 glob 匹配在调用方用 matchArtifacts 做。
      const patterns = Array.isArray(args[0]) ? args[0] : [args[0]]
      const changed = Array.isArray(context.paths) ? context.paths : []
      if (changed.length === 0) return false
      return patterns.some((pattern) => changed.includes(String(pattern)))
    }
    case 'exists': return args[0] !== undefined && args[0] !== null && args[0] !== ''
    case 'always': return true
    case 'success': return (context.needs || []).every((need) => need.status === 'succeeded' || need.status === 'completed')
    case 'failure': return (context.needs || []).some((need) => need.status === 'failed')
    case 'cancelled': return (context.needs || []).some((need) => need.status === 'canceled')
    case 'skipped': return (context.needs || []).some((need) => need.status === 'skipped')
    default: throw exprError(`表达式里不支持函数 “${name}”（可用：${[...FUNCTIONS.keys()].join('、')}）`, 0)
  }
}

function evaluateNode(node, context) {
  switch (node.kind) {
    case 'literal': return node.value
    case 'ref': return resolvePath(context, node.path)
    case 'not': return !truthy(evaluateNode(node.value, context))
    case 'and': return truthy(evaluateNode(node.left, context)) && truthy(evaluateNode(node.right, context))
    case 'or': return truthy(evaluateNode(node.left, context)) || truthy(evaluateNode(node.right, context))
    case 'compare': return compare(node.operator, evaluateNode(node.left, context), evaluateNode(node.right, context))
    case 'call': {
      const expected = FUNCTIONS.get(node.name)
      if (expected === undefined) {
        throw exprError(`表达式里不支持函数 “${node.name}”（可用：${[...FUNCTIONS.keys()].join('、')}）`, node.at || 0)
      }
      const args = node.args.map((arg) => evaluateNode(arg, context))
      if (args.length !== expected) {
        throw exprError(`${node.name}() 需要 ${expected} 个参数，收到 ${args.length} 个`, node.at || 0)
      }
      return callFunction(node.name, args, context)
    }
    default: throw exprError(`内部错误：未知节点 ${node.kind}`, 0)
  }
}

/**
 * 求一条表达式，返回原始值（布尔、字符串、数字都可能）。
 * 严格模式（默认）先过档位白名单，再求值。
 */
export function evaluate(source, context = {}, { tier = 't1', strict = true } = {}) {
  const text = String(source ?? '').trim()
  if (!text) return true
  if (strict) assertTier(text, tier)
  return evaluateNode(parseTokens(tokenize(text)), context)
}

/** 求一条表达式并转成布尔（`if:` / `when:` 用）。 */
export function evaluateCondition(source, context = {}, options = {}) {
  const text = String(source ?? '').trim()
  if (!text) return true
  return truthy(evaluate(text, context, options))
}

/* ------------------------------------------------------------------------------------------------
 * 模板插值：`${{ ... }}` 里可以是裸变量名，也可以是完整表达式
 *
 * 与 pipe.js 的 interpolate() 的区别：那个只认 `${{NAME}}`（v1 行为，报错码 PIPE_VAR），
 * 这个认 `${{ matrix.java }}`、`${{ vars.X == 'y' }}`。v1 路径保持原样，避免破坏既有 pipe.yml。
 * ---------------------------------------------------------------------------------------------- */

const TEMPLATE_PATTERN = /\$\{\{([\s\S]*?)\}\}/g

export function hasTemplate(text) {
  TEMPLATE_PATTERN.lastIndex = 0
  const matched = TEMPLATE_PATTERN.test(String(text ?? ''))
  TEMPLATE_PATTERN.lastIndex = 0
  return matched
}

export function evaluateTemplate(text, context = {}, { tier = 't2', strict = true } = {}) {
  if (typeof text !== 'string') return text
  return text.replace(TEMPLATE_PATTERN, (_match, body) => {
    const source = String(body).trim()
    if (!source) return ''
    // 裸标识符：`${{ NAME }}` 从 vars 顶层取，保持与 v1 相同的语义与错误码。
    if (/^[A-Za-z_]\w*$/.test(source)) {
      const vars = context.vars || context.variables || {}
      if (Object.prototype.hasOwnProperty.call(vars, source)) return String(vars[source] ?? '')
      if (Object.prototype.hasOwnProperty.call(context, source)) return String(context[source] ?? '')
      throw new PipeError(`未定义变量 ${source}`, { code: 'PIPE_VAR' })
    }
    const value = evaluate(source, context, { tier, strict })
    return value === undefined || value === null ? '' : String(value)
  })
}
