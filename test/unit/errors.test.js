import { describe, test, expect } from 'vitest'
import {
  MohdelError,
  Severity,
  getSeverityNumber
} from '../../src/lib/errors.js'

describe('Severity', () => {
  test('all severity levels are unique symbols', () => {
    const levels = [Severity.TRACE, Severity.DEBUG, Severity.INFO, Severity.WARN, Severity.ERROR, Severity.FATAL]
    const unique = new Set(levels)
    expect(unique.size).toBe(6)
    levels.forEach(s => expect(typeof s).toBe('symbol'))
  })

  test('object is frozen', () => {
    expect(Object.isFrozen(Severity)).toBe(true)
  })
})

describe('getSeverityNumber', () => {
  test('maps each severity to its number', () => {
    expect(getSeverityNumber(Severity.TRACE)).toBe(1)
    expect(getSeverityNumber(Severity.DEBUG)).toBe(5)
    expect(getSeverityNumber(Severity.INFO)).toBe(9)
    expect(getSeverityNumber(Severity.WARN)).toBe(13)
    expect(getSeverityNumber(Severity.ERROR)).toBe(17)
    expect(getSeverityNumber(Severity.FATAL)).toBe(21)
  })

  test('throws on unknown symbol (invariant violation)', () => {
    expect(() => getSeverityNumber(Symbol('UNKNOWN'))).toThrow('unknown severity symbol')
  })
})

describe('MohdelError', () => {
  test('sets all fields', () => {
    const cause = new Error('root')
    const err = new MohdelError('PROVIDER_ERROR', {
      cause,
      severity: Severity.WARN,
      detail: 'some detail',
      context: { model: 'gpt-4o' },
      component: 'inference',
      retryable: true,
      silent: true
    })
    expect(err.name).toBe('MohdelError')
    expect(err.message).toBe('PROVIDER_ERROR')
    expect(err.cause).toBe(cause)
    expect(err.severity).toBe(Severity.WARN)
    expect(err.detail).toBe('some detail')
    expect(err.context).toEqual({ model: 'gpt-4o' })
    expect(err.component).toBe('inference')
    expect(err.retryable).toBe(true)
    expect(err.silent).toBe(true)
  })

  test('defaults retryable to false, silent to false, component to inference', () => {
    const err = new MohdelError('UNEXPECTED')
    expect(err.retryable).toBe(false)
    expect(err.silent).toBe(false)
    expect(err.component).toBe('inference')
  })

  test('is instanceof Error', () => {
    expect(new MohdelError('x')).toBeInstanceOf(Error)
  })
})
