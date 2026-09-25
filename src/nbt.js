// 极简的只读 NBT（Named Binary Tag）解析器，仅支持 Java 版大端序。
// 用于解析 .litematica 文件（gzip 压缩的 NBT）。
// LongArray 以 BigInt64Array 返回，其余类型转为普通 JS 值。

class NBTReader {
  constructor(data) {
    this.dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
    this.pos = 0
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
    return new TextDecoder().decode(bytes)
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
    for (let i = 0; i < len; i++) arr[i] = this.i64()
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
      obj[name] = this.payload(type)
    }
    return obj
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
export function parseNBT(data) {
  const r = new NBTReader(data)
  const type = r.u8()
  if (type !== 10) throw new Error('根 NBT 标签不是 compound（类型 ' + type + '）')
  r.string() // 根标签名（通常为空串）
  return r.compound()
}

// 解压 NBT 数据：自动识别 gzip / zlib / 未压缩，返回未压缩的 Uint8Array。
// 使用浏览器自带的 DecompressionStream，无需任何第三方压缩库。
export async function decompressNBT(data) {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b) {
    return inflate(u8, 'gzip')
  }
  if (u8.length >= 2 && u8[0] === 0x78) {
    return inflate(u8, 'deflate')
  }
  return u8
}

async function inflate(data, format) {
  const ds = new DecompressionStream(format)
  const stream = new Blob([data]).stream().pipeThrough(ds)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
