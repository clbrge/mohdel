/**
 * Send an EvaluateEnvelope to thin-gate's `POST /v1/evaluate`. One-shot: a
 * single JSON response body.
 *
 * @module client/call_evaluation
 */

import { requestUnix } from './transport.js'
import { readAll, parseErrorBody } from './response.js'
import { MohdelError } from '#core'

/**
 * @param {import('#core/evaluation.js').EvaluateEnvelope} envelope
 * @param {object} options
 * @param {string} options.socketPath
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.path]  HTTP path; defaults to '/v1/evaluate'
 * @param {Record<string, string>} [options.headers]  sent with the request, for a router in front of the gate;
 *   `content-type`, `content-length`, `transfer-encoding`, `connection` and `host` are the transport's
 * @returns {Promise<import('#core/evaluation.js').EvaluateResult>}
 */
export async function callEvaluation (envelope, { socketPath, signal, path = '/v1/evaluate', headers }) {
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

  try {
    return JSON.parse(body)
  } catch (e) {
    throw new MohdelError(`gate returned an unparseable evaluate body: ${body.slice(0, 200)}`, {
      type: 'PROTOCOL_INVALID_RESPONSE',
      severity: 'error',
      retryable: false
    })
  }
}
