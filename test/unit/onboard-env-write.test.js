import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, test, expect, beforeEach, afterAll, vi } from 'vitest'

const dirs = vi.hoisted(() => {
  const os = require('node:os')
  const path = require('node:path')
  const fs = require('node:fs')
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'mohdel-onboard-'))
  return { config, cache: config, data: config, log: config, temp: config }
})

vi.mock('env-paths', () => ({ default: () => dirs }))

const { appendToEnvFile } = await import('../../src/cli/onboard.js')
const { ENV_PATH } = await import('../../src/lib/common.js')

afterAll(() => { fs.rmSync(dirs.config, { recursive: true, force: true }) })

const read = () => fs.readFileSync(ENV_PATH, 'utf8')

describe('appendToEnvFile', () => {
  beforeEach(() => { fs.rmSync(ENV_PATH, { force: true }) })

  test('writes a new key', async () => {
    await appendToEnvFile('OPENAI_API_SK', 'sk-plain')
    expect(read()).toBe('OPENAI_API_SK=sk-plain\n')
  })

  test('replaces an existing key in place', async () => {
    await appendToEnvFile('OPENAI_API_SK', 'sk-first')
    await appendToEnvFile('OPENAI_API_SK', 'sk-second')
    expect(read()).toBe('OPENAI_API_SK=sk-second\n')
  })

  test.each([
    ['dollar-ampersand', 'sk-$&-tail'],
    ['dollar-backtick', 'sk-$`-tail'],
    ['dollar-quote', "sk-$'-tail"],
    ['dollar-group', 'sk-$1-tail'],
    ['dollar-dollar', 'sk-$$-tail']
  ])('stores a replacement key containing %s verbatim', async (_label, key) => {
    // These are replacement-string escapes: on the update path a
    // replacement *string* expands them, silently rewriting the key
    // before it reaches disk.
    await appendToEnvFile('OPENAI_API_SK', 'sk-original')
    await appendToEnvFile('OPENAI_API_SK', key)
    expect(read()).toBe(`OPENAI_API_SK=${key}\n`)
  })

  test('leaves other keys untouched when replacing', async () => {
    await appendToEnvFile('OPENAI_API_SK', 'sk-a')
    await appendToEnvFile('GEMINI_API_SK', 'sk-b')
    await appendToEnvFile('OPENAI_API_SK', 'sk-c')
    expect(read()).toBe('OPENAI_API_SK=sk-c\nGEMINI_API_SK=sk-b\n')
  })

  test('the env file is owner-only', async () => {
    await appendToEnvFile('OPENAI_API_SK', 'sk-perm')
    expect(fs.statSync(ENV_PATH).mode & 0o777).toBe(0o600)
  })

  test('the file lives under the config dir', () => {
    expect(path.dirname(ENV_PATH).startsWith(dirs.config)).toBe(true)
    expect(os.tmpdir().length).toBeGreaterThan(0)
  })
})

describe('provider catalogue shown by first-run setup', () => {
  test('every provider that takes a key can be configured interactively', async () => {
    const { default: providers } = await import('../../src/lib/providers.js')
    const { default: PROVIDER_INFO } = await import('../../src/lib/provider-info.js')
    const keyed = Object.entries(providers).filter(([, d]) => d.apiKeyEnv).map(([n]) => n)
    expect(keyed.filter(n => !PROVIDER_INFO[n])).toEqual([])
  })

  test('descriptions carry no model version number', async () => {
    const { default: PROVIDER_INFO } = await import('../../src/lib/provider-info.js')
    // A generation in prose ("Gemini 2.5/3", "Llama 4") is stale the moment
    // the provider ships the next one, and nothing here updates it.
    const versioned = Object.entries(PROVIDER_INFO)
      .filter(([, info]) => /\d/.test(info.description))
      .map(([name, info]) => `${name}: ${info.description}`)
    expect(versioned).toEqual([])
  })

  test('every entry carries the fields the picker renders', async () => {
    const { default: PROVIDER_INFO } = await import('../../src/lib/provider-info.js')
    for (const [name, info] of Object.entries(PROVIDER_INFO)) {
      expect(info, name).toMatchObject({
        label: expect.any(String),
        description: expect.any(String),
        url: expect.stringMatching(/^https:\/\//),
        hint: expect.any(String),
        free: expect.any(Boolean)
      })
    }
  })
})
