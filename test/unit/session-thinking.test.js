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

    expect(captured.request.thinking).toEqual({ type: 'adaptive', display: 'omitted' })
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
    expect(captured.request.thinking).toEqual({ type: 'adaptive', display: 'omitted' })
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

  test('summarized thinking streams as reasoning_summary, and its length does not count as thinking', async () => {
    const { client } = mockAnthropic([
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'a'.repeat(80) } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Answer' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 26 } }
    ])

    const events = await collect(anthropic(envelope('anthropic', 'claude-opus-4-6'), { client }))
    const done = events.at(-1)
    expect(done.result.thinkingTokens).toBe(24)
    expect(done.result.outputTokens).toBe(2)
    expect(events.filter(e => e.type === 'delta').map(e => [e.delta.type, e.delta.delta])).toEqual([
      ['reasoning_summary', 'a'.repeat(80)], ['message', 'Answer']
    ])
  })

  test('redacted thinking: gap between output_tokens and streamed estimates thinking', async () => {
    // Mirrors opus 4.7 default behaviour — thinking happens via redacted
    // blocks that consume output tokens but emit no thinking_delta events.
    const { client } = mockAnthropic([
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      // 8 chars streamed → 2 tokens at 4 chars/token
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Answer..' } },
      // Anthropic reports total output_tokens of 50 — gap (50 − 2 = 48) is non-streamed thinking
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } }
    ])

    const done = (await collect(anthropic(envelope('anthropic', 'claude-opus-4-6'), { client }))).at(-1)
    expect(done.result.thinkingTokens).toBe(48)
    expect(done.result.outputTokens).toBe(2)
  })

  test('outputEffort=none short-circuits the gap fallback to zero thinking', async () => {
    // When the caller explicitly disabled thinking, buildRequest sends no
    // `thinking` field. Anthropic emits no thinking_delta and no
    // redacted_thinking blocks. The natural chars/4 estimation gap on
    // streamed text would otherwise falsely attribute tokens to thinking;
    // the explicit opt-out trumps the fallback.
    const { client } = mockAnthropic([
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      // 92 streamed chars → 23 tokens at chars/4. Real Anthropic count is
      // denser (85 tokens) — the gap (62) would be misread as thinking.
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x'.repeat(92) } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 85 } }
    ])

    const done = (await collect(anthropic(envelope('anthropic', 'claude-opus-4-6', {
      outputEffort: 'none'
    }), { client }))).at(-1)
    expect(done.result.thinkingTokens).toBe(0)
    expect(done.result.outputTokens).toBe(85)
  })

  test('tool input JSON counts as streamed output (not thinking) in gap fallback', async () => {
    // Without this, a tool-only call where Anthropic streams 200 chars of
    // input_json_delta and reports output_tokens=50 would falsely attribute
    // ~50 tokens to thinking instead of zero.
    const { client } = mockAnthropic([
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'fn' } },
      // 200 chars of tool input JSON → 50 tokens at 4 chars/token
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'x'.repeat(200) } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 50 } }
    ])

    const done = (await collect(anthropic(envelope('anthropic', 'claude-opus-4-6'), { client }))).at(-1)
    expect(done.result.thinkingTokens).toBe(0)
    expect(done.result.outputTokens).toBe(50)
  })
})

// ---------- OpenAI ----------

function mockOpenAI (events) {
  /** @type {any} */
  const captured = {}
  return {
    client: {
      responses: {
        create (req) {
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

  test('outputEffort=none disables thinking when catalog does not declare none', async () => {
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

  test('outputEffort=none forwards reasoning.effort=none when catalog declares it (gpt-5.4)', async () => {
    setCatalog({
      'openai/gpt-5.4': {
        inputPrice: 2.5,
        outputPrice: 20,
        thinkingEffortLevels: { none: 0, low: 300, medium: 600, high: 1000 },
        defaultThinkingEffort: 'low'
      }
    })
    const { client, captured } = mockOpenAI([
      { type: 'response.completed', response: { usage: {} } }
    ])
    await collect(openai(envelope('openai', 'gpt-5.4', {
      outputEffort: 'none',
      outputBudget: 1000
    }), { client }))
    expect(captured.request.reasoning).toEqual({ effort: 'none' })
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
      'gemini/gemini-4-argon': {
        inputPrice: 2,
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

  test('gemini-3.x uses thinkingLevel string, and asks for its thoughts only when the call wants summaries', async () => {
    const { client, captured } = mockGemini([
      { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }
    ])
    await collect(gemini(envelope('gemini', 'gemini-3-pro', { outputEffort: 'high' }), { client }))
    expect(captured.request.config.thinkingConfig).toEqual({ thinkingLevel: 'high' })
    const asked = mockGemini([
      { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }
    ])
    await collect(gemini(envelope('gemini', 'gemini-3-pro', { outputEffort: 'high', reasoningSummaries: true }), { client: asked.client }))
    expect(asked.captured.request.config.thinkingConfig).toEqual({ thinkingLevel: 'high', includeThoughts: true })
  })

  test('gemini-4 uses thinkingLevel string and leaves maxOutputTokens alone', async () => {
    const { client, captured } = mockGemini([
      { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }
    ])
    await collect(gemini(envelope('gemini', 'gemini-4-argon', { outputEffort: 'low', outputBudget: 4000 }), { client }))
    expect(captured.request.config.thinkingConfig).toEqual({ thinkingLevel: 'low' })
    expect(captured.request.config.maxOutputTokens).toBe(4000)
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

describe('anthropic: summarized thinking, and its thinking sent back', () => {
  const model = 'anthropic/claude-opus-5-5'
  beforeEach(() => setCatalog({
    [model]: { thinkingEffortLevels: { high: 0 }, defaultThinkingEffort: 'high', outputTokenLimit: 64000 },
    'anthropic/claude-haiku-4-5': { thinkingEffortLevels: { high: 0 }, defaultThinkingEffort: 'high', outputTokenLimit: 64000 }
  }))
  afterEach(() => setCatalog({}))

  function clients (events) {
    /** @type {any} */
    const captured = {}
    const stream = (req) => {
      captured.request = req
      return { async * [Symbol.asyncIterator] () { for (const e of events) yield e } }
    }
    return { client: { messages: { stream } }, captured }
  }

  const block = (index, content, ...deltas) => [
    { type: 'content_block_start', index, content_block: content },
    ...deltas.map(delta => ({ type: 'content_block_delta', index, delta })),
    { type: 'content_block_stop', index }
  ]
  const toolTurn = (note) => [
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    ...block(0, { type: 'thinking', thinking: '', signature: '' }, { type: 'thinking_delta', thinking: '' }, { type: 'signature_delta', signature: 's0' }),
    ...block(1, { type: 'thinking', thinking: '', signature: '' }, { type: 'thinking_delta', thinking: note }, { type: 'signature_delta', signature: 's1' }),
    ...block(2, { type: 'tool_use', id: 'toolu_1', name: 'edit_file', input: {} }, { type: 'input_json_delta', partial_json: '{"path":"auth.py"}' }),
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 50, output_tokens_details: { thinking_tokens: 40 } } }
  ]
  const kinds = (events) => events.filter(e => e.type === 'delta').map(e => [e.delta.type, e.delta.delta])

  test('a call that asks for summaries gets summarized thinking, a progress note streamed like the rest, its thinking counted as reported, its blocks kept to send back', async () => {
    const quiet = clients([])
    await collect(anthropic(envelope('anthropic', 'claude-opus-5-5'), { client: quiet.client }))
    expect(quiet.captured.request.thinking).toEqual({ type: 'adaptive', display: 'omitted' })
    const { client, captured } = clients(toolTurn('Confirmed the retry never refreshes the token. Editing auth.py.'))
    const events = await collect(anthropic(envelope('anthropic', 'claude-opus-5-5', { reasoningSummaries: true }), { client }))
    expect(captured.request.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(kinds(events)).toEqual([
      ['reasoning_summary', 'Confirmed the retry never refreshes the token. Editing auth.py.'],
      ['function_call', '{"path":"auth.py"}']
    ])
    const { result } = events.at(-1)
    expect(result.thinkingTokens).toBe(40)
    expect(result.outputTokens).toBe(10)
    expect(result.reasoningParts).toHaveLength(1)
    expect(result.reasoningParts[0].model).toBe(model)
    expect(JSON.parse(result.reasoningParts[0].encrypted)).toEqual([
      { type: 'thinking', thinking: '', signature: 's0' },
      { type: 'thinking', thinking: 'Confirmed the retry never refreshes the token. Editing auth.py.', signature: 's1' },
      { type: 'tool_use', id: 'toolu_1', name: 'edit_file', input: { path: 'auth.py' } }
    ])
  })

  test('summarized thinking streams as reasoning_summary', async () => {
    const { client } = clients([
      ...block(0, { type: 'thinking', thinking: '', signature: '' }, { type: 'thinking_delta', thinking: 'Weighing ' }, { type: 'thinking_delta', thinking: 'two fixes.' }, { type: 'signature_delta', signature: 's0' }),
      ...block(1, { type: 'text', text: '' }, { type: 'text_delta', text: 'Fix A.' }),
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 30 } }
    ])
    const events = await collect(anthropic(envelope('anthropic', 'claude-opus-5-5'), { client }))
    expect(kinds(events)).toEqual([['reasoning_summary', 'Weighing '], ['reasoning_summary', 'two fixes.'], ['message', 'Fix A.']])
  })

  test('a turn goes back to the model that produced it as its blocks came, and to another without its thinking', async () => {
    const turn = [
      { type: 'thinking', thinking: '', signature: 's0' },
      { type: 'thinking', thinking: 'Editing auth.py.', signature: 's1' },
      { type: 'tool_use', id: 'toolu_1', name: 'edit_file', input: { path: 'auth.py' } }
    ]
    const prompt = [
      { role: 'user', content: 'fix the retry' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '', encrypted: JSON.stringify(turn), model },
          { type: 'text', text: 'Editing auth.py.', phase: 'commentary' },
          { type: 'text', text: '' }
        ],
        toolCalls: [{ id: 'toolu_1', name: 'edit_file', arguments: { path: 'auth.py' } }]
      },
      { role: 'tool', toolCallId: 'toolu_1', content: 'ok' }
    ]
    const same = clients([])
    await collect(anthropic(envelope('anthropic', 'claude-opus-5-5', { prompt }), { client: same.client }))
    expect(same.captured.request.messages[1]).toEqual({ role: 'assistant', content: turn })
    const other = clients([])
    await collect(anthropic(envelope('anthropic', 'claude-haiku-4-5', { prompt }), { client: other.client }))
    expect(other.captured.request.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'edit_file', input: { path: 'auth.py' } }]
    })
  })

  test('a cache breakpoint that falls on a thinking block moves to the block before it', async () => {
    const turn = [
      ...Array.from({ length: 14 }, (_, i) => ({ type: 'text', text: `part ${i}` })),
      { type: 'thinking', thinking: '', signature: 's' },
      { type: 'tool_use', id: 'toolu_1', name: 'look', input: {} }
    ]
    const prompt = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'reasoning', text: '', encrypted: JSON.stringify(turn), model }], toolCalls: [{ id: 'toolu_1', name: 'look', arguments: {} }] },
      { role: 'tool', toolCallId: 'toolu_1', content: [{ type: 'text', text: 'seen', cache: '5m' }] }
    ]
    const { client, captured } = clients([])
    await collect(anthropic(envelope('anthropic', 'claude-opus-5-5', { prompt }), { client }))
    const blocks = captured.request.messages[1].content
    expect(blocks[14].type).toBe('thinking')
    expect(blocks[14].cache_control).toBeUndefined()
    expect(blocks[13].cache_control).toEqual({ type: 'ephemeral' })
  })
})
