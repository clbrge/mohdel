/**
 * Minute-bucket rate limiter (per-key: provider or provider/model).
 *
 * Tracks RPM and TPM. Returns ms to wait if over limit — throttles
 * rather than rejecting, so the caller can absorb small bursts
 * without a 429 round-trip.
 *
 * State is session-process-local. In a pool, each session has its
 * own counters — total throughput ~= pool_size × limit. For strict
 * cross-process enforcement, configure it at thin-gate level via
 * the `QuotaPolicy` hook.
 *
 * @module session/rate-limiter
 */

export function createRateLimiter () {
  /** @type {Map<string, {count: number, tokens: number, minute: number}>} */
  const buckets = new Map()

  const currentMinute = () => Math.floor(Date.now() / 60000)

  /** @param {string} key */
  const getBucket = (key) => {
    const minute = currentMinute()
    const b = buckets.get(key)
    if (b && b.minute === minute) return b
    const fresh = { count: 0, tokens: 0, minute }
    buckets.set(key, fresh)
    return fresh
  }

  /** @param {number} minute */
  const msUntilNextMinute = (minute) => Math.max(0, (minute + 1) * 60000 - Date.now())

  /**
   * Returns ms to wait before sending. 0 means go ahead.
   *
   * Semantics:
   *   - `undefined` / `null` on a dimension → no limit configured,
   *     skipped.
   *   - `0` → **deny all** (killswitch). `msUntilNextMinute` is
   *     returned regardless of the current bucket.
   *   - positive number → throttle at that value.
   *
   * @param {string} key
   * @param {{rpmLimit?: number, tpmLimit?: number}} limits
   * @returns {number}
   */
  const check = (key, { rpmLimit, tpmLimit } = {}) => {
    if (rpmLimit == null && tpmLimit == null) return 0
    const b = getBucket(key)
    if (rpmLimit != null && b.count >= rpmLimit) return msUntilNextMinute(b.minute)
    if (tpmLimit != null && b.tokens >= tpmLimit) return msUntilNextMinute(b.minute)
    return 0
  }

  /** @param {string} key */
  const recordRequest = (key) => {
    getBucket(key).count++
  }

  /**
   * @param {string} key
   * @param {number} tokens
   */
  const recordTokens = (key, tokens) => {
    getBucket(key).tokens += tokens
  }

  return { check, recordRequest, recordTokens }
}

// Single session-local instance.
const defaultLimiter = createRateLimiter()
export const check = defaultLimiter.check
export const recordRequest = defaultLimiter.recordRequest
export const recordTokens = defaultLimiter.recordTokens
