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
        this.materialListBody.classList.toggle('collapsed')
        this.materialListToggle.classList.toggle('collapsed')
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
  }

  clearError() {
    if (!this.errorBanner) return
    this.errorBanner.textContent = ''
    this.errorBanner.classList.add('hidden')
  }

  setStatus(text) {
    this.statusEl.textContent = text
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
          <button class="eye-btn" data-action="toggle" title="${on ? t('hide') : t('show')}">
            ${on ? '👁' : '🚫'}
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
    if (!materials || !materials.length) {
      this.materialListBody.innerHTML = `<li class="pack-empty">${t('noBlocks')}</li>`
      return
    }
    this.materialListBody.innerHTML = materials
      .map(
        (m) => `
        <li>
          <span class="material-name" title="${escapeHtml(m.key || m.name)}">${escapeHtml(m.name)}</span>
          <span class="material-count">${m.count.toLocaleString()}</span>
        </li>`
      )
      .join('')
  }

  // 渲染资源包两栏：loaded=已加载（按优先级顺序，名字数组），available=可加载 [{name, file}]
  // callbacks: { onLoad(pack), onUnload(name), onMove(name, delta) }
  renderPackPanels(loaded, available, callbacks) {
    this._renderLoadedPacks(loaded, callbacks)
    this._renderAvailablePacks(loaded, available, callbacks)
  }

  _renderLoadedPacks(loaded, callbacks) {
    const el = this.loadedPackListEl
    if (!el) return
    if (!loaded || !loaded.length) {
      el.innerHTML = `<li class="pack-empty">${t('packNoneLoaded')}</li>`
      return
    }
    el.innerHTML = loaded
      .map(
        (name, i) => `
        <li data-name="${escapeHtml(name)}">
          <span class="pack-name">${escapeHtml(name)}</span>
          <span class="pack-actions">
            <button data-action="up" title="${t('packUp')}" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button data-action="down" title="${t('packDown')}" ${i === loaded.length - 1 ? 'disabled' : ''}>↓</button>
            <button data-action="unload" class="unload-btn" title="${t('packUnload')}">${t('packUnload')}</button>
          </span>
        </li>`
      )
      .join('')
    el.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.closest('li').getAttribute('data-name')
        const action = btn.getAttribute('data-action')
        if (action === 'up') callbacks.onMove(name, -1)
        else if (action === 'down') callbacks.onMove(name, 1)
        else if (action === 'unload') callbacks.onUnload(name)
      })
    })
  }

  _renderAvailablePacks(loaded, available, callbacks) {
    const el = this.availablePackListEl
    if (!el) return
    const loadedSet = new Set(loaded || [])
    const avail = (available || []).filter((p) => !loadedSet.has(p.name))
    if (!avail.length) {
      el.innerHTML = `<li class="pack-empty">${t('packNoneAvailable')}</li>`
      return
    }
    el.innerHTML = avail
      .map(
        (p) => `
        <li data-name="${escapeHtml(p.name)}">
          <span class="pack-name">${escapeHtml(p.name)}</span>
          <button data-action="load" class="unload-btn">${t('packLoad')}</button>
        </li>`
      )
      .join('')
    el.querySelectorAll('button[data-action="load"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.closest('li').getAttribute('data-name')
        const pack = available.find((p) => p.name === name)
        if (pack) callbacks.onLoad(pack)
      })
    })
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
