import providers from './providers.js'
import { validate, isValidTag, stripComputed } from './schema.js'
import { isMetaKey, catalogEntries } from './common.js'
import { SPEED_LANES } from '../../js/session/adapters/_registry.js'
import { catalogKey } from '../../js/core/model-id.js'

const sortDeep = (value) => {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value && typeof value === 'object') {
    const sorted = {}
    for (const key of Object.keys(value).sort()) sorted[key] = sortDeep(value[key])
    return sorted
  }
  return value
}

const same = (a, b) => JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b))

const TYPE_OF = (value) => Array.isArray(value) ? 'array' : typeof value

const reviewLocal = (key, spec, local) => {
  const errors = []
  const warnings = []

  for (const [field, def] of Object.entries(local.fields)) {
    const value = spec[field]
    if (value === undefined) continue
    if (TYPE_OF(value) !== def.type) {
      errors.push(`${key}: ${field} — expected ${def.type}, got ${TYPE_OF(value)} (local field)`)
    }
  }

  for (const tag of spec.tags || []) {
    const def = local.tags[tag]
    if (!def) continue
    const missing = def.requires.filter(field => spec[field] === undefined)
    if (!missing.length) continue
    const message = `${key}: tag '${tag}' requires ${missing.join(', ')} — ${def.description}`
    if (def.severity === 'error') errors.push(message)
    else warnings.push(message)
  }

  return { errors, warnings }
}

export const reviewEntry = (key, spec, catalog, { strict = false, local = null } = {}) => {
  const errors = []
  const warnings = []
  const [keyProvider] = key.split('/')

  if (catalogKey(key) !== key) {
    errors.push(`${key}: catalog key carries a ':effort' or '@speed' suffix — those are call-time, not entry keys`)
  }

  if (spec.deprecated) {
    if (!catalog[spec.deprecated]) {
      errors.push(`${key}: deprecated target '${spec.deprecated}' not in curated`)
    }
    return { errors, warnings }
  }

  for (const issue of validate(spec, key, { strict })) {
    // Custom fields are namespaced by convention (docs/CATALOG.md) and
    // round-trip untouched, so they are not drift.
    if (issue.message === 'unknown field' && issue.field.includes(':')) continue
    if (issue.message === 'unknown field' && local?.fields[issue.field]) continue
    if (issue.severity === 'error') errors.push(`${key}: ${issue.field} — ${issue.message}`)
    else warnings.push(`${key}: ${issue.field} — ${issue.message}`)
  }

  const providerConfig = providers[keyProvider]
  if (!providerConfig) {
    errors.push(`${key}: provider '${keyProvider}' not in providers.js`)
  }
  if (spec.provider && spec.provider !== keyProvider) {
    errors.push(`${key}: spec.provider '${spec.provider}' doesn't match key prefix '${keyProvider}'`)
  }
  if (providerConfig && spec.sdk && spec.sdk !== providerConfig.sdk) {
    errors.push(`${key}: spec.sdk '${spec.sdk}' doesn't match provider sdk '${providerConfig.sdk}'`)
  }

  if (!spec.label) warnings.push(`${key}: missing label`)

  for (const priceField of ['inputPrice', 'outputPrice', 'thinkingPrice']) {
    const val = spec[priceField]
    if (val != null && typeof val === 'object' && val.default == null) {
      errors.push(`${key}: ${priceField} is tiered but missing 'default' key`)
    }
  }

  if (spec.thinkingEffortLevels && !spec.defaultThinkingEffort) {
    warnings.push(`${key}: has thinkingEffortLevels but no defaultThinkingEffort`)
  }

  const lanes = SPEED_LANES[keyProvider]
  for (const [lane, overlay] of Object.entries(spec.speeds || {})) {
    if (!lanes?.has(lane)) {
      const detail = lanes ? `accepts: ${[...lanes].join(', ')}` : 'implements no speed lanes'
      errors.push(`${key}: speeds.${lane} — provider '${keyProvider}' ${detail}; calls on that lane would fail at dispatch`)
    }
    for (const priceField of ['inputPrice', 'outputPrice', 'thinkingPrice']) {
      const val = overlay[priceField]
      if (val != null && typeof val === 'object' && val.default == null) {
        errors.push(`${key}: speeds.${lane}.${priceField} is tiered but missing 'default' key`)
      }
    }
    const priced = ['inputPrice', 'outputPrice'].some(f => overlay[f] != null)
    if (!priced) {
      warnings.push(`${key}: speeds.${lane} restates no prices — the lane will bill at base rates`)
    }
  }

  if (Array.isArray(spec.tags)) {
    for (const t of spec.tags) {
      if (!isValidTag(t)) warnings.push(`${key}: invalid tag "${t}" — must match /^[a-zA-Z][a-zA-Z0-9._-]{0,31}$/`)
    }
  }

  if (local) {
    const localIssues = reviewLocal(key, spec, local)
    errors.push(...localIssues.errors)
    warnings.push(...localIssues.warnings)
  }

  return { errors, warnings }
}

export const reviewCatalog = (catalog, { local = null } = {}) => {
  const errors = []
  const warnings = []
  for (const [key, spec] of catalogEntries(catalog)) {
    const entry = reviewEntry(key, spec, catalog, { local })
    errors.push(...entry.errors)
    warnings.push(...entry.warnings)
  }
  return { errors, warnings }
}

export const diffEntry = (before, after) => {
  const from = before ? stripComputed(before) : {}
  const to = stripComputed(after)
  const fields = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort()
  const changes = []
  for (const field of fields) {
    if (same(from[field], to[field])) continue
    changes.push({ field, from: from[field], to: to[field] })
  }
  return changes
}

export const parseCandidates = (text) => {
  let doc
  try {
    doc = JSON.parse(text)
  } catch (e) {
    throw new Error(`candidate is not valid JSON: ${e.message}`)
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('candidate must be a JSON object keyed by model id: { "<provider>/<model>": { … } }')
  }

  const entries = {}
  const ignored = []
  for (const [key, value] of Object.entries(doc)) {
    if (isMetaKey(key)) {
      ignored.push(key)
      continue
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      const got = Array.isArray(value) ? 'array' : typeof value
      throw new Error(`'${key}' maps to a ${got}, not an entry object — the shape is { "<provider>/<model>": { … } }`)
    }
    entries[key] = value
  }
  if (!Object.keys(entries).length) {
    throw new Error('candidate contains no entries')
  }
  return { entries, ignored }
}

export const reviewCandidates = (catalog, entries, { local = null } = {}) => {
  const merged = { ...catalog, ...entries }
  return Object.entries(entries).map(([key, entry]) => {
    const { errors, warnings } = reviewEntry(key, entry, merged, { strict: true, local })
    const existing = catalog[key]
    const changes = diffEntry(existing, entry)
    return {
      key,
      status: existing ? (changes.length ? 'changed' : 'unchanged') : 'new',
      errors,
      warnings,
      changes
    }
  })
}
