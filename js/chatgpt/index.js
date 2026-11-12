import { randomBytes, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { hostname } from 'node:os'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { defaultDirectory, readStore, withStore } from './store.js'
import { discoverModels, visibleModels } from './models.js'
import providers from '../../src/lib/providers.js'

const ISSUER = 'https://auth.openai.com'
const RESOURCE = 'https://api.openai.com/v1'
const TOKEN = `${ISSUER}/api/accounts/oauth/token`
const PERMISSION = 'chatgpt.tokens.use.direct'
const SCOPE = `openid profile email offline_access resource.invoke ${PERMISSION}`
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`))
const random = () => randomBytes(32).toString('base64url')
const REFRESH_MARGIN = 30000
// Every registration made before names were stored was sent this hint.
const UNNAMED_REGISTRATION = 'Mohdel'
export const usageURL = providers.chatgpt.billing.usage
/** Ends every error that signing in again fixes; a caller adds its own way to do it. */
export const SIGN_IN_AGAIN = 'sign in to ChatGPT again'

async function jsonRequest (fetcher, url, options = {}) {
  let response
  try {
    response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000) })
  } catch {
    throw new Error('ChatGPT connection failed. Try again.')
  }
  if (!response.ok) {
    const err = new Error(`ChatGPT request failed (${response.status})${response.status === 401 || response.status === 400 ? `; ${SIGN_IN_AGAIN}` : ''}`)
    Object.assign(err, { status: response.status })
    throw err
  }
  return response.json()
}

async function verifyIdentity (token, clientId, nonce) {
  const { payload } = await jwtVerify(token, jwks, {
    issuer: ISSUER,
    audience: clientId,
    requiredClaims: ['sub', 'exp', 'iat'],
    clockTolerance: 5
  })
  if (payload.nonce !== nonce || typeof payload.sub !== 'string' || !payload.sub) {
    throw new Error('ChatGPT identity validation failed')
  }
  return payload
}

function credentials (tokens, previous = {}) {
  if (typeof tokens.access_token !== 'string' || !tokens.access_token ||
      typeof tokens.refresh_token !== 'string' || !tokens.refresh_token ||
      !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0 ||
      tokens.token_type?.toLowerCase() !== 'bearer') {
    throw new Error(`ChatGPT returned incomplete credentials; ${SIGN_IN_AGAIN}`)
  }
  return {
    ...previous,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    id_token: tokens.id_token ?? previous.id_token,
    scopes: typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/) : previous.scopes ?? [],
    expires_at: Date.now() + tokens.expires_in * 1000
  }
}

const summary = (id, account, active) => ({
  id,
  name: account.name ?? UNNAMED_REGISTRATION,
  email: account.email ?? null,
  active: id === active,
  connected: !!account.access_token,
  planUsage: !!account.access_token && account.scopes?.includes(PERMISSION) === true
})

/**
 * @typedef {{ state: string, nonce: string, verifier: string, redirectUri: string, label: string,
 *   accountId?: string, clientId?: string, expiresAt: number, used: boolean }} PendingLogin
 */

/**
 * OAuth credentials belong to this installation, independently of the public model catalog.
 * `authorize` receives a sensitive browser URL; open it without recording it in logs.
 * @param {{ directory?: string, fetch?: typeof fetch, verifyIdentity?: Function }} [options]
 */
export function createChatGPT (options = {}) {
  const directory = options.directory ?? defaultDirectory()
  const fetcher = options.fetch ?? globalThis.fetch
  const verify = options.verifyIdentity ?? verifyIdentity
  const tokenRequest = params => jsonRequest(fetcher, TOKEN, {
    method: 'POST',
    body: new URLSearchParams({ ...params, resource: RESOURCE })
  })

  const accounts = async () => {
    const store = await readStore(directory)
    return Object.entries(store.accounts).map(([id, account]) => summary(id, account, store.active))
  }

  /** @param {string} id */
  const select = async id => withStore(directory, async (store, save) => {
    if (!store.accounts[id]?.access_token) throw new Error(`ChatGPT account is not connected; ${SIGN_IN_AGAIN}`)
    store.active = id
    await save(store)
  })

  /**
   * `refreshAt` is when this token stops being handed out; a caller may reuse it until then.
   * @param {string} [id] @returns {Promise<{accessToken: string, accountId: string, refreshAt: number}>}
   */
  const access = async (id) => withStore(directory, async (store, save) => {
    const account = store.accounts[id ?? store.active]
    if (!account?.access_token) throw new Error(`ChatGPT is not connected; ${SIGN_IN_AGAIN}`)
    if (!account.scopes?.includes(PERMISSION)) throw new Error(`ChatGPT plan usage is not enabled; grant plan usage when you ${SIGN_IN_AGAIN}`)
    if (account.expires_at <= Date.now() + REFRESH_MARGIN) {
      const tokens = await tokenRequest({ grant_type: 'refresh_token', client_id: account.client_id, refresh_token: account.refresh_token })
      Object.assign(account, credentials(tokens, account))
      await save(store)
      if (!account.scopes.includes(PERMISSION)) throw new Error(`ChatGPT plan usage permission was removed; ${SIGN_IN_AGAIN}`)
    }
    return { accessToken: account.access_token, accountId: account.client_id, refreshAt: account.expires_at - REFRESH_MARGIN }
  })

  /** @param {string} [id] @returns {Promise<Array<{id: string, model: string, label: string}>>} */
  const models = async (id) => {
    const { accessToken } = await access(id)
    return visibleModels(await discoverModels(accessToken, { fetch: fetcher }))
  }

  /** @param {string} [id] @returns {Promise<{revoked: boolean, name: string}>} */
  const logout = async (id) => withStore(directory, async (store, save) => {
    id ??= store.active
    const account = store.accounts[id]
    if (!account) throw new Error('Unknown ChatGPT account')
    let revoked = !account.refresh_token
    try {
      if (account.refresh_token) {
        const discovery = await jsonRequest(fetcher, `${ISSUER}/.well-known/openid-configuration`)
        const endpoint = new URL(discovery.revocation_endpoint)
        if (endpoint.origin !== ISSUER) throw new Error('Invalid revocation endpoint')
        const response = await fetcher(endpoint, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(30000),
          body: new URLSearchParams({ token: account.refresh_token, token_type_hint: 'refresh_token', client_id: account.client_id })
        })
        revoked = response.status === 200
      }
    } catch {
      revoked = false
    }
    for (const key of ['access_token', 'refresh_token', 'id_token', 'expires_at', 'scopes']) delete account[key]
    if (store.active === id) store.active = null
    await save(store)
    return { revoked, name: account.name ?? UNNAMED_REGISTRATION }
  })

  /**
   * The authorization link for a sign-in whose callback lands on `redirectUri`, and the `pending`
   * state `finishLogin` needs. `name` labels a new registration on the ChatGPT side (default
   * `Mohdel (<hostname>)`); an existing registration keeps the name it was created with. Both `url`
   * and `pending` are sensitive: neither is logged.
   * @param {{ redirectUri: string, accountId?: string, name?: string, timeoutMs?: number }} settings
   * @returns {Promise<{ url: string, pending: PendingLogin }>}
   */
  const startLogin = async ({ redirectUri, accountId, name, timeoutMs = 300000 }) => {
    if (name !== undefined && (typeof name !== 'string' || !name.trim())) throw new Error('ChatGPT registration name must not be empty')
    const initial = await withStore(directory, async (store, save) => {
      if (accountId && !store.accounts[accountId]) throw new Error('Unknown ChatGPT account')
      if (name !== undefined && store.accounts[accountId]) {
        throw new Error('A ChatGPT registration keeps the name it was created with; start a new registration to use another name')
      }
      await save(store)
      return { host: store.host, account: store.accounts[accountId] }
    })
    const pending = {
      state: random(),
      nonce: random(),
      verifier: random(),
      redirectUri,
      label: name ?? `Mohdel (${hostname()})`,
      accountId,
      clientId: initial.account?.client_id,
      expiresAt: Date.now() + timeoutMs,
      used: false
    }
    const url = new URL(`${ISSUER}/api/accounts/authorize`)
    url.search = new URLSearchParams({
      client_id: pending.clientId ?? 'dynamic_agent_client',
      ext_agent_host_id: initial.host,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SCOPE,
      resource: RESOURCE,
      state: pending.state,
      nonce: pending.nonce,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(pending.verifier).digest('base64url')
    }).toString()
    if (!initial.account) url.searchParams.set('agent_name_hint', pending.label)
    if (initial.account?.id_token) url.searchParams.set('id_token_hint', initial.account.id_token)
    return { url: url.toString(), pending }
  }

  /**
   * Completes a sign-in from its callback's query. A callback with another `state` is refused and
   * leaves `pending` usable; a matching one consumes it (`pending.used`), whatever follows.
   * @param {PendingLogin} pending
   * @param {URLSearchParams} params
   */
  const finishLogin = async (pending, params) => {
    if (pending.used) throw new Error('This ChatGPT sign-in was already completed; start a new one')
    if (Date.now() > pending.expiresAt) throw new Error('ChatGPT sign-in timed out')
    if (params.get('state') !== pending.state) throw new Error('Invalid sign-in state')
    pending.used = true
    if (params.has('error')) throw new Error('ChatGPT authorization was not granted')
    const clientId = params.get('client_id') ?? pending.clientId
    if (!clientId || clientId === 'dynamic_agent_client' || (pending.accountId && clientId !== pending.accountId) || !params.get('code')) {
      throw new Error('ChatGPT returned an invalid registration')
    }
    // Keep the issued ID even if code exchange fails; it must not be registered again.
    await withStore(directory, async (store, save) => {
      store.accounts[clientId] ??= { client_id: clientId, name: pending.label }
      await save(store)
    })
    const tokens = await tokenRequest({ grant_type: 'authorization_code', client_id: clientId, code: params.get('code'), code_verifier: pending.verifier, redirect_uri: pending.redirectUri })
    const identity = await verify(tokens.id_token, clientId, pending.nonce)
    return await withStore(directory, async (store, save) => {
      const previous = store.accounts[clientId]
      if (previous.subject && previous.subject !== identity.sub) throw new Error('ChatGPT returned a different account identity')
      const account = { ...credentials(tokens), client_id: clientId, name: previous.name, subject: identity.sub, email: identity.email ?? null }
      store.accounts[clientId] = account
      store.active = clientId
      await save(store)
      return summary(clientId, account, store.active)
    })
  }

  /**
   * `startLogin` and `finishLogin` around a loopback callback server of its own on 127.0.0.1.
   * @param {{ authorize: (url: string) => any, accountId?: string, name?: string, timeoutMs?: number }} settings
   */
  const login = async ({ authorize, accountId, name, timeoutMs = 300000 }) => {
    let pending
    let consume
    let fail
    const callback = new Promise((resolve, reject) => { consume = resolve; fail = reject })
    // A callback may reject while the system browser is still opening.
    callback.catch(() => {})
    let answered = false
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      if (req.method !== 'GET' || url.pathname !== '/auth/callback') { res.writeHead(404); res.end(); return }
      if (answered || !pending || url.searchParams.get('state') !== pending.state) { res.writeHead(400); res.end('Invalid sign-in state.'); return }
      answered = true
      res.end(url.searchParams.has('error') ? 'Sign-in was not completed. Return to Mohdel.' : 'Return to Mohdel to check whether sign-in completed.')
      consume(url.searchParams)
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve(undefined))
    })
    let timer
    try {
      const started = await startLogin({ redirectUri: `http://127.0.0.1:${server.address().port}/auth/callback`, accountId, name, timeoutMs })
      pending = started.pending
      timer = setTimeout(() => fail(new Error('ChatGPT sign-in timed out')), timeoutMs)
      Promise.resolve(authorize(started.url)).catch(fail)
      return await finishLogin(pending, await callback)
    } finally {
      clearTimeout(timer)
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
  }

  return { accounts, select, access, models, startLogin, finishLogin, login, logout }
}
