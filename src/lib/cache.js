import { createHash } from 'crypto'
import { join } from 'path'
import { readFile, writeFile, mkdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import envPaths from 'env-paths'
import { silent } from './logger.js'

export const CACHE_DIR = envPaths('mohdel', { suffix: null }).cache
export const FILE_CACHE_PATH = join(CACHE_DIR, 'uploaded-files.json')

const ensureCacheDir = async () => {
  if (!existsSync(CACHE_DIR)) {
    await mkdir(CACHE_DIR, { recursive: true })
  }
}

const createFileHash = async (filePath) => {
  const data = await readFile(filePath)
  const stats = await stat(filePath)
  const hash = createHash('sha256')
  hash.update(data)
  hash.update(filePath)
  hash.update(stats.mtime.toISOString())
  return hash.digest('hex')
}

export const loadFileCache = async (logger = silent) => {
  try {
    await ensureCacheDir()
    if (!existsSync(FILE_CACHE_PATH)) {
      return {}
    }
    const content = await readFile(FILE_CACHE_PATH, 'utf8')
    return JSON.parse(content)
  } catch (err) {
    logger.warn({ err }, '[mohdel:cache] failed to load file cache')
    return {}
  }
}

export const saveFileCache = async (cache, logger = silent) => {
  try {
    await ensureCacheDir()
    await writeFile(FILE_CACHE_PATH, JSON.stringify(cache, null, 2))
  } catch (err) {
    logger.error({ err }, '[mohdel:cache] failed to save file cache')
  }
}

export const getCachedFileData = async (filePath, provider = 'gemini', logger = silent) => {
  try {
    const hash = await createFileHash(filePath)
    const cache = await loadFileCache(logger)
    return cache[`${provider}:${hash}`]
  } catch (err) {
    logger.warn({ err }, '[mohdel:cache] failed to get cached file ID')
    return null
  }
}

export const setCachedFileData = async (filePath, data, provider = 'gemini', logger = silent) => {
  try {
    const hash = await createFileHash(filePath)
    const cache = await loadFileCache(logger)
    cache[`${provider}:${hash}`] = {
      hash,
      data,
      filePath,
      provider,
      cachedAt: new Date().toISOString()
    }
    await saveFileCache(cache, logger)
  } catch (err) {
    logger.error({ err }, '[mohdel:cache] failed to set cached file data')
  }
}
