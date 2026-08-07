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
