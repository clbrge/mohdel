import { describe, test, expect } from 'vitest'

import { sanitizeHeader } from '../../js/session/adapters/openrouter.js'

// F47: `HTTP-Referer` and `X-Title` are env-sourced. Node rejects
// CRLF in header values at send time (throws TypeError), but that
// failure mode is "adapter crashes" not "adapter works safely."
// Strip CRLF before passing to the SDK.

describe('openrouter sanitizeHeader (F47)', () => {
  test('passes through a clean value unchanged', () => {
    expect(sanitizeHeader('https://example.com')).toBe('https://example.com')
  })

  test('strips CR', () => {
    expect(sanitizeHeader('evil\rcontinued')).toBe('evilcontinued')
  })

  test('strips LF', () => {
    expect(sanitizeHeader('evil\ncontinued')).toBe('evilcontinued')
  })

  test('strips CRLF header-injection attempt', () => {
    const injected = 'https://example.com\r\nInjected-Header: yes'
    expect(sanitizeHeader(injected)).toBe('https://example.comInjected-Header: yes')
  })

  test('coerces non-string values to string', () => {
    expect(sanitizeHeader(42)).toBe('42')
  })
})
