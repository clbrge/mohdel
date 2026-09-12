import { describe, test, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const dirs = vi.hoisted(() => {
  const os = require('node:os'); const path = require('node:path'); const fs = require('node:fs')
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'mohdel-atomic-'))
  fs.mkdirSync(path.join(config, 'mohdel'), { recursive: true })
  return { config: path.join(config, 'mohdel'), cache: config, data: config, log: config, temp: config }
})
vi.mock('env-paths', () => ({ default: () => dirs }))

// Simulates a write that dies after some bytes have landed.
const hook = vi.hoisted(() => ({ dieAfter: null }))
vi.mock('fs/promises', async (importOriginal) => {
  const real = await importOriginal()
  return {
    ...real,
    default: real.default,
    writeFile: async (file, contents, ...rest) => {
      if (hook.dieAfter === null) return real.writeFile(file, contents, ...rest)
      await real.writeFile(file, String(contents).slice(0, hook.dieAfter), ...rest)
      throw new Error('ENOSPC: simulated death mid-write')
    }
  }
})

const { getCuratedModels, saveCuratedModels, CURATED_PATH } = await import('../../src/lib/common.js')
const entry = id => ({ model: id, creator: 'openai', inputFormat: ['text'] })
const strays = () => fs.readdirSync(path.dirname(CURATED_PATH)).filter(f => f.endsWith('.tmp'))

describe('catalog writes survive a dead process', () => {
  test('a completed save leaves no temp file behind', async () => {
    await saveCuratedModels({ 'openai/a': entry('a') })
    expect(strays()).toEqual([])
    expect(Object.keys(await getCuratedModels())).toContain('openai/a')
  })

  test('a write that dies mid-stream leaves the catalog whole', async () => {
    await saveCuratedModels({ 'openai/a': entry('a'), 'openai/b': entry('b') })
    const before = fs.readFileSync(CURATED_PATH, 'utf8')

    hook.dieAfter = 40
    await expect(saveCuratedModels({ 'openai/c': entry('c') })).rejects.toThrow()
    hook.dieAfter = null

    expect(fs.readFileSync(CURATED_PATH, 'utf8')).toBe(before)
    expect(() => JSON.parse(fs.readFileSync(CURATED_PATH, 'utf8'))).not.toThrow()
    expect(strays()).toEqual([])
  })

  test('the backup is taken before the write, so .prev holds the last good copy', async () => {
    await saveCuratedModels({ 'openai/a': entry('a') })
    await saveCuratedModels({ 'openai/a': entry('a'), 'openai/b': entry('b') })
    const prev = JSON.parse(fs.readFileSync(CURATED_PATH + '.prev', 'utf8'))
    expect(Object.keys(prev)).not.toContain('openai/b')
  })
})
