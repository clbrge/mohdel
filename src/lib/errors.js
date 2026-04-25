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
