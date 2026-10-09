import { describe, test, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../../', import.meta.url)
const src = (file) => readFileSync(fileURLToPath(new URL(file, root)), 'utf8')

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const holder = vi.hoisted(() => ({ mode: 'ok' }))

vi.mock('../../src/lib/catalog/openai.js', () => ({
  default: () => ({
    listModels: async () => {
      if (holder.mode === 'ok') return [{ id: 'gpt-x', label: 'X' }]
      if (holder.mode === 'auth') throw new Error('401 Unauthorized fetching https://api.openai.com/v1/models')
      throw new Error('socket hang up')
    }
  })
}))

const { verifyKey } = await import('../../src/cli/onboard.js')

describe('verifyKey against a candidate key, before anything is saved', () => {
  test('openrouter checks /auth/key, not the public model list', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200 }))
    expect(await verifyKey('openrouter', 'sk-good')).toBe('valid')
    const [url, init] = globalThis.fetch.mock.calls[0]
    expect(url).toBe('https://openrouter.ai/api/v1/auth/key')
    expect(JSON.stringify(init.headers)).toContain('sk-good')
  })

  test('openrouter refuses a bad key without touching the model list', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401 }))
    expect(await verifyKey('openrouter', 'sk-17chars')).toBe('invalid')
  })

  test('openrouter offline is unknown, never invalid', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('socket hang up') })
    expect(await verifyKey('openrouter', 'sk-x')).toBe('unknown')
  })

  test('a listed provider accepts its key', async () => {
    holder.mode = 'ok'
    expect(await verifyKey('openai', 'sk-good')).toBe('valid')
    holder.mode = 'ok'
  })

  test('a 401 listing refuses the key', async () => {
    holder.mode = 'auth'
    expect(await verifyKey('openai', 'sk-17chars')).toBe('invalid')
    holder.mode = 'ok'
  })

  test('a network failure is unknown, so setup offers to save anyway', async () => {
    holder.mode = 'down'
    expect(await verifyKey('openai', 'sk-x')).toBe('unknown')
    holder.mode = 'ok'
  })

  test('a provider with no listing mohdel reads is unknown', async () => {
    expect(await verifyKey('cohere', 'sk-x')).toBe('unknown')
  })

  test('a keyless provider is unknown', async () => {
    expect(await verifyKey('chatgpt', 'sk-x')).toBe('unknown')
    expect(await verifyKey('local', '')).toBe('unknown')
  })
})

describe('keys are never echoed and share one verified prompt', () => {
  test('onboarding masks the paste', () => {
    expect(src('src/cli/onboard.js')).toContain('await password(')
  })

  test('provider setup reuses the verified prompt instead of its own text() paste', async () => {
    const model = src('src/cli/model.js')
    expect(model).toContain('askValidatedKey')
    expect(model).not.toContain('Paste your')
  })

  test('onboarding keeps a single key prompt', () => {
    expect(src('src/cli/onboard.js').split('Paste your').length - 1).toBe(1)
  })
})
