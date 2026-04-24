import { describe, test, expect, beforeEach } from 'vitest'

import { groq } from '../../js/session/adapters/groq.js'
import { cerebras } from '../../js/session/adapters/cerebras.js'
import { deepseek } from '../../js/session/adapters/deepseek.js'
import { mistral } from '../../js/session/adapters/mistral.js'
import { openrouter } from '../../js/session/adapters/openrouter.js'
import { fireworks } from '../../js/session/adapters/fireworks.js'
import { xai } from '../../js/session/adapters/xai.js'
import { setCatalog } from '../../js/session/adapters/_catalog.js'

/** @returns {import('#core/envelope.js').CallEnvelope} */
function envelope (provider, bare, overrides = {}) {
  return {
    callId: 'c1',
    authId: 'a1',
    auth: { key: 'k' },
    model: `${provider}/${bare}`,
    prompt: 'hi',
    ...overrides
  }
}

async function collect (iter) {
  const out = []
  for await (const v of iter) out.push(v)
  return out
}

function mockChat (response) {
  const captured = {}
  return {
    client: {
      chat: {
        completions: {
          create: async (args, requestOptions) => {
            captured.args = args
            captured.requestOptions = requestOptions
            return response
          }
        }
      }
    },
    captured
  }
}

function mockChatStream (chunks) {
  const captured = {}
  return {
    client: {
      chat: {
        completions: {
          create: async (args, requestOptions) => {
            captured.args = args
            captured.requestOptions = requestOptions
            return (async function * () { for (const c of chunks) yield c })()
          }
        }
      }
    },
    captured
  }
}

const basicResponse = (overrides = {}) => ({
  choices: [{
    message: { content: 'hello world', tool_calls: null },
    finish_reason: 'stop',
    ...overrides.choice
  }],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 2,
    ...overrides.usage
  },
  ...overrides.top
})

beforeEach(() => setCatalog({}))

// ---------- Groq ----------

describe('groq adapter', () => {
  test('builds non-streaming request and emits delta + done', async () => {
    const { client, captured } = mockChat(basicResponse())
    const events = await collect(groq(envelope('groq', 'llama-3'), { client }))
    expect(captured.args.model).toBe('llama-3')
    expect(captured.args.temperature).toBe(0)
    expect(captured.args.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(events.map(e => e.type)).toEqual(['delta', 'done'])
    expect(events[1].result.output).toBe('hello world')
    expect(events[1].result.inputTokens).toBe(10)
    expect(events[1].result.outputTokens).toBe(2)
    expect(events[1].result.status).toBe('completed')
  })

  test('finish_reason=length → incomplete + warning', async () => {
    const { client } = mockChat(basicResponse({ choice: { finish_reason: 'length' } }))
    const events = await collect(groq(envelope('groq', 'llama-3'), { client }))
    expect(events.at(-1).result.status).toBe('incomplete')
    expect(events.at(-1).result.warning).toBe('insufficientOutputBudget')
  })

  test('tool_calls switch status to tool_use', async () => {
    const { client } = mockChat({
      choices: [{
        message: {
          content: null,
          tool_calls: [{ id: 'c1', function: { name: 'do', arguments: '{"a":1}' } }]
        },
        finish_reason: 'tool_calls'
      }],
      usage: { prompt_tokens: 5, completion_tokens: 3 }
    })
    const events = await collect(groq(envelope('groq', 'llama-3', {
      tools: [{ name: 'do', parameters: { type: 'object' } }]
    }), { client }))
    expect(events.at(-1).result.status).toBe('tool_use')
    expect(events.at(-1).result.toolCalls[0].name).toBe('do')
  })

  test('401 is classified as AUTH_INVALID', async () => {
    const client = {
      chat: {
        completions: {
          create: async () => {
            const e = new Error('unauth'); e.status = 401; throw e
          }
        }
      }
    }
    const events = await collect(groq(envelope('groq', 'llama-3'), { client }))
    expect(events.at(-1).type).toBe('error')
    expect(events.at(-1).error.type).toBe('AUTH_INVALID')
  })

  test('identifier maps to args.user by default', async () => {
    const { client, captured } = mockChat(basicResponse())
    await collect(groq(envelope('groq', 'llama-3', { identifier: 'u-1' }), { client }))
    expect(captured.args.user).toBe('u-1')
  })
})

// ---------- Cerebras ----------

describe('cerebras adapter', () => {
  test('reasoning uses disable_reasoning toggle for zai models', async () => {
    setCatalog({ 'cerebras/zai-glm-4.6': { thinkingEffortLevels: { low: 500, high: 2000 } } })
    const { client, captured } = mockChat(basicResponse())
    await collect(cerebras(envelope('cerebras', 'zai-glm-4.6', { outputEffort: 'high', outputBudget: 100 }), { client }))
    expect(captured.args.disable_reasoning).toBe(false)
    expect(captured.args.reasoning_effort).toBeUndefined()
  })

  test('reasoning_effort set for non-zai models with thinkingEffortLevels', async () => {
    setCatalog({ 'cerebras/llama-3-thinking': { thinkingEffortLevels: { low: 500 } } })
    const { client, captured } = mockChat(basicResponse())
    await collect(cerebras(envelope('cerebras', 'llama-3-thinking', { outputEffort: 'low', outputBudget: 100 }), { client }))
    expect(captured.args.reasoning_effort).toBe('low')
    expect(captured.args.disable_reasoning).toBeUndefined()
  })

  test('tool_choice flavor cerebras leaves required as-is', async () => {
    const { client, captured } = mockChat(basicResponse())
    await collect(cerebras(envelope('cerebras', 'llama-3', {
      tools: [{ name: 'x', parameters: {} }],
      toolChoice: 'required'
    }), { client }))
    expect(captured.args.tool_choice).toBe('required')
  })
})

// ---------- DeepSeek ----------

describe('deepseek adapter', () => {
  test('DSML tool calls in content are parsed into toolCalls', async () => {
    const DSML = '<\uFF5CDSML\uFF5Cfunction_calls><\uFF5CDSML\uFF5Cinvoke name="lookup"><\uFF5CDSML\uFF5Cparameter name="q">weather</\uFF5CDSML\uFF5Cparameter></\uFF5CDSML\uFF5Cinvoke></\uFF5CDSML\uFF5Cfunction_calls>'
    const { client } = mockChat({
      choices: [{
        message: { content: `prefix ${DSML} suffix`, tool_calls: null },
        finish_reason: 'stop'
      }],
      usage: { prompt_tokens: 5, completion_tokens: 3 }
    })
    const events = await collect(deepseek(envelope('deepseek', 'deepseek-chat'), { client }))
    const done = events.at(-1)
    expect(done.result.status).toBe('tool_use')
    expect(done.result.toolCalls).toHaveLength(1)
    expect(done.result.toolCalls[0].name).toBe('lookup')
    expect(done.result.toolCalls[0].arguments.q).toBe('weather')
    expect(done.result.output).toBe('prefix  suffix')
  })

  test('native tool_calls win over DSML parsing', async () => {
    const { client } = mockChat({
      choices: [{
        message: {
          content: null,
          tool_calls: [{ id: 'c1', function: { name: 'native', arguments: '{}' } }]
        },
        finish_reason: 'tool_calls'
      }],
      usage: { prompt_tokens: 5, completion_tokens: 3 }
    })
    const events = await collect(deepseek(envelope('deepseek', 'deepseek-chat'), { client }))
    expect(events.at(-1).result.toolCalls[0].name).toBe('native')
  })
})

// ---------- Mistral ----------

describe('mistral adapter', () => {
  test('tool_choice required → any (mistral flavor)', async () => {
    const { client, captured } = mockChat(basicResponse())
    await collect(mistral(envelope('mistral', 'mistral-large', {
      tools: [{ name: 'x', parameters: {} }],
      toolChoice: 'required'
    }), { client }))
    expect(captured.args.tool_choice).toBe('any')
  })
})

// ---------- OpenRouter ----------

describe('openrouter adapter', () => {
  test('streams deltas and final done event', async () => {
    const { client } = mockChatStream([
      { choices: [{ delta: { content: 'hello' } }] },
      { choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2 } }
    ])
    const events = await collect(openrouter(envelope('openrouter', 'any/model'), { client }))
    expect(events.filter(e => e.type === 'delta').map(e => e.delta.delta).join('')).toBe('hello world')
    expect(events.at(-1).result.status).toBe('completed')
    expect(events.at(-1).result.inputTokens).toBe(4)
  })

  test('providerOptions.openrouter is spliced into args.provider', async () => {
    const { client, captured } = mockChatStream([
      { choices: [{ finish_reason: 'stop' }], usage: {} }
    ])
    await collect(openrouter(envelope('openrouter', 'any/model', {
      providerOptions: { openrouter: { order: ['anthropic', 'openai'], deny: ['azure'] } }
    }), { client }))
    expect(captured.args.provider).toEqual({ order: ['anthropic', 'openai'], deny: ['azure'] })
  })

  test('streaming tool calls accumulate and terminate as tool_use', async () => {
    const { client } = mockChatStream([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'f' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":1' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] }, finish_reason: 'tool_calls' }], usage: {} }
    ])
    const events = await collect(openrouter(envelope('openrouter', 'any/model'), { client }))
    const done = events.at(-1)
    expect(done.result.status).toBe('tool_use')
    expect(done.result.toolCalls).toHaveLength(1)
    expect(done.result.toolCalls[0].name).toBe('f')
    expect(done.result.toolCalls[0].arguments).toEqual({ x: 1 })
  })

  // F7 regression: multi-tool streams, and chunks missing `index`.

  test('two tool calls streamed with `index` on every chunk → two distinct slots', async () => {
    const { client } = mockChatStream([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'get_weather' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 't2', function: { name: 'get_time' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"Paris"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"zone":"UTC"}' } }] } }] },
      { choices: [{ finish_reason: 'tool_calls' }], usage: {} }
    ])
    const done = (await collect(openrouter(envelope('openrouter', 'any/model'), { client }))).at(-1)
    expect(done.result.toolCalls).toHaveLength(2)
    expect(done.result.toolCalls[0]).toEqual({ id: 't1', name: 'get_weather', arguments: { city: 'Paris' } })
    expect(done.result.toolCalls[1]).toEqual({ id: 't2', name: 'get_time', arguments: { zone: 'UTC' } })
  })

  test('two tool calls streamed with only `id` (no index) → id-keyed separation', async () => {
    const { client } = mockChatStream([
      { choices: [{ delta: { tool_calls: [{ id: 't1', function: { name: 'get_weather' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ id: 't2', function: { name: 'get_time' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ id: 't1', function: { arguments: '{"city":"Paris"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ id: 't2', function: { arguments: '{"zone":"UTC"}' } }] } }] },
      { choices: [{ finish_reason: 'tool_calls' }], usage: {} }
    ])
    const done = (await collect(openrouter(envelope('openrouter', 'any/model'), { client }))).at(-1)
    expect(done.result.toolCalls).toHaveLength(2)
    const byId = Object.fromEntries(done.result.toolCalls.map(tc => [tc.id, tc]))
    expect(byId.t1).toEqual({ id: 't1', name: 'get_weather', arguments: { city: 'Paris' } })
    expect(byId.t2).toEqual({ id: 't2', name: 'get_time', arguments: { zone: 'UTC' } })
  })

  test('opener has `id + index`, continuations have only `id` → single slot, args concatenate', async () => {
    const { client } = mockChatStream([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'f' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ id: 't1', function: { arguments: '{"x":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ id: 't1', function: { arguments: '42}' } }] } }] },
      { choices: [{ finish_reason: 'tool_calls' }], usage: {} }
    ])
    const done = (await collect(openrouter(envelope('openrouter', 'any/model'), { client }))).at(-1)
    expect(done.result.toolCalls).toHaveLength(1)
    expect(done.result.toolCalls[0]).toEqual({ id: 't1', name: 'f', arguments: { x: 42 } })
  })

  // F40: streaming iterator throws mid-stream (upstream disconnect,
  // 502 from server, ...). Adapter must convert to a single `error`
  // event — not swallow the throw or leave the call terminal-less.
  test('streaming error mid-stream yields a terminal error event', async () => {
    const client = {
      chat: {
        completions: {
          create: async () => (async function * () {
            yield { choices: [{ delta: { content: 'partial' } }] }
            const e = new Error('upstream disconnect')
            e.status = 502
            throw e
          })()
        }
      }
    }
    const events = await collect(openrouter(envelope('openrouter', 'any/model'), { client }))
    // The partial delta made it through before the throw.
    expect(events.some(e => e.type === 'delta')).toBe(true)
    // Terminal is a single error event classified from the SDK error.
    const terminal = events.at(-1)
    expect(terminal.type).toBe('error')
    expect(typeof terminal.error.message).toBe('string')
    expect(terminal.error.message.length).toBeGreaterThan(0)
  })

  test('chunks with neither id nor index are dropped (warn logged); valid chunks still work', async () => {
    const warnings = []
    const log = { warn: (fields, msg) => warnings.push({ fields, msg }) }

    const { client } = mockChatStream([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'f' } }] } }] },
      // Garbage chunk: no id, no index. MUST NOT merge into slot 0.
      { choices: [{ delta: { tool_calls: [{ function: { name: 'GARBAGE', arguments: '!!' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"ok":1}' } }] } }] },
      { choices: [{ finish_reason: 'tool_calls' }], usage: {} }
    ])
    const done = (await collect(openrouter(envelope('openrouter', 'any/model'), { client, log }))).at(-1)

    expect(done.result.toolCalls).toHaveLength(1)
    expect(done.result.toolCalls[0]).toEqual({ id: 't1', name: 'f', arguments: { ok: 1 } })
    // Warn was logged for the unusable chunk.
    expect(warnings.length).toBe(1)
    expect(warnings[0].msg).toMatch(/no id or index/i)
  })
})

// ---------- Fireworks ----------

describe('fireworks adapter', () => {
  test('prefixes bare model ids with accounts/fireworks/models/', async () => {
    const { client, captured } = mockChatStream([
      { choices: [{ finish_reason: 'stop' }], usage: {} }
    ])
    await collect(fireworks(envelope('fireworks', 'llama-3-70b'), { client }))
    expect(captured.args.model).toBe('accounts/fireworks/models/llama-3-70b')
  })

  test('leaves prefixed model ids untouched', async () => {
    const { client, captured } = mockChatStream([
      { choices: [{ finish_reason: 'stop' }], usage: {} }
    ])
    await collect(fireworks(envelope('fireworks', 'accounts/fireworks/models/llama-3-70b'), { client }))
    expect(captured.args.model).toBe('accounts/fireworks/models/llama-3-70b')
  })
})

// ---------- xAI ----------

describe('xai adapter', () => {
  test('delegates to openai Responses API with supplied client', async () => {
    const captured = {}
    const client = {
      responses: {
        stream: (req) => {
          captured.req = req
          return {
            async * [Symbol.asyncIterator] () {
              yield { type: 'response.output_text.delta', delta: 'greet' }
              yield { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 1 } } }
            }
          }
        }
      }
    }
    const events = await collect(xai(envelope('xai', 'grok-2'), { client }))
    expect(captured.req.model).toBe('grok-2')
    expect(events.at(-1).result.output).toBe('greet')
  })

  test('identifier uses user field (not safety_identifier) for xai', async () => {
    const captured = {}
    const client = {
      responses: {
        stream: (req) => {
          captured.req = req
          return {
            async * [Symbol.asyncIterator] () {
              yield { type: 'response.completed', response: { usage: {} } }
            }
          }
        }
      }
    }
    await collect(xai(envelope('xai', 'grok-2', { identifier: 'u1' }), { client }))
    expect(captured.req.user).toBe('u1')
    expect(captured.req.safety_identifier).toBeUndefined()
  })

  test('reasoning param is omitted for xai even when spec has thinkingEffortLevels', async () => {
    setCatalog({ 'xai/grok-thinker': { thinkingEffortLevels: { low: 500 } } })
    const captured = {}
    const client = {
      responses: {
        stream: (req) => {
          captured.req = req
          return {
            async * [Symbol.asyncIterator] () {
              yield { type: 'response.completed', response: { usage: {} } }
            }
          }
        }
      }
    }
    await collect(xai(envelope('xai', 'grok-thinker', { outputEffort: 'low', outputBudget: 100 }), { client }))
    expect(captured.req.reasoning).toBeUndefined()
    // Headroom is still added to the budget
    expect(captured.req.max_output_tokens).toBe(600)
  })
})

// ---------- F15: signal propagation through wrappers ----------
//
// Each wrapper must forward deps.signal as requestOptions (second arg) to the
// SDK's chat.completions.create. Without it, AbortController.abort() can't
// cancel an in-flight HTTP request — it only stops event iteration.

describe('signal propagation (F15)', () => {
  test('groq forwards deps.signal to SDK', async () => {
    const { client, captured } = mockChat(basicResponse())
    const controller = new AbortController()
    await collect(groq(envelope('groq', 'llama-3'), { client, signal: controller.signal }))
    expect(captured.requestOptions?.signal).toBe(controller.signal)
  })

  test('cerebras forwards deps.signal to SDK', async () => {
    const { client, captured } = mockChat(basicResponse())
    const controller = new AbortController()
    await collect(cerebras(envelope('cerebras', 'llama-3'), { client, signal: controller.signal }))
    expect(captured.requestOptions?.signal).toBe(controller.signal)
  })

  test('deepseek forwards deps.signal to SDK', async () => {
    const { client, captured } = mockChat(basicResponse())
    const controller = new AbortController()
    await collect(deepseek(envelope('deepseek', 'deepseek-chat'), { client, signal: controller.signal }))
    expect(captured.requestOptions?.signal).toBe(controller.signal)
  })

  test('mistral forwards deps.signal to SDK', async () => {
    const { client, captured } = mockChat(basicResponse())
    const controller = new AbortController()
    await collect(mistral(envelope('mistral', 'mistral-large'), { client, signal: controller.signal }))
    expect(captured.requestOptions?.signal).toBe(controller.signal)
  })

  test('fireworks forwards deps.signal to SDK', async () => {
    const { client, captured } = mockChatStream([
      { choices: [{ finish_reason: 'stop' }], usage: {} }
    ])
    const controller = new AbortController()
    await collect(fireworks(envelope('fireworks', 'llama-3-70b'), { client, signal: controller.signal }))
    expect(captured.requestOptions?.signal).toBe(controller.signal)
  })
})
