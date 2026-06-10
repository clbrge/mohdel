/**
 * Shared transcription adapter for OpenAI-compatible
 * `POST <baseURL>/audio/transcriptions` endpoints (multipart upload).
 *
 * Groq, Mistral, and OpenAI all implement the same endpoint shape;
 * only the base URL and the supported `response_format` differ, so
 * one adapter covers all three. Per-provider knobs are bound via
 * `createTranscriptionAdapter` in `./index.js`.
 *
 * Duration extraction (for per-minute pricing) is response-shape
 * dependent:
 *   - `body.duration`                    — whisper `verbose_json` (Groq)
 *   - `body.usage.seconds`               — OpenAI duration-type usage
 *   - `body.usage.prompt_audio_seconds`  — Mistral Voxtral
 * OpenAI's gpt-4o-*-transcribe models report token usage instead;
 * `computeTranscriptionCost` falls back to token pricing for those.
 *
 * @module session/adapters/transcription/openai_compatible
 */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

import { getSpec } from '../_catalog.js'
import { classifyProviderError } from '../_errors.js'
import { computeTranscriptionCost } from '../_pricing.js'
import { catalogKey, bareOf } from '#core/model-id.js'

/**
 * @param {{baseURL: string, responseFormat?: string}} config
 * @returns {(
 *   env: import('#core/transcription.js').TranscriptionEnvelope,
 *   deps?: {fetch?: typeof fetch, spec?: any}
 * ) => Promise<import('#core/transcription.js').TranscriptionResult>}
 */
export function createTranscriptionAdapter ({ baseURL, responseFormat }) {
  return async function transcription (envelope, deps = {}) {
    const fetchFn = deps.fetch ?? globalThis.fetch
    const spec = deps.spec ?? getSpec(catalogKey(envelope.model)) ?? {}
    const start = String(process.hrtime.bigint())

    const audio = await loadAudio(envelope.audio)

    const form = new FormData()
    form.append('model', spec.model ?? bareOf(envelope.model))
    form.append('file', new Blob([audio.bytes], { type: audio.mimeType }), audio.filename)
    if (responseFormat) form.append('response_format', responseFormat)
    if (envelope.language) form.append('language', envelope.language)
    if (envelope.prompt) form.append('prompt', envelope.prompt)

    const root = (envelope.auth.baseURL || baseURL).replace(/\/$/, '')
    let res
    try {
      res = await fetchFn(`${root}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${envelope.auth.key}` },
        body: form
      })
    } catch (e) {
      throw typedError(classifyProviderError(e, envelope.auth?.key).message, 'NET_ERROR', true)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw fromHttpStatus(res.status, 'transcription request failed', text.slice(0, 200))
    }

    const body = await res.json()
    const durationSeconds = extractDuration(body)
    const tokens = extractTokens(body)
    const cost = computeTranscriptionCost(spec, { durationSeconds, ...tokens })

    const end = String(process.hrtime.bigint())
    return {
      status: 'completed',
      text: typeof body.text === 'string' ? body.text : '',
      language: typeof body.language === 'string' ? body.language : null,
      durationSeconds,
      ...tokens,
      cost,
      timestamps: { start, first: end, end }
    }
  }
}

/** @param {any} body */
function extractDuration (body) {
  if (typeof body.duration === 'number') return body.duration
  const u = body.usage
  if (u && typeof u === 'object') {
    if (typeof u.seconds === 'number') return u.seconds
    if (typeof u.prompt_audio_seconds === 'number') return u.prompt_audio_seconds
  }
  return null
}

/** @param {any} body */
function extractTokens (body) {
  const u = body.usage
  if (!u || typeof u !== 'object') return {}
  const out = {}
  if (typeof u.input_tokens === 'number') out.inputTokens = u.input_tokens
  if (typeof u.output_tokens === 'number') out.outputTokens = u.output_tokens
  return out
}

// Multipart filename drives format sniffing on the provider side, so
// data: URIs need an extension synthesized from the MIME subtype.
const EXT_BY_MIME = {
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus'
}

/**
 * `file://` and `data:` URIs only — providers require multipart
 * upload, so remote `https://` audio would mean mohdel silently
 * downloading arbitrary URLs; the caller owns that step.
 *
 * @param {import('#core/transcription.js').AudioRef} audio
 * @returns {Promise<{bytes: Buffer, mimeType: string, filename: string}>}
 */
export async function loadAudio (audio) {
  if (!audio?.fileUri || !audio?.mimeType) {
    throw typedError('transcription requires audio {fileUri, mimeType}', 'SESSION_INVALID_AUDIO', false)
  }
  const { fileUri, mimeType } = audio
  if (fileUri.startsWith('file://')) {
    const path = fileUri.replace(/^file:\/\//, '')
    let bytes
    try {
      bytes = await readFile(path)
    } catch (e) {
      throw typedError('audio file unreadable', 'SESSION_INVALID_AUDIO', false, messageOf(e))
    }
    return { bytes, mimeType, filename: basename(path) }
  }
  if (fileUri.startsWith('data:')) {
    const parts = fileUri.split(',')
    if (parts.length < 2) {
      throw typedError('malformed audio data URI', 'SESSION_INVALID_AUDIO', false)
    }
    const ext = EXT_BY_MIME[mimeType] || mimeType.split('/').pop() || 'bin'
    return { bytes: Buffer.from(parts[1], 'base64'), mimeType, filename: `audio.${ext}` }
  }
  throw typedError(
    `unsupported audio URI scheme: ${fileUri.slice(0, 32)}…`,
    'SESSION_INVALID_AUDIO',
    false
  )
}

function fromHttpStatus (status, message, detail) {
  const typed = classifyProviderError({ status })
  // Keep the classifier's message (stable/machine-readable); response
  // body snippets go to `detail` only (F45).
  return typedError(typed.message, typed.type, typed.retryable, detail ? `${message}: ${detail}` : message)
}

function typedError (message, type, retryable, detail) {
  const err = new Error(message)
  const typed = { message, severity: retryable ? 'warn' : 'error', retryable, type }
  if (detail) typed.detail = detail
  err.typed = typed
  return err
}

/** @param {unknown} e */
function messageOf (e) {
  return e instanceof Error ? e.message : String(e)
}
