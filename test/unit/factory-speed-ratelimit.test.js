import fs from 'node:fs'
import { describe, test, expect, beforeEach, vi } from 'vitest'

// `setRateLimit` persists the whole catalog, so this file must not be pointed
// at the machine's real one.
const dirs = vi.hoisted(() => {
  const os = require('node:os')
  const path = require('node:path')
  const fs = require('node:fs')
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'mohdel-lane-rl-'))
  return { config, cache: config, data: config, log: config, temp: config }
})

vi.mock('env-paths', () => ({ default: () => dirs }))

const mohdel = (await import('../../src/lib/index.js')).default
const { CURATED_PATH } = await import('../../src/lib/common.js')
const { clearCuratedCache } = await import('../../src/lib/curated-cache.js')

const CATALOG = {
  'anthropic/claude-x': {
    model: 'claude-x',
    provider: 'anthropic',
    creator: 'anthropic',
    inputFormat: ['text'],
    inputPrice: 0,
    outputPrice: 0,
    speeds: {
      fast: { wire: 'fast', inputPrice: 6, outputPrice: 30 },
      bare: { wire: 'economy' }
    }
  }
}

const silent = { trace () {}, debug () {}, info () {}, warn () {}, error () {}, fatal () {} }

const factory = async () => {
  fs.writeFileSync(CURATED_PATH, JSON.stringify(CATALOG, null, 2))
  clearCuratedCache()
  return mohdel({ configurations: { anthropic: { apiKey: 'sk-test' } }, logger: silent })
}

beforeEach(() => { clearCuratedCache() })

describe('rate limits on a speed lane', () => {
  test('a lane limit is written into the lane, not the entry', async () => {
    const m = await factory()
    const result = await m.use('anthropic/claude-x@fast').setRateLimit({ rpm: 200 })
    expect(result).toEqual({ rpmLimit: 200, tpmLimit: undefined })

    const entry = m.use('anthropic/claude-x').info()
    expect(entry.speeds.fast.rpmLimit).toBe(200)
    expect(entry.rpmLimit).toBeUndefined()
    expect(entry.rateLimitScope).toBeUndefined()
  })

  test('the entry keeps its own limit alongside the lane', async () => {
    const m = await factory()
    await m.use('anthropic/claude-x').setRateLimit({ rpm: 10 })
    await m.use('anthropic/claude-x@fast').setRateLimit({ rpm: 200 })

    const entry = m.use('anthropic/claude-x').info()
    expect(entry.rpmLimit).toBe(10)
    expect(entry.speeds.fast.rpmLimit).toBe(200)
    expect(entry.speeds.bare.rpmLimit).toBeUndefined()
  })

  test('inpm is refused on a lane, since a lane carries rpm and tpm only', async () => {
    const m = await factory()
    await expect(m.use('anthropic/claude-x@fast').setRateLimit({ inpm: 2000 }))
      .rejects.toThrow(/not a speed-lane limit/)
  })

  test('clearing a lane leaves its other fields and the entry alone', async () => {
    const m = await factory()
    await m.use('anthropic/claude-x').setRateLimit({ rpm: 10 })
    await m.use('anthropic/claude-x@fast').setRateLimit({ rpm: 200, tpm: 5000 })
    await m.use('anthropic/claude-x@fast').clearRateLimit(['rpm'])

    const entry = m.use('anthropic/claude-x').info()
    expect(entry.speeds.fast.rpmLimit).toBeUndefined()
    expect(entry.speeds.fast.tpmLimit).toBe(5000)
    expect(entry.speeds.fast.inputPrice).toBe(6)
    expect(entry.rpmLimit).toBe(10)
  })

  test('info names the lane it resolved, so callers can tell which bucket applies', async () => {
    const m = await factory()
    expect(m.use('anthropic/claude-x@fast').info().speed).toBe('fast')
    expect(m.use('anthropic/claude-x').info().speed).toBeUndefined()
  })
})
