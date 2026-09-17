import fs from 'node:fs'
import { describe, test, expect, beforeAll, vi } from 'vitest'

const dirs = vi.hoisted(() => {
  const os = require('node:os')
  const path = require('node:path')
  const fs = require('node:fs')
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'mohdel-price-'))
  return { config, cache: config, data: config, log: config, temp: config }
})

vi.mock('env-paths', () => ({ default: () => dirs }))

const { runModel } = await import('../../src/cli/model.js')
const { CURATED_PATH } = await import('../../src/lib/common.js')

const entry = (extra) => ({
  model: 'm', creator: 'x', provider: 'openai', inputFormat: ['text'], ...extra
})

beforeAll(() => {
  fs.writeFileSync(CURATED_PATH, JSON.stringify({
    'openai/pair': entry({ inputPrice: 0.15, outputPrice: 0.6 }),
    'openai/embed': entry({ embeddingPrice: 0.02 }),
    'openai/image': entry({ imagePrice: 0.012 }),
    'openai/audio': entry({ transcriptionPrice: 0.000667 }),
    'openai/zero': entry({ inputPrice: 0, outputPrice: 0 })
  }))
})

const list = async () => {
  const out = []
  const log = vi.spyOn(console, 'log').mockImplementation(l => out.push(l))
  try { await runModel(['list']) } finally { log.mockRestore() }
  return out.join('\n')
}

describe('mo model list — what a row says a model costs', () => {
  test('a model billed per token shows both sides of the pair', async () => {
    expect(await list()).toMatch(/openai\/pair.*\$0\.15.*\$0\.6/)
  })

  test('a model billed on one dimension shows that price, with its unit', async () => {
    const rows = await list()
    expect(rows).toMatch(/openai\/embed.*\$0\.02/)
    expect(rows).toMatch(/openai\/image.*\$0\.012\/image/)
    expect(rows).toMatch(/openai\/audio.*\$0\.000667\/min/)
  })

  test('free is reserved for a model that carries no price at all', async () => {
    const rows = await list()
    expect(rows).toMatch(/openai\/zero.*free/)
    for (const paid of ['openai/embed', 'openai/image', 'openai/audio']) {
      expect(rows).not.toMatch(new RegExp(`${paid}.*free`))
    }
  })
})
