/**
 * Novita image adapter.
 *
 * Async two-step: submit generation task, poll for completion.
 *
 * `spec.imageEndpoint` on the curated entry selects the route
 * (e.g. `txt2img`, `flux-dev`). `fetch` and `sleep` are injectable
 * for testability.
 *
 * @module session/adapters/image/novita
 */

import { getSpec } from '../_catalog.js'
import { classifyProviderError } from '../_errors.js'
import { catalogKey } from '#core/model-id.js'

const BASE_URL = 'https://api.novita.ai'
const NOVITA_TASK_POLL_INTERVAL_MS = 1000
const MAX_POLL_MS = 120_000

/**
 * @param {import('#core/image.js').ImageEnvelope} envelope
 * @param {{
 *   fetch?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   spec?: any
 * }} [deps]
 * @returns {Promise<import('#core/image.js').ImageResult>}
 */
export async function novitaImage (envelope, deps = {}) {
  const fetchFn = deps.fetch ?? globalThis.fetch
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? Date.now

  const spec = deps.spec ?? getSpec(catalogKey(envelope.model)) ?? {}
  const endpoint = spec.imageEndpoint
  if (!endpoint) {
    throw typedError('image endpoint not configured', 'PROVIDER_ERROR', false)
  }

  const start = String(process.hrtime.bigint())
  const apiKey = envelope.auth.key

  const body = { prompt: envelope.prompt }
  const size = envelope.size || spec.imageDefaultSize
  if (size) body.size = size.replace('x', '*')
  if (envelope.seed != null) body.seed = envelope.seed

  const submitUrl = `${BASE_URL}/v3/async/${endpoint}`
  const submit = await post(fetchFn, submitUrl, body, apiKey)

  const result = await pollTaskResult(fetchFn, sleep, now, submit.task_id, apiKey)

  const images = (result.images || []).map(img => ({
    mimeType: img.image_type ? `image/${img.image_type}` : 'image/png',
    url: img.image_url || img.url
  }))

  const end = String(process.hrtime.bigint())
  return {
    status: 'completed',
    images,
    seed: result.task?.seed ?? null,
    timestamps: { start, first: end, end }
  }
}

/** @param {number} ms */
function defaultSleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function post (fetchFn, url, body, apiKey) {
  let res
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    })
  } catch (e) {
    throw typedError(classifyProviderError(e).message, 'NET_ERROR', true)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw fromHttpStatus(res.status, 'novita submit failed', text.slice(0, 120))
  }
  return res.json()
}

async function pollTaskResult (fetchFn, sleep, now, taskId, apiKey) {
  const url = `${BASE_URL}/v3/async/task-result?task_id=${taskId}`
  const deadline = now() + MAX_POLL_MS

  while (now() < deadline) {
    const res = await fetchFn(url, { headers: { Authorization: `Bearer ${apiKey}` } })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw fromHttpStatus(res.status, 'novita poll failed', text.slice(0, 120))
    }
    const data = await res.json()
    const status = data.task?.status
    if (status === 'TASK_STATUS_SUCCEED') return data
    if (status === 'TASK_STATUS_FAILED') {
      throw typedError(
        'novita image failed',
        'PROVIDER_ERROR',
        false,
        data.task?.reason || 'unknown'
      )
    }
    await sleep(NOVITA_TASK_POLL_INTERVAL_MS)
  }

  throw typedError('novita image generation timed out', 'PROVIDER_UNAVAILABLE', true)
}

function fromHttpStatus (status, message, detail) {
  const typed = classifyProviderError({ status })
  // Keep the classifier's message (stable/machine-readable); put the
  // caller's context + any response-body snippet into `detail`. F45:
  // never echo provider response bodies into `TypedError.message`.
  return typedError(typed.message, typed.type, typed.retryable, detail ? `${message}: ${detail}` : message)
}

function typedError (message, type, retryable, detail) {
  const err = new Error(message)
  const typed = { message, severity: retryable ? 'warn' : 'error', retryable, type }
  if (detail) typed.detail = detail
  err.typed = typed
  return err
}
