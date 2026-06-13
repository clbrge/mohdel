/**
 * Live adapter smoke tests — one suite per registered text adapter.
 *
 * Scope: the adapter function directly (envelope → AsyncGenerator<Event>).
 * Skips factory / bridge / client layers so a regression against an
 * upstream SDK is pinpointed to the adapter, not a bridge quirk.
 *
 * Gating: each provider's suite skips when its API key env var
 * (`<PROVIDER>_API_SK`, matching `src/lib/providers.js`) is unset.
 * `npm run test:live` with no keys runs nothing and exits clean.
 *
 * Per-provider quirks (defined in SPECS below):
 *   - `streams: false` → skip delta-count assertion + cancel test
 *     (the adapter emits a single synthetic delta in non-streaming
 *     mode, so counting is meaningless).
 *   - `truncateBudget` → outputBudget for the incomplete-status test.
 *     Defaults to 1; bumped for providers that spend tokens on
 *     reasoning before emitting content (openai, xai with Responses).
 */

import { describe, test, expect } from 'vitest'
import { adapters } from '../../js/session/adapters/index.js'
import providers from '../../src/lib/providers.js'
import { STATUS_COMPLETED, STATUS_INCOMPLETE } from '#core'

/**
 * @typedef {object} LiveSpec
 * @property {string} defaultModel         Bare model ID (no provider prefix).
 * @property {boolean} streams             Whether the adapter emits real SSE deltas.
 * @property {number} [truncateBudget]     outputBudget for the incomplete test. Default 1.
 */

/** @type {Record<string, LiveSpec>} */
const SPECS = {
  anthropic: { defaultModel: 'claude-haiku-4-5', streams: true },
  openai: { defaultModel: 'gpt-5-mini', streams: true, truncateBudget: 16 },
  gemini: { defaultModel: 'gemini-2.5-flash', streams: true },
  xai: { defaultModel: 'grok-4-1-fast-non-reasoning', streams: true, truncateBudget: 16 },
  fireworks: { defaultModel: 'accounts/fireworks/models/kimi-k2p5', streams: true },
  openrouter: { defaultModel: 'anthropic/claude-haiku-4-5', streams: true },
  cerebras: { defaultModel: 'gpt-oss-120b', streams: false },
  deepseek: { defaultModel: 'deepseek-chat', streams: false },
  groq: { defaultModel: 'llama-3.3-70b-versatile', streams: false },
  mistral: { defaultModel: 'mistral-small-latest', streams: false },
  novita: { defaultModel: 'kwaipilot/kat-coder-pro', streams: false },
  qwen: { defaultModel: 'qwen3.6-flash', streams: false, truncateBudget: 16 }
}

async function collect (iter) {
  const out = []
  for await (const v of iter) out.push(v)
  return out
}

describe('live adapter smoke', () => {
  for (const [provider, spec] of Object.entries(SPECS)) {
    const adapter = adapters[provider]
    const envVar = providers[provider]?.apiKeyEnv
    const apiKey = envVar ? process.env[envVar] : undefined
    const overrideKey = `MOHDEL_LIVE_${provider.toUpperCase()}_MODEL`
    const model = process.env[overrideKey] || spec.defaultModel
    const truncateBudget = spec.truncateBudget ?? 1

    /** @returns {import('#core/envelope.js').CallEnvelope} */
    const envelope = (overrides = {}) => ({
      callId: `live-${provider}-${Math.random().toString(36).slice(2, 10)}`,
      authId: 'live',
      auth: { key: apiKey ?? '' },
      provider,
      model,
      prompt: 'Say the single word "hi".',
      outputBudget: 20,
      ...overrides
    })

    describe.skipIf(!apiKey || !adapter)(`${provider} (${model})`, () => {
      test('happy path → completed + tokens', async () => {
        const events = await collect(adapter(envelope()))
        expect(events.every(e => e.type !== 'error')).toBe(true)
        if (spec.streams) {
          expect(events.some(e => e.type === 'delta')).toBe(true)
        }
        const done = events.at(-1)
        expect(done.type).toBe('done')
        expect(done.result.status).toBe(STATUS_COMPLETED)
        expect(done.result.inputTokens).toBeGreaterThan(0)
        expect(done.result.outputTokens).toBeGreaterThan(0)
      }, 30_000)

      test(`outputBudget=${truncateBudget} + demanding prompt → incomplete`, async () => {
        const events = await collect(adapter(envelope({
          outputBudget: truncateBudget,
          prompt: 'Write a detailed essay about tigers.'
        })))
        const done = events.at(-1)
        expect(done.type).toBe('done')
        expect(done.result.status).toBe(STATUS_INCOMPLETE)
        expect(done.result.warning).toBe('insufficientOutputBudget')
      }, 30_000)

      // Cancel mid-stream verifies AbortSignal propagation through the
      // SDK to the provider. Meaningless for non-streaming adapters
      // (single synthetic delta arrives only once the full response is
      // already in), so skip.
      test.skipIf(!spec.streams)('cancel mid-stream → warning: cancelled', async () => {
        const controller = new AbortController()
        const events = []
        for await (const ev of adapter(envelope({
          outputBudget: 500,
          prompt: 'Count slowly from 1 to 100, one number per line.'
        }), { signal: controller.signal })) {
          events.push(ev)
          if (events.filter(e => e.type === 'delta').length >= 2) {
            controller.abort()
          }
        }
        const done = events.at(-1)
        expect(done.type).toBe('done')
        expect(done.result.warning).toBe('cancelled')
      }, 30_000)
    })
  }
})
