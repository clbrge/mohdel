/**
 * Ask thin-gate's `POST /v1/info` for the catalog entry a call with
 * `model` would run on.
 *
 * One-shot: a single JSON response body, the entry or `null` when the
 * gate's catalog has none. A lane the entry cannot take (an effort or
 * speed it does not declare) is the session's typed error.
 *
 * @module client/call_info
 */

import { requestUnix } from './transport.js'
import { readAll, parseErrorBody } from './response.js'
import { MohdelError } from '#core'

/**
 * @param {string} model  `<provider>/<id>[:effort][@speed]`
 * @param {object} options
 * @param {string} options.socketPath
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.path]  HTTP path; defaults to '/v1/info'
 * @param {Record<string, string>} [options.headers]  sent with the request, for a router in front of the gate;
 *   `content-type`, `content-length`, `transfer-encoding`, `connection` and `host` are the transport's
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function callInfo (model, { socketPath, signal, path = '/v1/info', headers }) {
  const res = await requestUnix({
    socketPath,
    path,
    method: 'POST',
    body: { model },
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
    throw new MohdelError(`gate returned an unparseable catalog entry: ${body.slice(0, 200)}`, {
      type: 'PROTOCOL_INVALID_RESPONSE',
      severity: 'error',
      retryable: false
    })
  }
}
