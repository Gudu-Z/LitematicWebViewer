// Minecraft 26.3 装备模型与默认物品组件。--fetch 更新可核对的原版源码缓存。
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { parseAddChilds, findMethods, extractConstants, stripComments } from './parse-entity-models.mjs'
const root = new URL('./_ref/equipment26/', import.meta.url)
const paths = {
  TridentModel: 'client/model/object/projectile/tridentmodel',
  SkullModel: 'client/model/object/skull/skullmodel', DragonHeadModel: 'client/model/object/skull/dragonheadmodel',
  AbstractPiglinModel: 'client/model/monster/piglin/abstractpiglinmodel',
  HumanoidModel: 'client/model/humanoidmodel', ArmorStandModel: 'client/model/object/armorstand/armorstandmodel',
  ArmorStandArmorModel: 'client/model/object/armorstand/armorstandarmormodel', ZombieVillagerModel: 'client/model/monster/zombie/zombievillagermodel',
  ElytraModel: 'client/model/object/equipment/elytramodel', AbstractEquineModel: 'client/model/animal/equine/abstractequinemodel',
  EquineSaddleModel: 'client/model/animal/equine/equinesaddlemodel', CamelSaddleModel: 'client/model/animal/camel/camelsaddlemodel',
  HappyGhastHarnessModel: 'client/model/animal/ghast/happyghastharnessmodel',
  AdultWolfModel: 'client/model/animal/wolf/adultwolfmodel', LlamaModel: 'client/model/animal/llama/llamamodel',
}
const sources = {}, code = {}
await mkdir(root, { recursive: true })
for (const [name, path] of Object.entries(paths)) {
  const url = 'https://mc-packet-reference.netlify.app/26.x/source/net/minecraft/' + path + '/'
  const file = new URL(name + '.java', root)
  if (process.argv.includes('--fetch')) {
    const response = await fetch(url); if (!response.ok) throw Error(url)
    const html = await response.text()
    const source = [...html.matchAll(/<td class="cv-code"><pre><code>([\s\S]*?)<\/code>/g)].map(m => m[1]
      .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&')).join('\n')
    if (!source.includes('class ' + name)) throw Error('Missing source: ' + name)
    await writeFile(file, source)
  }
  const source = await readFile(file, 'utf8')
  sources[name] = { url, sha256: createHash('sha256').update(source).digest('hex') }
  code[name] = stripComments(source).replaceAll('LayerDefinition.create', 'TexturedModelData.of')
    .replaceAll('LayerDefinition', 'TexturedModelData').replaceAll('MeshDefinition', 'ModelData').replaceAll('PartDefinition', 'ModelPartData')
    .replaceAll('CubeListBuilder', 'ModelPartBuilder').replaceAll('CubeDeformation', 'Dilation')
    .replaceAll('PartPose.offsetAndRotation', 'ModelTransform.of').replaceAll('PartPose.offset', 'ModelTransform.origin')
    .replaceAll('PartPose.rotation', 'ModelTransform.rotation').replaceAll('PartPose.ZERO', 'ModelTransform.NONE')
    .replaceAll('.addOrReplaceChild(', '.addChild(').replaceAll('.texOffs(', '.uv(').replaceAll('.addBox(', '.cuboid(').replaceAll('.mirror(', '.mirrored(')
    .replace(/\bpartdefinition\b/g, 'root')
}
const methods = Object.fromEntries(Object.entries(code).map(([key, text]) => [key, findMethods(text)]))
const model = (source, body, w, h, dilation = [0, 0, 0], offsets = [0, 0, 0]) => {
  const d = n => 'new Dilation(' + dilation.map(v => v + n).join(',') + ')'
  let text = body.replace(/g\.extend\(([-.\d]+)F\)/g, (_, n) => d(+n)).replace(/\bg\b/g, d(0))
    .replace(/armOffset\.([xyz])\(\)/g, (_, axis) => String(offsets['xyz'.indexOf(axis)]))
    .replace(/\byOffset\b/g, '0')
  for (const m of text.matchAll(/Dilation\s+(\w+)\s*=\s*(new Dilation\([^;]+\));/g)) text = text.replace(new RegExp('\\b' + m[1] + '\\b', 'g'), m[2])
  const parts = parseAddChilds(text, extractConstants(code[source]))
  if (!Object.keys(parts).length) throw Error('Empty model: ' + source)
  return { w, h, parts }
}
const models = {}
models.Trident = model('TridentModel', methods.TridentModel.createLayer, 32, 32)
models.Skull = model('SkullModel', methods.SkullModel.createHeadModel, 64, 32)
models.HumanoidHead = model('SkullModel', methods.SkullModel.createHeadModel.replace('root.addChild', 'ModelPartData head = root.addChild') + '\n' + methods.SkullModel.createHumanoidHeadLayer.replace(/root.getChild\("head"\)\s*\./, 'head.'), 64, 64)
models.PiglinHead = model('AbstractPiglinModel', methods.AbstractPiglinModel.addHead, 64, 64)
models.DragonHead = model('DragonHeadModel', methods.DragonHeadModel.createHeadLayer, 256, 256)
for (const [suffix, amount] of [['inner', .5], ['outer', 1]]) {
  for (const [name, extra] of [['Humanoid', methods.HumanoidModel.createBaseArmorMesh], ['ArmorStand', methods.ArmorStandArmorModel.createBaseMesh], ['ZombieVillager', methods.ZombieVillagerModel.createBaseArmorMesh]]) {
    models[name + '_' + suffix] = model('HumanoidModel', methods.HumanoidModel.createMesh + '\n' + extra, 64, 32, [amount, amount, amount])
  }
  models['Piglin_' + suffix] = model('HumanoidModel', methods.HumanoidModel.createMesh + '\n' + methods.HumanoidModel.createBaseArmorMesh, 64, 32, [amount, amount, amount].map(n => suffix === 'outer' ? 1.02 : n))
  models['Baby_' + suffix] = model('HumanoidModel', methods.HumanoidModel.createBabyArmorMesh, 64, 64, [-.1, suffix === 'outer' ? .5 : .3, .3])
  models['BabyPiglin_' + suffix] = model('HumanoidModel', methods.HumanoidModel.createBabyArmorMesh, 64, 64, [.7, .7, .7], [.5, -.5, 0])
}
models.ArmorStand = model('ArmorStandModel', methods.HumanoidModel.createMesh + '\n' + methods.ArmorStandModel.createBodyLayer, 64, 64)
models.Elytra = model('ElytraModel', methods.ElytraModel.createLayer, 64, 32)
models.HorseArmor = model('AbstractEquineModel', methods.AbstractEquineModel.createBodyMesh, 64, 64, [.1, .1, .1])
// 鞍具保留专用部件；沿用主体的父节点坐标，将 getChild 引用显式转成模型根。
models.HorseSaddle = model('EquineSaddleModel', methods.EquineSaddleModel.createSaddleLayer.replace(/\b(body|headParts)\.addChild/g, 'root.addChild'), 64, 64)
models.CamelSaddle = model('CamelSaddleModel', methods.CamelSaddleModel.createSaddleLayer.replace(/\b(body|head)\.addChild/g, 'root.addChild'), 128, 128)
models.Harness = model('HappyGhastHarnessModel', methods.HappyGhastHarnessModel.createHarnessLayer, 64, 64)
models.WolfArmor = model('AdultWolfModel', methods.AdultWolfModel.createBodyLayer, 64, 32, [.2, .2, .2])
models.LlamaDecor = model('LlamaModel', methods.LlamaModel.createBodyLayer, 128, 64, [.5, .5, .5])
const itemUrl = 'https://raw.githubusercontent.com/misode/mcmeta/26.3-summary/item_components/data.json'
const itemFile = new URL('item_components.json', root)
if (process.argv.includes('--fetch')) { const r = await fetch(itemUrl); if (!r.ok) throw Error(itemUrl); await writeFile(itemFile, await r.text()) }
const items = JSON.parse(await readFile(itemFile, 'utf8'))
const equipment = Object.fromEntries(Object.entries(items).filter(([, v]) => v['minecraft:equippable']).map(([id, v]) => [id, {
  equippable: v['minecraft:equippable'], ...(v['minecraft:max_damage'] ? { maxDamage: v['minecraft:max_damage'] } : {}),
}]))
await writeFile(new URL('../src/equipmentModelData.js', import.meta.url), '// Minecraft 26.3；由 scripts/gen-equipment-data.mjs 生成。\n'
  + `export const EQUIPMENT_MODEL_SOURCES = ${JSON.stringify(sources)}\nexport const EQUIPMENT_MODELS = ${JSON.stringify(models)}\n`)
await writeFile(new URL('../src/equipmentItemData.js', import.meta.url), `// Minecraft 26.3 官方物品组件报告：${itemUrl}\nexport const EQUIPMENT_ITEMS = ${JSON.stringify(equipment)}\n`)
console.log(`Generated ${Object.keys(models).length} equipment models and ${Object.keys(equipment).length} equippable items`)
