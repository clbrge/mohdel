import { resolve, extname } from 'node:path'

import mohdel, { silent } from '../lib/index.js'
import { loadDefaultEnv } from '../lib/common.js'
import { hintsForError } from './ask.js'

const noop = () => {}

const MIME_BY_EXT = {
  '.mp3': 'audio/mpeg',
  '.mpga': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus'
}

export async function runTranscribe (args) {
  if (args.includes('-h') || args.includes('--help')) {
    console.log(`mohdel transcribe — speech → text, pipeable

Usage:
  mo transcribe <model> <audio-file>

Options:
  --language <iso>     ISO-639-1 language hint (e.g. en, fr)
  --prompt <text>      Spelling/context hint forwarded to the provider
  --mime <type>        Override the MIME type guessed from the extension
  --json               Output full result as JSON
  -v, --verbose        Show debug info on stderr

Output:
  stdout: transcript text (raw — or JSON with --json)
  stderr: model name + duration/cost summary

Known extensions: ${Object.keys(MIME_BY_EXT).join(' ')}

Examples:
  mo transcribe groq/whisper-large-v3-turbo meeting.mp3
  mo transcribe mistral/voxtral-mini-transcribe interview.wav --language fr
  mo transcribe groq/whisper-large-v3-turbo memo.m4a --json | jq .cost`)
    process.exit(0)
  }

  loadDefaultEnv()

  const flagVal = (name) => {
    const idx = args.indexOf(name)
    if (idx === -1) return undefined
    const val = args[idx + 1]
    args.splice(idx, 2)
    return val
  }
  const flag = (name) => {
    const idx = args.indexOf(name)
    if (idx === -1) return false
    args.splice(idx, 1)
    return true
  }

  const json = flag('--json')
  const verbose = flag('--verbose') || flag('-v')
  const language = flagVal('--language')
  const prompt = flagVal('--prompt')
  const mimeOverride = flagVal('--mime')

  const [modelId, file] = args
  if (!modelId || !file) {
    console.error('Usage: mo transcribe <model> <audio-file>')
    process.exit(1)
  }

  const mimeType = mimeOverride || MIME_BY_EXT[extname(file).toLowerCase()]
  if (!mimeType) {
    console.error(`Unknown audio extension '${extname(file)}'. Pass --mime <type> (e.g. --mime audio/mpeg).`)
    process.exit(1)
  }

  const log = verbose ? (...args) => process.stderr.write(`${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`) : noop
  const logger = {
    ...silent,
    debug: verbose ? log : noop,
    info: log,
    warn: log,
    error: log,
    fatal: log
  }
  const mo = await mohdel({ logger })

  let model
  try {
    model = mo.use(modelId)
  } catch (err) {
    console.error(err.message)
    for (const h of hintsForError(err, modelId)) console.error(h)
    process.exit(1)
  }

  const options = {}
  if (language) options.language = language
  if (prompt) options.prompt = prompt

  process.stderr.write(`${model.id}\n`)

  try {
    const result = await model.transcribe(
      { fileUri: `file://${resolve(file)}`, mimeType },
      options
    )

    if (json) {
      console.log(JSON.stringify({
        model: model.id,
        text: result.text,
        language: result.language,
        durationSeconds: result.durationSeconds,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cost: result.cost ?? null,
        status: result.status
      }, null, 2))
    } else {
      process.stdout.write(result.text)
      if (result.text && !result.text.endsWith('\n')) process.stdout.write('\n')
    }

    const summary = []
    if (result.durationSeconds != null) summary.push(`${result.durationSeconds}s audio`)
    if (result.inputTokens) summary.push(`${result.inputTokens} in`)
    if (result.outputTokens) summary.push(`${result.outputTokens} out`)
    if (result.cost != null) summary.push(`$${result.cost.toFixed(4)}`)
    const ts = result.timestamps
    if (ts?.start && ts?.end) {
      summary.push(`${Math.round(Number(BigInt(ts.end) - BigInt(ts.start)) / 1e6)}ms total`)
    }
    if (summary.length) process.stderr.write(`${summary.join(', ')}\n`)
  } catch (err) {
    console.error(`Error: ${err.detail || err.message}`)
    for (const h of hintsForError(err, modelId)) console.error(h)
    process.exit(1)
  }
}
