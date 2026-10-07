import './embedExample.css'

const lang = new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh'
if (lang === 'en') {
  document.documentElement.lang = 'en'; document.title = 'Embedded preview examples | LitematicWebViewer'
  for (const [id, text] of Object.entries({
    back: '← Full viewer', heading: 'Bring schematics to your archive',
    intro: 'Click a schematic to open a quick preview, or explore it in 3D inside a build page’s image gallery.',
    popupLabel: '01 · SCHEMATIC LIST', popupTitle: 'Click a schematic to preview it',
    popupText: 'Stay on the current page. Left-drag to orbit, right-drag to pan, and scroll to zoom. Close the preview to keep browsing.',
    sampleTitle: 'Sample schematic', quickLabel: 'Quick preview', localTitle: 'Preview your schematic', localText: 'Choose a local file. No upload.', chooseLabel: 'Choose file',
    detailLabel: '02 · BUILD DETAILS', detailTitle: 'Preview inside the image gallery', imageTab: 'Images', modelTab: '3D preview',
    buildTitle: 'Sample build', buildDescription: 'Switch to 3D preview to rotate, pan and zoom the build right where its images appear.',
    buildHint: 'For materials and layer controls, choose “Full viewer” inside the preview.', download: 'Download schematic ↓', docs: 'Read the integration guide ↗',
  })) document.getElementById(id).textContent = text
  document.querySelector('[role="tablist"]').ariaLabel = 'Build gallery'
  document.getElementById('cover').alt = 'Screenshot of the sample schematic'
  document.getElementById('docs').href = 'https://github.com/Gudu-Z/LitematicWebViewer/blob/main/README.en.md#embedded-preview-cards'
}
const { createLitematicCard, openLitematicPreview } = await import(/* @vite-ignore */ new URL('./embed.js', location.href).href)
const sample = new URL('./demo.litematic', location.href).href
const name = lang === 'en' ? 'Sample schematic' : '示例投影'
document.getElementById('quickPreview').onclick = () => openLitematicPreview({ url: sample, name, lang })
const input = document.getElementById('file')
document.getElementById('localPreview').onclick = () => input.click()
input.onchange = event => {
  const file = event.target.files[0]
  if (file) {
    try { openLitematicPreview({ file, name: file.name, lang }); document.getElementById('exampleStatus').textContent = '' }
    catch (error) { document.getElementById('exampleStatus').textContent = error.message }
  }
  input.value = ''
}
let card
const tabs = ['imageTab', 'modelTab'].map(id => document.getElementById(id))
function selectTab(selected) {
  for (const tab of tabs) {
    const active = tab === selected
    tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !active
  }
  card?.destroy(); card = null
  if (selected.id === 'modelTab') card = createLitematicCard(document.getElementById('detailPreview'), { url: sample, name, lang })
}
for (const tab of tabs) {
  tab.onclick = () => selectTab(tab)
  tab.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[1] : tabs.find(other => other !== tab)
    selectTab(next); next.focus()
  }
}
