// 额外实体模型：这些模型来自较新的原版实体（26.3 / 1.21.11），
// 反编译源码的 getTexturedModelData 结构无法被 parse-entity-models.mjs 自动解析
// （参数化方法 / moveOrigin 根变换 / 带名字的 cuboid 重载等），故手写转录。
// 坐标约定与 entityModelData.js 一致：
//   pivot = ModelTransform origin（模型空间，Y 向下、脚底 y=24）
//   rot   = [pitch, yaw, roll]（弧度，ModelTransform.of(x,y,z, pitch,yaw,roll)）
//   cuboid = { u, v, x, y, z, dx, dy, dz, mirror, dil }
// 注意：使用 moveOrigin(0,24,0) 的模型（铜傀儡）已把 +24 加到顶层部件 pivot.y 上。

import { RELEASE_MODELS } from './releaseModelData.js'

export const EXTRA_MODELS = {
  ...RELEASE_MODELS,
  // ---------------------------------------------------------------------------
  // 史莱姆（64×32）。原版用 getOuterTexturedModelData/getInnerTexturedModelData，
  // 内芯与眼/嘴使用原版位置，外壳由独立半透明层绘制。
  SlimeEntityModel: {
    w: 64, h: 32,
    parts: {
      cube: { pivot: [0, 0, 0], cuboids: [{ u: 0, v: 16, x: -3, y: 17, z: -3, dx: 6, dy: 6, dz: 6 }], children: {} },
      right_eye: { pivot: [0, 0, 0], cuboids: [{ u: 32, v: 0, x: -3.25, y: 18, z: -3.5, dx: 2, dy: 2, dz: 2 }], children: {} },
      left_eye: { pivot: [0, 0, 0], cuboids: [{ u: 32, v: 4, x: 1.25, y: 18, z: -3.5, dx: 2, dy: 2, dz: 2 }], children: {} },
      mouth: { pivot: [0, 0, 0], cuboids: [{ u: 32, v: 8, x: 0, y: 21, z: -3.5, dx: 1, dy: 1, dz: 1 }], children: {} },
    },
  },
  SlimeOuterEntityModel: {
    w: 64, h: 32,
    parts: { cube: { pivot: [0, 0, 0], cuboids: [{ u: 0, v: 0, x: -4, y: 16, z: -4, dx: 8, dy: 8, dz: 8 }], children: {} } },
  },

  // SheepWoolEntityModel.getTexturedModelData：头/身体/腿膨胀量各不相同。
  SheepWoolEntityModel: {
    w: 64, h: 32,
    parts: {
      head: { pivot: [0, 6, -8], cuboids: [{ u: 0, v: 0, x: -3, y: -4, z: -4, dx: 6, dy: 6, dz: 6, dil: [0.6, 0.6, 0.6] }] },
      body: { pivot: [0, 5, 2], rot: [Math.PI / 2, 0, 0], cuboids: [{ u: 28, v: 8, x: -4, y: -10, z: -7, dx: 8, dy: 16, dz: 6, dil: [1.75, 1.75, 1.75] }] },
      ...Object.fromEntries([['right_hind_leg', -3, 7], ['left_hind_leg', 3, 7], ['right_front_leg', -3, -5], ['left_front_leg', 3, -5]].map(([name, x, z]) => [name, {
        pivot: [x, 12, z], cuboids: [{ u: 0, v: 16, x: -2, y: 0, z: -2, dx: 4, dy: 6, dz: 4, dil: [0.5, 0.5, 0.5] }],
      }])),
    },
  },

  // ---------------------------------------------------------------------------
  // 岩浆怪（64×64）。原版是 8 层薄片叠成身体 + 内芯，这里照原版转录。
  MagmaCubeEntityModel: {
    w: 64, h: 64,
    parts: {
      cube0: { pivot: [0, 0, 0], cuboids: [{ u: 0, v: 0, x: -4, y: 16, z: -4, dx: 8, dy: 1, dz: 8 }], children: {} },
      cube1: { pivot: [0, 0, 0], cuboids: [{ u: 0, v: 9, x: -4, y: 17, z: -4, dx: 8, dy: 1, dz: 8 }], children: {} },
      cube2: { pivot: [0, 0, 0], cuboids: [{ u: 0, v: 18, x: -4, y: 18, z: -4, dx: 8, dy: 1, dz: 8 }], children: {} },
      cube3: { pivot: [0, 0, 0], cuboids: [{ u: 0, v: 27, x: -4, y: 19, z: -4, dx: 8, dy: 1, dz: 8 }], children: {} },
      cube4: { pivot: [0, 0, 0], cuboids: [{ u: 32, v: 0, x: -4, y: 20, z: -4, dx: 8, dy: 1, dz: 8 }], children: {} },
      cube5: { pivot: [0, 0, 0], cuboids: [{ u: 32, v: 9, x: -4, y: 21, z: -4, dx: 8, dy: 1, dz: 8 }], children: {} },
      cube6: { pivot: [0, 0, 0], cuboids: [{ u: 32, v: 18, x: -4, y: 22, z: -4, dx: 8, dy: 1, dz: 8 }], children: {} },
      cube7: { pivot: [0, 0, 0], cuboids: [{ u: 32, v: 27, x: -4, y: 23, z: -4, dx: 8, dy: 1, dz: 8 }], children: {} },
      inside_cube: { pivot: [0, 0, 0], cuboids: [{ u: 24, v: 40, x: -2, y: 18, z: -2, dx: 4, dy: 4, dz: 4 }], children: {} },
    },
  },

  // ---------------------------------------------------------------------------
  // 旋风人（32×32）。原版用私有 createModelData() + resetChildrenExcept()，
  // 解析器不支持，这里分别转录主体和 getWindTexturedModelData() 的旋风层。
  BreezeEntityModel: {
    w: 32, h: 32,
    parts: {
      body: {
        pivot: [0, 0, 0],
        cuboids: [],
        children: {
          rods: {
            pivot: [0, 8, 0],
            cuboids: [],
            children: {
              rod_1: { pivot: [2.5981, -3, 1.5], rot: [-2.7489, -1.0472, 3.1416], cuboids: [{ u: 0, v: 17, x: -1, y: 0, z: -3, dx: 2, dy: 8, dz: 2 }], children: {} },
              rod_2: { pivot: [-2.5981, -3, 1.5], rot: [-2.7489, 1.0472, 3.1416], cuboids: [{ u: 0, v: 17, x: -1, y: 0, z: -3, dx: 2, dy: 8, dz: 2 }], children: {} },
              rod_3: { pivot: [0, -3, -3], rot: [0.3927, 0, 0], cuboids: [{ u: 0, v: 17, x: -1, y: 0, z: -3, dx: 2, dy: 8, dz: 2 }], children: {} },
            },
          },
          head: {
            pivot: [0, 4, 0],
            cuboids: [
              { u: 4, v: 24, x: -5, y: -5, z: -4.2, dx: 10, dy: 3, dz: 4 },
              { u: 0, v: 0, x: -4, y: -8, z: -4, dx: 8, dy: 8, dz: 8 },
            ],
            children: {},
          },
        },
      },
    },
  },

  // 旋风人外层（128×128）：wind_bottom → wind_mid → wind_top 的 pivot 逐级累加。
  // 中段和顶段各有三重壳体，共 7 个 cuboid；必须使用独立的 breeze_wind 贴图。
  BreezeWindEntityModel: {
    w: 128, h: 128,
    parts: {
      wind_body: {
        pivot: [0, 0, 0],
        children: {
          wind_bottom: {
            pivot: [0, 24, 0],
            cuboids: [{ u: 1, v: 83, x: -2.5, y: -7, z: -2.5, dx: 5, dy: 7, dz: 5 }],
            children: {
              wind_mid: {
                pivot: [0, -7, 0],
                cuboids: [
                  { u: 74, v: 28, x: -6, y: -6, z: -6, dx: 12, dy: 6, dz: 12 },
                  { u: 78, v: 32, x: -4, y: -6, z: -4, dx: 8, dy: 6, dz: 8 },
                  { u: 49, v: 71, x: -2.5, y: -6, z: -2.5, dx: 5, dy: 6, dz: 5 },
                ],
                children: {
                  wind_top: {
                    pivot: [0, -6, 0],
                    cuboids: [
                      { u: 0, v: 0, x: -9, y: -8, z: -9, dx: 18, dy: 8, dz: 18 },
                      { u: 6, v: 6, x: -6, y: -8, z: -6, dx: 12, dy: 8, dz: 12 },
                      { u: 105, v: 57, x: -2.5, y: -8, z: -2.5, dx: 5, dy: 8, dz: 5 },
                    ],
                    children: {},
                  },
                },
              },
            },
          },
        },
      },
    },
  },

  // ---------------------------------------------------------------------------
  // 蝌蚪（16×16）
  TadpoleEntityModel: {
    w: 16, h: 16,
    parts: {
      body: {
        pivot: [0, 22, -3],
        cuboids: [{ u: 0, v: 0, x: -1.5, y: -1, z: 0, dx: 3, dy: 2, dz: 3 }],
        children: {},
      },
      tail: {
        pivot: [0, 22, 0],
        cuboids: [{ u: 0, v: 0, x: 0, y: -1, z: 0, dx: 0, dy: 2, dz: 7 }],
        children: {},
      },
    },
  },

  // ---------------------------------------------------------------------------
  // 快乐恶魂（纹理 128×128，模型 UV 空间 64×64，整体缩放 4×）
  HappyGhastEntityModel: {
    w: 64, h: 64, scale: 4,
    parts: {
      body: {
        pivot: [0, 16, 0],
        cuboids: [{ u: 0, v: 0, x: -8, y: -8, z: -8, dx: 16, dy: 16, dz: 16 }],
        children: {
          tentacle0: { pivot: [-3.75, 7, -5], cuboids: [{ u: 0, v: 0, x: -1, y: 0, z: -1, dx: 2, dy: 5, dz: 2 }], children: {} },
          tentacle1: { pivot: [1.25, 7, -5], cuboids: [{ u: 0, v: 0, x: -1, y: 0, z: -1, dx: 2, dy: 7, dz: 2 }], children: {} },
          tentacle2: { pivot: [6.25, 7, -5], cuboids: [{ u: 0, v: 0, x: -1, y: 0, z: -1, dx: 2, dy: 4, dz: 2 }], children: {} },
          tentacle3: { pivot: [-6.25, 7, 0], cuboids: [{ u: 0, v: 0, x: -1, y: 0, z: -1, dx: 2, dy: 5, dz: 2 }], children: {} },
          tentacle4: { pivot: [-1.25, 7, 0], cuboids: [{ u: 0, v: 0, x: -1, y: 0, z: -1, dx: 2, dy: 5, dz: 2 }], children: {} },
          tentacle5: { pivot: [3.75, 7, 0], cuboids: [{ u: 0, v: 0, x: -1, y: 0, z: -1, dx: 2, dy: 7, dz: 2 }], children: {} },
          tentacle6: { pivot: [-3.75, 7, 5], cuboids: [{ u: 0, v: 0, x: -1, y: 0, z: -1, dx: 2, dy: 8, dz: 2 }], children: {} },
          tentacle7: { pivot: [1.25, 7, 5], cuboids: [{ u: 0, v: 0, x: -1, y: 0, z: -1, dx: 2, dy: 8, dz: 2 }], children: {} },
          tentacle8: { pivot: [6.25, 7, 5], cuboids: [{ u: 0, v: 0, x: -1, y: 0, z: -1, dx: 2, dy: 5, dz: 2 }], children: {} },
        },
      },
    },
  },

  // ---------------------------------------------------------------------------
  // 铜傀儡（64×64，root moveOrigin(0,24,0) → 顶层 pivot.y 已 +24）
  CopperGolemEntityModel: {
    w: 64, h: 64,
    parts: {
      body: {
        pivot: [0, 19, 0],
        cuboids: [{ u: 0, v: 15, x: -4, y: -6, z: -3, dx: 8, dy: 6, dz: 6 }],
        children: {
          head: {
            pivot: [0, -6, 0],
            cuboids: [
              { u: 0, v: 0, x: -4, y: -5, z: -5, dx: 8, dy: 5, dz: 10, dil: [0.015, 0.015, 0.015] },
              { u: 56, v: 0, x: -1, y: -2, z: -6, dx: 2, dy: 3, dz: 2 },
              { u: 37, v: 8, x: -1, y: -9, z: -1, dx: 2, dy: 4, dz: 2, dil: [-0.015, -0.015, -0.015] },
              { u: 37, v: 0, x: -2, y: -13, z: -2, dx: 4, dy: 4, dz: 4, dil: [-0.015, -0.015, -0.015] },
            ],
            children: {},
          },
          right_arm: { pivot: [-4, -6, 0], cuboids: [{ u: 36, v: 16, x: -3, y: -1, z: -2, dx: 3, dy: 10, dz: 4 }], children: {} },
          left_arm: { pivot: [4, -6, 0], cuboids: [{ u: 50, v: 16, x: 0, y: -1, z: -2, dx: 3, dy: 10, dz: 4 }], children: {} },
        },
      },
      right_leg: { pivot: [0, 19, 0], cuboids: [{ u: 0, v: 27, x: -4, y: 0, z: -2, dx: 4, dy: 5, dz: 4 }], children: {} },
      left_leg: { pivot: [0, 19, 0], cuboids: [{ u: 16, v: 27, x: 0, y: 0, z: -2, dx: 4, dy: 5, dz: 4 }], children: {} },
    },
  },

  // ---------------------------------------------------------------------------
  // 热带鱼（32×32）——小型（Type A）
  SmallTropicalFishEntityModel: {
    w: 32, h: 32,
    parts: {
      body: { pivot: [0, 22, 0], cuboids: [{ u: 0, v: 0, x: -1, y: -1.5, z: -3, dx: 2, dy: 3, dz: 6 }], children: {} },
      tail: { pivot: [0, 22, 3], cuboids: [{ u: 22, v: -6, x: 0, y: -1.5, z: 0, dx: 0, dy: 3, dz: 6 }], children: {} },
      right_fin: { pivot: [-1, 22.5, 0], rot: [0, Math.PI / 4, 0], cuboids: [{ u: 2, v: 16, x: -2, y: -1, z: 0, dx: 2, dy: 2, dz: 0 }], children: {} },
      left_fin: { pivot: [1, 22.5, 0], rot: [0, -Math.PI / 4, 0], cuboids: [{ u: 2, v: 12, x: 0, y: -1, z: 0, dx: 2, dy: 2, dz: 0 }], children: {} },
      top_fin: { pivot: [0, 20.5, -3], cuboids: [{ u: 10, v: -5, x: 0, y: -3, z: 0, dx: 0, dy: 3, dz: 6 }], children: {} },
    },
  },

  // 热带鱼（32×32）——大型（Type B/C）
  LargeTropicalFishEntityModel: {
    w: 32, h: 32,
    parts: {
      body: { pivot: [0, 19, 0], cuboids: [{ u: 0, v: 20, x: -1, y: -3, z: -3, dx: 2, dy: 6, dz: 6 }], children: {} },
      tail: { pivot: [0, 19, 3], cuboids: [{ u: 21, v: 16, x: 0, y: -3, z: 0, dx: 0, dy: 6, dz: 5 }], children: {} },
      right_fin: { pivot: [-1, 20, 0], rot: [0, Math.PI / 4, 0], cuboids: [{ u: 2, v: 16, x: -2, y: 0, z: 0, dx: 2, dy: 2, dz: 0 }], children: {} },
      left_fin: { pivot: [1, 20, 0], rot: [0, -Math.PI / 4, 0], cuboids: [{ u: 2, v: 12, x: 0, y: 0, z: 0, dx: 2, dy: 2, dz: 0 }], children: {} },
      top_fin: { pivot: [0, 16, -3], cuboids: [{ u: 20, v: 11, x: 0, y: -4, z: 0, dx: 0, dy: 4, dz: 6 }], children: {} },
      bottom_fin: { pivot: [0, 22, -3], cuboids: [{ u: 20, v: 21, x: 0, y: 0, z: 0, dx: 0, dy: 4, dz: 6 }], children: {} },
    },
  },

  // ---------------------------------------------------------------------------
  // 末影龙（256×256）
  DragonEntityModel: {
    w: 256, h: 256,
    parts: {
      head: {
        pivot: [0, 20, -62],
        cuboids: [
          { u: 176, v: 44, x: -6, y: -1, z: -24, dx: 12, dy: 5, dz: 16 },
          { u: 112, v: 30, x: -8, y: -8, z: -10, dx: 16, dy: 16, dz: 16 },
          { u: 0, v: 0, x: -5, y: -12, z: -4, dx: 2, dy: 4, dz: 6, mirror: true },
          { u: 112, v: 0, x: -5, y: -3, z: -22, dx: 2, dy: 2, dz: 4, mirror: true },
          { u: 0, v: 0, x: 3, y: -12, z: -4, dx: 2, dy: 4, dz: 6, mirror: true },
          { u: 112, v: 0, x: 3, y: -3, z: -22, dx: 2, dy: 2, dz: 4, mirror: true },
        ],
        children: {
          jaw: { pivot: [0, 4, -8], cuboids: [{ u: 176, v: 65, x: -6, y: 0, z: -16, dx: 12, dy: 4, dz: 16 }], children: {} },
        },
      },
      neck0: { pivot: [0, 20, -12], cuboids: neckTailCuboids(), children: {} },
      neck1: { pivot: [0, 20, -22], cuboids: neckTailCuboids(), children: {} },
      neck2: { pivot: [0, 20, -32], cuboids: neckTailCuboids(), children: {} },
      neck3: { pivot: [0, 20, -42], cuboids: neckTailCuboids(), children: {} },
      neck4: { pivot: [0, 20, -52], cuboids: neckTailCuboids(), children: {} },
      tail0: { pivot: [0, 10, 60], cuboids: neckTailCuboids(), children: {} },
      tail1: { pivot: [0, 10, 70], cuboids: neckTailCuboids(), children: {} },
      tail2: { pivot: [0, 10, 80], cuboids: neckTailCuboids(), children: {} },
      tail3: { pivot: [0, 10, 90], cuboids: neckTailCuboids(), children: {} },
      tail4: { pivot: [0, 10, 100], cuboids: neckTailCuboids(), children: {} },
      tail5: { pivot: [0, 10, 110], cuboids: neckTailCuboids(), children: {} },
      tail6: { pivot: [0, 10, 120], cuboids: neckTailCuboids(), children: {} },
      tail7: { pivot: [0, 10, 130], cuboids: neckTailCuboids(), children: {} },
      tail8: { pivot: [0, 10, 140], cuboids: neckTailCuboids(), children: {} },
      tail9: { pivot: [0, 10, 150], cuboids: neckTailCuboids(), children: {} },
      tail10: { pivot: [0, 10, 160], cuboids: neckTailCuboids(), children: {} },
      tail11: { pivot: [0, 10, 170], cuboids: neckTailCuboids(), children: {} },
      body: {
        pivot: [0, 3, 8],
        cuboids: [
          { u: 0, v: 0, x: -12, y: 1, z: -16, dx: 24, dy: 24, dz: 64 },
          { u: 220, v: 53, x: -1, y: -5, z: -10, dx: 2, dy: 6, dz: 12 },
          { u: 220, v: 53, x: -1, y: -5, z: 10, dx: 2, dy: 6, dz: 12 },
          { u: 220, v: 53, x: -1, y: -5, z: 30, dx: 2, dy: 6, dz: 12 },
        ],
        children: {
          left_wing: {
            pivot: [12, 2, -6],
            cuboids: [
              { u: 112, v: 88, x: 0, y: -4, z: -4, dx: 56, dy: 8, dz: 8, mirror: true },
              { u: -56, v: 88, x: 0, y: 0, z: 2, dx: 56, dy: 0, dz: 56, mirror: true },
            ],
            children: {
              left_wing_tip: {
                pivot: [56, 0, 0],
                cuboids: [
                  { u: 112, v: 136, x: 0, y: -2, z: -2, dx: 56, dy: 4, dz: 4, mirror: true },
                  { u: -56, v: 144, x: 0, y: 0, z: 2, dx: 56, dy: 0, dz: 56, mirror: true },
                ],
                children: {},
              },
            },
          },
          right_wing: {
            pivot: [-12, 2, -6],
            cuboids: [
              { u: 112, v: 88, x: -56, y: -4, z: -4, dx: 56, dy: 8, dz: 8 },
              { u: -56, v: 88, x: -56, y: 0, z: 2, dx: 56, dy: 0, dz: 56 },
            ],
            children: {
              right_wing_tip: {
                pivot: [-56, 0, 0],
                cuboids: [
                  { u: 112, v: 136, x: -56, y: -2, z: -2, dx: 56, dy: 4, dz: 4 },
                  { u: -56, v: 144, x: -56, y: 0, z: 2, dx: 56, dy: 0, dz: 56 },
                ],
                children: {},
              },
            },
          },
          left_front_leg: {
            pivot: [12, 17, -6], rot: [1.3, 0, 0],
            cuboids: [{ u: 112, v: 104, x: -4, y: -4, z: -4, dx: 8, dy: 24, dz: 8 }],
            children: {
              left_front_leg_tip: {
                pivot: [0, 20, -1], rot: [-0.5, 0, 0],
                cuboids: [{ u: 226, v: 138, x: -3, y: -1, z: -3, dx: 6, dy: 24, dz: 6 }],
                children: {
                  left_front_foot: {
                    pivot: [0, 23, 0], rot: [0.75, 0, 0],
                    cuboids: [{ u: 144, v: 104, x: -4, y: 0, z: -12, dx: 8, dy: 4, dz: 16 }],
                    children: {},
                  },
                },
              },
            },
          },
          right_front_leg: {
            pivot: [-12, 17, -6], rot: [1.3, 0, 0],
            cuboids: [{ u: 112, v: 104, x: -4, y: -4, z: -4, dx: 8, dy: 24, dz: 8 }],
            children: {
              right_front_leg_tip: {
                pivot: [0, 20, -1], rot: [-0.5, 0, 0],
                cuboids: [{ u: 226, v: 138, x: -3, y: -1, z: -3, dx: 6, dy: 24, dz: 6 }],
                children: {
                  right_front_foot: {
                    pivot: [0, 23, 0], rot: [0.75, 0, 0],
                    cuboids: [{ u: 144, v: 104, x: -4, y: 0, z: -12, dx: 8, dy: 4, dz: 16 }],
                    children: {},
                  },
                },
              },
            },
          },
          left_hind_leg: {
            pivot: [16, 13, 34], rot: [1.0, 0, 0],
            cuboids: [{ u: 0, v: 0, x: -8, y: -4, z: -8, dx: 16, dy: 32, dz: 16 }],
            children: {
              left_hind_leg_tip: {
                pivot: [0, 32, -4], rot: [0.5, 0, 0],
                cuboids: [{ u: 196, v: 0, x: -6, y: -2, z: 0, dx: 12, dy: 32, dz: 12 }],
                children: {
                  left_hind_foot: {
                    pivot: [0, 31, 4], rot: [0.75, 0, 0],
                    cuboids: [{ u: 112, v: 0, x: -9, y: 0, z: -20, dx: 18, dy: 6, dz: 24 }],
                    children: {},
                  },
                },
              },
            },
          },
          right_hind_leg: {
            pivot: [-16, 13, 34], rot: [1.0, 0, 0],
            cuboids: [{ u: 0, v: 0, x: -8, y: -4, z: -8, dx: 16, dy: 32, dz: 16 }],
            children: {
              right_hind_leg_tip: {
                pivot: [0, 32, -4], rot: [0.5, 0, 0],
                cuboids: [{ u: 196, v: 0, x: -6, y: -2, z: 0, dx: 12, dy: 32, dz: 12 }],
                children: {
                  right_hind_foot: {
                    pivot: [0, 31, 4], rot: [0.75, 0, 0],
                    cuboids: [{ u: 112, v: 0, x: -9, y: 0, z: -20, dx: 18, dy: 6, dz: 24 }],
                    children: {},
                  },
                },
              },
            },
          },
        },
      },
    },
  },

  // ---------------------------------------------------------------------------
  // 兔子（26.3 新版，64×64，成年）。26.3 把兔子重构为 geom API + createBodyLayer，
  // 几何和 UV 全变了（body 8×6×10、head 5×5×5 居中、新增 frontlegs/backlegs 分组、
  // 耳朵/hind_leg 不再有独立 foot 部件），与 1.21.11 的 64×32 旧模型完全不匹配。
  // 这里从 26.3 client.jar 的 AdultRabbitModel.createBodyLayer 反汇编逐条转录。
  // 注意：26.3 模型本身无缩放（旧版的 ModelTransformer.scaling(0.6) 已移除），故不设 scale。
  AdultRabbitModel: {
    w: 64, h: 64,
    parts: {
      body: {
        pivot: [0, 23, 4], rot: [-0.3926999866962433, 0, 0],
        cuboids: [{ u: 0, v: 0, x: -4, y: -6, z: -9, dx: 8, dy: 6, dz: 10 }],
        children: {
          tail: {
            pivot: [0, -4.991600036621094, 0.012500000186264515],
            cuboids: [{ u: 20, v: 16, x: -2, y: -3.0083999633789062, z: -1.0125000476837158, dx: 4, dy: 4, dz: 4 }],
            children: {},
          },
          head: {
            pivot: [0, -5.292900085449219, -8.121299743652344], rot: [0.3926999866962433, 0, 0],
            cuboids: [{ u: 0, v: 16, x: -2.5, y: -3, z: -4, dx: 5, dy: 5, dz: 5 }],
            children: {
              left_ear: {
                pivot: [1.5, -3.7070999145507812, -0.8787000179290771],
                cuboids: [{ u: 32, v: 0, x: -1, y: -4.292900085449219, z: -0.12129999697208405, dx: 2, dy: 5, dz: 1 }],
                children: {},
              },
              right_ear: {
                pivot: [-1.5, -3.7070999145507812, -0.8787000179290771],
                cuboids: [{ u: 26, v: 0, x: -1, y: -4.292900085449219, z: -0.12129999697208405, dx: 2, dy: 5, dz: 1 }],
                children: {},
              },
            },
          },
          frontlegs: {
            pivot: [0, -1.5348999500274658, -6.310800075531006],
            cuboids: [],
            children: {
              right_front_leg: {
                pivot: [-2, 1.9239000082015991, 0.38269999623298645], rot: [0.3926999866962433, 0, 0],
                cuboids: [{ u: 36, v: 18, x: -0.8999999761581421, y: -1, z: -0.8999999761581421, dx: 2, dy: 4, dz: 2 }],
                children: {},
              },
              left_front_leg: {
                pivot: [2, 1.9239000082015991, 0.482699990272522], rot: [0.3926999866962433, 0, 0],
                cuboids: [{ u: 44, v: 18, x: -1, y: -1, z: -1, dx: 2, dy: 4, dz: 2 }],
                children: {},
              },
            },
          },
        },
      },
      backlegs: {
        pivot: [0, 23, 4],
        cuboids: [],
        children: {
          right_hind_leg: {
            pivot: [-3, 0.5, 0],
            cuboids: [],
            children: {
              right_haunch: {
                pivot: [0, -0.5, 0], rot: [0, 0.3926999866962433, 0],
                cuboids: [{ u:20, v:24, x:-1, y:0, z:-5, dx:2, dy:1, dz:6 }],
                children: {},
              },
            },
          },
          left_hind_leg: {
            pivot: [3, 0.5, 0],
            cuboids: [],
            children: {
              left_haunch: {
                pivot: [0, -0.5, 0], rot: [0, -0.3926999866962433, 0],
                cuboids: [{ u:36, v:24, x:-1, y:0, z:-5, dx:2, dy:1, dz:6 }],
                children: {},
              },
            },
          },
        },
      },
    },
  },

  // ---------------------------------------------------------------------------
  // 竹筏（26.3，128×64）。原版 RaftModel（geom API），与 BoatModel 同坐标约定，
  // 但形状是平底木筏（无尖船头/侧壁）：bottom（甲板 + 水线以下部分）+ 双桨。
  // 这里从 26.3 client.jar 的 RaftModel.addCommonParts 反汇编转录。
  RaftModel: {
    w: 128, h: 64,
    parts: {
      bottom: {
        pivot: [0, -2.1, 1], rot: [Math.PI / 2, 0, 0],
        cuboids: [
          { u: 0, v: 0, x: -14, y: -11, z: -4, dx: 28, dy: 20, dz: 4 },
          { u: 0, v: 0, x: -14, y: -9, z: -8, dx: 28, dy: 16, dz: 4 },
        ],
        children: {},
      },
      left_paddle: {
        pivot: [3, -4, 9], rot: [0, 0, Math.PI / 16],
        cuboids: [
          { u: 0, v: 24, x: -1, y: 0, z: -5, dx: 2, dy: 2, dz: 18 },
          { u: 0, v: 24, x: -1.001, y: -3, z: 8, dx: 1, dy: 6, dz: 7 },
        ],
        children: {},
      },
      right_paddle: {
        pivot: [3, -4, -9], rot: [0, Math.PI, Math.PI / 16],
        cuboids: [
          { u: 40, v: 24, x: -1, y: 0, z: -5, dx: 2, dy: 2, dz: 18 },
          { u: 40, v: 24, x: 0.001, y: -3, z: 8, dx: 1, dy: 6, dz: 7 },
        ],
        children: {},
      },
    },
  },
}

// 龙颈/龙尾共用的两个盒体（"box" + "scale"）
function neckTailCuboids() {
  return [
    { u: 192, v: 104, x: -5, y: -5, z: -5, dx: 10, dy: 10, dz: 10 },
    { u: 48, v: 0, x: -1, y: -9, z: -3, dx: 2, dy: 4, dz: 6 },
  ]
}
