/**
 * Evaluation-adapter registry.
 *
 * @module session/adapters/evaluation
 */

import { typesafeEvaluation } from './typesafe.js'

const EVALUATION_ADAPTERS = {
  typesafe: typesafeEvaluation
}

export const EVALUATION_PROVIDERS = Object.freeze(Object.keys(EVALUATION_ADAPTERS))

/**
 * @param {string} provider
 */
export function getEvaluationAdapter (provider) {
  const adapter = EVALUATION_ADAPTERS[provider]
  if (!adapter) throw new Error(`no evaluation adapter for provider: ${provider}`)
  return adapter
}
