import { createChatGPT } from '../../../js/chatgpt/index.js'
import { discoverModels, visibleModels } from '../../../js/chatgpt/models.js'

export default (configuration = {}) => {
  const auth = createChatGPT()
  let models
  const load = async () => {
    models ??= configuration.apiKey
      ? visibleModels(await discoverModels(configuration.apiKey))
      : await auth.models()
    return models
  }
  return {
    listModels: async () => (await load()).map(m => ({ id: m.model, label: m.label })),
    getModelInfo: async id => {
      const model = (await load()).find(m => m.model === id)
      return model ? { model: id, label: model.label, creator: 'openai', inputPrice: 0, outputPrice: 0 } : null
    }
  }
}
