import * as THREE from 'three'
import { FACE_BATCH_SIZE, compactFaceKey, readCompactFace } from './compactFaceData.js'
import { copySpatialFaces } from './spatialFaces.js'

const declarations = `
attribute uint compactCell;
#ifdef COMPACT_SEPARATE_Y
attribute uint compactCellY;
#endif
attribute uint compactTemplate;
uniform highp sampler2D compactQuads;
uniform uvec3 compactDimensions;
uniform ivec3 compactMinimum;
uniform int compactWidth;
vec4 compactTexel(int index) {
  return texelFetch(compactQuads, ivec2(index % compactWidth, index / compactWidth), 0);
}
`
const readVertex = `
int compactIndex = int(compactTemplate & 0x7fffffffu) * 8 + gl_VertexID * 2;
vec4 compactA = compactTexel(compactIndex);
vec4 compactB = compactTexel(compactIndex + 1);
uint compactYZ = compactCell / compactDimensions.x;
#ifdef COMPACT_SEPARATE_Y
uint compactY = compactCellY;
#else
uint compactY = compactYZ / compactDimensions.z;
#endif
ivec3 compactOrigin = ivec3(compactCell % compactDimensions.x, compactY,
  compactYZ % compactDimensions.z) + compactMinimum;
if ((compactTemplate & 0x80000000u) != 0u) compactOrigin = ivec3(0);
#ifdef USE_MAP
  vMapUv = (mapTransform * vec3(compactA.w, compactB.w, 1.0)).xy;
#endif
`

function boxFor(data, offset, box) {
  const cells = data.cellBounds
  // Outward padding covers Float32 rounding of the legacy world vertices.
  const epsilon = Math.max(1, ...data.modelMin.map(Math.abs), ...data.modelMax.map(Math.abs),
    ...Array.from(cells.subarray(offset, offset + 6), Math.abs)) * 2 ** -22
  box.min.set(cells[offset] + data.modelMin[0] - epsilon, cells[offset + 1] + data.modelMin[1] - epsilon, cells[offset + 2] + data.modelMin[2] - epsilon)
  box.max.set(cells[offset + 3] + data.modelMax[0] + epsilon, cells[offset + 4] + data.modelMax[1] + epsilon, cells[offset + 5] + data.modelMax[2] + epsilon)
  return box
}

export class CompactFaceMesh extends THREE.Mesh {
  constructor(data, material) {
    if (!data) { super(); this.isCompactFaceMesh = true; return }
    const geometry = new THREE.InstancedBufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0,0,1, 0,0,1, 0,0,1, 0,0,1]), 3))
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(8), 2))
    geometry.setIndex([0, 1, 2, 2, 1, 3])
    for (const [name, array] of [['compactCell', data.cells], ['compactTemplate', data.templateIds], ['compactCellY', data.cellYs]]) {
      if (!array) continue
      const attribute = new THREE.InstancedBufferAttribute(array, 1); attribute.gpuType = THREE.IntType
      geometry.setAttribute(name, attribute)
    }
    geometry.instanceCount = data.count
    geometry.boundingBox = new THREE.Box3()
    // Export framing needs the exact rendered bounds, not the conservative
    // combination of every cell with every model used by raycast batches.
    geometry.boundingBox.min.fromArray(data.worldBounds)
    geometry.boundingBox.max.fromArray(data.worldBounds, 3)
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere())
    const texture = new THREE.DataTexture(data.templateData, data.textureWidth, data.textureHeight, THREE.RGBAFormat, THREE.FloatType)
    texture.needsUpdate = true
    geometry.addEventListener('dispose', () => texture.dispose())
    const b = data.bounds
    const uniforms = {
      compactQuads: { value: texture }, compactWidth: { value: data.textureWidth },
      compactDimensions: { value: new Uint32Array([b.width, b.height, b.depth]) },
      compactMinimum: { value: new Int32Array([b.minX, b.minY, b.minZ]) },
    }
    material.uniforms ||= {}
    for (const [key, uniform] of Object.entries(uniforms)) {
      if (material.uniforms[key]) material.uniforms[key].value = uniform.value
      else material.uniforms[key] = uniform
    }
    material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, material.uniforms)
      shader.vertexShader = (data.cellYs ? '#define COMPACT_SEPARATE_Y\n' : '') + shader.vertexShader.replace('#include <common>', '#include <common>\n' + declarations)
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n' + readVertex)
        .replace('#include <begin_vertex>', 'vec3 transformed = vec3(compactOrigin + ivec3(compactB.xyz)) + compactA.xyz;')
    }
    material.customProgramCacheKey = () => data.cellYs ? 'compact-block-faces-v2-xz-y' : 'compact-block-faces-v2-xyz'
    material.needsUpdate = true
    super(geometry, material)
    this.isCompactFaceMesh = true; this.compactData = data
  }

  copy(source, recursive) { super.copy(source, recursive); this.compactData = source.compactData; return copySpatialFaces(this, source) }

  // Keep exact triangle/UV picking without expanding all instances. Coarse
  // original-order batches discard most faces before the per-cell/triangle test.
  raycast(raycaster, hits) {
    const data = this.compactData, inverse = new THREE.Matrix4().copy(this.matrixWorld).invert()
    const ray = raycaster.ray.clone().applyMatrix4(inverse)
    if (!ray.intersectsBox(this.geometry.boundingBox)) return
    const geometry = new THREE.BufferGeometry(), positions = new Float32Array(12), uvs = new Float32Array(8)
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2)); geometry.setIndex([0, 1, 2, 2, 1, 3])
    const proxy = new THREE.Mesh(geometry, Array.isArray(this.material) ? this.material[0] : this.material), box = new THREE.Box3(), cellBox = new THREE.Box3(), results = []
    const modelMagnitude = Math.max(1, ...data.modelMin.map(Math.abs), ...data.modelMax.map(Math.abs))
    proxy.matrixWorld.copy(this.matrixWorld)
    for (let batch = 0; batch < data.cellBounds.length / 6; batch++) {
      if (!ray.intersectsBox(boxFor(data, batch * 6, box))) continue
      let previous = -1, selected = false
      for (let i = batch * FACE_BATCH_SIZE; i < Math.min(data.count, (batch + 1) * FACE_BATCH_SIZE); i++) {
        const key = compactFaceKey(data, i), b = data.bounds
        if (key !== previous) {
          const x = key % b.width + b.minX, y = Math.floor(key / (b.width * b.depth)) + b.minY, z = Math.floor(key / b.width) % b.depth + b.minZ
          cellBox.min.set(x + data.modelMin[0], y + data.modelMin[1], z + data.modelMin[2])
          cellBox.max.set(x + data.modelMax[0], y + data.modelMax[1], z + data.modelMax[2])
          cellBox.expandByScalar(Math.max(modelMagnitude, Math.abs(x), Math.abs(y), Math.abs(z)) * 2 ** -22)
          selected = ray.intersectsBox(cellBox); previous = key
        }
        if (!selected) continue
        readCompactFace(data, i, positions, uvs); geometry.computeBoundingSphere()
        results.length = 0; proxy.raycast(raycaster, results)
        for (const hit of results) hits.push({ ...hit, object: this, compactBlockKey: key, faceIndex: i * 2 + hit.faceIndex })
      }
    }
    geometry.dispose()
  }
}
