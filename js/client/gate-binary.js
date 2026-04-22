/**
 * Resolve the absolute path of the prebuilt `thin-gate` binary that
 * was installed alongside mohdel via `optionalDependencies`.
 *
 * ## How distribution works
 *
 * The main `mohdel` package declares a per-platform sub-package as an
 * optional dependency, e.g. `mohdel-thin-gate-linux-x64-gnu`. npm
 * only installs the sub-package whose `os` / `cpu` / `libc` filters
 * match the host, silently skips the rest. Each sub-package ships a
 * single `bin/mohdel-thin-gate` artifact and an `index.js` that
 * exports its absolute path.
 *
 * This module picks the right sub-package name from
 * `process.platform` / `process.arch`, dynamically imports it, and
 * returns the path. If no matching sub-package installed (unsupported
 * host, `--no-optional`, or a pre-publish build), throws with a
 * diagnostic message.
 *
 * ## Supported platforms (0.90)
 *
 * - Linux x64 glibc (`linux-x64-gnu`)
 *
 * More platforms are additive post-0.90; the resolver expands without
 * a wire-level change.
 *
 * @module client/gate-binary
 */

/**
 * @returns {Promise<string>} absolute path to the `thin-gate` binary
 * @throws if no sub-package matches the current host
 */
export async function resolveGateBinary () {
  const pkg = platformPackageName()
  if (!pkg) {
    throw new Error(
      `mohdel: no prebuilt thin-gate binary for platform ${process.platform}/${process.arch}. ` +
      'Supported in 0.90: linux-x64-gnu. Build from source (\'cargo build --release -p mohdel-thin-gate\') ' +
      'and set MOHDEL_GATE_BINARY to the resulting path, or file an issue for your platform.'
    )
  }

  try {
    /** @type {any} */
    const mod = await import(pkg)
    return mod.default
  } catch (e) {
    throw new Error(
      `mohdel: prebuilt binary package '${pkg}' is not installed. ` +
      'This usually means npm skipped the optional dependency — reinstall without ' +
      '\'--no-optional\' / \'--omit=optional\', or build from source and set MOHDEL_GATE_BINARY. ' +
      `(cause: ${/** @type {Error} */(e)?.message})`
    )
  }
}

/**
 * Map `(process.platform, process.arch)` to the sub-package name.
 * Returns `null` for unsupported hosts.
 *
 * Note: this ignores libc. 0.90 ships glibc only; `detect-libc`
 * lands when we add a musl sub-package.
 *
 * @returns {string | null}
 */
function platformPackageName () {
  if (process.platform === 'linux' && process.arch === 'x64') {
    return 'mohdel-thin-gate-linux-x64-gnu'
  }
  return null
}
