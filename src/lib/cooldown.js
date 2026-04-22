import { Severity, MohdelError } from './errors.js'
import { silent } from './logger.js'

const createCooldownTracker = (threshold = 3, durationMs = 60000, { logger = silent } = {}) => {
  // key → { failCount, until, reason }
  const entries = new Map()

  const check = (key) => {
    const entry = entries.get(key)
    if (!entry || !entry.until) return null
    if (Date.now() >= entry.until) {
      entries.delete(key)
      logger.debug({ key }, '[mohdel:cooldown] expired')
      return null
    }
    return entry
  }

  const recordFailure = (key, { immediate = false, cause } = {}) => {
    const entry = entries.get(key) || { failCount: 0, until: null, reason: null }
    entry.failCount++
    if (cause) entry.lastCause = cause
    const shouldCooldown = immediate || entry.failCount >= threshold
    if (shouldCooldown) {
      entry.until = Date.now() + durationMs
      entry.reason = immediate ? 'auth' : 'consecutive_failures'
      entries.set(key, entry)
      logger.info({
        key,
        reason: entry.reason,
        failCount: entry.failCount,
        durationMs,
        triggeredBy: entry.lastCause || null
      }, '[mohdel:cooldown] activated')
      return true
    }
    entries.set(key, entry)
    return false
  }

  const reset = (key) => {
    const had = entries.has(key)
    entries.delete(key)
    if (had) logger.debug({ key }, '[mohdel:cooldown] reset')
  }

  const throwIfCoolingDown = (key, span) => {
    const entry = check(key)
    if (!entry) return
    const secsLeft = Math.ceil((entry.until - Date.now()) / 1000)
    logger.trace({ key, secsLeft }, '[mohdel:cooldown] fast-fail')
    throw new MohdelError('PROVIDER_COOLDOWN', {
      severity: Severity.WARN,
      retryable: true,
      detail: `Provider ${key} is in cooldown for ${secsLeft}s after ${entry.failCount} consecutive failures (${entry.reason}).`,
      context: { provider: key, failCount: entry.failCount, reason: entry.reason, cooldownUntil: entry.until }
    })
  }

  return { check, recordFailure, reset, throwIfCoolingDown }
}

export default createCooldownTracker
