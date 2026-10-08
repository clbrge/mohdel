import fs from 'node:fs'
import path from 'node:path'
import { describe, test, expect, beforeEach, afterAll, afterEach, vi } from 'vitest'

const dirs = vi.hoisted(() => {
  const os = require('node:os')
  const path = require('node:path')
  const fs = require('node:fs')
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'mohdel-readiness-'))
  return { config, cache: config, data: config, log: config, temp: config }
})

vi.mock('env-paths', () => ({ default: () => dirs }))

const { modelReadiness, providerReadiness } = await import('../../src/lib/readiness.js')
const { CLI } = await import('../../src/lib/cli-path.js')
const { CURATED_PATH } = await import('../../src/lib/common.js')

const catalog = (entries) => fs.writeFileSync(CURATED_PATH, JSON.stringify(entries))
const OPENAI = 'openai/gpt-test'
const entry = (prices = {}) => ({ model: 'gpt-test', creator: 'openai', provider: 'openai', sdk: 'openai', inputFormat: ['text'], ...prices })

afterAll(() => { fs.rmSync(dirs.config, { recursive: true, force: true }) })
beforeEach(() => { catalog({}) })
afterEach(() => { vi.unstubAllEnvs() })

describe('one model', () => {
  test('wants its credential first, then its place in the catalog', async () => {
    vi.stubEnv('OPENAI_API_SK', '')
    expect(await modelReadiness(OPENAI)).toMatchObject({ credential: false, ready: false, fix: 'mo onboard openai' })
    vi.stubEnv('OPENAI_API_SK', 'sk-test')
    expect(await modelReadiness(OPENAI)).toMatchObject({ credential: true, inCatalog: false, ready: false, fix: 'mo curate openai' })
  })

  test('is ready without its prices, and says the prices are what is missing', async () => {
    vi.stubEnv('OPENAI_API_SK', 'sk-test')
    catalog({ [OPENAI]: entry() })
    expect(await modelReadiness(OPENAI)).toEqual({ model: OPENAI, inCatalog: true, priced: false, billing: 'metered', credential: true, ready: true, fix: 'mo model instructions openai' })
    catalog({ [OPENAI]: entry({ inputPrice: 1, outputPrice: 4 }) })
    expect(await modelReadiness(OPENAI)).toMatchObject({ priced: true, ready: true, fix: null })
  })

  test('asks a ChatGPT model for a sign-in, and no prices of a plan', async () => {
    expect(await modelReadiness('chatgpt/gpt-test')).toMatchObject({ billing: 'plan', priced: null, credential: false, fix: 'mo chatgpt login' })
  })

  test('names a provider mohdel does not know', async () => {
    expect(await modelReadiness('nowhere/x')).toMatchObject({ ready: false, fix: expect.stringMatching(/not a provider mohdel knows/) })
  })
})

describe('a provider', () => {
  test('is ready with its credential and a model of it in the catalog', async () => {
    vi.stubEnv('OPENAI_API_SK', 'sk-test')
    expect(await providerReadiness('openai')).toMatchObject({ credential: true, models: 0, ready: false, fix: 'mo curate openai' })
    catalog({ [OPENAI]: entry(), 'openai/gpt-gone': { ...entry(), deprecated: OPENAI } })
    expect(await providerReadiness('openai')).toMatchObject({ models: 1, ready: true, fix: null })
  })
})

test('the installed mo is where mohdel/cli says', () => {
  expect(CLI.endsWith(path.join('src', 'cli', 'index.js'))).toBe(true)
  expect(fs.existsSync(CLI)).toBe(true)
})
