import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'))

describe('package exports', () => {
  it('every subpath declares types before default', () => {
    for (const [subpath, entry] of Object.entries(pkg.exports)) {
      expect(Object.keys(entry), subpath).toEqual(['types', 'default'])
    }
  })

  // The declarations reference each other through `#core/*`, which the imports
  // map resolves to ./js/core/*.js — a consumer finds their types only at
  // js/core/*.d.ts. Emitting anywhere but beside the source leaves every such
  // reference unresolvable, and skipLibCheck turns that into a silent `any`.
  it('every types path sits beside the module it describes', () => {
    for (const [subpath, entry] of Object.entries(pkg.exports)) {
      expect(entry.types, subpath).toBe(entry.default.replace(/\.js$/, '.d.ts'))
    }
    expect(pkg.types).toBe(`./${pkg.main.replace(/\.js$/, '.d.ts')}`)
  })

  it('ships the generated declarations', () => {
    expect(pkg.files).toContain('js/**/*.d.ts')
    expect(pkg.files).toContain('src/lib/**/*.d.ts')
  })

  it('regenerates from a clean tree so tsc cannot read back its own output', () => {
    expect(pkg.scripts['build:types']).toMatch(/^npm run clean:types &&/)
    expect(pkg.scripts.prerelease).toContain('npm run build:types')
  })
})
