import { readFile, rm } from 'node:fs/promises'
import { CURATED_PATH, getCuratedModels, saveCuratedModels, tildePath } from '../lib/common.js'
import { parseCandidates, reviewCandidates } from '../lib/catalog-review.js'
import { localConventionsOrExit } from './local.js'
import { id, label, meta, err, warn, ok } from './colors.js'

const readStdin = async () => {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

const readCandidateFile = async (path) => {
  if (path === '-') return readStdin()
  return readFile(path, 'utf8')
}

const show = (value) => JSON.stringify(value)

const renderChange = ({ field, from, to }) => {
  const name = field.padEnd(22)
  if (from === undefined) return `  ${ok('+')} ${name} ${show(to)}`
  if (to === undefined) return `  ${err('-')} ${name} ${show(from)} ${meta('→ (removed)')}`
  return `  ${warn('~')} ${name} ${show(from)} ${meta('→')} ${show(to)}`
}

export const printReview = (reviews, ignored) => {
  for (const key of ignored) {
    console.log(meta(`skipping meta key ${key}`))
  }
  for (const review of reviews) {
    console.log(`\n${id(review.key)}  ${label(review.status)}`)
    for (const change of review.changes) console.log(renderChange(change))
    for (const e of review.errors) console.log(`  ${err('✗')} ${e}`)
    for (const w of review.warnings) console.log(`  ${warn('!')} ${w}`)
  }
}

export const summarize = (reviews) => ({
  candidates: reviews.length,
  new: reviews.filter(r => r.status === 'new').length,
  changed: reviews.filter(r => r.status === 'changed').length,
  unchanged: reviews.filter(r => r.status === 'unchanged').length,
  errors: reviews.reduce((n, r) => n + r.errors.length, 0),
  warnings: reviews.reduce((n, r) => n + r.warnings.length, 0)
})

const printSummary = (counts) => {
  const parts = [`${counts.new} new`, `${counts.changed} changed`, `${counts.unchanged} unchanged`]
  console.log(`\n${label(`${counts.candidates} candidate(s):`)} ${parts.join(', ')}  ${meta('│')}  ` +
    `${counts.errors ? err(`${counts.errors} error(s)`) : ok('0 errors')}, ${counts.warnings} warning(s)`)
}

const loadReview = async (path) => {
  const { entries, ignored } = parseCandidates(await readCandidateFile(path))
  const curated = await getCuratedModels()
  const local = await localConventionsOrExit()
  return { curated, entries, ignored, reviews: reviewCandidates(curated, entries, { local }) }
}

export async function runCheckEntry (args) {
  const path = args[args.indexOf('--entry') + 1]
  if (!path) {
    console.error('Usage: mo model check --entry <file|->')
    process.exit(1)
  }
  const json = args.includes('--json')

  let review
  try {
    review = await loadReview(path)
  } catch (e) {
    if (json) console.log(JSON.stringify({ error: e.message }, null, 2))
    else console.error(err(e.message))
    process.exit(1)
  }

  const counts = summarize(review.reviews)
  if (json) {
    console.log(JSON.stringify({ counts, ignored: review.ignored, candidates: review.reviews }, null, 2))
  } else {
    printReview(review.reviews, review.ignored)
    printSummary(counts)
    if (!counts.errors) {
      console.log(`${meta('Next:')}  mo model apply ${path === '-' ? '<file>' : path}`)
    }
  }
  if (counts.errors) process.exit(1)
}

export async function runApply (args) {
  if (args.includes('-h') || args.includes('--help')) {
    console.log(`mohdel model apply — write reviewed catalog entries

Usage:
  model apply <file|-> [--yes] [--rm]

Reads entries in curated.json shape, validates them, prints the diff
against ${tildePath(CURATED_PATH)}, and writes after confirmation. Nothing is
written when validation reports an error.

The candidate file is left alone unless you say otherwise — at a terminal
it asks, and --rm removes it without asking. Undo uses the catalog's own
backups, not the candidate.

Options:
  --yes    Skip the confirmation prompt
  --rm     Delete the candidate file once it has been applied

Write an entry with your coding agent: mo model instructions <provider>`)
    process.exit(0)
  }

  const path = args.find(a => !a.startsWith('--'))
  if (!path) {
    console.error('Usage: mo model apply <file|-> [--yes] [--rm]')
    process.exit(1)
  }

  let review
  try {
    review = await loadReview(path)
  } catch (e) {
    console.error(err(e.message))
    process.exit(1)
  }

  const counts = summarize(review.reviews)
  printReview(review.reviews, review.ignored)
  printSummary(counts)

  if (counts.errors) {
    console.error(`\n${err('Not written')} — fix the errors above and run again.`)
    process.exit(1)
  }
  const nothingToDo = !counts.new && !counts.changed
  if (nothingToDo) console.log(`\n${ok('Nothing to write')} — the catalog already matches.`)

  if (!nothingToDo && !args.includes('--yes')) {
    if (!process.stdout.isTTY || path === '-') {
      console.error(`\n${err('Not written')} — no terminal to confirm on. Re-run in a terminal, or pass --yes.`)
      process.exit(1)
    }
    const { confirm, isCancel } = await import('@clack/prompts')
    const go = await confirm({ message: `Write ${counts.new + counts.changed} entry(ies) to ${tildePath(CURATED_PATH)}?` })
    if (isCancel(go) || !go) {
      console.log(meta('Not written.'))
      return
    }
  }

  if (!nothingToDo) {
    await saveCuratedModels({ ...review.curated, ...review.entries })
    console.log(`${ok('✓')} ${counts.new + counts.changed} entry(ies) written to ${tildePath(CURATED_PATH)}`)
    console.log(`${meta('Undo:')}  mo model backup diff prev  ${meta('│')}  mo model backup restore prev`)
  }

  if (path === '-') return
  if (args.includes('--rm')) {
    await rm(path, { force: true })
    console.log(`${ok('✓')} removed ${path}`)
    return
  }
  if (!process.stdout.isTTY) return
  const { confirm, isCancel } = await import('@clack/prompts')
  const drop = await confirm({ message: `Delete ${path}?`, initialValue: false })
  if (isCancel(drop) || !drop) return
  await rm(path, { force: true })
  console.log(`${ok('✓')} removed ${path}`)
}
