import { describe, expect, test } from 'vitest'

import { parseTraceparent, remoteParentFromTraceparent } from '../../src/lib/tracing.js'

describe('parseTraceparent', () => {
  test('parses a valid W3C traceparent header', () => {
    const header = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    expect(parseTraceparent(header)).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      traceFlags: 1,
      isRemote: true
    })
  })

  test('parses unsampled flag (00)', () => {
    const header = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00'
    expect(parseTraceparent(header).traceFlags).toBe(0)
  })

  test('returns null for missing or empty header', () => {
    expect(parseTraceparent(null)).toBeNull()
    expect(parseTraceparent(undefined)).toBeNull()
    expect(parseTraceparent('')).toBeNull()
  })

  test('returns null for non-string input', () => {
    expect(parseTraceparent(42)).toBeNull()
    expect(parseTraceparent({})).toBeNull()
  })

  test('returns null for unknown version', () => {
    // Only version 00 is currently defined; reject anything else strictly
    expect(parseTraceparent('01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBeNull()
    expect(parseTraceparent('ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBeNull()
  })

  test('returns null for malformed shape', () => {
    expect(parseTraceparent('not-a-traceparent')).toBeNull()
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736')).toBeNull()
    expect(parseTraceparent('00-tooshort-00f067aa0ba902b7-01')).toBeNull()
  })

  test('returns null for invalid all-zero traceId per W3C spec', () => {
    const header = '00-00000000000000000000000000000000-00f067aa0ba902b7-01'
    expect(parseTraceparent(header)).toBeNull()
  })

  test('returns null for invalid all-zero spanId per W3C spec', () => {
    const header = '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01'
    expect(parseTraceparent(header)).toBeNull()
  })

  test('rejects uppercase hex (W3C requires lowercase)', () => {
    const header = '00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01'
    expect(parseTraceparent(header)).toBeNull()
  })
})

describe('remoteParentFromTraceparent', () => {
  test('returns a span-like object with spanContext() for valid header', () => {
    const header = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    const parent = remoteParentFromTraceparent(header)
    expect(parent).toBeTruthy()
    expect(typeof parent.spanContext).toBe('function')
    const ctx = parent.spanContext()
    expect(ctx.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
    expect(ctx.spanId).toBe('00f067aa0ba902b7')
    expect(ctx.traceFlags).toBe(1)
    expect(ctx.isRemote).toBe(true)
  })

  test('returns null for invalid header', () => {
    expect(remoteParentFromTraceparent(null)).toBeNull()
    expect(remoteParentFromTraceparent('garbage')).toBeNull()
  })
})
