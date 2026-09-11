import { readdirSync } from 'node:fs'
import { describe, test, expect } from 'vitest'
import { ADAPTER_NAMES, IMAGE_ADAPTER_NAMES, SPEED_LANES, isImageProvider } from '../../js/session/adapters/_registry.js'

const files = (dir) => readdirSync(new URL(dir, import.meta.url))
  .filter(f => f.endsWith('.js') && !f.startsWith('_') && f !== 'index.js')
  .map(f => f.replace(/\.js$/, ''))

describe('adapter registry', () => {
  test('names match the adapter modules on disk', () => {
    expect([...ADAPTER_NAMES].sort()).toEqual(files('../../js/session/adapters/').sort())
  })

  test('image names match the image adapter modules on disk', () => {
    expect([...IMAGE_ADAPTER_NAMES].sort()).toEqual(files('../../js/session/adapters/image/').sort())
  })

  test('every name resolves to an adapter export', async () => {
    for (const name of ADAPTER_NAMES) {
      const module = await import(`../../js/session/adapters/${name}.js`)
      expect(typeof module[name], name).toBe('function')
    }
  })

  test('every image name resolves to an adapter export', async () => {
    for (const name of IMAGE_ADAPTER_NAMES) {
      const module = await import(`../../js/session/adapters/image/${name}.js`)
      expect(typeof module[`${name}Image`], name).toBe('function')
    }
  })

  test('the registry agrees with the adapter about speed lanes', async () => {
    const { openai } = await import('../../js/session/adapters/openai.js')
    expect(openai.speedLanes).toBe(SPEED_LANES.openai)
  })

  test('isImageProvider answers without loading an adapter', () => {
    expect(isImageProvider('openai')).toBe(true)
    expect(isImageProvider('anthropic')).toBe(false)
    expect(isImageProvider('../../evil')).toBe(false)
  })

  test('a traversal-shaped provider name is not a known adapter', () => {
    for (const bad of ['..', '../../evil', '/etc/passwd', 'openai/../../x']) {
      expect(ADAPTER_NAMES.includes(bad), bad).toBe(false)
    }
  })
})
