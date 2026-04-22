import { describe, test, expect, vi, beforeEach } from 'vitest'
import createCooldownTracker from '../../src/lib/cooldown.js'
import { MohdelError } from '../../src/lib/errors.js'

describe('cooldown', () => {
  let cooldown

  beforeEach(() => {
    cooldown = createCooldownTracker(3, 60000)
  })

  describe('check', () => {
    test('returns null when no failures recorded', () => {
      expect(cooldown.check('anthropic')).toBeNull()
    })

    test('returns null when failures below threshold', () => {
      cooldown.recordFailure('anthropic')
      cooldown.recordFailure('anthropic')
      expect(cooldown.check('anthropic')).toBeNull()
    })

    test('returns entry when cooldown active', () => {
      cooldown.recordFailure('anthropic')
      cooldown.recordFailure('anthropic')
      cooldown.recordFailure('anthropic')
      const entry = cooldown.check('anthropic')
      expect(entry).not.toBeNull()
      expect(entry.failCount).toBe(3)
      expect(entry.reason).toBe('consecutive_failures')
      expect(entry.until).toBeGreaterThan(Date.now())
    })

    test('clears expired cooldown and returns null', () => {
      cooldown.recordFailure('anthropic')
      cooldown.recordFailure('anthropic')
      cooldown.recordFailure('anthropic')
      expect(cooldown.check('anthropic')).not.toBeNull()

      vi.useFakeTimers()
      vi.setSystemTime(Date.now() + 61000)
      expect(cooldown.check('anthropic')).toBeNull()
      vi.useRealTimers()
    })

    test('different keys are independent', () => {
      cooldown.recordFailure('anthropic')
      cooldown.recordFailure('anthropic')
      cooldown.recordFailure('anthropic')
      expect(cooldown.check('anthropic')).not.toBeNull()
      expect(cooldown.check('openai')).toBeNull()
    })
  })

  describe('recordFailure', () => {
    test('returns false when below threshold', () => {
      expect(cooldown.recordFailure('anthropic')).toBe(false)
      expect(cooldown.recordFailure('anthropic')).toBe(false)
    })

    test('returns true and activates cooldown at threshold', () => {
      cooldown.recordFailure('anthropic')
      cooldown.recordFailure('anthropic')
      expect(cooldown.recordFailure('anthropic')).toBe(true)
    })

    test('accumulates fail count across calls', () => {
      cooldown.recordFailure('anthropic')
      cooldown.recordFailure('anthropic')
      cooldown.recordFailure('anthropic')
      const entry = cooldown.check('anthropic')
      expect(entry.failCount).toBe(3)
    })

    test('immediate=true triggers cooldown on first failure', () => {
      const triggered = cooldown.recordFailure('anthropic', { immediate: true })
      expect(triggered).toBe(true)
      const entry = cooldown.check('anthropic')
      expect(entry).not.toBeNull()
      expect(entry.failCount).toBe(1)
      expect(entry.reason).toBe('auth')
    })

    test('continues to count past threshold', () => {
      for (let i = 0; i < 5; i++) cooldown.recordFailure('anthropic')
      const entry = cooldown.check('anthropic')
      expect(entry.failCount).toBe(5)
    })
  })

  describe('reset', () => {
    test('clears cooldown state', () => {
      cooldown.recordFailure('anthropic')
      cooldown.recordFailure('anthropic')
      cooldown.recordFailure('anthropic')
      expect(cooldown.check('anthropic')).not.toBeNull()

      cooldown.reset('anthropic')
      expect(cooldown.check('anthropic')).toBeNull()
    })

    test('no-op for unknown key', () => {
      cooldown.reset('unknown')
      expect(cooldown.check('unknown')).toBeNull()
    })

    test('does not affect other keys', () => {
      cooldown.recordFailure('anthropic')
      cooldown.recordFailure('anthropic')
      cooldown.recordFailure('anthropic')
      cooldown.recordFailure('openai')
      cooldown.recordFailure('openai')
      cooldown.recordFailure('openai')

      cooldown.reset('anthropic')
      expect(cooldown.check('anthropic')).toBeNull()
      expect(cooldown.check('openai')).not.toBeNull()
    })
  })

  describe('throwIfCoolingDown', () => {
    test('does not throw when no cooldown', () => {
      expect(() => cooldown.throwIfCoolingDown('anthropic')).not.toThrow()
    })

    test('does not throw when below threshold', () => {
      cooldown.recordFailure('anthropic')
      cooldown.recordFailure('anthropic')
      expect(() => cooldown.throwIfCoolingDown('anthropic')).not.toThrow()
    })

    test('throws MohdelError when cooldown active', () => {
      cooldown.recordFailure('anthropic')
      cooldown.recordFailure('anthropic')
      cooldown.recordFailure('anthropic')

      try {
        cooldown.throwIfCoolingDown('anthropic')
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(MohdelError)
        expect(err.message).toBe('PROVIDER_COOLDOWN')
        expect(err.retryable).toBe(true)
        expect(err.detail).toContain('anthropic')
        expect(err.detail).toContain('3 consecutive failures')
        expect(err.context.provider).toBe('anthropic')
        expect(err.context.failCount).toBe(3)
        expect(err.context.reason).toBe('consecutive_failures')
      }
    })

    test('throws with auth reason on immediate cooldown', () => {
      cooldown.recordFailure('openai', { immediate: true })

      try {
        cooldown.throwIfCoolingDown('openai')
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err.message).toBe('PROVIDER_COOLDOWN')
        expect(err.detail).toContain('1 consecutive failures')
        expect(err.context.reason).toBe('auth')
      }
    })

    test('does not throw after cooldown expires', () => {
      cooldown.recordFailure('anthropic')
      cooldown.recordFailure('anthropic')
      cooldown.recordFailure('anthropic')

      vi.useFakeTimers()
      vi.setSystemTime(Date.now() + 61000)
      expect(() => cooldown.throwIfCoolingDown('anthropic')).not.toThrow()
      vi.useRealTimers()
    })

    test('does not throw after reset', () => {
      cooldown.recordFailure('anthropic')
      cooldown.recordFailure('anthropic')
      cooldown.recordFailure('anthropic')

      cooldown.reset('anthropic')
      expect(() => cooldown.throwIfCoolingDown('anthropic')).not.toThrow()
    })
  })

  describe('custom threshold and duration', () => {
    test('threshold=1 triggers on first failure', () => {
      const cd = createCooldownTracker(1, 5000)
      expect(cd.recordFailure('anthropic')).toBe(true)
      expect(cd.check('anthropic')).not.toBeNull()
    })

    test('custom duration controls expiry', () => {
      const cd = createCooldownTracker(1, 2000)
      cd.recordFailure('anthropic')
      expect(cd.check('anthropic')).not.toBeNull()

      vi.useFakeTimers()
      vi.setSystemTime(Date.now() + 1500)
      expect(cd.check('anthropic')).not.toBeNull()

      vi.setSystemTime(Date.now() + 1000)
      expect(cd.check('anthropic')).toBeNull()
      vi.useRealTimers()
    })
  })

  describe('success-then-failure cycle', () => {
    test('reset after success restarts fail count', () => {
      cooldown.recordFailure('anthropic')
      cooldown.recordFailure('anthropic')
      // 2 failures, then success resets
      cooldown.reset('anthropic')

      // Need 3 fresh failures to trigger again
      cooldown.recordFailure('anthropic')
      cooldown.recordFailure('anthropic')
      expect(cooldown.check('anthropic')).toBeNull()

      cooldown.recordFailure('anthropic')
      expect(cooldown.check('anthropic')).not.toBeNull()
    })
  })
})
