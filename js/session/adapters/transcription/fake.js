/**
 * Fake transcription adapter — scenario-driven for tests and bug
 * reproductions. Never calls a real API.
 *
 * Mirrors the `fake` image adapter shape: the envelope's `prompt`
 * field carries a JSON scenario spec; the `mode` key picks a
 * behavior. Missing / non-JSON prompts fall through to `mode: "ok"`.
 *
 * ## Modes
 *
 * | mode    | params                          | behavior                       |
 * |---------|---------------------------------|--------------------------------|
 * | `ok`    | `text?`, `durationSeconds?`     | returns a canned transcription |
 * | `error` | `type`, `message`               | throws a tagged error          |
 *
 * @module session/adapters/transcription/fake
 */

/**
 * @param {import('#core/transcription.js').TranscriptionEnvelope} envelope
 * @returns {Promise<import('#core/transcription.js').TranscriptionResult>}
 */
export async function fakeTranscription (envelope) {
  const scenario = parseScenario(envelope.prompt)
  const mode = scenario.mode ?? 'ok'

  if (mode === 'error') {
    const err = new Error(scenario.message || 'fake transcription error')
    err.typed = {
      message: scenario.message || 'fake transcription error',
      severity: 'error',
      retryable: !!scenario.retryable,
      type: scenario.type || 'PROVIDER_ERROR'
    }
    throw err
  }

  const now = `${process.hrtime.bigint()}`
  return {
    status: 'completed',
    text: scenario.text ?? `fake transcript for ${envelope.callId}`,
    language: scenario.language ?? 'en',
    durationSeconds: scenario.durationSeconds ?? 1,
    cost: 0,
    timestamps: { start: now, first: now, end: now }
  }
}

/** @param {unknown} prompt */
function parseScenario (prompt) {
  if (typeof prompt !== 'string') return {}
  try { return JSON.parse(prompt) || {} } catch { return {} }
}
