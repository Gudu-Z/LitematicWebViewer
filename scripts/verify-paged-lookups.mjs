import assert from 'node:assert/strict'
import { PagedBlockStore, encodeBlockPage, blockPageBytes, BLOCK_PAGE_SIZE } from '../src/pagedBlocks.js'
import { serializeSchematic, deserializeSchematic } from '../src/workerProtocol.js'

function createRegion(position, dimensions, localToGlobal, valueAt) {
  const [minX, minY, minZ] = position, [width, height, depth] = dimensions, volume = width * height * depth
  const values = Uint32Array.from({ length: volume }, (_, index) => valueAt(index % width, Math.floor(index / (width * depth)), Math.floor(index / width) % depth))
  const counts = new Float64Array(localToGlobal.length), pages = []
  for (const value of values) if (value) counts[value - 1]++
  for (let base = 0; base < volume; base += BLOCK_PAGE_SIZE) pages.push(encodeBlockPage(values.subarray(base, base + BLOCK_PAGE_SIZE)))
  return { minX, minY, minZ, maxX: minX + width - 1, maxY: minY + height - 1, maxZ: minZ + depth - 1,
    width, height, depth, localToGlobal, values,
    states: { pages, volume, count: counts.reduce((a, b) => a + b, 0), counts, bytes: pages.reduce((sum, page) => sum + blockPageBytes(page), 0) } }
}
function verify(bounds, regions) {
  const map = new Map(), W = bounds.width, D = bounds.depth, stride = W * D
  for (const r of regions) for (let index = 0; index < r.values.length; index++) {
    const value = r.values[index]
    if (!value) continue
    const x = index % r.width + r.minX - bounds.minX, z = Math.floor(index / r.width) % r.depth + r.minZ - bounds.minZ
    const y = Math.floor(index / (r.width * r.depth)) + r.minY - bounds.minY
    map.set(x + z * W + y * stride, r.localToGlobal[value - 1])
  }
  const store = new PagedBlockStore(regions, bounds, 8)
  const restored = deserializeSchematic(structuredClone(serializeSchematic({ blocks: store, bounds }))).blocks
  for (const blocks of [store, restored]) {
    assert.equal(blocks.size, map.size)
    assert.deepEqual([...blocks], [...map], 'Preserve first insertion slots with last non-air values')
    const entries = [...blocks]
    assert.equal(new Set(entries).size, entries.length, 'Public iteration returns independent entry tuples')
    for (let gi = 0; gi < 8; gi++) {
      const wanted = Uint8Array.from({ length: 8 }, (_, i) => i === gi)
      assert.deepEqual([...blocks.entriesForPalette(wanted)], [...map].filter(([, value]) => value === gi))
    }
    for (const [key] of map) {
      const x = key % W, z = Math.floor(key / W) % D, y = Math.floor(key / stride)
      for (const [dx, dy, dz] of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const nx = x + dx, ny = y + dy, nz = z + dz
        const expected = nx < 0 || ny < 0 || nz < 0 || nx >= W || ny >= bounds.height || nz >= D ? undefined : map.get(nx + nz * W + ny * stride)
        assert.equal(blocks.getAt(nx, ny, nz), expected)
        if (nx >= 0 && ny >= 0 && nz >= 0 && nx < W && ny < bounds.height && nz < D) assert.equal(blocks.get(nx + nz * W + ny * stride), expected)
      }
    }
    for (const point of [[-1, 0, 0], [W, 0, 0], [0, bounds.height, 0], [0, 0, D], [.5, 0, 0], [0, NaN, 0], [0, 0, Infinity]]) assert.equal(blocks.getAt(...point), undefined)
    for (const key of [-1, .5, NaN, Infinity, stride * bounds.height]) assert.equal(blocks.get(key), undefined)
    // Repeated empty/missing coarse cells must not reuse a previous cell's list.
    for (const point of [[127, 0, 127], [128, 0, 128], [256, 0, 256], [0, 0, 0], [128, 0, 128]]) {
      const [x, y, z] = point
      if (x < W && y < bounds.height && z < D) assert.equal(blocks.getAt(x, y, z), map.get(x + z * W + y * stride))
    }
  }
}
verify({ minX: -13, minY: -7, minZ: 21, width: 17, height: 18, depth: 19 }, [
  createRegion([-13, -7, 21], [17, 18, 19], [0, 4, 2], (x, y, z) => (x + y + z) % 5 ? 1 + (x + z) % 3 : 0),
])
verify({ minX: -130, minY: 9, minZ: -130, width: 384, height: 3, depth: 384 }, [
  createRegion([-4, 9, -4], [6, 3, 6], [0, 1], (x, y, z) => (x + y + z) % 4 ? 1 : 0),
  createRegion([-3, 9, -3], [5, 3, 5], [6, 4], (x, y, z) => (x + y + z) % 3 ? 1 : 0),
  createRegion([126, 9, 126], [3, 1, 3], [5], () => 1),
])
verify({ minX: -100000, minY: -1, minZ: -100000, width: 100000, height: 3, depth: 100000 }, [
  createRegion([-33000, 0, -40000], [8, 2, 9], [7, 2], (x, y, z) => (x + y + z) % 3 ? 1 : 0),
  createRegion([-32997, 0, -39996], [5, 1, 4], [3], () => 1),
])
console.log('PASS paged coordinate lookup: independent Map oracle, overlapping air/order, coarse boundaries/missing cells, wide keys, palette masks, independent tuples and worker hydration')
