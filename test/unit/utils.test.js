import { describe, test, expect } from 'vitest'
import {
  sanitizeOutput,
  translateModelInfo,
  createRealtimeDeltaBuffer,
  createTimingTracker
} from '../../src/lib/utils.js'

describe('sanitizeOutput', () => {
  test('trims whitespace', () => {
    expect(sanitizeOutput('  hello  ')).toBe('hello')
  })

  test('replaces null bytes with replacement character', () => {
    expect(sanitizeOutput('hello\0world')).toBe('hello\uFFFDworld')
  })

  test('handles combined whitespace and null bytes', () => {
    expect(sanitizeOutput('  \0hi\0  ')).toBe('\uFFFDhi\uFFFD')
  })

  test('returns non-strings as-is', () => {
    expect(sanitizeOutput(42)).toBe(42)
    expect(sanitizeOutput(null)).toBe(null)
    expect(sanitizeOutput(undefined)).toBe(undefined)
  })

  test('handles empty string', () => {
    expect(sanitizeOutput('')).toBe('')
  })
})

describe('translateModelInfo', () => {
  test('renames fields via string mapping', () => {
    const model = { old_field: 'value', keep: 'yes' }
    const result = translateModelInfo(model, { old_field: 'new_field' })
    expect(result).toEqual({ new_field: 'value', keep: 'yes' })
    expect(result).not.toHaveProperty('old_field')
  })

  test('applies function transforms', () => {
    const model = { raw_size: '1024' }
    const result = translateModelInfo(model, {
      raw_size: (val) => ['size_kb', parseInt(val, 10)]
    })
    expect(result).toEqual({ size_kb: 1024 })
  })

  test('renames display_name to label', () => {
    const model = { display_name: 'GPT-4o', id: 'gpt-4o' }
    const result = translateModelInfo(model)
    expect(result.label).toBe('GPT-4o')
    expect(result).not.toHaveProperty('display_name')
  })

  test('renames displayName to label', () => {
    const model = { displayName: 'Claude 3', id: 'claude-3' }
    const result = translateModelInfo(model)
    expect(result.label).toBe('Claude 3')
    expect(result).not.toHaveProperty('displayName')
  })

  test('returns non-objects as-is', () => {
    expect(translateModelInfo(null)).toBe(null)
    expect(translateModelInfo(undefined)).toBe(undefined)
    expect(translateModelInfo('string')).toBe('string')
  })

  test('handles empty infoTranslate', () => {
    const model = { id: 'test' }
    expect(translateModelInfo(model, {})).toEqual({ id: 'test' })
  })

  test('does not mutate input', () => {
    const model = { display_name: 'Test', id: 'x' }
    translateModelInfo(model)
    expect(model).toHaveProperty('display_name')
  })
})

describe('createRealtimeDeltaBuffer', () => {
  test('flushes when buffer reaches maxChars', () => {
    const chunks = []
    const buf = createRealtimeDeltaBuffer(c => chunks.push(c), { maxChars: 10 })
    buf.push('message', 'hello') // 5 chars, no flush
    expect(chunks).toHaveLength(0)
    buf.push('message', 'world!') // 11 chars total, flush
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toEqual({ type: 'message', delta: 'helloworld!' })
  })

  test('flush() sends remaining buffer', () => {
    const chunks = []
    const buf = createRealtimeDeltaBuffer(c => chunks.push(c), { maxChars: 1000 })
    buf.push('message', 'partial')
    expect(chunks).toHaveLength(0)
    buf.flush()
    expect(chunks).toHaveLength(1)
    expect(chunks[0].delta).toBe('partial')
  })

  test('flush() is a no-op when buffer is empty', () => {
    const chunks = []
    const buf = createRealtimeDeltaBuffer(c => chunks.push(c))
    buf.flush()
    expect(chunks).toHaveLength(0)
  })

  test('no-op when handler is null', () => {
    const buf = createRealtimeDeltaBuffer(null)
    buf.push('message', 'hello')
    buf.flush() // should not throw
  })

  test('no-op when handler is undefined', () => {
    const buf = createRealtimeDeltaBuffer(undefined)
    buf.push('message', 'data')
    buf.flush()
  })

  test('ignores empty deltas', () => {
    const chunks = []
    const buf = createRealtimeDeltaBuffer(c => chunks.push(c), { maxChars: 5 })
    buf.push('message', '')
    buf.push('message', null)
    buf.push('message', undefined)
    buf.flush()
    expect(chunks).toHaveLength(0)
  })

  test('tracks last type across pushes', () => {
    const chunks = []
    const buf = createRealtimeDeltaBuffer(c => chunks.push(c), { maxChars: 5 })
    buf.push('message', 'ab')
    buf.push('function_call', 'cde') // 5 chars, triggers flush
    expect(chunks).toHaveLength(1)
    expect(chunks[0].type).toBe('function_call')
  })

  test('accumulates across multiple pushes before threshold', () => {
    const chunks = []
    const buf = createRealtimeDeltaBuffer(c => chunks.push(c), { maxChars: 100 })
    buf.push('message', 'a')
    buf.push('message', 'b')
    buf.push('message', 'c')
    expect(chunks).toHaveLength(0)
    buf.flush()
    expect(chunks).toHaveLength(1)
    expect(chunks[0].delta).toBe('abc')
  })
})

describe('createTimingTracker', () => {
  test('returns object with markFirst and timestamps', () => {
    const tracker = createTimingTracker()
    expect(typeof tracker.markFirst).toBe('function')
    expect(typeof tracker.timestamps).toBe('function')
  })

  test('timestamps returns start, first, end as strings', () => {
    const tracker = createTimingTracker()
    const ts = tracker.timestamps()
    expect(typeof ts.start).toBe('string')
    expect(typeof ts.first).toBe('string')
    expect(typeof ts.end).toBe('string')
  })

  test('first equals end when markFirst is never called', () => {
    const tracker = createTimingTracker()
    const ts = tracker.timestamps()
    expect(ts.first).toBe(ts.end)
  })

  test('markFirst is idempotent', () => {
    const tracker = createTimingTracker()
    tracker.markFirst()
    const ts1 = tracker.timestamps()
    const firstValue = ts1.first

    tracker.markFirst()
    const ts2 = tracker.timestamps()
    expect(ts2.first).toBe(firstValue)
  })

  test('start < end', () => {
    const tracker = createTimingTracker()
    // small busy-wait to ensure time passes
    const start = Date.now()
    while (Date.now() - start < 2) { /* spin */ }
    const ts = tracker.timestamps()
    expect(BigInt(ts.end)).toBeGreaterThan(BigInt(ts.start))
  })
})
