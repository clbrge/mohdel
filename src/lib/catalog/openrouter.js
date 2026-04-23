const BASE_URL = 'https://openrouter.ai/api/v1'

const fetchModels = async ({ apiKey }) => {
  const res = await fetch(`${BASE_URL}/models`, { headers: { Authorization: `Bearer ${apiKey}` } })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching openrouter models`)
  const body = await res.json()
  return Array.isArray(body?.data) ? body.data : []
}

// OpenRouter prices are decimal USD per token — convert to per-million-tokens.
const toPerMillion = (raw) => {
  const n = typeof raw === 'string' ? parseFloat(raw) : raw
  if (!Number.isFinite(n)) return undefined
  return n * 1_000_000
}

export default (sdkConfig) => {
  let cache = null
  const load = async () => {
    if (!cache) cache = await fetchModels(sdkConfig)
    return cache
  }
  return {
    listModels: async () => (await load()).map(m => ({ id: m.id, label: m.name || m.id })),
    getModelInfo: async (id) => {
      const m = (await load()).find(x => x.id === id)
      if (!m) return null
      const info = { model: m.id }
      if (m.name) info.label = m.name
      if (m.description) info.description = m.description
      if (typeof m.context_length === 'number') info.contextTokenLimit = m.context_length
      const topCtx = m.top_provider?.context_length
      if (!info.contextTokenLimit && typeof topCtx === 'number') info.contextTokenLimit = topCtx
      const maxOut = m.top_provider?.max_completion_tokens
      if (typeof maxOut === 'number') info.outputTokenLimit = maxOut
      const inP = toPerMillion(m.pricing?.prompt)
      const outP = toPerMillion(m.pricing?.completion)
      if (inP !== undefined) info.inputPrice = inP
      if (outP !== undefined) info.outputPrice = outP
      const modalities = m.architecture?.input_modalities
      if (Array.isArray(modalities) && modalities.length) {
        info.inputFormat = modalities.filter(x => typeof x === 'string')
      }
      if (typeof m.created === 'number') info.created = m.created
      return info
    }
  }
}
