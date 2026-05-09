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
import { catalogKey } from '#core/model-id.js'

/**
 * @param {string} start       hrtime-bigint-as-string at call entry
 * @param {string | null} first  first-token hrtime, or null if never streamed
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {string} output
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {{cacheWriteInputTokens?: number, cacheReadInputTokens?: number}} [extra]
 *   Optional cache token counts captured before cancellation. Threaded through
 *   so the cancellation-cost calculation prices any cache writes/reads that
 *   already happened before the abort.
 * @returns {import('#core/events.js').DoneEvent}
 */
export function cancelledDone (start, first, envelope, output, inputTokens, outputTokens, extra = {}) {
  const end = String(process.hrtime.bigint())
  const cacheWriteInputTokens = extra.cacheWriteInputTokens || 0
  const cacheReadInputTokens = extra.cacheReadInputTokens || 0
  return {
    type: 'done',
    result: {
      status: STATUS_INCOMPLETE,
      output: output || null,
      inputTokens,
      outputTokens,
      thinkingTokens: 0,
      ...(cacheWriteInputTokens > 0 && { cacheWriteInputTokens }),
      ...(cacheReadInputTokens > 0 && { cacheReadInputTokens }),
      cost: costFor(
        catalogKey(envelope.model),
        { inputTokens, outputTokens, thinkingTokens: 0, cacheWriteInputTokens, cacheReadInputTokens }
      ),
      timestamps: { start, first: first ?? end, end },
      warning: WARNING_CANCELLED
    }
  }
}
