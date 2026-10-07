import { readResourcePack, readLocalPacks, saveLocalPack } from './resourcePacks.js'

// Keep the viewer's choices separate from the catalog; both use the same ZIP reader.
const DATABASE = 'viewer-resource-packs'
const PREFERENCES = 'viewer-resource-packs-v1'
export class ViewerPacks {
  constructor({
    apply, translate = key => key,
    storage = { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) },
    read = () => readLocalPacks(DATABASE), write = pack => saveLocalPack(pack, DATABASE),
    fetchPack = (...args) => fetch(...args),
  }) {
    this.apply = apply; this.translate = translate; this.storage = storage
    this.read = read; this.write = write; this.fetch = fetchPack
    this.library = new Map(); this.loaded = []
  }
  get active() { return this.loaded.map(id => this.library.get(id)) }
  get available() { return [...this.library.values()].filter(pack => !this.loaded.includes(pack.id)) }
  async resolve(id) {
    const pack = this.library.get(id)
    if (!pack) throw Error(this.translate('packMissing'))
    if (!pack.zip) {
      let data = pack.data
      if (!data) {
        const response = await this.fetch('resourcepacks/' + encodeURIComponent(pack.file))
        if (!response.ok) throw Error(this.translate('packDownloadFailed', { status: response.status }))
        data = await response.arrayBuffer()
      }
      pack.zip = await readResourcePack(data)
    }
    return pack
  }
  async commit(ids, persist = true) {
    const next = [...new Set(ids)]
    const resolved = await Promise.all(next.map(id => this.resolve(id)))
    await this.apply(resolved)
    this.loaded = next
    if (persist) {
      try { this.storage.setItem(PREFERENCES, JSON.stringify(next)) }
      catch { return 'packPreferencesUnavailable' }
    }
    return ''
  }
  async init({ preset } = {}) {
    let warning = '', saved
    if (!preset) try { saved = JSON.parse(this.storage.getItem(PREFERENCES)) } catch {}
    try {
      const response = await this.fetch('resourcepacks/manifest.json')
      if (!response.ok) throw Error()
      for (const pack of await response.json()) {
        const id = 'builtin:' + pack.file
        this.library.set(id, { ...pack, id })
      }
    } catch { warning = 'packManifestUnavailable' }
    try { if (!preset) for (const pack of await this.read()) this.library.set(pack.id, pack) }
    catch { warning ||= 'packStorageUnavailable' }
    const defaultPack = [...this.library.values()].find(pack => pack.file && /XK/i.test(pack.name))
    const requested = preset === 'vanilla' ? [] : Array.isArray(saved) ? saved : defaultPack ? [defaultPack.id] : []
    const valid = []
    for (const id of new Set(requested)) {
      try { await this.resolve(id); valid.push(id) } catch { warning ||= 'packRestoreFailed' }
    }
    // A temporary outage must not erase a user's saved pack selection.
    return (await this.commit(valid, !warning && !preset)) || warning
  }
  load(id) { return this.commit([id, ...this.loaded.filter(key => key !== id)]) }
  unload(id) { return this.commit(this.loaded.filter(key => key !== id)) }
  unloadAll() { return this.commit([]) }
  move(id, delta) {
    const order = [...this.loaded], index = order.indexOf(id), target = index + delta
    if (index < 0 || target < 0 || target >= order.length) return Promise.resolve('')
    ;[order[index], order[target]] = [order[target], order[index]]
    return this.commit(order)
  }
  async importFiles(files) {
    // Validate all files first, so a bad selection cannot partially replace active packs.
    const imported = []
    for (const file of files) {
      try {
        const data = await file.arrayBuffer(), zip = await readResourcePack(data)
        imported.push({ id: 'local:' + file.name, name: file.name, data, zip })
      } catch (error) { throw Error(file.name + ': ' + this.translate(error.message)) }
    }
    const previous = new Map(this.library)
    for (const pack of imported) this.library.set(pack.id, pack)
    const ids = [...new Set(imported.map(pack => pack.id))]
    let warning
    try { warning = await this.commit([...ids, ...this.loaded.filter(id => !ids.includes(id))]) }
    catch (error) { this.library = previous; throw error }
    for (const pack of imported) {
      try { await this.write({ id: pack.id, name: pack.name, data: pack.data }) }
      catch { warning = 'packSaveFailed' }
    }
    return warning
  }
}
