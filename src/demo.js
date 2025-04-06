
import mohdel from './index.js'
import * as dotenv from 'dotenv'

dotenv.config()

const main = async () => {

  const llm = mohdel()

  const completion = await llm.completion(`Hello, how are you`)

  console.log(completion, 'done')
}

await main()
