import Groq from 'groq-sdk'

const Provider = (defaultConfiguration) => {
  const $ = {}

  const groq = new Groq(defaultConfiguration)

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

  return Object.freeze($)
}

export default Provider
