import { BABY_MODELS } from './babyEntityModels.js'

export const BABY_MODEL_KEYS = {
  pig: 'Pig', cow: 'Cow', mooshroom: 'Cow', sheep: 'Sheep', goat: 'Goat', panda: 'Panda', polar_bear: 'PolarBear',
  wolf: 'Wolf', cat: 'Feline', ocelot: 'Feline', fox: 'Fox', rabbit: 'Rabbit', horse: 'Horse', donkey: 'Donkey', mule: 'Donkey',
  skeleton_horse: 'Horse', zombie_horse: 'Horse', llama: 'Llama', trader_llama: 'Llama', turtle: 'Turtle', chicken: 'Chicken',
  axolotl: 'Axolotl', camel: 'Camel', armadillo: 'Armadillo', hoglin: 'Hoglin', zoglin: 'Hoglin', strider: 'Strider', bee: 'Bee',
  zombie: 'Zombie', husk: 'Zombie', drowned: 'Zombie', zombie_villager: 'ZombieVillager', villager: 'Villager',
  piglin: 'Piglin', zombified_piglin: 'Piglin', dolphin: 'Dolphin', squid: 'Squid', glow_squid: 'Squid',
}
export const BABY_MOBS = new Set([...Object.keys(BABY_MODEL_KEYS), 'sniffer', 'happy_ghast'])
export const isBaby = nbt => Number(nbt.Age) < 0 || !!(nbt.IsBaby || nbt.is_baby)
export function babyModel(id) { return BABY_MODELS[BABY_MODEL_KEYS[id]] }

// 嗅探兽和快乐恶魂使用原版缩放变换，其余使用 26.3 独立模型。
export function applyBabyPose(mesh, id, nbt) {
  if (!BABY_MOBS.has(id) || !isBaby(nbt)) return
  mesh.userData.baby = true
  if (babyModel(id)) return
  const scale = id === 'happy_ghast' ? .2375 : .5
  for (const bone of mesh.skeleton.bones[0].children) {
    bone.position.y -= 24; bone.position.multiplyScalar(scale); bone.position.y += 24; bone.scale.setScalar(scale)
  }
}
