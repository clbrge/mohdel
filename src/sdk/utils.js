export const translateModelInfo = (model, infoTranslate = {}) => {
  if (!model || typeof model !== 'object') return model
  if (!infoTranslate || Object.keys(infoTranslate).length === 0) return model
  const result = { ...model }
  for (const [source, target] of Object.entries(infoTranslate)) {
    if (source in result) {
      result[target] = result[source]
      delete result[source]
    }
  }
  return result
}
