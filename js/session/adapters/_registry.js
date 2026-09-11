/**
 * Adapter names and speed lanes, as plain data.
 *
 * Importing an adapter pulls its provider SDK; importing the registry in
 * `index.js` pulls all of them, which is ~300ms. Anything that only needs to
 * know *which* adapters exist, or what lanes a provider sells, reads this
 * instead and pays nothing.
 *
 * @module session/adapters/registry
 */

/** Every adapter module under `./`, named for the provider it serves. */
export const ADAPTER_NAMES = Object.freeze([
  'anthropic',
  'cerebras',
  'deepseek',
  'echo',
  'fake',
  'fireworks',
  'gemini',
  'groq',
  'local',
  'mistral',
  'novita',
  'openai',
  'openrouter',
  'qwen',
  'xai',
  'xiaomi'
])

/**
 * Speed lanes each provider's adapter can emit. The adapter carries the same
 * set on `adapter.speedLanes`; this is the copy readable without loading it.
 */
export const SPEED_LANES = Object.freeze({
  openai: new Set(['fast', 'priority', 'flex', 'scale'])
})

/** Image adapters, keyed by provider; the module exports `<provider>Image`. */
export const IMAGE_ADAPTER_NAMES = Object.freeze(['openai', 'novita', 'fake'])

/** Whether a provider has an image adapter. Answerable without loading one. */
export const isImageProvider = (provider) => IMAGE_ADAPTER_NAMES.includes(provider)
