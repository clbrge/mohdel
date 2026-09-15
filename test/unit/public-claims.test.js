import { describe, it, expect } from 'vitest'
import { readFileSync, globSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import providers from '../../src/lib/providers.js'

const read = name => readFileSync(fileURLToPath(new URL(`../../${name}`, import.meta.url)), 'utf8')
const pkg = JSON.parse(read('package.json'))
const readme = read('README.md')

const chatAdapters = new Set(
  globSync('js/session/adapters/*.js', { cwd: fileURLToPath(new URL('../../', import.meta.url)) })
    .map(f => f.split('/').pop().slice(0, -3))
)
const remote = Object.keys(providers).filter(name => name !== 'local' && chatAdapters.has(name))

describe('provider count claimed to the public', () => {
  it('matches the catalogue in the npm description', () => {
    const claim = pkg.description.match(/(\d+) providers/)
    expect(claim, pkg.description).not.toBeNull()
    expect(Number(claim[1])).toBe(remote.length)
  })

  it('matches the catalogue in the README pitch', () => {
    const claim = readme.match(/(\d+) providers/)
    expect(claim).not.toBeNull()
    expect(Number(claim[1])).toBe(remote.length)
  })

  it('documents an API key env var for every provider', () => {
    const undocumented = remote
      .map(name => providers[name].apiKeyEnv)
      .filter(env => env && !readme.includes(env))
    expect(undocumented).toEqual([])
  })

  it('matches the length of the README provider list', () => {
    const line = readme.match(/^Providers: (.+?)\. Node/m)
    expect(line).not.toBeNull()
    expect(line[1].split(', ')).toHaveLength(remote.length)
  })
})
