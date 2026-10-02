# LitematicWebViewer

一个纯前端的网页，用来在浏览器里 3D 预览 Minecraft 的 `.litematica` 结构文件（Litematica 模组保存的建筑蓝图）。代码主要由 AI 完成。

## 功能

**渲染**

- **真实贴图**渲染，支持加载 **资源包（.zip）** 更换方块贴图
- 完整方块模型（楼梯、栅栏、门、红石线/元件、铁轨等），隐藏面剔除、按贴图合并
- 草 / 树叶 / 水 / 岩浆染色；水与岩浆半透明渲染，并复刻原版的水下雾、水面流向、气泡柱
- 特殊方块：陶罐（陶片图案）、雕文书架、末地传送门 / 折跃门、移动活塞、旗帜、铜傀儡雕像
- 实体渲染：矿车、船、告示牌文字、玩家头颅（真实皮肤）、物品展示框

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
- 右上角：**眼睛** 隐藏/显示界面 · **地球** 切换语言 · **齿轮** 设置 · GitHub 链接
- **移动端**：飞行模式下左下角摇杆前后左右移动、右下角 ▲▼ 上升下降，单指划屏转头

## 四、测试用样例

项目里自带一个测试文件 `samples/demo.litematic`（一个小房子），可以直接拖进网页测试。

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
