/**
 * Send a TranscriptionEnvelope to thin-gate's `POST /v1/transcription`.
 *
 * Transcription is one-shot: single JSON response body, no streaming,
 * no cooldown/rate-limit. `audio.fileUri` must be a `file://` or
 * `data:` URI — `file://` requires that the gate's sessions share a
 * filesystem with the caller; `data:` carries the bytes inline subject
 * to the gate's body-size cap.
 *
 * @module client/call_transcription
 */

import { requestUnix } from './transport.js'
import { MohdelTypedError } from '#core'

/**
 * @param {import('#core/transcription.js').TranscriptionEnvelope} envelope
 * @param {object} options
 * @param {string} options.socketPath
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.path]  HTTP path; defaults to '/v1/transcription'
 * @returns {Promise<import('#core/transcription.js').TranscriptionResult>}
 */
export async function callTranscription (envelope, { socketPath, signal, path = '/v1/transcription' }) {
  const res = await requestUnix({
    socketPath,
    path,
    method: 'POST',
    body: envelope,
    signal
  })

  const body = await readAll(res)

  if (res.statusCode !== 200) {
    throw MohdelTypedError.fromJSON(parseErrorBody(body, res.statusCode ?? 0))
  }

  let parsed
  try {
    parsed = JSON.parse(body)
  } catch (e) {
    throw new MohdelTypedError(
      'thin-gate returned non-JSON transcription response',
      { type: 'PROTOCOL_INVALID_EVENT', retryable: false }
    )
  }

  if (!parsed || typeof parsed !== 'object' || parsed.status !== 'completed' || typeof parsed.text !== 'string') {
    throw new MohdelTypedError(
      'thin-gate returned malformed TranscriptionResult',
      { type: 'PROTOCOL_INVALID_EVENT', retryable: false }
    )
  }
  return parsed
}

/**
 * @param {AsyncIterable<Buffer|string>} stream
 * @returns {Promise<string>}
 */
async function readAll (stream) {
  let s = ''
  for await (const c of stream) s += typeof c === 'string' ? c : c.toString('utf8')
  return s
}

/**
 * @param {string} body
 * @param {number} status
 * @returns {import('#core/errors.js').TypedError}
 */
function parseErrorBody (body, status) {
  try {
    const parsed = JSON.parse(body)
    if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
      return parsed
    }
  } catch {}
  return {
    type: 'PROTOCOL_HTTP_ERROR',
    message: `thin-gate returned HTTP ${status}`,
    retryable: status >= 500
  }
}
