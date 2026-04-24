import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest'

import { run } from '../../js/session/run.js'
import { createCooldownTracker } from '../../js/session/_cooldown.js'
import { createRateLimiter } from '../../js/session/_rate_limiter.js'
import { setCatalog } from '../../js/session/adapters/_catalog.js'

beforeEach(() => setCatalog({ 'acme/fast': {}, 'acme/slow': {}, 'echo/m': {} }))

/** @returns {import('#core/envelope.js').CallEnvelope} */
function envelope (overrides = {}) {
  return {
    callId: 'c1',
    authId: 'a1',
    auth: { key: 'k' },
    model: 'acme/fast',
    prompt: 'hi',
    ...overrides
  }
}

async function collect (iter) {
  const out = []
  for await (const v of iter) out.push(v)
  return out
}

const doneAdapter = (result = defaultResult()) => async function * () {
  yield { type: 'done', result }
}

const errorAdapter = (error) => async function * () {
  yield { type: 'error', error }
}

function defaultResult () {
  return {
    status: 'completed',
    output: 'ok',
    inputTokens: 100,
    outputTokens: 50,
    thinkingTokens: 10,
    cost: 0,
    timestamps: { start: '0', first: '0', end: '0' }
  }
}

function fixtures ({ spec = {}, providerLimits } = {}) {
  return {
    resolveSpec: () => spec,
    resolveProviderLimits: () => providerLimits,
    cooldown: createCooldownTracker(3, 60_000),
    limiter: createRateLimiter(),
    sleeps: [],
    sleep (ms) { this.sleeps.push(ms); return Promise.resolve() }
  }
}

describe('session/run — cooldown enforcement', () => {
  test('active cooldown yields PROVIDER_COOLDOWN error and skips adapter', async () => {
    const fx = fixtures()
    fx.cooldown.recordFailure('acme', { immediate: true })
    let called = false
    const adapter = async function * () { called = true; yield { type: 'done', result: defaultResult() } }

    const events = await collect(run(envelope(), {
      ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => adapter
    }))

    expect(called).toBe(false)
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('error')
    expect(events[0].error.type).toBe('PROVIDER_COOLDOWN')
    expect(events[0].error.retryable).toBe(true)
  })

  test('successful done resets cooldown failCount', async () => {
    const fx = fixtures()
    fx.cooldown.recordFailure('acme')
    fx.cooldown.recordFailure('acme')

    await collect(run(envelope(), {
      ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => doneAdapter()
    }))

    expect(fx.cooldown.coolingDownError('acme')).toBeUndefined()
    fx.cooldown.recordFailure('acme')
    fx.cooldown.recordFailure('acme')
    expect(fx.cooldown.coolingDownError('acme')).toBeUndefined()
  })

  test('error event with retryable type records a normal failure', async () => {
    const fx = fixtures()
    const err = { message: 'rate limit', severity: 'warn', retryable: true, type: 'RATE_LIMIT' }

    await collect(run(envelope(), {
      ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => errorAdapter(err)
    }))
    await collect(run(envelope(), {
      ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => errorAdapter(err)
    }))
    expect(fx.cooldown.coolingDownError('acme')).toBeUndefined()

    await collect(run(envelope(), {
      ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => errorAdapter(err)
    }))
    const coolErr = fx.cooldown.coolingDownError('acme')
    expect(coolErr?.type).toBe('PROVIDER_COOLDOWN')
  })

  test('AUTH_INVALID triggers immediate cooldown on first failure', async () => {
    const fx = fixtures()
    const err = { message: 'auth failed', severity: 'error', retryable: false, type: 'AUTH_INVALID' }

    await collect(run(envelope(), {
      ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => errorAdapter(err)
    }))
    expect(fx.cooldown.coolingDownError('acme')?.type).toBe('PROVIDER_COOLDOWN')
  })

  test('non-retryable non-auth error skips cooldown recording', async () => {
    const fx = fixtures()
    const err = { message: 'bad request', severity: 'error', retryable: false, type: 'PROVIDER_ERROR' }

    for (let i = 0; i < 5; i++) {
      await collect(run(envelope(), {
        ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => errorAdapter(err)
      }))
    }
    expect(fx.cooldown.coolingDownError('acme')).toBeUndefined()
  })

  // F9 regression: a cancelled `done` terminal must NOT wipe an
  // accumulated failure streak. Cancel is caller-side; it says
  // nothing about provider recovery.
  test('cancelled done does not reset cooldown failure count', async () => {
    const fx = fixtures()
    const retryableErr = { message: 'overloaded', severity: 'warn', retryable: true, type: 'RATE_LIMIT' }
    const cancelledAdapter = async function * () {
      yield {
        type: 'done',
        result: {
          status: 'incomplete',
          output: null,
          inputTokens: 0,
          outputTokens: 0,
          thinkingTokens: 0,
          cost: 0,
          timestamps: { start: '0', first: '0', end: '0' },
          warning: 'cancelled'
        }
      }
    }

    // Two failures: below threshold (3), no cooldown yet.
    await collect(run(envelope(), {
      ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => errorAdapter(retryableErr)
    }))
    await collect(run(envelope(), {
      ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => errorAdapter(retryableErr)
    }))
    expect(fx.cooldown.coolingDownError('acme')).toBeUndefined()

    // Caller-side cancel arrives.
    await collect(run(envelope(), {
      ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => cancelledAdapter
    }))
    // Streak unchanged — next real failure triggers cooldown.
    await collect(run(envelope(), {
      ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => errorAdapter(retryableErr)
    }))
    expect(fx.cooldown.coolingDownError('acme')?.type).toBe('PROVIDER_COOLDOWN')
  })

  test('completed done DOES reset cooldown failure count', async () => {
    const fx = fixtures()
    const retryableErr = { message: 'overloaded', severity: 'warn', retryable: true, type: 'RATE_LIMIT' }

    // Prime two failures.
    await collect(run(envelope(), {
      ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => errorAdapter(retryableErr)
    }))
    await collect(run(envelope(), {
      ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => errorAdapter(retryableErr)
    }))

    // A real success resets.
    await collect(run(envelope(), {
      ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => doneAdapter()
    }))

    // Another two failures: still below threshold (streak was cleared).
    await collect(run(envelope(), {
      ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => errorAdapter(retryableErr)
    }))
    await collect(run(envelope(), {
      ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => errorAdapter(retryableErr)
    }))
    expect(fx.cooldown.coolingDownError('acme')).toBeUndefined()
  })
})

describe('session/run — rate-limit enforcement', () => {
  test('no spec and no provider config → adapter runs without throttle', async () => {
    const fx = fixtures()
    const events = await collect(run(envelope(), {
      ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => doneAdapter()
    }))
    expect(fx.sleeps).toEqual([])
    expect(events.at(-1).type).toBe('done')
  })

  test('spec.rpmLimit=1 throttles the second call', async () => {
    const fx = fixtures({ spec: { rpmLimit: 1 } })
    await collect(run(envelope(), {
      ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => doneAdapter()
    }))
    expect(fx.sleeps).toEqual([])
    await collect(run(envelope(), {
      ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => doneAdapter()
    }))
    expect(fx.sleeps.length).toBe(1)
    expect(fx.sleeps[0]).toBeGreaterThan(0)
  })

  test('provider config applies when spec missing', async () => {
    const fx = fixtures({ providerLimits: { rpmLimit: 1 } })
    await collect(run(envelope(), {
      ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => doneAdapter()
    }))
    await collect(run(envelope(), {
      ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => doneAdapter()
    }))
    expect(fx.sleeps.length).toBe(1)
  })

  test('spec overrides provider config', async () => {
    const fx = fixtures({
      spec: { rpmLimit: 100 },
      providerLimits: { rpmLimit: 1 }
    })
    await collect(run(envelope(), {
      ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => doneAdapter()
    }))
    await collect(run(envelope(), {
      ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => doneAdapter()
    }))
    expect(fx.sleeps).toEqual([])
  })

  test('rateLimitScope=model uses provider/model bucket key', async () => {
    const fx = fixtures({ spec: { rpmLimit: 1, rateLimitScope: 'model' } })
    await collect(run(envelope({ model: 'acme/fast' }), {
      ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => doneAdapter()
    }))
    await collect(run(envelope({ model: 'acme/slow' }), {
      ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => doneAdapter()
    }))
    expect(fx.sleeps).toEqual([])
  })

  test('rateLimitScope=provider (default) uses provider bucket — shared across models', async () => {
    const fx = fixtures({ spec: { rpmLimit: 1 } })
    await collect(run(envelope({ model: 'acme/fast' }), {
      ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => doneAdapter()
    }))
    await collect(run(envelope({ model: 'acme/slow' }), {
      ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => doneAdapter()
    }))
    expect(fx.sleeps.length).toBe(1)
  })

  test('tpm triggers throttle after enough tokens recorded', async () => {
    const fx = fixtures({ spec: { tpmLimit: 100 } })
    const big = { ...defaultResult(), inputTokens: 90, outputTokens: 20, thinkingTokens: 0 }
    await collect(run(envelope(), {
      ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => doneAdapter(big)
    }))
    expect(fx.sleeps).toEqual([])
    await collect(run(envelope(), {
      ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => doneAdapter(big)
    }))
    expect(fx.sleeps.length).toBe(1)
  })

  test('tokens not recorded when tpmLimit unset', async () => {
    const fx = fixtures({ spec: { rpmLimit: 10 } })
    await collect(run(envelope(), {
      ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => doneAdapter()
    }))
    expect(fx.limiter.check('acme', { tpmLimit: 1 })).toBe(0)
  })

  // F6: `0` is a killswitch (deny all), not "unset".
  test('spec.rpmLimit=0 denies the very first call (killswitch)', async () => {
    const fx = fixtures({ spec: { rpmLimit: 0 } })
    await collect(run(envelope(), {
      ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => doneAdapter()
    }))
    // No call succeeded without a throttle delay.
    expect(fx.sleeps.length).toBe(1)
    expect(fx.sleeps[0]).toBeGreaterThan(0)
  })

  test('spec.tpmLimit=0 denies even when rpmLimit is absent', async () => {
    const fx = fixtures({ spec: { tpmLimit: 0 } })
    await collect(run(envelope(), {
      ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => doneAdapter()
    }))
    expect(fx.sleeps.length).toBe(1)
    expect(fx.sleeps[0]).toBeGreaterThan(0)
  })

  test('spec.rpmLimit undefined → no throttle (unlimited)', async () => {
    // Explicitly test that omitting the field is distinct from 0.
    const fx = fixtures({ spec: {} })
    await collect(run(envelope(), {
      ...fx, sleep: fx.sleep.bind(fx), resolveAdapter: () => doneAdapter()
    }))
    expect(fx.sleeps).toEqual([])
  })

  test('limiter.check: null/undefined dimensions are skipped; 0 denies', () => {
    const rl = createRateLimiter()
    // both missing → 0 ms (go)
    expect(rl.check('k', {})).toBe(0)
    expect(rl.check('k', { rpmLimit: undefined, tpmLimit: undefined })).toBe(0)
    // rpmLimit=0 denies regardless of bucket state
    expect(rl.check('k', { rpmLimit: 0 })).toBeGreaterThan(0)
    // tpmLimit=0 denies too
    expect(rl.check('k', { tpmLimit: 0 })).toBeGreaterThan(0)
    // Mixed: one denies, the other unset → denied
    expect(rl.check('k', { rpmLimit: 0, tpmLimit: 1000 })).toBeGreaterThan(0)
  })
})

describe('createCooldownTracker — window freeze (F5 regression)', () => {
  afterEach(() => { vi.useRealTimers() })

  test('late failures during active window do not push deadline forward', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(1_000_000_000_000))

    const cd = createCooldownTracker(3, 60_000)

    // Cross threshold: 3 failures back-to-back at T=0 activate.
    expect(cd.recordFailure('acme')).toBe(false)
    expect(cd.recordFailure('acme')).toBe(false)
    expect(cd.recordFailure('acme')).toBe(true) // activated
    const firstErr = cd.coolingDownError('acme')
    expect(firstErr).toBeDefined()
    const firstSecondsLeft = firstErr.detail.match(/for (\d+)s/)[1]

    // Advance 10s (still within the 60s window), fire more failures.
    // None should push the deadline.
    vi.setSystemTime(new Date(1_000_000_010_000))
    expect(cd.recordFailure('acme')).toBe(false) // no re-activation
    expect(cd.recordFailure('acme')).toBe(false)
    expect(cd.recordFailure('acme')).toBe(false)

    // Expected seconds-left now ~50 (original deadline - 10s elapsed).
    // If `until` had been pushed forward, we'd see ~60 again.
    const laterErr = cd.coolingDownError('acme')
    expect(laterErr).toBeDefined()
    const laterSecondsLeft = Number(laterErr.detail.match(/for (\d+)s/)[1])
    expect(laterSecondsLeft).toBeLessThanOrEqual(Number(firstSecondsLeft) - 9)
    expect(laterSecondsLeft).toBeGreaterThanOrEqual(Number(firstSecondsLeft) - 11)

    // But fail_count keeps incrementing for diagnostics
    expect(laterErr.detail).toContain('6 consecutive failures')
  })

  test('expired window allows fresh activation', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(1_000_000_000_000))

    const cd = createCooldownTracker(1, 5_000) // threshold=1, 5s window

    expect(cd.recordFailure('acme')).toBe(true)
    expect(cd.coolingDownError('acme')).toBeDefined()

    // Jump past the window. coolingDownError's `check()` will clear
    // the expired entry on read.
    vi.setSystemTime(new Date(1_000_000_010_000))
    expect(cd.coolingDownError('acme')).toBeUndefined()

    // Next failure re-activates freshly.
    expect(cd.recordFailure('acme')).toBe(true)
    expect(cd.coolingDownError('acme')).toBeDefined()
  })

  test('immediate=true on active window is also frozen', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(1_000_000_000_000))

    const cd = createCooldownTracker(3, 60_000)

    // Bring it up via consecutive failures first.
    cd.recordFailure('acme')
    cd.recordFailure('acme')
    expect(cd.recordFailure('acme')).toBe(true) // active, reason=consecutive_failures

    vi.setSystemTime(new Date(1_000_000_005_000))

    // An auth failure arriving during the active window does NOT
    // push the deadline or upgrade the reason.
    expect(cd.recordFailure('acme', { immediate: true })).toBe(false)
    const err = cd.coolingDownError('acme')
    expect(err.detail).toContain('consecutive_failures')
    // ~55s left, not 60s.
    const secondsLeft = Number(err.detail.match(/for (\d+)s/)[1])
    expect(secondsLeft).toBeLessThan(60)
    expect(secondsLeft).toBeGreaterThanOrEqual(54)
  })
})
