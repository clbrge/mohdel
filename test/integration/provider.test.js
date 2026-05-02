import { describe, test, expect } from 'vitest'
import { loadDefaultEnv } from '../../src/lib/common.js'
import mohdel from '../../src/lib/index.js'
import providers from '../../src/lib/providers.js'
import { getCuratedCacheSnapshot } from '../../src/lib/curated-cache.js'

loadDefaultEnv()

const IMAGE_TYPES = new Set(['image'])

const tagFilter = process.env.TAG || null

describe('provider integration', async () => {
  const m = await mohdel()
  const curated = getCuratedCacheSnapshot()

  // Group curated models by provider. Skip entries without any tags —
  // an un-tagged model is usually a stale/unvalidated curate that
  // produces noise in the smoke suite (e.g. a retired upstream variant).
  // Explicit `TAG=...` filter narrows further.
  const byProvider = {}
  for (const [fullId, meta] of Object.entries(curated)) {
    const provider = fullId.split('/')[0]
    if (!providers[provider]) continue
    if (!meta.tags || meta.tags.length === 0) continue
    if (tagFilter && !meta.tags.includes(tagFilter)) continue
    if (!byProvider[provider]) byProvider[provider] = []
    byProvider[provider].push(fullId)
  }

  for (const [provider, modelIds] of Object.entries(byProvider)) {
    const envVar = providers[provider].apiKeyEnv
    const hasKey = envVar && !!process.env[envVar]
    const sdk = providers[provider].sdk
    const api = providers[provider].api

    // Separate text and image models
    const textModels = modelIds.filter(id => !IMAGE_TYPES.has(curated[id].type))
    const imageModels = modelIds.filter(id => IMAGE_TYPES.has(curated[id].type))

    if (textModels.length > 0) {
      const modelId = textModels[0]

      describe.skipIf(!hasKey)(`${provider} (${modelId})`, () => {
        test('answer() smoke', async () => {
          const deltas = []
          const llm = m.use(modelId)
          const result = await llm.answer('Reply with exactly: hello', {
            realtimeHandler: (chunk) => deltas.push(chunk)
          })

          expect(result.status).toBe('completed')
          expect(result.output.toLowerCase()).toContain('hello')
          expect(result.inputTokens).toBeGreaterThan(0)
          expect(result.outputTokens).toBeGreaterThan(0)

          // Streaming providers should have forwarded at least one delta
          // chatCompletions API path (deepseek, novita) doesn't stream deltas
          if (['openai', 'anthropic', 'gemini', 'fireworks'].includes(sdk) && api !== 'chatCompletions') {
            expect(deltas.length).toBeGreaterThan(0)
            expect(deltas[0]).toHaveProperty('delta')
            expect(deltas[0]).toHaveProperty('type')
          }
        }, 30_000)

        if (m.use(modelId).supportsTools) {
          test('tool use smoke', async () => {
            const llm = m.use(modelId)
            const result = await llm.answer(
              'What is the weather in Paris? Use the get_weather tool.',
              {
                tools: [
                  {
                    name: 'get_weather',
                    description: 'Get weather for a location',
                    parameters: {
                      type: 'object',
                      properties: { location: { type: 'string' } },
                      required: ['location']
                    }
                  }
                ],
                // 'auto' rather than 'required': DeepSeek's reasoner-backed
                // models accept the tool list but reject toolChoice='required'.
                // The prompt explicitly tells the model to call the tool, so
                // every frontier model picks it up under 'auto' anyway.
                toolChoice: 'auto'
              }
            )

            expect(result.status).toBe('tool_use')
            expect(result.toolCalls).toBeDefined()
            expect(result.toolCalls.length).toBeGreaterThan(0)
            expect(result.toolCalls[0].name).toBe('get_weather')
          }, 30_000)
        }
      })
    }

    if (imageModels.length > 0) {
      const modelId = imageModels[0]

      describe.skipIf(!hasKey)(`${provider} image (${modelId})`, () => {
        test('image() smoke', async () => {
          const llm = m.use(modelId)
          const result = await llm.image('A simple red circle on white background')

          expect(result.status).toBe('completed')
          expect(result.images).toBeDefined()
          expect(result.images.length).toBeGreaterThan(0)
          expect(result.images[0]).toHaveProperty('url')
          expect(result.images[0]).toHaveProperty('mimeType')
          expect(result.timestamps).toHaveProperty('start')
          expect(result.timestamps).toHaveProperty('end')
        }, 120_000)
      })
    }
  }
})
