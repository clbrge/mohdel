import { GoogleGenAI } from '@google/genai'
import { translateModelInfo } from './utils.js'

// documentation
// https://googleapis.github.io/js-genai/main/index.html

const Provider = (defaultConfiguration) => {
  const ai = new GoogleGenAI(defaultConfiguration)

  // Property name translations (empty for now)
  const infoTranslate = {}
  const format = queue => {
    const last = queue.pop()

    return {
      msg: last.content,
      history: queue.map(({ role, content }) => ({ role: role === 'assistant' ? 'model' : 'user', parts: [{ text: content }] }))
    }
  }

  return {
    responses: (model) => async (content) => {
      const messages = typeof content === 'string' ? [{ role: 'user', content }] : format(content)
      try {
        const data = await ai.models.generateContent({
          model,
          contents: prompt
        })

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

    completion: (model) => async (prompt) => {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: prompt
        })
        return response.text
      } catch (err) {
        console.error('Error calling GoogleGenAI:', err.message)
        throw err
      }
    },
    getModelInfo: async (model) => {
      try {
        const modelInfo = await ai.models.get({ model })
        return translateModelInfo(modelInfo, infoTranslate)
      } catch (err) {
        console.error('Error calling GoogleGenAI:', err.message)
        throw err
      }
    },
    listModels: async () => {
      try {
        const apiKey = defaultConfiguration.apiKey
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
        const response = await fetch(url)

        if (!response.ok) {
          throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`)
        }
        const { models } = await response.json()
        return models.map(details => ({ id: details.name.replace('models/', ''), label: details.displayName, ...details }))
      } catch (err) {
        console.error('Error listing Gemini models:', err.message)
        return { models: [] }
      }
    }
  }
}

export default Provider
