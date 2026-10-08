import { fileURLToPath } from 'node:url'

/**
 * Where the installed `mo` is, for a program that runs it for its user without `mo` on `PATH`:
 * `node <CLI> onboard openrouter`, `node <CLI> doctor --model <id> --json`.
 */
export const CLI = fileURLToPath(new URL('../cli/index.js', import.meta.url))
