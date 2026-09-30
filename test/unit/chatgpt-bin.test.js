import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultDirectory, withStore } from '../../js/chatgpt/store.js'

const bin = fileURLToPath(new URL('../../js/chatgpt/bin.js', import.meta.url))
const run = (...args) => promisify(execFile)(process.execPath, [bin, ...args], { env: process.env })

let root
let directory
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mohdel-chatgpt-bin-'))
  vi.stubEnv('HOME', root)
  vi.stubEnv('USERPROFILE', root)
  vi.stubEnv('XDG_DATA_HOME', join(root, 'data'))
  vi.stubEnv('LOCALAPPDATA', join(root, 'local'))
  directory = defaultDirectory()
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

const connected = expiresAt => withStore(directory, async (store, save) => {
  store.accounts.oaiapp_test = { client_id: 'oaiapp_test', access_token: 'access-secret', refresh_token: 'refresh-secret', expires_at: expiresAt, scopes: ['chatgpt.tokens.use.direct'] }
  store.active = 'oaiapp_test'
  await save(store)
})

describe('chatgpt/bin access', () => {
  test('prints the active account token and when to ask again', async () => {
    const expiresAt = Date.now() + 3600000
    await connected(expiresAt)
    const { stdout, stderr } = await run('access')
    expect(JSON.parse(stdout)).toEqual({ accessToken: 'access-secret', refreshAt: expiresAt - 30000 })
    expect(stderr).toBe('')
  })

  test('an unknown account fails on stderr without the token', async () => {
    await connected(Date.now() + 3600000)
    const failure = await run('access', '--account', 'oaiapp_other').catch(err => err)
    expect(failure.code).toBe(1)
    expect(failure.stdout).toBe('')
    expect(failure.stderr).toContain('run mo chatgpt login')
    expect(failure.stderr).not.toContain('secret')
  })

  test('a corrupt store is named, not quoted', async () => {
    await withStore(directory, async () => {})
    await writeFile(join(directory, 'accounts.json'), '{"accounts":{"x":{"access_token":"access-secret"')
    const failure = await run('access').catch(err => err)
    expect(failure.code).toBe(1)
    expect(failure.stderr).toContain(join(directory, 'accounts.json'))
    expect(failure.stderr).not.toContain('secret')
  })

  test.each([[], ['refresh'], ['access', '--account'], ['access', '--acount', 'x']])('rejects arguments %j', async (...args) => {
    const failure = await run(...args).catch(err => err)
    expect(failure.code).toBe(1)
    expect(failure.stderr).toContain('usage')
  })
})
