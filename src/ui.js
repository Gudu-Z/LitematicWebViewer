// UI 更新：状态栏、进度条、元数据面板、拖拽遮罩。

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
    this.layerValue = root.querySelector('#layerValue')
    this.regionListEl = root.querySelector('#regionList')
    this.regionListBody = root.querySelector('#regionListBody')
    this.regionListToggle = root.querySelector('#regionListToggle')

    // 区域列表折叠
    if (this.regionListToggle) {
      this.regionListToggle.addEventListener('click', () => {
        this.regionListBody.classList.toggle('collapsed')
        this.regionListToggle.classList.toggle('collapsed')
      })
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

  setProgress(p) {
    this.progressFill.style.width = Math.round(Math.min(1, Math.max(0, p)) * 100) + '%'
  }

  showMetadata(meta) {
    const m = meta || {}
    const items = [
      ['名称', m.name || '（无）'],
      ['作者', m.author || '（无）'],
      ['尺寸', m.enclosingSize ? `${m.enclosingSize.x} × ${m.enclosingSize.y} × ${m.enclosingSize.z}` : '（无）'],
      ['方块总数', m.totalBlocks != null ? m.totalBlocks.toLocaleString() : '（无）'],
      ['总体积', m.totalVolume != null ? m.totalVolume.toLocaleString() : '（无）'],
      ['区域数', m.regionCount ?? '（无）'],
      ['数据版本', m.minecraftDataVersion || '（无）'],
    ]
    if (m.description) items.push(['描述', m.description])
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
    this.moveModeBtn.textContent = mode === 'orbit' ? '环绕模式' : '飞行模式'
  }

  // 同步速度滑块与数值显示
  setSpeed(value) {
    const v = Math.round(Number(value) * 100) / 100
    if (this.speedSlider) this.speedSlider.value = String(v)
    if (this.speedValue) this.speedValue.textContent = v.toFixed(1) + '×'
  }

  // 更新当前层显示
  setLayerLabel(y) {
    if (this.layerValue) this.layerValue.textContent = '层 ' + y
  }

  // 渲染区域列表（可折叠，每项带眼睛开关）。visible 为 Set（null=全显示）
  renderRegionList(regions, visible, onToggle) {
    if (!this.regionListBody) return
    if (!regions || !regions.length) {
      this.regionListBody.innerHTML = '<li class="pack-empty">无区域</li>'
      return
    }
    this.regionListBody.innerHTML = regions
      .map((r) => {
        const on = !visible || visible.has(r.name)
        return `
        <li data-name="${escapeHtml(r.name)}">
          <button class="eye-btn" data-action="toggle" title="${on ? '隐藏' : '显示'}">
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
      el.innerHTML = '<li class="pack-empty">未加载任何资源包</li>'
      return
    }
    el.innerHTML = loaded
      .map(
        (name, i) => `
        <li data-name="${escapeHtml(name)}">
          <span class="pack-name">${escapeHtml(name)}</span>
          <span class="pack-actions">
            <button data-action="up" title="提高优先级" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button data-action="down" title="降低优先级" ${i === loaded.length - 1 ? 'disabled' : ''}>↓</button>
            <button data-action="unload" class="unload-btn" title="卸载">卸载</button>
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
      el.innerHTML = '<li class="pack-empty">没有可加载的资源包</li>'
      return
    }
    el.innerHTML = avail
      .map(
        (p) => `
        <li data-name="${escapeHtml(p.name)}">
          <span class="pack-name">${escapeHtml(p.name)}</span>
          <button data-action="load" class="unload-btn">加载</button>
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
