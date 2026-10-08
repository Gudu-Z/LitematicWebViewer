// Shared by the standalone SDK build and the iframe. Only data crosses the frame boundary.
export const defaults = {
  lang: 'zh', theme: 'dark', background: null, ui: 'default',
  controls: { reset: true, open: true, hint: true, status: true, title: true },
  labels: {}, style: {}, dialog: { width: 1040, height: 720 },
  interaction: { rotate: true, pan: true, zoom: true, autoRotate: false, autoRotateSpeed: 2 },
  camera: { projection: 'perspective', position: null, target: null, zoom: 1, height: null },
}
const palettes = {
  dark: { background: '#172332', surface: '#1e3147', text: '#e6eef8', muted: '#bed5ec', border: '#496582', accent: '#83cbff', backdrop: '#050b16bc' },
  light: { background: '#edf2f7', surface: '#ffffff', text: '#213348', muted: '#53677e', border: '#c5d1df', accent: '#1268bf', backdrop: '#14233466' },
}
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const color = value => typeof value === 'string' && /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(value)
const number = (value, min, max) => Number.isFinite(value) && value >= min && value <= max
const vector = value => Array.isArray(value) && value.length === 3 && value.every(n => number(n, -1e9, 1e9))
const choices = { lang: ['zh', 'en'], theme: ['dark', 'light', 'auto'], ui: ['default', 'none'] }

export function normalizeOptions(patch = {}, previous = defaults) {
  if (!object(patch)) throw TypeError('Preview options must be an object')
  const next = structuredClone(previous)
  const check = (ok, key) => { if (!ok) throw TypeError(`Invalid preview option: ${key}`) }
  for (const [key, values] of Object.entries(choices)) if (key in patch) {
    check(values.includes(patch[key]), key); next[key] = patch[key]
  }
  if ('background' in patch) {
    check(patch.background === null || patch.background === 'transparent' || /^#[\da-f]{6}$/i.test(patch.background), 'background')
    next.background = patch.background
  }
  for (const group of ['controls', 'labels', 'style', 'dialog', 'interaction', 'camera']) {
    if (!(group in patch)) continue
    if (patch[group] === null) { next[group] = structuredClone(defaults[group]); continue }
    check(object(patch[group]), group)
    for (const [key, value] of Object.entries(patch[group])) {
      if (value === null && group !== 'camera') { delete next[group][key]; if (Object.hasOwn(defaults[group], key)) next[group][key] = defaults[group][key]; continue }
      let valid = false
      if (group === 'controls') valid = Object.hasOwn(defaults.controls, key) && typeof value === 'boolean'
      if (group === 'labels') valid = ['reset', 'open', 'hint', 'waiting', 'loading', 'error', 'retry', 'activate', 'subtitle', 'close'].includes(key) && typeof value === 'string' && value.length <= 300
      if (group === 'style') valid = key === 'background' ? /^#[\da-f]{6}$/i.test(value) : Object.hasOwn(palettes.dark, key) ? color(value) : key === 'radius' ? number(value, 0, 48) : key === 'fontFamily' && typeof value === 'string' && value.length <= 200 && !/[;{}<>]/.test(value)
      if (group === 'dialog') valid = ['width', 'height'].includes(key) && number(value, 240, 4096)
      if (group === 'interaction') valid = key === 'autoRotateSpeed' ? number(value, -20, 20) : Object.hasOwn(defaults.interaction, key) && typeof value === 'boolean'
      if (group === 'camera') valid = key === 'projection' ? ['perspective', 'orthographic'].includes(value) : ['position', 'target'].includes(key) ? value === null || vector(value) : key === 'zoom' ? number(value, .01, 100) : key === 'height' && (value === null || number(value, .01, 1e9))
      check(valid, `${group}.${key}`)
      next[group][key] = structuredClone(value)
    }
  }
  const c = next.camera
  check((c.position === null) === (c.target === null), 'camera.position and camera.target must be supplied together')
  check(!c.position || c.position.some((v, i) => v !== c.target[i]), 'camera.position must differ from camera.target')
  return next
}

export function themeValues(options, prefersDark = false) {
  const theme = options.theme === 'auto' ? prefersDark ? 'dark' : 'light' : options.theme
  const values = { ...palettes[theme], radius: 16, fontFamily: 'system-ui, sans-serif', ...options.style }
  values.background = options.background ?? values.background
  return { theme, ...values }
}

export function applyTheme(element, options, prefersDark = false) {
  const values = themeValues(options, prefersDark)
  element.dataset.theme = values.theme
  // Private defaults let host CSS override the public --lwv-* properties on the popup.
  for (const key of ['background', 'surface', 'text', 'muted', 'border', 'accent', 'backdrop']) element.style.setProperty(`--_lwv-${key}`, values[key])
  element.style.setProperty('--_lwv-radius', `${values.radius}px`)
  element.style.setProperty('--_lwv-font', values.fontFamily)
  element.style.setProperty('--_lwv-dialog-width', `${options.dialog.width}px`)
  element.style.setProperty('--_lwv-dialog-height', `${options.dialog.height}px`)
  return values
}
