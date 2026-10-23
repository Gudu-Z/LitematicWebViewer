import * as THREE from 'three'

const CHUNK_SIZE = 32
const MAX_INSTANCES = 1024
const batchRecords = new WeakMap()

function preciseMaterial(source, capacity) {
  // Match the ordinary Mesh path: Three computes modelView/normal matrices in
  // doubles before uploading floats. Multiplying two float matrices in the
  // instanced shader otherwise shifts cutout/AA edges and large-coordinate detail.
  const texture = new THREE.DataTexture(new Float32Array(capacity * 32), 8, capacity, THREE.RGBAFormat, THREE.FloatType)
  const material = source.clone()
  material.onBeforeCompile = shader => {
    shader.uniforms.frameViewMatrices = { value: texture }
    shader.vertexShader = `uniform highp sampler2D frameViewMatrices;
      mat4 frameModelView() {
        return mat4(texelFetch(frameViewMatrices, ivec2(0, gl_InstanceID), 0),
          texelFetch(frameViewMatrices, ivec2(1, gl_InstanceID), 0),
          texelFetch(frameViewMatrices, ivec2(2, gl_InstanceID), 0),
          texelFetch(frameViewMatrices, ivec2(3, gl_InstanceID), 0));
      }
      mat3 frameNormalMatrix() {
        return mat3(texelFetch(frameViewMatrices, ivec2(4, gl_InstanceID), 0).xyz,
          texelFetch(frameViewMatrices, ivec2(5, gl_InstanceID), 0).xyz,
          texelFetch(frameViewMatrices, ivec2(6, gl_InstanceID), 0).xyz);
      }
      ` + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
      vec4 mvPosition = frameModelView() * vec4(transformed, 1.0);
      gl_Position = projectionMatrix * mvPosition;
    `).replace('#include <defaultnormal_vertex>', `
      vec3 transformedNormal = frameNormalMatrix() * objectNormal;
      #ifdef FLIP_SIDED
        transformedNormal = -transformedNormal;
      #endif
    `)
  }
  material.customProgramCacheKey = () => 'precise-item-frame-v1'
  return { material, texture }
}

function attachViewMatrices(batch, records, texture) {
  const view = new THREE.Matrix4(), normal = new THREE.Matrix3(), lastView = new THREE.Matrix4()
  let lastVersion = -1
  batch.onBeforeRender = (_renderer, _scene, camera) => {
    // Static frames do not need another matrix upload until the camera or the
    // visible instance set changes. Export can use a second camera/context.
    if (lastVersion === batch.instanceMatrix.version && lastView.equals(camera.matrixWorldInverse)) return
    lastVersion = batch.instanceMatrix.version
    lastView.copy(camera.matrixWorldInverse)
    const pixels = texture.image.data
    let index = 0
    for (const record of records) {
      if (!record.root.visible) continue
      view.multiplyMatrices(camera.matrixWorldInverse, record.world)
      view.toArray(pixels, index * 32)
      normal.getNormalMatrix(view)
      for (let column = 0; column < 3; column++) {
        for (let row = 0; row < 3; row++) pixels[index * 32 + 16 + column * 4 + row] = normal.elements[column * 3 + row]
      }
      index++
    }
    texture.needsUpdate = true
  }
  batch.addEventListener('dispose', () => texture.dispose())
}

// Call only after a static object has its final parent and transforms. Animated
// entities/rigs keep the normal update path, including their attachments.
export function freezeStaticObject(root) {
  root.updateWorldMatrix(true, true, true)
  root.traverse(object => {
    object.matrixAutoUpdate = false
    object.matrixWorldAutoUpdate = false
  })
}

function eligible(mesh) {
  const material = mesh.material
  return mesh.isMesh && !mesh.isSkinnedMesh && !mesh.isInstancedMesh && material && !Array.isArray(material)
    && (material.isMeshLambertMaterial || material.isMeshBasicMaterial)
    && !material.transparent && material.blending === THREE.NormalBlending
    && !mesh.morphTargetInfluences && !mesh.userData.updateAnimation
    && mesh.onBeforeRender === THREE.Object3D.prototype.onBeforeRender
    && mesh.matrixWorld.determinant() > 0
}

function pruneEmptyGroups(root) {
  for (const child of [...root.children]) {
    pruneEmptyGroups(child)
    if (child.isGroup && !child.children.length) root.remove(child)
  }
}

// Logical frame roots stay in the entity group for layer visibility and F3+B.
// Only repeated, static, opaque/cutout meshes move into spatial render batches.
export function batchItemFrames(group, frames) {
  if (!frames.length) return
  group.updateWorldMatrix(true, true)
  const groups = new Map(), inverseParent = group.matrixWorld.clone().invert()
  for (const root of frames) {
    root.traverse(mesh => {
      if (!eligible(mesh)) return
      for (let node = mesh; node !== root; node = node.parent) if (!node.visible) return
      const e = mesh.matrixWorld.elements
      const origin = [e[12], e[13], e[14]].map(v => Math.floor(v / CHUNK_SIZE) * CHUNK_SIZE)
      const key = `${mesh.geometry.id}:${mesh.material.id}:${mesh.renderOrder}:${mesh.layers.mask}:${origin}`
      let bucket = groups.get(key)
      if (!bucket) groups.set(key, bucket = { origin, meshes: [] })
      bucket.meshes.push({ mesh, root })
    })
  }
  const buckets = [...groups.values()].flatMap(({ origin, meshes }) => {
    const parts = []
    for (let i = 0; i < meshes.length; i += MAX_INSTANCES) parts.push({ origin, meshes: meshes.slice(i, i + MAX_INSTANCES) })
    return parts
  })
  for (const { origin, meshes } of buckets) {
    if (meshes.length < 2) continue
    const first = meshes[0].mesh
    const { material, texture } = preciseMaterial(first.material, meshes.length)
    const batch = new THREE.InstancedMesh(first.geometry, material, meshes.length)
    batch.name = 'item-frame-batch'
    batch.userData.isFrameBatch = true
    batch.renderOrder = first.renderOrder
    batch.layers.mask = first.layers.mask
    // Keep the large world translation in a double-precision Object3D matrix.
    // GPU instance translations stay within a small chunk even at ±30M blocks.
    batch.matrix.multiplyMatrices(inverseParent, new THREE.Matrix4().makeTranslation(...origin))
    batch.matrixAutoUpdate = false
    const records = meshes.map(({ mesh, root }) => {
      const world = mesh.matrixWorld.clone(), matrix = world.clone()
      matrix.elements[12] -= origin[0]
      matrix.elements[13] -= origin[1]
      matrix.elements[14] -= origin[2]
      mesh.removeFromParent()
      return { root, matrix, world }
    })
    batchRecords.set(batch, records)
    attachViewMatrices(batch, records, texture)
    group.add(batch)
    freezeStaticObject(batch)
  }
  for (const frame of frames) {
    pruneEmptyGroups(frame)
    freezeStaticObject(frame)
  }
  updateFrameBatches(group)
}

export function updateFrameBatches(group) {
  for (const batch of group.children) {
    const records = batchRecords.get(batch)
    if (!records) continue
    let count = 0
    for (const { root, matrix } of records) if (root.visible) batch.setMatrixAt(count++, matrix)
    batch.count = count
    batch.visible = count > 0
    batch.instanceMatrix.needsUpdate = true
    batch.computeBoundingBox()
    batch.computeBoundingSphere()
  }
}

// Raycaster instanceId follows the compacted visible instances, not the original
// record index. Hidden layers must never resolve to a different frame's NBT.
export function frameInstanceRoot(batch, instanceId) {
  if (!Number.isInteger(instanceId) || instanceId < 0) return null
  let index = 0
  for (const record of batchRecords.get(batch) || []) {
    if (record.root.visible && index++ === instanceId) return record.root
  }
  return null
}
