import * as dotenv from 'dotenv'
import { join } from 'path'
import { existsSync } from 'fs'
import { readFile, writeFile, mkdir } from 'fs/promises'
import envPaths from 'env-paths'

export const CONFIG_DIR = envPaths('mohdel', { suffix: null }).config
export const CONFIG_PATH = join(CONFIG_DIR, 'default.json')
export const CURATED_PATH = join(CONFIG_DIR, 'curated.json')
export const EXCLUDED_PATH = join(CONFIG_DIR, 'excluded.json')
export const ENV_PATH = join(CONFIG_DIR, 'environment')

// Default curated and excluded models
const DEFAULT_CURATED = {
  "anthropic/claude-3-5-sonnet-20240620": {
    "label": "Claude 3.5 Sonnet"
  },
  "anthropic/claude-3-opus-20240229": {
    "label": "Claude 3 Opus"
  },
  "anthropic/claude-3-sonnet-20240229": {
    "label": "Claude 3 Sonnet"
  },
  "anthropic/claude-3-haiku-20240307": {
    "label": "Claude 3 Haiku"
  },
  "openai/gpt-4o": {
    "label": "GPT-4o"
  },
  "openai/gpt-4-turbo": {
    "label": "GPT-4 Turbo"
  },
  "openai/gpt-4": {
    "label": "GPT-4"
  },
  "openai/gpt-3.5-turbo": {
    "label": "GPT-3.5 Turbo"
  },
  "gemini/gemini-1.5-pro": {
    "label": "Gemini 1.5 Pro"
  },
  "gemini/gemini-1.5-flash": {
    "label": "Gemini 1.5 Flash"
  },
  "groq/llama3-70b-8192": {
    "label": "Llama3 70B"
  },
  "groq/mixtral-8x7b-32768": {
    "label": "Mixtral 8x7B"
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

// Get configuration from config file
export const getConfig = async () => {
  try {
    if (!existsSync(CONFIG_PATH)) {
      return {}
    }
    
    const configData = await readFile(CONFIG_PATH, 'utf8')
    return JSON.parse(configData)
  } catch (err) {
    console.warn(`Failed to load configuration: ${err.message}`)
    return {}
  }
}

// Save configuration to config file
export const saveConfig = async (config) => {
  try {
    if (!existsSync(CONFIG_DIR)) {
      await mkdir(CONFIG_DIR, { recursive: true })
    }
    
    await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2))
    return true
  } catch (err) {
    console.error(`Failed to save configuration: ${err.message}`)
    return false
  }
}

// Get default curated models
export const getCuratedModels = async () => {
  try {
    if (!existsSync(CONFIG_DIR)) {
      await mkdir(CONFIG_DIR, { recursive: true })
    }

    if (!existsSync(CURATED_PATH)) {
      // Use default curated models if no file exists
      await saveCuratedModels(DEFAULT_CURATED)
      return DEFAULT_CURATED
    }
    
    const data = await readFile(CURATED_PATH, 'utf8')
    return JSON.parse(data)
  } catch (err) {
    console.warn(`Failed to load curated models: ${err.message}`)
    // Fall back to default curated models
    return DEFAULT_CURATED
  }
}

// Save curated models to config directory
export const saveCuratedModels = async (models) => {
  try {
    if (!existsSync(CONFIG_DIR)) {
      await mkdir(CONFIG_DIR, { recursive: true })
    }
    
    await writeFile(CURATED_PATH, JSON.stringify(models, null, 2))
    return true
  } catch (err) {
    console.error(`Failed to save curated models: ${err.message}`)
    throw new Error(`Failed to save curated models: ${err.message}`)
  }
}

// Get excluded models
export const getExcludedModels = async () => {
  try {
    if (!existsSync(CONFIG_DIR)) {
      await mkdir(CONFIG_DIR, { recursive: true })
    }

    if (!existsSync(EXCLUDED_PATH)) {
      // Use default excluded models if no file exists
      await saveExcludedModels(DEFAULT_EXCLUDED)
      return DEFAULT_EXCLUDED
    }
    
    const data = await readFile(EXCLUDED_PATH, 'utf8')
    return JSON.parse(data)
  } catch (err) {
    console.warn(`Failed to load excluded models: ${err.message}`)
    // Fall back to default excluded models
    return DEFAULT_EXCLUDED
  }
}

// Save excluded models to config directory
export const saveExcludedModels = async (models) => {
  try {
    if (!existsSync(CONFIG_DIR)) {
      await mkdir(CONFIG_DIR, { recursive: true })
    }
    
    await writeFile(EXCLUDED_PATH, JSON.stringify(models, null, 2))
    return true
  } catch (err) {
    console.error(`Failed to save excluded models: ${err.message}`)
    throw new Error(`Failed to save excluded models: ${err.message}`)
  }
}

// Get default model ID from configuration
export const getDefaultModelId = async () => {
  const config = await getConfig()
  
  if (config.defaultModel) {
    return config.defaultModel
  }
  
  throw new Error('No default model configured. Run \'npx mohdel\' to set up a default model.')
}