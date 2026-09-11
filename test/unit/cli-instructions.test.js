import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest'
import providerDefs from '../../src/lib/providers.js'
import { fieldDefs } from '../../src/lib/schema.js'

// `common.js` derives CONFIG_DIR from env-paths at module load, so the brief
// must not read the machine's real catalog.
const dirs = vi.hoisted(() => {
  const os = require('node:os')
  const path = require('node:path')
  const fs = require('node:fs')
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'mohdel-instructions-'))
  return { config, cache: config, data: config, log: config, temp: config }
})

vi.mock('env-paths', () => ({ default: () => dirs }))

const { runInstructions } = await import('../../src/cli/instructions.js')
const { CURATED_PATH, tildePath, portablePath } = await import('../../src/lib/common.js')
const { detectAssistants, handoff, launchLines, AGENTS } = await import('../../src/lib/assistants.js')

const capture = async (args = []) => {
  const out = []
  const errs = []
  const log = vi.spyOn(console, 'log').mockImplementation(l => out.push(l))
  const error = vi.spyOn(console, 'error').mockImplementation(l => errs.push(l))
  try {
    await runInstructions(args)
  } finally {
    log.mockRestore()
    error.mockRestore()
  }
  return { out: out.join('\n'), err: errs.join('\n') }
}

const render = async (args = []) => (await capture(args)).out

const referenceSection = (brief) =>
  brief.slice(brief.indexOf('## Where to read the numbers'), brief.indexOf('## Entry kinds'))

beforeAll(() => {
  fs.writeFileSync(CURATED_PATH, JSON.stringify({
    'anthropic/claude-haiku-4-5': {
      model: 'claude-haiku-4-5-20251001',
      creator: 'anthropic',
      provider: 'anthropic',
      inputFormat: ['text'],
      inputPrice: 1
    }
  }))
})

afterAll(() => { fs.rmSync(dirs.config, { recursive: true, force: true }) })

describe('model instructions', () => {
  test('every catalog field reaches the brief with its meaning', async () => {
    const brief = await render()
    for (const field of Object.keys(fieldDefs)) {
      expect(brief).toContain(`| \`${field}\` |`)
    }
    expect(brief).not.toContain('| undefined |')
  })

  test('required fields are marked required', async () => {
    const brief = await render()
    expect(brief).toMatch(/\| `model` \| string \| yes \|/)
    expect(brief).toMatch(/\| `creator` \| string \| yes \|/)
    expect(brief).toMatch(/\| `inputFormat` \| array \| yes \|/)
  })

  test('a provider argument narrows the reference links', async () => {
    const section = referenceSection(await render(['anthropic']))
    expect(section).toContain(providerDefs.anthropic.references.pricing)
    expect(section).not.toContain('`openai`')
  })

  test('no argument lists every provider', async () => {
    const section = referenceSection(await render())
    for (const name of Object.keys(providerDefs)) {
      expect(section).toContain(`\`${name}\``)
    }
  })

  test('a provider with no reference links says so instead of going silent', async () => {
    const brief = await render(['local'])
    expect(brief).toContain('no reference links shipped')
  })

  test('the brief names the catalog it must not edit, and the review commands', async () => {
    const brief = await render(['anthropic'])
    expect(brief).toContain(`Do not edit ${portablePath(CURATED_PATH)}`)
    expect(brief).toContain('mo model check --entry mohdel-candidate.json --json')
    expect(brief).toContain('mo model apply mohdel-candidate.json')
  })

  test('an existing entry for the provider is shown for shape', async () => {
    const brief = await render(['anthropic'])
    expect(brief).toContain('An existing anthropic entry, for shape')
    expect(brief).toContain('claude-haiku-4-5-20251001')
    expect(brief).not.toContain('upstreamIds')
  })

  test('an unknown provider exits non-zero', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(render(['nope'])).rejects.toThrow('exit')
    expect(exit).toHaveBeenCalledWith(1)
    vi.restoreAllMocks()
  })
})

describe('the hand-off to a coding agent', () => {
  test('the recipe goes to stderr so a redirected brief stays clean', async () => {
    const { out, err } = await capture(['anthropic'])
    expect(err).toContain('written for a coding agent, not for you')
    expect(err).toContain('mo model instructions anthropic > mohdel-brief.md')
    expect(err).toContain('mo model apply mohdel-candidate.json')
    expect(out).not.toContain('not for you')
    expect(out.startsWith('# mohdel catalog entry')).toBe(true)
  })

  test('every one of the top five agents gets a launch line', () => {
    const lines = launchLines([]).join('\n')
    expect(lines).toContain('claude "<prompt>"')
    expect(lines).toContain('codex "<prompt>"')
    expect(lines).toContain('gemini -i "<prompt>"')
    expect(lines).toContain('opencode --prompt "<prompt>"')
    expect(lines).toContain('cursor-agent "<prompt>"')
  })

  test('only the installed agents are marked', () => {
    const lines = launchLines(['codex']).join('\n')
    expect(lines).toMatch(/codex "<prompt>"\s+← on your PATH/)
    expect(lines).not.toMatch(/claude "<prompt>"\s+← on your PATH/)
  })

  test("cursor's binary-name ambiguity is stated, not papered over", () => {
    expect(launchLines([]).join('\n')).toContain("installs as 'agent' on some platforms")
  })

  test('the recipe is agent-agnostic even with none installed', () => {
    const text = handoff(null, [])
    expect(text).toContain('mo model instructions > mohdel-brief.md')
    expect(text).toContain('read mohdel-brief.md and add models to my mohdel catalog')
    expect(text).toContain('Any other agent works too')
    expect(text).not.toContain('← on your PATH')
  })

  test('detection returns only agents the table can launch', () => {
    const known = AGENTS.map(a => a.bin)
    for (const name of detectAssistants()) expect(known).toContain(name)
  })
})

describe('paths that leave this machine', () => {
  const home = os.homedir()

  test('a path under home leads with the portable form', () => {
    const under = path.join(home, '.config', 'mohdel', 'curated.json')
    expect(tildePath(under)).toBe('~/.config/mohdel/curated.json')
    expect(portablePath(under)).toBe(`~/.config/mohdel/curated.json (${under} on this machine)`)
  })

  test('a path outside home is printed once, with no parenthetical', () => {
    const outside = path.join(path.sep, 'srv', 'mohdel', 'curated.json')
    expect(tildePath(outside)).toBe(outside)
    expect(portablePath(outside)).toBe(outside)
  })

  test('a sibling directory sharing the home prefix is not collapsed', () => {
    const sibling = `${home}-backup/curated.json`
    expect(tildePath(sibling)).toBe(sibling)
  })
})

describe('provider reference links', () => {
  test('every routable provider ships a pricing and a models link', () => {
    const missing = Object.entries(providerDefs)
      .filter(([name, def]) => name !== 'local' && def.apiKeyEnv)
      .filter(([, def]) => !def.references?.pricing || !def.references?.models)
      .map(([name]) => name)
    expect(missing).toEqual(['xiaomi'])
  })

  test('every reference link is https', () => {
    const bad = Object.values(providerDefs)
      .flatMap(def => Object.values(def.references || {}))
      .filter(url => !url.startsWith('https://'))
    expect(bad).toEqual([])
  })
})

describe('the agent the recipe names', () => {
  test('a stated preference beats what is on PATH', async () => {
    const { preferredAgent } = await import('../../src/lib/assistants.js')
    expect(preferredAgent('codex', ['claude']).bin).toBe('codex')
    expect(preferredAgent(null, ['codex']).bin).toBe('codex')
  })

  test('with no preference and nothing installed it still names one', async () => {
    const { preferredAgent } = await import('../../src/lib/assistants.js')
    expect(preferredAgent(null, []).bin).toBe('claude')
  })

  test('an agent mohdel has no entry for still gets a runnable line', async () => {
    const { preferredAgent, launchLines } = await import('../../src/lib/assistants.js')
    expect(preferredAgent('my-agent', []).start('"x"')).toBe('my-agent "x"')
    expect(launchLines([], 'my-agent').join('\n')).toContain('my-agent "<prompt>"')
  })

  test('the chosen agent is marked, and only it', async () => {
    const { launchLines } = await import('../../src/lib/assistants.js')
    const lines = launchLines(['claude'], 'codex').join('\n')
    expect(lines).toMatch(/codex "<prompt>"\s+← yours/)
    expect(lines).toMatch(/claude "<prompt>"\s+← on your PATH/)
    expect(lines.match(/← yours/g)).toHaveLength(1)
  })
})

describe('writeBrief', () => {
  test('replaces a brief mohdel wrote, writes alongside anything else', async () => {
    const { writeBrief, BRIEF_FILE, BRIEF_HEADING } = await import('../../src/cli/instructions.js')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mohdel-brief-'))
    const cwd = process.cwd()
    process.chdir(dir)
    try {
      expect(await writeBrief('anthropic')).toBe(BRIEF_FILE)
      expect(fs.readFileSync(path.join(dir, BRIEF_FILE), 'utf8').startsWith(BRIEF_HEADING)).toBe(true)

      expect(await writeBrief('anthropic')).toBe(BRIEF_FILE)
      expect(fs.readdirSync(dir)).toEqual([BRIEF_FILE])

      fs.writeFileSync(path.join(dir, BRIEF_FILE), 'my own notes\n')
      expect(await writeBrief('anthropic')).toBe('mohdel-brief-2.md')
      expect(fs.readFileSync(path.join(dir, BRIEF_FILE), 'utf8')).toBe('my own notes\n')
    } finally {
      process.chdir(cwd)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('bootstrapping an empty catalog', () => {
  test('the brief tells the agent not to ask a beginner to name a model', async () => {
    fs.rmSync(CURATED_PATH, { force: true })
    const brief = await render(['gemini'])
    expect(brief).toContain('## This catalog is empty')
    expect(brief).toContain('mo provider models gemini --json')
    expect(brief).toMatch(/do not ask them to/)
  })

  test('the section is absent once anything is curated', async () => {
    fs.writeFileSync(CURATED_PATH, JSON.stringify({
      'gemini/x': { model: 'x', creator: 'google', inputFormat: ['text'], inputPrice: 1 }
    }))
    expect(await render(['gemini'])).not.toContain('## This catalog is empty')
  })

  test('the prompt a user pastes carries no placeholder to fill in', async () => {
    const { briefPrompt } = await import('../../src/lib/assistants.js')
    const prompt = briefPrompt('mohdel-brief.md', 'gemini')
    expect(prompt).toBe('read mohdel-brief.md and add gemini models to my mohdel catalog')
    expect(prompt).not.toMatch(/[<>]/)
  })
})

describe('free tiers in the brief', () => {
  test('a provider with a free tier is flagged, with the rule for what to record', async () => {
    const brief = await render(['gemini'])
    expect(brief).toContain('free tier: yes')
    expect(brief).toContain('### A free tier is not a price')
    expect(brief).toMatch(/Record\s+the \*\*paid\*\* rates anyway/)
  })

  test('a provider without one is not flagged', async () => {
    expect(await render(['anthropic'])).not.toContain('free tier: yes')
  })

  test('every provider the picker calls free is flagged in the brief', async () => {
    const { default: PROVIDER_INFO } = await import('../../src/lib/provider-info.js')
    for (const [name, info] of Object.entries(PROVIDER_INFO)) {
      if (!info.free) continue
      expect(await render([name]), name).toContain('free tier: yes')
    }
  })
})

describe('the provider whose API publishes prices', () => {
  test('exactly one provider declares it, and it is openrouter', async () => {
    const { default: providers } = await import('../../src/lib/providers.js')
    const declared = Object.entries(providers).filter(([, d]) => d.pricesFromApi).map(([n]) => n)
    expect(declared).toEqual(['openrouter'])
  })

  test('its brief says the list carries prices rather than sending the agent to a page', async () => {
    const brief = await render(['openrouter'])
    expect(brief).toContain('is the exception among providers')
    expect(brief).toContain('mo curate openrouter')
    expect(brief).not.toContain('Provider APIs return model *ids*, not prices.')
  })

  test('every other provider still gets the ids-not-prices line', async () => {
    const brief = await render(['anthropic'])
    expect(brief).toContain('Provider APIs return model *ids*, not prices.')
    expect(brief).not.toContain('is the exception among providers')
  })

  test('the no-agent hand-off names it as the way to skip an agent', async () => {
    const { handoff } = await import('../../src/lib/assistants.js')
    const text = handoff('openai', [], null)
    expect(text).toContain('skip the agent entirely')
    expect(text).toContain('mo curate openrouter')
  })
})
