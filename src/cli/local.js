import { loadLocalConventions } from '../lib/local-conventions.js'
import { err } from './colors.js'

// A declaration file that exists but does not parse is broken policy. Reading
// it as "no conventions" would let every local rule silently stop applying.
export const localConventionsOrExit = async () => {
  try {
    return await loadLocalConventions()
  } catch (e) {
    console.error(err(e.message))
    console.error(err('Fix it or move it aside; mohdel will not carry on as if no conventions were declared.'))
    process.exit(1)
  }
}
