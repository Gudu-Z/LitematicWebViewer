// 方块实体的模型和持续动画，与主预览器/检查页共用。
import * as THREE from 'three'
import { createEntityRig } from './entityModel.js'

const cuboid = (u, v, x, y, z, dx, dy, dz) => ({ u, v, x, y, z, dx, dy, dz })
const part = (cuboids, pivot = [0, 0, 0], rot = [0, 0, 0]) => ({ cuboids, pivot, rot, children: {} })
export const BELL_MODEL = { w: 32, h: 32, parts: { bell_body: {
  ...part([cuboid(0, 0, -3, -6, -3, 6, 7, 6)], [8, 12, 8]),
  children: { bell_base: part([cuboid(0, 13, 4, 4, 4, 8, 2, 8)], [-8, -12, -8]) },
} } }
const BOOK_MODEL = { w: 64, h: 32, parts: {
  left_lid: part([cuboid(0, 0, -6, -5, -.005, 6, 10, .005)], [0, 0, -1]),
  right_lid: part([cuboid(16, 0, 0, -5, -.005, 6, 10, .005)], [0, 0, 1]),
  seam: part([cuboid(12, 0, -1, -5, 0, 2, 10, .005)], [0, 0, 0], [0, Math.PI / 2, 0]),
  left_pages: part([cuboid(0, 10, 0, -4, -.99, 5, 8, 1)]), right_pages: part([cuboid(12, 10, 0, -4, -.01, 5, 8, 1)]),
  flip_page1: part([cuboid(24, 10, 0, -4, 0, 5, 8, .005)]), flip_page2: part([cuboid(24, 10, 0, -4, 0, 5, 8, .005)]),
} }

export function animateObject(mesh, update) {
  const start = performance.now()
  mesh.userData.updateAnimation = update
  update(0)
  mesh.onBeforeRender = (_renderer, _scene, camera) => {
    update(mesh.userData.animationAge ?? (performance.now() - start) / 50, camera)
    mesh.updateWorldMatrix(true, true)
    mesh.skeleton?.update()
  }
}

// 将实体工具的 (x,24-y,-z)/16 还原为方块实体使用的 (x,y,z)/16。
async function blockRig(model, key, assets) {
  const map = await assets.getTexture(key)
  if (!map) return null
  const rig = createEntityRig(model, new THREE.MeshLambertMaterial({ map, alphaTest: .1, side: THREE.DoubleSide }))
  rig.scale.set(1, -1, -1); rig.position.y = 1.5
  return rig
}
export async function buildBlockEffect(id, properties, assets) {
  const root = new THREE.Group()
  root.name = id + '-effect'
  if (id === 'bell') {
    const rig = await blockRig(BELL_MODEL, 'entity/bell/bell_body', assets)
    if (!rig) return root
    root.add(rig)
    animateObject(rig, age => {
      const ticks = age % 80, angle = properties.preview_ringing === 'true' && ticks < 50 ? Math.sin(ticks / Math.PI) / (4 + ticks / 3) : 0
      const side = properties.facing || 'south', bone = rig.userData.parts.bell_body
      bone.rotation.x = side === 'north' ? -angle : side === 'south' ? angle : 0
      bone.rotation.z = side === 'east' ? -angle : side === 'west' ? angle : 0
    })
  }
  if (id === 'enchanting_table') {
    const rig = await blockRig(BOOK_MODEL, 'entity/enchantment/enchanting_table_book', assets)
    if (!rig) return root
    const pivot = new THREE.Group(), turn = new THREE.Group()
    pivot.add(turn); turn.add(rig); root.add(pivot); turn.rotation.z = 80 * Math.PI / 180
    animateObject(rig, age => {
      const open = properties.preview_book === 'open' ? 1 : 0, angle = (Math.sin(age * .02) * .1 + 1.25) * open
      const p = rig.userData.parts, flip = offset => Math.max(0, Math.min(1, ((age * .01 + offset) % 1) * 1.6 - .3))
      p.left_lid.rotation.y = Math.PI + angle; p.right_lid.rotation.y = -angle
      p.left_pages.rotation.y = angle; p.right_pages.rotation.y = -angle
      p.flip_page1.rotation.y = angle * (1 - 2 * flip(.25)); p.flip_page2.rotation.y = angle * (1 - 2 * flip(.75))
      for (const name of ['left_pages', 'right_pages', 'flip_page1', 'flip_page2']) p[name].position.x = Math.sin(angle)
      pivot.position.set(.5, .85 + Math.sin(age * .1) * .01, .5)
      pivot.rotation.y = open ? 0 : -age * .02
    })
  }
  if (id === 'conduit' && properties.preview_active === 'true') {
    const box = (size, w, h) => ({ w, h, parts: { shell: part([cuboid(0, 0, -size / 2, -size / 2, -size / 2, size, size, size)]) } })
    const cage = await blockRig(box(8, 32, 16), 'entity/conduit/cage', assets)
    const wind = await blockRig(box(16, 64, 32), 'entity/conduit/wind', assets)
    const wind2 = await blockRig(box(16, 64, 32), 'entity/conduit/wind', assets)
    const windMap = await assets.getTexture('entity/conduit/wind'), verticalMap = await assets.getTexture('entity/conduit/wind_vertical')
    if (!cage || !wind || !wind2) return root
    const wrap = rig => { const group = new THREE.Group(); group.add(rig); root.add(group); return group }
    const cageGroup = wrap(cage), windGroup = wrap(wind), innerGroup = wrap(wind2)
    innerGroup.scale.setScalar(.875); innerGroup.rotation.set(Math.PI, 0, Math.PI)
    const map = await assets.getTexture('entity/conduit/' + (properties.preview_eye === 'true' ? 'open_eye' : 'closed_eye'))
    const eye = new THREE.Mesh(new THREE.PlaneGeometry(1 / 3, 1 / 3), new THREE.MeshBasicMaterial({ map, alphaTest: .1, side: THREE.DoubleSide }))
    // 眼睛只使用 16×16 图集左上 8×8。
    const uv = eye.geometry.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * .5, (1 - uv.getY(i)) * .5)
    root.add(eye)
    const axis = new THREE.Vector3(.5, 1, .5).normalize()
    animateObject(cage, age => {
      const wave = Math.sin(age * .1) / 2 + .5, y = .3 + (wave * wave + wave) * .2
      cageGroup.position.set(.5, y, .5); cageGroup.quaternion.setFromAxisAngle(axis, age * .0375)
      windGroup.position.set(.5, .5, .5); innerGroup.position.set(.5, .5, .5)
      const phase = Math.floor(age / 66) % 3
      windGroup.rotation.set(phase === 1 ? Math.PI / 2 : 0, 0, phase === 2 ? Math.PI / 2 : 0)
      wind.material.map = wind2.material.map = phase === 1 ? verticalMap : windMap
      eye.position.set(.5, y, .5)
    })
    animateObject(eye, (_age, camera) => { if (camera) { const world = new THREE.Quaternion(); camera.getWorldQuaternion(world); const parent = root.getWorldQuaternion(new THREE.Quaternion()).invert(); eye.quaternion.copy(parent.multiply(world)) } })
  }
  return root
}

export async function addBlockEffects(group, data, assets, visible) {
  const { width: w, depth: d, minX, minY, minZ } = data.bounds
  const supported = new Set(['bell', 'enchanting_table', 'conduit'])
  const entries = data.palette.map(p => supported.has(p.name.replace('minecraft:', '')) ? p : null)
  if (!entries.some(Boolean)) return
  for (const [key, index] of data.blocks) {
    const p = entries[index]; if (!p) continue
    const x = key % w, z = Math.floor(key / w) % d, y = Math.floor(key / (w * d))
    if (visible && !visible(x + minX, y + minY, z + minZ, y)) continue
    const effect = await buildBlockEffect(p.name.replace('minecraft:', ''), p.properties, assets)
    if (effect.children.length) { effect.position.set(x + minX, y + minY, z + minZ); group.add(effect) }
  }
}

export async function portalMaterial(assets, gateway) {
  const sky = await assets.getTexture('environment/end_sky'), stars = await assets.getTexture('entity/end_portal/end_portal')
  for (const texture of [sky, stars]) if (texture) { texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.colorSpace = THREE.NoColorSpace; texture.needsUpdate = true }
  const colors = [[.022087,.098399,.110818],[.011892,.095924,.089485],[.027636,.101689,.100326],[.046564,.109883,.114838],[.064901,.117696,.097189],[.063761,.086895,.123646],[.084817,.111994,.166380],[.097489,.154120,.091064],[.106152,.131144,.195191],[.097721,.110188,.187229],[.133516,.138278,.148582],[.070006,.243332,.235792],[.196766,.142899,.214696],[.047281,.315338,.321970],[.204675,.390010,.302066],[.080955,.314821,.661491]]
  // rendertype_end_portal：屏幕投影采样，逐层旋转、缩放、滚动；门 15 层，折跃门 16 层。
  return new THREE.ShaderMaterial({ uniforms: { sky: { value: sky }, stars: { value: stars }, gameTime: { value: 0 } },
    vertexShader: 'varying vec4 projected; void main(){ gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); projected=vec4((gl_Position.xy+gl_Position.ww)*.5,gl_Position.zw); }',
    fragmentShader: `uniform sampler2D sky; uniform sampler2D stars; uniform float gameTime; varying vec4 projected;
    void main(){vec3 color=texture2DProj(sky,projected).rgb*vec3(${colors[0]});
    ${colors.slice(0, gateway ? 16 : 15).map((color, i) => {
      const n = i + 1, angle = ((n*n*4321+n*9)*2) * Math.PI / 180, s = (4.5 - n / 4) * 2
      return `{ vec4 uv=projected; uv.xy=mat2(${Math.cos(angle)},${Math.sin(angle)},${-Math.sin(angle)},${Math.cos(angle)})*uv.xy*${s.toFixed(1)}; uv.xy+=vec2(${(17/n).toFixed(9)},${(2+n/1.5).toFixed(9)}*gameTime*1.5)*uv.w;uv.xy=uv.xy*.5+uv.ww*.25;color+=texture2DProj(stars,uv).rgb*vec3(${color}); }`
    }).join('\n')}
    gl_FragColor=vec4(color,1.); }`, side: THREE.FrontSide,
  })
}
