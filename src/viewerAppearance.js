import { normalizeOptions, themeValues } from './previewOptions.js'
import { viewerAppearance } from './viewerOptions.js'
import './viewerAppearance.css'

export function readViewerAppearance(params) {
  const embedded = params.get('embedded') === '1' && parent !== window
  let options = normalizeOptions({ lang: params.get('lang') === 'en' ? 'en' : 'zh' })
  let themed = embedded
  try {
    const value = params.get('appearance')
    if (value && value.length <= 16000) {
      options = normalizeOptions(viewerAppearance(JSON.parse(value)))
      themed = true
    }
  } catch { /* Invalid links keep the default UI and never execute styling code. */ }
  return { embedded, themed, options }
}

const visible = (id, on) => document.getElementById(id)?.toggleAttribute('data-viewer-hidden', !on)

// UI tokens are separate from the scene background and from exported PNG pixels.
export class ViewerAppearance {
  constructor({ themed, embedded, onTheme, onLayout }) {
    Object.assign(this, { themed, embedded, onTheme, onLayout })
    this.media = matchMedia('(prefers-color-scheme: dark)')
    this.media.addEventListener('change', () => this.applyTheme())
    this.logo = document.querySelector('.brand-logo').getAttribute('src')
    this.observer = new ResizeObserver(() => {
      document.documentElement.style.setProperty('--toolbar-width', `${document.getElementById('topbar').getBoundingClientRect().width}px`)
    })
    this.observer.observe(document.getElementById('topbar'))
  }

  applyTheme() {
    if (!this.themed || !this.options) return
    const values = themeValues(this.options, this.media.matches)
    const root = document.documentElement
    root.dataset.viewerTheme = values.theme
    root.style.colorScheme = values.theme
    for (const name of ['background', 'surface', 'text', 'muted', 'border', 'accent', 'backdrop']) root.style.setProperty(`--ui-${name}`, values[name])
    const mix = (a, b, percent) => `color-mix(in srgb, ${a} ${percent}%, ${b})`
    const panel = mix(values.surface, 'transparent', this.options.viewer.panelOpacity * 100)
    let hex = values.accent.slice(1)
    if (hex.length === 3) hex = [...hex].map(c => c + c).join('')
    const [r, g, b] = [0, 2, 4].map(n => parseInt(hex.slice(n, n + 2), 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)
    const tokens = {
      panel, line: values.border, muted: values.muted, accent: values.accent,
      'ui-panel': panel, 'ui-control': mix(values.surface, values.text, 95), 'ui-hover': mix(values.surface, values.accent, 88),
      'ui-selected': mix(values.surface, values.accent, 80), 'ui-on-accent': .2126 * r + .7152 * g + .0722 * b > .179 ? '#102030' : '#ffffff',
      'ui-primary-hover': mix(values.accent, .2126 * r + .7152 * g + .0722 * b > .179 ? '#ffffff' : '#000000', 90),
      'ui-error': values.theme === 'light' ? '#a42b32' : '#ffb4ac', 'ui-error-bg': values.theme === 'light' ? '#fff1ef' : '#542b31',
      'ui-radius': `${values.radius}px`, 'ui-control-radius': `${Math.min(10, values.radius)}px`, 'ui-font': values.fontFamily,
    }
    for (const [name, value] of Object.entries(tokens)) root.style.setProperty(`--${name}`, value)
    this.onTheme(values)
  }

  update(options) {
    const previous = this.options
    this.options = options
    const v = options.viewer, p = v.panels, tools = v.tools
    document.body.classList.toggle('viewer-no-header', !v.header)
    document.body.classList.toggle('viewer-compact', v.layout === 'compact')
    document.body.classList.toggle('viewer-dense', v.density === 'compact')
    visible('app-header', v.header)
    for (const [key, id] of Object.entries({ file: 'filePanel', controls: 'controlPanel', metadata: 'metadataPanel', regions: 'regionList', materials: 'materialList' })) visible(id, p[key])
    const left = p.file || p.controls || tools.packs || tools.help, right = p.metadata || p.regions || p.materials
    visible('sidebar', left); visible('right-panel', right)
    visible('controlsPanelBtn', left); visible('infoPanelBtn', right); visible('mobilePanels', left || right)
    for (const [key, ids] of Object.entries({ packs: ['packSummaryBtn', 'packsTab'], export: ['imageExportBtn', 'welcomeExportBtn'], catalog: ['entityPreviewBtn', 'welcomeCatalogBtn'], settings: ['settingsBtn'], language: ['langBtn', 'exportLang'], help: ['operationHelp', 'githubBtn'], interface: ['uiToggleBtn'], projection: ['projectionBtn'] })) for (const id of ids) visible(id, tools[key])
    visible('welcomeOpenBtn', p.file)
    if (!tools.packs && document.getElementById('packsTab').getAttribute('aria-selected') === 'true') document.getElementById('generalTab').click()
    for (const [key, prefix] of [['regions', 'region'], ['materials', 'material']]) {
      if (previous && previous.viewer.expanded[key] === v.expanded[key]) continue
      for (const suffix of ['Body', 'Toggle']) document.getElementById(`${prefix}List${suffix}`).classList.toggle('collapsed', !v.expanded[key])
    }
    this.refreshLabels(options.lang)
    if (!previous || JSON.stringify([previous.theme, previous.style, previous.background, previous.viewer.panelOpacity]) !== JSON.stringify([options.theme, options.style, options.background, v.panelOpacity])) this.applyTheme()
    this.onLayout()
  }

  refreshLabels(lang) {
    if (!this.options) return
    const { brand } = this.options.viewer, english = lang === 'en'
    document.querySelector('.brand-full').textContent = brand.name || 'LitematicWebViewer'
    document.querySelector('.brand-short').textContent = brand.name || 'Litematic'
    const image = document.querySelector('.brand-logo')
    image.referrerPolicy = 'no-referrer'
    const source = brand.logo || this.logo
    if (image.getAttribute('src') !== source) image.src = source
    const link = document.getElementById('archiveReturn')
    link.hidden = !brand.returnUrl
    link.href = brand.returnUrl || '#'
    link.title = link.ariaLabel = brand.returnLabel || (english ? 'Return to archive' : '返回档案馆')
    link.target = this.embedded ? '_blank' : '_self'
    if (this.themed) document.querySelector('[data-i18n="packStorageHint"]').textContent = english ? 'Resource packs and settings apply only to this preview session.' : '资源包和设置仅在本次预览中生效。'
  }
}
