import { describe, test, expect } from 'vitest'
import { anthropic } from '../../js/session/adapters/anthropic.js'
import { setPricing } from '../../js/session/adapters/_pricing.js'
import { STATUS_COMPLETED, STATUS_INCOMPLETE } from '#core'

setPricing({
  'anthropic/claude-sonnet-4-5': { input: 3, output: 15 }
})

/** @returns {import('#core/envelope.js').CallEnvelope} */
function envelope (overrides = {}) {
  return {
    callId: 'c1',
    authId: 'a1',
    auth: { key: 'sk-ant-test' },
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
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
    messages: {
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

describe('session/adapters/anthropic', () => {
  test('happy path yields delta events + completed done', async () => {
    const { client } = makeClient({
      events: [
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: ' there' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }
      ]
    })

    const events = await collect(anthropic(envelope(), { client }))
    expect(events.map(e => e.type)).toEqual(['delta', 'delta', 'done'])
    expect(events[0].delta).toEqual({ type: 'message', delta: 'Hi' })
    expect(events[1].delta).toEqual({ type: 'message', delta: ' there' })
    const done = events[2]
    expect(done.result.status).toBe(STATUS_COMPLETED)
    expect(done.result.output).toBe('Hi there')
    expect(done.result.inputTokens).toBe(10)
    expect(done.result.outputTokens).toBe(2)
    expect(done.result.warning).toBeUndefined()
  })

  test('max_tokens truncation produces incomplete + warning', async () => {
    const { client } = makeClient({
      events: [
        { type: 'message_start', message: { usage: { input_tokens: 5 } } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Cut' } },
        { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 1 } }
      ]
    })

    const events = await collect(anthropic(envelope(), { client }))
    const done = events.at(-1)
    expect(done.result.status).toBe(STATUS_INCOMPLETE)
    expect(done.result.warning).toBe('insufficientOutputBudget')
  })

  test('string prompt becomes user message; system-only messages go to top-level', async () => {
    const { client, captured } = makeClient({
      events: [{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }]
    })
    await collect(anthropic(envelope({
      prompt: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'hi' }
      ]
    }), { client }))

    expect(captured.request.system).toBe('Be terse.')
    expect(captured.request.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  test('outputBudget maps to Anthropic max_tokens', async () => {
    const { client, captured } = makeClient({
      events: [{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }]
    })
    await collect(anthropic(envelope({ outputBudget: 512 }), { client }))
    expect(captured.request.max_tokens).toBe(512)
  })

  test('SDK throwing 401 yields error event', async () => {
    const err = Object.assign(new Error('nope'), { status: 401 })
    const { client } = makeClient({ throws: err })
    const events = await collect(anthropic(envelope(), { client }))
    expect(events.length).toBe(1)
    expect(events[0].type).toBe('error')
    expect(events[0].error.type).toBe('AUTH_INVALID')
  })

  test('done includes non-zero cost for a priced model', async () => {
    const { client } = makeClient({
      events: [
        { type: 'message_start', message: { usage: { input_tokens: 100 } } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } }
      ]
    })
    const events = await collect(anthropic(envelope({ model: 'claude-sonnet-4-5' }), { client }))
    const done = events.at(-1)
    expect(done.result.cost).toBeGreaterThan(0)
  })

  test('done cost is 0 for unknown model', async () => {
    const { client } = makeClient({
      events: [{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } }]
    })
    const events = await collect(anthropic(envelope({ model: 'unknown-xyz' }), { client }))
    expect(events.at(-1).result.cost).toBe(0)
  })
})
