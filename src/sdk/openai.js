import OpenAI from 'openai'
import { translateModelInfo } from './utils.js'

const Provider = (defaultConfiguration, specs) => {
  const openai = new OpenAI(defaultConfiguration)

  // Property name translations (empty for now)
  const infoTranslate = {}

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
        if (thinkingEffortLevels) {
          options.outputEffort ||= 'medium'
          args.reasoning = { effort: options.outputEffort }
        }
        if (options.outputType === 'json') {
          args.text = { format: { type: 'json_object' } }
        }
        if (options.identifier) {
          args.user = options.identifier
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
