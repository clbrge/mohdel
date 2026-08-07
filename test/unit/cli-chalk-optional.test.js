import { describe, test, expect, vi } from 'vitest'

// `chalk` is an optionalDependency: npm skips it on an engine mismatch
// or `--no-optional`, so resolution failure is a real runtime state.
vi.mock('chalk', () => { throw new Error("Cannot find package 'chalk'") })

const { default: chalk, isColorAvailable } = await import('../../src/cli/_chalk.js')
const colors = await import('../../src/cli/colors.js')
const { cliLogger } = await import('../../src/cli/colored-logger.js')

describe('chalk fallback when the optional dependency is absent', () => {
  test('the module loads instead of throwing', () => {
    expect(isColorAvailable).toBe(false)
    expect(typeof chalk).toBe('function')
  })

  test('styles are callable and return the text unchanged', () => {
    expect(chalk.cyan('model')).toBe('model')
    expect(chalk.dim('—')).toBe('—')
    expect(chalk.white('x')).toBe('x')
  })

  test('chained styles still resolve', () => {
    expect(chalk.bold.red('boom')).toBe('boom')
    expect(chalk.bold.red.underline('deep')).toBe('deep')
  })

  test('non-string input is coerced, not dropped', () => {
    expect(chalk.green(42)).toBe('42')
  })

  test('the stand-in survives string coercion and inspection', () => {
    // A `get` trap that returned the chain for Symbol.toPrimitive or
    // util.inspect.custom would break template literals and console.log.
    expect(`${chalk.cyan('a')}`).toBe('a')
    expect(() => JSON.stringify({ v: chalk.cyan('a') })).not.toThrow()
    expect(String(chalk.red('e'))).toBe('e')
  })

  test('the semantic colour roles still work', () => {
    expect(colors.id('gpt-5')).toBe('gpt-5')
    expect(colors.label('Title')).toBe('Title')
    expect(colors.missing).toBe('—')
    expect(colors.err('nope')).toBe('nope')
  })

  test('the CLI logger still emits its lines', () => {
    const seen = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => seen.push(a.join(' ')))
    try {
      const logger = cliLogger('info')
      logger.error({ ctx: 1 }, 'something failed')
      expect(seen.join('')).toContain('something failed')
      expect(seen.join('')).toContain('ERR')
    } finally {
      spy.mockRestore()
    }
  })
})
