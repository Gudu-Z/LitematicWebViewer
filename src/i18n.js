// 极简双语（中文 / English）字典与切换。
// 静态文案在 HTML 里用 data-i18n / data-i18n-title 标注，由 applyTranslations() 统一替换；
// 动态文案在 JS 里通过 t(key, vars) 取当前语言字符串。

import { BLOCK_NAMES } from './blockNames.js'

const STRINGS = {
  openFile: ['打开 .litematica 文件', 'Open .litematica file'],
  clear: ['清除', 'Clear'],
  dragHint: ['拖入 .litematica 文件开始预览', 'Drag a .litematica file to preview'],
  move: ['移动', 'Move'],
  moveUp: ['上升', 'Ascend'],
  moveDown: ['下降', 'Descend'],
  orbitMode: ['环绕模式', 'Orbit mode'],
  flyMode: ['飞行模式', 'Fly mode'],
  speed: ['速度', 'Speed'],
  render: ['渲染', 'Render'],
  renderAll: ['全部渲染', 'All'],
  renderBelow: ['层级下方', 'Below layer'],
  renderAbove: ['层级上方', 'Above layer'],
  renderSingle: ['单层渲染', 'Single layer'],
  layer: ['层级', 'Layer'],
  layerDownTitle: ['下一层 (Q)', 'Next layer (Q)'],
  layerUpTitle: ['上一层 (E)', 'Previous layer (E)'],
  locateHere: ['定位到此处', 'Locate here'],
  locateHereTitle: ['把当前层设为摄像机所在高度', 'Set current layer to the camera height'],
  regionsToggleTitle: ['展开/收起区域', 'Expand/collapse regions'],
  materialsToggleTitle: ['展开/收起材料', 'Expand/collapse materials'],
  materialSortTitle: ['切换排序', 'Toggle sort order'],
  hint1: ['环绕模式：左键旋转 · 右键平移 · 滚轮缩放', 'Orbit: left-drag rotate · right-drag pan · wheel zoom'],
  hint2: ['飞行模式（按 WASD 切换）：左键转头 · WASD 移动 · 右键平移 · 滚轮调速', 'Fly mode (WASD): left-drag look · WASD move · right-drag pan · wheel speed'],
  hint3: ['E / Q：上一 / 下一层', 'E / Q: previous / next layer'],
  settings: ['设置', 'Settings'],
  github: ['GitHub 仓库', 'GitHub repository'],
  info: ['信息', 'Info'],
  regions: ['区域', 'Regions'],
  materials: ['材料', 'Materials'],
  sortDesc: ['多 → 少', 'Most → least'],
  sortAsc: ['少 → 多', 'Least → most'],
  hideUi: ['隐藏界面', 'Hide UI'],
  showUi: ['显示界面', 'Show UI'],
  entityPreview: ['模型图鉴（新标签页）', 'Model catalog (new tab)'],
  close: ['关闭', 'Close'],
  bgColor: ['背景颜色', 'Background color'],
  sectionDisplay: ['显示', 'Display'],
  showEntities: ['显示实体', 'Show entities'],
  showWireframes: ['显示区域线框', 'Show region wireframes'],
  showDimensions: ['显示尺寸', 'Show dimensions'],
  showFog: ['水下雾气', 'Underwater fog'],
  sectionControls: ['操作', 'Controls'],
  sensitivity: ['镜头灵敏度', 'Look sensitivity'],
  resourcePacks: ['资源包', 'Resource packs'],
  loadedPacks: ['已加载（越靠上优先级越高）', 'Loaded (higher = higher priority)'],
  availablePacks: ['可加载', 'Available'],
  loadPack: ['从文件加载资源包 (.zip)', 'Load resource pack (.zip)'],
  metaName: ['名称', 'Name'],
  metaAuthor: ['作者', 'Author'],
  metaSize: ['尺寸', 'Size'],
  metaTotalBlocks: ['方块总数', 'Total blocks'],
  metaTotalVolume: ['总体积', 'Total volume'],
  metaRegionCount: ['区域数', 'Regions'],
  metaDataVersion: ['数据版本', 'Data version'],
  metaDescription: ['描述', 'Description'],
  metaNone: ['（无）', '(none)'],
  metaNotLoaded: ['尚未加载文件', 'No file loaded'],
  noRegions: ['无区域', 'No regions'],
  noBlocks: ['无方块', 'No blocks'],
  show: ['显示', 'Show'],
  hide: ['隐藏', 'Hide'],
  packUp: ['提高优先级', 'Raise priority'],
  packDown: ['降低优先级', 'Lower priority'],
  packUnload: ['卸载', 'Unload'],
  packLoad: ['加载', 'Load'],
  packNoneLoaded: ['未加载任何资源包', 'No resource packs loaded'],
  packNoneAvailable: ['没有可加载的资源包', 'No resource packs available'],
  statusCleared: ['已清除，可拖入新文件', 'Cleared, drag in a new file'],
  statusParsing: ['正在解析方块模型（{n} 种方块）…', 'Resolving block models ({n} types)…'],
  statusGeometry: ['正在生成几何体（{n} 个方块）…', 'Generating geometry ({n} blocks)…'],
  statusDone: ['完成：{faces} 个面，{textures} 种贴图{entities}', 'Done: {faces} faces, {textures} textures{entities}'],
  statusEntities: ['，{n} 个实体', ', {n} entities'],
  loadFailed: ['加载失败：', 'Load failed: '],
  fileTooLarge: ['文件过大，浏览器内存不足以完整预览', 'File too large — not enough memory to preview'],
  layerValue: ['层 {y}', 'Layer {y}'],
  layerDash: ['层 -', 'Layer -'],
  webglInitFailed: ['无法初始化 3D 渲染（WebGL 可能不可用）：', 'Failed to initialize 3D rendering (WebGL may be unavailable): '],
  scriptError: ['脚本错误：', 'Script error: '],
  runtimeError: ['运行错误：', 'Runtime error: '],
  capDecompression: ['当前浏览器不支持 DecompressionStream（解压 .litematica 必需），请升级浏览器', 'Browser does not support DecompressionStream (required for .litematica), please upgrade'],
  capWebgl: ['当前浏览器不支持 WebGL，无法 3D 渲染', 'Browser does not support WebGL, cannot render 3D'],
  renderUnavailable: ['3D 渲染不可用，无法预览', '3D rendering unavailable, cannot preview'],
  parsingFile: ['正在解析文件 …', 'Parsing file…'],
  parsingFilePct: ['正在解析文件 … {p}%', 'Parsing file… {p}%'],
  loadingPack: ['正在加载资源包 {name} …', 'Loading resource pack {name}…'],
  loadingPackShort: ['正在加载资源包 …', 'Loading resource pack…'],
  packDownloadFailed: ['资源包下载失败（HTTP {status}）', 'Resource pack download failed (HTTP {status})'],
  packLoaded: ['资源包已加载：{name}', 'Resource pack loaded: {name}'],
  packLoadedShort: ['资源包已加载（打开文件后生效）', 'Resource pack loaded (applies after opening a file)'],
  packLoadFailed: ['资源包加载失败：', 'Resource pack load failed: '],
  packUnloaded: ['已卸载资源包：{name}', 'Resource pack unloaded: {name}'],
  packUnloadFailed: ['卸载失败：', 'Unload failed: '],
  packMoveFailed: ['调整优先级失败：', 'Reorder failed: '],
}

let lang = 'zh'

export function t(key, vars) {
  const pair = STRINGS[key]
  let s = pair ? pair[lang === 'zh' ? 0 : 1] : key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll('{' + k + '}', String(v))
  }
  return s
}

export function setLang(l) {
  lang = l === 'en' ? 'en' : 'zh'
}

export function getLang() {
  return lang
}

// 方块译名：按当前语言取 BLOCK_NAMES[lang][id]，缺失回退英文 ID
export function blockName(id) {
  const m = BLOCK_NAMES[lang === 'zh' ? 'zh' : 'en']
  return (m && m[id]) || id
}

// 把 DOM 里所有 data-i18n（文本）与 data-i18n-title（title 属性）按当前语言替换
export function applyTranslations(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'))
  })
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.setAttribute('title', t(el.getAttribute('data-i18n-title')))
  })
  root.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')))
  })
}
