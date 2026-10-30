import assert from 'node:assert/strict'
import { UI } from '../src/ui.js'
import { setLang } from '../src/i18n.js'

function element(attributes = {}) {
  const attrs = new Map(Object.entries(attributes)), listeners = new Map()
  return {
    textContent: '', style: {}, hidden: false, disabled: false,
    getAttribute: key => attrs.get(key) ?? null,
    setAttribute: (key, value) => attrs.set(key, String(value)),
    removeAttribute: key => attrs.delete(key),
    addEventListener: (type, handler) => listeners.set(type, handler),
    click: () => listeners.get('click')?.(),
  }
}

const nodes = new Map(['app', 'status', 'welcomeStatus', 'loadingControls', 'loadingStatus',
  'cancelLoadingBtn', 'progressFill'].map(id => [`#${id}`, element()]))
const node = id => nodes.get(`#${id}`)
node('progressFill').parentElement = element()
node('app').setAttribute('aria-busy', 'true')
node('welcomeStatus').setAttribute('aria-live', 'polite')
const ui = new UI({ querySelector: selector => nodes.get(selector) ?? null })
assert.equal(node('loadingControls').hidden, true)
assert.equal(node('cancelLoadingBtn').hidden, true)

let firstCanceled = 0, secondCanceled = 0
ui.setLoadingCancelable(true, () => firstCanceled++)
assert.equal(node('cancelLoadingBtn').disabled, false)
assert.equal(node('loadingControls').hidden, false)
assert.equal(node('status').getAttribute('aria-live'), 'off')
ui.setProgress(.25)
ui.setLoadingStage('fill', { fraction: .73, stageFraction: .46 })
assert.match(node('loadingStatus').textContent, /生成模型 46%/)
assert.equal(node('loadingStatus').textContent, node('status').textContent)
assert.equal(node('loadingStatus').textContent, node('welcomeStatus').textContent)
assert.equal(node('progressFill').style.width, '25%', 'Stage progress must not replace overall progress')
ui.setLoadingStage('decompress', { fraction: 0, processedBytes: 128 * 1024 ** 2 })
assert.equal(node('status').textContent, '正在解压文件（已处理 128.0 MiB）…')
assert.equal(node('progressFill').style.width, '25%', 'Byte-based stage text leaves overall progress unchanged')
setLang('en'); ui.refreshStatus()
assert.equal(node('status').textContent, 'Decompressing file (128.0 MiB processed)…')
ui.setLoadingStage('decompress', { stageFraction: 0, processedBytes: 1.5 * 1024 ** 3 })
assert.equal(node('status').textContent, 'Decompressing file (1.5 GiB processed)…')
ui.setLoadingStage('decompress', { stageFraction: .5 })
assert.equal(node('status').textContent, 'Decompressing file 50%…', 'Known totals restore percentage reporting')
setLang('zh'); ui.setLoadingStage('fill', { stageFraction: .46 })
node('cancelLoadingBtn').click()
node('cancelLoadingBtn').click()
assert.equal(firstCanceled, 1, 'Each job can only be canceled once, even with repeated input')
assert.equal(node('cancelLoadingBtn').disabled, true)
assert.equal(node('cancelLoadingBtn').getAttribute('data-i18n'), 'cancelingLoading')

ui.setLoadingCancelable(false)
assert.equal(node('loadingControls').hidden, true)
assert.equal(node('status').getAttribute('aria-live'), null)
assert.equal(node('welcomeStatus').getAttribute('aria-live'), 'polite')
node('cancelLoadingBtn').click()
assert.equal(firstCanceled, 1, 'A late event after completion cannot invoke the previous job')
ui.setLoadingCancelable(true, () => secondCanceled++)
assert.equal(node('cancelLoadingBtn').getAttribute('data-i18n'), 'cancelLoading')
assert.equal(node('cancelLoadingBtn').disabled, false)
node('cancelLoadingBtn').click()
assert.equal(secondCanceled, 1)
assert.equal(firstCanceled, 1, 'Opening another file must replace the cancellation callback')

setLang('en')
ui.refreshStatus()
assert.equal(node('status').textContent, 'Building model 46%…')
for (const [phase, word] of [['decompress', 'Decompressing'], ['parse', 'Reading'], ['count', 'Counting'],
  ['textures', 'Preparing'], ['assemble', 'Displaying'], ['models', 'Preparing'],
  ['details', 'Building'], ['entities', 'Building']]) {
  ui.setLoadingStage(phase, { completed: 3, total: 4 })
  assert.match(node('status').textContent, new RegExp(`${word}.*75%`))
}
ui.setLoadingStage('count', { stageFraction: -2 })
assert.match(node('status').textContent, /0%/)
ui.setLoadingStage('count', { stageFraction: 2 })
assert.match(node('status').textContent, /100%/)
ui.setLoadingStage('decompress', { stageFraction: NaN })
assert.equal(node('status').textContent, 'Decompressing file…')
ui.setLoadingStage('unknown')
assert.equal(node('status').textContent, 'Loading schematic…')
ui.setLoadingCancelable(false)
ui.setStatusKey('loadingCancelled')
assert.match(node('status').textContent, /Loading canceled/)

// Embed/custom hosts need not provide the optional loading controls or status DOM.
const minimal = new UI({ querySelector: () => null })
minimal.setLoadingCancelable(true, () => assert.fail('No control was clicked'))
minimal.setLoadingStage('parse', { stageFraction: .5 })
minimal.setLoadingCancelable(false)
setLang('zh')
console.log('PASS loading cancellation is one-shot, isolated per file, bilingual and optional for small hosts')
