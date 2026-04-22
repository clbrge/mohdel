import { describe, test, expect } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { drive } from '../../js/session/driver.js'

/** @returns {import('#core/envelope.js').CallEnvelope} */
function envelope (overrides = {}) {
  return {
    callId: 'c1',
    authId: 'a1',
    auth: { key: 'k' },
    provider: 'echo',
    model: 'm',
    prompt: 'hi',
    ...overrides
  }
}

function inputStream (...lines) {
  return Readable.from(lines.map(l => (l.endsWith('\n') ? l : l + '\n')))
}

function capturingStdout () {
  const chunks = []
  const s = new Writable({
    write (chunk, _enc, cb) { chunks.push(chunk.toString('utf8')); cb() }
  })
  return { stream: s, output: () => chunks.join('') }
}

function parseNDJSON (text) {
  return text.split('\n').filter(l => l).map(l => JSON.parse(l))
}

describe('session/driver', () => {
  test('reads one envelope, emits delta + done, returns', async () => {
    const stdin = inputStream(JSON.stringify(envelope()))
    const { stream: stdout, output } = capturingStdout()

    await drive(stdin, stdout)
    const events = parseNDJSON(output())
    expect(events.map(e => e.type)).toEqual(['delta', 'delta', 'done'])
  })

  test('multiple envelopes back-to-back (pool reuse case)', async () => {
    const stdin = inputStream(
      JSON.stringify(envelope({ callId: 'first' })),
      JSON.stringify(envelope({ callId: 'second' })),
      JSON.stringify(envelope({ callId: 'third' }))
    )
    const { stream: stdout, output } = capturingStdout()

    await drive(stdin, stdout)
    const events = parseNDJSON(output())
    const dones = events.filter(e => e.type === 'done')
    expect(dones.length).toBe(3)
  })

  test('unparseable envelope is skipped; subsequent envelopes still process', async () => {
    const stdin = inputStream(
      'not json',
      JSON.stringify(envelope({ callId: 'valid' }))
    )
    const { stream: stdout, output } = capturingStdout()

    await drive(stdin, stdout)
    const events = parseNDJSON(output())
    expect(events.filter(e => e.type === 'done').length).toBe(1)
  })

  test('unknown provider produces an error event', async () => {
    const stdin = inputStream(JSON.stringify(envelope({ provider: 'nonesuch' })))
    const { stream: stdout, output } = capturingStdout()

    await drive(stdin, stdout)
    const events = parseNDJSON(output())
    expect(events.length).toBe(1)
    expect(events[0].type).toBe('error')
    expect(events[0].error.type).toBe('SESSION_UNKNOWN_PROVIDER')
  })

  test('{op:"ping"} produces {op:"pong"} without queueing a call', async () => {
    const stdin = inputStream('{"op":"ping"}')
    const { stream: stdout, output } = capturingStdout()

    await drive(stdin, stdout)
    const lines = output().split('\n').filter(Boolean).map(l => JSON.parse(l))
    expect(lines).toEqual([{ op: 'pong' }])
  })

  test('ping + envelope: pong first, then call events', async () => {
    const stdin = inputStream(
      '{"op":"ping"}',
      JSON.stringify(envelope({ callId: 'after-pong' }))
    )
    const { stream: stdout, output } = capturingStdout()

    await drive(stdin, stdout)
    const lines = output().split('\n').filter(Boolean).map(l => JSON.parse(l))
    expect(lines[0]).toEqual({ op: 'pong' })
    const events = lines.slice(1)
    expect(events.at(-1).type).toBe('done')
  })

  test('ping arriving mid-call is ignored (no pong written mid-stream)', async () => {
    // F10 regression. If a supervisor pings a busy session, emitting
    // `{op:"pong"}` on stdout would confuse the gate's event-stream
    // reader and kill the session. Session must drop mid-call pings.
    const { PassThrough } = await import('node:stream')
    const stdin = new PassThrough()
    const { stream: stdout, output } = capturingStdout()

    // Fire the driver, capture its completion promise.
    const driving = drive(stdin, stdout)

    // Send an envelope that takes measurable time (fake `slow` mode
    // with 6 tokens × 20ms delay ≈ 120ms of streaming).
    const slow = {
      callId: 'slow-1',
      authId: 'a1',
      auth: { key: 'k' },
      provider: 'fake',
      model: 'm',
      prompt: JSON.stringify({ mode: 'slow', tokens: 6, delayMs: 20 })
    }
    stdin.write(JSON.stringify(slow) + '\n')

    // Wait until the call is past its first delta, then inject a ping.
    await new Promise(resolve => setTimeout(resolve, 30))
    stdin.write('{"op":"ping"}\n')

    // Let the call finish.
    await new Promise(resolve => setTimeout(resolve, 200))
    stdin.end()
    await driving

    // Every line on stdout during this call should be an Event, never
    // a control frame.
    const lines = output().split('\n').filter(Boolean).map(l => JSON.parse(l))
    for (const line of lines) {
      expect(line.op).toBeUndefined() // no control-frame leakage
      expect(line.type).toBeDefined() // it IS an Event
    }
    expect(lines.at(-1).type).toBe('done')
  })

  test('ping arriving between calls still produces pong', async () => {
    // Counterpart to the mid-call test: a ping with no active call
    // still works normally. Confirms the guard is in-flight-scoped,
    // not a blanket disable.
    const { PassThrough } = await import('node:stream')
    const stdin = new PassThrough()
    const { stream: stdout, output } = capturingStdout()

    const driving = drive(stdin, stdout)

    stdin.write(JSON.stringify(envelope({ callId: 'first' })) + '\n')
    await new Promise(resolve => setTimeout(resolve, 30))
    // First call is done by now (echo adapter is near-instant). Ping
    // now lands while idle → pong expected.
    stdin.write('{"op":"ping"}\n')
    await new Promise(resolve => setTimeout(resolve, 30))
    stdin.write(JSON.stringify(envelope({ callId: 'second' })) + '\n')
    await new Promise(resolve => setTimeout(resolve, 30))
    stdin.end()
    await driving

    const lines = output().split('\n').filter(Boolean).map(l => JSON.parse(l))
    // Exactly one pong, between the two calls' terminals.
    const pongs = lines.filter(l => l.op === 'pong')
    expect(pongs).toHaveLength(1)
    const dones = lines.filter(l => l.type === 'done')
    expect(dones).toHaveLength(2)
  })

  test('empty stdin returns without writing', async () => {
    const stdin = inputStream()
    const { stream: stdout, output } = capturingStdout()

    await drive(stdin, stdout)
    expect(output()).toBe('')
  })

  test('cancel control mid-call aborts via matching callId', async () => {
    // Slow adapter: one delta, then waits until cancelled.
    // But to test through the driver, we need the cancel message arriving
    // while the adapter iterates. We simulate with a delayed adapter that
    // checks signal.aborted between yields.
    // Simpler: rely on the echo adapter's signal handling — pre-abort via
    // the cancel control, which aborts IMMEDIATELY on signal check.

    // Since echo is instant, we test the control-message RECOGNITION
    // path: cancel before envelope is a no-op (not currentCall); cancel
    // for unknown callId while envelope is in-flight is also a no-op.
    // End-to-end mid-call abort is covered by session-cancel.test.js.

    const stdin = inputStream(
      JSON.stringify({ op: 'cancel', callId: 'nothing-in-flight' }),
      JSON.stringify(envelope({ callId: 'real' }))
    )
    const { stream: stdout, output } = capturingStdout()
    await drive(stdin, stdout)
    const events = parseNDJSON(output())
    expect(events.filter(e => e.type === 'done').length).toBe(1)
  })

  // F19: cancels arriving before the envelope was dequeued must still
  // abort the call.

  test('pre-dequeue cancel aborts the matching envelope on dispatch', async () => {
    // Cancel for 'c-pre' arrives FIRST, then the envelope for 'c-pre'.
    // Before F19, driver dropped the cancel (no currentCall match).
    // Now: envelope dispatches with a pre-aborted controller → run()
    // yields a cancelled done immediately.
    const stdin = inputStream(
      JSON.stringify({ op: 'cancel', callId: 'c-pre' }),
      JSON.stringify(envelope({ callId: 'c-pre' }))
    )
    const { stream: stdout, output } = capturingStdout()
    await drive(stdin, stdout)
    const events = parseNDJSON(output())
    const done = events.at(-1)
    expect(done.type).toBe('done')
    expect(done.result.warning).toBe('cancelled')
  })

  test('pre-dequeue cancel only fires once, does not leak to next call of same id', async () => {
    // Cancel for 'dup' → envelope 'dup' (aborts) → envelope 'dup' again
    // (fresh controller, runs normally). The precancel set must be cleared
    // on first match.
    const stdin = inputStream(
      JSON.stringify({ op: 'cancel', callId: 'dup' }),
      JSON.stringify(envelope({ callId: 'dup' })),
      JSON.stringify(envelope({ callId: 'dup' }))
    )
    const { stream: stdout, output } = capturingStdout()
    await drive(stdin, stdout)
    const dones = parseNDJSON(output()).filter(e => e.type === 'done')
    expect(dones).toHaveLength(2)
    expect(dones[0].result.warning).toBe('cancelled')
    expect(dones[1].result.warning).not.toBe('cancelled')
  })

  // F25: image envelopes — `op: "image"` dispatches to runImage()
  // and emits a single `image_done` line.

  test('image envelope emits single image_done line', async () => {
    const imgEnv = {
      op: 'image',
      callId: 'img-1',
      authId: 'a1',
      auth: { key: 'k' },
      provider: 'fake',
      model: 'test',
      prompt: JSON.stringify({ mode: 'ok', count: 1 })
    }
    const stdin = inputStream(JSON.stringify(imgEnv))
    const { stream: stdout, output } = capturingStdout()
    await drive(stdin, stdout)
    const lines = parseNDJSON(output())
    expect(lines).toHaveLength(1)
    expect(lines[0].type).toBe('image_done')
    expect(lines[0].result.status).toBe('completed')
    expect(lines[0].result.images).toHaveLength(1)
    expect(lines[0].result.images[0].url).toContain('img-img-1')
  })

  test('image envelope on unknown provider emits error line', async () => {
    const imgEnv = {
      op: 'image',
      callId: 'img-2',
      authId: 'a1',
      auth: { key: 'k' },
      provider: 'nonesuch',
      model: 'test',
      prompt: 'red sphere'
    }
    const stdin = inputStream(JSON.stringify(imgEnv))
    const { stream: stdout, output } = capturingStdout()
    await drive(stdin, stdout)
    const lines = parseNDJSON(output())
    expect(lines).toHaveLength(1)
    expect(lines[0].type).toBe('error')
    expect(lines[0].error.type).toBe('SESSION_UNKNOWN_PROVIDER')
  })

  test('pre-cancel buffer is bounded: flood of unmatched cancels does not grow without bound', async () => {
    // Send 200 cancels for distinct unknown callIds, then an envelope
    // matching the FIRST of those cancels. Cap is 128, so the first ~72
    // cancels have been evicted and the envelope should run normally.
    const floodCancels = Array.from({ length: 200 }, (_, i) =>
      JSON.stringify({ op: 'cancel', callId: `ghost-${i}` })
    )
    const stdin = inputStream(
      ...floodCancels,
      JSON.stringify(envelope({ callId: 'ghost-0' })) // evicted by now
    )
    const { stream: stdout, output } = capturingStdout()
    await drive(stdin, stdout)
    const events = parseNDJSON(output())
    const done = events.at(-1)
    expect(done.type).toBe('done')
    // ghost-0's precancel entry was evicted → call runs normally (no cancel warning)
    expect(done.result.warning).not.toBe('cancelled')
  })
})
