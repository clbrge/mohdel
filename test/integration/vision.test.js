import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { describe, test, expect } from 'vitest'
import { loadDefaultEnv } from '../../src/lib/common.js'
import mohdel from '../../src/lib/index.js'
import { getCuratedCacheSnapshot } from '../../src/lib/curated-cache.js'
import providers from '../../src/lib/providers.js'

loadDefaultEnv()

const __dirname = dirname(fileURLToPath(import.meta.url))
const imagePath = join(__dirname, '..', 'test-vision.png')
const imageBase64 = readFileSync(imagePath).toString('base64')

// Normalized image object matching the engine's format after inference.js normalization
const testImage = {
  mimeType: 'image/png',
  fileUri: `data:image/png;base64,${imageBase64}`,
  data: imageBase64,
  width: 200,
  height: 80,
  filename: 'test-vision.png',
  size: readFileSync(imagePath).length
}

describe('vision integration', async () => {
  const m = await mohdel()
  const curated = getCuratedCacheSnapshot()

  // Collect one model per provider that supports image input
  const seen = new Set()
  const visionModels = []
  for (const [fullId, meta] of Object.entries(curated)) {
    if (meta.deprecated) continue
    if (!meta.inputFormat?.includes('image')) continue
    // Skip image-generation-only models (no answer() support)
    if (meta.type === 'image') continue
    // Skip models without an SDK (imagen, etc.)
    if (!meta.sdk) continue
    const provider = fullId.split('/')[0]
    // One model per provider is enough
    if (seen.has(provider)) continue
    const envVar = providers[provider]?.apiKeyEnv
    if (!envVar || !process.env[envVar]) continue
    seen.add(provider)
    visionModels.push(fullId)
  }

  for (const modelId of visionModels) {
    describe(`${modelId}`, () => {
      test('can describe image content', async () => {
        const llm = m.use(modelId)
        const result = await llm.answer(
          'List the three characters shown in this image, in order from left to right. Reply with ONLY the three characters separated by spaces, nothing else.',
          { images: [testImage] }
        )

        expect(result.status).toBe('completed')
        expect(result.output).toBeTruthy()

        const output = result.output.trim()
        // Model should identify: A (black), + (red), # (blue)
        expect(output).toMatch(/A/)
        expect(output).toMatch(/\+/)
        expect(output).toMatch(/#/)
      }, 30_000)

      test('can identify colors', async () => {
        const llm = m.use(modelId)
        const result = await llm.answer(
          'What color is each character in this image? Reply as: first=COLOR, second=COLOR, third=COLOR',
          { images: [testImage] }
        )

        expect(result.status).toBe('completed')
        expect(result.output).toBeTruthy()

        const lower = result.output.toLowerCase()
        expect(lower).toMatch(/black/)
        expect(lower).toMatch(/red/)
        expect(lower).toMatch(/blue/)
      }, 30_000)
    })
  }
})
