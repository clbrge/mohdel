/**
 * TypeSafe evaluation adapter (`POST /v1/systemone`). TypeSafe calls a binary
 * question `noul` and keys binary criteria `true` / `false`; score
 * probabilities come back keyed by level index as strings.
 *
 * @module session/adapters/evaluation/typesafe
 */

import { getSpec } from '../_catalog.js'
import { classifyProviderError, fromHttpStatus, typedError } from '../_errors.js'
import { evaluationCostFor } from '../_pricing.js'
import { catalogKey, bareOf } from '#core/model-id.js'
import { checkEvaluation } from './_shared.js'

const BASE_URL = 'https://api.typesafe.ai/v1'

export async function typesafeEvaluation (envelope, deps = {}) {
  const fetchFn = deps.fetch ?? globalThis.fetch
  const spec = deps.spec ?? getSpec(catalogKey(envelope.model)) ?? {}
  const start = String(process.hrtime.bigint())

  checkEvaluation(envelope, spec)

  const body = {
    model: spec.model ?? bareOf(envelope.model),
    state: envelope.state,
    questions: Object.fromEntries(
      Object.entries(envelope.questions).map(([id, q]) => [id, toQuestion(q)])
    )
  }

  let res
  try {
    res = await fetchFn(`${BASE_URL}/systemone`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${envelope.auth.key}`
      },
      body: JSON.stringify(body)
    })
  } catch (e) {
    throw typedError(classifyProviderError(e, envelope.auth?.key).message, 'NET_ERROR', true)
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw fromHttpStatus(res.status, 'evaluation request failed', detail.slice(0, 500), envelope.auth?.key)
  }

  const payload = await res.json()
  const usage = payload?.usage
  if (typeof payload?.model !== 'string' || !isCount(usage?.input_tokens) || !isCount(usage?.output_tokens)) {
    throw mismatch('response lacks model or token usage')
  }

  const answers = {}
  for (const [id, q] of Object.entries(envelope.questions)) {
    answers[id] = fromAnswer(id, q, payload.answers?.[id])
  }

  const inputTokens = usage.input_tokens
  const outputTokens = usage.output_tokens
  const end = String(process.hrtime.bigint())

  return {
    status: 'completed',
    answers,
    upstreamModel: payload.model,
    inputTokens,
    outputTokens,
    cost: evaluationCostFor(envelope, spec, { inputTokens, outputTokens }),
    timestamps: { start, first: end, end }
  }
}

function toQuestion (q) {
  if (q.type !== 'binary') return q
  const out = { type: 'noul', instructions: q.instructions }
  if (q.criteria) out.criteria = { true: q.criteria.yes, false: q.criteria.no }
  return out
}

function fromAnswer (id, q, a) {
  if (q.type === 'binary') {
    if (a?.type !== 'noul' || !isProbability(a.noul)) throw mismatch(`no binary answer for '${id}'`)
    return { type: 'binary', probability: a.noul }
  }
  if (a?.type !== q.type || !isProbability(a.confidence)) throw mismatch(`no ${q.type} answer for '${id}'`)

  if (q.type === 'choice') {
    const options = Object.keys(q.criteria)
    if (typeof a.choice !== 'string' || !options.includes(a.choice) ||
        !options.every(o => isProbability(a.probabilities?.[o]))) {
      throw mismatch(`malformed choice answer for '${id}'`)
    }
    const probabilities = Object.fromEntries(options.map(o => [o, a.probabilities[o]]))
    return { type: 'choice', choice: a.choice, probabilities, confidence: a.confidence }
  }

  const probabilities = q.criteria.map((_, i) => a.probabilities?.[String(i)])
  if (typeof a.score !== 'number' || !probabilities.every(isProbability)) {
    throw mismatch(`malformed score answer for '${id}'`)
  }
  return { type: 'score', score: a.score, probabilities, confidence: a.confidence }
}

function isProbability (v) {
  return typeof v === 'number' && v >= 0 && v <= 1
}

function isCount (v) {
  return Number.isInteger(v) && v >= 0
}

function mismatch (message) {
  return typedError(message, 'EVALUATE_RESULT_MISMATCH', false)
}
