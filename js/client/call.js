/**
 * Send a CallEnvelope to thin-gate; returns an async iterable of Events.
 *
 * Cancellation: pass an AbortSignal. Aborting closes the HTTP request;
 * thin-gate infers cancel from connection close and sends the session a
 * cancel control message. The session's own cancelled terminal is drained
 * gate-side, so the client synthesizes the same cancelled `done` here —
 * partial output from the deltas it relayed, zero tokens, zero cost —
 * giving a caller the same terminal on this path as on the in-process one.
 * @module client/call
 */

import { requestUnix } from './transport.js'
import { readAll, parseErrorBody } from './response.js'
import { parseNDJSON } from './ndjson.js'
import { isEvent, MohdelError, STATUS_INCOMPLETE, WARNING_CANCELLED } from '#core'

/**
 * @param {string} start
 * @param {string | null} first
 * @param {string} output
 * @returns {import('#core/events.js').DoneEvent}
 */
function cancelledDone (start, first, output) {
  const end = String(process.hrtime.bigint())
  return {
    type: 'done',
    result: {
      status: STATUS_INCOMPLETE,
      output: output || null,
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      cost: 0,
      timestamps: { start, first: first ?? end, end },
      warning: WARNING_CANCELLED
    }
  }
}

/**
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {object} options
 * @param {string} options.socketPath
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.path]  HTTP path; defaults to '/v1/call'
 * @returns {AsyncGenerator<import('#core/events.js').Event>}
 */
export async function * call (envelope, { socketPath, signal, path = '/v1/call' }) {
  const start = String(process.hrtime.bigint())
  if (signal?.aborted) {
    yield cancelledDone(start, null, '')
    return
  }

  let res
  try {
    res = await requestUnix({
      socketPath,
      path,
      method: 'POST',
      body: envelope,
      signal
    })
  } catch (e) {
    if (signal?.aborted) {
      yield cancelledDone(start, null, '')
      return
    }
    throw e
  }

  if (res.statusCode !== 200) {
    const body = await readAll(res)
    throw MohdelError.fromJSON(parseErrorBody(body, res.statusCode ?? 0))
  }

  const outputParts = []
  let first = null
  let sawTerminal = false
  try {
    for await (const obj of parseNDJSON(res)) {
      if (!isEvent(obj)) {
        throw new MohdelError(
          'received non-Event object from thin-gate',
          { type: 'PROTOCOL_INVALID_EVENT', retryable: false }
        )
      }
      if (obj.type === 'delta') {
        if (first === null) first = String(process.hrtime.bigint())
        if (obj.delta?.type === 'message') outputParts.push(obj.delta.delta)
      } else if (obj.type === 'done' || obj.type === 'error') {
        sawTerminal = true
      }
      yield /** @type {import('#core/events.js').Event} */(obj)
    }
  } catch (e) {
    if (!signal?.aborted) throw e
  }

  if (signal?.aborted && !sawTerminal) {
    yield cancelledDone(start, first, outputParts.join(''))
  }
}
