# LitematicWebViewer

在浏览器里 3D 预览 Minecraft 的 `.litematic` / `.litematica` 投影文件（Litematica 模组保存的建筑蓝图），也可以通过模型图鉴页查看方块、生物和实体的不同状态。纯前端运行，不需要后端服务器。代码主要由 AI 完成。

**[在线预览器](https://gudu-z.github.io/LitematicWebViewer/)** · **[模型图鉴](https://gudu-z.github.io/LitematicWebViewer/scripts/entity-preview.html)** · **[下载示例文件](samples/demo.litematic)**

![预览器打开示例建筑，左侧可切换渲染层级，右侧显示区域和材料清单](docs/images/viewer.png)

*打开投影后，可以旋转、缩放建筑，查看材料清单，或切换层级检查内部结构。图中使用仓库自带的 `demo.litematic`。*

## 功能

**渲染**

- **真实贴图**渲染，支持加载 **资源包（.zip）** 更换方块贴图
- 完整方块模型（楼梯、栅栏、门、红石线/元件、铁轨等），隐藏面剔除、按贴图合并
- 草 / 树叶 / 水 / 岩浆染色；水与岩浆半透明渲染，并复刻原版的水下雾、水面流向、气泡柱
- 特殊方块：钟、附魔台书本、潮涌核心、动态末地传送门 / 折跃门、飘动旗帜、陶罐（陶片图案）、雕文书架、铜傀儡雕像等
- 实体渲染：矿车、船、坐垫、告示牌文字、玩家头颅（真实皮肤）、物品展示框
- 85 种生物：持续特效、骨骼待机动画，以及皮肤、羊毛、膨胀、坐姿等状态；其中 40 种支持幼年形态
- 原版动画贴图帧表与插值；资源包可覆盖动画，例如内置 XK 的水贴图为单帧

**交互**

- 环绕 / 飞行两种相机模式，可随时切换
- 透视 / 正交渲染切换，默认透视；正交视图便于比较尺寸和查看结构
- 区域显示 / 隐藏、层级切片渲染（全部 / 下方 / 上方 / 单层）
- 材料清单：按方块统计数量、中文译名、多 ↔ 少排序
- 中 / 英双语界面
- 模型图鉴：分类、双语搜索、状态组合，以及世界 / 物品 / 刷怪蛋 / 展示框视图
- 设置面板：背景色、显示实体 / 区域线框 / 尺寸、水下雾、镜头灵敏度
- 移动端适配：飞行模式下左下角虚拟摇杆移动、右下角上升 / 下降按钮

日常使用直接打开[在线预览器](https://gudu-z.github.io/LitematicWebViewer/)即可；以下安装步骤适合本地运行或开发。

---

## 一、首次安装（只需做一次）

需要先安装 [Node.js](https://nodejs.org/) **22.12 或更高版本**。

打开命令行，进入本项目文件夹，依次执行：

```bash
npm install        # 安装依赖
npm run setup      # 下载官方客户端并提取贴图/模型，需要联网
```

> 默认资源版本为 **26.3**，首次运行会下载完整的 `client.jar` 并提取所需资源。也可以运行 `node scripts/fetch-assets.mjs 1.21.1` 指定其他版本；图鉴目录和新版实体模型仍以 26.3 为基准。

## 二、启动预览器

```bash
npm run dev
```

浏览器会自动打开 `http://localhost:5173`。

## 三、使用

1. 点击 **「打开投影文件」**，或者直接把 `.litematic` 文件**拖进网页**。首次打开也可以点击 **「体验示例建筑」**。
2. 稍等片刻，建筑就会以 3D 形式显示出来。
3. 用左侧的 **「渲染」和「层级」** 控件查看全部、单层或指定层上下的结构；右侧可查看区域和材料清单。
4. 点右上角 **齿轮** 打开设置，**「显示与操作」**中可调整背景色、显示开关与镜头灵敏度，**「资源包」**中可管理材质；左侧资源包摘要也可直接打开对应设置。

资源包支持批量导入本地 ZIP、加载、卸载和上下排序，越靠上的包优先级越高，新导入的包放在最上方。卸载的本地包仍保留在可用列表，可随时重新加载；**「全部卸载」**恢复原版材质。文件和加载顺序保存在当前浏览器，刷新后恢复。切换资源包会保留当前视角、渲染层级和区域选择。

![新版设置中的资源包管理，可加载、卸载、排序或导入本地 ZIP](docs/images/viewer-packs.png)

> 项目默认加载 [XK redstone display](https://modrinth.com/resourcepack/xk-redstone-display) 资源包，让红石粉显示 0–15 强度数字。

**操作方式**

- **环绕模式**（默认）：左键拖拽旋转 · 滚轮缩放 · 右键平移
- **飞行模式**（按 W/A/S/D 自动切换）：左键原地转头 · W/A/S/D 沿视线移动 · 右键平移 · 滚轮调速 · 空格 / Shift 升降
- **E / Q**：上一 / 下一层（配合左侧「渲染」下拉框的层级切片）
- **「定位到此处」按钮**：把当前层设为摄像机所在高度
- **「适应窗口」按钮**：重新居中建筑，自动给两侧面板留出空间
- 右上角：**眼睛** 隐藏/显示界面 · **网格** 切换透视/正交渲染（高亮表示正交） · **方块图鉴** 在新标签页打开模型图鉴 · **地球** 切换语言 · **齿轮** 设置 · GitHub 链接
- **移动端**：底部“视图控制 / 结构信息”按需展开面板；飞行模式下左下角摇杆前后左右移动、右下角 ▲▼ 上升下降，单指划屏转头

## 四、模型图鉴

无需加载投影文件，打开[在线模型图鉴页](https://gudu-z.github.io/LitematicWebViewer/scripts/entity-preview.html)即可浏览模型。本地运行时，点击预览器右上角带方块的图鉴按钮，也可以直接打开 `http://localhost:5173/scripts/entity-preview.html`。

支持“全部 / 方块 / 生物 / 实体”分类、中英文名称或 ID 搜索、分页、暂停动画和中英界面切换。顶部“设置”可加载、卸载、排序材质包，并导入本地 ZIP；越靠上的包优先级越高，未覆盖的资源回退原版。首次打开默认加载内置 XK，卸载全部材质包即可使用原版。导入文件、加载顺序和趣味选项保存在当前浏览器；语言和搜索条件仍保存在 URL 中，兼容旧链接的 `pack=xk` / `pack=vanilla`。

主界面设置的“显示与操作”和模型图鉴设置中均有“巨儒卫道士”开关，默认关闭；开启后，卫道士、唤魔者和幻术师同时显示交叉手臂与独立双臂。两处分别记住开关状态，主界面切换后立即更新当前投影中的生物。

![模型图鉴页的生物分类，可按名称搜索并点击卡片查看状态](docs/images/render-catalog.png)

*先选分类或输入名称，再点击卡片。图鉴涵盖 1,289 个方块（合并为 1,167 张卡片）、85 种生物，以及船、矿车、展示框、盔甲架和坐垫五类实体。*

### 在同一卡片中切换状态

| 检查对象 | 可以切换的内容 |
| --- | --- |
| 生物 | 皮肤、颜色、姿态、持续特效，以及适用生物的成年 / 幼年形态，例如普通 / 闪电苦力怕、幼猫坐姿 |
| 方块 | 原版方块状态，包括 505 种可含水方块、墙的“不显示 / 低 / 高”连接；门、床、双层植物默认完整显示 |
| 同类变种 | 蜡烛蛋糕归入蛋糕，挂墙告示牌 / 旗帜 / 头颅 / 火把 / 珊瑚扇归入对应卡片，炼药锅内容物和所有盆栽分别合并 |
| 船与其他实体 | 22 种木材与箱船组合、矿车类型、16 色坐垫及朝向、盔甲架手臂等；盔甲架默认隐藏手臂 |
| 装备 | 盔甲架和适用生物的四个盔甲槽、主副手、惯用手、头部物品与鞘翅；马铠、狼铠、鞍具、羊驼地毯及快乐恶魂挽具；可组合染色、盔甲纹饰与附魔光效 |
| 物品与展示框 | 切换“查看方式”，检查对应物品、刷怪蛋或放入展示框后的样子；展示框卡片可筛选 1,658 种物品 |
| 特殊效果 | 水 / 岩浆的静止与八向流动、敲钟演示、附魔台翻书、潮涌核心激活与眼睛状态 |

![猫的详情卡片，右侧将年龄设为幼年、姿态设为坐下](docs/images/render-detail.png)

*右侧下拉框可组合切换状态；左侧模型支持拖动旋转和滚轮缩放，左下角 XYZ 坐标轴随视角旋转，帮助判断朝向（X 东、Y 上、Z 南）。“查看方式”可切换物品 / 刷怪蛋和展示框视图。*

物品、刷怪蛋和幼年形态的可用性以原版为准；不可见方块或没有对应物品的对象会显示说明。若想对比水的逐帧动画，请切换原版材质：XK 的水贴图本身为单帧。

<details>
<summary>开发说明：资源来源、渲染对照与验证命令</summary>

方块选项合并资源包模型声明与 [26.3 游戏生成的状态报告（mcmeta 归档）](https://github.com/misode/mcmeta/blob/26.3-summary/blocks/data.json)，包含 505 种可含水方块（另兼容旧版 chain ID）以及墙的“不显示 / 低 / 高”连接状态。方块网格、流体与特殊方块实体共用主预览器的渲染路径。空气等不可见方块保留目录项并标明原因；图鉴页显示的是当前渲染器的能力，仍受下文已知外观差异的限制。

名称来自 Minecraft 26.3 官方 `zh_cn.json` 和 `en_us.json`。图鉴设置与主预览器独立；本地材质包通过 IndexedDB 保存，不上传服务器。更新默认资源版本后运行 `node scripts/gen-inspection-data.mjs <版本>`，重新生成目录、状态报告与官方译名。

坐垫按 26.3 的 [CushionModel](https://mc-packet-reference.netlify.app/26.x/source/net/minecraft/client/model/object/cushion/cushionmodel/) 和 [CushionRenderer](https://mc-packet-reference.netlify.app/26.x/source/net/minecraft/client/renderer/entity/cushionrenderer/) 渲染，读取实体 NBT 的 `color` 与朝向。图鉴将 16 色坐垫合并为一张实体卡片，可切换颜色、四个朝向，以及对应的物品和展示框视图；投影主预览器使用同一渲染实现。

![盔甲架穿戴钻石盔甲，手持钻石剑与盾牌](docs/images/equipment.png)

装备按 26.3 的 [HumanoidArmorLayer](https://mc-packet-reference.netlify.app/26.x/source/net/minecraft/client/renderer/entity/layers/humanoidarmorlayer/)、`EquipmentLayerRenderer`、`ItemInHandLayer` 和动物专用模型实现。主预览器自动读取新版 `equipment`，同时兼容旧版 `ArmorItems`、`HandItems`、`ArmorItem`、`DecorItem` 和鞍具数据。图鉴中可逐槽选择装备；装备跟随骨骼姿态与待机动作，幼年生物使用新版专用盔甲模型，小型盔甲架保持原版缩放。手持物使用第三人称变换，三叉戟使用立体模型；皮革染色、狼铠损伤和盔甲纹饰读取物品组件及资源包。附魔光效使用原版贴图近似混合，目前用于穿戴装备。运行 `node scripts/gen-equipment-data.mjs --fetch` 可更新记录来源与 SHA-256 的模型数据和默认装备组件。

装备设置随当前穿戴物显示：皮革装备、皮革马铠和狼铠可染色；选中纹饰后才显示纹饰材质；狼铠损伤、附魔光效和惯用手也只在适用时出现。幼年动物隐藏无法渲染的身体装备与鞍具，猫和狼在驯服后才显示项圈颜色。移除适用装备会清除对应的预览设置，混搭时染色和纹饰只应用到适用槽位。

特殊方块对照 26.3 的 `BellModel`、`BannerRenderer`、`TheEndPortalRenderer`、`TheEndGatewayRenderer`、附魔台及潮涌核心渲染器。钟补全钟体，旗面绕横杆摆动，展示框旗帜遵循物品固定视角变换；末地传送门使用上下水平面，折跃门使用六面体，二者使用[官方末地传送门着色器](https://github.com/misode/mcmeta/blob/26.3-assets/assets/minecraft/shaders/core/rendertype_end_portal.fsh)的投影采样与分层星空。通用动画纹理支持 `.mcmeta` 的帧顺序、逐帧时长、帧尺寸和颜色插值，因此水、岩浆、火焰、下界传送门等贴图按原版帧表播放。图鉴页暂停按钮同时暂停贴图、方块和实体动画。

### 生物渲染对照记录

持续特效和待机姿态按原版 `EntityModel.setAngles`、动画关键帧及 `FeatureRenderer` 实现。参考基线是 [1.21.11 源码镜像的固定版本](https://github.com/duollectis/minecraft-decompiled-1.21.11/tree/b4cb28a04035b7a190aaf74d4b9ba5ed11095cbb/src/main/java/net/minecraft/client/render/entity)，保留项目已经对照 26.3 客户端转录的新版兔子模型和烈焰人火棒布局。默认贴图仍为 26.3，尚未完成两个版本之间全部实体模型差异的迁移。

| 对照项 | 当前处理 |
| --- | --- |
| 流动/发光图层 | 旋风人风层与眼睛、闪电苦力怕护盾、半血凋零护甲、监守者心跳/光斑、生物发光眼睛、发光鱿鱼、`jeb_` 彩虹羊毛 |
| 持续待机 | 烈焰人火棒、恶魂触手、鱿鱼触手、幻翼/蜜蜂/悦灵/恼鬼/蝙蝠翅膀、鱼尾和鱼鳍、守卫者棘刺/尾巴、炽足兽刚毛、蠹虫/末影螨摆动、双足生物手臂、猪灵耳朵、女巫鼻子、监守者呼吸、凋零躯干 |
| 状态相关待机 | 美西螈水陆待机、青蛙水中待机、骆驼待机及坐姿、铜傀儡转头、犰狳蜷缩、狐狸睡眠呼吸、鹦鹉/鸡滞空拍翅、潜影贝开盖摆动、末影龙翅膀和下颚 |
| 补齐外观 | 史莱姆内芯与半透明外壳、绵羊羊毛/底绒、热带鱼颜色/花纹、河豚三种体型、溺尸/流浪者/沼泽骷髅外层、村民服装、铁傀儡裂纹、驯服动物项圈、哞菇蘑菇、雪傀儡南瓜 |
| 修正模型和状态 | 洞穴蜘蛛/凋零骷髅/尸壳/猫/马/村民/灾厄村民比例、掠夺者空手/持弩双臂、船与竹筏的静止船桨、驴骡耳朵与箱子、羊驼箱子可见性、猫狼坐姿、狐狸睡姿、潜影贝头部/颜色/吸附方向、犰狳多余部件、山羊缺角、海龟蛋腹部 |

时间按每秒 20 tick 推进；从已保存 NBT 和结构中的水方块选择姿态。随机待机的起点使用稳定种子，无法还原存档中未保存的客户端动画相位。没有持续待机动作的生物保持原版静止姿态；不模拟 AI、移动、攻击、粒子、临时事件或末影龙的历史飞行轨迹。

监守者触角对照 26.3 的 [WardenModel](https://mc-packet-reference.netlify.app/26.x/source/net/minecraft/client/model/monster/warden/wardenmodel/) 与 [ModelPart.Cube](https://mc-packet-reference.netlify.app/26.x/source/net/minecraft/client/model/geom/modelpart/)：修正零厚度平面合并后横向 UV 翻转的问题，同步修正美西螈外鳃、翅膀、鱼鳍等共用部件。平面省略重合面和零面积侧面；膨胀后具有厚度的部件（如疣猪兽鬃毛）保留六面，并统一修正上下表面的法线方向。

幼年形态使用 26.3 的 27 套独立模型、专用贴图及美西螈/骆驼/犰狳待机关键帧；嗅探兽和快乐恶魂使用原版缩放规则，快乐恶魂保留幼体内芯。猫、狼、狐狸的幼年坐姿/睡姿也按新版模型处理。生成数据记录了[客户端源码镜像](https://mc-packet-reference.netlify.app/26.x/source/net/minecraft/client/model/animal/cow/babycowmodel/)的具体 URL 和 SHA-256；运行 `node scripts/gen-baby-models.mjs --fetch`、`node scripts/gen-baby-animations.mjs --fetch` 可重新获取并转录。

仍确认存在的差异：寒冷/温暖牛、猪、鸡等变种目前只切换贴图，未切换专用几何；村民帽子尚未读取资源包的 hat 元数据；狐狸叼物、熊猫进食等专用物品层、手持物附魔光效、自定义玩家头颅皮肤、拴绳及乘骑组合尚未完整渲染。手持物目前覆盖盔甲架、人形盔甲生物、掠夺者、悦灵和恼鬼，不模拟使用物品、攻击或拉弓过程。静态投影也不能复现游戏中的动态光照和实体之间的交互。图鉴页的敲钟、翻书和激活潮涌核心为显式演示选项；不模拟玩家靠近、潮涌核心框架检测、折跃门临时光束或粒子。

验证命令（需先执行 `npm run setup` 安装默认资源）：

```bash
node scripts/verify-entities.mjs  # 全部生物/状态、真实贴图、绑定姿态、动画无漂移、资源隔离及释放
node scripts/verify-entity-planes.mjs  # 平面 UV、镜像/膨胀、面法线、监守者与图鉴双套手臂
node scripts/verify-inspection-packs.mjs  # ZIP/BOM 校验、包裹目录、叠加排序、卸载与原版回退
node scripts/verify-viewer-packs.mjs  # 主界面包管理：保存/恢复、批量导入、同名替换、失败回退
node scripts/verify-viewer-framing.mjs  # 横竖屏与面板留白、各种尺寸结构的完整取景
node scripts/verify-equipment.mjs # 装备槽、新旧 NBT、幼年/小型模型、姿态同步、染色与动物装备
node scripts/verify-breeze.mjs   # 风层几何、UV、透明排序与滚动
node scripts/verify-shulker.mjs  # 共用潜影盒几何回归
node scripts/verify-waxed-items.mjs  # XK 的 60 种涂蜡物品、展示框描边与原版回退
node scripts/verify-render-inspection.mjs  # 目录与译名、626 个实体状态、多格组合、含水/墙、旗帜对齐和船桨
node scripts/verify-cushion.mjs  # 坐垫 16 色、原版尺寸/UV/朝向、NBT 和物品映射
node scripts/verify-special-rendering.mjs  # 特殊方块、分组、流向、40 种幼体及变种、1,228 个对应物品、中英文
npm run build
```

`src/entityAnimationData.js` 已包含运行所需关键帧。需要重新生成时，将上述固定版本的 `Breeze/Bat/Camel/Frog/CopperGolem/ArmadilloAnimations.java` 放在 `scripts/_ref/`，再运行 `node scripts/gen-entity-animations.mjs`；运行网站不需要这些 Java 文件。

</details>

## 五、已知限制

- 超大投影（约 2000 万方块以上）会提示「文件过大」无法预览——浏览器内存放不下全部方块与合并几何
- 没有生物群系信息，草 / 树叶 / 藤蔓统一用默认颜色（原版会按群系渐变）
- 方块模型的个别边角（`uvlock`、极端旋转组合）可能与原版有细微差异
- 极老版本存档的部分方块贴图可能有细微出入

## 六、目录结构

```
src/
  main.js             入口：文件读取、拖拽、资源包、UI 接线
  nbt.js               NBT 二进制解析 + gzip/zlib 解压
  litematica.js        .litematica 解析（位解码、区域归一化）
  blocks.js            方块状态 -> 方块模型解析（含 multipart/变体）
  modelBaker.js        模型 JSON -> 面（quad）烘焙
  geometry.js          隐藏面剔除 + 按贴图分组合并几何
  renderer.js          Three.js 渲染（相机、材质、实体、水下雾）
  entities.js          实体模型（矿车/船/物品展示框等）
  entityModel.js       实体几何、骨骼与透明面排序
  entityAppearance.js  生物皮肤、NBT 状态和附加图层
  entityAnimations.js / entityAnimationData.js   原版待机公式与关键帧
  entityModelData.js / extraEntityModels.js   实体模型数据
  entityBabies.js / babyEntityModels.js / babyAnimationData.js   26.3 幼年模型与动画
  blockEffects.js      钟、附魔台、潮涌核心及末地传送门着色器
  textureAnimation.js  原版动画贴图帧表与插值
  assets.js            资源提供者（默认资源 + 资源包覆盖）
  ui.js                界面更新
  i18n.js              中英双语字典
  blockNames.js        方块中/英文译名（由脚本生成）
  fluidFlowBlocks.js   阻挡流体流动的方块集合（由脚本生成）
  styles.css           样式
scripts/
  fetch-assets.mjs     下载官方资源
  gen-block-names.mjs  生成方块译名表
  gen-fluid-flow-blocks.mjs  生成阻挡流体流动的方块集合（BLOCKS_FLUID_FLOW）
  gen-test.mjs         生成测试样例
  copy-packs.mjs       复制资源包
  verify-*.mjs / bench-pipeline.mjs   解码/几何验证与基准（开发用）
public/
  assets/minecraft/    默认官方资源（贴图/模型/blockstates）
  fonts/               像素字体
  demo.litematic       测试样例（部署用）
resourcepacks/         可加载的资源包
docs/images/           README 的实际页面截图
```

## 七、参考与致谢

本项目参考了以下项目与资料（在此致谢）：

- [Litematica 模组](https://github.com/maruohon/litematica) —— `.litematica` 文件格式的来源（Minecraft 建筑蓝图模组）
- [prismarine-viewer](https://github.com/PrismarineJS/prismarine-viewer) —— 方块模型烘焙的主要参考（面角点表、UV 旋转、变体旋转等公式）
- [litematic-viewer](https://github.com/endingcredits/litematic-viewer) —— 同类 `.litematica` 预览器项目

**默认资源包**：[XK redstone display](https://modrinth.com/resourcepack/xk-redstone-display) —— 让红石粉显示 0–15 强度数字。

**依赖库**：

- [Three.js](https://threejs.org/) —— 3D 渲染
- [JSZip](https://stuk.github.io/jszip/) —— 资源包（.zip）解压
- [Vite](https://vite.dev/) —— 构建工具

**游戏资源**：默认贴图/模型取自 Minecraft 官方 `client.jar`，由 `npm run setup` 下载（默认 26.3）。
