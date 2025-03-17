
import modhel from './index.js'

const main = async () => {

  const claude = modhel('anthropic/claude-3-7-sonnet-20250219')

  const completion = await claude.completion("Hello, how are you?")


  console.log(completion, 'done')
}

await main()
