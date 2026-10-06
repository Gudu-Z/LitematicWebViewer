import JSZip from 'jszip'

// Accept the usual pack root and a single enclosing directory created when zipping a folder.
export async function readResourcePack(data) {
  let zip
  try { zip = await JSZip.loadAsync(data) } catch { throw Error('无法读取 ZIP 文件') }
  const roots = zip.file(/(^|\/)pack\.mcmeta$/)
  const metadata = zip.file('pack.mcmeta') || (roots.length === 1 ? roots[0] : null)
  if (!metadata) throw Error('材质包缺少 pack.mcmeta')
  try {
    const json = JSON.parse((await metadata.async('string')).trimStart())
    if (!json.pack || typeof json.pack !== 'object') throw Error()
  } catch { throw Error('pack.mcmeta 格式无效') }
  const prefix = metadata.name.slice(0, -'pack.mcmeta'.length)
  const root = prefix ? zip.folder(prefix) : zip
  if (!root.file(/^assets\/minecraft\//).length) throw Error('材质包没有可用的 Minecraft 资源')
  return root
}

// ZIPs stay in this browser; no upload is involved. Preferences use localStorage separately.
async function localPacksStore(database, mode, action) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(database, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('packs', { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('packs', mode)
      const request = action(transaction.objectStore('packs'))
      transaction.oncomplete = () => resolve(request.result)
      transaction.onerror = transaction.onabort = () => reject(transaction.error)
    })
  } finally { db.close() }
}
export const readLocalPacks = (database = 'model-catalog-packs') => localPacksStore(database, 'readonly', store => store.getAll())
export const saveLocalPack = (pack, database = 'model-catalog-packs') => localPacksStore(database, 'readwrite', store => store.put(pack))
