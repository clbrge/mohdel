import { describe, test, expect } from 'vitest'
import { openai } from '../../js/session/adapters/openai.js'
import { setCatalog } from '../../js/session/adapters/_catalog.js'
import { setPricing } from '../../js/session/adapters/_pricing.js'
import { STATUS_COMPLETED, STATUS_INCOMPLETE } from '#core'

setPricing({
  'openai/gpt-5': { input: 3, output: 15 }
})

/** @returns {import('#core/envelope.js').CallEnvelope} */
function envelope (overrides = {}) {
  return {
    callId: 'c1',
    authId: 'a1',
    auth: { key: 'sk-test' },
    model: 'openai/gpt-5',
    prompt: 'hi',
    ...overrides
  }
}

async function collect (iter) {
  const out = []
  for await (const v of iter) out.push(v)
  return out
}

function makeClient ({ events = [], throws = null } = {}) {
  /** @type {any} */
  const captured = {}
  const client = {
    responses: {
      stream (request) {
        captured.request = request
        if (throws) throw throws
        return {
          async * [Symbol.asyncIterator] () {
            for (const e of events) yield e
          }
        }
      }
    }
  }
  return { client, captured }
}

describe('session/adapters/openai', () => {
  test('happy path yields delta events + completed done', async () => {
    const { client } = makeClient({
      events: [
        { type: 'response.output_text.delta', delta: 'Hello' },
        { type: 'response.output_text.delta', delta: ', world.' },
        { type: 'response.completed', response: { usage: { input_tokens: 8, output_tokens: 3 } } }
      ]
    })

    const events = await collect(openai(envelope(), { client }))
    expect(events.map(e => e.type)).toEqual(['delta', 'delta', 'done'])
    expect(events[0].delta.delta).toBe('Hello')
    expect(events[1].delta.delta).toBe(', world.')
    const done = events[2]
    expect(done.result.status).toBe(STATUS_COMPLETED)
    expect(done.result.output).toBe('Hello, world.')
    expect(done.result.inputTokens).toBe(8)
    expect(done.result.outputTokens).toBe(3)
  })

  test('response.incomplete + max_output_tokens → incomplete + warning', async () => {
    const { client } = makeClient({
      events: [
        { type: 'response.output_text.delta', delta: 'cut' },
        {
          type: 'response.incomplete',
          response: {
            incomplete_details: { reason: 'max_output_tokens' },
            usage: { input_tokens: 5, output_tokens: 1 }
          }
        }
      ]
    })
    const done = (await collect(openai(envelope(), { client }))).at(-1)
    expect(done.result.status).toBe(STATUS_INCOMPLETE)
    expect(done.result.warning).toBe('insufficientOutputBudget')
  })

  test('string prompt wraps as user input; system messages go to instructions', async () => {
    const { client, captured } = makeClient({
      events: [{ type: 'response.completed', response: { usage: {} } }]
    })
    await collect(openai(envelope({
      prompt: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'hi' }
      ]
    }), { client }))
    expect(captured.request.instructions).toBe('Be terse.')
    expect(captured.request.input).toEqual([{ role: 'user', content: 'hi' }])
  })

  test('outputBudget maps to max_output_tokens', async () => {
    const { client, captured } = makeClient({
      events: [{ type: 'response.completed', response: { usage: {} } }]
    })
    await collect(openai(envelope({ outputBudget: 512 }), { client }))
    expect(captured.request.max_output_tokens).toBe(512)
  })

  test('SDK throwing 429 yields retryable error event', async () => {
    const err = Object.assign(new Error('rate'), { status: 429 })
    const { client } = makeClient({ throws: err })
    const events = await collect(openai(envelope(), { client }))
    expect(events[0].type).toBe('error')
    expect(events[0].error.type).toBe('RATE_LIMIT')
    expect(events[0].error.retryable).toBe(true)
  })

  const preambleThenCall = [
    { type: 'response.output_text.delta', delta: 'Starting with #56.' },
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'exec' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"command":"git status"}' }
  ]

  test.each(['openai/gpt-5', 'meta/any-model', 'xai/grok-4'])('%s: a stream ending before its terminal event is a retryable error, never a done', async (model) => {
    const { client } = makeClient({ events: preambleThenCall })
    const events = await collect(openai(envelope({ model }), { client }))
    expect(events.some(e => e.type === 'done')).toBe(false)
    expect(events.at(-1).type).toBe('error')
    expect(events.at(-1).error.retryable).toBe(true)
  })

  test('response.failed is an error, never a done', async () => {
    const { client } = makeClient({
      events: [...preambleThenCall, { type: 'response.failed', response: { error: { code: 'server_error', message: 'The server had an error' } } }]
    })
    const events = await collect(openai(envelope({ model: 'meta/any-model' }), { client }))
    expect(events.some(e => e.type === 'done')).toBe(false)
    expect(events.at(-1).type).toBe('error')
  })

  test('response.failed keeps the provider code for classification', async () => {
    const { client } = makeClient({
      events: [{ type: 'response.failed', response: { error: { code: 'context_length_exceeded', message: 'too long' } } }]
    })
    const events = await collect(openai(envelope(), { client }))
    expect(events.at(-1).error.type).toBe('CONTEXT_OVERFLOW')
  })

  test('done cost is 0 for unknown model; non-zero for priced', async () => {
    {
      const { client } = makeClient({
        events: [{ type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 50 } } }]
      })
      const done = (await collect(openai(envelope({ model: 'openai/gpt-5' }), { client }))).at(-1)
      expect(done.result.cost).toBeGreaterThan(0)
    }
    {
      const { client } = makeClient({
        events: [{ type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 10 } } }]
      })
      const done = (await collect(openai(envelope({ model: 'openai/unknown-xyz' }), { client }))).at(-1)
      expect(done.result.cost).toBe(0)
    }
  })

  test('identifier maps to safety_identifier and prompt_cache_key', async () => {
    const { client, captured } = makeClient({
      events: [{ type: 'response.completed', response: { usage: {} } }]
    })
    await collect(openai(envelope({ identifier: 'u-1' }), { client }))
    expect(captured.request.safety_identifier).toBe('u-1')
    expect(captured.request.prompt_cache_key).toBe('u-1')
  })

  test('cache read + write tokens are subtracted from input and priced separately', async () => {
    setCatalog({
      'openai/gpt-5.6-luna': {
        inputPrice: 1,
        cacheReadPrice: 0.1,
        cacheWritePrice: 1.25,
        outputPrice: 6
      }
    })
    const { client } = makeClient({
      events: [{
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            input_tokens_details: { cached_tokens: 50, cache_write_tokens: 40 }
          }
        }
      }]
    })
    const done = (await collect(openai(envelope({ model: 'openai/gpt-5.6-luna' }), { client }))).at(-1)
    expect(done.result.inputTokens).toBe(10)
    expect(done.result.cacheReadInputTokens).toBe(50)
    expect(done.result.cacheWriteInputTokens).toBe(40)
    expect(done.result.outputTokens).toBe(10)
    expect(done.result.cost).toBe(0.000125)
  })
})

describe('session/adapters/openai — abort', () => {
  test('abort mid-stream → aborted done with the partial output', async () => {
    const { client } = makeClient({
      events: [
        { type: 'response.output_text.delta', delta: 'Hel' },
        { type: 'response.output_text.delta', delta: 'lo' },
        { type: 'response.output_text.delta', delta: '!' },
        { type: 'response.completed', response: { usage: { input_tokens: 8, output_tokens: 3 } } }
      ]
    })
    const controller = new AbortController()
    const events = []
    for await (const ev of openai(envelope(), { client, signal: controller.signal })) {
      events.push(ev)
      if (events.filter(e => e.type === 'delta').length === 2) controller.abort()
    }
    expect(events.map(e => e.type)).toEqual(['delta', 'delta', 'done'])
    const done = events.at(-1)
    expect(done.result.status).toBe(STATUS_INCOMPLETE)
    expect(done.result.warning).toBe('aborted')
    expect(done.result.output).toBe('Hello')
    expect(done.result.outputTokens).toBe(0)
  })

  test('SDK throwing under an aborted signal → aborted done, not an error event', async () => {
    const controller = new AbortController()
    controller.abort()
    const { client } = makeClient({ throws: new Error('Request was aborted.') })
    const events = await collect(openai(envelope(), { client, signal: controller.signal }))
    expect(events.map(e => e.type)).toEqual(['done'])
    expect(events[0].result.warning).toBe('aborted')
  })
})

describe('session/adapters/openai — reasoning carried across rounds', () => {
  const done = { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 50, output_tokens_details: { reasoning_tokens: 40 } } } }
  const thought = { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAAB-opaque' } }
  const call = [
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"city":"paris"}' }
  ]
  const recordedBy = (model) => [
    { role: 'user', content: 'weather in paris?' },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '', encrypted: 'gAAAAB-opaque', id: 'rs_1', model },
        { type: 'text', text: 'Checking.' }
      ],
      toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'paris' } }]
    },
    { role: 'tool', toolCallId: 'call_1', content: '{"temp":21}' }
  ]

  test.each(['openai/gpt-5', 'meta/any-model', 'xai/grok-4.7'])('%s: a reasoning model is asked for its reasoning back', async (model) => {
    setCatalog({ [model]: { thinkingEffortLevels: { low: 0, none: 0 } } })
    const { client, captured } = makeClient({ events: [done] })
    await collect(openai(envelope({ model }), { client }))
    expect(captured.request.include).toEqual(['reasoning.encrypted_content'])
  })

  test('a model that does not reason, or reasons at none, is not asked', async () => {
    setCatalog({ 'openai/gpt-5': { thinkingEffortLevels: { low: 0, none: 0 } } })
    const plain = makeClient({ events: [done] })
    await collect(openai(envelope({ model: 'openai/unknown-xyz' }), { client: plain.client }))
    expect(plain.captured.request.include).toBeUndefined()
    const off = makeClient({ events: [done] })
    await collect(openai(envelope({ outputEffort: 'none' }), { client: off.client }))
    expect(off.captured.request.include).toBeUndefined()
  })

  test.each(['openai/gpt-5', 'meta/any-model'])('%s: reasoning that came with a tool call returns as parts naming the model', async (model) => {
    const { client } = makeClient({ events: [thought, ...call, done] })
    const result = (await collect(openai(envelope({ model }), { client }))).at(-1).result
    expect(result.status).toBe('tool_use')
    expect(result.reasoningParts).toEqual([{ type: 'reasoning', text: '', id: 'rs_1', encrypted: 'gAAAAB-opaque', model }])
  })

  test('a reasoning item without encrypted content is not kept', async () => {
    const bare = { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_2', summary: [] } }
    const { client } = makeClient({ events: [bare, ...call, done] })
    const result = (await collect(openai(envelope({ model: 'meta/any-model' }), { client }))).at(-1).result
    expect(result.reasoningParts).toBeUndefined()
  })

  test('recorded reasoning is replayed to the model that produced it, ahead of its turn', async () => {
    const { client, captured } = makeClient({ events: [done] })
    await collect(openai(envelope({ model: 'meta/any-model', prompt: recordedBy('meta/any-model') }), { client }))
    expect(captured.request.input.map(item => item.type ?? item.role)).toEqual(['user', 'reasoning', 'message', 'function_call', 'function_call_output'])
    expect(captured.request.input[1]).toEqual({ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAAB-opaque' })
  })

  test.each(['openai/gpt-5', 'meta/another-model'])('%s never receives reasoning another model produced', async (model) => {
    const { client, captured } = makeClient({ events: [done] })
    await collect(openai(envelope({ model, prompt: recordedBy('meta/any-model') }), { client }))
    expect(captured.request.input.some(item => item.type === 'reasoning')).toBe(false)
    expect(JSON.stringify(captured.request)).not.toContain('gAAAAB-opaque')
  })
})

describe('session/adapters/openai — what the model says while it works', () => {
  const completed = { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 20 } } }
  const kinds = (events) => events.filter(e => e.type === 'delta').map(e => [e.delta.type, e.delta.delta])
  const message = (id, phase, text) => [
    { type: 'response.output_item.added', item: { type: 'message', id, role: 'assistant', content: [], ...(phase && { phase }) } },
    { type: 'response.output_text.delta', item_id: id, delta: text },
    { type: 'response.output_item.done', item: { type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text }], ...(phase && { phase }) } }
  ]

  test('a commentary message streams as commentary, stays out of the answer and comes back as a part', async () => {
    const { client } = makeClient({ events: [...message('msg_1', 'commentary', 'Checking the forecast.'), ...message('msg_2', 'final_answer', 'It is 21C.'), completed] })
    const events = await collect(openai(envelope(), { client }))
    expect(kinds(events)).toEqual([['commentary', 'Checking the forecast.'], ['message', 'It is 21C.']])
    const { result } = events.at(-1)
    expect(result.output).toBe('It is 21C.')
    expect(result.commentaryParts).toEqual([{ type: 'text', text: 'Checking the forecast.', phase: 'commentary' }])
  })

  test('a message whose phase comes only as it closes is still kept out of the answer', async () => {
    const late = [
      { type: 'response.output_item.added', item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] } },
      { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Looking.' },
      { type: 'response.output_item.done', item: { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'Looking.' }], phase: 'commentary' } }
    ]
    const { client } = makeClient({ events: [...late, ...message('msg_2', undefined, 'Done.'), completed] })
    const { result } = (await collect(openai(envelope(), { client }))).at(-1)
    expect(result.output).toBe('Done.')
    expect(result.commentaryParts).toEqual([{ type: 'text', text: 'Looking.', phase: 'commentary' }])
  })

  test('summaries stream as reasoning_summary, parts apart, and raw reasoning text as reasoning', async () => {
    const { client } = makeClient({
      events: [
        { type: 'response.reasoning_summary_part.added', item_id: 'rs_1', summary_index: 0 },
        { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', summary_index: 0, delta: '**Planning**' },
        { type: 'response.reasoning_summary_part.added', item_id: 'rs_1', summary_index: 1 },
        { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', summary_index: 1, delta: '**Checking**' },
        { type: 'response.reasoning_text.delta', item_id: 'rs_2', delta: 'raw step' },
        ...message('msg_1', 'final_answer', 'Answer.'),
        completed
      ]
    })
    const events = await collect(openai(envelope(), { client }))
    expect(kinds(events)).toEqual([
      ['reasoning_summary', '**Planning**'], ['reasoning_summary', '\n\n'], ['reasoning_summary', '**Checking**'],
      ['reasoning', 'raw step'], ['message', 'Answer.']
    ])
  })

  test('openai asks for summaries when the call wants them and the credential says its organization may', async () => {
    setCatalog({ 'openai/gpt-5': { thinkingEffortLevels: { low: 0, none: 0 } } })
    const ask = (auth) => envelope({ reasoningSummaries: true, auth: { key: 'sk-test', ...auth } })
    const unsaid = makeClient({ events: [completed] })
    await collect(openai(ask({}), { client: unsaid.client }))
    expect(unsaid.captured.request.reasoning).toEqual({ effort: 'low' })
    const asked = makeClient({ events: [completed] })
    await collect(openai(ask({ summaries: true }), { client: asked.client }))
    expect(asked.captured.request.reasoning).toEqual({ effort: 'low', summary: 'auto' })
    const unwanted = makeClient({ events: [completed] })
    await collect(openai(envelope({ auth: { key: 'sk-test', summaries: true } }), { client: unwanted.client }))
    expect(unwanted.captured.request.reasoning).toEqual({ effort: 'low' })
    const off = makeClient({ events: [completed] })
    await collect(openai(ask({ summaries: false }), { client: off.client }))
    expect(off.captured.request.reasoning).toEqual({ effort: 'low' })
    const none = makeClient({ events: [completed] })
    await collect(openai(envelope({ reasoningSummaries: true, outputEffort: 'none' }), { client: none.client }))
    expect(none.captured.request.reasoning).toEqual({ effort: 'none' })
  })

  test('a request refused over summaries says which setting stops asking for them', async () => {
    const refused = Object.assign(new Error('Your organization must be verified to generate reasoning summaries.'), { status: 400, param: 'reasoning.summary', code: 'unsupported_value' })
    const { client } = makeClient({ throws: refused })
    const [event] = await collect(openai(envelope(), { client }))
    expect(event.type).toBe('error')
    expect(event.error).toMatchObject({ type: 'SUMMARIES_REFUSED', retryable: false })
    expect(event.error.detail).toMatch(/reasoningSummaries: false for openai in providers.json/)
  })

  test('commentary goes back as messages with their phase, and the answer beside it as the final one', async () => {
    const { client, captured } = makeClient({ events: [completed] })
    await collect(openai(envelope({
      prompt: [
        { role: 'user', content: 'weather in paris?' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Checking the forecast.', phase: 'commentary' }, { type: 'text', text: '' }],
          toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'paris' } }]
        },
        { role: 'tool', toolCallId: 'call_1', content: '{"temp":21}' },
        { role: 'assistant', content: [{ type: 'text', text: 'Noting it.', phase: 'commentary' }, { type: 'text', text: 'It is 21C.' }] },
        { role: 'user', content: 'thanks' }
      ]
    }), { client }))
    const assistant = captured.request.input.filter(item => item.type === 'message')
    expect(assistant).toEqual([
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking the forecast.' }], phase: 'commentary' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Noting it.' }], phase: 'commentary' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'It is 21C.' }], phase: 'final_answer' }
    ])
  })
})
