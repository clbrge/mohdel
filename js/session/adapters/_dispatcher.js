/**
 * Shared undici dispatcher for streaming-LLM adapters.
 *
 * Default `globalThis.fetch` (undici on Node 18+) closes a stream when
 * no body chunk has arrived for `bodyTimeout` ms — 300 000 ms (5 min)
 * by default. Reasoning models stream zero bytes during their thinking
 * phase, so any non-trivial task on a thinking-capable provider can
 * blow that limit and surface as a `NET_ERROR / "terminated"` mid-run.
 *
 * We disable the inter-chunk idle timeout, so nothing in this process
 * bounds a stream once its headers have arrived: the SDKs' request
 * timeout is armed around `fetch` only and cleared when the headers
 * land. What can still end a stream:
 *   1. caller's `AbortSignal` (per-run timeout, user abort)
 *   2. provider-side stream limits
 *
 * Headers timeout stays bounded — connect + first response must be
 * fast even when the body afterwards may be slow.
 *
 * Singleton: undici Agents own a connection pool, so we keep one per
 * process and let it manage per-origin keep-alive across all adapters.
 */
import { Agent } from 'undici'

let _agent = null

export function streamingDispatcher () {
  if (!_agent) _agent = new Agent({ bodyTimeout: 0, headersTimeout: 60_000 })
  return _agent
}
