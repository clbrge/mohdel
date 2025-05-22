import * as dotenv from 'dotenv'
import { join } from 'path'
import { existsSync } from 'fs'
import { readFile, writeFile, mkdir, copyFile } from 'fs/promises'
import envPaths from 'env-paths'

export const CONFIG_DIR = envPaths('mohdel', { suffix: null }).config
export const CONFIG_PATH = join(CONFIG_DIR, 'default.json')
export const CURATED_PATH = join(CONFIG_DIR, 'curated.json')
export const EXCLUDED_PATH = join(CONFIG_DIR, 'excluded.json')
export const ENV_PATH = join(CONFIG_DIR, 'environment')

// Default curated and excluded models
const DEFAULT_CURATED = {
  'anthropic/claude-3-5-sonnet-20240620': {
    label: 'Claude 3.5 Sonnet'
  },
  'anthropic/claude-3-opus-20240229': {
    label: 'Claude 3 Opus'
  },
  'anthropic/claude-3-sonnet-20240229': {
    label: 'Claude 3 Sonnet'
  },
  'anthropic/claude-3-haiku-20240307': {
    label: 'Claude 3 Haiku'
  },
  'openai/gpt-4o': {
    label: 'GPT-4o'
  },
  'openai/gpt-4-turbo': {
    label: 'GPT-4 Turbo'
  },
  'openai/gpt-4': {
    label: 'GPT-4'
  },
  'openai/gpt-3.5-turbo': {
    label: 'GPT-3.5 Turbo'
  },
  'gemini/gemini-1.5-pro': {
    label: 'Gemini 1.5 Pro'
  },
  'gemini/gemini-1.5-flash': {
    label: 'Gemini 1.5 Flash'
  },
  'groq/llama3-70b-8192': {
    label: 'Llama3 70B'
  },
  'groq/mixtral-8x7b-32768': {
    label: 'Mixtral 8x7B'
  }
}

const DEFAULT_EXCLUDED = {}

// Load environment variables from .env files
const loadDefaultEnv = () => {
  console.log(CONFIG_DIR)
  try {
    if (existsSync(ENV_PATH)) {
      dotenv.config({ path: ENV_PATH })
    }
  } catch (err) {
    console.warn(`Failed to load default parameters: ${err.message}`)
  }
  return {}
}

// Load environment variables at module initialization
loadDefaultEnv()

// Get API key from environment variables
export const getAPIKey = (envVarName) => {
  if (process.env[envVarName]) {
    return process.env[envVarName]
  }
  return null
}

// Sort object keys alphabetically (first level only)
const sortObjectKeys = (obj) => {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj

  return Object.keys(obj)
    .sort()
    .reduce((sorted, key) => {
      sorted[key] = obj[key]
      return sorted
    }, {})
}

// Create a backup of a file before modifying it
const createBackup = async (filePath) => {
  if (!existsSync(filePath)) return

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${filePath}.${timestamp}.bak`

  try {
    await copyFile(filePath, backupPath)
    console.log(`Backup created: ${backupPath}`)
    return backupPath
  } catch (err) {
    console.warn(`Failed to create backup of ${filePath}: ${err.message}`)
    return null
  }
}

// Higher-order function to create file handling operations
const createFileOperation = (filePath, defaultValue = {}, operationType) => {
  // Handler for loading data from a file
  const loadHandler = async () => {
    let loadedData
    try {
      if (!existsSync(CONFIG_DIR)) {
        await mkdir(CONFIG_DIR, { recursive: true })
      }

      if (!existsSync(filePath)) {
        if (defaultValue && Object.keys(defaultValue).length > 0) {
          await writeFile(filePath, JSON.stringify(defaultValue, null, 2))
          // Use a clone of defaultValue for subsequent processing to avoid mutating the original
          loadedData = JSON.parse(JSON.stringify(defaultValue))
        } else {
          loadedData = {}
        }
      } else {
        const fileContent = await readFile(filePath, 'utf8')
        loadedData = JSON.parse(fileContent)
      }

      if (operationType === 'curated models' && typeof loadedData === 'object' && loadedData !== null && !Array.isArray(loadedData)) {
        const processedData = {}
        for (const [key, entryValue] of Object.entries(loadedData)) {
          // Work with a copy of the entry to avoid modifying the objects from loadedData directly
          const entry = { ...entryValue }
          let coreIds

          // Rule 1: 'models' array takes precedence
          if (entry.models && Array.isArray(entry.models) && entry.models.length > 0 && entry.provider) {
            coreIds = entry.models.map(modelName => `${entry.provider}/${modelName}`)
          }
          // Rule 2: 'model' property
          else if (entry.model && entry.provider) {
            coreIds = [`${entry.provider}/${entry.model}`]
          }
          // Rule 3: Fallback to key
          else {
            coreIds = [key]
          }
          
          // Ensure coreIds is always a non-empty array (already handled by Rule 3 as fallback)
          processedData[key] = { ...entry, coreIds }
        }
        return processedData
      }

      return loadedData
    } catch (err) {
      console.warn(`Failed to load ${operationType}: ${err.message}`)
      // Return a clone of defaultValue on error
      return JSON.parse(JSON.stringify(defaultValue || {}))
    }
  }

  // Handler for saving data to a file
  const saveHandler = async (data) => {
    try {
      if (!existsSync(CONFIG_DIR)) {
        await mkdir(CONFIG_DIR, { recursive: true })
      }

      if (existsSync(filePath)) {
        await createBackup(filePath)
      }

      let dataToSave = data
      if (operationType === 'curated models' && typeof data === 'object' && data !== null && !Array.isArray(data)) {
        const cleanedData = {}
        for (const [key, entry] of Object.entries(data)) {
          const { coreIds, ...rest } = entry // Remove coreIds
          cleanedData[key] = rest
        }
        dataToSave = cleanedData
      }

      const sortedData = sortObjectKeys(dataToSave)
      await writeFile(filePath, JSON.stringify(sortedData, null, 2))
      return true
    } catch (err) {
      console.error(`Failed to save ${operationType}: ${err.message}`)
      if (operationType !== 'configuration') {
        throw new Error(`Failed to save ${operationType}: ${err.message}`)
      }
      return false
    }
  }

  return { load: loadHandler, save: saveHandler }
}

// Create file operations for different types of data
const configOps = createFileOperation(CONFIG_PATH, {}, 'configuration')
const curatedOps = createFileOperation(CURATED_PATH, DEFAULT_CURATED, 'curated models')
const excludedOps = createFileOperation(EXCLUDED_PATH, DEFAULT_EXCLUDED, 'excluded models')

// Get configuration from config file
export const getConfig = configOps.load

// Save configuration to config file
export const saveConfig = configOps.save

// Get default curated models
export const getCuratedModels = curatedOps.load

// Save curated models to config directory
export const saveCuratedModels = curatedOps.save

// Get excluded models
export const getExcludedModels = excludedOps.load

// Save excluded models to config directory
export const saveExcludedModels = excludedOps.save

// Get default model ID from configuration
export const getDefaultModelId = async () => {
  const config = await getConfig()

  if (config.defaultModel) {
    return config.defaultModel
  }

  throw new Error('No default model configured. Run \'npx mohdel\' to set up a default model.')
}