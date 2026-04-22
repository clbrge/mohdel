// Semantic color roles for CLI output.
import chalk from 'chalk'

export const id = chalk.cyan // model IDs, provider names
export const label = chalk.bold // display names, titles
export const tag = chalk.yellow // tags
export const price = chalk.green // money values
export const meta = chalk.dim // counts, field labels, headers, separators
export const missing = chalk.dim('—') // null/absent values
export const err = chalk.red // errors
export const warn = chalk.yellow // warnings
export const ok = chalk.green // success, ● dots
export const inactive = chalk.dim // unconfigured, ○ dots
