import { describe, test, expect, vi, afterEach } from 'vitest'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const payload = {
  data: [
    {
      id: 'zai-org/glm-5.3-flash',
      display_name: 'GLM 5.3 Flash',
      model_type: 'chat',
      context_size: 1048576,
      max_output_tokens: 131072,
      input_modalities: ['text', 'image', 'video'],
      output_modalities: ['text'],
      features: ['function-calling', 'structured-outputs', 'reasoning', 'serverless'],
      pricing: {
        prompt: { price_per_m: 1500, price_per_m_decimal: '0.15' },
        completion: { price_per_m: 5000, price_per_m_decimal: '0.5' },
        input_cache_read: { price_per_m: 300, price_per_m_decimal: '0.03' }
      }
    },
    { id: 'some/diffusion-model', model_type: 'image', display_name: 'Diffusion' },
    { id: 'unpriced/model', model_type: 'chat', display_name: 'Unpriced' }
  ]
}

const client = () => {
  globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => payload }))
  return import('../../src/lib/catalog/novita.js').then(m => m.default({ apiKey: 'sk-x' }))
}

describe('the novita catalog client', () => {
  test('reads prices as USD per million from the decimal field', async () => {
    const info = await (await client()).getModelInfo('zai-org/glm-5.3-flash')
    expect(info).toMatchObject({
      model: 'zai-org/glm-5.3-flash',
      label: 'GLM 5.3 Flash',
      contextTokenLimit: 1048576,
      outputTokenLimit: 131072,
      inputPrice: 0.15,
      outputPrice: 0.5,
      cacheReadPrice: 0.03,
      inputFormat: ['text', 'image', 'video'],
      supportsTools: true
    })
  })

  test('lists only chat models, so image models stay out of a text catalog', async () => {
    const models = await (await client()).listModels()
    expect(models.map(m => m.id)).toEqual(['zai-org/glm-5.3-flash', 'unpriced/model'])
  })

  // An absent price must stay absent rather than become zero, which would
  // read as a free model and bill nothing.
  test('leaves prices out when the payload carries none', async () => {
    const c = await client()
    expect(await c.getModelInfo('unpriced/model')).not.toHaveProperty('inputPrice')
    expect((await c.listModels()).find(m => m.id === 'unpriced/model').inputPrice).toBeUndefined()
  })

  test('sends the key in a header, never the URL', async () => {
    await (await client()).listModels()
    const [url, init] = globalThis.fetch.mock.calls[0]
    expect(url).toBe('https://api.novita.ai/openai/v1/models')
    expect(JSON.stringify(init.headers)).toContain('sk-x')
  })
})
