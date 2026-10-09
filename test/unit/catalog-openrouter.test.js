import { describe, test, expect, vi, afterEach } from 'vitest'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

// OpenRouter prices a variable-priced router at `-1` a token; the client must
// treat it as no price rather than `-1000000`, which would lower a ledger.
const payload = {
  data: [
    {
      id: 'bodybuilder',
      name: 'Bodybuilder',
      pricing: { prompt: '-1', completion: '-1' },
      architecture: { input_modalities: ['text'] }
    },
    {
      id: 'vendor/priced',
      name: 'Priced',
      pricing: { prompt: '0.000001', completion: '0.000004' },
      architecture: { input_modalities: ['text'] }
    }
  ]
}

const client = () => {
  globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => payload }))
  return import('../../src/lib/catalog/openrouter.js').then(m => m.default({ apiKey: 'sk-test' }))
}

describe('the openrouter catalog client with negative listing prices', () => {
  test('lists a negative price as no price', async () => {
    const models = await (await client()).listModels()
    expect(models.find(m => m.id === 'bodybuilder').inputPrice).toBeUndefined()
    expect(models.find(m => m.id === 'bodybuilder').outputPrice).toBeUndefined()
  })

  test('omits a negative price from model info', async () => {
    const info = await (await client()).getModelInfo('bodybuilder')
    expect(info).not.toHaveProperty('inputPrice')
    expect(info).not.toHaveProperty('outputPrice')
  })

  test('still converts a real price to per-million', async () => {
    const info = await (await client()).getModelInfo('vendor/priced')
    expect(info).toMatchObject({ inputPrice: 1, outputPrice: 4 })
  })
})
