import { describe, test, expect, beforeEach } from 'vitest'
import { anthropic } from '../../js/session/adapters/anthropic.js'
import { openai } from '../../js/session/adapters/openai.js'
import { groq } from '../../js/session/adapters/groq.js'
import { gemini } from '../../js/session/adapters/gemini.js'
import { setCatalog } from '../../js/session/adapters/_catalog.js'

const TOOLS = [{ name: 'lookup', description: 'Look up a word', parameters: { type: 'object', properties: { word: { type: 'string' } } } }]

function iterable (events) {
  return { async * [Symbol.asyncIterator] () { for (const e of events) yield e } }
}

const FAMILIES = [
  {
    name: 'Anthropic Messages',
    model: 'anthropic/claude-sonnet-4-5',
    shared: false,
    reasons: { normal: 'end_turn', budget: 'max_tokens', blocked: 'refusal', unknown: 'a_future_reason' },
    run: (envelope, events, signal) => anthropic(envelope, { client: { messages: { stream: () => iterable(events) } }, signal }),
    text: t => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }),
    tool: () => [
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"word":' } }
    ],
    end: reason => [{ type: 'message_delta', delta: { stop_reason: reason, stop_details: null }, usage: { output_tokens: 3 } }]
  },
  {
    name: 'OpenAI Responses',
    model: 'openai/gpt-5',
    shared: false,
    reasons: { normal: null, budget: 'max_output_tokens', blocked: 'content_filter', unknown: 'a_future_reason' },
    run: (envelope, events, signal) => openai(envelope, { client: { responses: { create: () => iterable(events) } }, signal }),
    text: t => ({ type: 'response.output_text.delta', delta: t }),
    tool: () => [
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"word":' }
    ],
    end: reason => reason === null
      ? [{ type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 3 } } }]
      : [{ type: 'response.incomplete', response: { incomplete_details: { reason }, usage: { input_tokens: 5, output_tokens: 3 } } }]
  },
  {
    name: 'Chat Completions',
    model: 'groq/llama-3',
    shared: true,
    reasons: { normal: 'stop', budget: 'length', blocked: 'content_filter', unknown: 'a_future_reason' },
    run: (envelope, events, signal) => groq(envelope, { client: { chat: { completions: { create: async () => iterable(events) } } }, signal }),
    text: t => ({ choices: [{ delta: { content: t } }] }),
    tool: () => [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{"word":' } }] } }] }],
    end: reason => [
      { choices: [{ delta: {}, finish_reason: reason }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } }
    ]
  },
  {
    name: 'Gemini',
    model: 'gemini/gemini-2.5-flash',
    shared: false,
    reasons: { normal: 'STOP', budget: 'MAX_TOKENS', blocked: 'SAFETY', malformed: 'MALFORMED_FUNCTION_CALL', unknown: 'A_FUTURE_REASON' },
    run: (envelope, events, signal) => gemini(envelope, { client: { models: { generateContentStream: async () => iterable(events) } }, signal }),
    text: t => ({ candidates: [{ content: { parts: [{ text: t }] } }] }),
    tool: () => [{ candidates: [{ content: { parts: [{ functionCall: { name: 'lookup', args: { word: 'x' } } }] } }] }],
    end: reason => [{ candidates: [{ content: { parts: [] }, finishReason: reason }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } }]
  }
]

function envelope (family) {
  return { callId: 'c1', authId: 'a1', auth: { key: 'k' }, model: family.model, prompt: 'hi', tools: TOOLS }
}

async function collect (iter) {
  const out = []
  for await (const v of iter) out.push(v)
  return out
}

async function resultOf (family, events, signal) {
  const out = await collect(family.run(envelope(family), events, signal))
  expect(out.filter(e => e.type === 'done' || e.type === 'error')).toHaveLength(1)
  return out.at(-1)
}

beforeEach(() => setCatalog({}))

describe.each(FAMILIES)('every adapter cuts a reply the same way: $name', (family) => {
  test('a normal end is completed, with no warning', async () => {
    const done = await resultOf(family, [family.text('Hi'), ...family.end(family.reasons.normal)])
    expect(done.result.status).toBe('completed')
    expect(done.result.warning).toBeUndefined()
    expect(done.result.warningDetail).toBeUndefined()
  })

  test('the output limit is insufficientOutputBudget, the provider\'s reason as detail', async () => {
    const done = await resultOf(family, [family.text('Cu'), ...family.end(family.reasons.budget)])
    expect(done.result.status).toBe('incomplete')
    expect(done.result.warning).toBe('insufficientOutputBudget')
    expect(done.result.warningDetail).toBe(family.reasons.budget)
    expect(done.result.output).toBe('Cu')
  })

  test('a block is contentBlocked, the provider\'s reason as detail', async () => {
    const done = await resultOf(family, family.end(family.reasons.blocked))
    expect(done.result.status).toBe('incomplete')
    expect(done.result.warning).toBe('contentBlocked')
    expect(done.result.warningDetail).toBe(family.reasons.blocked)
  })

  test.runIf(family.reasons.malformed)('a malformed reply is malformedResponse, the provider\'s reason as detail', async () => {
    const done = await resultOf(family, family.end(family.reasons.malformed))
    expect(done.result.status).toBe('incomplete')
    expect(done.result.warning).toBe('malformedResponse')
    expect(done.result.warningDetail).toBe(family.reasons.malformed)
  })

  test.runIf(!family.shared)('on an API one provider serves, a reason mohdel does not know is unmappedReason with the reason as detail', async () => {
    const done = await resultOf(family, [family.text('Hi'), ...family.end(family.reasons.unknown)])
    expect(done.result.status).toBe('incomplete')
    expect(done.result.warning).toBe('unmappedReason')
    expect(done.result.warningDetail).toBe(family.reasons.unknown)
  })

  test.runIf(family.shared)('on an API many providers serve, a reason not listed as a cut is a normal end', async () => {
    const done = await resultOf(family, [family.text('Hi'), ...family.end(family.reasons.unknown)])
    expect(done.result.status).toBe('completed')
    expect(done.result.warning).toBeUndefined()
  })

  test('a stream that ends without the provider\'s finish is an error, never a result', async () => {
    const last = await resultOf(family, [family.text('Hi')])
    expect(last.type).toBe('error')
  })

  test('tool calls cut by the output limit are incomplete, never tool_use', async () => {
    const done = await resultOf(family, [...family.tool(), ...family.end(family.reasons.budget)])
    expect(done.result.status).toBe('incomplete')
    expect(done.result.warning).toBe('insufficientOutputBudget')
  })

  test('an abort is aborted, with no detail', async () => {
    const controller = new AbortController()
    controller.abort()
    const done = await resultOf(family, [family.text('Hi'), ...family.end(family.reasons.normal)], controller.signal)
    expect(done.result.status).toBe('incomplete')
    expect(done.result.warning).toBe('aborted')
    expect(done.result.warningDetail).toBeUndefined()
  })
})
