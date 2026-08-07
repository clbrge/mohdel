/**
 * NDJSON framing limits, shared by every JS reader of the protocol.
 *
 * The cap bounds a single unterminated line, not accumulated buffered
 * frames, and is measured in UTF-8 bytes so it matches the gate's
 * `read_capped_line` (`rust/thin-gate/src/server.rs`), which counts
 * bytes off the socket. A reader that capped UTF-16 units instead
 * would accept up to three times what the gate does.
 *
 * @module core/framing
 */

export const MAX_LINE_BYTES = 16 * 1024 * 1024

/**
 * Exact byte length is O(n) in the string, so it is only computed in
 * the band where the answer is in doubt: UTF-8 encodes a UTF-16 unit
 * as 1-3 bytes, which brackets the count between `length` and
 * `3 * length`.
 *
 * @param {string} s
 * @param {number} [cap]
 * @returns {boolean}
 */
export function exceedsLineBytes (s, cap = MAX_LINE_BYTES) {
  if (s.length > cap) return true
  if (s.length * 3 <= cap) return false
  return Buffer.byteLength(s, 'utf8') > cap
}
