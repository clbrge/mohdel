import { chmodSync, existsSync } from 'fs'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { dirname } from 'path'
import { ENV_PATH } from './common.js'

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Read, edit, write: two writers at once can lose one.
 * @param {string} key
 * @param {string} value
 */
export async function appendToEnvFile (key, value) {
  const dir = dirname(ENV_PATH)
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })

  let content = ''
  if (existsSync(ENV_PATH)) {
    content = await readFile(ENV_PATH, 'utf8')
    // Function form: `$&`, `` $` ``, `$'` and `$1` are expanded inside a replacement string, which would rewrite a pasted key.
    const re = new RegExp(`^${escapeRegExp(key)}=.*$`, 'm')
    if (re.test(content)) {
      content = content.replace(re, () => `${key}=${value}`)
      await writeFile(ENV_PATH, content, { mode: 0o600 })
      chmodSync(ENV_PATH, 0o600)
      return
    }
    if (!content.endsWith('\n')) content += '\n'
  }
  content += `${key}=${value}\n`
  await writeFile(ENV_PATH, content, { mode: 0o600 })
  chmodSync(ENV_PATH, 0o600)
}
