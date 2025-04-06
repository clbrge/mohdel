
import mohdel from './index.js'
import * as dotenv from 'dotenv'

dotenv.config()

const main = async () => {

  const claude = mohdel('claude-3-7-sonnet-20250219')

  const completion = await claude.completion(`Hello, how are you`)

  console.log(completion, 'done')
}

await main()
