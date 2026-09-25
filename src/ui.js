// UI 更新：状态栏、进度条、元数据面板、拖拽遮罩。

export class UI {
  constructor(root) {
    this.metadataEl = root.querySelector('#metadata')
    this.statusEl = root.querySelector('#status')
    this.progressFill = root.querySelector('#progressFill')
    this.dropOverlay = root.querySelector('#dropOverlay')
    this.errorBanner = root.querySelector('#errorBanner')
    this.packListEl = root.querySelector('#packList')
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

  // packs: [{name, file}]；onSelect(pack) 在点击「加载」时触发
  renderPackList(packs, onSelect) {
    if (!this.packListEl) return
    if (!packs || !packs.length) {
      this.packListEl.innerHTML = '<li class="pack-empty">没有可用的资源包（把 .zip 放进 resourcepacks/ 目录后运行 npm run packs）</li>'
      return
    }
    this.packListEl.innerHTML = packs
      .map(
        (p) => `
        <li data-name="${escapeHtml(p.name)}">
          <span class="pack-name">${escapeHtml(p.name)}</span>
          <button data-action="load">加载</button>
        </li>`
      )
      .join('')
    this.packListEl.querySelectorAll('button[data-action="load"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const li = btn.closest('li')
        const name = li.getAttribute('data-name')
        const pack = packs.find((p) => p.name === name)
        if (pack) onSelect(pack)
      })
    })
  }

  setActivePack(name) {
    if (!this.packListEl) return
    this.packListEl.querySelectorAll('li').forEach((li) => {
      li.classList.toggle('active', name != null && li.getAttribute('data-name') === name)
    })
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
