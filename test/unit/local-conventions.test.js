import { describe, test, expect } from 'vitest'
import { parseLocalConventions, TEMPLATE } from '../../src/lib/local-conventions.js'
import { reviewEntry, reviewCatalog } from '../../src/lib/catalog-review.js'

const local = parseLocalConventions(JSON.stringify({
  fields: {
    perTurnBudget: { type: 'number', description: 'What one turn is allowed to consume.', measured: 'calibrate <model>' }
  },
  tags: {
    rotate: { description: 'Routes into rotation.', requires: ['perTurnBudget'] },
    soft: { description: 'Softer routing.', requires: ['perTurnBudget'], severity: 'warn' },
    plain: { description: 'Just a label.' }
  }
}))

const entry = (over = {}) => ({
  model: 'm', creator: 'anthropic', provider: 'anthropic', sdk: 'anthropic', label: 'M', inputFormat: ['text'], ...over
})

describe('parseLocalConventions', () => {
  test('the shipped template is valid', () => {
    expect(() => parseLocalConventions(TEMPLATE)).not.toThrow()
  })

  test('meta keys are allowed so the file can carry its own notes', () => {
    expect(() => parseLocalConventions('{"_comment":"hi","notes":"x"}')).not.toThrow()
  })

  test('an unknown top-level key is rejected', () => {
    expect(() => parseLocalConventions('{"feilds":{}}')).toThrow(/unknown key 'feilds'/)
  })

  test('redeclaring a mohdel field is rejected', () => {
    expect(() => parseLocalConventions(JSON.stringify({
      fields: { inputPrice: { type: 'number', description: 'x' } }
    }))).toThrow(/already a mohdel field/)
  })

  test('a rule requiring a field nobody declared is rejected', () => {
    expect(() => parseLocalConventions(JSON.stringify({
      tags: { rotate: { description: 'x', requires: ['turnTokenBse'] } }
    }))).toThrow(/neither a mohdel field nor declared/)
  })

  test('a rule may require a mohdel field', () => {
    expect(() => parseLocalConventions(JSON.stringify({
      tags: { rotate: { description: 'x', requires: ['outputTokenLimit'] } }
    }))).not.toThrow()
  })

  test('severity defaults to error', () => {
    expect(local.tags.rotate.severity).toBe('error')
    expect(local.tags.soft.severity).toBe('warn')
  })

  test('an invalid severity is rejected', () => {
    expect(() => parseLocalConventions(JSON.stringify({
      tags: { rotate: { description: 'x', severity: 'fatal' } }
    }))).toThrow(/severity must be one of/)
  })

  test('a field with no description is rejected', () => {
    expect(() => parseLocalConventions('{"fields":{"x":{"type":"number"}}}')).toThrow(/description is required/)
  })

  test('malformed JSON is rejected', () => {
    expect(() => parseLocalConventions('{')).toThrow(/not valid JSON/)
  })
})

describe('local rules in review', () => {
  test('a declared field is no longer unknown-field drift', () => {
    const spec = entry({ perTurnBudget: 20000 })
    expect(reviewEntry('anthropic/x', spec, {}, { strict: true }).warnings)
      .toContainEqual(expect.stringContaining('unknown field'))
    expect(reviewEntry('anthropic/x', spec, {}, { strict: true, local }).warnings).toEqual([])
  })

  test('a declared field is type-checked', () => {
    const { errors } = reviewEntry('anthropic/x', entry({ perTurnBudget: '20000' }), {}, { local })
    expect(errors).toEqual(['anthropic/x: perTurnBudget — expected number, got string (local field)'])
  })

  test('a tag without its required field is an error', () => {
    const { errors } = reviewEntry('anthropic/x', entry({ tags: ['rotate'] }), {}, { local })
    expect(errors).toEqual(["anthropic/x: tag 'rotate' requires perTurnBudget — Routes into rotation."])
  })

  test('a satisfied requirement reports nothing', () => {
    const { errors, warnings } = reviewEntry('anthropic/x', entry({ tags: ['rotate'], perTurnBudget: 1 }), {}, { local })
    expect({ errors, warnings }).toEqual({ errors: [], warnings: [] })
  })

  test('severity warn keeps the rule out of the error list', () => {
    const { errors, warnings } = reviewEntry('anthropic/x', entry({ tags: ['soft'] }), {}, { local })
    expect(errors).toEqual([])
    expect(warnings).toEqual(["anthropic/x: tag 'soft' requires perTurnBudget — Softer routing."])
  })

  test('a tag with no requirements is inert', () => {
    const { errors, warnings } = reviewEntry('anthropic/x', entry({ tags: ['plain'] }), {}, { local })
    expect({ errors, warnings }).toEqual({ errors: [], warnings: [] })
  })

  test('a deprecated stub is not held to tag rules', () => {
    const { errors } = reviewEntry('anthropic/old', { deprecated: 'anthropic/x' }, { 'anthropic/x': entry() }, { local })
    expect(errors).toEqual([])
  })

  test('without conventions the catalog reviews exactly as before', () => {
    const catalog = { 'anthropic/x': entry({ tags: ['rotate'] }) }
    expect(reviewCatalog(catalog).errors).toEqual([])
    expect(reviewCatalog(catalog, { local }).errors).toHaveLength(1)
  })
})
