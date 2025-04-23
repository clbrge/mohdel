import Anthropic from '@anthropic-ai/sdk'
import { translateModelInfo } from './utils.js'

const anthropicSDK = (config) => {
  const anthropic = new Anthropic(config)

  const infoTranslate = {
    display_name: 'displayName',
    created_at: 'createdAt'
  }

  const format = queue => {
    const compactQueue = []
    let system = ''
    let currentRole
    let currentContent = ''
    for (const { role, content } of queue) {
      if (role === 'system') {
        system += content + '\n'
        continue
      }
      if (currentRole === role) {
        currentContent += content + '\n'
        continue
      }
      if (currentContent) {
        compactQueue.push({ role: currentRole, content: currentContent })
      }
      currentRole = role
      currentContent = content + '\n'
    }
    if (currentContent) {
      compactQueue.push({ role: currentRole, content: currentContent })
    }
    return { system, messages: compactQueue }
  }

  return {
    chat: (model) => async (content) => {
      const messages = typeof content === 'string' ? [{ role: 'user', content }] : format(content)
      try {
        const data = await anthropic.messages.create({ model, messages })
        return {
          output: data.choices[0].message.content.trim(),
          inputTokens: data.usage.prompt_tokens,
          outputTokens: data.usage.completion_tokens,
          thinkingTokens: 0
        }
      } catch (err) {
        console.error('Error calling openai sdk:', err.message)
        throw err
      }
    },

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
        const model = await anthropic.models.retrieve(modelName)
        return translateModelInfo(model, infoTranslate)
      } catch (err) {
        console.error('Error retrieving Anthropic model info:', err.message)
        return null
      }
    }
  }
}

export default anthropicSDK
