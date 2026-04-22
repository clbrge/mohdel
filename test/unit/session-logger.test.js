import { describe, test, expect } from 'vitest'

import { run } from '../../js/session/run.js'
import { createLogger } from '../../js/session/_logger.js'

/** @returns {import('#core/envelope.js').CallEnvelope} */
function envelope (overrides = {}) {
  return {
    callId: 'call-abc',
    authId: 'auth-xyz',
    auth: { key: 'k' },
    provider: 'echo',
    model: 'm',
    prompt: 'hi',
    ...overrides
  }
}

async function collect (iter) {
  const out = []
  for await (const v of iter) out.push(v)
  return out
}

function captureStream () {
  const lines = []
  return {
    lines,
    stream: {
      write (chunk) {
        const text = typeof chunk === 'string' ? chunk : chunk.toString()
        for (const line of text.split('\n')) {
          if (line) lines.push(JSON.parse(line))
        }
        return true
      }
    }
  }
}

describe('_logger', () => {
  test('default level is silent under vitest (no stderr noise)', () => {
    const logger = createLogger({ stream: { write: () => { throw new Error('should not write') } } })
    // warn fires by default in production, but under vitest DEFAULT_LEVEL=silent
    logger.warn('should not fire')
    logger.error('should not fire')
    // Passing is reaching here with no throw
    expect(true).toBe(true)
  })

  test('explicit level overrides the vitest default', () => {
    const { lines, stream } = captureStream()
    const logger = createLogger({ level: 'debug', stream })
    logger.trace('dropped below debug')
    logger.debug('kept')
    logger.warn('also kept')
    expect(lines.map(l => l.level)).toEqual(['debug', 'warn'])
  })

  test('fields in first-arg merge into the line; msg comes from second arg', () => {
    const { lines, stream } = captureStream()
    const logger = createLogger({ level: 'trace', stream })
    logger.info({ provider: 'anthropic', latency: 42 }, '[mohdel:test] hit')
    expect(lines[0].provider).toBe('anthropic')
    expect(lines[0].latency).toBe(42)
    expect(lines[0].msg).toBe('[mohdel:test] hit')
  })

  test('withContext composes fields across scopes', () => {
    const { lines, stream } = captureStream()
    const logger = createLogger({ level: 'trace', stream })
      .withContext({ callId: 'c1' })
      .withContext({ provider: 'openai' })
    logger.info('[mohdel:test] hit')
    expect(lines[0].callId).toBe('c1')
    expect(lines[0].provider).toBe('openai')
  })

  test('Error instances are flattened to {message, name, status?} — no stack at warn', () => {
    // F22: at warn and higher-severity levels (production default),
    // drop err.stack because some SDKs synthesize Errors carrying
    // request bodies / auth tokens in the stack trace.
    const { lines, stream } = captureStream()
    const logger = createLogger({ level: 'warn', stream })
    const e = Object.assign(new Error('boom'), { status: 500 })
    logger.warn({ err: e }, '[mohdel:test] failed')
    expect(lines[0].err.message).toBe('boom')
    expect(lines[0].err.status).toBe(500)
    expect(lines[0].err.stack).toBeUndefined()
  })

  test('F22: stack is kept at debug/trace (opt-in verbose levels)', () => {
    const { lines, stream } = captureStream()
    const logger = createLogger({ level: 'trace', stream })
    const e = new Error('debug-me')
    logger.debug({ err: e }, 'debug-line')
    logger.trace({ err: e }, 'trace-line')
    logger.info({ err: e }, 'info-line')
    logger.warn({ err: e }, 'warn-line')
    logger.error({ err: e }, 'error-line')

    const byMsg = Object.fromEntries(lines.map(l => [l.msg, l]))
    expect(typeof byMsg['debug-line'].err.stack).toBe('string')
    expect(typeof byMsg['trace-line'].err.stack).toBe('string')
    expect(byMsg['info-line'].err.stack).toBeUndefined()
    expect(byMsg['warn-line'].err.stack).toBeUndefined()
    expect(byMsg['error-line'].err.stack).toBeUndefined()
  })

  test('F22: a stack carrying a fake Bearer token is not emitted at warn', () => {
    // Regression fixture: simulate an SDK that synthesizes an error
    // whose stack includes an auth header.
    const { lines, stream } = captureStream()
    const logger = createLogger({ level: 'warn', stream })
    const e = new Error('unauthorized')
    e.stack = 'Error: unauthorized\n  at request({ Authorization: "Bearer sk-test-1234567890" })'
    logger.error({ err: e }, '[mohdel:test] failed')
    const serialized = JSON.stringify(lines[0])
    expect(serialized).not.toContain('sk-test')
    expect(serialized).not.toContain('Bearer')
  })
})

describe('run.js logger emission', () => {
  test('emits [mohdel:answer] start and done with traceId from traceparent', async () => {
    const { lines, stream } = captureStream()
    const logger = createLogger({ level: 'debug', stream })
    const traceparent = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01'

    await collect(run(envelope({ traceparent }), { logger }))

    const start = lines.find(l => l.msg === '[mohdel:answer] start')
    const done = lines.find(l => l.msg === '[mohdel:answer] done')
    expect(start).toBeDefined()
    expect(done).toBeDefined()

    expect(start.callId).toBe('call-abc')
    expect(start.provider).toBe('echo')
    // The no-op tracer may echo the parent's spanId or assign a fresh
    // one depending on SDK registration; the contract is that the
    // traceId carries through so a collector can stitch logs + spans.
    expect(start.traceId).toBe('0123456789abcdef0123456789abcdef')
    expect(typeof start.spanId).toBe('string')

    expect(done.status).toBe('completed')
    expect(typeof done.totalMs).toBe('number')
  })

  test('emits [mohdel:answer] failed with error fields on adapter error', async () => {
    const throwingAdapter = async function * () {
      yield {
        type: 'error',
        error: { message: 'bad key', severity: 'error', retryable: false, type: 'AUTH_INVALID' }
      }
    }
    const { lines, stream } = captureStream()
    const logger = createLogger({ level: 'warn', stream })

    await collect(run(envelope(), { logger, resolveAdapter: () => throwingAdapter }))

    const failed = lines.find(l => l.msg === '[mohdel:answer] failed')
    expect(failed).toBeDefined()
    expect(failed.err.type).toBe('AUTH_INVALID')
    expect(failed.provider).toBe('echo')
  })

  test('cooldown fast-fail emits [mohdel:cooldown] fast-fail', async () => {
    const { lines, stream } = captureStream()
    const logger = createLogger({ level: 'debug', stream })
    const cooldown = {
      coolingDownError: () => ({
        message: 'provider in cooldown',
        detail: 'echo is in cooldown for 10s',
        severity: 'warn',
        retryable: true,
        type: 'PROVIDER_COOLDOWN'
      }),
      recordFailure: () => false,
      reset: () => {}
    }
    const limiter = {
      check: () => 0,
      recordRequest: () => {},
      recordTokens: () => {}
    }

    await collect(run(envelope(), { logger, cooldown, limiter }))

    const coolLine = lines.find(l => l.msg === '[mohdel:cooldown] fast-fail')
    expect(coolLine).toBeDefined()
    expect(coolLine.provider).toBe('echo')
  })
})
