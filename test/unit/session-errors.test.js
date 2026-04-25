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
  test('401 → AUTH_INVALID, no detail (avoids leaking key)', () => {
    const err = { status: 401, message: 'Bearer xyz invalid' }
    const out = classifyProviderError(err)
    expect(out.type).toBe('AUTH_INVALID')
    expect(out.retryable).toBe(false)
    expect(out.detail).toBeUndefined()
  })

  test('403 → AUTH_INVALID', () => {
    expect(classifyProviderError({ status: 403 }).type).toBe('AUTH_INVALID')
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
