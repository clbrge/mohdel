/**
 * `TypedError` — wire-format error. Carries `message` (machine key),
 * optional `detail` (user-facing context), `severity` (lowercase
 * string), `retryable`, and optional `type` (canonical tag).
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
 *   Top-level message. Never echo provider response bodies.
 * @property {string} [detail]
 *   User-facing error detail (mirrors `MohdelError.detail`).
 * @property {SeverityTag} severity
 * @property {boolean} retryable
 * @property {string} [type]
 *   Optional canonical tag (e.g. `'PROVIDER_COOLDOWN'`, `'AUTH_INVALID'`).
 */

export const SEVERITY_TAGS = Object.freeze([
  'trace', 'debug', 'info', 'warn', 'error', 'fatal'
])

export class MohdelTypedError extends Error {
  /**
   * @param {string} message
   * @param {{
   *   severity?: SeverityTag,
   *   retryable?: boolean,
   *   detail?: string,
   *   type?: string
   * }} [options]
   */
  constructor (message, { severity = 'error', retryable = false, detail, type } = {}) {
    super(message)
    this.name = 'MohdelTypedError'
    this.severity = severity
    this.retryable = retryable
    if (detail) this.detail = detail
    if (type) this.type = type
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
   * @returns {MohdelTypedError}
   */
  static fromJSON (data) {
    return new MohdelTypedError(data.message, {
      severity: data.severity,
      retryable: data.retryable,
      detail: data.detail,
      type: data.type
    })
  }
}
