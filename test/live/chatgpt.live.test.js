import { describe, test, expect } from 'vitest'
import { createChatGPT } from '../../js/chatgpt/index.js'
import { chatgpt } from '../../js/session/adapters/chatgpt.js'

// Explicit opt-in: this test spends the selected account's ChatGPT allowance.
describe.skipIf(process.env.MOHDEL_LIVE_CHATGPT !== '1')('ChatGPT plan', () => {
  test('discovers an account model and completes inference', async () => {
    const auth = createChatGPT()
    const models = await auth.models()
    expect(models.length).toBeGreaterThan(0)
    const { accessToken } = await auth.access()
    const events = []
    for await (const event of chatgpt({
      callId: 'chatgpt-live',
      authId: 'local',
      auth: { key: accessToken },
      model: models[0].id,
      prompt: 'Reply with exactly: Hello.'
    })) events.push(event)
    expect(events.at(-1).type).toBe('done')
    expect(events.at(-1).result.output).toBeTruthy()
    expect(events.at(-1).result.cost).toBe(0)
  }, 60000)
})
