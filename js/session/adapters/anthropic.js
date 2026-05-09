/**
 * Anthropic Messages API adapter.
 *
 * Scope:
 *   - Text in, text out, streaming
 *   - Status contract (incomplete + warning on max_tokens)
 *   - Tools: unified format → anthropic input_schema; streaming
 *     function_call deltas; tool_use terminal state; tool_result
 *     messages on the way back in
 *   - AbortSignal forwarded to SDK
 *
 * Deferred: vision, thinking/reasoning control (outputEffort).
 *
 * @module session/adapters/anthropic
 */

import Anthropic from '@anthropic-ai/sdk'

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
import { catalogKey, bareOf } from '#core/model-id.js'
import {
  toAnthropicTools,
  fromAnthropicToolCalls,
  toToolChoice
} from './_tools.js'
import { streamingDispatcher } from './_dispatcher.js'

/**
 * Approximate chars-per-token used to estimate Anthropic thinking
 * tokens (the API doesn't report them separately in `usage`).
 *
 * ## Known limitations (cost accuracy)
 *
 * The estimate structurally under-counts in three ways:
 *   1. **Signatures.** Thinking blocks have shape
 *      `{type: 'thinking', thinking: '<text>', signature: '<hash>'}`.
 *      Signatures consume output tokens but aren't streamed as
 *      `thinking_delta` — we never see them.
 *   2. **Redacted thinking.** When Anthropic returns
 *      `{type: 'redacted_thinking', data: '<encrypted>'}` in place
 *      of a plain thinking block, zero `thinking_delta` events are
 *      emitted even though the block still consumes output tokens.
 *   3. **BPE variance.** 4 chars/token is an English-text average;
 *      dense reasoning prose can compress differently.
 *
 * **Cost impact:** provably zero when `thinkingPrice == outputPrice`
 * (true for every Anthropic entry in the curated catalog today) —
 * the heuristic error cancels in `cost = i*ip + o*op + t*tp` because
 * `o*op + t*op = (o+t)*op = totalOutput*op`. If a catalog maintainer
 * ever sets asymmetric Anthropic pricing, cost drifts by
 * `estimate_error × (thinkingPrice − outputPrice)` — that's a
 * catalog-editor awareness item until Anthropic exposes a real
 * `thinking_tokens` field in `usage`. (They'll almost certainly do
 * that the day they introduce asymmetric pricing.)
 */
const ANTHROPIC_THINKING_CHARS_PER_TOKEN = 4

/**
 * Fallback `max_tokens` when the caller supplied no `outputBudget`
 * and the model spec has no `outputTokenLimit`. Anthropic's
 * `max_tokens` is required on every request; 4096 matches the
 * smallest Claude output ceiling and keeps calls cheap on unknown
 * models. Tune via `spec.outputTokenLimit` or `envelope.outputBudget`.
 */
const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096

/**
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {{client?: Anthropic, signal?: AbortSignal, log?: any, span?: any}} [deps]
 * @returns {AsyncGenerator<import('#core/events.js').Event>}
 */
export async function * anthropic (envelope, deps = {}) {
  const client = deps.client ?? new Anthropic({
    apiKey: envelope.auth.key,
    fetchOptions: { dispatcher: streamingDispatcher() }
  })
  const signal = deps.signal
  const log = deps.log
  const start = String(process.hrtime.bigint())
  let first = null

  const { system, conversation } = splitPrompt(envelope.prompt)

  // Attach images to the last user message before building the request.
  if (envelope.images?.length) {
    try {
      const loaded = await loadImages(envelope.images)
      const blocks = loaded.map(toAnthropicImageBlock).filter(Boolean)
      if (blocks.length) injectImageBlocks(conversation, blocks)
    } catch (e) {
      log?.warn({ err: e }, '[mohdel:anthropic] image load failed')
      yield { type: 'error', error: classifyProviderError(e, envelope.auth?.key) }
      return
    }
  }

  const request = buildRequest(envelope, conversation, system)

  // F53: accumulate via array + join to avoid per-delta V8 cons-string
  // churn. Materialized at each exit point.
  const outputParts = []
  const currentOutput = () => outputParts.join('')
  let inputTokens = 0
  let outputTokens = 0
  let cacheWriteTokens = 0
  let cacheReadTokens = 0
  let thinkingChars = 0
  let status = STATUS_COMPLETED
  /** @type {string | undefined} */
  let warning

  // Tool-use accumulation state
  /** @type {Map<number, {id: string, name: string, inputJson: string}>} */
  const toolBlocks = new Map()

  try {
    const stream = await client.messages.stream(request, { signal })

    for await (const event of stream) {
      if (signal?.aborted) {
        yield cancelledDone(start, first, envelope, currentOutput(), inputTokens, outputTokens, { cacheWriteInputTokens: cacheWriteTokens, cacheReadInputTokens: cacheReadTokens })
        return
      }
      switch (event.type) {
        case 'message_start':
          if (event.message?.usage?.input_tokens) {
            inputTokens = event.message.usage.input_tokens
          }
          if (event.message?.usage?.cache_creation_input_tokens) {
            cacheWriteTokens = event.message.usage.cache_creation_input_tokens
          }
          if (event.message?.usage?.cache_read_input_tokens) {
            cacheReadTokens = event.message.usage.cache_read_input_tokens
          }
          break

        case 'content_block_start':
          if (event.content_block?.type === 'tool_use') {
            toolBlocks.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              inputJson: ''
            })
          }
          break

        case 'content_block_delta':
          if (event.delta?.type === 'text_delta' && event.delta.text) {
            if (first === null) first = String(process.hrtime.bigint())
            outputParts.push(event.delta.text)
            yield { type: 'delta', delta: { type: 'message', delta: event.delta.text } }
          } else if (event.delta?.type === 'thinking_delta') {
            // Thinking content is not surfaced via `delta` events —
            // only `message` and `function_call` deltas stream to
            // consumers. Accumulate char count to estimate
            // thinking_tokens at the end.
            thinkingChars += (event.delta.thinking || '').length
          } else if (event.delta?.type === 'input_json_delta') {
            const block = toolBlocks.get(event.index)
            if (block) {
              block.inputJson += event.delta.partial_json ?? ''
              if (first === null) first = String(process.hrtime.bigint())
              yield {
                type: 'delta',
                delta: { type: 'function_call', delta: event.delta.partial_json ?? '' }
              }
            }
          }
          break

        case 'message_delta':
          if (event.delta?.stop_reason === 'max_tokens') {
            status = STATUS_INCOMPLETE
            warning = WARNING_INSUFFICIENT_OUTPUT_BUDGET
          } else if (event.delta?.stop_reason === 'tool_use') {
            status = STATUS_TOOL_USE
          }
          if (event.usage?.output_tokens) {
            outputTokens = event.usage.output_tokens
          }
          break

        default:
          break
      }
    }
  } catch (e) {
    if (signal?.aborted) {
      yield cancelledDone(start, first, envelope, currentOutput(), inputTokens, outputTokens, { cacheWriteInputTokens: cacheWriteTokens, cacheReadInputTokens: cacheReadTokens })
      return
    }
    log?.warn({ err: e }, '[mohdel:anthropic] stream failed')
    yield { type: 'error', error: classifyProviderError(e, envelope.auth?.key) }
    return
  }

  if (signal?.aborted) {
    yield cancelledDone(start, first, envelope, currentOutput(), inputTokens, outputTokens, { cacheWriteInputTokens: cacheWriteTokens, cacheReadInputTokens: cacheReadTokens })
    return
  }

  const end = String(process.hrtime.bigint())
  // Estimate thinking tokens. Primary path: count streamed thinking_delta
  // chars (sonnet emits these). Fallback: gap between Anthropic's reported
  // output_tokens and what actually streamed as visible output (text +
  // tool input JSON) — catches redacted_thinking blocks (opus 4.7 default)
  // that consume output tokens but emit no streaming deltas.
  const streamedOutput = currentOutput()
  const streamedOutputChars = streamedOutput.length +
    [...toolBlocks.values()].reduce((s, b) => s + b.inputJson.length, 0)
  const streamedOutputTokens = Math.ceil(streamedOutputChars / ANTHROPIC_THINKING_CHARS_PER_TOKEN)
  const estimatedThinkingTokens = thinkingChars > 0
    ? Math.min(Math.ceil(thinkingChars / ANTHROPIC_THINKING_CHARS_PER_TOKEN), outputTokens)
    : Math.max(0, outputTokens - streamedOutputTokens)
  const messageOutputTokens = Math.max(0, outputTokens - estimatedThinkingTokens)

  /** @type {import('#core/events.js').DoneEvent} */
  const done = {
    type: 'done',
    result: {
      status,
      output: streamedOutput || null,
      inputTokens,
      outputTokens: messageOutputTokens,
      thinkingTokens: estimatedThinkingTokens,
      ...(cacheWriteTokens > 0 && { cacheWriteInputTokens: cacheWriteTokens }),
      ...(cacheReadTokens > 0 && { cacheReadInputTokens: cacheReadTokens }),
      cost: costFor(
        catalogKey(envelope.model),
        {
          inputTokens,
          outputTokens: messageOutputTokens,
          thinkingTokens: estimatedThinkingTokens,
          cacheWriteInputTokens: cacheWriteTokens,
          cacheReadInputTokens: cacheReadTokens
        }
      ),
      timestamps: { start, first: first ?? end, end }
    }
  }
  if (warning) done.result.warning = warning
  if (toolBlocks.size > 0) {
    done.result.toolCalls = finalizeToolCalls(toolBlocks)
  }
  yield done
}

/**
 * @param {Map<number, {id: string, name: string, inputJson: string}>} toolBlocks
 */
function finalizeToolCalls (toolBlocks) {
  const blocks = Array.from(toolBlocks.values()).map(b => ({
    id: b.id,
    name: b.name,
    input: safeParseJson(b.inputJson)
  }))
  return fromAnthropicToolCalls(blocks)
}

/** @param {string} s */
function safeParseJson (s) {
  if (!s) return {}
  try { return JSON.parse(s) } catch { return s }
}

/**
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {Array<{role: string, content: any}>} conversation
 * @param {string | Array<{type: string, text: string, cache_control?: object}>} system
 *   Either a flat string (legacy) or an array of typed blocks with optional
 *   `cache_control` for prompt caching. The Anthropic SDK accepts both shapes.
 */
function buildRequest (envelope, conversation, system) {
  const spec = getSpec(catalogKey(envelope.model))
  const outputTokenLimit = spec?.outputTokenLimit

  /** @type {Record<string, any>} */
  const request = {
    model: spec?.model ?? bareOf(envelope.model),
    max_tokens: envelope.outputBudget ?? outputTokenLimit ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
    messages: conversation
  }
  if (typeof system === 'string' ? system : Array.isArray(system) && system.length) {
    request.system = system
  }
  if (envelope.tools?.length) {
    request.tools = toAnthropicTools(envelope.tools)
  }
  if (envelope.toolChoice) {
    const choice = toToolChoice('anthropic', envelope.toolChoice)
    if (envelope.parallelToolCalls === false && choice) {
      choice.disable_parallel_tool_use = true
    }
    request.tool_choice = choice
  }

  // Thinking — adaptive mode, with an optional effort hint when the
  // spec defines `thinkingEffortLevels`. `outputEffort: 'none'`
  // opts out of thinking entirely (`thinking.type: 'disabled'` —
  // adaptive thinking must not be enabled when the caller has
  // explicitly disabled it, otherwise the call silently clobbers
  // `outputBudget` with the full model limit).
  if (spec?.thinkingEffortLevels) {
    const effort = envelope.outputEffort ?? spec.defaultThinkingEffort
    if (effort && effort !== 'none') {
      request.thinking = { type: 'adaptive' }
      if (spec.thinkingEffortLevels[effort] != null) {
        request.output_config = { effort }
      }
      // Thinking tokens share the output budget — give them the full
      // model limit instead of just the requested outputBudget.
      if (outputTokenLimit) request.max_tokens = outputTokenLimit
    }
  }

  return request
}

/** @param {string | import('#core/envelope.js').Message[]} prompt */
function splitPrompt (prompt) {
  if (typeof prompt === 'string') {
    return { system: '', conversation: [{ role: 'user', content: prompt }] }
  }
  /** @type {string[]} */
  const systemParts = []
  /** @type {Array<{type: string, text: string, cache_control?: object}>} */
  const systemBlocks = []
  let hasCacheMarkers = false
  /** @type {Array<{role: string, content: any}>} */
  const conversation = []
  for (const m of prompt) {
    if (m.role === 'system') {
      // Translate spore-style cache markers ({text, cache: '5m'|'1h'}) into
      // Anthropic's cache_control. Preserves the block boundary that spore
      // chose; collapsing into a single string would silently disable
      // caching even when the upstream tier composed the prompt with
      // explicit breakpoints.
      if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (!p?.text) continue
          const block = { type: 'text', text: p.text }
          if (p.cache === '5m') {
            block.cache_control = { type: 'ephemeral' }
            hasCacheMarkers = true
          } else if (p.cache === '1h') {
            block.cache_control = { type: 'ephemeral', ttl: '1h' }
            hasCacheMarkers = true
          }
          systemBlocks.push(block)
          systemParts.push(p.text)
        }
      } else {
        const text = flattenText(m.content)
        if (text) {
          systemBlocks.push({ type: 'text', text })
          systemParts.push(text)
        }
      }
    } else if (m.role === 'tool') {
      // Tool results go in a user-role message with tool_result blocks.
      conversation.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: m.toolCallId ?? '',
          content: flattenText(m.content)
        }]
      })
    } else if (m.role === 'assistant' && m.toolCalls?.length) {
      // Assistant + tool_use: optional text block followed by one
      // tool_use block per call.
      const content = []
      const text = flattenText(m.content)
      if (text) content.push({ type: 'text', text })
      for (const tc of m.toolCalls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.arguments ?? {}
        })
      }
      conversation.push({ role: 'assistant', content })
    } else {
      conversation.push({
        role: m.role,
        content: toAnthropicContent(m.content)
      })
    }
  }
  // If cache markers are present, return the structured block array so
  // buildRequest can pass it through to Anthropic's typed system field.
  // Otherwise fall back to the legacy string concatenation path so
  // non-cached calls don't change request shape.
  const system = hasCacheMarkers
    ? systemBlocks
    : systemParts.filter(Boolean).join('\n\n')
  return { system, conversation }
}

/** @param {string | import('#core/envelope.js').MessagePart[]} content */
function flattenText (content) {
  if (typeof content === 'string') return content
  return content.filter(p => p.type === 'text' && p.text).map(p => p.text).join('\n')
}

/** @param {string | import('#core/envelope.js').MessagePart[]} content */
function toAnthropicContent (content) {
  if (typeof content === 'string') return content
  return content.map(p => {
    if (p.type === 'text') return { type: 'text', text: p.text ?? '' }
    throw new Error(`unsupported content part type: ${p.type}`)
  })
}

/** @param {import('./_images.js').LoadedImage} img */
function toAnthropicImageBlock (img) {
  if (img.base64) {
    return {
      type: 'image',
      source: { type: 'base64', media_type: img.mimeType, data: img.base64 }
    }
  }
  if (img.url) {
    return {
      type: 'image',
      source: { type: 'url', url: img.url }
    }
  }
  return null
}

/**
 * Inject image content blocks into the LAST user message in the
 * conversation (or append a new user message if none exists).
 *
 * @param {Array<{role: string, content: any}>} conversation
 * @param {Array<any>} blocks
 */
function injectImageBlocks (conversation, blocks) {
  for (let i = conversation.length - 1; i >= 0; i--) {
    if (conversation[i].role !== 'user') continue
    const msg = conversation[i]
    if (typeof msg.content === 'string') {
      msg.content = [{ type: 'text', text: msg.content }, ...blocks]
    } else if (Array.isArray(msg.content)) {
      msg.content = [...msg.content, ...blocks]
    }
    return
  }
  conversation.push({ role: 'user', content: blocks })
}
