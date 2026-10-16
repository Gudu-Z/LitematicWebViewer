import * as THREE from 'three'

// Minecraft 26.3 TextureTransform.ARMOR_ENTITY_GLINT_TEXTURING:
// T(-t%110000/110000, t%30000/30000) * Rz(10deg) * S(.16),
// t = floor(milliseconds * default glintSpeed(.5) * 8).
export function updateArmorGlintMatrix(matrix, age) {
  const time = Math.trunc(age * 50 * .5 * 8)
  const angle = Math.PI / 18, c = Math.cos(angle) * .16, s = Math.sin(angle) * .16
  matrix.set(c, -s, -(time % 110000) / 110000, s, c, (time % 30000) / 30000, 0, 0, 1)
}

// EquipmentLayerRenderer uses the entity shader on the first armor layer, or a
// separate depth-equal GLINT pass after trims. Both use the texture's own RGB,
// default GlintAlpha=.75, and SRC_COLOR/ONE (squared RGB), without a purple tint.
export function applyArmorGlint(material, texture, { overlay = false, blur = true } = {}) {
  const map = texture.clone()
  map.wrapS = map.wrapT = THREE.RepeatWrapping
  map.magFilter = map.minFilter = blur ? THREE.LinearFilter : THREE.NearestFilter
  map.generateMipmaps = false
  // Minecraft's glint shader samples the encoded texture values. Convert the
  // lit base to the same space for the addition, then return to Three's linear RGB.
  map.colorSpace = THREE.NoColorSpace
  map.matrixAutoUpdate = false
  material.glintMap = map // Keep the provider-owned Source visible to scene resource tracking.
  material.userData.updateGlint = age => updateArmorGlintMatrix(map.matrix, age)
  material.userData.updateGlint(0)
  material.onBeforeCompile = shader => {
    shader.uniforms.equipmentGlint = { value: map }
    shader.uniforms.equipmentGlintMatrix = { value: map.matrix }
    shader.vertexShader = 'uniform mat3 equipmentGlintMatrix;\nvarying vec2 equipmentGlintUv;\n' + shader.vertexShader.replace(
      '#include <uv_vertex>', '#include <uv_vertex>\nequipmentGlintUv = (equipmentGlintMatrix * vec3(uv, 1.0)).xy;')
    shader.fragmentShader = 'uniform sampler2D equipmentGlint;\nvarying vec2 equipmentGlintUv;\n' + shader.fragmentShader.replace(
      '#include <opaque_fragment>', `
        vec4 glintSample = texture2D(equipmentGlint, equipmentGlintUv);
        vec3 glintColor = glintSample.rgb * 0.75;
        ${overlay ? `
          if (glintSample.a < 0.1) discard;
          outgoingLight = sRGBTransferEOTF(vec4(glintColor, 1.0)).rgb;
          diffuseColor.a = glintSample.a;
        ` : `
          vec3 baseColor = sRGBTransferOETF(vec4(outgoingLight, 1.0)).rgb;
          outgoingLight = sRGBTransferEOTF(vec4(baseColor + glintColor * glintColor, 1.0)).rgb;
        `}
        #include <opaque_fragment>
      `)
  }
  material.customProgramCacheKey = () => 'equipment-glint-26.3-' + (overlay ? 'overlay' : 'base')
  const dispose = () => { map.dispose(); material.removeEventListener('dispose', dispose) }
  material.addEventListener('dispose', dispose)
  return material
}

export function trimmedArmorGlint(texture, options) {
  return applyArmorGlint(new THREE.MeshBasicMaterial({
    transparent: true, blending: THREE.CustomBlending,
    blendSrc: THREE.SrcColorFactor, blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    depthWrite: false, depthFunc: THREE.EqualDepth, side: THREE.DoubleSide,
    forceSinglePass: true, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  }), texture, { ...options, overlay: true })
}
