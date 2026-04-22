import { describe, expect, test } from 'vitest'

import {
  _buildHandlersForTests as buildHandlers,
  _parseVerbosityForTests as parseVerbosity,
  _resolvePriceForTests as resolvePrice,
  silent
} from '../../src/lib/index.js'

// Simulate a stateful logger like pino: methods read instance state via a
// Symbol-keyed property. If the method is detached from `this`, accessing
// the property throws "Cannot read properties of undefined".
//
// This is the bug pattern pino-based consumers routinely hit:
// destructuring `const { debug } = pinoChild` detaches `debug` from the
// instance, and pino's internal `this[Symbol(pino.msgPrefix)]` lookup blows up.
const PINO_MSG_PREFIX = Symbol('pino.msgPrefix')
const PINO_INTERNAL = Symbol('pino.internal')

const createPinoLikeLogger = () => {
  const calls = []
  const logger = {
    [PINO_MSG_PREFIX]: '[child] ',
    [PINO_INTERNAL]: { sessionId: 's1' },
    trace (...args) {
      const prefix = this[PINO_INTERNAL].sessionId + this[PINO_MSG_PREFIX]
      calls.push(['trace', prefix, args])
    },
    debug (...args) {
      const prefix = this[PINO_INTERNAL].sessionId + this[PINO_MSG_PREFIX]
      calls.push(['debug', prefix, args])
    },
    info (...args) {
      const prefix = this[PINO_INTERNAL].sessionId + this[PINO_MSG_PREFIX]
      calls.push(['info', prefix, args])
    },
    warn (...args) {
      const prefix = this[PINO_INTERNAL].sessionId + this[PINO_MSG_PREFIX]
      calls.push(['warn', prefix, args])
    },
    error (...args) {
      const prefix = this[PINO_INTERNAL].sessionId + this[PINO_MSG_PREFIX]
      calls.push(['error', prefix, args])
    },
    fatal (...args) {
      const prefix = this[PINO_INTERNAL].sessionId + this[PINO_MSG_PREFIX]
      calls.push(['fatal', prefix, args])
    }
  }
  return { logger, calls }
}

describe('buildHandlers', () => {
  test('preserves `this` binding when calling stateful logger methods through handlers', () => {
    const { logger, calls } = createPinoLikeLogger()
    const handlers = buildHandlers({ logger })

    handlers.trace({ span: 's' }, 'a')
    handlers.debug({ span: 's' }, 'b')
    handlers.info({ span: 's' }, 'c')
    handlers.warn({ span: 's' }, 'd')
    handlers.error({ span: 's' }, 'e')
    handlers.fatal({ span: 's' }, 'f')

    expect(calls).toEqual([
      ['trace', 's1[child] ', [{ span: 's' }, 'a']],
      ['debug', 's1[child] ', [{ span: 's' }, 'b']],
      ['info', 's1[child] ', [{ span: 's' }, 'c']],
      ['warn', 's1[child] ', [{ span: 's' }, 'd']],
      ['error', 's1[child] ', [{ span: 's' }, 'e']],
      ['fatal', 's1[child] ', [{ span: 's' }, 'f']]
    ])
  })

  test('regression: destructuring this-dependent methods throws — wrappers must not', () => {
    const { logger } = createPinoLikeLogger()

    // Direct destructuring crashes — proves the fixture is sensitive enough to catch the bug.
    const { debug } = logger
    expect(() => debug('hi')).toThrow()

    // Through buildHandlers, the wrapper preserves `this` so the call succeeds.
    const handlers = buildHandlers({ logger })
    expect(() => handlers.debug('hi')).not.toThrow()
  })

  test('falls back to silent (no-op) for missing methods on a partial logger', () => {
    const partial = {
      info () {},
      warn () {}
      // no trace/debug/error/fatal
    }
    const handlers = buildHandlers({ logger: partial })
    // Missing methods become no-ops — never undefined and never console output.
    expect(typeof handlers.trace).toBe('function')
    expect(typeof handlers.debug).toBe('function')
    expect(typeof handlers.error).toBe('function')
    expect(typeof handlers.fatal).toBe('function')
    // Calling them must not throw and must not write to stdout/stderr.
    expect(() => handlers.trace('x')).not.toThrow()
    expect(() => handlers.debug('x')).not.toThrow()
    expect(() => handlers.error('x')).not.toThrow()
    expect(() => handlers.fatal('x')).not.toThrow()
  })

  test('defaults to silent when no logger is passed', () => {
    const handlers = buildHandlers({})
    expect(typeof handlers.trace).toBe('function')
    expect(typeof handlers.debug).toBe('function')
    expect(typeof handlers.info).toBe('function')
    expect(typeof handlers.warn).toBe('function')
    expect(typeof handlers.error).toBe('function')
    expect(typeof handlers.fatal).toBe('function')
    expect(() => {
      handlers.trace('x')
      handlers.debug('x')
      handlers.info('x')
      handlers.warn('x')
      handlers.error('x')
      handlers.fatal('x')
    }).not.toThrow()
  })

  test('routes onSuccess and onFailure callbacks through unchanged', () => {
    const onSuccess = () => {}
    const onFailure = () => {}
    const handlers = buildHandlers({ logger: createPinoLikeLogger().logger, onSuccess, onFailure })
    expect(handlers.onSuccess).toBe(onSuccess)
    expect(handlers.onFailure).toBe(onFailure)
  })
})

describe('parseVerbosity', () => {
  test('returns the default (1) for missing input', () => {
    expect(parseVerbosity(null)).toBe(1)
    expect(parseVerbosity(undefined)).toBe(1)
    expect(parseVerbosity('')).toBe(1)
  })

  test('accepts valid tier numbers (0, 1, 2)', () => {
    expect(parseVerbosity(0)).toBe(0)
    expect(parseVerbosity(1)).toBe(1)
    expect(parseVerbosity(2)).toBe(2)
  })

  test('accepts valid tier strings (parses int)', () => {
    expect(parseVerbosity('0')).toBe(0)
    expect(parseVerbosity('1')).toBe(1)
    expect(parseVerbosity('2')).toBe(2)
  })

  test('clamps values above the max to 2', () => {
    expect(parseVerbosity(3)).toBe(2)
    expect(parseVerbosity('99')).toBe(2)
    expect(parseVerbosity(Number.MAX_SAFE_INTEGER)).toBe(2)
  })

  test('returns default for negative values', () => {
    expect(parseVerbosity(-1)).toBe(1)
    expect(parseVerbosity('-5')).toBe(1)
  })

  test('returns default for non-numeric input', () => {
    expect(parseVerbosity('abc')).toBe(1)
    expect(parseVerbosity('verbose')).toBe(1)
    expect(parseVerbosity(NaN)).toBe(1)
    expect(parseVerbosity({})).toBe(1)
  })

  test('strips trailing whitespace via parseInt semantics', () => {
    // parseInt('2 ', 10) === 2 — useful when env vars have stray whitespace
    expect(parseVerbosity('2 ')).toBe(2)
  })
})

describe('silent (canonical no-op logger)', () => {
  test('exposes all six log levels as no-op functions', () => {
    expect(typeof silent.trace).toBe('function')
    expect(typeof silent.debug).toBe('function')
    expect(typeof silent.info).toBe('function')
    expect(typeof silent.warn).toBe('function')
    expect(typeof silent.error).toBe('function')
    expect(typeof silent.fatal).toBe('function')
  })

  test('exposes child() returning the same silent logger', () => {
    expect(typeof silent.child).toBe('function')
    expect(silent.child({ foo: 'bar' })).toBe(silent)
  })

  test('all level methods return undefined and do not throw', () => {
    expect(silent.trace('x')).toBeUndefined()
    expect(silent.debug('x')).toBeUndefined()
    expect(silent.info('x')).toBeUndefined()
    expect(silent.warn('x')).toBeUndefined()
    expect(silent.error('x')).toBeUndefined()
    expect(silent.fatal('x')).toBeUndefined()
  })
})

describe('resolvePrice', () => {
  test('returns a plain number as-is', () => {
    expect(resolvePrice(3.0, 1000)).toBe(3.0)
    expect(resolvePrice(0, 1000)).toBe(0)
  })

  test('returns 0 for null/undefined', () => {
    expect(resolvePrice(null, 1000)).toBe(0)
    expect(resolvePrice(undefined, 1000)).toBe(0)
  })

  test('returns default when input tokens are below threshold', () => {
    const price = { default: 2.5, '>272000': 5 }
    expect(resolvePrice(price, 100000)).toBe(2.5)
  })

  test('returns higher rate when input tokens exceed threshold', () => {
    const price = { default: 2.5, '>272000': 5 }
    expect(resolvePrice(price, 300000)).toBe(5)
  })

  test('returns default at exactly the threshold (not exceeded)', () => {
    const price = { default: 0.2, '>200000': 0.4 }
    expect(resolvePrice(price, 200000)).toBe(0.2)
  })

  test('picks the highest matching threshold when multiple match', () => {
    const price = { default: 1, '>100000': 2, '>500000': 4 }
    expect(resolvePrice(price, 600000)).toBe(4)
    expect(resolvePrice(price, 200000)).toBe(2)
    expect(resolvePrice(price, 50000)).toBe(1)
  })

  test('returns 0 for tiered object missing default key', () => {
    const price = { '>200000': 5 }
    expect(resolvePrice(price, 100000)).toBe(0)
  })
})
