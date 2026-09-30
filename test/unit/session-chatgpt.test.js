import { describe, test, expect, vi, beforeEach } from 'vitest'
import { chatgpt } from '../../js/session/adapters/chatgpt.js'
import { setCatalog } from '../../js/session/adapters/_catalog.js'
import { run } from '../../js/session/run.js'

const envelope = () => ({ callId: 'c1', authId: 'a1', auth: { key: 'oauth-token-secret' }, model: 'chatgpt/account-model', prompt: 'Hello' })
const collect = async iter => { const events = []; for await (const event of iter) events.push(event); return events }
const modelFetch = vi.fn(async () => Response.json({ models: [{ slug: 'account-model', visibility: 'list' }] }))
const client = events => ({ responses: { stream: vi.fn(async function * () { yield * events }) } })
const completed = { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 3 } } }

beforeEach(() => {
  modelFetch.mockClear()
  setCatalog({ 'chatgpt/account-model': { model: 'account-model', inputPrice: 999, outputPrice: 999 } })
})

describe('ChatGPT Responses adapter', () => {
  test('forces nonstored streaming, preserves token counts, and does not bill API prices', async () => {
    const sdk = client([{ type: 'response.output_text.delta', delta: 'Hello' }, completed])
    const events = await collect(chatgpt(envelope(), { fetch: modelFetch, client: sdk }))
    expect(sdk.responses.stream.mock.calls[0][0]).toMatchObject({ model: 'account-model', stream: true, store: false })
    expect(modelFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer oauth-token-secret')
    expect(events.at(-1).result).toMatchObject({ output: 'Hello', inputTokens: 10, outputTokens: 3, cost: 0 })
  })

  test('does not infer with a model missing from the signed-in account', async () => {
    const sdk = client([completed])
    const events = await collect(chatgpt(envelope(), { fetch: async () => Response.json({ models: [] }), client: sdk }))
    expect(events.at(-1).type).toBe('error')
    expect(sdk.responses.stream).not.toHaveBeenCalled()
  })

  test.each([
    { events: [] },
    { events: [{ type: 'response.failed', response: { error: { message: 'failed' } } }] }
  ])('a missing or failed terminal response is not success', async ({ events }) => {
    const result = await collect(chatgpt(envelope(), { fetch: modelFetch, client: client(events) }))
    expect(result.at(-1).type).toBe('error')
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
