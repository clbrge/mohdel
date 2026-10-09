import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../../', import.meta.url)
const src = (file) => readFileSync(fileURLToPath(new URL(file, root)), 'utf8')

// Every SDK with built-in retries must be constructed with `maxRetries: 0`:
// mohdel classifies errors but never retries (ARCHITECTURE.md:393-395,
// README:182) — the caller owns the retry budget. A default `maxRetries: 2`
// retries a 429/5xx silently inside one call, adding latency and spending
// rate budget the gate's cooldown never sees.
const RETRY_CLIENTS = [
  'js/session/adapters/anthropic.js',
  'js/session/adapters/openai.js',
  'js/session/adapters/chatgpt.js',
  'js/session/adapters/groq.js',
  'js/session/adapters/cerebras.js',
  'js/session/adapters/mistral.js',
  'js/session/adapters/qwen.js',
  'js/session/adapters/deepseek.js',
  'js/session/adapters/fireworks.js',
  'js/session/adapters/xai.js',
  'js/session/adapters/xiaomi.js',
  'js/session/adapters/novita.js',
  'js/session/adapters/meta.js',
  'js/session/adapters/local.js',
  'js/session/adapters/openrouter.js',
  'js/session/adapters/image/openai.js'
]

describe('no hidden SDK retries', () => {
  for (const file of RETRY_CLIENTS) {
    test(`${file} disables SDK retries`, () => {
      const text = src(file)
      const constructions = [...text.matchAll(/new\s+(OpenAI|Anthropic|Groq|Cerebras)\s*\(/g)]
      expect(constructions.length, `${file} builds no retrying SDK`).toBeGreaterThan(0)
      for (const m of constructions) {
        const block = text.slice(m.index, m.index + 500)
        expect(block, `${file} must pass maxRetries: 0 to ${m[1]}`).toContain('maxRetries: 0')
      }
    })
  }

  test('gemini documents its asymmetry: GoogleGenAI has no retry option', () => {
    expect(src('js/session/adapters/gemini.js')).toContain('new GoogleGenAI(')
  })
})
