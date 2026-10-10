// UI 更新：状态栏、进度条、元数据面板、拖拽遮罩。

import { t } from './i18n.js'

export class UI {
  constructor(root) {
    this.metadataEl = root.querySelector('#metadata')
    this.statusEl = root.querySelector('#status')
    this.progressFill = root.querySelector('#progressFill')
    this.dropOverlay = root.querySelector('#dropOverlay')
    this.errorBanner = root.querySelector('#errorBanner')
    this.loadedPackListEl = root.querySelector('#loadedPackList')
    this.availablePackListEl = root.querySelector('#availablePackList')
    this.moveModeBtn = root.querySelector('#moveModeBtn')
    this.speedSlider = root.querySelector('#speedSlider')
    this.speedValue = root.querySelector('#speedValue')
    this.sensitivitySlider = root.querySelector('#sensitivitySlider')
    this.sensitivityValue = root.querySelector('#sensitivityValue')
    this.layerValue = root.querySelector('#layerValue')
    this.regionListEl = root.querySelector('#regionList')
    this.regionListBody = root.querySelector('#regionListBody')
    this.regionListToggle = root.querySelector('#regionListToggle')
    this.materialListBody = root.querySelector('#materialListBody')
    this.materialListToggle = root.querySelector('#materialListToggle')
    this.materialSortBtn = root.querySelector('#materialSortBtn')
    this.onMaterialSort = null // 由 main.js 设置，点击排序按钮时触发

    // 区域列表折叠
    if (this.regionListToggle) {
      this.regionListToggle.addEventListener('click', () => {
        this.regionListBody.classList.toggle('collapsed')
        this.regionListToggle.classList.toggle('collapsed')
      })
    }

    // 材料清单折叠
    if (this.materialListToggle) {
      this.materialListToggle.addEventListener('click', () => {
        const collapsed = this.materialListBody.classList.toggle('collapsed')
        this.materialListToggle.classList.toggle('collapsed', collapsed)
        this.materialListToggle.setAttribute('aria-expanded', String(!collapsed))
      })
    }

    // 材料排序切换
    if (this.materialSortBtn) {
      this.materialSortBtn.addEventListener('click', () => this.onMaterialSort?.())
    }
  }

  showError(msg) {
    if (!this.errorBanner) return
    this.errorBanner.textContent = String(msg)
    this.errorBanner.classList.remove('hidden')
    this.onError?.(String(msg))
  }

  clearError() {
    if (!this.errorBanner) return
    this.errorBanner.textContent = ''
    this.errorBanner.classList.add('hidden')
  }

  setStatus(text) {
    this.statusEl.textContent = text
    document.getElementById('welcomeStatus').textContent = document.getElementById('app').getAttribute('aria-busy') === 'true' ? text : ''
  }

  // 记录状态来源（key + 插值变量），语言切换后能重新翻译
  setStatusKey(key, vars) {
    this._statusKey = key
    this._statusVars = vars
    this.setStatus(t(key, vars))
  }

  refreshStatus() {
    if (this._statusKey) this.setStatus(t(this._statusKey, this._statusVars))
  }

  setProgress(p) {
    this.progressFill.style.width = Math.round(Math.min(1, Math.max(0, p)) * 100) + '%'
    this.progressFill.parentElement.setAttribute('aria-valuenow', String(Math.round(Math.min(1, Math.max(0, p)) * 100)))
    this.onProgress?.(p)
  }

  showMetadata(meta) {
    const m = meta || {}
    const none = t('metaNone')
    const items = [
      [t('metaName'), m.name || none],
      [t('metaAuthor'), m.author || none],
      [t('metaSize'), m.enclosingSize ? `${m.enclosingSize.x} × ${m.enclosingSize.y} × ${m.enclosingSize.z}` : none],
      [t('metaTotalBlocks'), m.totalBlocks != null ? m.totalBlocks.toLocaleString() : none],
      [t('metaTotalVolume'), m.totalVolume != null ? m.totalVolume.toLocaleString() : none],
      [t('metaRegionCount'), m.regionCount ?? none],
      [t('metaDataVersion'), m.minecraftDataVersion || none],
    ]
    if (m.description) items.push([t('metaDescription'), m.description])
    this.metadataEl.innerHTML = items
      .map(([k, v]) => `<div class="row"><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd></div>`)
      .join('')
  }

  showDropOverlay(on) {
    this.dropOverlay.classList.toggle('visible', on)
  }

  // 更新移动模式按钮文案
  setMoveModeLabel(mode) {
    if (!this.moveModeBtn) return
    this.moveModeBtn.textContent = mode === 'orbit' ? t('orbitMode') : t('flyMode')
  }

  // 同步速度滑块与数值显示
  setSpeed(value) {
    const v = Math.round(Number(value) * 100) / 100
    if (this.speedSlider) this.speedSlider.value = String(v)
    if (this.speedValue) this.speedValue.textContent = v.toFixed(1) + '×'
  }

  // 同步灵敏度滑块与数值显示
  setSensitivity(value) {
    const v = Math.round(Number(value) * 1000) / 1000
    if (this.sensitivitySlider) this.sensitivitySlider.value = String(v)
    if (this.sensitivityValue) this.sensitivityValue.textContent = String(v)
  }

  // 更新当前层显示
  setLayerLabel(y) {
    if (!this.layerValue) return
    this.layerValue.textContent = y === '-' ? t('layerDash') : t('layerValue', { y })
  }

  // 渲染区域列表（可折叠，每项带眼睛开关）。visible 为 Set（null=全显示）
  renderRegionList(regions, visible, onToggle) {
    if (!this.regionListBody) return
    if (!regions || !regions.length) {
      this.regionListBody.innerHTML = `<li class="pack-empty">${t('noRegions')}</li>`
      return
    }
    this.regionListBody.innerHTML = regions
      .map((r) => {
        const on = !visible || visible.has(r.name)
        return `
        <li data-name="${escapeHtml(r.name)}">
          <button class="eye-btn" data-action="toggle" title="${on ? t('hide') : t('show')}" aria-label="${on ? t('hide') : t('show')} ${escapeHtml(r.name)}" aria-pressed="${on}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>${on ? '' : '<path d="m3 3 18 18"/>'}</svg>
          </button>
          <span class="region-name">${escapeHtml(r.name)}</span>
        </li>`
      })
      .join('')
    this.regionListBody.querySelectorAll('button[data-action="toggle"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        onToggle(btn.closest('li').getAttribute('data-name'))
      })
    })
  }

  // 渲染材料清单（每种方块类型 + 数量）。materials 已按当前排序方向排好；sortAsc 决定排序按钮文案
  renderMaterialList(materials, sortAsc) {
    if (!this.materialListBody) return
    if (this.materialSortBtn) this.materialSortBtn.textContent = sortAsc ? t('sortAsc') : t('sortDesc')
    const kinds = (materials?.length || 0).toLocaleString()
    const total = (materials || []).reduce((sum, m) => sum + m.count, 0).toLocaleString()
    document.getElementById('materialSummary').textContent = t('materialKinds', { n: kinds })
    document.getElementById('materialTotals').textContent = t('materialTotals', { kinds, total })
    if (!materials || !materials.length) {
      this.materialListBody.innerHTML = `<li class="pack-empty">${t('noBlocks')}</li>`
      return
    }
    this.materialListBody.innerHTML = materials
      .map(
        (m) => `
        <li>
          <span class="material-icon" data-material="${escapeHtml(m.key || m.name)}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9zm-8 4.5 8 4.5 8-4.5M12 12v9"/></svg><img width="32" height="32" alt="" hidden /></span>
          <span class="material-name" title="${escapeHtml(m.key || m.name)}">${escapeHtml(m.name)}</span>
          <span class="material-count">${m.count.toLocaleString()}</span>
        </li>`
      )
      .join('')
  }

  // Both lists use stable IDs, keeping local and built-in packs with the same name separate.
  renderPackPanels(loaded, available, callbacks, busy = false) {
    for (const [el, packs, active] of [[this.loadedPackListEl, loaded, true], [this.availablePackListEl, available, false]]) {
      el.replaceChildren()
      if (!packs.length) {
        const row = document.createElement('li'); row.className = 'pack-empty'
        row.textContent = t(active ? 'packNoneLoaded' : 'packNoneAvailable'); el.append(row)
      }
      packs.forEach((pack, index) => {
        const row = document.createElement('li'); row.dataset.packId = pack.id
        const name = document.createElement('span'); name.className = 'pack-name'; name.textContent = pack.name
        const origin = document.createElement('span'); origin.className = 'pack-origin'; origin.textContent = t(pack.file ? 'packBuiltIn' : 'packLocal')
        const actions = document.createElement('div'); actions.className = 'pack-actions'
        const add = (action, key, handler, disabled = false, label = t(key)) => {
          const button = document.createElement('button'); button.type = 'button'; button.dataset.action = action
          button.textContent = label; button.title = t(key); button.setAttribute('aria-label', t(key) + ' · ' + pack.name)
          button.disabled = busy || disabled; button.onclick = handler; actions.append(button)
        }
        if (active) {
          add('up', 'packUp', () => callbacks.onMove(pack.id, -1), index === 0, '↑')
          add('down', 'packDown', () => callbacks.onMove(pack.id, 1), index === packs.length - 1, '↓')
          add('unload', 'packUnload', () => callbacks.onUnload(pack.id))
        } else add('load', 'packLoad', () => callbacks.onLoad(pack.id))
        row.append(name, origin, actions); el.append(row)
      })
    }
    document.getElementById('loadedPackCount').textContent = loaded.length
    document.getElementById('availablePackCount').textContent = available.length
    document.getElementById('unloadAllPacks').disabled = busy || !loaded.length
    document.getElementById('packSummary').textContent = loaded.length ? t('packCount', { n: loaded.length }) : t('packVanilla')
  }

  setPackStatus(key, vars, error = false) {
    this._packStatus = { key, vars, error }
    const el = document.getElementById('packStatus')
    el.textContent = t(key, vars); el.dataset.error = String(error)
  }

  refreshPackStatus() {
    if (this._packStatus) this.setPackStatus(this._packStatus.key, this._packStatus.vars, this._packStatus.error)
  }

}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
