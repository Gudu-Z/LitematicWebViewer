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
