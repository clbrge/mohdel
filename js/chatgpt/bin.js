#!/usr/bin/env node
/**
 * Access-token helper for a supervisor that cannot run the OAuth refresh
 * itself (thin-gate's `ChatGptAuth`). Invoked as
 * `node <path-to-this-file> access [--account <id>]`.
 *
 * stdout: `{"accessToken": "…", "refreshAt": <epoch ms>}`, exit 0.
 * stderr: the error message, exit 1. The token never reaches stderr.
 *
 * @module chatgpt/bin
 */

import { createChatGPT } from './index.js'

const USAGE = 'usage: node bin.js access [--account <id>]'

async function main (args) {
  const [verb, flag, id, ...rest] = args
  if (verb !== 'access' || rest.length || (flag !== undefined && (flag !== '--account' || !id))) {
    throw new Error(USAGE)
  }
  const { accessToken, refreshAt } = await createChatGPT().access(id)
  process.stdout.write(JSON.stringify({ accessToken, refreshAt }))
}

main(process.argv.slice(2)).catch(err => {
  process.stderr.write(err.message)
  process.exitCode = 1
})
