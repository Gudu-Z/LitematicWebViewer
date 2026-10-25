// 极简的只读 NBT（Named Binary Tag）解析器，仅支持 Java 版大端序。
// 用于解析 .litematica 文件（gzip 压缩的 NBT）。
// LongArray 以 BigInt64Array 返回，其余类型转为普通 JS 值。

export const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1
const textDecoder = new TextDecoder()

class NBTReader {
  constructor(data, selectField) {
    this.dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
    this.pos = 0
    this.selectField = selectField
    this.path = []
  }

  u8() {
    const v = this.dv.getUint8(this.pos)
    this.pos += 1
    return v
  }

  i16() {
    const v = this.dv.getInt16(this.pos, false)
    this.pos += 2
    return v
  }

  i32() {
    const v = this.dv.getInt32(this.pos, false)
    this.pos += 4
    return v
  }

  i64() {
    const v = this.dv.getBigInt64(this.pos, false)
    this.pos += 8
    return v
  }

  f32() {
    const v = this.dv.getFloat32(this.pos, false)
    this.pos += 4
    return v
  }

  f64() {
    const v = this.dv.getFloat64(this.pos, false)
    this.pos += 8
    return v
  }

  string() {
    const len = this.dv.getUint16(this.pos, false)
    this.pos += 2
    const bytes = new Uint8Array(this.dv.buffer, this.dv.byteOffset + this.pos, len)
    this.pos += len
    return textDecoder.decode(bytes)
  }

  byteArray() {
    const len = this.i32()
    const arr = new Int8Array(len)
    for (let i = 0; i < len; i++) arr[i] = this.dv.getInt8(this.pos++)
    return arr
  }

  intArray() {
    const len = this.i32()
    const arr = new Int32Array(len)
    for (let i = 0; i < len; i++) arr[i] = this.i32()
    return arr
  }

  longArray() {
    const len = this.i32()
    const arr = new BigInt64Array(len)
    // 保留 BigInt64Array 的返回格式，但直接写入两个 32 位半区，避免逐 long 创建 BigInt。
    const words = new Uint32Array(arr.buffer)
    const low = LITTLE_ENDIAN ? 0 : 1
    for (let i = 0; i < len; i++) {
      words[i * 2 + (low ^ 1)] = this.dv.getUint32(this.pos, false)
      words[i * 2 + low] = this.dv.getUint32(this.pos + 4, false)
      this.pos += 8
    }
    return arr
  }

  list() {
    const type = this.u8()
    const len = this.i32()
    const arr = new Array(len)
    for (let i = 0; i < len; i++) arr[i] = this.payload(type)
    return arr
  }

  compound() {
    const obj = {}
    for (;;) {
      const type = this.u8()
      if (type === 0) break // TAG_End
      const name = this.string()
      if (this.selectField && !this.selectField(this.path, name)) {
        this.skipPayload(type)
      } else {
        if (this.selectField) this.path.push(name)
        obj[name] = this.payload(type)
        if (this.selectField) this.path.pop()
      }
    }
    return obj
  }

  skip(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.pos + bytes > this.dv.byteLength) {
      throw new RangeError('NBT 字段超出数据范围')
    }
    this.pos += bytes
  }

  // Skip binary payloads without decoding strings or allocating item/AI trees.
  // Compounds have no length prefix, so their tag headers still need scanning.
  skipPayload(type) {
    if (type >= 1 && type <= 6) { this.skip([0, 1, 2, 4, 8, 4, 8][type]); return }
    if (type === 8) { const length = this.dv.getUint16(this.pos, false); this.pos += 2; this.skip(length); return }
    if (type === 7 || type === 11 || type === 12) { this.skip(this.i32() * (type === 7 ? 1 : type === 11 ? 4 : 8)); return }
    if (type === 9) {
      const itemType = this.u8(), length = this.i32()
      if (length < 0) throw new RangeError('NBT 列表长度无效')
      if (itemType >= 1 && itemType <= 6) this.skip(length * [0, 1, 2, 4, 8, 4, 8][itemType])
      else for (let i = 0; i < length; i++) this.skipPayload(itemType)
      return
    }
    if (type === 10) {
      for (let child; (child = this.u8()) !== 0;) { this.skipPayload(8); this.skipPayload(child) }
      return
    }
    throw new Error('未知的 NBT 标签类型：' + type)
  }

  payload(type) {
    switch (type) {
      case 1: return this.dv.getInt8(this.pos++)
      case 2: return this.i16()
      case 3: return this.i32()
      case 4: return this.i64()
      case 5: return this.f32()
      case 6: return this.f64()
      case 7: return this.byteArray()
      case 8: return this.string()
      case 9: return this.list()
      case 10: return this.compound()
      case 11: return this.intArray()
      case 12: return this.longArray()
      default: throw new Error('未知的 NBT 标签类型：' + type)
    }
  }
}

// 解析一个完整的 NBT 文件，返回根 compound 的普通对象。
// Optional selector receives the enclosing field path (list indices omitted).
// Returning false skips the entire value, not merely its returned JS property.
export function parseNBT(data, selectField) {
  const r = new NBTReader(data, selectField)
  const type = r.u8()
  if (type !== 10) throw new Error('根 NBT 标签不是 compound（类型 ' + type + '）')
  r.string() // 根标签名（通常为空串）
  return r.compound()
}

export { decompressNBT } from './decompression.js'
