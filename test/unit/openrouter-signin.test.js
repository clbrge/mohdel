import { test, expect } from 'vitest'
import { challengeOf } from '../../src/cli/openrouter-signin.js'

test('the S256 challenge of the RFC 7636 appendix B verifier is the published one', () => {
  expect(challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
})
