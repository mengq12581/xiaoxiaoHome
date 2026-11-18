// 程序化家具模型。局部坐标：x 右、y 上、-z 为家具正面（人使用的一侧），原点在占地中心的地面上。
// 尺寸取自 furniture.json 的 size = [宽, 深, 高]。
// 道具约定（由 scene/props.ts 按名字接管，平时的样子就是这里建出来的样子）：
//   prop:<名字>  活动需要时才出现的东西（翻开的本子、盖在身上的被子、碗）
//   hide:<名字>  该道具出现时要藏起来的东西（合上的本子）
//   glow:<名字>  该道具「出现」时发光的面（电脑屏幕、电视屏幕）
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
  ceramic: 0xf7f5f0,
  tile: 0xe9e7e1,
  mirror: 0xd3e4ea,
  faucet: 0xb9b1a6,
  terracotta: 0xc98b6b,
  leaf: 0x7fa878,
  leafDark: 0x5f8a62,
  leafLight: 0xa3c48f,
  flowerPink: 0xe8a3b0,
  flowerYellow: 0xf0cf7a,
};

/** 镜面：哑光偏亮，不做真反射 */
const mirrorMat = soft(C.mirror, { roughness: 0.25 });
/** 淋浴隔断玻璃 */
const glassPanelMat = soft(0xcfe6f2, { roughness: 0.15, transparent: true, opacity: 0.3, depthWrite: false });

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
  ball(r: number, color: number, x: number, y: number, z: number, finish: Finish = 'paint') {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), mat(color, finish));
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
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
    // 碗（吃饭时才出现）
    const bowl = new THREE.Group();
    bowl.name = 'prop:bowl';
    bowl.position.set(-w * 0.12, h, -d * 0.12);
    new Builder(bowl).cyl(0.07, 0.04, 0.06, 0xf3ede3, 0, 0.03, 0);
    b.g.add(bowl);
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
    b.box(sw - 0.04, sh - 0.04, 0.004, C.screen, 0, ty, 0.04 - 0.024, 'paint', 'glow:tv_glow', mat(C.screen, 'paint', 0x0e141c));
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
    b.box(0.54, 0.3, 0.004, C.screen, 0, h + 0.3, mz - 0.026, 'paint', 'glow:screen_glow', mat(C.screen, 'paint', 0x0e141c));
    // 键盘、鼠标（靠里放，桌子前沿留给本子）
    b.box(0.42, 0.02, 0.13, 0xece8e2, -0.02, h + 0.01, -d / 2 + 0.31, 'paint', 'keyboard');
    b.box(0.05, 0.022, 0.08, 0xece8e2, 0.3, h + 0.011, -d / 2 + 0.31);
    // 本子：平时合着放在桌角；写笔记时换成摊开在面前的那本
    b.box(0.21, 0.016, 0.28, 0xc97b63, w / 2 - 0.26, h + 0.008, -d / 2 + 0.22, 'fabric', 'hide:notebook_open');
    b.box(0.2, 0.005, 0.27, 0xfaf6ee, w / 2 - 0.255, h + 0.012, -d / 2 + 0.22, 'paint', 'hide:notebook_open');
    const open = new THREE.Group();
    open.name = 'prop:notebook_open';
    open.position.set(0.02, h, -d / 2 + 0.13);
    const ob = new Builder(open);
    ob.box(0.4, 0.008, 0.26, 0xc97b63, 0, 0.004, 0, 'fabric');
    for (const sx of [-1, 1]) ob.box(0.185, 0.008, 0.24, 0xfaf6ee, sx * 0.097, 0.011, 0);
    ob.box(0.006, 0.01, 0.24, 0xd9d2c4, 0, 0.012, 0);
    // 几行字
    for (let i = 0; i < 4; i++) ob.box(0.13, 0.002, 0.008, 0xb9b2a6, -0.097, 0.0155, -0.08 + i * 0.035);
    b.g.add(open);
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

  bed(b, w, d, h, item) {
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
    // 盖在身上的被子（睡觉时才鼓起来）：位置跟着「躺」的交互点走，从脚盖到胸口
    const lie = item.anchors.find((a) => a.id === 'bed_lie');
    if (lie) {
      const cover = new THREE.Group();
      cover.name = 'prop:blanket_cover';
      // 交互点局部 [右, 前]：前 = 家具正面 = -z
      cover.position.set(lie.local[0], mattressTop - 0.03, -lie.local[1] - 0.14);
      // 一团鼓起的被子：压扁的椭球，下半埋在床垫里
      const bump = new THREE.Mesh(new THREE.SphereGeometry(0.5, 40, 24), mat(C.blanket, 'fabric'));
      bump.scale.set(0.8, 0.5, 0.92);
      bump.position.y = 0.06;
      bump.castShadow = true;
      bump.receiveShadow = true;
      cover.add(bump);
      b.g.add(cover);
    }
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

  shoe_cabinet(b, w, d, h) {
    b.box(w - 0.04, 0.06, d - 0.04, C.woodDark, 0, 0.03, 0, 'wood');
    b.box(w, h - 0.1, d, C.warmWhite, 0, 0.06 + (h - 0.1) / 2, 0);
    b.box(w + 0.03, 0.04, d + 0.02, C.wood, 0, h - 0.02, 0, 'wood');
    for (const s of [-1, 1]) {
      b.box(w / 2 - 0.03, h - 0.2, 0.014, C.cream, s * (w / 4), 0.06 + (h - 0.1) / 2, -d / 2 - 0.007);
      b.box(0.022, 0.16, 0.025, C.woodDark, s * 0.05, h * 0.6, -d / 2 - 0.02, 'wood');
    }
    // 柜面上一小盆绿植
    b.cyl(0.05, 0.04, 0.07, C.terracotta, w * 0.28, h + 0.035, 0);
    b.ball(0.07, C.leaf, w * 0.28, h + 0.12, 0, 'fabric');
  },

  vanity(b, w, d, h) {
    // 洗手台：木柜 + 台面 + 台盆 + 龙头；背后（靠墙）一面镜子
    b.box(w, h - 0.1, d - 0.03, C.wood, 0, 0.06 + (h - 0.1) / 2, 0.015, 'wood');
    for (const s of [-1, 1]) b.box(w / 2 - 0.03, h - 0.22, 0.014, C.woodLight, s * (w / 4), 0.06 + (h - 0.1) / 2, -d / 2 + 0.022, 'wood');
    b.box(w + 0.02, 0.05, d, C.ceramic, 0, h - 0.025, 0);
    const basin = b.cyl(0.17, 0.15, 0.035, C.tile, 0, h + 0.012, -0.03);
    basin.scale.z = 0.78;
    b.cyl(0.14, 0.12, 0.012, C.mirror, 0, h + 0.03, -0.03).scale.z = 0.78;
    b.cyl(0.014, 0.014, 0.13, C.faucet, 0, h + 0.065, d / 2 - 0.09, 'paint', 12);
    b.box(0.022, 0.02, 0.1, C.faucet, 0, h + 0.125, d / 2 - 0.13);
    b.box(w * 0.86, 0.72, 0.03, C.wood, 0, h + 0.62, d / 2 - 0.02, 'wood');
    b.box(w * 0.86 - 0.07, 0.65, 0.012, C.mirror, 0, h + 0.62, d / 2 - 0.04, 'paint', 'mirror', mirrorMat);
  },

  kitchenette(b, w, d, h) {
    // 厨房角（docs/验收问题.md C18）：靠墙一条操作台 + 水槽 + 两格吊柜；台面上一只电水壶、两只杯子。
    // 不做灶、不明火、不排烟。局部 +z 是墙，-z 是人站的一侧。
    const kick = 0.1;
    const topT = 0.04;
    // 踢脚（往里缩）+ 柜体
    b.box(w - 0.04, kick, d - 0.1, C.charcoal, 0, kick / 2, 0.04);
    const bodyH = h - kick - topT;
    b.box(w, bodyH, d - 0.03, C.warmWhite, 0, kick + bodyH / 2, 0.015);
    // 柜门：左边两扇（水槽柜），右边三层抽屉；浅木门板 + 深色细长拉手
    const fz = -d / 2 + 0.006;
    const third = w / 3;
    const doorH = bodyH - 0.03;
    const sinkW = third * 2;
    for (let i = 0; i < 2; i++) {
      const x = -w / 2 + sinkW / 4 + (sinkW / 2) * i;
      b.box(sinkW / 2 - 0.012, doorH, 0.018, C.woodLight, x, kick + bodyH / 2, fz, 'wood');
      b.box(0.012, 0.16, 0.014, C.charcoal, x + (i === 0 ? 1 : -1) * (sinkW / 4 - 0.05), kick + bodyH - 0.14, fz - 0.014);
    }
    const drawerH = (doorH - 0.02) / 3;
    for (let i = 0; i < 3; i++) {
      const y = kick + 0.015 + drawerH / 2 + i * (drawerH + 0.01);
      b.box(third - 0.012, drawerH, 0.018, C.woodLight, w / 2 - third / 2, y, fz, 'wood');
      b.box(0.16, 0.012, 0.014, C.charcoal, w / 2 - third / 2, y + drawerH / 2 - 0.05, fz - 0.014);
    }
    // 台面：在水槽处开洞（四块拼成）
    const sx = -w / 2 + sinkW / 2; // 水槽中心
    const sw = 0.52;
    const sd = 0.38;
    const sz = -0.03;
    const ty = h - topT / 2;
    const td = d + 0.02;
    const tz = -0.01;
    const top = (x0: number, x1: number, z0: number, z1: number) => b.box(x1 - x0, topT, z1 - z0, C.cream, (x0 + x1) / 2, ty, (z0 + z1) / 2);
    top(-w / 2 - 0.01, sx - sw / 2, tz - td / 2, tz + td / 2);
    top(sx + sw / 2, w / 2 + 0.01, tz - td / 2, tz + td / 2);
    top(sx - sw / 2, sx + sw / 2, tz - td / 2, sz - sd / 2);
    top(sx - sw / 2, sx + sw / 2, sz + sd / 2, tz + td / 2);
    // 不锈钢水槽：底板 + 四壁，沉到台面以下
    const steel = soft(0xb9bec1, { roughness: 0.32, metalness: 0.6 });
    const depth = 0.17;
    const plate = (pw: number, ph: number, pd: number, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(pw, ph, pd), steel);
      m.position.set(x, y, z);
      m.receiveShadow = true;
      b.g.add(m);
    };
    plate(sw, 0.01, sd, sx, h - topT - depth, sz);
    plate(sw, depth, 0.01, sx, h - topT - depth / 2, sz - sd / 2);
    plate(sw, depth, 0.01, sx, h - topT - depth / 2, sz + sd / 2);
    plate(0.01, depth, sd, sx - sw / 2, h - topT - depth / 2, sz);
    plate(0.01, depth, sd, sx + sw / 2, h - topT - depth / 2, sz);
    plate(0.05, 0.004, 0.05, sx, h - topT - depth + 0.008, sz); // 下水口
    // 龙头：底座 + 立管 + 鹅颈弯（半圆环）+ 单把手
    const tapZ = sz + sd / 2 + 0.06;
    b.cyl(0.024, 0.026, 0.02, C.faucet, sx, h + 0.01, tapZ, 'paint', 16, steel);
    b.cyl(0.012, 0.012, 0.24, C.faucet, sx, h + 0.13, tapZ, 'paint', 12, steel);
    const neck = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.012, 8, 20, Math.PI), steel);
    neck.rotation.y = Math.PI / 2;
    neck.position.set(sx, h + 0.25, tapZ - 0.075);
    neck.castShadow = true;
    b.g.add(neck);
    b.cyl(0.013, 0.011, 0.05, C.faucet, sx, h + 0.225, tapZ - 0.15, 'paint', 12, steel);
    b.box(0.012, 0.012, 0.07, C.faucet, sx + 0.035, h + 0.06, tapZ - 0.01, 'paint', undefined, steel);
    // 墙面防溅：一条浅色瓷砖，从台面到吊柜底
    const cabBottom = h + 0.62;
    b.box(w, cabBottom - h, 0.012, C.tile, 0, h + (cabBottom - h) / 2, d / 2 - 0.006);
    // 两格吊柜（每格一扇门，拉手在下沿）
    const cabH = 0.62;
    const cabD = 0.33;
    const cabW = (w - 0.02) / 2;
    for (let i = 0; i < 2; i++) {
      const x = -w / 2 + cabW / 2 + i * (cabW + 0.02);
      const z = d / 2 - cabD / 2 - 0.012;
      b.box(cabW, cabH, cabD, C.warmWhite, x, cabBottom + cabH / 2, z);
      b.box(cabW - 0.014, cabH - 0.014, 0.018, C.woodLight, x, cabBottom + cabH / 2, z - cabD / 2 - 0.008, 'wood');
      b.box(0.14, 0.012, 0.014, C.charcoal, x + (i === 0 ? 1 : -1) * (cabW / 2 - 0.12), cabBottom + 0.05, z - cabD / 2 - 0.022);
    }
    // 电水壶（底座 + 壶身 + 盖 + 提手 + 壶嘴），放在抽屉柜那一侧
    const kx = w / 2 - third / 2 - 0.12;
    const kz = 0.02;
    b.cyl(0.078, 0.082, 0.02, C.charcoal, kx, h + 0.01, kz, 'paint', 24);
    b.cyl(0.058, 0.074, 0.17, C.warmWhite, kx, h + 0.105, kz, 'paint', 24);
    b.cyl(0.05, 0.057, 0.014, C.cream, kx, h + 0.197, kz, 'paint', 24);
    b.ball(0.014, C.charcoal, kx, h + 0.21, kz);
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.011, 8, 16, Math.PI), mat(C.charcoal));
    // 半圆环先转成「右半边」，再转到壶背后（+z），竖着贴在壶身上
    handle.rotation.set(0, -Math.PI / 2, -Math.PI / 2);
    handle.position.set(kx, h + 0.11, kz + 0.045);
    handle.castShadow = true;
    b.g.add(handle);
    const spout = b.cyl(0.008, 0.016, 0.06, C.warmWhite, kx, h + 0.16, kz - 0.085, 'paint', 12);
    spout.rotation.x = -0.9;
    // 两只杯子：一只奶白、一只陶土色，杯口里面颜色深一点（看得出是空心的）
    for (const [cx, cz, color] of [
      [w / 2 - 0.2, -0.1, C.ceramic],
      [w / 2 - 0.1, -0.03, C.terracotta],
    ] as const) {
      b.cyl(0.036, 0.032, 0.088, color, cx, h + 0.044, cz, 'paint', 20);
      b.cyl(0.03, 0.03, 0.004, 0x6b5a4d, cx, h + 0.086, cz, 'paint', 20);
      const ear = new THREE.Mesh(new THREE.TorusGeometry(0.022, 0.006, 6, 12, Math.PI), mat(color));
      ear.rotation.z = -Math.PI / 2;
      ear.position.set(cx + 0.034, h + 0.046, cz);
      ear.castShadow = true;
      b.g.add(ear);
    }
  },

  toilet(b, w, d, h) {
    // 水箱靠墙（+z），坐圈朝外
    b.box(w, h * 0.5, 0.18, C.ceramic, 0, h * 0.7, d / 2 - 0.09);
    b.box(w * 0.92, 0.03, 0.2, C.tile, 0, h * 0.96, d / 2 - 0.09);
    b.box(w * 0.7, h * 0.42, d * 0.5, C.ceramic, 0, h * 0.21, -0.02);
    const bowl = b.cyl(w * 0.48, w * 0.36, 0.1, C.ceramic, 0, h * 0.47, -d * 0.12, 'paint', 28);
    bowl.scale.z = 1.25;
    const lid = b.cyl(w * 0.46, w * 0.46, 0.025, C.tile, 0, h * 0.55, -d * 0.12, 'paint', 28);
    lid.scale.z = 1.25;
  },

  shower(b, w, d, h) {
    // 淋浴区：浅色防滑地台 + 地漏 + 靠左墙的花洒立杆
    b.box(w, h, d, C.tile, 0, h / 2, 0);
    b.cyl(0.05, 0.05, 0.01, C.faucet, w * 0.15, h + 0.005, 0, 'paint', 16);
    const x = -w / 2 + 0.07;
    b.cyl(0.014, 0.014, 1.95, C.faucet, x, h + 0.975, 0, 'paint', 12);
    b.box(0.26, 0.022, 0.022, C.faucet, x + 0.13, h + 1.95, 0);
    b.cyl(0.1, 0.1, 0.025, C.faucet, x + 0.27, h + 1.93, 0, 'paint', 24);
    b.box(0.05, 0.12, 0.08, C.faucet, x + 0.01, h + 1.05, 0);
  },

  shower_glass(b, w, d, h) {
    // 淋浴与马桶之间的玻璃隔断（只隔左半，右侧留通道）
    const panel = new THREE.Mesh(new RoundedBoxGeometry(w, h, 0.012, 2, 0.005), glassPanelMat);
    panel.position.set(0, h / 2 + 0.03, 0);
    panel.renderOrder = 1;
    b.g.add(panel);
    b.box(w, 0.03, d, C.faucet, 0, 0.015, 0);
    b.box(w, 0.025, d * 0.8, C.faucet, 0, h + 0.04, 0);
    b.box(0.03, h + 0.05, d * 0.8, C.faucet, w / 2 - 0.015, (h + 0.05) / 2, 0);
  },

  plants(b, w, d, h, item) {
    // 一丛花草：高矮不一的陶盆，叶团 + 零星小花；位置由 id 决定，每次一样
    const rnd = seeded(hashString(item.id));
    const pots: [number, number, number, number][] = [
      [0.2, -0.3, 0.17, 1.0],
      [-0.22, -0.34, 0.12, 0.62],
      [0.24, 0.12, 0.13, 0.72],
      [-0.18, 0.02, 0.15, 0.5],
      [0.0, 0.38, 0.1, 0.42],
      [-0.3, 0.36, 0.09, 0.34],
    ];
    const leaves = [C.leaf, C.leafDark, C.leafLight];
    const blooms = [C.flowerPink, C.flowerYellow, C.pillow];
    pots.forEach(([fx, fz, r, tall], i) => {
      const x = fx * w;
      const z = -fz * d;
      const potH = 0.12 + r * 0.7;
      b.cyl(r, r * 0.78, potH, i % 2 ? C.terracotta : C.cream, x, potH / 2, z, 'paint', 20);
      const top = potH + tall * h * 0.55;
      const n = 3 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) {
        const a = rnd() * Math.PI * 2;
        const rr = r * (0.3 + rnd() * 0.7);
        const yy = potH + (top - potH) * (0.35 + rnd() * 0.65);
        b.ball(r * (0.75 + rnd() * 0.5), leaves[(i + k) % 3], x + Math.cos(a) * rr, yy, z + Math.sin(a) * rr, 'fabric');
      }
      if (i % 2 === 0) {
        for (let k = 0; k < 4; k++) {
          const a = rnd() * Math.PI * 2;
          b.ball(0.03, blooms[(i + k) % 3], x + Math.cos(a) * r * 0.9, top + 0.02 + rnd() * 0.06, z + Math.sin(a) * r * 0.9, 'fabric');
        }
      }
    });
  },

  round_table(b, w, _d, h) {
    b.cyl(w / 2, w / 2, 0.04, C.wood, 0, h - 0.02, 0, 'wood', 40);
    b.cyl(0.035, 0.045, h - 0.07, C.woodDark, 0, (h - 0.07) / 2 + 0.03, 0, 'wood', 16);
    b.cyl(w * 0.3, w * 0.33, 0.03, C.woodDark, 0, 0.015, 0, 'wood', 28);
    // 桌上一只杯子
    b.cyl(0.03, 0.026, 0.07, C.ceramic, w * 0.16, h + 0.035, w * 0.08, 'paint', 16);
  },

  balcony_chair(b, w, d, h) {
    const seatY = 0.42;
    legs(b, w, d, seatY - 0.02, 0.05, 0.04, C.woodDark);
    b.box(w, 0.05, d, C.wood, 0, seatY, 0, 'wood');
    b.box(w - 0.06, 0.04, d - 0.06, C.blanketFold, 0, seatY + 0.04, 0, 'fabric');
    const back = b.box(w, h - seatY - 0.02, 0.04, C.wood, 0, seatY + (h - seatY) / 2, d / 2 - 0.02, 'wood');
    back.rotation.x = 0.1;
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
