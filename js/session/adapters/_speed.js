/**
 * Service-speed lanes — catalog side.
 *
 * A lane is a named service speed a model sells, declared per catalog
 * entry under `speeds` with the price and rate-limit fields that
 * differ from the base entry. This module owns only what is common to
 * every provider: what the entry declares, and what that means for
 * pricing and throttling.
 *
 * How a lane reaches the wire, and how the served lane is read back,
 * is provider protocol and lives in the adapter. An adapter that
 * handles lanes advertises the names it accepts on `speedLanes`;
 * absence of that property is the declaration that it handles none,
 * and is what `run.js` checks before dispatch.
 *
 * @module session/adapters/_speed
 */

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
 * Whether `spec` declares `speed`. Uses `hasOwn` rather than
 * truthiness so a lane sold at base prices still counts.
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
 * Whether the lane declares a quota of its own, which is what earns it
 * a private rate-limit bucket. Lanes that don't (OpenAI's service_tier
 * shares the model's TPM/RPM pool) count against the base bucket —
 * giving them their own would silently double the allowance.
 *
 * @param {any} spec
 * @param {string} [speed]
 * @returns {boolean}
 */
export function speedHasOwnQuota (spec, speed) {
  if (!speed || !hasSpeed(spec, speed)) return false
  const overlay = spec.speeds[speed]
  return overlay.rpmLimit != null || overlay.tpmLimit != null
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
