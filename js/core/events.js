/**
 * Event union for the session → thin-gate → client stream.
 *
 * Four events:
 *   - `delta`  — streaming chunk (message text or function-call args).
 *   - `idle`   — synthetic event emitted when the adapter has been
 *                silent for at least `idleHeartbeatMs` (opt-in via
 *                `CallEnvelope.idleHeartbeatMs`). Carries the elapsed
 *                gap so the consumer can drive its own stall policy.
 *                Never terminal; further events may follow.
 *   - `done`   — terminal with the full `AnswerResult`.
 *   - `error`  — wire-format error (serializable `TypedError`).
 *
 * Rust mirror: `rust/thin-gate/src/protocol.rs::Event`.
 *
 * @module core/events
 */

/**
 * @typedef {(DeltaEvent | IdleEvent | DoneEvent | ErrorEvent)} Event
 */

/**
 * Streaming chunk: `{ type: 'message' | 'function_call', delta: string }`.
 *
 * @typedef {object} DeltaEvent
 * @property {'delta'} type
 * @property {DeltaChunk} delta
 */

/**
 * Synthetic heartbeat emitted by `session/run.js` while the adapter
 * is silent — i.e. no real event (delta / done / error / tool call)
 * for at least `idleHeartbeatMs`. The consumer decides what to do
 * (log, bump a watchdog, abort via its own AbortSignal). Mohdel
 * never aborts on its own.
 *
 * Re-emitted every `idleHeartbeatMs` while the gap persists; the
 * timer resets on the next real event.
 *
 * @typedef {object} IdleEvent
 * @property {'idle'} type
 * @property {number} sinceMs
 *   Milliseconds since the last real event (or since the call
 *   started, when no event has arrived yet).
 */

/**
 * @typedef {object} DeltaChunk
 * @property {('message'|'function_call')} type
 * @property {string} delta
 */

/**
 * Terminal event on success.
 *
 * @typedef {object} DoneEvent
 * @property {'done'} type
 * @property {AnswerResult} result
 */

/**
 * Terminal event on failure.
 *
 * @typedef {object} ErrorEvent
 * @property {'error'} type
 * @property {import('./errors.js').TypedError} error
 */

/**
 * Inference result — the shape returned by the factory `answer()` and
 * carried in `DoneEvent.result`.
 *
 * @typedef {object} AnswerResult
 * @property {import('./status.js').Status} status
 *   `'completed' | 'tool_use' | 'incomplete'`.
 * @property {(string|null)} output
 *   Final text (null when `status === 'tool_use'` with no text).
 * @property {number} inputTokens
 *   Regular (non-cached) input tokens. For OpenAI/cerebras/fireworks where
 *   `cached_tokens` is reported as a SUBSET of `prompt_tokens`, adapters
 *   subtract the cached portion before exposing it here so all providers
 *   produce additive token shapes.
 * @property {number} outputTokens
 * @property {number} thinkingTokens
 * @property {number} [cacheWriteInputTokens]
 *   Input tokens written to a fresh prompt cache breakpoint, billed at
 *   `cacheWritePrice`. Absent when the provider has no separate
 *   cache-write counter.
 * @property {number} [cacheWrite1hInputTokens]
 *   The 1h-TTL subset of `cacheWriteInputTokens` (Anthropic), billed at
 *   `cacheWrite1hPrice`; the 5m portion is the remainder. A request may mix
 *   TTLs. Absent when the turn has no 1h-TTL cache writes.
 * @property {number} [cacheReadInputTokens]
 *   Input tokens served from prompt cache, billed at `cacheReadPrice`.
 *   Absent when the provider has no prompt caching.
 * @property {number} cost
 *   USD, computed from curated pricing. Single number (not a breakdown).
 * @property {Timestamps} timestamps
 * @property {string} [warning]
 *   `'insufficientOutputBudget' | 'cancelled' | ...` additive union.
 * @property {ToolCall[]} [toolCalls]
 *   Present when `status === 'tool_use'`.
 * @property {number} [maxInterFrameMs]
 *   Longest gap (ms) between adapter events during the call —
 *   from `startedAt` to the first frame, between consecutive
 *   frames, and from the last frame to the terminal. Direct signal
 *   for calibrating downstream read timeouts: a 15-min call that
 *   streams deltas every 30s is safe; a 5-min call with zero
 *   intermediate frames is dangerous.
 */

/**
 * `process.hrtime.bigint()` values as strings (nanoseconds).
 *
 * @typedef {object} Timestamps
 * @property {string} start  Adapter invocation start.
 * @property {string} first  Time of first delta.
 * @property {string} end    Completion time.
 */

/**
 * Tool call as emitted on `AnswerResult.toolCalls`. `arguments` is a
 * **parsed object**, not a JSON string.
 *
 * @typedef {object} ToolCall
 * @property {string} id
 * @property {string} name
 * @property {object} arguments
 * @property {string} [thoughtSignature]
 *   Provider-specific opaque blob carried through tool-call
 *   round-trips to preserve thinking state continuity. Set by the
 *   Gemini adapter when the model emits one; absent for other
 *   providers. Callers replaying tool results should pass the
 *   ToolCall back unchanged so the adapter can re-attach it.
 */

export const EVENT_TYPES = Object.freeze(['delta', 'idle', 'done', 'error'])

/**
 * @param {unknown} x
 * @returns {x is Event}
 */
export function isEvent (x) {
  return x !== null && typeof x === 'object' && EVENT_TYPES.includes(/** @type {any} */(x).type)
}
