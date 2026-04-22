/**
 * Fake provider — scenario-driven adapter for stress tests,
 * benchmarks, and bug reproductions. Never calls a real API.
 *
 * The envelope's `prompt` field carries a JSON scenario spec; the
 * `mode` key picks a behavior, the rest are mode-specific params.
 * Invalid / non-JSON prompts fall through to `mode: "echo"` so ad-hoc
 * use from scripts Just Works.
 *
 * ## Modes
 *
 * | mode          | params                         | behavior                                             |
 * |---------------|--------------------------------|------------------------------------------------------|
 * | `echo`        | –                              | one short delta + `done` (default fallback)          |
 * | `slow`        | `tokens`, `delayMs`            | emit N deltas `delayMs` apart                        |
 * | `volume`      | `tokens`                       | emit N deltas as fast as the event loop allows       |
 * | `tool`        | `name`, `args`                 | single `tool_use` terminal with one tool call        |
 * | `incomplete`  | `warning`                      | `done` with status=incomplete + warning              |
 * | `error`       | `type`, `message`, `retryable` | yield typed error event                              |
 * | `hang`        | –                              | never emits a terminal (caller aborts via signal)    |
 * | `cancel_after`| `tokens`                       | emit N deltas then wait for `signal.aborted`         |
 * | `crash`       | `code`                         | `process.exit(code\|1)` — kills whichever process is running the adapter. Used by the isolation benchmark to demonstrate that via-gate the crash stays in the session subprocess, in-process it takes down the caller. |
 *
 * Every mode honors `deps.signal`: when aborted mid-stream, emits a
 * `cancelled` done event. That keeps consumer behavior uniform with
 * the real provider adapters.
 *
 * @module session/adapters/fake
 */

import {
  STATUS_COMPLETED,
  STATUS_INCOMPLETE,
  STATUS_TOOL_USE,
  WARNING_INSUFFICIENT_OUTPUT_BUDGET
} from '#core/status.js'

import { cancelledDone } from './_cancelled.js'

/**
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {{signal?: AbortSignal, log?: any}} [deps]
 * @returns {AsyncGenerator<import('#core/events.js').Event>}
 */
export async function * fake (envelope, deps = {}) {
  const signal = deps.signal
  const spec = parseSpec(envelope.prompt)
  const start = String(process.hrtime.bigint())
  let first = null

  switch (spec.mode) {
    case 'error':
      yield {
        type: 'error',
        error: {
          message: spec.message ?? 'fake error',
          severity: spec.severity ?? 'error',
          retryable: spec.retryable ?? false,
          type: spec.type ?? 'PROVIDER_ERROR'
        }
      }
      return

    case 'hang':
      // Wait for abort. If the signal is already aborted, yield
      // cancelled immediately. Otherwise block until it fires.
      await waitForAbort(signal)
      yield cancelledDone(start, first, envelope, '', 0, 0)
      return

    case 'crash': {
      // Kills whatever process is executing the adapter. In-process
      // this takes down the caller; via the gate it only takes down
      // one session subprocess, which the pool respawns.
      const code = Number.isInteger(spec.code) ? spec.code : 1
      process.exit(code)
      // process.exit does not return; this line is unreachable but
      // the linter can't see that and would flag no-fallthrough.
      return
    }

    case 'incomplete': {
      const warning = spec.warning ?? WARNING_INSUFFICIENT_OUTPUT_BUDGET
      const text = spec.output ?? 'partial output'
      first = String(process.hrtime.bigint())
      yield { type: 'delta', delta: { type: 'message', delta: text } }
      yield doneEvent({
        status: STATUS_INCOMPLETE,
        output: text,
        warning,
        start,
        first,
        tokens: approxTokens(text)
      })
      return
    }

    case 'tool': {
      const name = spec.name ?? 'fake_tool'
      const args = spec.args ?? {}
      const id = spec.id ?? `fake_call_${Date.now()}`
      first = String(process.hrtime.bigint())
      yield {
        type: 'delta',
        delta: { type: 'function_call', delta: JSON.stringify(args) }
      }
      yield doneEvent({
        status: STATUS_TOOL_USE,
        output: null,
        start,
        first,
        tokens: 0,
        toolCalls: [{ id, name, arguments: args }]
      })
      return
    }

    case 'slow':
    case 'volume': {
      const total = clampPositive(spec.tokens, 5)
      const delayMs = spec.mode === 'slow' ? clampPositive(spec.delayMs, 50) : 0
      let output = ''
      for (let i = 0; i < total; i++) {
        if (signal?.aborted) {
          yield cancelledDone(start, first, envelope, output, approxTokens(output), approxTokens(output))
          return
        }
        if (first === null) first = String(process.hrtime.bigint())
        const chunk = spec.chunk ?? `tok${i} `
        output += chunk
        yield { type: 'delta', delta: { type: 'message', delta: chunk } }
        if (delayMs > 0) {
          await sleep(delayMs, signal)
          if (signal?.aborted) {
            yield cancelledDone(start, first, envelope, output, approxTokens(output), approxTokens(output))
            return
          }
        }
      }
      yield doneEvent({
        status: STATUS_COMPLETED,
        output,
        start,
        first,
        tokens: approxTokens(output)
      })
      return
    }

    case 'cancel_after': {
      const total = clampPositive(spec.tokens, 3)
      let output = ''
      for (let i = 0; i < total; i++) {
        if (first === null) first = String(process.hrtime.bigint())
        const chunk = `tok${i} `
        output += chunk
        yield { type: 'delta', delta: { type: 'message', delta: chunk } }
      }
      await waitForAbort(signal)
      yield cancelledDone(start, first, envelope, output, approxTokens(output), approxTokens(output))
      return
    }

    case 'echo':
    default: {
      const text = spec.output ?? 'ok'
      first = String(process.hrtime.bigint())
      yield { type: 'delta', delta: { type: 'message', delta: text } }
      yield doneEvent({
        status: STATUS_COMPLETED,
        output: text,
        start,
        first,
        tokens: approxTokens(text)
      })
    }
  }
}

/**
 * @param {string | any[]} prompt
 * @returns {{mode: string, [k: string]: any}}
 */
function parseSpec (prompt) {
  if (typeof prompt !== 'string') return { mode: 'echo' }
  const trimmed = prompt.trim()
  if (!trimmed.startsWith('{')) return { mode: 'echo' }
  try {
    const obj = JSON.parse(trimmed)
    if (!obj || typeof obj !== 'object' || !obj.mode) return { mode: 'echo' }
    return obj
  } catch {
    return { mode: 'echo' }
  }
}

/**
 * @param {number | undefined} v
 * @param {number} fallback
 */
function clampPositive (v, fallback) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return fallback
  return Math.floor(v)
}

/** Cheap token estimate — 4 chars/token, deterministic across runs. */
function approxTokens (text) {
  return Math.max(1, Math.ceil((text?.length ?? 0) / 4))
}

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
function sleep (ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    }
  })
}

/** @param {AbortSignal} [signal] */
function waitForAbort (signal) {
  if (!signal) return new Promise(() => {}) // never resolves — caller had better set a timeout
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

/**
 * @param {{
 *   status: string,
 *   output: string | null,
 *   start: string,
 *   first: string | null,
 *   tokens: number,
 *   warning?: string,
 *   toolCalls?: any[]
 * }} opts
 * @returns {import('#core/events.js').DoneEvent}
 */
function doneEvent (opts) {
  const end = String(process.hrtime.bigint())
  const result = {
    status: opts.status,
    output: opts.output,
    inputTokens: opts.tokens,
    outputTokens: opts.tokens,
    thinkingTokens: 0,
    cost: 0,
    timestamps: { start: opts.start, first: opts.first ?? end, end }
  }
  if (opts.warning) result.warning = opts.warning
  if (opts.toolCalls) result.toolCalls = opts.toolCalls
  return { type: 'done', result }
}
