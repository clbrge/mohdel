const BASE_URL = 'https://api.cerebras.ai/v1'

const fetchModels = async ({ apiKey }) => {
  const res = await fetch(`${BASE_URL}/models`, { headers: { Authorization: `Bearer ${apiKey}` } })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching cerebras models`)
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
      if (typeof m.created === 'number') info.created = m.created
      return info
    }
  }
}
