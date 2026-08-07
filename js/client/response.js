/**
 * Shared response handling for the three gate call paths.
 *
 * `call.js`, `call_image.js` and `call_transcription.js` each read a
 * non-200 body the same way and turn it into the same `TypedError`;
 * keeping one copy means a fix to the error shape cannot land on some
 * paths and miss others.
 *
 * @module client/response
 */

/**
 * @param {AsyncIterable<Buffer|string>} stream
 * @returns {Promise<string>}
 */
export async function readAll (stream) {
  let s = ''
  for await (const c of stream) s += typeof c === 'string' ? c : c.toString('utf8')
  return s
}

/**
 * @param {string} body
 * @param {number} status
 * @returns {import('#core/errors.js').TypedError}
 */
export function parseErrorBody (body, status) {
  try {
    const parsed = JSON.parse(body)
    if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
      return parsed
    }
  } catch {}
  return {
    type: 'PROTOCOL_HTTP_ERROR',
    message: `thin-gate returned HTTP ${status}`,
    severity: 'error',
    retryable: status >= 500
  }
}
