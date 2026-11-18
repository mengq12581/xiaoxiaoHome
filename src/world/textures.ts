// 写实化用的程序贴图（canvas 生成，断网可用）：颜色贴图 + 由高度图算出的法线贴图。
// 每种贴图只生成一次（缓存），都是可平铺的（噪声按周期取样）。

import * as THREE from 'three';
import { rng } from './noise';

const cache = new Map<string, THREE.Texture>();

/** 可平铺的值噪声：坐标按 period 取模 */
function tileNoise(seed: number) {
  const r = rng(seed);
  const N = 256;
  const table = new Float32Array(N * N);
  for (let i = 0; i < table.length; i++) table[i] = r();
  const at = (x: number, y: number, period: number) => table[(((y % period) + period) % period) * N + (((x % period) + period) % period)];
  const smooth = (t: number) => t * t * (3 - 2 * t);
  /** u, v ∈ [0,1)，freq 为整数（保证无缝） */
  return (u: number, v: number, freq: number) => {
    const x = u * freq;
    const y = v * freq;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = smooth(x - xi);
    const fy = smooth(y - yi);
    const a = at(xi, yi, freq);
    const b = at(xi + 1, yi, freq);
    const c = at(xi, yi + 1, freq);
    const d = at(xi + 1, yi + 1, freq);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}

function fbmTile(noise: ReturnType<typeof tileNoise>, u: number, v: number, base: number, oct = 4) {
  let s = 0;
  let a = 0.5;
  let n = 0;
  let f = base;
  for (let i = 0; i < oct; i++) {
    s += a * noise(u, v, f);
    n += a;
    a *= 0.5;
    f *= 2;
  }
  return s / n;
}

/** 由高度图（0～1）生成切线空间法线贴图 */
function normalFromHeight(h: Float32Array, size: number, strength: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const at = (x: number, y: number) => h[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const k = (y * size + x) * 4;
      data[k] = Math.round((-dx / len * 0.5 + 0.5) * 255);
      data[k + 1] = Math.round((dy / len * 0.5 + 0.5) * 255);
      data[k + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
      data[k + 3] = 255;
    }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

function colorTexture(size: number, fill: (u: number, v: number, out: number[]) => void): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const c = [0, 0, 0, 255];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      c[3] = 255;
      fill(x / size, y / size, c);
      const k = (y * size + x) * 4;
      data[k] = c[0];
      data[k + 1] = c[1];
      data[k + 2] = c[2];
      data[k + 3] = c[3];
    }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

function cached<T extends THREE.Texture>(key: string, make: () => T): T {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key) as T;
}

export interface MaterialMaps {
  map: THREE.Texture;
  normalMap: THREE.Texture;
}

/** 地面细节（灰度，乘在地形顶点色上）：草叶的细碎明暗 + 大一些的斑块 */
export function groundDetail(): MaterialMaps {
  const size = 256;
  const n = tileNoise(11);
  const h = new Float32Array(size * size);
  const map = colorTexture(size, (u, v, c) => {
    const big = fbmTile(n, u, v, 4, 3);
    const fine = fbmTile(n, u + 0.37, v + 0.71, 32, 2);
    const blade = n(u * 1.0, v * 1.0, 128);
    const val = 0.72 + 0.22 * big + 0.16 * (fine - 0.5) + 0.12 * (blade - 0.5);
    h[Math.round(v * size) * size + Math.round(u * size)] = fine * 0.6 + blade * 0.4;
    const g = Math.max(0, Math.min(255, Math.round(val * 255)));
    c[0] = g;
    c[1] = g;
    c[2] = g;
  });
  map.colorSpace = THREE.NoColorSpace;
  return { map, normalMap: normalFromHeight(h, size, 2.5) };
}

/** 通用：按高度函数生成「颜色 + 法线」一对贴图 */
function pair(key: string, size: number, fn: (u: number, v: number) => { h: number; rgb: [number, number, number] }, strength: number): MaterialMaps {
  const k = `pair:${key}`;
  if (cache.has(k)) return { map: cache.get(k)!, normalMap: cache.get(`${k}:n`)! };
  const h = new Float32Array(size * size);
  const map = colorTexture(size, (u, v, c) => {
    const s = fn(u, v);
    h[Math.min(size - 1, Math.round(v * size)) * size + Math.min(size - 1, Math.round(u * size))] = s.h;
    c[0] = s.rgb[0];
    c[1] = s.rgb[1];
    c[2] = s.rgb[2];
  });
  const normalMap = normalFromHeight(h, size, strength);
  cache.set(k, map);
  cache.set(`${k}:n`, normalMap);
  return { map, normalMap };
}

const clamp255 = (x: number) => Math.max(0, Math.min(255, Math.round(x)));

/** 灰泥墙（颜色为乘数，白底） */
export function plasterMaps(): MaterialMaps {
  const n = tileNoise(21);
  return pair('plaster', 256, (u, v) => {
    const big = fbmTile(n, u, v, 3, 3);
    const fine = fbmTile(n, u + 0.5, v, 24, 3);
    const g = clamp255((0.93 + 0.08 * (big - 0.5) + 0.04 * (fine - 0.5)) * 255);
    return { h: fine, rgb: [g, g, g] };
  }, 1.2);
}

/** 石材墙基：错缝砌块，块与块之间有灰缝 */
export function stoneMaps(): MaterialMaps {
  const n = tileNoise(31);
  const r = rng(5);
  const tint = Array.from({ length: 64 }, () => 0.86 + r() * 0.2);
  return pair('stone', 256, (u, v) => {
    const rows = 4;
    const row = Math.floor(v * rows);
    const off = row % 2 ? 0.25 : 0;
    const cols = 2;
    const cu = (u + off) * cols;
    const col = Math.floor(cu);
    const fu = cu - col;
    const fv = v * rows - row;
    const edge = Math.min(fu, 1 - fu, fv * 2, (1 - fv) * 2);
    const mortar = edge < 0.035 ? 1 - edge / 0.035 : 0;
    const t = tint[(row * 7 + (((col % cols) + cols) % cols) * 13) % 64];
    const grain = fbmTile(n, u, v, 16, 3);
    const k = t * (0.88 + 0.24 * grain) * (1 - 0.35 * mortar);
    const g = clamp255(k * 255);
    return { h: (1 - mortar) * 0.8 + grain * 0.2, rgb: [g, g, g] };
  }, 3);
}

/** 屋瓦：一行行鱼鳞瓦，带高度起伏（颜色乘在屋瓦底色上） */
export function roofTileMaps(): MaterialMaps {
  const n = tileNoise(41);
  const r = rng(9);
  const tint = Array.from({ length: 64 }, () => 0.85 + r() * 0.25);
  return pair('roof', 256, (u, v) => {
    const rows = 4;
    const cols = 6;
    const row = Math.floor(v * rows);
    const fv = v * rows - row;
    const off = row % 2 ? 0.5 / cols : 0;
    const cu = ((u + off) * cols) % cols;
    const col = Math.floor(cu);
    const fu = cu - col;
    // 每片瓦的下沿是一道弧，越靠下越鼓起
    const arc = 0.18 * (1 - Math.pow(2 * fu - 1, 2));
    const shape = Math.max(0, Math.min(1, (1 - fv - arc) / 0.9));
    const lip = shape < 0.08 ? shape / 0.08 : 1;
    const ht = (0.25 + 0.75 * (1 - shape)) * lip;
    const t = tint[(row * 11 + col * 5) % 64];
    const grain = fbmTile(n, u, v, 32, 2);
    const k = t * (0.72 + 0.28 * ht) * (0.92 + 0.12 * grain) * (lip < 1 ? 0.6 : 1);
    const g = clamp255(k * 255);
    return { h: ht, rgb: [g, g, g] };
  }, 4);
}

/** 木纹（颜色为乘数）：顺着 u 方向的细长纹理 */
export function woodMaps(): MaterialMaps {
  const n = tileNoise(51);
  return pair('wood', 256, (u, v) => {
    const warp = fbmTile(n, u, v, 2, 2) * 0.6;
    const rings = Math.sin((v * 18 + warp * 6) * Math.PI * 2) * 0.5 + 0.5;
    const fine = n(u, v, 128);
    const k = 0.82 + 0.12 * rings + 0.08 * (fine - 0.5);
    const g = clamp255(k * 255);
    return { h: rings * 0.6 + fine * 0.4, rgb: [g, g, g] };
  }, 1.5);
}

/** 树皮：竖向的沟纹 */
export function barkMaps(): MaterialMaps {
  const n = tileNoise(61);
  return pair('bark', 256, (u, v) => {
    const warp = fbmTile(n, u, v, 2, 2);
    const ridges = Math.pow(Math.abs(Math.sin((u * 7 + warp * 1.5) * Math.PI * 2)), 0.6);
    const fine = fbmTile(n, u, v * 4, 16, 2);
    const k = 0.55 + 0.35 * ridges + 0.15 * (fine - 0.5);
    return { h: ridges * 0.8 + fine * 0.2, rgb: [clamp255(k * 128), clamp255(k * 100), clamp255(k * 78)] };
  }, 4);
}

/** 岩石 */
export function rockMaps(): MaterialMaps {
  const n = tileNoise(71);
  return pair('rock', 256, (u, v) => {
    const a = fbmTile(n, u, v, 4, 5);
    const cracks = Math.abs(fbmTile(n, u + 0.3, v + 0.2, 8, 3) - 0.5) < 0.02 ? 0.6 : 1;
    const k = (0.7 + 0.4 * a) * cracks;
    const g = clamp255(k * 255);
    return { h: a * cracks, rgb: [g, g, g] };
  }, 3);
}

/**
 * 叶片贴图（带透明度）：一张卡片上画一小簇白蜡树的羽状复叶。
 * tone：叶子底色；返回颜色贴图（alpha = 形状）与法线贴图（叶脉起伏）。
 */
export function leafCard(key: string, tone: [number, number, number], seed: number): MaterialMaps {
  const k = `leaf:${key}`;
  if (cache.has(k)) return { map: cache.get(k)!, normalMap: cache.get(`${k}:n`)! };
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const r = rng(seed);
  const hc = document.createElement('canvas');
  hc.width = hc.height = size;
  const hg = hc.getContext('2d')!;
  hg.fillStyle = '#000';
  hg.fillRect(0, 0, size, size);
  // 3～4 根小枝，每根两侧对生 5～7 片椭圆小叶
  const twigs = 3 + Math.floor(r() * 2);
  for (let t = 0; t < twigs; t++) {
    const x0 = size * (0.3 + r() * 0.4);
    const y0 = size;
    const ang = -Math.PI / 2 + (r() - 0.5) * 0.9;
    const len = size * (0.7 + r() * 0.25);
    const pairs = 5 + Math.floor(r() * 3);
    g.strokeStyle = `rgb(${tone[0] * 0.6},${tone[1] * 0.55},${tone[2] * 0.4})`;
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x0 + Math.cos(ang) * len, y0 + Math.sin(ang) * len);
    g.stroke();
    for (let i = 0; i <= pairs; i++) {
      const s = 0.18 + (i / pairs) * 0.8;
      const px = x0 + Math.cos(ang) * len * s;
      const py = y0 + Math.sin(ang) * len * s;
      for (const side of i === pairs ? [0] : [-1, 1]) {
        const la = ang + side * (0.9 + r() * 0.3);
        const ll = size * (0.11 + r() * 0.04) * (i === pairs ? 1.1 : 1);
        const lw = ll * 0.38;
        const cx = px + Math.cos(la) * ll * 0.55;
        const cy = py + Math.sin(la) * ll * 0.55;
        const shade = 0.8 + r() * 0.35;
        g.save();
        g.translate(cx, cy);
        g.rotate(la);
        g.fillStyle = `rgb(${clamp255(tone[0] * shade)},${clamp255(tone[1] * shade)},${clamp255(tone[2] * shade)})`;
        g.beginPath();
        g.ellipse(0, 0, ll * 0.55, lw * 0.5, 0, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = `rgba(255,255,230,0.18)`;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(-ll * 0.5, 0);
        g.lineTo(ll * 0.5, 0);
        g.stroke();
        g.restore();
        hg.save();
        hg.translate(cx, cy);
        hg.rotate(la);
        const grad = hg.createLinearGradient(0, -lw * 0.5, 0, lw * 0.5);
        grad.addColorStop(0, '#444');
        grad.addColorStop(0.5, '#fff');
        grad.addColorStop(1, '#444');
        hg.fillStyle = grad;
        hg.beginPath();
        hg.ellipse(0, 0, ll * 0.55, lw * 0.5, 0, 0, Math.PI * 2);
        hg.fill();
        hg.restore();
      }
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const img = hg.getImageData(0, 0, size, size).data;
  const h = new Float32Array(size * size);
  for (let i = 0; i < h.length; i++) h[i] = img[i * 4] / 255;
  const normalMap = normalFromHeight(h, size, 2);
  normalMap.wrapS = normalMap.wrapT = THREE.ClampToEdgeWrapping;
  cache.set(k, tex);
  cache.set(`${k}:n`, normalMap);
  return { map: tex, normalMap };
}

/** 云的形状贴图（灰度 = 浓度），柔和边缘 */
export function cloudShape(seed: number): THREE.Texture {
  return cached(`cloud:${seed}`, () => {
    const W = 256;
    const H = 128;
    const n = tileNoise(seed);
    const data = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const u = x / W;
        const v = y / H;
        const dx = (u - 0.5) / 0.48;
        const dy = (v - 0.55) / 0.42;
        const fall = Math.max(0, 1 - (dx * dx + dy * dy));
        const d = fbmTile(n, u, v, 4, 5);
        const dens = Math.max(0, Math.min(1, (d * fall * 2.4 - 0.45) * 2.2)) * (v > 0.25 ? 1 : v / 0.25);
        const k = (y * W + x) * 4;
        const shade = Math.max(0, Math.min(1, 1 - (v - 0.35) * 0.9 + (d - 0.5) * 0.6));
        data[k] = Math.round(shade * 255);
        data[k + 1] = Math.round(shade * 255);
        data[k + 2] = Math.round(shade * 255);
        data[k + 3] = Math.round(dens * 255);
      }
    const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
    return t;
  });
}

/** 草丛卡片：几十根细长草叶，底部偏暗、叶尖偏黄，alpha = 形状 */
export function grassCard(): THREE.Texture {
  return cached('grass-card', () => {
    const W = 128;
    const H = 128;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d')!;
    const r = rng(77);
    for (let i = 0; i < 46; i++) {
      const x0 = W * (0.08 + r() * 0.84);
      const hgt = H * (0.45 + r() * 0.53);
      const lean = (r() - 0.5) * W * 0.35;
      const w = 1.6 + r() * 2.2;
      const grad = g.createLinearGradient(0, H, 0, H - hgt);
      const k = 0.75 + r() * 0.4;
      grad.addColorStop(0, `rgb(${Math.round(58 * k)},${Math.round(82 * k)},${Math.round(36 * k)})`);
      grad.addColorStop(0.6, `rgb(${Math.round(112 * k)},${Math.round(146 * k)},${Math.round(66 * k)})`);
      grad.addColorStop(1, `rgb(${Math.round(176 * k)},${Math.round(184 * k)},${Math.round(104 * k)})`);
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(x0 - w, H);
      g.quadraticCurveTo(x0 + lean * 0.3, H - hgt * 0.6, x0 + lean, H - hgt);
      g.quadraticCurveTo(x0 + lean * 0.3 + w * 0.6, H - hgt * 0.6, x0 + w, H);
      g.closePath();
      g.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}
