// LivingEntity.getScale / AttributeInstance.calculateValue. Model placement,
// logical dimensions and riding attachments must use the same saved attribute.
export function entityScale(nbt = {}) {
  const short = value => String(value || '').replace(/^minecraft:/, '')
  const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback
  const attributes = nbt.attributes ?? nbt.Attributes
  const attribute = Array.isArray(attributes) && attributes.find(a => ['scale', 'generic.scale'].includes(short(a.id ?? a.Name)))
  if (!attribute) return 1
  const modifiers = attribute.modifiers ?? attribute.Modifiers ?? []
  const operation = m => m.type ?? m.Operation
  const amount = m => number(m.amount ?? m.Amount)
  let base = number(attribute.base ?? attribute.Base, 1)
  if (Array.isArray(modifiers)) {
    for (const m of modifiers) if (['add_value', 0].includes(operation(m))) base += amount(m)
    let value = base
    for (const m of modifiers) if (['add_multiplied_base', 1].includes(operation(m))) value += base * amount(m)
    for (const m of modifiers) if (['add_multiplied_total', 2].includes(operation(m))) value *= 1 + amount(m)
    base = value
  }
  return Math.fround(Math.max(.0625, Math.min(16, base)))
}
