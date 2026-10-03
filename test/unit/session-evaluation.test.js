import { describe, test, expect, vi, afterEach } from 'vitest'
import { runEvaluation } from '../../js/session/run_evaluation.js'
import { run } from '../../js/session/run.js'
import { setCatalog } from '../../js/session/adapters/_catalog.js'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const MODEL = 'typesafe/fixture-evaluator'
const spec = { model: 'fixture-upstream', inputPrice: 0.042, outputPrice: 0 }

const envelope = (questions, extra = {}) => ({
  callId: 'c1', authId: 'a1', auth: { key: 'sk-x' }, model: MODEL, state: 'payouts failing for 3 days', questions, ...extra
})
const answering = (json) => {
  const calls = []
  globalThis.fetch = vi.fn(async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers })
    return { ok: true, status: 200, json: async () => json }
  })
  return calls
}
const failing = (status, body) => {
  globalThis.fetch = vi.fn(async () => ({ ok: false, status, text: async () => body }))
}
const usage = { input_tokens: 1_000_000, output_tokens: 30 }

const ALL = {
  urgent: { type: 'binary', instructions: 'Urgent?', criteria: { yes: 'time-sensitive', no: 'not urgent' } },
  team: { type: 'choice', instructions: 'Which team?', criteria: { technical: 'bugs', billing: 'payments', other: null } },
  anger: { type: 'score', instructions: 'How angry?', criteria: ['calm', 'frustrated', 'furious'] }
}
const ALL_ANSWERS = {
  urgent: { type: 'noul', noul: 0.95 },
  team: { type: 'choice', choice: 'billing', probabilities: { billing: 0.88, other: 0, technical: 0.12 }, confidence: 0.81 },
  anger: { type: 'score', score: 1.05, legend: { 0: 'calm', 1: 'frustrated', 2: 'furious' }, probabilities: { 0: 0, 1: 0.95, 2: 0.05 }, confidence: 0.92 }
}

describe('typesafe request', () => {
  test('sends the entry model, the state and TypeSafe question names', async () => {
    const calls = answering({ model: 'fixture-1.0', answers: ALL_ANSWERS, usage })
    await runEvaluation(envelope(ALL), { spec })
    expect(calls[0].url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(calls[0].body.model).toBe('fixture-upstream')
    expect(calls[0].body.state).toBe('payouts failing for 3 days')
    expect(calls[0].body.questions.urgent).toEqual({
      type: 'noul', instructions: 'Urgent?', criteria: { true: 'time-sensitive', false: 'not urgent' }
    })
    expect(calls[0].body.questions.team).toEqual(ALL.team)
    expect(calls[0].body.questions.anger).toEqual(ALL.anger)
  })

  test('a binary question without criteria sends none', async () => {
    const calls = answering({ model: 'fixture-1.0', answers: { urgent: ALL_ANSWERS.urgent }, usage })
    await runEvaluation(envelope({ urgent: { type: 'binary', instructions: 'Urgent?' } }), { spec })
    expect(calls[0].body.questions.urgent).toEqual({ type: 'noul', instructions: 'Urgent?' })
  })

  test('the key travels as a bearer header', async () => {
    const calls = answering({ model: 'fixture-1.0', answers: ALL_ANSWERS, usage })
    await runEvaluation(envelope(ALL), { spec })
    expect(calls[0].headers.Authorization).toBe('Bearer sk-x')
  })
})

describe('typesafe result', () => {
  test('translates every answer to mohdel shapes, probabilities in criteria order', async () => {
    answering({ model: 'fixture-1.0', answers: ALL_ANSWERS, usage })
    const r = await runEvaluation(envelope(ALL), { spec })
    expect(r.ok).toBe(true)
    expect(r.result.answers.urgent).toEqual({ type: 'binary', probability: 0.95 })
    expect(r.result.answers.team).toEqual({
      type: 'choice', choice: 'billing', probabilities: { technical: 0.12, billing: 0.88, other: 0 }, confidence: 0.81
    })
    expect(Object.keys(r.result.answers.team.probabilities)).toEqual(['technical', 'billing', 'other'])
    expect(r.result.answers.anger).toEqual({ type: 'score', score: 1.05, probabilities: [0, 0.95, 0.05], confidence: 0.92 })
    expect(r.result.upstreamModel).toBe('fixture-1.0')
    expect(r.result.status).toBe('completed')
  })

  test('prices input tokens from inputPrice; free output costs nothing', async () => {
    answering({ model: 'fixture-1.0', answers: ALL_ANSWERS, usage })
    const r = await runEvaluation(envelope(ALL), { spec })
    expect(r.result.inputTokens).toBe(1_000_000)
    expect(r.result.outputTokens).toBe(30)
    expect(r.result.cost).toBe(0.042)
  })

  test('a missing answer is a mismatch, not a partial result', async () => {
    answering({ model: 'fixture-1.0', answers: { urgent: ALL_ANSWERS.urgent }, usage })
    const r = await runEvaluation(envelope(ALL), { spec })
    expect(r.ok).toBe(false)
    expect(r.error.type).toBe('EVALUATE_RESULT_MISMATCH')
  })

  test('an answer of the wrong type is a mismatch', async () => {
    answering({ model: 'fixture-1.0', answers: { ...ALL_ANSWERS, team: ALL_ANSWERS.anger }, usage })
    const r = await runEvaluation(envelope(ALL), { spec })
    expect(r.error.type).toBe('EVALUATE_RESULT_MISMATCH')
  })

  test('missing token usage is a mismatch rather than a zero cost', async () => {
    answering({ model: 'fixture-1.0', answers: ALL_ANSWERS })
    const r = await runEvaluation(envelope(ALL), { spec })
    expect(r.error.type).toBe('EVALUATE_RESULT_MISMATCH')
  })
})

describe('typesafe HTTP errors', () => {
  test('422 is a non-retryable provider error carrying the body, never the key', async () => {
    failing(422, '{"detail":"questions.team.criteria: too many options"}')
    const r = await runEvaluation(envelope(ALL), { spec })
    expect(r.error.type).toBe('PROVIDER_ERROR')
    expect(r.error.retryable).toBe(false)
    expect(r.error.detail).toContain('too many options')
    expect(r.error.detail).not.toContain('sk-x')
  })

  test('429 and 529 are retryable', async () => {
    failing(429, 'slow down')
    expect((await runEvaluation(envelope(ALL), { spec })).error.retryable).toBe(true)
    failing(529, 'overloaded')
    const r = await runEvaluation(envelope(ALL), { spec })
    expect(r.error.type).toBe('PROVIDER_UNAVAILABLE')
    expect(r.error.retryable).toBe(true)
  })
})

describe('question checks run before dispatch', () => {
  const rejects = async (questions, type = 'EVALUATE_INPUT_INVALID', extra = {}, s = spec) => {
    globalThis.fetch = vi.fn()
    const r = await runEvaluation(envelope(questions, extra), { spec: s })
    expect(r.ok).toBe(false)
    expect(r.error.type).toBe(type)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  }

  test('no questions', () => rejects({}))
  test('unknown question type', () => rejects({ q: { type: 'rank', instructions: 'x', criteria: ['a', 'b'] } }))
  test('unknown question field', () => rejects({ q: { type: 'binary', instructions: 'x', weight: 2 } }))
  test('missing instructions', () => rejects({ q: { type: 'binary' } }))
  test('binary criteria other than yes and no', () => rejects({ q: { type: 'binary', instructions: 'x', criteria: { true: 'a', false: 'b' } } }))
  test('a choice of one option', () => rejects({ q: { type: 'choice', instructions: 'x', criteria: { only: null } } }))
  test('a score of one level', () => rejects({ q: { type: 'score', instructions: 'x', criteria: ['only'] } }))
  test('a state that is neither text nor JSON structure', () => rejects(ALL, 'EVALUATE_INPUT_INVALID', { state: 42 }))
  test('a type the entry does not declare', () =>
    rejects({ q: ALL.anger }, 'EVALUATE_QUESTION_TYPE_UNSUPPORTED', {}, { ...spec, evaluationTypes: ['binary', 'choice'] }))
})

describe('routing', () => {
  test('a provider without an evaluation adapter is unknown', async () => {
    const r = await runEvaluation({ ...envelope(ALL), model: 'echo/m' })
    expect(r.error.type).toBe('SESSION_UNKNOWN_PROVIDER')
  })

  test('answer() on an evaluation-only provider points to evaluate()', async () => {
    setCatalog({ [MODEL]: spec })
    const events = []
    for await (const ev of run({ callId: 'c1', authId: 'a1', auth: { key: 'k' }, model: MODEL, prompt: 'hi' })) events.push(ev)
    expect(events).toHaveLength(1)
    expect(events[0].error.type).toBe('PROVIDER_TEXT_NOT_SUPPORTED')
    expect(events[0].error.message).toContain('evaluate(')
  })
})

test('a key echoed in an error body is masked', async () => {
  const key = 'sk-live-0123456789abcdef'
  failing(401, `invalid api key ${key}`)
  const r = await runEvaluation(envelope(ALL, { auth: { key } }), { spec })
  expect(r.error.type).toBe('AUTH_INVALID')
  expect(r.error.detail).toContain('invalid api key')
  expect(r.error.detail).not.toContain(key)
})
