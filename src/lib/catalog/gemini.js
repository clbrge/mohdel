const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

const fetchModels = async ({ apiKey }) => {
  const all = []
  let pageToken = null
  while (true) {
    const url = new URL(`${BASE_URL}/models`)
    url.searchParams.set('key', apiKey)
    url.searchParams.set('pageSize', '1000')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching ${url.pathname}`)
    const body = await res.json()
    const page = Array.isArray(body?.models) ? body.models : []
    all.push(...page)
    if (!body?.nextPageToken) break
    pageToken = body.nextPageToken
  }
  return all
}

const shortId = (name) => name.startsWith('models/') ? name.slice('models/'.length) : name

export default (sdkConfig) => {
  let cache = null
  const load = async () => {
    if (!cache) cache = await fetchModels(sdkConfig)
    return cache
  }
  return {
    listModels: async () => (await load())
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => ({ id: shortId(m.name), label: m.displayName || shortId(m.name) })),
    getModelInfo: async (id) => {
      const m = (await load()).find(x => shortId(x.name) === id)
      if (!m) return null
      const info = { model: shortId(m.name) }
      if (m.displayName) info.label = m.displayName
      if (m.description) info.description = m.description
      if (typeof m.inputTokenLimit === 'number') info.contextTokenLimit = m.inputTokenLimit
      if (typeof m.outputTokenLimit === 'number') info.outputTokenLimit = m.outputTokenLimit
      if (m.version) info.version = m.version
      return info
    }
  }
}
