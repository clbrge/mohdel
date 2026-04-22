import mohdel, { silent } from '../lib/index.js'
import { parseJsonFlag, jsonOutput } from './json-output.js'
import { id, label, tag, meta, err } from './colors.js'

// CLI logger: silent for noisy levels, console.error for errors and fatals.
const cliLogger = { ...silent, error: console.error, fatal: console.error }

export async function runTag (args) {
  const jsonFlag = parseJsonFlag(args)
  const [action, arg1, arg2] = args

  if (!action || action === '-h' || action === '--help') {
    console.log(`mohdel tag — manage model tags

Usage:
  tag list [--json]              List all unique tags
  tag list <model> [--json]      Show tags on a model
  tag show <tag> [--json]        List models with a tag
  tag add <model> <tag>          Add a tag to a model
  tag rm <model> <tag>           Remove a tag from a model`)
    process.exit(0)
  }

  const mo = await mohdel({ logger: cliLogger })

  function useModel (modelId) {
    try { return mo.use(modelId) } catch (e) {
      console.error(err(e.message))
      process.exit(1)
    }
  }

  if (action === 'list') {
    // tag list <model> — show tags on a model
    if (arg1) {
      const modelTags = useModel(arg1).tags()
      if (jsonFlag.json) {
        jsonOutput(modelTags.map(t => ({ tag: t })), jsonFlag.fields)
        return
      }
      console.log(modelTags.length ? modelTags.map(t => tag(t)).join(', ') : meta('(no tags)'))
      return
    }
    // tag list — list all unique tags
    const all = mo.list()
    const tags = new Set()
    for (const m of all) {
      for (const t of mo.use(m.value).tags()) tags.add(t)
    }
    const sorted = [...tags].sort()
    if (jsonFlag.json) {
      jsonOutput(sorted.map(t => ({ tag: t })), jsonFlag.fields)
      return
    }
    for (const t of sorted) console.log(tag(t))
    return
  }

  // tag show <tag> — list models with a tag
  if (action === 'show') {
    if (!arg1) { console.error('Usage: tag show <tag>'); process.exit(1) }
    const models = mo.list(arg1)
    if (!models.length) { console.log(meta(`No models with tag "${arg1}"`)); return }
    if (jsonFlag.json) {
      jsonOutput(models.map(m => ({ id: m.value, label: m.label })), jsonFlag.fields)
      return
    }
    for (const m of models) console.log(`${id(m.value)}  ${label(m.label)}`)
    return
  }

  // tag model <model> — backward compat alias for tag list <model>
  if (action === 'model') {
    if (!arg1) { console.error('Usage: tag list <model>'); process.exit(1) }
    const modelTags = useModel(arg1).tags()
    if (jsonFlag.json) {
      jsonOutput(modelTags.map(t => ({ tag: t })), jsonFlag.fields)
      return
    }
    console.log(modelTags.length ? modelTags.map(t => tag(t)).join(', ') : meta('(no tags)'))
    return
  }

  if (action === 'add') {
    if (!arg1 || !arg2) { console.error('Usage: tag add <model> <tag>'); process.exit(1) }
    try {
      const modelTags = await useModel(arg1).addTag(arg2)
      console.log(`${id(arg1)}: ${modelTags.map(t => tag(t)).join(', ')}`)
    } catch (e) {
      console.error(err(e.message))
      process.exit(1)
    }
    return
  }

  if (action === 'rm' || action === 'remove') {
    if (!arg1 || !arg2) { console.error('Usage: tag rm <model> <tag>'); process.exit(1) }
    const modelTags = await useModel(arg1).delTag(arg2)
    console.log(`${id(arg1)}: ${modelTags.length ? modelTags.map(t => tag(t)).join(', ') : meta('(no tags)')}`)
    return
  }

  console.error(`Unknown action: ${action}. Run "tag --help".`)
  process.exit(1)
}
