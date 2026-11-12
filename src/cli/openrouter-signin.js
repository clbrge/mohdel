import { text, isCancel, log } from '@clack/prompts'
import { startOpenRouterSignIn, finishOpenRouterSignIn } from '../lib/credentials.js'

/** A key OpenRouter makes for the user once they authorize, labelled `label`; null when they cancel. */
export async function signIn ({ label }) {
  const { url, verifier } = startOpenRouterSignIn({ label })
  log.step('Open this link, sign in and authorize. OpenRouter then shows a code.')
  console.log(url)
  const pasted = await text({
    message: 'Paste the code OpenRouter shows:',
    validate: (value) => {
      if (!value || !value.trim()) return 'The code cannot be empty'
    }
  })
  if (isCancel(pasted)) return null
  return finishOpenRouterSignIn({ code: pasted.trim(), verifier })
}
