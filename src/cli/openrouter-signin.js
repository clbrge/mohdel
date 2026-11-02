import { randomBytes, createHash } from 'node:crypto'
import { text, isCancel, log } from '@clack/prompts'

const AUTHORIZE_URL = 'https://openrouter.ai/auth'
const EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys'

export const challengeOf = (verifier) => createHash('sha256').update(verifier).digest('base64url')

const pkcePair = () => {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: challengeOf(verifier) }
}

const exchange = async (code, verifier) => {
  const res = await fetch(EXCHANGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' })
  })
  if (!res.ok) {
    const said = await res.text()
    if (res.status === 403 && /expired/i.test(said)) throw new Error('code expired, sign in again')
    throw new Error(`OpenRouter refused the code: ${res.status} ${said}`)
  }
  const { key } = await res.json()
  if (typeof key !== 'string') throw new Error('OpenRouter answered without a key')
  return key
}

export const keyPage = (key) => `https://openrouter.ai/keys/${createHash('sha256').update(key).digest('hex')}`

/** A key OpenRouter makes for the user once they authorize, labelled `label`; null when they cancel. */
export async function signIn ({ label }) {
  const { verifier, challenge } = pkcePair()
  const url = new URL(AUTHORIZE_URL)
  url.search = new URLSearchParams({ code_challenge: challenge, code_challenge_method: 'S256', key_label: label }).toString()
  log.step('Open this link, sign in and authorize. OpenRouter then shows a code.')
  console.log(url.toString())
  const pasted = await text({
    message: 'Paste the code OpenRouter shows:',
    validate: (value) => {
      if (!value || !value.trim()) return 'The code cannot be empty'
    }
  })
  if (isCancel(pasted)) return null
  return exchange(pasted.trim(), verifier)
}
