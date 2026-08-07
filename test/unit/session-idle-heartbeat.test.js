import { describe, test, expect, vi, afterEach } from 'vitest'
import { withIdleHeartbeat, MIN_IDLE_HEARTBEAT_MS } from '../../js/session/_idle_heartbeat.js'

afterEach(() => { vi.useRealTimers() })

/**
 * A source whose single in-flight `next()` stays pending until the test
 * resolves it, counting every subscription made to that promise.
 */
function controllableSource () {
  const state = { subscriptions: 0, settle: null }
  const iter = {
    next () {
      const p = new Promise(resolve => { state.settle = resolve })
      const then = p.then.bind(p)
      p.then = (...args) => { state.subscriptions++; return then(...args) }
      return p
    }
  }
  return { state, source: { [Symbol.asyncIterator]: () => iter } }
}

describe('withIdleHeartbeat — pending-promise subscriptions', () => {
  test('subscribes once per in-flight next(), however many idle ticks fire', async () => {
    vi.useFakeTimers()
    const { state, source } = controllableSource()
    const events = []
    const pump = (async () => {
      for await (const ev of withIdleHeartbeat(source, MIN_IDLE_HEARTBEAT_MS)) events.push(ev)
    })()

    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(MIN_IDLE_HEARTBEAT_MS)
    }

    expect(events.filter(e => e.type === 'idle').length).toBeGreaterThanOrEqual(5)
    // One `next()` has been in flight the whole time. Re-racing it per
    // tick would have attached two reactions each firing.
    expect(state.subscriptions).toBe(1)

    state.settle({ done: true, value: undefined })
    await pump
  })

  test('a real event releases the promise and the next one subscribes once more', async () => {
    vi.useFakeTimers()
    const { state, source } = controllableSource()
    const events = []
    const pump = (async () => {
      for await (const ev of withIdleHeartbeat(source, MIN_IDLE_HEARTBEAT_MS)) events.push(ev)
    })()

    await vi.advanceTimersByTimeAsync(MIN_IDLE_HEARTBEAT_MS)
    state.settle({ done: false, value: { type: 'delta' } })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(MIN_IDLE_HEARTBEAT_MS)

    expect(events.some(e => e.type === 'delta')).toBe(true)
    expect(state.subscriptions).toBe(2)

    state.settle({ done: true, value: undefined })
    await pump
  })
})

describe('withIdleHeartbeat — floor', () => {
  test('a sub-floor idleMs ticks at the floor, not the requested cadence', async () => {
    vi.useFakeTimers()
    const { state, source } = controllableSource()
    const events = []
    const pump = (async () => {
      for await (const ev of withIdleHeartbeat(source, 1)) events.push(ev)
    })()

    await vi.advanceTimersByTimeAsync(MIN_IDLE_HEARTBEAT_MS - 1)
    expect(events).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    expect(events.filter(e => e.type === 'idle')).toHaveLength(1)

    state.settle({ done: true, value: undefined })
    await pump
  })

  test('an above-floor idleMs is honoured as given', async () => {
    vi.useFakeTimers()
    const { state, source } = controllableSource()
    const events = []
    const pump = (async () => {
      for await (const ev of withIdleHeartbeat(source, 1000)) events.push(ev)
    })()

    await vi.advanceTimersByTimeAsync(999)
    expect(events).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(events.filter(e => e.type === 'idle')).toHaveLength(1)

    state.settle({ done: true, value: undefined })
    await pump
  })
})

describe('withIdleHeartbeat — pass-through', () => {
  test('falsy idleMs yields the source unchanged and sets no timer', async () => {
    async function * src () { yield 'a'; yield 'b' }
    expect(await Array.fromAsync(withIdleHeartbeat(src(), 0))).toEqual(['a', 'b'])
    expect(await Array.fromAsync(withIdleHeartbeat(src(), undefined))).toEqual(['a', 'b'])
  })

  test('source errors propagate', async () => {
    async function * src () { throw new Error('boom') }
    await expect(Array.fromAsync(withIdleHeartbeat(src(), MIN_IDLE_HEARTBEAT_MS)))
      .rejects.toThrow('boom')
  })

  test('no real event is dropped when the timer wins first', async () => {
    vi.useFakeTimers()
    const { state, source } = controllableSource()
    const events = []
    const pump = (async () => {
      for await (const ev of withIdleHeartbeat(source, MIN_IDLE_HEARTBEAT_MS)) events.push(ev)
    })()

    await vi.advanceTimersByTimeAsync(MIN_IDLE_HEARTBEAT_MS * 2)
    state.settle({ done: false, value: 'survived' })
    await vi.advanceTimersByTimeAsync(0)

    expect(events).toContain('survived')

    state.settle({ done: true, value: undefined })
    await pump
  })
})
