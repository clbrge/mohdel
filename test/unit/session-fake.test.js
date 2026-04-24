import { describe, test, expect } from 'vitest'

import { fake } from '../../js/session/adapters/fake.js'

/** @returns {import('#core/envelope.js').CallEnvelope} */
function envelope (prompt, overrides = {}) {
  return {
    callId: 'c1',
    authId: 'a1',
    auth: { key: 'k' },
    model: 'fake/m',
    prompt,
    ...overrides
  }
}

async function collect (iter) {
  const out = []
  for await (const v of iter) out.push(v)
  return out
}

describe('fake adapter — echo (default)', () => {
  test('non-JSON prompt falls through to echo', async () => {
    const events = await collect(fake(envelope('plain text')))
    expect(events.map(e => e.type)).toEqual(['delta', 'done'])
    expect(events.at(-1).result.status).toBe('completed')
    expect(events.at(-1).result.output).toBe('ok')
  })

  test('{mode:"echo"} with output override', async () => {
    const events = await collect(fake(envelope(JSON.stringify({ mode: 'echo', output: 'hey' }))))
    expect(events[0].delta.delta).toBe('hey')
    expect(events.at(-1).result.output).toBe('hey')
  })

  test('malformed JSON falls through to echo', async () => {
    const events = await collect(fake(envelope('{bad json')))
    expect(events.at(-1).result.status).toBe('completed')
  })
})

describe('fake adapter — slow', () => {
  test('emits N deltas then done', async () => {
    const spec = { mode: 'slow', tokens: 4, delayMs: 1 }
    const events = await collect(fake(envelope(JSON.stringify(spec))))
    const deltas = events.filter(e => e.type === 'delta')
    expect(deltas.length).toBe(4)
    expect(events.at(-1).type).toBe('done')
  })

  test('abort mid-stream yields cancelled done', async () => {
    const spec = { mode: 'slow', tokens: 100, delayMs: 20 }
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 30)
    const events = await collect(fake(envelope(JSON.stringify(spec)), { signal: controller.signal }))
    expect(events.at(-1).type).toBe('done')
    expect(events.at(-1).result.warning).toBe('cancelled')
    expect(events.at(-1).result.status).toBe('incomplete')
  })
})

describe('fake adapter — volume', () => {
  test('emits requested token count fast', async () => {
    const events = await collect(fake(envelope(JSON.stringify({ mode: 'volume', tokens: 50 }))))
    const deltas = events.filter(e => e.type === 'delta')
    expect(deltas.length).toBe(50)
    expect(events.at(-1).result.status).toBe('completed')
  })
})

describe('fake adapter — error', () => {
  test('yields typed error event with provided type', async () => {
    const spec = { mode: 'error', type: 'AUTH_INVALID', message: 'bad key' }
    const events = await collect(fake(envelope(JSON.stringify(spec))))
    expect(events.length).toBe(1)
    expect(events[0].type).toBe('error')
    expect(events[0].error.type).toBe('AUTH_INVALID')
    expect(events[0].error.message).toBe('bad key')
  })

  test('defaults to PROVIDER_ERROR when type omitted', async () => {
    const events = await collect(fake(envelope(JSON.stringify({ mode: 'error' }))))
    expect(events[0].error.type).toBe('PROVIDER_ERROR')
  })
})

describe('fake adapter — hang', () => {
  test('never emits a terminal until aborted', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 30)
    const events = await collect(fake(envelope(JSON.stringify({ mode: 'hang' })), { signal: controller.signal }))
    expect(events.length).toBe(1)
    expect(events[0].type).toBe('done')
    expect(events[0].result.warning).toBe('cancelled')
  })

  test('pre-aborted signal resolves immediately', async () => {
    const controller = new AbortController()
    controller.abort()
    const events = await collect(fake(envelope(JSON.stringify({ mode: 'hang' })), { signal: controller.signal }))
    expect(events.at(-1).result.warning).toBe('cancelled')
  })
})

describe('fake adapter — tool', () => {
  test('emits tool_use terminal with one tool call', async () => {
    const spec = { mode: 'tool', name: 'lookup', args: { q: 'weather' }, id: 'call_x' }
    const events = await collect(fake(envelope(JSON.stringify(spec))))
    const done = events.at(-1)
    expect(done.result.status).toBe('tool_use')
    expect(done.result.toolCalls).toEqual([
      { id: 'call_x', name: 'lookup', arguments: { q: 'weather' } }
    ])
  })
})

describe('fake adapter — incomplete', () => {
  test('done with status=incomplete + warning', async () => {
    const spec = { mode: 'incomplete', output: 'half', warning: 'insufficientOutputBudget' }
    const events = await collect(fake(envelope(JSON.stringify(spec))))
    const done = events.at(-1)
    expect(done.result.status).toBe('incomplete')
    expect(done.result.output).toBe('half')
    expect(done.result.warning).toBe('insufficientOutputBudget')
  })
})

describe('fake adapter — cancel_after', () => {
  test('emits N deltas then waits for abort', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    const events = await collect(fake(
      envelope(JSON.stringify({ mode: 'cancel_after', tokens: 3 })),
      { signal: controller.signal }
    ))
    const deltas = events.filter(e => e.type === 'delta')
    expect(deltas.length).toBe(3)
    expect(events.at(-1).result.warning).toBe('cancelled')
  })
})

describe('fake adapter — registry', () => {
  test('is exposed under envelope.provider="fake"', async () => {
    const { getAdapter } = await import('../../js/session/adapters/index.js')
    const adapter = getAdapter('fake')
    const events = await collect(adapter(envelope('plain text')))
    expect(events.at(-1).type).toBe('done')
  })
})
