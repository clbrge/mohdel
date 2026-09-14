const toPrice = (entry) => {
  const raw = entry?.price_per_m_decimal
  if (typeof raw !== 'string') return undefined
  const n = parseFloat(raw)
  return Number.isFinite(n) ? n : undefined
}

const MODALITIES = new Set(['text', 'image', 'video', 'audio'])

const BASE_URL = 'https://api.novita.ai/openai/v1'

const fetchModels = async ({ apiKey }) => {
  const res = await fetch(`${BASE_URL}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching novita models`)
  const body = await res.json()
  return Array.isArray(body?.data) ? body.data : []
}

export default (sdkConfig) => {
  let cache = null
  const load = async () => {
    if (!cache) cache = await fetchModels(sdkConfig)
    // The same endpoint serves image and video models; those belong to the
    // image adapter and have no place in a chat catalog.
    return cache.filter(m => m.model_type === 'chat')
  }
  return {
    listModels: async () => (await load()).map(m => ({
      id: m.id,
      label: m.display_name || m.id,
      inputPrice: toPrice(m.pricing?.prompt),
      outputPrice: toPrice(m.pricing?.completion)
    })),
    getModelInfo: async (id) => {
      const m = (await load()).find(x => x.id === id)
      if (!m) return null
      const info = { model: m.id }
      if (m.display_name) info.label = m.display_name
      if (m.description) info.description = m.description
      if (typeof m.context_size === 'number') info.contextTokenLimit = m.context_size
      if (typeof m.max_output_tokens === 'number') info.outputTokenLimit = m.max_output_tokens

      // Prices are USD per million as a decimal string, which is what the
      // catalog stores. The integer `*_price_per_m` fields are the same number
      // scaled by 10,000.
      const input = toPrice(m.pricing?.prompt)
      const output = toPrice(m.pricing?.completion)
      const cacheRead = toPrice(m.pricing?.input_cache_read)
      if (input !== undefined) info.inputPrice = input
      if (output !== undefined) info.outputPrice = output
      if (cacheRead !== undefined) info.cacheReadPrice = cacheRead

      const modalities = (m.input_modalities || []).filter(x => MODALITIES.has(x))
      if (modalities.length) info.inputFormat = modalities
      if (Array.isArray(m.features)) info.supportsTools = m.features.includes('function-calling')
      if (typeof m.created === 'number') info.created = m.created
      return info
    }
  }
}
