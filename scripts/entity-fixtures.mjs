import { MOB_TABLE } from '../src/entityAppearance.js'
const entity = (id, nbt = {}, label = id) => ({ label, id: 'minecraft:' + id, pos: [0, 0, 0], rotation: [0, 0], nbt: { Health: 20, OnGround: 1, ...nbt } })
export const FEATURE_FIXTURES = [
  entity('breeze', {}, '旋风人'), entity('creeper', { powered: 1 }, '闪电苦力怕'), entity('wither', { Health: 140 }, '凋零 · 护甲'),
  entity('warden', {}, '监守者'), entity('blaze', {}, '烈焰人'), entity('ghast', {}, '恶魂'),
  entity('slime', { Size: 2 }, '史莱姆 · 半透明外壳'), entity('phantom', { OnGround: 0 }, '幻翼'),
  entity('bee', { OnGround: 0 }, '蜜蜂'), entity('allay', {}, '悦灵'), entity('vex', {}, '恼鬼'),
  entity('bat', {}, '蝙蝠 · 飞行'), entity('bat', { BatFlags: 1 }, '蝙蝠 · 倒挂'),
  entity('guardian', { OnGround: 0 }, '守卫者'), entity('squid', { OnGround: 0 }, '鱿鱼'), entity('glow_squid', { OnGround: 0 }, '发光鱿鱼'),
  entity('axolotl', { OnGround: 0, Variant: 4 }, '美西螈'), entity('copper_golem', {}, '铜傀儡'),
  entity('camel', {}, '骆驼'), entity('strider', {}, '炽足兽'), entity('silverfish', {}, '蠹虫'),
  entity('endermite', {}, '末影螨'), entity('enderman', {}, '末影人'), entity('ender_dragon', {}, '末影龙'),
  entity('sheep', { Color: 14 }, '绵羊 · 羊毛'), entity('sheep', { Color: 14, Sheared: 1 }, '绵羊 · 已剪毛'),
  entity('pufferfish', { OnGround: 0, PuffState: 0 }, '河豚 · 未膨胀'), entity('pufferfish', { OnGround: 0, PuffState: 1 }, '河豚 · 半膨胀'),
  entity('pufferfish', { OnGround: 0, PuffState: 2 }, '河豚 · 完全膨胀'), entity('tropical_fish', { OnGround: 0, Variant: 0x03040501 }, '热带鱼 · 花纹'),
  entity('cave_spider', {}, '洞穴蜘蛛'), entity('wither_skeleton', {}, '凋零骷髅'), entity('drowned', {}, '溺尸 · 外层'),
  entity('stray', {}, '流浪者 · 外层'), entity('bogged', {}, '沼泽骷髅 · 外层'),
  entity('villager', { VillagerData: { type: 'minecraft:desert', profession: 'minecraft:librarian', level: 5 } }, '村民 · 服装'),
  entity('frog', { OnGround: 0 }, '青蛙 · 水中待机'), entity('piglin', {}, '猪灵'),
  entity('sheep', { CustomName: '{"text":"jeb_"}' }, '绵羊 · 彩虹羊毛'),
  entity('shulker', { Peek: 100, Color: 3 }, '潜影贝 · 开盖'), entity('shulker', { Peek: 100, AttachFace: 5 }, '潜影贝 · 墙面吸附'),
  entity('cat', { Sitting: 1, Owner: [1, 2, 3, 4], CollarColor: 3 }, '猫 · 坐姿与项圈'),
  entity('wolf', { Sitting: 1, Owner: [1, 2, 3, 4] }, '狼 · 坐姿与项圈'),
  entity('fox', { Sleeping: 1 }, '狐狸 · 睡眠呼吸'), entity('armadillo', { state: 'scared' }, '犰狳 · 蜷缩'),
  entity('chicken', { OnGround: 0 }, '鸡 · 滞空拍翅'), entity('donkey', { ChestedHorse: 1 }, '驴 · 长耳与箱子'),
  entity('snow_golem', { Pumpkin: 1 }, '雪傀儡 · 南瓜'), entity('mooshroom', { Type: 'brown' }, '哞菇 · 蘑菇'),
  entity('iron_golem', { Health: 15 }, '铁傀儡 · 裂纹'), entity('rabbit', { RabbitType: 3 }, '兔子 · 新版皮肤'),
  entity('camel', { LastPoseTick: -500 }, '骆驼 · 坐姿'),
]
export const ALL_MOB_FIXTURES = Object.keys(MOB_TABLE).map(id => entity(id, {
  OnGround: ['cod', 'salmon', 'tropical_fish', 'pufferfish', 'tadpole', 'squid', 'glow_squid', 'axolotl', 'guardian', 'elder_guardian', 'bee', 'parrot'].includes(id) ? 0 : 1,
  ...(id === 'wither' ? { Health: 300 } : id === 'iron_golem' ? { Health: 100 } : {}),
}))
