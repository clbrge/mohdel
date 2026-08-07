import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import {
  MEDIA_MAX_BYTES,
  dataUriPayload,
  isTrustedMedia,
  markTrustedMedia,
  mediaScheme,
  readLocalMedia,
  resolveLocalMedia
} from '../../js/session/adapters/_media.js'
import { loadImage } from '../../js/session/adapters/_images.js'

const TYPE = 'SESSION_INVALID_IMAGE'

let tmpDir
let mediaFile

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mohdel-media-'))
  mediaFile = path.join(tmpDir, 'asset.bin')
  fs.writeFileSync(mediaFile, Buffer.from('payload'))
  delete process.env.MOHDEL_MEDIA_ROOTS
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.MOHDEL_MEDIA_ROOTS
})

const uri = (p) => `file://${p}`

describe('mediaScheme', () => {
  test('classifies the three supported schemes', () => {
    expect(mediaScheme('https://example.com/a.png')).toBe('remote')
    expect(mediaScheme('http://example.com/a.png')).toBe('remote')
    expect(mediaScheme('data:image/png;base64,AAA')).toBe('data')
    expect(mediaScheme('file:///tmp/a.png')).toBe('file')
  })

  test('a bare filesystem path is not a supported scheme', () => {
    expect(mediaScheme('/etc/passwd')).toBe('unknown')
    expect(mediaScheme('./relative.png')).toBe('unknown')
  })

  test('non-string and empty input is unknown', () => {
    expect(mediaScheme(undefined)).toBe('unknown')
    expect(mediaScheme('')).toBe('unknown')
    expect(mediaScheme(42)).toBe('unknown')
  })
})

describe('dataUriPayload', () => {
  test('returns everything after the first comma', () => {
    expect(dataUriPayload('data:image/png;base64,AAAB', TYPE)).toBe('AAAB')
  })

  test('a data URI without a comma throws typed', async () => {
    expect(() => dataUriPayload('data:image/png;base64', TYPE))
      .toThrow(/malformed data URI/)
  })
})

describe('resolveLocalMedia', () => {
  test('resolves a regular file and reports its size', async () => {
    const out = await resolveLocalMedia(uri(mediaFile), { type: TYPE, trusted: true })
    expect(out.path).toBe(fs.realpathSync(mediaFile))
    expect(out.size).toBe(7)
  })

  test('percent-encoded paths decode correctly', async () => {
    const spaced = path.join(tmpDir, 'with space.bin')
    fs.writeFileSync(spaced, Buffer.from('x'))
    const out = await resolveLocalMedia(`file://${tmpDir}/with%20space.bin`, { type: TYPE, trusted: true })
    expect(out.path).toBe(fs.realpathSync(spaced))
  })

  test('a missing file throws typed rather than a bare fs error', async () => {
    await expect(
      resolveLocalMedia(uri(path.join(tmpDir, 'nope.bin')), { type: TYPE, trusted: true })
    ).rejects.toMatchObject({ typed: { type: TYPE, retryable: false } })
  })

  test('a directory is rejected — not a regular file', async () => {
    await expect(
      resolveLocalMedia(uri(tmpDir), { type: TYPE, trusted: true })
    ).rejects.toThrow(/not a regular file/)
  })

  test('a character device is rejected even though it reports size 0', async () => {
    if (!fs.existsSync('/dev/zero')) return
    expect(fs.statSync('/dev/zero').size).toBe(0)
    await expect(
      resolveLocalMedia('file:///dev/zero', { type: TYPE, trusted: true })
    ).rejects.toThrow(/not a regular file/)
  })

  test('a file over maxBytes is rejected', async () => {
    await expect(
      resolveLocalMedia(uri(mediaFile), { type: TYPE, trusted: true, maxBytes: 3 })
    ).rejects.toThrow(/exceeds the size limit/)
  })

  test('a file at exactly maxBytes is accepted', async () => {
    const out = await resolveLocalMedia(uri(mediaFile), { type: TYPE, trusted: true, maxBytes: 7 })
    expect(out.size).toBe(7)
  })

  test('default cap is generous enough for ordinary media', () => {
    expect(MEDIA_MAX_BYTES).toBeGreaterThan(20 * 1024 * 1024)
  })
})

describe('resolveLocalMedia — MOHDEL_MEDIA_ROOTS confinement', () => {
  test('unset roots deny an untrusted caller outright', async () => {
    await expect(
      resolveLocalMedia(uri(mediaFile), { type: TYPE })
    ).rejects.toThrow(/not permitted/)
  })

  test('unset roots leave a trusted caller unconfined', async () => {
    const out = await resolveLocalMedia(uri(mediaFile), { type: TYPE, trusted: true })
    expect(out.size).toBe(7)
  })

  test('configured roots confine a trusted caller too', async () => {
    process.env.MOHDEL_MEDIA_ROOTS = path.join(tmpDir, 'nowhere')
    await expect(
      resolveLocalMedia(uri(mediaFile), { type: TYPE, trusted: true })
    ).rejects.toThrow(/outside the permitted directories/)
  })

  test('a file inside a configured root is allowed', async () => {
    process.env.MOHDEL_MEDIA_ROOTS = tmpDir
    const out = await resolveLocalMedia(uri(mediaFile), { type: TYPE })
    expect(out.path).toBe(fs.realpathSync(mediaFile))
    expect(out.size).toBe(7)
  })

  test('a file outside every configured root is denied', async () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mohdel-other-'))
    try {
      process.env.MOHDEL_MEDIA_ROOTS = otherDir
      await expect(
        resolveLocalMedia(uri(mediaFile), { type: TYPE })
      ).rejects.toThrow(/outside the permitted directories/)
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true })
    }
  })

  test('traversal out of a root is denied after resolution', async () => {
    const inner = path.join(tmpDir, 'inner')
    fs.mkdirSync(inner)
    process.env.MOHDEL_MEDIA_ROOTS = inner
    await expect(
      resolveLocalMedia(`file://${inner}/../asset.bin`, { type: TYPE })
    ).rejects.toThrow(/outside the permitted directories/)
  })

  test('a symlink pointing outside a root is denied', async () => {
    const inner = path.join(tmpDir, 'inner')
    fs.mkdirSync(inner)
    const outside = path.join(tmpDir, 'secret.bin')
    fs.writeFileSync(outside, Buffer.from('secret'))
    fs.symlinkSync(outside, path.join(inner, 'link.bin'))

    process.env.MOHDEL_MEDIA_ROOTS = inner
    await expect(
      resolveLocalMedia(uri(path.join(inner, 'link.bin')), { type: TYPE })
    ).rejects.toThrow(/outside the permitted directories/)
  })

  test('a sibling directory sharing a name prefix is not treated as inside', async () => {
    const root = path.join(tmpDir, 'media')
    const sibling = path.join(tmpDir, 'media-evil')
    fs.mkdirSync(root)
    fs.mkdirSync(sibling)
    const planted = path.join(sibling, 'a.bin')
    fs.writeFileSync(planted, Buffer.from('x'))

    process.env.MOHDEL_MEDIA_ROOTS = root
    await expect(
      resolveLocalMedia(uri(planted), { type: TYPE })
    ).rejects.toThrow(/outside the permitted directories/)
  })

  test('multiple roots are honored', async () => {
    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'mohdel-second-'))
    try {
      process.env.MOHDEL_MEDIA_ROOTS = `${second}${path.delimiter}${tmpDir}`
      const out = await resolveLocalMedia(uri(mediaFile), { type: TYPE })
      expect(out.size).toBe(7)
    } finally {
      fs.rmSync(second, { recursive: true, force: true })
    }
  })
})

describe('readLocalMedia', () => {
  test('returns the resolved path alongside the bytes', async () => {
    const out = await readLocalMedia(uri(mediaFile), { type: TYPE, trusted: true })
    expect(out.bytes.toString('utf8')).toBe('payload')
    expect(out.path).toBe(fs.realpathSync(mediaFile))
  })

  test('confinement applies to the read path too', async () => {
    process.env.MOHDEL_MEDIA_ROOTS = path.join(tmpDir, 'nowhere')
    await expect(
      readLocalMedia(uri(mediaFile), { type: TYPE })
    ).rejects.toThrow(/outside the permitted directories/)
  })
})

describe('loadImage honors the media policy', () => {
  test('a confined image outside the root yields a typed error', async () => {
    process.env.MOHDEL_MEDIA_ROOTS = path.join(tmpDir, 'nowhere')
    await expect(
      loadImage({ fileUri: uri(mediaFile), mimeType: 'image/png' })
    ).rejects.toMatchObject({ typed: { type: 'SESSION_INVALID_IMAGE' } })
  })

  test('an unreadable image carries a typed error, not a network error', async () => {
    await expect(
      loadImage({ fileUri: uri(path.join(tmpDir, 'ghost.png')), mimeType: 'image/png' })
    ).rejects.toMatchObject({ typed: { type: 'SESSION_INVALID_IMAGE' } })
  })
})

describe('trust mark', () => {
  test('an envelope parsed from the wire can never carry it', async () => {
    const wire = JSON.parse(JSON.stringify({
      callId: 'c1',
      authId: 'a1',
      auth: { key: 'k' },
      model: 'anthropic/claude-sonnet-4-5',
      prompt: 'hi',
      trustedMedia: true,
      'mohdel.trustedMedia': true,
      __proto__: { trustedMedia: true }
    }))
    expect(isTrustedMedia(wire)).toBe(false)
  })

  test('survives the object spread run.js applies when splitting :effort', () => {
    const marked = markTrustedMedia({ model: 'anthropic/claude-sonnet-4-5:max' })
    const respread = { ...marked, model: 'anthropic/claude-sonnet-4-5' }
    expect(isTrustedMedia(respread)).toBe(true)
  })

  test('does not survive a JSON round trip', () => {
    const marked = markTrustedMedia({ model: 'anthropic/x', prompt: 'hi' })
    expect(isTrustedMedia(JSON.parse(JSON.stringify(marked)))).toBe(false)
  })

  test('is absent on a plain object', () => {
    expect(isTrustedMedia({})).toBe(false)
    expect(isTrustedMedia(null)).toBe(false)
    expect(isTrustedMedia(undefined)).toBe(false)
  })
})
