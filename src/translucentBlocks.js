import * as THREE from 'three'
import { blockFaceKeys, setBlockFaceKeys } from './selectionSources.js'
import { createFaceRadixSort } from './translucentFaceOrder.js'

const sorting = new WeakMap()
const identity = new THREE.Matrix4()

function canonicalQuads(indices) {
  for (let i = 0, base = 0; i < indices.length; i += 6, base += 4) {
    if (indices[i] !== base || indices[i + 1] !== base + 1 || indices[i + 2] !== base + 2 ||
      indices[i + 3] !== base + 2 || indices[i + 4] !== base + 1 || indices[i + 5] !== base + 3) return false
  }
  return true
}

function writeQuads(target, order, original) {
  if (original) {
    for (let i = 0, j = 0; j < target.length; i++, j += 6) {
      const k = order[i] * 6
      for (let c = 0; c < 6; c++) target[j + c] = original[k + c]
    }
  } else for (let i = 0, j = 0; j < target.length; i++, j += 6) {
    const base = (order ? order[i] : i) * 4
    target[j] = base; target[j + 1] = base + 1; target[j + 2] = base + 2
    target[j + 3] = base + 2; target[j + 4] = base + 1; target[j + 5] = base + 3
  }
}

function worldCenters(state, positions, matrix) {
  const { centers, point } = state, local = matrix.equals(identity)
  for (let i = 0, j = 0; j < centers.length; i += 12, j += 3) {
    const x = (positions[i] + positions[i + 9]) / 2, y = (positions[i + 1] + positions[i + 10]) / 2, z = (positions[i + 2] + positions[i + 11]) / 2
    if (local && Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) { centers[j] = x; centers[j + 1] = y; centers[j + 2] = z }
    else point.set(x, y, z).applyMatrix4(matrix).toArray(centers, j)
  }
}

function stillOrdered(order, distances) {
  for (let i = 1; i < order.length; i++) {
    const a = order[i - 1], b = order[i]
    if (distances[a] < distances[b] || (distances[a] === distances[b] && a > b)) return false
  }
  return true
}

// Block quads use 0,1,2 / 2,1,3 (unlike entity ModelPart quads). Keep their
// original triangles and sort all textures together, including the honey core.
class TranslucentBlockMesh extends THREE.Mesh {
  copy(source, recursive) {
    super.copy(source, recursive)
    // Cached frame instances need independent camera-dependent index buffers.
    this.geometry = source.geometry.clone()
    setBlockFaceKeys(this.geometry, blockFaceKeys(source.geometry))
    const state = sorting.get(source)
    if (state?.indices) this.geometry.index.array.set(state.indices)
    else if (state) writeQuads(this.geometry.index.array, null, null)
    sorting.delete(this)
    return this
  }

  onBeforeRender(_renderer, _scene, camera) {
    let state = sorting.get(this)
    const geometry = this.geometry, count = geometry.index.count / 6
    if (!state) {
      const distances = new Float64Array(count), index = geometry.index.array
      state = { centers: new Float64Array(count * 3), indices: canonicalQuads(index) ? null : index.slice(),
        order: Uint32Array.from({ length: count }, (_, i) => i), distances, radix: createFaceRadixSort(distances), world: new THREE.Matrix4(),
        point: new THREE.Vector3(), eye: new THREE.Vector3(), ready: false }
      sorting.set(this, state)
    }
    // Distance ordering depends on the eye position, not its viewing direction.
    // Turning in place leaves every distance and the uploaded index order exact.
    state.point.setFromMatrixPosition(camera.matrixWorld)
    const sameWorld = state.ready && state.world.equals(this.matrixWorld)
    if (sameWorld && state.eye.equals(state.point)) return
    state.eye.copy(state.point)
    if (!sameWorld) {
      worldCenters(state, geometry.attributes.position.array, this.matrixWorld)
      state.world.copy(this.matrixWorld); state.ready = true
    }
    const { centers, distances, order, eye } = state
    let finite = true
    for (let i = 0, j = 0; i < count; i++, j += 3) {
      const x = centers[j] - eye.x, y = centers[j + 1] - eye.y, z = centers[j + 2] - eye.z
      const distance = x * x + y * y + z * z
      distances[i] = distance
      if (!Number.isFinite(distance)) finite = false
    }
    if (state.radix && finite) {
      if (stillOrdered(order, distances)) return
      state.radix(order)
    } else {
      // Keep the original comparator (and previous order) for non-finite keys.
      order.sort((a, b) => distances[b] - distances[a] || a - b)
    }
    writeQuads(geometry.index.array, order, state.indices)
    geometry.index.needsUpdate = true
  }
}

function materialFor(maps) {
  const material = new THREE.MeshLambertMaterial({ map: maps[0], vertexColors: true,
    transparent: true, opacity: 1, alphaTest: .001, depthWrite: true, side: THREE.FrontSide, flatShading: true })
  // Also lets collectSceneResources retain/animate every borrowed pack texture.
  material.translucentMaps = maps
  material.userData.privateBlockMaterial = true
  material.customProgramCacheKey = () => 'translucent-block-maps-v1-' + maps.length
  material.onBeforeCompile = shader => {
    maps.forEach((map, i) => { shader.uniforms['blockMap' + i] = { value: map } })
    shader.vertexShader = 'attribute float blockTexture; attribute float blockUnlit; varying float vBlockTexture; varying float vBlockUnlit;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\nvBlockTexture = blockTexture; vBlockUnlit = blockUnlit;')
    shader.fragmentShader = 'varying float vBlockTexture; varying float vBlockUnlit;\n' +
      maps.map((_, i) => `uniform sampler2D blockMap${i};`).join('\n') + '\n' + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>',
      'vec4 blockSample;\n' + maps.map((_, i) => `${i ? 'else ' : ''}${i < maps.length - 1 ? `if (vBlockTexture < ${i + .5}) ` : ''}{ blockSample = texture2D(blockMap${i}, vMapUv); }`).join('\n') + '\ndiffuseColor *= blockSample;')
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>',
      'outgoingLight = mix(outgoingLight, diffuseColor.rgb, vBlockUnlit);\n#include <opaque_fragment>')
  }
  return material
}

// One draw call for the four vanilla slime/honey sprites, with real texture alpha
// and far-to-near faces. Sorting separate texture meshes loses the honey core.
// Sampling the existing textures also preserves animated/local resource packs.
export function mergeTranslucentBlocks(meshes, { disposeMaterials = false } = {}) {
  if (!meshes.length) return []
  const maps = [...new Set(meshes.map(mesh => mesh.material.map))]
  // WebGL2 guarantees 16 fragment samplers. Unusually complex replacement models
  // fall back to separately sortable quads rather than exceed the hardware limit.
  if (maps.length > 8) {
    const result = []
    for (const mesh of meshes) {
      for (let face = 0; face < mesh.geometry.index.count / 6; face++) {
        const geometry = new THREE.BufferGeometry()
        for (const [key, attr] of Object.entries(mesh.geometry.attributes)) {
          geometry.setAttribute(key, new THREE.BufferAttribute(attr.array.slice(face * 4 * attr.itemSize, (face + 1) * 4 * attr.itemSize), attr.itemSize))
        }
        geometry.setIndex([0, 1, 2, 2, 1, 3])
        setBlockFaceKeys(geometry, blockFaceKeys(mesh.geometry)?.slice(face, face + 1))
        result.push(...mergeTranslucentBlocks([new THREE.Mesh(geometry, mesh.material)]))
      }
    }
    release(meshes, disposeMaterials)
    return result
  }
  const count = meshes.reduce((n, mesh) => n + mesh.geometry.attributes.position.count, 0)
  const positions = new Float32Array(count * 3), uvs = new Float32Array(count * 2), colors = new Float32Array(count * 3)
  const textures = new Float32Array(count), unlit = new Float32Array(count), indices = new Uint32Array(count / 4 * 6)
  const sources = meshes.map(mesh => blockFaceKeys(mesh.geometry))
  const keys = sources.every(Boolean) ? new (sources.some(a => a instanceof Float64Array) ? Float64Array : Uint32Array)(count / 4) : null
  let vertex = 0, index = 0
  for (const mesh of meshes) {
    const g = mesh.geometry, m = mesh.material, size = g.attributes.position.count
    if (keys) keys.set(blockFaceKeys(g), vertex / 4)
    positions.set(g.attributes.position.array, vertex * 3); uvs.set(g.attributes.uv.array, vertex * 2)
    textures.fill(maps.indexOf(m.map), vertex, vertex + size)
    unlit.fill(m.isMeshBasicMaterial ? 1 : 0, vertex, vertex + size)
    const tint = m.color.toArray(), original = g.attributes.color
    for (let i = 0; i < size * 3; i++) colors[vertex * 3 + i] = tint[i % 3] * (original?.array[i] ?? 1)
    for (const value of g.index.array) indices[index++] = value + vertex
    vertex += size
  }
  const geometry = new THREE.BufferGeometry()
  for (const [key, array, size] of [['position', positions, 3], ['uv', uvs, 2], ['color', colors, 3], ['blockTexture', textures, 1], ['blockUnlit', unlit, 1]]) {
    geometry.setAttribute(key, new THREE.BufferAttribute(array, size))
  }
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))
  setBlockFaceKeys(geometry, keys)
  release(meshes, disposeMaterials)
  return [new TranslucentBlockMesh(geometry, materialFor(maps))]
}

function release(meshes, materials) {
  for (const geometry of new Set(meshes.map(mesh => mesh.geometry))) geometry.dispose()
  if (materials) for (const material of new Set(meshes.map(mesh => mesh.material))) material.dispose()
}
