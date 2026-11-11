// 程序化家具模型。局部坐标：x 右、y 上、-z 为家具正面（人使用的一侧），原点在占地中心的地面上。
// 尺寸取自 furniture.json 的 size = [宽, 深, 高]。

import * as THREE from 'three';
import type { FurnitureItem } from '../config/types';
import { P } from './house';
import { hashString, seeded } from './textures';

const matCache = new Map<string, THREE.MeshLambertMaterial>();
function mat(color: number, opts: { emissive?: number; emissiveIntensity?: number } = {}): THREE.MeshLambertMaterial {
  const key = `${color}:${opts.emissive ?? 0}:${opts.emissiveIntensity ?? 0}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color, emissive: opts.emissive ?? 0x000000, emissiveIntensity: opts.emissiveIntensity ?? 1 });
    matCache.set(key, m);
  }
  return m;
}

const C = {
  wood: 0xc9a27a,
  woodDark: 0xa57b55,
  woodLight: 0xe2c9a6,
  white: 0xf3ede4,
  cream: 0xece2d4,
  sofa: 0x8fa79f,
  sofaLight: 0xa8bcb4,
  fabric: 0x6a7a8c,
  black: 0x24242a,
  screen: 0x2f3a48,
  metal: 0x8c8c94,
  blanket: 0xebc6ae,
  blanketFold: 0xf6e2d2,
  pillow: 0xfbf7f0,
  sheet: 0xf5f1ea,
  lampShade: 0xfff1d2,
};

class Builder {
  constructor(public g: THREE.Group) {}
  box(w: number, h: number, d: number, color: number, x: number, y: number, z: number, name?: string, m?: THREE.Material) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m ?? mat(color));
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (name) mesh.name = name;
    this.g.add(mesh);
    return mesh;
  }
  cyl(rt: number, rb: number, h: number, color: number, x: number, y: number, z: number, seg = 16, m?: THREE.Material) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m ?? mat(color));
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.g.add(mesh);
    return mesh;
  }
}

function legs(b: Builder, w: number, d: number, h: number, inset: number, size: number, color: number) {
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) b.box(size, h, size, color, sx * (w / 2 - inset), h / 2, sz * (d / 2 - inset));
}

type ModelFn = (b: Builder, w: number, d: number, h: number, item: FurnitureItem) => void;

const MODELS: Record<string, ModelFn> = {
  sofa(b, w, d, h) {
    const legH = 0.08;
    legs(b, w, d, legH, 0.08, 0.05, C.woodDark);
    const baseH = 0.22;
    b.box(w, baseH, d, C.sofa, 0, legH + baseH / 2, 0);
    const backT = 0.22;
    b.box(w, h - legH, backT, C.sofa, 0, legH + (h - legH) / 2, d / 2 - backT / 2);
    const armW = 0.18;
    const armH = 0.58;
    for (const s of [-1, 1]) b.box(armW, armH, d, C.sofa, s * (w / 2 - armW / 2), legH + armH / 2, 0);
    const inner = w - armW * 2;
    const n = 3;
    const cw = inner / n - 0.02;
    const cd = d - backT - 0.03;
    for (let i = 0; i < n; i++) {
      const x = -inner / 2 + (inner / n) * (i + 0.5);
      b.box(cw, 0.13, cd, C.sofaLight, x, legH + baseH + 0.065, -d / 2 + cd / 2 + 0.01);
      const back = b.box(cw, 0.36, 0.12, C.sofaLight, x, legH + baseH + 0.13 + 0.17, d / 2 - backT - 0.05);
      back.rotation.x = -0.12;
    }
  },

  coffee_table(b, w, d, h) {
    b.box(w, 0.05, d, C.wood, 0, h - 0.025, 0);
    legs(b, w, d, h - 0.05, 0.06, 0.05, C.woodDark);
    b.box(w - 0.14, 0.025, d - 0.14, C.woodLight, 0, 0.13, 0);
    // 小摆件：杯子
    b.cyl(0.035, 0.03, 0.09, 0xf6f1ea, w * 0.22, h + 0.045, d * 0.1);
  },

  tv_stand(b, w, d, h) {
    b.box(w, h, d, C.white, 0, h / 2, 0);
    for (const s of [-1, 1]) b.box(w / 2 - 0.05, h - 0.12, 0.012, C.cream, s * (w / 4), h / 2, -d / 2 - 0.006);
    for (const s of [-1, 1]) b.box(0.08, 0.015, 0.02, C.metal, s * 0.06, h / 2, -d / 2 - 0.02);
    const sw = Math.min(w * 0.85, 1.3);
    const sh = sw * 0.56;
    b.box(0.34, 0.015, 0.2, C.black, 0, h + 0.0075, 0.02);
    b.box(0.07, 0.09, 0.04, C.black, 0, h + 0.045, 0.04);
    const ty = h + 0.09 + sh / 2;
    b.box(sw, sh, 0.045, C.black, 0, ty, 0.04, 'tv_body');
    b.box(sw - 0.04, sh - 0.04, 0.004, C.screen, 0, ty, 0.04 - 0.024, 'tv_screen', mat(C.screen, { emissive: 0x0e141c, emissiveIntensity: 1 }));
  },

  desk(b, w, d, h) {
    b.box(w, 0.04, d, C.wood, 0, h - 0.02, 0);
    for (const s of [-1, 1]) b.box(0.04, h - 0.04, d - 0.04, C.woodDark, s * (w / 2 - 0.03), (h - 0.04) / 2, 0);
    b.box(w - 0.1, 0.32, 0.02, C.woodDark, 0, h - 0.04 - 0.16, d / 2 - 0.06);
    // 显示器（面朝使用者）
    const mz = d / 2 - 0.16;
    b.box(0.2, 0.012, 0.14, C.black, 0, h + 0.006, mz);
    b.box(0.05, 0.13, 0.035, C.black, 0, h + 0.065, mz + 0.01);
    b.box(0.58, 0.34, 0.03, C.black, 0, h + 0.13 + 0.17, mz - 0.01, 'monitor');
    b.box(0.54, 0.3, 0.004, C.screen, 0, h + 0.3, mz - 0.026, 'monitor_screen', mat(C.screen, { emissive: 0x0e141c, emissiveIntensity: 1 }));
    // 键盘、鼠标
    b.box(0.42, 0.02, 0.13, 0xe7e7e9, -0.02, h + 0.01, -d / 2 + 0.2, 'keyboard');
    b.box(0.05, 0.02, 0.08, 0xe7e7e9, 0.3, h + 0.01, -d / 2 + 0.2);
    // 本子（合上的；写笔记时翻开）
    b.box(0.21, 0.016, 0.28, 0xc97b63, w / 2 - 0.26, h + 0.008, -d / 2 + 0.22, 'notebook');
    b.box(0.2, 0.004, 0.27, 0xfaf6ee, w / 2 - 0.255, h + 0.011, -d / 2 + 0.22);
    // 笔筒
    b.cyl(0.035, 0.035, 0.1, 0x9fb7c6, -w / 2 + 0.16, h + 0.05, d / 2 - 0.12);
  },

  office_chair(b, w, d, h) {
    const sw = w * 0.85;
    const sd = d * 0.82;
    const seatY = 0.46;
    // 五星脚
    for (let i = 0; i < 5; i++) {
      const leg = b.box(w * 0.48, 0.03, 0.04, C.black, 0, 0.05, 0);
      const a = (i / 5) * Math.PI * 2;
      leg.rotation.y = a;
      leg.position.set(Math.cos(a) * w * 0.22, 0.05, -Math.sin(a) * w * 0.22);
      b.cyl(0.025, 0.025, 0.04, C.black, Math.cos(a) * w * 0.44, 0.02, -Math.sin(a) * w * 0.44, 8);
    }
    b.cyl(0.028, 0.028, seatY - 0.1, C.metal, 0, (seatY - 0.1) / 2 + 0.06, 0, 10);
    b.box(sw, 0.08, sd, C.fabric, 0, seatY, 0);
    const backH = Math.max(0.3, h - seatY - 0.08);
    const back = b.box(sw * 0.95, backH, 0.06, C.fabric, 0, seatY + 0.06 + backH / 2, sd / 2 - 0.02);
    back.rotation.x = 0.08;
    b.box(0.04, 0.2, 0.04, C.black, 0, seatY + 0.12, sd / 2 - 0.02);
  },

  bookshelf(b, w, d, h, item) {
    const t = 0.03;
    for (const s of [-1, 1]) b.box(t, h, d, C.woodLight, s * (w / 2 - t / 2), h / 2, 0);
    b.box(w, t, d, C.woodLight, 0, h - t / 2, 0);
    b.box(w, t, d, C.woodLight, 0, t / 2 + 0.04, 0);
    b.box(w - 2 * t, 0.04, 0.02, C.woodLight, 0, 0.02, -d / 2 + 0.01);
    b.box(w, h, 0.012, C.cream, 0, h / 2, d / 2 - 0.006);
    const levels = 4;
    const inner = h - t - (0.04 + t);
    const step = inner / levels;
    const rnd = seeded(hashString(item.id));
    const bookColors = [0xd98c74, 0x8fb3c9, 0xe8c76f, 0x9fbf8f, 0xc7a3c9, 0xf0ede6, 0x6f8fa6, 0xd6b29a];
    for (let k = 0; k < levels; k++) {
      const y0 = 0.04 + t + k * step;
      if (k > 0) b.box(w - 2 * t, 0.022, d - 0.02, C.woodLight, 0, y0, 0);
      let x = -w / 2 + t + 0.02;
      const xEnd = w / 2 - t - 0.02;
      const fill = 0.45 + rnd() * 0.45;
      while (x < -w / 2 + t + (w - 2 * t) * fill && x < xEnd - 0.06) {
        const bw = 0.025 + rnd() * 0.035;
        const bh = Math.min(step - 0.06, 0.17 + rnd() * 0.12);
        b.box(bw, bh, d - 0.08, bookColors[Math.floor(rnd() * bookColors.length)], x + bw / 2, y0 + 0.011 + bh / 2, 0.01);
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
    b.box(w, frameH, d, C.wood, 0, legH + frameH / 2, 0);
    const mattressTop = h;
    b.box(w - 0.06, 0.2, d - 0.1, C.sheet, 0, mattressTop - 0.1, -0.03);
    b.box(w + 0.02, 0.95, 0.07, C.wood, 0, 0.475, d / 2 - 0.035, 'headboard');
    for (const s of [-1, 1]) b.box(w / 2 - 0.14, 0.11, 0.32, C.pillow, s * (w / 4), mattressTop + 0.055, d / 2 - 0.08 - 0.18, 'pillow');
    const blanketD = d * 0.62;
    b.box(w - 0.02, 0.06, blanketD, C.blanket, 0, mattressTop + 0.03, -d / 2 + 0.05 + blanketD / 2, 'blanket');
    b.box(w - 0.02, 0.066, 0.14, C.blanketFold, 0, mattressTop + 0.033, -d / 2 + 0.05 + blanketD - 0.07);
  },

  nightstand(b, w, d, h) {
    b.box(w, h, d, C.wood, 0, h / 2, 0);
    b.box(w - 0.06, h * 0.36, 0.012, C.woodLight, 0, h * 0.68, -d / 2 - 0.006);
    b.box(w - 0.06, h * 0.36, 0.012, C.woodLight, 0, h * 0.28, -d / 2 - 0.006);
    b.cyl(0.015, 0.015, 0.02, C.metal, 0, h * 0.68, -d / 2 - 0.02, 8).rotation.x = Math.PI / 2;
    // 台灯
    b.cyl(0.06, 0.07, 0.03, C.cream, 0, h + 0.015, 0.03);
    b.cyl(0.012, 0.012, 0.2, C.metal, 0, h + 0.13, 0.03, 8);
    b.cyl(0.07, 0.11, 0.15, C.lampShade, 0, h + 0.27, 0.03, 20, mat(C.lampShade, { emissive: 0x6b5a3a, emissiveIntensity: 0.6 }));
  },

  wardrobe(b, w, d, h) {
    b.box(w, h - 0.06, d, C.white, 0, 0.06 + (h - 0.06) / 2, 0);
    b.box(w - 0.04, 0.06, d - 0.04, C.woodDark, 0, 0.03, 0);
    b.box(w + 0.03, 0.035, d + 0.02, C.cream, 0, h - 0.0175, 0);
    for (const s of [-1, 1]) {
      b.box(w / 2 - 0.03, h - 0.16, 0.014, C.cream, s * (w / 4), 0.06 + (h - 0.06) / 2, -d / 2 - 0.007);
      b.box(0.02, 0.28, 0.025, C.woodDark, s * 0.05, h * 0.55, -d / 2 - 0.02);
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
