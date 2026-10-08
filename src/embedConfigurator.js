export function setupConfigurator({ createLitematicCard, openLitematicPreview, lang, sample, sdkURL }) {
  const en = lang === 'en', $ = id => document.getElementById(id)
  if (en) {
    const labels = {
      customLink: 'Style configurator ↓', language: '中文', customLabel: '03 · MAKE IT YOURS', customTitle: 'One model. Your site’s style.',
      customText: 'Adjust the theme and interactions, preview them live, then copy the integration code. Headless mode uses your own buttons, loading indicators and dialogs.',
      presetDark: 'Dark', presetLight: 'Light', presetCustom: 'Custom archive', archiveTitle: 'Build archive / 3D preview', liveTag: 'LIVE', startLabel: 'Activate custom preview',
      hostReset: 'Reset view', hostOpen: 'Full viewer ↗', tryPopup: 'Try as a popup ↗', hostNote: 'The code below includes your current settings.',
      themeLabel: 'Theme', themeDark: 'Dark', themeLight: 'Light', themeAuto: 'System', uiLabel: 'Interface', uiDefault: 'Built-in controls', uiNone: 'Headless · Your own controls',
      accentLabel: 'Accent', backgroundLabel: 'Background', transparentLabel: 'Transparent background', radiusLabel: 'Corner radius', projectionLabel: 'Projection', perspectiveLabel: 'Perspective', orthographicLabel: 'Orthographic',
      controlLabel: 'Built-in controls', resetLabel: 'Reset', openLabel: 'Full viewer', hintLabel: 'Gesture hint', titleLabel: 'Dialog title', interactionLabel: 'Interaction',
      rotateLabel: 'Orbit', panLabel: 'Pan', zoomLabel: 'Zoom', autoRotateLabel: 'Auto-rotate', codeLabel: 'Integration code', codeInline: 'Inline card', codePopup: 'Click to open', copyCode: 'Copy code',
    }
    for (const [id, value] of Object.entries(labels)) $(id).textContent = value
    $('language').href = '?lang=zh'
    document.querySelector('.presets').ariaLabel = 'Theme presets'
  }
  let card, currentPreset = 'dark'
  const getOptions = () => ({
    lang, theme: $('cfgTheme').value, background: $('cfgTransparent').checked ? 'transparent' : $('cfgBackground').value,
    ui: $('cfgUI').value, style: { accent: $('cfgAccent').value, radius: +$('cfgRadius').value },
    controls: Object.fromEntries(['reset', 'open', 'hint', 'title'].map(key => [key, $('cfg' + key[0].toUpperCase() + key.slice(1)).checked])),
    camera: { projection: $('cfgProjection').value },
    interaction: Object.fromEntries(['rotate', 'pan', 'zoom', 'autoRotate'].map(key => [key, $('cfg' + key[0].toUpperCase() + key.slice(1)).checked])),
  })
  const onStatus = event => {
    if (event.type === 'ready') return
    if (event.type === 'loaded') $('customStatus').textContent = en ? 'Ready · Drag to explore' : '加载完成 · 拖动探索模型'
    else if (event.type === 'inactive') $('customStatus').textContent = en ? 'Preview paused while offscreen' : '离开可视区域，预览已暂停'
    else $('customStatus').textContent = event.message || ''
    if (event.stage !== 'handoff' && ['loaded', 'loading', 'error', 'inactive'].includes(event.type)) for (const id of ['hostReset', 'hostOpen']) $(id).disabled = event.type !== 'loaded'
  }
  function activate() {
    if (!card) {
      $('startCustom').hidden = true
      card = createLitematicCard($('customPreview'), { url: sample, name: en ? 'Sample schematic' : '示例投影', ...getOptions(), onStatus })
    }
  }
  function code() {
    const popup = $('codeMode').value === 'popup', options = getOptions(), headless = options.ui === 'none'
    const reset = en ? 'Reset view' : '复位视角', full = en ? 'Full viewer' : '完整预览', launch = en ? 'Preview schematic' : '预览投影'
    // Keep copied examples usable on other domains and paired with this SDK revision.
    const moduleURL = new URL('https://lwv.loafing.club/embed.js')
    moduleURL.search = sdkURL.search
    const config = JSON.stringify({ url: 'https://lwv.loafing.club/demo.litematic', ...options }, null, 2)
    const customButtons = `<button id="reset" disabled>${reset}</button>\n<button id="full" disabled>${full}</button>\n<p id="status" role="status"></p>\n`
    const handler = `,\n  onStatus(event) {${popup ? "\n    if (event.type === 'close-request') dialog.close();" : ''}\n    if (event.stage !== 'handoff' && ['loaded', 'loading', 'error', 'inactive'].includes(event.type)) {\n      document.getElementById('reset').disabled = event.type !== 'loaded';\n      document.getElementById('full').disabled = event.type !== 'loaded';\n    }\n    document.getElementById('status').textContent = event.message || '';\n  }`
    // A custom popup uses the host's own dialog so its controls remain in the modal focus scope.
    if (popup && headless) {
      $('configCode').textContent = `<button id="launch">${launch}</button>\n<dialog id="preview-dialog" style="width:min(900px,90vw);padding:16px;border:0;border-radius:16px">\n  <form method="dialog"><button>${en ? 'Close' : '关闭'}</button></form>\n  <div id="preview" style="height: min(60vh,500px)"></div>\n  ${customButtons}</dialog>\n<script type="module">\nimport { createLitematicCard } from '${moduleURL}';\nconst dialog = document.getElementById('preview-dialog');\nlet card;\ndocument.getElementById('launch').onclick = () => {\n  dialog.showModal();\n  card = createLitematicCard(document.getElementById('preview'), {\n  ...${config}${handler}\n  });\n};\ndialog.addEventListener('close', () => { card?.destroy(); card = null; });\ndocument.getElementById('reset').onclick = () => card?.resetView();\ndocument.getElementById('full').onclick = () => card?.openFullViewer();\n</script>`
    } else if (popup) {
      $('configCode').textContent = `<button id="launch">${launch}</button>\n<script type="module">\nimport { openLitematicPreview } from '${moduleURL}';\ndocument.getElementById('launch').onclick = () => openLitematicPreview(${config});\n</script>`
    } else {
      $('configCode').textContent = `<div id="preview" style="height:400px;border-radius:${options.style.radius}px"></div>\n${headless ? customButtons : ''}<script type="module">\nimport { createLitematicCard } from '${moduleURL}';\nconst card = createLitematicCard(document.getElementById('preview'), ${headless ? '{\n  ...' + config + handler + '\n}' : config});\n${headless ? `document.getElementById('reset').onclick = () => card.resetView();\ndocument.getElementById('full').onclick = () => card.openFullViewer();\n` : ''}// ${en ? 'When removing the preview: card.destroy();' : '移除预览时调用：card.destroy();'}\n</script>`
    }
    $('copyStatus').textContent = ''
  }
  function update(changed) {
    const options = getOptions()
    $('archiveShell').dataset.preset = currentPreset
    $('archiveShell').style.borderRadius = `${options.style.radius}px`
    $('hostControls').hidden = options.ui !== 'none'
    document.querySelectorAll('.presets button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.preset === currentPreset)))
    // Styling changes keep the visitor's current camera intact.
    if (card) { if (changed !== 'cfgProjection' && changed !== 'preset') delete options.camera; card.setOptions(options) }
    code()
  }
  $('startCustom').onclick = activate
  $('configForm').onsubmit = event => event.preventDefault()
  $('configForm').oninput = event => { update(event.target.id); activate() }
  for (const button of document.querySelectorAll('[data-preset]')) button.onclick = () => {
    currentPreset = button.dataset.preset
    const light = currentPreset !== 'dark', custom = currentPreset === 'custom'
    $('cfgTheme').value = light ? 'light' : 'dark'
    $('cfgBackground').value = light ? '#edf2f7' : '#172332'; $('cfgAccent').value = custom ? '#21796b' : light ? '#1268bf' : '#83cbff'
    $('cfgTransparent').checked = custom; $('cfgUI').value = custom ? 'none' : 'default'
    $('cfgProjection').value = custom ? 'orthographic' : 'perspective'
    update('preset'); activate()
  }
  $('hostReset').onclick = () => card?.resetView()
  $('hostOpen').onclick = () => card?.openFullViewer()
  $('tryPopup').onclick = () => {
    const options = getOptions()
    if (options.ui !== 'none') { openLitematicPreview({ url: sample, name: en ? 'Your archive · Sample build' : '你的档案馆 · 示例建筑', ...options }); return }
    // The host owns this dialog and every control; only the model comes from the SDK.
    const dialog = document.createElement('dialog')
    dialog.className = 'custom-preview-dialog'
    dialog.ariaLabel = en ? 'Archive preview' : '档案馆预览'
    const shell = document.createElement('div'); shell.className = 'archive-shell'; shell.dataset.preset = currentPreset
    const header = document.createElement('header'); header.className = 'archive-heading'
    const title = document.createElement('span'); title.textContent = $('archiveTitle').textContent
    const close = document.createElement('button'); close.textContent = en ? 'Close' : '关闭'; close.onclick = () => dialog.close()
    header.append(title, close)
    const viewport = document.createElement('div'); viewport.className = 'custom-dialog-viewport'
    const controls = document.createElement('div'); controls.className = 'custom-dialog-controls'
    const reset = document.createElement('button'), full = document.createElement('button'), status = document.createElement('p')
    reset.textContent = $('hostReset').textContent; full.textContent = $('hostOpen').textContent; reset.disabled = full.disabled = true
    status.setAttribute('role', 'status'); controls.append(reset, full); shell.append(header, viewport, controls, status); dialog.append(shell)
    document.body.append(dialog); dialog.showModal()
    const customCard = createLitematicCard(viewport, { url: sample, ...options, onStatus(event) {
      if (event.type === 'close-request') dialog.close()
      status.textContent = event.message || ''
      if (event.stage !== 'handoff' && ['loaded', 'loading', 'error', 'inactive'].includes(event.type)) reset.disabled = full.disabled = event.type !== 'loaded'
    } })
    reset.onclick = () => customCard.resetView(); full.onclick = () => customCard.openFullViewer()
    dialog.addEventListener('close', () => { customCard.destroy(); dialog.remove(); $('tryPopup').focus() }, { once: true })
  }
  $('codeMode').onchange = code
  $('copyCode').onclick = async () => {
    try { await navigator.clipboard.writeText($('configCode').textContent); $('copyStatus').textContent = en ? 'Copied. Replace the sample URL with your schematic URL.' : '已复制。把示例地址替换为你的投影文件地址即可。' }
    catch { const range = document.createRange(); range.selectNodeContents($('configCode')); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); $('copyStatus').textContent = en ? 'Code selected. Press Ctrl/Cmd+C to copy.' : '已选中代码，按 Ctrl/Cmd+C 复制。' }
  }
  update()
}
