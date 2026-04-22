/**
 * Adapter registry. Maps `envelope.provider` to an adapter function.
 *
 * Each adapter has the shape:
 *   async function* adapter(envelope) => AsyncGenerator<Event>
 *
 * Adapters should yield events in order and return when the stream
 * is complete. Exceptions thrown from an adapter are caught by
 * `run()` and converted into `call.error` events.
 *
 * @module session/adapters
 */

import { anthropic } from './anthropic.js'
import { cerebras } from './cerebras.js'
import { deepseek } from './deepseek.js'
import { echo } from './echo.js'
import { fake } from './fake.js'
import { fireworks } from './fireworks.js'
import { gemini } from './gemini.js'
import { groq } from './groq.js'
import { mistral } from './mistral.js'
import { novita } from './novita.js'
import { openai } from './openai.js'
import { openrouter } from './openrouter.js'
import { xai } from './xai.js'

export const adapters = Object.freeze({
  anthropic,
  cerebras,
  deepseek,
  echo,
  fake,
  fireworks,
  gemini,
  groq,
  mistral,
  novita,
  openai,
  openrouter,
  xai
})

/**
 * @param {string} provider
 * @returns {(env: import('#core/envelope.js').CallEnvelope)
 *   => AsyncGenerator<import('#core/events.js').Event>}
 */
export function getAdapter (provider) {
  const a = adapters[provider]
  if (!a) throw new Error(`unknown provider: ${provider}`)
  return a
}
