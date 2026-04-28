/**
 * Shared chat.completions core — handles both streaming and
 * non-streaming variants.
 *
 * Used by all providers that speak the classic OpenAI Chat
 * Completions shape (Groq, Cerebras, DeepSeek, Mistral, OpenRouter,
 * Fireworks). Each provider supplies an SDK client factory plus a
 * small config block (tool-choice flavor, identifier field name,
 * DSML fallback, reasoning field mapping, arg mutation hook); this
 * module owns the request/response shape.
 *
 * Non-streaming mode emits a single synthetic `delta` for the
 * visible message content followed by a terminal `done`. Streaming
 * mode emits real per-chunk deltas.
 *
 * @module session/adapters/_chat_completions
 */

import { getSpec } from './_catalog.js'
import { classifyProviderError } from './_errors.js'
import { costFor } from './_pricing.js'
import { catalogKey, bareOf } from '#core/model-id.js'
import {
  STATUS_COMPLETED,
  STATUS_INCOMPLETE,
  STATUS_TOOL_USE,
  WARNING_INSUFFICIENT_OUTPUT_BUDGET
} from '#core/status.js'
import {
  toCerebrasTools,
  fromCerebrasToolCalls,
  toToolChoice
} from './_tools.js'

// DSML parse regexes. These run against untrusted model output, so
// worst-case match time MUST stay linear in input length (no ReDoS).
// Rules to preserve that:
//   - Lazy quantifiers (`*?`) only with bounded character classes
//     (`[\s\S]`, `[^"]`, `[^<]`) and followed by a literal/anchor.
//   - No nested alternations (e.g. `(a|b)*?`) inside a quantifier —
//     that's what flips `*?` to exponential worst-case.
//   - No backreferences.
// If you add a new pattern here, benchmark it against a 1 MiB
// adversarial input before merging.
const DSML_RE = /<\uFF5CDSML\uFF5Cfunction_calls>/
const DSML_BLOCK_RE = /<\uFF5CDSML\uFF5Cfunction_calls>[\s\S]*?<\/\uFF5CDSML\uFF5Cfunction_calls>/g
const DSML_INVOKE_RE = /<\uFF5CDSML\uFF5Cinvoke\s+name="([^"]+)">([\s\S]*?)<\/\uFF5CDSML\uFF5Cinvoke>/g
const DSML_PARAM_RE = /<\uFF5CDSML\uFF5Cparameter\s+name="([^"]+)"(?:\s+string="([^"]*)")?>([^<]*)<\/\uFF5CDSML\uFF5Cparameter>/g

/**
 * @typedef {object} ChatCompletionsConfig
 * @property {string} provider
 *   Registry key. Also used as tool-choice flavor unless
 *   `toolChoiceFlavor` is set.
 * @property {'openai'|'mistral'|'cerebras'} [toolChoiceFlavor]
 * @property {'user'|'safety_identifier'} [identifierField]
 *   Defaults to 'user'.
 * @property {'reasoning_effort'|'cerebras_zai'} [reasoningField]
 *   How to wire outputEffort into the request. `reasoning_effort`
 *   sets `args.reasoning_effort = effort`. `cerebras_zai` flips
 *   `args.disable_reasoning = false` instead (zai-family only).
 * @property {boolean} [parseDsml]
 *   Extract DeepSeek DSML function-call blocks from message content
 *   when native `tool_calls` is absent.
 * @property {boolean} [stream]
 *   Use chat.completions streaming. Emits real delta events per SSE
 *   chunk; usage reported on the final chunk via
 *   `stream_options.include_usage`.
 * @property {(envelope: any, args: any) => void} [mutateArgs]
 *   Last-mile hook to splice provider-specific fields into the
 *   request (e.g. OpenRouter routing prefs).
 */

/**
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {any} client
 * @param {ChatCompletionsConfig} config
 * @param {{signal?: AbortSignal, log?: any, span?: any}} [deps]
 * @returns {AsyncGenerator<import('#core/events.js').Event>}
 */
export async function * runChatCompletions (envelope, client, config, deps = {}) {
  const spec = getSpec(catalogKey(envelope.model)) || {}
  const start = String(process.hrtime.bigint())

  const args = buildRequest(envelope, spec, config)
  if (config.mutateArgs) config.mutateArgs(envelope, args)

  if (config.stream) {
    yield * runStreaming(envelope, client, args, config, start, deps)
    return
  }

  let response
  try {
    response = await client.chat.completions.create(args, { signal: deps.signal })
  } catch (e) {
    deps.log?.warn({ err: e }, `[mohdel:${config.provider}] request failed`)
    yield { type: 'error', error: classifyProviderError(e) }
    return
  }

  const first = String(process.hrtime.bigint())
  const choice = Array.isArray(response?.choices) ? response.choices[0] : null
  const message = choice?.message || {}
  const usage = response?.usage || {}
  const finishReason = choice?.finish_reason

  let content = message.content || ''
  let toolCalls = message.tool_calls

  if (config.parseDsml && content && (!toolCalls || !toolCalls.length)) {
    const dsml = parseDsmlToolCalls(content)
    if (dsml) {
      toolCalls = dsml
      content = stripDsml(content)
    }
  }

  if (content) {
    yield { type: 'delta', delta: { type: 'message', delta: content } }
  }

  yield finalize({
    envelope, content, toolCalls, usage, finishReason, start, first
  })
}

/**
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {any} client
 * @param {any} args
 * @param {ChatCompletionsConfig} config
 * @param {string} start
 * @param {{signal?: AbortSignal}} deps
 */
async function * runStreaming (envelope, client, args, config, start, deps) {
  args.stream = true
  args.stream_options = { include_usage: true }

  // F53: accumulate via array + join to avoid per-delta V8 cons-string
  // churn on long streams.
  const contentParts = []
  let first = null
  let finishReason = null
  let usage = {}
  const toolCallAccum = {}
  // Cross-reference: tc.id observed on the opener → slot index. Lets
  // us correlate continuation chunks that carry only `id` (some
  // OpenAI-compat providers omit `index` after the opener) back to
  // their original slot. Without this, chunks defaulting to
  // `index ?? 0` silently merge multiple calls into slot 0.
  const idToIndex = {}

  let stream
  try {
    stream = await client.chat.completions.create(args, { signal: deps.signal })
  } catch (e) {
    deps.log?.warn({ err: e }, `[mohdel:${config.provider}] request failed`)
    yield { type: 'error', error: classifyProviderError(e) }
    return
  }

  try {
    for await (const chunk of stream) {
      const choice = chunk.choices?.[0]
      // DeepSeek V4 / deepseek-reasoner / Cerebras reasoning models emit
      // `delta.reasoning_content` chunks before visible content. Don't
      // accumulate (token count comes from `usage.completion_tokens_details.
      // reasoning_tokens`), but do mark TTFT so the first-token timestamp
      // reflects actual model start, not just first visible token.
      if (choice?.delta?.reasoning_content && first === null) {
        first = String(process.hrtime.bigint())
      }
      if (choice?.delta?.content) {
        if (first === null) first = String(process.hrtime.bigint())
        contentParts.push(choice.delta.content)
        yield { type: 'delta', delta: { type: 'message', delta: choice.delta.content } }
      }
      if (choice?.delta?.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          // Resolve which slot this chunk belongs to:
          //   1. explicit `tc.index` always wins (normal case);
          //   2. missing `tc.index` but a `tc.id` we've seen before
          //      → use the cross-ref we recorded on the opener;
          //   3. new `tc.id` with no index → allocate next slot;
          //   4. neither id nor index → can't correlate; drop + warn.
          let idx = tc.index
          if (idx == null && tc.id != null && idToIndex[tc.id] != null) {
            idx = idToIndex[tc.id]
          }
          if (idx == null && tc.id != null) {
            idx = Object.keys(toolCallAccum).length
          }
          if (idx == null) {
            deps.log?.warn(
              { tc },
              `[mohdel:${config.provider}] tool_call chunk with no id or index; skipped`
            )
            continue
          }
          const slot = toolCallAccum[idx] || (toolCallAccum[idx] = { id: '', name: '', arguments: '' })
          if (tc.id) {
            slot.id = tc.id
            idToIndex[tc.id] = idx
          }
          if (tc.function?.name) slot.name += tc.function.name
          if (tc.function?.arguments) {
            slot.arguments += tc.function.arguments
            if (first === null) first = String(process.hrtime.bigint())
            yield {
              type: 'delta',
              delta: { type: 'function_call', delta: tc.function.arguments }
            }
          }
        }
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason
      if (chunk.usage) usage = chunk.usage
    }
  } catch (e) {
    deps.log?.warn({ err: e }, `[mohdel:${config.provider}] stream failed`)
    yield { type: 'error', error: classifyProviderError(e) }
    return
  }

  const collectedToolCalls = Object.values(toolCallAccum).map(tc => ({
    id: tc.id,
    function: { name: tc.name, arguments: tc.arguments }
  }))

  yield finalize({
    envelope,
    content: contentParts.join(''),
    toolCalls: collectedToolCalls.length ? collectedToolCalls : null,
    usage,
    finishReason,
    start,
    first
  })
}

/**
 * @param {{
 *   envelope: any,
 *   content: string,
 *   toolCalls: any[] | null,
 *   usage: any,
 *   finishReason: string | null,
 *   start: string,
 *   first: string | null
 * }} p
 * @returns {import('#core/events.js').DoneEvent}
 */
function finalize ({ envelope, content, toolCalls, usage, finishReason, start, first }) {
  const end = String(process.hrtime.bigint())
  const inputTokens = usage.prompt_tokens || 0
  const totalOutputTokens = usage.completion_tokens || 0
  const thinkingTokens = usage.completion_tokens_details?.reasoning_tokens || 0
  const visibleOutputTokens = Math.max(0, totalOutputTokens - thinkingTokens)

  const truncated = finishReason === 'length'
  let status = truncated ? STATUS_INCOMPLETE : STATUS_COMPLETED
  if (toolCalls && toolCalls.length > 0) status = STATUS_TOOL_USE

  /** @type {import('#core/events.js').DoneEvent} */
  const done = {
    type: 'done',
    result: {
      status,
      output: content || null,
      inputTokens,
      outputTokens: visibleOutputTokens,
      thinkingTokens,
      cost: costFor(
        catalogKey(envelope.model),
        { inputTokens, outputTokens: visibleOutputTokens, thinkingTokens }
      ),
      timestamps: { start, first: first ?? end, end }
    }
  }
  if (truncated) done.result.warning = WARNING_INSUFFICIENT_OUTPUT_BUDGET
  if (toolCalls && toolCalls.length > 0) {
    done.result.toolCalls = fromCerebrasToolCalls(toolCalls)
  }
  return done
}

/**
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {any} spec
 * @param {ChatCompletionsConfig} config
 */
function buildRequest (envelope, spec, config) {
  /** @type {Record<string, any>} */
  const args = {
    model: spec?.model ?? bareOf(envelope.model),
    temperature: 0,
    messages: toChatMessages(envelope.prompt)
  }

  if (envelope.outputBudget !== undefined) {
    args.max_tokens = envelope.outputBudget
  }

  if (envelope.images?.length) {
    injectImages(args, envelope.images)
  }

  if (envelope.tools?.length) {
    args.tools = toCerebrasTools(envelope.tools)
    if (envelope.toolChoice) {
      args.tool_choice = toToolChoice(config.toolChoiceFlavor || 'openai', envelope.toolChoice)
    }
    if (envelope.parallelToolCalls === false) {
      args.parallel_tool_calls = false
    }
  }

  if (envelope.outputType === 'json') {
    args.response_format = { type: 'json_object' }
  }

  if (spec.thinkingEffortLevels) {
    const effort = envelope.outputEffort ?? spec.defaultThinkingEffort ?? 'low'
    if (effort && effort !== 'none') {
      const headroom = spec.thinkingEffortLevels[effort]
      if (args.max_tokens && typeof headroom === 'number') {
        args.max_tokens += headroom
      }
      delete args.temperature
      if (config.reasoningField === 'cerebras_zai' && /zai/i.test(bareOf(envelope.model))) {
        args.disable_reasoning = false
      } else {
        args.reasoning_effort = effort
      }
    }
  }

  if (envelope.identifier) {
    args[config.identifierField || 'user'] = envelope.identifier
  }

  return args
}

/**
 * @param {string | import('#core/envelope.js').Message[]} prompt
 * @returns {Array<any>}
 */
function toChatMessages (prompt) {
  if (typeof prompt === 'string') return [{ role: 'user', content: prompt }]
  return prompt.map(m => {
    if (m.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: m.toolCallId,
        content: flattenText(m.content)
      }
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      // Chat Completions assistant turn: optional `content` + the
      // `tool_calls` array. `arguments` must be a JSON string on
      // the wire.
      return {
        role: 'assistant',
        content: flattenText(m.content) || '',
        tool_calls: m.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: stringifyToolArgs(tc.arguments)
          }
        }))
      }
    }
    return { role: m.role, content: flattenText(m.content) }
  })
}

/** @param {unknown} args */
function stringifyToolArgs (args) {
  if (typeof args === 'string' && args) return args
  try { return JSON.stringify(args ?? {}) } catch { return '{}' }
}

/** @param {string | import('#core/envelope.js').MessagePart[]} content */
function flattenText (content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(p => p.type === 'text' && p.text).map(p => p.text).join('\n')
}

/**
 * @param {any} args
 * @param {import('#core/envelope.js').MediaRef[]} images
 */
function injectImages (args, images) {
  const blocks = images
    .filter(i => i?.fileUri && i?.mimeType)
    .map(i => ({
      type: 'image_url',
      image_url: { url: i.fileUri, detail: 'high' }
    }))
  if (!blocks.length) return

  // Append to the last user message; fallback to creating one.
  for (let i = args.messages.length - 1; i >= 0; i--) {
    const m = args.messages[i]
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') {
      m.content = [{ type: 'text', text: m.content }, ...blocks]
    } else if (Array.isArray(m.content)) {
      m.content = [...m.content, ...blocks]
    }
    return
  }
  args.messages.push({ role: 'user', content: blocks })
}

/** @param {string} text */
function parseDsmlToolCalls (text) {
  if (!text || !DSML_RE.test(text)) return null
  const calls = []
  let m
  while ((m = DSML_INVOKE_RE.exec(text)) !== null) {
    const args = {}
    let p
    while ((p = DSML_PARAM_RE.exec(m[2])) !== null) {
      const raw = p[3].trim()
      args[p[1]] = p[2] === 'false' && raw !== '' && !isNaN(Number(raw))
        ? Number(raw)
        : raw
    }
    calls.push({
      id: `dsml_${Date.now()}_${calls.length}`,
      type: 'function',
      function: { name: m[1], arguments: JSON.stringify(args) }
    })
  }
  return calls.length > 0 ? calls : null
}

/** @param {string} text */
function stripDsml (text) {
  if (!text) return text
  return text.replace(DSML_BLOCK_RE, '').trim() || ''
}
