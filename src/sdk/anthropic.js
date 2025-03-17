import '@anthropic-ai/sdk/shims/web'
import Anthropic from '@anthropic-ai/sdk'

const Provider = (defaultConfiguration) => {
  const anthropic = new Anthropic(defaultConfiguration)

  const $ = {}

  $.call = (model, configuration = {}, type = 'chat') => args => {
    const api = Object.keys(configuration).length ? new Anthropic(configuration) : anthropic
    return api.messages.create({
      ...args,
      model
    })
  }

  $.listModels = async () => {
    const { data } = await anthropic.models.list({
      limit: 20
    })
    return data.map(model => ({ label: model.display_name, ...model }))
  }

  return Object.freeze($)
}

export default Provider
