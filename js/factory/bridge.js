/**
 * Factory bridge — in-process path from the `mohdel()` factory API
 * to the `/session` runtime.
 *
 * The factory surface is `mohdel().use(model).answer(prompt, options)`
 * returning a `Promise<AnswerResult>`. This module takes those
 * call arguments, builds a `CallEnvelope` (the wire shape
 * documented in `PROTOCOL.md`), drives `run()` / `runImage()`
 * in `js/session/`, and collapses the event stream back into a
 * single result object.
 *
 * The bridge is what the `mo` CLI, library consumers doing
 * `import mohdel from 'mohdel'`, and test harnesses all sit on top
 * of. It's **in-process only** — `thin-gate` is not spawned. For
 * the subprocess path use `mohdel/client` directly.
 *
 * Adapter error events are rethrown as `MohdelError` so caller
 * catch blocks see a thrown exception rather than an event.
 *
 * @module factory/bridge
 */

import { run } from '../session/run.js'
import { runImage } from '../session/run_image.js'
import { MohdelError, Severity } from '../../src/lib/errors.js'
import { createRealtimeDeltaBuffer } from '../../src/lib/utils.js'

/**
 * @typedef {object} BridgeDeps
 * @property {object} [cooldown]  Cooldown tracker injected into run().
 * @property {object} [limiter]   Rate limiter injected into run().
 * @property {(provider: string) => any} [resolveProviderLimits]
 *   Hook that returns `{rpmLimit, tpmLimit}` for a given provider —
 *   lets the factory keep its own `providersConfig` as source of
 *   truth instead of the module-level `providers.json` loader.
 * @property {AbortSignal} [signal]
 */

/**
 * Run `answer()` through the /session runtime.
 *
 * ## Option mapping
 *
 * Every factory `answer()` option is either mapped onto the envelope
 * or intentionally ignored. Ignored options are listed explicitly —
 * audit any "missing option" report against this table first.
 *
 * | factory option                                    | envelope destination                                 |
 * |---------------------------------------------------|------------------------------------------------------|
 * | `outputBudget`/`outputType`/`outputStyle`/`outputEffort` | flat fields on envelope                       |
 * | `images` / `videos` / `cache`                     | flat fields on envelope                              |
 * | `tools` / `toolChoice` / `parallelToolCalls`      | flat fields on envelope                              |
 * | `identifier`                                      | envelope.identifier (adapter maps to provider field) |
 * | `realtimeHandler` / `bufferOpts`                  | drained via createRealtimeDeltaBuffer                |
 * | `providerOrder` / `providerAllow` / `providerDeny`| envelope.providerOptions.openrouter                  |
 * | `traceparent` / `baggage`                         | envelope transport metadata                          |
 * | `callId` / `authId`                               | envelope transport metadata                          |
 * | `configuration.apiKey`                            | envelope.auth.key                                    |
 * | **`parentSpan`**                                  | **dropped** — use `traceparent` instead              |
 * | **`maybeThrowHandler`**                           | **dropped** — no factory-side validation hook        |
 * | **`configuration.baseURL` / `defaultHeaders` / …**| **rejected** — adapters own baseURL (F24)            |
 *
 * @param {object} args
 * @param {string} args.provider      Resolved provider name (e.g. 'openai').
 * @param {string} args.model         Provider-native model id (no provider prefix).
 * @param {string} args.modelKey      Catalog key `<provider>/<model>` — for spec/pricing.
 * @param {any} args.configuration    Provider config. Only `apiKey` is threaded; other fields are rejected (F24).
 * @param {string | any[] | {system?: any, messages: any[]}} args.prompt
 * @param {any} [args.options]        Factory `answer()` options.
 * @param {BridgeDeps} [deps]
 * @returns {Promise<any>}            AnswerResult (matches the factory's return shape).
 */
export async function runAnswer ({ provider, model, modelKey, configuration, prompt, options = {} }, deps = {}) {
  const envelope = toEnvelope({ provider, model, configuration, prompt, options })

  // If the caller passed a `realtimeHandler`, feed every `delta`
  // event into a buffer that invokes the handler on batches matching
  // `bufferOpts` cadence. Without this, streaming callbacks silently
  // never fire — `mo ask --stream` and any integration that relies
  // on streaming callbacks stops working.
  //
  // F54: skip the buffer allocation entirely when no handler was
  // supplied — the common case.
  const deltaBuffer = options.realtimeHandler
    ? createRealtimeDeltaBuffer(options.realtimeHandler, options.bufferOpts)
    : null

  let terminal
  try {
    for await (const ev of run(envelope, deps)) {
      if (ev.type === 'delta' && ev.delta) {
        if (deltaBuffer) deltaBuffer.push(ev.delta.type, ev.delta.delta)
      } else if (ev.type === 'done' || ev.type === 'error') {
        terminal = ev
        break
      }
    }
  } finally {
    // Flush any pending buffered content regardless of terminal
    // path (success, error, or exception) so the handler sees the
    // tail of the stream.
    deltaBuffer?.flush()
  }

  if (!terminal) {
    throw new MohdelError('SESSION_NO_TERMINAL', {
      severity: Severity.ERROR,
      detail: 'session run produced no terminal event',
      retryable: false
    })
  }

  if (terminal.type === 'error') {
    throw fromTypedError(terminal.error, { provider, model, modelKey })
  }

  return terminal.result
}

/**
 * Run an `image()` call through the /session runtime.
 *
 * @param {object} args
 * @param {string} args.provider
 * @param {string} args.model
 * @param {any} args.configuration
 * @param {string} args.prompt
 * @param {any} [args.options]
 * @param {any} [args.spec]       modelSpec passthrough so the image
 *                                adapter picks up `imageEndpoint`,
 *                                `imageDefaultSize`, etc. without
 *                                re-reading the catalog.
 * @returns {Promise<any>}
 */
export async function runAnswerImage ({ provider, model, configuration, prompt, options = {}, spec }) {
  const envelope = {
    callId: options.callId || newCallId(),
    authId: options.authId || 'local',
    auth: configToAuth(configuration),
    model: `${provider}/${model}`,
    prompt
  }
  if (options.size) envelope.size = options.size
  if (options.seed != null) envelope.seed = options.seed

  const out = await runImage(envelope, spec ? { spec } : {})
  if (!out.ok) throw fromTypedError(out.error, { provider, model })
  return out.result
}

/**
 * @param {object} args
 * @param {string} args.provider
 * @param {string} args.model
 * @param {any} args.configuration
 * @param {string | any[] | {system?: any, messages: any[]}} args.prompt
 * @param {any} args.options
 * @returns {import('#core/envelope.js').CallEnvelope}
 */
function toEnvelope ({ provider, model, configuration, prompt, options }) {
  /** @type {import('#core/envelope.js').CallEnvelope} */
  const envelope = {
    callId: options.callId || newCallId(),
    authId: options.authId || 'local',
    auth: configToAuth(configuration),
    model: /** @type {import('#core/model-id.js').ModelId} */ (`${provider}/${model}`),
    prompt: toEnvelopePrompt(prompt)
  }

  if (options.traceparent) envelope.traceparent = options.traceparent
  if (options.baggage) envelope.baggage = options.baggage
  if (options.outputBudget !== undefined) envelope.outputBudget = options.outputBudget
  if (options.outputType) envelope.outputType = options.outputType
  if (options.outputStyle) envelope.outputStyle = options.outputStyle
  if (options.outputEffort) envelope.outputEffort = options.outputEffort
  if (options.images?.length) envelope.images = options.images
  if (options.videos?.length) envelope.videos = options.videos
  if (options.cache !== undefined) envelope.cache = options.cache
  if (options.tools?.length) envelope.tools = options.tools
  if (options.toolChoice) envelope.toolChoice = options.toolChoice
  if (options.parallelToolCalls === false) envelope.parallelToolCalls = false
  if (options.identifier) envelope.identifier = options.identifier

  // OpenRouter routing prefs ride in their own bag to keep the flat
  // envelope clean. The openrouter adapter reads this via
  // `config.mutateArgs`.
  if (options.providerOrder || options.providerAllow || options.providerDeny) {
    envelope.providerOptions = {
      openrouter: {
        order: options.providerOrder,
        allow: options.providerAllow,
        deny: options.providerDeny
      }
    }
  }

  return envelope
}

/**
 * Re-throw a TypedError as a MohdelError so factory-API caller catch
 * blocks — which duck-type on `.detail` / `.retryable` — keep
 * working without knowing about the session event-stream shape.
 *
 * @param {import('#core/errors.js').TypedError} err
 * @param {{provider: string, model: string, modelKey?: string}} ctx
 * @returns {MohdelError}
 */
function fromTypedError (err, ctx) {
  // TypedError `message` is the machine-key label (e.g. "provider error
  // 400"); `detail` carries the provider's own rejection text when it
  // was safe to surface. Prefer the detail so callers see what to fix.
  return new MohdelError(err.type || 'PROVIDER_ERROR', {
    severity: toSeveritySymbol(err.severity),
    detail: err.detail || err.message,
    retryable: !!err.retryable,
    context: { provider: ctx.provider, model: ctx.model }
  })
}

/** @param {string | undefined} s */
function toSeveritySymbol (s) {
  switch (s) {
    case 'trace': return Severity.TRACE
    case 'debug': return Severity.DEBUG
    case 'info': return Severity.INFO
    case 'warn': return Severity.WARN
    case 'error': return Severity.ERROR
    case 'fatal': return Severity.FATAL
    default: return Severity.ERROR
  }
}

function newCallId () {
  return `m86_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Turn the factory's `configuration` bag into an envelope `auth` object.
 * Accepts `apiKey` + `baseURL`; anything else is rejected with
 * `CONFIGURATION_UNSUPPORTED` rather than silently dropped — otherwise
 * a caller could believe their proxy / org header / timeout is in
 * effect when it isn't, which in the worst case leaks auth keys and
 * prompts to a provider they never intended to reach.
 *
 * @param {any} configuration
 * @returns {import('#core/envelope.js').Auth}
 */
const ALLOWED_CONFIG_KEYS = new Set(['apiKey', 'baseURL'])

function configToAuth (configuration) {
  if (!configuration) return { key: '' }
  const unsupported = Object.keys(configuration).filter(k => !ALLOWED_CONFIG_KEYS.has(k))
  if (unsupported.length > 0) {
    throw new MohdelError('CONFIGURATION_UNSUPPORTED', {
      severity: Severity.ERROR,
      detail:
        'per-call SDK configuration is limited to `apiKey` and `baseURL`. ' +
        `Unsupported keys: ${unsupported.join(', ')}. ` +
        'Move other fields to environment variables or pin them at factory construction.',
      retryable: false
    })
  }
  const auth = { key: configuration.apiKey || '' }
  if (configuration.baseURL) auth.baseURL = configuration.baseURL
  return auth
}

/**
 * Translate the factory's structured-input shape
 * (`{ system?, messages: [{role, content, toolCalls?, toolCallId?, toolName?}] }`)
 * into the envelope `Message[]` expected by session adapters. Plain
 * strings and pre-shaped arrays pass through untouched.
 *
 * Role mapping:
 *   - factory `tool_result` → envelope `tool` (carrying `toolCallId`,
 *     `content`, and optional `name` from `toolName`).
 *   - `assistant.toolCalls` carries through as-is onto the envelope
 *     Message so adapters can emit the provider-native tool_use.
 *
 * @param {unknown} prompt
 * @returns {string | import('#core/envelope.js').Message[]}
 */
function toEnvelopePrompt (prompt) {
  if (typeof prompt === 'string') return prompt
  if (Array.isArray(prompt)) return /** @type {any} */(prompt)

  if (prompt && typeof prompt === 'object' && Array.isArray(prompt.messages)) {
    const out = []
    if (prompt.system != null) {
      out.push({
        role: 'system',
        content: flattenSystem(prompt.system)
      })
    }
    for (const m of prompt.messages) {
      if (m.role === 'tool_result') {
        const msg = {
          role: 'tool',
          content: m.content ?? ''
        }
        if (m.toolCallId) msg.toolCallId = m.toolCallId
        if (m.toolName) msg.toolName = m.toolName
        out.push(msg)
      } else if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
        const msg = {
          role: 'assistant',
          content: m.content ?? '',
          toolCalls: m.toolCalls.map(tc => {
            const out = {
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments ?? {}
            }
            // Preserve provider-specific bits so a subsequent replay
            // reaches the adapter intact. Gemini rejects a tool-call
            // replay whose original `thoughtSignature` has been stripped.
            if (tc.thoughtSignature) out.thoughtSignature = tc.thoughtSignature
            return out
          })
        }
        out.push(msg)
      } else {
        out.push({ role: m.role, content: m.content ?? '' })
      }
    }
    return out
  }

  // Unknown shape — reject early with a clear error. Letting this
  // fall through would land a raw non-iterable in the envelope and
  // produce a confusing `prompt.map is not a function` deep inside
  // the adapter.
  throw new MohdelError('SESSION_INVALID_PROMPT', {
    severity: Severity.ERROR,
    retryable: false,
    detail:
      'prompt must be a string, a Message[] array, ' +
      'or { system?, messages: [...] }; received ' +
      describePromptShape(prompt)
  })
}

/** @param {unknown} v */
function describePromptShape (v) {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  if (typeof v !== 'object') return typeof v
  if ('messages' in v && !Array.isArray(/** @type {any} */(v).messages)) {
    return 'object with non-array messages'
  }
  return 'object without messages'
}

/**
 * The factory accepts `system` as either a plain string or an array
 * of `{text, cache?}` blocks (for Anthropic prompt caching). The
 * envelope's `Message.content` is string-or-MessagePart[]; flatten
 * blocks to a single string here. Callers who need Anthropic
 * cache-control blocks preserved need a separate path.
 *
 * @param {string | Array<{text?: string}>} system
 */
function flattenSystem (system) {
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return system.map(b => b?.text ?? '').filter(Boolean).join('\n')
  }
  return String(system ?? '')
}
