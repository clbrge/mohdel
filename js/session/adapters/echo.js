/**
 * Echo adapter — deterministic stub. Emits two message deltas and a
 * `done` event with a synthetic `AnswerResult`. Honors `signal` for
 * test-controlled cancellation.
 *
 * @module session/adapters/echo
 */

import { STATUS_COMPLETED } from '#core/status.js'

import { cancelledDone } from './_cancelled.js'

/**
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {{signal?: AbortSignal}} [deps]
 * @returns {AsyncGenerator<import('#core/events.js').Event>}
 */
export async function * echo (envelope, { signal } = {}) {
  const start = String(process.hrtime.bigint())
  let first = null
  let output = ''

  for (const delta of ['Hello', ', world.']) {
    if (signal?.aborted) {
      yield cancelledDone(start, first, envelope, output, 0, 0)
      return
    }
    if (first === null) first = String(process.hrtime.bigint())
    output += delta
    yield { type: 'delta', delta: { type: 'message', delta } }
  }

  if (signal?.aborted) {
    yield cancelledDone(start, first, envelope, output, 0, 0)
    return
  }

  const end = String(process.hrtime.bigint())
  yield {
    type: 'done',
    result: {
      status: STATUS_COMPLETED,
      output,
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      cost: 0,
      timestamps: { start, first: first ?? end, end }
    }
  }
}
