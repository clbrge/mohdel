/**
 * Mohdel logger interface.
 *
 * Mohdel does not own a log sink — it accepts handler functions from the consumer
 * and routes structured events through them. Modules that need a default use
 * `silent` (no-op for all levels).
 *
 * Consumers pass their own logger (pino-compatible) to the mohdel factory.
 * CLI code that wants a colored-stderr helper imports `cliLogger` from
 * `src/cli/colored-logger.js`; keeping that shim out of `src/lib/` lets
 * library consumers avoid loading chalk.
 *
 * All loggers match the interface contract
 * `{ trace, debug, info, warn, error, fatal, child }`.
 */

const noop = () => {}

function silentChild () { return silent }

export const silent = {
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  fatal: noop,
  child: silentChild
}
