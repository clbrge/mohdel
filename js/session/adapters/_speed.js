/**
 * Service-speed lanes.
 *
 * A lane is a provider request parameter that buys a different
 * speed/price point for the same weights (Anthropic `speed: "fast"`).
 * Lanes are declared per catalog entry under `speeds`, keyed by lane
 * name, each carrying the wire value plus any price and rate-limit
 * fields that differ from the base entry.
 *
 * Two declarations must agree for a lane to be usable: the entry
 * declares it (`spec.speeds`) and the provider's adapter can emit it
 * (`SPEED_PARAMS`). `run.js` checks both before dispatch.
 *
 * @module session/adapters/_speed
 */

import { providerOf } from '#core/model-id.js'

/**
 * Providers whose adapter emits a lane parameter, mapped to the
 * native parameter name. Absence from this table is the declaration
 * that a provider has no lanes.
 */
export const SPEED_PARAMS = Object.freeze({
  anthropic: 'speed'
})

/** Spec fields a lane overlay may restate. */
export const SPEED_OVERRIDABLE = Object.freeze([
  'inputPrice',
  'outputPrice',
  'thinkingPrice',
  'cacheWritePrice',
  'cacheWrite1hPrice',
  'cacheReadPrice',
  'rpmLimit',
  'tpmLimit'
])

/**
 * @param {string} provider
 * @returns {boolean}
 */
export function providerSupportsSpeed (provider) {
  return Object.hasOwn(SPEED_PARAMS, provider)
}

/**
 * @param {string} provider
 * @returns {string | undefined}
 */
export function speedParamFor (provider) {
  return SPEED_PARAMS[provider]
}

/**
 * Whether `spec` declares `speed`. Uses `hasOwn` rather than
 * truthiness so an overlay that only carries `wire` still counts.
 *
 * @param {any} spec
 * @param {string} speed
 * @returns {boolean}
 */
export function hasSpeed (spec, speed) {
  return !!spec?.speeds && Object.hasOwn(spec.speeds, speed)
}

/**
 * @param {any} spec
 * @returns {string[]}
 */
export function speedNames (spec) {
  return spec?.speeds ? Object.keys(spec.speeds) : []
}

/**
 * Spec with `speed`'s overlay applied. Unnamed fields fall through to
 * the base entry.
 *
 * @param {any} spec
 * @param {string} [speed]
 * @returns {any}
 * @throws when `speed` is set and `spec` does not declare it
 */
export function mergeSpeed (spec, speed) {
  if (!speed) return spec
  if (!hasSpeed(spec, speed)) {
    throw new Error(`model does not declare speed lane '${speed}'`)
  }
  const overlay = spec.speeds[speed]
  const merged = { ...spec }
  for (const field of SPEED_OVERRIDABLE) {
    if (Object.hasOwn(overlay, field)) merged[field] = overlay[field]
  }
  return merged
}

/**
 * Set the provider-native lane parameter on an outbound request.
 * No-op when the envelope carries no lane.
 *
 * @param {Record<string, any>} request
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {any} spec
 * @throws when the envelope carries a lane the provider cannot emit
 *   or the spec does not declare
 */
export function applySpeed (request, envelope, spec) {
  if (!envelope.speed) return
  const provider = providerOf(envelope.model)
  const param = speedParamFor(provider)
  if (!param) {
    throw new Error(`provider '${provider}' does not implement speed lanes`)
  }
  if (!hasSpeed(spec, envelope.speed)) {
    throw new Error(`model does not declare speed lane '${envelope.speed}'`)
  }
  request[param] = spec.speeds[envelope.speed].wire
}
