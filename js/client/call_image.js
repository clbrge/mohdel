/**
 * Send an ImageEnvelope to thin-gate's `POST /v1/image`.
 *
 * Image generation is one-shot: single JSON response body, no
 * streaming, no cooldown/rate-limit.
 *
 * @module client/call_image
 */

import { requestUnix } from './transport.js'
import { readAll, parseErrorBody } from './response.js'
import { MohdelError } from '#core'

/**
 * @param {import('#core/image.js').ImageEnvelope} envelope
 * @param {object} options
 * @param {string} options.socketPath
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.path]  HTTP path; defaults to '/v1/image'
 * @param {Record<string, string>} [options.headers]  sent with the request, for a router in front of the gate;
 *   `content-type`, `content-length`, `transfer-encoding`, `connection` and `host` are the transport's
 * @returns {Promise<import('#core/image.js').ImageResult>}
 */
export async function callImage (envelope, { socketPath, signal, path = '/v1/image', headers }) {
  const res = await requestUnix({
    socketPath,
    path,
    method: 'POST',
    body: envelope,
    signal,
    headers
  })

  const body = await readAll(res)

  if (res.statusCode !== 200) {
    throw MohdelError.fromJSON(parseErrorBody(body, res.statusCode ?? 0))
  }

  let parsed
  try {
    parsed = JSON.parse(body)
  } catch (e) {
    throw new MohdelError(
      'thin-gate returned non-JSON image response',
      { type: 'PROTOCOL_INVALID_EVENT', retryable: false }
    )
  }

  if (!parsed || typeof parsed !== 'object' || parsed.status !== 'completed' || !Array.isArray(parsed.images)) {
    throw new MohdelError(
      'thin-gate returned malformed ImageResult',
      { type: 'PROTOCOL_INVALID_EVENT', retryable: false }
    )
  }
  return parsed
}
