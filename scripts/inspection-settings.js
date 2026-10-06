import { t } from './inspection-i18n.js'
import { readResourcePack as readInspectionPack, readLocalPacks, saveLocalPack } from '../src/resourcePacks.js'

const PREFERENCES = 'model-catalog-settings-v1'
export function createInspectionSettings({ onPacksChange, onOptionsChange }) {
  const $ = id => document.getElementById(id)
  const library = new Map()
  let loaded = [], extraArms = false, busy = false, status = null
  const renderOptions = () => ({ illagerExtraArms: extraArms })
  function message(key, detail = '', error = false) {
    status = key ? { key, detail, error } : null
    $('settings-status').textContent = status ? t(key) + (detail ? ' ' + detail : '') : ''
    $('settings-status').dataset.error = String(error)
  }
  function save() {
    try { localStorage.setItem(PREFERENCES, JSON.stringify({ loaded, extraArms })) }
    catch { message('无法保存设置，当前会话仍可使用。', '', true) }
  }
  async function resolvePacks(ids) {
    return Promise.all(ids.map(async id => {
      const pack = library.get(id)
      if (!pack.zip) {
        let data = pack.data
        if (!data) {
          const response = await fetch(new URL('../resourcepacks/' + encodeURIComponent(pack.file), location.href))
          if (!response.ok) throw Error(t('资源包下载失败') + ': ' + pack.name)
          data = await response.arrayBuffer()
        }
        pack.zip = await readInspectionPack(data)
      }
      return pack
    }))
  }
  async function applyPacks(ids, persist = true) {
    const packs = await resolvePacks(ids)
    await onPacksChange(packs)
    loaded = ids
    if (persist) save()
  }
  async function run(action) {
    if (busy) return
    busy = true; message('正在应用设置…'); render()
    try {
      await action()
      if (status?.key === '正在应用设置…') message('设置已应用')
    } catch (error) { message('操作失败：', t(error.message), true) }
    finally { busy = false; render() }
  }
  function button(label, action, disabled = false, accessibleName = label) {
    const el = document.createElement('button')
    el.type = 'button'; el.textContent = t(label); el.disabled = busy || disabled
    el.setAttribute('aria-label', t(accessibleName)); el.onclick = () => run(action)
    el.dataset.action = label
    return el
  }
  function renderList(id, ids, active) {
    const list = $(id); list.replaceChildren()
    if (!ids.length) {
      const note = document.createElement('li'); note.className = 'pack-empty'
      note.textContent = t(active ? '未加载材质包，使用原版材质。' : '没有其他材质包，可从本地导入。')
      list.append(note)
    }
    ids.forEach((key, index) => {
      const pack = library.get(key)
      const row = document.createElement('li'); row.className = 'pack-row'; row.dataset.packId = key
      const name = document.createElement('strong'); name.className = 'pack-name'; name.textContent = pack.name
      const origin = document.createElement('span'); origin.className = 'pack-origin'; origin.textContent = t(pack.file ? '内置' : '本地导入')
      const actions = document.createElement('div'); actions.className = 'pack-actions'
      if (active) {
        for (const [label, delta] of [['上移', -1], ['下移', 1]]) actions.append(button(label, () => {
          const order = [...loaded], target = index + delta
          ;[order[index], order[target]] = [order[target], order[index]]
          return applyPacks(order)
        }, index + delta < 0 || index + delta >= ids.length))
        actions.append(button('卸载', () => applyPacks(loaded.filter(id => id !== key))))
      } else actions.append(button('加载', () => applyPacks([key, ...loaded])))
      row.append(name, origin, actions); list.append(row)
    })
  }
  function render() {
    renderList('loaded-packs', loaded, true)
    renderList('available-packs', [...library.keys()].filter(id => !loaded.includes(id)), false)
    $('import-packs').disabled = busy; $('pack-files').disabled = busy
    $('illager-extra-arms').disabled = busy; $('illager-extra-arms').checked = extraArms
    $('settings').setAttribute('aria-busy', String(busy))
    if (status) message(status.key, status.detail, status.error)
  }
  async function init(legacyPack) {
    busy = true; render()
    let preferences = {}, warning = ''
    try { preferences = JSON.parse(localStorage.getItem(PREFERENCES) || '{}') || {} } catch {}
    extraArms = preferences.extraArms === true
    try {
      const response = await fetch(new URL('../resourcepacks/manifest.json', location.href))
      if (!response.ok) throw Error(t('资源包下载失败'))
      for (const pack of await response.json()) {
        const id = 'builtin:' + pack.file
        library.set(id, { ...pack, id })
      }
    } catch (error) { warning = error.message }
    try { for (const pack of await readLocalPacks()) library.set(pack.id, pack) }
    catch { warning ||= t('无法读取本地材质包，仍可在当前会话导入。') }
    const xk = [...library.values()].find(pack => pack.file?.startsWith('XK redstone display'))?.id
    const ids = legacyPack === 'vanilla' ? [] : legacyPack === 'xk' ? (xk ? [xk] : [])
      : Array.isArray(preferences.loaded) ? preferences.loaded : xk ? [xk] : []
    // A missing or damaged saved pack should not stop the rest of the catalog loading.
    const valid = []
    for (const id of new Set(ids)) if (library.has(id)) {
      try { await resolvePacks([id]); valid.push(id) } catch (error) { warning ||= t(error.message) }
    }
    // Do not overwrite saved preferences when a transient network/storage failure hides packs.
    await applyPacks(valid, !warning)
    if (warning) message('部分设置未能恢复：', warning, true)
    busy = false; render(); $('open-settings').disabled = false
  }
  $('open-settings').onclick = () => { render(); $('settings').showModal() }
  $('close-settings').onclick = () => $('settings').close()
  $('settings').addEventListener('click', event => {
    if (event.target !== $('settings')) return
    const r = $('settings').getBoundingClientRect()
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) $('settings').close()
  })
  $('import-packs').onclick = () => $('pack-files').click()
  $('pack-files').onchange = () => {
    const files = [...$('pack-files').files]; $('pack-files').value = ''
    if (!files.length) return
    run(async () => {
      // Validate the entire selection before replacing any pack in the library.
      const imported = []
      for (const file of files) {
        try {
          const data = await file.arrayBuffer(), zip = await readInspectionPack(data)
          imported.push({ id: 'local:' + file.name, name: file.name, data, zip })
        } catch (error) { throw Error(file.name + ': ' + t(error.message)) }
      }
      let storageFailed = false
      for (const pack of imported) {
        library.set(pack.id, pack)
        try { await saveLocalPack({ id: pack.id, name: pack.name, data: pack.data }) } catch { storageFailed = true }
      }
      const ids = [...new Set(imported.map(pack => pack.id))]
      await applyPacks([...ids, ...loaded.filter(id => !ids.includes(id))])
      if (storageFailed) message('无法保存本地材质包，刷新后需要重新导入。', '', true)
    })
  }
  $('illager-extra-arms').onchange = () => {
    const enabled = $('illager-extra-arms').checked
    run(async () => { extraArms = enabled; await onOptionsChange(); save() })
  }
  return { init, render, renderOptions, get loaded() { return [...loaded] }, get busy() { return busy } }
}
