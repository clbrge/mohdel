// What first-run setup shows about each provider: how to get a key, and
// whether you can use it without paying. Kept beside the provider registry
// rather than inside the onboarding flow, because the brief needs it too.
const PROVIDER_INFO = {
  gemini: {
    label: 'Google Gemini',
    description: 'Long context, vision, video, audio. Free tier, no card required.',
    url: 'https://aistudio.google.com/apikey',
    hint: 'Create an API key at aistudio.google.com → Get API Key',
    free: true
  },
  groq: {
    label: 'Groq',
    description: 'Open-weight models at the fastest inference available. Free tier, no card required.',
    url: 'https://console.groq.com/keys',
    hint: 'Create an API key at console.groq.com → API Keys',
    free: true
  },
  cerebras: {
    label: 'Cerebras',
    description: 'Llama, Qwen — fast inference on custom hardware. Starter credits for new accounts.',
    url: 'https://cloud.cerebras.ai/platform',
    hint: 'Create an API key at cloud.cerebras.ai → Platform → API Keys',
    free: false
  },
  anthropic: {
    label: 'Anthropic',
    description: 'Claude Opus, Sonnet, Haiku — reasoning, coding, vision, tool use.',
    url: 'https://console.anthropic.com/settings/keys',
    hint: 'Create an API key at console.anthropic.com → Settings → API Keys',
    free: false
  },
  openai: {
    label: 'OpenAI',
    description: 'GPT and reasoning models — vision, image generation, tool use.',
    url: 'https://platform.openai.com/api-keys',
    hint: 'Create an API key at platform.openai.com → API Keys',
    free: false
  },
  xai: {
    label: 'xAI',
    description: 'Grok — reasoning and tool use.',
    url: 'https://console.x.ai',
    hint: 'Create an API key at console.x.ai',
    free: false
  },
  mistral: {
    label: 'Mistral',
    description: 'Mistral Large, Codestral, Pixtral — coding, reasoning, vision. Free tier, no card required.',
    url: 'https://console.mistral.ai/api-keys',
    hint: 'Create an API key at console.mistral.ai → API Keys',
    free: true
  },
  deepseek: {
    label: 'DeepSeek',
    description: 'Reasoning and coding models, at low cost.',
    url: 'https://platform.deepseek.com/api_keys',
    hint: 'Create an API key at platform.deepseek.com → API Keys',
    free: false
  },
  fireworks: {
    label: 'Fireworks',
    description: 'Llama, Qwen, DeepSeek — serverless inference with reasoning.',
    url: 'https://fireworks.ai/account/api-keys',
    hint: 'Create an API key at fireworks.ai → Account → API Keys',
    free: false
  },
  openrouter: {
    label: 'OpenRouter',
    description: 'Multi-provider router — hundreds of models behind one key, some of them at no cost. Free tier, no card required.',
    url: 'https://openrouter.ai/settings/keys',
    hint: 'Create an API key at openrouter.ai → Settings → Keys',
    free: true
  },
  novita: {
    label: 'Novita',
    description: 'Image generation and open-weight inference.',
    url: 'https://novita.ai/dashboard/key',
    hint: 'Create an API key at novita.ai → Dashboard → API Key',
    free: false
  },
  xiaomi: {
    label: 'Xiaomi MiMo',
    description: 'MiMo — vision and text models.',
    url: 'https://platform.xiaomimimo.com/',
    hint: 'Create an API key in the MiMo open platform console',
    free: false
  },
  qwen: {
    label: 'Qwen Cloud',
    description: 'Qwen — reasoning, coding, long context. Free quota for new users.',
    url: 'https://home.qwencloud.com/api-keys',
    hint: 'Create an API key at home.qwencloud.com → API Keys',
    free: false
  }
}

export default PROVIDER_INFO
