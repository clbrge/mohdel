import { GoogleGenAI } from '@google/genai'

const Provider = (defaultConfiguration) => {
  const $ = {}

  const ai = new GoogleGenAI(defaultConfiguration.apiKey)

  $.call = (model, configuration = {}, type = 'chat') => ({ msg, ...args }) => {
    const api = Object.keys(configuration).length ? new GoogleGenAI(configuration.apiKey) : ai
    const chat = api.getGenerativeModel({ model }).startChat(args)
    return chat.sendMessage(msg)
  }

  $.listModels = async () => {
    try {
      const apiKey = defaultConfiguration.apiKey
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
      const response = await fetch(url)
      
      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`)
      }
      const { models } = await response.json()
      return models.map(details => ({ id: details.name.replace('models/',''), label: details.displayName, ...details}) )
    } catch (err) {
      console.error('Error listing Gemini models:', err.message)
      return { models: [] }
    }
  }

  return Object.freeze($)
}

export default Provider
