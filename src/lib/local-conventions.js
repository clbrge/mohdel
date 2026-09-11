import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CONFIG_DIR, isMetaKey } from './common.js'
import { fieldDefs, isValidTag } from './schema.js'

export const LOCAL_PATH = join(CONFIG_DIR, 'catalog.local.json')

const TOP_LEVEL = ['fields', 'tags', 'adding', 'notes']
const FIELD_KEYS = ['type', 'description', 'measured', 'readBy']
const TAG_KEYS = ['description', 'requires', 'severity']
const TYPES = ['string', 'number', 'boolean', 'array', 'object']
const SEVERITIES = ['error', 'warn']

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

export const parseLocalConventions = (text) => {
  let doc
  try {
    doc = JSON.parse(text)
  } catch (e) {
    throw new Error(`not valid JSON: ${e.message}`)
  }
  if (!isPlainObject(doc)) throw new Error('must be a JSON object')

  for (const key of Object.keys(doc)) {
    if (isMetaKey(key)) continue
    if (!TOP_LEVEL.includes(key)) {
      throw new Error(`unknown key '${key}' (expected: ${TOP_LEVEL.join(', ')})`)
    }
  }

  const fields = {}
  for (const [name, def] of Object.entries(doc.fields || {})) {
    if (!isPlainObject(def)) throw new Error(`fields.${name} must be an object`)
    for (const key of Object.keys(def)) {
      if (!FIELD_KEYS.includes(key)) throw new Error(`fields.${name}.${key} is not a known key (expected: ${FIELD_KEYS.join(', ')})`)
    }
    if (fieldDefs[name]) throw new Error(`fields.${name} is already a mohdel field — remove it, mohdel validates it already`)
    if (!TYPES.includes(def.type)) throw new Error(`fields.${name}.type must be one of ${TYPES.join(', ')}`)
    if (typeof def.description !== 'string' || !def.description) throw new Error(`fields.${name}.description is required`)
    for (const key of ['measured', 'readBy']) {
      if (def[key] !== undefined && typeof def[key] !== 'string') throw new Error(`fields.${name}.${key} must be a string`)
    }
    fields[name] = def
  }

  const tags = {}
  for (const [name, def] of Object.entries(doc.tags || {})) {
    if (!isPlainObject(def)) throw new Error(`tags.${name} must be an object`)
    for (const key of Object.keys(def)) {
      if (!TAG_KEYS.includes(key)) throw new Error(`tags.${name}.${key} is not a known key (expected: ${TAG_KEYS.join(', ')})`)
    }
    if (!isValidTag(name)) throw new Error(`tags.${name} is not a valid tag name`)
    if (typeof def.description !== 'string' || !def.description) throw new Error(`tags.${name}.description is required`)
    if (def.severity !== undefined && !SEVERITIES.includes(def.severity)) {
      throw new Error(`tags.${name}.severity must be one of ${SEVERITIES.join(', ')}`)
    }
    if (def.requires !== undefined) {
      if (!Array.isArray(def.requires)) throw new Error(`tags.${name}.requires must be an array of field names`)
      for (const required of def.requires) {
        if (!fieldDefs[required] && !fields[required]) {
          throw new Error(`tags.${name}.requires names '${required}', which is neither a mohdel field nor declared under fields`)
        }
      }
    }
    tags[name] = { severity: 'error', requires: [], ...def }
  }

  const adding = doc.adding || {}
  if (!isPlainObject(adding)) throw new Error('adding must be an object')
  for (const [key, value] of Object.entries(adding)) {
    if (!['field', 'tag'].includes(key)) throw new Error(`adding.${key} is not a known key (expected: field, tag)`)
    if (typeof value !== 'string') throw new Error(`adding.${key} must be a string`)
  }

  if (doc.notes !== undefined && typeof doc.notes !== 'string') throw new Error('notes must be a string')

  return { fields, tags, adding, notes: doc.notes || '' }
}

// Absent is the default state, not an error. A file that exists but does not
// parse is broken policy — it must not read as "no conventions".
export const loadLocalConventions = async (path = LOCAL_PATH) => {
  if (!existsSync(path)) return null
  try {
    return parseLocalConventions(await readFile(path, 'utf8'))
  } catch (e) {
    throw new Error(`${path}: ${e.message}`)
  }
}

export const TEMPLATE = `{
  "_comment": "Declares what THIS installation adds to the mohdel catalog: custom fields your own services read, tags that mean something to them, and how a new one gets introduced. Absent by default; mohdel ships nothing here. See docs/CATALOG.md > Local conventions.",

  "fields": {
    "yourField": {
      "type": "number",
      "description": "What it means. The coding agent reads this before filling it in.",
      "measured": "the command that produces this value, when it is measured rather than published",
      "readBy": "which of your services read it"
    }
  },

  "tags": {
    "yourTag": {
      "description": "What applying this tag does in your stack.",
      "requires": ["yourField"],
      "severity": "error"
    }
  },

  "adding": {
    "field": "How a new custom field is introduced here. Name every step that has to happen before it counts as existing.",
    "tag": "How a new tag is introduced here, and what reads it."
  },

  "notes": "Anything else the coding agent should know about this catalog."
}
`
