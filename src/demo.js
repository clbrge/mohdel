import mohdel from './index.js'
import * as dotenv from 'dotenv'
import fs from 'fs'
import { createUniquePromptFromLegacyInputs } from './sdk/utils.js'

dotenv.config()

const test = async (llm, prompt) => {
  const start = process.hrtime.bigint()
  const completion = await llm.completion(prompt)
  const end = process.hrtime.bigint()
  console.log({
    duration: Number((end - start) / 1_000_000n),
    completion
  })
}

const main = async () => {

  // await test(llm, 'give me two colors')
  // await test(llm, 'count after me: 1, 2, 3')
  // await test(llm, 'why the sky is blue')

  const inputs = JSON.parse(fs.readFileSync('test-messages.json', 'utf8'))
  //const prompt = createUniquePromptFromLegacyInputs(inputs)
  const prompt = 'make a small hiaiku in json format'

  const llm = mohdel('openai/o3-mini')

  const {
    output,
    inputTokens,
    outputTokens,
    thinkingTokens,
  } = await llm.answer(prompt, {
    outputBudget: 50000,
    outputType: 'json', // or default is text
    outputStyle: 'default', // accomodate code etc
    outputEffort: 'low', // or 'low', 'medium', high'
    identifier: 'lakeid'
  })

  console.log({
    output,
    inputTokens,
    outputTokens,
    thinkingTokens,
  })

}

await main()
