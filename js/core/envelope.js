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
 * @property {string} provider       Adapter discriminator.
 * @property {string} model          Provider-native model id.
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
 * @property {string} [baseURL]
 *   Optional override of the adapter's default provider endpoint.
 *   Lets callers point at a self-hosted deployment, regional endpoint,
 *   proxy, or test server. Adapters treat it as `baseURL ?? ADAPTER_DEFAULT`.
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
  'provider',
  'model',
  'prompt',
  'outputBudget',
  'outputType',
  'outputStyle',
  'outputEffort',
  'images',
  'videos',
  'cache',
  'tools',
  'toolChoice',
  'parallelToolCalls',
  'identifier',
  'providerOptions'
])
