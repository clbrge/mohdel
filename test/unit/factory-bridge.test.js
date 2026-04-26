import { describe, test, expect, beforeEach } from 'vitest'

import { runAnswer, runAnswerImage } from '../../js/factory/bridge.js'
import { createCooldownTracker } from '../../js/session/_cooldown.js'
import { createRateLimiter } from '../../js/session/_rate_limiter.js'
import { setCatalog } from '../../js/session/adapters/_catalog.js'
import { MohdelError } from '../../src/lib/errors.js'

beforeEach(() => setCatalog({ 'echo/m': {} }))

function freshDeps () {
  return {
    cooldown: createCooldownTracker(3, 60_000),
    limiter: createRateLimiter(),
    resolveProviderLimits: () => undefined
  }
}

const baseArgs = {
  provider: 'echo',
  model: 'm',
  modelKey: 'echo/m',
  configuration: { apiKey: 'k' },
  prompt: 'hi'
}

const goneDoneAdapter = (result) => async function * () {
  yield {
    type: 'done',
    result: {
      status: 'completed',
      output: 'ok',
      inputTokens: 1,
      outputTokens: 1,
      thinkingTokens: 0,
      cost: 0,
      timestamps: { start: '0', first: '0', end: '0' },
      ...result
    }
  }
}

describe('factory bridge — runAnswer', () => {
  let deps
  beforeEach(() => { deps = freshDeps() })

  test('happy path returns a shaped AnswerResult', async () => {
    const result = await runAnswer(baseArgs, deps)
    expect(result.status).toBe('completed')
    expect(result.output).toBe('Hello, world.')
    expect(typeof result.cost).toBe('number')
    expect(result.timestamps).toHaveProperty('start')
  })

  test('unknown provider throws MohdelError carrying the error type', async () => {
    await expect(runAnswer({ ...baseArgs, modelKey: 'nonesuch/m' }, deps))
      .rejects.toMatchObject({
        name: 'MohdelError',
        message: 'SESSION_UNKNOWN_PROVIDER',
        retryable: false
      })
  })

  test('adapter error event is rethrown as MohdelError with typed detail', async () => {
    const capturing = async function * () {
      yield {
        type: 'error',
        error: {
          message: 'bad key',
          severity: 'error',
          retryable: false,
          type: 'AUTH_INVALID'
        }
      }
    }
    await expect(runAnswer(baseArgs, {
      ...deps,
      resolveAdapter: () => capturing
    })).rejects.toMatchObject({
      name: 'MohdelError',
      message: 'AUTH_INVALID',
      detail: 'bad key',
      retryable: false
    })
  })

  test('envelope carries flat answer options (outputBudget, outputType, identifier, tools, traceparent)', async () => {
    let captured
    const capturing = async function * (env) {
      captured = env
      yield * goneDoneAdapter()()
    }
    await runAnswer({
      ...baseArgs,
      options: {
        outputBudget: 500,
        outputType: 'json',
        outputStyle: 'chat',
        outputEffort: 'low',
        identifier: 'u-42',
        tools: [{ name: 't', parameters: {} }],
        toolChoice: 'auto',
        parallelToolCalls: false,
        traceparent: '00-abc-def-01'
      }
    }, { ...deps, resolveAdapter: () => capturing })

    expect(captured.outputBudget).toBe(500)
    expect(captured.outputType).toBe('json')
    expect(captured.outputStyle).toBe('chat')
    expect(captured.outputEffort).toBe('low')
    expect(captured.identifier).toBe('u-42')
    expect(captured.tools).toHaveLength(1)
    expect(captured.toolChoice).toBe('auto')
    expect(captured.parallelToolCalls).toBe(false)
    expect(captured.traceparent).toBe('00-abc-def-01')
  })

  test('openrouter routing prefs are moved into providerOptions.openrouter', async () => {
    let captured
    const capturing = async function * (env) {
      captured = env
      yield * goneDoneAdapter()()
    }
    await runAnswer({
      ...baseArgs,
      options: {
        providerOrder: ['anthropic'],
        providerDeny: ['azure']
      }
    }, { ...deps, resolveAdapter: () => capturing })
    expect(captured.providerOptions?.openrouter).toEqual({
      order: ['anthropic'],
      allow: undefined,
      deny: ['azure']
    })
  })

  test('auth key from configuration.apiKey becomes envelope.auth.key', async () => {
    let captured
    const capturing = async function * (env) {
      captured = env
      yield * goneDoneAdapter()()
    }
    await runAnswer({
      ...baseArgs,
      configuration: { apiKey: 'sk-test-123' }
    }, { ...deps, resolveAdapter: () => capturing })
    expect(captured.auth.key).toBe('sk-test-123')
  })

  test('realtimeHandler fires for delta events (streaming)', async () => {
    // Simulates a real adapter: emits several message deltas, one
    // function_call delta, then a done event. The bridge must call
    // the handler with buffered {type, delta} payloads per the
    // createRealtimeDeltaBuffer contract.
    const streamingAdapter = async function * () {
      yield { type: 'delta', delta: { type: 'message', delta: 'Hello' } }
      yield { type: 'delta', delta: { type: 'message', delta: ', world' } }
      yield { type: 'delta', delta: { type: 'function_call', delta: '{"x":' } }
      yield {
        type: 'done',
        result: {
          status: 'completed',
          output: 'Hello, world',
          inputTokens: 2,
          outputTokens: 3,
          thinkingTokens: 0,
          cost: 0,
          timestamps: { start: '0', first: '0', end: '0' }
        }
      }
    }

    const captured = []
    const realtimeHandler = (chunk) => captured.push(chunk)

    // Force flush after every character so no buffering latency
    // obscures the test.
    const bufferOpts = { maxChars: 1, maxMs: 0 }

    const result = await runAnswer({
      ...baseArgs,
      options: { realtimeHandler, bufferOpts }
    }, { ...deps, resolveAdapter: () => streamingAdapter })

    // Handler received `{type, delta}` batches.
    expect(captured.length).toBeGreaterThan(0)
    for (const chunk of captured) {
      expect(chunk).toHaveProperty('type')
      expect(chunk).toHaveProperty('delta')
      expect(['message', 'function_call']).toContain(chunk.type)
    }
    // Combined message content matches what the adapter emitted.
    const msgDeltas = captured.filter(c => c.type === 'message').map(c => c.delta).join('')
    expect(msgDeltas).toBe('Hello, world')
    const fnDeltas = captured.filter(c => c.type === 'function_call').map(c => c.delta).join('')
    expect(fnDeltas).toBe('{"x":')
    // Terminal result still comes back.
    expect(result.status).toBe('completed')
  })

  test('realtimeHandler is flushed even when adapter errors mid-stream', async () => {
    const crashingAdapter = async function * () {
      yield { type: 'delta', delta: { type: 'message', delta: 'partial' } }
      yield {
        type: 'error',
        error: { message: 'boom', severity: 'error', retryable: false, type: 'PROVIDER_ERROR' }
      }
    }
    const captured = []
    const realtimeHandler = (chunk) => captured.push(chunk)

    await expect(runAnswer({
      ...baseArgs,
      options: { realtimeHandler, bufferOpts: { maxChars: 1, maxMs: 0 } }
    }, { ...deps, resolveAdapter: () => crashingAdapter }))
      .rejects.toBeInstanceOf(MohdelError)

    expect(captured.map(c => c.delta).join('')).toBe('partial')
  })

  test('no realtimeHandler → no throw, deltas silently ignored', async () => {
    const streamingAdapter = async function * () {
      yield { type: 'delta', delta: { type: 'message', delta: 'x' } }
      yield * goneDoneAdapter()()
    }
    const result = await runAnswer(baseArgs, {
      ...deps, resolveAdapter: () => streamingAdapter
    })
    expect(result.status).toBe('completed')
  })

  test('{system, messages} shape is normalized into Message[]', async () => {
    let captured
    const capturing = async function * (env) {
      captured = env
      yield * goneDoneAdapter()()
    }
    await runAnswer({
      ...baseArgs,
      prompt: {
        system: 'Be terse.',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: '4' },
          { role: 'user', content: 'add 3' }
        ]
      }
    }, { ...deps, resolveAdapter: () => capturing })
    expect(Array.isArray(captured.prompt)).toBe(true)
    expect(captured.prompt).toEqual([
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '4' },
      { role: 'user', content: 'add 3' }
    ])
  })

  test('tool_result role is renamed to tool with toolCallId + name', async () => {
    let captured
    const capturing = async function * (env) {
      captured = env
      yield * goneDoneAdapter()()
    }
    await runAnswer({
      ...baseArgs,
      prompt: {
        messages: [
          { role: 'user', content: 'what is the hostname?' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', name: 'get_hostname', arguments: {} }]
          },
          {
            role: 'tool_result',
            toolCallId: 'c1',
            toolName: 'get_hostname',
            content: 'dev-box'
          }
        ]
      }
    }, { ...deps, resolveAdapter: () => capturing })

    // Assistant preserves toolCalls; tool_result becomes tool.
    expect(captured.prompt[1]).toEqual({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'get_hostname', arguments: {} }]
    })
    expect(captured.prompt[2]).toEqual({
      role: 'tool',
      toolCallId: 'c1',
      toolName: 'get_hostname',
      content: 'dev-box'
    })
  })

  test('system as block array is flattened to a string', async () => {
    let captured
    const capturing = async function * (env) {
      captured = env
      yield * goneDoneAdapter()()
    }
    await runAnswer({
      ...baseArgs,
      prompt: {
        system: [
          { text: 'first block' },
          { text: 'second block', cache: true }
        ],
        messages: [{ role: 'user', content: 'hi' }]
      }
    }, { ...deps, resolveAdapter: () => capturing })

    expect(captured.prompt[0]).toEqual({
      role: 'system',
      content: 'first block\nsecond block'
    })
  })

  test('plain string prompt still passes through unchanged', async () => {
    let captured
    const capturing = async function * (env) {
      captured = env
      yield * goneDoneAdapter()()
    }
    await runAnswer({ ...baseArgs, prompt: 'plain string' }, {
      ...deps, resolveAdapter: () => capturing
    })
    expect(captured.prompt).toBe('plain string')
  })

  test('pre-shaped Message[] passes through unchanged', async () => {
    const shaped = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' }
    ]
    let captured
    const capturing = async function * (env) {
      captured = env
      yield * goneDoneAdapter()()
    }
    await runAnswer({ ...baseArgs, prompt: shaped }, {
      ...deps, resolveAdapter: () => capturing
    })
    expect(captured.prompt).toEqual(shaped)
  })
})

describe('compat bridge — runAnswerImage', () => {
  test('uses supplied spec override instead of session catalog', async () => {
    let submitted
    global.fetch = async (url, opts) => {
      if (opts?.method === 'POST') {
        submitted = JSON.parse(opts.body)
        return { ok: true, status: 200, json: async () => ({ task_id: 't' }) }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          task: { status: 'TASK_STATUS_SUCCEED' },
          images: [{ image_url: 'https://x/y.png' }]
        })
      }
    }
    const result = await runAnswerImage({
      provider: 'novita',
      model: 'flux-dev',
      configuration: { apiKey: 'k' },
      prompt: 'a cube',
      spec: { imageEndpoint: 'flux-dev' }
    })
    expect(result.status).toBe('completed')
    expect(submitted.prompt).toBe('a cube')
  })

  test('error surface: unknown provider yields MohdelError', async () => {
    await expect(runAnswerImage({
      provider: 'nonesuch',
      model: 'x',
      configuration: { apiKey: 'k' },
      prompt: 'x'
    })).rejects.toMatchObject({
      name: 'MohdelError',
      message: 'SESSION_UNKNOWN_PROVIDER'
    })
  })
})

// F11 regression: bridge must reject invalid prompt shapes up-front
// instead of letting them propagate into the adapter.
describe('compat bridge — invalid prompt shapes', () => {
  let deps
  beforeEach(() => { deps = freshDeps() })

  const capturing = async function * () {
    throw new Error('adapter should NOT be reached for invalid prompts')
  }

  async function expectInvalidPrompt (prompt, shapeHint) {
    try {
      await runAnswer({ ...baseArgs, prompt }, { ...deps, resolveAdapter: () => capturing })
      expect.unreachable('should have thrown SESSION_INVALID_PROMPT')
    } catch (err) {
      expect(err).toBeInstanceOf(MohdelError)
      expect(err.message).toBe('SESSION_INVALID_PROMPT')
      expect(err.retryable).toBe(false)
      expect(err.detail).toContain(shapeHint)
    }
  }

  test('null prompt → SESSION_INVALID_PROMPT (detail mentions null)', async () => {
    await expectInvalidPrompt(null, 'null')
  })

  test('undefined prompt → SESSION_INVALID_PROMPT (detail mentions undefined)', async () => {
    await expectInvalidPrompt(undefined, 'undefined')
  })

  test('primitive (number) prompt → SESSION_INVALID_PROMPT (detail mentions number)', async () => {
    await expectInvalidPrompt(42, 'number')
  })

  test('object without messages → SESSION_INVALID_PROMPT', async () => {
    await expectInvalidPrompt({ system: 'Be terse.' }, 'object without messages')
  })

  test('object with non-array messages → SESSION_INVALID_PROMPT', async () => {
    await expectInvalidPrompt({ messages: 'not an array' }, 'object with non-array messages')
  })
})

// F24: per-call `configuration` overrides (baseURL, defaultHeaders,
// organization, timeout) are no longer plumbed. Silent drop would
// risk leaking prompts + keys to a provider the caller never
// intended to reach (e.g. corporate proxy configs). Throw loudly.
describe('compat bridge — configuration normalization (F24)', () => {
  let deps
  beforeEach(() => { deps = freshDeps() })

  test('apiKey-only configuration is accepted', async () => {
    const result = await runAnswer({ ...baseArgs, configuration: { apiKey: 'k' } }, deps)
    expect(result.status).toBe('completed')
  })

  test('missing configuration is accepted (empty apiKey)', async () => {
    const result = await runAnswer({ ...baseArgs, configuration: undefined }, deps)
    expect(result.status).toBe('completed')
  })

  test('configuration.baseURL flows onto envelope.auth.baseURL', async () => {
    let captured
    const capturing = async function * (env) {
      captured = env
      yield * goneDoneAdapter()()
    }
    await runAnswer({
      ...baseArgs,
      configuration: { apiKey: 'k', baseURL: 'https://proxy.corp/v1' }
    }, { ...deps, resolveAdapter: () => capturing })
    expect(captured.auth.key).toBe('k')
    expect(captured.auth.baseURL).toBe('https://proxy.corp/v1')
  })

  test('configuration.defaultHeaders throws with detail listing the key', async () => {
    try {
      await runAnswer({ ...baseArgs, configuration: { defaultHeaders: { 'x-a': '1' } } }, deps)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(MohdelError)
      expect(e.message).toBe('CONFIGURATION_UNSUPPORTED')
      expect(e.detail).toContain('defaultHeaders')
    }
  })

  test('multiple unsupported keys are all listed in detail', async () => {
    try {
      await runAnswer({
        ...baseArgs,
        configuration: { apiKey: 'k', baseURL: 'u', organization: 'org', timeout: 30 }
      }, deps)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e.message).toBe('CONFIGURATION_UNSUPPORTED')
      expect(e.detail).toContain('baseURL')
      expect(e.detail).toContain('organization')
      expect(e.detail).toContain('timeout')
    }
  })
})
