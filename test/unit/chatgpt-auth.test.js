import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createChatGPT } from '../../js/chatgpt/index.js'
import { readStore, withStore } from '../../js/chatgpt/store.js'

let directory
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'mohdel-chatgpt-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })
const tokens = () => ({ access_token: 'access-secret', refresh_token: 'refresh-secret', id_token: 'identity-secret', token_type: 'Bearer', expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct' })

async function connect (options = {}) {
  let authorization
  const fetcher = options.fetch ?? vi.fn(async () => Response.json(tokens()))
  const verifyIdentity = options.verifyIdentity ?? vi.fn(async () => ({ sub: 'subject', email: 'user@example.test' }))
  const auth = createChatGPT({ directory, fetch: fetcher, verifyIdentity })
  const result = await auth.login({
    accountId: options.accountId,
    authorize: async value => {
      authorization = new URL(value)
      const callback = new URL(authorization.searchParams.get('redirect_uri'))
      callback.search = new URLSearchParams({ state: authorization.searchParams.get('state'), code: 'code', client_id: options.clientId ?? 'oaiapp_test' })
      await fetch(callback)
    }
  })
  return { auth, result, authorization, fetcher, verifyIdentity }
}

describe('ChatGPT OAuth', () => {
  test('binds PKCE and nonce, saves the issued client and protects credentials', async () => {
    const { auth, result, authorization, fetcher, verifyIdentity } = await connect()
    expect(authorization.searchParams.get('client_id')).toBe('dynamic_agent_client')
    expect(authorization.searchParams.get('scope')).toContain('chatgpt.tokens.use.direct')
    const exchange = fetcher.mock.calls[0][1].body
    expect(exchange.get('client_id')).toBe('oaiapp_test')
    expect(exchange.get('redirect_uri')).toBe(authorization.searchParams.get('redirect_uri'))
    expect(createHash('sha256').update(exchange.get('code_verifier')).digest('base64url')).toBe(authorization.searchParams.get('code_challenge'))
    expect(verifyIdentity).toHaveBeenCalledWith('identity-secret', 'oaiapp_test', authorization.searchParams.get('nonce'))
    expect(result.planUsage).toBe(true)
    expect((await stat(join(directory, 'accounts.json'))).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(await auth.accounts())).not.toContain('secret')
    const { expires_at: expiresAt } = (await readStore(directory)).accounts.oaiapp_test
    expect(await auth.access()).toEqual({ accessToken: 'access-secret', accountId: 'oaiapp_test', refreshAt: expiresAt - 30000 })
  })

  test('ignores a mismatched state before accepting the valid callback', async () => {
    const fetcher = vi.fn(async () => Response.json(tokens()))
    const auth = createChatGPT({ directory, fetch: fetcher, verifyIdentity: async () => ({ sub: 'subject' }) })
    await auth.login({
      authorize: async value => {
        const url = new URL(value)
        const callback = new URL(url.searchParams.get('redirect_uri'))
        callback.search = new URLSearchParams({ code: 'code', client_id: 'oaiapp_test', state: 'wrong' })
        expect((await fetch(callback)).status).toBe(400)
        expect(fetcher).not.toHaveBeenCalled()
        callback.searchParams.set('state', url.searchParams.get('state'))
        await fetch(callback)
      }
    })
  })

  test('denial does not exchange a code', async () => {
    const fetcher = vi.fn()
    const auth = createChatGPT({ directory, fetch: fetcher })
    await expect(auth.login({
      authorize: async value => {
        const url = new URL(value)
        const callback = new URL(url.searchParams.get('redirect_uri'))
        callback.search = new URLSearchParams({ state: url.searchParams.get('state'), error: 'access_denied' })
        await fetch(callback)
      }
    })).rejects.toThrow('not granted')
    expect(fetcher).not.toHaveBeenCalled()
  })

  test('identity-only grants cannot perform discovery or inference', async () => {
    const { auth } = await connect({ fetch: async () => Response.json({ ...tokens(), scope: 'openid' }) })
    await expect(auth.access()).rejects.toThrow('plan usage is not enabled')
    await expect(auth.models()).rejects.toThrow('plan usage is not enabled')
  })

  test('keeps issued registration on exchange failure', async () => {
    await expect(connect({ fetch: async () => new Response('', { status: 400 }) })).rejects.toThrow('400')
    const store = await readStore(directory)
    expect(store.accounts.oaiapp_test.client_id).toBe('oaiapp_test')
    expect(store.active).toBeNull()
  })

  test('reauthorization keeps the host/client and rejects a different identity', async () => {
    const first = await connect()
    const second = await connect({ accountId: 'oaiapp_test' })
    expect(second.authorization.searchParams.get('client_id')).toBe('oaiapp_test')
    expect(second.authorization.searchParams.get('ext_agent_host_id')).toBe(first.authorization.searchParams.get('ext_agent_host_id'))
    expect(second.authorization.searchParams.has('agent_name_hint')).toBe(false)
    await expect(connect({ accountId: 'oaiapp_test', verifyIdentity: async () => ({ sub: 'other' }) })).rejects.toThrow('different account')
    await expect(connect({ accountId: 'oaiapp_test', clientId: 'oaiapp_other' })).rejects.toThrow('invalid registration')
  })

  test('serializes rotating refreshes between independent clients', async () => {
    await connect()
    await withStore(directory, async (store, save) => {
      store.accounts.oaiapp_test.expires_at = 0
      await save(store)
    })
    const fetcher = vi.fn(async () => Response.json({ ...tokens(), access_token: 'new-access', refresh_token: 'new-refresh' }))
    const a = createChatGPT({ directory, fetch: fetcher })
    const b = createChatGPT({ directory, fetch: fetcher })
    const results = await Promise.all([a.access(), b.access()])
    expect(results.map(r => r.accessToken)).toEqual(['new-access', 'new-access'])
    expect(results[0].refreshAt).toBeGreaterThan(Date.now())
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][1].body.get('grant_type')).toBe('refresh_token')
    expect((await readStore(directory)).accounts.oaiapp_test.refresh_token).toBe('new-refresh')
  })

  test('discovers visible account models in server order', async () => {
    await connect()
    const auth = createChatGPT({
      directory,
      fetch: async () => Response.json({
        models: [
          { slug: 'z', display_name: 'Z', visibility: 'list' },
          { slug: 'hidden', visibility: 'hide' },
          { slug: 'a', visibility: 'list' }
        ]
      })
    })
    expect((await auth.models()).map(m => m.id)).toEqual(['chatgpt/z', 'chatgpt/a'])
  })

  test('sign-out clears tokens even if remote revocation is unavailable', async () => {
    await connect()
    const auth = createChatGPT({ directory, fetch: async () => { throw new Error('offline') } })
    expect(await auth.logout()).toEqual({ revoked: false })
    await expect(auth.access()).rejects.toThrow('not connected')
    const store = await readStore(directory)
    expect(store.accounts.oaiapp_test).toEqual({ client_id: 'oaiapp_test', subject: 'subject', email: 'user@example.test' })
  })
})
