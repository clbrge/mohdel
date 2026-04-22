/**
 * Fake image adapter — scenario-driven for tests, benchmarks, and
 * bug reproductions. Never calls a real API.
 *
 * Mirrors the `fake` answer adapter shape: the envelope's `prompt`
 * carries a JSON scenario spec; the `mode` key picks a behavior.
 * Invalid / non-JSON prompts fall through to `mode: "ok"`.
 *
 * ## Modes
 *
 * | mode    | params                    | behavior                                    |
 * |---------|---------------------------|---------------------------------------------|
 * | `ok`    | `count?` (default 1)      | returns `count` placeholder image URLs      |
 * | `error` | `type`, `message`         | throws a tagged error                       |
 *
 * @module session/adapters/image/fake
 */

/**
 * @param {import('#core/image.js').ImageEnvelope} envelope
 * @returns {Promise<import('#core/image.js').ImageResult>}
 */
export async function fakeImage (envelope) {
  const scenario = parseScenario(envelope.prompt)
  const mode = scenario.mode ?? 'ok'

  if (mode === 'error') {
    const err = new Error(scenario.message || 'fake image error')
    err.typed = {
      message: scenario.message || 'fake image error',
      severity: 'error',
      retryable: !!scenario.retryable,
      type: scenario.type || 'PROVIDER_ERROR'
    }
    throw err
  }

  const count = Math.max(1, Number(scenario.count) || 1)
  const now = `${process.hrtime.bigint()}`
  return {
    status: 'completed',
    images: Array.from({ length: count }, (_, i) => ({
      mimeType: 'image/png',
      url: `https://fake.example/img-${envelope.callId}-${i}.png`
    })),
    seed: envelope.seed ?? null,
    timestamps: { start: now, first: now, end: now }
  }
}

/** @param {unknown} prompt */
function parseScenario (prompt) {
  if (typeof prompt !== 'string') return {}
  try { return JSON.parse(prompt) || {} } catch { return {} }
}
