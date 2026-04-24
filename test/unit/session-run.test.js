import { describe, test, expect, beforeEach } from 'vitest'
import { run } from '../../js/session/run.js'
import { setCatalog } from '../../js/session/adapters/_catalog.js'

beforeEach(() => setCatalog({ 'echo/m': {} }))

/** @returns {import('#core/envelope.js').CallEnvelope} */
function envelope (overrides = {}) {
  return {
    callId: 'c1',
    authId: 'a1',
    auth: { key: 'k' },
    model: 'echo/m',
    prompt: 'hi',
    ...overrides
  }
}

async function collect (iter) {
  const out = []
  for await (const v of iter) out.push(v)
  return out
}

describe('session/run', () => {
  test('passes events from the matching adapter through', async () => {
    const events = await collect(run(envelope()))
    expect(events.map(e => e.type)).toEqual(['delta', 'delta', 'done'])
  })

  test('unknown provider yields a single error event', async () => {
    const events = await collect(run(envelope({ model: 'nonesuch/m' })))
    expect(events.length).toBe(1)
    expect(events[0].type).toBe('error')
    expect(events[0].error.type).toBe('SESSION_UNKNOWN_PROVIDER')
    expect(events[0].error.severity).toBe('error')
  })

  // F29 (image-only provider via answer path) — the fallback exists in
  // run.js but no provider in the current registry is image-only:
  // every entry in `IMAGE_ADAPTERS` (openai, novita, fake) also has a
  // text adapter. Re-add a concrete test here the next time a text-less
  // image provider is registered.

  test('adapter that throws produces an error event (not aborted)', async () => {
    const throwing = async function * () {
      throw new Error('provider exploded')
    }
    const events = await collect(run(envelope(), { resolveAdapter: () => throwing }))
    expect(events.length).toBe(1)
    expect(events[0].type).toBe('error')
    expect(events[0].error.type).toBe('SESSION_ADAPTER_THREW')
    expect(events[0].error.message).toContain('provider exploded')
  })

  test('adapter that throws with aborted signal yields cancelled done', async () => {
    const throwing = async function * () {
      throw new Error('aborted')
    }
    const controller = new AbortController()
    controller.abort()
    const events = await collect(run(envelope(), {
      resolveAdapter: () => throwing,
      signal: controller.signal
    }))
    expect(events.at(-1).type).toBe('done')
    expect(events.at(-1).result.warning).toBe('cancelled')
  })

  test('adapter returning without terminal + no abort yields SESSION_ADAPTER_NO_TERMINAL', async () => {
    const buggy = async function * () {
      yield { type: 'delta', delta: { type: 'message', delta: 'hi' } }
    }
    const events = await collect(run(envelope(), { resolveAdapter: () => buggy }))
    expect(events.at(-1).type).toBe('error')
    expect(events.at(-1).error.type).toBe('SESSION_ADAPTER_NO_TERMINAL')
  })

  test('adapter emitting done is forwarded unchanged', async () => {
    const adapter = async function * () {
      yield {
        type: 'done',
        result: {
          status: 'completed',
          output: 'ok',
          inputTokens: 1,
          outputTokens: 1,
          thinkingTokens: 0,
          cost: 0,
          timestamps: { start: '0', first: '0', end: '0' }
        }
      }
    }
    const events = await collect(run(envelope(), { resolveAdapter: () => adapter }))
    expect(events.length).toBe(1)
    expect(events[0].type).toBe('done')
    expect(events[0].result.output).toBe('ok')
  })
})
