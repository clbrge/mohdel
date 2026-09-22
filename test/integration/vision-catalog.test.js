import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { describe, test, expect, afterAll } from 'vitest'
import { loadDefaultEnv } from '../../src/lib/common.js'
import mohdel from '../../src/lib/index.js'
import { getCuratedCacheSnapshot } from '../../src/lib/curated-cache.js'
import providers from '../../src/lib/providers.js'
import { isTextModel } from './_model-types.js'

loadDefaultEnv()

const __dirname = dirname(fileURLToPath(import.meta.url))
const triangle = readFileSync(join(__dirname, '..', 'test-vision-triangle.png')).toString('base64')

const QUESTION = 'What shape is in this image, and what color is it? Reply with only the color and the shape, for example "purple hexagon".'

function lowestEffort (levels) {
  if (!levels) return undefined
  return Object.entries(levels).sort((a, b) => a[1] - b[1])[0][0]
}

describe('vision: every image-capable catalog model', async () => {
  const m = await mohdel()
  const curated = getCuratedCacheSnapshot()
  const rows = []

  afterAll(() => {
    console.table(rows)
  })

  const models = Object.entries(curated)
    .filter(([, meta]) => !meta.deprecated && meta.inputFormat?.includes('image') && isTextModel(meta) && meta.sdk)
    .sort(([a], [b]) => a.localeCompare(b))

  for (const [modelId, meta] of models) {
    const envVar = providers[modelId.split('/')[0]]?.apiKeyEnv
    if (!envVar || !process.env[envVar]) {
      rows.push({ model: modelId, result: `skipped: ${envVar ?? 'no provider'} unset`, answer: '' })
      continue
    }

    test(modelId, async () => {
      const row = { model: modelId, result: 'fail', answer: '' }
      rows.push(row)
      try {
        const result = await m.use(modelId).answer({
          messages: [{
            role: 'user',
            content: [
              { type: 'image', fileUri: `data:image/png;base64,${triangle}`, mimeType: 'image/png' },
              { type: 'text', text: QUESTION }
            ]
          }]
        }, { outputBudget: 256, outputEffort: lowestEffort(meta.thinkingEffortLevels) })

        const output = (result.output ?? '').trim()
        row.answer = output.slice(-80)
        expect(result.status).toBe('completed')
        const lower = output.toLowerCase()
        expect(lower).toContain('green')
        expect(lower).toContain('triangle')
        row.result = 'pass'
      } catch (e) {
        row.answer ||= `${e.type ?? 'error'}: ${e.message}${e.detail ? ` (${e.detail})` : ''}`.slice(0, 160)
        throw e
      }
    }, 120_000)
  }
})
