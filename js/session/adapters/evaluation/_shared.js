/**
 * Pre-dispatch checks every evaluation adapter runs. They reject what the
 * gate's serde types reject, so a malformed envelope fails the same way
 * in-process.
 *
 * @module session/adapters/evaluation/shared
 */

import { typedError } from '../_errors.js'
import { QUESTION_TYPES } from '#core/evaluation.js'

const QUESTION_KEYS = new Set(['type', 'instructions', 'criteria'])
const BINARY_CRITERIA_KEYS = ['yes', 'no']

/**
 * @param {import('#core/evaluation.js').EvaluateEnvelope} envelope
 * @param {any} spec
 */
export function checkEvaluation (envelope, spec) {
  const { state, questions } = envelope
  if (typeof state !== 'string' && !isObject(state) && !Array.isArray(state)) {
    throw invalid('state must be a string, an object or an array')
  }
  if (!isObject(questions) || Object.keys(questions).length === 0) {
    throw invalid('questions must be a non-empty object')
  }
  for (const [id, q] of Object.entries(questions)) {
    checkQuestion(id, q, spec)
  }
}

function checkQuestion (id, q, spec) {
  if (!isObject(q)) throw invalid(`question '${id}' must be an object`)
  const extra = Object.keys(q).filter(k => !QUESTION_KEYS.has(k))
  if (extra.length) throw invalid(`question '${id}' has unknown field '${extra.join("', '")}'`)
  if (!QUESTION_TYPES.includes(q.type)) {
    throw invalid(`question '${id}' type must be one of ${QUESTION_TYPES.join(', ')}`)
  }
  if (Array.isArray(spec?.evaluationTypes) && !spec.evaluationTypes.includes(q.type)) {
    throw typedError(
      `question '${id}' is '${q.type}', which this model does not answer; it answers ${spec.evaluationTypes.join(', ')}`,
      'EVALUATE_QUESTION_TYPE_UNSUPPORTED',
      false
    )
  }
  if (q.instructions === undefined || q.instructions === null) {
    throw invalid(`question '${id}' requires instructions`)
  }

  const c = q.criteria
  if (q.type === 'binary') {
    if (c === undefined) return
    if (!isObject(c) || Object.keys(c).length !== 2 || !BINARY_CRITERIA_KEYS.every(k => c[k] !== undefined && c[k] !== null)) {
      throw invalid(`question '${id}' criteria must have exactly 'yes' and 'no'`)
    }
  } else if (q.type === 'choice') {
    if (!isObject(c) || Object.keys(c).length < 2) {
      throw invalid(`question '${id}' criteria must name at least two options`)
    }
  } else if (!Array.isArray(c) || c.length < 2) {
    throw invalid(`question '${id}' criteria must list at least two levels`)
  }
}

/** @param {unknown} v */
function isObject (v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** @param {string} message */
function invalid (message) {
  return typedError(message, 'EVALUATE_INPUT_INVALID', false)
}
