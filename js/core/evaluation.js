/**
 * Evaluation envelope and result: one `state`, a map of typed questions, one
 * typed answer per question.
 *
 * @module core/evaluation
 */

/**
 * @typedef {object} EvaluateEnvelope
 * @property {string} callId
 * @property {string} authId
 * @property {import('./envelope.js').Auth} auth
 * @property {string} [traceparent]
 * @property {string} [baggage]
 * @property {string} model
 * @property {string | object | any[]} state
 * @property {Record<string, Question>} questions
 *   Answers come back under the same ids.
 */

/**
 * @typedef {BinaryQuestion | ChoiceQuestion | ScoreQuestion} Question
 *
 * `instructions` and every criterion description may be a string, an object
 * or an array.
 */

/**
 * @typedef {object} BinaryQuestion
 * @property {'binary'} type
 * @property {any} instructions
 * @property {{yes: any, no: any}} [criteria]
 */

/**
 * @typedef {object} ChoiceQuestion
 * @property {'choice'} type
 * @property {any} instructions
 * @property {Record<string, any>} criteria
 *   Option name to its description, or null. At least two options.
 */

/**
 * @typedef {object} ScoreQuestion
 * @property {'score'} type
 * @property {any} instructions
 * @property {any[]} criteria
 *   Level descriptions, lowest first; level `i` is worth `i`. At least two.
 */

/**
 * @typedef {BinaryAnswer | ChoiceAnswer | ScoreAnswer} Answer
 */

/**
 * @typedef {object} BinaryAnswer
 * @property {'binary'} type
 * @property {number} probability
 *   Of yes.
 */

/**
 * @typedef {object} ChoiceAnswer
 * @property {'choice'} type
 * @property {string} choice
 * @property {Record<string, number>} probabilities
 * @property {number} [confidence]
 *   Absent when the provider reports none.
 */

/**
 * @typedef {object} ScoreAnswer
 * @property {'score'} type
 * @property {number} score
 *   Probability-weighted level; can fall between two.
 * @property {number[]} probabilities
 *   One per level, in `criteria` order.
 * @property {number} [confidence]
 */

/**
 * @typedef {object} EvaluateResult
 * @property {'completed'} status
 * @property {Record<string, Answer>} answers
 * @property {string} upstreamModel
 *   The provider's id for the version that answered, which differs from the
 *   entry's `model` when that is an alias.
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cost
 * @property {{start: string, first: string, end: string}} timestamps
 */

export const EVALUATE_ENVELOPE_FIELDS = Object.freeze([
  'callId',
  'authId',
  'auth',
  'traceparent',
  'baggage',
  'model',
  'state',
  'questions'
])

export const QUESTION_TYPES = Object.freeze(['binary', 'choice', 'score'])
