import { createChatGPT, usageURL } from '../../js/chatgpt/index.js'
import { parseJsonFlag, printAvailableFields, jsonOutput } from './json-output.js'

export async function runChatGPT (args) {
  const output = parseJsonFlag(args)
  const nameAt = args.indexOf('--name')
  const name = nameAt === -1 ? undefined : args.splice(nameAt, 2)[1]
  const [verb, id] = args
  const auth = createChatGPT()
  try {
    if (nameAt !== -1 && (verb !== 'login' || !name || name.startsWith('--'))) {
      throw new Error('Usage: mo chatgpt login --name <label>')
    }
    if (verb === 'list' || verb === 'models') {
      const fields = verb === 'list' ? ['id', 'name', 'email', 'active', 'connected', 'planUsage'] : ['id', 'model', 'label']
      if (output.json && !output.fields) { printAvailableFields(fields); return }
      const items = verb === 'list' ? await auth.accounts() : await auth.models(id)
      if (output.json) jsonOutput(items, output.fields)
      else {
        for (const item of items) {
          console.log(verb === 'list'
            ? `${item.active ? '*' : ' '} ${item.id}  ${item.name}  ${item.email ?? ''}  ${item.planUsage ? 'Using ChatGPT plan' : item.connected ? 'Plan usage not enabled' : 'Signed out'}`
            : `${item.id}  ${item.label}`)
        }
      }
      return
    }
    if (verb === 'login') {
      const active = (await auth.accounts()).find(a => a.active)
      const account = await auth.login({
        accountId: id === '--new' || (name && !id) ? undefined : id ?? active?.id,
        name,
        authorize: value => {
          // Retained ID-token hints must never be printed to a terminal or log.
          const url = new URL(value)
          url.searchParams.delete('id_token_hint')
          console.log(`Continue with ChatGPT — open this URL in your browser:\n${url}`)
        }
      })
      console.log(`Connected: ${account.id} ${account.name} ${account.email ?? ''}`)
      console.log(account.planUsage ? 'Using ChatGPT plan. Discover models: mo chatgpt models' : 'Plan usage not enabled. Run mo chatgpt login to grant access.')
      console.log(`Manage usage: ${usageURL}`)
    } else if (verb === 'select' && id) {
      await auth.select(id)
      console.log(`Selected ChatGPT account: ${id}`)
    } else if (verb === 'logout') {
      const { revoked, name: registration } = await auth.logout(id)
      console.log('Signed out locally.')
      if (!revoked) console.log(`Remote revocation was not confirmed. Disconnect "${registration}" in ChatGPT Settings: ${usageURL}`)
    } else if (verb === 'usage') {
      console.log(usageURL)
    } else {
      console.log(`mo chatgpt — use your eligible ChatGPT plan

  login [account-id|--new]   Continue with ChatGPT in your browser
  login --name <label>       Start a new registration, named as ChatGPT shows it
                             (a new registration defaults to Mohdel (<hostname>))
  list [--json fields]      Saved accounts and the active account
  select <account-id>       Choose a saved account
  logout [account-id]       Revoke and clear its local credentials
  models [--json fields]    Discover the selected account's models
  usage                    Open this link to manage plan usage

After signing in, add models with: mo model curate chatgpt
Then call them with: mo ask chatgpt/<model-slug> "your prompt"
Usage consumes your ChatGPT allowance. Reported cost is API USD only.`)
      if (verb && !['--help', '-h'].includes(verb)) process.exitCode = 1
    }
  } catch (err) {
    console.error(err.message)
    process.exitCode = 1
  }
}
