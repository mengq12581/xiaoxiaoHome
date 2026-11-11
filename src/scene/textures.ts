// 程序生成贴图（canvas），不依赖任何外部素材。

import * as THREE from 'three';

/** 可复现的伪随机（mulberry32） */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

interface FloorStyle {
  base: [number, number, number];
  jitter: number;
  plank: boolean;
}

const FLOOR_STYLES: Record<string, FloorStyle> = {
  wood_light: { base: [222, 196, 160], jitter: 14, plank: true },
  wood_warm: { base: [201, 160, 120], jitter: 14, plank: true },
  tile: { base: [228, 226, 220], jitter: 4, plank: false },
  carpet: { base: [196, 186, 204], jitter: 6, plank: false },
};

const cache = new Map<string, THREE.CanvasTexture>();

/** 1 张贴图覆盖 2m × 2m 地面 */
export const FLOOR_TEXTURE_METERS = 2;

export function floorTexture(kind: string): THREE.CanvasTexture {
  const hit = cache.get(kind);
  if (hit) return hit;
  const style = FLOOR_STYLES[kind] ?? FLOOR_STYLES.wood_light;
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  const rnd = seeded(hashString(kind));
  const [r, gg, b] = style.base;
  const col = (d: number) => `rgb(${Math.round(r + d)},${Math.round(gg + d)},${Math.round(b + d)})`;

  if (style.plank) {
    // 木地板：每行 0.2m 宽（512px/2m → 51px）
    const rows = 10;
    const rowH = size / rows;
    for (let i = 0; i < rows; i++) {
      let x = -rnd() * size * 0.5;
      while (x < size) {
        const len = size * (0.35 + rnd() * 0.4);
        g.fillStyle = col((rnd() - 0.5) * style.jitter * 2);
        g.fillRect(x, i * rowH, len, rowH);
        // 木纹
        g.strokeStyle = 'rgba(120,80,40,0.08)';
        g.lineWidth = 1;
        for (let k = 0; k < 3; k++) {
          const yy = i * rowH + rowH * (0.2 + rnd() * 0.6);
          g.beginPath();
          g.moveTo(x + 4, yy);
          g.bezierCurveTo(x + len * 0.3, yy + (rnd() - 0.5) * 6, x + len * 0.7, yy + (rnd() - 0.5) * 6, x + len - 4, yy);
          g.stroke();
        }
        g.fillStyle = 'rgba(90,60,30,0.28)';
        g.fillRect(x, i * rowH, 2, rowH);
        x += len;
      }
      g.fillStyle = 'rgba(90,60,30,0.22)';
      g.fillRect(0, i * rowH, size, 2);
    }
  } else {
    g.fillStyle = col(0);
    g.fillRect(0, 0, size, size);
    const n = 4;
    const cell = size / n;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        g.fillStyle = col((rnd() - 0.5) * style.jitter * 2);
        g.fillRect(i * cell + 2, j * cell + 2, cell - 4, cell - 4);
      }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  cache.set(kind, tex);
  return tex;
}
