import { ZH_NAMES } from './inspection-data.js'
import { EN_NAMES } from './inspection-english.js'
import { language } from './inspection-catalog.js'

const words = {
  '显示': 'Display', '显示实体碰撞箱': 'Show entity hitboxes',
  'F3+B 切换。白色：碰撞箱；红色：视线高度；蓝色：朝向；黄色：乘坐位置。': 'Toggle with F3+B. White: hitbox; red: eye height; blue: look direction; yellow: riding position.',
  '姿势': 'Pose', '奔跑': 'Running', '星形': 'Star',
  'Minecraft 方块与生物模型图鉴 | LitematicWebViewer': 'Minecraft Block & Mob Model Catalog | LitematicWebViewer',
  '模型图鉴简介': 'Explore Minecraft block, mob, entity and item models in an online 3D model catalog. Search official names, switch states, baby forms, equipment, vehicles and resource packs, and preview item frames.',
  '在线浏览我的世界（Minecraft）方块、生物、实体与物品的 3D 模型；点击卡片，查看状态、装备和乘坐效果。': 'Explore Minecraft block, mob, entity and item models online in 3D. Open a card to view states, equipment and passengers.',
  '乘坐载具': 'Vehicle', '乘客': 'Passenger', '第二位乘客': 'Second passenger',
  '乘客年龄': 'Passenger age', '第二位乘客年龄': 'Second passenger age', '坐垫颜色': 'Cushion color',
  '设置': 'Settings', '图鉴设置': 'Catalog settings', '关闭设置': 'Close settings', '材质包': 'Resource packs',
  '本地导入 .zip': 'Import local .zip', '选择本地材质包': 'Choose local resource packs',
  '越靠上的材质包优先级越高；未覆盖的资源使用原版材质。': 'Packs at the top take priority. Uncovered resources use vanilla textures.',
  '已加载': 'Loaded', '可用材质包': 'Available packs', '内置': 'Built in', '本地导入': 'Local import',
  '上移': 'Move up', '下移': 'Move down', '卸载': 'Unload', '加载': 'Load',
  '未加载材质包，使用原版材质。': 'No packs loaded. Using vanilla textures.',
  '没有其他材质包，可从本地导入。': 'No other packs available. Import a local pack to add one.',
  '趣味选项': 'Fun options', '巨儒卫道士': 'Four-armed illagers',
  '让卫道士、唤魔者和幻术师同时显示交叉与独立的两套手臂。': 'Show both crossed and separate arms on vindicators, evokers and illusioners.',
  '正在应用设置…': 'Applying settings…', '设置已应用': 'Settings applied', '操作失败：': 'Operation failed:',
  '无法读取 ZIP 文件': 'Cannot read ZIP file', '材质包缺少 pack.mcmeta': 'Resource pack is missing pack.mcmeta',
  'pack.mcmeta 格式无效': 'Invalid pack.mcmeta', '材质包没有可用的 Minecraft 资源': 'Resource pack contains no usable Minecraft assets',
  '无法保存设置，当前会话仍可使用。': 'Could not save settings. They still apply to this session.',
  '无法读取本地材质包，仍可在当前会话导入。': 'Could not restore local packs. You can still import packs for this session.',
  '无法保存本地材质包，刷新后需要重新导入。': 'Could not save local packs. Import them again after refreshing.',
  '部分设置未能恢复：': 'Some settings could not be restored:',
  '切换语言': 'Switch language',
  '惯用手': 'Main arm', '右手': 'Right hand', '左手': 'Left hand', '轻度': 'Low', '中度': 'Medium', '重度': 'High',
  '头部装备': 'Head equipment', '胸部装备': 'Chest equipment', '腿部装备': 'Leg equipment', '脚部装备': 'Feet equipment',
  '主手': 'Main hand', '副手': 'Off hand', '身体装备': 'Body equipment', '鞍具': 'Saddle', '装备染色': 'Equipment dye',
  '吞入方块': 'Swallowed block', '移动方块': 'Moving block', '移动进度': 'Movement progress', '运动方向': 'Movement', '伸出': 'Extending', '收回': 'Retracting', '活塞源': 'Source piston',
  '附魔光效': 'Enchantment glint', '盔甲纹饰': 'Armor trim', '纹饰材质': 'Trim material', '装备损伤': 'Equipment damage',
  '盔甲架姿态': 'Armor stand pose', '举手': 'Raised arm', '持武器': 'Holding weapons', '默认': 'Default',
  '世界坐标轴：X 东，Y 上，Z 南': 'World axes: X east, Y up, Z south',
  '正在加载模型目录…': 'Loading catalog…', '资源包下载失败': 'Resource pack download failed',
  '模型图鉴': 'Model catalog', '全部': 'All', '方块': 'Blocks', '生物': 'Mobs', '实体': 'Entities',
  '分类': 'Category', '资源包': 'Resource pack', 'XK 材质包': 'XK resource pack', '原版材质': 'Vanilla textures',
  '暂停动画': 'Pause animations', '继续动画': 'Resume animations', '状态与变种': 'States and variants',
  '返回预览器': 'Back to viewer', '搜索中文名或 ID': 'Search names or IDs', '搜索方块、生物、实体或展示框物品': 'Search blocks, mobs, entities or frame items',
  '点击卡片查看状态与变种': 'Select a card to inspect states and variants', '没有找到匹配的对象，请尝试其他名称或切换分类。': 'No matches. Try another name or category.',
  '← 上一页': '← Previous', '下一页 →': 'Next →', '分页': 'Pagination', '渲染对象列表': 'Rendered objects',
  '关闭详情': 'Close details', '可旋转的模型预览': 'Interactive model preview', '模型状态': 'Model state',
  '拖动旋转 · 滚轮缩放': 'Drag to rotate · Scroll to zoom', '重置视角': 'Reset camera', '恢复默认状态': 'Reset state',
  '展示框物品': 'Item in frame', '筛选物品名称': 'Filter item names', '筛选展示框物品': 'Filter frame items', '空展示框': 'Empty frame',
  '加载中…': 'Loading…', '正在加载模型…': 'Loading model…', '正在加载资源包…': 'Loading resource pack…', '加载失败：': 'Loading failed: ',
  '模型加载失败': 'Model failed to load', '此对象使用默认外观。': 'This object uses its default appearance.', '切换状态可对照不同外观': 'Change states to compare appearances',
  '此方块在世界中不可见': 'This block is invisible in the world', '此对象当前没有可显示的模型': 'No model is available for this object',
  '此对象没有对应的物品或刷怪蛋': 'This object has no corresponding item or spawn egg',
  '世界形态': 'World model', '物品形态': 'Item model', '刷怪蛋': 'Spawn egg', '展示框内': 'In item frame', '查看方式': 'View',
  '放置方式': 'Placement', '内容': 'Contents', '种类': 'Type', '类型': 'Type', '显示部分': 'Visible part', '上半': 'Upper half', '下半': 'Lower half', '床头': 'Head', '床尾': 'Foot',
  '立地': 'Standing', '挂墙': 'Wall mounted', '悬挂': 'Hanging', '朝向': 'Facing', '含水': 'Waterlogged', '年龄': 'Age', '成年': 'Adult', '幼年': 'Baby',
  '自动': 'Automatic', '静止': 'Still', '流向': 'Flow direction', '敲钟演示': 'Bell ringing demo', '关闭': 'Off', '播放': 'Play',
  '书本': 'Book', '无人靠近': 'No player nearby', '展开翻页': 'Open and turn pages', '眼睛': 'Eye', '闭合': 'Closed', '睁开': 'Open',
  '是': 'Yes', '否': 'No', '无': 'None', '有': 'Yes', '不显示': 'None', '隐藏': 'Hidden', '显示': 'Visible', '低': 'Low', '高': 'Tall',
  '北': 'North', '南': 'South', '西': 'West', '东': 'East', '东北': 'Northeast', '东南': 'Southeast', '西南': 'Southwest', '西北': 'Northwest', '上': 'Up', '下': 'Down',
  '普通': 'Normal', '正常': 'Normal', '小型': 'Small', '大型': 'Large', '小': 'Small', '中': 'Medium', '大': 'Large', '状态': 'State', '变种': 'Variant',
  '颜色': 'Color', '身体颜色': 'Body color', '花纹颜色': 'Pattern color', '毛色': 'Coat', '羽色': 'Plumage', '花纹': 'Pattern', '毛色与花纹': 'Coat and markings',
  '体型': 'Size', '大小': 'Size', '姿态': 'Pose', '手臂姿态': 'Arm pose', '空手': 'Empty hands', '持弩': 'Holding crossbow', '手臂': 'Arms', '底座': 'Base plate',
  '温带': 'Temperate', '暖地': 'Warm', '寒带': 'Cold', '站立': 'Standing', '坐下': 'Sitting', '睡眠': 'Sleeping', '清醒': 'Awake',
  '驯服': 'Taming', '未驯服': 'Untamed', '已驯服': 'Tamed', '项圈颜色': 'Collar color', '环境': 'Environment', '水中 / 滞空': 'In water / airborne', '地面': 'On ground',
  '普通苦力怕': 'Normal creeper', '闪电苦力怕': 'Charged creeper', '护甲': 'Armor', '半血护甲': 'Armored', '生成状态': 'Spawning', '无敌阶段': 'Invulnerable',
  '飞行': 'Flying', '倒挂': 'Hanging', '羊毛': 'Wool', '未剪毛': 'Unshorn', '已剪毛': 'Sheared', '特殊名称': 'Custom name', '彩虹羊毛（jeb_）': 'Rainbow wool (jeb_)',
  '红色': 'Red', '橙色': 'Orange', '黄色': 'Yellow', '白色': 'White', '黑色': 'Black', '粉红色': 'Pink', '棕色': 'Brown', '绿色': 'Green', '蓝色': 'Blue', '青色': 'Cyan',
  '淡蓝色': 'Light blue', '淡灰色': 'Light gray', '灰色': 'Gray', '品红色': 'Magenta', '紫色': 'Purple', '黄绿色': 'Lime', '金色': 'Gold', '奶油色': 'Creamy',
  '北侧': 'North side', '南侧': 'South side', '东侧': 'East side', '西侧': 'West side', '上方连接': 'Upper connection', '下方连接': 'Lower connection',
  '材质与类型': 'Material and type', '物品旋转': 'Item rotation', '轴向': 'Axis', '半部': 'Half', '形状': 'Shape', '开启': 'Open', '供能': 'Powered',
  '点亮': 'Lit', '生长阶段': 'Growth stage', '液面等级': 'Fluid level', '旋转': 'Rotation', '门轴': 'Hinge', '占用': 'Occupied', '食用次数': 'Bites',
  '安装方式': 'Attachment', '单墙': 'Single wall', '双墙': 'Double wall', '附着面': 'Attachment face', '墙面': 'Wall', '顶面': 'Ceiling', '左': 'Left', '右': 'Right',
  '墙内': 'In wall', '附着': 'Attached', '距离': 'Distance', '持续存在': 'Persistent', '上下': 'Vertical', '东西': 'East–west', '南北': 'North–south',
  '双层': 'Double', '单个': 'Single', '直形': 'Straight', '内左': 'Inner left', '内右': 'Inner right', '外左': 'Outer left', '外右': 'Outer right',
  '蜂蜜等级': 'Honey level', '倾斜': 'Tilt', '蜡烛数量': 'Candle count', '左侧药水': 'Left bottle', '中间药水': 'Middle bottle', '右侧药水': 'Right bottle',
  '向下流动': 'Downward flow', '红石信号': 'Redstone power', '感测阶段': 'Sensor phase', '激活': 'Active', '未激活': 'Inactive', '冷却': 'Cooldown',
  '浆果': 'Berries', '条件制约': 'Conditional', '模式': 'Mode', '比较': 'Compare', '减法': 'Subtract', '朝向组合': 'Orientation', '触发': 'Triggered',
  '反相': 'Inverted', '湿润度': 'Moisture', '覆雪': 'Snowy', '启用': 'Enabled', '有唱片': 'Has record', '有书': 'Has book', '乐器': 'Instrument', '音高': 'Note',
  '底部': 'Bottom', '花朵数量': 'Flower count', '伸出': 'Extended', '缩短': 'Short', '粗细': 'Thickness', '垂直朝向': 'Vertical direction', '侧面': 'Side',
  '延迟': 'Delay', '锁定': 'Locked', '充能': 'Charges', '绽放': 'Bloom', '允许召唤': 'Can summon', '尖啸': 'Shrieking', '孵化阶段': 'Hatch stage',
  '层数': 'Layers', '不稳定': 'Unstable', '蛋数量': 'Egg count', '左角': 'Left horn', '右角': 'Right horn',
  '显性基因': 'Main gene', '隐性基因': 'Hidden gene', '懒惰': 'Lazy', '忧郁': 'Worried', '顽皮': 'Playful', '虚弱': 'Weak', '好斗': 'Aggressive',
  '苍白': 'Pale', '斑点': 'Spotted', '雪地': 'Snowy', '灰烬': 'Ashen', '锈色': 'Rusty', '森林': 'Woods', '栗色': 'Chestnut', '条纹': 'Striped',
  '情绪': 'Mood', '平静': 'Calm', '愤怒': 'Angry', '虎斑': 'Tabby', '黑白': 'Tuxedo', '暹罗': 'Siamese', '英国短毛': 'British Shorthair',
  '三花': 'Calico', '波斯': 'Persian', '布偶': 'Ragdoll', '红狐': 'Red', '雪狐': 'Snow', '黑白花色': 'Black and white', '椒盐色': 'Salt and pepper',
  '无花纹': 'No markings', '白袜': 'White stockings', '白色斑块': 'White patches', '白色斑点': 'White dots', '黑色斑点': 'Black dots', '深棕色': 'Dark brown',
  '携带海龟蛋': 'Carrying eggs', '伸展': 'Unrolled', '蜷缩': 'Rolled up', '温度': 'Temperature', '温暖': 'Warm', '寒冷': 'Cold',
  '膨胀': 'Puff state', '未膨胀': 'Deflated', '半膨胀': 'Half puffed', '完全膨胀': 'Fully puffed', '红蓝': 'Red and blue', '黄蓝': 'Yellow and blue',
  '花蜜': 'Nectar', '尾刺': 'Stinger', '已使用': 'Used', '地区服装': 'Biome clothing', '平原': 'Plains', '沙漠': 'Desert', '丛林': 'Jungle',
  '热带草原': 'Savanna', '沼泽': 'Swamp', '针叶林': 'Taiga', '职业': 'Profession', '职业等级': 'Profession level', '新手': 'Novice', '学徒': 'Apprentice',
  '老手': 'Journeyman', '专家': 'Expert', '大师': 'Master', '蘑菇': 'Mushrooms', '保留': 'Present', '已剪除': 'Sheared',
  '原色': 'Undyed', '开合': 'Opening', '半开': 'Half open', '全开': 'Fully open', '吸附面': 'Attached face', '北墙': 'North wall', '南墙': 'South wall',
  '西墙': 'West wall', '东墙': 'East wall', '裂纹': 'Cracks', '轻度': 'Low', '中度': 'Medium', '重度': 'High',
  '氧化程度': 'Oxidation', '未氧化': 'Unaffected', '斑驳': 'Exposed', '锈蚀': 'Weathered', '氧化': 'Oxidized',
}
const translatedNames = new Map(Object.entries(ZH_NAMES).filter(([key]) => EN_NAMES[key]).map(([key, value]) => [value, EN_NAMES[key]]))
const humanize = text => String(text).replace(/^minecraft:/, '').replace(/^nbt\./, '').replaceAll('_', ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase())
export function t(text, fallback = text) {
  if (language !== 'en') return text
  if (words[text] || translatedNames.has(text)) return words[text] || translatedNames.get(text)
  if (!/[\u3400-\u9fff]/.test(text)) return text
  if (/^花纹 \d+$/.test(text)) return text.replace('花纹', 'Pattern')
  if (text.includes(' · ')) return text.split(' · ').map(s => t(s, fallback)).join(' · ')
  return humanize(fallback)
}
export function optionLabel(option) {
  const fallback = typeof option.value === 'string' || typeof option.value === 'number' ? option.value : 'Default'
  return t(option.label, fallback)
}
export function translateDocument() {
  document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN'
  document.title = t('Minecraft 方块与生物模型图鉴 | LitematicWebViewer')
  for (const element of document.querySelectorAll('[data-i18n-content]')) {
    element.dataset.originalContent ||= element.content
    element.content = language === 'en' ? t(element.dataset.i18nContent) : element.dataset.originalContent
  }
  for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n)
  for (const element of document.querySelectorAll('[placeholder], [aria-label]')) {
    for (const attribute of ['placeholder', 'aria-label']) {
      const key = 'source' + attribute.replace('-', '')
      if (!element.hasAttribute(attribute)) continue
      element.dataset[key] ||= element.getAttribute(attribute)
      element.setAttribute(attribute, t(element.dataset[key]))
    }
  }
  document.getElementById('language').textContent = language === 'en' ? '中文' : 'English'
}
