/**
 * `MohdelError` — the one error kind. `TypedError` is its serialized
 * form: `type` is the canonical machine tag callers branch on,
 * `message` is a short human-readable label, `detail` carries the
 * provider's own rejection text, plus `severity` (lowercase string)
 * and `retryable`.
 *
 * Thrown in-process by the factory and serialized over the gate are
 * two transports for the same error. `toJSON()` whitelists the wire
 * fields, so in-process-only state (`context`) cannot reach the wire.
 *
 * Rust mirror: `rust/thin-gate/src/protocol.rs::TypedError`.
 *
 * @module core/errors
 */

/**
 * @typedef {('trace'|'debug'|'info'|'warn'|'error'|'fatal')} SeverityTag
 */

/**
 * @typedef {object} TypedError
 * @property {string} message
 *   Short human-readable label (e.g. `'provider error 400'`). Never
 *   echo provider response bodies.
 * @property {string} [detail]
 *   Provider rejection text, capped and API-key-scrubbed by
 *   `classifyProviderError`. Whether to surface, log, or redact it
 *   further is the caller's policy.
 * @property {SeverityTag} severity
 * @property {boolean} retryable
 * @property {string} [type]
 *   Canonical tag callers branch on (e.g. `'PROVIDER_COOLDOWN'`,
 *   `'AUTH_INVALID'`). Optional on the wire; every
 *   `classifyProviderError` result sets it.
 */

export const SEVERITY_TAGS = Object.freeze([
  'trace', 'debug', 'info', 'warn', 'error', 'fatal'
])

export class MohdelError extends Error {
  /**
   * @param {string} message
   * @param {{
   *   severity?: SeverityTag,
   *   retryable?: boolean,
   *   detail?: string,
   *   type?: string,
   *   context?: object
   * }} [options]
   *   `context` is in-process only and never serialized.
   */
  constructor (message, { severity = 'error', retryable = false, detail, type, context } = {}) {
    super(message)
    this.name = 'MohdelError'
    this.severity = severity
    this.retryable = retryable
    if (detail) this.detail = detail
    if (type) this.type = type
    if (context) this.context = context
  }

  /** @returns {TypedError} */
  toJSON () {
    /** @type {TypedError} */
    const out = {
      message: this.message,
      severity: this.severity,
      retryable: this.retryable
    }
    if (this.detail) out.detail = this.detail
    if (this.type) out.type = this.type
    return out
  }

  /**
   * @param {TypedError} data
   * @param {object} [context]  In-process only; not part of `data`.
   * @returns {MohdelError}
   */
  static fromJSON (data, context) {
    return new MohdelError(data.message, {
      severity: data.severity,
      retryable: data.retryable,
      detail: data.detail,
      type: data.type,
      context
    })
  }
}
