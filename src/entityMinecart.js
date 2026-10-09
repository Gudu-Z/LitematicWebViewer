// Minecraft 26.3: AbstractMinecart.EXITS, OldMinecartBehavior.getPos/getPosOffs,
// AbstractMinecartRenderer.oldExtractState/oldRender (default, non-experimental movement).
// Verified against the official client e877b6a07acd633fb3bb475002175cec036e7b87.
const EXITS = {
  north_south: [[0, 0, -1], [0, 0, 1]],
  east_west: [[-1, 0, 0], [1, 0, 0]],
  ascending_east: [[-1, -1, 0], [1, 0, 0]],
  ascending_west: [[-1, 0, 0], [1, -1, 0]],
  ascending_north: [[0, 0, -1], [0, -1, 1]],
  ascending_south: [[0, -1, -1], [0, 0, 1]],
  south_east: [[0, 0, 1], [1, 0, 0]],
  south_west: [[0, 0, 1], [-1, 0, 0]],
  north_west: [[0, 0, -1], [-1, 0, 0]],
  north_east: [[0, 0, -1], [1, 0, 0]],
}
const RAILS = new Set(['rail', 'powered_rail', 'detector_rail', 'activator_rail'])
const DEG = Math.PI / 180

function railAt(data, x, y, z) {
  if (!data?.blocks || !data.palette || !data.bounds) return null
  const b = data.bounds, dx = x - b.minX, dy = y - b.minY, dz = z - b.minZ
  // A flattened out-of-bounds index can alias a real block in the next row/layer.
  if (dx < 0 || dx >= b.width || dy < 0 || dy >= b.height || dz < 0 || dz >= b.depth) return null
  const entry = data.palette[data.blocks.get(dx + dz * b.width + dy * b.width * b.depth)]
  if (!RAILS.has((entry?.name || '').replace(/^minecraft:/, ''))) return null
  const exits = EXITS[entry.properties?.shape]
  return Array.isArray(exits) ? { x, y, z, exits } : null
}

function railBelow(data, x, y, z) {
  x = Math.floor(x); y = Math.floor(y); z = Math.floor(z)
  // Vanilla checks the block below first, including at the high end of a slope.
  return railAt(data, x, y - 1, z) || railAt(data, x, y, z)
}

function positionOnRail(data, x, y, z) {
  const rail = railBelow(data, x, y, z)
  if (!rail) return null
  const [a, b] = rail.exits
  const startX = rail.x + .5 + a[0] * .5, startY = rail.y + .0625 + a[1] * .5, startZ = rail.z + .5 + a[2] * .5
  const dx = (b[0] - a[0]) * .5, dy = b[1] - a[1], dz = (b[2] - a[2]) * .5
  const t = dx === 0 ? z - rail.z : dz === 0 ? x - rail.x : ((x - startX) * dx + (z - startZ) * dz) * 2
  return [startX + dx * t, startY + dy * t + (dy < 0 ? 1 : dy > 0 ? .5 : 0), startZ + dz * t]
}

function positionAlongRail(data, x, y, z, distance) {
  const rail = railBelow(data, x, y, z)
  if (!rail) return null
  const [a, b] = rail.exits, dx = b[0] - a[0], dz = b[2] - a[2], length = Math.hypot(dx, dz)
  y = rail.y + (a[1] !== b[1] ? 1 : 0)
  x += dx / length * distance; z += dz / length * distance
  for (const exit of [a, b]) {
    if (exit[1] !== 0 && Math.floor(x) - rail.x === exit[0] && Math.floor(z) - rail.z === exit[2]) {
      y += exit[1]; break
    }
  }
  return positionOnRail(data, x, y, z)
}

// This transform belongs only to the rendered cart, never its logical Pos or passengers.
// Vanilla lifts by 0.375 BEFORE rotating, then draws the model around that pivot.
export function minecartRenderPose(entity, data) {
  const [x, y, z] = entity.pos
  let yaw = Number(entity.rotation?.[0]) || 0, pitch = Number(entity.rotation?.[1]) || 0
  const offset = [0, .375, 0], center = positionOnRail(data, x, y, z)
  if (center) {
    const distance = Math.fround(.3)
    const front = positionAlongRail(data, x, y, z, distance) || center
    const back = positionAlongRail(data, x, y, z, -distance) || center
    offset[0] = center[0] - x
    offset[1] += (front[1] + back[1]) / 2 - y
    offset[2] = center[2] - z
    const dx = back[0] - front[0], dy = back[1] - front[1], dz = back[2] - front[2]
    const length = Math.hypot(dx, dy, dz)
    if (length !== 0) {
      yaw = Math.fround(Math.atan2(dz, dx) / DEG)
      pitch = Math.fround(Math.atan(dy / length) * 73)
    }
  }
  return { offset, yaw: Math.fround(180 - yaw) * DEG, pitch: -pitch * DEG }
}
