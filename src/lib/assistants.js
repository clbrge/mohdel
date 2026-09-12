import { statSync } from 'node:fs'
import { join, delimiter } from 'node:path'

const AGENTS = [
  { bin: 'claude', label: 'Claude Code', start: p => `claude ${p}` },
  { bin: 'codex', label: 'Codex CLI', start: p => `codex ${p}` },
  { bin: 'gemini', label: 'Gemini CLI', start: p => `gemini -i ${p}` },
  { bin: 'opencode', label: 'opencode', start: p => `opencode --prompt ${p}` },
  { bin: 'cursor-agent', label: 'Cursor CLI', start: p => `cursor-agent ${p}`, note: "installs as 'agent' on some platforms" },
  { bin: 'aider', label: 'Aider', start: p => `aider --message ${p}`, note: 'sends one message, then exits' }
]

const isExecutable = (path) => {
  try {
    const stat = statSync(path)
    return stat.isFile() && (stat.mode & 0o111) !== 0
  } catch {
    return false
  }
}

export const detectAssistants = () => {
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean)
  return AGENTS.map(a => a.bin).filter(bin => dirs.some(dir => isExecutable(join(dir, bin))))
}

const TOP = AGENTS.slice(0, 5)

export const launchLines = (installed = detectAssistants(), chosen = null, indent = '     ') => {
  const rows = chosen && !AGENTS.some(a => a.bin === chosen) ? [custom(chosen), ...TOP] : TOP
  const width = Math.max(...rows.map(a => a.start('"<prompt>"').length))
  return rows.map(a => {
    const mark = a.bin === chosen
      ? '← yours'
      : installed.includes(a.bin) ? '← on your PATH' : null
    const marks = [mark, a.note].filter(Boolean)
    const line = indent + a.start('"<prompt>"')
    return marks.length ? `${line.padEnd(indent.length + width + 3)}${marks.join('; ')}` : line
  })
}

// A binary the user named that mohdel has no entry for. Passing the prompt as
// one argument is the form every agent CLI accepts.
const custom = (bin) => ({ bin, label: bin, start: p => `${bin} ${p}` })

export const preferredAgent = (chosen, installed = detectAssistants()) => {
  if (chosen) return AGENTS.find(a => a.bin === chosen) || custom(chosen)
  return TOP.find(a => installed.includes(a.bin)) || TOP[0]
}

export const handoff = (provider, installed = detectAssistants(), chosen = null) => {
  const scope = provider ? ` ${provider}` : ''

  const none = installed.length === 0 && !chosen
    ? `

Nothing on your PATH looks like a coding agent. Mohdel does not ship one;
Claude Code, Codex CLI and opencode all install from npm.

You can also skip the agent entirely: OpenRouter publishes prices in its own
model list, so 'mo curate openrouter' writes a complete catalog with no brief
and no pricing page. It has a free tier and needs no card.`
    : ''

  return `This brief is written for a coding agent, not for you.${none}

1. mo model instructions${scope} > mohdel-brief.md

2. start your coding agent on <prompt>:

     ${briefPrompt('mohdel-brief.md', provider)}

${launchLines(installed, chosen).join('\n')}

   Any other agent works too, with one requirement: it must be able to fetch a
   web page. The brief sends it to the provider's pricing page, and an agent
   that cannot read one will either stop or guess.

3. it drafts mohdel-candidate.json and checks it with
   'mo model check --entry mohdel-candidate.json', then hands you
   'mo model apply mohdel-candidate.json' — which shows the diff before writing.`
}

export const briefPrompt = (file, provider) =>
  `read ${file} and add ${provider ? provider + ' ' : ''}models to my mohdel catalog`

export { AGENTS }
