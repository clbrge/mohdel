import { describe, test, expect, vi } from 'vitest'

const dirs = vi.hoisted(() => {
  const os = require('node:os'); const path = require('node:path'); const fs = require('node:fs')
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'mohdel-free-'))
  fs.mkdirSync(path.join(config, 'mohdel'), { recursive: true })
  fs.writeFileSync(path.join(config, 'mohdel', 'curated.json'), JSON.stringify({ $schema: 'x' }))
  return { config: path.join(config, 'mohdel'), cache: config, data: config, log: config, temp: config }
})
vi.mock('env-paths', () => ({ default: () => dirs }))

const { freeModels, addModels } = await import('../../src/lib/select.js')
const { getCuratedModels } = await import('../../src/lib/common.js')

describe('free models in a self-priced list', () => {
  test('a model is free only when both prices are zero', () => {
    const list = [
      { id: 'a:free', inputPrice: 0, outputPrice: 0 },
      { id: 'b', inputPrice: 0, outputPrice: 1.5 },
      { id: 'c', inputPrice: 3, outputPrice: 6 },
      { id: 'd' }
    ]
    expect(freeModels(list).map(m => m.id)).toEqual(['a:free'])
  })

  // Without prices in the list there is nothing to filter on, and every model
  // would read as free.
  test('a list without prices yields nothing', () => {
    expect(freeModels([{ id: 'x' }, { id: 'y' }])).toEqual([])
  })
})

describe('adding models without prompting', () => {
  const api = {
    getModelInfo: async (id) => ({
      model: id,
      contextTokenLimit: 128000,
      inputPrice: 0,
      outputPrice: 0,
      inputFormat: ['text']
    })
  }

  test('writes entries the catalog accepts, creator included', async () => {
    await addModels('openrouter', api, [
      { id: 'deepseek/deepseek-r1:free', label: 'DeepSeek R1 (free)' },
      { id: 'nobody/unknown-model:free', label: 'Unknown' }
    ])
    const curated = await getCuratedModels()

    expect(curated['openrouter/deepseek/deepseek-r1:free']).toMatchObject({
      provider: 'openrouter',
      model: 'deepseek/deepseek-r1:free',
      creator: 'deepseek',
      inputPrice: 0,
      outputPrice: 0,
      inputFormat: ['text']
    })
    // Creator is required, and an upstream list never states it. An id whose
    // vendor the creator table does not know still has to produce one.
    expect(curated['openrouter/nobody/unknown-model:free'].creator).toBe('nobody')
  })
})

describe('the openrouter model list', () => {
  test('carries the prices it publishes, per million tokens', async () => {
    const payload = {
      data: [
        { id: 'deepseek/deepseek-r1:free', name: 'R1 (free)', pricing: { prompt: '0', completion: '0' } },
        { id: 'anthropic/claude-sonnet-4-6', name: 'Sonnet', pricing: { prompt: '0.000003', completion: '0.000015' } }
      ]
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => payload })
    const { default: adapter } = await import('../../src/lib/catalog/openrouter.js')

    const models = await adapter({ apiKey: 'k' }).listModels()
    expect(models).toEqual([
      { id: 'deepseek/deepseek-r1:free', label: 'R1 (free)', inputPrice: 0, outputPrice: 0 },
      { id: 'anthropic/claude-sonnet-4-6', label: 'Sonnet', inputPrice: 3, outputPrice: 15 }
    ])
    expect(freeModels(models).map(m => m.id)).toEqual(['deepseek/deepseek-r1:free'])
    fetchSpy.mockRestore()
  })
})
