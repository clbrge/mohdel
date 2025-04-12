import OpenAI from 'openai'
import { translateModelInfo } from './utils.js'

const Provider = (defaultConfiguration) => {
  const api = new OpenAI(defaultConfiguration)
  
  // Property name translations (empty for now)
  const infoTranslate = {}

  return {
    completion: (model) => async (prompt) => {
      try {
        const response = await api.chat.completions.create({
          model,
          messages: [{ role: 'user', content: prompt }]
        })
        return response.choices[0].message.content
      } catch (err) {
        console.error('Error calling openai sdk:', err.message)
        throw err
      }
    },
    
    getEmbeddings: (model = 'text-embedding-ada-002') => async (inputs) => {
      try {
        const { data } = await api.embeddings.create({
          input: inputs,
          model
        })
        return data
      } catch (err) {
        console.error('Error getting embeddings from (openai sdk):', err.message)
        throw err
      }
    },
    
    getModelInfo: async (model) => {
      try {
        const modelInfo = await api.models.retrieve(model)
        return translateModelInfo(modelInfo, infoTranslate)
      } catch (err) {
        console.error('Error retrieving model info (openai sdk):', err.message)
        return null
      }
    },
    
    listModels: async () => {
      try {
        const models = await api.models.list()
        return models
      } catch (err) {
        console.error('Error listing (openai sdk) models:', err.message)
        return { data: [] }
      }
    }
  }
}

export default Provider
