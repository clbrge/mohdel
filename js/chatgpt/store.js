import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import envPaths from 'env-paths'

export const defaultDirectory = () => join(envPaths('mohdel', { suffix: null }).data, 'chatgpt')

export async function readStore (directory) {
  const path = join(directory, 'accounts.json')
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return { host: `urn:uuid:${randomUUID()}`, active: null, accounts: {} }
    throw err
  }
  try {
    return JSON.parse(text)
  } catch {
    // V8's parse error quotes the input, which here holds tokens.
    throw new Error(`ChatGPT credentials are not valid JSON: ${path}`)
  }
}

export async function writeStore (directory, store) {
  const temporary = join(directory, `${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify(store), { mode: 0o600, flag: 'wx' })
    await rename(temporary, join(directory, 'accounts.json'))
  } finally {
    await unlink(temporary).catch(err => { if (err.code !== 'ENOENT') throw err })
  }
}

// A filesystem lock also serializes refresh-token rotation between session processes.
// Never steal a lock on a timer: a slow token exchange may still own it.
export async function withStore (directory, action) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const lock = join(directory, 'accounts.lock')
  const until = Date.now() + 35000
  while (true) {
    try {
      await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 })
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      if (Date.now() >= until) throw new Error(`ChatGPT credentials are locked: ${lock}. If its owner has exited, remove this lock and retry.`)
      await delay(100)
    }
  }
  try {
    return await action(await readStore(directory), store => writeStore(directory, store))
  } finally {
    await unlink(lock)
  }
}
