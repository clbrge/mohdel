import { test, expect, vi, afterEach } from 'vitest'
import mohdel, { silent } from '../../src/lib/index.js'
import providers from '../../src/lib/providers.js'
import { runAnswer } from '../../js/factory/bridge.js'

vi.mock('../../js/factory/bridge.js', async original => ({
  ...await original(),
  runAnswer: vi.fn(async () => ({ status: 'completed', output: 'Hello', cost: 0, inputTokens: 1, outputTokens: 1 }))
}))
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })
const models = { 'chatgpt/account-model': { model: 'account-model', inputPrice: 0, outputPrice: 0 } }

test('a model proxy resolves a fresh OAuth credential before each answer', async () => {
  const resolver = vi.spyOn(providers.chatgpt, 'resolveConfiguration')
    .mockResolvedValueOnce({ apiKey: 'first' }).mockResolvedValueOnce({ apiKey: 'second' })
  const mo = await mohdel({ models, logger: silent })
  const model = mo.use('chatgpt/account-model')
  await model.answer('one')
  await model.answer('two')
  expect(resolver).toHaveBeenCalledTimes(2)
  expect(runAnswer.mock.calls.map(([args]) => args.configuration.apiKey)).toEqual(['first', 'second'])
})

test('caller-owned per-call credentials do not require a saved local login', async () => {
  const resolver = vi.spyOn(providers.chatgpt, 'resolveConfiguration').mockRejectedValue(new Error('not signed in'))
  const mo = await mohdel({ models, logger: silent })
  await mo.use('chatgpt/account-model').answer('hi', { configuration: { apiKey: 'caller-token' } })
  expect(resolver).not.toHaveBeenCalled()
  expect(runAnswer.mock.calls[0][0].configuration.apiKey).toBe('caller-token')
})

test('factory credentials remain caller-owned', async () => {
  const resolver = vi.spyOn(providers.chatgpt, 'resolveConfiguration').mockRejectedValue(new Error('not signed in'))
  const mo = await mohdel({ models, configurations: { chatgpt: { apiKey: 'caller-token' } }, logger: silent })
  await mo.use('chatgpt/account-model').answer('hi')
  expect(resolver).not.toHaveBeenCalled()
  expect(runAnswer.mock.calls[0][0].configuration.apiKey).toBe('caller-token')
})
