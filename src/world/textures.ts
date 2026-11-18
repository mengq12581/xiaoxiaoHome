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
    const g = clamp255((0.96 + 0.05 * (big - 0.5) + 0.025 * (fine - 0.5)) * 255);
    return { h: fine, rgb: [g, g, g] };
  }, 1.0);
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

/** 立边咬合金属屋面：一张贴图 = 一块板（u 方向两侧是凸起的咬合边），v 方向有很淡的竖向流痕 */
export function metalSeamMaps(): MaterialMaps {
  const n = tileNoise(91);
  return pair('metal-seam', 256, (u, v) => {
    const d = Math.min(u, 1 - u);
    const seam = d < 0.035 ? 1 - d / 0.035 : 0;
    const streak = fbmTile(n, u * 0.25, v, 8, 2);
    const k = (0.9 + 0.1 * streak) * (seam > 0 ? 1.12 - 0.25 * (1 - seam) : 1);
    const g = clamp255(k * 230);
    return { h: seam * 0.9 + streak * 0.05, rgb: [g, g, g] };
  }, 6);
}

/** 画一朵五瓣花（樱花 / 白花）：petal 花瓣色，heart 花心色 */
function drawBlossom(g: CanvasRenderingContext2D, x: number, y: number, r: number, rot: number, petal: string, heart: string, edge: string) {
  for (let i = 0; i < 5; i++) {
    const a = rot + (i / 5) * Math.PI * 2;
    g.save();
    g.translate(x + Math.cos(a) * r * 0.5, y + Math.sin(a) * r * 0.5);
    g.rotate(a + Math.PI / 2);
    const grad = g.createRadialGradient(0, r * 0.25, 0, 0, 0, r * 0.62);
    grad.addColorStop(0, heart);
    grad.addColorStop(0.45, petal);
    grad.addColorStop(1, edge);
    g.fillStyle = grad;
    g.beginPath();
    g.ellipse(0, 0, r * 0.36, r * 0.55, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
  g.fillStyle = heart;
  g.beginPath();
  g.arc(x, y, r * 0.16, 0, Math.PI * 2);
  g.fill();
}

/**
 * 花枝卡片：一小段深色细枝上挤满五瓣花（樱花用粉白，小花树用白）；带少量嫩叶。
 * tone：'sakura' | 'white'
 */
export function blossomCard(tone: 'sakura' | 'white', seed: number): THREE.Texture {
  return cached(`blossom:${tone}:${seed}`, () => {
    const size = 256;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d')!;
    const r = rng(seed);
    const col =
      tone === 'sakura'
        ? { petal: 'rgb(250,226,232)', edge: 'rgb(244,196,210)', heart: 'rgb(214,120,150)' }
        : { petal: 'rgb(252,250,244)', edge: 'rgb(236,234,226)', heart: 'rgb(226,200,120)' };
    // 细枝
    g.strokeStyle = 'rgb(70,52,46)';
    g.lineCap = 'round';
    const twigs: [number, number, number, number][] = [];
    for (let t = 0; t < 3; t++) {
      const x0 = size * (0.35 + r() * 0.3);
      const a = -Math.PI / 2 + (r() - 0.5) * 1.2;
      const len = size * (0.55 + r() * 0.35);
      g.lineWidth = 3 - t * 0.6;
      g.beginPath();
      g.moveTo(x0, size);
      g.lineTo(x0 + Math.cos(a) * len, size + Math.sin(a) * len);
      g.stroke();
      twigs.push([x0, size, a, len]);
    }
    // 嫩叶（少）
    for (let i = 0; i < 5; i++) {
      const [x0, y0, a, len] = twigs[i % twigs.length];
      const s = 0.3 + r() * 0.6;
      g.save();
      g.translate(x0 + Math.cos(a) * len * s, y0 + Math.sin(a) * len * s);
      g.rotate(a + (r() - 0.5) * 2);
      g.fillStyle = tone === 'sakura' ? 'rgb(150,140,90)' : 'rgb(120,150,80)';
      g.beginPath();
      g.ellipse(10, 0, 12, 5, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
    // 花：沿枝成簇
    for (let i = 0; i < 26; i++) {
      const [x0, y0, a, len] = twigs[i % twigs.length];
      const s = 0.25 + r() * 0.75;
      const x = x0 + Math.cos(a) * len * s + (r() - 0.5) * 34;
      const y = y0 + Math.sin(a) * len * s + (r() - 0.5) * 34;
      drawBlossom(g, x, y, 15 + r() * 9, r() * 6.28, col.petal, col.heart, col.edge);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  });
}

/** 绣球花头：满铺四瓣小花（白～浅蓝～蓝紫由实例颜色决定，这里是白底带阴影） */
export function hydrangeaMaps(): MaterialMaps {
  const k = 'hydrangea';
  if (cache.has(k)) return { map: cache.get(k)!, normalMap: cache.get(`${k}:n`)! };
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgb(205,205,210)';
  g.fillRect(0, 0, size, size);
  const hc = document.createElement('canvas');
  hc.width = hc.height = size;
  const hg = hc.getContext('2d')!;
  hg.fillStyle = '#000';
  hg.fillRect(0, 0, size, size);
  const r = rng(31);
  for (let i = 0; i < 260; i++) {
    const x = r() * size;
    const y = r() * size;
    const rad = 7 + r() * 5;
    const rot = r() * 6.28;
    const shade = 0.8 + r() * 0.2;
    for (const [dx, dy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size]]) {
      for (let p = 0; p < 4; p++) {
        const a = rot + (p / 4) * Math.PI * 2;
        const px = x + dx + Math.cos(a) * rad * 0.5;
        const py = y + dy + Math.sin(a) * rad * 0.5;
        g.fillStyle = `rgb(${clamp255(255 * shade)},${clamp255(255 * shade)},${clamp255(252 * shade)})`;
        g.beginPath();
        g.ellipse(px, py, rad * 0.45, rad * 0.38, a, 0, Math.PI * 2);
        g.fill();
        hg.fillStyle = '#fff';
        hg.beginPath();
        hg.ellipse(px, py, rad * 0.45, rad * 0.38, a, 0, Math.PI * 2);
        hg.fill();
      }
    }
  }
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  const img = hg.getImageData(0, 0, size, size).data;
  const h = new Float32Array(size * size);
  for (let i = 0; i < h.length; i++) h[i] = img[i * 4] / 255;
  const normalMap = normalFromHeight(h, size, 2.5);
  cache.set(k, map);
  cache.set(`${k}:n`, normalMap);
  return { map, normalMap };
}

/** 宽叶卡片（绣球的叶子）：几片对生的卵形大叶，叶脉明显 */
export function broadLeafCard(): THREE.Texture {
  return cached('broad-leaf', () => {
    const size = 128;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d')!;
    const r = rng(41);
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + (i - 2) * 0.55 + (r() - 0.5) * 0.2;
      const len = size * (0.36 + r() * 0.1);
      g.save();
      g.translate(size / 2, size * 0.95);
      g.rotate(a + Math.PI / 2);
      const k = 0.8 + r() * 0.3;
      g.fillStyle = `rgb(${clamp255(70 * k)},${clamp255(110 * k)},${clamp255(56 * k)})`;
      g.beginPath();
      g.ellipse(0, -len * 0.55, len * 0.32, len * 0.55, 0, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(190,220,160,0.35)';
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(0, -len * 1.05);
      g.stroke();
      g.restore();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

/** 雏菊卡片：一小丛白色小雏菊（黄心），平铺在地上用 */
export function daisyCard(): THREE.Texture {
  return cached('daisy', () => {
    const size = 128;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d')!;
    const r = rng(53);
    // 底下几片细叶
    for (let i = 0; i < 10; i++) {
      g.save();
      g.translate(size / 2 + (r() - 0.5) * 50, size / 2 + (r() - 0.5) * 50);
      g.rotate(r() * 6.28);
      g.fillStyle = `rgb(${70 + r() * 20},${105 + r() * 20},${55})`;
      g.beginPath();
      g.ellipse(0, 0, 14, 4, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
    for (let i = 0; i < 7; i++) {
      const x = size / 2 + (r() - 0.5) * 80;
      const y = size / 2 + (r() - 0.5) * 80;
      const rad = 9 + r() * 5;
      for (let p = 0; p < 14; p++) {
        const a = (p / 14) * Math.PI * 2;
        g.save();
        g.translate(x + Math.cos(a) * rad * 0.55, y + Math.sin(a) * rad * 0.55);
        g.rotate(a);
        g.fillStyle = p % 2 ? 'rgb(250,250,246)' : 'rgb(238,238,232)';
        g.beginPath();
        g.ellipse(0, 0, rad * 0.5, rad * 0.13, 0, 0, Math.PI * 2);
        g.fill();
        g.restore();
      }
      g.fillStyle = 'rgb(232,190,60)';
      g.beginPath();
      g.arc(x, y, rad * 0.24, 0, Math.PI * 2);
      g.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

/** 芦苇草（蒲苇）花穗卡片：一根细茎顶着蓬松的羽毛状花穗 */
export function plumeCard(): THREE.Texture {
  return cached('plume', () => {
    const W = 64;
    const H = 256;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d')!;
    const r = rng(67);
    g.strokeStyle = 'rgb(150,140,110)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(W / 2, H);
    g.lineTo(W / 2, H * 0.35);
    g.stroke();
    // 花穗：上窄下宽的一团细丝
    for (let i = 0; i < 900; i++) {
      const t = r();
      const y = H * (0.02 + t * 0.42);
      const spread = Math.sin(Math.min(1, t * 1.25) * Math.PI * 0.9) * W * 0.36;
      const x = W / 2 + (r() - 0.5) * 2 * spread;
      const len = 6 + r() * 10;
      const k = 0.85 + r() * 0.15;
      g.strokeStyle = `rgba(${clamp255(246 * k)},${clamp255(236 * k)},${clamp255(222 * k)},0.7)`;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + (x - W / 2) * 0.15, y + len);
      g.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

/** 竹叶卡片：一小枝上几片细长披针形竹叶 */
export function bambooLeafCard(): THREE.Texture {
  return cached('bamboo-leaf', () => {
    const size = 128;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d')!;
    const r = rng(71);
    g.strokeStyle = 'rgb(110,120,70)';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(size * 0.1, size * 0.9);
    g.lineTo(size * 0.85, size * 0.2);
    g.stroke();
    for (let i = 0; i < 9; i++) {
      const s = 0.15 + (i / 9) * 0.8;
      const x = size * (0.1 + 0.75 * s);
      const y = size * (0.9 - 0.7 * s);
      const a = (i % 2 ? 1 : -1) * (0.6 + r() * 0.5) - 0.8;
      const len = 26 + r() * 16;
      const k = 0.8 + r() * 0.35;
      g.save();
      g.translate(x, y);
      g.rotate(a);
      g.fillStyle = `rgb(${clamp255(92 * k)},${clamp255(128 * k)},${clamp255(60 * k)})`;
      g.beginPath();
      g.moveTo(0, 0);
      g.quadraticCurveTo(len * 0.5, -len * 0.12, len, 0);
      g.quadraticCurveTo(len * 0.5, len * 0.12, 0, 0);
      g.fill();
      g.restore();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}
