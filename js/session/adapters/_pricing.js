/**
 * Cost computation from curated catalog spec.
 *
 * Reads `inputPrice` / `outputPrice` / `thinkingPrice` from the
 * catalog spec (loaded via `_catalog.js`). Returns a single number
 * (USD) written to `AnswerResult.cost`. Unknown models or specs
 * without prices return `0` — graceful degradation.
 *
 * @module session/adapters/_pricing
 */

import { getSpec, setCatalog } from './_catalog.js'

/**
 * Pure cost computation from spec + usage.
 *
 * @param {any} spec  Catalog entry (with `inputPrice`/`outputPrice`/`thinkingPrice`),
 *                    or `undefined`.
 * @param {{inputTokens?: number, outputTokens?: number, thinkingTokens?: number}} usage
 * @returns {number}
 */
export function computeCost (spec, usage) {
  if (!spec) return 0
  const ip = spec.inputPrice
  const op = spec.outputPrice
  if (typeof ip !== 'number' || typeof op !== 'number') return 0
  const i = usage.inputTokens ?? 0
  const o = usage.outputTokens ?? 0
  const t = usage.thinkingTokens ?? 0
  const tp = typeof spec.thinkingPrice === 'number' ? spec.thinkingPrice : op
  const total = (i * ip + o * op + t * tp) / 1_000_000
  return round(total)
}

/**
 * @param {string} model  Fully-qualified `<provider>/<model>`.
 * @param {{inputTokens?: number, outputTokens?: number, thinkingTokens?: number}} usage
 * @returns {number}
 */
export function costFor (model, usage) {
  return computeCost(getSpec(model), usage)
}

/**
 * Test convenience: inject pricing-only specs by model id. Wraps
 * `setCatalog` with the `{input, output, thinking?}` shape used in
 * existing tests, translating to spec fields.
 *
 * @param {Record<string, {input: number, output: number, thinking?: number}>} table
 */
export function setPricing (table) {
  /** @type {Record<string, any>} */
  const wrapped = {}
  for (const [k, v] of Object.entries(table)) {
    wrapped[k] = {
      inputPrice: v.input,
      outputPrice: v.output,
      ...(v.thinking != null && { thinkingPrice: v.thinking })
    }
  }
  setCatalog(wrapped)
}

/** @param {number} n */
function round (n) {
  return Math.round(n * 1e6) / 1e6
}
