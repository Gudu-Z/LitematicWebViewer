export const VIEWER_DEFAULTS = {
  header: true, layout: 'auto', density: 'comfortable', panelOpacity: .94,
  panels: { file: true, controls: true, metadata: true, regions: true, materials: true },
  tools: { packs: true, export: true, catalog: true, settings: true, language: true, help: true, interface: true, projection: true },
  expanded: { regions: true, materials: true },
  brand: { name: '', logo: '', returnUrl: '', returnLabel: '' },
}

export function normalizeViewerOptions(patch, previous = VIEWER_DEFAULTS) {
  if (patch === null) return structuredClone(VIEWER_DEFAULTS)
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw TypeError('viewer must be an object')
  const next = structuredClone(previous)
  const check = (valid, key) => { if (!valid) throw TypeError(`Invalid viewer option: ${key}`) }
  for (const [key, value] of Object.entries(patch)) {
    check(Object.hasOwn(VIEWER_DEFAULTS, key), key)
    if (value === null) { next[key] = structuredClone(VIEWER_DEFAULTS[key]); continue }
    if (['panels', 'tools', 'expanded', 'brand'].includes(key)) {
      check(value && typeof value === 'object' && !Array.isArray(value), key)
      for (const [name, setting] of Object.entries(value)) {
        check(Object.hasOwn(VIEWER_DEFAULTS[key], name), `${key}.${name}`)
        if (setting === null) { next[key][name] = VIEWER_DEFAULTS[key][name]; continue }
        if (key === 'brand') {
          check(typeof setting === 'string' && setting.length <= (['logo', 'returnUrl'].includes(name) ? 2048 : 80), `brand.${name}`)
          if (setting && ['logo', 'returnUrl'].includes(name)) {
            let url
            try { url = new URL(setting) } catch { /* Rejected below. */ }
            check(url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, `brand.${name}`)
          }
        } else check(typeof setting === 'boolean', `${key}.${name}`)
        next[key][name] = setting
      }
    } else {
      check(key === 'header' ? typeof value === 'boolean' : key === 'layout' ? ['auto', 'compact'].includes(value) : key === 'density' ? ['comfortable', 'compact'].includes(value) : Number.isFinite(value) && value >= .3 && value <= 1, key)
      next[key] = value
    }
  }
  return next
}

// Appearance survives a full-viewer refresh; file bytes and transfer tokens never enter it.
export function viewerAppearance(options) {
  return Object.fromEntries(['lang', 'theme', 'background', 'style', 'viewer'].filter(key => options[key] !== undefined).map(key => [key, options[key]]))
}
