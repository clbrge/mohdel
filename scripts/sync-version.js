#!/usr/bin/env node
/**
 * Sync the version across every file that has to track the main
 * `package.json` version. release-it only bumps the top-level version
 * field; this script propagates that to:
 *
 *   - `package.json` optionalDependencies.mohdel-thin-gate-linux-x64-gnu
 *     (exact-version pin — the main package and its prebuilt-binary
 *     sub-package publish together, so the pin must track the bump).
 *   - `packages/thin-gate-linux-x64-gnu/package.json` version (the
 *     sub-package itself).
 *   - `Cargo.toml` workspace.package.version (Rust crate).
 *
 * Wired as release-it's `hooks["after:bump"]` so it runs after the
 * main version is bumped but before the release commit is staged.
 * Exits non-zero on failure so release-it aborts the release.
 *
 * Standalone invocation (rare — release-it is the normal path):
 *
 *   node scripts/sync-version.js                    # use current package.json version
 *   node scripts/sync-version.js 0.91.0             # force a specific version
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const mainPkgPath = resolve(ROOT, 'package.json')
const subPkgPath = resolve(ROOT, 'packages/thin-gate-linux-x64-gnu/package.json')
const cargoPath = resolve(ROOT, 'Cargo.toml')

const cliVersion = process.argv[2]

const mainPkg = JSON.parse(readFileSync(mainPkgPath, 'utf8'))
const version = cliVersion || mainPkg.version

if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error(`sync-version: refusing to use malformed version "${version}"`)
  process.exit(1)
}

let changes = 0

// 1. Main package.json optionalDep pin.
const subPkgKey = 'mohdel-thin-gate-linux-x64-gnu'
if (mainPkg.optionalDependencies?.[subPkgKey] !== version) {
  mainPkg.optionalDependencies[subPkgKey] = version
  writeFileSync(mainPkgPath, JSON.stringify(mainPkg, null, 2) + '\n')
  console.log(`sync-version: package.json optionalDependencies[${subPkgKey}] → ${version}`)
  changes++
}

// 2. Sub-package version.
const subPkg = JSON.parse(readFileSync(subPkgPath, 'utf8'))
if (subPkg.version !== version) {
  subPkg.version = version
  writeFileSync(subPkgPath, JSON.stringify(subPkg, null, 2) + '\n')
  console.log(`sync-version: packages/thin-gate-linux-x64-gnu/package.json version → ${version}`)
  changes++
}

// 3. Cargo.toml workspace version. One-liner substitution: match the
// first `version = "x.y.z"` line inside `[workspace.package]`. Avoids
// pulling in a TOML parser for a single field.
const cargoSrc = readFileSync(cargoPath, 'utf8')
const cargoPattern = /(\[workspace\.package\][\s\S]*?\nversion\s*=\s*)"[^"]+"/
if (!cargoPattern.test(cargoSrc)) {
  console.error('sync-version: could not locate [workspace.package] version in Cargo.toml')
  process.exit(1)
}
const cargoUpdated = cargoSrc.replace(cargoPattern, `$1"${version}"`)
if (cargoUpdated !== cargoSrc) {
  writeFileSync(cargoPath, cargoUpdated)
  console.log(`sync-version: Cargo.toml workspace.package.version → ${version}`)
  changes++
}

if (changes === 0) {
  console.log(`sync-version: already at ${version}, nothing to do`)
} else {
  console.log(`sync-version: ${changes} file(s) updated to ${version}`)
}
