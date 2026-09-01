/**
 * Canonical call envelope — the frozen wire shape for a single
 * inference call. Flat `answer(prompt, options)` surface plus the
 * minimum transport metadata needed to cross a process boundary
 * (callId, authId, auth.key, traceparent).
 *
 * camelCase on the wire. JSON on NDJSON frames. Rust mirror:
 * `rust/thin-gate/src/protocol.rs`.
 *
 * @module core/envelope
 */

/**
 * @typedef {object} CallEnvelope
 *
 * @property {string} callId
 *   Unique per call.
 * @property {string} authId
 *   Quota-scoping identity (rate-limit/cooldown bucket). Distinct
 *   from `identifier`, which is the provider-side safety/tracking
 *   ID that gets forwarded to the provider API.
 * @property {Auth} auth
 * @property {string} [traceparent]  W3C tracecontext header.
 * @property {string} [baggage]      W3C baggage header.
 *
 * @property {string} model
 *   Full mohdel id — `"<provider>/<bare>[:<effort>]"`. Same shape
 *   on the wire and in-process. See PROTOCOL §3. No separate
 *   `provider` field exists at any layer; callers that need the
 *   provider or bare part use the helpers in `core/model-id.js`.
 *
 * @property {(string|Message[])} prompt
 *   Either a plain string or a structured array of messages.
 *
 * --- Answer options (flat) ---
 *
 * @property {number} [outputBudget]
 *   Max output tokens (clamped to model's outputTokenLimit).
 * @property {('text'|'json')} [outputType]
 *   Default 'text'.
 * @property {('chat'|'coding'|'analysis'|'translation'|'creative')} [outputStyle]
 * @property {string} [outputEffort]
 *   Thinking effort level. Valid keys are per-model — validated at
 *   runtime against the curated entry's `thinkingEffortLevels`.
 *   Default is the model's `defaultThinkingEffort`.
 * @property {string} [speed]
 *   Service speed lane. Valid keys are per-model — validated at
 *   runtime against the curated entry's `speeds`. There is no
 *   default and no fallback: omitting the field sends no speed
 *   parameter, while naming a lane the entry does not declare
 *   (`SESSION_INVALID_SPEED`) or the provider's adapter cannot emit
 *   (`SESSION_SPEED_NOT_IMPLEMENTED`) fails the call before dispatch.
 *
 * @property {MediaRef[]} [images]
 * @property {MediaRef[]} [videos]
 * @property {boolean} [cache]
 *   Cache uploaded files (Gemini videos).
 *
 * @property {ToolSpec[]} [tools]
 * @property {('auto'|'required'|'none'|string)} [toolChoice]
 * @property {boolean} [parallelToolCalls]
 *
 * @property {string} [identifier]
 *   Opaque per-user ID passed to the provider for tracking / abuse
 *   monitoring.
 *
 * @property {number} [idleHeartbeatMs]
 *   When set, the session emits a synthetic `{type:'idle', sinceMs}`
 *   event whenever the adapter has been silent for at least this
 *   many milliseconds, and re-emits every `idleHeartbeatMs` while
 *   the gap persists. The consumer decides whether to act (log,
 *   bump a watchdog, abort via its own AbortSignal). Mohdel never
 *   aborts on its own. Omitting the field disables the heartbeat.
 *   Positive values are raised to `MIN_IDLE_HEARTBEAT_MS` (250).
 *
 * @property {Object<string, object>} [providerOptions]
 *   Namespaced bag of provider-specific knobs that don't fit the
 *   shared envelope. Keys are provider names; values are arbitrary
 *   JSON objects the matching adapter consumes. Today only
 *   `providerOptions.openrouter = {order?, allow?, deny?}` is
 *   recognized (OpenRouter routing preferences). Unknown keys are
 *   accepted on the wire and silently ignored by adapters that
 *   don't read them — upgrade to a typed sub-struct per provider if
 *   strict validation becomes necessary.
 */

/**
 * @typedef {object} Auth
 * @property {string} key  Provider API key. Redact in logs; never persist.
 */

/**
 * @typedef {object} Message
 * @property {('system'|'user'|'assistant'|'tool')} role
 * @property {(string|MessagePart[])} content
 * @property {string} [toolCallId]
 *   Set on `tool` messages — identifies which assistant tool call
 *   this is a response to.
 * @property {string} [name]
 *   Optional function name for `tool` messages (providers that
 *   require naming the tool alongside the response).
 * @property {ToolCall[]} [toolCalls]
 *   Set on `assistant` messages when the model called tools in this
 *   turn. Preserves multi-turn histories where the assistant both
 *   spoke text AND invoked tools; adapters emit the provider-native
 *   tool_use / function_call / tool_calls representation.
 */

/**
 * @typedef {object} ToolCall
 * @property {string} id
 * @property {string} name
 * @property {object} arguments  Parsed object, not a JSON string.
 */

/**
 * @typedef {object} MessagePart
 * @property {('text'|'reasoning')} type
 * @property {string} text
 * @property {('5m'|'1h')} [cache]
 *   Prompt-cache marker. On system parts: a breakpoint at this block.
 *   On non-system parts: opts the whole conversation into prefix
 *   caching (adapter places the breakpoints). Providers with
 *   automatic caching ignore it.
 */

/**
 * @typedef {object} MediaRef
 * @property {string} fileUri
 * @property {string} mimeType
 */

/**
 * @typedef {object} ToolSpec
 * @property {string} name
 * @property {string} [description]
 * @property {object} parameters  JSON Schema
 */

export const ENVELOPE_FIELDS = Object.freeze([
  'callId',
  'authId',
  'auth',
  'traceparent',
  'baggage',
  'model',
  'prompt',
  'outputBudget',
  'outputType',
  'outputStyle',
  'outputEffort',
  'speed',
  'images',
  'videos',
  'cache',
  'tools',
  'toolChoice',
  'parallelToolCalls',
  'identifier',
  'idleHeartbeatMs',
  'providerOptions'
])

export const MAX_ID_BYTES = 128
export const MAX_MODEL_BYTES = 256
export const MAX_PROVIDER_BYTES = 32

const encoder = new TextEncoder()

/**
 * @param {string} s
 * @returns {number}
 */
function byteLength (s) {
  return encoder.encode(s).length
}

/**
 * Bound the envelope fields that become long-lived map keys and
 * telemetry attributes, and reject a model id with an empty half.
 *
 * Mirror of `rust/thin-gate/src/protocol.rs::validate_ids`, applied on
 * the in-process factory path which does not cross the gate. Reason
 * strings match the gate's byte for byte so both transports report a
 * rejection identically.
 *
 * @param {string} callId
 * @param {string} authId
 * @param {string} model
 * @returns {string | undefined}  Reason, or undefined when valid.
 */
export function validateIds (callId, authId, model) {
  if (byteLength(callId) > MAX_ID_BYTES) return `callId exceeds ${MAX_ID_BYTES} bytes`
  if (byteLength(authId) > MAX_ID_BYTES) return `authId exceeds ${MAX_ID_BYTES} bytes`
  if (byteLength(model) > MAX_MODEL_BYTES) return `model exceeds ${MAX_MODEL_BYTES} bytes`

  const slash = model.indexOf('/')
  const provider = slash < 0 ? '' : model.slice(0, slash)
  const bare = slash < 0 ? '' : model.slice(slash + 1)
  if (slash < 0 || !provider || !bare) {
    return `model must be '<provider>/<id>' (got: ${model})`
  }
  if (byteLength(provider) > MAX_PROVIDER_BYTES) {
    return `model provider exceeds ${MAX_PROVIDER_BYTES} bytes`
  }
}
