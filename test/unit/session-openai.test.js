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
