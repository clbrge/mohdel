const fieldDefs = {
  model: { type: 'string', required: true },
  provider: { type: 'string' },
  sdk: { type: 'string' },
  type: { type: 'string', default: 'model' },
  creator: { type: 'string', required: true },
  label: { type: 'string' },
  displayName: { type: 'string', deprecated: 'use label instead' },
  description: { type: 'string' },
  inputPrice: { type: 'number', altType: 'object' },
  outputPrice: { type: 'number', altType: 'object' },
  thinkingPrice: { type: 'number', altType: 'object' },
  contextTokenLimit: { type: 'number' },
  outputTokenLimit: { type: 'number' },
  thinkingTokenLimit: { type: 'number' },
  thinkingEffortLevels: { type: 'object', nullable: true, default: null },
  defaultThinkingEffort: { type: 'string' },
  tags: { type: 'array', itemType: 'string', default: [] },
  aliases: { type: 'array', itemType: 'string', default: [] },
  replaces: { type: 'array', itemType: 'string', default: [] },
  leaderboard: { type: 'array', itemType: 'number', validate: (v) => Array.isArray(v) && v.length === 3 ? null : 'must be [intelligence, speed, latency]' },
  leaderboardNote: { type: 'string' },
  inputFormat: { type: 'array', itemType: 'string', required: true, default: ['text'] },
  version: { type: 'string' },
  createdAt: { type: 'string' },
  created: { type: 'number' },
  imagePrice: { type: 'number' },
  imageEndpoint: { type: 'string' },
  imageDefaultSize: { type: 'string' },
  transcriptionPrice: { type: 'number' },
  deprecated: { type: 'string' },
  suspended: { type: 'string' },
  rpmLimit: { type: 'number' },
  tpmLimit: { type: 'number' },
  rateLimitScope: { type: 'string', validate: (v) => ['model', 'provider'].includes(v) ? null : 'must be "model" or "provider"' },
  supportsTools: { type: 'boolean' }
}

const knownFields = new Set(Object.keys(fieldDefs))

const COMPUTED_FIELDS = new Set(['upstreamIds'])

const TYPE_CHECKERS = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number',
  array: (v) => Array.isArray(v),
  object: (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
}

const checkType = (value, def) => {
  if (value === null && def.nullable) return true
  const checker = TYPE_CHECKERS[def.type]
  if (checker && checker(value)) return true
  if (def.altType) {
    const altChecker = TYPE_CHECKERS[def.altType]
    if (altChecker && altChecker(value)) return true
  }
  return false
}

const validate = (entry, curatedKey, { strict = false } = {}) => {
  const issues = []
  const isDeprecatedStub = !!entry.deprecated

  for (const [field, def] of Object.entries(fieldDefs)) {
    const value = entry[field]

    if (def.required && !isDeprecatedStub && (value === undefined || value === null || value === '')) {
      issues.push({ field, message: 'required field missing', severity: 'error' })
      continue
    }

    if (value === undefined) continue

    if (!checkType(value, def)) {
      issues.push({ field, message: `expected ${def.type}, got ${typeof value}`, severity: 'error' })
      continue
    }

    if (def.deprecated) {
      issues.push({ field, message: `deprecated: ${def.deprecated}`, severity: 'warn' })
    }

    if (def.validate) {
      const msg = def.validate(value)
      if (msg) {
        issues.push({ field, message: msg, severity: 'warn' })
      }
    }

    if (def.type === 'array' && def.itemType && Array.isArray(value)) {
      const itemChecker = TYPE_CHECKERS[def.itemType]
      if (itemChecker) {
        for (let i = 0; i < value.length; i++) {
          if (!itemChecker(value[i])) {
            issues.push({ field, message: `item ${i} expected ${def.itemType}, got ${typeof value[i]}`, severity: 'warn' })
            break
          }
        }
      }
    }
  }

  if (strict) {
    for (const key of Object.keys(entry)) {
      if (!knownFields.has(key) && !COMPUTED_FIELDS.has(key)) {
        issues.push({ field: key, message: 'unknown field', severity: 'warn' })
      }
    }
  }

  return issues
}

const applyDefaults = (entry) => {
  const result = { ...entry }
  for (const [field, def] of Object.entries(fieldDefs)) {
    if (result[field] === undefined && def.default !== undefined) {
      result[field] = Array.isArray(def.default) ? [...def.default] : def.default
    }
  }
  return result
}

const stripComputed = (entry) => {
  const result = {}
  for (const [key, value] of Object.entries(entry)) {
    if (!COMPUTED_FIELDS.has(key)) {
      result[key] = value
    }
  }
  return result
}

// Strip only computed fields. Custom fields (not in knownFields) are preserved —
// consumers own their own namespace (e.g. `<yourapp>:label`,
// `<yourapp>:billingKey`).
const stripUnknown = (entry) => {
  const result = {}
  for (const [key, value] of Object.entries(entry)) {
    if (!COMPUTED_FIELDS.has(key)) {
      result[key] = value
    }
  }
  return result
}

const TAG_RE = /^[a-zA-Z][a-zA-Z0-9._-]{0,31}$/
const isValidTag = (tag) => typeof tag === 'string' && TAG_RE.test(tag)

export { fieldDefs, knownFields, validate, applyDefaults, stripComputed, stripUnknown, isValidTag }
