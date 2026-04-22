import { describe, test, expect } from 'vitest'
import { EVENT_TYPES, isEvent } from '#core/events.js'

describe('core/events', () => {
  test('EVENT_TYPES is frozen with 3 variants', () => {
    expect(Object.isFrozen(EVENT_TYPES)).toBe(true)
    expect([...EVENT_TYPES].sort()).toEqual(['delta', 'done', 'error'])
  })

  test('isEvent accepts the three variant types', () => {
    for (const type of EVENT_TYPES) {
      expect(isEvent({ type })).toBe(true)
    }
  })

  test('isEvent rejects non-events', () => {
    expect(isEvent(null)).toBe(false)
    expect(isEvent(undefined)).toBe(false)
    expect(isEvent({})).toBe(false)
    expect(isEvent({ type: 'nonsense' })).toBe(false)
    expect(isEvent({ type: 'call.start' })).toBe(false) // old-shape event, no longer valid
    expect(isEvent('string')).toBe(false)
    expect(isEvent(42)).toBe(false)
  })
})
