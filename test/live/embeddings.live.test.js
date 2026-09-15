/**
 * Live embedding smoke tests. Gated per provider on the matching
 * `<PROVIDER>_API_SK`; a provider without a key is skipped, so this suite is
 * safe to run with only some keys set.
 *
 * Deliberately small: four calls per provider with short inputs, because a
 * trial key is rate limited and embeddings bill per token.
 *
 *   COHERE_API_SK=... npm run test:live
 *   npx vitest run test/live/embeddings.live.test.js
 *
 * `local` needs a server rather than a key: set MOHDEL_LOCAL_EMBED_URL to
 * something like http://localhost:11434/v1 to include it.
 */
import { describe, test, expect } from 'vitest'
import { runEmbedding } from '../../js/session/run_embedding.js'
import providers from '../../src/lib/providers.js'
import { getCuratedModels, loadDefaultEnv } from '../../src/lib/common.js'

loadDefaultEnv()

/**
 * The entries under test are the ones in the catalog, not a copy: a wrong
 * `dimensions` or `maxBatch` in `curated.json` should fail here rather than
 * pass against a duplicate written for the test.
 */
const MODELS = {
  openai: 'openai/text-embedding-3-small',
  cohere: 'cohere/embed-v4.0',
  gemini: 'gemini/gemini-embedding-2',
  local: 'local/nomic-embed-text'
}

const catalog = await getCuratedModels()
const SPECS = Object.fromEntries(
  Object.entries(MODELS)
    .map(([provider, key]) => [provider, catalog[key]])
    .filter(([, spec]) => spec)
)

const keyFor = (provider) => provider === 'local'
  ? process.env.MOHDEL_LOCAL_EMBED_URL && 'local'
  : process.env[providers[provider]?.apiKeyEnv]

// `local` reaches a server rather than a provider, so its entry's baseURL is
// overridable without editing the catalog.
const specFor = (provider) => provider === 'local'
  ? { ...SPECS.local, baseURL: process.env.MOHDEL_LOCAL_EMBED_URL ?? SPECS.local.baseURL }
  : SPECS[provider]

const embed = (provider, input, extra = {}, override = {}) => runEmbedding({
  callId: `live-${Date.now()}`,
  authId: 'live',
  auth: { key: keyFor(provider) ?? '' },
  model: MODELS[provider],
  input,
  ...extra
}, { spec: { ...specFor(provider), ...override } })

describe('live embeddings', () => {
  // A checkout without these entries applied has nothing to test; say so
  // rather than failing with "no test found in suite".
  if (!Object.keys(SPECS).length) {
    test.skip(`no embedding entries in the catalog (looked for ${Object.values(MODELS).join(', ')})`, () => {})
    return
  }

  for (const [provider, spec] of Object.entries(SPECS)) {
    const available = !!keyFor(provider)
    const maybe = available ? describe : describe.skip

    maybe(`${provider} (${MODELS[provider]})`, () => {
      test('one input returns one vector of the declared width', async () => {
        const r = await embed(provider, ['the quick brown fox'])
        expect(r.ok, JSON.stringify(r.error)).toBe(true)
        expect(r.result.vectors).toHaveLength(1)
        expect(r.result.vectors[0].length).toBe(spec.dimensions)
        expect(r.result.status).toBe('completed')
      }, 30_000)

      test('a batch returns one vector per input, in order', async () => {
        const r = await embed(provider, ['alpha', 'beta', 'gamma'])
        expect(r.ok, JSON.stringify(r.error)).toBe(true)
        expect(r.result.vectors).toHaveLength(3)
        // Distinct texts must not produce identical vectors: that would mean
        // the provider aggregated the batch instead of embedding each input.
        expect(r.result.vectors[0]).not.toEqual(r.result.vectors[1])
      }, 30_000)

      // Without this the cost figure is 0 and nobody notices.
      test('the provider reports the tokens it billed, and the entry prices them', async () => {
        const r = await embed(provider, ['the quick brown fox'])
        expect(r.ok).toBe(true)
        if (provider === 'local') return // self-hosted: no tokens, no price
        expect(r.result.inputTokens).toBeGreaterThan(0)
        if (spec.embeddingPrice) expect(r.result.cost).toBeGreaterThan(0)
      }, 30_000)

      test.runIf(spec.dimensionsSelectable)('a requested width is honoured, not ignored', async () => {
        const r = await embed(provider, ['the quick brown fox'], { dimensions: 256 })
        expect(r.ok, JSON.stringify(r.error)).toBe(true)
        expect(r.result.vectors[0].length).toBe(256)
      }, 30_000)

      test('a batch over maxBatch is refused before dispatch', async () => {
        const r = await embed(provider, ['a', 'b'], {}, { maxBatch: 1 })
        expect(r.ok).toBe(false)
        expect(r.error.type).toBe('EMBED_BATCH_TOO_LARGE')
      })

      test.runIf(spec.inputTypes)('the role reaches the provider and is reported back', async () => {
        const r = await embed(provider, ['the quick brown fox'], { inputType: 'query' })
        expect(r.ok, JSON.stringify(r.error)).toBe(true)
        expect(r.result.inputType).toBe(spec.inputTypes.query)
      }, 30_000)
    })
  }
})
