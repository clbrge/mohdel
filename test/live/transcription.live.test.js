/**
 * Live transcription smoke tests — one suite per registered
 * transcription provider, gated on the provider's API key env var
 * (same convention as adapters.live.test.js).
 *
 * The audio is a generated 1-second 440 Hz sine WAV, so no fixture
 * file and no intelligible speech: assertions cover the endpoint
 * contract (auth, multipart shape, response parsing, duration
 * extraction) — not transcription quality. Whisper-family models may
 * legitimately return an empty or junk transcript for a pure tone.
 */

import { describe, test, expect } from 'vitest'
import { getTranscriptionAdapter } from '../../js/session/adapters/transcription/index.js'

const SPECS = {
  groq: { model: 'whisper-large-v3-turbo', reportsDuration: true },
  mistral: { model: 'voxtral-mini-latest', reportsDuration: true },
  openai: { model: 'gpt-4o-mini-transcribe', reportsDuration: false }
}

function sineWavDataUri (seconds = 1, rate = 16000, freq = 440) {
  const samples = seconds * rate
  const data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return `data:audio/wav;base64,${Buffer.concat([header, data]).toString('base64')}`
}

for (const [provider, spec] of Object.entries(SPECS)) {
  const key = process.env[`${provider.toUpperCase()}_API_SK`]

  describe.skipIf(!key)(`${provider} transcription (live)`, () => {
    test('transcribes a generated wav', { timeout: 60_000 }, async () => {
      const adapter = getTranscriptionAdapter(provider)
      const result = await adapter({
        callId: 'live-transcription',
        authId: 'live',
        auth: { key },
        model: `${provider}/${spec.model}`,
        audio: { fileUri: sineWavDataUri(), mimeType: 'audio/wav' }
      }, { spec: { model: spec.model } })

      expect(result.status).toBe('completed')
      expect(typeof result.text).toBe('string')
      if (spec.reportsDuration) {
        expect(result.durationSeconds).toBeGreaterThan(0)
      }
    })
  })
}
