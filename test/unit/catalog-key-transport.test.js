import fs from 'node:fs'
import path from 'node:path'
import { describe, test, expect, afterEach } from 'vitest'

const CATALOG_DIR = path.join(import.meta.dirname, '..', '..', 'src', 'lib', 'catalog')
const MODULES = fs.readdirSync(CATALOG_DIR).filter(f => f.endsWith('.js')).sort()

const API_KEY = 'sk-secret-do-not-log-1234567890'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

/**
 * Records every request a fetcher makes and answers with an empty
 * model list in each provider's response shape.
 */
function recordingFetch (calls) {
  return async (input, init = {}) => {
    calls.push({ url: String(input?.url ?? input), headers: init.headers || {} })
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ models: [], data: [], models_list: [] })
    }
  }
}

describe('catalog fetchers never put the API key in the URL', () => {
  test('the registry is non-empty', () => {
    expect(MODULES.length).toBeGreaterThan(0)
  })

  for (const file of MODULES) {
    test(file, async () => {
      const calls = []
      globalThis.fetch = recordingFetch(calls)

      const factory = (await import(path.join(CATALOG_DIR, file))).default
      const catalog = factory({ apiKey: API_KEY })
      await catalog.listModels()

      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) {
        expect(call.url).not.toContain(API_KEY)
        expect(new URL(call.url).searchParams.has('key')).toBe(false)
        // The key has to travel somewhere: a header, not the URL.
        expect(JSON.stringify(call.headers)).toContain(API_KEY)
      }
    })
  }
})
