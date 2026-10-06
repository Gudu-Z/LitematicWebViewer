import { Quaternion, Vector3 } from 'three'

// 固定在预览角落的世界坐标轴，只跟随相机朝向，不受模型大小、缩放或平移影响。
export function createOrientationGizmo(container) {
  const canvas = document.createElement('canvas')
  canvas.className = 'orientation-gizmo'
  canvas.setAttribute('role', 'img')
  canvas.setAttribute('aria-label', '世界坐标轴：X 东，Y 上，Z 南')
  canvas.hidden = true
  container.append(canvas)
  const context = canvas.getContext('2d')
  const rotation = new Quaternion(), previous = new Quaternion(), inverse = new Quaternion()
  const axes = [
    { label: 'X', color: '#ff8088', direction: new Vector3(1, 0, 0) },
    { label: 'Y', color: '#a3df80', direction: new Vector3(0, 1, 0) },
    { label: 'Z', color: '#80b7ff', direction: new Vector3(0, 0, 1) },
  ].flatMap(axis => [1, -1].map(sign => ({ ...axis, sign, point: new Vector3() })))
  let dirty = true

  return {
    clear() { canvas.hidden = true; dirty = true },
    update(camera) {
      canvas.hidden = false
      if (!context) return
      const size = canvas.clientWidth, ratio = Math.min(devicePixelRatio || 1, 2), pixels = Math.round(size * ratio)
      if (!size) return
      camera.getWorldQuaternion(rotation)
      if (canvas.width !== pixels || canvas.height !== pixels) {
        canvas.width = pixels; canvas.height = pixels; dirty = true
      }
      if (!dirty && rotation.equals(previous)) return
      dirty = false; previous.copy(rotation); inverse.copy(rotation).invert()
      context.setTransform(pixels / 96, 0, 0, pixels / 96, 0, 0)
      context.clearRect(0, 0, 96, 96)
      context.beginPath(); context.arc(48, 48, 46, 0, Math.PI * 2)
      context.fillStyle = '#101b2ab8'; context.fill()
      for (const axis of axes) axis.point.copy(axis.direction).multiplyScalar(axis.sign).applyQuaternion(inverse)
      // 相机坐标中 z 越大越靠近观察者，先画后方，避免轴端遮挡关系颠倒。
      axes.sort((a, b) => a.point.z - b.point.z)
      context.lineCap = 'round'
      for (const axis of axes) {
        context.globalAlpha = axis.sign > 0 ? .9 : .3
        context.strokeStyle = axis.color; context.lineWidth = axis.sign > 0 ? 2.5 : 1.5
        context.beginPath(); context.moveTo(48, 48); context.lineTo(48 + axis.point.x * 31, 48 - axis.point.y * 31); context.stroke()
      }
      context.globalAlpha = 1
      context.beginPath(); context.arc(48, 48, 3, 0, Math.PI * 2); context.fillStyle = '#bdcce0'; context.fill()
      context.font = 'bold 12px system-ui, sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle'
      for (const axis of axes) {
        const x = 48 + axis.point.x * 31, y = 48 - axis.point.y * 31
        context.globalAlpha = axis.point.z < 0 ? .65 : 1
        context.beginPath(); context.arc(x, y, axis.sign > 0 ? 9 : 3, 0, Math.PI * 2)
        context.fillStyle = axis.color; context.fill()
        if (axis.sign > 0) { context.fillStyle = '#101b2a'; context.fillText(axis.label, x, y + .5) }
      }
      context.globalAlpha = 1
    },
  }
}
