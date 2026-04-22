/**
 * Video upload + inline handling shared across adapters that
 * currently support video (Gemini today; more could follow the same
 * shape).
 *
 * Three code paths per envelope video ref:
 *   1. `file://` / local path, ≤20MB, no cache flag → read + base64
 *      inline as `inlineData`.
 *   2. `file://` / local path, >20MB or `cache: true` → upload via
 *      the provider SDK (Gemini `ai.files.upload`), poll until the
 *      file is ACTIVE, return a `fileData` part. Content-hash +
 *      mtime-keyed cache at `~/.cache/mohdel/uploaded-files.json`
 *      short-circuits repeat uploads.
 *   3. `https://` → passthrough as `fileData.fileUri` (Gemini fetches
 *      it directly).
 *
 * @module session/adapters/_videos
 */

import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import envPaths from 'env-paths'

const CACHE_DIR = envPaths('mohdel', { suffix: null }).cache
const CACHE_PATH = join(CACHE_DIR, 'uploaded-files.json')

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

async function loadCache () {
  try {
    if (!existsSync(CACHE_PATH)) return {}
    const text = await fs.readFile(CACHE_PATH, 'utf8')
    return JSON.parse(text)
  } catch {
    return {}
  }
}

async function saveCache (cache) {
  try {
    await ensureCacheDir()
    await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2))
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
 *   provider?: string
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
    provider: deps.provider ?? 'gemini'
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

  // https:// → Gemini fetches it directly
  if (/^https?:\/\//i.test(fileUri)) {
    return { fileData: { fileUri, mimeType } }
  }

  // data: URI → inline the base64 payload
  if (fileUri.startsWith('data:')) {
    const comma = fileUri.indexOf(',')
    if (comma < 0) return null
    return { inlineData: { data: fileUri.slice(comma + 1), mimeType } }
  }

  // file:// or local path
  const filePath = fileUri.replace(/^file:\/\//, '')
  let stats
  try {
    stats = await ctx.statFn(filePath)
  } catch {
    return null
  }

  if (stats.size > INLINE_MAX_BYTES || ctx.useCache) {
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
