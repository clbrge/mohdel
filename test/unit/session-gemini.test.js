import { describe, test, expect } from 'vitest'
import { gemini } from '../../js/session/adapters/gemini.js'
import { setPricing } from '../../js/session/adapters/_pricing.js'
import { STATUS_COMPLETED, STATUS_INCOMPLETE } from '#core'

setPricing({
  'gemini/gemini-2.5-flash': { input: 0.075, output: 0.3 }
})

/** @returns {import('#core/envelope.js').CallEnvelope} */
function envelope (overrides = {}) {
  return {
    callId: 'c1',
    authId: 'a1',
    auth: { key: 'AI-test' },
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    prompt: 'hi',
    ...overrides
  }
}

async function collect (iter) {
  const out = []
  for await (const v of iter) out.push(v)
  return out
}

function makeClient ({ chunks = [], throws = null } = {}) {
  /** @type {any} */
  const captured = {}
  const client = {
    models: {
      generateContentStream (request) {
        captured.request = request
        if (throws) throw throws
        return (async function * () {
          for (const c of chunks) yield c
        })()
      }
    }
  }
  return { client, captured }
}

function chunk (text, finishReason) {
  const c = {
    candidates: [{ content: { parts: [{ text }] } }]
  }
  if (finishReason) c.candidates[0].finishReason = finishReason
  return c
}

describe('session/adapters/gemini', () => {
  test('happy path yields delta events + completed done', async () => {
    const { client } = makeClient({
      chunks: [
        chunk('Hi'),
        chunk(' there'),
        {
          candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 }
        }
      ]
    })

    const events = await collect(gemini(envelope(), { client }))
    expect(events.map(e => e.type)).toEqual(['delta', 'delta', 'done'])
    expect(events[0].delta.delta).toBe('Hi')
    const done = events.at(-1)
    expect(done.result.status).toBe(STATUS_COMPLETED)
    expect(done.result.output).toBe('Hi there')
    expect(done.result.inputTokens).toBe(4)
    expect(done.result.outputTokens).toBe(2)
  })

  test('MAX_TOKENS → incomplete + insufficientOutputBudget', async () => {
    const { client } = makeClient({
      chunks: [
        chunk('Cut'),
        {
          candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 }
        }
      ]
    })
    const done = (await collect(gemini(envelope(), { client }))).at(-1)
    expect(done.result.status).toBe(STATUS_INCOMPLETE)
    expect(done.result.warning).toBe('insufficientOutputBudget')
  })

  test('SAFETY → incomplete without warning', async () => {
    const { client } = makeClient({
      chunks: [{ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] }]
    })
    const done = (await collect(gemini(envelope(), { client }))).at(-1)
    expect(done.result.status).toBe(STATUS_INCOMPLETE)
    expect(done.result.warning).toBeUndefined()
  })

  test('role assistant maps to model; text parts wrap as {text}', async () => {
    const { client, captured } = makeClient({
      chunks: [{ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }]
    })
    await collect(gemini(envelope({
      prompt: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' }
      ]
    }), { client }))
    expect(captured.request.contents).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello' }] }
    ])
  })

  test('outputBudget → config.maxOutputTokens', async () => {
    const { client, captured } = makeClient({
      chunks: [{ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }]
    })
    await collect(gemini(envelope({ outputBudget: 512 }), { client }))
    expect(captured.request.config.maxOutputTokens).toBe(512)
  })

  test('SDK throwing 500 yields retryable error', async () => {
    const err = Object.assign(new Error('down'), { status: 503 })
    const { client } = makeClient({ throws: err })
    const events = await collect(gemini(envelope(), { client }))
    expect(events[0].type).toBe('error')
    expect(events[0].error.type).toBe('PROVIDER_UNAVAILABLE')
    expect(events[0].error.retryable).toBe(true)
  })

  // F14 regression. @google/genai reads abortSignal from
  // params.config.abortSignal only — a second positional {signal}
  // arg is dropped. This test pins the actual wiring: the SDK gets
  // our AbortController.signal on the request's `config` field.
  test('deps.signal is merged into request.config.abortSignal', async () => {
    const { client, captured } = makeClient({
      chunks: [chunk('hi', 'STOP')]
    })
    const controller = new AbortController()
    await collect(gemini(envelope(), { client, signal: controller.signal }))

    expect(captured.request.config).toBeDefined()
    expect(captured.request.config.abortSignal).toBe(controller.signal)
  })

  test('no signal → no abortSignal field on request.config', async () => {
    const { client, captured } = makeClient({
      chunks: [chunk('hi', 'STOP')]
    })
    await collect(gemini(envelope(), { client }))

    // `config` may or may not exist depending on envelope options;
    // the invariant is specifically that `abortSignal` isn't set.
    expect(captured.request.config?.abortSignal).toBeUndefined()
  })

  test('pre-aborted signal still reaches SDK (no short-circuit)', async () => {
    // Even when the caller aborts before dispatch, the signal still
    // gets attached so the SDK sees it and tears down the request
    // the moment its internal HTTP client checks.
    const controller = new AbortController()
    controller.abort()

    const { client, captured } = makeClient({
      chunks: [chunk('hi', 'STOP')]
    })
    await collect(gemini(envelope(), { client, signal: controller.signal }))

    expect(captured.request.config.abortSignal).toBe(controller.signal)
    expect(captured.request.config.abortSignal.aborted).toBe(true)
  })
})
