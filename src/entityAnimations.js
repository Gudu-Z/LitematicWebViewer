// 原版 *EntityModel.setAngles 的静止/待机分支，时间单位为游戏 tick。
// 不模拟寻路、行走、攻击或临时客户端事件；关键帧来自 entityAnimationData.js。
import { ENTITY_ANIMATIONS } from './entityAnimationData.js'
import { BABY_ANIMATIONS } from './babyAnimationData.js'
import { RELEASE_ANIMATIONS } from './releaseModelData.js'
import { readEquipment } from './equipmentState.js'
const PI = Math.PI, DEG = PI / 180
const BIPEDS = new Set(['zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'bogged', 'parched', 'wither_skeleton', 'piglin', 'piglin_brute', 'zombified_piglin', 'giant', 'enderman'])
export const IDLE_ANIMATED_MOBS = new Set([...BIPEDS,
  'breeze', 'blaze', 'ghast', 'happy_ghast', 'phantom', 'bee', 'vex', 'allay', 'bat',
  'endermite', 'silverfish', 'cod', 'salmon', 'tropical_fish', 'pufferfish', 'tadpole',
  'squid', 'glow_squid', 'wither', 'witch', 'strider', 'warden', 'axolotl', 'camel',
  'camel_husk', 'nautilus', 'zombie_nautilus',
  'copper_golem', 'frog', 'armadillo', 'parrot', 'ender_dragon', 'guardian', 'elder_guardian', 'shulker', 'fox', 'chicken',
])

// 对齐 AnimationHelper/Transformation.Interpolations：平移 Y 翻转已由生成器完成；
// CUBIC 使用与 MathHelper.catmullRom 相同的插值，并按原版夹取首尾帧。
export function applyKeyframeAnimation(parts, name, seconds, weight = 1) {
  const animation = ENTITY_ANIMATIONS[name] || BABY_ANIMATIONS[name] || RELEASE_ANIMATIONS[name]
  if (!animation) return
  const t = animation.loop ? seconds % animation.length : Math.min(seconds, animation.length)
  for (const track of animation.tracks) {
    const bone = parts[track.part]
    if (!bone) continue
    const frames = track.frames
    let end = frames.findIndex(f => f[0] >= t)
    if (end < 0) end = frames.length - 1
    const start = Math.max(0, end - 1)
    const a = frames[start], b = frames[end]
    const fraction = a === b ? 0 : Math.max(0, Math.min(1, (t - a[0]) / (b[0] - a[0])))
    const target = track.target === 'ROTATE' ? bone.rotation : track.target === 'SCALE' ? bone.scale : bone.position
    for (let axis = 0; axis < 3; axis++) {
      const j = axis + 1, f = fraction
      let value
      if (b[4]) {
        const p = frames[Math.max(0, start - 1)][j], q = a[j], r = b[j], s = frames[Math.min(frames.length - 1, end + 1)][j]
        value = 0.5 * ((2 * q) + (-p + r) * f + (2 * p - 5 * q + 4 * r - s) * f * f + (-p + 3 * q - 3 * r + s) * f * f * f)
      } else value = a[j] + (b[j] - a[j]) * f
      target[['x', 'y', 'z'][axis]] += (track.target === 'SCALE' ? value - 1 : value) * weight
    }
  }
}

export function applyIdlePose(parts, id, state, age) {
  const nbt = state.nbt || {}
  const set = (name, axis, value) => { if (parts[name]) parts[name].rotation[axis] = value }
  const add = (name, axis, value) => { if (parts[name]) parts[name].rotation[axis] += value }
  const move = (name, axis, value) => { if (parts[name]) parts[name].position[axis] += value }
  const origin = (name, axis, value) => { if (parts[name]) parts[name].position[axis] = value }
  const hide = name => { if (parts[name]) parts[name].scale.setScalar(0) }
  const pitch = (Number(state.rotation?.[1]) || 0) * DEG
  add(parts.head_parts ? 'head_parts' : 'head', 'x', pitch)
  // 独立帽子节点须随头部转动；模型中的父子帽子会自然继承。
  if (parts.hat?.parent === parts.head?.parent) add('hat', 'x', pitch)
  // HumanoidModel / IllagerModel passenger pose; quadrupeds and villagers keep vanilla poses.
  const illager = ['pillager', 'vindicator', 'evoker', 'illusioner'].includes(id)
  if (state.riding && (BIPEDS.has(id) || illager)) {
    for (const [side, sign] of [['right', 1], ['left', -1]]) {
      set(side + '_leg', 'x', id === 'enderman' ? -.4 : -1.4137167)
      set(side + '_leg', 'y', sign * PI / 10)
      set(side + '_leg', 'z', sign * .07853982)
      if (illager) {
        set(side + '_arm', 'x', -PI / 5)
        set(side + '_arm', 'y', 0)
        set(side + '_arm', 'z', 0)
      }
    }
  }
  if (BIPEDS.has(id)) {
    const equipment = readEquipment(nbt)
    const zombie = ['zombie', 'husk', 'drowned', 'zombie_villager', 'giant', 'zombified_piglin'].includes(id)
    const base = zombie ? -PI / 2.25 : 0
    for (const [side, sign] of [['right', 1], ['left', -1]]) {
      const held = equipment[(side === 'left') === !!nbt.LeftHanded ? 'mainhand' : 'offhand']
      set(side + '_arm', 'x', (zombie ? base : state.riding ? -PI / 5 : held ? -PI / 10 : 0) + sign * Math.sin(age * 0.067) * 0.05)
      set(side + '_arm', 'z', sign * (Math.cos(age * 0.09) * 0.05 + 0.05))
      if (zombie) set(side + '_arm', 'y', -sign * 0.1)
    }
    if (id.includes('piglin')) {
      const earAngle = state.babyModel ? 5 * DEG : PI / 6
      set('left_ear', 'z', -earAngle - Math.cos(age * 0.12) * 0.08)
      set('right_ear', 'z', earAngle + Math.cos(age * 0.1) * 0.08)
    }
    if (id === 'enderman') for (const side of ['left', 'right']) {
      if (parts[side + '_arm']) parts[side + '_arm'].rotation.x *= 0.5
      if (nbt.carriedBlockState) { set(side + '_arm', 'x', -0.5); set(side + '_arm', 'z', side === 'left' ? -0.05 : 0.05) }
    }
  }
  switch (id) {
    case 'pillager': {
      const items = Object.values(readEquipment(nbt))
      if (items.some(item => item?.id?.replace(/^minecraft:/, '') === 'crossbow')) {
        // IllagerEntityModel.CROSSBOW_HOLD -> ArmPosing.hold（静止持弩姿态）。
        const main = nbt.LeftHanded ? 'left_arm' : 'right_arm', off = nbt.LeftHanded ? 'right_arm' : 'left_arm', sign = nbt.LeftHanded ? -1 : 1
        set(main, 'y', -0.3 * sign); set(off, 'y', 0.6 * sign)
        set(main, 'x', -PI / 2 + pitch + 0.1); set(off, 'x', -1.5 + pitch)
      }
      break
    }
    case 'guardian': case 'elder_guardian': {
      const xs = [0, 0, 8, -8, -8, 8, 8, -8, 0, 0, 8, -8]
      const ys = [-8, -8, -8, -8, 0, 0, 0, 0, 8, 8, 8, 8]
      const zs = [8, -8, 0, 0, -8, -8, 8, 8, 8, -8, 0, 0]
      for (let i = 0; i < 12; i++) {
        const extension = 1 + Math.cos(age * 1.5 + i) * 0.01
        origin('spike' + i, 'x', xs[i] * extension)
        origin('spike' + i, 'y', 16 + ys[i] * extension)
        origin('spike' + i, 'z', zs[i] * extension)
      }
      // GuardianEntity.tickMovement 的水中静止极限速率为 0.125，离水为 2。
      for (let i = 0; i < 3; i++) set('tail' + i, 'y', Math.sin(age * (state.touchingWater ? 0.125 : 2)) * PI * 0.05 * (i + 1))
      break
    }
    case 'shulker': {
      const open = Math.max(0, Math.min(1, (Number(nbt.Peek) || 0) / 100)), f = (0.5 + open) * PI
      origin('lid', 'y', 16 + Math.sin(f) * 8 + (f > PI ? Math.sin(age * 0.1) * 0.7 : 0))
      set('lid', 'y', open > 0.3 ? (Math.sin(f) - 1) ** 4 * PI * 0.125 : 0)
      break
    }
    case 'cat': case 'ocelot':
      if (state.babyModel && state.sitting) {
        add('body', 'x', -0.43633232); move('body', 'y', 1.25); move('head', 'z', .75)
        add('tail1', 'x', .5454154); move('tail1', 'y', 4); move('tail1', 'z', -.9)
        move('left_hind_leg', 'z', -.9); move('right_hind_leg', 'z', -.9)
        break
      }
      set('tail2', 'x', 1.7278761)
      if (state.sitting) {
        set('body', 'x', PI / 4); move('body', 'y', -4); move('body', 'z', 5)
        move('head', 'y', -3.3); move('head', 'z', 1)
        move('tail1', 'y', 8); move('tail1', 'z', -2); set('tail1', 'x', 1.7278761)
        move('tail2', 'y', 2); move('tail2', 'z', -0.8); set('tail2', 'x', 2.670354)
        for (const side of ['left', 'right']) {
          set(side + '_front_leg', 'x', -PI / 20); move(side + '_front_leg', 'y', 2); move(side + '_front_leg', 'z', -2)
          set(side + '_hind_leg', 'x', -PI / 2); move(side + '_hind_leg', 'y', 3); move(side + '_hind_leg', 'z', -4)
        }
      }
      break
    case 'wolf':
      if (state.babyModel && state.sitting) {
        // WolfModel.setSittingPose 的 ageScale=.5，再应用 BabyWolfModel 的躯干旋转。
        move('body', 'y', 2); move('body', 'z', -1); set('body', 'x', -PI / 4)
        move('tail', 'y', 4.5); move('tail', 'z', -1)
        for (const [side, sign] of [['right', 1], ['left', -1]]) {
          move(side + '_hind_leg', 'y', 3.35); move(side + '_hind_leg', 'z', -2.5); set(side + '_hind_leg', 'x', PI * 1.5)
          move(side + '_front_leg', 'x', sign * .005); move(side + '_front_leg', 'y', .5); set(side + '_front_leg', 'x', 5.811947)
        }
        break
      }
      if (state.sitting) {
        move('upper_body', 'y', 2); set('upper_body', 'x', PI * 2 / 5); set('upper_body', 'y', 0)
        move('body', 'y', 4); move('body', 'z', -2); set('body', 'x', PI / 4)
        move('tail', 'y', 9); move('tail', 'z', -2)
        for (const [side, sign] of [['right', 1], ['left', -1]]) {
          move(side + '_hind_leg', 'y', 6.7); move(side + '_hind_leg', 'z', -5); set(side + '_hind_leg', 'x', PI * 1.5)
          move(side + '_front_leg', 'x', sign * 0.01); move(side + '_front_leg', 'y', 1); set(side + '_front_leg', 'x', 5.811947)
        }
      }
      break
    case 'fox':
      if (state.babyModel) {
        if (nbt.Sleeping) {
          set('body', 'z', -PI / 2); set('body', 'x', -PI / 18)
          move('body', 'y', 1.5); move('body', 'z', -1.5); move('body', 'x', -1.5)
          set('tail', 'x', -2.1816616); move('tail', 'x', -.7); move('tail', 'z', .6); move('tail', 'y', .9)
          move('head', 'x', -2); move('head', 'y', 2.8); move('head', 'z', -4)
          set('head', 'x', 0); set('head', 'y', -PI * 2 / 3); set('head', 'z', Math.cos(age * .027) / 22)
          for (const side of ['left', 'right']) { hide(side + '_front_leg'); hide(side + '_hind_leg') }
        } else if (state.sitting) {
          set('head', 'x', 0); set('head', 'y', 0); move('head', 'y', -.75)
          set('body', 'x', -.959931); move('body', 'z', -2.25); move('body', 'y', 1.5)
          set('tail', 'x', .95993114); move('tail', 'y', -.6); move('tail', 'z', -1)
          for (const [side, sign] of [['right', 1], ['left', -1]]) {
            set(side + '_front_leg', 'x', -PI / 12); move(side + '_front_leg', 'z', -1.5); move(side + '_front_leg', 'x', sign * .01)
            move(side + '_hind_leg', 'z', -3.75); move(side + '_hind_leg', 'x', sign * .01)
          }
        }
        break
      }
      if (nbt.Sleeping) {
        set('body', 'z', -PI / 2); move('body', 'y', 5); set('tail', 'x', -PI * 5 / 6)
        move('head', 'x', 2); move('head', 'y', 2.99); set('head', 'x', 0); set('head', 'y', -PI * 2 / 3)
        set('head', 'z', Math.cos(age * 0.027) / 22)
        for (const side of ['left', 'right']) { hide(side + '_front_leg'); hide(side + '_hind_leg') }
      } else if (state.sitting) {
        set('body', 'x', PI / 6); move('body', 'y', -7); move('body', 'z', 3)
        set('tail', 'x', PI / 4); move('tail', 'z', -1); move('head', 'y', -6.5); move('head', 'z', 2.75)
        for (const side of ['left', 'right']) {
          set(side + '_hind_leg', 'x', -PI * 5 / 12); move(side + '_hind_leg', 'y', 4); move(side + '_hind_leg', 'z', -0.25)
          set(side + '_front_leg', 'x', -PI / 12)
        }
      }
      break
    case 'llama': case 'trader_llama':
      if (!nbt.ChestedHorse) { hide('left_chest'); hide('right_chest') }
      break
    case 'turtle': if (!nbt.HasEgg) hide('egg_belly'); break
    case 'dolphin': set('head', 'x', 0); set('body', 'x', pitch); break
    case 'chicken':
      if (nbt.OnGround === false || nbt.OnGround === 0) {
        const flap = Math.sin(age * 1.8) + 1
        set('right_wing', 'z', flap); set('left_wing', 'z', -flap)
      }
      break
    case 'breeze': applyKeyframeAnimation(parts, 'Breeze.IDLING', age / 20); break
    case 'blaze':
      for (let i = 0; i < 12; i++) {
        const band = Math.floor(i / 4)
        // 当前资源版本沿用项目中 26.3 的四等分火棒布局。
        const angle = [0, PI / 4, 0.47123894][band] + age * PI * [-0.1, 0.03, -0.05][band] + (i % 4) * PI / 2
        origin('rod' + i, 'x', Math.cos(angle) * [9, 7, 5][band])
        origin('rod' + i, 'z', Math.sin(angle) * [9, 7, 5][band])
        origin('rod' + i, 'y', [-2, 2, 11][band] + Math.cos((i * (band === 2 ? 1.5 : 2) + age) * (band === 2 ? 0.5 : 0.25)))
      }
      break
    case 'ghast': case 'happy_ghast':
      for (let i = 0; i < 9; i++) set('tentacle' + i, 'x', 0.2 * Math.sin(age * 0.3 + i) + 0.4)
      break
    case 'phantom': {
      const f = age * 7.448451 * DEG, wing = Math.cos(f) * 16 * DEG
      for (const segment of ['base', 'tip']) {
        set('left_wing_' + segment, 'z', wing); set('right_wing_' + segment, 'z', -wing)
        set('tail_' + segment, 'x', -(5 + Math.cos(f * 2) * 5) * DEG)
      }
      break
    }
    case 'bee':
      if (nbt.HasStung || nbt.has_stung) hide('stinger')
      if (!nbt.OnGround) {
        const f = Math.cos(age * 0.18), wing = Math.cos(age * 120.32113 * DEG) * PI * 0.15
        set('right_wing', 'y', 0); set('left_wing', 'y', 0)
        set('right_wing', 'z', wing); set('left_wing', 'z', -wing)
        for (const leg of ['front_legs', 'middle_legs', 'back_legs']) set(leg, 'x', PI / 4)
        if (!(nbt.AngerTime > 0)) {
          set('bone', 'x', 0.1 + f * PI * 0.025); move('bone', 'y', -f * 0.9)
          set('left_antenna', 'x', f * PI * 0.03); set('right_antenna', 'x', f * PI * 0.03)
          set('front_legs', 'x', -f * PI * 0.1 + PI / 8); set('back_legs', 'x', -f * PI * 0.05 + PI / 4)
        }
      }
      break
    case 'vex': {
      const f = Math.cos(age * 5.5 * DEG) * 0.1
      set('right_arm', 'z', PI / 5 + f); set('left_arm', 'z', -PI / 5 - f)
      set('body', 'x', PI / 20)
      const wing = 1.0995574 + Math.cos(age * 45.836624 * DEG) * DEG * 16.2
      set('left_wing', 'y', wing); set('right_wing', 'y', -wing)
      set('left_wing', 'x', 0.47123888); set('right_wing', 'x', 0.47123888)
      set('left_wing', 'z', -0.47123888); set('right_wing', 'z', 0.47123888)
      break
    }
    case 'allay': {
      const wing = Math.cos(age * 20 * DEG) * PI * 0.15, j = age * 9 * DEG
      const held = !!readEquipment(nbt).mainhand
      set('right_wing', 'x', 0.43633232); set('left_wing', 'x', 0.43633232)
      set('right_wing', 'y', -PI / 4 + wing); set('left_wing', 'y', PI / 4 - wing)
      move('root', 'y', Math.cos(j) * 0.25)
      const arm = 0.43633232 - Math.cos(j + PI * 1.5) * PI * 0.075 * (held ? 0 : 1)
      set('left_arm', 'z', -arm); set('right_arm', 'z', arm)
      set('left_arm', 'x', held ? -PI / 3 : 0); set('right_arm', 'x', held ? -PI / 3 : 0)
      break
    }
    case 'bat': applyKeyframeAnimation(parts, (nbt.BatFlags & 1) ? 'Bat.ROOSTING' : 'Bat.FLYING', age / 20); break
    case 'endermite': case 'silverfish':
      for (let i = 0; i < (id === 'silverfish' ? 7 : 4); i++) {
        const f = age * 0.9 + i * 0.15 * PI
        set('segment' + i, 'y', Math.cos(f) * PI * (id === 'silverfish' ? 0.05 : 0.01) * (1 + Math.abs(i - 2)))
        origin('segment' + i, 'x', Math.sin(f) * PI * (id === 'silverfish' ? 0.2 : 0.1) * Math.abs(i - 2))
      }
      if (id === 'silverfish') for (const [i, j] of [[0, 2], [1, 4], [2, 1]]) {
        set('layer' + i, 'y', parts['segment' + j]?.rotation.y || 0)
        if (i) origin('layer' + i, 'x', parts['segment' + j]?.position.x || 0)
      }
      break
    case 'cod': case 'tropical_fish': case 'tadpole':
      set(id === 'cod' ? 'tail_fin' : 'tail', 'y', -(state.touchingWater ? 1 : 1.5) * (id === 'tadpole' ? 0.25 : 0.45) * Math.sin(age * (id === 'tadpole' ? 0.3 : 0.6)))
      break
    case 'salmon': set('body_back', 'y', -(state.touchingWater ? 1 : 1.3) * 0.25 * Math.sin(age * 0.6 * (state.touchingWater ? 1 : 1.7))); break
    case 'pufferfish':
      for (const suffix of ['_fin', '_blue_fin']) {
        set('right' + suffix, 'z', -0.2 + 0.4 * Math.sin(age * 0.2))
        set('left' + suffix, 'z', 0.2 - 0.4 * Math.sin(age * 0.2))
      }
      break
    case 'squid': case 'glow_squid': {
      const phase = age * state.squidSpeed % (2 * PI)
      const angle = state.touchingWater ? (phase < PI ? Math.sin((phase / PI) ** 2 * PI) * PI * 0.25 : 0) : Math.abs(Math.sin(phase)) * PI * 0.25
      for (let i = 0; i < 8; i++) set('tentacle' + i, 'x', angle)
      break
    }
    case 'wither': {
      const f = Math.cos(age * 0.1), rib = (0.065 + 0.05 * f) * PI
      set('ribcage', 'x', rib); set('tail', 'x', (0.265 + 0.1 * f) * PI)
      origin('tail', 'x', -2); origin('tail', 'y', 6.9 + Math.cos(rib) * 10); origin('tail', 'z', -0.5 + Math.sin(rib) * 10)
      set('center_head', 'x', pitch)
      break
    }
    case 'witch': {
      const f = 0.01 * (state.seed % 10)
      set('nose', 'x', Math.sin(age * f) * 4.5 * DEG); set('nose', 'z', Math.cos(age * f) * 2.5 * DEG)
      break
    }
    case 'strider':
      for (const [name, base, speed, amplitude] of [
        ['bottom', 1.2217305, -0.4, 0.05], ['middle', 1.134464, 0.2, 0.1], ['top', 0.87266463, 0.4, 0.1],
      ]) for (const [side, sign] of [['right', -1], ['left', 1]]) set(`${side}_${name}_bristle`, 'z', sign * base + amplitude * Math.sin(age * speed))
      break
    case 'warden':
      add('head', 'z', 0.06 * Math.cos(age * 0.1)); add('head', 'x', 0.06 * Math.sin(age * 0.1))
      add('body', 'z', 0.025 * Math.sin(age * 0.1)); add('body', 'x', 0.025 * Math.cos(age * 0.1))
      break
    case 'axolotl': {
      if (state.babyModel) {
        applyKeyframeAnimation(parts, state.touchingWater ? 'IDLE_UNDERWATER' : 'BABY_AXOLOTL_IDLE_FLOOR', age / 20)
        break
      }
      if (state.touchingWater) {
        const c = Math.cos(age * 0.075), k = -0.15 + 0.075 * c
        add('body', 'x', k); move('body', 'y', -Math.sin(age * 0.075) * 0.15); add('head', 'x', -k)
        add('top_gills', 'x', 0.2 * c); add('left_gills', 'y', -0.3 * c - 0.19); add('right_gills', 'y', 0.3 * c + 0.19)
        add('left_hind_leg', 'x', PI * 0.75 - c * 0.11); add('left_hind_leg', 'y', 0.47123894); add('left_hind_leg', 'z', 1.7278761)
        add('left_front_leg', 'x', PI / 4 - c * 0.2); add('left_front_leg', 'y', 2.042035); add('tail', 'y', 0.5 * c)
      } else {
        const s = Math.sin(age * 0.09), c = Math.cos(age * 0.09), i = s * s - 2 * s, k = 0.6 + 0.05 * (c * c - 3 * s)
        add('head', 'x', -0.09 * i); add('head', 'z', -0.2); add('tail', 'y', -0.1 + 0.1 * i)
        add('top_gills', 'x', k); add('left_gills', 'y', -k); add('right_gills', 'y', k)
        add('left_hind_leg', 'x', 1.1); add('left_hind_leg', 'y', 1)
        add('left_front_leg', 'x', 0.8); add('left_front_leg', 'y', 2.3); add('left_front_leg', 'z', -0.5)
      }
      for (const limb of ['hind', 'front']) {
        const left = parts[`left_${limb}_leg`]
        if (left) for (const axis of ['x', 'y', 'z']) set(`right_${limb}_leg`, axis, left.rotation[axis] * (axis === 'x' ? 1 : -1))
      }
      break
    }
    case 'nautilus':
    case 'zombie_nautilus':
      set('body', 'x', Math.max(-10 * DEG, Math.min(10 * DEG, pitch)))
      applyKeyframeAnimation(parts, 'Nautilus.SWIMMING', age / 50, .6)
      break
    case 'camel_husk':
    case 'camel':
      if (state.sitting) applyKeyframeAnimation(parts, state.babyModel ? 'CAMEL_BABY_SIT_POSE' : 'Camel.SITTING', age / 20)
      applyKeyframeAnimation(parts, state.babyModel ? 'CAMEL_BABY_IDLE' : 'Camel.IDLING', (age % (80 + state.seed % 40)) / 20)
      break
    case 'copper_golem': applyKeyframeAnimation(parts, 'CopperGolem.SPIN_HEAD', (age % (200 + state.seed % 41)) / 20); break
    case 'frog':
      hide('croaking_body'); hide('tongue')
      if (state.touchingWater) applyKeyframeAnimation(parts, 'Frog.IDLING_IN_WATER', age / 20)
      break
    case 'armadillo':
      if (state.rolledUp) {
        for (const name of ['right_hind_leg', 'left_hind_leg', 'tail']) hide(name)
        applyKeyframeAnimation(parts, state.babyModel ? 'ARMADILLO_BABY_PEEK' : 'Armadillo.SCARED', age / 20)
      } else hide('cube')
      break
    case 'parrot':
      if (state.sitting) {
        for (const name of ['head', 'tail', 'body', 'left_wing', 'right_wing', 'left_leg', 'right_leg']) move(name, 'y', 1)
        add('tail', 'x', PI / 6); add('left_leg', 'x', 1); add('right_leg', 'x', 1)
      } else if (nbt.OnGround === false || nbt.OnGround === 0) {
        const flap = Math.sin(age * 1.8) + 1
        for (const name of ['head', 'tail', 'body', 'left_wing', 'right_wing', 'left_leg', 'right_leg']) move(name, 'y', flap * 0.3)
        set('left_wing', 'z', -0.0873 - flap); set('right_wing', 'z', 0.0873 + flap)
        add('left_leg', 'x', PI * 2 / 9); add('right_leg', 'x', PI * 2 / 9)
      }
      break
    case 'ender_dragon': {
      // 无飞行轨迹历史的投影保持位置，取原版栖息相位驱动翅膀和下颚。
      const f = age * 0.1 * PI * 2
      set('jaw', 'x', (Math.sin(f) + 1) * 0.2)
      set('left_wing', 'x', 0.125 - Math.cos(f) * 0.2); set('right_wing', 'x', 0.125 - Math.cos(f) * 0.2)
      set('left_wing', 'y', -0.25); set('right_wing', 'y', 0.25)
      set('left_wing', 'z', -(Math.sin(f) + 0.125) * 0.8); set('right_wing', 'z', (Math.sin(f) + 0.125) * 0.8)
      set('left_wing_tip', 'z', (Math.sin(f + 2) + 0.5) * 0.75); set('right_wing_tip', 'z', -(Math.sin(f + 2) + 0.5) * 0.75)
      break
    }
  }
}
