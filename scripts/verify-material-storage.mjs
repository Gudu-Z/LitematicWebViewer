import assert from 'node:assert/strict'
import { materialIconId } from '../src/materialItems.js'
import { materialStorage } from '../src/materialStorage.js'

// Expected limits from Minecraft 26.3's item components and ShulkerBoxMenu.
// No downloaded reports, network, renderer or DOM are required by this test.
const expect = (name, count, stackSize, boxes) => assert.deepEqual(
  materialStorage(name, count), { stackSize, capacity: 27 * stackSize, boxes }, `${name}, count=${count}`,
)

expect('stone', 0, 64, 0)
expect('stone', 1, 64, 1)
expect('stone', 1728, 64, 1)
expect('minecraft:stone', 1729, 64, 2)
expect('oak_sign', 432, 16, 1)
expect('oak_sign', 433, 16, 2)
expect('red_bed', 27, 1, 1)
expect('red_bed', 28, 1, 2)
expect('straw_bed', 432, 16, 1)
expect('minecraft:straw_bed', 433, 16, 2)

for (const wood of 'oak spruce birch jungle acacia dark_oak mangrove cherry bamboo crimson warped pale_oak poplar'.split(' ')) {
  for (const form of ['sign', 'wall_sign', 'hanging_sign', 'wall_hanging_sign']) {
    expect(`minecraft:${wood}_${form}`, 433, 16, 2)
  }
}
for (const color of 'white orange magenta light_blue yellow lime pink gray light_gray cyan purple blue brown green red black'.split(' ')) {
  expect(`${color}_bed`, 28, 1, 2)
  expect(`${color}_banner`, 433, 16, 2)
  expect(`minecraft:${color}_wall_banner`, 433, 16, 2)
  assert.deepEqual(materialStorage(`${color}_shulker_box`, 64), { reason: 'Nested' })
  assert.deepEqual(materialStorage(`minecraft:${color}_shulker_box`, 64), { reason: 'Nested' })
  assert.deepEqual(materialStorage(`${color}_candle_cake`, 64), { reason: 'NoItem' })
}
assert.deepEqual(materialStorage('shulker_box', 1), { reason: 'Nested' })
assert.deepEqual(materialStorage('minecraft:shulker_box', 1), { reason: 'Nested' })

for (const name of ['cake', 'water', 'bubble_column', 'lava', 'powder_snow', 'water_bucket', 'lava_bucket', 'powder_snow_bucket']) expect(name, 28, 1, 2)
for (const name of [
  'bamboo_sapling', 'big_dripleaf_stem', 'pitcher_crop', 'torchflower_crop',
  'redstone_wire', 'wheat', 'cave_vines', 'moving_piston', 'mossy_stone_brick_wall',
  'decorated_pot', 'flower_pot', 'cauldron', 'red_candle', 'waxed_cut_copper',
]) expect(name, 1729, 64, 2)

for (const name of [
  'air', 'cave_air', 'void_air', 'end_gateway', 'end_portal', 'nether_portal',
  'fire', 'soul_fire', 'frosted_ice', 'piston_head',
  'water_cauldron', 'lava_cauldron', 'powder_snow_cauldron',
  'potted_fern', 'potted_poplar_sapling', 'candle_cake',
]) {
  assert.deepEqual(materialStorage(name, 1), { reason: 'NoItem' }, name)
  assert.deepEqual(materialStorage(`minecraft:${name}`, 1), { reason: 'NoItem' }, name)
}
assert.deepEqual(materialStorage('example:stone', 1), { reason: 'Unknown' })
assert.deepEqual(materialStorage('example:oak_sign', 1), { reason: 'Unknown' })

// Additional capacity aliases must not replace the established icon models.
for (const name of ['bamboo_sapling', 'big_dripleaf_stem', 'pitcher_crop', 'torchflower_crop', 'potted_fern', 'red_candle_cake']) {
  assert.equal(materialIconId(name), name)
}
assert.equal(materialIconId('minecraft:oak_wall_hanging_sign'), 'oak_hanging_sign')
assert.equal(materialIconId('minecraft:red_wall_banner'), 'red_banner')
assert.equal(materialIconId('water'), 'water_bucket')

console.log('Material storage: capacity boundaries, 26.3 stack exceptions, aliases and unsupported storage passed')
