import { describe, test, expect, vi, afterEach } from 'vitest'
import { coalesce } from '../../js/client/index.js'

const delta = (text, type = 'message') => ({ type: 'delta', delta: { type, delta: text } })
const done = { type: 'done', result: { status: 'completed' } }

async function * stream (...events) {
  for (const ev of events) yield ev
}

async function collect (iterable) {
  const out = []
  for await (const ev of iterable) out.push(ev)
  return out
}

afterEach(() => vi.restoreAllMocks())

describe('client/coalesce', () => {
  test('merges deltas until maxChars, flushes the rest before the terminal', async () => {
    const out = await collect(coalesce(
      stream(delta('hello'), delta('world!'), delta('tail'), done),
      { maxChars: 10 }
    ))
    expect(out).toEqual([delta('helloworld!'), delta('tail'), done])
  })

  test('flushes when maxMs has passed since the last flush, checked on arrival', async () => {
    let now = 1000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    async function * timed () {
      yield delta('a')
      now += 499
      yield delta('b')
      now += 1
      yield delta('c')
      yield delta('d')
      yield done
    }
    const out = await collect(coalesce(timed(), { maxChars: 1000, maxMs: 500 }))
    expect(out).toEqual([delta('abc'), delta('d'), done])
  })

  test('a change of kind flushes the previous kind', async () => {
    const out = await collect(coalesce(stream(
      delta('Let me check. '),
      delta('{"city":', 'function_call'),
      delta('"Paris"}', 'function_call'),
      done
    )))
    expect(out).toEqual([
      delta('Let me check. '),
      delta('{"city":"Paris"}', 'function_call'),
      done
    ])
  })

  test('other events pass through in order, after what was buffered', async () => {
    const idle = { type: 'idle', sinceMs: 5000 }
    const error = { type: 'error', error: { message: 'x', severity: 'error', retryable: false } }
    const out = await collect(coalesce(stream(delta('a'), idle, delta('b'), error)))
    expect(out).toEqual([delta('a'), idle, delta('b'), error])
  })

  test('empty deltas are dropped; a stream without a terminal still flushes', async () => {
    const out = await collect(coalesce(stream(delta(''), delta('x'))))
    expect(out).toEqual([delta('x')])
  })

  test('defaults are the facade\'s: 250 chars', async () => {
    const out = await collect(coalesce(stream(delta('x'.repeat(249)), delta('y'), delta('z'))))
    expect(out).toEqual([delta('x'.repeat(249) + 'y'), delta('z')])
  })
})
