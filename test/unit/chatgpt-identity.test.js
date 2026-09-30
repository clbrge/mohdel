import { test, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatGPT } from '../../js/chatgpt/index.js'

const fixture = vi.hoisted(() => ({ keys: null }))
vi.mock('jose', async original => ({
  ...await original(),
  createRemoteJWKSet: () => (...args) => fixture.keys(...args)
}))

let key
let otherKey
let directory
beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  key = pair.privateKey
  otherKey = (await generateKeyPair('RS256')).privateKey
  fixture.keys = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'test', alg: 'RS256', use: 'sig' }] })
})
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'mohdel-chatgpt-identity-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

test.each(['valid', 'issuer', 'audience', 'nonce', 'expired', 'signature'])('verifies real ID-token signatures and claims: %s', async variant => {
  let nonce
  const auth = createChatGPT({
    directory,
    fetch: async () => {
      const idToken = await new SignJWT({ nonce: variant === 'nonce' ? 'wrong' : nonce })
        .setProtectedHeader({ alg: 'RS256', kid: 'test' })
        .setIssuer(variant === 'issuer' ? 'https://other.test' : 'https://auth.openai.com')
        .setAudience(variant === 'audience' ? 'other-client' : 'oaiapp_test')
        .setSubject('subject').setIssuedAt().setExpirationTime(variant === 'expired' ? 1 : '1h')
        .sign(variant === 'signature' ? otherKey : key)
      return Response.json({ access_token: 'secret-access', refresh_token: 'secret-refresh', id_token: idToken, token_type: 'Bearer', expires_in: 3600, scope: 'chatgpt.tokens.use.direct' })
    }
  })
  const pending = auth.login({
    authorize: async value => {
      const url = new URL(value)
      nonce = url.searchParams.get('nonce')
      const callback = new URL(url.searchParams.get('redirect_uri'))
      callback.search = new URLSearchParams({ state: url.searchParams.get('state'), client_id: 'oaiapp_test', code: 'code' })
      await fetch(callback)
    }
  })
  if (variant === 'valid') expect((await pending).planUsage).toBe(true)
  else {
    await expect(pending).rejects.toThrow()
    expect((await auth.accounts())[0].connected).toBe(false)
  }
})
