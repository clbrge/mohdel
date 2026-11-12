/**
 * ChatGPT's sign-in is not here: it is `startLogin` / `finishLogin` on `createChatGPT()` (`mohdel/chatgpt`).
 * @module credentials
 */
import { randomBytes, createHash } from 'node:crypto'
import providers from './providers.js'
import { providerApi } from './curate.js'
import { appendToEnvFile } from './env-file.js'

const AUTHORIZE_URL = 'https://openrouter.ai/auth'
const EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys'

const AUTH_FAILURE_RE = /40[13]|unauthorized|forbidden|invalid[\s_-]*api[\s_-]*key|invalid key|incorrect api key|authentication/i

const isAuthFailure = (err) => AUTH_FAILURE_RE.test(`${err?.message ?? err}`)

/** OpenRouter's model list is public, so a listing proves nothing about the key. */
const verifyOpenRouterKey = async (key) => {
  let res
  try {
    res = await fetch('https://openrouter.ai/api/v1/auth/key', { headers: { Authorization: `Bearer ${key}` } })
  } catch {
    return 'unknown'
  }
  if (res.ok) return 'valid'
  if (res.status === 401 || res.status === 403) return 'invalid'
  return 'unknown'
}

/**
 * What the provider says of a candidate key, before anything is saved:
 * `valid`, `invalid` (the provider refused it), or `unknown` (offline, or no
 * listing mohdel reads — nothing to check against). Keyless providers
 * (chatgpt, local) are always `unknown`; callers skip them. What to do with
 * `unknown` is the caller's choice.
 * @param {string} provider
 * @param {string} key
 * @returns {Promise<'valid' | 'invalid' | 'unknown'>}
 */
export async function verifyKey (provider, key) {
  if (!providers[provider].apiKeyEnv) return 'unknown'
  if (provider === 'openrouter') return verifyOpenRouterKey(key)
  const api = await providerApi(provider, key)
  if (!api) return 'unknown'
  try {
    await api.listModels()
    return 'valid'
  } catch (err) {
    return isAuthFailure(err) ? 'invalid' : 'unknown'
  }
}

/**
 * Writes the provider's key to mohdel's environment file and sets it in `process.env`, since
 * loading the file never overrides a variable already set. Not serialised: a caller that may save
 * twice at once orders its own calls.
 * @param {string} provider
 * @param {string} key
 */
export async function saveKey (provider, key) {
  if (!providers[provider]) throw new Error(`Unknown provider: ${provider}`)
  const envVar = providers[provider].apiKeyEnv
  if (!envVar) throw new Error(`${provider} takes no API key`)
  await appendToEnvFile(envVar, key)
  process.env[envVar] = key
}

const challengeOf = (verifier) => createHash('sha256').update(verifier).digest('base64url')

/**
 * The link that starts an OpenRouter sign-in, and the verifier its finish needs. Without
 * `callbackUrl` OpenRouter shows the user a code to paste; with it, OpenRouter sends the browser
 * there with `?code=`. The caller keeps `verifier` until the finish.
 * @param {{ label: string, callbackUrl?: string }} settings
 * @returns {{ url: string, verifier: string }}
 */
export function startOpenRouterSignIn ({ label, callbackUrl }) {
  const verifier = randomBytes(32).toString('base64url')
  const url = new URL(AUTHORIZE_URL)
  url.search = new URLSearchParams({
    code_challenge: challengeOf(verifier),
    code_challenge_method: 'S256',
    key_label: label,
    ...(callbackUrl ? { callback_url: callbackUrl } : {})
  }).toString()
  return { url: url.toString(), verifier }
}

/**
 * The key OpenRouter makes for the code from a sign-in `startOpenRouterSignIn` began. Neither
 * checked nor saved here.
 * @param {{ code: string, verifier: string }} signIn
 * @returns {Promise<string>}
 */
export async function finishOpenRouterSignIn ({ code, verifier }) {
  const res = await fetch(EXCHANGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' })
  })
  if (!res.ok) {
    const said = await res.text()
    if (res.status === 403 && /expired/i.test(said)) throw new Error('code expired, sign in again')
    throw new Error(`OpenRouter refused the code: ${res.status} ${said}`)
  }
  const { key } = await res.json()
  if (typeof key !== 'string') throw new Error('OpenRouter answered without a key')
  return key
}

/**
 * @param {string} key
 * @returns {string} where the user sets this key's spending limit
 */
export const keyPage = (key) => `https://openrouter.ai/keys/${createHash('sha256').update(key).digest('hex')}`
