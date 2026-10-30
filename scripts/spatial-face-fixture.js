import { CompactFaceData } from '../src/compactFaceData.js'

// Asset-free shapes shared by CPU and browser regression. Positions deliberately
// revisit earlier clusters: spatial grouping must never reorder these faces.
export function spatialFixture({ repetitions = 4096, wide = false, layered = false } = {}) {
  const bounds = wide
    ? { minX: -2560, minY: -64, minZ: -3328, width: 5120, height: 256, depth: 6656 }
    : { minX: -512, minY: -8, minZ: -512, width: 1024, height: 32, depth: 1024 }
  const clusters = wide ? [[10, 8, 12], [2050, 132, 3010], [5090, 248, 6620]]
    : [[20, 4, 20], [500, 12, 500], [950, 20, 950]]
  const quads = [
    { verts: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]], uvs: [[0, 0], [1, 0], [0, 1], [1, 1]] },
    // Reverse UV orientation on the same plane exposes changes in coplanar order.
    { verts: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]], uvs: [[1, 0], [0, 0], [1, 1], [0, 1]] },
    // This model intersects the view while its source cell can be outside it.
    { verts: [[-18, -.125, -.000001], [19, -.125, -.000001], [-18, 1.234567, -.000001], [19, 1.234567, -.000001]],
      uvs: [[0, 0], [1, 0], [0, 1], [1, 1]] },
  ]
  const faces = [], phases = [0, 1, 2, 0, 2, 1]
  for (const [phase, clusterIndex] of phases.entries()) for (let i = 0; i < repetitions; i++) {
    const [cx, cy, cz] = clusters[clusterIndex]
    const x = cx + i % 8, y = cy + Math.floor(i / 8) % 2, z = cz + Math.floor(i / 16) % 3
    const key = x + z * bounds.width + y * bounds.width * bounds.depth
    const quad = layered ? { ...quads[i % 2], verts: quads[i % 2].verts.map(vertex => [vertex[0], vertex[1], vertex[2] + phase / 8]) }
      : quads[i % quads.length]
    faces.push({ key, x: x + bounds.minX, y: y + bounds.minY, z: z + bounds.minZ, quad })
  }
  const data = new CompactFaceData(faces.length, bounds)
  for (const face of faces) data.write(face.quad, face.x, face.y, face.z, face.key)
  data.finish()
  return { data, faces, bounds, clusters: clusters.map(([x, y, z]) => [x + bounds.minX + 4, y + bounds.minY + 1, z + bounds.minZ + 1]) }
}

export function exactPositions(faces) {
  return Float32Array.from(faces.flatMap(face => face.quad.verts.flatMap(vertex => [
    vertex[0] + face.x, vertex[1] + face.y, vertex[2] + face.z,
  ])))
}
