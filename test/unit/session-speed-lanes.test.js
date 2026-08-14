import { describe, test, expect } from 'vitest'
import { run } from '../../js/session/run.js'
import { catalogKey, effortOf, speedOf } from '../../js/core/model-id.js'
import { computeCost } from '../../js/session/adapters/_pricing.js'
import { setCatalog } from '../../js/session/adapters/_catalog.js'
import { anthropic } from '../../js/session/adapters/anthropic.js'
import { mergeSpeed, hasSpeed, SPEED_PARAMS } from '../../js/session/adapters/_speed.js'

/** @returns {import('#core/envelope.js').CallEnvelope} */
function envelope (overrides = {}) {
  return {
    callId: 'c1',
    authId: 'a1',
    auth: { key: 'k' },
    model: 'anthropic/claude-x',
    prompt: 'hi',
    ...overrides
  }
}

const LANED = {
  provider: 'anthropic',
  model: 'claude-x',
  inputPrice: 3,
  outputPrice: 15,
  rateLimitScope: 'model',
  rpmLimit: 10,
  speeds: {
    fast: { wire: 'fast', inputPrice: 6, outputPrice: 30, rpmLimit: 2 },
    bare: { wire: 'economy' }
  }
}

function specs (table = {}) {
  const base = {
    'anthropic/claude-x': LANED,
    'anthropic/claude-plain': { provider: 'anthropic', model: 'claude-plain', inputPrice: 1, outputPrice: 2 },
    'gemini/gem-laned': {
      provider: 'gemini',
      model: 'gem-laned',
      inputPrice: 1,
      outputPrice: 2,
      speeds: { fast: { wire: 'fast', outputPrice: 4 } }
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
  return { adapter, seen }
}

function noLimiter () {
  return { check: () => 0, recordRequest: () => {}, recordTokens: () => {} }
}

function neverAdapter () {
  return async function * () {
    throw new Error('adapter must not be reached')
  }
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
    const table = { 'vertex/gemini-x@002': { provider: 'vertex', model: 'gemini-x@002' } }
    await collect(run(envelope({ model: 'vertex/gemini-x@002' }), {
      resolveAdapter: () => adapter,
      resolveSpec: specs(table),
      limiter: noLimiter()
    }))
    expect(seen.envelope.model).toBe('vertex/gemini-x@002')
    expect(seen.envelope.speed).toBeUndefined()
  })

  test('a bare id containing `:` resolves whole rather than being split', async () => {
    const { adapter, seen } = capturingAdapter()
    const table = { 'openrouter/vendor/model:free': { provider: 'openrouter', model: 'vendor/model:free' } }
    await collect(run(envelope({ model: 'openrouter/vendor/model:free' }), {
      resolveAdapter: () => adapter,
      resolveSpec: specs(table),
      limiter: noLimiter()
    }))
    expect(seen.envelope.model).toBe('openrouter/vendor/model:free')
    expect(seen.envelope.outputEffort).toBeUndefined()
  })
})

describe('R2a — lane not declared by the entry', () => {
  test('rejects a lane the entry does not list, before dispatch', async () => {
    const events = await collect(run(envelope({ model: 'anthropic/claude-x@turbo' }), {
      resolveAdapter: () => neverAdapter(),
      resolveSpec: specs(),
      limiter: noLimiter()
    }))
    expect(events).toHaveLength(1)
    expect(events[0].error.type).toBe('SESSION_INVALID_SPEED')
    expect(events[0].error.message).toMatch(/Available:.*fast/)
  })

  test('rejects any lane on an entry with no `speeds` at all', async () => {
    const events = await collect(run(envelope({ model: 'anthropic/claude-plain', speed: 'fast' }), {
      resolveAdapter: () => neverAdapter(),
      resolveSpec: specs(),
      limiter: noLimiter()
    }))
    expect(events[0].error.type).toBe('SESSION_INVALID_SPEED')
    expect(events[0].error.message).toMatch(/declares no speed lanes/)
  })

  test('an explicit envelope.speed goes through the same guard as the suffix', async () => {
    const events = await collect(run(envelope({ speed: 'turbo' }), {
      resolveAdapter: () => neverAdapter(),
      resolveSpec: specs(),
      limiter: noLimiter()
    }))
    expect(events[0].error.type).toBe('SESSION_INVALID_SPEED')
  })

  test('reversed suffix order is reported as such', async () => {
    const events = await collect(run(envelope({ model: 'anthropic/claude-x@fast:high' }), {
      resolveAdapter: () => neverAdapter(),
      resolveSpec: specs(),
      limiter: noLimiter()
    }))
    expect(events[0].error.type).toBe('SESSION_INVALID_SPEED')
    expect(events[0].error.message).toMatch(/Suffix order/)
  })

  test('an overlay carrying only `wire` is a valid lane', async () => {
    const { adapter, seen } = capturingAdapter()
    const events = await collect(run(envelope({ model: 'anthropic/claude-x@bare' }), {
      resolveAdapter: () => adapter,
      resolveSpec: specs(),
      limiter: noLimiter()
    }))
    expect(events.at(-1).type).toBe('done')
    expect(seen.envelope.speed).toBe('bare')
  })
})

describe('R2b — provider adapter cannot emit the lane', () => {
  test('rejects a declared lane whose provider has no adapter support', async () => {
    const events = await collect(run(envelope({ model: 'gemini/gem-laned@fast' }), {
      resolveAdapter: () => neverAdapter(),
      resolveSpec: specs(),
      limiter: noLimiter()
    }))
    expect(events).toHaveLength(1)
    expect(events[0].error.type).toBe('SESSION_SPEED_NOT_IMPLEMENTED')
  })

  test('the guard fires before the adapter is invoked', async () => {
    const { adapter, seen } = capturingAdapter()
    await collect(run(envelope({ model: 'gemini/gem-laned@fast' }), {
      resolveAdapter: () => adapter,
      resolveSpec: specs(),
      limiter: noLimiter()
    }))
    expect(seen.calls).toBe(0)
  })

  test('the two guards stay distinct', async () => {
    const undeclared = await collect(run(envelope({ model: 'gemini/gem-laned@turbo' }), {
      resolveAdapter: () => neverAdapter(),
      resolveSpec: specs(),
      limiter: noLimiter()
    }))
    expect(undeclared[0].error.type).toBe('SESSION_INVALID_SPEED')
  })
})

describe('normalization and attribution', () => {
  test('the suffix is stripped and the lane travels on the envelope', async () => {
    const { adapter, seen } = capturingAdapter()
    await collect(run(envelope({ model: 'anthropic/claude-x@fast' }), {
      resolveAdapter: () => adapter,
      resolveSpec: specs(),
      limiter: noLimiter()
    }))
    expect(seen.envelope.model).toBe('anthropic/claude-x')
    expect(seen.envelope.speed).toBe('fast')
  })

  test('explicit envelope.speed wins over the suffix', async () => {
    const { adapter, seen } = capturingAdapter()
    await collect(run(envelope({ model: 'anthropic/claude-x@fast', speed: 'bare' }), {
      resolveAdapter: () => adapter,
      resolveSpec: specs(),
      limiter: noLimiter()
    }))
    expect(seen.envelope.model).toBe('anthropic/claude-x')
    expect(seen.envelope.speed).toBe('bare')
  })

  test('both suffixes split together', async () => {
    const { adapter, seen } = capturingAdapter()
    const table = {
      'anthropic/claude-x': { ...LANED, thinkingEffortLevels: { high: 1024 } }
    }
    await collect(run(envelope({ model: 'anthropic/claude-x:high@fast' }), {
      resolveAdapter: () => adapter,
      resolveSpec: specs(table),
      limiter: noLimiter()
    }))
    expect(seen.envelope.model).toBe('anthropic/claude-x')
    expect(seen.envelope.outputEffort).toBe('high')
    expect(seen.envelope.speed).toBe('fast')
  })

  test('the lane is stamped on the result so cost can be grouped by it', async () => {
    const { adapter } = capturingAdapter()
    const events = await collect(run(envelope({ model: 'anthropic/claude-x@fast' }), {
      resolveAdapter: () => adapter,
      resolveSpec: specs(),
      limiter: noLimiter()
    }))
    expect(events.at(-1).result.speed).toBe('fast')
  })

  test('no lane means no speed field anywhere', async () => {
    const { adapter, seen } = capturingAdapter()
    const events = await collect(run(envelope(), {
      resolveAdapter: () => adapter,
      resolveSpec: specs(),
      limiter: noLimiter()
    }))
    expect(seen.envelope.speed).toBeUndefined()
    expect(events.at(-1).result.speed).toBeUndefined()
  })
})

describe('overlay merge and pricing', () => {
  test('named fields override, unnamed fall through', () => {
    const merged = mergeSpeed(LANED, 'fast')
    expect(merged.inputPrice).toBe(6)
    expect(merged.outputPrice).toBe(30)
    expect(merged.model).toBe('claude-x')
    expect(merged.rateLimitScope).toBe('model')
  })

  test('an overlay with only `wire` changes no prices', () => {
    const merged = mergeSpeed(LANED, 'bare')
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
    expect(hasSpeed(LANED, 'bare')).toBe(true)
    expect(hasSpeed(LANED, 'toString')).toBe(false)
    expect(hasSpeed({ inputPrice: 1 }, 'fast')).toBe(false)
  })

  test('lane prices reach computeCost', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
    expect(computeCost(LANED, usage)).toBeCloseTo(18, 6)
    expect(computeCost(mergeSpeed(LANED, 'fast'), usage)).toBeCloseTo(36, 6)
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

describe('R6 — lanes get their own rate-limit bucket', () => {
  function recordingLimiter (seen) {
    return {
      check: (key) => { seen.push(key); return 0 },
      recordRequest: () => {},
      recordTokens: () => {}
    }
  }

  test('base traffic and lane traffic use different bucket keys', async () => {
    const seen = []
    const { adapter } = capturingAdapter()
    const deps = {
      resolveAdapter: () => adapter,
      resolveSpec: specs(),
      limiter: recordingLimiter(seen)
    }
    await collect(run(envelope(), deps))
    await collect(run(envelope({ model: 'anthropic/claude-x@fast' }), deps))
    expect(seen).toEqual(['anthropic/claude-x', 'anthropic/claude-x@fast'])
  })

  test('the lane\'s own rpmLimit is the one enforced', async () => {
    const seen = []
    const { adapter } = capturingAdapter()
    await collect(run(envelope({ model: 'anthropic/claude-x@fast' }), {
      resolveAdapter: () => adapter,
      resolveSpec: specs(),
      limiter: {
        check: (key, limits) => { seen.push(limits); return 0 },
        recordRequest: () => {},
        recordTokens: () => {}
      }
    }))
    expect(seen[0].rpmLimit).toBe(2)
  })
})

describe('adapter emission', () => {
  test('every provider in SPEED_PARAMS names a non-empty parameter', () => {
    for (const [provider, param] of Object.entries(SPEED_PARAMS)) {
      expect(typeof param, provider).toBe('string')
      expect(param.length, provider).toBeGreaterThan(0)
    }
  })

  function anthropicClient () {
    const captured = {}
    const client = {
      messages: {
        stream (request) {
          captured.request = request
          return {
            async * [Symbol.asyncIterator] () {
              yield { type: 'message_start', message: { usage: { input_tokens: 1_000_000 } } }
              yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }
              yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1_000_000 } }
            }
          }
        }
      }
    }
    return { client, captured }
  }

  test('the lane parameter reaches the wire with the overlay\'s value', async () => {
    setCatalog({ 'anthropic/claude-x': LANED })
    const { client, captured } = anthropicClient()
    await collect(anthropic(envelope({ speed: 'bare' }), { client }))
    expect(captured.request.speed).toBe('economy')
  })

  test('no lane means no parameter at all', async () => {
    setCatalog({ 'anthropic/claude-x': LANED })
    const { client, captured } = anthropicClient()
    await collect(anthropic(envelope(), { client }))
    expect('speed' in captured.request).toBe(false)
  })

  test('the call is billed at the lane\'s rates end to end', async () => {
    setCatalog({ 'anthropic/claude-x': LANED })
    const { client } = anthropicClient()
    const base = await collect(anthropic(envelope(), { client }))
    expect(base.at(-1).result.cost).toBeCloseTo(18, 6)

    const { client: fastClient } = anthropicClient()
    const fast = await collect(anthropic(envelope({ speed: 'fast' }), { client: fastClient }))
    expect(fast.at(-1).result.cost).toBeCloseTo(36, 6)
  })

  test('an adapter handed an undeclared lane throws rather than dropping it', async () => {
    setCatalog({ 'anthropic/claude-x': LANED })
    const { client } = anthropicClient()
    await expect(collect(anthropic(envelope({ speed: 'turbo' }), { client })))
      .rejects.toThrow(/does not declare speed lane/)
  })
})
