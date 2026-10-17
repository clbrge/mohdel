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
import { capOutput } from './_output_cap.js'

import {
  STATUS_COMPLETED,
  STATUS_INCOMPLETE,
  STATUS_TOOL_USE,
  WARNING_INSUFFICIENT_OUTPUT_BUDGET
} from '#core/status.js'

import { abortedDone } from './_aborted.js'
import { getSpec } from './_catalog.js'
import { classifyProviderError } from './_errors.js'
import { hasImagePart, loadImageParts, loadImages } from './_images.js'
import { isTrustedMedia } from './_media.js'
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
 * tokens when `usage` reports no `output_tokens_details.thinking_tokens`.
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
 * the heuristic error drops out of `cost = i*ip + o*op + t*tp` because
 * `o*op + t*op = (o+t)*op = totalOutput*op`. If a catalog maintainer
 * ever sets asymmetric Anthropic pricing, cost drifts by
 * `estimate_error × (thinkingPrice − outputPrice)` — that's a
 * catalog-editor awareness item until Anthropic exposes a real
 * `thinking_tokens` field in `usage`. (They'll almost certainly do
 * that the day they introduce asymmetric pricing.)
 */
const ANTHROPIC_THINKING_CHARS_PER_TOKEN = 4

const REPLAYED_BLOCKS = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use'])

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
    maxRetries: 0,
    fetchOptions: { dispatcher: streamingDispatcher() }
  })
  const signal = deps.signal
  const log = deps.log
  const start = String(process.hrtime.bigint())
  let first = null

  let imageParts
  let imageBlocks = []
  try {
    const trusted = isTrustedMedia(envelope)
    imageParts = await loadImageParts(envelope.prompt, { trusted })
    if (envelope.images?.length) {
      imageBlocks = (await loadImages(envelope.images, { trusted })).map(toAnthropicImageBlock)
    }
  } catch (e) {
    log?.warn({ err: e }, '[mohdel:anthropic] image load failed')
    const typed = /** @type {any} */(e).typed
    yield { type: 'error', error: typed || classifyProviderError(e, envelope.auth?.key, { provider: 'anthropic' }) }
    return
  }

  const { system, conversation, conversationCacheTtl } = splitPrompt(envelope.prompt, imageParts, envelope.model)
  if (imageBlocks.length) injectImageBlocks(conversation, imageBlocks)

  const request = buildRequest(envelope, conversation, system, conversationCacheTtl)

  // Array + join, not `+=`: per-delta cons-strings are the cost on a long stream.
  const outputParts = []
  const currentOutput = () => outputParts.join('')
  let inputTokens = 0
  let outputTokens = 0
  let cacheWriteTokens = 0
  let cacheWrite1hTokens = 0
  let cacheReadTokens = 0
  /** @type {number | null} */
  let reportedThinkingTokens = null
  // The response's content blocks as they came, sent back unmodified to this model on its next call.
  /** @type {any[]} */
  const blocks = []
  let replayable = true
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
        yield abortedDone(start, first, envelope, currentOutput(), inputTokens, outputTokens, { cacheWriteInputTokens: cacheWriteTokens, cacheReadInputTokens: cacheReadTokens })
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
          // cache_creation breaks the write total down by TTL (5m + 1h).
          // Surface the 1h subset so the cost layer can price it separately;
          // a request may mix TTLs, so both tiers can be non-zero.
          if (event.message?.usage?.cache_creation?.ephemeral_1h_input_tokens) {
            cacheWrite1hTokens = event.message.usage.cache_creation.ephemeral_1h_input_tokens
          }
          if (event.message?.usage?.cache_read_input_tokens) {
            cacheReadTokens = event.message.usage.cache_read_input_tokens
          }
          break

        case 'content_block_start':
          if (REPLAYED_BLOCKS.has(event.content_block?.type)) blocks[event.index] = { ...event.content_block }
          else replayable = false
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
            if (blocks[event.index]) blocks[event.index].text = (blocks[event.index].text ?? '') + event.delta.text
            yield { type: 'delta', delta: { type: 'message', delta: event.delta.text } }
          } else if (event.delta?.type === 'thinking_delta') {
            const text = event.delta.thinking || ''
            if (blocks[event.index]) blocks[event.index].thinking = (blocks[event.index].thinking ?? '') + text
            if (text) {
              if (first === null) first = String(process.hrtime.bigint())
              yield { type: 'delta', delta: { type: 'reasoning_summary', delta: text } }
            }
          } else if (event.delta?.type === 'signature_delta') {
            if (blocks[event.index]) blocks[event.index].signature = event.delta.signature
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
          if (typeof event.usage?.output_tokens_details?.thinking_tokens === 'number') {
            reportedThinkingTokens = event.usage.output_tokens_details.thinking_tokens
          }
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
      yield abortedDone(start, first, envelope, currentOutput(), inputTokens, outputTokens, { cacheWriteInputTokens: cacheWriteTokens, cacheReadInputTokens: cacheReadTokens })
      return
    }
    log?.warn({ err: e }, '[mohdel:anthropic] stream failed')
    yield { type: 'error', error: classifyProviderError(e, envelope.auth?.key, { provider: 'anthropic' }) }
    return
  }

  if (signal?.aborted) {
    yield abortedDone(start, first, envelope, currentOutput(), inputTokens, outputTokens, { cacheWriteInputTokens: cacheWriteTokens, cacheReadInputTokens: cacheReadTokens })
    return
  }

  const end = String(process.hrtime.bigint())
  // Thinking tokens, when the response does not report them: the gap
  // between Anthropic's output_tokens and what streamed as visible output
  // (text + tool input JSON). Streamed thinking text is a summary, so its
  // length says nothing of the tokens thought.
  //
  // When the caller explicitly disabled thinking via `outputEffort: 'none'`,
  // we did NOT send `request.thinking` (see buildRequest) — Anthropic
  // won't emit thinking content, redacted or otherwise — so the fallback
  // heuristic would only attribute the natural chars/4 estimation gap
  // (Anthropic packs denser than 4 chars/token on most content) to a
  // non-existent thinking budget. Trust the explicit opt-out and report
  // zero.
  const streamedOutput = currentOutput()
  const streamedOutputChars = streamedOutput.length +
    [...toolBlocks.values()].reduce((s, b) => s + b.inputJson.length, 0)
  const streamedOutputTokens = Math.ceil(streamedOutputChars / ANTHROPIC_THINKING_CHARS_PER_TOKEN)
  const thinkingDisabled = envelope.outputEffort === 'none'
  let estimatedThinkingTokens
  if (reportedThinkingTokens !== null) {
    estimatedThinkingTokens = Math.min(reportedThinkingTokens, outputTokens)
  } else if (thinkingDisabled) {
    estimatedThinkingTokens = 0
  } else {
    estimatedThinkingTokens = Math.max(0, outputTokens - streamedOutputTokens)
  }
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
      ...(cacheWrite1hTokens > 0 && { cacheWrite1hInputTokens: cacheWrite1hTokens }),
      ...(cacheReadTokens > 0 && { cacheReadInputTokens: cacheReadTokens }),
      cost: costFor(
        envelope,
        {
          inputTokens,
          outputTokens: messageOutputTokens,
          thinkingTokens: estimatedThinkingTokens,
          cacheWriteInputTokens: cacheWriteTokens,
          cacheWrite1hInputTokens: cacheWrite1hTokens,
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
  const turn = replayable && blocks.some(b => b?.type === 'thinking' || b?.type === 'redacted_thinking')
    ? replayBlocks(blocks, toolBlocks)
    : null
  if (turn) done.result.reasoningParts = [{ type: 'reasoning', text: '', encrypted: JSON.stringify(turn), model: envelope.model }]
  yield done
}

/**
 * A response's content blocks, cleaned to what goes back: thinking with its signature, redacted
 * thinking, text, and tool calls with their parsed input.
 *
 * @param {any[]} blocks
 * @param {Map<number, {id: string, name: string, inputJson: string}>} toolBlocks
 */
function replayBlocks (blocks, toolBlocks) {
  return blocks.flatMap((b, index) => {
    if (!b) return []
    if (b.type === 'thinking') return [{ type: 'thinking', thinking: b.thinking ?? '', signature: b.signature ?? '' }]
    if (b.type === 'redacted_thinking') return [{ type: 'redacted_thinking', data: b.data }]
    if (b.type === 'text') return [{ type: 'text', text: b.text ?? '' }]
    const call = toolBlocks.get(index)
    return [{ type: 'tool_use', id: b.id, name: b.name, input: safeParseJson(call?.inputJson ?? '') }]
  })
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
 * @param {'5m'|'1h'|null} [conversationCacheTtl]
 *   When set, place conversation-prefix breakpoints (see
 *   `applyCacheBreakpoints`).
 */
function buildRequest (envelope, conversation, system, conversationCacheTtl = null) {
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
      request.thinking = { type: 'adaptive', display: envelope.reasoningSummaries === true ? 'summarized' : 'omitted' }
      if (spec.thinkingEffortLevels[effort] != null) {
        request.output_config = { effort }
      }
      // Thinking tokens share the output budget — give them the full
      // model limit instead of just the requested outputBudget.
      if (outputTokenLimit) request.max_tokens = outputTokenLimit
    }
  }

  applyCacheBreakpoints(request, conversationCacheTtl)

  request.max_tokens = capOutput(request.max_tokens, outputTokenLimit)

  return request
}

/** Anthropic caps `cache_control` breakpoints at 4 per request. */
const MAX_CACHE_BREAKPOINTS = 4

/**
 * Conversation breakpoints sit at stable block positions (indices
 * ≡ 15 mod 16) so that consecutive requests share entry positions
 * even when one request appends more blocks than Anthropic's
 * 20-block cache lookback covers.
 */
const MILESTONE_INTERVAL = 16

/** @param {'5m'|'1h'} ttl */
function cacheControlFor (ttl) {
  return ttl === '1h'
    ? { type: 'ephemeral', ttl: '1h' }
    : { type: 'ephemeral' }
}

/**
 * A `cache: '5m'|'1h'` marker on any non-system message part opts the
 * conversation into prefix caching. Over-cap system breakpoints are
 * dropped middle-first: the first one is the most stable read fallback
 * (volatile blocks like session memory sit later), the last covers the
 * full system prompt. Dropping a breakpoint never changes prompt
 * content — only cache eligibility.
 *
 * @param {{system?: any, messages: Array<{role: string, content: any}>}} request
 * @param {'5m'|'1h'|null} conversationTtl
 */
function applyCacheBreakpoints (request, conversationTtl) {
  let messageBreakpoints = 0
  if (conversationTtl && request.messages.length) {
    messageBreakpoints = placeConversationBreakpoints(request.messages, conversationTtl)
  }
  if (Array.isArray(request.system)) {
    const marked = request.system.filter(b => b.cache_control)
    const budget = MAX_CACHE_BREAKPOINTS - messageBreakpoints
    while (marked.length > budget && marked.length > 0) {
      const drop = marked.length > 1 ? marked.splice(1, 1)[0] : marked.shift()
      delete drop.cache_control
    }
  }
}

/**
 * @param {Array<{role: string, content: any}>} messages
 * @param {'5m'|'1h'} ttl
 * @returns {number} breakpoints placed
 */
function placeConversationBreakpoints (messages, ttl) {
  const blockCount = messages.reduce(
    (n, m) => n + (Array.isArray(m.content) ? m.content.length : 1), 0)
  if (blockCount === 0) return 0
  const trailing = blockCount - 1
  const targets = [trailing]
  const milestone = MILESTONE_INTERVAL * Math.floor(trailing / MILESTONE_INTERVAL) - 1
  if (milestone >= 0 && milestone !== trailing) targets.unshift(milestone)
  // A thinking block cannot carry `cache_control`; the breakpoint moves back to the block before it.
  const flat = messages.flatMap(m => Array.isArray(m.content) ? m.content.map((b, i) => ({ m, i, b })) : [{ m, i: 0, b: null }])
  const thinking = (ref) => ref.b?.type === 'thinking' || ref.b?.type === 'redacted_thinking'
  const marked = new Set()
  for (let t of targets) {
    while (t >= 0 && thinking(flat[t])) t--
    if (t < 0 || marked.has(t)) continue
    marked.add(t)
    const { m, i } = flat[t]
    if (!Array.isArray(m.content)) m.content = [{ type: 'text', text: m.content }]
    m.content[i].cache_control = cacheControlFor(ttl)
  }
  return marked.size
}

/** @param {string | import('#core/envelope.js').Message[]} prompt */
function splitPrompt (prompt, imageParts, model) {
  if (typeof prompt === 'string') {
    return { system: '', conversation: [{ role: 'user', content: prompt }], conversationCacheTtl: null }
  }
  /** @type {string[]} */
  const systemParts = []
  /** @type {Array<{type: string, text: string, cache_control?: object}>} */
  const systemBlocks = []
  let hasCacheMarkers = false
  /** @type {'5m'|'1h'|null} */
  let conversationCacheTtl = null
  /** @type {Array<{role: string, content: any}>} */
  const conversation = []
  for (const m of prompt) {
    if (m.role !== 'system' && Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p?.cache === '5m' || p?.cache === '1h') conversationCacheTtl = p.cache
      }
    }
    if (m.role === 'system') {
      // Translate caller-supplied cache markers ({text, cache: '5m'|'1h'})
      // into Anthropic's cache_control. Preserves the block boundary the
      // caller chose; collapsing into a single string would silently disable
      // caching even when the prompt was composed with explicit
      // breakpoints.
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
          content: hasImagePart(m.content) ? toAnthropicContent(m.content, imageParts) : flattenText(m.content)
        }]
      })
    } else if (m.role === 'assistant' && boundTurn(m.content, model).length) {
      conversation.push({ role: 'assistant', content: boundTurn(m.content, model) })
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
        content: toAnthropicContent(m.content, imageParts)
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
  return { system, conversation, conversationCacheTtl }
}

/**
 * An assistant turn this model produced, as its blocks came — thinking included, which the API
 * takes back only unmodified and in order — or none.
 *
 * @param {string | import('#core/envelope.js').MessagePart[]} content
 * @param {string} model
 * @returns {any[]}
 */
function boundTurn (content, model) {
  if (!Array.isArray(content)) return []
  return content
    .filter(p => p.type === 'reasoning' && p.encrypted && p.model === model)
    .flatMap(p => JSON.parse(p.encrypted))
}

/**
 * The answer's text: what a model wrote for the person while it worked comes back in its own
 * thinking blocks, never as text.
 *
 * @param {string | import('#core/envelope.js').MessagePart[]} content
 */
function flattenText (content) {
  if (typeof content === 'string') return content
  return content.filter(p => p.type === 'text' && p.text && p.phase !== 'commentary').map(p => p.text).join('\n')
}

/**
 * @param {string | import('#core/envelope.js').MessagePart[]} content
 * @param {Map<object, import('./_images.js').LoadedImage>} imageParts
 */
function toAnthropicContent (content, imageParts) {
  if (typeof content === 'string') return content
  return content.filter(p => p.type !== 'reasoning' && p.phase !== 'commentary').map(p => {
    if (p.type === 'text') return { type: 'text', text: p.text ?? '' }
    if (p.type === 'image') return toAnthropicImageBlock(imageParts.get(p))
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
