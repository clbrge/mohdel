/**
 * Prebuilt thin-gate binary resolver for Linux x64 (glibc).
 *
 * Consumers import the default export and spawn the resulting
 * absolute path. This sub-package is installed automatically via
 * the main `mohdel` package's `optionalDependencies` when the host
 * matches `os=linux`, `cpu=x64`, `libc=glibc`.
 *
 * @module mohdel-thin-gate-linux-x64-gnu
 */

import { fileURLToPath } from 'node:url'

const binaryUrl = new URL('./bin/mohdel-thin-gate', import.meta.url)

/** Absolute path to the prebuilt `mohdel-thin-gate` executable. */
export default fileURLToPath(binaryUrl)
