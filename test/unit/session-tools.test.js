import { describe, test, expect } from 'vitest'
import { anthropic } from '../../js/session/adapters/anthropic.js'
import { openai } from '../../js/session/adapters/openai.js'
import { gemini } from '../../js/session/adapters/gemini.js'
import { STATUS_TOOL_USE } from '#core'

/** @returns {import('#core/envelope.js').CallEnvelope} */
function envelope (provider, model, overrides = {}) {
  return {
    callId: 'c1',
    authId: 'a1',
    auth: { key: 'k' },
    provider,
    model,
    prompt: 'What is the weather in Paris?',
    tools: [{
      name: 'get_weather',
      description: 'get current weather',
      parameters: {
        type: 'object',
        properties: { location: { type: 'string' } },
        required: ['location']
      }
    }],
    toolChoice: 'auto',
    ...overrides
  }
}

async function collect (iter) {
  const out = []
  for await (const v of iter) out.push(v)
  return out
}

// ---------- Anthropic ----------

function mockAnthropic (events, opts = {}) {
  /** @type {any} */
  const captured = {}
  return {
    client: {
      messages: {
        stream (req) {
          captured.request = req
          if (opts.throws) throw opts.throws
          return {
            async * [Symbol.asyncIterator] () { for (const e of events) yield e }
          }
        }
      }
    },
    captured
  }
}

describe('anthropic tool round-trip', () => {
  test('tools converted to input_schema on request', async () => {
    const { client, captured } = mockAnthropic([
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
    ])
    await collect(anthropic(envelope('anthropic', 'claude-sonnet-4-5'), { client }))

    expect(captured.request.tools).toEqual([{
      name: 'get_weather',
      description: 'get current weather',
      input_schema: {
        type: 'object',
        properties: { location: { type: 'string' } },
        required: ['location']
      }
    }])
    expect(captured.request.tool_choice).toEqual({ type: 'auto' })
  })

  test('parallelToolCalls=false sets disable_parallel_tool_use', async () => {
    const { client, captured } = mockAnthropic([
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
    ])
    await collect(anthropic(envelope('anthropic', 'claude-sonnet-4-5', {
      parallelToolCalls: false,
      toolChoice: 'required'
    }), { client }))
    expect(captured.request.tool_choice).toMatchObject({
      type: 'any',
      disable_parallel_tool_use: true
    })
  })

  test('streaming tool_use emits function_call deltas and tool_use done', async () => {
    const { client } = mockAnthropic([
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_abc', name: 'get_weather', input: {} }
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"location":"' }
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: 'Paris"}' }
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }
    ])

    const events = await collect(anthropic(envelope('anthropic', 'claude-sonnet-4-5'), { client }))

    // Two function_call deltas
    const deltas = events.filter(e => e.type === 'delta')
    expect(deltas).toHaveLength(2)
    expect(deltas[0].delta.type).toBe('function_call')
    expect(deltas[0].delta.delta).toBe('{"location":"')
    expect(deltas[1].delta.delta).toBe('Paris"}')

    // Terminal done with tool_use and parsed toolCalls
    const done = events.at(-1)
    expect(done.type).toBe('done')
    expect(done.result.status).toBe(STATUS_TOOL_USE)
    expect(done.result.toolCalls).toEqual([{
      id: 'toolu_abc',
      name: 'get_weather',
      arguments: { location: 'Paris' }
    }])
  })

  test('tool-result message converts to user+tool_result content block', async () => {
    const { client, captured } = mockAnthropic([
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
    ])

    await collect(anthropic({
      callId: 'c1',
      authId: 'a1',
      auth: { key: 'k' },
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      prompt: [
        { role: 'user', content: 'weather in Paris?' },
        { role: 'assistant', content: '' },
        { role: 'tool', toolCallId: 'toolu_abc', content: 'sunny, 22C' }
      ]
    }, { client }))

    expect(captured.request.messages).toContainEqual({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_abc',
        content: 'sunny, 22C'
      }]
    })
  })
})

// ---------- OpenAI ----------

function mockOpenAI (events, opts = {}) {
  /** @type {any} */
  const captured = {}
  return {
    client: {
      responses: {
        stream (req) {
          captured.request = req
          if (opts.throws) throw opts.throws
          return {
            async * [Symbol.asyncIterator] () { for (const e of events) yield e }
          }
        }
      }
    },
    captured
  }
}

describe('openai tool round-trip', () => {
  test('tools converted to OpenAI function format', async () => {
    const { client, captured } = mockOpenAI([
      { type: 'response.completed', response: { usage: {} } }
    ])
    await collect(openai(envelope('openai', 'gpt-5'), { client }))

    expect(captured.request.tools).toEqual([{
      type: 'function',
      name: 'get_weather',
      description: 'get current weather',
      parameters: expect.any(Object)
    }])
    expect(captured.request.tool_choice).toBe('auto')
  })

  test('parallelToolCalls=false sets parallel_tool_calls on request', async () => {
    const { client, captured } = mockOpenAI([
      { type: 'response.completed', response: { usage: {} } }
    ])
    await collect(openai(envelope('openai', 'gpt-5', { parallelToolCalls: false }), { client }))
    expect(captured.request.parallel_tool_calls).toBe(false)
  })

  test('streaming function_call args emit deltas and tool_use done', async () => {
    const { client } = mockOpenAI([
      { type: 'response.created' },
      {
        type: 'response.output_item.added',
        item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'get_weather' }
      },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"location":"' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: 'Paris"}' },
      {
        type: 'response.completed',
        response: { usage: { input_tokens: 8, output_tokens: 5 } }
      }
    ])

    const events = await collect(openai(envelope('openai', 'gpt-5'), { client }))

    const deltas = events.filter(e => e.type === 'delta')
    expect(deltas).toHaveLength(2)
    expect(deltas[0].delta.type).toBe('function_call')
    expect(deltas[0].delta.delta).toBe('{"location":"')

    const done = events.at(-1)
    expect(done.result.status).toBe(STATUS_TOOL_USE)
    expect(done.result.toolCalls).toEqual([{
      id: 'call_1',
      name: 'get_weather',
      arguments: { location: 'Paris' }
    }])
  })

  test('tool-result message converts to function_call_output input item', async () => {
    const { client, captured } = mockOpenAI([
      { type: 'response.completed', response: { usage: {} } }
    ])

    await collect(openai({
      callId: 'c1',
      authId: 'a1',
      auth: { key: 'k' },
      provider: 'openai',
      model: 'gpt-5',
      prompt: [
        { role: 'user', content: 'weather?' },
        { role: 'tool', toolCallId: 'call_1', content: 'sunny, 22C' }
      ]
    }, { client }))

    expect(captured.request.input).toContainEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: 'sunny, 22C'
    })
  })
})

// ---------- Gemini ----------

function mockGemini (chunks, opts = {}) {
  /** @type {any} */
  const captured = {}
  return {
    client: {
      models: {
        generateContentStream (req) {
          captured.request = req
          if (opts.throws) throw opts.throws
          return (async function * () { for (const c of chunks) yield c })()
        }
      }
    },
    captured
  }
}

describe('gemini tool round-trip', () => {
  test('tools converted to functionDeclarations in config', async () => {
    const { client, captured } = mockGemini([
      { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }
    ])
    await collect(gemini(envelope('gemini', 'gemini-2.5-flash'), { client }))

    expect(captured.request.config.tools).toEqual([{
      functionDeclarations: [{
        name: 'get_weather',
        description: 'get current weather',
        parameters: expect.any(Object)
      }]
    }])
    expect(captured.request.config.toolConfig).toEqual({
      functionCallingConfig: { mode: 'AUTO' }
    })
  })

  test('functionCall part emits delta and populates toolCalls', async () => {
    const { client } = mockGemini([
      {
        candidates: [{
          content: {
            parts: [{
              functionCall: { name: 'get_weather', args: { location: 'Paris' } }
            }]
          }
        }]
      },
      {
        candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
      }
    ])

    const events = await collect(gemini(envelope('gemini', 'gemini-2.5-flash'), { client }))

    const deltas = events.filter(e => e.type === 'delta')
    expect(deltas).toHaveLength(1)
    expect(deltas[0].delta.type).toBe('function_call')
    expect(JSON.parse(deltas[0].delta.delta)).toEqual({ location: 'Paris' })

    const done = events.at(-1)
    expect(done.result.status).toBe(STATUS_TOOL_USE)
    expect(done.result.toolCalls).toHaveLength(1)
    expect(done.result.toolCalls[0]).toMatchObject({
      name: 'get_weather',
      arguments: { location: 'Paris' }
    })
    // Gemini-generated id (no provider id)
    expect(done.result.toolCalls[0].id).toMatch(/^gemini_call_/)
  })

  test('tool-result message converts to functionResponse part', async () => {
    const { client, captured } = mockGemini([
      { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }
    ])

    await collect(gemini({
      callId: 'c1',
      authId: 'a1',
      auth: { key: 'k' },
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      prompt: [
        { role: 'user', content: 'weather?' },
        { role: 'tool', toolName: 'get_weather', content: '{"temp":22,"condition":"sunny"}' }
      ]
    }, { client }))

    const toolContent = captured.request.contents.find(c =>
      c.parts.some(p => p.functionResponse)
    )
    expect(toolContent.parts[0]).toEqual({
      functionResponse: {
        name: 'get_weather',
        response: { temp: 22, condition: 'sunny' }
      }
    })
  })
})
