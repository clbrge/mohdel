import fs from 'node:fs'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const dirs = vi.hoisted(() => {
  const os = require('node:os')
  const path = require('node:path')
  const fs = require('node:fs')
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'mohdel-mohdex-add-'))
  return { config, cache: config, data: config, log: config, temp: config }
})

vi.mock('env-paths', () => ({ default: () => dirs }))

const { addFromMohdex } = await import('../../src/lib/mohdex.js')
const { CURATED_PATH, getCuratedModels } = await import('../../src/lib/common.js')

const entry = { provider: 'openai', sdk: 'openai', model: 'gpt-test', creator: 'openai', inputPrice: 1, outputPrice: 5, inputFormat: ['text'] }
const held = { provider: 'openai', sdk: 'openai', model: 'gpt-held', creator: 'openai', inputPrice: 2, outputPrice: 8, inputFormat: ['text'] }

afterAll(() => { fs.rmSync(dirs.config, { recursive: true, force: true }) })
beforeEach(() => { fs.writeFileSync(CURATED_PATH, JSON.stringify({ 'openai/gpt-held': held })) })

describe('addFromMohdex', () => {
  it('writes an entry the catalog accepts, beside what it holds', async () => {
    await addFromMohdex([{ key: 'openai/gpt-test', entry }])
    const curated = await getCuratedModels()
    expect(curated['openai/gpt-test'].model).toBe('gpt-test')
    expect(curated['openai/gpt-held'].model).toBe('gpt-held')
  })

  it('throws on an entry the catalog would reject, naming the key and the field', async () => {
    await expect(addFromMohdex([{ key: 'openai/gpt-test', entry: { ...entry, inputPrice: -1 } }]))
      .rejects.toThrow(/the catalog would reject openai\/gpt-test: inputPrice — /)
  })

  it('writes none of them when one is rejected', async () => {
    await expect(addFromMohdex([
      { key: 'openai/gpt-test', entry },
      { key: 'openai/gpt-bad', entry: { ...entry, model: 'gpt-bad', inputPrice: -1 } }
    ])).rejects.toThrow('openai/gpt-bad')
    const curated = await getCuratedModels()
    expect(curated['openai/gpt-test']).toBeUndefined()
    expect(curated['openai/gpt-bad']).toBeUndefined()
  })
})
