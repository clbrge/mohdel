import { describe, it, expect } from 'vitest'
import { readFileSync, globSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { builtinModules } from 'node:module'

const root = new URL('../../', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const declared = new Set([
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.optionalDependencies || {}),
  ...Object.keys(pkg.devDependencies || {})
])
const builtin = new Set(builtinModules)

const staticImports = (file) => {
  const src = readFileSync(fileURLToPath(new URL(file, root)), 'utf8')
  return [...src.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)]
    .map(m => m[1])
    .filter(s => !s.startsWith('.') && !s.startsWith('#') && !s.startsWith('node:'))
    .map(s => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]))
    .filter(s => !builtin.has(s))
}

const shipped = globSync('{src,js}/**/*.js', { cwd: fileURLToPath(root) })
  .filter(f => !f.endsWith('.d.ts'))

describe('dependencies a shipped module imports at load time', () => {
  it('are all declared in package.json', () => {
    const undeclared = new Set()
    for (const f of shipped) {
      for (const spec of staticImports(f)) if (!declared.has(spec)) undeclared.add(`${f}: ${spec}`)
    }
    expect([...undeclared]).toEqual([])
  })

  // An unsatisfiable or unavailable optional dependency is skipped silently:
  // the install succeeds and the import fails at runtime instead.
  it('are not optional, since a static import cannot tolerate an absent package', () => {
    const optional = new Set(Object.keys(pkg.optionalDependencies || {}))
    const hard = new Set()
    for (const f of shipped) {
      for (const spec of staticImports(f)) if (optional.has(spec)) hard.add(`${f}: ${spec}`)
    }
    expect([...hard]).toEqual([])
  })
})
