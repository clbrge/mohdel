/**
 * Send an EmbedEnvelope to thin-gate's `POST /v1/embed`.
 *
 * One-shot: a single JSON response body, no streaming, no cooldown or
 * rate-limit. One call carries N inputs and returns N vectors in request
 * order; the gate never splits a batch, so a batch larger than the model's
 * `maxBatch` comes back as an error rather than as several calls.
 *
 * @module client/call_embedding
 */

import { requestUnix } from './transport.js'
import { readAll, parseErrorBody } from './response.js'
import { MohdelError } from '#core'

/**
 * @param {import('#core/embedding.js').EmbedEnvelope} envelope
 * @param {object} options
 * @param {string} options.socketPath
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.path]  HTTP path; defaults to '/v1/embed'
 * @returns {Promise<import('#core/embedding.js').EmbedResult>}
 */
export async function callEmbedding (envelope, { socketPath, signal, path = '/v1/embed' }) {
  const res = await requestUnix({
    socketPath,
    path,
    method: 'POST',
    body: envelope,
    signal
  })

  const body = await readAll(res)

  if (res.statusCode !== 200) {
    throw MohdelError.fromJSON(parseErrorBody(body, res.statusCode ?? 0))
  }

  let parsed
  try {
    parsed = JSON.parse(body)
  } catch (e) {
    throw new MohdelError(`gate returned an unparseable embed body: ${body.slice(0, 200)}`, {
      type: 'PROTOCOL_INVALID_RESPONSE',
      severity: 'error',
      retryable: false
    })
  }
  return parsed
}
