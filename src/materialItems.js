// Placed-only blocks use their inventory counterpart; other blocks can fall back
// to their block model (for example a planted flower pot or a cake with a candle).
export function materialIconId(name) {
  const id = name.replace(/^minecraft:/, '').replace(/(^|_)wall_/, '$1')
  return ({
    water: 'water_bucket', lava: 'lava_bucket', bubble_column: 'water_bucket',
    redstone_wire: 'redstone', tripwire: 'string', wheat: 'wheat_seeds',
    carrots: 'carrot', potatoes: 'potato', beetroots: 'beetroot_seeds',
    cocoa: 'cocoa_beans', sweet_berry_bush: 'sweet_berries',
    melon_stem: 'melon_seeds', attached_melon_stem: 'melon_seeds',
    pumpkin_stem: 'pumpkin_seeds', attached_pumpkin_stem: 'pumpkin_seeds',
    kelp_plant: 'kelp', cave_vines: 'glow_berries', cave_vines_plant: 'glow_berries',
    twisting_vines_plant: 'twisting_vines', weeping_vines_plant: 'weeping_vines',
    powder_snow: 'powder_snow_bucket', tall_seagrass: 'seagrass',
    moving_piston: 'piston',
  })[id] || id
}
