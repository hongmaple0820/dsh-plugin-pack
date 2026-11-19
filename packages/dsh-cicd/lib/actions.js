/**
 * 内置动作（`uses:`）—— v3.0-P2
 *
 * 为什么是白名单，而不是「从某个 URL 拉 action」：
 * pipe.yml 是仓库里的文件，谁能提 PR 谁就能改它。一旦允许引用外部 action，任何有提交权限的人
 * 都能让构建机执行别人仓库里的代码——那不是 CI，那是一个对外开放的远程执行入口。
 * GitHub Actions 的供应链事故基本都出在这里，我们没有精力做 pin + 审计 + 签名那一整套，
 * 所以只提供七个固定动作，其余一律 `run:` 写 shell（用户自己承担 shell 的风险，边界清楚）。
 *
 * 设计约束：
 * 1. 未知动作 = 硬失败，绝不静默跳过。「静默跳过」会让流水线看起来绿了、实际什么都没做。
 * 2. `with` 里未知键 = 硬失败。拼错的 `path:` 写成 `paths:` 不报错，用户会以为缓存在工作。
 * 3. 每个动作自己声明需要的能力（collect/deploy/notify/toolchain），缺能力时明确报错，
 *    而不是假装成功——一个「执行了但没有部署器」的 deploy 比失败更危险。
 */

export const ACTION_NAMES = ['checkout', 'toolchain', 'cache', 'collect', 'deploy', 'verify', 'notify']

export const ACTION_ERRORS = {
  UNKNOWN: 'ACTION_NOT_FOUND',
  INPUT: 'ACTION_INPUT_INVALID',
  FAILED: 'ACTION_FAILED',
  UNAVAILABLE: 'ACTION_UNAVAILABLE',
}

function actionError(message, code = ACTION_ERRORS.FAILED, extra = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
  return error
}

/** `with:` 必须是 map；空值归一成空对象，方便各动作直接解构。 */
export function normalizeInput(withValue) {
  if (withValue === undefined || withValue === null) return {}
  if (typeof withValue !== 'object' || Array.isArray(withValue)) {
    throw actionError('with 必须是 map（键值对）', ACTION_ERRORS.INPUT)
  }
  return { ...withValue }
}

/**
 * 只接受声明过的键。拼错的键必须炸：`path` 写成 `paths` 不报错的话，
 * 用户会以为缓存在工作，直到某天发现每次构建都是冷的。
 */
export function assertKeys(name, input, allowed) {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) {
    throw actionError(
      `动作 ${name} 不认识参数 ${unknown.map((key) => `“${key}”`).join('、')}（支持：${allowed.join('、') || '无'}）`,
      ACTION_ERRORS.INPUT,
    )
  }
}

const asString = (value, fallback = '') => (typeof value === 'string' ? value.trim() : value === undefined || value === null ? fallback : String(value))
const asList = (value) => {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter((item) => item !== '')
  if (typeof value === 'string' && value.trim() !== '') return value.split(',').map((item) => item.trim()).filter((item) => item !== '')
  return []
}
const asPositiveInt = (value, fallback) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback)

function requireCapability(ctx, capability, what) {
  const value = ctx?.[capability]
  // 能力可以是函数（deploy / collect / notify）也可以是对象（cache 有两个方法 restore+save）。
  // 只认 typeof === 'function' 会把 cache 直接判成「没有缓存能力」——
  // 而它的报错文案说的是「干跑里不能用」，排查时会被带到完全错误的方向。
  if (typeof value !== 'function' && (typeof value !== 'object' || value === null)) {
    throw actionError(`当前上下文没有${what}能力（${capability}）——这个动作只能在真的运行里用，不能在干跑里用`, ACTION_ERRORS.UNAVAILABLE)
  }
  return value
}

/* ------------------------------------------------------------------------------------------------
 * checkout
 *
 * 这里的模型是「runner 直接在项目目录里构建」（不是每个 job 一份新工作区，那是 P3）。
 * 所以 checkout 绝不能偷偷切分支：那会改掉用户自己的工作副本，下一次他自己跑 `git status`
 * 会看到一堆莫名其妙的改动，而且我们的失败恢复也不会切回来。
 * 于是：能安全做的（fetch / submodule）就做，需要改 HEAD 的（切 ref）只在已经一致时通过，
 * 不一致时明确失败并说明原因。
 * ---------------------------------------------------------------------------------------------- */
const checkoutAction = {
  capability: 'git',
  keys: ['fetch_depth', 'submodules', 'ref', 'clean'],
  async run(ctx, input) {
    const fetchDepth = asPositiveInt(input.fetch_depth, 0)
    const wantSubmodules = input.submodules === true || input.submodules === 'true'
    const ref = asString(input.ref)

    if (typeof ctx.git !== 'function') {
      // 不是 git 仓库（本地目录项目）：fetch/submodule 都无意义，ref 也没法切
      if (ref) throw actionError(`项目不是 git 仓库，无法 checkout ${ref}`, ACTION_ERRORS.FAILED)
      ctx.log(`checkout：${ctx.project?.path || ''} 不是 git 仓库，跳过取代码`)
      return { outputs: { ref: '', fetched: false } }
    }

    let fetched = false
    if (fetchDepth > 0) {
      const out = await ctx.git(['fetch', '--quiet', '--prune', `--depth=${fetchDepth}`])
      fetched = out.ok
      if (!out.ok) throw actionError(`git fetch 失败：${out.stderr || out.error || '未知错误'}`)
      ctx.log(`checkout：已 fetch（depth=${fetchDepth}）`)
    } else {
      ctx.log('checkout：没有声明 fetch_depth，复用工作区现有代码')
    }

    if (wantSubmodules) {
      const out = await ctx.git(['submodule', 'update', '--init', '--recursive'])
      if (!out.ok) throw actionError(`submodule 更新失败：${out.stderr || out.error || '未知错误'}`)
      ctx.log('checkout：submodule 已初始化')
    }

    const head = await ctx.git(['rev-parse', 'HEAD'])
    const current = head.ok ? head.stdout.trim() : ''

    if (ref) {
      const target = await ctx.git(['rev-parse', '--verify', `${ref}^{commit}`])
      const targetSha = target.ok ? target.stdout.trim() : ''
      if (!targetSha) throw actionError(`git 里找不到 ${ref}`, ACTION_ERRORS.FAILED)
      if (targetSha !== current) {
        throw actionError(
          `工作区 HEAD 是 ${current.slice(0, 12) || '（未知）'}，与声明要构建的 ${ref}（${targetSha.slice(0, 12)}）不一致。`
          + '这里不会替你切分支——那会改掉你自己的代码。请先手动检出，或用 P3 的独立工作区。',
          ACTION_ERRORS.FAILED,
        )
      }
      ctx.log(`checkout：HEAD 已是 ${ref}（${current.slice(0, 12)}）`)
    }

    return { outputs: { ref: current, fetched, submodules: wantSubmodules } }
  },
}

/* ------------------------------------------------------------------------------------------------
 * toolchain —— 在 step 级别换工具链
 *
 * 与 pipe.yml 顶层的 `toolchain:` 是同一套实现，区别只是作用范围：顶层是整次运行，
 * 这里是「从这个动作之后开始的 step」。用途是「build 用 17、publish 用 21」这种。
 * ---------------------------------------------------------------------------------------------- */
const toolchainAction = {
  capability: 'toolchain',
  keys: ['java', 'maven', 'gradle', 'node', 'python', 'php', 'go'],
  async run(ctx, input) {
    requireCapability(ctx, 'toolchain', '工具链')
    const specs = {}
    for (const [key, value] of Object.entries(input)) {
      const text = asString(value)
      if (!text) throw actionError(`toolchain.${key} 不能是空值`, ACTION_ERRORS.INPUT)
      specs[key] = text
    }
    if (Object.keys(specs).length === 0) throw actionError('toolchain 动作至少要声明一门语言', ACTION_ERRORS.INPUT)
    const installed = await ctx.toolchain(specs)
    const describe = installed.map((item) => `${item.lang}=${item.version}`).join(', ')
    ctx.log(`toolchain：${describe}`)
    return { outputs: { toolchain: describe, versions: Object.fromEntries(installed.map((item) => [item.lang, item.version])) } }
  },
}

/* ------------------------------------------------------------------------------------------------
 * cache —— 恢复 + 保存
 *
 * 保存不能在这一步做完（那时候还没 build，`dist/` 是空的），所以登记一个收尾钩子，
 * 由 runner 在 job/stage 结束时统一 flush。这也是 GitHub 的 post 步骤在做的事。
 * 目录布局：<workDir>/cache/keys/<sha256(key)>/files/... ，另存一份 key.txt 便于排查与 GC。
 * ---------------------------------------------------------------------------------------------- */
const cacheAction = {
  capability: 'cache',
  keys: ['key', 'paths', 'restore_keys', 'mode'],
  async run(ctx, input) {
    const cache = requireCapability(ctx, 'cache', '缓存')
    if (typeof cache.restore !== 'function' || typeof cache.save !== 'function') {
      throw actionError('当前上下文的缓存能力缺少 restore / save 方法', ACTION_ERRORS.UNAVAILABLE)
    }
    const key = asString(input.key)
    if (!key) throw actionError('cache 动作必须给 key（否则每次构建都会命中同一份缓存）', ACTION_ERRORS.INPUT)
    const paths = asList(input.paths)
    if (paths.length === 0) throw actionError('cache 动作必须给 paths', ACTION_ERRORS.INPUT)
    const restoreKeys = asList(input.restore_keys)
    const mode = asString(input.mode, 'both')
    if (!['restore', 'save', 'both'].includes(mode)) {
      throw actionError(`cache 的 mode 只能是 restore / save / both，收到 “${mode}”`, ACTION_ERRORS.INPUT)
    }

    let restored = null
    if (mode === 'restore' || mode === 'both') {
      restored = await ctx.cache.restore({ key, paths, restoreKeys })
      ctx.log(restored.hit
        ? `cache：命中 ${restored.key}（${restored.bytes} 字节）`
        : `cache：未命中 ${key}${restoreKeys.length ? `（也未命中 restore_keys）` : ''}`)
    }
    if (mode === 'save' || mode === 'both') {
      ctx.finalize(async () => {
        const saved = await ctx.cache.save({ key, paths })
        ctx.log(saved.ok
          ? `cache：已保存 ${key}（${saved.bytes} 字节）`
          : `cache：保存 ${key} 失败：${saved.error || '未知原因'}`)
      })
    }
    return { outputs: { key, hit: Boolean(restored?.hit), restoredKey: restored?.key || '' } }
  },
}

/* ------------------------------------------------------------------------------------------------
 * collect —— 收制品进 CAS
 * ---------------------------------------------------------------------------------------------- */
const collectAction = {
  capability: 'collect',
  keys: ['paths', 'name', 'retention'],
  async run(ctx, input) {
    requireCapability(ctx, 'collect', '收集制品')
    const paths = asList(input.paths)
    if (paths.length === 0) throw actionError('collect 动作必须给 paths', ACTION_ERRORS.INPUT)
    const name = asString(input.name, 'default')
    const result = await ctx.collect({ paths, name, retention: asString(input.retention, 'default') })
    if (result.files.length === 0) {
      // 空收集是几乎一定是路径写错了，不是「这次刚好没产物」
      throw actionError(`collect 没有匹配到任何文件：${paths.join('、')}`, ACTION_ERRORS.FAILED)
    }
    ctx.log(`collect：${name} 收到 ${result.files.length} 个文件（${result.bytes} 字节）`)
    return { outputs: { name, files: result.files.length, bytes: result.bytes } }
  },
}

/* ------------------------------------------------------------------------------------------------
 * deploy —— 调部署引擎
 * ---------------------------------------------------------------------------------------------- */
const deployAction = {
  capability: 'deploy',
  keys: ['target', 'artifacts', 'keep', 'strategy'],
  async run(ctx, input) {
    requireCapability(ctx, 'deploy', '部署')
    const target = asString(input.target)
    if (!target) throw actionError('deploy 动作必须给 target', ACTION_ERRORS.INPUT)
    const artifacts = asList(input.artifacts)
    const result = await ctx.deploy({ target, artifacts, keep: asPositiveInt(input.keep, 0), strategy: asString(input.strategy) })
    const hosts = Array.isArray(result?.hosts) ? result.hosts : []
    const failed = hosts.filter((host) => !host.ok)
    if (result?.status && result.status !== 'success') {
      throw actionError(`部署到 ${target} 失败：${result.error || failed.map((host) => `${host.host}: ${host.error}`).join('；') || '未知原因'}`)
    }
    ctx.log(`deploy：${target} ${hosts.length} 台主机完成`)
    return { outputs: { target, hosts: hosts.length, failed: failed.length }, hosts }
  },
}

/* ------------------------------------------------------------------------------------------------
 * verify —— 探针
 *
 * 部署后的冒烟检查。故意只支持 GET/HEAD 与三种断言形态（状态码、包含、正则），
 * 不做「执行脚本」——那会把验证变成第二套部署逻辑。
 * ---------------------------------------------------------------------------------------------- */
const verifyAction = {
  capability: 'fetch',
  keys: ['url', 'expect', 'status', 'contains', 'matches', 'retries', 'interval', 'method', 'timeout'],
  async run(ctx, input) {
    const url = asString(input.url)
    if (!url) throw actionError('verify 动作必须给 url', ACTION_ERRORS.INPUT)
    if (!/^https?:\/\//i.test(url)) throw actionError(`verify 只接受 http(s) 地址，收到 “${url}”`, ACTION_ERRORS.INPUT)
    const method = asString(input.method, 'GET').toUpperCase()
    if (!['GET', 'HEAD'].includes(method)) throw actionError(`verify 只支持 GET/HEAD，收到 ${method}`, ACTION_ERRORS.INPUT)
    const wantStatus = asPositiveInt(input.status, 0)
    const contains = asString(input.contains)
    const matches = asString(input.matches)
    const retries = asPositiveInt(input.retries, 0)
    const interval = asPositiveInt(input.interval, 1000)
    const timeoutMs = asPositiveInt(input.timeout, 5000)
    const fetchImpl = ctx.fetch || globalThis.fetch

    let last = ''
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, interval))
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetchImpl(url, { method, signal: controller.signal, headers: { 'user-agent': 'dsh-cicd-verify' } })
        const text = method === 'HEAD' ? '' : await response.text()
        if (wantStatus && response.status !== wantStatus) { last = `HTTP ${response.status}，期望 ${wantStatus}`; continue }
        if (!wantStatus && !response.ok) { last = `HTTP ${response.status}`; continue }
        if (contains && !text.includes(contains)) { last = `响应里没有 “${contains}”`; continue }
        if (matches && !new RegExp(matches).test(text)) { last = `响应不匹配 /${matches}/`; continue }
        ctx.log(`verify：${url} 通过（HTTP ${response.status}${attempt > 0 ? `，第 ${attempt + 1} 次尝试` : ''}）`)
        return { outputs: { url, status: response.status, attempts: attempt + 1 } }
      } catch (error) {
        last = error.name === 'AbortError' ? `超时（${timeoutMs}ms）` : error.message
      } finally {
        clearTimeout(timer)
      }
    }
    throw actionError(`verify 失败：${url} —— ${last}`, ACTION_ERRORS.FAILED)
  },
}

/* ------------------------------------------------------------------------------------------------
 * notify —— 通知
 * ---------------------------------------------------------------------------------------------- */
const notifyAction = {
  capability: 'notify',
  keys: ['channel', 'template', 'message', 'level'],
  async run(ctx, input) {
    requireCapability(ctx, 'notify', '通知')
    const level = asString(input.level, 'info')
    if (!['info', 'warn', 'error'].includes(level)) throw actionError(`notify 的 level 只能是 info/warn/error，收到 “${level}”`, ACTION_ERRORS.INPUT)
    const message = asString(input.message) || asString(input.template)
    const result = await ctx.notify({ channel: asString(input.channel, 'default'), message, level })
    ctx.log(`notify：${result.delivered ? `已发送到 ${result.delivered} 个 webhook` : '没有配置 webhook，跳过'}`)
    return { outputs: { delivered: result.delivered || 0 } }
  },
}

export const ACTIONS = {
  checkout: checkoutAction,
  toolchain: toolchainAction,
  cache: cacheAction,
  collect: collectAction,
  deploy: deployAction,
  verify: verifyAction,
  notify: notifyAction,
}

/** 执行一个动作。未知动作硬失败——绝不静默跳过。 */
export async function runAction({ name, with: withValue, ctx }) {
  const actionName = asString(name)
  const action = ACTIONS[actionName]
  if (!action) {
    throw actionError(
      `不支持的动作 “${actionName}”（支持：${ACTION_NAMES.join('、')}）。自定义逻辑请用 run: 写 shell`,
      ACTION_ERRORS.UNKNOWN,
    )
  }
  const input = normalizeInput(withValue)
  assertKeys(actionName, input, action.keys)
  return action.run(ctx, input)
}
