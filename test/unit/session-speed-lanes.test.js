import { describe, test, expect } from 'vitest'
import { run } from '../../js/session/run.js'
import { catalogKey, effortOf, speedOf } from '../../js/core/model-id.js'
import { computeCost } from '../../js/session/adapters/_pricing.js'
import { setCatalog } from '../../js/session/adapters/_catalog.js'
import { openai } from '../../js/session/adapters/openai.js'
import {
  hasSpeed,
  mergeSpeed,
  speedHasOwnQuota
} from '../../js/session/adapters/_speed.js'

/** @returns {import('#core/envelope.js').CallEnvelope} */
function envelope (overrides = {}) {
  return {
    callId: 'c1',
    authId: 'a1',
    auth: { key: 'sk-test' },
    model: 'openai/gpt-x',
    prompt: 'hi',
    ...overrides
  }
}

const LANED = {
  provider: 'openai',
  model: 'gpt-x',
  inputPrice: 3,
  outputPrice: 15,
  speeds: {
    fast: { inputPrice: 6, outputPrice: 30 },
    flex: { inputPrice: 1.5, outputPrice: 7.5, rpmLimit: 5 },
    scale: {}
  }
}

function specs (table = {}) {
  const base = {
    'openai/gpt-x': LANED,
    'openai/gpt-plain': { provider: 'openai', model: 'gpt-plain', inputPrice: 1, outputPrice: 2 },
    'anthropic/claude-laned': {
      provider: 'anthropic',
      model: 'claude-laned',
      inputPrice: 1,
      outputPrice: 2,
      speeds: { fast: { outputPrice: 4 } }
    },
    ...table
  }
  return (key) => base[key]
}

async function collect (iter) {
  const out = []
  for await (const v of iter) out.push(v)
  return out
}

function capturingAdapter () {
  const seen = { envelope: null, calls: 0 }
  const adapter = async function * (env) {
    seen.envelope = env
    seen.calls++
    yield {
      type: 'done',
      result: {
        status: 'completed',
        output: 'ok',
        inputTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        cost: 0,
        timestamps: { start: '0', first: '0', end: '0' }
      }
    }
  }
  adapter.speedLanes = openai.speedLanes
  return { adapter, seen }
}

function noLimiter () {
  return { check: () => 0, recordRequest: () => {}, recordTokens: () => {} }
}

function neverAdapter () {
  const adapter = async function * () {
    throw new Error('adapter must not be reached')
  }
  adapter.speedLanes = openai.speedLanes
  return adapter
}

function lanelessAdapter () {
  const { adapter } = capturingAdapter()
  delete adapter.speedLanes
  return adapter
}

function deps (extra = {}) {
  return { resolveSpec: specs(), limiter: noLimiter(), ...extra }
}

describe('model-id `@speed` parsing', () => {
  test.each([
    ['p/m', 'p/m', undefined, undefined],
    ['p/m:high', 'p/m', 'high', undefined],
    ['p/m@fast', 'p/m', undefined, 'fast'],
    ['p/m:high@fast', 'p/m', 'high', 'fast']
  ])('%s splits into base/effort/speed', (id, base, effort, speed) => {
    expect(catalogKey(id)).toBe(base)
    expect(effortOf(id)).toBe(effort)
    expect(speedOf(id)).toBe(speed)
  })

  test('a sigil before the provider slash is not a suffix', () => {
    expect(catalogKey('weird:name')).toBe('weird:name')
    expect(speedOf('weird@name')).toBeUndefined()
  })
})

describe('full-id-first resolution', () => {
  test('a bare id containing `@` resolves whole rather than being split', async () => {
    const { adapter, seen } = capturingAdapter()
    const table = { 'vertex/gemini-x@002': { provider: 'openai', model: 'gemini-x@002' } }
    await collect(run(envelope({ model: 'vertex/gemini-x@002' }), {
      ...deps({ resolveSpec: specs(table) }),
      resolveAdapter: () => adapter
    }))
    expect(seen.envelope.model).toBe('vertex/gemini-x@002')
    expect(seen.envelope.speed).toBeUndefined()
  })

  test('a bare id containing `:` resolves whole rather than being split', async () => {
    const { adapter, seen } = capturingAdapter()
    const table = { 'openrouter/vendor/model:free': { provider: 'openai', model: 'vendor/model:free' } }
    await collect(run(envelope({ model: 'openrouter/vendor/model:free' }), {
      ...deps({ resolveSpec: specs(table) }),
      resolveAdapter: () => adapter
    }))
    expect(seen.envelope.model).toBe('openrouter/vendor/model:free')
    expect(seen.envelope.outputEffort).toBeUndefined()
  })
})

describe('R2a — lane not declared by the entry', () => {
  test('rejects a lane the entry does not list, before dispatch', async () => {
    const events = await collect(run(envelope({ model: 'openai/gpt-x@turbo' }), {
      ...deps(), resolveAdapter: () => neverAdapter()
    }))
    expect(events).toHaveLength(1)
    expect(events[0].error.type).toBe('SESSION_INVALID_SPEED')
    expect(events[0].error.message).toMatch(/Available:.*fast/)
  })

  test('rejects any lane on an entry with no `speeds` at all', async () => {
    const events = await collect(run(envelope({ model: 'openai/gpt-plain', speed: 'fast' }), {
      ...deps(), resolveAdapter: () => neverAdapter()
    }))
    expect(events[0].error.type).toBe('SESSION_INVALID_SPEED')
    expect(events[0].error.message).toMatch(/declares no speed lanes/)
  })

  test('an explicit envelope.speed goes through the same guard as the suffix', async () => {
    const events = await collect(run(envelope({ speed: 'turbo' }), {
      ...deps(), resolveAdapter: () => neverAdapter()
    }))
    expect(events[0].error.type).toBe('SESSION_INVALID_SPEED')
  })

  test('reversed suffix order is reported as such', async () => {
    const events = await collect(run(envelope({ model: 'openai/gpt-x@fast:high' }), {
      ...deps(), resolveAdapter: () => neverAdapter()
    }))
    expect(events[0].error.type).toBe('SESSION_INVALID_SPEED')
    expect(events[0].error.message).toMatch(/did you mean 'openai\/gpt-x:high@fast'/)
  })

  test('a lane declaring nothing is still a valid lane', async () => {
    const { adapter, seen } = capturingAdapter()
    const events = await collect(run(envelope({ model: 'openai/gpt-x@scale' }), {
      ...deps(), resolveAdapter: () => adapter
    }))
    expect(events.at(-1).type).toBe('done')
    expect(seen.envelope.speed).toBe('scale')
  })
})

describe('R2b — provider adapter cannot emit the lane', () => {
  test('rejects a declared lane whose adapter implements none', async () => {
    const events = await collect(run(envelope({ model: 'anthropic/claude-laned@fast' }), {
      ...deps(), resolveAdapter: () => lanelessAdapter()
    }))
    expect(events).toHaveLength(1)
    expect(events[0].error.type).toBe('SESSION_SPEED_NOT_IMPLEMENTED')
    expect(events[0].error.message).toMatch(/implements no speed lanes/)
  })

  test('rejects a lane name the adapter does not accept', async () => {
    const table = { 'openai/gpt-x': { ...LANED, speeds: { ...LANED.speeds, turbo: {} } } }
    const events = await collect(run(envelope({ model: 'openai/gpt-x@turbo' }), {
      ...deps({ resolveSpec: specs(table) }), resolveAdapter: () => neverAdapter()
    }))
    expect(events[0].error.type).toBe('SESSION_SPEED_NOT_IMPLEMENTED')
    expect(events[0].error.message).toMatch(/accepts: fast/)
  })

  test('the guard fires before the adapter is invoked', async () => {
    const { adapter, seen } = capturingAdapter()
    delete adapter.speedLanes
    await collect(run(envelope({ model: 'anthropic/claude-laned@fast' }), {
      ...deps(), resolveAdapter: () => adapter
    }))
    expect(seen.calls).toBe(0)
  })

  test('the two guards stay distinct', async () => {
    const events = await collect(run(envelope({ model: 'anthropic/claude-laned@turbo' }), {
      ...deps(), resolveAdapter: () => neverAdapter()
    }))
    expect(events[0].error.type).toBe('SESSION_INVALID_SPEED')
  })
})

describe('normalization and attribution', () => {
  test('the suffix is stripped and the lane travels on the envelope', async () => {
    const { adapter, seen } = capturingAdapter()
    await collect(run(envelope({ model: 'openai/gpt-x@fast' }), {
      ...deps(), resolveAdapter: () => adapter
    }))
    expect(seen.envelope.model).toBe('openai/gpt-x')
    expect(seen.envelope.speed).toBe('fast')
  })

  test('explicit envelope.speed wins over the suffix', async () => {
    const { adapter, seen } = capturingAdapter()
    await collect(run(envelope({ model: 'openai/gpt-x@fast', speed: 'scale' }), {
      ...deps(), resolveAdapter: () => adapter
    }))
    expect(seen.envelope.speed).toBe('scale')
  })

  test('both suffixes split together', async () => {
    const { adapter, seen } = capturingAdapter()
    const table = { 'openai/gpt-x': { ...LANED, thinkingEffortLevels: { high: 1024 } } }
    await collect(run(envelope({ model: 'openai/gpt-x:high@fast' }), {
      ...deps({ resolveSpec: specs(table) }),
      resolveAdapter: () => adapter
    }))
    expect(seen.envelope.outputEffort).toBe('high')
    expect(seen.envelope.speed).toBe('fast')
  })

  test('the lane is stamped on the result so cost can be grouped by it', async () => {
    const { adapter } = capturingAdapter()
    const events = await collect(run(envelope({ model: 'openai/gpt-x@fast' }), {
      ...deps(), resolveAdapter: () => adapter
    }))
    expect(events.at(-1).result.speed).toBe('fast')
  })

  test('no lane means no speed field anywhere', async () => {
    const { adapter, seen } = capturingAdapter()
    const events = await collect(run(envelope(), { ...deps(), resolveAdapter: () => adapter }))
    expect(seen.envelope.speed).toBeUndefined()
    expect(events.at(-1).result.speed).toBeUndefined()
  })
})

describe('overlay merge and pricing', () => {
  test('named fields override, unnamed fall through', () => {
    const merged = mergeSpeed(LANED, 'fast')
    expect(merged.inputPrice).toBe(6)
    expect(merged.outputPrice).toBe(30)
    expect(merged.model).toBe('gpt-x')
  })

  test('a lane declaring nothing changes no prices', () => {
    const merged = mergeSpeed(LANED, 'scale')
    expect(merged.inputPrice).toBe(3)
    expect(merged.outputPrice).toBe(15)
  })

  test('no lane returns the spec untouched', () => {
    expect(mergeSpeed(LANED, undefined)).toBe(LANED)
  })

  test('an undeclared lane throws rather than falling back to base', () => {
    expect(() => mergeSpeed(LANED, 'turbo')).toThrow(/does not declare speed lane/)
  })

  test('hasSpeed uses own-property semantics', () => {
    expect(hasSpeed(LANED, 'fast')).toBe(true)
    expect(hasSpeed(LANED, 'scale')).toBe(true)
    expect(hasSpeed(LANED, 'toString')).toBe(false)
    expect(hasSpeed({ inputPrice: 1 }, 'fast')).toBe(false)
  })

  test('a discount lane prices below base', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
    expect(computeCost(LANED, usage)).toBeCloseTo(18, 6)
    expect(computeCost(mergeSpeed(LANED, 'fast'), usage)).toBeCloseTo(36, 6)
    expect(computeCost(mergeSpeed(LANED, 'flex'), usage)).toBeCloseTo(9, 6)
  })

  test('a lane may carry its own tiered price map', () => {
    const spec = {
      inputPrice: 1,
      outputPrice: 1,
      speeds: { fast: { wire: 'fast', inputPrice: { '>500000': 8, default: 2 } } }
    }
    const merged = mergeSpeed(spec, 'fast')
    expect(computeCost(merged, { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(8, 6)
    expect(computeCost(merged, { inputTokens: 100_000, outputTokens: 0 })).toBeCloseTo(0.2, 6)
  })
})

describe('R6 — a lane buckets separately only when it has its own quota', () => {
  function recordingLimiter (seen) {
    return {
      check: (key, limits) => { seen.push({ key, limits }); return 0 },
      recordRequest: () => {},
      recordTokens: () => {}
    }
  }

  test('a lane with no declared limits shares the base bucket', async () => {
    const seen = []
    const { adapter } = capturingAdapter()
    const table = { 'openai/gpt-x': { ...LANED, rpmLimit: 10, rateLimitScope: 'model' } }
    const d = { resolveSpec: specs(table), limiter: recordingLimiter(seen), resolveAdapter: () => adapter }
    await collect(run(envelope(), d))
    await collect(run(envelope({ model: 'openai/gpt-x@fast' }), d))
    expect(seen.map(s => s.key)).toEqual(['openai/gpt-x', 'openai/gpt-x'])
  })

  test('a lane that declares a quota gets its own bucket and limit', async () => {
    const seen = []
    const { adapter } = capturingAdapter()
    const table = { 'openai/gpt-x': { ...LANED, rpmLimit: 10, rateLimitScope: 'model' } }
    const d = { resolveSpec: specs(table), limiter: recordingLimiter(seen), resolveAdapter: () => adapter }
    await collect(run(envelope({ model: 'openai/gpt-x@flex' }), d))
    expect(seen[0].key).toBe('openai/gpt-x@flex')
    expect(seen[0].limits.rpmLimit).toBe(5)
  })

  test('speedHasOwnQuota reads the overlay, not the base', () => {
    expect(speedHasOwnQuota(LANED, 'flex')).toBe(true)
    expect(speedHasOwnQuota(LANED, 'fast')).toBe(false)
    expect(speedHasOwnQuota(LANED, undefined)).toBe(false)
  })
})

describe('openai adapter — emission and served-tier billing', () => {
  const USAGE = { input_tokens: 1_000_000, output_tokens: 1_000_000 }

  function client (responseExtra = {}) {
    const captured = {}
    return {
      captured,
      client: {
        responses: {
          stream (request) {
            captured.request = request
            return {
              async * [Symbol.asyncIterator] () {
                yield { type: 'response.output_text.delta', delta: 'ok' }
                yield { type: 'response.completed', response: { usage: USAGE, ...responseExtra } }
              }
            }
          }
        }
      }
    }
  }

  test('the lane parameter reaches the wire as service_tier', async () => {
    setCatalog({ 'openai/gpt-x': LANED })
    const { client: c, captured } = client({ service_tier: 'priority' })
    await collect(openai(envelope({ speed: 'fast' }), { client: c }))
    expect(captured.request.service_tier).toBe('fast')
  })

  test('no lane means no parameter at all', async () => {
    setCatalog({ 'openai/gpt-x': LANED })
    const { client: c, captured } = client()
    await collect(openai(envelope(), { client: c }))
    expect('service_tier' in captured.request).toBe(false)
  })

  test('a served lane bills at the lane rate', async () => {
    setCatalog({ 'openai/gpt-x': LANED })
    const { client: c } = client({ service_tier: 'priority' })
    const events = await collect(openai(envelope({ speed: 'fast' }), { client: c }))
    expect(events.at(-1).result.cost).toBeCloseTo(36, 6)
    expect(events.at(-1).result.servedSpeed).toBe('fast')
  })

  test('a downgrade bills at base rates, not the requested lane', async () => {
    setCatalog({ 'openai/gpt-x': LANED })
    const { client: c } = client({ service_tier: 'default' })
    const events = await collect(openai(envelope({ speed: 'fast' }), { client: c }))
    expect(events.at(-1).result.cost).toBeCloseTo(18, 6)
    expect(events.at(-1).result.servedSpeed).toBeNull()
  })

  test('a downgrade is reported, not swallowed', async () => {
    setCatalog({ 'openai/gpt-x': LANED })
    const warnings = []
    const { client: c } = client({ service_tier: 'default' })
    await collect(openai(envelope({ speed: 'fast' }), {
      client: c,
      log: { warn: (o, m) => warnings.push({ o, m }) }
    }))
    expect(warnings.some(w => /different speed lane/.test(w.m))).toBe(true)
  })

  test('a missing service_tier bills the request and says so', async () => {
    setCatalog({ 'openai/gpt-x': LANED })
    const warnings = []
    const { client: c } = client()
    const events = await collect(openai(envelope({ speed: 'fast' }), {
      client: c,
      log: { warn: (o, m) => warnings.push({ o, m }) }
    }))
    expect(events.at(-1).result.cost).toBeCloseTo(36, 6)
    expect(warnings.some(w => /no service_tier reported/.test(w.m))).toBe(true)
  })

  test('an adapter handed an undeclared lane throws rather than dropping it', async () => {
    setCatalog({ 'openai/gpt-x': LANED })
    const { client: c } = client()
    await expect(collect(openai(envelope({ speed: 'turbo' }), { client: c })))
      .rejects.toThrow(/does not declare speed lane/)
  })
})
