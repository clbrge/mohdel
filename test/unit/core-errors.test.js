import { describe, test, expect } from 'vitest'
import { MohdelError, SEVERITY_TAGS } from '#core/errors.js'

describe('core/errors MohdelError', () => {
  test('SEVERITY_TAGS has the 6 mohdel levels', () => {
    expect([...SEVERITY_TAGS]).toEqual(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
  })

  test('basic construction with defaults', () => {
    const e = new MohdelError('bad key')
    expect(e).toBeInstanceOf(Error)
    expect(e.message).toBe('bad key')
    expect(e.severity).toBe('error')
    expect(e.retryable).toBe(false)
    expect(e.detail).toBeUndefined()
    expect(e.type).toBeUndefined()
  })

  test('construction with full options', () => {
    const e = new MohdelError('rate limit', {
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
    const e = new MohdelError('boom')
    expect(e.toJSON()).toEqual({
      message: 'boom',
      severity: 'error',
      retryable: false
    })
  })

  test('toJSON includes detail and type when set', () => {
    const e = new MohdelError('x', { severity: 'fatal', retryable: false, detail: 'y', type: 'Z' })
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
    const e = MohdelError.fromJSON(wire)
    expect(e.toJSON()).toEqual(wire)
  })

  test('name is MohdelError', () => {
    expect(new MohdelError('x').name).toBe('MohdelError')
  })

  test('context is carried in-process but never serialized', () => {
    const e = new MohdelError('boom', { context: { provider: 'openai', model: 'gpt-5' } })
    expect(e.context).toEqual({ provider: 'openai', model: 'gpt-5' })
    expect(e.toJSON()).toEqual({
      message: 'boom',
      severity: 'error',
      retryable: false
    })
    expect(JSON.parse(JSON.stringify(e))).not.toHaveProperty('context')
  })

  test('fromJSON attaches context without it reaching the wire', () => {
    const wire = { message: 'rpm', severity: 'warn', retryable: true, type: 'RATE_LIMIT' }
    const e = MohdelError.fromJSON(wire, { provider: 'groq', model: 'llama' })
    expect(e.context).toEqual({ provider: 'groq', model: 'llama' })
    expect(e.toJSON()).toEqual(wire)
  })
})
