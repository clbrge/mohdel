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
 * `idleMs` is caller-supplied and raised to `MIN_IDLE_HEARTBEAT_MS`.
 * Without a floor one request can ask for a millisecond cadence and
 * turn adapter silence into thousands of serialized events per second
 * through the gate.
 *
 * The in-flight `iterator.next()` is reused across timer firings so no
 * real event is dropped. Its continuation is attached exactly once, at
 * creation, and parks its result in `settled`; each idle tick races a
 * fresh timer against that flag rather than re-subscribing. Attaching
 * per tick instead would retain two reaction records per firing on a
 * promise that by definition has not settled.
 *
 * @module session/_idle_heartbeat
 */

export const MIN_IDLE_HEARTBEAT_MS = 250

/**
 * @template T
 * @param {AsyncIterable<T>} source
 * @param {number | undefined | null} idleMs
 *   When falsy or non-positive, the source is yielded through
 *   unchanged (no timer is set up). Positive values below
 *   `MIN_IDLE_HEARTBEAT_MS` are raised to it.
 * @returns {AsyncGenerator<T | import('#core/events.js').IdleEvent>}
 */
export async function * withIdleHeartbeat (source, idleMs) {
  if (!idleMs || idleMs <= 0) {
    yield * source
    return
  }

  const tickMs = Math.max(idleMs, MIN_IDLE_HEARTBEAT_MS)
  const iter = source[Symbol.asyncIterator]()
  let lastAt = Date.now()

  /** @type {{real: IteratorResult<T>} | {err: unknown} | null} */
  let settled = null
  /** @type {(() => void) | null} */
  let wake = null
  let inFlight = false

  const park = (result) => {
    settled = result
    const w = wake
    wake = null
    w?.()
  }

  try {
    while (true) {
      if (!inFlight) {
        inFlight = true
        iter.next().then(
          r => park({ real: r }),
          e => park({ err: e })
        )
      }

      if (!settled) {
        /** @type {NodeJS.Timeout | undefined} */
        let timer
        await new Promise(resolve => {
          wake = resolve
          timer = setTimeout(resolve, tickMs)
        })
        clearTimeout(timer)
        wake = null
      }

      if (!settled) {
        yield /** @type {import('#core/events.js').IdleEvent} */ ({
          type: 'idle',
          sinceMs: Date.now() - lastAt
        })
        continue
      }

      const done = settled
      settled = null
      inFlight = false
      if ('err' in done) throw done.err
      if (done.real.done) return
      lastAt = Date.now()
      yield done.real.value
    }
  } finally {
    // Best-effort cleanup if the consumer abandons us mid-stream.
    if (typeof iter.return === 'function') {
      try { await iter.return() } catch { /* ignore */ }
    }
  }
}
