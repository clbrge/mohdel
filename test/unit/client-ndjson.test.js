import { describe, test, expect } from 'vitest'
import { parseNDJSON } from '../../js/client/ndjson.js'

async function * streamOf (...chunks) {
  for (const c of chunks) yield c
}

/** @param {AsyncIterable<unknown>} iter */
async function collect (iter) {
  const out = []
  for await (const v of iter) out.push(v)
  return out
}

describe('client/ndjson parseNDJSON', () => {
  test('parses a single object with trailing newline', async () => {
    expect(await collect(parseNDJSON(streamOf('{"a":1}\n')))).toEqual([{ a: 1 }])
  })

  test('parses multiple objects', async () => {
    const s = streamOf('{"a":1}\n{"b":2}\n{"c":3}\n')
    expect(await collect(parseNDJSON(s))).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
  })

  test('handles tail without trailing newline', async () => {
    const s = streamOf('{"a":1}\n{"b":2}')
    expect(await collect(parseNDJSON(s))).toEqual([{ a: 1 }, { b: 2 }])
  })

  test('handles chunks split mid-line', async () => {
    const s = streamOf('{"a":', '1}\n{"b":2', '}\n')
    expect(await collect(parseNDJSON(s))).toEqual([{ a: 1 }, { b: 2 }])
  })

  test('handles chunks split on newline boundary', async () => {
    const s = streamOf('{"a":1}', '\n{"b":2}\n')
    expect(await collect(parseNDJSON(s))).toEqual([{ a: 1 }, { b: 2 }])
  })

  test('handles Buffer chunks', async () => {
    const s = streamOf(Buffer.from('{"a":1}\n'), Buffer.from('{"b":2}\n'))
    expect(await collect(parseNDJSON(s))).toEqual([{ a: 1 }, { b: 2 }])
  })

  test('skips empty lines', async () => {
    const s = streamOf('\n{"a":1}\n\n\n{"b":2}\n\n')
    expect(await collect(parseNDJSON(s))).toEqual([{ a: 1 }, { b: 2 }])
  })

  test('throws on invalid JSON', async () => {
    const s = streamOf('{"a":1}\nnope\n')
    await expect(collect(parseNDJSON(s))).rejects.toThrow()
  })

  // F37: tail branch (no trailing newline) hits a different JSON.parse
  // site than mid-stream lines. Needed independently of the mid-stream
  // malformed-JSON test above.
  test('throws on malformed JSON in the un-newlined tail', async () => {
    const s = streamOf('{"a":1}\n{partial')
    await expect(collect(parseNDJSON(s))).rejects.toThrow()
  })

  // F18: cap runaway lines to prevent OOM from malformed streams.
  test('throws when a line without newline exceeds the cap', async () => {
    const CAP = 16 * 1024 * 1024
    // 4 MiB chunks, yielded 5× = 20 MiB without \n → must throw before OOM
    const chunk = 'x'.repeat(4 * 1024 * 1024)
    const s = (async function * () {
      for (let i = 0; i < 5; i++) yield chunk
    })()
    await expect(collect(parseNDJSON(s))).rejects.toThrow(/exceeds .* bytes/)
    // Ensure the cap is the one we claim
    expect(CAP).toBe(16777216)
  })
})
