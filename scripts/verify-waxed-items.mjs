// node scripts/verify-waxed-items.mjs — 使用内置 XK 包和默认资源验证展示框物品。
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import JSZip from 'jszip'
import * as THREE from 'three'
import { AssetProvider } from '../src/assets.js'
import { buildEntityMesh } from '../src/entities.js'

const root = 'public/assets/minecraft/'
const pack = await JSZip.loadAsync(readFileSync('resourcepacks/XK redstone display 26.3.0.zip'))
const assets = new AssetProvider()
assets.baseUrl = 'https://assets.test/'
const originalFetch = globalThis.fetch
// 保留生产代码的资源包优先级、JSON 解析和缓存，仅替换网络与浏览器图片解码。
globalThis.fetch = async url => {
  assert.ok(String(url).startsWith(assets.baseUrl), '测试不得访问网络')
  const file = root + String(url).slice(assets.baseUrl.length)
  return existsSync(file) ? new Response(readFileSync(file)) : new Response(null, { status: 404 })
}
assets._getTexture = async key => {
  const path = 'textures/' + key + '.png'
  const entry = assets.packs.map(p => p.zip.file('assets/minecraft/' + path)).find(Boolean)
  const png = entry ? await entry.async('nodebuffer') : readFileSync(root + path)
  const texture = new THREE.Texture()
  texture.name = key
  texture.image = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
  return texture
}
const meshes = group => {
  const result = []
  group.traverse(o => { if (o.isMesh) result.push(o) })
  return result
}
const dispose = group => meshes(group).forEach(mesh => { mesh.geometry.dispose(); mesh.material.dispose() })
const buildItem = async (name, facing = 3, rotation = 0) => {
  const frame = await buildEntityMesh({
    id: 'minecraft:item_frame', pos: [7, 11, -3], rotation: [0, 0],
    nbt: { Facing: facing, ItemRotation: rotation, Item: { id: 'minecraft:' + name, count: 1 } },
  }, assets)
  assert.equal(frame.children.length, 2, name + ' 应同时生成框体与物品')
  frame.updateMatrixWorld(true)
  return frame
}
const wax = 'block/waxed_block'
const firstTexture = (holder, origin, direction) => {
  const ray = new THREE.Raycaster(
    holder.localToWorld(new THREE.Vector3(...origin)),
    new THREE.Vector3(...direction).transformDirection(holder.matrixWorld),
  )
  return ray.intersectObject(holder, true)[0]?.object.material.map.name
}

try {
  assets.addPack(pack, 'XK')
  const names = Object.keys(pack.files).filter(p => /^assets\/minecraft\/items\/waxed.*\.json$/.test(p))
    .map(p => p.split('/').at(-1).slice(0, -5))
  assert.equal(names.length, 60, '内置 XK 涂蜡物品覆盖数')
  let outlined = 0, sprites = 0
  for (const name of names) {
    const frame = await buildItem(name)
    const item = frame.children[1], parts = meshes(item)
    assert.ok(parts.length, name + ' 不能缺少物品网格')
    if (/_(bars|door|chain|lantern)$/.test(name)) {
      // 这些物品的黄色边框直接画在贴图里，仍需保持平面物品的双面显示。
      assert.ok(parts.every(p => p.material.side === THREE.DoubleSide), name)
      assert.ok(parts.some(p => p.material.map.name === 'item/' + name), name)
      sprites++
    } else {
      const shells = parts.filter(p => p.material.map.name === wax)
      assert.ok(shells.length, name + ' 应加载资源包的反向描边外壳')
      assert.ok(parts.some(p => p.material.map.name !== wax), name + ' 应包含铜制品本体')
      assert.ok(parts.every(p => p.material.side === THREE.FrontSide), name + ' 应按原版剔除背面')
      assert.ok(shells.every(p => p.material.isMeshBasicMaterial), name + ' shade=false 不能受方向光压暗')
      if (name.endsWith('golem_statue')) {
        assert.ok(parts.some(p => p.material.map.name.startsWith('block/special/')), name + ' 应优先使用包内雕像模型')
      }
      outlined++
    }
    dispose(frame)
  }

  // 射线检查可见表面：从六个方向看，正中应看到铜，边缘应看到黄色轮廓。
  // 同时覆盖展示框六种朝向与八种物品旋转，避免只检查材质标志而漏掉绕序错误。
  for (let facing = 0; facing < 6; facing++) for (let rotation = 0; rotation < 8; rotation++) {
    const frame = await buildItem('waxed_copper_block', facing, rotation), item = frame.children[1]
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
      const origin = [0, 0, 0], direction = [0, 0, 0]
      origin[axis] = sign * 2; direction[axis] = -sign
      assert.equal(firstTexture(item, origin, direction), 'block/copper_block', '外壳不能挡住铜表面')
      origin[(axis + 1) % 3] = 0.53
      assert.equal(firstTexture(item, origin, direction), wax, '外轮廓不能因剔除而消失')
    }
    dispose(frame)
  }

  // 四个切制铜模型有完整根对象后的多余 }，需像原版 JsonHelper 的 adapter 一样读取首个对象。
  for (const oxidation of ['', 'exposed_', 'weathered_', 'oxidized_']) {
    const path = 'models/item/waxed_' + oxidation + 'cut_copper.json'
    const raw = await pack.file('assets/minecraft/' + path).async('string')
    assert.throws(() => JSON.parse(raw), SyntaxError)
    const model = await assets.getJSON(path)
    assert.equal(model.parent, 'minecraft:item/template_waxed_block')
    assert.equal(model.textures.side, 'block/' + oxidation + 'cut_copper')
  }

  // 卸载包必须回到原版资源：普通方块无轮廓，雕像仍走特殊实体渲染器。
  assets.removePack('XK')
  for (const name of ['waxed_copper_block', 'waxed_cut_copper', 'waxed_copper_golem_statue', 'waxed_oxidized_copper_golem_statue']) {
    const frame = await buildItem(name), parts = meshes(frame.children[1])
    assert.ok(parts.length && parts.every(p => p.material.map.name !== wax), name)
    if (name.endsWith('golem_statue')) assert.ok(parts.some(p => p.material.map.name.startsWith('entity/copper_golem/')), name)
    dispose(frame)
  }
  // 普通方块和透明方块保留外表面；平面物品仍可从两侧看见。
  for (const name of ['stone', 'glass', 'oak_sapling', 'iron_sword']) {
    const frame = await buildItem(name), item = frame.children[1]
    for (const sign of [-1, 1]) assert.ok(firstTexture(item, [0, 0, sign * 2], [0, 0, -sign]), name)
    dispose(frame)
  }
  assets.addPack(pack, 'XK')
  const reloaded = await buildItem('waxed_cut_copper')
  assert.ok(meshes(reloaded.children[1]).some(p => p.material.map.name === wax), '重新加载不能保留原版模型缓存')
  dispose(reloaded)

  // 兼容读取仅限模型根对象之后；正文语法错误仍应退回低优先级包，普通 JSON 仍严格解析。
  const lower = new JSZip(), upper = new JSZip()
  const add = (zip, path, body) => zip.file('assets/minecraft/' + path, body)
  const escaped = { parent: 'block/block', credit: 'braces { } and a quote " and slash \\', nested: [{ a: 1 }] }
  add(upper, 'models/item/parser.json', '\uFEFF' + JSON.stringify(escaped) + '} trailing data')
  add(lower, 'models/item/broken.json', '{"parent":"block/stone"}')
  add(upper, 'models/item/broken.json', '{"parent": invalid }')
  add(lower, 'models/item/truncated.json', '{"parent":"block/stone"}')
  add(upper, 'models/item/truncated.json', '{"parent":"block/dirt"')
  add(lower, 'items/parser.json', '{"valid":true}')
  add(upper, 'items/parser.json', '{"valid":false}}')
  assets.clearPacks(); assets.addPack(upper, 'upper'); assets.addPack(lower, 'lower')
  assert.deepEqual(await assets.getJSON('models/item/parser.json'), escaped)
  assert.deepEqual(await assets.getJSON('models/item/broken.json'), { parent: 'block/stone' })
  assert.deepEqual(await assets.getJSON('models/item/truncated.json'), { parent: 'block/stone' })
  assert.deepEqual(await assets.getJSON('items/parser.json'), { valid: true })
  console.log(`通过：${outlined} 种描边模型、${sprites} 种平面物品、48 种展示框朝向/旋转、原版回退及模型解析。`)
} finally {
  globalThis.fetch = originalFetch
}
