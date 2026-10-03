/**
 * Live evaluation smoke test, against the catalog's own entry. Skipped
 * without `TYPESAFE_API_SK` or without the entry.
 *
 *   TYPESAFE_API_SK=... npx vitest run test/live/evaluations.live.test.js
 */
import { describe, test, expect } from 'vitest'
import { runEvaluation } from '../../js/session/run_evaluation.js'
import providers from '../../src/lib/providers.js'
import { getCuratedModels, loadDefaultEnv } from '../../src/lib/common.js'

loadDefaultEnv()

const MODEL = 'typesafe/jev-1.13.0'
const spec = (await getCuratedModels())[MODEL]
const key = process.env[providers.typesafe.apiKeyEnv]

const QUESTIONS = {
  urgent: { type: 'binary', instructions: 'Does `body` convey urgency?' },
  team: {
    type: 'choice',
    instructions: 'Which team should handle `body`?',
    criteria: { billing: 'Payments, invoicing, refunds', technical: 'Bugs, outages, integrations', other: null }
  },
  anger: { type: 'score', instructions: 'How frustrated is the customer?', criteria: ['Calm', 'Frustrated', 'Very angry'] }
}

describe.skipIf(!key || !spec)('live evaluation: typesafe', () => {
  test('answers all three question types and prices the call', async () => {
    const out = await runEvaluation({
      callId: `live-${Date.now()}`,
      authId: 'live',
      auth: { key },
      model: MODEL,
      state: { subject: 'Payouts', body: 'Help! My payouts have been failing for 3 days and I am losing sales.' },
      questions: QUESTIONS
    }, { spec })

    expect(out.ok, JSON.stringify(out.error)).toBe(true)
    const { answers } = out.result
    expect(answers.urgent.type).toBe('binary')
    expect(answers.urgent.probability).toBeGreaterThan(0.5)
    expect(answers.team.choice).toBe('billing')
    expect(Object.keys(answers.team.probabilities)).toEqual(['billing', 'technical', 'other'])
    expect(answers.anger.probabilities).toHaveLength(3)
    expect(out.result.upstreamModel).toBe(spec.model)
    expect(out.result.inputTokens).toBeGreaterThan(0)
    expect(out.result.cost).toBeCloseTo(out.result.inputTokens * spec.inputPrice / 1e6, 12)
  })

  test('the provider rejects what mohdel lets through as a typed error', async () => {
    const out = await runEvaluation({
      callId: `live-${Date.now()}`,
      authId: 'live',
      auth: { key },
      model: MODEL,
      state: 'x',
      questions: { q: { type: 'score', instructions: 'Rate it', criteria: Array.from({ length: 11 }, (_, i) => `level ${i}`) } }
    }, { spec })

    expect(out.ok).toBe(false)
    expect(out.error.type).toBe('PROVIDER_ERROR')
    expect(out.error.detail).not.toContain(key)
  })
})
