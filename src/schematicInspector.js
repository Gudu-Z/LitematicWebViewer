import * as THREE from 'three'
import { getLang } from './i18n.js'
import { MaterialIcons } from './materialIcons.js'
import { inspectSelection, stackName, shortId } from './selectionDetails.js'
import { bindSelectionClicks, pickSchematic, selectionBounds } from './selectionPicking.js'
import './schematicInspector.css'

const WORDS = {
  block: ['方块', 'Block'], mob: ['生物', 'Mob'], entity: ['实体', 'Entity'], close: ['取消选中', 'Clear selection'],
  position: ['投影坐标', 'Schematic coordinates'], regions: ['区域', 'Region'], properties: ['方块状态', 'Block states'],
  noProperties: ['此方块没有状态属性', 'This block has no state properties'],
  health: ['血量', 'Health'], healthValue: ['{n} 点 · {hearts} 颗心', '{n} HP · {hearts} hearts'],
  maxHealth: ['已保存的最大血量', 'Saved maximum health'], unknown: ['文件未保存', 'Not saved in file'],
  rotation: ['朝向', 'Facing'], yaw: ['水平角 Yaw', 'Yaw'], pitch: ['俯仰角 Pitch', 'Pitch'], riding: ['乘坐状态', 'Riding'],
  equipment: ['装备与手持物品', 'Equipment & held items'], passengers: ['乘客', 'Passengers'],
  head: ['头部', 'Head'], chest: ['胸部', 'Chest'], legs: ['腿部', 'Legs'], feet: ['脚部', 'Feet'],
  mainhand: ['主手', 'Main hand'], offhand: ['副手', 'Off hand'], body: ['身体', 'Body'], saddle: ['鞍', 'Saddle'],
  inventory: ['容器内容', 'Contents'], otherHalf: ['相邻箱体', 'Other chest half'],
  front: ['正面文字', 'Front text'], back: ['背面文字', 'Back text'],
  occupancy: ['已占用 {used} / {size} 格 · {count} 件', '{used} / {size} slots used · {count} items'],
  itemCount: ['{used} 组 · {count} 件', '{used} stacks · {count} items'],
  empty: ['空', 'Empty'], slot: ['槽位 {n}', 'Slot {n}'], item: ['物品详情', 'Item details'],
  missingInventory: ['文件未保存物品列表，可能为空或导出时未包含容器内容。', 'No item list was saved. The container may be empty, or its contents may have been omitted when exporting.'],
  loot: ['战利品尚未生成', 'Loot has not been generated'],
  enderChest: ['末影箱内容属于玩家，投影文件中的方块不保存该库存。', 'Ender chest contents belong to the player and are not stored in this schematic block.'],
  nbt: ['原始 NBT 数据', 'Raw NBT data'], noNBT: ['文件没有保存此方块的方块实体数据。', 'No block entity data was saved for this block.'],
  filteredNBT: ['已读取的 NBT 数据', 'Loaded NBT data'],
  skippedBooks: ['本投影的书页正文已跳过，不在详情中显示；物品数量、书名和作者仍保留。', 'Book page contents were skipped for this schematic and are not shown here. Item counts, titles and authors are retained.'],
  saved: ['显示投影文件保存的状态。单击空白处或按 Esc 取消选中。', 'Shows the state saved in the schematic. Click empty space or press Esc to clear.'],
  entries: ['{n} 项', '{n} entries'], more: ['显示更多', 'Show more'],
  blockEntity: ['方块实体', 'Block entity'], details: ['已保存的信息', 'Saved information'],
  true: ['是', 'Yes'], false: ['否', 'No'], north: ['北（−Z）', 'North (−Z)'], south: ['南（+Z）', 'South (+Z)'],
  east: ['东（+X）', 'East (+X)'], west: ['西（−X）', 'West (−X)'], up: ['上（+Y）', 'Up (+Y)'], down: ['下（−Y）', 'Down (−Y)'],
  facing: ['朝向', 'Facing'], waterlogged: ['含水', 'Waterlogged'], axis: ['轴向', 'Axis'], half: ['上下部分', 'Half'],
  single: ['单独', 'Single'], double: ['双层', 'Double'], top: ['上半', 'Top'], bottom: ['下半', 'Bottom'],
  upper: ['上半', 'Upper'], lower: ['下半', 'Lower'], left: ['左', 'Left'], right: ['右', 'Right'],
  straight: ['直形', 'Straight'], inner_left: ['内左', 'Inner left'], inner_right: ['内右', 'Inner right'],
  outer_left: ['外左', 'Outer left'], outer_right: ['外右', 'Outer right'],
  type: ['类型', 'Type'], shape: ['形状', 'Shape'], open: ['打开', 'Open'], powered: ['受红石激活', 'Powered'],
  lit: ['点亮', 'Lit'], level: ['等级', 'Level'], rotationState: ['旋转', 'Rotation'], age: ['生长阶段', 'Growth stage'],
  Health: ['血量', 'Health'], Age: ['年龄（刻）', 'Age (ticks)'], Baby: ['幼年', 'Baby'], IsBaby: ['幼年', 'Baby'],
  NoAI: ['禁用 AI', 'No AI'], Invulnerable: ['无敌', 'Invulnerable'], Invisible: ['隐形', 'Invisible'],
  Silent: ['静音', 'Silent'], PersistenceRequired: ['持久保留', 'Persistent'], Fire: ['着火时间（刻）', 'Fire (ticks)'],
  Air: ['剩余氧气（刻）', 'Air (ticks)'], FallDistance: ['下落距离', 'Fall distance'],
  Size: ['大小', 'Size'], Variant: ['变种', 'Variant'], Sitting: ['坐下', 'Sitting'], Tame: ['驯服', 'Tamed'],
  BurnTime: ['燃烧时间', 'Burn time'], CookTime: ['烧炼进度', 'Cooking progress'], CookTimeTotal: ['烧炼总时间', 'Cooking duration'],
}
const tr = (key, args = {}) => {
  let value = WORDS[key]?.[getLang() === 'en' ? 1 : 0] || key
  for (const [k, v] of Object.entries(args)) value = value.replaceAll('{' + k + '}', String(v))
  return value
}
const el = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
const format = value => typeof value === 'number' ? (Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)))) : String(value)
const NBT_BOOLEAN = new Set(['Baby', 'IsBaby', 'NoAI', 'Invulnerable', 'Invisible', 'Silent', 'PersistenceRequired', 'Sitting', 'Tame', 'Small', 'ShowArms', 'NoGravity'])
let namesPromise

export class SchematicInspector {
  constructor({ renderer, assets, getData, enabled, onSelect }) {
    this.renderer = renderer; this.assets = assets; this.getData = getData
    renderer.renderer.domElement.tabIndex = 0
    this.panel = el('section', 'schematic-inspector'); this.panel.id = 'schematicInspector'; this.panel.hidden = true
    this.panel.setAttribute('aria-labelledby', 'selectionTitle'); this.panel.tabIndex = -1
    this.panel.addEventListener('keydown', event => { if (event.key !== 'Escape') event.stopPropagation() })
    this.panel.addEventListener('focusin', () => renderer.keys.clear())
    this.header = el('header', 'inspector-head')
    this.heading = el('div'); this.title = el('h2'); this.title.id = 'selectionTitle'; this.title.setAttribute('aria-live', 'polite')
    this.kind = el('p', 'eyebrow'); this.id = el('p', 'inspector-id')
    this.heading.append(this.kind, this.title, this.id)
    this.close = el('button', 'icon-btn', '×'); this.close.type = 'button'; this.close.onclick = () => this.clear(true)
    this.header.append(this.heading, this.close)
    this.body = el('div', 'inspector-body'); this.body.tabIndex = 0
    this.footer = el('p', 'inspector-foot')
    this.panel.append(this.header, this.body, this.footer); document.getElementById('app').append(this.panel)
    this.outline = new THREE.Box3Helper(new THREE.Box3(), 0x8dc8ff)
    this.outline.name = 'selection-outline'; this.outline.visible = false
    this.outline.material.depthTest = false; this.outline.material.transparent = true; this.outline.material.opacity = .9
    this.outline.renderOrder = 1000
    renderer.scene.add(this.outline)
    this.unbind = bindSelectionClicks(renderer.renderer.domElement, enabled, (x, y) => {
      const selection = pickSchematic(renderer, getData(), x, y)
      if (!selection) { this.clear(); return }
      onSelect?.(); this.select(selection)
    })
    // Registered before the host bridge: Esc dismisses this card before it can
    // request closing a host website's full viewer modal.
    this.onEscape = event => {
      if (event.key !== 'Escape' || this.panel.hidden || document.querySelector('dialog[open]')) return
      event.preventDefault(); event.stopImmediatePropagation(); this.clear(true)
    }
    window.addEventListener('keydown', this.onEscape, true)
  }

  select(selection) {
    this.selection = selection
    this.details = inspectSelection(this.getData(), selection)
    if (!this.details) { this.clear(); return }
    this.outline.box.copy(selectionBounds(selection)); this.outline.visible = true
    this.panel.hidden = false; document.body.classList.add('has-selection')
    this.render(); this.body.scrollTop = 0; this.renderer.requestRender(true)
    namesPromise ||= Promise.all([import('../scripts/inspection-data.js'), import('../scripts/inspection-english.js')])
    if (!this.names) namesPromise.then(([zh, en]) => {
      this.names = { zh: zh.ZH_NAMES, en: en.EN_NAMES }
      if (!this.panel.hidden) this.render()
    }).catch(() => { /* Resource IDs remain readable if the language chunk fails. */ })
  }

  clear(focus = false) {
    const wasOpen = !this.panel.hidden
    this.selection = null; this.details = null; this.panel.hidden = true; this.outline.visible = false
    document.body.classList.remove('has-selection'); this.body.replaceChildren(); this.icons?.observe()
    if (wasOpen) this.renderer.requestRender(true)
    if (focus) this.renderer.renderer.domElement.focus({ preventScroll: true })
  }

  resetIcons() { this.icons?.reset() }
  translate() { if (this.details) this.render() }
  name(id, kind = 'item') {
    const value = String(id || ''), qualified = value.includes(':') ? value.replace(':', '.') : 'minecraft.' + value
    const names = this.names?.[getLang()]
    return names?.[kind + '.' + qualified] || names?.['block.' + qualified] || value
  }

  section(label, open = true) {
    const section = el('details', 'inspector-section'); section.open = open
    section.append(el('summary', null, label)); this.body.append(section)
    const content = el('div', 'inspector-section-body'); section.append(content)
    return content
  }

  rows(parent, pairs) {
    const list = el('dl', 'inspector-rows')
    for (const [key, value, raw] of pairs) {
      const label = el('dt', null, tr(key))
      if (raw && tr(key) !== raw) label.append(el('code', null, raw))
      list.append(label, el('dd', null, value))
    }
    parent.append(list)
  }

  render() {
    const d = this.details
    if (!d) return
    this.kind.textContent = tr(d.kind)
    this.title.textContent = d.customName || this.name(d.id, d.kind === 'block' ? 'block' : 'entity')
    this.id.textContent = d.customName ? this.name(d.id, d.kind === 'block' ? 'block' : 'entity') + ' · ' + d.id : d.id
    this.close.title = tr('close'); this.close.setAttribute('aria-label', tr('close')); this.footer.textContent = tr('saved')
    this.body.replaceChildren()
    const coordinates = el('div', 'inspector-coordinates'); coordinates.setAttribute('aria-label', tr('position'))
    d.position.forEach((value, i) => {
      const cell = el('div'); cell.append(el('span', null, ['X', 'Y', 'Z'][i]), el('code', null, format(value)))
      cell.title = String(value); coordinates.append(cell)
    })
    this.body.append(coordinates)
    if (d.regions?.length) this.rows(this.body, [['regions', d.regions.join(' · ')]])
    if (d.kind === 'block') {
      const states = this.section(tr('properties'))
      const pairs = Object.entries(d.properties).map(([key, value]) => [key === 'rotation' ? 'rotationState' : key, tr(String(value)), key])
      if (pairs.length) this.rows(states, pairs)
      else states.append(el('p', 'inspector-note', tr('noProperties')))
      if (d.tileId) this.rows(this.body, [['blockEntity', d.tileId]])
    } else {
      const pairs = []
      if (d.kind === 'mob' || d.health !== null) pairs.push(['health', d.health === null ? tr('unknown') : tr('healthValue', { n: format(d.health), hearts: format(d.health / 2) })])
      if (d.maxHealth !== null) pairs.push(['maxHealth', format(d.maxHealth)])
      if (d.facing) pairs.push(['rotation', tr(d.facing)])
      if (d.rotation) pairs.push(['yaw', format(d.rotation[0]) + '°'], ['pitch', format(d.rotation[1] ?? 0) + '°'])
      if (d.riding) pairs.push(['riding', tr('true')])
      this.rows(this.body, pairs)
      if (d.health !== null && d.maxHealth > 0) {
        const meter = el('meter', 'inspector-meter'); meter.min = 0; meter.max = d.maxHealth; meter.value = d.health
        meter.setAttribute('aria-label', tr('health')); this.body.append(meter)
      }
      if (d.equipment?.length) {
        const equipment = this.section(tr('equipment'))
        for (const [slot, stack] of d.equipment) equipment.append(this.itemButton(stack, Number(stack.count ?? stack.Count ?? 1), tr(slot)))
      }
      if (d.passengers?.length) this.section(tr('passengers')).append(el('p', 'inspector-note', d.passengers.map(p => p.name || this.name(p.id, 'entity')).join(' · ')))
    }
    for (const inventory of d.containers || []) this.renderInventory(inventory)
    for (const text of d.texts || []) this.section(tr(text.side)).append(el('pre', 'inspector-sign-text', text.text.trim() ? text.text : tr('empty')))
    if (d.privateInventory) this.body.append(el('p', 'inspector-note', tr('enderChest')))
    this.itemPane = el('div', 'inspector-item-detail'); this.itemPane.hidden = true; this.body.append(this.itemPane)
    const skip = new Set(['id', 'x', 'y', 'z', 'Health', 'health', 'CustomName', 'custom_name'])
    const fields = Object.entries(d.nbt || {}).filter(([key, value]) => !skip.has(key) && value !== null && typeof value !== 'object')
    if (fields.length) {
      const values = this.section(tr('details'), false)
      this.rows(values, fields.map(([key, value]) => [key, NBT_BOOLEAN.has(key) ? tr(value ? 'true' : 'false') : String(value), key]))
    }
    if (d.nbt) {
      const filtered = this.getData()?.nbtInfo?.bookPageFields > 0
      const section = this.section(tr(filtered ? 'filteredNBT' : 'nbt'), false)
      if (filtered) section.append(el('p', 'inspector-note inspector-nbt-omissions', tr('skippedBooks')))
      this.nbtTree(section, d.nbt)
    }
    else if (d.containers?.length) this.body.append(el('p', 'inspector-note', tr('noNBT')))
    this.icons ||= new MaterialIcons(this.body, this.assets)
    this.icons.observe()
  }

  icon(stack) {
    const icon = el('span', 'material-icon'); icon.dataset.material = shortId(stack.id); icon.setAttribute('aria-hidden', 'true')
    const image = el('img'); image.width = image.height = 32; image.alt = ''; image.hidden = true
    icon.append(el('span', 'inspector-icon-placeholder', '◇'), image)
    return icon
  }

  itemButton(stack, count, label, grid = false) {
    const name = stackName(stack) || this.name(stack.id)
    const button = el('button', grid ? 'inspector-slot' : 'inspector-equipment'); button.type = 'button'
    button.title = `${label} · ${name} × ${count}\n${stack.id}`; button.setAttribute('aria-label', button.title)
    button.append(this.icon(stack), el('span', 'inspector-item-count', format(count)))
    if (!grid) { const text = el('span'); text.append(el('small', null, label), el('span', null, name)); button.append(text) }
    button.onclick = () => {
      this.itemPane.hidden = false; this.itemPane.replaceChildren(el('h3', null, tr('item')), el('p', null, name + ' × ' + count), el('code', null, stack.id))
      if (this.getData()?.nbtInfo?.bookPageFields > 0) this.itemPane.append(el('p', 'inspector-note', tr('skippedBooks')))
      this.nbtTree(this.itemPane, stack)
      this.itemPane.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
    return button
  }

  renderInventory(inventory) {
    const section = this.section(tr(inventory.otherHalf ? 'otherHalf' : 'inventory'))
    if (inventory.otherHalf) section.append(el('p', 'inspector-note', inventory.position.join(', ')))
    if (inventory.lootTable) section.append(el('p', 'inspector-note', tr('loot') + ' · ' + inventory.lootTable))
    if (!inventory.known) { section.append(el('p', 'inspector-note', tr('missingInventory'))); return }
    section.append(el('p', 'inspector-inventory-count', tr(inventory.capacity ? 'occupancy' : 'itemCount', {
      used: inventory.occupied, size: inventory.capacity, count: inventory.total,
    })))
    if (inventory.capacity) {
      const meter = el('meter', 'inspector-meter'); meter.max = inventory.capacity; meter.value = inventory.occupied
      meter.setAttribute('aria-label', tr('inventory')); section.append(meter)
      const grid = el('div', 'inspector-inventory-grid')
      for (let slot = 0; slot < inventory.capacity; slot++) {
        const item = inventory.entries.find(entry => entry.slot === slot), label = tr('slot', { n: slot + 1 })
        const cell = item ? this.itemButton(item.stack, item.count, label, true) : el('span', 'inspector-slot empty')
        cell.title ||= label + ' · ' + tr('empty'); grid.append(cell)
      }
      section.append(grid)
    }
    for (const item of inventory.entries) if (!inventory.capacity || item.slot >= inventory.capacity || item.slot < 0) {
      section.append(this.itemButton(item.stack, item.count, tr('slot', { n: item.slot + 1 })))
    }
  }

  // Expand compounds lazily and page long lists. Opening a chest containing books
  // or nested shulker boxes must not stringify the entire NBT on every click.
  nbtTree(parent, value, depth = 0) {
    if (depth > 64) { parent.append(el('p', 'inspector-note', '…')); return }
    const array = Array.isArray(value) || ArrayBuffer.isView(value)
    const keys = array ? null : Object.keys(value || {}), size = array ? value.length : keys.length
    let offset = 0
    const more = el('button', 'inspector-more', tr('more')); more.type = 'button'
    const page = () => {
      more.remove()
      const end = Math.min(size, offset + 40)
      for (; offset < end; offset++) {
        const key = array ? offset : keys[offset], item = value[key]
        if (item !== null && typeof item === 'object') {
          const details = el('details', 'inspector-nbt'), summary = el('summary')
          const count = Array.isArray(item) || ArrayBuffer.isView(item) ? item.length : Object.keys(item).length
          summary.append(el('code', null, String(key)), el('span', null, tr('entries', { n: count })))
          details.append(summary); parent.append(details)
          details.addEventListener('toggle', () => {
            if (!details.open || details.dataset.loaded) return
            details.dataset.loaded = 'true'; const children = el('div', 'inspector-nbt-children'); details.append(children)
            this.nbtTree(children, item, depth + 1)
          })
        } else {
          const row = el('div', 'inspector-nbt-value'); row.append(el('code', null, String(key)), el('span', null, String(item)))
          parent.append(row)
        }
      }
      if (offset < size) parent.append(more)
    }
    more.onclick = page; page()
  }
}
