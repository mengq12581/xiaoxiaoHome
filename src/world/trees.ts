// 写实的树：枝干分级生长 + 叶片卡片（生成器见 vendor/ashTree.js，MIT）。
//   - 三个树种：绿叶大树（白蜡树形）、樱花（矮干、横向铺开的树冠、满树粉白花枝）、开白花的小树；
//     每种两三个生长种子做不同树形，用实例化绘制（同一棵树形、不同大小朝向颜色）；
//   - 叶片 / 花枝卡片（textures.ts 的 leafCard / blossomCard），透明度裁切，双面、法线保持「整团朝外」；
//   - 风：顶点着色器里按高度轻轻摆动，叶片再多一层细碎抖动；
//   - 遮挡淡出：每棵树一个「树冠球」，从相机到要保持可见的点（她、各房间）的视线穿过树冠球，
//     这棵树就渐变成稀疏的网点（屏幕抖动裁切，不走半透明排序，影子照旧）。

import * as THREE from 'three';
import type { Vec2 } from '../config/types';
import { P } from '../scene/house';
import { compileAshTree } from './vendor/ashTree.js';
import { ashMedium } from './vendor/ashPreset.js';
import type { AshPreset } from './vendor/ashTree';
import { rng } from './noise';
import { barkMaps, blossomCard, leafCard } from './textures';
/** 被判定为遮挡时的「覆盖率」（1 = 实心，0 = 全透） */
export const TREE_FADE_MIN = 0.18;
const FADE_SPEED = 4;

export type TreeKind = 'green' | 'sakura' | 'sapling';
export interface TreeSpot {
  p: Vec2;
  /** 相对该树种标准大小的比例（绿叶树 1 ≈ 6.4 米高；樱花 1 ≈ 3.6 米高、4.7 米宽；小花树 1 ≈ 2.4 米高） */
  scale: number;
  kind: TreeKind;
  /** 树形编号（按树种的种子数取模） */
  variant: number;
  /** 地面高度（世界 y） */
  ground: number;
}

export interface Trees {
  group: THREE.Group;
  /** 每帧：风 + 遮挡淡出 */
  update(dt: number, camera: THREE.Camera, targets: THREE.Vector3[]): void;
  /** 当前判定为遮挡的树的数量（调试） */
  readonly occluding: number;
}

const clone = (p: AshPreset) => JSON.parse(JSON.stringify(p)) as AshPreset;

/** 绿叶大树（白蜡树形）。预算（GTX 1650）：每棵约 1 万三角面——枝干截面与分段数降一档，叶片卡片少而大 */
function greenPreset(seed: number): AshPreset {
  const p = clone(ashMedium);
  p.seed = seed;
  p.branch.segments = [8, 5, 3, 3];
  p.branch.sections = [10, 6, 4, 3];
  p.leaves.count = 7;
  p.leaves.size = 5;
  return p;
}

/** 樱花：主干矮而粗，分枝角度大、向四周铺开，枝条更扭；花枝卡片多而密 */
function sakuraPreset(seed: number): AshPreset {
  const p = clone(ashMedium);
  p.seed = seed;
  Object.assign(p.branch, {
    angle: [0, 58, 50, 40],
    children: [5, 4, 4, 0],
    length: [20, 26, 12, 5],
    radius: [2.6, 0.62, 0.7, 0.7],
    start: [0, 0.45, 0.25, 0],
    gnarliness: [0.08, 0.28, 0.25, 0.12],
    forceStrength: 0.004,
    segments: [8, 5, 3, 3],
    sections: [8, 6, 4, 3],
  });
  p.leaves = { angle: 45, count: 12, start: 0.15, size: 4.4, sizeVariance: 0.5, alphaTest: 0.5 };
  return p;
}

/** 开白花的小树：细干、稀疏的枝，花开得零零散散 */
function saplingPreset(seed: number): AshPreset {
  const p = sakuraPreset(seed);
  p.branchLevels = 2;
  Object.assign(p.branch, {
    angle: [0, 35, 40, 40],
    children: [6, 4, 0, 0],
    length: [30, 18, 9, 4],
    radius: [1.2, 0.55, 0.7, 0.7],
    start: [0, 0.35, 0.3, 0],
    gnarliness: [0.06, 0.2, 0.2, 0.1],
    forceStrength: 0.01,
  });
  p.leaves = { angle: 40, count: 6, start: 0.3, size: 4.5, sizeVariance: 0.5, alphaTest: 0.5 };
  return p;
}

interface Species {
  presets: AshPreset[];
  /** 生成器单位 → 米 */
  unit: number;
  bark: string;
  leaf: THREE.Texture;
  /** 每棵树的叶 / 花色（乘在贴图上） */
  tint(r: () => number, c: THREE.Color): THREE.Color;
}

/** 给材质加上：风、逐实例的网点淡出。叶片额外保持法线不随背面翻转（整团朝外，背光面不发黑） */
function decorate(mat: THREE.Material, time: { value: number }, leaf: boolean) {
  mat.onBeforeCompile = (s) => {
    s.uniforms.uTime = time;
    s.vertexShader = s.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float aFade;
varying float vFade;
uniform float uTime;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vFade = aFade;
{
  vec3 ip = vec3(instanceMatrix[3][0], 0.0, instanceMatrix[3][2]);
  float ph = ip.x * 0.37 + ip.z * 0.61;
  float h = max(position.y, 0.0) / 85.0;
  float sway = sin(uTime * 0.9 + ph) * 0.6 + sin(uTime * 1.7 + ph * 1.3) * 0.25;
  transformed.x += sway * h * h * 1.4;
  transformed.z += cos(uTime * 0.8 + ph) * 0.4 * h * h * 1.4;
  ${leaf ? 'transformed += normal * sin(uTime * 4.0 + dot(position, vec3(0.31, 0.17, 0.23))) * 0.18 * h;' : ''}
}`,
      );
    s.fragmentShader = s.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vFade;`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
if (vFade < 0.999) {
  float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  if (ign > vFade) discard;
}`,
      );
    if (leaf) s.fragmentShader = s.fragmentShader.replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''));
  };
  mat.customProgramCacheKey = () => (leaf ? 'tree-leaf' : 'tree-bark');
}

export function buildTrees(spots: TreeSpot[], seed = 7): Trees {
  const group = new THREE.Group();
  group.name = 'trees';
  const r = rng(seed);
  const time = { value: 0 };

  const species: Record<TreeKind, Species> = {
    green: {
      presets: [36330, 101, 202].map(greenPreset),
      unit: 0.075,
      bark: '#c9b8a6',
      leaf: leafCard('green', [112, 150, 70], 3).map,
      tint: (r, c) => c.setHSL(0.1 + (r() - 0.5) * 0.05, 0.12 + r() * 0.15, 0.78 + r() * 0.16),
    },
    sakura: {
      presets: [11, 23].map(sakuraPreset),
      unit: 0.06,
      bark: '#6f5f58',
      leaf: blossomCard('sakura', 5),
      tint: (r, c) => c.setHSL(0.96, 0.25 + r() * 0.3, 0.86 + r() * 0.1),
    },
    sapling: {
      presets: [7, 19].map(saplingPreset),
      unit: 0.06,
      bark: '#7a6a5e',
      leaf: blossomCard('white', 9),
      tint: (r, c) => c.setHSL(0.08, 0.1 + r() * 0.2, 0.92 + r() * 0.06),
    },
  };
  const bark = barkMaps();
  const leafMats = {} as Record<TreeKind, THREE.MeshStandardMaterial>;
  const barkMats = {} as Record<TreeKind, THREE.MeshStandardMaterial>;
  const depthMats = {} as Record<TreeKind, THREE.MeshDepthMaterial>;
  for (const k of Object.keys(species) as TreeKind[]) {
    const sp = species[k];
    barkMats[k] = new THREE.MeshStandardMaterial({ map: bark.map, normalMap: bark.normalMap, normalScale: new THREE.Vector2(1.2, 1.2), roughness: 0.92, color: sp.bark });
    decorate(barkMats[k], time, false);
    leafMats[k] = new THREE.MeshStandardMaterial({ map: sp.leaf, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.78 });
    decorate(leafMats[k], time, true);
    // 投影也要按叶片形状裁切，不然影子是一片片方块
    depthMats[k] = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: sp.leaf, alphaTest: 0.5, side: THREE.DoubleSide });
  }
  const compiled = new Map<AshPreset, ReturnType<typeof compileAshTree>>();
  const compile = (p: AshPreset) => {
    if (!compiled.has(p)) compiled.set(p, compileAshTree(p));
    return compiled.get(p)!;
  };

  // 遮挡判定用的树冠球
  interface Crown {
    center: THREE.Vector3;
    radius: number;
    fade: number;
    attr: THREE.InstancedBufferAttribute;
    index: number;
  }
  const crowns: Crown[] = [];

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const col = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);
  for (const kind of Object.keys(species) as TreeKind[]) {
    const sp = species[kind];
    for (let v = 0; v < sp.presets.length; v++) {
      const list = spots.filter((s) => s.kind === kind && s.variant % sp.presets.length === v);
      if (!list.length) continue;
      const tree = compile(sp.presets[v]);
      const branchGeo = tree.branchGeometry.clone();
      const leafGeo = tree.leafGeometry.clone();
      const fade = new THREE.InstancedBufferAttribute(new Float32Array(list.length).fill(1), 1);
      fade.setUsage(THREE.DynamicDrawUsage);
      branchGeo.setAttribute('aFade', fade);
      leafGeo.setAttribute('aFade', fade);
      const branches = new THREE.InstancedMesh(branchGeo, barkMats[kind], list.length);
      const leaves = new THREE.InstancedMesh(leafGeo, leafMats[kind], list.length);
      leaves.customDepthMaterial = depthMats[kind];
      leafGeo.computeBoundingBox();
      const box = leafGeo.boundingBox!;
      const cMid = box.getCenter(new THREE.Vector3());
      const cR = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 0.42;
      list.forEach((t, i) => {
        const s = sp.unit * t.scale;
        q.setFromAxisAngle(up, r() * Math.PI * 2);
        const base = P(t.p[0], t.ground - 0.08, t.p[1]);
        m4.compose(base, q, new THREE.Vector3(s, s * (0.94 + r() * 0.12), s));
        branches.setMatrixAt(i, m4);
        leaves.setMatrixAt(i, m4);
        // 每棵树叶色 / 花色略有差异
        leaves.setColorAt(i, sp.tint(r, col));
        crowns.push({
          center: base.clone().add(new THREE.Vector3(0, cMid.y * s, 0)),
          radius: cR * s,
          fade: 1,
          attr: fade,
          index: i,
        });
      });
      branches.castShadow = leaves.castShadow = true;
      branches.receiveShadow = leaves.receiveShadow = true;
      // 实例分散在岛上各处：包围球按整组算，不然会被错误地视锥剔除
      branches.frustumCulled = leaves.frustumCulled = false;
      branches.name = `tree-bark-${v}-${kind}`;
      leaves.name = `tree-leaves-${v}-${kind}`;
      group.add(branches, leaves);
    }
  }

  const ray = new THREE.Ray();
  const tmp = new THREE.Vector3();
  let occluding = 0;
  return {
    group,
    get occluding() {
      return occluding;
    },
    update(dt, camera, targets) {
      time.value += dt;
      const origin = camera.getWorldPosition(new THREE.Vector3());
      const step = Math.min(1, dt * FADE_SPEED);
      occluding = 0;
      const dirty = new Set<THREE.InstancedBufferAttribute>();
      for (const c of crowns) {
        let hit = false;
        for (const t of targets) {
          const len = tmp.subVectors(t, origin).length();
          ray.set(origin, tmp.divideScalar(len));
          // 视线穿过树冠球、且树在目标点之前
          const d = ray.distanceSqToPoint(c.center);
          if (d < c.radius * c.radius) {
            const along = tmp.dot(new THREE.Vector3().subVectors(c.center, origin));
            if (along > 0 && along - c.radius < len) {
              hit = true;
              break;
            }
          }
        }
        // 相机钻进树冠里时也淡掉
        if (origin.distanceTo(c.center) < c.radius * 1.1) hit = true;
        if (hit) occluding++;
        const goal = hit ? TREE_FADE_MIN : 1;
        const next = Math.abs(goal - c.fade) < 0.01 ? goal : c.fade + (goal - c.fade) * step;
        if (next !== c.fade) {
          c.fade = next;
          c.attr.setX(c.index, next);
          dirty.add(c.attr);
        }
      }
      for (const a of dirty) a.needsUpdate = true;
    },
  };
}
