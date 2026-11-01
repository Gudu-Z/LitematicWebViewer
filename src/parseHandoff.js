// Only parser-produced records use this protocol. Each page and entity NBT
// record owns its tree, so native clone preserves its typed arrays and aliases
// inside one packet. Generic object graphs still use a single structured clone.
export const PARSE_HANDOFF_VERSION = 1
const PAGE_BATCH = 1024, RECORD_BATCH = 2048, MAP_BATCH = 8192
const protocolError = message => Object.assign(new Error(message), { code: 'WORKER_PROTOCOL' })
const parts = (n, size) => Math.ceil(n / size)
const partCount = counts => counts.pages.reduce((n, pages) => n + parts(pages, PAGE_BATCH), 0)
  + parts(counts.map, MAP_BATCH) + parts(counts.tileEntities, RECORD_BATCH) + parts(counts.entities, RECORD_BATCH)

function withoutPages(blocks) {
  const links = new Map(), regions = blocks.regions.map(r => {
    const copy = { ...r, states: { ...r.states, pages: [] } }
    links.set(r, copy)
    return copy
  })
  const remap = list => list.map(r => links.get(r))
  for (const r of regions) {
    r.before = remap(r.before); r.after = remap(r.after); r.overlaps = remap(r.overlaps)
  }
  const grid = blocks.regionGrid
  let regionGrid = null
  if (grid) {
    const cells = new Map()
    for (const [key, candidates] of grid.cells) cells.set(key, remap(candidates))
    regionGrid = { ...grid, cells }
  }
  return { ...blocks, regions, onlyRegion: links.get(blocks.onlyRegion) ?? null, regionGrid }
}

function* arrayPackets(kind, values, size, region) {
  for (let start = 0; start < values.length; start += size) {
    const packet = { kind, start, values: values.slice(start, start + size) }
    if (kind === 'pages') packet.region = region
    yield packet
  }
}

export function planParseHandoff(wire) {
  const { blocks, tileEntities, entities } = wire
  if (!Array.isArray(tileEntities) || !Array.isArray(entities)) return null
  const paged = blocks?.kind === 'paged' && Array.isArray(blocks.regions)
  if (!paged && !(blocks?.kind === 'map' && blocks.values instanceof Map)) return null
  const counts = { pages: paged ? blocks.regions.map(r => r.states.pages.length) : [],
    map: paged ? 0 : blocks.values.size, tileEntities: tileEntities.length, entities: entities.length }
  if (counts.pages.reduce((n, size) => n + size, 0) < 16384 && counts.map < 32768
    && counts.tileEntities < 16384 && counts.entities < 16384) return null

  // Keep the original property and region order, precomputed overlap counts
  // and grid. No source page is copied or detached: the worker still builds
  // geometry and the main thread receives native clones of the same pages.
  const result = { ...wire, blocks: paged ? withoutPages(blocks) : { ...blocks, values: new Map() },
    tileEntities: [], entities: [] }
  const header = { version: PARSE_HANDOFF_VERSION, result, counts, partCount: partCount(counts) }
  const packets = { *[Symbol.iterator]() {
    if (paged) {
      for (let i = 0; i < blocks.regions.length; i++) yield* arrayPackets('pages', blocks.regions[i].states.pages, PAGE_BATCH, i)
    } else {
      // Parser block Maps contain numeric keys/indices. Keep safe-integer
      // coordinates above 2^32 without sending a separate object per entry.
      const entries = blocks.values.entries()
      for (let start = 0; start < counts.map; start += MAP_BATCH) {
        const values = new Float64Array(Math.min(MAP_BATCH, counts.map - start) * 2)
        for (let i = 0; i < values.length; i += 2) {
          const [key, value] = entries.next().value
          values[i] = key; values[i + 1] = value
        }
        yield { kind: 'map', start, values }
      }
    }
    yield* arrayPackets('tileEntities', tileEntities, RECORD_BATCH)
    yield* arrayPackets('entities', entities, RECORD_BATCH)
  } }
  return { header, packets }
}

export function createParseHandoffReceiver(header) {
  const result = header?.result, counts = header?.counts, blocks = result?.blocks
  const validCount = n => Number.isSafeInteger(n) && n >= 0
  const arrayCount = n => validCount(n) && n <= 0xffffffff
  const empty = list => Array.isArray(list) && list.length === 0
  if (header?.version !== PARSE_HANDOFF_VERSION || !counts || !Array.isArray(counts.pages)
    || !arrayCount(counts.tileEntities) || !arrayCount(counts.entities) || !validCount(counts.map)
    || !validCount(header.partCount) || !empty(result?.tileEntities) || !empty(result?.entities)) {
    throw protocolError('Invalid parse handoff header')
  }
  const targets = []
  const add = (kind, output, count, size, region) => { if (count) targets.push({ kind, output, count, size, region }) }
  if (blocks?.kind === 'paged') {
    if (!Array.isArray(blocks.regions) || counts.pages.length !== blocks.regions.length || counts.map !== 0) throw protocolError('Invalid parse handoff regions')
    for (let i = 0; i < blocks.regions.length; i++) {
      const pages = blocks.regions[i]?.states?.pages, count = counts.pages[i]
      if (!empty(pages) || !arrayCount(count)) throw protocolError('Invalid parse handoff page count')
      add('pages', pages, count, PAGE_BATCH, i)
    }
  } else if (blocks?.kind === 'map' && blocks.values instanceof Map && !blocks.values.size && !counts.pages.length) {
    add('map', blocks.values, counts.map, MAP_BATCH)
  } else throw protocolError('Invalid parse handoff blocks')
  add('tileEntities', result.tileEntities, counts.tileEntities, RECORD_BATCH)
  add('entities', result.entities, counts.entities, RECORD_BATCH)
  if (!header.partCount || header.partCount !== partCount(counts)) throw protocolError('Invalid parse handoff packet count')

  // Only grow existing collections as validated packets arrive; never allocate
  // a claimed count of pages, map entries or entities based on a header alone.
  let index = 0, start = 0, received = 0, closed = false
  const fail = message => { closed = true; throw protocolError(message) }
  return {
    append(packet) {
      const target = targets[index], values = packet?.values
      if (closed || !target || packet?.kind !== target.kind || packet.region !== target.region || packet.start !== start) fail('Unexpected parse handoff packet')
      const count = Math.min(target.size, target.count - start)
      if (target.kind === 'map') {
        if (!(values instanceof Float64Array) || values.length !== count * 2) fail('Invalid parse handoff map packet')
        for (let i = 0; i < values.length; i += 2) {
          if (!validCount(values[i]) || !validCount(values[i + 1])) fail('Invalid parse handoff map entry')
          target.output.set(values[i], values[i + 1])
        }
        if (target.output.size !== start + count) fail('Duplicate parse handoff map entry')
      } else {
        if (!Array.isArray(values) || values.length !== count || values.includes(undefined)) fail('Invalid parse handoff records')
        target.output.push(...values)
      }
      received++; start += count
      if (start === target.count) { index++; start = 0 }
    },
    finish() {
      if (closed || index !== targets.length || received !== header.partCount) fail('Incomplete parse handoff')
      closed = true
      return result
    },
  }
}
