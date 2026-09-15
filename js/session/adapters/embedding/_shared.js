/**
 * Pieces every embedding adapter needs: the pre-dispatch checks that turn a
 * provider's per-model limits into an error before a request is sent, and the
 * envelope-to-provider translation of `inputType`.
 *
 * These fail rather than drop. A `dimensions` the model ignores, or an
 * `inputType` silently discarded, both produce vectors that look fine and
 * retrieve badly, which is the failure mohdel exists to prevent.
 *
 * @module session/adapters/embedding/shared
 */

import { typedError } from '../_errors.js'

/**
 * @param {import('#core/embedding.js').EmbedEnvelope} envelope
 * @param {any} spec
 */
export function checkBatch (envelope, spec) {
  const input = envelope.input
  if (!Array.isArray(input) || input.length === 0) {
    throw typedError('embed requires a non-empty input array', 'EMBED_INPUT_EMPTY', false)
  }
  if (input.some(t => typeof t !== 'string')) {
    throw typedError('embed input must be strings', 'EMBED_INPUT_INVALID', false)
  }
  const max = spec?.maxBatch
  if (typeof max === 'number' && input.length > max) {
    throw typedError(
      `${input.length} inputs exceeds this model's batch limit of ${max}`,
      'EMBED_BATCH_TOO_LARGE',
      false
    )
  }
}

/**
 * @param {import('#core/embedding.js').EmbedEnvelope} envelope
 * @param {any} spec
 * @returns {number | undefined}
 */
export function checkDimensions (envelope, spec) {
  const wanted = envelope.dimensions
  if (wanted === undefined) return undefined
  if (!spec?.dimensionsSelectable) {
    throw typedError(
      'this model returns a fixed vector width; remove `dimensions`',
      'EMBED_DIMENSIONS_UNSUPPORTED',
      false
    )
  }
  return wanted
}

/**
 * Symbolic role to the provider's own vocabulary. The entry owns the mapping,
 * the same way `thinkingEffortLevels` owns thinking budgets.
 *
 * @param {import('#core/embedding.js').EmbedEnvelope} envelope
 * @param {any} spec
 * @returns {string | null}
 */
export function resolveInputType (envelope, spec) {
  const table = spec?.inputTypes
  const wanted = envelope.inputType ?? spec?.defaultInputType ?? null
  if (wanted === null) return null

  if (!table || typeof table !== 'object') {
    throw typedError(
      'this model declares no inputTypes; remove `inputType`',
      'EMBED_INPUT_TYPE_UNSUPPORTED',
      false
    )
  }
  const native = table[wanted]
  if (typeof native !== 'string') {
    throw typedError(
      `inputType '${wanted}' is not declared for this model; known: ${Object.keys(table).join(', ')}`,
      'EMBED_INPUT_TYPE_UNKNOWN',
      false
    )
  }
  return native
}

/**
 * @param {number[][]} vectors
 * @returns {number}
 */
export function widthOf (vectors) {
  return vectors.length && Array.isArray(vectors[0]) ? vectors[0].length : 0
}
