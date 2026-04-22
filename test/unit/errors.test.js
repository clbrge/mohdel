import { describe, test, expect } from 'vitest'
import {
  MohdelError,
  APIError,
  Severity,
  getSeverityNumber,
  toTransportError,
  reportRetryable,
  reportDefault,
  retryableWarn,
  isContextOverflowMessage
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

describe('APIError', () => {
  test('sets name, message, and status', () => {
    const err = new APIError('rate limited', 429)
    expect(err.name).toBe('APIError')
    expect(err.message).toBe('rate limited')
    expect(err.status).toBe(429)
  })

  test('defaults status to 500', () => {
    const err = new APIError('fail')
    expect(err.status).toBe(500)
  })

  test('is instanceof Error', () => {
    expect(new APIError('x')).toBeInstanceOf(Error)
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

describe('toTransportError', () => {
  test('converts typed error to transport shape', () => {
    const err = new MohdelError('PROVIDER_RETRYABLE_ERROR', {
      detail: 'Provider API failed',
      component: 'inference',
      context: { model: 'gpt-4o' },
      retryable: true,
      silent: false
    })
    const spanMock = { spanContext: () => ({ traceId: 'abc123' }) }
    const result = toTransportError(err, spanMock)
    expect(result).toEqual({
      message: 'PROVIDER_RETRYABLE_ERROR',
      detail: 'Provider API failed',
      trace: 'abc123',
      component: 'inference',
      context: { model: 'gpt-4o' },
      retryable: true,
      silent: false
    })
  })

  test('converts plain Error to fallback transport shape', () => {
    const err = new Error('something broke')
    const result = toTransportError(err)
    expect(result).toEqual({
      message: 'UNEXPECTED_ERROR',
      detail: 'An unexpected error occurred',
      trace: undefined,
      component: undefined,
      context: undefined,
      retryable: false,
      silent: false
    })
  })

  test('handles missing span', () => {
    const err = new MohdelError('PROVIDER_ERROR', { detail: 'fail' })
    const result = toTransportError(err)
    expect(result.trace).toBeUndefined()
  })
})

describe('reportRetryable', () => {
  test('returns retryable true with ERROR severity and machine key', () => {
    const err = new Error('timeout')
    const result = reportRetryable(err, 'openai')
    expect(result.message).toBe('PROVIDER_RETRYABLE_ERROR')
    expect(result.retryable).toBe(true)
    expect(result.severity).toBe(Severity.ERROR)
    expect(result.cause).toBe(err)
    expect(result.detail).toContain('openai')
  })

  test('uses custom detail when provided', () => {
    const err = new Error('x')
    const result = reportRetryable(err, 'openai', 'custom detail')
    expect(result.detail).toBe('custom detail')
  })
})

describe('reportDefault', () => {
  test('returns non-retryable for generic errors', () => {
    const err = new Error('fail')
    const result = reportDefault(err, 'anthropic')
    expect(result.message).toBe('PROVIDER_ERROR')
    expect(result.retryable).toBe(false)
    expect(result.severity).toBe(Severity.ERROR)
    expect(result.cause).toBe(err)
    expect(result.detail).toContain('anthropic')
  })

  test('returns retryable for connection errors', () => {
    const err = new Error('fetch failed')
    err.cause = { code: 'ECONNRESET' }
    const result = reportDefault(err, 'openai')
    expect(result.retryable).toBe(true)
  })

  test('returns retryable for timeout errors', () => {
    const err = new Error('request timed out')
    err.code = 'ETIMEDOUT'
    const result = reportDefault(err, 'openai')
    expect(result.retryable).toBe(true)
  })

  test('returns retryable for DNS errors', () => {
    const err = new Error('getaddrinfo ENOTFOUND api.openai.com')
    err.code = 'ENOTFOUND'
    const result = reportDefault(err, 'openai')
    expect(result.retryable).toBe(true)
  })
})

describe('retryableWarn', () => {
  test('returns retryable with WARN severity and machine key', () => {
    const err = new Error('overloaded')
    const result = retryableWarn(err, 'API is overloaded')
    expect(result.message).toBe('PROVIDER_OVERLOADED')
    expect(result.retryable).toBe(true)
    expect(result.severity).toBe(Severity.WARN)
    expect(result.cause).toBe(err)
    expect(result.detail).toBe('API is overloaded')
  })
})

describe('isConnectionError (via reportDefault)', () => {
  // Each err.code literal in the source — one test per distinct value
  const codes = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT']

  for (const code of codes) {
    test(`err.code = ${code} → retryable`, () => {
      const err = new Error('fail')
      err.code = code
      expect(reportDefault(err, 'x').retryable).toBe(true)
    })
  }

  // err.cause.code fallback — two spot-checks for the || branch
  test('err.cause.code = ECONNRESET → retryable', () => {
    const err = new Error('fail')
    err.cause = { code: 'ECONNRESET' }
    expect(reportDefault(err, 'x').retryable).toBe(true)
  })

  test('err.cause.code = ETIMEDOUT → retryable', () => {
    const err = new Error('fail')
    err.cause = { code: 'ETIMEDOUT' }
    expect(reportDefault(err, 'x').retryable).toBe(true)
  })

  // Message-based detection — one per distinct substring
  test('fetch failed message → retryable', () => {
    expect(reportDefault(new Error('fetch failed'), 'x').retryable).toBe(true)
  })

  test('socket hang up message → retryable', () => {
    expect(reportDefault(new Error('socket hang up'), 'x').retryable).toBe(true)
  })

  test('network error message → retryable', () => {
    expect(reportDefault(new Error('network timeout'), 'x').retryable).toBe(true)
  })

  // Negative cases
  test('unrelated error → not retryable', () => {
    expect(reportDefault(new Error('bad request'), 'x').retryable).toBe(false)
  })

  test('null/undefined err → not retryable', () => {
    expect(reportDefault(null, 'x').retryable).toBe(false)
  })
})

describe('isContextOverflowMessage', () => {
  const positives = [
    'context_length exceeded',
    'maximum context length exceeded',
    'token limit reached',
    'input is too long',
    'too many tokens in prompt',
    'exceeds maximum context window',
    'prompt is too long',
    'max_tokens would exceed the limit'
  ]

  for (const msg of positives) {
    test(`detects: "${msg}"`, () => {
      expect(isContextOverflowMessage(msg)).toBe(true)
    })
  }

  test('max_tokens alone is not overflow', () => {
    expect(isContextOverflowMessage('max_tokens must be positive')).toBe(false)
  })

  test('unrelated message returns false', () => {
    expect(isContextOverflowMessage('invalid api key')).toBe(false)
  })

  test('null/undefined returns false', () => {
    expect(isContextOverflowMessage(null)).toBe(false)
    expect(isContextOverflowMessage(undefined)).toBe(false)
  })

  test('case insensitive', () => {
    expect(isContextOverflowMessage('CONTEXT_LENGTH exceeded')).toBe(true)
  })
})
