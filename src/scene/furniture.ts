// 程序化家具模型。局部坐标：x 右、y 上、-z 为家具正面（人使用的一侧），原点在占地中心的地面上。
// 尺寸取自 furniture.json 的 size = [宽, 深, 高]。
// 观感：所有块都是大圆角的软体块（硬质件圆角到 4 厘米、布艺件到 9 厘米，像捏出来的）；
// 材质只有哑光木、织物、暖白三类（PBR，无金属），不描线。

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { FurnitureItem } from '../config/types';
import { P } from './house';
import { ROUGH, soft } from './materials';
import { fabricTexture, hashString, seeded, woodGrainTexture } from './textures';

type Finish = 'wood' | 'fabric' | 'paint';

const matCache = new Map<string, THREE.MeshStandardMaterial>();
function mat(color: number, finish: Finish = 'paint', emissive = 0x000000, emissiveIntensity = 1): THREE.MeshStandardMaterial {
  const key = `${color}:${finish}:${emissive}:${emissiveIntensity}`;
  let m = matCache.get(key);
  if (!m) {
    m = soft(color, {
      map: finish === 'wood' ? woodGrainTexture() : finish === 'fabric' ? fabricTexture() : null,
      roughness: ROUGH[finish],
      // 深色件（屏幕、椅脚）少吃环境反光，否则俯视时发灰
      envMapIntensity: color === C.screenBody || color === C.screen || color === C.charcoal ? 0.4 : 1,
      emissive,
      emissiveIntensity,
    });
    matCache.set(key, m);
  }
  return m;
}

const C = {
  wood: 0xc9a27a,
  woodDark: 0xa57b55,
  woodLight: 0xe2c9a6,
  warmWhite: 0xf1e9dc,
  cream: 0xe9dfcf,
  sofa: 0x93aaa1,
  sofaLight: 0xa9bdb5,
  chairFabric: 0x76869a,
  charcoal: 0x3f3a37,
  screenBody: 0x2a2a2e,
  screen: 0x2f3a48,
  blanket: 0xebc6ae,
  blanketFold: 0xf6e2d2,
  pillow: 0xfbf7f0,
  sheet: 0xf5f1ea,
  lampShade: 0xfff1d2,
};

class Builder {
  constructor(public g: THREE.Group) {}
  /**
   * 软圆角盒。圆角半径 = 最短边的 45%，上限按材质：布艺 9 厘米（靠垫、床垫鼓起来），木与漆面 4 厘米。
   * 薄板（门板、书）自然退化成小圆边。
   */
  box(w: number, h: number, d: number, color: number, x: number, y: number, z: number, finish: Finish = 'paint', name?: string, m?: THREE.Material) {
    const cap = finish === 'fabric' ? 0.09 : 0.04;
    const r = Math.min(cap, Math.min(w, h, d) * 0.45);
    const mesh = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, r > 0.03 ? 6 : 4, r), m ?? mat(color, finish));
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (name) mesh.name = name;
    this.g.add(mesh);
    return mesh;
  }
  cyl(rt: number, rb: number, h: number, color: number, x: number, y: number, z: number, finish: Finish = 'paint', seg = 32, m?: THREE.Material) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m ?? mat(color, finish));
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.g.add(mesh);
    return mesh;
  }
}

function legs(b: Builder, w: number, d: number, h: number, inset: number, size: number, color: number) {
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) b.box(size, h, size, color, sx * (w / 2 - inset), h / 2, sz * (d / 2 - inset), 'wood');
}

type ModelFn = (b: Builder, w: number, d: number, h: number, item: FurnitureItem) => void;

const MODELS: Record<string, ModelFn> = {
  sofa(b, w, d, h) {
    const legH = 0.08;
    legs(b, w, d, legH, 0.08, 0.05, C.woodDark);
    const baseH = 0.22;
    b.box(w, baseH, d, C.sofa, 0, legH + baseH / 2, 0, 'fabric');
    const backT = 0.22;
    b.box(w, h - legH, backT, C.sofa, 0, legH + (h - legH) / 2, d / 2 - backT / 2, 'fabric');
    const armW = 0.18;
    const armH = 0.58;
    for (const s of [-1, 1]) b.box(armW, armH, d, C.sofa, s * (w / 2 - armW / 2), legH + armH / 2, 0, 'fabric');
    const inner = w - armW * 2;
    const n = 3;
    const cw = inner / n - 0.02;
    const cd = d - backT - 0.03;
    for (let i = 0; i < n; i++) {
      const x = -inner / 2 + (inner / n) * (i + 0.5);
      b.box(cw, 0.13, cd, C.sofaLight, x, legH + baseH + 0.065, -d / 2 + cd / 2 + 0.01, 'fabric');
      const back = b.box(cw, 0.36, 0.12, C.sofaLight, x, legH + baseH + 0.13 + 0.17, d / 2 - backT - 0.05, 'fabric');
      back.rotation.x = -0.12;
    }
  },

  coffee_table(b, w, d, h) {
    b.box(w, 0.05, d, C.wood, 0, h - 0.025, 0, 'wood');
    legs(b, w, d, h - 0.05, 0.06, 0.05, C.woodDark);
    b.box(w - 0.14, 0.025, d - 0.14, C.woodLight, 0, 0.13, 0, 'wood');
    b.cyl(0.035, 0.03, 0.09, 0xf6f1ea, w * 0.22, h + 0.045, d * 0.1);
  },

  tv_stand(b, w, d, h) {
    b.box(w, h, d, C.warmWhite, 0, h / 2, 0);
    for (const s of [-1, 1]) b.box(w / 2 - 0.05, h - 0.12, 0.012, C.cream, s * (w / 4), h / 2, -d / 2 - 0.006);
    for (const s of [-1, 1]) b.box(0.08, 0.016, 0.022, C.woodDark, s * 0.06, h / 2, -d / 2 - 0.02, 'wood');
    const sw = Math.min(w * 0.85, 1.3);
    const sh = sw * 0.56;
    b.box(0.34, 0.016, 0.2, C.screenBody, 0, h + 0.008, 0.02);
    b.box(0.07, 0.09, 0.04, C.screenBody, 0, h + 0.045, 0.04);
    const ty = h + 0.09 + sh / 2;
    b.box(sw, sh, 0.045, C.screenBody, 0, ty, 0.04, 'paint', 'tv_body');
    b.box(sw - 0.04, sh - 0.04, 0.004, C.screen, 0, ty, 0.04 - 0.024, 'paint', 'tv_screen', mat(C.screen, 'paint', 0x0e141c));
  },

  desk(b, w, d, h) {
    b.box(w, 0.04, d, C.wood, 0, h - 0.02, 0, 'wood');
    for (const s of [-1, 1]) b.box(0.04, h - 0.04, d - 0.04, C.woodDark, s * (w / 2 - 0.03), (h - 0.04) / 2, 0, 'wood');
    b.box(w - 0.1, 0.32, 0.02, C.woodDark, 0, h - 0.04 - 0.16, d / 2 - 0.06, 'wood');
    // 显示器（面朝使用者）
    const mz = d / 2 - 0.16;
    b.box(0.2, 0.014, 0.14, C.screenBody, 0, h + 0.007, mz);
    b.box(0.05, 0.13, 0.035, C.screenBody, 0, h + 0.065, mz + 0.01);
    b.box(0.58, 0.34, 0.03, C.screenBody, 0, h + 0.13 + 0.17, mz - 0.01, 'paint', 'monitor');
    b.box(0.54, 0.3, 0.004, C.screen, 0, h + 0.3, mz - 0.026, 'paint', 'monitor_screen', mat(C.screen, 'paint', 0x0e141c));
    // 键盘、鼠标
    b.box(0.42, 0.02, 0.13, 0xece8e2, -0.02, h + 0.01, -d / 2 + 0.2, 'paint', 'keyboard');
    b.box(0.05, 0.022, 0.08, 0xece8e2, 0.3, h + 0.011, -d / 2 + 0.2);
    // 本子（合上的；写笔记时翻开）
    b.box(0.21, 0.016, 0.28, 0xc97b63, w / 2 - 0.26, h + 0.008, -d / 2 + 0.22, 'fabric', 'notebook');
    b.box(0.2, 0.005, 0.27, 0xfaf6ee, w / 2 - 0.255, h + 0.012, -d / 2 + 0.22);
    // 笔筒
    b.cyl(0.035, 0.035, 0.1, 0x9fb7c6, -w / 2 + 0.16, h + 0.05, d / 2 - 0.12);
  },

  office_chair(b, w, d, h) {
    const sw = w * 0.85;
    const sd = d * 0.82;
    const seatY = 0.46;
    // 五星脚（哑光深炭色，不用金属）
    for (let i = 0; i < 5; i++) {
      const leg = b.box(w * 0.48, 0.03, 0.045, C.charcoal, 0, 0.05, 0);
      const a = (i / 5) * Math.PI * 2;
      leg.rotation.y = a;
      leg.position.set(Math.cos(a) * w * 0.22, 0.05, -Math.sin(a) * w * 0.22);
      b.cyl(0.026, 0.026, 0.04, C.charcoal, Math.cos(a) * w * 0.44, 0.02, -Math.sin(a) * w * 0.44, 'paint', 10);
    }
    b.cyl(0.028, 0.028, seatY - 0.1, C.charcoal, 0, (seatY - 0.1) / 2 + 0.06, 0, 'paint', 12);
    b.box(sw, 0.08, sd, C.chairFabric, 0, seatY, 0, 'fabric');
    const backH = Math.max(0.3, h - seatY - 0.08);
    const back = b.box(sw * 0.95, backH, 0.07, C.chairFabric, 0, seatY + 0.06 + backH / 2, sd / 2 - 0.02, 'fabric');
    back.rotation.x = 0.08;
    b.box(0.045, 0.2, 0.045, C.charcoal, 0, seatY + 0.12, sd / 2 - 0.02);
  },

  bookshelf(b, w, d, h, item) {
    const t = 0.03;
    for (const s of [-1, 1]) b.box(t, h, d, C.woodLight, s * (w / 2 - t / 2), h / 2, 0, 'wood');
    b.box(w, t, d, C.woodLight, 0, h - t / 2, 0, 'wood');
    b.box(w, t, d, C.woodLight, 0, t / 2 + 0.04, 0, 'wood');
    b.box(w - 2 * t, 0.04, 0.02, C.woodLight, 0, 0.02, -d / 2 + 0.01, 'wood');
    b.box(w, h, 0.012, C.cream, 0, h / 2, d / 2 - 0.006);
    const levels = 4;
    const inner = h - t - (0.04 + t);
    const step = inner / levels;
    const rnd = seeded(hashString(item.id));
    const bookColors = [0xd98c74, 0x8fb3c9, 0xe8c76f, 0x9fbf8f, 0xc7a3c9, 0xf0ede6, 0x6f8fa6, 0xd6b29a];
    for (let k = 0; k < levels; k++) {
      const y0 = 0.04 + t + k * step;
      if (k > 0) b.box(w - 2 * t, 0.022, d - 0.02, C.woodLight, 0, y0, 0, 'wood');
      let x = -w / 2 + t + 0.02;
      const xEnd = w / 2 - t - 0.02;
      const fill = 0.45 + rnd() * 0.45;
      while (x < -w / 2 + t + (w - 2 * t) * fill && x < xEnd - 0.06) {
        const bw = 0.025 + rnd() * 0.035;
        const bh = Math.min(step - 0.06, 0.17 + rnd() * 0.12);
        b.box(bw, bh, d - 0.08, bookColors[Math.floor(rnd() * bookColors.length)], x + bw / 2, y0 + 0.011 + bh / 2, 0.01, 'fabric');
        x += bw + 0.004;
      }
      if (rnd() > 0.4) b.cyl(0.05, 0.04, 0.1, 0xb9d3c1, xEnd - 0.08, y0 + 0.06, 0);
    }
  },

  bed(b, w, d, h) {
    // 正面（-z）是床尾，床头在 +z
    const legH = 0.06;
    legs(b, w, d, legH, 0.06, 0.06, C.woodDark);
    const frameH = h - 0.2 - legH;
    b.box(w, frameH, d, C.wood, 0, legH + frameH / 2, 0, 'wood');
    const mattressTop = h;
    b.box(w - 0.06, 0.2, d - 0.1, C.sheet, 0, mattressTop - 0.1, -0.03, 'fabric');
    b.box(w + 0.02, 0.95, 0.07, C.wood, 0, 0.475, d / 2 - 0.035, 'wood', 'headboard');
    for (const s of [-1, 1]) b.box(w / 2 - 0.14, 0.11, 0.32, C.pillow, s * (w / 4), mattressTop + 0.055, d / 2 - 0.08 - 0.18, 'fabric', 'pillow');
    const blanketD = d * 0.62;
    b.box(w - 0.02, 0.06, blanketD, C.blanket, 0, mattressTop + 0.03, -d / 2 + 0.05 + blanketD / 2, 'fabric', 'blanket');
    b.box(w - 0.02, 0.066, 0.14, C.blanketFold, 0, mattressTop + 0.033, -d / 2 + 0.05 + blanketD - 0.07, 'fabric');
  },

  nightstand(b, w, d, h) {
    b.box(w, h, d, C.wood, 0, h / 2, 0, 'wood');
    b.box(w - 0.06, h * 0.36, 0.012, C.woodLight, 0, h * 0.68, -d / 2 - 0.006, 'wood');
    b.box(w - 0.06, h * 0.36, 0.012, C.woodLight, 0, h * 0.28, -d / 2 - 0.006, 'wood');
    b.cyl(0.015, 0.015, 0.02, C.woodDark, 0, h * 0.68, -d / 2 - 0.02, 'wood', 10).rotation.x = Math.PI / 2;
    // 台灯：木底座 + 木杆 + 暖白灯罩
    b.cyl(0.06, 0.07, 0.03, C.woodLight, 0, h + 0.015, 0.03, 'wood');
    b.cyl(0.012, 0.012, 0.2, C.woodDark, 0, h + 0.13, 0.03, 'wood', 8);
    b.cyl(0.07, 0.11, 0.15, C.lampShade, 0, h + 0.27, 0.03, 'fabric', 24, mat(C.lampShade, 'fabric', 0x6b5a3a, 0.6));
  },

  wardrobe(b, w, d, h) {
    b.box(w, h - 0.06, d, C.warmWhite, 0, 0.06 + (h - 0.06) / 2, 0);
    b.box(w - 0.04, 0.06, d - 0.04, C.woodDark, 0, 0.03, 0, 'wood');
    b.box(w + 0.03, 0.035, d + 0.02, C.cream, 0, h - 0.0175, 0);
    for (const s of [-1, 1]) {
      b.box(w / 2 - 0.03, h - 0.16, 0.014, C.cream, s * (w / 4), 0.06 + (h - 0.06) / 2, -d / 2 - 0.007);
      b.box(0.022, 0.28, 0.025, C.woodDark, s * 0.05, h * 0.55, -d / 2 - 0.02, 'wood');
    }
  },

  window_spot() {
    // 不可见：只承载交互点
  },
};

export interface FurnitureView {
  item: FurnitureItem;
  group: THREE.Group;
}

export function buildFurniture(item: FurnitureItem): FurnitureView {
  const group = new THREE.Group();
  group.name = `furniture:${item.id}`;
  group.userData.furnitureId = item.id;
  const [w, d, h] = item.size;
  MODELS[item.kind](new Builder(group), w, d, h, item);
  placeFurniture(group, item);
  return { item, group };
}

/** 按 position / rotation 摆放（平面逆时针角 = 绕世界 +Y 轴旋转） */
export function placeFurniture(group: THREE.Object3D, item: FurnitureItem) {
  group.position.copy(P(item.position[0], 0, item.position[1]));
  group.rotation.set(0, (item.rotation * Math.PI) / 180, 0);
}
