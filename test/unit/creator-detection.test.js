import { describe, test, expect } from 'vitest'
import creators, { creatorFromModelId } from '../../src/lib/creators.js'

describe('creatorFromModelId', () => {
  test('a family prefix identifies the lab', () => {
    expect(creatorFromModelId('claude-opus-5')).toBe('anthropic')
    expect(creatorFromModelId('gemini-3.8-flash')).toBe('google')
    expect(creatorFromModelId('gemma-4-31b-it')).toBe('google')
    expect(creatorFromModelId('qwen3-4b')).toBe('alibaba')
    expect(creatorFromModelId('grok-4.6')).toBe('xai')
    expect(creatorFromModelId('flux-2-dev')).toBe('bfl')
  })

  test('a model served elsewhere keeps its own lab', () => {
    expect(creatorFromModelId('gpt-oss-120b')).toBe('openai')
    expect(creatorFromModelId('whisper-large-v3-turbo')).toBe('openai')
    expect(creatorFromModelId('llama-4-scout-17b')).toBe('meta')
  })

  test('a router-style namespace wins over the rest of the id', () => {
    expect(creatorFromModelId('moonshotai/kimi-k3')).toBe('moonshotai')
    expect(creatorFromModelId('kwaipilot/kat-coder-pro')).toBe('kwaipilot')
    expect(creatorFromModelId('zai-org/glm-4.7-flash')).toBe('zai')
    expect(creatorFromModelId('minimax/minimax-m3')).toBe('minimax')
  })

  test('a prefix only matches on a token boundary', () => {
    expect(creatorFromModelId('gemma-4')).toBe('google')
    expect(creatorFromModelId('gemmarama-7b')).toBeNull()
    expect(creatorFromModelId('grokking-12b')).toBeNull()
  })

  test('an unknown id guesses nothing rather than guessing wrong', () => {
    expect(creatorFromModelId('something-unknown')).toBeNull()
    expect(creatorFromModelId('')).toBeNull()
  })

  test('every prefix belongs to a creator the registry describes', () => {
    for (const [name, def] of Object.entries(creators)) {
      for (const p of def.prefixes || []) {
        expect(typeof p, `${name}`).toBe('string')
        expect(creatorFromModelId(`${p}-1`), `${p} should resolve`).toBe(name)
      }
    }
  })
})
