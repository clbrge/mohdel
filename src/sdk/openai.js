import OpenAI from 'openai'
import { translateModelInfo } from './utils.js'

const Provider = (defaultConfiguration, specs) => {
  const openai = new OpenAI(defaultConfiguration)

  // important for xai
  const infoTranslate = {
    id: 'model',
  }

  const formatImages = images => {
    const list = []
    if (images && Array.isArray(images)) {
      for (const image of images) {
        if (!image || !image.data || !image.mimetype) continue
        list.push({
          type: 'image_url',
          image_url: `data:${image.mimetype};base64,${image.data}`,
          detail: 'high' // Use auto by default, could be made configurable
        })
      }
    }
    return list
  }

  const estimateImageTokens = (model, { mimetype, width, height, data }) => {
    // Check for openAI supported MIME types
    const supportedMimeTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
    if (!supportedMimeTypes.includes(mimetype)) {
      return Infinity // Return Infinity for unsupported types
    }
    if (['gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4.1'].includes(model)) {
      // For GPT-4.1 family models (mini, nano, standard)
      // They typically use approximately 2048 tokens per high-res image
      return 2048
    } else if (model === 'o4-mini') {
      // o4-mini uses a different token calculation
      // Estimated at 1792 tokens per standard image
      return 1792
    } else if (model === 'o3') {
      // o3 has its own token count for images
      return 2304
    } else if (model === 'o1-pro') {
      // o1-pro has higher image token usage
      return 2560
    }
    // Default to Infinity if model doesn't match known image-supporting models
    // or if the logic needs a fallback
    return Infinity
  }

  // todo use headers
  // https://platform.openai.com/docs/api-reference/debugging-requests
  const $ = {
    deepseekChatCompletion: (modelName, configuration) => async (input, options) => {
      const api = configuration ? new OpenAI({ ...defaultConfiguration, ...configuration }) : openai
      const { model, outputTokenLimit } = specs[modelName]
      try {
        if (options.outputBudget > outputTokenLimit) {
          options.outputBudget = outputTokenLimit
        }
        const args = {
          model,
          temperature: 0,
          // max tokens is without thinking effort tokens
          max_tokens: options.outputBudget || outputTokenLimit,
          messages: [
            { role: 'user', content: input }
          ]
        }
        // not yet available
        // if (thinkingEffortLevels) {
        // options.outputEffort ||= 'medium'
        // args.reasoning_effort = ?
        // }
        // temperature: 1,
        const { choices, usage } = await api.chat.completions.create(args)
        return {
          output: choices[0].message.content.trim(),
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens,
          thinkingTokens: usage.completion_tokens_details?.reasoning_tokens || 0
        }
      } catch (err) {
        console.error('Error calling deepseekChatCompletion (openai sdk)', err.message)
        throw err
      }
    }
  }

  return {
    ...$,
    estimateImageTokens,
    answer: (modelName, configuration) => async (input, options) => {
      const { model, thinkingEffortLevels, provider, outputTokenLimit } = specs[modelName]
      // deepseek does not support response API
      if (provider === 'deepseek') return $.deepseekChatCompletion(modelName)(input, options)
      const api = configuration ? new OpenAI({ ...defaultConfiguration, ...configuration }) : openai
      try {
        if (options.outputBudget > outputTokenLimit) {
          options.outputBudget = outputTokenLimit
        }
        const args = {
          model,
          temperature: 0,
          input,
          store: false
        }
        if (options.outputType === 'json') {
          args.text = { format: { type: 'json_object' } }
        }
        if (options.identifier) {
          args.user = options.identifier
        }
        if (thinkingEffortLevels) {
          options.outputEffort ||= 'medium'
          args.reasoning = { effort: options.outputEffort }
          delete args.temperature
        }
        if (options.images && options.images.length > 0) {
          args.input = [{
            role: 'user',
            content: [
              { type: 'input_text', text: input },
              ...formatImages(options.images)
            ]
          }]
        }
        // both think and output tokens!
        args.max_output_tokens = options.outputBudget || outputTokenLimit
        // instructions: 'todo',
        // max_output_tokens
        // text: {
        //   format: {
        //     type: "json_schema",
        //     strict: True
        //     name: 'basic',
        //     schema: {
        //       type: "object",
        //       additionalProperties: true,
        //     }
        //   }
        // }
        // temperature: 1,
        const { /* id, status, error, */ output, usage } = await api.responses.create(args)
        // output format
        // {
        //   id: 'msg_6807afa55120819196474a69caa79ccd0407e855946b42dd',
        //   type: 'message',
        //   status: 'completed',
        //   content: [
        //     {
        //       type: 'output_text',
        //       annotations: [],
        //       text: ""
        //     }
        //   ],
        //   role: 'assistant'
        // }
        for (const { /* id, status */ type, content } of output) {
          // if (type === 'reasoning') {
          //   //
          // }
          if (type === 'message') {
            return {
              output: content[0].text.trim(),
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens - usage.output_tokens_details.reasoning_tokens,
              thinkingTokens: usage.output_tokens_details.reasoning_tokens
            }
          }
        }
        // console.log({ id, status, error, output, usage })
      } catch (err) {
        console.error('Error calling answer (openai sdk)', err.message)
        throw err
      }
    },

    completion: (model) => async (prompt) => {
      try {
        const response = await openai.chat.completions.create({
          model,
          temperature: 0,
          messages: [{ role: 'user', content: prompt }]
        })
        return response.choices[0].message.content
      } catch (err) {
        console.error('Error calling openai sdk:', err.message)
        throw err
      }
    },

    getModelInfo: async (model) => {
      try {
        const modelInfo = await openai.models.retrieve(model)
        return translateModelInfo(modelInfo, infoTranslate)
      } catch (err) {
        console.error('Error retrieving model info (openai sdk):', err.message)
        return null
      }
    },

    listModels: async () => {
      try {
        const models = await openai.models.list()
        return models
      } catch (err) {
        console.error('Error listing (openai sdk) models:', err.message)
        return { data: [] }
      }
    }
  }
}

export default Provider
