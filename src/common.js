import * as dotenv from 'dotenv'

const loadDefaultEnv = () => {
  try {
    const defaultEnvironmentPath = join(homedir(), '.mohdel', 'environment')
    if (existsSync(defaultEnvironmentPath)) {
      dotenv.config({ path: defaultEnvironmentPath })
    }
  } catch (err) {
    console.warn(`Failed to load default parameters: ${err.message}`)
  }
  return {}
}

loadDefaultEnv()

export const getAPIKey = (envVarName) => {
  if (process.env[envVarName]) {
    return process.env[envVarName]
  }
  return null
}
