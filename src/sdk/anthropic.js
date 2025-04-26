import Anthropic from '@anthropic-ai/sdk'
import { translateModelInfo } from './utils.js'

const anthropicSDK = (defaultConfiguration, specs) => {
  const anthropic = new Anthropic(defaultConfiguration)

  const infoTranslate = {
    display_name: 'displayName',
    created_at: 'createdAt'
  }

  return {
    answer: (modelName, configuration) => async (input, options) => {
      const api = configuration ? new Anthropic({ ...defaultConfiguration, ...configuration }) : anthropic
      const { model, outputTokenLimit } = specs[modelName]
      try {
        if (options.outputBudget > outputTokenLimit) {
          options.outputBudget = outputTokenLimit
        }
        const args = {
          model,
          temperature: 0,
          max_tokens: options.outputBudget || outputTokenLimit,
          messages: [
            { role: 'user', content: input }
          ]
        }
        if (options.identifier) {
          args.metadata = { user_id: options.identifier }
        }
        // The minimum budget is 1,024 tokens.
        // Streaming is required when max_tokens is greater than 21,333.
        // args.thinking = {
        //   type: "enabled",
        //   budget_tokens: 0
        // }
        const { content, usage } = await api.messages.create(args)
        return {
          output: content[0].text.trim(),
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          thinkingTokens: 0
        }
      } catch (err) {
        console.error('Error calling answer (anthropic sdk)', err.message)
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
