const lang = new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh'
if (lang === 'en') {
  document.documentElement.lang = 'en'; document.title = 'Embedded preview examples | LitematicWebViewer'
  for (const [id, text] of Object.entries({ back: '← Full viewer', heading: 'Bring schematics to your archive', intro: 'Drag to orbit. Click to open the full viewer. These cards demonstrate URL and file-data integration.', urlTitle: 'Public download URL', urlText: 'Embed with one iframe. This example uses vanilla textures.', fileTitle: 'Local or protected files', fileText: 'Files pass between browser windows without an upload, including when opening the full viewer.', sample: 'Use sample', docs: 'Read the integration guide ↗' })) document.getElementById(id).textContent = text
  document.getElementById('file').ariaLabel = 'Choose a schematic'
  document.getElementById('docs').href = 'https://github.com/Gudu-Z/LitematicWebViewer/blob/main/README.en.md#embedded-preview-cards'
}
const { createLitematicCard } = await import(/* @vite-ignore */ new URL('./embed.js', location.href).href)
const frame = document.createElement('iframe')
const url = new URL('./embed.html', location.href)
url.search = new URLSearchParams({ file: new URL('./demo.litematic', location.href).href, lang, pack: 'vanilla' })
frame.src = url.href; frame.title = lang === 'en' ? 'Schematic preview' : '投影预览'; frame.loading = 'lazy'
document.getElementById('urlCard').append(frame)
const card = createLitematicCard(document.getElementById('fileCard'), { lang, pack: 'xk' })
document.getElementById('file').onchange = event => { if (event.target.files[0]) card.load(event.target.files[0]) }
document.getElementById('sample').onclick = async event => {
  const button = event.currentTarget; button.disabled = true
  try {
    const response = await fetch(new URL('./demo.litematic', location.href))
    if (!response.ok) throw Error(`HTTP ${response.status}`)
    card.load(new File([await response.blob()], 'demo.litematic'))
  } catch (error) { button.textContent = error.message }
  finally { button.disabled = false }
}
