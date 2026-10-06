# LitematicWebViewer

一个纯前端的网页，用来在浏览器里 3D 预览 Minecraft 的 `.litematica` 结构文件（Litematica 模组保存的建筑蓝图）。代码主要由 AI 完成。

## 功能

**渲染**

- **真实贴图**渲染，支持加载 **资源包（.zip）** 更换方块贴图
- 完整方块模型（楼梯、栅栏、门、红石线/元件、铁轨等），隐藏面剔除、按贴图合并
- 草 / 树叶 / 水 / 岩浆染色；水与岩浆半透明渲染，并复刻原版的水下雾、水面流向、气泡柱
- 特殊方块：陶罐（陶片图案）、雕文书架、末地传送门 / 折跃门、移动活塞、旗帜、铜傀儡雕像
- 实体渲染：矿车、船、告示牌文字、玩家头颅（真实皮肤）、物品展示框
- 85 种生物：持续特效、骨骼待机动画，以及存档中的皮肤、羊毛、膨胀、坐姿等状态

**交互**

- 环绕 / 飞行两种相机模式，可随时切换
- 区域显示 / 隐藏、层级切片渲染（全部 / 下方 / 上方 / 单层）
- 材料清单：按方块统计数量、中文译名、多 ↔ 少排序
- 中 / 英双语界面
- 设置面板：背景色、显示实体 / 区域线框 / 尺寸、水下雾、镜头灵敏度
- 移动端适配：飞行模式下左下角虚拟摇杆移动、右下角上升 / 下降按钮

纯浏览器运行，**不需要后端服务器**。

---

## 一、首次安装（只需做一次）

需要先安装 [Node.js](https://nodejs.org/)（18 或更高版本）。

打开命令行，进入本项目文件夹，依次执行：

```bash
npm install        # 安装依赖
npm run setup      # 下载 Minecraft 官方贴图/模型（约 20 MB，需要联网）
```

> `npm run setup` 默认下载 **26.3**（最新正式版）的资源。想换版本可执行：
> `node scripts/fetch-assets.mjs 1.21.1`（版本号换成你游戏对应的版本）。

## 二、启动预览器

```bash
npm run dev
```

浏览器会自动打开 `http://localhost:5173`。

## 三、使用

1. 点击 **「打开 .litematica 文件」**，或者直接把 `.litematic` 文件**拖进网页**。
2. 稍等片刻，建筑就会以 3D 形式显示出来。
3. 点右上角 **齿轮** 打开设置面板，里面可以切换背景色、显示开关、镜头灵敏度，以及管理 **资源包**（点击「加载」换贴图、卸载恢复默认）。

> 项目默认加载 [XK redstone display](https://modrinth.com/resourcepack/xk-redstone-display) 资源包，让红石粉显示 0–15 强度数字。

**操作方式**

- **环绕模式**（默认）：左键拖拽旋转 · 滚轮缩放 · 右键平移
- **飞行模式**（按 W/A/S/D 自动切换）：左键原地转头 · W/A/S/D 沿视线移动 · 右键平移 · 滚轮调速 · 空格 / Shift 升降
- **E / Q**：上一 / 下一层（配合设置里的「渲染模式」层级切片）
- **「定位到此处」按钮**：把当前层设为摄像机所在高度
- 右上角：**眼睛** 隐藏/显示界面 · **检查清单** 在新标签页打开渲染检查 · **地球** 切换语言 · **齿轮** 设置 · GitHub 链接
- **移动端**：飞行模式下左下角摇杆前后左右移动、右下角 ▲▼ 上升下降，单指划屏转头

## 四、测试用样例

项目里自带一个测试文件 `samples/demo.litematic`（一个小房子），可以直接拖进网页测试。

点击预览器工具栏中“隐藏界面”和“切换语言”之间的检查清单按钮，即可在新标签页打开[渲染检查页](http://127.0.0.1:5173/scripts/entity-preview.html)。支持“全部 / 方块 / 生物 / 实体”分类、中文名或 ID 搜索、分页和暂停动画；本地和 GitHub Pages 发布版均可使用。

目录包含当前原版资源的 1,289 个方块、85 种已支持生物，以及船、矿车、物品展示框、盔甲架四类实体。点击卡片打开可旋转、缩放的模型详情；同一种生物的颜色、皮肤、姿态和持续特效可组合切换，船包含 22 种木材与箱船组合，展示框可筛选 1,658 种物品。门、床和双层植物默认显示全部，可切换单独部分；插蜡烛蛋糕合并到蛋糕卡片，挂墙旗帜合并到对应颜色的旗帜卡片。盔甲架默认隐藏手臂。

方块选项合并资源包模型声明与 [26.3 游戏生成的状态报告（mcmeta 归档）](https://github.com/misode/mcmeta/blob/26.3-summary/blocks/data.json)，包含 505 种可含水方块（另兼容旧版 chain ID）以及墙的“不显示 / 低 / 高”连接状态。方块网格、流体与特殊方块实体共用主预览器的渲染路径。空气等不可见方块保留目录项并标明原因；检查页显示的是当前渲染器的能力，仍受下文已知外观差异的限制。

名称来自 Minecraft 26.3 官方 `zh_cn.json`，检查页默认使用内置 XK 材质包，也可切换原版；显式选择原版后，刷新保留该选择。更新默认资源版本后运行 `node scripts/gen-inspection-data.mjs <版本>`，重新生成目录、状态报告与官方译名。

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

仍确认存在的差异：幼体目前沿用成年模型；寒冷/温暖牛、猪、鸡等变种目前只切换贴图，未切换专用几何；村民帽子尚未读取资源包的 hat 元数据；盔甲、鞍具、马铠、狼铠、手持物、末影人搬运方块、拴绳及乘骑组合尚未完整渲染。静态投影也不能复现游戏中的动态光照和实体之间的交互。这些项目不计为本轮已完成的持续特效/待机动画。

验证命令（需先执行 `npm run setup` 安装默认资源）：

```bash
node scripts/verify-entities.mjs  # 全部生物/状态、真实贴图、绑定姿态、动画无漂移、资源隔离及释放
node scripts/verify-breeze.mjs   # 风层几何、UV、透明排序与滚动
node scripts/verify-shulker.mjs  # 共用潜影盒几何回归
node scripts/verify-waxed-items.mjs  # XK 的 60 种涂蜡物品、展示框描边与原版回退
node scripts/verify-render-inspection.mjs  # 目录与译名、525 个实体状态、多格组合、含水/墙、旗帜对齐和船桨
npm run build
```

`src/entityAnimationData.js` 已包含运行所需关键帧。需要重新生成时，将上述固定版本的 `Breeze/Bat/Camel/Frog/CopperGolem/ArmadilloAnimations.java` 放在 `scripts/_ref/`，再运行 `node scripts/gen-entity-animations.mjs`；运行网站不需要这些 Java 文件。

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
