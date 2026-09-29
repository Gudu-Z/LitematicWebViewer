# LitematicWebViewer

一个纯前端网页，用来在浏览器里 3D 预览 Minecraft 的 `.litematica` 结构文件（Litematica 模组保存的建筑蓝图）。
代码主要由ai完成
- **真实贴图**渲染，支持加载 **资源包（.zip）** 更换方块贴图
- **3D 可旋转**：环绕 / 飞行两种相机模式，拖拽旋转、滚轮缩放、右键平移
- **实体渲染**：矿车、船、告示牌、玩家头颅等用真实模型与皮肤显示
- **区域切换**：按区域显示/隐藏结构，层级切片渲染
- 纯浏览器运行，**不需要后端服务器**

---

## 一、首次安装（只需做一次）

需要先安装 [Node.js](https://nodejs.org/)（18 或更高版本）。

打开命令行，进入本项目文件夹，依次执行：

```bash
npm install        # 安装依赖
npm run setup      # 下载 Minecraft 官方贴图/模型（约 20 MB，需要联网）
```

> `npm run setup` 默认下载 **1.20.4** 版本的资源。想换版本可执行：
> `node scripts/fetch-assets.mjs 1.21.1`（版本号换成你游戏对应的版本）。

## 二、启动预览器

```bash
npm run dev
```

浏览器会自动打开 `http://localhost:5173`。

## 三、使用

1. 点击 **「打开 .litematica 文件」**，或者直接把 `.litematic` 文件**拖进网页**。
2. 稍等片刻，建筑就会以 3D 形式显示出来。
3. 左侧 **「资源包」** 列表会显示 `resourcepacks/` 目录里的资源包，点击「加载」即可换贴图；点「恢复默认材质」卸载。

> 项目默认加载 [XK redstone display](https://modrinth.com/resourcepack/xk-redstone-display) 资源包，让红石粉显示 0–15 强度数字。

**操作方式**：
- **环绕模式**（默认）：左键拖拽旋转 · 滚轮缩放 · 右键平移
- **飞行模式**（按 W/A/S/D 自动切换）：左键原地转头 · W/A/S/D 沿视线移动 · 右键平移 · 滚轮调速 · 空格/Shift 升降
- **E / Q**：上一 / 下一层（配合左侧「渲染」的层级模式）
- **「定位到此处」按钮**：把相机移到当前层所在高度

## 四、测试用样例

项目里自带一个测试文件 `samples/demo.litematic`（一个小房子），可以直接拖进网页测试。

## 五、已知限制（第一版）

- 玻璃、树叶、水等透明方块为简化处理（不透明渲染或跳过）
- 告示牌背面文字、发光/彩色文字等细节暂不支持
- 方块模型旋转、`uvlock`、多贴图方块（部分方块）可能有细微差异
- 极老版本存档的部分方块贴图可能有细微出入

## 六、目录结构

```
src/
  main.js        入口：文件读取、拖拽、资源包加载
  nbt.js         NBT 二进制解析 + gzip/zlib 解压
  litematica.js  .litematica 解析（位解码、区域归一化）
  blocks.js      方块状态 -> 六面贴图解析
  assets.js      资源提供者（默认资源 + 资源包覆盖）
  renderer.js    Three.js 渲染（隐藏面剔除、按贴图合并）
  ui.js          界面更新
scripts/
  fetch-assets.mjs  下载官方资源
  gen-test.mjs      生成测试样例 + 解码回环验证
public/assets/minecraft/  默认官方资源（贴图/模型/blockstates）
```

## 七、参考与致谢

本项目参考了以下项目与资料（在此致谢）：

- [Litematica 模组](https://github.com/maruohon/litematica) —— `.litematica` 文件格式的来源（Minecraft 建筑蓝图模组）
- [prismarine-viewer](https://github.com/PrismarineJS/prismarine-viewer) —— 方块模型烘焙的主要参考（面角点表 FACE_CORNERS、UV 旋转、变体旋转等公式）
- [litematic-viewer](https://github.com/endingcredits/litematic-viewer) —— 同类 `.litematica` 预览器项目

**默认资源包**：[XK redstone display](https://modrinth.com/resourcepack/xk-redstone-display) —— 让红石粉显示 0–15 强度数字。

**依赖库**：

- [Three.js](https://threejs.org/) —— 3D 渲染
- [JSZip](https://stuk.github.io/jszip/) —— 资源包（.zip）解压
- [Vite](https://vite.dev/) —— 构建工具

**游戏资源**：默认贴图/模型取自 Minecraft 官方 `client.jar`，由 `npm run setup` 下载（默认 1.20.4）。
