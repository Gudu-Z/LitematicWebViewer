// Embedded cards never inspect saved inventories, AI memories, trades or timers.
// Keep the fields consumed by the renderers, including nested passenger visuals.
// Health/attributes are needed for wither shields, golem cracks and entity scale.
const regionFields = new Set(['Position', 'Size', 'BlockStatePalette', 'BlockStates', 'TileEntities', 'Entities'])
const tileFields = new Set([
  'id', 'x', 'y', 'z', 'profile', 'front_text', 'back_text', 'Text1', 'Text2', 'Text3', 'Text4',
  'Color', 'GlowingText', 'patterns', 'sherds', 'blockState', 'facing', 'progress', 'extending', 'source',
])
export const renderedBlockEntities = new Set([
  'minecraft:skull', 'minecraft:sign', 'minecraft:hanging_sign', 'minecraft:banner',
  'minecraft:decorated_pot', 'minecraft:piston',
])
const entityFields = new Set(`
  id Pos Rotation UUID Passengers
  Item Facing ItemRotation Invisible invisible
  Age IsBaby is_baby Small Marker ShowArms NoBasePlate Pose pose
  equipment ArmorItems HandItems body_armor_item ArmorItem DecorItem SaddleItem Saddle LeftHanded
  Health attributes Attributes CustomName custom_name
  Type type Variant variant minecraft:variant Color color CatType RabbitType CollarColor Owner OwnerUUID
  MainGene HiddenGene AngerTime HasNectar HasStung has_stung Sheared sheared
  Shivering shivering weather_state oxidation_level PuffState Size AttachFace Peek peek
  powered Powered Invul active Active VillagerData HasLeftHorn HasRightHorn Pumpkin carriedBlockState
  ChestedHorse Sitting sitting LastPoseTick state Sleeping SleepingX sleeping_pos DeathTime
  OnGround HasEgg BatFlags DragonPhase
`.trim().split(/\s+/))

export function selectRenderNbtField(path, name) {
  if (path[0] !== 'Regions' && path[0] !== 'SubRegions') return true
  if (path.length === 2) return regionFields.has(name)
  if (path.length === 3 && path[2] === 'TileEntities') return tileFields.has(name)
  if (path[2] === 'Entities' && path.slice(3).every(key => key === 'Passengers')) return entityFields.has(name)
  return true
}
