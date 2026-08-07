/**
 * NDJSON line parser. Yields parsed objects from a byte/string stream.
 *
 * The cap applies to a single unterminated line, not to the accumulated
 * buffer: a buffer holding several complete frames is a legitimate
 * burst, not a runaway line.
 *
 * @module client/ndjson
 */

import { MAX_LINE_BYTES, exceedsLineBytes } from '#core/framing.js'

/**
 * @param {AsyncIterable<Buffer|string>} stream
 * @returns {AsyncGenerator<unknown>}
 */
export async function * parseNDJSON (stream) {
  let buf = ''
  for await (const chunk of stream) {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) yield JSON.parse(line)
    }
    if (exceedsLineBytes(buf)) {
      throw new Error(`NDJSON line exceeds ${MAX_LINE_BYTES} bytes without newline`)
    }
  }
  const tail = buf.trim()
  if (tail) yield JSON.parse(tail)
}
