/**
 * Idle-heartbeat wrapper for an adapter's event stream.
 *
 * `withIdleHeartbeat(source, idleMs)` consumes `source` and re-emits
 * every event it yields. When `source` is silent for at least
 * `idleMs`, an `{type:'idle', sinceMs}` event is yielded; while the
 * silence persists, further idle events are yielded every `idleMs`.
 * The timer resets on every real event.
 *
 * Idle events are advisory — mohdel does not abort the call on its
 * own. Consumers decide whether to log, bump a watchdog, or trigger
 * an external AbortSignal.
 *
 * The in-flight `iterator.next()` is reused across timer firings so
 * no real event is dropped: when the timer wins the race, the
 * underlying promise stays pending and the next loop iteration
 * attaches a fresh race to the same promise.
 *
 * @module session/_idle_heartbeat
 */

/**
 * @template T
 * @param {AsyncIterable<T>} source
 * @param {number | undefined | null} idleMs
 *   When falsy or non-positive, the source is yielded through
 *   unchanged (no timer is set up).
 * @returns {AsyncGenerator<T | import('#core/events.js').IdleEvent>}
 */
export async function * withIdleHeartbeat (source, idleMs) {
  if (!idleMs || idleMs <= 0) {
    yield * source
    return
  }

  const iter = source[Symbol.asyncIterator]()
  let lastAt = Date.now()
  /** @type {Promise<IteratorResult<T>> | null} */
  let pending = null

  try {
    while (true) {
      if (!pending) pending = iter.next()

      /** @type {NodeJS.Timeout | undefined} */
      let timer
      /** @type {{idle: true} | {real: IteratorResult<T>} | {err: unknown}} */
      const winner = await new Promise(resolve => {
        timer = setTimeout(() => resolve({ idle: true }), idleMs)
        pending.then(
          r => resolve({ real: r }),
          e => resolve({ err: e })
        )
      })
      clearTimeout(timer)

      if ('idle' in winner) {
        yield /** @type {import('#core/events.js').IdleEvent} */ ({
          type: 'idle',
          sinceMs: Date.now() - lastAt
        })
        continue
      }

      pending = null
      if ('err' in winner) throw winner.err
      if (winner.real.done) return
      lastAt = Date.now()
      yield winner.real.value
    }
  } finally {
    // Best-effort cleanup if the consumer abandons us mid-stream.
    if (typeof iter.return === 'function') {
      try { await iter.return() } catch { /* ignore */ }
    }
  }
}
