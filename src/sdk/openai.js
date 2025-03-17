import OpenAI from 'openai'

const Provider = (defaultConfiguration) => {
  const defaultApi = new OpenAI(defaultConfiguration)

  const $ = {}

  $.getEmbeddings = (
    model = 'text-embedding-ada-002'
  ) => async inputs => {
    const { data /* , usage  */ } = await defaultApi.embeddings.create({
      input: inputs,
      model: 'text-embedding-ada-002'
    })
    return data
  }

  $.call = (model, configuration = {}, type = 'chat') => args => {
    if (Object.keys(configuration).length && defaultConfiguration.baseURL) configuration.baseURL = defaultConfiguration.baseURL
    const api = Object.keys(configuration).length ? new OpenAI(configuration) : defaultApi
    return api.chat.completions.create({ ...args, model })
  }

  $.listModels = async () => {
    try {
      return await defaultApi.models.list()
    } catch (err) {
      console.error('Error listing OpenAI models:', err.message)
      return { data: [] }
    }
  }

  return Object.freeze($)
}

export default Provider
