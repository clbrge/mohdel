# mohdel-thin-gate-linux-x64-gnu

Prebuilt `thin-gate` binary for mohdel — Linux x64 with glibc.

This package is **installed automatically** when you `npm install mohdel`
on a matching host (via npm's `optionalDependencies` + `os`/`cpu`/`libc`
filtering). It contains a single artifact: the `mohdel-thin-gate`
subprocess binary that mohdel's session pool spawns.

You should not depend on this package directly. Use the parent
`mohdel` package and let the optional-dependency machinery pick the
right prebuilt.

## What's in the package

```
bin/mohdel-thin-gate   # stripped release binary (~3-4 MB)
index.js               # exports the absolute binary path
```

## Invoking directly

```js
import thinGatePath from 'mohdel-thin-gate-linux-x64-gnu'
import { spawn } from 'node:child_process'
const proc = spawn(thinGatePath, ['--data', '/tmp/data.sock', ...])
```

Or as a CLI via npm's `bin` shim:

```sh
npx mohdel-thin-gate --help
```

## Build provenance

Built in CI from the `rust/thin-gate` crate in
[mohdel](https://github.com/clbrge/mohdel) at tag `v0.90.0`. Target triple:
`x86_64-unknown-linux-gnu`. Profile: `[profile.release]` with
`strip = true`, `lto = "thin"`, `codegen-units = 1`.
