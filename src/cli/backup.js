import { existsSync } from 'fs'
import { readFile, copyFile, stat } from 'fs/promises'
import { CURATED_PATH, BACKUP_SLOTS } from '../lib/common.js'
import { id, meta, ok, err, warn } from './colors.js'

export async function runBackup (args) {
  const [action, slot] = args

  if (!action || action === '-h' || action === '--help') {
    console.log(`mohdel model backup — manage catalog backups

Usage:
  model backup list                Show backup slots with timestamps
  model backup restore <slot>      Restore from a backup slot
  model backup diff <slot>         Show changes between current and slot

Slots: prev (last save), daily (first save of the day), weekly (first save of the week)`)
    process.exit(0)
  }

  if (action === 'list') {
    const current = existsSync(CURATED_PATH) ? await stat(CURATED_PATH) : null
    if (current) {
      const entries = JSON.parse(await readFile(CURATED_PATH, 'utf8'))
      const count = Object.keys(entries).length
      console.log(`  ${ok('●')} current  ${meta(fmtDate(current.mtimeMs))}  ${meta(`${count} models`)}`)
    } else {
      console.log(`  ${meta('○')} current  ${meta('(no catalog)')}`)
    }
    for (const s of BACKUP_SLOTS) {
      const path = CURATED_PATH + '.' + s
      if (existsSync(path)) {
        const st = await stat(path)
        const entries = JSON.parse(await readFile(path, 'utf8'))
        const count = Object.keys(entries).length
        console.log(`  ${ok('●')} ${id(s.padEnd(7))}  ${meta(fmtDate(st.mtimeMs))}  ${meta(`${count} models`)}`)
      } else {
        console.log(`  ${meta('○')} ${meta(s.padEnd(7))}  ${meta('(empty)')}`)
      }
    }
    return
  }

  if (action === 'restore') {
    if (!slot || !BACKUP_SLOTS.includes(slot)) {
      console.error(`Usage: model backup restore <${BACKUP_SLOTS.join('|')}>`)
      process.exit(1)
    }
    const backupPath = CURATED_PATH + '.' + slot
    if (!existsSync(backupPath)) {
      console.error(err(`No backup in slot "${slot}"`))
      process.exit(1)
    }
    // Rotate current to .prev before restoring
    if (existsSync(CURATED_PATH)) {
      await copyFile(CURATED_PATH, CURATED_PATH + '.prev')
    }
    await copyFile(backupPath, CURATED_PATH)
    const entries = JSON.parse(await readFile(CURATED_PATH, 'utf8'))
    console.log(`${ok('✓')} Restored from ${id(slot)} (${Object.keys(entries).length} models). Previous state saved to ${meta('prev')}.`)
    return
  }

  if (action === 'diff') {
    if (!slot || !BACKUP_SLOTS.includes(slot)) {
      console.error(`Usage: model backup diff <${BACKUP_SLOTS.join('|')}>`)
      process.exit(1)
    }
    const backupPath = CURATED_PATH + '.' + slot
    if (!existsSync(backupPath)) {
      console.error(err(`No backup in slot "${slot}"`))
      process.exit(1)
    }
    if (!existsSync(CURATED_PATH)) {
      console.error(err('No current catalog'))
      process.exit(1)
    }

    const current = JSON.parse(await readFile(CURATED_PATH, 'utf8'))
    const backup = JSON.parse(await readFile(backupPath, 'utf8'))
    const currentKeys = new Set(Object.keys(current))
    const backupKeys = new Set(Object.keys(backup))

    const added = [...currentKeys].filter(k => !backupKeys.has(k))
    const removed = [...backupKeys].filter(k => !currentKeys.has(k))
    const changed = [...currentKeys].filter(k => backupKeys.has(k) && JSON.stringify(current[k]) !== JSON.stringify(backup[k]))

    if (!added.length && !removed.length && !changed.length) {
      console.log(meta('No differences'))
      return
    }

    for (const k of added) console.log(`${ok('+')} ${id(k)}`)
    for (const k of removed) console.log(`${err('-')} ${id(k)}`)
    for (const k of changed) console.log(`${warn('~')} ${id(k)}`)
    console.log(meta(`\n${added.length} added, ${removed.length} removed, ${changed.length} changed`))
    return
  }

  console.error(`Unknown action: ${action}. Run "model backup --help".`)
  process.exit(1)
}

function fmtDate (ms) {
  const d = new Date(ms)
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString()
}
