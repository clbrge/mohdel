export const sanitizeOutput = str => {
  if (typeof str !== 'string') return str
  return str.replace(/\0/g, '\uFFFD').trim()
}

// Practical input ceiling for a model spec: catalog `contextTokenLimit`
// minus any empirically-derived `inputCeilingMargin` reserve the API
// silently steals (reasoning floor, structural overhead, pricing-tier
// cliffs). Reduces to `contextTokenLimit` when the margin field is
// unset. Consumers computing safe input budgets should call this in
// place of `spec.contextTokenLimit`.
export const effectiveContextLimit = spec => {
  if (!spec || spec.contextTokenLimit == null) return 0
  return Math.max(0, spec.contextTokenLimit - (spec.inputCeilingMargin ?? 0))
}

export const translateModelInfo = (model, infoTranslate = {}) => {
  if (!model || typeof model !== 'object') return model

  const result = { ...model }

  if (infoTranslate && Object.keys(infoTranslate).length) {
    for (const [source, target] of Object.entries(infoTranslate)) {
      if (source in result) {
        if (typeof target === 'function') {
          const [realtarget, realresult] = target(result[source])
          result[realtarget] = realresult
        } else {
          result[target] = result[source]
        }
        delete result[source]
      }
    }
  }

  const labelKeys = ['display_name', 'displayName']
  for (const key of labelKeys) {
    if (key in result) {
      result.label = result[key]
      delete result[key]
    }
  }

  return result
}

export const createRealtimeDeltaBuffer = (handler, opts = {}) => {
  const maxChars = opts.maxChars ?? 250
  const maxMs = opts.maxMs ?? 10_000
  let buffer = ''
  let lastType = 'message'
  let lastFlush = Date.now()

  const flushInternal = force => {
    if (!handler) return
    const now = Date.now()
    const shouldFlush = force || buffer.length >= maxChars || now - lastFlush >= maxMs
    if (shouldFlush && buffer) {
      handler({ type: lastType, delta: buffer })
      buffer = ''
      lastFlush = now
    }
  }

  const push = (type, delta) => {
    if (!handler || !delta) return
    lastType = type || lastType || 'message'
    buffer += delta
    flushInternal(false)
  }

  const flush = () => flushInternal(true)

  return { push, flush }
}

export const createTimingTracker = () => {
  const start = process.hrtime.bigint()
  let first = null

  const markFirst = () => {
    if (!first) first = process.hrtime.bigint()
  }

  const timestamps = () => {
    const end = process.hrtime.bigint()
    const firstValue = first || end
    return {
      start: start.toString(),
      first: firstValue.toString(),
      end: end.toString()
    }
  }

  return { markFirst, timestamps }
}
