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
import { parseNDJSON } from './ndjson.js'
import { isEvent, MohdelTypedError } from '#core'

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
    throw MohdelTypedError.fromJSON(parseErrorBody(body, res.statusCode ?? 0))
  }

  for await (const obj of parseNDJSON(res)) {
    if (!isEvent(obj)) {
      throw new MohdelTypedError(
        'received non-Event object from thin-gate',
        { type: 'PROTOCOL_INVALID_EVENT', retryable: false }
      )
    }
    yield /** @type {import('#core/events.js').Event} */(obj)
  }
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
