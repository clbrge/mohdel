/**
 * CLI-only colored stderr logger. Extracted from `src/lib/logger.js`
 * so that library consumers (who use `silent` or pass their own pino
 * logger) don't pay for loading chalk. Only CLI code imports this.
 *
 * Matches the logger interface contract
 * `{ trace, debug, info, warn, error, fatal, child }`. Filters by minimum
 * level so noise stays out of the user's view.
 *
 * @module cli/colored-logger
 */

import chalk from 'chalk'

const noop = () => {}

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 }

const COLORS = {
  trace: chalk.dim,
  debug: chalk.cyan,
  info: chalk.white,
  warn: chalk.yellow,
  error: chalk.red,
  fatal: chalk.bold.red
}

const LABELS = {
  trace: 'TRC',
  debug: 'DBG',
  info: 'INF',
  warn: 'WRN',
  error: 'ERR',
  fatal: 'FTL'
}

/**
 * Build a colored stderr logger filtered by minimum level.
 *
 * @param {string} [minLevel='warn'] — minimum level to print: trace|debug|info|warn|error|fatal
 * @returns {object} logger object
 */
export function cliLogger (minLevel = 'warn') {
  const threshold = LEVELS[minLevel] ?? LEVELS.warn
  const lg = {}

  for (const level of Object.keys(LEVELS)) {
    if (LEVELS[level] < threshold) {
      lg[level] = noop
    } else {
      const color = COLORS[level]
      const label = color(LABELS[level])
      lg[level] = (...args) => {
        // Pino-style: first arg may be an object with structured fields
        if (args.length && typeof args[0] === 'object' && args[0] !== null) {
          const [, ...rest] = args
          console.error(label, ...rest)
        } else {
          console.error(label, ...args)
        }
      }
    }
  }

  lg.child = () => lg
  return lg
}
