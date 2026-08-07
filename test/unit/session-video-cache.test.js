import fs from 'node:fs'
import path from 'node:path'
import { describe, test, expect, beforeEach, afterAll, vi } from 'vitest'

const dirs = vi.hoisted(() => {
  const os = require('node:os')
  const path = require('node:path')
  const fs = require('node:fs')
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'mohdel-vcache-'))
  return { cache, config: cache, data: cache, log: cache, temp: cache }
})

vi.mock('env-paths', () => ({ default: () => dirs }))

const { getCachedFile, setCachedFile } = await import('../../js/session/adapters/_videos.js')

const CACHE_PATH = path.join(dirs.cache, 'uploaded-files.json')
const readCache = () => JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'))
const writeCache = (obj) => fs.writeFileSync(CACHE_PATH, JSON.stringify(obj))

let videoPath

beforeEach(() => {
  fs.rmSync(CACHE_PATH, { force: true })
  videoPath = path.join(dirs.cache, 'clip.mp4')
  fs.writeFileSync(videoPath, Buffer.from([1, 2, 3, 4]))
})

afterAll(() => { fs.rmSync(dirs.cache, { recursive: true, force: true }) })

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString()
const HOUR = 60 * 60 * 1000

describe('video upload cache', () => {
  test('a fresh entry round-trips', async () => {
    await setCachedFile(videoPath, { uri: 'files/abc' }, 'gemini')
    const hit = await getCachedFile(videoPath, 'gemini')
    expect(hit?.data).toEqual({ uri: 'files/abc' })
  })

  test('an entry past the TTL is not returned', async () => {
    await setCachedFile(videoPath, { uri: 'files/stale' }, 'gemini')
    const cache = readCache()
    const [key] = Object.keys(cache)
    cache[key].cachedAt = iso(25 * HOUR)
    writeCache(cache)

    expect(await getCachedFile(videoPath, 'gemini')).toBeUndefined()
  })

  test('an entry inside the TTL survives', async () => {
    await setCachedFile(videoPath, { uri: 'files/recent' }, 'gemini')
    const cache = readCache()
    const [key] = Object.keys(cache)
    cache[key].cachedAt = iso(23 * HOUR)
    writeCache(cache)

    expect((await getCachedFile(videoPath, 'gemini'))?.data).toEqual({ uri: 'files/recent' })
  })

  test('expired entries are dropped from the file on the next write', async () => {
    const stale = {}
    for (let i = 0; i < 20; i++) {
      stale[`gemini:old${i}`] = { hash: `old${i}`, data: {}, filePath: '/x', provider: 'gemini', cachedAt: iso(48 * HOUR) }
    }
    writeCache(stale)

    await setCachedFile(videoPath, { uri: 'files/new' }, 'gemini')

    const keys = Object.keys(readCache())
    expect(keys.filter(k => k.startsWith('gemini:old'))).toHaveLength(0)
    expect(keys).toHaveLength(1)
  })

  test('the entry count is capped, keeping the most recent', async () => {
    const many = {}
    for (let i = 0; i < 600; i++) {
      many[`gemini:k${i}`] = {
        hash: `k${i}`,
        data: { uri: `files/${i}` },
        filePath: '/x',
        provider: 'gemini',
        // Higher i == more recent.
        cachedAt: iso((600 - i) * 1000)
      }
    }
    writeCache(many)

    await setCachedFile(videoPath, { uri: 'files/newest' }, 'gemini')

    const keys = Object.keys(readCache())
    expect(keys.length).toBeLessThanOrEqual(500)
    expect(keys).toContain('gemini:k599')
    expect(keys).not.toContain('gemini:k0')
  })

  test('a corrupt cache file degrades to a miss, not a throw', async () => {
    writeCache('not-an-object')
    fs.writeFileSync(CACHE_PATH, '{ broken')
    await expect(getCachedFile(videoPath, 'gemini')).resolves.toBeUndefined()
  })
})
