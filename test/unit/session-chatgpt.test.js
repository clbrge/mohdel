import { describe, test, expect, vi, beforeEach } from 'vitest'
import OpenAI from 'openai'
import { chatgpt } from '../../js/session/adapters/chatgpt.js'
import { setCatalog } from '../../js/session/adapters/_catalog.js'
import { run } from '../../js/session/run.js'

let tokens = 0
const envelope = (key = `oauth-token-secret-${++tokens}`) => ({ callId: 'c1', authId: 'a1', auth: { key }, model: 'chatgpt/account-model', prompt: 'Hello' })
const collect = async iter => { const events = []; for await (const event of iter) events.push(event); return events }
const modelFetch = vi.fn(async () => Response.json({ models: [{ slug: 'account-model', visibility: 'list' }] }))
const client = events => ({ responses: { create: vi.fn(async function * () { yield * events }) } })
const completed = { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 3 } } }

beforeEach(() => {
  modelFetch.mockClear()
  setCatalog({ 'chatgpt/account-model': { model: 'account-model', inputPrice: 999, outputPrice: 999 } })
})

describe('ChatGPT Responses adapter', () => {
  test('forces nonstored streaming, preserves token counts, and does not bill API prices', async () => {
    const sdk = client([{ type: 'response.output_text.delta', delta: 'Hello' }, completed])
    const call = envelope()
    const events = await collect(chatgpt(call, { fetch: modelFetch, client: sdk }))
    expect(sdk.responses.create.mock.calls[0][0]).toMatchObject({ model: 'account-model', stream: true, store: false })
    expect(modelFetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${call.auth.key}`)
    expect(events.at(-1).result).toMatchObject({ output: 'Hello', inputTokens: 10, outputTokens: 3, cost: 0 })
  })

  test('routes by the identifier for the cache, and sends no safety_identifier, which the backend refuses', async () => {
    const sdk = client([completed])
    await collect(chatgpt({ ...envelope(), identifier: 'conv-1' }, { fetch: modelFetch, client: sdk }))
    const request = sdk.responses.create.mock.calls[0][0]
    expect(request.prompt_cache_key).toBe('conv-1')
    expect(request).not.toHaveProperty('safety_identifier')
  })

  test('refuses an output budget, which the route asks callers to omit, and sends nothing', async () => {
    const sdk = client([completed])
    const events = await collect(chatgpt({ ...envelope(), outputBudget: 1000 }, { fetch: modelFetch, client: sdk }))
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { type: 'INVALID_REQUEST', retryable: false } })
    expect(events.at(-1).error.message).toMatch(/no output budget/)
    expect(sdk.responses.create).not.toHaveBeenCalled()
    expect(modelFetch).not.toHaveBeenCalled()
  })

  test('does not infer with a model missing from the signed-in account', async () => {
    const sdk = client([completed])
    const events = await collect(chatgpt(envelope(), { fetch: async () => Response.json({ models: [] }), client: sdk }))
    expect(events.at(-1).type).toBe('error')
    expect(sdk.responses.create).not.toHaveBeenCalled()
  })

  test('discovers once per token', async () => {
    const call = envelope()
    await collect(chatgpt(call, { fetch: modelFetch, client: client([completed]) }))
    await collect(chatgpt(call, { fetch: modelFetch, client: client([completed]) }))
    expect(modelFetch).toHaveBeenCalledTimes(1)
    await collect(chatgpt(envelope(), { fetch: modelFetch, client: client([completed]) }))
    expect(modelFetch).toHaveBeenCalledTimes(2)
  })

  test('a failed discovery is not remembered', async () => {
    const call = envelope()
    await collect(chatgpt(call, { fetch: async () => new Response('', { status: 500 }) }))
    const events = await collect(chatgpt(call, { fetch: modelFetch, client: client([completed]) }))
    expect(modelFetch).toHaveBeenCalledTimes(1)
    expect(events.at(-1).type).toBe('done')
  })

  test.each([
    { events: [] },
    { events: [{ type: 'response.failed', response: { error: { message: 'failed' } } }] }
  ])('a missing or failed terminal response is not success', async ({ events }) => {
    const result = await collect(chatgpt(envelope(), { fetch: modelFetch, client: client(events) }))
    expect(result.at(-1).type).toBe('error')
  })

  test('an event type the SDK does not know, such as the moderation metadata, is passed over', async () => {
    const events = [
      { type: 'response.created', response: { id: 'resp_1', object: 'response', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } },
      { type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Hello' },
      { type: 'response.metadata', response_id: 'resp_1', metadata: { openai_chatgpt_moderation_metadata: {} } },
      completed
    ]
    const body = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
    const sdk = new OpenAI({
      apiKey: 'oauth-token',
      baseURL: 'http://responses.test/v1',
      maxRetries: 0,
      fetch: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    })
    const result = await collect(chatgpt(envelope(), { fetch: modelFetch, client: sdk }))
    expect(result.at(-1).result).toMatchObject({ output: 'Hello', inputTokens: 10, outputTokens: 3 })
  })

  test('a usage limit arriving in the stream is a quota, not retried, and logged by its code alone', async () => {
    const call = envelope()
    const limit = Object.assign(new Error('The ChatGPT user has reached their usage limit.'), {
      error: { type: 'usage_limit_reached', message: `The ChatGPT user has reached their usage limit. ${call.auth.key}` }
    })
    const sdk = { responses: { create: vi.fn(async function * () { yield { type: 'response.output_text.delta', delta: 'He' }; throw limit }) } }
    const warn = vi.fn()
    const events = await collect(chatgpt(call, { fetch: modelFetch, client: sdk, log: { warn } }))
    expect(events.at(-1).error).toMatchObject({ type: 'QUOTA_EXHAUSTED', retryable: false })
    expect(JSON.stringify(events.at(-1))).not.toContain(call.auth.key)
    expect(warn.mock.calls[0][0]).toEqual({ provider: 'chatgpt', code: 'usage_limit_reached' })
  })

  test.each([401, 403, 429, 500])('discovery failure %s is a terminal error', async status => {
    const events = await collect(chatgpt(envelope(), { fetch: async () => new Response('', { status }) }))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('error')
    expect(JSON.stringify(events)).not.toContain('oauth-token-secret')
  })

  test('abort during discovery returns the normal aborted result', async () => {
    const controller = new AbortController()
    const events = await collect(chatgpt(envelope(), {
      signal: controller.signal,
      fetch: async () => { controller.abort(); throw new Error('aborted') }
    }))
    expect(events.at(-1).result).toMatchObject({ warning: 'aborted', cost: 0 })
  })

  test('uses the same registry and envelope when dispatched by the session runtime', async () => {
    const sdk = client([completed])
    const events = await collect(run(envelope(), {
      resolveAdapter: async provider => {
        expect(provider).toBe('chatgpt')
        return (env, deps) => chatgpt(env, { ...deps, fetch: modelFetch, client: sdk })
      }
    }))
    expect(events.at(-1).type).toBe('done')
    expect(events.at(-1).result.cost).toBe(0)
  })
})
