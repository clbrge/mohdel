/**
 * Shared error classification for provider adapters.
 *
 * Maps SDK errors (by HTTP status) to a canonical `TypedError` with
 * stable `type` tags (AUTH_INVALID, RATE_LIMIT, PROVIDER_COOLDOWN,
 * PROVIDER_UNAVAILABLE, …). 401/403 messages stay generic to avoid
 * echoing provider bodies that may contain the API key back on the
 * wire; for other statuses the provider's own detail is preserved
 * on `.detail` so callers can debug 400s (schema rejects, etc).
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
  // OpenAI SDK: err.error.message; Google SDK: err.message is the full
  // body sometimes. Prefer the structured field when present.
  const nested = err.error?.message || err.response?.data?.error?.message
  const raw = nested || err.message
  if (!raw) return undefined
  const str = typeof raw === 'string' ? raw : JSON.stringify(raw)
  return str.length > DETAIL_CAP ? str.slice(0, DETAIL_CAP) + '…' : str
}

/**
 * @param {unknown} e
 * @returns {import('#core/errors.js').TypedError}
 */
export function classifyProviderError (e) {
  const err = /** @type {any} */(e)
  const status = err?.status

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
      detail: extractDetail(err)
    }
  }
  if (typeof status === 'number' && status >= 500) {
    return {
      message: `provider error ${status}`,
      severity: 'warn',
      retryable: true,
      type: 'PROVIDER_UNAVAILABLE',
      detail: extractDetail(err)
    }
  }
  if (typeof status === 'number' && status >= 400) {
    return {
      message: `provider error ${status}`,
      severity: 'error',
      retryable: false,
      type: 'PROVIDER_ERROR',
      detail: extractDetail(err)
    }
  }
  return {
    message: err?.message ? String(err.message).slice(0, 200) : 'network error',
    severity: 'warn',
    retryable: true,
    type: 'NET_ERROR',
    detail: extractDetail(err)
  }
}
