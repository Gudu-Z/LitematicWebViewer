// Pixel-level animation checks, including seek/backward ages used by image export.
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { animateTexture } from '../src/textureAnimation.js'
import { AssetProvider } from '../src/assets.js'

const originalDocument = globalThis.document
const contexts = []
globalThis.document = {
  createElement(tag) {
    assert.equal(tag, 'canvas')
    const canvas = { width: 0, height: 0 }
    canvas.getContext = type => {
      assert.equal(type, '2d')
      const pixels = new Uint8ClampedArray(canvas.width * canvas.height * 4)
      const counts = { reads: 0, allocations: 0, writes: 0, draws: 0, buffers: new Set() }
      const context = {
        pixels, counts,
        clearRect() { pixels.fill(0) },
        drawImage(source, sx, sy, width, height, dx, dy, dw, dh) {
          assert.deepEqual([dx, dy, dw, dh], [0, 0, canvas.width, canvas.height])
          assert.deepEqual([width, height], [canvas.width, canvas.height])
          for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            const offset = ((sy + y) * source.width + sx + x) * 4
            pixels.set(source.pixels.subarray(offset, offset + 4), (y * width + x) * 4)
          }
          counts.draws++
        },
        getImageData() { counts.reads++; return { data: pixels.slice() } },
        createImageData(width, height) {
          counts.allocations++
          return { data: new Uint8ClampedArray(width * height * 4) }
        },
        putImageData(value) {
          counts.writes++; counts.buffers.add(value)
          pixels.set(value.data)
        },
      }
      contexts.push(context)
      return context
    }
    return canvas
  },
}

function sourceImage(width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 71 + Math.floor(i / 4) * 13 + 29) % 256
  return { width, height, pixels }
}

// The expected image is calculated directly from the original atlas, without the production canvas or cached frame pixels.
function expectedImage(source, width, height, frames, interpolate, age) {
  const duration = frames.reduce((sum, f) => sum + f.time, 0)
  let time = ((Math.floor(age) % duration) + duration) % duration, index = 0
  while (time >= frames[index].time) time -= frames[index++].time
  const columns = Math.floor(source.width / width)
  const framePixels = frame => {
    const result = new Uint8ClampedArray(width * height * 4)
    const sx = frame % columns * width, sy = Math.floor(frame / columns) * height
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const from = ((sy + y) * source.width + sx + x) * 4
      result.set(source.pixels.subarray(from, from + 4), (y * width + x) * 4)
    }
    return result
  }
  const a = framePixels(frames[index].index)
  if (interpolate && time) {
    const b = framePixels(frames[(index + 1) % frames.length].index), fraction = time / frames[index].time
    for (let i = 0; i < a.length; i++) if (i % 4 !== 3) a[i] = a[i] * (1 - fraction) + b[i] * fraction
  }
  return { pixels: a, state: index + ':' + (interpolate ? time : 0) }
}

const cases = [
  {
    label: 'grid with repeated source frames and different durations', source: sourceImage(6, 4), width: 2, height: 2,
    metadata: { width: 2, height: 2, interpolate: true, frames: [{ index: 4, time: 4 }, { index: 1, time: 3 }, { index: 4, time: 2 }, { index: 5, time: 5 }] },
    frames: [{ index: 4, time: 4 }, { index: 1, time: 3 }, { index: 4, time: 2 }, { index: 5, time: 5 }],
  },
  {
    label: 'frame stepping without interpolation', source: sourceImage(6, 4), width: 2, height: 2,
    metadata: { width: 2, height: 2, frametime: 3, frames: [5, 0, 5, 2] },
    frames: [5, 0, 5, 2].map(index => ({ index, time: 3 })),
  },
  {
    label: 'implicit vertical atlas', source: sourceImage(2, 6), width: 2, height: 2,
    metadata: { frametime: 2, interpolate: true }, frames: [0, 1, 2].map(index => ({ index, time: 2 })),
  },
  {
    label: 'implicit horizontal atlas', source: sourceImage(6, 2), width: 2, height: 2,
    metadata: { frametime: 4, interpolate: true }, frames: [0, 1, 2].map(index => ({ index, time: 4 })),
  },
  {
    label: 'non-square frames', source: sourceImage(6, 4), width: 3, height: 2,
    metadata: { width: 3, height: 2, interpolate: true }, frames: [0, 1, 2, 3].map(index => ({ index, time: 1 })),
  },
  {
    label: 'invalid frame entries and zero-duration fallback', source: sourceImage(6, 4), width: 2, height: 2,
    metadata: { width: 2, height: 2, interpolate: true, frames: [-1, 12, .5, { index: 3, time: -2 }, { index: 1, time: 3 }, { index: 0, time: 0 }] },
    frames: [{ index: 1, time: 3 }, { index: 0, time: 1 }],
  },
]
let pixelChecks = 0
try {
  for (const fixture of cases) {
    const { source, width, height, frames, metadata, label } = fixture
    const texture = new THREE.Texture()
    animateTexture(texture, source, metadata)
    const context = contexts.at(-1), initial = expectedImage(source, width, height, frames, metadata.interpolate, 0)
    assert.deepEqual(context.pixels, initial.pixels, label + ' initial frame')
    assert.equal(context.counts.reads, metadata.interpolate ? new Set(frames.map(f => f.index)).size : 0,
      label + ' must read each distinct source frame at most once')
    let lastState = initial.state, versions = texture.version
    const ages = [...Array.from({ length: 100 }, (_, i) => i / 4), 10000.2, 3.9, 3.1, -1, -1.7, -20, 0, 12, 100, 12, 0]
    for (const age of ages) {
      const expected = expectedImage(source, width, height, frames, metadata.interpolate, age)
      texture.userData.updateAnimation(age)
      assert.deepEqual(context.pixels, expected.pixels, label + ' age=' + age)
      if (expected.state !== lastState) versions++
      assert.equal(texture.version, versions, label + ' uploads only when its displayed frame changes')
      lastState = expected.state
      pixelChecks++
    }
    const interpolates = metadata.interpolate && frames.some(f => f.time > 1)
    assert.equal(context.counts.allocations, interpolates ? 1 : 0, label + ' must reuse one interpolation buffer')
    assert.equal(context.counts.buffers.size, interpolates ? 1 : 0, label + ' must submit that same buffer each time')
    texture.dispose()
  }

  // A provider skips traversal for unchanged ticks, but new textures and backward/export seeks must update immediately.
  const assets = new AssetProvider(), updates = new Map()
  let traversals = 0
  assets.animatedTextures[Symbol.iterator] = function () { traversals++; return Set.prototype[Symbol.iterator].call(this) }
  assets._getTexture = async name => {
    const texture = new THREE.Texture()
    updates.set(name, [])
    texture.userData.updateAnimation = age => updates.get(name).push(age)
    return texture
  }
  assets.updateAnimations(20.1) // Empty providers may have already seen this tick before decoding completes.
  await assets.getTexture('first')
  assets.updateAnimations(20.2)
  const firstTraversal = traversals
  for (const age of [20.3, 20.6, 20.99]) assets.updateAnimations(age)
  assert.equal(traversals, firstTraversal, 'Unchanged ticks must skip collection traversal')
  assert.deepEqual(updates.get('first'), [20.2], 'An animation decoded mid-tick must receive its first update')
  await assets.getTexture('second')
  assets.updateAnimations(20.9)
  assert.deepEqual(updates.get('second'), [20.9], 'Another new texture must catch up without waiting for the next tick')
  for (const age of [3.25, 3.75, 103.5, 20.4]) assets.updateAnimations(age)
  assert.deepEqual(updates.get('second'), [20.9, 3.25, 103.5, 20.4], 'Seek backward, forward and resume must all update')
  assets.clearCaches()
  await assets.getTexture('replacement')
  assets.updateAnimations(20.6)
  assert.deepEqual(updates.get('replacement'), [20.6], 'Pack replacement during the same tick must reset the traversal guard')
  assets.clearCaches()
  console.log(`PASS texture animation: ${pixelChecks} exact pixel/upload comparisons, unique source-frame reads, one reusable interpolation buffer, same-tick traversal suppression, new textures and backward/forward export seeks`)
} finally {
  globalThis.document = originalDocument
}
