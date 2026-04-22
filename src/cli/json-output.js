// --json flag support (gh-style):
//   --json           → list available fields
//   --json f1,f2,f3  → output only those fields

/**
 * Extract --json flag and its value from args.
 * Returns { json: false } or { json: true, fields: null } (list fields)
 * or { json: true, fields: ['f1','f2'] } (filter).
 * Mutates args in place to remove consumed --json [value].
 */
export function parseJsonFlag (args) {
  const idx = args.indexOf('--json')
  if (idx === -1) return { json: false }

  args.splice(idx, 1)

  // Next arg is the field list (if it exists and doesn't look like a flag)
  const next = args[idx]
  if (next && !next.startsWith('-')) {
    args.splice(idx, 1)
    return { json: true, fields: next.split(',').map(f => f.trim()).filter(Boolean) }
  }

  return { json: true, fields: null }
}

/**
 * Print available fields for a --json call with no field list.
 */
export function printAvailableFields (fields) {
  console.log('Available JSON fields:')
  for (const f of fields) console.log(`  ${f}`)
}

/**
 * Pick selected fields from an object.
 */
function pick (obj, fields) {
  const out = {}
  for (const f of fields) {
    if (f in obj) out[f] = obj[f]
  }
  return out
}

/**
 * Output a list of objects as JSON, optionally filtered to specific fields.
 */
export function jsonOutput (items, fields) {
  const out = fields ? items.map(item => pick(item, fields)) : items
  console.log(JSON.stringify(out, null, 2))
}

/**
 * Output a single object as JSON, optionally filtered to specific fields.
 */
export function jsonOutputOne (item, fields) {
  const out = fields ? pick(item, fields) : item
  console.log(JSON.stringify(out, null, 2))
}
