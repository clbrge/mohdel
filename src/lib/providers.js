const providers = {
  anthropic: {
    sdk: 'anthropic',
    apiKeyEnv: 'ANTHROPIC_API_SK',
    createConfiguration: apiKey => ({ apiKey }),
    creators: ['anthropic'],
    contextSemantics: 'shared',
    outputCapStrategy: 'error'
  },
  cerebras: {
    sdk: 'cerebras',
    apiKeyEnv: 'CEREBRAS_API_SK',
    createConfiguration: apiKey => ({ apiKey }),
    creators: ['openai', 'zai'],
    contextSemantics: 'shared',
    outputCapStrategy: 'accept'
  },
  deepseek: {
    sdk: 'openai',
    api: 'chatCompletions',
    apiKeyEnv: 'DEEPSEEK_API_SK',
    createConfiguration: apiKey => ({ baseURL: 'https://api.deepseek.com', apiKey }),
    creators: ['deepseek'],
    contextSemantics: 'shared',
    outputCapStrategy: 'accept'
  },
  fireworks: {
    sdk: 'fireworks',
    apiKeyEnv: 'FIREWORKS_API_SK',
    createConfiguration: apiKey => ({ apiKey, baseURL: 'https://api.fireworks.ai/inference/v1' }),
    creators: ['meta', 'alibaba'],
    contextSemantics: 'shared',
    outputCapStrategy: 'accept'
  },
  gemini: {
    sdk: 'gemini',
    apiKeyEnv: 'GEMINI_API_SK',
    createConfiguration: apiKey => ({ apiKey }),
    creators: ['google'],
    contextSemantics: 'separate',
    outputCapStrategy: 'accept'
  },
  groq: {
    sdk: 'groq',
    apiKeyEnv: 'GROQ_API_SK',
    createConfiguration: apiKey => ({ apiKey }),
    creators: ['meta']
  },
  mistral: {
    sdk: 'openai',
    api: 'chatCompletions',
    apiKeyEnv: 'MISTRAL_API_SK',
    createConfiguration: apiKey => ({ baseURL: 'https://api.mistral.ai/v1', apiKey }),
    creators: ['mistral']
  },
  novita: {
    sdk: 'openai',
    api: 'chatCompletions',
    imageHandler: 'novita',
    apiKeyEnv: 'NOVITA_API_SK',
    createConfiguration: apiKey => ({ apiKey, baseURL: 'https://api.novita.ai/openai' }),
    creators: ['deepseek', 'openai', 'bfl'],
    contextSemantics: 'shared',
    outputCapStrategy: 'error'
  },
  openai: {
    sdk: 'openai',
    apiKeyEnv: 'OPENAI_API_SK',
    createConfiguration: apiKey => ({ apiKey }),
    creators: ['openai'],
    contextSemantics: 'shared',
    outputCapStrategy: 'accept'
  },
  openrouter: {
    sdk: 'openrouter',
    apiKeyEnv: 'OPENROUTER_API_SK',
    createConfiguration: apiKey => {
      // Optional OpenRouter attribution headers — only sent when the
      // embedder opts in via env. No defaults.
      const defaultHeaders = {}
      if (process.env.OPENROUTER_REFERER) defaultHeaders['HTTP-Referer'] = process.env.OPENROUTER_REFERER
      if (process.env.OPENROUTER_TITLE) defaultHeaders['X-Title'] = process.env.OPENROUTER_TITLE
      return {
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey,
        defaultHeaders
      }
    },
    creators: []
  },
  xai: {
    sdk: 'openai',
    apiKeyEnv: 'XAI_API_SK',
    createConfiguration: apiKey => ({ baseURL: 'https://api.x.ai/v1', apiKey }),
    creators: ['xai'],
    contextSemantics: 'shared',
    outputCapStrategy: 'accept'
  },
  xiaomi: {
    sdk: 'openai',
    api: 'chatCompletions',
    apiKeyEnv: 'XIAOMI_API_SK',
    createConfiguration: apiKey => ({ baseURL: 'https://api.xiaomimimo.com/v1', apiKey }),
    creators: ['xiaomi'],
    contextSemantics: 'shared',
    outputCapStrategy: 'accept'
  }
}

Object.freeze(providers)

export default providers
