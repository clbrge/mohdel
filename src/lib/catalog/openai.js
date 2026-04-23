// Catalog fetcher for any OpenAI-compatible /v1/models endpoint
// (openai, deepseek, mistral, novita, xai). Inference path lives in
// js/session/adapters/openai.js — this module is CLI-only.

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

const fetchModels = async ({ apiKey, baseURL }) => {
  const url = `${(baseURL || DEFAULT_BASE_URL).replace(/\/$/, '')}/models`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching ${url}`)
  const body = await res.json()
  return Array.isArray(body?.data) ? body.data : []
}

export default (sdkConfig) => {
  let cache = null
  const load = async () => {
    if (!cache) cache = await fetchModels(sdkConfig)
    return cache
  }
  return {
    listModels: async () => (await load()).map(m => ({ id: m.id, label: m.id })),
    getModelInfo: async (id) => {
      const m = (await load()).find(x => x.id === id)
      if (!m) return null
      const info = { model: m.id }
      if (typeof m.context_window === 'number') info.contextTokenLimit = m.context_window
      if (typeof m.max_context_length === 'number') info.contextTokenLimit = m.max_context_length
      if (typeof m.max_completion_tokens === 'number') info.outputTokenLimit = m.max_completion_tokens
      if (typeof m.created === 'number') info.created = m.created
      return info
    }
  }
}
