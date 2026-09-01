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
    baseURL: 'https://api.deepseek.com',
    createConfiguration: apiKey => ({ apiKey }),
    creators: ['deepseek'],
    contextSemantics: 'shared',
    outputCapStrategy: 'accept'
  },
  fireworks: {
    sdk: 'fireworks',
    apiKeyEnv: 'FIREWORKS_API_SK',
    baseURL: 'https://api.fireworks.ai/inference/v1',
    createConfiguration: apiKey => ({ apiKey }),
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
  local: {
    sdk: 'openai',
    api: 'chatCompletions',
    catalog: false,
    resolveConfiguration: () => ({ apiKey: process.env.MOHDEL_LOCAL_API_SK || '' }),
    creators: [],
    contextSemantics: 'shared',
    outputCapStrategy: 'accept'
  },
  mistral: {
    sdk: 'openai',
    api: 'chatCompletions',
    apiKeyEnv: 'MISTRAL_API_SK',
    baseURL: 'https://api.mistral.ai/v1',
    createConfiguration: apiKey => ({ apiKey }),
    creators: ['mistral']
  },
  novita: {
    sdk: 'openai',
    api: 'chatCompletions',
    imageHandler: 'novita',
    apiKeyEnv: 'NOVITA_API_SK',
    baseURL: 'https://api.novita.ai/openai',
    createConfiguration: apiKey => ({ apiKey }),
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
    baseURL: 'https://openrouter.ai/api/v1',
    createConfiguration: apiKey => ({ apiKey }),
    creators: []
  },
  qwen: {
    sdk: 'openai',
    api: 'chatCompletions',
    apiKeyEnv: 'QWEN_API_SK',
    baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    createConfiguration: apiKey => ({ apiKey }),
    creators: ['alibaba'],
    contextSemantics: 'shared',
    outputCapStrategy: 'accept'
  },
  xai: {
    sdk: 'openai',
    apiKeyEnv: 'XAI_API_SK',
    baseURL: 'https://api.x.ai/v1',
    createConfiguration: apiKey => ({ apiKey }),
    creators: ['xai'],
    contextSemantics: 'shared',
    outputCapStrategy: 'accept'
  },
  xiaomi: {
    sdk: 'openai',
    api: 'chatCompletions',
    apiKeyEnv: 'XIAOMI_API_SK',
    baseURL: 'https://api.xiaomimimo.com/v1',
    createConfiguration: apiKey => ({ apiKey }),
    creators: ['xiaomi'],
    contextSemantics: 'shared',
    outputCapStrategy: 'accept'
  }
}

Object.freeze(providers)

export default providers
