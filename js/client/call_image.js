/**
 * Send an ImageEnvelope to thin-gate's `POST /v1/image`.
 *
 * Image generation is one-shot: single JSON response body, no
 * streaming, no cooldown/rate-limit.
 *
 * @module client/call_image
 */

import { requestUnix } from './transport.js'
import { MohdelTypedError } from '#core'

/**
 * @param {import('#core/image.js').ImageEnvelope} envelope
 * @param {object} options
 * @param {string} options.socketPath
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.path]  HTTP path; defaults to '/v1/image'
 * @returns {Promise<import('#core/image.js').ImageResult>}
 */
export async function callImage (envelope, { socketPath, signal, path = '/v1/image' }) {
  const res = await requestUnix({
    socketPath,
    path,
    method: 'POST',
    body: envelope,
    signal
  })

  const body = await readAll(res)

  if (res.statusCode !== 200) {
    throw MohdelTypedError.fromJSON(parseErrorBody(body, res.statusCode ?? 0))
  }

  let parsed
  try {
    parsed = JSON.parse(body)
  } catch (e) {
    throw new MohdelTypedError(
      'thin-gate returned non-JSON image response',
      { type: 'PROTOCOL_INVALID_EVENT', retryable: false }
    )
  }

  if (!parsed || typeof parsed !== 'object' || parsed.status !== 'completed' || !Array.isArray(parsed.images)) {
    throw new MohdelTypedError(
      'thin-gate returned malformed ImageResult',
      { type: 'PROTOCOL_INVALID_EVENT', retryable: false }
    )
  }
  return parsed
}

/**
 * @param {AsyncIterable<Buffer|string>} stream
 * @returns {Promise<string>}
 */
async function readAll (stream) {
  let s = ''
  for await (const c of stream) s += typeof c === 'string' ? c : c.toString('utf8')
  return s
}

/**
 * @param {string} body
 * @param {number} status
 * @returns {import('#core/errors.js').TypedError}
 */
function parseErrorBody (body, status) {
  try {
    const parsed = JSON.parse(body)
    if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
      return parsed
    }
  } catch {}
  return {
    type: 'PROTOCOL_HTTP_ERROR',
    message: `thin-gate returned HTTP ${status}`,
    retryable: status >= 500
  }
}
