import { describe, test, expect } from 'vitest'
import { echo } from '../../js/session/adapters/echo.js'
import { isEvent, STATUS_COMPLETED, STATUS_INCOMPLETE } from '#core'

/** @returns {import('#core/envelope.js').CallEnvelope} */
function envelope (overrides = {}) {
  return {
    callId: 'c1',
    authId: 'a1',
    auth: { key: 'k' },
    provider: 'echo',
    model: 'm',
    prompt: 'hi',
    ...overrides
  }
}

async function collect (iter) {
  const out = []
  for await (const v of iter) out.push(v)
  return out
}

describe('session/adapters/echo', () => {
  test('yields two delta events and one done with status=completed', async () => {
    const events = await collect(echo(envelope()))
    expect(events.length).toBe(3)
    expect(events[0].type).toBe('delta')
    expect(events[1].type).toBe('delta')
    expect(events[2].type).toBe('done')
  })

  test('every yielded value is a valid Event', async () => {
    for (const ev of await collect(echo(envelope()))) {
      expect(isEvent(ev)).toBe(true)
    }
  })

  test('delta chunks have type=message and matching text', async () => {
    const events = await collect(echo(envelope()))
    expect(events[0]).toMatchObject({ type: 'delta', delta: { type: 'message', delta: 'Hello' } })
    expect(events[1]).toMatchObject({ type: 'delta', delta: { type: 'message', delta: ', world.' } })
  })

  test('done result has completed status and full AnswerResult shape', async () => {
    const events = await collect(echo(envelope()))
    const done = events.at(-1)
    expect(done.result.status).toBe(STATUS_COMPLETED)
    expect(done.result.output).toBe('Hello, world.')
    expect(done.result.inputTokens).toBe(0)
    expect(done.result.outputTokens).toBe(0)
    expect(done.result.thinkingTokens).toBe(0)
    expect(done.result.cost).toBe(0)
    expect(done.result.timestamps.start).toMatch(/^\d+$/)
    expect(done.result.timestamps.first).toMatch(/^\d+$/)
    expect(done.result.timestamps.end).toMatch(/^\d+$/)
  })

  test('pre-aborted signal yields cancelled done immediately', async () => {
    const controller = new AbortController()
    controller.abort()
    const events = await collect(echo(envelope(), { signal: controller.signal }))
    expect(events.length).toBe(1)
    expect(events[0].type).toBe('done')
    expect(events[0].result.status).toBe(STATUS_INCOMPLETE)
    expect(events[0].result.warning).toBe('cancelled')
  })
})
