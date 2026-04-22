/**
 * Shared `cancelledDone` helper for adapters that need to synthesize
 * a terminal `done` event on `signal.aborted` mid-stream.
 *
 * Three adapters (openai, anthropic, gemini) had byte-identical
 * copies of this before F58; consolidated here. `_chat_completions.js`
 * and `run.js` have their own cancel paths — don't migrate them
 * here unless you're certain the shape matches (thinkingTokens,
 * cost, tool_calls semantics can all differ).
 *
 * @module session/adapters/_cancelled
 */

import { STATUS_INCOMPLETE, WARNING_CANCELLED } from '#core/status.js'
import { costFor } from './_pricing.js'

/**
 * @param {string} start       hrtime-bigint-as-string at call entry
 * @param {string | null} first  first-token hrtime, or null if never streamed
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {string} output
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @returns {import('#core/events.js').DoneEvent}
 */
export function cancelledDone (start, first, envelope, output, inputTokens, outputTokens) {
  const end = String(process.hrtime.bigint())
  return {
    type: 'done',
    result: {
      status: STATUS_INCOMPLETE,
      output: output || null,
      inputTokens,
      outputTokens,
      thinkingTokens: 0,
      cost: costFor(
        `${envelope.provider}/${envelope.model}`,
        { inputTokens, outputTokens, thinkingTokens: 0 }
      ),
      timestamps: { start, first: first ?? end, end },
      warning: WARNING_CANCELLED
    }
  }
}
