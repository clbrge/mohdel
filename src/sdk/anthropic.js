import Anthropic from '@anthropic-ai/sdk'

const anthropicSDK = (config) => {
  const anthropic = new Anthropic(config)

  return {
    completion: (modelName) => async (prompt) => {
      try {
        const response = await anthropic.messages.create({
          model: modelName,
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }]
        })

        return response.content[0].text
      } catch (err) {
        console.error('Error calling Anthropic API:', err.message)
        throw err
      }
    },
    
    listModels: async (options = {}) => {
      try {
        const response = await anthropic.models.list(options)
        return response
      } catch (err) {
        console.error('Error listing Anthropic models:', err.message)
        return { data: [] }
      }
    },
    
    getModelInfo: async (modelName) => {
      try {
        const models = await anthropic.models.list()
        return models.data.find(model => model.id === modelName)
      } catch (err) {
        console.error('Error retrieving Anthropic model info:', err.message)
        return null
      }
    }
  }
}

export default anthropicSDK