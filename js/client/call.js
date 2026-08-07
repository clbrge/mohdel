/**
 * Send a CallEnvelope to thin-gate; returns an async iterable of Events.
 *
 * Cancellation: pass an AbortSignal. Aborting destroys the HTTP request;
 * thin-gate infers cancel from connection close and emits
 * `call.cancelled` upstream.
 *
 * @module client/call
 */

import { requestUnix } from './transport.js'
import { readAll, parseErrorBody } from './response.js'
import { parseNDJSON } from './ndjson.js'
import { isEvent, MohdelError } from '#core'

/**
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {object} options
 * @param {string} options.socketPath
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.path]  HTTP path; defaults to '/v1/call'
 * @returns {AsyncGenerator<import('#core/events.js').Event>}
 */
export async function * call (envelope, { socketPath, signal, path = '/v1/call' }) {
  const res = await requestUnix({
    socketPath,
    path,
    method: 'POST',
    body: envelope,
    signal
  })

  if (res.statusCode !== 200) {
    const body = await readAll(res)
    throw MohdelError.fromJSON(parseErrorBody(body, res.statusCode ?? 0))
  }

  for await (const obj of parseNDJSON(res)) {
    if (!isEvent(obj)) {
      throw new MohdelError(
        'received non-Event object from thin-gate',
        { type: 'PROTOCOL_INVALID_EVENT', retryable: false }
      )
    }
    yield /** @type {import('#core/events.js').Event} */(obj)
  }
}
