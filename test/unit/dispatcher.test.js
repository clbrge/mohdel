import { describe, test, expect } from 'vitest'
import { Agent } from 'undici'

import { streamingDispatcher } from '../../js/session/adapters/_dispatcher.js'

// The undici body idle timeout (default 300 s) closes a streaming
// response when no chunk arrives for that long. Reasoning models
// stream zero bytes during their thinking phase, so the default
// limit surfaces as a `NET_ERROR / "terminated"` mid-run on hard
// tasks. Adapters opt out via `streamingDispatcher`, which all chat
// completions adapters wire into the SDK's `fetchOptions.dispatcher`.

describe('streamingDispatcher', () => {
  test('returns the same Agent across calls (singleton)', () => {
    expect(streamingDispatcher()).toBe(streamingDispatcher())
  })

  test('returns an undici Agent', () => {
    expect(streamingDispatcher()).toBeInstanceOf(Agent)
  })
})
