/**
 * V2-M1：实时日志中心（进程内）。
 *
 * runner 的 log() 每写一行就调用 hub.append()：先入环形缓冲，再同步 fan-out 给订阅者。
 * 订阅发生在任意时刻都无竞态：append 与 subscribe 都在事件循环里同步执行，
 * 订阅者拿到的快照（ring 内容）+ 之后的事件流正好无缝衔接。
 *
 * - 活跃 run：WS 客户端连上时先收 ring 快照，再收实时行，run 结束收 end 事件。
 * - 已结束 run：hub 里没有 ring（run 结束即丢弃），WS 端退化为读日志文件尾部 + end。
 * - ring 上限 5000 行：超限丢最旧行并标记 truncated，防止失控日志吃内存。
 */

const RING_LIMIT = 5000

export function createLiveHub() {
  const rings = new Map() // runId -> { lines: [], truncated: false, status: '' }
  const subscribers = new Map() // runId -> Set<fn>

  const ring = (runId) => {
    let entry = rings.get(runId)
    if (!entry) {
      entry = { lines: [], truncated: false, status: '' }
      rings.set(runId, entry)
    }
    return entry
  }

  return {
    /** runner 每行日志调用一次。entry 形如 { stageId, index, line }。 */
    append(runId, entry) {
      const state = ring(runId)
      if (state.lines.length >= RING_LIMIT) {
        state.lines.shift()
        state.truncated = true
      }
      state.lines.push(entry)
      const set = subscribers.get(runId)
      if (!set || set.size === 0) return
      for (const fn of set) {
        try { fn({ type: 'line', ...entry }) } catch { /* subscriber errors never break the run */ }
      }
    },

    /** run 结束（任何状态）调用：通知订阅者并丢弃 ring。 */
    end(runId, status) {
      const state = rings.get(runId)
      const set = subscribers.get(runId)
      if (set && set.size > 0) {
        for (const fn of set) {
          try { fn({ type: 'end', status }) } catch { /* subscriber errors never break the run */ }
        }
      }
      rings.delete(runId)
      subscribers.delete(runId)
      if (state) state.status = status
    },

    /** 订阅：立即返回当前快照（行数组），之后新行/结束事件走回调。 */
    subscribe(runId, fn) {
      let set = subscribers.get(runId)
      if (!set) {
        set = new Set()
        subscribers.set(runId, set)
      }
      set.add(fn)
      const state = rings.get(runId)
      return {
        snapshot: state ? state.lines.slice() : [],
        truncated: Boolean(state?.truncated),
        active: Boolean(state),
        unsubscribe() { set?.delete(fn) },
      }
    },

    /** 当前活跃（有 ring）的 runId 列表，调试用。 */
    activeRunIds() { return [...rings.keys()] },

    dispose() {
      rings.clear()
      subscribers.clear()
    },
  }
}
