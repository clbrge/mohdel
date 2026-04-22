import { join } from 'path'
import { existsSync } from 'fs'
import { readFile, writeFile, mkdir, copyFile, stat } from 'fs/promises'
import envPaths from 'env-paths'
import { validate, stripComputed } from './schema.js'
import { silent } from './logger.js'

// Module-level logger — set by mohdel factory via setLogger().
// Defaults to silent so file-load operations don't spam console when imported standalone.
let moduleLogger = silent
export const setLogger = (logger) => { moduleLogger = logger || silent }

export const CONFIG_DIR = envPaths('mohdel', { suffix: null }).config
export const CONFIG_PATH = join(CONFIG_DIR, 'default.json')
export const CURATED_PATH = join(CONFIG_DIR, 'curated.json')
export const EXCLUDED_PATH = join(CONFIG_DIR, 'excluded.json')
export const PROVIDERS_CONFIG_PATH = join(CONFIG_DIR, 'providers.json')
export const ENV_PATH = join(CONFIG_DIR, 'environment')

const DEFAULT_CURATED = {}

const DEFAULT_EXCLUDED = {}

export const loadEnvFile = (envPath) => {
  try {
    process.loadEnvFile(envPath)
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err
    }
  }
}

export const loadDefaultEnv = () => {
  loadEnvFile(ENV_PATH)
}

export const getAPIKey = (envVarName) => {
  if (process.env[envVarName]) {
    return process.env[envVarName]
  }
  return null
}

const sortObjectKeys = (obj) => {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj

  return Object.keys(obj)
    .sort()
    .reduce((sorted, key) => {
      sorted[key] = obj[key]
      return sorted
    }, {})
}

// 3-slot backup rotation: .prev (every save), .daily (first save of the day), .weekly (first save of the week)
const getWeek = (ms) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-W${String(Math.ceil((d.getDate() + new Date(d.getFullYear(), d.getMonth(), 1).getDay()) / 7)).padStart(2, '0')}-${d.getMonth()}`
}

const rotateBackup = async (filePath) => {
  if (!existsSync(filePath)) return

  const prev = filePath + '.prev'
  const daily = filePath + '.daily'
  const weekly = filePath + '.weekly'

  try {
    // Always: current → .prev
    await copyFile(filePath, prev)

    // First save of new day: .prev → .daily
    const prevMtime = (await stat(prev)).mtimeMs
    const dailyMtime = existsSync(daily) ? (await stat(daily)).mtimeMs : 0
    if (new Date(prevMtime).toDateString() !== new Date(dailyMtime).toDateString()) {
      await copyFile(prev, daily)
    }

    // First save of new week: .daily → .weekly
    if (existsSync(daily)) {
      const dMtime = (await stat(daily)).mtimeMs
      const wMtime = existsSync(weekly) ? (await stat(weekly)).mtimeMs : 0
      if (getWeek(dMtime) !== getWeek(wMtime)) {
        await copyFile(daily, weekly)
      }
    }
  } catch (err) {
    moduleLogger.warn(`[mohdel:common] backup rotation failed: ${err.message}`)
  }
}

export const BACKUP_SLOTS = ['prev', 'daily', 'weekly']

const createFileOperation = (filePath, defaultValue = {}, operationType) => {
  const loadHandler = async () => {
    let loadedData
    try {
      if (!existsSync(CONFIG_DIR)) {
        await mkdir(CONFIG_DIR, { recursive: true })
      }

      if (!existsSync(filePath)) {
        if (defaultValue && Object.keys(defaultValue).length > 0) {
          await writeFile(filePath, JSON.stringify(defaultValue, null, 2))
          loadedData = JSON.parse(JSON.stringify(defaultValue))
        } else {
          loadedData = {}
        }
      } else {
        const fileContent = await readFile(filePath, 'utf8')
        loadedData = JSON.parse(fileContent)
      }

      if (typeof loadedData === 'object' && loadedData !== null && !Array.isArray(loadedData)) {
        const processedData = {}
        for (const [key, entryValue] of Object.entries(loadedData)) {
          if (typeof entryValue !== 'object' || entryValue === null || Array.isArray(entryValue)) {
            processedData[key] = entryValue
            continue
          }
          const entry = { ...entryValue }
          const upstreamIds = []
          if (entry.model) {
            upstreamIds.push(entry.model)
          }
          if (entry.aliases && Array.isArray(entry.aliases) && entry.aliases.length > 0) {
            upstreamIds.push(...entry.aliases)
          }
          processedData[key] = { ...entry, upstreamIds }
        }

        if (operationType === 'curated models') {
          for (const [curatedKey, entry] of Object.entries(processedData)) {
            const issues = validate(entry, curatedKey)
            for (const issue of issues) {
              moduleLogger.warn(`[mohdel:schema] ${curatedKey}: ${issue.field} — ${issue.message}`)
            }
          }
        }

        return processedData
      }

      return loadedData
    } catch (err) {
      moduleLogger.warn(`[mohdel:common] failed to load ${operationType}: ${err.message}`)
      return JSON.parse(JSON.stringify(defaultValue || {}))
    }
  }

  const saveHandler = async (data) => {
    try {
      if (!existsSync(CONFIG_DIR)) {
        await mkdir(CONFIG_DIR, { recursive: true })
      }

      await rotateBackup(filePath)

      let dataToSave = data
      if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
        const cleanedData = {}
        for (const [key, entry] of Object.entries(data)) {
          cleanedData[key] = (typeof entry === 'object' && entry !== null && !Array.isArray(entry))
            ? stripComputed(entry)
            : entry
        }
        dataToSave = cleanedData
      }

      const sortedData = sortObjectKeys(dataToSave)
      await writeFile(filePath, JSON.stringify(sortedData, null, 2))
      return true
    } catch (err) {
      moduleLogger.error(`[mohdel:common] failed to save ${operationType}: ${err.message}`)
      if (operationType !== 'configuration') {
        throw new Error(`Failed to save ${operationType}: ${err.message}`)
      }
      return false
    }
  }

  return { load: loadHandler, save: saveHandler }
}

const configOps = createFileOperation(CONFIG_PATH, {}, 'configuration')
const curatedOps = createFileOperation(CURATED_PATH, DEFAULT_CURATED, 'curated models')
const excludedOps = createFileOperation(EXCLUDED_PATH, DEFAULT_EXCLUDED, 'excluded models')
const providersConfigOps = createFileOperation(PROVIDERS_CONFIG_PATH, {}, 'provider config')

export const getConfig = configOps.load
export const saveConfig = configOps.save
export const getCuratedModels = curatedOps.load
export const saveCuratedModels = curatedOps.save
export const getExcludedModels = excludedOps.load
export const saveExcludedModels = excludedOps.save
export const getProvidersConfig = providersConfigOps.load
export const saveProvidersConfig = providersConfigOps.save

export const getDefaultModelId = async () => {
  const config = await getConfig()

  if (config.defaultModel) {
    return config.defaultModel
  }

  throw new Error('No default model configured. Run \'mo default\' to set up a default model.')
}
