import { describe, test, expect } from 'vitest'

import { anthropic } from '../../js/session/adapters/anthropic.js'
import { openai } from '../../js/session/adapters/openai.js'
import { gemini } from '../../js/session/adapters/gemini.js'
import { groq } from '../../js/session/adapters/groq.js'

/**
 * Shared test: the envelope carries an assistant message with
 * `toolCalls` plus a follow-up `tool` message. Each adapter must
 * translate the assistant turn into the provider-native tool_use /
 * function_call / functionCall shape and the tool turn into the
 * provider's tool-result equivalent.
 */

const TOOL_HISTORY = [
  { role: 'system', content: 'Summarize tool output.' },
  { role: 'user', content: 'hostname?' },
  {
    role: 'assistant',
    content: 'checking',
    toolCalls: [{ id: 'c1', name: 'get_hostname', arguments: { verbose: true } }]
  },
  { role: 'tool', toolCallId: 'c1', toolName: 'get_hostname', content: 'dev-box' }
]

function envelope (provider, model, prompt) {
  return {
    callId: 'c',
    authId: 'a',
    auth: { key: 'k' },
    provider,
    model,
    prompt
  }
}

async function collect (iter) {
  const out = []
  for await (const v of iter) out.push(v)
  return out
}

// ---------- Anthropic ----------

describe('anthropic — assistant.toolCalls round-trip', () => {
  test('emits tool_use blocks inside assistant content', async () => {
    const captured = {}
    const client = {
      messages: {
        stream (req) {
          captured.request = req
          return { async * [Symbol.asyncIterator] () { yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } } } }
        }
      }
    }
    await collect(anthropic(envelope('anthropic', 'claude-sonnet-4-5', TOOL_HISTORY), { client }))

    expect(captured.request.system).toBe('Summarize tool output.')
    const msgs = captured.request.messages
    // user, assistant (with tool_use), user (tool_result batch)
    expect(msgs[0]).toEqual({ role: 'user', content: 'hostname?' })

    // Assistant content: text block + tool_use block
    expect(msgs[1].role).toBe('assistant')
    expect(msgs[1].content).toEqual([
      { type: 'text', text: 'checking' },
      { type: 'tool_use', id: 'c1', name: 'get_hostname', input: { verbose: true } }
    ])

    // Anthropic wraps tool_result in a user-role message
    expect(msgs[2].role).toBe('user')
    expect(msgs[2].content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'c1',
      content: 'dev-box'
    })
  })
})

// ---------- OpenAI (Responses API) ----------

describe('openai — assistant.toolCalls round-trip', () => {
  test('splits assistant into message item + function_call item(s)', async () => {
    const captured = {}
    const client = {
      responses: {
        stream (req) {
          captured.request = req
          return {
            async * [Symbol.asyncIterator] () {
              yield { type: 'response.completed', response: { usage: {} } }
            }
          }
        }
      }
    }
    await collect(openai(envelope('openai', 'gpt-5-mini', TOOL_HISTORY), { client }))

    expect(captured.request.instructions).toBe('Summarize tool output.')
    const input = captured.request.input
    // Expected: user, assistant-message, function_call, function_call_output
    const types = input.map(i => i.type ?? i.role)
    expect(types).toEqual(['user', 'message', 'function_call', 'function_call_output'])

    expect(input[1]).toEqual({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'checking' }]
    })
    expect(input[2]).toEqual({
      type: 'function_call',
      name: 'get_hostname',
      call_id: 'c1',
      arguments: JSON.stringify({ verbose: true })
    })
    expect(input[3]).toEqual({
      type: 'function_call_output',
      call_id: 'c1',
      output: 'dev-box'
    })
  })

  test('assistant with toolCalls but no text skips the message item', async () => {
    const silentAssistant = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 't', arguments: {} }]
      }
    ]
    const captured = {}
    const client = {
      responses: {
        stream (req) {
          captured.request = req
          return {
            async * [Symbol.asyncIterator] () {
              yield { type: 'response.completed', response: { usage: {} } }
            }
          }
        }
      }
    }
    await collect(openai(envelope('openai', 'gpt-5-mini', silentAssistant), { client }))
    // Expect: user + function_call (no message item)
    expect(captured.request.input.map(i => i.type ?? i.role)).toEqual(['user', 'function_call'])
  })
})

// ---------- Gemini ----------

describe('gemini — assistant.toolCalls round-trip', () => {
  test('emits a single model turn with text + functionCall parts', async () => {
    const captured = {}
    const client = {
      models: {
        generateContentStream (req) {
          captured.request = req
          return (async function * () {
            yield { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }
          })()
        }
      }
    }
    await collect(gemini(envelope('gemini', 'gemini-2.5-flash', TOOL_HISTORY), { client }))

    const contents = captured.request.contents
    // user, model (with text + functionCall), user (functionResponse)
    expect(contents[0]).toEqual({ role: 'user', parts: [{ text: 'hostname?' }] })

    expect(contents[1].role).toBe('model')
    expect(contents[1].parts).toEqual([
      { text: 'checking' },
      { functionCall: { name: 'get_hostname', args: { verbose: true } } }
    ])

    expect(contents[2].role).toBe('user')
    expect(contents[2].parts[0]).toEqual({
      functionResponse: {
        name: 'get_hostname',
        response: { result: 'dev-box' }
      }
    })
  })
})

// ---------- Chat completions (via Groq) ----------

describe('chat-completions — assistant.toolCalls round-trip', () => {
  test('assistant emits tool_calls array + tool role uses tool_call_id', async () => {
    const captured = {}
    const client = {
      chat: {
        completions: {
          create: async (args) => {
            captured.args = args
            return {
              choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1 }
            }
          }
        }
      }
    }
    await collect(groq(envelope('groq', 'llama-3', TOOL_HISTORY), { client }))

    const msgs = captured.args.messages
    // system + user + assistant (tool_calls) + tool
    expect(msgs[0]).toEqual({ role: 'system', content: 'Summarize tool output.' })
    expect(msgs[1]).toEqual({ role: 'user', content: 'hostname?' })

    expect(msgs[2]).toEqual({
      role: 'assistant',
      content: 'checking',
      tool_calls: [{
        id: 'c1',
        type: 'function',
        function: {
          name: 'get_hostname',
          arguments: JSON.stringify({ verbose: true })
        }
      }]
    })

    expect(msgs[3]).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: 'dev-box'
    })
  })
})
