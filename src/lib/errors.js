export const Severity = Object.freeze({
  TRACE: Symbol('TRACE'),
  DEBUG: Symbol('DEBUG'),
  INFO: Symbol('INFO'),
  WARN: Symbol('WARN'),
  ERROR: Symbol('ERROR'),
  FATAL: Symbol('FATAL')
})

export const getSeverityNumber = (severitySymbol) => {
  switch (severitySymbol) {
    case Severity.TRACE:
      return 1
    case Severity.DEBUG:
      return 5
    case Severity.INFO:
      return 9
    case Severity.WARN:
      return 13
    case Severity.ERROR:
      return 17
    case Severity.FATAL:
      return 21
    default:
      throw new Error(`[mohdel] unknown severity symbol: ${String(severitySymbol)}`)
  }
}

// NOTE used to mock upstream Error
export class APIError extends Error {
  constructor (message, status = 500) {
    super(message)
    this.name = 'APIError'
    this.status = status
  }
}

// usually Severity at least info
export class MohdelError extends Error {
  constructor (
    message,
    { cause, severity, detail, context, component = 'inference', retryable = false, silent = false } = {}
  ) {
    super(message, { cause })
    this.name = 'MohdelError'
    this.severity = severity
    this.detail = detail
    this.context = context
    this.component = component
    this.retryable = retryable
    this.silent = silent
  }
}

// Convert any error to the serialized transport shape. Duck-types on
// `detail` to distinguish typed errors (MohdelError) from plain Error.
export const toTransportError = (err, span) => {
  const isTyped = err.detail !== undefined
  return {
    message: isTyped ? err.message : 'UNEXPECTED_ERROR',
    detail: isTyped ? err.detail : 'An unexpected error occurred',
    trace: span?.spanContext()?.traceId,
    component: err.component || undefined,
    context: err.context || undefined,
    retryable: err.retryable ?? false,
    silent: err.silent ?? false
  }
}

export const retryableWarn = (err, detail) => {
  return {
    message: 'PROVIDER_OVERLOADED',
    severity: Severity.WARN,
    retryable: true,
    detail,
    cause: err
  }
}
export const reportRetryable = (err, provider, detail) => {
  detail ||= `**An unexpected error occurred**: ${provider}'s API failed to respond. Try again or switch to a different model. If the issue persists, please contact support and provide the Trace ID.`
  return {
    message: 'PROVIDER_RETRYABLE_ERROR',
    severity: Severity.ERROR,
    detail,
    retryable: true,
    cause: err
  }
}

export const reportDefault = (err, provider) => {
  return {
    message: 'PROVIDER_ERROR',
    severity: Severity.ERROR,
    detail: `**An unexpected error occurred**: ${provider}'s API failed to respond. Try switching to a different model or please contact support and provide the Trace ID.`,
    retryable: isConnectionError(err),
    cause: err
  }
}

export const reportContextOverflow = (err, provider) => {
  return {
    message: 'CONTEXT_OVERFLOW',
    severity: Severity.WARN,
    detail: `The prompt exceeds ${provider}'s context limit. Reduce input or switch to a larger context model.`,
    retryable: false,
    cause: err
  }
}

export function isContextOverflowMessage (errMessage) {
  const msg = (errMessage || '').toLowerCase()
  if (msg.includes('context_length') || msg.includes('context length')) return true
  if (msg.includes('token limit') || msg.includes('too long') || msg.includes('too many tokens')) return true
  if (msg.includes('maximum context') || msg.includes('prompt is too long')) return true
  if (msg.includes('max_tokens') && msg.includes('exceed')) return true
  return false
}

function isConnectionError (err) {
  const code = err?.code || err?.cause?.code
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' ||
      code === 'EPIPE' || code === 'ENOTFOUND' || code === 'UND_ERR_CONNECT_TIMEOUT') return true
  const msg = (err?.message || '').toLowerCase()
  if (msg.includes('fetch failed') || msg.includes('socket hang up') || msg.includes('network')) return true
  return false
}
