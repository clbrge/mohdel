/**
 * Coalesce the delta events of a `call()` stream, with the facade's
 * `bufferOpts` rules (`createRealtimeDeltaBuffer`): deltas of one kind
 * accumulate until `maxChars` is reached or `maxMs` has passed since the
 * last flush, checked as each delta arrives — there is no timer. A change
 * of kind, any other event, and the end of the stream flush first, so
 * order is kept and the terminal event is never held back.
 *
 * @module client/coalesce
 */

/**
 * @param {AsyncIterable<import('#core/events.js').Event>} events
 * @param {{maxChars?: number, maxMs?: number}} [bufferOpts]
 * @returns {AsyncGenerator<import('#core/events.js').Event>}
 */
export async function * coalesce (events, { maxChars = 250, maxMs = 10_000 } = {}) {
  let buffer = ''
  let kind = 'message'
  let lastFlush = Date.now()

  const flush = () => {
    const ev = { type: 'delta', delta: { type: kind, delta: buffer } }
    buffer = ''
    lastFlush = Date.now()
    return ev
  }

  for await (const ev of events) {
    if (ev.type !== 'delta') {
      if (buffer) yield flush()
      yield ev
      continue
    }
    if (!ev.delta.delta) continue
    if (buffer && ev.delta.type !== kind) yield flush()
    kind = ev.delta.type
    buffer += ev.delta.delta
    if (buffer.length >= maxChars || Date.now() - lastFlush >= maxMs) yield flush()
  }
  if (buffer) yield flush()
}
