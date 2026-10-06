// Minecraft 26.3 Mojang 命名源码中的独立幼年模型。使用 --fetch 更新来源缓存。
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { parseAddChilds, extractConstants, findMethods, stripComments } from './parse-entity-models.mjs'
const root = new URL('./_ref/baby26/', import.meta.url)
const paths = {
  Cow: 'animal/cow', Pig: 'animal/pig', Sheep: 'animal/sheep', Wolf: 'animal/wolf', Chicken: 'animal/chicken',
  Rabbit: 'animal/rabbit', Feline: 'animal/feline', Fox: 'animal/fox', Goat: 'animal/goat', PolarBear: 'animal/polarbear',
  Panda: 'animal/panda', Turtle: 'animal/turtle', Llama: 'animal/llama', Axolotl: 'animal/axolotl', Bee: 'animal/bee',
  Camel: 'animal/camel', Armadillo: 'animal/armadillo', Dolphin: 'animal/dolphin', Horse: 'animal/equine', Donkey: 'animal/equine',
  Zombie: 'monster/zombie', ZombieVillager: 'monster/zombie', Piglin: 'monster/piglin', Hoglin: 'monster/hoglin', Strider: 'monster/strider', Villager: 'npc',
  Squid: 'animal/squid',
}
const sources = {}, models = {}
await mkdir(root, { recursive: true })
for (const [key, path] of Object.entries(paths)) {
  const name = 'Baby' + key + 'Model', file = new URL(name + '.java', root)
  const url = `https://mc-packet-reference.netlify.app/26.x/source/net/minecraft/client/model/${path}/${name.toLowerCase()}/`
  if (process.argv.includes('--fetch')) {
    const response = await fetch(url)
    if (!response.ok) throw Error(url)
    const html = await response.text()
    const source = [...html.matchAll(/<td class="cv-code"><pre><code>([\s\S]*?)<\/code>/g)].map(m => m[1]
      .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&')).join('\n')
    if (!source.includes('class ' + name)) throw Error('缺失源码：' + name)
    await writeFile(file, source)
  }
  const source = await readFile(file, 'utf8')
  sources[key] = { url, sha256: createHash('sha256').update(source).digest('hex') }
  const converted = stripComments(source).replaceAll('LayerDefinition.create', 'TexturedModelData.of')
    .replaceAll('LayerDefinition', 'TexturedModelData').replaceAll('MeshDefinition', 'ModelData').replaceAll('PartDefinition', 'ModelPartData')
    .replaceAll('CubeListBuilder', 'ModelPartBuilder').replaceAll('CubeDeformation', 'Dilation')
    .replaceAll('PartPose.offsetAndRotation', 'ModelTransform.of').replaceAll('PartPose.offset', 'ModelTransform.origin')
    .replaceAll('PartPose.rotation', 'ModelTransform.rotation').replaceAll('PartPose.ZERO', 'ModelTransform.NONE')
    .replaceAll('.addOrReplaceChild(', '.addChild(').replaceAll('.texOffs(', '.uv(').replaceAll('.addBox(', '.cuboid(').replaceAll('.mirror(', '.mirrored(')
    .replace(/\bpartdefinition\b/g, 'modelPartData')
  const methods = findMethods(converted), method = methods.createBodyLayer || methods.createBabyLayer || methods.createBabyMesh || methods.createBodyModel
  if (!method) throw Error('未找到构建方法：' + name)
  let code = method
  // 村民有帽模型在无帽基础上补部件。
  if (key === 'Villager') code = methods.createNoHatModel + '\n' + code
  const parts = parseAddChilds(code, extractConstants(converted))
  if (key === 'Squid') {
    delete parts['createTentacleName(i)']
    for (let i = 0; i < 8; i++) parts['tentacle' + i] = { pivot: [Math.cos(i * Math.PI / 4) * 3, 18.5, Math.sin(i * Math.PI / 4) * 3], rot: [0, -i * Math.PI / 4 + Math.PI / 2, 0],
      cuboids: [{ u: 0, v: 18, x: -1, y: -.5, z: -1, dx: 2, dy: 6, dz: 2 }], children: {} }
  }
  const dimensions = source.match(/LayerDefinition\.create\([^,]+,\s*(\d+),\s*(\d+)\)/)
  const w = dimensions ? +dimensions[1] : 64, h = dimensions ? +dimensions[2] : 64
  const count = nodes => Object.values(nodes).reduce((n, p) => n + p.cuboids.length + count(p.children), 0)
  if (!count(parts)) throw Error('空模型：' + name)
  const scale = source.match(/\.apply\(MeshTransformer\.scaling\(([.\d]+)F\)\)/)
  models[key] = { w, h, parts, ...(scale ? { scale: +scale[1] } : {}) }
  console.log(name, w, h, count(parts), Object.keys(parts).join(','))
}
await writeFile(new URL('../src/babyEntityModels.js', import.meta.url), '// 由 scripts/gen-baby-models.mjs 从 Minecraft 26.3 独立幼年模型生成。\n'
  + `export const BABY_MODEL_SOURCES = ${JSON.stringify(sources)}\nexport const BABY_MODELS = ${JSON.stringify(models)}\n`)
