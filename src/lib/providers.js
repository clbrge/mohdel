// `contextSemantics` and `outputCapStrategy` are published facts about a
// provider, not switches: mohdel caps `outputBudget` to the model's
// `outputTokenLimit` whatever they say. They exist so an embedder building its
// own provider requests does not have to rediscover the behaviour one 400 at a
// time. Entries may override `outputCapStrategy` per model. See
// ARCHITECTURE.md > "The output budget is capped to the model's ceiling".
const providers = {
  anthropic: {
    sdk: 'anthropic',
    apiKeyEnv: 'ANTHROPIC_API_SK',
    createConfiguration: apiKey => ({ apiKey }),
    references: {
      pricing: 'https://platform.claude.com/docs/en/about-claude/pricing',
      models: 'https://platform.claude.com/docs/en/models/overview',
      rateLimits: 'https://platform.claude.com/docs/en/api/rate-limits'
    },
    contextSemantics: 'shared',
    outputCapStrategy: 'error'
  },
  cerebras: {
    sdk: 'cerebras',
    apiKeyEnv: 'CEREBRAS_API_SK',
    createConfiguration: apiKey => ({ apiKey }),
    references: {
      pricing: 'https://www.cerebras.ai/pricing',
      models: 'https://inference-docs.cerebras.ai/models/overview',
      rateLimits: 'https://inference-docs.cerebras.ai/support/rate-limits'
    },
    contextSemantics: 'shared',
    outputCapStrategy: 'accept'
  },
  deepseek: {
    sdk: 'openai',
    api: 'chatCompletions',
    apiKeyEnv: 'DEEPSEEK_API_SK',
    baseURL: 'https://api.deepseek.com',
    createConfiguration: apiKey => ({ apiKey }),
    references: {
      pricing: 'https://api-docs.deepseek.com/quick_start/pricing',
      models: 'https://api-docs.deepseek.com/quick_start/pricing',
      rateLimits: 'https://api-docs.deepseek.com/quick_start/rate_limit'
    },
    contextSemantics: 'shared',
    outputCapStrategy: 'accept'
  },
  fireworks: {
    sdk: 'fireworks',
    apiKeyEnv: 'FIREWORKS_API_SK',
    baseURL: 'https://api.fireworks.ai/inference/v1',
    createConfiguration: apiKey => ({ apiKey }),
    references: {
      pricing: 'https://fireworks.ai/pricing',
      models: 'https://fireworks.ai/models',
      rateLimits: 'https://docs.fireworks.ai/guides/quotas_usage/account-quotas'
    },
    contextSemantics: 'shared',
    outputCapStrategy: 'accept'
  },
  gemini: {
    sdk: 'gemini',
    apiKeyEnv: 'GEMINI_API_SK',
    createConfiguration: apiKey => ({ apiKey }),
    references: {
      pricing: 'https://ai.google.dev/gemini-api/docs/pricing',
      models: 'https://ai.google.dev/gemini-api/docs/models',
      rateLimits: 'https://ai.google.dev/gemini-api/docs/rate-limits'
    },
    contextSemantics: 'separate',
    outputCapStrategy: 'accept'
  },
  groq: {
    sdk: 'groq',
    apiKeyEnv: 'GROQ_API_SK',
    createConfiguration: apiKey => ({ apiKey }),
    references: {
      pricing: 'https://console.groq.com/docs/models',
      models: 'https://console.groq.com/docs/models',
      rateLimits: 'https://console.groq.com/docs/rate-limits'
    }
  },
  local: {
    sdk: 'openai',
    api: 'chatCompletions',
    catalog: false,
    resolveConfiguration: () => ({ apiKey: process.env.MOHDEL_LOCAL_API_SK || '' }),
    contextSemantics: 'shared',
    outputCapStrategy: 'accept'
  },
  mistral: {
    sdk: 'openai',
    api: 'chatCompletions',
    apiKeyEnv: 'MISTRAL_API_SK',
    baseURL: 'https://api.mistral.ai/v1',
    createConfiguration: apiKey => ({ apiKey }),
    references: {
      pricing: 'https://mistral.ai/pricing',
      models: 'https://docs.mistral.ai/models',
      rateLimits: 'https://docs.mistral.ai/admin/billing-usage/usage-limits'
    }
  },
  novita: {
    sdk: 'openai',
    api: 'chatCompletions',
    imageHandler: 'novita',
    apiKeyEnv: 'NOVITA_API_SK',
    baseURL: 'https://api.novita.ai/openai',
    createConfiguration: apiKey => ({ apiKey }),
    references: {
      pricing: 'https://novita.ai/pricing',
      models: 'https://novita.ai/models'
    },
    contextSemantics: 'shared',
    outputCapStrategy: 'error'
  },
  openai: {
    sdk: 'openai',
    apiKeyEnv: 'OPENAI_API_SK',
    createConfiguration: apiKey => ({ apiKey }),
    references: {
      pricing: 'https://developers.openai.com/api/docs/pricing',
      models: 'https://developers.openai.com/api/docs/models',
      rateLimits: 'https://developers.openai.com/api/docs/guides/rate-limits'
    },
    contextSemantics: 'shared',
    outputCapStrategy: 'accept'
  },
  openrouter: {
    sdk: 'openrouter',
    apiKeyEnv: 'OPENROUTER_API_SK',
    baseURL: 'https://openrouter.ai/api/v1',
    createConfiguration: apiKey => ({ apiKey }),
    // Alone among the providers, OpenRouter's model list carries per-token
    // prices, so `mo curate openrouter` writes complete entries with no
    // pricing page to read.
    pricesFromApi: true,
    references: {
      pricing: 'https://openrouter.ai/models',
      models: 'https://openrouter.ai/models',
      rateLimits: 'https://openrouter.ai/docs/api_reference/limits'
    }
  },
  qwen: {
    sdk: 'openai',
    api: 'chatCompletions',
    apiKeyEnv: 'QWEN_API_SK',
    baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    createConfiguration: apiKey => ({ apiKey }),
    references: {
      pricing: 'https://docs.qwencloud.com/developer-guides/getting-started/pricing',
      models: 'https://www.qwencloud.com/models',
      rateLimits: 'https://docs.qwencloud.com/developer-guides/administration/rate-limits'
    },
    contextSemantics: 'shared',
    outputCapStrategy: 'accept'
  },
  xai: {
    sdk: 'openai',
    apiKeyEnv: 'XAI_API_SK',
    baseURL: 'https://api.x.ai/v1',
    createConfiguration: apiKey => ({ apiKey }),
    references: {
      pricing: 'https://docs.x.ai/developers/models',
      models: 'https://docs.x.ai/developers/models',
      rateLimits: 'https://docs.x.ai/developers/rate-limits'
    },
    contextSemantics: 'shared',
    outputCapStrategy: 'accept'
  },
  xiaomi: {
    sdk: 'openai',
    api: 'chatCompletions',
    apiKeyEnv: 'XIAOMI_API_SK',
    baseURL: 'https://api.xiaomimimo.com/v1',
    createConfiguration: apiKey => ({ apiKey }),
    contextSemantics: 'shared',
    outputCapStrategy: 'accept'
  }
}

Object.freeze(providers)

export default providers
