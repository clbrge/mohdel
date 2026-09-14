/**
 * Per-provider facts the live suite and the capability probe both need.
 */

/**
 * @typedef {object} LiveSpec
 * @property {string} defaultModel         Bare model ID (no provider prefix).
 * @property {boolean} streams             Whether the adapter emits real SSE deltas.
 * @property {number} [truncateBudget]     outputBudget for the incomplete test. Default 1.
 */

/** @type {Record<string, LiveSpec>} */
export const SPECS = {
  anthropic: { defaultModel: 'claude-haiku-4-5', streams: true },
  openai: { defaultModel: 'gpt-5-mini', streams: true, truncateBudget: 16 },
  gemini: { defaultModel: 'gemini-2.5-flash', streams: true },
  xai: { defaultModel: 'grok-4-1-fast-non-reasoning', streams: true, truncateBudget: 16 },
  fireworks: { defaultModel: 'accounts/fireworks/models/glm-5p3-flash', streams: true },
  openrouter: { defaultModel: 'anthropic/claude-haiku-4-5', streams: true },
  cerebras: { defaultModel: 'gpt-oss-120b', streams: true },
  deepseek: { defaultModel: 'deepseek-chat', streams: false },
  groq: { defaultModel: 'qwen/qwen3.8-27b', streams: true },
  mistral: { defaultModel: 'mistral-small-latest', streams: true },
  novita: { defaultModel: 'zai-org/glm-5.3-flash', streams: true },
  qwen: { defaultModel: 'qwen3.6-flash', streams: true, truncateBudget: 16 },
  xiaomi: { defaultModel: 'mimo-v2.5', streams: true },
  local: { defaultModel: 'llama3.1:8b', streams: true }
}
