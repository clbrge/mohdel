import { providerOf } from '#core/model-id.js'

const LOCAL_API_KEY_ENV = 'MOHDEL_LOCAL_API_SK'

// `contextSemantics` and `outputCapStrategy` are published facts about a
// provider, not switches: mohdel caps `outputBudget` to the model's
// `outputTokenLimit` whatever they say. They exist so an embedder building its
// own provider requests does not have to rediscover the behaviour one 400 at a
// time. Entries may override `outputCapStrategy` per model. See
// ARCHITECTURE.md > "The output budget is capped to the model's ceiling".
// `billing` is how a provider's calls are paid for. `metered`: API money,
// reported as `cost`. `plan`: a share of a subscription allowance, seen at
// `usage`. `capacity`: hardware run or rented at a flat rate. `cost` is 0 for
// the last two.
const providers = {
  anthropic: {
    billing: { kind: 'metered' },
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
    billing: { kind: 'metered' },
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
  chatgpt: {
    billing: { kind: 'plan', label: 'ChatGPT plan', usage: 'https://chatgpt.com/settings/usage' },
    sdk: 'openai',
    catalogClient: 'chatgpt',
    refreshConfiguration: true,
    resolveConfiguration: async () => {
      const { createChatGPT } = await import('../../js/chatgpt/index.js')
      const { accessToken } = await createChatGPT().access()
      return { apiKey: accessToken }
    },
    references: {
      models: 'https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference'
    },
    contextSemantics: 'shared',
    outputCapStrategy: 'accept'
  },
  deepseek: {
    billing: { kind: 'metered' },
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
    billing: { kind: 'metered' },
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
    billing: { kind: 'metered' },
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
    billing: { kind: 'metered' },
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
    billing: { kind: 'capacity', label: 'local server' },
    sdk: 'openai',
    api: 'chatCompletions',
    catalog: false,
    optionalApiKeyEnv: LOCAL_API_KEY_ENV,
    resolveConfiguration: () => ({ apiKey: process.env[LOCAL_API_KEY_ENV] || '' }),
    contextSemantics: 'shared',
    outputCapStrategy: 'accept'
  },
  meta: {
    billing: { kind: 'metered' },
    sdk: 'openai',
    apiKeyEnv: 'META_API_SK',
    baseURL: 'https://api.meta.ai/v1',
    createConfiguration: apiKey => ({ apiKey }),
    references: {
      pricing: 'https://dev.meta.ai/docs/pricing-rate-limits',
      models: 'https://dev.meta.ai/docs/models',
      rateLimits: 'https://dev.meta.ai/docs/pricing-rate-limits'
    },
    outputCapStrategy: 'accept'
  },
  cohere: {
    billing: { kind: 'metered' },
    sdk: 'cohere',
    api: 'embeddings',
    catalog: false,
    apiKeyEnv: 'COHERE_API_SK',
    baseURL: 'https://api.cohere.com/v2',
    createConfiguration: apiKey => ({ apiKey }),
    references: {
      pricing: 'https://cohere.com/pricing',
      models: 'https://docs.cohere.com/docs/models',
      rateLimits: 'https://docs.cohere.com/docs/rate-limits'
    }
  },
  typesafe: {
    billing: { kind: 'metered' },
    sdk: 'typesafe',
    api: 'evaluation',
    catalog: false,
    apiKeyEnv: 'TYPESAFE_API_SK',
    baseURL: 'https://api.typesafe.ai/v1',
    createConfiguration: apiKey => ({ apiKey }),
    references: {
      pricing: 'https://docs.typesafe.ai/models',
      models: 'https://docs.typesafe.ai/models',
      rateLimits: 'https://docs.typesafe.ai/models'
    }
  },
  mistral: {
    billing: { kind: 'metered' },
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
    billing: { kind: 'metered' },
    sdk: 'openai',
    api: 'chatCompletions',
    imageHandler: 'novita',
    apiKeyEnv: 'NOVITA_API_SK',
    baseURL: 'https://api.novita.ai/openai',
    pricesFromApi: true,
    catalogClient: 'novita',
    createConfiguration: apiKey => ({ apiKey }),
    references: {
      pricing: 'https://novita.ai/pricing',
      models: 'https://novita.ai/models'
    },
    contextSemantics: 'shared',
    outputCapStrategy: 'error'
  },
  openai: {
    billing: { kind: 'metered' },
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
    billing: { kind: 'metered' },
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
    billing: { kind: 'metered' },
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
    billing: { kind: 'metered' },
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
    billing: { kind: 'metered' },
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

/**
 * How calls to `modelId`'s provider are paid for.
 * @param {string} modelId
 * @returns {{kind: 'metered' | 'plan' | 'capacity', label?: string, usage?: string}}
 */
export function billingOf (modelId) {
  const provider = providerOf(modelId)
  const def = providers[provider]
  if (!def) throw new Error(`Unknown provider '${provider}' in model id '${modelId}'`)
  return { ...def.billing }
}

export default providers
