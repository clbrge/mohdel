/**
 * Shared error classification for provider adapters.
 *
 * Maps SDK errors to a canonical `TypedError`. Inspects provider
 * error codes / messages first (so semantically meaningful tags like
 * `CONTEXT_OVERFLOW` and `QUOTA_EXHAUSTED` aren't lost in generic
 * status buckets), then falls back to HTTP status. 401/403 messages
 * stay generic to avoid echoing provider bodies that may contain the
 * API key back on the wire; for other statuses the provider's own
 * detail is preserved on `.detail` so callers can debug 400s.
 *
 * Type tags: `AUTH_INVALID`, `RATE_LIMIT`, `QUOTA_EXHAUSTED`,
 * `CONTEXT_OVERFLOW`, `CONTENT_BLOCKED`, `PROVIDER_UNAVAILABLE`,
 * `PROVIDER_ERROR`, `NET_ERROR`.
 *
 * @module session/adapters/_errors
 */

const DETAIL_CAP = 500

/**
 * Extract a short human-readable detail from an SDK error. Trimmed
 * to `DETAIL_CAP` chars so a verbose provider body doesn't blow up
 * log pipelines.
 * @param {any} err
 * @returns {string | undefined}
 */
function extractDetail (err) {
  if (!err) return undefined
  const nested = err.error?.message || err.response?.data?.error?.message
  const raw = nested || err.message
  if (!raw) return undefined
  const str = typeof raw === 'string' ? raw : JSON.stringify(raw)
  return str.length > DETAIL_CAP ? str.slice(0, DETAIL_CAP) + '…' : str
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
function extractCode (err) {
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
 * @param {unknown} e
 * @returns {import('#core/errors.js').TypedError}
 */
export function classifyProviderError (e) {
  const err = /** @type {any} */(e)
  const status = err?.status
  const code = extractCode(err)
  const message = err?.message || ''
  const detail = extractDetail(err)

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
    code === 'credit_balance_too_low'
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
    // Deliberately no detail — 401/403 bodies can echo the key.
    return {
      message: 'authentication failed',
      severity: 'error',
      retryable: false,
      type: 'AUTH_INVALID'
    }
  }
  if (status === 429) {
    return {
      message: 'rate limit exceeded',
      severity: 'warn',
      retryable: true,
      type: 'RATE_LIMIT',
      detail
    }
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
    message: message ? String(message).slice(0, 200) : 'network error',
    severity: 'warn',
    retryable: true,
    type: 'NET_ERROR',
    detail
  }
}
