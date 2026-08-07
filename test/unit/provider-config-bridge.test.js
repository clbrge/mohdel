import { describe, test, expect, afterEach } from 'vitest'
import providers from '../../src/lib/providers.js'
import { configToAuth } from '../../js/factory/bridge.js'

const entries = Object.entries(providers).filter(
  ([, p]) => typeof p.createConfiguration === 'function'
)

describe('every provider config survives the factory bridge allowlist', () => {
  test('the registry is non-empty', () => {
    expect(entries.length).toBeGreaterThan(0)
  })

  for (const [name, provider] of entries) {
    test(`${name}`, () => {
      const auth = configToAuth(provider.createConfiguration('sk-test'))
      expect(auth.key).toBe('sk-test')
    })
  }
})

describe('openrouter attribution env does not leak into the factory config', () => {
  afterEach(() => {
    delete process.env.OPENROUTER_REFERER
    delete process.env.OPENROUTER_TITLE
  })

  test('config is accepted with the attribution vars set', () => {
    process.env.OPENROUTER_REFERER = 'https://example.test'
    process.env.OPENROUTER_TITLE = 'Example'
    const cfg = providers.openrouter.createConfiguration('sk-test')
    expect(cfg).toEqual({ baseURL: 'https://openrouter.ai/api/v1', apiKey: 'sk-test' })
    expect(configToAuth(cfg).key).toBe('sk-test')
  })
})
