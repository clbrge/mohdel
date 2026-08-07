import fs from 'node:fs'
import path from 'node:path'
import { describe, test, expect, beforeEach, afterAll, vi } from 'vitest'

// `common.js` derives CONFIG_DIR from env-paths at module load, so the
// mock has to be in place before it is imported.
const dirs = vi.hoisted(() => {
  const os = require('node:os')
  const path = require('node:path')
  const fs = require('node:fs')
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'mohdel-common-'))
  return { config, cache: config, data: config, log: config, temp: config }
})

vi.mock('env-paths', () => ({ default: () => dirs }))

const { getCuratedModels, getConfig, ConfigParseError, CURATED_PATH, CONFIG_PATH } =
  await import('../../src/lib/common.js')

afterAll(() => { fs.rmSync(dirs.config, { recursive: true, force: true }) })

describe('config load: missing vs malformed', () => {
  beforeEach(() => {
    for (const f of [CURATED_PATH, CONFIG_PATH]) fs.rmSync(f, { force: true })
  })

  test('a missing file resolves to the default', async () => {
    await expect(getConfig()).resolves.toEqual({})
  })

  test('a valid file loads', async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ defaultModel: 'openai/gpt-5' }))
    await expect(getConfig()).resolves.toMatchObject({ defaultModel: 'openai/gpt-5' })
  })

  test('a file that exists but does not parse throws naming the path', async () => {
    fs.writeFileSync(CURATED_PATH, '{ "openai/gpt-5": { ,, } }')
    await expect(getCuratedModels()).rejects.toThrow(ConfigParseError)
    await expect(getCuratedModels()).rejects.toThrow(/is not valid JSON/)
    await expect(getCuratedModels()).rejects.toThrow(CURATED_PATH)
  })

  test('the parse failure is not masked by the default fallback', async () => {
    fs.writeFileSync(CURATED_PATH, 'not json at all')
    const result = await getCuratedModels().then(
      value => ({ resolved: value }),
      err => ({ threw: err })
    )
    expect(result.resolved).toBeUndefined()
    expect(result.threw).toBeInstanceOf(ConfigParseError)
    expect(result.threw.cause).toBeInstanceOf(SyntaxError)
  })
})

describe('path derivation', () => {
  test('config paths live under the mocked config dir', () => {
    expect(CURATED_PATH.startsWith(dirs.config)).toBe(true)
    expect(path.basename(CURATED_PATH)).toBe('curated.json')
  })
})
