/**
 * NDJSON line parser. Yields parsed objects from a byte/string stream.
 *
 * @module client/ndjson
 */

const MAX_LINE_BYTES = 16 * 1024 * 1024

/**
 * @param {AsyncIterable<Buffer|string>} stream
 * @returns {AsyncGenerator<unknown>}
 */
export async function * parseNDJSON (stream) {
  let buf = ''
  for await (const chunk of stream) {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    if (buf.length > MAX_LINE_BYTES) {
      throw new Error(`NDJSON line exceeds ${MAX_LINE_BYTES} bytes without newline`)
    }
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) yield JSON.parse(line)
    }
  }
  const tail = buf.trim()
  if (tail) yield JSON.parse(tail)
}
