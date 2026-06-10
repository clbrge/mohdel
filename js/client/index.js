/**
 * mohdel client — thin caller for thin-gate's data-plane unix socket.
 *
 * Public surface (0.90):
 *   - call(envelope, { socketPath, signal }): AsyncGenerator<Event>
 *   - callImage(envelope, { socketPath, signal }): Promise<ImageResult>
 *   - callTranscription(envelope, { socketPath, signal }): Promise<TranscriptionResult>
 *
 * No provider SDKs are imported transitively. This module can be
 * consumed by callers that must not pull openai-node, anthropic-sdk,
 * etc. into their bundle.
 *
 * @module client
 */

export { call } from './call.js'
export { callImage } from './call_image.js'
export { callTranscription } from './call_transcription.js'
