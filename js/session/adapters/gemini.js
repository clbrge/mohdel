/**
 * Google Gemini (`@google/genai`) adapter.
 *
 * Scope:
 *   - Text in, text out, streaming
 *   - Status contract (incomplete + warning on MAX_TOKENS)
 *   - Tools: unified format → Gemini FunctionDeclaration; functionCall
 *     parts collected per chunk; tool_use terminal state;
 *     functionResponse parts on the way back in
 *   - Images (inlineData for base64 / data URIs, fileData for https://)
 *   - Videos (inline ≤20MB, upload + poll for larger or when
 *     `cache: true`, content-hashed cache at `~/.cache/mohdel/uploaded-files.json`)
 *   - AbortSignal forwarded to SDK
 *
 * @module session/adapters/gemini
 */

import { GoogleGenAI } from '@google/genai'

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
import { loadVideos } from './_videos.js'
import { costFor } from './_pricing.js'
import {
  toGeminiTools,
  fromGeminiToolCalls,
  toToolChoice
} from './_tools.js'

/**
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {{client?: GoogleGenAI, signal?: AbortSignal, log?: any, span?: any}} [deps]
 * @returns {AsyncGenerator<import('#core/events.js').Event>}
 */
export async function * gemini (envelope, deps = {}) {
  const client = deps.client ?? new GoogleGenAI({ apiKey: envelope.auth.key })
  const signal = deps.signal
  const log = deps.log
  const start = String(process.hrtime.bigint())
  let first = null

  const { systemInstruction, contents } = buildContents(envelope.prompt)

  if (envelope.images?.length) {
    try {
      const loaded = await loadImages(envelope.images)
      const parts = loaded.map(toGeminiImagePart).filter(Boolean)
      if (parts.length) injectParts(contents, parts)
    } catch (e) {
      log?.warn({ err: e }, '[mohdel:gemini] image load failed')
      yield { type: 'error', error: classifyProviderError(e) }
      return
    }
  }

  if (envelope.videos?.length) {
    try {
      const parts = await loadVideos(envelope.videos, {
        client,
        useCache: !!envelope.cache,
        signal
      })
      if (parts.length) injectParts(contents, parts)
    } catch (e) {
      if (signal?.aborted) {
        yield cancelledDone(start, first, envelope, '', 0, 0)
        return
      }
      log?.warn({ err: e }, '[mohdel:gemini] video load failed')
      // `typed` lets _videos.js surface PROVIDER_UNAVAILABLE on
      // upload-deadline timeouts; fall back to generic classification.
      const typed = /** @type {any} */(e).typed
      yield { type: 'error', error: typed || classifyProviderError(e) }
      return
    }
  }

  const request = buildRequest(envelope, contents, systemInstruction)

  // The Google `@google/genai` SDK reads abortSignal exclusively
  // from `params.config.abortSignal` — a second-arg `{signal}` is
  // dropped (verified against the compiled SDK at
  // node_modules/@google/genai/dist/index.cjs). Merge into config
  // so cancellation actually tears down the HTTPS request, not just
  // the local loop.
  if (signal) {
    request.config = { ...(request.config ?? {}), abortSignal: signal }
  }

  // F53: accumulate via array + join to avoid per-delta V8 cons-string
  // churn. Materialized at each exit point.
  const outputParts = []
  const currentOutput = () => outputParts.join('')
  let inputTokens = 0
  let outputTokens = 0
  let thinkingTokens = 0
  let status = STATUS_COMPLETED
  /** @type {string | undefined} */
  let warning
  /** @type {Array<{name: string, args: any}>} */
  const collectedFunctionCalls = []

  try {
    const stream = await client.models.generateContentStream(request)

    for await (const chunk of stream) {
      if (signal?.aborted) {
        yield cancelledDone(start, first, envelope, currentOutput(), inputTokens, outputTokens)
        return
      }

      for (const part of chunk?.candidates?.[0]?.content?.parts ?? []) {
        if (typeof part.text === 'string' && part.text.length > 0) {
          if (first === null) first = String(process.hrtime.bigint())
          outputParts.push(part.text)
          yield { type: 'delta', delta: { type: 'message', delta: part.text } }
        } else if (part.functionCall) {
          if (first === null) first = String(process.hrtime.bigint())
          // `thoughtSignature` is sibling to `functionCall` on the part.
          // Hoist it onto the collected object so `fromGeminiToolCalls`
          // can propagate it through to the unified toolCalls shape,
          // and any replay of this assistant turn puts the signature
          // back on the outgoing part (required for gemini to accept
          // a prior tool call on the next turn).
          collectedFunctionCalls.push(
            part.thoughtSignature
              ? { ...part.functionCall, thoughtSignature: part.thoughtSignature }
              : part.functionCall
          )
          // Gemini sends complete functionCall parts (not streamed args).
          // Emit a single function_call delta with the serialized args
          // so consumers that watch for delta chunks see something.
          const delta = JSON.stringify(part.functionCall.args ?? {})
          yield {
            type: 'delta',
            delta: { type: 'function_call', delta }
          }
        }
      }

      const finish = chunk?.candidates?.[0]?.finishReason
      if (finish && isIncompleteFinish(finish)) {
        status = STATUS_INCOMPLETE
        if (finish === 'MAX_TOKENS') warning = WARNING_INSUFFICIENT_OUTPUT_BUDGET
      }

      if (chunk?.usageMetadata) {
        if (typeof chunk.usageMetadata.promptTokenCount === 'number') {
          inputTokens = chunk.usageMetadata.promptTokenCount
        }
        if (typeof chunk.usageMetadata.candidatesTokenCount === 'number') {
          outputTokens = chunk.usageMetadata.candidatesTokenCount
        }
        if (typeof chunk.usageMetadata.thoughtsTokenCount === 'number') {
          thinkingTokens = chunk.usageMetadata.thoughtsTokenCount
        }
      }
    }
  } catch (e) {
    if (signal?.aborted) {
      yield cancelledDone(start, first, envelope, currentOutput(), inputTokens, outputTokens)
      return
    }
    log?.warn({ err: e }, '[mohdel:gemini] stream failed')
    yield { type: 'error', error: classifyProviderError(e) }
    return
  }

  if (signal?.aborted) {
    yield cancelledDone(start, first, envelope, currentOutput(), inputTokens, outputTokens)
    return
  }

  if (collectedFunctionCalls.length > 0 && status === STATUS_COMPLETED) {
    status = STATUS_TOOL_USE
  }

  const end = String(process.hrtime.bigint())
  /** @type {import('#core/events.js').DoneEvent} */
  const done = {
    type: 'done',
    result: {
      status,
      output: currentOutput() || null,
      inputTokens,
      outputTokens,
      thinkingTokens,
      cost: costFor(
        `${envelope.provider}/${envelope.model}`,
        { inputTokens, outputTokens, thinkingTokens }
      ),
      timestamps: { start, first: first ?? end, end }
    }
  }
  if (warning) done.result.warning = warning
  if (collectedFunctionCalls.length > 0) {
    done.result.toolCalls = fromGeminiToolCalls(collectedFunctionCalls)
  }
  yield done
}

/**
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {Array<{role: string, parts: any[]}>} contents
 * @param {string} systemInstruction
 */
function buildRequest (envelope, contents, systemInstruction) {
  const spec = getSpec(`${envelope.provider}/${envelope.model}`)

  /** @type {Record<string, any>} */
  const config = {}
  if (systemInstruction) config.systemInstruction = systemInstruction
  if (envelope.outputBudget !== undefined) config.maxOutputTokens = envelope.outputBudget
  if (envelope.tools?.length) {
    config.tools = toGeminiTools(envelope.tools)
    if (envelope.toolChoice) {
      config.toolConfig = toToolChoice('gemini', envelope.toolChoice)
    }
  }

  // Thinking — model-family-dependent shape:
  //   - gemini-3.x: thinkingConfig = { includeThoughts: true, thinkingLevel: <name> }
  //   - gemini-2.x: thinkingConfig = { thinkingBudget: <number> }
  //   - other (e.g. gemini-1.5): thinkingBudget with maxOutputTokens
  //     adjustment for headroom
  const effort = envelope.outputEffort ?? spec?.defaultThinkingEffort
  if (spec?.thinkingEffortLevels && effort && effort !== 'none') {
    const budget = spec.thinkingEffortLevels[effort]
    if (/^gemini-3/.test(envelope.model)) {
      config.thinkingConfig = { includeThoughts: true, thinkingLevel: effort }
    } else if (/gemini-2/.test(envelope.model)) {
      if (typeof budget === 'number') {
        config.thinkingConfig = { thinkingBudget: budget }
      }
    } else {
      if (typeof budget === 'number') {
        config.thinkingConfig = { thinkingBudget: budget }
        if (config.maxOutputTokens && budget > 0) {
          config.maxOutputTokens += budget
        }
      }
    }
  }

  /** @type {Record<string, any>} */
  const request = {
    model: envelope.model,
    contents
  }
  if (Object.keys(config).length > 0) request.config = config
  return request
}

/** @param {string | import('#core/envelope.js').Message[]} prompt */
function buildContents (prompt) {
  if (typeof prompt === 'string') {
    return {
      systemInstruction: '',
      contents: [{ role: 'user', parts: [{ text: prompt }] }]
    }
  }
  /** @type {string[]} */
  const systemParts = []
  /** @type {Array<{role: string, parts: any[]}>} */
  const contents = []
  for (const m of prompt) {
    if (m.role === 'system') {
      systemParts.push(flattenText(m.content))
    } else if (m.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: m.toolName ?? '',
            response: safeParseToolResult(m.content)
          }
        }]
      })
    } else if (m.role === 'assistant' && m.toolCalls?.length) {
      // Gemini expects a single `model` turn carrying both text and
      // functionCall parts. When replaying a prior assistant turn, the
      // `thoughtSignature` attached to each tool call by gemini on the
      // original response must ride back into the part — without it,
      // the next call is rejected as a hand-constructed history.
      const parts = []
      const text = flattenText(m.content)
      if (text) parts.push({ text })
      for (const tc of m.toolCalls) {
        const part = {
          functionCall: { name: tc.name, args: tc.arguments ?? {} }
        }
        if (tc.thoughtSignature) part.thoughtSignature = tc.thoughtSignature
        parts.push(part)
      }
      contents.push({ role: 'model', parts })
    } else {
      contents.push({
        role: mapRole(m.role),
        parts: toGeminiParts(m.content)
      })
    }
  }
  return {
    systemInstruction: systemParts.filter(Boolean).join('\n\n'),
    contents
  }
}

/** @param {string | import('#core/envelope.js').MessagePart[]} content */
function safeParseToolResult (content) {
  const text = flattenText(content)
  try { return JSON.parse(text) } catch { return { result: text } }
}

/** @param {string} role */
function mapRole (role) {
  if (role === 'assistant') return 'model'
  return role
}

/** @param {string | import('#core/envelope.js').MessagePart[]} content */
function flattenText (content) {
  if (typeof content === 'string') return content
  return content.filter(p => p.type === 'text' && p.text).map(p => p.text).join('\n')
}

/** @param {string | import('#core/envelope.js').MessagePart[]} content */
function toGeminiParts (content) {
  if (typeof content === 'string') return [{ text: content }]
  return content.map(p => {
    if (p.type === 'text') return { text: p.text ?? '' }
    throw new Error(`unsupported content part type: ${p.type}`)
  })
}

/** @param {import('./_images.js').LoadedImage} img */
function toGeminiImagePart (img) {
  if (img.base64) {
    return { inlineData: { mimeType: img.mimeType, data: img.base64 } }
  }
  if (img.url) {
    return { fileData: { mimeType: img.mimeType, fileUri: img.url } }
  }
  return null
}

/**
 * Append media parts to the LAST user message in `contents`. Used
 * for both images and videos — Gemini's `parts` array is homogeneous
 * so the injection logic doesn't care which media type.
 *
 * @param {Array<{role: string, parts: any[]}>} contents
 * @param {Array<any>} parts
 */
function injectParts (contents, parts) {
  for (let i = contents.length - 1; i >= 0; i--) {
    if (contents[i].role !== 'user') continue
    contents[i].parts = [...contents[i].parts, ...parts]
    return
  }
  contents.push({ role: 'user', parts })
}

/** @param {string} reason */
function isIncompleteFinish (reason) {
  return reason === 'MAX_TOKENS' ||
    reason === 'SAFETY' ||
    reason === 'RECITATION' ||
    reason === 'BLOCKLIST' ||
    reason === 'PROHIBITED_CONTENT' ||
    reason === 'SPII'
}
