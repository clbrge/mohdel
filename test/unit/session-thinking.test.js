import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { anthropic } from '../../js/session/adapters/anthropic.js'
import { openai } from '../../js/session/adapters/openai.js'
import { gemini } from '../../js/session/adapters/gemini.js'
import { setCatalog } from '../../js/session/adapters/_catalog.js'

/** @returns {import('#core/envelope.js').CallEnvelope} */
function envelope (provider, bare, overrides = {}) {
  return {
    callId: 'c1',
    authId: 'a1',
    auth: { key: 'k' },
    model: `${provider}/${bare}`,
    prompt: 'Solve this.',
    ...overrides
  }
}

async function collect (iter) {
  const out = []
  for await (const v of iter) out.push(v)
  return out
}

// ---------- Anthropic ----------

function mockAnthropic (events) {
  /** @type {any} */
  const captured = {}
  return {
    client: {
      messages: {
        stream (req) {
          captured.request = req
          return {
            async * [Symbol.asyncIterator] () { for (const e of events) yield e }
          }
        }
      }
    },
    captured
  }
}

describe('anthropic thinking config', () => {
  beforeEach(() => {
    setCatalog({
      'anthropic/claude-opus-4-6': {
        inputPrice: 15,
        outputPrice: 75,
        thinkingPrice: 75,
        outputTokenLimit: 64000,
        thinkingEffortLevels: { minimal: 2048, low: 8192, medium: 16384, high: 32768, max: 65536 },
        defaultThinkingEffort: 'medium'
      },
      'anthropic/no-thinking': { inputPrice: 1, outputPrice: 5, outputTokenLimit: 4096 }
    })
  })

  afterEach(() => setCatalog({}))

  test('spec with thinkingEffortLevels enables adaptive thinking with effort', async () => {
    const { client, captured } = mockAnthropic([
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
    ])
    await collect(anthropic(envelope('anthropic', 'claude-opus-4-6', {
      outputEffort: 'high',
      outputBudget: 1024
    }), { client }))

    expect(captured.request.thinking).toEqual({ type: 'adaptive' })
    expect(captured.request.output_config).toEqual({ effort: 'high' })
    // Thinking ignores user outputBudget — uses spec.outputTokenLimit
    expect(captured.request.max_tokens).toBe(64000)
  })

  test('default effort applied when envelope omits outputEffort', async () => {
    const { client, captured } = mockAnthropic([
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
    ])
    await collect(anthropic(envelope('anthropic', 'claude-opus-4-6'), { client }))

    expect(captured.request.output_config).toEqual({ effort: 'medium' })
  })

  test('unknown effort key is ignored — adaptive without output_config', async () => {
    const { client, captured } = mockAnthropic([
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
    ])
    await collect(anthropic(envelope('anthropic', 'claude-opus-4-6', {
      outputEffort: 'mythical'
    }), { client }))
    expect(captured.request.thinking).toEqual({ type: 'adaptive' })
    expect(captured.request.output_config).toBeUndefined()
  })

  test('non-thinking model: no thinking config applied', async () => {
    const { client, captured } = mockAnthropic([
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
    ])
    await collect(anthropic(envelope('anthropic', 'no-thinking', {
      outputEffort: 'high'
    }), { client }))
    expect(captured.request.thinking).toBeUndefined()
  })

  test('outputEffort=none opts out of thinking and preserves outputBudget', async () => {
    const { client, captured } = mockAnthropic([
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
    ])
    await collect(anthropic(envelope('anthropic', 'claude-opus-4-6', {
      outputEffort: 'none',
      outputBudget: 1024
    }), { client }))

    // No thinking: adapter must not set any thinking config.
    expect(captured.request.thinking).toBeUndefined()
    expect(captured.request.output_config).toBeUndefined()
    // Caller's outputBudget is respected (not clobbered by outputTokenLimit).
    expect(captured.request.max_tokens).toBe(1024)
  })

  test('thinking_delta events estimate thinkingTokens (no message tokens emitted)', async () => {
    const { client } = mockAnthropic([
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      // 80 chars of "thinking" → ~20 tokens at 4 chars/token
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'a'.repeat(80) } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Answer' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 26 } }
    ])

    const events = await collect(anthropic(envelope('anthropic', 'claude-opus-4-6'), { client }))
    const done = events.at(-1)
    expect(done.result.thinkingTokens).toBe(20)
    // outputTokens = total reported (26) minus thinking estimate (20) = 6
    expect(done.result.outputTokens).toBe(6)
    // No `delta` event was yielded for thinking content
    const messageDeltas = events.filter(e =>
      e.type === 'delta' && e.delta.type === 'message'
    )
    expect(messageDeltas).toHaveLength(1)
    expect(messageDeltas[0].delta.delta).toBe('Answer')
  })
})

// ---------- OpenAI ----------

function mockOpenAI (events) {
  /** @type {any} */
  const captured = {}
  return {
    client: {
      responses: {
        stream (req) {
          captured.request = req
          return {
            async * [Symbol.asyncIterator] () { for (const e of events) yield e }
          }
        }
      }
    },
    captured
  }
}

describe('openai thinking config', () => {
  beforeEach(() => {
    setCatalog({
      'openai/gpt-5': {
        inputPrice: 3,
        outputPrice: 15,
        thinkingEffortLevels: { low: 1024, medium: 4096, high: 16384 },
        defaultThinkingEffort: 'low'
      }
    })
  })

  afterEach(() => setCatalog({}))

  test('reasoning.effort set with envelope outputEffort', async () => {
    const { client, captured } = mockOpenAI([
      { type: 'response.completed', response: { usage: {} } }
    ])
    await collect(openai(envelope('openai', 'gpt-5', {
      outputEffort: 'high',
      outputBudget: 1000
    }), { client }))

    expect(captured.request.reasoning).toEqual({ effort: 'high' })
    // max_output_tokens gets thinking headroom: 1000 + 16384 = 17384
    expect(captured.request.max_output_tokens).toBe(17384)
  })

  test('default effort applied when omitted', async () => {
    const { client, captured } = mockOpenAI([
      { type: 'response.completed', response: { usage: {} } }
    ])
    await collect(openai(envelope('openai', 'gpt-5', { outputBudget: 1000 }), { client }))
    expect(captured.request.reasoning).toEqual({ effort: 'low' })
    expect(captured.request.max_output_tokens).toBe(2024)
  })

  test('outputEffort=none disables thinking', async () => {
    const { client, captured } = mockOpenAI([
      { type: 'response.completed', response: { usage: {} } }
    ])
    await collect(openai(envelope('openai', 'gpt-5', {
      outputEffort: 'none',
      outputBudget: 1000
    }), { client }))
    expect(captured.request.reasoning).toBeUndefined()
    expect(captured.request.max_output_tokens).toBe(1000)
  })

  test('reasoning_tokens splits from output_tokens in usage', async () => {
    const { client } = mockOpenAI([
      { type: 'response.output_text.delta', delta: 'final' },
      {
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 10,
            output_tokens: 50,
            output_tokens_details: { reasoning_tokens: 30 }
          }
        }
      }
    ])
    const done = (await collect(openai(envelope('openai', 'gpt-5'), { client }))).at(-1)
    expect(done.result.thinkingTokens).toBe(30)
    expect(done.result.outputTokens).toBe(20)
  })

  test('outputType=json sets text.format', async () => {
    const { client, captured } = mockOpenAI([
      { type: 'response.completed', response: { usage: {} } }
    ])
    await collect(openai(envelope('openai', 'gpt-5', { outputType: 'json' }), { client }))
    expect(captured.request.text.format).toEqual({ type: 'json_object' })
  })
})

// ---------- Gemini ----------

function mockGemini (chunks) {
  /** @type {any} */
  const captured = {}
  return {
    client: {
      models: {
        generateContentStream (req) {
          captured.request = req
          return (async function * () { for (const c of chunks) yield c })()
        }
      }
    },
    captured
  }
}

describe('gemini thinking config', () => {
  beforeEach(() => {
    setCatalog({
      'gemini/gemini-3-pro': {
        inputPrice: 1.25,
        outputPrice: 10,
        thinkingEffortLevels: { low: 1024, medium: 8192, high: 32768 },
        defaultThinkingEffort: 'medium'
      },
      'gemini/gemini-2.5-flash': {
        inputPrice: 0.075,
        outputPrice: 0.3,
        thinkingEffortLevels: { low: 1024, medium: 4096, high: 16384 },
        defaultThinkingEffort: 'low'
      }
    })
  })

  afterEach(() => setCatalog({}))

  test('gemini-3.x uses thinkingLevel string', async () => {
    const { client, captured } = mockGemini([
      { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }
    ])
    await collect(gemini(envelope('gemini', 'gemini-3-pro', { outputEffort: 'high' }), { client }))
    expect(captured.request.config.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: 'high'
    })
  })

  test('gemini-2.x uses thinkingBudget number', async () => {
    const { client, captured } = mockGemini([
      { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }
    ])
    await collect(gemini(envelope('gemini', 'gemini-2.5-flash', { outputEffort: 'medium' }), { client }))
    expect(captured.request.config.thinkingConfig).toEqual({ thinkingBudget: 4096 })
  })

  test('thoughtsTokenCount in usage is reported as thinkingTokens', async () => {
    const { client } = mockGemini([
      {
        candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 20,
          thoughtsTokenCount: 200
        }
      }
    ])
    const done = (await collect(gemini(envelope('gemini', 'gemini-3-pro'), { client }))).at(-1)
    expect(done.result.thinkingTokens).toBe(200)
    expect(done.result.outputTokens).toBe(20)
  })
})
