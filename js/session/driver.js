/**
 * NDJSON stdio driver.
 *
 * Reads lines from stdin concurrently with running calls:
 *   - Envelope line (no `op` field): queued for sequential dispatch
 *     via `run()`. Events written to stdout as NDJSON.
 *   - Control message `{op:"cancel", callId}`: if it matches the
 *     in-flight call, aborts via AbortController.
 *
 * Single-call-at-a-time per process.
 *
 * @module session/driver
 */

import readline from 'node:readline'

import { run } from './run.js'
import { runImage } from './run_image.js'
import { setCatalog } from './adapters/_catalog.js'

// Bounded memory for pre-dequeue cancels. Hostile/buggy supervisors
// spamming random callIds can't grow the set without bound.
const PRECANCEL_CAP = 128

/**
 * @param {NodeJS.ReadableStream} stdin
 * @param {NodeJS.WritableStream} stdout
 * @returns {Promise<void>}
 */
export async function drive (stdin, stdout) {
  const rl = readline.createInterface({ input: stdin, crlfDelay: Infinity })

  /** @type {{callId: string, controller: AbortController} | null} */
  let currentCall = null
  /** @type {import('#core/envelope.js').CallEnvelope[]} */
  const envelopeQueue = []
  /** @type {(() => void) | null} */
  let queueNotify = null
  let stdinClosed = false
  /** Cancel messages received before their envelope was dequeued.
   *  JS Sets are insertion-ordered, so `values().next()` is the
   *  oldest entry — cheap FIFO eviction at cap. */
  const precancelled = new Set()

  function recordPrecancel (callId) {
    if (precancelled.has(callId)) return
    if (precancelled.size >= PRECANCEL_CAP) {
      precancelled.delete(precancelled.values().next().value)
    }
    precancelled.add(callId)
  }

  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return

    let obj
    try {
      obj = JSON.parse(trimmed)
    } catch (e) {
      process.stderr.write(`session: failed to parse stdin line: ${e.message}\n`)
      return
    }

    if (obj && typeof obj === 'object' && obj.op === 'cancel') {
      if (currentCall && currentCall.callId === obj.callId) {
        currentCall.controller.abort()
      } else {
        // Pre-dequeue cancel: remember the callId so the envelope
        // aborts immediately on dispatch. Honored once then cleared.
        recordPrecancel(obj.callId)
      }
      return
    }

    // Readiness heartbeat from supervisor: the pool sends `ping`
    // before marking a fresh session "pool-ready". Reply immediately
    // with `pong` on stdout — emitted as a standalone control frame,
    // outside any in-flight call's event stream.
    //
    // Current protocol pings only between calls. If a supervisor
    // violates that invariant and pings a busy session, emitting
    // `{op:"pong"}` mid-stream would land in the gate's
    // `pool_stream_next` read buffer, fail Event parse, and get
    // classified as `SESSION_INVALID_EVENT` — killing the session.
    // Drop mid-call pings; the supervisor can re-ping after the
    // call terminates.
    // Catalog injection from the supervisor. Supersedes whatever was
    // loaded from disk at startup. Lets a supervisor (e.g. a
    // thin-gate session pool) run sessions in contexts without
    // access to `~/.config/mohdel/` by providing the catalog via
    // stdin instead.
    if (obj && typeof obj === 'object' && obj.op === 'set_catalog') {
      if (obj.table && typeof obj.table === 'object') {
        setCatalog(obj.table)
      } else {
        process.stderr.write('session: set_catalog requires `table: object`\n')
      }
      return
    }

    if (obj && typeof obj === 'object' && obj.op === 'ping') {
      if (currentCall) {
        process.stderr.write(
          `session: ping during in-flight call ${currentCall.callId}; ignored\n`
        )
        return
      }
      stdout.write(JSON.stringify({ op: 'pong' }) + '\n')
      return
    }

    envelopeQueue.push(obj)
    if (queueNotify) { queueNotify(); queueNotify = null }
  })

  rl.on('close', () => {
    stdinClosed = true
    if (queueNotify) { queueNotify(); queueNotify = null }
  })

  while (true) {
    // `stdinClosed` flips asynchronously inside the `rl.on('close')`
    // callback above, which also signals `queueNotify`. The linter's
    // no-unmodified-loop-condition rule can't see callback mutation,
    // so it false-positives here.
    // eslint-disable-next-line no-unmodified-loop-condition
    while (envelopeQueue.length === 0 && !stdinClosed) {
      await new Promise(resolve => { queueNotify = resolve })
    }
    if (envelopeQueue.length === 0) return

    const envelope = envelopeQueue.shift()
    const controller = new AbortController()
    if (precancelled.delete(envelope.callId)) controller.abort()
    currentCall = { callId: envelope.callId, controller }

    try {
      if (envelope.op === 'image') {
        // Image envelopes are one-shot: a single terminal line on
        // stdout, no streaming. `op` is a driver-internal tag
        // (strip before dispatch so the JS ImageEnvelope shape
        // matches `js/core/image.js` exactly).
        const { op: _op, ...imgEnv } = envelope
        const out = await runImage(imgEnv)
        if (out.ok) {
          stdout.write(JSON.stringify({ type: 'image_done', result: out.result }) + '\n')
        } else {
          stdout.write(JSON.stringify({ type: 'error', error: out.error }) + '\n')
        }
      } else {
        for await (const ev of run(envelope, { signal: controller.signal })) {
          stdout.write(JSON.stringify(ev) + '\n')
        }
      }
    } finally {
      currentCall = null
    }
  }
}
