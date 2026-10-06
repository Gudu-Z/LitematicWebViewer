// Minecraft AnimationResourceMetadata：帧顺序、逐帧时长和插值（单位为游戏 tick）。
export function animationFrames(width, height, metadata) {
  const size = Math.min(width, height)
  const w = metadata.width || (metadata.height ? width : size)
  const h = metadata.height || (metadata.width ? height : size)
  const columns = Math.floor(width / w), count = columns * Math.floor(height / h)
  const frames = (metadata.frames?.length ? metadata.frames : Array.from({ length: count }, (_, i) => i))
    .map(f => typeof f === 'number' ? { index: f, time: metadata.frametime || 1 } : { index: f.index, time: f.time || metadata.frametime || 1 })
    .filter(f => Number.isInteger(f.index) && f.index >= 0 && f.index < count && f.time > 0)
  return { width: w, height: h, columns, frames, duration: frames.reduce((n, f) => n + f.time, 0) }
}

export function animateTexture(texture, source, metadata) {
  const layout = animationFrames(source.width, source.height, metadata)
  if (!layout.frames.length) return
  const canvas = document.createElement('canvas')
  canvas.width = layout.width; canvas.height = layout.height
  const context = canvas.getContext('2d', { willReadFrequently: !!metadata.interpolate })
  const pixels = metadata.interpolate ? layout.frames.map(f => {
    context.clearRect(0, 0, canvas.width, canvas.height)
    draw(f.index); return context.getImageData(0, 0, canvas.width, canvas.height)
  }) : null
  function draw(index) {
    context.drawImage(source, index % layout.columns * layout.width, Math.floor(index / layout.columns) * layout.height,
      layout.width, layout.height, 0, 0, layout.width, layout.height)
  }
  let last = ''
  texture.image = canvas
  texture.userData.updateAnimation = age => {
    let time = ((Math.floor(age) % layout.duration) + layout.duration) % layout.duration, index = 0
    while (time >= layout.frames[index].time) time -= layout.frames[index++].time
    const key = index + ':' + (metadata.interpolate ? time : 0)
    if (key === last) return
    last = key
    if (pixels && time) {
      const a = pixels[index], b = pixels[(index + 1) % pixels.length], result = context.createImageData(canvas.width, canvas.height)
      const fraction = time / layout.frames[index].time
      for (let i = 0; i < result.data.length; i++) result.data[i] = i % 4 === 3 ? a.data[i] : a.data[i] * (1 - fraction) + b.data[i] * fraction
      context.putImageData(result, 0, 0)
    } else { context.clearRect(0, 0, canvas.width, canvas.height); draw(layout.frames[index].index) }
    texture.needsUpdate = true
  }
  texture.userData.animation = layout
  texture.userData.updateAnimation(0)
}
