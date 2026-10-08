/**
 * Whether a provider, or one model, is ready to call: its credential there, and the model in the
 * catalog. A model without its prices is ready — it runs and its calls report no cost — and says so,
 * so a program that bounds spend can offer to fill them in.
 */

import providers, { billingOf } from './providers.js'
import { catalogEntries, getAPIKey, getCuratedModels } from './common.js'
import { catalogKey, providerOf } from '#core/model-id.js'

export { loadDefaultEnv } from './common.js'

const signsIn = (provider) => providers[provider]?.catalogClient === 'chatgpt'

/** A key set, a ChatGPT account signed in with plan usage on, or nothing needed. */
export async function credentialOf (provider) {
  const def = providers[provider]
  if (!def) return false
  if (signsIn(provider)) {
    const { createChatGPT } = await import('../../js/chatgpt/index.js')
    return (await createChatGPT().accounts()).some(account => account.active && account.planUsage)
  }
  return def.apiKeyEnv ? Boolean(getAPIKey(def.apiKeyEnv)) : true
}

const credentialFix = (provider) => signsIn(provider) ? 'mo chatgpt login' : `mo onboard ${provider}`

const hasPrices = (spec) => spec.inputPrice != null && spec.outputPrice != null

/**
 * `{ model, inCatalog, priced, billing, credential, ready, fix }` — `priced` is null for a model
 * whose calls are not metered, `fix` the command closing the first thing missing, null for none.
 */
export async function modelReadiness (model) {
  const provider = providerOf(model)
  if (!providers[provider]) {
    return { model, inCatalog: false, priced: null, billing: null, credential: false, ready: false, fix: `${provider} is not a provider mohdel knows — mo providers lists them` }
  }
  const spec = (await getCuratedModels())[catalogKey(model)]
  const inCatalog = Boolean(spec && !spec.deprecated)
  const billing = billingOf(model).kind
  const priced = billing === 'metered' && inCatalog ? hasPrices(spec) : null
  const credential = await credentialOf(provider)
  const fix = !credential
    ? credentialFix(provider)
    : !inCatalog
        ? `mo curate ${provider}`
        : priced === false ? `mo model instructions ${provider}` : null
  return { model, inCatalog, priced, billing, credential, ready: credential && inCatalog, fix }
}

/**
 * A provider's models in the catalog, or every provider's without one, deprecated ones left out,
 * each `{ model, billing, priced }` as `modelReadiness` reads them: what a program offers its user
 * to choose from.
 */
export async function modelsOf (provider = null) {
  return catalogEntries(await getCuratedModels())
    .filter(([key, spec]) => (provider === null || providerOf(key) === provider) && !spec.deprecated)
    .map(([key, spec]) => {
      const billing = billingOf(key).kind
      return { model: key, billing, priced: billing === 'metered' ? hasPrices(spec) : null }
    })
}

/** `{ provider, credential, models, ready, fix }` — `models` the provider's catalog entries in use. */
export async function providerReadiness (provider) {
  const credential = await credentialOf(provider)
  const models = catalogEntries(await getCuratedModels())
    .filter(([key, spec]) => providerOf(key) === provider && !spec.deprecated).length
  const fix = !credential ? credentialFix(provider) : models ? null : `mo curate ${provider}`
  return { provider, credential, models, ready: credential && models > 0, fix }
}
