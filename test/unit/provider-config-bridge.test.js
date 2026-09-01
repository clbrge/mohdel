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
    expect(cfg).toEqual({ apiKey: 'sk-test' })
    expect(configToAuth(cfg).key).toBe('sk-test')
  })
})

describe('local: optional token only; the endpoint lives on the catalog entry', () => {
  afterEach(() => {
    delete process.env.MOHDEL_LOCAL_API_SK
  })

  test('no token → empty key and no baseURL on the envelope', () => {
    delete process.env.MOHDEL_LOCAL_API_SK
    expect(configToAuth(providers.local.resolveConfiguration())).toEqual({ key: '' })
  })

  test('MOHDEL_LOCAL_API_SK becomes the key', () => {
    process.env.MOHDEL_LOCAL_API_SK = 'tok'
    expect(configToAuth(providers.local.resolveConfiguration())).toEqual({ key: 'tok' })
  })
})
