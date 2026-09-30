/** @param {string} accessToken @param {{fetch?: typeof fetch, signal?: AbortSignal}} [options] */
export async function discoverModels (accessToken, options = {}) {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)
  const response = await (options.fetch ?? fetch)('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${accessToken}` }, redirect: 'error', signal
  })
  if (!response.ok) throw Object.assign(new Error('ChatGPT model discovery failed'), { status: response.status })
  const body = await response.json()
  if (!Array.isArray(body.models)) throw new Error('ChatGPT returned an invalid model list')
  return body.models.filter(m => typeof m.slug === 'string' && m.slug)
}

export const visibleModels = models => models.filter(m => m.visibility === 'list')
  .map(m => ({ id: `chatgpt/${m.slug}`, model: m.slug, label: m.display_name || m.slug }))
