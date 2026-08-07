/**
 * Video upload + inline handling shared across adapters that
 * currently support video (Gemini today; more could follow the same
 * shape).
 *
 * Three code paths per envelope video ref:
 *   1. `file://`, ≤20MB, no cache flag → read + base64 inline as
 *      `inlineData`.
 *   2. `file://`, >20MB or `cache: true` → upload via the provider
 *      SDK (Gemini `ai.files.upload`), poll until the file is ACTIVE,
 *      return a `fileData` part. Content-hash + mtime-keyed cache at
 *      `~/.cache/mohdel/uploaded-files.json` short-circuits repeat
 *      uploads.
 *   3. `https://` → passthrough as `fileData.fileUri` (Gemini fetches
 *      it directly).
 *
 * Local paths resolve through `_media.js`. Bare filesystem paths are
 * not accepted — the scheme is required, matching `_images.js` and the
 * transcription loader.
 *
 * @module session/adapters/_videos
 */

import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import envPaths from 'env-paths'

import { dataUriPayload, mediaError, mediaScheme, resolveLocalMedia } from './_media.js'

const CACHE_DIR = envPaths('mohdel', { suffix: null }).cache
const CACHE_PATH = join(CACHE_DIR, 'uploaded-files.json')

const VIDEO_ERROR = 'SESSION_INVALID_VIDEO'
const INLINE_MAX_BYTES = 20 * 1024 * 1024
const VIDEO_UPLOAD_POLL_INTERVAL_MS = 5_000
/** Hard deadline on the PROCESSING → ACTIVE wait. Videos occasionally
 * take a while; 5 min is generous enough that a stuck file ≠ slow
 * file, but short enough that a pool slot doesn't hang forever. */
const MAX_UPLOAD_POLL_MS = 300_000

/**
 * @typedef {object} UploadedFileRecord
 * @property {string} hash
 * @property {{uri: string, name: string, mimeType?: string, state?: string}} data
 * @property {string} filePath
 * @property {string} provider
 * @property {string} cachedAt
 */

// ---------- cache ----------

async function ensureCacheDir () {
  if (!existsSync(CACHE_DIR)) {
    await fs.mkdir(CACHE_DIR, { recursive: true })
  }
}

/**
 * Content-hash keyed by `sha256(bytes + filePath + mtime)` so an
 * edited file forces re-upload even if the path stays the same.
 *
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function hashFile (filePath) {
  const [buf, st] = await Promise.all([
    fs.readFile(filePath),
    fs.stat(filePath)
  ])
  const h = createHash('sha256')
  h.update(buf)
  h.update(filePath)
  h.update(st.mtime.toISOString())
  return h.digest('hex')
}

/**
 * Provider file handles expire server-side — Gemini's Files API keeps
 * an upload about 48h — while a cache entry would live forever. An
 * entry outliving its handle is worse than a cache miss: the upload is
 * skipped and the provider rejects a URI it no longer knows.
 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** Bound on retained entries; the file is rewritten whole on each save. */
const CACHE_MAX_ENTRIES = 500

/**
 * @param {Record<string, UploadedFileRecord>} cache
 * @returns {Record<string, UploadedFileRecord>}
 */
function prune (cache) {
  const cutoff = Date.now() - CACHE_TTL_MS
  const live = Object.entries(cache).filter(([, e]) => {
    const at = Date.parse(e?.cachedAt ?? '')
    return Number.isFinite(at) && at >= cutoff
  })
  if (live.length <= CACHE_MAX_ENTRIES) return Object.fromEntries(live)
  live.sort((a, b) => Date.parse(b[1].cachedAt) - Date.parse(a[1].cachedAt))
  return Object.fromEntries(live.slice(0, CACHE_MAX_ENTRIES))
}

async function loadCache () {
  try {
    if (!existsSync(CACHE_PATH)) return {}
    const text = await fs.readFile(CACHE_PATH, 'utf8')
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return prune(parsed)
  } catch {
    return {}
  }
}

async function saveCache (cache) {
  try {
    await ensureCacheDir()
    await fs.writeFile(CACHE_PATH, JSON.stringify(prune(cache), null, 2))
  } catch {
    // cache write failures shouldn't bring down a call
  }
}

/**
 * @param {string} filePath
 * @param {string} provider
 * @returns {Promise<UploadedFileRecord | undefined>}
 */
export async function getCachedFile (filePath, provider = 'gemini') {
  try {
    const hash = await hashFile(filePath)
    const cache = await loadCache()
    return cache[`${provider}:${hash}`]
  } catch {
    return undefined
  }
}

/**
 * @param {string} filePath
 * @param {object} data
 * @param {string} provider
 */
export async function setCachedFile (filePath, data, provider = 'gemini') {
  try {
    const hash = await hashFile(filePath)
    const cache = await loadCache()
    cache[`${provider}:${hash}`] = {
      hash,
      data,
      filePath,
      provider,
      cachedAt: new Date().toISOString()
    }
    await saveCache(cache)
  } catch {
    // best effort
  }
}

// ---------- loader ----------

/**
 * @typedef {object} VideoPart
 * @property {{data: string, mimeType: string}} [inlineData]
 * @property {{fileUri: string, mimeType: string}} [fileData]
 */

/**
 * @param {import('#core/envelope.js').MediaRef[]} videos
 * @param {{
 *   client: {files: {upload: (args: any) => Promise<any>, get: (args: {name: string}) => Promise<any>}},
 *   useCache?: boolean,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   readFile?: (path: string) => Promise<Buffer>,
 *   stat?: (path: string) => Promise<{size: number}>,
 *   signal?: AbortSignal,
 *   provider?: string,
 *   trusted?: boolean
 * }} deps
 * @returns {Promise<VideoPart[]>}
 */
export async function loadVideos (videos, deps) {
  const out = []
  if (!videos || !Array.isArray(videos)) return out
  const ctx = {
    client: deps.client,
    useCache: !!deps.useCache,
    sleep: deps.sleep ?? defaultSleep,
    now: deps.now ?? Date.now,
    readFileFn: deps.readFile ?? fs.readFile,
    statFn: deps.stat ?? fs.stat,
    signal: deps.signal,
    provider: deps.provider ?? 'gemini',
    trusted: !!deps.trusted
  }

  for (const v of videos) {
    if (!v?.fileUri || !v?.mimeType) continue
    throwIfAborted(ctx.signal)
    const part = await toPart(v, ctx)
    if (part) out.push(part)
  }
  return out
}

async function toPart (ref, ctx) {
  const { fileUri, mimeType } = ref

  const scheme = mediaScheme(fileUri)
  if (scheme === 'remote') {
    return { fileData: { fileUri, mimeType } }
  }
  if (scheme === 'data') {
    return { inlineData: { data: dataUriPayload(fileUri, VIDEO_ERROR), mimeType } }
  }
  if (scheme !== 'file') {
    throw mediaError(
      `unsupported video URI scheme: ${fileUri.slice(0, 32)}…`,
      VIDEO_ERROR
    )
  }

  // The upload path streams from the path rather than buffering, so
  // only the inline branch is bounded here — by INLINE_MAX_BYTES.
  const { path: filePath, size } = await resolveLocalMedia(fileUri, {
    type: VIDEO_ERROR,
    trusted: ctx.trusted,
    maxBytes: Number.POSITIVE_INFINITY,
    stat: ctx.statFn
  })

  if (size > INLINE_MAX_BYTES || ctx.useCache) {
    const uri = await uploadFile(filePath, mimeType, ctx)
    return { fileData: { fileUri: uri, mimeType } }
  }

  const buf = await ctx.readFileFn(filePath)
  return { inlineData: { data: buf.toString('base64'), mimeType } }
}

/**
 * Upload + poll until active. Honors the on-disk cache so repeat
 * calls (same bytes + mtime) skip the network round trip. A stuck
 * PROCESSING file is bounded by `MAX_UPLOAD_POLL_MS`; an aborted
 * signal breaks out immediately.
 */
async function uploadFile (filePath, mimeType, ctx) {
  const cached = await getCachedFile(filePath, ctx.provider)
  if (cached?.data?.uri) return cached.data.uri
  throwIfAborted(ctx.signal)

  let file = await ctx.client.files.upload({
    file: filePath,
    config: { mimeType }
  })

  const deadline = ctx.now() + MAX_UPLOAD_POLL_MS

  while (file?.state === 'PROCESSING') {
    if (ctx.now() >= deadline) {
      throw typedError(
        `gemini file upload did not become ACTIVE within ${MAX_UPLOAD_POLL_MS / 1000}s`,
        'PROVIDER_UNAVAILABLE',
        true
      )
    }
    throwIfAborted(ctx.signal)
    await ctx.sleep(VIDEO_UPLOAD_POLL_INTERVAL_MS)
    throwIfAborted(ctx.signal)
    file = await ctx.client.files.get({ name: file.name })
  }
  if (file?.state === 'FAILED') {
    throw new Error('gemini file processing failed')
  }
  if (!file?.uri) {
    throw new Error('gemini upload returned no uri')
  }

  await setCachedFile(filePath, file, ctx.provider)
  return file.uri
}

/**
 * Raise an `AbortError` when `signal` is aborted. The gemini
 * adapter's video-load catch block already converts this shape to
 * the standard cancelled terminal via the outer `signal?.aborted`
 * check in `run.js`.
 *
 * @param {AbortSignal | undefined} signal
 */
function throwIfAborted (signal) {
  if (signal?.aborted) {
    const err = new Error('aborted')
    err.name = 'AbortError'
    throw err
  }
}

/**
 * @param {string} message
 * @param {string} type
 * @param {boolean} retryable
 */
function typedError (message, type, retryable) {
  const err = new Error(message)
  err.typed = {
    message,
    severity: retryable ? 'warn' : 'error',
    retryable,
    type
  }
  return err
}

function defaultSleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
