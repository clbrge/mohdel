const providers = {
  anthropic: {
    sdk: 'anthropic',
    apiKeyEnv: 'ANTHROPIC_API_SK',
    createConfiguration: apiKey => ({ apiKey })
  },
  deepseek: {
    sdk: 'openai',
    apiKeyEnv: 'DEEPSEEK_API_SK',
    createConfiguration: apiKey => ({ baseURL: 'https://api.deepseek.com', apiKey })
  },
  gemini: {
    sdk: 'gemini',
    apiKeyEnv: 'GEMINI_API_SK',
    createConfiguration: apiKey => ({ apiKey })
  },
  groq:{
    sdk: 'groq',
    apiKeyEnv: 'GROQ_API_SK',
    createConfiguration: apiKey => ({ apiKey })
  },
  openai: {
    sdk: 'openai',
    apiKeyEnv: 'OPENAI_API_SK',
    createConfiguration: apiKey => ({ apiKey })
  },
  xai: {
    sdk: 'openai',
    apiKeyEnv: 'XAI_API_SK',
    createConfiguration: apiKey => ({ baseURL: 'https://api.x.ai/v1', apiKey })
  }
}

Object.freeze(providers)

export default providers
