import { describe, test, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

import { isEvent } from '#core'
import { ENVELOPE_FIELDS } from '#core/envelope.js'
import { IMAGE_ENVELOPE_FIELDS } from '#core/image.js'
import { TRANSCRIPTION_ENVELOPE_FIELDS } from '#core/transcription.js'

const here = path.dirname(url.fileURLToPath(import.meta.url))
const fixturesDir = path.join(here, '..', 'conformance')

// ---------- Known-field allowlists (frozen in 0.90) ----------
//
// These mirror the Rust `#[serde(deny_unknown_fields)]` attributes in
// `rust/thin-gate/src/protocol.rs`. Keep them in sync when the frozen
// shape evolves.

const ENVELOPE_ALLOWED = new Set(ENVELOPE_FIELDS)
const AUTH_ALLOWED = new Set(['key', 'baseUrl'])
const MEDIA_ALLOWED = new Set(['fileUri', 'mimeType'])
const TOOL_SPEC_ALLOWED = new Set(['name', 'description', 'parameters'])
const MESSAGE_ALLOWED = new Set(['role', 'content', 'toolCallId', 'toolName', 'toolCalls'])
const MESSAGE_PART_ALLOWED = new Set(['type', 'text', 'cache'])

const EVENT_ALLOWED = new Set(['type', 'delta', 'result', 'error', 'sinceMs'])
const DELTA_CHUNK_ALLOWED = new Set(['type', 'delta'])
const ANSWER_RESULT_ALLOWED = new Set([
  'status', 'output', 'inputTokens', 'outputTokens', 'thinkingTokens',
  'cacheWriteInputTokens', 'cacheWrite1hInputTokens', 'cacheReadInputTokens',
  'cost', 'timestamps', 'warning', 'toolCalls', 'maxInterFrameMs', 'reasoning',
  'speed', 'servedSpeed'
])
const TIMESTAMPS_ALLOWED = new Set(['start', 'first', 'end'])
const TOOL_CALL_ALLOWED = new Set(['id', 'name', 'arguments', 'thoughtSignature'])
const TYPED_ERROR_ALLOWED = new Set([
  'message', 'detail', 'severity', 'retryable', 'type'
])

function loadFixture (name) {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), 'utf8'))
}

/**
 * Asserts `obj` has only keys from `allowed`. Throws with the
 * offending key names on the first violation.
 *
 * @param {object} obj
 * @param {Set<string>} allowed
 * @param {string} path
 */
function assertOnlyKnownKeys (obj, allowed, path = '') {
  if (obj == null || typeof obj !== 'object') return
  const unknown = Object.keys(obj).filter(k => !allowed.has(k))
  if (unknown.length > 0) {
    throw new Error(`${path || '<root>'} has unknown keys: ${unknown.join(', ')}`)
  }
}

// ---------- Envelope fixtures ----------

describe('conformance envelopes (JS side)', () => {
  const envelopes = loadFixture('envelopes.json')

  test('fixture file is non-empty', () => {
    expect(Object.keys(envelopes).length).toBeGreaterThan(0)
  })

  for (const [name, env] of Object.entries(envelopes)) {
    test(`has required envelope fields: ${name}`, () => {
      for (const required of ['callId', 'authId', 'auth', 'model', 'prompt']) {
        expect(env).toHaveProperty(required)
      }
      expect(env.auth).toHaveProperty('key')
      expect(env.model).toMatch(/^[^/]+\/.+/)
    })

    test(`only contains frozen-type fields (envelope + nested): ${name}`, () => {
      assertOnlyKnownKeys(env, ENVELOPE_ALLOWED, 'envelope')
      assertOnlyKnownKeys(env.auth, AUTH_ALLOWED, 'auth')
      for (const ref of env.images ?? []) {
        assertOnlyKnownKeys(ref, MEDIA_ALLOWED, 'image')
      }
      for (const ref of env.videos ?? []) {
        assertOnlyKnownKeys(ref, MEDIA_ALLOWED, 'video')
      }
      for (const tool of env.tools ?? []) {
        assertOnlyKnownKeys(tool, TOOL_SPEC_ALLOWED, 'tool')
      }
      if (Array.isArray(env.prompt)) {
        for (const m of env.prompt) {
          assertOnlyKnownKeys(m, MESSAGE_ALLOWED, 'message')
          if (Array.isArray(m.content)) {
            for (const p of m.content) {
              assertOnlyKnownKeys(p, MESSAGE_PART_ALLOWED, 'messagePart')
            }
          }
          for (const tc of m.toolCalls ?? []) {
            assertOnlyKnownKeys(tc, TOOL_CALL_ALLOWED, 'toolCall')
          }
        }
      }
    })

    test(`round-trips JSON.stringify/parse: ${name}`, () => {
      const reparsed = JSON.parse(JSON.stringify(env))
      expect(reparsed).toEqual(env)
    })
  }
})

// ---------- Event fixtures ----------

describe('conformance events (JS side)', () => {
  const events = loadFixture('events.json')

  test('all fixture events pass isEvent', () => {
    for (const [name, ev] of Object.entries(events)) {
      expect(isEvent(ev), `${name}`).toBe(true)
    }
  })

  test('covers delta, idle, done (completed/incomplete/tool_use), error', () => {
    const values = Object.values(events)
    expect(values.some(e => e.type === 'delta')).toBe(true)
    expect(values.some(e => e.type === 'idle')).toBe(true)
    expect(values.some(e => e.type === 'done' && e.result.status === 'completed')).toBe(true)
    expect(values.some(e => e.type === 'done' && e.result.status === 'incomplete')).toBe(true)
    expect(values.some(e => e.type === 'done' && e.result.status === 'tool_use')).toBe(true)
    expect(values.some(e => e.type === 'error')).toBe(true)
  })

  // Delta fast-path in thin-gate scans `{"type":"delta"` prefix.
  // Every event fixture MUST serialize with `type` as its first key.
  test('every event serializes with `type` as the first JSON key', () => {
    for (const [name, ev] of Object.entries(events)) {
      const serialized = JSON.stringify(ev)
      expect(serialized.startsWith(`{"type":"${ev.type}"`), `event '${name}'`).toBe(true)
    }
  })

  for (const [name, ev] of Object.entries(events)) {
    test(`only contains frozen-type fields: ${name}`, () => {
      assertOnlyKnownKeys(ev, EVENT_ALLOWED, 'event')
      if (ev.type === 'delta') {
        assertOnlyKnownKeys(ev.delta, DELTA_CHUNK_ALLOWED, 'delta')
      } else if (ev.type === 'done') {
        assertOnlyKnownKeys(ev.result, ANSWER_RESULT_ALLOWED, 'result')
        assertOnlyKnownKeys(ev.result.timestamps, TIMESTAMPS_ALLOWED, 'timestamps')
        for (const tc of ev.result.toolCalls ?? []) {
          assertOnlyKnownKeys(tc, TOOL_CALL_ALLOWED, 'toolCall')
        }
      } else if (ev.type === 'error') {
        assertOnlyKnownKeys(ev.error, TYPED_ERROR_ALLOWED, 'error')
      }
    })

    test(`round-trips JSON.stringify/parse: ${name}`, () => {
      expect(JSON.parse(JSON.stringify(ev))).toEqual(ev)
    })
  }
})

// ---------- Image fixtures ----------

const IMAGE_ENVELOPE_ALLOWED = new Set(IMAGE_ENVELOPE_FIELDS)
const IMAGE_RESULT_ALLOWED = new Set(['status', 'images', 'seed', 'timestamps'])
const IMAGE_DATA_ALLOWED = new Set(['mimeType', 'url', 'base64'])

describe('conformance images (JS side)', () => {
  const fixtures = loadFixture('images.json')

  test('fixture file is non-empty and covers envelope + result shapes', () => {
    const names = Object.keys(fixtures)
    expect(names.some(n => n.startsWith('envelope-'))).toBe(true)
    expect(names.some(n => n.startsWith('result-'))).toBe(true)
  })

  for (const [name, fx] of Object.entries(fixtures)) {
    if (name.startsWith('envelope-')) {
      test(`image envelope has required fields: ${name}`, () => {
        for (const required of ['callId', 'authId', 'auth', 'model', 'prompt']) {
          expect(fx).toHaveProperty(required)
        }
        expect(fx.model).toMatch(/^[^/]+\/.+/)
      })

      test(`image envelope only contains frozen-type fields: ${name}`, () => {
        assertOnlyKnownKeys(fx, IMAGE_ENVELOPE_ALLOWED, 'imageEnvelope')
        assertOnlyKnownKeys(fx.auth, AUTH_ALLOWED, 'auth')
      })
    } else if (name.startsWith('result-')) {
      test(`image result only contains frozen-type fields: ${name}`, () => {
        assertOnlyKnownKeys(fx, IMAGE_RESULT_ALLOWED, 'imageResult')
        assertOnlyKnownKeys(fx.timestamps, TIMESTAMPS_ALLOWED, 'timestamps')
        for (const img of fx.images ?? []) {
          assertOnlyKnownKeys(img, IMAGE_DATA_ALLOWED, 'imageData')
        }
      })
    }

    test(`round-trips JSON.stringify/parse: ${name}`, () => {
      expect(JSON.parse(JSON.stringify(fx))).toEqual(fx)
    })
  }
})

// ---------- Transcription fixtures ----------

const TRANSCRIPTION_ENVELOPE_ALLOWED = new Set(TRANSCRIPTION_ENVELOPE_FIELDS)
const TRANSCRIPTION_RESULT_ALLOWED = new Set([
  'status', 'text', 'language', 'durationSeconds',
  'inputTokens', 'outputTokens', 'cost', 'timestamps'
])

describe('conformance transcriptions (JS side)', () => {
  const fixtures = loadFixture('transcriptions.json')

  test('fixture file is non-empty and covers envelope + result shapes', () => {
    const names = Object.keys(fixtures)
    expect(names.some(n => n.startsWith('envelope-'))).toBe(true)
    expect(names.some(n => n.startsWith('result-'))).toBe(true)
  })

  for (const [name, fx] of Object.entries(fixtures)) {
    if (name.startsWith('envelope-')) {
      test(`transcription envelope has required fields: ${name}`, () => {
        for (const required of ['callId', 'authId', 'auth', 'model', 'audio']) {
          expect(fx).toHaveProperty(required)
        }
        expect(fx.model).toMatch(/^[^/]+\/.+/)
        expect(fx.audio.fileUri).toMatch(/^(file:\/\/|data:)/)
      })

      test(`transcription envelope only contains frozen-type fields: ${name}`, () => {
        assertOnlyKnownKeys(fx, TRANSCRIPTION_ENVELOPE_ALLOWED, 'transcriptionEnvelope')
        assertOnlyKnownKeys(fx.auth, AUTH_ALLOWED, 'auth')
        assertOnlyKnownKeys(fx.audio, MEDIA_ALLOWED, 'audio')
      })
    } else if (name.startsWith('result-')) {
      test(`transcription result only contains frozen-type fields: ${name}`, () => {
        assertOnlyKnownKeys(fx, TRANSCRIPTION_RESULT_ALLOWED, 'transcriptionResult')
        assertOnlyKnownKeys(fx.timestamps, TIMESTAMPS_ALLOWED, 'timestamps')
      })
    }

    test(`round-trips JSON.stringify/parse: ${name}`, () => {
      expect(JSON.parse(JSON.stringify(fx))).toEqual(fx)
    })
  }
})

// ---------- Tripwire: unknown-field rejection parity with Rust ----------
//
// The JS side doesn't have a strict typed parser, but this
// allowlist-checker is how we enforce the same invariant from
// callers that build envelopes. Injecting a new field into a
// fixture should fail the "only contains frozen-type fields" test
// above. Document that here so a future contributor doesn't silently
// loosen the allowlists.

describe('unknown-field parity', () => {
  test('assertOnlyKnownKeys flags a rogue envelope key', () => {
    const rogue = {
      callId: 'c',
      authId: 'a',
      auth: { key: 'k' },
      model: 'echo/m',
      prompt: 'hi',
      futureField: 42
    }
    expect(() => assertOnlyKnownKeys(rogue, ENVELOPE_ALLOWED, 'envelope'))
      .toThrow(/futureField/)
  })

  test('assertOnlyKnownKeys flags a rogue result key', () => {
    const rogue = {
      status: 'completed',
      output: null,
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      cost: 0,
      timestamps: { start: '0', first: '0', end: '0' },
      ghostField: 'x'
    }
    expect(() => assertOnlyKnownKeys(rogue, ANSWER_RESULT_ALLOWED, 'result'))
      .toThrow(/ghostField/)
  })
})

// ---------- Field-name parity: JS allowlists <-> Rust protocol ----------
//
// The allowlists above are a hand-maintained mirror of the
// `#[serde(deny_unknown_fields)]` structs in
// `rust/thin-gate/src/protocol.rs`. When the two drift, the JS side
// stops catching a field the gate will reject (or vice versa) and the
// mismatch only surfaces as a terminal "non-Event line" in production.
// This block reparses the Rust source and asserts each allowlist is
// exactly the set of wire keys its struct accepts, so a drift fails
// here — before release — instead of in the field.

const protocolSrc = fs.readFileSync(
  path.join(here, '..', '..', 'rust', 'thin-gate', 'src', 'protocol.rs'),
  'utf8'
)

function stripRustComments (src) {
  return src.split('\n').map(line => {
    if (line.trim().startsWith('//')) return ''
    const i = line.indexOf(' //')
    return i >= 0 ? line.slice(0, i) : line
  }).join('\n')
}

function toCamel (s) {
  return s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())
}

function wireName (rustName, attrText, renameAll) {
  const explicit = (attrText.match(/rename\s*=\s*"([^"]+)"/) || [])[1]
  if (explicit) return explicit
  const bare = rustName.replace(/^r#/, '')
  return renameAll === 'camelCase' ? toCamel(bare) : bare
}

function braceBody (src, declIdx) {
  const open = src.indexOf('{', declIdx)
  let depth = 0
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++
    else if (src[k] === '}' && --depth === 0) return src.slice(open + 1, k)
  }
  throw new Error('unbalanced braces')
}

function structKeys (body, renameAll) {
  const keys = new Set()
  const re = /((?:#\[[\s\S]*?\]\s*)*)pub\s+((?:r#)?\w+)\s*:/g
  let m
  while ((m = re.exec(body))) keys.add(wireName(m[2], m[1], renameAll))
  return keys
}

function enumKeys (body, containerAttr) {
  const keys = new Set()
  const tag = (containerAttr.match(/tag\s*=\s*"([^"]+)"/) || [])[1]
  if (tag) keys.add(tag)
  const re = /((?:#\[[\s\S]*?\]\s*)*)((?:r#)?\w+)\s*:/g
  let m
  while ((m = re.exec(body))) keys.add(wireName(m[2], m[1], null))
  return keys
}

function parseProtocol (src) {
  const clean = stripRustComments(src)
  const lines = clean.split('\n')
  const items = {}
  let attrs = []
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t === '') continue
    if (t.startsWith('#[')) { attrs.push(t); continue }
    const m = t.match(/^pub (struct|enum) (\w+)/)
    if (m) {
      const [, kind, name] = m
      const attrText = attrs.join(' ')
      const declIdx = clean.indexOf(lines[i])
      const body = braceBody(clean, declIdx)
      const renameAll = (attrText.match(/rename_all\s*=\s*"([^"]+)"/) || [])[1]
      items[name] = {
        deny: attrText.includes('deny_unknown_fields'),
        keys: kind === 'struct' ? structKeys(body, renameAll) : enumKeys(body, attrText)
      }
    }
    attrs = []
  }
  return items
}

describe('field-name parity: JS allowlists <-> Rust protocol', () => {
  const rust = parseProtocol(protocolSrc)

  const MAP = {
    CallEnvelope: ENVELOPE_ALLOWED,
    Auth: AUTH_ALLOWED,
    MediaRef: MEDIA_ALLOWED,
    ToolSpec: TOOL_SPEC_ALLOWED,
    Message: MESSAGE_ALLOWED,
    Event: EVENT_ALLOWED,
    DeltaChunk: DELTA_CHUNK_ALLOWED,
    AnswerResult: ANSWER_RESULT_ALLOWED,
    Timestamps: TIMESTAMPS_ALLOWED,
    ToolCall: TOOL_CALL_ALLOWED,
    TypedError: TYPED_ERROR_ALLOWED,
    ImageEnvelope: IMAGE_ENVELOPE_ALLOWED,
    ImageResult: IMAGE_RESULT_ALLOWED,
    ImageData: IMAGE_DATA_ALLOWED,
    TranscriptionEnvelope: TRANSCRIPTION_ENVELOPE_ALLOWED,
    TranscriptionResult: TRANSCRIPTION_RESULT_ALLOWED
  }

  for (const [rustType, jsAllowed] of Object.entries(MAP)) {
    test(`${rustType} wire fields match JS allowlist`, () => {
      const item = rust[rustType]
      expect(item, `${rustType} not found in protocol.rs`).toBeDefined()
      expect(item.deny, `${rustType} is not deny_unknown_fields`).toBe(true)
      const rustKeys = [...item.keys].sort()
      const jsKeys = [...jsAllowed].sort()
      const missingInJs = rustKeys.filter(k => !jsAllowed.has(k))
      const extraInJs = jsKeys.filter(k => !item.keys.has(k))
      expect({ missingInJs, extraInJs }).toEqual({ missingInJs: [], extraInJs: [] })
    })
  }
})
