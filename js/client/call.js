/**
 * Send a CallEnvelope to thin-gate; returns an async iterable of Events.
 *
 * Abort: pass an AbortSignal. Once the gate has answered, an abort
 * posts `/v1/abort` for this call and the stream keeps flowing until the
 * session's own aborted `done` — partial output and the usage reported
 * before the cut, as on the in-process path. That wait has no limit of
 * its own: to stop waiting, stop iterating, which abandons the call. An
 * abort before the gate answered drops the request instead; nothing has
 * been reported yet, so the client ends with an aborted `done` of its
 * own, zero usage.
 * @module client/call
 */

import { requestUnix } from './transport.js'
import { readAll, parseErrorBody } from './response.js'
import { parseNDJSON } from './ndjson.js'
import { isEvent, MohdelError, STATUS_INCOMPLETE, WARNING_ABORTED } from '#core'

const ABORT_PATH = '/v1/abort'
const GATE_HEADER = 'mohdel-gate'

/**
 * @param {string} start
 * @returns {import('#core/events.js').DoneEvent}
 */
function abortedDone (start) {
  const end = String(process.hrtime.bigint())
  return {
    type: 'done',
    result: {
      status: STATUS_INCOMPLETE,
      output: null,
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      cost: 0,
      timestamps: { start, first: end, end },
      warning: WARNING_ABORTED
    }
  }
}

/**
 * `CALL_NOT_FOUND` means the call ended before the abort reached it; its
 * terminal is already on the stream.
 *
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {string | string[] | undefined} gate  the call response's `mohdel-gate`
 * @param {string} socketPath
 * @param {Record<string, string> | undefined} headers
 */
async function requestAbort (envelope, gate, socketPath, headers) {
  if (typeof gate !== 'string') {
    throw new MohdelError(
      `the /v1/call response carries no ${GATE_HEADER} header`,
      { type: 'PROTOCOL_GATE_UNIDENTIFIED', retryable: false }
    )
  }
  const res = await requestUnix({
    socketPath,
    path: ABORT_PATH,
    method: 'POST',
    body: { callId: envelope.callId, authId: envelope.authId, gate },
    headers
  })
  const body = await readAll(res)
  if (res.statusCode === 202) return
  const error = parseErrorBody(body, res.statusCode ?? 0)
  if (error.type === 'CALL_NOT_FOUND') return
  throw MohdelError.fromJSON(error)
}

/**
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {object} options
 * @param {string} options.socketPath
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.path]  HTTP path; defaults to '/v1/call'
 * @param {Record<string, string>} [options.headers]  sent with the request and with its abort, for a router in
 *   front of the gate; `content-type`, `content-length`, `transfer-encoding`, `connection` and `host` are the transport's
 * @returns {AsyncGenerator<import('#core/events.js').Event>}
 */
export async function * call (envelope, { socketPath, signal, path = '/v1/call', headers }) {
  const start = String(process.hrtime.bigint())
  if (signal?.aborted) {
    yield abortedDone(start)
    return
  }

  let res
  try {
    res = await requestUnix({
      socketPath,
      path,
      method: 'POST',
      body: envelope,
      signal,
      headers
    })
  } catch (e) {
    if (signal?.aborted) {
      yield abortedDone(start)
      return
    }
    throw e
  }

  if (res.statusCode !== 200) {
    const body = await readAll(res)
    throw MohdelError.fromJSON(parseErrorBody(body, res.statusCode ?? 0))
  }

  /** @type {unknown} */
  let abortError = null
  let sawTerminal = false
  const onAbort = () => {
    if (sawTerminal) return
    requestAbort(envelope, res.headers[GATE_HEADER], socketPath, headers).catch((e) => {
      abortError = e
      res.destroy()
    })
  }
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })

  try {
    for await (const obj of parseNDJSON(res)) {
      if (!isEvent(obj)) {
        throw new MohdelError(
          'received non-Event object from thin-gate',
          { type: 'PROTOCOL_INVALID_EVENT', retryable: false }
        )
      }
      if (obj.type === 'done' || obj.type === 'error') sawTerminal = true
      yield /** @type {import('#core/events.js').Event} */(obj)
    }
  } catch (e) {
    throw abortError ?? e
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
  if (abortError) throw abortError
}
