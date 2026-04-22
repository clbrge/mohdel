import { describe, test, expect } from 'vitest'
import {
  STATUS_COMPLETED,
  STATUS_TOOL_USE,
  STATUS_INCOMPLETE,
  STATUSES,
  WARNING_INSUFFICIENT_OUTPUT_BUDGET,
  WARNING_CANCELLED,
  isStatus
} from '#core/status.js'

describe('core/status', () => {
  test('three canonical status values', () => {
    expect(STATUS_COMPLETED).toBe('completed')
    expect(STATUS_TOOL_USE).toBe('tool_use')
    expect(STATUS_INCOMPLETE).toBe('incomplete')
    expect(Object.isFrozen(STATUSES)).toBe(true)
  })

  test('warning constants', () => {
    expect(WARNING_INSUFFICIENT_OUTPUT_BUDGET).toBe('insufficientOutputBudget')
    expect(WARNING_CANCELLED).toBe('cancelled')
  })

  test('isStatus', () => {
    expect(isStatus('completed')).toBe(true)
    expect(isStatus('tool_use')).toBe(true)
    expect(isStatus('incomplete')).toBe(true)
    expect(isStatus('done')).toBe(false)
    expect(isStatus(null)).toBe(false)
  })
})
