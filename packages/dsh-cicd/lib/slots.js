/**
 * Slot locks: one file per (host, port), created with O_EXCL semantics over the remote shell.
 *
 * Why a file and not a DB row: the process that holds the port lives on the target host, and the
 * failure we are guarding against is exactly "this box rebooted while the controller believed the
 * slot was taken". A row in our SQLite would be authoritative about a machine it cannot see; a file
 * on that machine is authoritative about itself.
 *
 * Why `set -C` (noclobber) instead of `mkdir`: both are atomic on POSIX, but a lock *file* can
 * carry the payload (pid, release, instance id) in the same operation that claims the name, so
 * there is no window where the lock exists but says nothing. `mkdir` would need a second write.
 *
 * Staleness is decided by evidence, not by age: a slot is reclaimed only when the recorded pid is
 * gone AND the port is not listening. Age alone would reap a perfectly healthy long-running
 * process; pid alone would reap a slot whose process died but whose port is still bound by a
 * lingering socket in TIME_WAIT-less states (rare, but it happens with SO_REUSEPORT).
 */

export const SLOT_ERRORS = {
  EXHAUSTED: 'SLOT_EXHAUSTED',
  INVALID: 'SLOT_INVALID',
}

const OK = 'CICD_SLOT_OK'
const BUSY = 'CICD_SLOT_BUSY'

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function parseJson(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

export function slotFileName(port) {
  return `${Math.trunc(Number(port))}.lock`
}

export function slotsRoot(root) {
  return `${String(root || '').replace(/\/+$/, '')}/slots`
}

function looksListening(port) {
  // 同时兼容 ss 与 netstat，并匹配 `:8080 ` 与 `:8080$`（行尾）。两种工具在 `-ltn` 输出里
  // 端口总是跟在冒号后，因此不需要去区分 IPv4 / IPv6 / 通配地址。
  const p = Math.trunc(Number(port))
  return `(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -qE '[:.]${p}[[:space:]]*$' && echo yes || echo no`
}

/**
 * @param {object} options
 * @param {(command: string, opts?: object) => Promise<{exitCode?: number, stdout?: string, stderr?: string}>} options.run
 *   Executes one shell command on the host this store is bound to. The caller binds the host.
 * @param {string} options.root  directory that holds the slot directory (usually <target.path>)
 * @param {() => number} [options.now]
 */
export function createSlotStore({ run, root, now = Date.now }) {
  if (typeof run !== 'function') throw new Error('createSlotStore 需要 run(command)')
  const dir = slotsRoot(root)

  async function readAll() {
    const listing = await run(`ls -1 ${shellQuote(dir)} 2>/dev/null || true`)
    const names = String(listing?.stdout || '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.endsWith('.lock'))
    const entries = []
    for (const name of names) {
      const body = await run(`cat ${shellQuote(`${dir}/${name}`)} 2>/dev/null || true`)
      const record = parseJson(body?.stdout)
      const port = Number(name.replace(/\.lock$/, ''))
      if (!Number.isInteger(port) || port <= 0) continue
      entries.push({
        port,
        pid: Number(record?.pid) || 0,
        releaseId: String(record?.releaseId || ''),
        instanceId: String(record?.instanceId || ''),
        slot: Number.isInteger(record?.slot) ? record.slot : 0,
        claimedAt: String(record?.claimedAt || ''),
        raw: record,
      })
    }
    entries.sort((a, b) => a.port - b.port)
    return entries
  }

  async function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false
    const result = await run(`kill -0 ${pid} 2>/dev/null && echo yes || echo no`)
    return /yes/.test(String(result?.stdout || ''))
  }

  async function portListening(port) {
    const result = await run(looksListening(port))
    return /yes/.test(String(result?.stdout || ''))
  }

  /**
   * Claim one port. Returns `{ok:true, port, reclaimed}` or `{ok:false, port, holder}`.
   * `reclaimed` is true when an existing lock was proven stale and taken over.
   */
  async function claim({ port, releaseId = '', instanceId = '', slot = 0, pid = 0 }) {
    const file = `${dir}/${slotFileName(port)}`
    const payload = JSON.stringify({
      pid: Number(pid) || 0,
      releaseId: String(releaseId || ''),
      instanceId: String(instanceId || ''),
      slot: Number.isInteger(slot) ? slot : 0,
      claimedAt: new Date(now()).toISOString(),
    })
    await run(`mkdir -p ${shellQuote(dir)}`)
    const create = async () => {
      const result = await run(
        `(set -C; printf '%s' ${shellQuote(payload)} > ${shellQuote(file)}) 2>/dev/null && echo ${OK} || echo ${BUSY}`,
      )
      return new RegExp(OK).test(String(result?.stdout || ''))
    }
    if (await create()) return { ok: true, port, reclaimed: false }

    // 有人占着。判断它是不是僵尸：pid 没了、端口也没在听，才算。
    const body = await run(`cat ${shellQuote(file)} 2>/dev/null || true`)
    const record = parseJson(body?.stdout)
    const holderPid = Number(record?.pid) || 0
    const alive = await pidAlive(holderPid)
    const listening = await portListening(port)
    if (alive || listening) {
      return {
        ok: false,
        port,
        holder: {
          pid: holderPid,
          releaseId: String(record?.releaseId || ''),
          instanceId: String(record?.instanceId || ''),
          alive,
          listening,
        },
      }
    }
    await run(`rm -f ${shellQuote(file)}`)
    if (await create()) return { ok: true, port, reclaimed: true, previous: record || null }
    return { ok: false, port, holder: { pid: holderPid, alive, listening, race: true } }
  }

  /** Rewrite an existing lock with the real pid once the process is up. */
  async function stampPid({ port, pid, releaseId = '', instanceId = '', slot = 0 }) {
    const file = `${dir}/${slotFileName(port)}`
    const payload = JSON.stringify({
      pid: Number(pid) || 0,
      releaseId: String(releaseId || ''),
      instanceId: String(instanceId || ''),
      slot: Number.isInteger(slot) ? slot : 0,
      claimedAt: new Date(now()).toISOString(),
    })
    await run(`printf '%s' ${shellQuote(payload)} > ${shellQuote(file)}`)
  }

  async function release(port) {
    await run(`rm -f ${shellQuote(`${dir}/${slotFileName(port)}`)}`)
    return true
  }

  /**
   * Allocate `count` consecutive-by-step ports starting at `base`.
   * Returns `{ok, ports, reclaimed, failed}`; on failure every port claimed in this call is released
   * again, because a half-allocated set is worse than none: the caller cannot start a partial
   * instance group and would leak the successful claims until the next reclaim sweep.
   */
  async function allocate({ count, base, step = 1, releaseId = '', instancePrefix = '', startSlot = 0 }) {
    const total = Number(count)
    const first = Number(base)
    const stride = Number(step) || 1
    if (!Number.isInteger(total) || total <= 0) {
      throw Object.assign(new Error(`instances.count 必须是正整数，收到 ${count}`), { code: SLOT_ERRORS.INVALID })
    }
    if (!Number.isInteger(first) || first <= 0 || first > 65535) {
      throw Object.assign(new Error(`instances.port.base 必须是 1–65535 的整数，收到 ${base}`), { code: SLOT_ERRORS.INVALID })
    }
    const wanted = []
    for (let index = 0; index < total; index += 1) {
      const port = first + index * stride
      if (port > 65535) {
        throw Object.assign(new Error(`端口越界：第 ${index + 1} 个实例算出 ${port}`), { code: SLOT_ERRORS.INVALID })
      }
      wanted.push(port)
    }
    const claimed = []
    const reclaimed = []
    for (let index = 0; index < wanted.length; index += 1) {
      const port = wanted[index]
      const slot = startSlot + index
      const attempt = await claim({
        port,
        releaseId,
        instanceId: instancePrefix ? `${instancePrefix}/${slot}` : '',
        slot,
      })
      if (!attempt.ok) {
        for (const done of claimed) await release(done)
        return {
          ok: false,
          ports: [],
          reclaimed,
          failed: { port, holder: attempt.holder || null },
        }
      }
      claimed.push(port)
      if (attempt.reclaimed) reclaimed.push({ port, previous: attempt.previous || null })
    }
    return { ok: true, ports: claimed, reclaimed, failed: null }
  }

  /** Reclaim every provably dead lock. Returns the reclaimed entries. */
  async function reclaim() {
    const entries = await readAll()
    const done = []
    for (const entry of entries) {
      const alive = await pidAlive(entry.pid)
      if (alive) continue
      const listening = await portListening(entry.port)
      if (listening) continue
      await release(entry.port)
      done.push({ ...entry, reclaimedAt: new Date(now()).toISOString() })
    }
    return done
  }

  async function list() {
    const entries = await readAll()
    const out = []
    for (const entry of entries) {
      out.push({
        ...entry,
        alive: await pidAlive(entry.pid),
        listening: await portListening(entry.port),
      })
    }
    return out
  }

  /**
   * 把一组端口一次还回去。存在的理由很朴素：调用方的失败路径通常是「一批端口刚拿到、紧接着
   * 下一步就炸了」，逐端口 try/catch 的循环会在每个调用点重复一遍，而漏掉其中一次就意味着
   * 这些端口要等到僵尸回收才可能被再次分配。
   */
  async function releaseAll(ports) {
    const list = Array.isArray(ports) ? ports : []
    for (const port of list) {
      try { await release(port) } catch { /* best effort：回收失败不该掩盖真正的错误 */ }
    }
    return list.length
  }

  return { dir, root, claim, stampPid, release, releaseAll, allocate, reclaim, list }
}
