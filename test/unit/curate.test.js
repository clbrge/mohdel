import fs from 'node:fs'
import { describe, test, expect, beforeEach, afterAll, afterEach, vi } from 'vitest'

const dirs = vi.hoisted(() => {
  const os = require('node:os')
  const path = require('node:path')
  const fs = require('node:fs')
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'mohdel-curate-'))
  return { config, cache: config, data: config, log: config, temp: config }
})

vi.mock('env-paths', () => ({ default: () => dirs }))

vi.mock('../../src/lib/catalog/openrouter.js', () => ({
  default: () => ({
    listModels: async () => [
      { id: 'vendor/priced', label: 'Priced', inputPrice: 1, outputPrice: 4 },
      { id: 'vendor/bare', label: 'Bare' },
      { id: 'vendor/plain', label: 'Plain' },
      { id: 'vendor/held', label: 'Held', inputPrice: 0, outputPrice: 0 },
      { id: 'vendor/hidden', label: 'Hidden', inputPrice: 2, outputPrice: 2 }
    ],
    getModelInfo: async (id) => ({
      'vendor/priced': { model: id, inputPrice: 1, outputPrice: 4, contextTokenLimit: 128000, inputFormat: ['text'] },
      'vendor/plain': { model: id, inputFormat: ['text'] }
    })[id] ?? null
  })
}))

const { curate, upstream } = await import('../../src/lib/curate.js')
const { CURATED_PATH, EXCLUDED_PATH, getCuratedModels } = await import('../../src/lib/common.js')

afterAll(() => { fs.rmSync(dirs.config, { recursive: true, force: true }) })
beforeEach(() => {
  fs.writeFileSync(CURATED_PATH, JSON.stringify({ 'openrouter/vendor/held': { provider: 'openrouter', sdk: 'openrouter', model: 'vendor/held', creator: 'vendor' } }))
  fs.writeFileSync(EXCLUDED_PATH, JSON.stringify({ 'openrouter/vendor/hidden': { label: 'Hidden' } }))
  vi.stubEnv('OPENROUTER_API_SK', 'sk-test')
})
afterEach(() => { vi.unstubAllEnvs() })

describe('what a provider lists beyond the catalog', () => {
  test('leaves out what the catalog holds or excludes, with prices where the listing has them', async () => {
    expect(await upstream('openrouter')).toEqual([
      { id: 'vendor/priced', label: 'Priced', inputPrice: 1, outputPrice: 4 },
      { id: 'vendor/bare', label: 'Bare', inputPrice: null, outputPrice: null },
      { id: 'vendor/plain', label: 'Plain', inputPrice: null, outputPrice: null }
    ])
  })

  test('is null without a key to list with', async () => {
    vi.stubEnv('OPENROUTER_API_SK', '')
    expect(await upstream('openrouter')).toBe(null)
  })

  test('names a provider mohdel does not know', async () => {
    await expect(upstream('nowhere')).rejects.toThrow(/not a provider mohdel knows/)
  })
})

describe('adding models without prompting', () => {
  test('writes an entry for each, saying which have prices', async () => {
    expect(await curate('openrouter', ['vendor/priced', 'vendor/plain'])).toEqual([
      { model: 'openrouter/vendor/priced', priced: true },
      { model: 'openrouter/vendor/plain', priced: false }
    ])
    const catalog = await getCuratedModels()
    expect(catalog['openrouter/vendor/priced']).toMatchObject({ provider: 'openrouter', model: 'vendor/priced', creator: 'vendor', inputPrice: 1 })
    expect(catalog['openrouter/vendor/held']).toBeDefined()
    expect(await upstream('openrouter')).toEqual([{ id: 'vendor/bare', label: 'Bare', inputPrice: null, outputPrice: null }])
  })

  test('refuses a model the provider does not describe well enough for the catalog, writing nothing', async () => {
    await expect(curate('openrouter', ['vendor/priced', 'vendor/bare'])).rejects.toThrow(
      'the catalog would reject openrouter/vendor/bare: inputFormat — required field missing (vendor/bare is not in the provider\'s response). mo curate openrouter asks for what is missing'
    )
    expect((await getCuratedModels())['openrouter/vendor/priced']).toBeUndefined()
  })

  test('refuses a model the provider does not list, writing nothing', async () => {
    await expect(curate('openrouter', ['vendor/priced', 'vendor/nowhere'])).rejects.toThrow(/does not list vendor\/nowhere/)
    expect((await getCuratedModels())['openrouter/vendor/priced']).toBeUndefined()
  })

  test('leaves an entry already in the catalog as it is, writing nothing', async () => {
    await expect(curate('openrouter', ['vendor/priced', 'vendor/held'])).rejects.toThrow(/vendor\/held is already in the catalog/)
    expect(JSON.parse(fs.readFileSync(CURATED_PATH, 'utf8'))).toEqual({
      'openrouter/vendor/held': { provider: 'openrouter', sdk: 'openrouter', model: 'vendor/held', creator: 'vendor' }
    })
  })

  test('refuses a model another entry holds as an alias', async () => {
    fs.writeFileSync(CURATED_PATH, JSON.stringify({ 'openrouter/priced': { provider: 'openrouter', sdk: 'openrouter', model: 'priced', creator: 'vendor', aliases: ['vendor/priced'] } }))
    await expect(curate('openrouter', ['vendor/priced'])).rejects.toThrow(/already in the catalog/)
  })

  test('refuses a model excluded from the catalog', async () => {
    await expect(curate('openrouter', ['vendor/hidden'])).rejects.toThrow(/vendor\/hidden is excluded from the catalog/)
  })

  test('sends a provider without its key to mo onboard', async () => {
    vi.stubEnv('OPENROUTER_API_SK', '')
    await expect(curate('openrouter', ['vendor/priced'])).rejects.toThrow(/openrouter has no key — mo onboard openrouter sets it/)
  })
})
