// 极简双语（中文 / English）字典与切换。
// 静态文案在 HTML 里用 data-i18n / data-i18n-title 标注，由 applyTranslations() 统一替换；
// 动态文案在 JS 里通过 t(key, vars) 取当前语言字符串。

import { BLOCK_NAMES } from './blockNames.js'

const STRINGS = {
  invalidURL: ['请使用有效的 HTTPS 投影文件链接。', 'Use a valid HTTPS schematic URL.'],
  fileLimit: ['远程投影文件必须非空且不超过 64 MiB。', 'Remote schematics must be nonempty and no larger than 64 MiB.'],
  notSchematic: ['链接返回了网页，请提供投影文件的直接下载地址。', 'The URL returned a web page. Provide a direct schematic download URL.'],
  previewTransferFailed: ['未收到预览卡片的文件，请保持原页面打开后重试，或手动打开投影文件。', 'The preview file was not received. Keep the original page open and try again, or open the schematic manually.'],
  pageTitle: ['Minecraft 投影在线预览器（Litematica）| LitematicWebViewer', 'Minecraft Litematica Viewer Online | LitematicWebViewer'],
  pageDescription: ['免费的我的世界（Minecraft）投影在线预览器，支持 Litematica 的 .litematic、.litematica 投影与 .nbt 结构文件。3D 查看建筑、逐层预览、统计材料，支持资源包和模型图鉴；无需安装游戏，文件在浏览器本地处理。', 'Free online Minecraft Litematica viewer for .litematic, .litematica and .nbt files. Preview schematics in 3D, inspect layers, count materials and explore the model catalog. No game installation needed; files stay in your browser.'],
  openFile: ['打开投影文件', 'Open schematic'],
  viewerSubtitle: ['Minecraft 投影预览器', 'Minecraft schematic viewer'],
  welcomeTitle: ['Minecraft 投影在线预览器', 'Online Minecraft schematic viewer'],
  welcomeDescription: ['打开我的世界 Litematica 投影，3D 查看建筑、逐层浏览并统计材料。无需安装游戏，文件在浏览器本地处理。', 'Open Litematica schematics in 3D, inspect each layer and count materials. No Minecraft installation needed; files are processed locally in your browser.'],
  browseCatalog: ['浏览模型图鉴', 'Browse model catalog'],
  exportRenderedImage: ['导出渲染图片', 'Export rendered image'],
  currentFile: ['当前文件', 'Current file'],
  viewControls: ['视图控制', 'View controls'],
  fitView: ['适应窗口', 'Fit view'],
  orthographicProjection: ['正交渲染', 'Orthographic rendering'],
  perspectiveProjectionTitle: ['当前：透视渲染 · 点击切换为正交渲染', 'Perspective rendering · Switch to orthographic'],
  orthographicProjectionTitle: ['当前：正交渲染 · 点击切换为透视渲染', 'Orthographic rendering · Switch to perspective'],
  operationHelp: ['操作提示', 'Navigation help'],
  loadProgress: ['加载进度', 'Loading progress'],
  previewPanels: ['预览面板', 'Viewer panels'],
  settingsCategories: ['设置分类', 'Settings categories'],
  generalSettings: ['显示与操作', 'Display & controls'],
  dropHint: ['松开以打开投影或导入资源包', 'Drop to open a schematic or import resource packs'],
  loadingDemo: ['正在打开示例建筑…', 'Opening the demo…'],
  demoFailed: ['示例建筑加载失败，请重试。', 'Could not load the demo. Please try again.'],
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
  info: ['结构信息', 'Build info'],
  regions: ['区域', 'Regions'],
  materials: ['材料', 'Materials'],
  sortDesc: ['多 → 少', 'Most → least'],
  sortAsc: ['少 → 多', 'Least → most'],
  hideUi: ['隐藏界面', 'Hide UI'],
  exportImage: ['导出图片', 'Export image'],
  showUi: ['显示界面', 'Show UI'],
  entityPreview: ['模型图鉴（新标签页）', 'Model catalog (new tab)'],
  close: ['关闭', 'Close'],
  bgColor: ['背景颜色', 'Background color'],
  sectionDisplay: ['显示', 'Display'],
  showEntities: ['显示实体', 'Show entities'],
  showEntityHitboxes: ['显示实体碰撞箱', 'Show entity hitboxes'],
  entityHitboxesHint: ['F3+B 切换。白色：碰撞箱；红色：视线高度；蓝色：朝向；黄色：乘坐位置。', 'Toggle with F3+B. White: hitbox; red: eye height; blue: look direction; yellow: riding position.'],
  showWireframes: ['显示区域线框', 'Show region wireframes'],
  showDimensions: ['显示尺寸', 'Show dimensions'],
  showFog: ['水下雾气', 'Underwater fog'],
  sectionFun: ['趣味选项', 'Fun options'],
  illagerExtraArms: ['巨儒卫道士', 'Four-armed illagers'],
  illagerExtraArmsHint: ['让卫道士、唤魔者和幻术师同时显示交叉与独立的两套手臂。', 'Show both crossed and separate arms on vindicators, evokers and illusioners.'],
  settingsSaveFailed: ['无法保存设置，当前会话仍可使用。', 'Could not save settings. They still apply to this session.'],
  settingsApplyFailed: ['设置应用失败：', 'Could not apply settings: '],
  sectionControls: ['操作', 'Controls'],
  sensitivity: ['镜头灵敏度', 'Look sensitivity'],
  resourcePacks: ['资源包', 'Resource packs'],
  loadedPacks: ['已加载', 'Loaded'],
  availablePacks: ['可用资源包', 'Available'],
  loadPack: ['本地导入 .zip', 'Import local .zip'],
  unloadAllPacks: ['全部卸载', 'Unload all'],
  packPriorityHint: ['越靠上优先级越高，未覆盖的资源使用原版材质。', 'Packs at the top take priority. Uncovered resources use vanilla textures.'],
  packStorageHint: ['本地文件和加载顺序保存在当前浏览器。卸载的资源包可在可用列表中重新加载。', 'Local files and pack order are saved in this browser. Unloaded packs remain available to load again.'],
  packBuiltIn: ['内置资源包', 'Built-in pack'],
  packLocal: ['本地导入', 'Local import'],
  packVanilla: ['原版材质', 'Vanilla textures'],
  packCount: ['已加载 {n} 个', '{n} loaded'],
  packApplying: ['正在更新资源包与模型…', 'Updating resource packs and models…'],
  packUpdated: ['资源包已更新', 'Resource packs updated'],
  packOperationFailed: ['资源包更新失败：{error}', 'Resource pack update failed: {error}'],
  packAllUnloaded: ['已卸载全部资源包，使用原版材质。', 'All packs unloaded. Using vanilla textures.'],
  packOrderUpdated: ['资源包优先级已更新', 'Pack priority updated'],
  packMissing: ['资源包不可用，请重新导入。', 'Resource pack unavailable. Please import it again.'],
  packPreferencesUnavailable: ['无法保存加载顺序，当前会话仍可使用。', 'Could not save pack order. It still applies to this session.'],
  packManifestUnavailable: ['暂时无法读取内置资源包，仍可导入本地文件。', 'Built-in packs are temporarily unavailable. You can still import local files.'],
  packStorageUnavailable: ['无法读取保存的本地资源包，可重新导入。', 'Could not restore local packs. You can import them again.'],
  packRestoreFailed: ['部分资源包未能恢复，可在可用列表中重试加载。', 'Some packs could not be restored. Retry loading them from the available list.'],
  packSaveFailed: ['本地资源包已加载，但无法保存；刷新后需要重新导入。', 'Local packs loaded but could not be saved. Import them again after refreshing.'],
  '无法读取 ZIP 文件': ['无法读取 ZIP 文件', 'Cannot read ZIP file'],
  '材质包缺少 pack.mcmeta': ['材质包缺少 pack.mcmeta', 'Resource pack is missing pack.mcmeta'],
  'pack.mcmeta 格式无效': ['pack.mcmeta 格式无效', 'Invalid pack.mcmeta'],
  '材质包没有可用的 Minecraft 资源': ['材质包没有可用的 Minecraft 资源', 'Resource pack contains no usable Minecraft assets'],
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
  packNoneLoaded: ['当前使用原版材质。加载资源包即可更换外观。', 'Using vanilla textures. Load a resource pack to change the appearance.'],
  packNoneAvailable: ['没有其他资源包，可从本地导入 ZIP。', 'No other packs available. Import a local ZIP to add one.'],
  statusCleared: ['已清除，可拖入新文件', 'Cleared, drag in a new file'],
  statusParsing: ['正在解析方块模型（{n} 种方块）…', 'Resolving block models ({n} types)…'],
  statusGeometry: ['正在生成几何体（{n} 个方块）…', 'Generating geometry ({n} blocks)…'],
  statusDone: ['完成：{faces} 个面，{textures} 种贴图{entities}', 'Done: {faces} faces, {textures} textures{entities}'],
  statusEntities: ['，{n} 个实体', ', {n} entities'],
  loadFailed: ['加载失败：', 'Load failed: '],
  fileTooLarge: ['文件过大，浏览器内存不足以完整预览', 'File too large — not enough memory to preview'],
  inspectingSchematic: ['正在检查投影', 'Inspecting schematic'],
  streamReadHint: ['正在顺序读取文件，可随时取消。', 'Reading the file sequentially. You can cancel at any time.'],
  streamReadProgress: ['已读取 {n} MiB 解压数据…', 'Read {n} MiB of decompressed data…'],
  selectLoadRange: ['选择加载范围', 'Choose a range to load'],
  readingSchematicRange: ['正在读取选定范围', 'Reading the selected range'],
  rangeExplanation: ['输入投影内的坐标（包含起止位置）。每次最多加载 {n} 格体积；复杂区域可缩小范围后重试。', 'Enter schematic coordinates (both endpoints included). Load up to {n} cells at a time; use a smaller range for complex areas.'],
  sourceBlockCount: ['原文件共 {n} 个方块，选择一部分进行预览。', 'The source contains {n} blocks. Select a portion to preview.'],
  sourceRange: ['原文件范围：', 'Source bounds: '],
  rangeFrom: ['起点', 'From'], rangeTo: ['终点', 'To'],
  rangeCenter: ['推荐范围', 'Suggested range'], rangeColumn: ['中央整高窄柱', 'Full-height center column'],
  rangeVolume: ['{size}，共 {n} 格', '{size}, {n} cells'],
  loadRange: ['加载此范围', 'Load this range'], cancelLoad: ['取消', 'Cancel'],
  changeLoadRange: ['更改加载范围', 'Change loaded range'],
  loadedRange: ['局部预览 · {n} 个已加载方块\n{range}\n材料清单仅统计此范围；结构信息显示原文件总量。', 'Partial preview · {n} loaded blocks\n{range}\nMaterials cover this range; build info shows source totals.'],
  loadCancelled: ['已取消读取', 'Loading cancelled'],
  emptyRange: ['此范围内没有可显示内容，请更改加载范围。', 'Nothing to display in this range. Choose another range.'],
  invalidWindow: ['请输入原文件范围内的整数坐标，起点不能大于终点。', 'Enter integer coordinates within the source bounds, with From no greater than To.'],
  windowTooLarge: ['范围过大，请缩小范围（最多 1,048,576 格体积）。', 'Range too large. Reduce it to at most 1,048,576 cells.'],
  windowTooComplex: ['此范围的模型过于复杂，请缩小加载范围。', 'This range has too much geometry or too many entities. Select a smaller range.'],
  windowRequired: ['请在完整预览器中选择加载范围。', 'Select a range in the full viewer.'],
  invalidSchematicBounds: ['投影的区域尺寸或调色板无效。', 'Invalid schematic region dimensions or palette.'],
  invalidBlockStates: ['投影的方块数据不完整或包含无效索引。', 'Incomplete block data or invalid palette indices.'],
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
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'))
  })
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.setAttribute('title', t(el.getAttribute('data-i18n-title')))
  })
  root.querySelectorAll('[data-i18n-content]').forEach((el) => {
    el.setAttribute('content', t(el.getAttribute('data-i18n-content')))
  })
  root.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')))
  })
}
