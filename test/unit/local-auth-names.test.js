import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { describe, test, expect } from 'vitest'

import providers from '../../src/lib/providers.js'

const ROOT = join(import.meta.dirname, '..', '..')
const LOCAL_AUTH_RS = readFileSync(join(ROOT, 'rust', 'thin-gate', 'src', 'hooks', 'local_auth.rs'), 'utf8')

const rustTable = (name) => {
  const decl = LOCAL_AUTH_RS.match(new RegExp(`const ${name}: &\\[\\(&str, &str\\)\\] = &\\[([^\\]]*)\\];`))
  if (!decl) throw new Error(`${name} not found in local_auth.rs`)
  return Object.fromEntries([...decl[1].matchAll(/\("([^"]+)",\s*"([^"]+)"\)/g)].map(m => [m[1], m[2]]))
}

const jsTable = (field) => Object.fromEntries(
  Object.entries(providers).filter(([, def]) => def[field]).map(([name, def]) => [name, def[field]])
)

describe('LocalAuth key variable names', () => {
  test('KEY_ENV matches apiKeyEnv for every provider', () => {
    expect(rustTable('KEY_ENV')).toEqual(jsTable('apiKeyEnv'))
  })

  test('OPTIONAL_KEY_ENV matches optionalApiKeyEnv for every provider', () => {
    expect(rustTable('OPTIONAL_KEY_ENV')).toEqual(jsTable('optionalApiKeyEnv'))
  })
})

describe('mohdel environment file format', () => {
  test('the shared fixture parses to the expected keys in Node', () => {
    const fixture = readFileSync(join(ROOT, 'test', 'conformance', 'env-file.env'), 'utf8')
    const expected = JSON.parse(readFileSync(join(ROOT, 'test', 'conformance', 'env-file.expected.json'), 'utf8'))
    expect(parseEnv(fixture)).toEqual(expected)
  })

  test('CRLF lines parse as LF', () => {
    expect(parseEnv('A=a\r\nB="b"\r\n')).toEqual({ A: 'a', B: 'b' })
  })
})
