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
    }
  }
}

export default anthropicSDK
