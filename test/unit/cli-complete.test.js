import { describe, test, expect, vi } from 'vitest'

const dirs = vi.hoisted(() => {
  const os = require('node:os'); const path = require('node:path'); const fs = require('node:fs')
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'mohdel-complete-'))
  fs.mkdirSync(path.join(config, 'mohdel'), { recursive: true })
  fs.writeFileSync(path.join(config, 'mohdel', 'curated.json'), JSON.stringify({
    $schema: 'x',
    'anthropic/claude-opus-5': { model: 'o5', creator: 'anthropic', inputFormat: ['text'], tags: ['fast'] },
    'anthropic/claude-haiku-4-5': { model: 'h45', creator: 'anthropic', inputFormat: ['text'] },
    'openai/gpt-5.6': { model: 'g56', creator: 'openai', inputFormat: ['text'], tags: ['chat'] },
    'openai/gpt-4o': { deprecated: 'openai/gpt-5.6' }
  }))
  return { config: path.join(config, 'mohdel'), cache: config, data: config, log: config, temp: config }
})
vi.mock('env-paths', () => ({ default: () => dirs }))

const { candidates, BASH_SCRIPT } = await import('../../src/cli/complete.js')
const at = (line) => {
  const words = line.split(' ')
  return candidates(words.length - 1, words)
}

describe('completion candidates', () => {
  test('completes a model id mid-word', async () => {
    expect(await at('mo ask anthropic/claude-o')).toEqual(['anthropic/claude-opus-5'])
  })

  test('never offers a deprecated id', async () => {
    const all = await at('mo ask ')
    expect(all).toContain('openai/gpt-5.6')
    expect(all).not.toContain('openai/gpt-4o')
  })

  test('skips catalog meta keys', async () => {
    expect(await at('mo ask ')).not.toContain('$schema')
  })

  test('resolves aliases the way the router does', async () => {
    expect(await at('mo show openai/')).toEqual(await at('mo model show openai/'))
    expect(await at('mo rl show anthropic/')).toEqual(await at('mo ratelimit show anthropic/'))
  })

  test('offers providers where a provider is expected, catalog or not', async () => {
    expect(await at('mo curate gem')).toEqual(['gemini'])
    expect(await at('mo provider setup xi')).toEqual(['xiaomi'])
  })

  test('offers field names for the second argument of model set', async () => {
    expect(await at('mo model set openai/gpt-5.6 inputP')).toEqual(['inputPrice'])
  })

  test('offers tags where a tag is expected', async () => {
    expect(await at('mo tag show ')).toEqual(['chat', 'fast'])
  })

  test('offers commands and aliases at the start', async () => {
    const first = await at('mo ')
    expect(first).toContain('model')
    expect(first).toContain('providers')
  })

  test('offers nothing for free text', async () => {
    expect(await at('mo ask openai/gpt-5.6 why')).toEqual([])
  })

  test('offers nothing for an unknown command', async () => {
    expect(await at('mo bogus ')).toEqual([])
  })

  test('the bash script defines the function it registers', () => {
    expect(BASH_SCRIPT).toContain('_mo_completion()')
    expect(BASH_SCRIPT).toContain('complete -o default -F _mo_completion mo')
    expect(BASH_SCRIPT).toContain('mo __complete "$COMP_CWORD"')
  })
})

describe('the default model is a CLI convenience only', () => {
  test('nothing in the library, session or gate reads it', async () => {
    const { execSync } = await import('node:child_process')
    const root = new URL('../../', import.meta.url).pathname
    const hits = execSync(
      'git grep -lI defaultModel -- src/lib js rust || true',
      { cwd: root, encoding: 'utf8' }
    ).trim()
    expect(hits).toBe('')
  })
})
