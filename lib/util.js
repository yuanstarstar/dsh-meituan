export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function clip(text, max = 300) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** 从「月售100+」「起送 ¥20」「5.1km」「人均 ¥36」这类文案里抠数字 */
export function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const text = String(value ?? '')
  const match = text.match(/-?\d+(?:\.\d+)?/)
  if (!match) return null
  const parsed = Number(match[0])
  return Number.isFinite(parsed) ? parsed : null
}

export function uniqBy(list, keyOf) {
  const seen = new Set()
  const out = []
  for (const item of list) {
    const key = keyOf(item)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

export function nowIso() {
  return new Date().toISOString()
}
