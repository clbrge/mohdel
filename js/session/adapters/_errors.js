/**
 * Shared error classification for provider adapters.
 *
 * Maps SDK errors to a canonical `TypedError`. Inspects provider
 * error codes / messages first (so semantically meaningful tags like
 * `CONTEXT_OVERFLOW` and `QUOTA_EXHAUSTED` aren't lost in generic
 * status buckets), then falls back to HTTP status. The provider's own
 * detail is preserved on `.detail` for every classification —
 * including 401/403. When the caller supplies the API key it was
 * using, `classifyProviderError` masks any verbatim occurrence of
 * that key in the detail before returning, so an echoed-key provider
 * body never reaches downstream consumers as plaintext. Whatever the
 * caller does with `detail` after that — surface it, log it, redact
 * it further — is the caller's policy.
 *
 * 429 split: `RATE_LIMIT_TIER` means the caller's own quota dimension
 * (per-minute/per-day requests or tokens, org concurrency) was
 * exhausted — retrying inside the rate-limit window cannot succeed.
 * `RATE_LIMIT_LOAD` means the provider is shedding load for reasons
 * not tied to the caller's quota — the next attempt may succeed
 * immediately. `RATE_LIMIT` (no suffix) is the fallback when the
 * signal is ambiguous. Pass `opts.provider` from the adapter to enable
 * provider-specific disambiguation. A 429 whose headers name a wait
 * (`Retry-After`, or OpenRouter's epoch-ms `X-RateLimit-Reset`) carries
 * it as `retryAfterMs`.
 *
 * Type tags: `AUTH_INVALID`, `RATE_LIMIT`, `RATE_LIMIT_TIER`,
 * `RATE_LIMIT_LOAD`, `QUOTA_EXHAUSTED`, `CONTEXT_OVERFLOW`,
 * `CONTENT_BLOCKED`, `PROVIDER_UNAVAILABLE`, `PROVIDER_ERROR`,
 * `NET_ERROR`.
 *
 * @module session/adapters/_errors
 */

import { logger } from '../_logger.js'

const DETAIL_CAP = 500

/**
 * Replace verbatim occurrences of `key` in `detail` with a masked
 * form. Long keys (≥ 16 chars) become `<first4>…<last4>` so a caller
 * with multiple keys can still tell them apart from the masked
 * substring; shorter keys fall back to `<redacted>` since revealing
 * 8 chars would leak too much. Keys under 8 chars are treated as
 * not-a-key (no scrub) — guards against pathological replacements
 * on empty or fixture values.
 * @param {string | undefined} detail
 * @param {string | undefined} key
 * @returns {string | undefined}
 */
export function scrubKey (detail, key) {
  if (!detail || !key || typeof key !== 'string' || key.length < 8) return detail
  if (!detail.includes(key)) return detail
  const mask = key.length >= 16
    ? `${key.slice(0, 4)}…${key.slice(-4)}`
    : '<redacted>'
  return detail.split(key).join(mask)
}

const UNWRAP_DEPTH = 2

/**
 * `@google/genai` sets `ApiError.message` to `JSON.stringify({error:
 * {message, code, status}})`, and Gemini's own body inside it is
 * itself JSON — so the sentence sits two envelopes deep.
 * @param {string} str
 * @returns {string}
 */
function unwrapJsonMessage (str) {
  let current = str
  for (let i = 0; i < UNWRAP_DEPTH; i++) {
    const trimmed = current.trim()
    if (!trimmed.startsWith('{')) return current
    let parsed
    try { parsed = JSON.parse(trimmed) } catch { return current }
    const inner = parsed?.error?.message ?? parsed?.message
    if (typeof inner !== 'string' || !inner) return current
    current = inner
  }
  return current
}

/**
 * Extract a short human-readable detail from an SDK error. Trimmed
 * to `DETAIL_CAP` chars so a verbose provider body doesn't blow up
 * log pipelines.
 * @param {any} err
 * @returns {string | undefined}
 */
function extractDetail (err) {
  if (!err) return undefined
  const str = upstreamDetail(err.error?.metadata) ?? sdkDetail(err)
  if (!str) return undefined
  return str.length > DETAIL_CAP ? str.slice(0, DETAIL_CAP) + '…' : str
}

/**
 * OpenRouter's top-level message for an upstream failure is only
 * "Provider returned error"; what the upstream said is in
 * `error.metadata.raw`, and which upstream in `provider_name`.
 * @param {any} metadata
 * @returns {string | undefined}
 */
function upstreamDetail (metadata) {
  if (typeof metadata?.raw !== 'string' || !metadata.raw) return undefined
  const said = unwrapJsonMessage(metadata.raw)
  return metadata.provider_name ? `${metadata.provider_name}: ${said}` : said
}

/**
 * @param {any} err
 * @returns {string | undefined}
 */
function sdkDetail (err) {
  const nested = err.error?.message || err.response?.data?.error?.message
  const raw = nested || err.message
  if (!raw) return undefined
  return unwrapJsonMessage(typeof raw === 'string' ? raw : JSON.stringify(raw))
}

/**
 * Pull a provider-supplied error code/type out of any of the shapes
 * the SDKs use. OpenAI/xAI/DeepSeek expose `err.code` or
 * `err.error.code`; Anthropic surfaces `err.error.error.type`;
 * Gemini buries everything in `err.message`. Lower-cased for a
 * single substring/equality check site.
 * @param {any} err
 * @returns {string}
 */
export function extractCode (err) {
  if (!err) return ''
  const candidates = [
    err.code,
    err.error?.code,
    err.error?.type,
    err.error?.error?.type,
    err.error?.error?.code,
    err.response?.data?.error?.code,
    err.response?.data?.error?.type
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c) return c.toLowerCase()
  }
  return ''
}

/**
 * Match common context-overflow phrasings used by providers that
 * don't expose a dedicated error code (Gemini, some compat gateways).
 * @param {string} msg
 * @returns {boolean}
 */
function matchesContextOverflow (msg) {
  const m = (msg || '').toLowerCase()
  if (!m) return false
  if (m.includes('context_length') || m.includes('context length')) return true
  if (m.includes('maximum context') || m.includes('context window')) return true
  if (m.includes('prompt is too long') || m.includes('input is too long')) return true
  if (m.includes('too many tokens') || m.includes('token limit')) return true
  if (m.includes('max_tokens') && m.includes('exceed')) return true
  return false
}

/**
 * Read a header in a SDK-agnostic way. Some SDKs hand back a real
 * `Headers` instance (web fetch); others use a plain lowercased
 * object. Normalize to a case-insensitive lookup that works on both.
 * @param {any} headers
 * @param {string} name
 * @returns {string | undefined}
 */
function headerVal (headers, name) {
  if (!headers) return undefined
  if (typeof headers.get === 'function') {
    const v = headers.get(name) ?? headers.get(name.toLowerCase())
    return v == null ? undefined : String(v)
  }
  if (typeof headers === 'object') {
    const lower = name.toLowerCase()
    if (headers[name] != null) return String(headers[name])
    if (headers[lower] != null) return String(headers[lower])
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === lower) return String(headers[k])
    }
  }
  return undefined
}

/**
 * Headers that providers expose for caller-side quota limits. Any one
 * being present is a strong signal that the 429 is tier-driven; if
 * one is present and reads 0, it's definitive.
 */
const RATE_LIMIT_HEADER_NAMES = Object.freeze([
  'x-ratelimit-remaining',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-remaining-tokens',
  'anthropic-ratelimit-requests-remaining',
  'anthropic-ratelimit-tokens-remaining',
  'anthropic-ratelimit-input-tokens-remaining',
  'anthropic-ratelimit-output-tokens-remaining'
])

function readRemainingHeaders (err) {
  const headers = err?.headers || err?.response?.headers
  if (!headers) return { any: false, zero: false }
  let any = false
  let zero = false
  for (const name of RATE_LIMIT_HEADER_NAMES) {
    const raw = headerVal(headers, name)
    if (raw == null) continue
    any = true
    const n = Number(raw)
    if (Number.isFinite(n) && n <= 0) zero = true
  }
  return { any, zero }
}

const tierResult = (detail) => ({
  message: 'rate limit exceeded (caller quota)',
  severity: 'warn',
  retryable: true,
  type: 'RATE_LIMIT_TIER',
  detail
})

const loadResult = (detail) => ({
  message: 'rate limit exceeded (provider load)',
  severity: 'warn',
  retryable: true,
  type: 'RATE_LIMIT_LOAD',
  detail
})

const ambiguousResult = (detail) => ({
  message: 'rate limit exceeded',
  severity: 'warn',
  retryable: true,
  type: 'RATE_LIMIT',
  detail
})

/**
 * Per-provider 429 disambiguators. Each takes the raw error + already-
 * extracted code/detail and returns a TypedError result, or `undefined`
 * to defer to the generic header/fallback path.
 *
 * Notes on signals (verified against SDK source where possible;
 * marked `UNVERIFIED` when based on docs/conventions only):
 * - openai: `code === 'rate_limit_exceeded'` is the documented tier
 *   tag. Generic 429 with no quota wording → LOAD.
 * - anthropic: `error.error.type === 'overloaded_error'` is the public
 *   load signal; `'rate_limit_error'` is the tier signal.
 * - cerebras: tier hits surface the same generic 429 body
 *   ("We're experiencing high traffic right now…") as load events;
 *   `x-ratelimit-remaining-*` headers, when present and zero, are the
 *   only reliable tier discriminator. Absent headers + that body
 *   string → LOAD. UNVERIFIED for non-tier-saturated cases.
 * - gemini: `status === 'RESOURCE_EXHAUSTED'` in the body → TIER.
 *   Pure 429 without that status → LOAD (rare; gemini usually returns
 *   503 / `UNAVAILABLE` for global congestion).
 */
const providerOverrides = {
  openai (_err, code, detail) {
    if (code === 'rate_limit_exceeded') return tierResult(detail)
    return undefined
  },
  cerebras (_err, _code, detail) {
    if (/high traffic/i.test(detail || '')) return loadResult(detail)
    return undefined
  },
  xai (_err, code, detail) {
    if (code === 'rate_limit_exceeded') return tierResult(detail)
    return undefined
  },
  deepseek (_err, code, detail) {
    if (code === 'rate_limit_exceeded') return tierResult(detail)
    return undefined
  },
  mistral (_err, code, detail) {
    if (code === 'rate_limit_exceeded') return tierResult(detail)
    return undefined
  },
  fireworks (_err, code, detail) {
    if (code === 'rate_limit_exceeded') return tierResult(detail)
    return undefined
  },
  groq (_err, code, detail) {
    if (code === 'rate_limit_exceeded') return tierResult(detail)
    return undefined
  },
  xiaomi (_err, code, detail) {
    if (code === 'rate_limit_exceeded') return tierResult(detail)
    return undefined
  },
  qwen (_err, code, detail) {
    if (code === 'rate_limit_exceeded') return tierResult(detail)
    return undefined
  },
  novita (_err, code, detail) {
    if (code === 'rate_limit_exceeded') return tierResult(detail)
    return undefined
  },
  openrouter (err, code, detail) {
    // OpenRouter forwards upstream 429s. Their own aggregator tier hits
    // expose `code === 'rate_limit_exceeded'`; an upstream's free pool
    // shared by every OpenRouter caller says so in
    // `error.metadata.limit_source`; other upstream-provider load shows
    // as an "overloaded" / "busy" phrasing.
    if (code === 'rate_limit_exceeded') return tierResult(detail)
    if (err?.error?.metadata?.limit_source === 'upstream_provider_shared_pool') return loadResult(detail)
    if (/overloaded|busy|capacity/i.test(detail || '')) return loadResult(detail)
    return undefined
  },
  anthropic (_err, code, detail) {
    if (code === 'overloaded_error') return loadResult(detail)
    if (code === 'rate_limit_error') return tierResult(detail)
    return undefined
  },
  gemini (err, code, detail) {
    // SDK buries the protobuf-style status in the message; the body's
    // `error.status` is also exposed when present.
    const status = err?.error?.status || err?.response?.data?.error?.status
    if (status === 'RESOURCE_EXHAUSTED' || /resource_exhausted/i.test(detail || '')) {
      return tierResult(detail)
    }
    return undefined
  }
}

/**
 * Decide whether a 429 is caller-tier or provider-load. The order is
 * intentional: provider override first (most specific signals), then
 * generic header-based detection, then a "remaining=0 on a present
 * header" definitive tier signal, otherwise fall back to ambiguous.
 * @param {any} err
 * @param {string} code   already-lowercased code from extractCode()
 * @param {string | undefined} detail
 * @param {string} [provider]
 * @returns {import('#core/errors.js').TypedError}
 */
function classify429 (err, code, detail, provider) {
  const result = kindOf429(err, code, detail, provider)
  const waitMs = providerWaitMs(err?.headers || err?.response?.headers, provider)
  if (waitMs !== undefined) result.retryAfterMs = waitMs
  return result
}

/**
 * @param {any} err
 * @param {string} code
 * @param {string | undefined} detail
 * @param {string} [provider]
 * @returns {import('#core/errors.js').TypedError}
 */
function kindOf429 (err, code, detail, provider) {
  const override = provider && providerOverrides[provider]?.(err, code, detail)
  if (override) return override

  const { any, zero } = readRemainingHeaders(err)
  if (zero) return tierResult(detail)
  if (any) {
    // Headers present but remaining > 0 — provider is throttling
    // despite the caller having budget. That's a load signal.
    return loadResult(detail)
  }

  return ambiguousResult(detail)
}

/**
 * Providers whose `X-RateLimit-Reset` is the epoch millisecond the
 * window reopens. Others use the name for other units (OpenAI's
 * `x-ratelimit-reset-requests` is a duration such as `1s`).
 */
const RESET_EPOCH_MS_PROVIDERS = Object.freeze(['openrouter'])

/**
 * How long the provider says to wait, from `Retry-After` (delta-seconds
 * or an HTTP-date, RFC 9110 §10.2.3) or, where the unit is known, from
 * `X-RateLimit-Reset`. Undefined when no header names a wait still
 * ahead. A header present but unparseable is logged, not guessed.
 * @param {any} headers
 * @param {string} [provider]
 * @returns {number | undefined}
 */
function providerWaitMs (headers, provider) {
  const retryAfter = headerVal(headers, 'retry-after')
  if (retryAfter !== undefined) return retryAfterWaitMs(retryAfter, provider)
  if (provider && RESET_EPOCH_MS_PROVIDERS.includes(provider)) {
    const reset = headerVal(headers, 'x-ratelimit-reset')
    if (reset !== undefined) return resetWaitMs(reset, provider)
  }
  return undefined
}

/**
 * @param {string} raw
 * @param {string | undefined} provider
 * @returns {number | undefined}
 */
function retryAfterWaitMs (raw, provider) {
  const value = raw.trim()
  if (/^\d+$/.test(value)) return aheadMs(Number(value) * 1000)
  const at = Date.parse(value)
  if (Number.isNaN(at)) return unparseableWait(provider, 'retry-after', raw)
  return aheadMs(at - Date.now())
}

/**
 * @param {string} raw
 * @param {string} provider
 * @returns {number | undefined}
 */
function resetWaitMs (raw, provider) {
  const value = raw.trim()
  if (!/^\d+$/.test(value)) return unparseableWait(provider, 'x-ratelimit-reset', raw)
  return aheadMs(Number(value) - Date.now())
}

/** @param {number} ms */
const aheadMs = (ms) => ms > 0 ? ms : undefined

/**
 * @param {string | undefined} provider
 * @param {string} header
 * @param {string} raw
 * @returns {undefined}
 */
function unparseableWait (provider, header, raw) {
  logger.warn({ provider, header, value: raw }, '[mohdel:errors] unparseable rate-limit wait')
  return undefined
}

/**
 * @param {unknown} e
 * @param {string} [key]   Optional API key the call was made with. When
 *                         provided, any verbatim occurrence is replaced
 *                         with `<redacted>` in the returned detail —
 *                         providers occasionally echo the rejected key
 *                         in error bodies (notably 401/403) and that
 *                         must not leak.
 * @param {{ provider?: string }} [opts]
 *                         Adapter-supplied provider name. Enables
 *                         provider-specific 429 disambiguation
 *                         (`RATE_LIMIT_TIER` vs `RATE_LIMIT_LOAD`).
 *                         When omitted, 429 classification falls back
 *                         to header-only detection.
 * @returns {import('#core/errors.js').TypedError}
 */
export function classifyProviderError (e, key, opts = {}) {
  const err = /** @type {any} */(e)
  const status = err?.status
  const code = extractCode(err)
  const message = err?.message || ''
  const detail = scrubKey(extractDetail(err), key)

  // --- Code-driven classification (runs before status buckets so
  //     specific tags survive even when the upstream HTTP status is
  //     a generic 400/429). ---

  if (
    code === 'context_length_exceeded' ||
    code === 'string_above_max_length' ||
    code === 'context_length' ||
    matchesContextOverflow(message) ||
    matchesContextOverflow(detail)
  ) {
    return {
      message: 'context length exceeded',
      severity: 'warn',
      retryable: false,
      type: 'CONTEXT_OVERFLOW',
      detail
    }
  }

  if (
    code === 'insufficient_quota' ||
    code === 'billing_hard_limit_reached' ||
    code === 'account_deactivated' ||
    code === 'credit_balance_too_low' ||
    code === 'usage_limit_reached' ||
    code === 'usage_not_included'
  ) {
    return {
      message: 'provider quota exhausted',
      severity: 'error',
      retryable: false,
      type: 'QUOTA_EXHAUSTED',
      detail
    }
  }

  if (
    code === 'content_filter' ||
    code === 'content_policy_violation' ||
    code === 'safety' ||
    code === 'blocked' ||
    code === 'prohibited_content'
  ) {
    return {
      message: 'content blocked by provider safety filter',
      severity: 'warn',
      retryable: false,
      type: 'CONTENT_BLOCKED',
      detail
    }
  }

  // --- Status-driven fallback. ---

  if (status === 401 || status === 403) {
    return {
      message: 'authentication failed',
      severity: 'error',
      retryable: false,
      type: 'AUTH_INVALID',
      detail
    }
  }
  if (status === 429) {
    return classify429(err, code, detail, opts.provider)
  }
  if (typeof status === 'number' && status >= 500) {
    return {
      message: `provider error ${status}`,
      severity: 'warn',
      retryable: true,
      type: 'PROVIDER_UNAVAILABLE',
      detail
    }
  }
  if (typeof status === 'number' && status >= 400) {
    return {
      message: `provider error ${status}`,
      severity: 'error',
      retryable: false,
      type: 'PROVIDER_ERROR',
      detail
    }
  }
  return {
    message: message ? scrubKey(String(message), key).slice(0, 200) : 'network error',
    severity: 'warn',
    retryable: true,
    type: 'NET_ERROR',
    detail
  }
}

/**
 * Wrap a `TypedError` payload in a throwable `Error`. Adapters that
 * fetch directly (rather than through a provider SDK) throw these; the
 * run loop lifts `.typed` onto the terminal error event.
 *
 * @param {string} message
 * @param {string} type
 * @param {boolean} retryable
 * @param {string} [detail]
 * @returns {Error & {typed: import('#core/errors.js').TypedError}}
 */
export function typedError (message, type, retryable, detail) {
  const err = new Error(message)
  /** @type {import('#core/errors.js').TypedError} */
  const typed = { message, severity: retryable ? 'warn' : 'error', retryable, type }
  if (detail) typed.detail = detail
  return Object.assign(err, { typed })
}

/**
 * Classify an HTTP status, keeping the classifier's stable message and
 * routing the caller's context plus any response-body snippet into
 * `detail` — provider response bodies must never reach
 * `TypedError.message`.
 *
 * @param {number} status
 * @param {string} message
 * @param {string} [detail]
 * @param {string} [key]  masked out of `detail`
 * @returns {Error & {typed: import('#core/errors.js').TypedError}}
 */
export function fromHttpStatus (status, message, detail, key) {
  const typed = classifyProviderError({ status })
  const scrubbed = scrubKey(detail, key)
  return typedError(typed.message, typed.type, typed.retryable, scrubbed ? `${message}: ${scrubbed}` : message)
}
