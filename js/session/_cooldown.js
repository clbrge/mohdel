/**
 * Consecutive-failure cooldown tracker.
 *
 *   - Auth failures (401/403) trigger immediate cooldown (1 failure).
 *   - Other retryable failures require `threshold` consecutive
 *     failures before cooldown triggers.
 *   - Success resets the failure counter.
 *   - `check`/`throwIfCoolingDown` expires the entry when the
 *     cooldown window passes.
 *
 * Configuration comes from env vars (session-level, global):
 *   - MOHDEL_COOLDOWN_THRESHOLD (default 3)
 *   - MOHDEL_COOLDOWN_DURATION_MS (default 60_000)
 *
 * State is session-process-local.
 *
 * @module session/cooldown
 */

const DEFAULT_THRESHOLD = 3
const DEFAULT_DURATION_MS = 60_000

function envInt (name, fallback) {
  const v = process.env[name]
  if (!v) return fallback
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function createCooldownTracker (
  threshold = envInt('MOHDEL_COOLDOWN_THRESHOLD', DEFAULT_THRESHOLD),
  durationMs = envInt('MOHDEL_COOLDOWN_DURATION_MS', DEFAULT_DURATION_MS)
) {
  /** @type {Map<string, {failCount: number, until: number | null, reason: string | null}>} */
  const entries = new Map()

  /** @param {string} key */
  const check = (key) => {
    const entry = entries.get(key)
    if (!entry || !entry.until) return null
    if (Date.now() >= entry.until) {
      entries.delete(key)
      return null
    }
    return entry
  }

  /**
   * Records a failure. Returns `true` only if this call caused a
   * **fresh** cooldown activation — no active window existed (or the
   * previous one had expired). Late failures during an active window
   * increment `failCount` (diagnostics) but do NOT push `until`
   * forward; the cooldown is set-once, waited-out, reset on success.
   * Without this freeze, concurrent failures racing past the
   * pre-dispatch check would keep sliding the deadline and the user
   * would effectively never recover.
   *
   * @param {string} key
   * @param {{immediate?: boolean}} [options]
   * @returns {boolean} true if this call freshly activated the cooldown
   */
  const recordFailure = (key, { immediate = false } = {}) => {
    const entry = entries.get(key) || { failCount: 0, until: null, reason: null }
    entry.failCount++
    const shouldCooldown = immediate || entry.failCount >= threshold
    if (shouldCooldown) {
      const now = Date.now()
      if (entry.until == null || now >= entry.until) {
        entry.until = now + durationMs
        entry.reason = immediate ? 'auth' : 'consecutive_failures'
        entries.set(key, entry)
        return true
      }
    }
    entries.set(key, entry)
    return false
  }

  /** @param {string} key */
  const reset = (key) => {
    entries.delete(key)
  }

  /**
   * Returns a TypedError shape if the bucket is cooling down, else
   * undefined. Caller yields it as a `call.error` event.
   *
   * @param {string} key
   * @returns {import('#core/errors.js').TypedError | undefined}
   */
  const coolingDownError = (key) => {
    const entry = check(key)
    if (!entry) return undefined
    const secsLeft = Math.ceil((entry.until - Date.now()) / 1000)
    return {
      message: 'provider in cooldown',
      detail: `${key} is in cooldown for ${secsLeft}s after ${entry.failCount} consecutive failures (${entry.reason})`,
      severity: 'warn',
      retryable: true,
      type: 'PROVIDER_COOLDOWN'
    }
  }

  return { check, recordFailure, reset, coolingDownError, threshold, durationMs }
}

// Single session-local tracker. Re-exported as named members so
// callers can `import * as cooldown from './_cooldown.js'` and use
// `cooldown.reset(key)` / `cooldown.coolingDownError(key)`.
const defaultTracker = createCooldownTracker()
export const check = defaultTracker.check
export const recordFailure = defaultTracker.recordFailure
export const reset = defaultTracker.reset
export const coolingDownError = defaultTracker.coolingDownError
