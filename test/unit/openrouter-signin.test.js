import { describe, test, expect, vi, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { startOpenRouterSignIn, finishOpenRouterSignIn, keyPage } from '../../src/lib/credentials.js'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

describe('OpenRouter sign-in as a start and a finish', () => {
  test('the link carries the S256 challenge of the verifier handed back, and the label', () => {
    const { url, verifier } = startOpenRouterSignIn({ label: 'spore via Mohdel (host)' })
    const link = new URL(url)
    expect(link.origin + link.pathname).toBe('https://openrouter.ai/auth')
    expect(link.searchParams.get('code_challenge')).toBe(createHash('sha256').update(verifier).digest('base64url'))
    expect(link.searchParams.get('code_challenge_method')).toBe('S256')
    expect(link.searchParams.get('key_label')).toBe('spore via Mohdel (host)')
    expect(link.searchParams.has('callback_url')).toBe(false)
  })

  test('a callback URL is passed on, so OpenRouter sends the code there', () => {
    const { url } = startOpenRouterSignIn({ label: 'x', callbackUrl: 'http://127.0.0.1:8080/oki/openrouter' })
    expect(new URL(url).searchParams.get('callback_url')).toBe('http://127.0.0.1:8080/oki/openrouter')
  })

  test('each start has its own verifier', () => {
    expect(startOpenRouterSignIn({ label: 'x' }).verifier).not.toBe(startOpenRouterSignIn({ label: 'x' }).verifier)
  })

  test('the finish exchanges the code with the start\'s verifier', async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ key: 'sk-or-made' }))
    const { verifier } = startOpenRouterSignIn({ label: 'x' })
    expect(await finishOpenRouterSignIn({ code: 'the-code', verifier })).toBe('sk-or-made')
    const [url, init] = globalThis.fetch.mock.calls[0]
    expect(url).toBe('https://openrouter.ai/api/v1/auth/keys')
    expect(JSON.parse(init.body)).toEqual({ code: 'the-code', code_verifier: verifier, code_challenge_method: 'S256' })
  })

  test('an expired code says to sign in again', async () => {
    globalThis.fetch = vi.fn(async () => new Response('code has expired', { status: 403 }))
    await expect(finishOpenRouterSignIn({ code: 'old', verifier: 'v' })).rejects.toThrow('code expired, sign in again')
  })

  test('an answer without a key is refused', async () => {
    globalThis.fetch = vi.fn(async () => Response.json({}))
    await expect(finishOpenRouterSignIn({ code: 'c', verifier: 'v' })).rejects.toThrow('without a key')
  })

  test('the key page is named by the key\'s hash, never the key', () => {
    expect(keyPage('sk-or-made')).toBe(`https://openrouter.ai/keys/${createHash('sha256').update('sk-or-made').digest('hex')}`)
  })
})
