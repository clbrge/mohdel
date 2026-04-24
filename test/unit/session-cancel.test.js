import { describe, test, expect, beforeEach } from 'vitest'
import { echo } from '../../js/session/adapters/echo.js'
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

describe('echo adapter honors signal', () => {
  test('pre-aborted signal yields only a cancelled done', async () => {
    const controller = new AbortController()
    controller.abort()
    const events = await collect(echo(envelope(), { signal: controller.signal }))
    expect(events.length).toBe(1)
    expect(events[0].type).toBe('done')
    expect(events[0].result.warning).toBe('cancelled')
  })

  test('abort mid-stream yields partial deltas then cancelled done', async () => {
    const controller = new AbortController()
    const iter = echo(envelope(), { signal: controller.signal })

    const out = []
    const { value: first } = await iter.next()
    out.push(first)
    controller.abort()
    for await (const ev of iter) out.push(ev)

    expect(out[0].type).toBe('delta')
    expect(out.at(-1).type).toBe('done')
    expect(out.at(-1).result.warning).toBe('cancelled')
  })
})

describe('run() abort handling', () => {
  test('pre-aborted + adapter returning early yields cancelled done', async () => {
    const noop = async function * () { /* returns without yielding */ }
    const controller = new AbortController()
    controller.abort()

    const events = await collect(run(envelope(), {
      resolveAdapter: () => noop,
      signal: controller.signal
    }))
    expect(events.length).toBe(1)
    expect(events[0].type).toBe('done')
    expect(events[0].result.warning).toBe('cancelled')
  })

  test('adapter that throws on abort produces cancelled done', async () => {
    const throwing = async function * () {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
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

  test('mid-stream cancel via signal stops adapter yielding and returns cancelled done', async () => {
    const slow = async function * (_env, { signal } = {}) {
      yield { type: 'delta', delta: { type: 'message', delta: 'a' } }
      for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 10))
        if (signal?.aborted) {
          const end = String(process.hrtime.bigint())
          yield {
            type: 'done',
            result: {
              status: 'incomplete',
              output: null,
              inputTokens: 0,
              outputTokens: 0,
              thinkingTokens: 0,
              cost: 0,
              timestamps: { start: end, first: end, end },
              warning: 'cancelled'
            }
          }
          return
        }
        yield { type: 'delta', delta: { type: 'message', delta: `chunk${i}` } }
      }
    }
    const controller = new AbortController()
    const iter = run(envelope(), {
      resolveAdapter: () => slow,
      signal: controller.signal
    })

    const out = []
    for await (const ev of iter) {
      out.push(ev)
      if (ev.type === 'delta' && ev.delta.delta === 'chunk1') controller.abort()
    }

    expect(out.at(-1).type).toBe('done')
    expect(out.at(-1).result.warning).toBe('cancelled')
  })
})
