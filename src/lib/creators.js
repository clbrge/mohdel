const creators = {
  alibaba: {
    prefixes: ['qwen', 'qwq'],
    label: 'Alibaba',
    logo: 'alibaba.svg',
    description: 'Alibaba Cloud’s Qwen models target large-scale enterprise scenarios with strong multilingual and commerce-focused capabilities.'
  },
  bfl: {
    prefixes: ['flux'],
    label: 'Black Forest Labs',
    logo: 'bfl.svg',
    description: 'Black Forest Labs builds the Flux family of image generation models, delivering fast, high-quality text-to-image synthesis.'
  },
  anthropic: {
    prefixes: ['claude'],
    label: 'Anthropic',
    logo: 'anthropic.svg',
    description: 'Anthropic builds Claude models that emphasize safe reasoning, tool use, and reliable outputs for production assistants.'
  },
  deepseek: {
    prefixes: ['deepseek'],
    label: 'DeepSeek',
    logo: 'deepseek.svg',
    description: 'DeepSeek offers fast, cost-efficient foundation models optimized for coding, chat, and multilingual reasoning.'
  },
  google: {
    prefixes: ['gemini', 'gemma', 'imagen', 'nano-banana'],
    label: 'Google',
    logo: 'gemini.svg',
    description: 'Google’s Gemini family blends multimodal understanding, coding assistance, and long-context reasoning from Google DeepMind research.'
  },
  kwaipilot: {
    prefixes: ['kwaipilot', 'kat-coder'],
    label: 'Kwaipilot',
    logo: 'kwaipilot.svg',
    description: 'Kuaishou\'s KwaiPilot team builds KAT-Coder, a MoE coding model with strong agentic and multi-step reasoning for software engineering tasks.'
  },
  meta: {
    prefixes: ['llama', 'code-llama'],
    label: 'Meta',
    logo: 'meta.svg',
    description: 'Meta stewards the Llama ecosystem with open, widely adoptable models for chat, coding, and research.'
  },
  minimax: {
    prefixes: ['minimax'],
    label: 'Minimax',
    logo: 'minimax.svg',
    description: 'Minimax offers versatile Chinese-first chat and coding models tuned for fast, cost-aware assistants and enterprise integrations.'
  },
  mistral: {
    prefixes: ['mistral', 'codestral', 'pixtral', 'ministral', 'magistral', 'voxtral', 'devstral'],
    label: 'Mistral',
    logo: 'mistral.svg',
    description: 'Mistral AI ships strong open-weight and proprietary models with a focus on European hosting, multilingual quality, and efficient deployment.'
  },
  moonshotai: {
    prefixes: ['moonshotai', 'kimi'],
    label: 'Moonshot AI',
    logo: 'moonshotai.svg',
    description: 'Moonshot AI ships fluent, Chinese-first assistants and lean models tuned for consumer chat and business workflows.'
  },
  cohere: {
    prefixes: ['embed', 'command', 'rerank'],
    label: 'Cohere',
    logo: 'cohere.svg',
    description: 'Cohere builds retrieval-focused models: embeddings and rerankers aimed at enterprise search rather than chat.'
  },
  nomic: {
    prefixes: ['nomic-embed'],
    label: 'Nomic',
    logo: 'nomic.svg',
    description: 'Nomic publishes open-weight embedding models with Matryoshka dimensions, widely self-hosted through Ollama and vLLM.'
  },
  openai: {
    prefixes: ['gpt', 'whisper', 'dall-e', 'sora', 'text-embedding', 'o1', 'o3', 'o4'],
    label: 'OpenAI',
    logo: 'openai.svg',
    description: 'OpenAI’s GPT and o-series models focus on broad tool-use, reasoning quality, and multimodal support across developer platforms.'
  },
  xai: {
    prefixes: ['grok'],
    label: 'xAI',
    logo: 'xai.svg',
    description: 'xAI develops Grok with real-time, web-aware chat and coding behavior aimed at terse, fast responses.'
  },
  xiaomi: {
    prefixes: ['mimo'],
    label: 'Xiaomi',
    logo: 'xiaomi.svg',
    description: 'Xiaomi develops MiMo, a high-efficiency MoE reasoning model optimized for agentic coding and tool use at low inference cost.'
  },
  zai: {
    prefixes: ['zai', 'zai-org', 'glm'],
    label: 'Z AI',
    logo: 'zai.svg',
    description: 'Z AI delivers streamlined assistants with lightweight models oriented toward pragmatic productivity use cases.'
  }
}

Object.freeze(creators)

// Which organisation trained a model, guessed from its id. Two signals: a
// router-style id carries the creator as a namespace (`moonshotai/kimi-k3`),
// and a bare id usually starts with a family name (`claude-`, `qwen3-`).
// A guess is only ever offered as a default — it is never written unasked.
const startsWithToken = (id, prefix) => {
  if (!id.startsWith(prefix)) return false
  const next = id[prefix.length]
  return next === undefined || !/[a-z]/.test(next)
}

export const creatorFromModelId = (bare) => {
  const segments = String(bare).toLowerCase().split('/')
  const candidates = segments.length > 1 ? [segments[0], segments[segments.length - 1]] : segments
  for (const segment of candidates) {
    for (const [name, def] of Object.entries(creators)) {
      if ((def.prefixes || []).some(p => startsWithToken(segment, p))) return name
    }
  }
  return null
}

export default creators
