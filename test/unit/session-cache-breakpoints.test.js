import { describe, test, expect } from 'vitest'
import { anthropic } from '../../js/session/adapters/anthropic.js'
import { openai } from '../../js/session/adapters/openai.js'
import { setPricing } from '../../js/session/adapters/_pricing.js'

setPricing({
  'anthropic/claude-sonnet-4-5': { input: 3, output: 15 },
  'openai/gpt-5.2': { input: 1, output: 8 }
})

function envelope (overrides = {}) {
  return {
    callId: 'c1',
    authId: 'a1',
    auth: { key: 'sk-test' },
    model: 'anthropic/claude-sonnet-4-5',
    prompt: 'hi',
    ...overrides
  }
}

async function drain (iter) {
  const out = []
  for await (const v of iter) out.push(v)
  return out
}

function makeAnthropicClient () {
  const captured = {}
  const client = {
    messages: {
      stream (request) {
        captured.request = request
        return {
          async * [Symbol.asyncIterator] () {
            yield { type: 'message_start', message: { usage: { input_tokens: 1 } } }
            yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }
          }
        }
      }
    }
  }
  return { client, captured }
}

function systemMsg (blocks) {
  return { role: 'system', content: blocks }
}

function userMsg (text, cache) {
  return { role: 'user', content: [cache ? { type: 'text', text, cache } : { type: 'text', text }] }
}

function assistantMsg (text) {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

function breakpoints (request) {
  const sys = Array.isArray(request.system)
    ? request.system.filter(b => b.cache_control).length
    : 0
  let msg = 0
  for (const m of request.messages) {
    if (!Array.isArray(m.content)) continue
    msg += m.content.filter(b => b.cache_control).length
  }
  return { sys, msg, total: sys + msg }
}

describe('anthropic conversation cache breakpoints', () => {
  test('marker on a message part places a trailing breakpoint', async () => {
    const { client, captured } = makeAnthropicClient()
    const prompt = [
      systemMsg([{ type: 'text', text: 'foundation', cache: '5m' }]),
      userMsg('turn 1'),
      assistantMsg('answer 1'),
      userMsg('turn 2', '5m')
    ]
    await drain(anthropic(envelope({ prompt }), { client }))

    const msgs = captured.request.messages
    const last = msgs[msgs.length - 1].content
    expect(last[last.length - 1].cache_control).toEqual({ type: 'ephemeral' })
    expect(last[last.length - 1].cache).toBeUndefined()
    expect(breakpoints(captured.request)).toEqual({ sys: 1, msg: 1, total: 2 })
  })

  test('1h marker produces a 1h trailing breakpoint', async () => {
    const { client, captured } = makeAnthropicClient()
    const prompt = [
      systemMsg([{ type: 'text', text: 'foundation', cache: '1h' }]),
      userMsg('turn 1'),
      assistantMsg('answer 1'),
      userMsg('turn 2', '1h')
    ]
    await drain(anthropic(envelope({ prompt }), { client }))

    const msgs = captured.request.messages
    const last = msgs[msgs.length - 1].content
    expect(last[last.length - 1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  test('long conversation gets a stable milestone breakpoint at index ≡ 15 mod 16', async () => {
    const { client, captured } = makeAnthropicClient()
    const conv = []
    for (let i = 0; i < 20; i++) {
      conv.push(userMsg(`u${i}`))
      conv.push(assistantMsg(`a${i}`))
    }
    conv.push(userMsg('now', '5m'))
    const prompt = [systemMsg([{ type: 'text', text: 'foundation', cache: '5m' }]), ...conv]
    await drain(anthropic(envelope({ prompt }), { client }))

    const marked = []
    let idx = 0
    for (const m of captured.request.messages) {
      for (const b of m.content) {
        if (b.cache_control) marked.push(idx)
        idx++
      }
    }
    const trailing = idx - 1
    expect(marked).toContain(trailing)
    const milestone = marked.find(i => i !== trailing)
    expect(milestone % 16).toBe(15)
    expect(trailing - milestone).toBeLessThanOrEqual(16)
    expect(breakpoints(captured.request)).toEqual({ sys: 1, msg: 2, total: 3 })
  })

  test('over-cap system markers are trimmed keeping first and last', async () => {
    const { client, captured } = makeAnthropicClient()
    const conv = []
    for (let i = 0; i < 20; i++) {
      conv.push(userMsg(`u${i}`))
      conv.push(assistantMsg(`a${i}`))
    }
    conv.push(userMsg('now', '5m'))
    const prompt = [
      systemMsg([
        { type: 'text', text: 'foundation', cache: '1h' },
        { type: 'text', text: 'substrate', cache: '5m' },
        { type: 'text', text: 'memory', cache: '5m' },
        { type: 'text', text: 'pipeline', cache: '5m' },
        { type: 'text', text: 'state', cache: '5m' }
      ]),
      ...conv
    ]
    await drain(anthropic(envelope({ prompt }), { client }))

    expect(breakpoints(captured.request)).toEqual({ sys: 2, msg: 2, total: 4 })
    const sys = captured.request.system
    expect(sys[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(sys[4].cache_control).toEqual({ type: 'ephemeral' })
    expect(sys[1].cache_control).toBeUndefined()
    expect(sys[2].cache_control).toBeUndefined()
    expect(sys[3].cache_control).toBeUndefined()
  })

  test('five system markers alone are trimmed to four', async () => {
    const { client, captured } = makeAnthropicClient()
    const prompt = [
      systemMsg([
        { type: 'text', text: 'foundation', cache: '1h' },
        { type: 'text', text: 'substrate', cache: '5m' },
        { type: 'text', text: 'memory', cache: '5m' },
        { type: 'text', text: 'pipeline', cache: '5m' },
        { type: 'text', text: 'state', cache: '5m' }
      ]),
      userMsg('question')
    ]
    await drain(anthropic(envelope({ prompt }), { client }))

    expect(breakpoints(captured.request)).toEqual({ sys: 4, msg: 0, total: 4 })
    expect(captured.request.system[1].cache_control).toBeUndefined()
  })

  test('no markers leaves the request untouched', async () => {
    const { client, captured } = makeAnthropicClient()
    const prompt = [
      { role: 'system', content: 'plain system' },
      { role: 'user', content: 'plain question' }
    ]
    await drain(anthropic(envelope({ prompt }), { client }))

    expect(captured.request.system).toBe('plain system')
    expect(captured.request.messages).toEqual([{ role: 'user', content: 'plain question' }])
    expect(breakpoints(captured.request)).toEqual({ sys: 0, msg: 0, total: 0 })
  })

  test('marker with a string-content final message converts it to a block array', async () => {
    const { client, captured } = makeAnthropicClient()
    const prompt = [
      systemMsg([{ type: 'text', text: 'foundation', cache: '5m' }]),
      userMsg('turn 1', '5m'),
      assistantMsg('answer 1'),
      { role: 'user', content: 'turn 2' }
    ]
    await drain(anthropic(envelope({ prompt }), { client }))

    const msgs = captured.request.messages
    const last = msgs[msgs.length - 1].content
    expect(Array.isArray(last)).toBe(true)
    expect(last[last.length - 1]).toEqual({
      type: 'text',
      text: 'turn 2',
      cache_control: { type: 'ephemeral' }
    })
  })

  test('marker survives tool_result being the final message', async () => {
    const { client, captured } = makeAnthropicClient()
    const prompt = [
      systemMsg([{ type: 'text', text: 'foundation', cache: '5m' }]),
      userMsg('turn 1'),
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'calling' }],
        toolCalls: [{ id: 't1', name: 'lookup', arguments: {} }]
      },
      { role: 'tool', toolCallId: 't1', content: [{ type: 'text', text: 'result', cache: '5m' }] }
    ]
    await drain(anthropic(envelope({ prompt }), { client }))

    const msgs = captured.request.messages
    const last = msgs[msgs.length - 1].content
    expect(last[last.length - 1].type).toBe('tool_result')
    expect(last[last.length - 1].cache_control).toEqual({ type: 'ephemeral' })
  })
})

describe('openai adapter ignores conversation cache markers', () => {
  test('marker does not leak into the request', async () => {
    const captured = {}
    const client = {
      responses: {
        stream (request) {
          captured.request = request
          return {
            async * [Symbol.asyncIterator] () {
              yield { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }
            }
          }
        }
      }
    }
    const prompt = [
      { role: 'system', content: [{ type: 'text', text: 'sys', cache: '5m' }] },
      userMsg('turn 1'),
      assistantMsg('answer 1'),
      userMsg('turn 2', '5m')
    ]
    await drain(openai(envelope({ model: 'openai/gpt-5.2', prompt }), { client }))

    expect(JSON.stringify(captured.request)).not.toContain('cache')
  })
})
