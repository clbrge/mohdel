import { GoogleGenAI } from '@google/genai'
import { translateModelInfo } from './utils.js'

// documentation
// https://googleapis.github.io/js-genai/main/index.html

const outputStyleTemperature = {
  coding: 0.0, // Keep deterministic for accuracy
  analysis: 0.2, // Allow some flexibility but stay grounded (adjust based on testing)
  translation: 0.4, // Prioritize accuracy heavily
  chat: 0.9, // More creative/varied but coherent conversation
  creative: 1.0 // Maximum standard creativity/randomness
}

const Provider = (defaultConfiguration, specs) => {
  const ai = new GoogleGenAI(defaultConfiguration)

  const infoTranslate = {
    name: str => ['model', str.replace('models/', '')]
  }

  return {
    answer: (modelName, configuration) => async (input, options) => {
      const api = configuration ? new GoogleGenAI({ ...defaultConfiguration, ...configuration }) : ai
      const { model, thinkingEffortLevels, outputTokenLimit } = specs[modelName]
      try {
        // API doc https://googleapis.github.io/js-genai/main/index.html
        if (options.outputBudget > outputTokenLimit) {
          options.outputBudget = outputTokenLimit
        }
        const args = {
          model,
          contents: input,
          config: {
            maxOutputTokens: options.outputBudget,
            // audioTimestamp?: boolean;
            // cachedContent?: string;
            // candidateCount?: number;
            // frequencyPenalty?: number;
            // httpOptions?: HttpOptions;
            // labels?: Record<string, string>;
            // logprobs?: number;
            // maxOutputTokens?: number;
            // mediaResolution?: MediaResolution;
            // presencePenalty?: number;
            // responseLogprobs?: boolean;
            // responseMimeType?: string;
            // responseModalities?: string[];
            // responseSchema?: Schema;
            // routingConfig?: GenerationConfigRoutingConfig;
            // safetySettings?: SafetySetting[];
            // seed?: number;
            // speechConfig?: SpeechConfigUnion;
            // stopSequences?: string[];
            // systemInstruction?: ContentUnion;
            temperature: outputStyleTemperature[options.outputStyle] || 0
            // thinkingConfig?: ThinkingConfig;
            // toolConfig?: ToolConfig;
            // tools?: ToolListUnion;
            // topK?: number;
            // topP?: number;
          }
        }
        if (thinkingEffortLevels && options.outputEffort && options.outputEffort !== 'none' && thinkingEffortLevels[options.outputEffort]) {
          args.config.thinkingConfig = { thinkingBudget: thinkingEffortLevels[options.outputEffort] }
        }
        const { candidates, usageMetadata } = await api.models.generateContent(args)
        // console.log(usageMetadata)
        return {
          output: candidates[0].content.parts[0].text.trim(),
          inputTokens: usageMetadata.promptTokenCount,
          outputTokens: usageMetadata.candidatesTokenCount,
          thinkingTokens: usageMetadata.thoughtsTokenCount || 0
        }
      } catch (err) {
        console.error('Error calling answer (gemini sdk)', err.message)
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
