// Minecraft 26.3 model definitions; --fetch refreshes the decompiled source cache.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { parseAddChilds, extractConstants, findMethods, stripComments } from './parse-entity-models.mjs'
import { parseAnimation } from './gen-entity-animations.mjs'

const root = new URL('./_ref/coverage26/', import.meta.url)
const paths = {
  NautilusModel: 'model/animal/nautilus', ZombieNautilusCoralModel: 'model/monster/nautilus',
  NautilusArmorModel: 'model/animal/nautilus', NautilusSaddleModel: 'model/animal/nautilus',
  SulfurCubeModel: 'model/monster/slime', SmallSulfurCubeModel: 'model/monster/slime',
  CopperGolemModel: 'model/animal/golem', NautilusAnimation: 'animation/definitions',
  SkeletonModel: 'model/monster/skeleton',
}
const sources = {}, methods = {}, constants = {}
await mkdir(root, { recursive: true })
for (const [name, path] of Object.entries(paths)) {
  const file = new URL(name + '.java', root)
  const url = `https://mc-packet-reference.netlify.app/26.x/source/net/minecraft/client/${path}/${name.toLowerCase()}/`
  if (process.argv.includes('--fetch')) {
    const response = await fetch(url), html = await response.text()
    const source = [...html.matchAll(/<td class="cv-code"><pre><code>([\s\S]*?)<\/code>/g)].map(m => m[1]
      .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&')).join('\n')
    if (!response.ok || !source.includes('class ' + name)) throw Error('Missing source: ' + url)
    await writeFile(file, source)
  }
  const source = await readFile(file, 'utf8')
  sources[name] = { url, sha256: createHash('sha256').update(source).digest('hex') }
  const converted = stripComments(source).replaceAll('LayerDefinition.create', 'TexturedModelData.of')
    .replaceAll('LayerDefinition', 'TexturedModelData').replaceAll('MeshDefinition', 'ModelData').replaceAll('PartDefinition', 'ModelPartData')
    .replaceAll('CubeListBuilder', 'ModelPartBuilder').replaceAll('CubeDeformation', 'Dilation')
    .replaceAll('PartPose.offsetAndRotation', 'ModelTransform.of').replaceAll('PartPose.offset', 'ModelTransform.origin')
    .replaceAll('PartPose.rotation', 'ModelTransform.rotation').replaceAll('PartPose.ZERO', 'ModelTransform.NONE')
    .replaceAll('.addOrReplaceChild(', '.addChild(').replaceAll('.texOffs(', '.uv(').replaceAll('.addBox(', '.cuboid(').replaceAll('.mirror(', '.mirrored(')
    .replace(/\bpartdefinition\b/g, 'modelPartData')
  methods[name] = findMethods(converted)
  constants[name] = extractConstants(converted)
}
const models = {}
function model(key, source, method, w, h, adjust = () => {}) {
  const code = methods[source][method]
  if (!code) throw Error(`${source}.${method} missing`)
  const parts = parseAddChilds(code, constants[source])
  adjust(parts)
  models[key] = { w, h, parts }
  return models[key]
}
model('NautilusModel', 'NautilusModel', 'createBodyMesh', 128, 128)
model('BabyNautilusModel', 'NautilusModel', 'createBabyBodyLayer', 64, 64)
model('ParchedModel', 'SkeletonModel', 'createSingleModelDualBodyLayer', 64, 64)
for (const [name, method] of [['NautilusArmorModel', 'createBodyLayer'], ['NautilusSaddleModel', 'createSaddleLayer']]) model(name, name, method, 128, 128)
// The coral layer starts at an inherited shell, not at the mesh root.
const coralCode = methods.ZombieNautilusCoralModel.createBodyLayer.replace(/mesh\.getRoot\(\)\s*\.getChild\("root"\)\s*\.getChild\("shell"\)\s*/, 'modelPartData')
models.ZombieNautilusCoralModel = structuredClone(models.NautilusModel)
models.ZombieNautilusCoralModel.parts.root.children.shell.children = parseAddChilds(coralCode, constants.ZombieNautilusCoralModel)
if (Object.keys(models.ZombieNautilusCoralModel.parts.root.children.shell.children.corals?.children || {}).length !== 4) throw Error('Coral hierarchy was not parsed')
for (const small of [false, true]) for (const layer of ['Outer', 'Inner']) {
  const source = small ? 'SmallSulfurCubeModel' : 'SulfurCubeModel'
  model(`${source}${layer}`, source, `create${layer}BodyLayer`, small ? 64 : 128, small ? 64 : 128, parts => {
    // Convert SulfurCubeRenderer's model-origin translation to the shared y=24 convention.
    const center = 1.501 - (small ? 1.24 : .98) + 1 / 16
    parts.cube.pivot[1] += 24 - center * 16
  })
}
for (const [pose, method] of Object.entries({ standing: 'createBodyLayer', running: 'createRunningPoseBodyLayer', sitting: 'createSittingPoseBodyLayer', star: 'createStarPoseBodyLayer' })) {
  model('CopperStatue_' + pose, 'CopperGolemModel', method, 64, 64, parts => {
    // Statue renderer cancels the entity root's +24 translation; compileModel restores it here.
    for (const part of Object.values(parts)) part.pivot[1] += 24
  })
}
const animationSource = (await readFile(new URL('NautilusAnimation.java', root), 'utf8'))
  .replaceAll('Builder.withLength', 'Builder.create').replaceAll('.addAnimation(', '.addBoneAnimation(')
  .replaceAll('Targets.ROTATION', 'Targets.ROTATE').replaceAll('Targets.POSITION', 'Targets.MOVE_ORIGIN')
  .replaceAll('KeyframeAnimations.degreeVec', 'AnimationHelper.createRotationalVector')
  .replaceAll('KeyframeAnimations.posVec', 'AnimationHelper.createTranslationalVector')
  .replaceAll('KeyframeAnimations.scaleVec', 'AnimationHelper.createScalingVector')
const animations = { 'Nautilus.SWIMMING': parseAnimation(animationSource, 'SWIMMING') }
for (const [key, value] of Object.entries(models)) {
  const count = parts => Object.values(parts).reduce((n, part) => n + part.cuboids.length + count(part.children), 0)
  if (!count(value.parts)) throw Error('Empty model: ' + key)
  console.log(key, count(value.parts))
}
await writeFile(new URL('../src/releaseModelData.js', import.meta.url),
  '// Generated by scripts/gen-release-models.mjs from Minecraft 26.3 model definitions.\n'
  + `export const RELEASE_MODEL_SOURCES = ${JSON.stringify(sources)}\n`
  + `export const RELEASE_MODELS = ${JSON.stringify(models)}\n`
  + `export const RELEASE_ANIMATIONS = ${JSON.stringify(animations)}\n`)
