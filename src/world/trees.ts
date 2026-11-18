// 写实的树：枝干分级生长 + 叶片卡片（生成器见 vendor/ashTree.js，MIT）。
//   - 三个生长种子做三种树形，每种用实例化绘制（同一棵树形、不同大小朝向颜色）；
//   - 叶片卡片上画的是一小簇羽状复叶（textures.ts 的 leafCard），透明度裁切，双面、法线保持「整团朝外」；
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
import { barkMaps, leafCard } from './textures';

/** 生成器的单位换算到米（中等白蜡树约 85 单位高） */
const UNIT = 0.075;
/** 被判定为遮挡时的「覆盖率」（1 = 实心，0 = 全透） */
export const TREE_FADE_MIN = 0.18;
const FADE_SPEED = 4;

export type TreeKind = 'green' | 'blossom';
export interface TreeSpot {
  p: Vec2;
  /** 相对中等树的大小（1 ≈ 6.4 米高） */
  scale: number;
  kind: TreeKind;
  /** 0 / 1 / 2：三种树形 */
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

const SEEDS = [36330, 101, 202];

function preset(seed: number): AshPreset {
  const p = JSON.parse(JSON.stringify(ashMedium)) as AshPreset;
  p.seed = seed;
  // 预算（GTX 1650）：每棵约 1 万三角面——枝干截面与分段数降一档，叶片卡片少而大
  p.branch.segments = [8, 5, 3, 3];
  p.branch.sections = [10, 6, 4, 3];
  p.leaves.count = 7;
  p.leaves.size = 5;
  return p;
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

  const bark = barkMaps();
  const barkMat = new THREE.MeshStandardMaterial({ map: bark.map, normalMap: bark.normalMap, normalScale: new THREE.Vector2(1.2, 1.2), roughness: 0.92, color: '#c9b8a6' });
  decorate(barkMat, time, false);
  const leafMats: Record<TreeKind, THREE.MeshStandardMaterial> = {
    green: new THREE.MeshStandardMaterial({ map: leafCard('green', [112, 150, 70], 3).map, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.78 }),
    blossom: new THREE.MeshStandardMaterial({ map: leafCard('blossom', [238, 186, 196], 5).map, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.8 }),
  };
  decorate(leafMats.green, time, true);
  decorate(leafMats.blossom, time, true);
  // 投影也要按叶片形状裁切，不然影子是一片片方块
  const depthMats: Record<TreeKind, THREE.MeshDepthMaterial> = {
    green: new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: leafMats.green.map, alphaTest: 0.5, side: THREE.DoubleSide }),
    blossom: new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: leafMats.blossom.map, alphaTest: 0.5, side: THREE.DoubleSide }),
  };

  const compiled = SEEDS.map((s) => compileAshTree(preset(s)));

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
  for (let v = 0; v < SEEDS.length; v++) {
    for (const kind of ['green', 'blossom'] as const) {
      const list = spots.filter((s) => s.variant === v && s.kind === kind);
      if (!list.length) continue;
      const branchGeo = compiled[v].branchGeometry.clone();
      const leafGeo = compiled[v].leafGeometry.clone();
      const fade = new THREE.InstancedBufferAttribute(new Float32Array(list.length).fill(1), 1);
      fade.setUsage(THREE.DynamicDrawUsage);
      branchGeo.setAttribute('aFade', fade);
      leafGeo.setAttribute('aFade', fade);
      const branches = new THREE.InstancedMesh(branchGeo, barkMat, list.length);
      const leaves = new THREE.InstancedMesh(leafGeo, leafMats[kind], list.length);
      leaves.customDepthMaterial = depthMats[kind];
      leafGeo.computeBoundingBox();
      const box = leafGeo.boundingBox!;
      const cMid = box.getCenter(new THREE.Vector3());
      const cR = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 0.42;
      list.forEach((t, i) => {
        const s = UNIT * t.scale;
        q.setFromAxisAngle(up, r() * Math.PI * 2);
        const base = P(t.p[0], t.ground - 0.08, t.p[1]);
        m4.compose(base, q, new THREE.Vector3(s, s * (0.94 + r() * 0.12), s));
        branches.setMatrixAt(i, m4);
        leaves.setMatrixAt(i, m4);
        // 每棵树叶色略有差异：花树粉得深浅不一，绿树有的偏黄有的偏蓝
        if (kind === 'green') col.setHSL(0.1 + (r() - 0.5) * 0.05, 0.12 + r() * 0.15, 0.78 + r() * 0.16);
        else col.setHSL(0.97, 0.05 + r() * 0.1, 0.9 + r() * 0.08);
        leaves.setColorAt(i, col);
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
