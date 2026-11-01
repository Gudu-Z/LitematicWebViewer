import * as THREE from 'three'

// Batch only runs in Three's *finished* draw order. A water surface, another
// transparent object or a different set of textures ends the run. The normal
// meshes remain the source of frustum tests, picking, layer visibility and export.
const COLUMNS = 64, TEXELS = 5

function batchMaterial(source, maps, matrices) {
  const material = source.clone()
  material.map = maps[0]
  material.customProgramCacheKey = () => 'sorted-signs-v1:' + maps.length
  material.onBeforeCompile = shader => {
    shader.uniforms.signViews = { value: matrices }
    shader.vertexShader = 'uniform highp sampler2D signViews;\nflat varying int signMapId;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
      int signIndex = int(modelMatrix[3].x) + gl_InstanceID;
      ivec2 p = ivec2((signIndex & ${COLUMNS - 1}) * ${TEXELS}, signIndex >> ${Math.log2(COLUMNS)});
      mat4 signView = mat4(texelFetch(signViews, p, 0), texelFetch(signViews, p + ivec2(1,0), 0),
        texelFetch(signViews, p + ivec2(2,0), 0), texelFetch(signViews, p + ivec2(3,0), 0));
      signMapId = int(texelFetch(signViews, p + ivec2(4,0), 0).x);
      vec4 mvPosition = signView * vec4(transformed, 1.0);
      gl_Position = projectionMatrix * mvPosition;
    `)
    let declarations = 'flat varying int signMapId;\n', sample = ''
    for (let i = 0; i < maps.length; i++) {
      const name = i ? 'signMap' + i : 'map'
      if (i) { declarations += 'uniform sampler2D ' + name + ';\n'; shader.uniforms[name] = { value: maps[i] } }
      sample += (i ? 'else ' : '') + (i === maps.length - 1 ? '' : `if (signMapId == ${i}) `) + `{ diffuseColor *= texture2D(${name}, vMapUv); }\n`
    }
    shader.fragmentShader = declarations + shader.fragmentShader.replace('#include <map_fragment>', sample)
  }
  return material
}

export function installSignDrawBatches(scene, group, renderer) {
  const count = group.children.length, caps = renderer?.capabilities
  // Bound the camera-matrix table to 10 MiB; larger sets keep their original draws.
  if (!scene?.isScene || count < 256 || count > 131072 || !renderer?.renderLists?.get
    || !(caps?.maxVertexTextures >= 1) || !(caps.maxTextures >= 2) || caps.maxTextureSize < Math.max(COLUMNS * TEXELS, Math.ceil(count / COLUMNS))) return
  const geometry = group.children[0].geometry, slots = new Map(), sources = new WeakMap(), pages = []
  const pageSize = Math.min(32, caps.maxTextures - 1)
  // These are the private, immutable, otherwise identical label materials made
  // by renderSigns. No atlas or resampling: each slot borrows its original map.
  for (const mesh of group.children) {
    const mat = mesh.material
    if (mesh.geometry !== geometry || !mat?.isMeshBasicMaterial || !mat.transparent || !mat.forceSinglePass
      || mat.side !== THREE.DoubleSide || !mat.map?.isCanvasTexture) return
    if (mat.onBeforeRender !== THREE.Material.prototype.onBeforeRender || mat.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile) continue
    let slot = slots.get(mat)
    if (!slot) {
      const index = slots.size
      if (index % pageSize === 0) pages.push({ maps: [], source: mat })
      const page = pages.at(-1)
      slot = { page, id: page.maps.length, material: mat }
      slots.set(mat, slot); page.maps.push(mat.map)
    }
    sources.set(mesh, slot)
  }
  // Avoid allocating many materials for schematics with mostly unique labels.
  if (!pages.length || slots.size * 4 > count) return
  const width = COLUMNS * TEXELS, height = Math.ceil(count / COLUMNS)
  const pixels = new Float32Array(width * height * 4)
  const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, THREE.FloatType)
  const view = new THREE.Matrix4(), runs = []
  for (const page of pages) page.material = batchMaterial(page.source, page.maps, texture)
  // Draw an existing plane buffer, already prepared by Three while projecting
  // its source meshes. gl_InstanceID addresses the per-draw slice. No instance
  // matrix attribute is needed: preserve Three's CPU-double modelView product.
  const proxy = new THREE.InstancedMesh(geometry, pages[0].material, 0)
  proxy.layers.enableAll()
  proxy.onBeforeRender = (_r, _s, _c, _g, _m, run) => {
    proxy.count = run.instances
    proxy.matrixWorld.elements[12] = run.first
  }
  const get = item => {
    const mesh = item.object, slot = sources.get(mesh)
    return slot && slot.material === item.material && geometry === item.geometry && !item.group
      && mesh.onBeforeRender === THREE.Object3D.prototype.onBeforeRender && mesh.onAfterRender === THREE.Object3D.prototype.onAfterRender
      && item.material.onBeforeRender === THREE.Material.prototype.onBeforeRender
      && item.material.onBeforeCompile === THREE.Material.prototype.onBeforeCompile ? slot : null
  }
  function pack(list, camera) {
    let read = 0, write = 0, instances = 0, nRuns = 0
    while (read < list.length) {
      const item = list[read], first = get(item)
      if (!first) { list[write++] = item; read++; continue }
      let end = read + 1
      while (end < list.length && get(list[end])?.page === first.page) end++
      if (end - read < 2) { list[write++] = item; read++; continue }
      const batch = runs[nRuns] ??= { object: proxy, geometry, group: { start: 0, count: 6 } }
      nRuns++; batch.material = first.page.material
      batch.group.first = instances; batch.group.instances = end - read
      for (; read < end; read++) {
        const mesh = list[read].object, offset = instances++ * TEXELS * 4
        view.multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld).toArray(pixels, offset)
        pixels[offset + 16] = sources.get(mesh).id
      }
      list[write++] = batch
    }
    list.length = write
    if (instances) texture.needsUpdate = true
  }
  // The WebGL render list has no after-sort callback. Intercept exactly the
  // next top-level sort, then immediately restore it. Unsupported renderers,
  // other cameras/contexts (e.g. export) and unsorted passes draw normally.
  let restore, disposed = false
  const previous = scene.onBeforeRender
  function before(gl, currentScene, camera, ...rest) {
    previous.call(this, gl, currentScene, camera, ...rest)
    restore?.()
    if (disposed || gl !== renderer || !group.visible || currentScene.overrideMaterial || currentScene.environment
      || camera.isArrayCamera || gl.xr?.isPresenting || gl.shadowMap?.enabled || !gl.sortObjects) return
    const list = gl.renderLists.get(currentScene, 0), sort = list?.sort
    if (typeof sort !== 'function' || !Array.isArray(list.transparent)) return
    const once = function (...args) {
      restore()
      sort.apply(list, args)
      pack(list.transparent, camera)
    }
    restore = () => { if (list.sort === once) list.sort = sort; restore = null }
    list.sort = once
  }
  scene.onBeforeRender = before
  return () => {
    if (disposed) return
    disposed = true
    restore?.()
    if (scene.onBeforeRender === before) scene.onBeforeRender = previous
    texture.dispose(); proxy.dispose()
    for (const page of pages) page.material.dispose()
  }
}
