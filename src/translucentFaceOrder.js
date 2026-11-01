// Squared distances are nonnegative. Finite IEEE-754 doubles therefore sort
// in the same order as their unsigned bits (including subnormals). Count each
// 32-bit half in 11/11/10-bit digits: six stable passes, no Float32 rounding.
const lowWord = new Uint32Array(Float64Array.of(1).buffer)[0] === 0 ? 0 : 1
const offsets = [0, 2048, 4096, 5120, 7168, 9216, 9728]
const histogramSize = offsets[6]

export function createFaceRadixSort(distances) {
  const count = distances.length
  // Tiny framed items take the simple comparator path. Bound optional scratch
  // even for an exceptionally large replacement model.
  if (count < 4096 || (count + histogramSize) * 4 > 32 * 1024 ** 2) return null
  const words = new Uint32Array(distances.buffer, distances.byteOffset, count * 2)
  const scratch = new Uint32Array(count), histogram = new Uint32Array(histogramSize)
  return order => {
    histogram.fill(0)
    for (let i = 0; i < count; i++) {
      const lo = words[i * 2 + lowWord], hi = words[i * 2 + 1 - lowWord]
      histogram[lo & 2047]++; histogram[2048 + (lo >>> 11 & 2047)]++; histogram[4096 + (lo >>> 22)]++
      // Ignore the sign bit: -0 and +0 have the same numeric rank.
      histogram[5120 + (hi & 2047)]++; histogram[7168 + (hi >>> 11 & 2047)]++; histogram[9216 + (hi >>> 22 & 511)]++
    }
    let mask = 0, passes = 0
    for (let pass = 0; pass < 6; pass++) {
      let start = 0, used = 0
      for (let bin = offsets[pass + 1] - 1; bin >= offsets[pass]; bin--) {
        const frequency = histogram[bin]; histogram[bin] = start; start += frequency
        if (frequency) used++
      }
      if (used > 1) { mask |= 1 << pass; passes++ }
    }
    if (!passes) { for (let id = 0; id < count; id++) order[id] = id; return }
    let source = null, target = passes % 2 ? order : scratch
    for (let pass = 0; pass < 6; pass++) {
      if (!(mask & 1 << pass)) continue
      const offset = offsets[pass], digitMask = offsets[pass + 1] - offset - 1, shift = pass % 3 * 11
      const half = pass < 3 ? lowWord : 1 - lowWord
      if (source) {
        for (let i = 0; i < count; i++) {
          const id = source[i]
          target[histogram[offset + (words[id * 2 + half] >>> shift & digitMask)]++] = id
        }
      } else {
        // Start from canonical face IDs, not the last camera's order. Equal
        // distances keep the same original-ID tiebreak as the comparison sort.
        for (let id = 0; id < count; id++) target[histogram[offset + (words[id * 2 + half] >>> shift & digitMask)]++] = id
      }
      source = target; target = target === order ? scratch : order
    }
  }
}
