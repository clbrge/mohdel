/**
 * OpenAI Responses API adapter.
 *
 * Scope:
 *   - Text in, text out, streaming
 *   - Status contract (incomplete + warning on max_output_tokens)
 *   - Tools: unified format → OpenAI function tool; streaming
 *     function_call argument deltas; tool_use terminal state;
 *     function_call_output input items on the way back in
 *   - AbortSignal forwarded to SDK
 *
 * Deferred: vision, reasoning (outputEffort → reasoning.effort),
 *           outputStyle (GPT-5 verbosity).
 *
 * @module session/adapters/openai
 */

import OpenAI from 'openai'

import {
  STATUS_COMPLETED,
  STATUS_INCOMPLETE,
  STATUS_TOOL_USE,
  WARNING_INSUFFICIENT_OUTPUT_BUDGET
} from '#core/status.js'

import { cancelledDone } from './_cancelled.js'
import { getSpec } from './_catalog.js'
import { classifyProviderError } from './_errors.js'
import { loadImages } from './_images.js'
import { costFor } from './_pricing.js'
import { catalogKey, providerOf, bareOf } from '#core/model-id.js'
import {
  toOpenAITools,
  fromOpenAIToolCalls,
  toToolChoice
} from './_tools.js'
import { streamingDispatcher } from './_dispatcher.js'

/**
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {{client?: OpenAI, signal?: AbortSignal, log?: any, span?: any}} [deps]
 * @returns {AsyncGenerator<import('#core/events.js').Event>}
 */
export async function * openai (envelope, deps = {}) {
  const client = deps.client ?? new OpenAI({
    apiKey: envelope.auth.key,
    ...(envelope.auth.baseURL ? { baseURL: envelope.auth.baseURL } : {}),
    fetchOptions: { dispatcher: streamingDispatcher() }
  })
  const signal = deps.signal
  const log = deps.log
  const start = String(process.hrtime.bigint())
  let first = null

  const { instructions, input } = splitPrompt(envelope.prompt)

  if (envelope.images?.length) {
    try {
      const loaded = await loadImages(envelope.images)
      const parts = loaded.map(toOpenAIImagePart).filter(Boolean)
      if (parts.length) injectImageParts(input, parts)
    } catch (e) {
      log?.warn({ err: e }, '[mohdel:openai] image load failed')
      yield { type: 'error', error: classifyProviderError(e, envelope.auth?.key, { provider: 'openai' }) }
      return
    }
  }

  const request = buildRequest(envelope, input, instructions)

  // F53: accumulate via array + join to avoid per-delta V8 cons-string
  // churn. Materialized at each exit point.
  const outputParts = []
  const currentOutput = () => outputParts.join('')
  let inputTokens = 0
  let outputTokens = 0
  let thinkingTokens = 0
  let cachedInputTokens = 0
  let cacheWriteTokens = 0
  let status = STATUS_COMPLETED
  /** @type {string | undefined} */
  let warning

  // Tool-call accumulation: itemId → {call_id, name, arguments}
  /** @type {Map<string, {call_id: string, name: string, arguments: string}>} */
  const toolItems = new Map()

  try {
    const stream = await client.responses.stream(request, { signal })

    for await (const event of stream) {
      if (signal?.aborted) {
        yield cancelledDone(start, first, envelope, currentOutput(), inputTokens, outputTokens)
        return
      }
      switch (event.type) {
        case 'response.output_text.delta':
          if (event.delta) {
            if (first === null) first = String(process.hrtime.bigint())
            outputParts.push(event.delta)
            yield { type: 'delta', delta: { type: 'message', delta: event.delta } }
          }
          break

        case 'response.output_item.added':
          if (event.item?.type === 'function_call') {
            toolItems.set(event.item.id, {
              call_id: event.item.call_id ?? event.item.id,
              name: event.item.name ?? '',
              arguments: ''
            })
          }
          break

        case 'response.function_call_arguments.delta':
          if (event.item_id && event.delta) {
            const t = toolItems.get(event.item_id)
            if (t) {
              t.arguments += event.delta
              if (first === null) first = String(process.hrtime.bigint())
              yield {
                type: 'delta',
                delta: { type: 'function_call', delta: event.delta }
              }
            }
          }
          break

        case 'response.completed':
          if (event.response?.usage) {
            inputTokens = event.response.usage.input_tokens ?? 0
            outputTokens = event.response.usage.output_tokens ?? 0
            thinkingTokens = event.response.usage.output_tokens_details?.reasoning_tokens ?? 0
            cachedInputTokens = event.response.usage.input_tokens_details?.cached_tokens ?? 0
            cacheWriteTokens = event.response.usage.input_tokens_details?.cache_write_tokens ?? 0
          }
          if (toolItems.size > 0) {
            status = STATUS_TOOL_USE
          }
          break

        case 'response.incomplete':
          status = STATUS_INCOMPLETE
          if (event.response?.incomplete_details?.reason === 'max_output_tokens') {
            warning = WARNING_INSUFFICIENT_OUTPUT_BUDGET
          }
          if (event.response?.usage) {
            inputTokens = event.response.usage.input_tokens ?? 0
            outputTokens = event.response.usage.output_tokens ?? 0
            thinkingTokens = event.response.usage.output_tokens_details?.reasoning_tokens ?? 0
            cachedInputTokens = event.response.usage.input_tokens_details?.cached_tokens ?? 0
            cacheWriteTokens = event.response.usage.input_tokens_details?.cache_write_tokens ?? 0
          }
          break

        default:
          break
      }
    }
  } catch (e) {
    if (signal?.aborted) {
      yield cancelledDone(start, first, envelope, currentOutput(), inputTokens, outputTokens)
      return
    }
    log?.warn({ err: e }, '[mohdel:openai] stream failed')
    yield { type: 'error', error: classifyProviderError(e, envelope.auth?.key, { provider: 'openai' }) }
    return
  }

  if (signal?.aborted) {
    yield cancelledDone(start, first, envelope, currentOutput(), inputTokens, outputTokens)
    return
  }

  const end = String(process.hrtime.bigint())
  // OpenAI Responses reports `output_tokens` INCLUDING reasoning
  // tokens. The `AnswerResult` contract separates them into
  // `outputTokens` (message-only) and `thinkingTokens`, so subtract
  // one from the other for the message-only count.
  const messageOutputTokens = Math.max(0, outputTokens - thinkingTokens)

  // OpenAI counts cached_tokens and cache_write_tokens as SUBSETS of
  // input_tokens. Convert to mohdel's additive convention (cacheRead/
  // cacheWriteInputTokens are separate from inputTokens) by subtracting
  // both portions before pricing. Both adapters and computeCost stay
  // simpler with the additive shape.
  const regularInputTokens = Math.max(0, inputTokens - cachedInputTokens - cacheWriteTokens)

  /** @type {import('#core/events.js').DoneEvent} */
  const done = {
    type: 'done',
    result: {
      status,
      output: currentOutput() || null,
      inputTokens: regularInputTokens,
      outputTokens: messageOutputTokens,
      thinkingTokens,
      ...(cacheWriteTokens > 0 && { cacheWriteInputTokens: cacheWriteTokens }),
      ...(cachedInputTokens > 0 && { cacheReadInputTokens: cachedInputTokens }),
      cost: costFor(
        catalogKey(envelope.model),
        {
          inputTokens: regularInputTokens,
          outputTokens: messageOutputTokens,
          thinkingTokens,
          cacheWriteInputTokens: cacheWriteTokens,
          cacheReadInputTokens: cachedInputTokens
        }
      ),
      timestamps: { start, first: first ?? end, end }
    }
  }
  if (warning) done.result.warning = warning
  if (toolItems.size > 0) {
    done.result.toolCalls = fromOpenAIToolCalls(Array.from(toolItems.values()))
  }
  yield done
}

/**
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {Array<any>} input
 * @param {string} instructions
 */
function buildRequest (envelope, input, instructions) {
  const spec = getSpec(catalogKey(envelope.model))
  const provider = providerOf(envelope.model)

  /** @type {Record<string, any>} */
  const request = {
    model: spec?.model ?? bareOf(envelope.model),
    input
  }
  if (instructions) request.instructions = instructions
  if (envelope.outputBudget !== undefined) request.max_output_tokens = envelope.outputBudget
  if (envelope.tools?.length) {
    request.tools = toOpenAITools(envelope.tools)
  }
  if (envelope.toolChoice) {
    request.tool_choice = toToolChoice('openai', envelope.toolChoice)
  }
  if (envelope.parallelToolCalls === false) {
    request.parallel_tool_calls = false
  }

  // Thinking: when the spec has `thinkingEffortLevels`, set
  // `reasoning.effort` and add the thinking-budget headroom on top
  // of the user's `outputBudget`. Both OpenAI (gpt-5.x) and xAI
  // (grok-4.3+) accept the same `reasoning: { effort }` shape on
  // the Responses API, including the literal value 'none' to
  // disable reasoning entirely.
  if (spec?.thinkingEffortLevels) {
    const effort = envelope.outputEffort ?? spec.defaultThinkingEffort ?? 'low'
    if (effort && spec.thinkingEffortLevels[effort] != null) {
      const headroom = spec.thinkingEffortLevels[effort]
      if (request.max_output_tokens && typeof headroom === 'number') {
        request.max_output_tokens += headroom
      }
      request.reasoning = { effort }
    }
  }

  // outputType: 'json' → text.format
  if (envelope.outputType === 'json') {
    request.text = { ...(request.text || {}), format: { type: 'json_object' } }
  }

  // outputStyle: 'chat' → GPT-5 verbosity hint (only on gpt-5 family)
  if (envelope.outputStyle && /gpt-5/.test(envelope.model)) {
    request.text = {
      ...(request.text || {}),
      verbosity: envelope.outputStyle === 'chat' ? 'high' : 'low'
    }
  }

  // Per-user identifier — openai uses `safety_identifier`; other
  // Responses-API providers (xai) use the legacy `user` field.
  if (envelope.identifier) {
    if (provider === 'openai') {
      request.safety_identifier = envelope.identifier
      request.prompt_cache_key = envelope.identifier
    } else {
      request.user = envelope.identifier
    }
  }

  return request
}

/** @param {string | import('#core/envelope.js').Message[]} prompt */
function splitPrompt (prompt) {
  if (typeof prompt === 'string') {
    return { instructions: '', input: [{ role: 'user', content: prompt }] }
  }
  /** @type {string[]} */
  const systemParts = []
  /** @type {Array<any>} */
  const input = []
  for (const m of prompt) {
    if (m.role === 'system') {
      systemParts.push(flattenText(m.content))
    } else if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.toolCallId ?? '',
        output: flattenText(m.content)
      })
    } else if (m.role === 'assistant' && m.toolCalls?.length) {
      // Responses API wants a message item (if any text) followed
      // by one function_call item per tool invocation.
      const text = flattenText(m.content)
      if (text) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }]
        })
      }
      for (const tc of m.toolCalls) {
        input.push({
          type: 'function_call',
          name: tc.name,
          call_id: tc.id,
          arguments: stringifyToolArgs(tc.arguments)
        })
      }
    } else {
      input.push({
        role: m.role,
        content: toInputContent(m.role, m.content)
      })
    }
  }
  return { instructions: systemParts.filter(Boolean).join('\n\n'), input }
}

/** @param {string | import('#core/envelope.js').MessagePart[]} content */
function flattenText (content) {
  if (typeof content === 'string') return content
  return content.filter(p => p.type === 'text' && p.text).map(p => p.text).join('\n')
}

/**
 * OpenAI's `function_call` item demands a JSON string for arguments.
 * The unified `ToolCall.arguments` is an object, so stringify here
 * and fall back to `"{}"` on any JSON oddness rather than crashing
 * mid-call.
 * @param {unknown} args
 */
function stringifyToolArgs (args) {
  if (typeof args === 'string' && args) return args
  try {
    return JSON.stringify(args ?? {})
  } catch {
    return '{}'
  }
}

/**
 * @param {string} role
 * @param {string | import('#core/envelope.js').MessagePart[]} content
 */
function toInputContent (role, content) {
  if (typeof content === 'string') return content
  const partType = role === 'assistant' ? 'output_text' : 'input_text'
  return content.map(p => {
    if (p.type === 'text') return { type: partType, text: p.text ?? '' }
    throw new Error(`unsupported content part type: ${p.type}`)
  })
}

/** @param {import('./_images.js').LoadedImage} img */
function toOpenAIImagePart (img) {
  if (img.url) {
    return { type: 'input_image', image_url: img.url }
  }
  if (img.base64) {
    // Responses API takes a data URI for inline images.
    return {
      type: 'input_image',
      image_url: `data:${img.mimeType};base64,${img.base64}`
    }
  }
  return null
}

/**
 * Inject image parts into the LAST user input item.
 *
 * @param {Array<any>} input
 * @param {Array<any>} parts
 */
function injectImageParts (input, parts) {
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i]
    if (item.role !== 'user') continue
    if (typeof item.content === 'string') {
      item.content = [{ type: 'input_text', text: item.content }, ...parts]
    } else if (Array.isArray(item.content)) {
      item.content = [...item.content, ...parts]
    }
    return
  }
  input.push({ role: 'user', content: parts })
}
