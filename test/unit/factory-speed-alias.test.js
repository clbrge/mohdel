import { describe, test, expect } from 'vitest'

import mohdel from '../../src/lib/index.js'

function libraryFactory () {
  const models = {
    'anthropic/claude-x': {
      model: 'claude-x',
      provider: 'anthropic',
      thinkingEffortLevels: { low: 1024, high: 8192 },
      inputPrice: 0,
      outputPrice: 0,
      speeds: {
        fast: { wire: 'fast', inputPrice: 6, outputPrice: 30 },
        bare: { wire: 'economy' }
      }
    },
    'anthropic/claude-plain': {
      model: 'claude-plain',
      provider: 'anthropic',
      inputPrice: 0,
      outputPrice: 0
    }
  }
  const configurations = { anthropic: { apiKey: 'sk-test' } }
  return mohdel({ models, configurations, logger: { trace () {}, debug () {}, info () {}, warn () {}, error () {}, fatal () {} } })
}

describe('factory `@speed` alias', () => {
  test('resolves a declared lane', async () => {
    const m = await libraryFactory()
    const proxy = m.use('anthropic/claude-x@fast')
    expect(proxy.id).toBe('anthropic/claude-x')
  })

  test('resolves alongside an effort suffix', async () => {
    const m = await libraryFactory()
    const proxy = m.use('anthropic/claude-x:high@fast')
    expect(proxy.id).toBe('anthropic/claude-x')
  })

  test('a lane carrying only wire is valid', async () => {
    const m = await libraryFactory()
    expect(m.use('anthropic/claude-x@bare').id).toBe('anthropic/claude-x')
  })

  test('rejects a lane the spec does not declare', async () => {
    const m = await libraryFactory()
    expect(() => m.use('anthropic/claude-x@turbo'))
      .toThrow(/does not support speed lane 'turbo'.*Available:.*fast/)
  })

  test('reversed suffix order suggests the corrected id', async () => {
    const m = await libraryFactory()
    expect(() => m.use('anthropic/claude-x@fast:high'))
      .toThrow(/did you mean 'anthropic\/claude-x:high@fast'/)
  })

  test('rejects any lane on a spec with no speeds', async () => {
    const m = await libraryFactory()
    expect(() => m.use('anthropic/claude-plain@fast'))
      .toThrow(/declares no speed lanes/)
  })

  test('an unresolvable base falls through to the not-found path', async () => {
    const m = await libraryFactory()
    expect(() => m.use('anthropic/nope@fast')).toThrow(/not found/)
  })

  test('a curated id containing `@` resolves whole rather than being split', async () => {
    const models = {
      'vertex/gemini-x': { model: 'gemini-x', provider: 'gemini', inputPrice: 0, outputPrice: 0 },
      'vertex/gemini-x@002': { model: 'gemini-x@002', provider: 'gemini', inputPrice: 0, outputPrice: 0 }
    }
    const m = await mohdel({ models, configurations: { gemini: { apiKey: 'k' } }, logger: { trace () {}, debug () {}, info () {}, warn () {}, error () {}, fatal () {} } })
    expect(m.use('vertex/gemini-x@002').id).toBe('vertex/gemini-x@002')
  })

  test('a curated id containing `:` resolves whole rather than being split', async () => {
    const models = {
      'openrouter/vendor/model': { model: 'vendor/model', provider: 'openrouter', inputPrice: 0, outputPrice: 0 },
      'openrouter/vendor/model:free': { model: 'vendor/model:free', provider: 'openrouter', inputPrice: 0, outputPrice: 0 }
    }
    const m = await mohdel({ models, configurations: { openrouter: { apiKey: 'k' } }, logger: { trace () {}, debug () {}, info () {}, warn () {}, error () {}, fatal () {} } })
    expect(m.use('openrouter/vendor/model:free').id).toBe('openrouter/vendor/model:free')
  })
})
