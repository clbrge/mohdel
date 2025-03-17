import { GoogleGenerativeAI } from '@google/generative-ai'

const Provider = (defaultConfiguration) => {
  const $ = {}

  const genAI = new GoogleGenerativeAI(defaultConfiguration.apiKey)

  $.call = (model, configuration = {}, type = 'chat') => ({ msg, ...args }) => {
    const api = Object.keys(configuration).length ? new GoogleGenerativeAI(configuration.apiKey) : genAI
    const chat = api.getGenerativeModel({ model }).startChat(args)
    return chat.sendMessage(msg)
  }

  $.listModels = async () => {
    try {
      // Gemini SDK doesn't have a direct listModels method
      // Return a hardcoded list of available models
      return {
        models: [
          { id: 'gemini-pro' },
          { id: 'gemini-pro-vision' },
          { id: 'gemini-ultra' }
        ]
      }
    } catch (err) {
      console.error('Error listing Gemini models:', err.message)
      return { models: [] }
    }
  }

  return Object.freeze($)
}

export default Provider
