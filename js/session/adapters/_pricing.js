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
 * Each price field (`inputPrice` / `outputPrice` / `thinkingPrice` /
 * `cacheWritePrice` / `cacheReadPrice`) is one of:
 *
 *   - a `number` — flat per-million rate; or
 *   - an object `{">N": number, ..., "default": number}` — tiered.
 *     The active rate is the one under the highest `>N` key that the
 *     call's `inputTokens` exceeds; falls back to `"default"` when
 *     nothing matches. Keys that aren't `">N"` or `"default"` are
 *     ignored. `>` is strict — at exactly N, the default is used.
 *
 * Optional fields fall back to other prices when absent:
 *   - `thinkingPrice` → `outputPrice`
 *   - `cacheWritePrice` → `inputPrice` (graceful for non-caching providers)
 *   - `cacheReadPrice` → `inputPrice`
 *
 * Token-counting convention: this function is purely additive across
 * `inputTokens`, `cacheWriteInputTokens`, `cacheReadInputTokens`,
 * `outputTokens`, and `thinkingTokens`. Adapters normalize provider-specific
 * shapes (e.g. subset-of-input vs. additional-to-input) before calling here.
 *
 * @param {any} spec  Catalog entry, or `undefined`.
 * @param {{inputTokens?: number, outputTokens?: number, thinkingTokens?: number,
 *          cacheWriteInputTokens?: number, cacheReadInputTokens?: number}} usage
 * @returns {number}
 */
export function computeCost (spec, usage) {
  if (!spec) return 0
  const i = usage.inputTokens ?? 0
  const o = usage.outputTokens ?? 0
  const t = usage.thinkingTokens ?? 0
  const cw = usage.cacheWriteInputTokens ?? 0
  const cr = usage.cacheReadInputTokens ?? 0
  const ip = resolveTier(spec.inputPrice, i)
  const op = resolveTier(spec.outputPrice, i)
  if (typeof ip !== 'number' || typeof op !== 'number') return 0
  const tp = resolveTier(spec.thinkingPrice, i)
  const tpFinal = typeof tp === 'number' ? tp : op
  const cwp = resolveTier(spec.cacheWritePrice, i)
  const cwpFinal = typeof cwp === 'number' ? cwp : ip
  const crp = resolveTier(spec.cacheReadPrice, i)
  const crpFinal = typeof crp === 'number' ? crp : ip
  const total = (i * ip + cw * cwpFinal + cr * crpFinal + o * op + t * tpFinal) / 1_000_000
  return round(total)
}

/**
 * Resolve a price field against a token count. Scalars pass through;
 * tiered maps return the rate of the highest `>N` key that
 * `tokens` exceeds, falling back to `default`. Returns `null` when
 * the field is absent or malformed — callers decide whether to treat
 * that as "no price" (cost=0) or fall back (thinkingPrice→outputPrice).
 *
 * @param {unknown} price
 * @param {number} tokens
 * @returns {number | null}
 */
function resolveTier (price, tokens) {
  if (typeof price === 'number') return price
  if (!price || typeof price !== 'object') return null
  let best = null
  let bestThreshold = -1
  for (const key of Object.keys(price)) {
    if (key === 'default') continue
    const m = /^>(\d+)$/.exec(key)
    if (!m) continue
    const threshold = Number(m[1])
    if (tokens > threshold && threshold > bestThreshold) {
      bestThreshold = threshold
      const v = /** @type {Record<string, unknown>} */ (price)[key]
      if (typeof v === 'number') best = v
    }
  }
  if (best != null) return best
  const d = /** @type {Record<string, unknown>} */ (price).default
  return typeof d === 'number' ? d : null
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
 * Cost of a transcription call.
 *
 * Providers bill speech-to-text two ways, and the catalog supports both:
 *
 *   - `transcriptionPrice` — flat USD per audio **minute** (Groq,
 *     Mistral; the industry quoting unit). Used when the provider
 *     reported the audio duration.
 *   - token pricing (`inputPrice`/`outputPrice`) — OpenAI's
 *     gpt-4o-*-transcribe models report token usage instead of
 *     duration; falls through to `computeCost`.
 *
 * Duration wins when both are available. Unknown models or specs
 * without prices return `0` — same graceful degradation as
 * `computeCost`.
 *
 * @param {any} spec  Catalog entry, or `undefined`.
 * @param {{durationSeconds?: number | null, inputTokens?: number, outputTokens?: number}} usage
 * @returns {number}
 */
export function computeTranscriptionCost (spec, usage) {
  if (!spec) return 0
  const seconds = usage.durationSeconds
  if (typeof seconds === 'number' && seconds > 0 && typeof spec.transcriptionPrice === 'number') {
    return round((seconds / 60) * spec.transcriptionPrice)
  }
  if (usage.inputTokens || usage.outputTokens) {
    return computeCost(spec, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens })
  }
  return 0
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
