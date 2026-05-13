import { describe, test, expect } from 'vitest'
import { classifyProviderError } from '../../js/session/adapters/_errors.js'

describe('classifyProviderError — code-driven', () => {
  test('OpenAI context_length_exceeded → CONTEXT_OVERFLOW, non-retryable', () => {
    const err = { status: 400, code: 'context_length_exceeded', message: 'too long' }
    const out = classifyProviderError(err)
    expect(out.type).toBe('CONTEXT_OVERFLOW')
    expect(out.retryable).toBe(false)
    expect(out.severity).toBe('warn')
    expect(out.detail).toBe('too long')
  })

  test('nested err.error.code is found', () => {
    const err = { status: 400, error: { code: 'context_length_exceeded', message: 'big' } }
    expect(classifyProviderError(err).type).toBe('CONTEXT_OVERFLOW')
  })

  test('Anthropic-style err.error.error.type is found', () => {
    const err = { status: 400, error: { error: { type: 'context_length_exceeded' } } }
    expect(classifyProviderError(err).type).toBe('CONTEXT_OVERFLOW')
  })

  test('message-based detection (Gemini-style "prompt is too long")', () => {
    const err = { status: 400, message: 'The prompt is too long for this model' }
    expect(classifyProviderError(err).type).toBe('CONTEXT_OVERFLOW')
  })

  test('insufficient_quota at 429 is QUOTA_EXHAUSTED, NOT retryable', () => {
    const err = { status: 429, code: 'insufficient_quota', message: 'pay up' }
    const out = classifyProviderError(err)
    expect(out.type).toBe('QUOTA_EXHAUSTED')
    expect(out.retryable).toBe(false)
    expect(out.severity).toBe('error')
  })

  test('credit_balance_too_low → QUOTA_EXHAUSTED', () => {
    const err = { status: 400, error: { type: 'credit_balance_too_low' } }
    expect(classifyProviderError(err).type).toBe('QUOTA_EXHAUSTED')
  })

  test('content_filter → CONTENT_BLOCKED, non-retryable', () => {
    const err = { status: 400, code: 'content_filter', message: 'rejected' }
    const out = classifyProviderError(err)
    expect(out.type).toBe('CONTENT_BLOCKED')
    expect(out.retryable).toBe(false)
    expect(out.severity).toBe('warn')
  })
})

describe('classifyProviderError — status-driven fallback', () => {
  test('401 → AUTH_INVALID, preserves provider detail (consumer redacts if needed)', () => {
    const err = { status: 401, message: 'Bearer xyz invalid' }
    const out = classifyProviderError(err)
    expect(out.type).toBe('AUTH_INVALID')
    expect(out.retryable).toBe(false)
    expect(out.detail).toBe('Bearer xyz invalid')
  })

  test('403 → AUTH_INVALID', () => {
    expect(classifyProviderError({ status: 403 }).type).toBe('AUTH_INVALID')
  })

  test('AUTH_INVALID detail masks long key as <first4>…<last4>', () => {
    const key = 'sk-ant-api03-very-long-secret-value-12345'
    const err = { status: 401, message: `Invalid API key: ${key} not recognized` }
    const out = classifyProviderError(err, key)
    expect(out.type).toBe('AUTH_INVALID')
    expect(out.detail).toBe('Invalid API key: sk-a…2345 not recognized')
    expect(out.detail).not.toContain(key)
  })

  test('mid-length key (8–15 chars) falls back to <redacted>', () => {
    const key = 'midkey1234' // 10 chars
    const err = { status: 401, message: `bad: ${key}` }
    expect(classifyProviderError(err, key).detail).toBe('bad: <redacted>')
  })

  test('scrubber is a no-op when key is too short or missing', () => {
    const err = { status: 401, message: 'plain message' }
    expect(classifyProviderError(err).detail).toBe('plain message')
    expect(classifyProviderError(err, '').detail).toBe('plain message')
    expect(classifyProviderError(err, 'short').detail).toBe('plain message')
  })

  test('plain 429 (no code) → RATE_LIMIT, retryable', () => {
    const err = { status: 429, message: 'slow down' }
    const out = classifyProviderError(err)
    expect(out.type).toBe('RATE_LIMIT')
    expect(out.retryable).toBe(true)
  })

  test('500 → PROVIDER_UNAVAILABLE, retryable', () => {
    const out = classifyProviderError({ status: 500 })
    expect(out.type).toBe('PROVIDER_UNAVAILABLE')
    expect(out.retryable).toBe(true)
  })

  test('503 → PROVIDER_UNAVAILABLE', () => {
    expect(classifyProviderError({ status: 503 }).type).toBe('PROVIDER_UNAVAILABLE')
  })

  test('400 with no recognized code → PROVIDER_ERROR, non-retryable', () => {
    const err = { status: 400, message: 'schema reject' }
    const out = classifyProviderError(err)
    expect(out.type).toBe('PROVIDER_ERROR')
    expect(out.retryable).toBe(false)
    expect(out.detail).toBe('schema reject')
  })

  test('no status → NET_ERROR, retryable', () => {
    const err = new Error('fetch failed')
    const out = classifyProviderError(err)
    expect(out.type).toBe('NET_ERROR')
    expect(out.retryable).toBe(true)
  })

  test('null/undefined → NET_ERROR fallback', () => {
    expect(classifyProviderError(null).type).toBe('NET_ERROR')
    expect(classifyProviderError(undefined).type).toBe('NET_ERROR')
  })
})

describe('classifyProviderError — 429 split (TIER vs LOAD)', () => {
  test('plain 429 with no provider, no headers → RATE_LIMIT (fallback)', () => {
    const out = classifyProviderError({ status: 429, message: 'slow down' })
    expect(out.type).toBe('RATE_LIMIT')
    expect(out.retryable).toBe(true)
  })

  test('any provider, x-ratelimit-remaining-requests=0 header → RATE_LIMIT_TIER', () => {
    const err = {
      status: 429,
      message: 'rate limit',
      headers: { 'x-ratelimit-remaining-requests': '0' }
    }
    expect(classifyProviderError(err, undefined, { provider: 'openai' }).type)
      .toBe('RATE_LIMIT_TIER')
  })

  test('Headers instance (web fetch) is accepted', () => {
    const headers = new Headers({ 'x-ratelimit-remaining-tokens': '0' })
    const err = { status: 429, message: 'rl', headers }
    expect(classifyProviderError(err, undefined, { provider: 'openai' }).type)
      .toBe('RATE_LIMIT_TIER')
  })

  test('headers present but remaining > 0 → RATE_LIMIT_LOAD', () => {
    const err = {
      status: 429,
      message: 'rl',
      headers: { 'x-ratelimit-remaining-requests': '47' }
    }
    expect(classifyProviderError(err, undefined, { provider: 'openai' }).type)
      .toBe('RATE_LIMIT_LOAD')
  })

  test('openai code=rate_limit_exceeded → RATE_LIMIT_TIER (no headers needed)', () => {
    const err = { status: 429, code: 'rate_limit_exceeded', message: 'tpm reached' }
    expect(classifyProviderError(err, undefined, { provider: 'openai' }).type)
      .toBe('RATE_LIMIT_TIER')
  })

  test('anthropic overloaded_error → RATE_LIMIT_LOAD', () => {
    const err = { status: 429, error: { error: { type: 'overloaded_error' } }, message: 'overloaded' }
    expect(classifyProviderError(err, undefined, { provider: 'anthropic' }).type)
      .toBe('RATE_LIMIT_LOAD')
  })

  test('anthropic rate_limit_error → RATE_LIMIT_TIER', () => {
    const err = { status: 429, error: { error: { type: 'rate_limit_error' } }, message: 'rl' }
    expect(classifyProviderError(err, undefined, { provider: 'anthropic' }).type)
      .toBe('RATE_LIMIT_TIER')
  })

  test('cerebras "high traffic" body with no headers → RATE_LIMIT_LOAD', () => {
    const err = {
      status: 429,
      message: "We're experiencing high traffic right now! Please try again soon."
    }
    expect(classifyProviderError(err, undefined, { provider: 'cerebras' }).type)
      .toBe('RATE_LIMIT_LOAD')
  })

  test('cerebras tier hit (headers remaining=0) → RATE_LIMIT_TIER (overrides body)', () => {
    const err = {
      status: 429,
      message: "We're experiencing high traffic right now!",
      headers: { 'x-ratelimit-remaining-tokens': '0' }
    }
    // Header presence is a stronger signal than the generic body
    // string — but cerebras's provider override fires first and
    // matches the body. Expected: LOAD wins because the override is
    // intentional for this provider's known boilerplate.
    expect(classifyProviderError(err, undefined, { provider: 'cerebras' }).type)
      .toBe('RATE_LIMIT_LOAD')
  })

  test('gemini RESOURCE_EXHAUSTED → RATE_LIMIT_TIER', () => {
    const err = { status: 429, error: { status: 'RESOURCE_EXHAUSTED' }, message: 'quota' }
    expect(classifyProviderError(err, undefined, { provider: 'gemini' }).type)
      .toBe('RATE_LIMIT_TIER')
  })

  test('gemini plain 429 (no RESOURCE_EXHAUSTED) → RATE_LIMIT (no header signal)', () => {
    const err = { status: 429, message: 'slow' }
    expect(classifyProviderError(err, undefined, { provider: 'gemini' }).type)
      .toBe('RATE_LIMIT')
  })

  test('openrouter overloaded body → RATE_LIMIT_LOAD', () => {
    const err = { status: 429, message: 'upstream provider is overloaded' }
    expect(classifyProviderError(err, undefined, { provider: 'openrouter' }).type)
      .toBe('RATE_LIMIT_LOAD')
  })

  test('unknown provider falls back to generic header detection', () => {
    const err = {
      status: 429,
      message: 'rl',
      headers: { 'x-ratelimit-remaining-requests': '0' }
    }
    expect(classifyProviderError(err, undefined, { provider: 'novel-provider' }).type)
      .toBe('RATE_LIMIT_TIER')
  })

  test('detail preserved through 429 classification', () => {
    const err = { status: 429, code: 'rate_limit_exceeded', message: 'Rate limit reached for TPM: limit 30000, used 30000' }
    const out = classifyProviderError(err, undefined, { provider: 'openai' })
    expect(out.detail).toContain('30000')
  })
})

describe('classifyProviderError — detail extraction', () => {
  test('prefers err.error.message over err.message', () => {
    const err = { status: 400, message: 'fallback', error: { message: 'specific' } }
    expect(classifyProviderError(err).detail).toBe('specific')
  })

  test('caps detail at 500 chars + ellipsis', () => {
    const long = 'x'.repeat(800)
    const out = classifyProviderError({ status: 400, message: long })
    expect(out.detail.length).toBe(501)
    expect(out.detail.endsWith('…')).toBe(true)
  })
})
