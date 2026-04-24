import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { computeCost, costFor, setPricing } from '../../js/session/adapters/_pricing.js'
import { loadCatalog, getSpec, setCatalog } from '../../js/session/adapters/_catalog.js'

describe('computeCost', () => {
  test('returns 0 when spec is undefined', () => {
    expect(computeCost(undefined, { inputTokens: 100, outputTokens: 200 })).toBe(0)
  })

  test('returns 0 when spec lacks pricing fields', () => {
    expect(computeCost({ creator: 'anthropic' }, { inputTokens: 100, outputTokens: 200 })).toBe(0)
  })

  test('computes from inputPrice + outputPrice in spec', () => {
    const spec = { inputPrice: 3, outputPrice: 15 }
    expect(computeCost(spec, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(18)
  })

  test('sub-million token counts scale down', () => {
    const spec = { inputPrice: 1, outputPrice: 5 }
    expect(computeCost(spec, { inputTokens: 1000, outputTokens: 500 })).toBeCloseTo(0.0035, 6)
  })

  test('thinkingTokens default to outputPrice rate', () => {
    const spec = { inputPrice: 1, outputPrice: 5 }
    expect(computeCost(spec, { inputTokens: 0, outputTokens: 0, thinkingTokens: 1_000_000 })).toBe(5)
  })

  test('explicit thinkingPrice overrides outputPrice for thinking tokens', () => {
    const spec = { inputPrice: 1, outputPrice: 5, thinkingPrice: 10 }
    expect(computeCost(spec, { inputTokens: 0, outputTokens: 0, thinkingTokens: 1_000_000 })).toBe(10)
  })

  test('missing usage fields default to 0', () => {
    expect(computeCost({ inputPrice: 1, outputPrice: 5 }, {})).toBe(0)
  })

  // Tiered pricing (OpenAI gpt-5.4, xAI grok-4-1-fast, etc.) expresses
  // prices as `{">THRESHOLD": rate, "default": rate}` where the active
  // rate depends on the call's input-token count.
  describe('tiered pricing', () => {
    test('below threshold uses default rate', () => {
      const spec = {
        inputPrice: { '>272000': 5, default: 2.5 },
        outputPrice: { '>272000': 22.5, default: 15 }
      }
      const cost = computeCost(spec, { inputTokens: 100_000, outputTokens: 1000 })
      // 100k * 2.5 + 1k * 15 → 0.265
      expect(cost).toBeCloseTo(0.265, 6)
    })

    test('above threshold uses surcharge rate', () => {
      const spec = {
        inputPrice: { '>272000': 5, default: 2.5 },
        outputPrice: { '>272000': 22.5, default: 15 }
      }
      const cost = computeCost(spec, { inputTokens: 500_000, outputTokens: 1000 })
      // 500k * 5 + 1k * 22.5 → 2.5225
      expect(cost).toBeCloseTo(2.5225, 6)
    })

    test('at-threshold stays on default (strictly >)', () => {
      const spec = { inputPrice: { '>100': 10, default: 1 }, outputPrice: 0 }
      expect(computeCost(spec, { inputTokens: 100, outputTokens: 0 })).toBeCloseTo(0.0001, 8)
      expect(computeCost(spec, { inputTokens: 101, outputTokens: 0 })).toBeCloseTo(0.00101, 8)
    })

    test('multi-tier picks highest threshold that inputTokens exceeds', () => {
      const spec = {
        inputPrice: { '>100000': 2, '>500000': 4, default: 1 },
        outputPrice: 0
      }
      expect(computeCost(spec, { inputTokens: 50_000, outputTokens: 0 })).toBeCloseTo(0.05, 6)
      expect(computeCost(spec, { inputTokens: 200_000, outputTokens: 0 })).toBeCloseTo(0.4, 6)
      expect(computeCost(spec, { inputTokens: 600_000, outputTokens: 0 })).toBeCloseTo(2.4, 6)
    })

    test('mixed shape: scalar input, tiered output', () => {
      const spec = {
        inputPrice: 1,
        outputPrice: { '>100000': 20, default: 10 }
      }
      expect(computeCost(spec, { inputTokens: 50_000, outputTokens: 1000 }))
        .toBeCloseTo(0.06, 6) // 50k*1 + 1k*10 → 0.06
      expect(computeCost(spec, { inputTokens: 200_000, outputTokens: 1000 }))
        .toBeCloseTo(0.22, 6) // 200k*1 + 1k*20 → 0.22
    })

    test('thinkingPrice falls back to (resolved) outputPrice', () => {
      const spec = {
        inputPrice: 0,
        outputPrice: { '>272000': 22.5, default: 15 }
      }
      // thinking tokens billed at outputPrice's active tier
      expect(computeCost(spec, { inputTokens: 0, outputTokens: 0, thinkingTokens: 1_000_000 }))
        .toBe(15)
      expect(computeCost(spec, { inputTokens: 500_000, outputTokens: 0, thinkingTokens: 1_000_000 }))
        .toBe(22.5)
    })

    test('explicit tiered thinkingPrice wins over outputPrice', () => {
      const spec = {
        inputPrice: 0,
        outputPrice: 15,
        thinkingPrice: { '>100000': 30, default: 20 }
      }
      expect(computeCost(spec, { inputTokens: 50_000, outputTokens: 0, thinkingTokens: 1_000_000 }))
        .toBe(20)
      expect(computeCost(spec, { inputTokens: 200_000, outputTokens: 0, thinkingTokens: 1_000_000 }))
        .toBe(30)
    })

    test('malformed tiered map without numeric default returns 0', () => {
      const spec = { inputPrice: { '>100': 'bogus' }, outputPrice: 5 }
      expect(computeCost(spec, { inputTokens: 1000, outputTokens: 100 })).toBe(0)
    })

    test('tier keys that are not ">N" are ignored', () => {
      const spec = {
        inputPrice: { foo: 99, '>100': 2, default: 1 },
        outputPrice: 0
      }
      expect(computeCost(spec, { inputTokens: 50, outputTokens: 0 })).toBeCloseTo(0.00005, 8)
      expect(computeCost(spec, { inputTokens: 500, outputTokens: 0 })).toBeCloseTo(0.001, 8)
    })

    test('full-spec shape: scalar sdk/model fields alongside tiered prices', () => {
      // Catalog entries frequently carry non-pricing fields
      // (`sdk`, `model`, `provider`, `thinkingEffortLevels`, ...).
      // `computeCost` reads only the three price fields and ignores
      // the rest.
      const spec = {
        sdk: 'openai',
        model: 'some-model',
        inputPrice: { '>272000': 5, default: 2.5 },
        outputPrice: { '>272000': 22.5, default: 15 }
      }
      const cost = computeCost(spec, {
        inputTokens: 10_000, outputTokens: 500, thinkingTokens: 200
      })
      // 10000*2.5 + 500*15 + 200*15 → 0.03550  (input below threshold)
      expect(cost).toBeCloseTo(0.0355, 6)
    })
  })
})

describe('loadCatalog from curated.json', () => {
  let tmpDir, tmpFile

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mohdel-catalog-'))
    tmpFile = path.join(tmpDir, 'curated.json')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('reads full curated entries (spec includes pricing + thinking metadata)', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({
      'anthropic/claude-haiku-4-5': { inputPrice: 1, outputPrice: 5, model: 'claude-haiku-4-5' },
      'anthropic/claude-opus-4-5': {
        inputPrice: 15,
        outputPrice: 75,
        thinkingPrice: 75,
        thinkingEffortLevels: { low: 8192, medium: 16384, high: 32768 },
        defaultThinkingEffort: 'medium',
        outputTokenLimit: 64000
      }
    }))

    const catalog = loadCatalog(tmpFile)
    expect(catalog['anthropic/claude-haiku-4-5'].inputPrice).toBe(1)
    expect(catalog['anthropic/claude-opus-4-5'].thinkingEffortLevels.medium).toBe(16384)
    expect(catalog['anthropic/claude-opus-4-5'].defaultThinkingEffort).toBe('medium')
  })

  test('returns {} for missing/malformed/non-object files', () => {
    expect(loadCatalog(path.join(tmpDir, 'nope.json'))).toEqual({})
    fs.writeFileSync(tmpFile, 'not json')
    expect(loadCatalog(tmpFile)).toEqual({})
    fs.writeFileSync(tmpFile, JSON.stringify(['array']))
    expect(loadCatalog(tmpFile)).toEqual({})
  })
})

describe('setCatalog / getSpec / setPricing / costFor', () => {
  beforeEach(() => {
    setCatalog({})
  })

  afterEach(() => setCatalog({}))

  test('setCatalog + getSpec round-trip', () => {
    setCatalog({
      'test/model': {
        inputPrice: 2,
        outputPrice: 10,
        thinkingEffortLevels: { low: 1024 },
        defaultThinkingEffort: 'low'
      }
    })
    const spec = getSpec('test/model')
    expect(spec.inputPrice).toBe(2)
    expect(spec.thinkingEffortLevels.low).toBe(1024)
  })

  test('getSpec returns undefined for unknown model', () => {
    expect(getSpec('unknown/model')).toBeUndefined()
  })

  test('setPricing wrapper still works (back-compat)', () => {
    setPricing({ 'test/model': { input: 2, output: 10 } })
    const cost = costFor('test/model', { inputTokens: 1000, outputTokens: 500 })
    expect(cost).toBeCloseTo(0.007, 6)
  })

  test('costFor returns 0 for unknown model', () => {
    expect(costFor('unknown', { inputTokens: 100, outputTokens: 200 })).toBe(0)
  })

  // Regression for the model-id unification: when the cs-core/mohdel
  // catalog id ("anthropic/claude-haiku-4-5") differs from the SDK
  // wire string stored in spec.model ("claude-haiku-4-5-20251001"),
  // costFor must look up by the catalog key (the id), not by
  // provider/spec.model. A prior bug conflated the two and produced
  // cost=0 silently for every versioned Anthropic model.
  test('costFor resolves pricing via the catalog key even when spec.model is a versioned wire string', () => {
    setCatalog({
      'anthropic/claude-haiku-4-5': {
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        inputPrice: 1,
        outputPrice: 5
      }
    })
    const cost = costFor('anthropic/claude-haiku-4-5', { inputTokens: 1_000_000, outputTokens: 100_000 })
    expect(cost).toBeCloseTo(1.5, 6)
    expect(costFor('anthropic/claude-haiku-4-5-20251001', { inputTokens: 1_000_000, outputTokens: 100_000 })).toBe(0)
  })
})
