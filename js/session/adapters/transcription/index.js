/**
 * Transcription-adapter registry. Mirrors session/adapters/image but
 * scoped to speech-to-text providers.
 *
 * Groq, OpenAI, and Mistral all expose the same OpenAI-compatible
 * `POST /audio/transcriptions` multipart endpoint, so each entry is
 * the shared adapter bound to per-provider knobs:
 *
 *   - `baseURL` — the provider's OpenAI-compatible API root.
 *   - `responseFormat` — `verbose_json` where supported (returns
 *     `duration`, needed for per-minute pricing). OpenAI's
 *     gpt-4o-*-transcribe models reject `verbose_json` (plain `json`
 *     returns token usage instead); Mistral rejects the field
 *     entirely (its default response already carries
 *     `usage.prompt_audio_seconds`).
 *
 * @module session/adapters/transcription
 */

import { createTranscriptionAdapter } from './openai_compatible.js'
import { fakeTranscription } from './fake.js'

const TRANSCRIPTION_ADAPTERS = {
  groq: createTranscriptionAdapter({
    baseURL: 'https://api.groq.com/openai/v1',
    responseFormat: 'verbose_json'
  }),
  openai: createTranscriptionAdapter({
    baseURL: 'https://api.openai.com/v1',
    responseFormat: 'json'
  }),
  mistral: createTranscriptionAdapter({
    baseURL: 'https://api.mistral.ai/v1'
  }),
  fake: fakeTranscription
}

/**
 * @param {string} provider
 * @returns {(
 *   env: import('#core/transcription.js').TranscriptionEnvelope,
 *   deps?: any
 * ) => Promise<import('#core/transcription.js').TranscriptionResult>}
 */
export function getTranscriptionAdapter (provider) {
  const adapter = TRANSCRIPTION_ADAPTERS[provider]
  if (!adapter) throw new Error(`no transcription adapter for provider: ${provider}`)
  return adapter
}

/**
 * Whether the provider has a transcription adapter registered.
 *
 * @param {string} provider
 */
export function isTranscriptionProvider (provider) {
  return Object.prototype.hasOwnProperty.call(TRANSCRIPTION_ADAPTERS, provider)
}
