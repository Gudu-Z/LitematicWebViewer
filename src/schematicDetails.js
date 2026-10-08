// Shared by the full viewer and embedded cards. Keep block entity interpretation identical.

// 从方块实体中提取玩家头颅：{x, y, z, rotation?, facing?, skinUrl}
export function extractPlayerHeads(tileEntities, data) {
  const heads = []
  const b = data.bounds
  for (const te of tileEntities || []) {
    if (te.id !== 'minecraft:skull') continue
    const gi = data.blocks.get((te.x - b.minX) + (te.z - b.minZ) * b.width + (te.y - b.minY) * (b.width * b.depth))
    if (gi === undefined) continue
    const p = data.palette[gi]
    const name = (p.name || '').replace(/^minecraft:/, '')
    if (name !== 'player_head' && name !== 'player_wall_head') continue
    const skinUrl = extractSkinUrl(te.nbt?.profile)
    // skinUrl 为 null 时（占位头颅/无皮肤信息）渲染器回退到默认 Steve 皮肤
    heads.push({ x: te.x, y: te.y, z: te.z, rotation: p.properties?.rotation, facing: p.properties?.facing, skinUrl })
  }
  return heads
}

// 从头颅 profile 里解出皮肤 URL（properties 里的 textures 项是 base64 编码的 JSON）
function extractSkinUrl(profile) {
  if (!profile) return null
  for (const prop of profile.properties || []) {
    if (prop.name !== 'textures' || !prop.value) continue
    try {
      const binary = atob(prop.value)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const obj = JSON.parse(new TextDecoder().decode(bytes))
      return obj?.textures?.SKIN?.url || null
    } catch {
      return null
    }
  }
  return null
}

// 从方块实体中提取告示牌：{x, y, z, rotation, lines}
export function extractSigns(tileEntities, data) {
  const signs = []
  for (const te of tileEntities || []) {
    if (te.id !== 'minecraft:sign' && te.id !== 'minecraft:hanging_sign') continue
    const lines = []
    const ft = te.nbt && te.nbt.front_text
    if (ft && Array.isArray(ft.messages)) {
      for (const m of ft.messages) lines.push(textComponentToString(m))
    } else {
      // 旧格式：Text1..Text4
      for (let i = 1; i <= 4; i++) lines.push(textComponentToString(te.nbt && te.nbt['Text' + i]))
    }
    if (lines.every((l) => !l)) continue
    const b = data.bounds
    const gi = data.blocks.get((te.x - b.minX) + (te.z - b.minZ) * b.width + (te.y - b.minY) * (b.width * b.depth))
    const props = gi !== undefined ? data.palette[gi].properties || {} : {}
    // 立地告示牌用 rotation，墙上告示牌用 facing；挂告示牌单独标记（板在下方）
    signs.push({
      x: te.x, y: te.y, z: te.z,
      rotation: Number(props.rotation) || 0,
      facing: props.facing,
      hanging: te.id === 'minecraft:hanging_sign',
      color: (ft && ft.color) || null,
      lines,
    })
  }
  return signs
}

// 从方块实体中提取旗帜：{x, y, z, rotation?, facing?, baseColor, patterns: [{pattern, color}]}
export function extractBanners(tileEntities, data) {
  const banners = []
  const b = data.bounds
  for (const te of tileEntities || []) {
    if (te.id !== 'minecraft:banner') continue
    const gi = data.blocks.get((te.x - b.minX) + (te.z - b.minZ) * b.width + (te.y - b.minY) * (b.width * b.depth))
    if (gi === undefined) continue
    const p = data.palette[gi]
    const name = (p.name || '').replace(/^minecraft:/, '')
    // 底色从方块名推断（red_banner / blue_wall_banner）
    const baseColor = name.replace(/_wall_banner$/, '').replace(/_banner$/, '')
    const patterns = (te.nbt?.patterns || []).map((pt) => ({ pattern: pt.pattern, color: pt.color }))
    banners.push({
      x: te.x, y: te.y, z: te.z,
      rotation: p.properties?.rotation,
      facing: p.properties?.facing,
      baseColor,
      patterns,
    })
  }
  return banners
}

// 从方块中提取铜傀儡雕像：{x, y, z, facing, texKey}
export function extractStatues(data) {
  const statues = []
  const b = data.bounds
  const W = b.width
  const strideY = W * b.depth
  for (const [key, gi] of data.blocks) {
    const p = data.palette[gi]
    const name = (p.name || '').replace(/^minecraft:/, '')
    if (!name.endsWith('copper_golem_statue')) continue
    const lx = key % W
    const lz = Math.floor(key / W) % b.depth
    const ly = Math.floor(key / strideY)
    const tex = 'entity/copper_golem/copper_golem' + (name.includes('exposed') ? '_exposed' : name.includes('weathered') ? '_weathered' : name.includes('oxidized') ? '_oxidized' : '')
    statues.push({ x: lx + b.minX, y: ly + b.minY, z: lz + b.minZ, facing: p.properties?.facing, pose: p.properties?.copper_golem_pose, texKey: tex })
  }
  return statues
}

// 从方块实体中提取装饰罐：{x, y, z, facing, sherds: {front, back, left, right}}，sherds 各项为陶片物品 ID 或 null
export function extractDecoratedPots(tileEntities, data) {
  const pots = []
  const b = data.bounds
  for (const te of tileEntities || []) {
    if (te.id !== 'minecraft:decorated_pot') continue
    const gi = data.blocks.get((te.x - b.minX) + (te.z - b.minZ) * b.width + (te.y - b.minY) * (b.width * b.depth))
    const props = gi !== undefined ? data.palette[gi].properties || {} : {}
    pots.push({ x: te.x, y: te.y, z: te.z, facing: props.facing, sherds: parsePotSherds(te.nbt?.sherds) })
  }
  return pots
}

// 解析装饰罐的 sherds NBT：兼容 1.20 的列表格式与 1.21 的映射格式。
// 列表顺序为 [back, left, right, front]（与原版 PotDecorations 记录字段顺序一致）。
function parsePotSherds(sherds) {
  const out = { front: null, back: null, left: null, right: null }
  if (!sherds) return out
  if (Array.isArray(sherds)) {
    const order = ['back', 'left', 'right', 'front']
    for (let i = 0; i < order.length && i < sherds.length; i++) out[order[i]] = sherdIdOf(sherds[i])
    return out
  }
  if (typeof sherds === 'object') {
    for (const k of Object.keys(out)) out[k] = sherdIdOf(sherds[k])
    return out
  }
  return out
}

// 从 sherd 条目（字符串 ID 或物品栈对象）解出物品 ID
function sherdIdOf(entry) {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object') return entry.id || null
  return null
}

// 把 JSON 文本组件转成纯文本（简化处理）
function textComponentToString(c) {
  if (c == null) return ''
  if (typeof c === 'string') {
    // litematic 常把文本组件 JSON 序列化后存进 NBT 字符串：
    //   "所有发射器预填1空盒"（带引号的裸字符串）或 {"text":"...","extra":[...]}
    const s = c.trim()
    if (s.startsWith('"') || s.startsWith('{')) {
      try { return textComponentToString(JSON.parse(s)) } catch { return c }
    }
    return c
  }
  if (typeof c === 'object') {
    if (typeof c.text === 'string') return c.text
    if (Array.isArray(c.extra)) return c.extra.map(textComponentToString).join('')
    if (typeof c.translate === 'string') return c.translate
  }
  return ''
}
