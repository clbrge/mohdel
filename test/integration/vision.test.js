import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { describe, test, expect } from 'vitest'
import { loadDefaultEnv } from '../../src/lib/common.js'
import mohdel from '../../src/lib/index.js'
import { getCuratedCacheSnapshot } from '../../src/lib/curated-cache.js'
import providers from '../../src/lib/providers.js'
import { isTextModel } from './_model-types.js'

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

const LIST_CHARACTERS = 'List the three characters shown in the image, in order from left to right. Reply with ONLY the three characters separated by spaces, nothing else.'

const VIEW_IMAGE = {
  name: 'view_image',
  description: 'Returns the image the user is asking about.',
  parameters: { type: 'object', properties: {} }
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
    // Non-chat endpoints have no answer() support.
    if (!isTextModel(meta)) continue
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

      test('reads an image part in a user message', async () => {
        const llm = m.use(modelId)
        const result = await llm.answer({
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: 'Here is an image.' },
              { type: 'image', fileUri: `file://${imagePath}`, mimeType: 'image/png' },
              { type: 'text', text: LIST_CHARACTERS }
            ]
          }]
        })

        expect(result.status).toBe('completed')
        expectCharacters(result.output)
      }, 30_000)

      test.skipIf(curated[modelId].supportsTools === false)('reads an image returned by a tool', async () => {
        const llm = m.use(modelId)
        const ask = { role: 'user', content: `Call view_image, then answer. ${LIST_CHARACTERS}` }
        const step1 = await llm.answer({ messages: [ask] }, { tools: [VIEW_IMAGE] })
        expect(step1.status).toBe('tool_use')

        const assistantContent = step1.reasoning
          ? [{ type: 'reasoning', text: step1.reasoning }, { type: 'text', text: step1.output || '' }]
          : (step1.output || '')
        const step2 = await llm.answer({
          messages: [
            ask,
            { role: 'assistant', content: assistantContent, toolCalls: step1.toolCalls },
            {
              role: 'tool_result',
              toolCallId: step1.toolCalls[0].id,
              toolName: 'view_image',
              content: [
                { type: 'text', text: 'The image:' },
                { type: 'image', fileUri: `file://${imagePath}`, mimeType: 'image/png' }
              ]
            }
          ]
        }, { tools: [VIEW_IMAGE] })

        expect(step2.status).toBe('completed')
        expectCharacters(step2.output)
      }, 60_000)
    })
  }
})

function expectCharacters (output) {
  expect(output).toBeTruthy()
  expect(output).toMatch(/A/)
  expect(output).toMatch(/\+/)
  expect(output).toMatch(/#/)
}
