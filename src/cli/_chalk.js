/**
 * Chalk, or an uncoloured stand-in when it is absent.
 *
 * `chalk` is an `optionalDependency`, so npm skips it on an engine
 * mismatch or `--no-optional` without failing the install. A static
 * import would then take the whole CLI down at load time instead of
 * dropping colour, which is the only thing actually lost. Dynamic
 * import is the exception the style rule allows: an optional package
 * cannot be resolved statically.
 *
 * The stand-in has to be callable *and* chainable, because call sites
 * use both `dim('x')` and `bold.red('x')`.
 *
 * @module cli/_chalk
 */

const identity = (s) => String(s)

/** @type {any} */
const plain = new Proxy(identity, {
  get (target, prop, receiver) {
    // Symbols and function internals must resolve on the function
    // itself; returning the chain proxy for `Symbol.toPrimitive` or
    // `util.inspect.custom` breaks string coercion and console output.
    if (typeof prop === 'symbol' || prop in Function.prototype) {
      return Reflect.get(target, prop, receiver)
    }
    return plain
  }
})

/** @type {any} */
let chalk
try {
  chalk = (await import('chalk')).default
} catch {
  chalk = plain
}

export const isColorAvailable = chalk !== plain
export default chalk
