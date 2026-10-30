// Count and fill visit the same eligible blocks in the same order. Retain only
// a bounded prefix of their six direction bits; an exhausted cache returns
// undefined so the caller recomputes the remaining masks normally.
//
// Each page chooses raw bytes or (run length << 6 | mask) Uint32 records. The
// budget covers retained typed arrays, the reusable raw page, and a compressed
// output while it is being created. No allocation depends on the world size.
const MAX_CACHE_BYTES = 64 * 1024 * 1024
const PAGE_MASKS = 65536
const MAX_CACHE_PAGES = 65536

export class CullMaskCache {
  constructor(maxBytes = MAX_CACHE_BYTES, { maxPages = MAX_CACHE_PAGES } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_CACHE_BYTES) throw new RangeError('Invalid cull cache budget')
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_CACHE_PAGES) throw new RangeError('Invalid cull cache page limit')
    this.maxBytes = maxBytes; this.maxPages = maxPages; this.bytes = 0; this.peakBytes = 0
    this.pages = []; this.raw = null; this.used = 0; this.runs = 0; this.previous = -1
    this.recording = maxBytes > 0; this.length = 0; this.readCount = 0
    this.pageIndex = 0; this.offset = 0; this.remaining = 0; this.mask = 0
  }
  append(mask) {
    if (!this.recording) return
    if (!this.raw) {
      const size = Math.min(PAGE_MASKS, this.maxBytes - this.bytes)
      if (!size) { this.recording = false; return }
      this.raw = new Uint8Array(size); this.peakBytes = Math.max(this.peakBytes, this.bytes + size)
    }
    this.raw[this.used++] = mask; this.length++
    if (mask !== this.previous) { this.previous = mask; this.runs++ }
    if (this.used === this.raw.length) this.seal()
  }
  seal() {
    if (!this.used) return
    const compressedBytes = this.runs * 4
    if (compressedBytes < this.used && this.bytes + this.raw.byteLength + compressedBytes <= this.maxBytes) {
      const data = new Uint32Array(this.runs)
      this.peakBytes = Math.max(this.peakBytes, this.bytes + this.raw.byteLength + data.byteLength)
      let start = 0, cursor = 0
      for (let i = 1; i <= this.used; i++) if (i === this.used || this.raw[i] !== this.raw[start]) { data[cursor++] = ((i - start) << 6) | this.raw[start]; start = i }
      this.pages.push({ data, length: this.used, rle: true }); this.bytes += data.byteLength
      // Reuse the fixed scratch page while budget still permits it.
      if (this.bytes + this.raw.byteLength > this.maxBytes) this.raw = null
    } else {
      this.pages.push({ data: this.raw, length: this.used, rle: false }); this.bytes += this.raw.byteLength; this.raw = null
    }
    this.used = this.runs = 0; this.previous = -1
    // Even highly compressible, very long inputs have a fixed JS metadata cap.
    if (this.pages.length >= this.maxPages) { this.recording = false; this.raw = null }
  }
  finish() { this.seal(); this.raw = null; this.recording = false }
  read() {
    if (this.readCount >= this.length) return undefined
    let page = this.pages[this.pageIndex]
    if (this.offset >= page.length) {
      this.bytes -= page.data.byteLength; this.pages[this.pageIndex++] = null; this.offset = 0
      this.word = 0; this.remaining = 0; page = this.pages[this.pageIndex]
    }
    this.readCount++; this.offset++
    if (!page.rle) return page.data[this.offset - 1]
    if (!this.remaining) { const entry = page.data[this.word || 0]; this.word = (this.word || 0) + 1; this.remaining = entry >>> 6; this.mask = entry & 63 }
    this.remaining--; return this.mask
  }
  dispose() {
    this.pages = []; this.raw = null; this.bytes = 0; this.recording = false
    this.length = this.readCount = this.used = this.remaining = 0
  }
}
