import * as dotenv from 'dotenv'
import { join } from 'path'
import { homedir } from 'os'
import { existsSync } from 'fs'
import { readFile, writeFile, mkdir } from 'fs/promises'

// Base configuration directory in user's home folder
export const CONFIG_DIR = join(homedir(), '.mohdel')
export const CONFIG_PATH = join(CONFIG_DIR, 'default.json')
export const ENV_PATH = join(CONFIG_DIR, 'environment')

// Load environment variables from .env files
const loadDefaultEnv = () => {
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

// Get default model ID from configuration
export const getDefaultModelId = async () => {
  const config = await getConfig()
  
  if (config.defaultModel) {
    return config.defaultModel
  }
  
  throw new Error('No default model configured. Run \'npx mohdel\' to set up a default model.')
}