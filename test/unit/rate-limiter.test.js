import { describe, test, expect, vi, beforeEach } from 'vitest'
import createRateLimiter from '../../src/lib/rate-limiter.js'

describe('rate-limiter', () => {
  let limiter

  beforeEach(() => {
    limiter = createRateLimiter()
  })

  describe('check', () => {
    test('returns 0 when no limits configured', () => {
      expect(limiter.check('anthropic')).toBe(0)
      expect(limiter.check('anthropic', {})).toBe(0)
    })

    test('returns 0 when under RPM limit', () => {
      limiter.recordRequest('anthropic')
      expect(limiter.check('anthropic', { rpmLimit: 10 })).toBe(0)
    })

    test('returns delay when RPM limit reached', () => {
      for (let i = 0; i < 5; i++) limiter.recordRequest('anthropic')
      const delay = limiter.check('anthropic', { rpmLimit: 5 })
      expect(delay).toBeGreaterThan(0)
      expect(delay).toBeLessThanOrEqual(60000)
    })

    test('returns 0 when under TPM limit', () => {
      limiter.recordTokens('anthropic', 5000)
      expect(limiter.check('anthropic', { tpmLimit: 100000 })).toBe(0)
    })

    test('returns delay when TPM limit reached', () => {
      limiter.recordTokens('anthropic', 100000)
      const delay = limiter.check('anthropic', { tpmLimit: 100000 })
      expect(delay).toBeGreaterThan(0)
      expect(delay).toBeLessThanOrEqual(60000)
    })

    test('RPM triggers before TPM when both set', () => {
      for (let i = 0; i < 5; i++) limiter.recordRequest('anthropic')
      const delay = limiter.check('anthropic', { rpmLimit: 5, tpmLimit: 1000000 })
      expect(delay).toBeGreaterThan(0)
    })

    test('TPM triggers even when RPM is fine', () => {
      limiter.recordRequest('anthropic')
      limiter.recordTokens('anthropic', 200000)
      const delay = limiter.check('anthropic', { rpmLimit: 100, tpmLimit: 100000 })
      expect(delay).toBeGreaterThan(0)
    })

    test('different keys are independent', () => {
      for (let i = 0; i < 10; i++) limiter.recordRequest('anthropic')
      expect(limiter.check('anthropic', { rpmLimit: 10 })).toBeGreaterThan(0)
      expect(limiter.check('openai', { rpmLimit: 10 })).toBe(0)
    })
  })

  describe('recordRequest', () => {
    test('increments count by 1', () => {
      limiter.recordRequest('anthropic')
      limiter.recordRequest('anthropic')
      // 2 requests recorded, limit of 2 should trigger
      expect(limiter.check('anthropic', { rpmLimit: 2 })).toBeGreaterThan(0)
      // but limit of 3 should not
      expect(limiter.check('anthropic', { rpmLimit: 3 })).toBe(0)
    })

    test('does not add tokens', () => {
      limiter.recordRequest('anthropic')
      expect(limiter.check('anthropic', { tpmLimit: 1 })).toBe(0)
    })
  })

  describe('recordTokens', () => {
    test('adds tokens without incrementing count', () => {
      limiter.recordTokens('anthropic', 5000)
      // count should still be 0
      expect(limiter.check('anthropic', { rpmLimit: 1 })).toBe(0)
      // tokens should be tracked
      expect(limiter.check('anthropic', { tpmLimit: 5000 })).toBeGreaterThan(0)
    })

    test('accumulates across calls', () => {
      limiter.recordTokens('anthropic', 3000)
      limiter.recordTokens('anthropic', 4000)
      expect(limiter.check('anthropic', { tpmLimit: 7000 })).toBeGreaterThan(0)
      expect(limiter.check('anthropic', { tpmLimit: 7001 })).toBe(0)
    })
  })

  describe('typical answer() flow', () => {
    test('recordRequest + recordTokens counts one request', () => {
      // Simulates the index.js flow: recordRequest pre-request, recordTokens post-request
      limiter.recordRequest('anthropic')
      limiter.recordTokens('anthropic', 2000)

      // Should count as 1 request, not 2
      expect(limiter.check('anthropic', { rpmLimit: 2 })).toBe(0)

      limiter.recordRequest('anthropic')
      limiter.recordTokens('anthropic', 3000)

      // Now 2 requests, 5000 tokens
      expect(limiter.check('anthropic', { rpmLimit: 2 })).toBeGreaterThan(0)
      expect(limiter.check('anthropic', { tpmLimit: 5000 })).toBeGreaterThan(0)
      expect(limiter.check('anthropic', { tpmLimit: 5001 })).toBe(0)
    })
  })

  describe('minute boundary rollover', () => {
    test('fresh bucket resets counts', () => {
      limiter.recordRequest('anthropic')
      limiter.recordTokens('anthropic', 50000)
      expect(limiter.check('anthropic', { rpmLimit: 1 })).toBeGreaterThan(0)

      // Advance clock past minute boundary
      vi.useFakeTimers()
      vi.setSystemTime(Date.now() + 61000)

      // Counts should be reset in new minute
      expect(limiter.check('anthropic', { rpmLimit: 1 })).toBe(0)
      expect(limiter.check('anthropic', { tpmLimit: 50000 })).toBe(0)

      vi.useRealTimers()
    })
  })
})
