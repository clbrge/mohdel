import { describe, test, expect } from 'vitest'
import { ENVELOPE_FIELDS } from '#core/envelope.js'

describe('core/envelope', () => {
  test('ENVELOPE_FIELDS is frozen', () => {
    expect(Object.isFrozen(ENVELOPE_FIELDS)).toBe(true)
  })

  test('ENVELOPE_FIELDS is the full frozen CallEnvelope field set', () => {
    expect(ENVELOPE_FIELDS).toEqual([
      // transport metadata
      'callId', 'authId', 'auth', 'traceparent', 'baggage',
      // routing
      'provider', 'model',
      // prompt (first arg)
      'prompt',
      // answer options (flat)
      'outputBudget', 'outputType', 'outputStyle', 'outputEffort',
      'images', 'videos', 'cache',
      'tools', 'toolChoice', 'parallelToolCalls',
      'identifier',
      // provider-specific bag (openrouter routing today; extensible)
      'providerOptions'
    ])
  })
})
