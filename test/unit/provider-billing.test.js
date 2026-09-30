import { describe, test, expect, afterEach } from 'vitest'
import providers, { billingOf } from '../../src/lib/providers.js'
import { costFor, embeddingCostFor, transcriptionCostFor } from '../../js/session/adapters/_pricing.js'
import { setCatalog } from '../../js/session/adapters/_catalog.js'
import { reviewEntry } from '../../src/lib/catalog-review.js'

const REQUIRED = {
  metered: [],
  plan: ['label', 'usage'],
  capacity: ['label']
}

describe('provider billing declarations', () => {
  test.each(Object.keys(providers))('%s declares a known kind with its required fields', name => {
    const { kind, ...rest } = providers[name].billing
    expect(Object.keys(REQUIRED)).toContain(kind)
    expect(Object.keys(rest).sort()).toEqual(REQUIRED[kind].slice().sort())
    for (const field of REQUIRED[kind]) expect(rest[field]).toBeTruthy()
  })
})

describe('billingOf', () => {
  test.each([
    ['anthropic/claude-x', { kind: 'metered' }],
    ['chatgpt/gpt-x', { kind: 'plan', label: 'ChatGPT plan', usage: 'https://chatgpt.com/settings/usage' }],
    ['local/qwen-x', { kind: 'capacity', label: 'local server' }]
  ])('%s', (model, billing) => {
    expect(billingOf(model)).toEqual(billing)
  })

  test('an unknown provider throws', () => {
    expect(() => billingOf('nowhere/model')).toThrow("Unknown provider 'nowhere'")
    expect(() => billingOf('no-slash')).toThrow('Unknown provider')
  })

  test('returns a copy', () => {
    billingOf('chatgpt/gpt-x').label = 'changed'
    expect(billingOf('chatgpt/gpt-x').label).toBe('ChatGPT plan')
  })
})

describe('cost follows the declaration, not the provider name', () => {
  const priced = { inputPrice: 10, outputPrice: 10, embeddingPrice: 10, transcriptionPrice: 10 }
  afterEach(() => setCatalog({}))

  test.each([
    ['chatgpt/priced', 0],
    ['local/priced', 0],
    ['openai/priced', 0.02],
    ['fake/priced', 0.02]
  ])('%s', (model, expected) => {
    setCatalog({ [model]: priced })
    const envelope = { model }
    expect(costFor(envelope, { inputTokens: 1000, outputTokens: 1000 })).toBeCloseTo(expected, 10)
    expect(embeddingCostFor(envelope, priced, { inputTokens: 2000 })).toBeCloseTo(expected, 10)
    expect(transcriptionCostFor(envelope, priced, { durationSeconds: 0.12 })).toBeCloseTo(expected, 10)
  })
})

describe('catalog review', () => {
  const local = over => ({ model: 'qwen3:4b', creator: 'alibaba', provider: 'local', sdk: 'openai', label: 'Qwen3', inputFormat: ['text'], baseURL: 'http://127.0.0.1:11434/v1', ...over })

  test('prices on a capacity entry are flagged as never charged', () => {
    const { warnings } = reviewEntry('local/qwen3-4b', local({ inputPrice: 1 }), {})
    expect(warnings).toContainEqual(expect.stringContaining('prices are never charged'))
  })

  test('an unpriced capacity entry is not flagged', () => {
    const { warnings } = reviewEntry('local/qwen3-4b', local(), {})
    expect(warnings).not.toContainEqual(expect.stringContaining('never charged'))
  })
})
