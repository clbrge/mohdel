/**
 * Session-process logger.
 *
 * Minimal pino-shape writer with no pino dependency. Writes one
 * newline-delimited JSON object per call to **stderr** — stdout is
 * reserved for the NDJSON event stream. Every line carries the
 * log level, subsystem message, and any structured fields the caller
 * included (including `traceId` / `spanId` for SigNoz / Jaeger /
 * Honeycomb correlation).
 *
 * Verbosity tier (`MOHDEL_VERBOSITY`, 0/1/2) matches the LOGGING.md
 * spec. Level gate (`MOHDEL_LOG_LEVEL`, one of trace/debug/info/warn/
 * error/fatal/silent) is the standard severity filter applied on top
 * of the tier.
 *
 * @module session/logger
 */

const LEVELS = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: 100
}

// Real sessions want "warn" (anomalies visible) but tests would
// otherwise flood stderr with the lines we deliberately induce.
// Under vitest, default to silent unless MOHDEL_LOG_LEVEL is set
// explicitly.
const DEFAULT_LEVEL = process.env.VITEST ? 'silent' : 'warn'
const DEFAULT_VERBOSITY = 1

function envInt (name, fallback) {
  const v = process.env[name]
  if (!v) return fallback
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

function envLevel (name, fallback) {
  const v = process.env[name]
  if (!v) return fallback
  const k = String(v).toLowerCase()
  return Object.prototype.hasOwnProperty.call(LEVELS, k) ? k : fallback
}

/**
 * @param {{level?: string, verbosity?: number, stream?: NodeJS.WritableStream, context?: object}} [opts]
 */
export function createLogger (opts = {}) {
  const level = opts.level ?? envLevel('MOHDEL_LOG_LEVEL', DEFAULT_LEVEL)
  const verbosity = opts.verbosity ?? envInt('MOHDEL_VERBOSITY', DEFAULT_VERBOSITY)
  const stream = opts.stream ?? process.stderr
  const baseContext = { ...(opts.context ?? {}) }
  const threshold = LEVELS[level] ?? LEVELS[DEFAULT_LEVEL]

  const emit = (lvl, firstArg, msg) => {
    if (LEVELS[lvl] < threshold) return
    const line = { level: lvl, time: Date.now(), ...baseContext }
    if (typeof firstArg === 'string') {
      line.msg = firstArg
    } else if (firstArg && typeof firstArg === 'object') {
      // Stack traces can harbor sensitive data from some SDKs (tokens,
      // request bodies passed into Error constructors). Keep them only
      // at the verbose levels (trace/debug), which are off by default
      // in production.
      mergeFields(line, firstArg, LEVELS[lvl] <= LEVELS.debug)
      if (msg !== undefined) line.msg = msg
    }
    try {
      stream.write(JSON.stringify(line) + '\n')
    } catch {
      // swallow: stderr write failures must not take down the session
    }
  }

  const trace = (fields, msg) => emit('trace', fields, msg)
  const debug = (fields, msg) => emit('debug', fields, msg)
  const info = (fields, msg) => emit('info', fields, msg)
  const warn = (fields, msg) => emit('warn', fields, msg)
  const error = (fields, msg) => emit('error', fields, msg)
  const fatal = (fields, msg) => emit('fatal', fields, msg)

  /**
   * @param {object} extra
   */
  const withContext = (extra) => createLogger({
    level,
    verbosity,
    stream,
    context: { ...baseContext, ...extra }
  })

  return Object.freeze({
    level,
    verbosity,
    trace,
    debug,
    info,
    warn,
    error,
    fatal,
    withContext
  })
}

/**
 * Merge structured log fields. Errors are flattened to a stable shape
 * so `JSON.stringify` doesn't drop the message.
 *
 * @param {object} target
 * @param {object} source
 * @param {boolean} includeStack
 */
function mergeFields (target, source, includeStack) {
  for (const [k, v] of Object.entries(source)) {
    if (v instanceof Error) {
      target[k] = {
        message: v.message,
        name: v.name,
        ...(includeStack && v.stack ? { stack: v.stack } : {}),
        ...(v.code ? { code: v.code } : {}),
        ...(v.status ? { status: v.status } : {})
      }
    } else {
      target[k] = v
    }
  }
}

// Module-level default — used when a caller doesn't pass their own.
// Keeping the stream open lets adapters import the singleton
// directly; `withContext` spawns scoped children per call without
// allocating a new writer.
export const logger = createLogger()
