const BASE_URL = 'https://api.anthropic.com/v1'
const API_VERSION = '2023-06-01'

const fetchModels = async ({ apiKey }) => {
  const all = []
  let afterId = null
  while (true) {
    const url = new URL(`${BASE_URL}/models`)
    url.searchParams.set('limit', '100')
    if (afterId) url.searchParams.set('after_id', afterId)
    const res = await fetch(url, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION
      }
    })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching ${url}`)
    const body = await res.json()
    const page = Array.isArray(body?.data) ? body.data : []
    all.push(...page)
    if (!body?.has_more || !page.length) break
    afterId = page[page.length - 1].id
  }
  return all
}

export default (sdkConfig) => {
  let cache = null
  const load = async () => {
    if (!cache) cache = await fetchModels(sdkConfig)
    return cache
  }
  return {
    listModels: async () => (await load()).map(m => ({ id: m.id, label: m.display_name || m.id })),
    getModelInfo: async (id) => {
      const m = (await load()).find(x => x.id === id)
      if (!m) return null
      const info = { model: m.id }
      if (m.display_name) info.label = m.display_name
      if (m.created_at) info.createdAt = m.created_at
      return info
    }
  }
}
