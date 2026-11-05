import fs from 'node:fs'
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const dirs = vi.hoisted(() => {
  const os = require('node:os')
  const path = require('node:path')
  const fs = require('node:fs')
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'mohdel-credential-only-'))
  return { config, cache: config, data: config, log: config, temp: config }
})

vi.mock('env-paths', () => ({ default: () => dirs }))

vi.mock('../../src/lib/catalog/openai.js', () => ({
  default: () => ({ listModels: async () => [{ id: 'gpt-test', label: 'Test' }] })
}))

const { runOnboardCommand } = await import('../../src/cli/onboard.js')
const { CURATED_PATH, ENV_PATH } = await import('../../src/lib/common.js')

const output = () => vi.mocked(process.stdout.write).mock.calls.map(([text]) => text).join('')

beforeEach(() => {
  fs.writeFileSync(CURATED_PATH, '{}')
  fs.rmSync(ENV_PATH, { force: true })
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
afterAll(() => { fs.rmSync(dirs.config, { recursive: true, force: true }) })

describe('mo onboard --credential-only', () => {
  test('a stored key is enough: exit 0 with an empty catalog, which stays empty', async () => {
    vi.stubEnv('OPENAI_API_SK', 'sk-test')
    expect(await runOnboardCommand(['openai', '--caller', 'spore', '--credential-only'])).toBe(0)
    expect(output()).toContain('openai has its credential. Back to spore.')
    expect(fs.readFileSync(CURATED_PATH, 'utf8')).toBe('{}')
  })

  test('without a caller the last line hands back to nobody', async () => {
    vi.stubEnv('OPENAI_API_SK', 'sk-test')
    expect(await runOnboardCommand(['openai', '--credential-only'])).toBe(0)
    expect(output()).toContain('openai has its credential.')
    expect(output()).not.toContain('Back to')
  })

  test('needs a provider', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await runOnboardCommand(['--caller', 'spore', '--credential-only'])).toBe(2)
    expect(error.mock.calls[0][0]).toContain('--credential-only needs a provider')
  })

  test('an unknown provider is still 2', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await runOnboardCommand(['nosuch', '--credential-only'])).toBe(2)
  })
})
