import { describe, test, expect } from 'vitest'
import { MohdelTypedError, SEVERITY_TAGS } from '#core/errors.js'

describe('core/errors MohdelTypedError', () => {
  test('SEVERITY_TAGS has the 6 mohdel levels', () => {
    expect([...SEVERITY_TAGS]).toEqual(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
  })

  test('basic construction with defaults', () => {
    const e = new MohdelTypedError('bad key')
    expect(e).toBeInstanceOf(Error)
    expect(e.message).toBe('bad key')
    expect(e.severity).toBe('error')
    expect(e.retryable).toBe(false)
    expect(e.detail).toBeUndefined()
    expect(e.type).toBeUndefined()
  })

  test('construction with full options', () => {
    const e = new MohdelTypedError('rate limit', {
      severity: 'warn',
      retryable: true,
      detail: 'API quota exceeded',
      type: 'PROVIDER_COOLDOWN'
    })
    expect(e.severity).toBe('warn')
    expect(e.retryable).toBe(true)
    expect(e.detail).toBe('API quota exceeded')
    expect(e.type).toBe('PROVIDER_COOLDOWN')
  })

  test('toJSON produces wire shape (optional fields omitted when unset)', () => {
    const e = new MohdelTypedError('boom')
    expect(e.toJSON()).toEqual({
      message: 'boom',
      severity: 'error',
      retryable: false
    })
  })

  test('toJSON includes detail and type when set', () => {
    const e = new MohdelTypedError('x', { severity: 'fatal', retryable: false, detail: 'y', type: 'Z' })
    expect(e.toJSON()).toEqual({
      message: 'x',
      severity: 'fatal',
      retryable: false,
      detail: 'y',
      type: 'Z'
    })
  })

  test('fromJSON round-trips', () => {
    const wire = {
      message: 'rpm',
      severity: 'warn',
      retryable: true,
      type: 'PROVIDER_COOLDOWN'
    }
    const e = MohdelTypedError.fromJSON(wire)
    expect(e.toJSON()).toEqual(wire)
  })
})
