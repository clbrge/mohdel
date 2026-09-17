import { describe, test, expect, vi } from 'vitest'
import { runEmbedding } from '../../js/session/run_embedding.js'
import { createRateLimiter } from '../../js/session/_rate_limiter.js'

const envelope = (model, input) => ({
  callId: 'c1', authId: 'a1', auth: { key: 'sk-x' }, model, input
})

const adapter = (inputTokens = 0) => vi.fn(async () => ({
  status: 'ok', vectors: [[1]], dimensions: 1, inputTokens, cost: 0
}))

const harness = ({ spec, providerLimits, inputTokens = 0 } = {}) => {
  const limiter = createRateLimiter()
  const sleeps = []
  const embed = adapter(inputTokens)
  const call = (input, model = 'openai/text-embedding-3-small') => runEmbedding(envelope(model, input), {
    resolveAdapter: () => embed,
    resolveProviderLimits: () => providerLimits,
    limiter,
    sleep: async (ms) => { sleeps.push(ms) },
    spec
  })
  return { call, sleeps, limiter, embed }
}

describe('embedding rate limits', () => {
  test('rpm throttles the call past the limit, and every call is counted', async () => {
    const { call, sleeps, embed } = harness({ spec: { rpmLimit: 2 } })
    await call(['a'])
    await call(['b'])
    expect(sleeps).toEqual([])
    await call(['c'])
    expect(sleeps).toHaveLength(1)
    expect(sleeps[0]).toBeGreaterThan(0)
    expect(embed).toHaveBeenCalledTimes(3)
  })

  test('tokens are recorded from the result, so tpm gates the next call', async () => {
    const { call, sleeps } = harness({ spec: { tpmLimit: 100 }, inputTokens: 150 })
    await call(['a'])
    expect(sleeps).toEqual([])
    await call(['b'])
    expect(sleeps).toHaveLength(1)
  })

  test('inpm admits a batch only when the whole batch fits', async () => {
    const { call, sleeps, limiter } = harness({ spec: { inpmLimit: 100 } })
    await call(Array(96).fill('x'))
    expect(sleeps).toEqual([])
    expect(limiter.check('openai', { inpmLimit: 100 }, { inputs: 96 })).toBeGreaterThan(0)
    await call(Array(96).fill('x'))
    expect(sleeps).toHaveLength(1)
  })

  test('a batch larger than the whole allowance is sent rather than delayed', async () => {
    const { call, sleeps, embed } = harness({ spec: { inpmLimit: 50 } })
    await call(Array(96).fill('x'))
    expect(sleeps).toEqual([])
    expect(embed).toHaveBeenCalledTimes(1)
  })

  test('inpm 0 denies', async () => {
    const { call, sleeps } = harness({ spec: { inpmLimit: 0 } })
    await call(['a'])
    expect(sleeps).toHaveLength(1)
  })

  test('no limits anywhere touches nothing', async () => {
    const { call, sleeps, limiter } = harness({})
    await call(['a'])
    expect(sleeps).toEqual([])
    expect(limiter.check('openai', { rpmLimit: 1 })).toBe(0)
  })

  test('the provider level applies when the entry carries none, and the entry wins when it does', async () => {
    const shared = harness({ spec: {}, providerLimits: { rpmLimit: 1 } })
    await shared.call(['a'])
    await shared.call(['b'])
    expect(shared.sleeps).toHaveLength(1)

    const overridden = harness({ spec: { rpmLimit: 3 }, providerLimits: { rpmLimit: 1 } })
    await overridden.call(['a'])
    await overridden.call(['b'])
    expect(overridden.sleeps).toEqual([])
  })

  test('a model-scoped entry gets its own bucket, keyed on the catalog key', async () => {
    const limiter = createRateLimiter()
    const sleeps = []
    const call = (modelKey) => runEmbedding(envelope('openai/text-embedding-3-small', ['a']), {
      resolveAdapter: () => adapter(),
      resolveProviderLimits: () => undefined,
      limiter,
      sleep: async (ms) => { sleeps.push(ms) },
      modelKey,
      spec: { rpmLimit: 1, rateLimitScope: 'model' }
    })
    await call('openai/embed-small')
    await call('openai/other-embed')
    expect(sleeps).toEqual([])
    await call('openai/embed-small')
    expect(sleeps).toHaveLength(1)
  })

  test('a malformed envelope spends no quota', async () => {
    const { call, limiter } = harness({ spec: { rpmLimit: 1 } })
    await call('not-an-array')
    expect(limiter.check('openai', { rpmLimit: 1 })).toBe(0)
  })
})
