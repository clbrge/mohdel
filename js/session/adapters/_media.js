/**
 * Local-media resolution for envelope `fileUri` references.
 *
 * Under thin-gate a `fileUri` comes from whoever can reach the data
 * socket, while the session process holds the gate host's filesystem
 * privileges. `MOHDEL_MEDIA_ROOTS` (PATH-style) confines local reads
 * to the listed directories; unset means unconfined.
 *
 * @module session/adapters/_media
 */

import { readFile as fsReadFile, realpath as fsRealpath, stat as fsStat } from 'node:fs/promises'
import { delimiter, isAbsolute, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { typedError } from './_errors.js'

export const MEDIA_MAX_BYTES = 64 * 1024 * 1024

/**
 * A symbol key cannot survive `JSON.parse`, so an envelope arriving
 * over the wire can never carry this mark however it is crafted. Only
 * an in-process caller holding the symbol can set it.
 */
const TRUSTED_MEDIA = Symbol('mohdel.trustedMedia')

/**
 * @template {object} T
 * @param {T} envelope
 * @returns {T}
 */
export function markTrustedMedia (envelope) {
  return Object.assign(envelope, { [TRUSTED_MEDIA]: true })
}

/**
 * @param {any} envelope
 * @returns {boolean}
 */
export function isTrustedMedia (envelope) {
  return envelope?.[TRUSTED_MEDIA] === true
}

/**
 * @param {string} uri
 * @returns {'remote' | 'data' | 'file' | 'unknown'}
 */
export function mediaScheme (uri) {
  if (typeof uri !== 'string' || !uri) return 'unknown'
  if (/^https?:\/\//i.test(uri)) return 'remote'
  if (uri.startsWith('data:')) return 'data'
  if (uri.startsWith('file://')) return 'file'
  return 'unknown'
}

/**
 * @param {string} message
 * @param {string} type    Canonical TypedError tag supplied by the caller.
 * @param {string} [detail]
 * @returns {Error & {typed: import('#core/errors.js').TypedError}}
 */
export function mediaError (message, type, detail) {
  return typedError(message, type, false, detail)
}

/**
 * @param {string} uri
 * @param {string} type
 * @returns {string}  Raw base64 payload, no `data:` prefix.
 */
export function dataUriPayload (uri, type) {
  const comma = uri.indexOf(',')
  if (comma < 0) {
    throw mediaError('malformed data URI', type, 'expected data:<mime>;base64,<payload>')
  }
  return uri.slice(comma + 1)
}

/**
 * A character device such as `/dev/zero` reports `size: 0` and reads
 * without end, so the regular-file check — not the size check — is
 * what bounds the read.
 *
 * `MOHDEL_MEDIA_ROOTS`, when set, confines reads for every caller.
 * When unset, `trusted` decides: an in-process caller reads its own
 * disk freely, an envelope off the wire reads nothing.
 *
 * @param {string} fileUri
 * @param {{
 *   type: string,
 *   trusted?: boolean,
 *   maxBytes?: number,
 *   stat?: (path: string) => Promise<any>,
 *   realpath?: (path: string) => Promise<string>
 * }} opts
 * @returns {Promise<{path: string, size: number}>}
 */
export async function resolveLocalMedia (fileUri, opts) {
  const { type, trusted = false, maxBytes = MEDIA_MAX_BYTES } = opts
  const stat = opts.stat ?? fsStat
  const realpath = opts.realpath ?? fsRealpath

  let requested
  try {
    requested = fileURLToPath(new URL(fileUri))
  } catch {
    throw mediaError('media path is not a valid file URI', type, fileUri.slice(0, 64))
  }

  let path
  try {
    path = await realpath(requested)
  } catch (e) {
    throw mediaError('media file is unreadable', type, messageOf(e))
  }

  const roots = await mediaRoots(realpath)
  if (roots.length) {
    if (!roots.some(root => contains(root, path))) {
      throw mediaError(
        'media path is outside the permitted directories',
        type,
        `${path} is not under any MOHDEL_MEDIA_ROOTS entry`
      )
    }
  } else if (!trusted) {
    throw mediaError(
      'reading local files is not permitted for this caller',
      type,
      'set MOHDEL_MEDIA_ROOTS to the directories this deployment may read media from, or send the media as a data: URI'
    )
  }

  let stats
  try {
    stats = await stat(path)
  } catch (e) {
    throw mediaError('media file is unreadable', type, messageOf(e))
  }

  if (!stats.isFile()) {
    throw mediaError('media path is not a regular file', type, path)
  }
  if (stats.size > maxBytes) {
    throw mediaError(
      'media file exceeds the size limit',
      type,
      `${stats.size} bytes exceeds the ${maxBytes} byte limit`
    )
  }

  return { path, size: stats.size }
}

/**
 * @param {string} fileUri
 * @param {{
 *   type: string,
 *   trusted?: boolean,
 *   maxBytes?: number,
 *   stat?: (path: string) => Promise<any>,
 *   realpath?: (path: string) => Promise<string>,
 *   readFile?: (path: string) => Promise<Buffer>
 * }} opts
 * @returns {Promise<{path: string, bytes: Buffer}>}
 */
export async function readLocalMedia (fileUri, opts) {
  const { path } = await resolveLocalMedia(fileUri, opts)
  const readFile = opts.readFile ?? fsReadFile
  try {
    return { path, bytes: await readFile(path) }
  } catch (e) {
    throw mediaError('media file is unreadable', opts.type, messageOf(e))
  }
}

/**
 * @param {(path: string) => Promise<string>} realpath
 * @returns {Promise<string[]>}
 */
async function mediaRoots (realpath) {
  const raw = process.env.MOHDEL_MEDIA_ROOTS
  if (!raw) return []
  const entries = raw.split(delimiter).map(s => s.trim()).filter(Boolean)
  return Promise.all(entries.map(entry => realpath(entry).catch(() => entry)))
}

/**
 * `startsWith` would accept `/srv/media-evil` for root `/srv/media`;
 * the relative path never does.
 *
 * @param {string} root
 * @param {string} path
 * @returns {boolean}
 */
function contains (root, path) {
  if (path === root) return true
  const rel = relative(root, path)
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

/** @param {unknown} e */
function messageOf (e) {
  return e instanceof Error ? e.message : String(e)
}
