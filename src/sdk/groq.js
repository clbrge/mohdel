import Groq from 'groq-sdk'
import { translateModelInfo } from './utils.js'

const Provider = (defaultConfiguration) => {
  const $ = {}

  const groq = new Groq(defaultConfiguration)

  const infoTranslate = {
    max_completion_tokens: 'outputTokenLimit',
    context_window: 'inputTokenLimit'
  }

  const format = (queue) => {
    queue = queue.map(({ role, content }) => ({ role, content }))
    return queue
  }

  $.chat = (model) => async (content) => {
    const messages = typeof content === 'string' ? [{ role: 'user', content }] : format(content)
    try {
      const data = await groq.chat.completions.create({ model, messages })
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
  }

  $.call = (model, configuration = {}, type = 'chat') => args => {
    const api = Object.keys(configuration).length ? new Groq(configuration) : groq
    return api.chat.completions.create({ ...args, model })
  }

  $.listModels = async () => {
    try {
      return await groq.models.list()
    } catch (err) {
      console.error('Error listing Groq models:', err.message)
      return []
    }
  }

  $.getModelInfo = async (model) => {
    try {
      const modelInfo = await groq.models.retrieve(model)
      return translateModelInfo(modelInfo, infoTranslate)
    } catch (err) {
      console.error('Error retrieving Groq model info:', err.message)
      return null
    }
  }

  return Object.freeze($)
}

export default Provider
