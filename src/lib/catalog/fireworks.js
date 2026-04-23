// Fireworks' /inference/v1/models is openai-compatible for listing.
// Upstream IDs carry a `accounts/fireworks/models/` prefix that the
// runtime adapter adds back automatically — strip it here so curated
// entries stay short.
const DEFAULT_BASE_URL = 'https://api.fireworks.ai/inference/v1'
const FW_PREFIX = 'accounts/fireworks/models/'

const shortId = (id) => id?.startsWith(FW_PREFIX) ? id.slice(FW_PREFIX.length) : id

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
    listModels: async () => (await load()).map(m => {
      const id = shortId(m.id)
      return { id, label: id }
    }),
    getModelInfo: async (id) => {
      const m = (await load()).find(x => shortId(x.id) === id)
      if (!m) return null
      const info = { model: shortId(m.id) }
      if (typeof m.context_length === 'number') info.contextTokenLimit = m.context_length
      if (typeof m.created === 'number') info.created = m.created
      return info
    }
  }
}
