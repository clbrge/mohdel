import { describe, test, expect } from 'vitest'
import { run } from '../../js/session/run.js'

// Wire-side counterpart to `factory-output-effort-alias.test.js`.
// Session `run()` accepts the `model:effort` shortcut on the wire,
// mirroring the factory's `mohdel().use('model:effort')` ergonomics.
// Without this, direct `/v1/call` callers see inconsistent behavior
// (factory accepts `:effort` but wire rejects it as an unknown model).

/** @returns {import('#core/envelope.js').CallEnvelope} */
function envelope (overrides = {}) {
  return {
    callId: 'c1',
    authId: 'a1',
    auth: { key: 'k' },
    provider: 'anthropic',
    model: 'claude-opus-4',
    prompt: 'hi',
    ...overrides
  }
}

function specs ({ levels = { minimal: 2048, low: 8192, medium: 16384, high: 32768, max: 65536 } } = {}) {
  return (key) => {
    switch (key) {
      case 'anthropic/claude-opus-4':
        return { provider: 'anthropic', model: 'claude-opus-4', thinkingEffortLevels: levels }
      case 'anthropic/claude-no-thinking':
        return { provider: 'anthropic', model: 'claude-no-thinking', thinkingEffortLevels: null }
      default:
        return undefined
    }
  }
}

async function collect (iter) {
  const out = []
  for await (const v of iter) out.push(v)
  return out
}

// Capture whatever envelope the adapter sees so we can assert the
// normalization actually happened before dispatch.
function capturingAdapter () {
  const seen = { envelope: null }
  const adapter = async function * (env) {
    seen.envelope = env
    yield {
      type: 'done',
      result: {
        status: 'completed',
        output: 'ok',
        inputTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        cost: 0,
        timestamps: { start: '0', first: '0', end: '0' }
      }
    }
  }
  return { adapter, seen }
}

describe('session/run `:effort` alias on the wire', () => {
  test('accepts a per-spec level not in the old hardcoded list (`:max`)', async () => {
    const { adapter, seen } = capturingAdapter()
    const events = await collect(run(envelope({ model: 'claude-opus-4:max' }), {
      resolveAdapter: () => adapter,
      resolveSpec: specs()
    }))
    expect(events.at(-1).type).toBe('done')
    expect(seen.envelope.model).toBe('claude-opus-4')
    expect(seen.envelope.outputEffort).toBe('max')
  })

  test('accepts `:minimal` level', async () => {
    const { adapter, seen } = capturingAdapter()
    await collect(run(envelope({ model: 'claude-opus-4:minimal' }), {
      resolveAdapter: () => adapter,
      resolveSpec: specs()
    }))
    expect(seen.envelope.model).toBe('claude-opus-4')
    expect(seen.envelope.outputEffort).toBe('minimal')
  })

  test('accepts `:none` when spec has thinkingEffortLevels', async () => {
    const { adapter, seen } = capturingAdapter()
    await collect(run(envelope({ model: 'claude-opus-4:none' }), {
      resolveAdapter: () => adapter,
      resolveSpec: specs()
    }))
    expect(seen.envelope.model).toBe('claude-opus-4')
    expect(seen.envelope.outputEffort).toBe('none')
  })

  test('rejects an unsupported level with spec-aware error', async () => {
    const events = await collect(run(envelope({ model: 'claude-opus-4:max' }), {
      resolveSpec: specs({ levels: { low: 100, high: 200 } })
    }))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('error')
    expect(events[0].error.type).toBe('SESSION_INVALID_OUTPUT_EFFORT')
    expect(events[0].error.message).toMatch(/does not support output effort level 'max'/)
    expect(events[0].error.message).toMatch(/Available:.*low.*high/)
  })

  test('model with null thinkingEffortLevels rejects any `:effort` alias', async () => {
    const events = await collect(run(envelope({ model: 'claude-no-thinking:low' }), {
      resolveSpec: specs()
    }))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('error')
    expect(events[0].error.type).toBe('SESSION_INVALID_OUTPUT_EFFORT')
    expect(events[0].error.message).toMatch(/no thinkingEffortLevels/)
  })

  test('unknown base (no colon split applies) leaves envelope untouched', async () => {
    const { adapter, seen } = capturingAdapter()
    await collect(run(envelope({ model: 'claude-hypothetical:low' }), {
      resolveAdapter: () => adapter,
      resolveSpec: specs()
    }))
    // Base `anthropic/claude-hypothetical` doesn't resolve, so we
    // leave the model alone. Downstream lookup will emit its own
    // not-found — here we just assert we didn't split.
    expect(seen.envelope.model).toBe('claude-hypothetical:low')
    expect(seen.envelope.outputEffort).toBeUndefined()
  })

  test('explicit outputEffort on envelope wins over suffix', async () => {
    const { adapter, seen } = capturingAdapter()
    await collect(run(envelope({ model: 'claude-opus-4:high', outputEffort: 'low' }), {
      resolveAdapter: () => adapter,
      resolveSpec: specs()
    }))
    // Suffix stays embedded in model, outputEffort unchanged.
    // (The effort already being set signals the caller made a deliberate choice;
    // the shortcut is meant as a convenience, not an override.)
    expect(seen.envelope.model).toBe('claude-opus-4:high')
    expect(seen.envelope.outputEffort).toBe('low')
  })

  test('model without any `:` is unchanged', async () => {
    const { adapter, seen } = capturingAdapter()
    await collect(run(envelope({ model: 'claude-opus-4' }), {
      resolveAdapter: () => adapter,
      resolveSpec: specs()
    }))
    expect(seen.envelope.model).toBe('claude-opus-4')
    expect(seen.envelope.outputEffort).toBeUndefined()
  })
})
