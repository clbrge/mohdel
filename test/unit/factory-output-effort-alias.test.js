import { describe, test, expect } from 'vitest'

import mohdel from '../../src/lib/index.js'

// F31: `:effort` alias parser used to hardcode `['none','low','medium','high']`,
// dropping provider-specific levels like Anthropic Opus `minimal`/`max`.
// The fix is spec-aware: split on the last colon iff `base` resolves to
// a known spec, then validate the candidate against the spec's own
// `thinkingEffortLevels` keys.

// Library-mode factory lets us define the spec surface under test.
function libraryFactory ({ levels = { minimal: 2048, low: 8192, medium: 16384, high: 32768, max: 65536 } } = {}) {
  const models = {
    'anthropic/claude-opus-4': {
      model: 'claude-opus-4',
      provider: 'anthropic',
      thinkingEffortLevels: levels,
      inputPrice: 0,
      outputPrice: 0
    },
    'anthropic/claude-no-thinking': {
      model: 'claude-no-thinking',
      provider: 'anthropic',
      thinkingEffortLevels: null,
      inputPrice: 0,
      outputPrice: 0
    }
  }
  const configurations = {
    anthropic: { apiKey: 'sk-test' }
  }
  return mohdel({ models, configurations, logger: { trace () {}, debug () {}, info () {}, warn () {}, error () {}, fatal () {} } })
}

describe('factory `:effort` alias (F31)', () => {
  test('accepts a per-spec level not in the old hardcoded list (`:max`)', async () => {
    const m = await libraryFactory()
    // If this throws, the old hardcoded-list filter is still in place.
    const proxy = m.use('anthropic/claude-opus-4:max')
    expect(proxy).toBeDefined()
  })

  test('accepts `:minimal` level', async () => {
    const m = await libraryFactory()
    const proxy = m.use('anthropic/claude-opus-4:minimal')
    expect(proxy).toBeDefined()
  })

  test('accepts existing `:low` level', async () => {
    const m = await libraryFactory()
    const proxy = m.use('anthropic/claude-opus-4:low')
    expect(proxy).toBeDefined()
  })

  test('accepts `:none` even when spec has thinkingEffortLevels', async () => {
    const m = await libraryFactory()
    const proxy = m.use('anthropic/claude-opus-4:none')
    expect(proxy).toBeDefined()
  })

  test('rejects an unsupported level with spec-aware "Available:" error', async () => {
    const m = await libraryFactory({ levels: { low: 100, high: 200 } })
    expect(() => m.use('anthropic/claude-opus-4:max'))
      .toThrow(/does not support output effort level 'max'.*Available:.*low.*high/s)
  })

  test('model with null thinkingEffortLevels rejects any :effort alias', async () => {
    const m = await libraryFactory()
    expect(() => m.use('anthropic/claude-no-thinking:low'))
      .toThrow(/does not support output effort/)
  })

  test('truly unknown model without known base still gets "not found"', async () => {
    const m = await libraryFactory()
    // Base `hypothetical/unknown` not in catalog → no split → fall back to
    // treating the full string as a model id → "not found".
    expect(() => m.use('hypothetical/unknown:low'))
      .toThrow(/not found/)
  })
})
