// 角色贴图（canvas 程序绘制）：脸、裙面印花、T 恤印花。
//
// 脸贴在 SphereGeometry 上：u = phi / 2π，phi = π/2 对应 +Z（正面）→ 画布 x = 0.25W；
// v 方向画布 y = θ/π · H（θ 从头顶 0 到下巴 π）。1024×512 时约 163 px/弧度，头半径 0.205 米 → 约 795 px/米。

import * as THREE from 'three';

export interface FaceStyle {
  skin: string;
  iris: string;
  blush: string;
  /** 'girl'：上睫毛线 + 外眼角小翘；'boy'：圆眼、细上眼线 */
  kind: 'girl' | 'boy';
}

const W = 1024;
const H = 512;
const PX_PER_M = 795;

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function toTexture(c: HTMLCanvasElement) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function shade(hex: string, k: number): string {
  const c = new THREE.Color(hex);
  c.multiplyScalar(k);
  return `#${c.getHexString()}`;
}

export function faceTexture(style: FaceStyle): THREE.CanvasTexture {
  const c = canvas(W, H);
  const g = c.getContext('2d')!;
  g.fillStyle = style.skin;
  g.fillRect(0, 0, W, H);

  const cx = W * 0.25;
  const eyeY = H * 0.56;
  const m = (meters: number) => meters * PX_PER_M;

  // 腮红
  for (const s of [-1, 1]) {
    const bx = cx + s * m(0.085);
    const by = eyeY + m(0.05);
    const grad = g.createRadialGradient(bx, by, 0, bx, by, m(0.03));
    grad.addColorStop(0, hexA(style.blush, 0.75));
    grad.addColorStop(1, hexA(style.blush, 0));
    g.fillStyle = grad;
    g.beginPath();
    g.ellipse(bx, by, m(0.032), m(0.02), 0, 0, Math.PI * 2);
    g.fill();
  }

  // 眼睛
  const eyeDX = m(0.074);
  const rx = m(style.kind === 'girl' ? 0.029 : 0.02);
  const ry = m(style.kind === 'girl' ? 0.033 : 0.022);
  for (const s of [-1, 1]) {
    const ex = cx + s * eyeDX;
    // 眼白（只露一点）
    g.fillStyle = '#fffaf6';
    g.beginPath();
    g.ellipse(ex, eyeY, rx * 1.08, ry * 1.0, 0, 0, Math.PI * 2);
    g.fill();
    // 虹膜：上深下浅
    const ig = g.createLinearGradient(ex, eyeY - ry, ex, eyeY + ry);
    ig.addColorStop(0, shade(style.iris, 0.55));
    ig.addColorStop(0.55, style.iris);
    ig.addColorStop(1, shade(style.iris, 1.35));
    g.fillStyle = ig;
    g.beginPath();
    g.ellipse(ex, eyeY + ry * 0.04, rx * 0.92, ry * 0.96, 0, 0, Math.PI * 2);
    g.fill();
    // 瞳孔
    g.fillStyle = '#1b120e';
    g.beginPath();
    g.ellipse(ex, eyeY + ry * 0.08, rx * 0.42, ry * 0.46, 0, 0, Math.PI * 2);
    g.fill();
    // 高光：一大一小
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.ellipse(ex - s * rx * 0.3 - rx * 0.05, eyeY - ry * 0.36, rx * 0.3, ry * 0.26, 0, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.arc(ex + s * rx * 0.28, eyeY + ry * 0.38, rx * 0.13, 0, Math.PI * 2);
    g.fill();
    // 上眼线
    g.strokeStyle = '#24170f';
    g.lineCap = 'round';
    g.lineWidth = style.kind === 'girl' ? m(0.0055) : m(0.004);
    g.beginPath();
    g.ellipse(ex, eyeY + ry * 0.12, rx * 1.12, ry * 1.08, 0, Math.PI * 1.08, Math.PI * 1.92);
    g.stroke();
    if (style.kind === 'girl') {
      // 外眼角一根小睫毛（自然，不上挑）
      const ox = ex + s * rx * 1.08;
      const oy = eyeY - ry * 0.35;
      g.lineWidth = m(0.0035);
      g.beginPath();
      g.moveTo(ox, oy);
      g.lineTo(ox + s * m(0.009), oy - m(0.004));
      g.stroke();
    }
  }

  // 鼻子：一个小点
  g.fillStyle = shade(style.skin, 0.78);
  g.beginPath();
  g.arc(cx, eyeY + m(0.038), m(0.0032), 0, Math.PI * 2);
  g.fill();

  // 嘴：闭合微笑
  g.strokeStyle = '#8c4b3f';
  g.lineWidth = m(0.0035);
  g.lineCap = 'round';
  g.beginPath();
  g.arc(cx, eyeY + m(0.052), m(0.014), Math.PI * 0.22, Math.PI * 0.78);
  g.stroke();

  return toTexture(c);
}

function hexA(hex: string, a: number): string {
  const c = new THREE.Color(hex);
  return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;
}

function star(g: CanvasRenderingContext2D, x: number, y: number, r: number) {
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 === 0 ? r : r * 0.45;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const px = x + rr * Math.cos(a);
    const py = y + rr * Math.sin(a);
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  g.closePath();
  g.fill();
}

/**
 * 连衣裙：CylinderGeometry(thetaStart = π)，正面在 u = 0.5（画布正中）；画布顶边 = 领口。
 * 胸口一弯浅黄月牙 + 两颗小星星（右上、左下，按正面观看方向）。
 */
export function dressTexture(dress: string, print: string): THREE.CanvasTexture {
  const c = canvas(512, 256);
  const g = c.getContext('2d')!;
  g.fillStyle = dress;
  g.fillRect(0, 0, 512, 256);
  // 下摆一道浅缝线
  g.fillStyle = shade(dress, 0.93);
  g.fillRect(0, 246, 512, 3);

  const mx = 256 + 10;
  const my = 62;
  // 月牙：先画整圆，再用底色圆咬掉一块
  const moon = canvas(80, 80);
  const mg = moon.getContext('2d')!;
  mg.fillStyle = print;
  mg.beginPath();
  mg.arc(40, 40, 22, 0, Math.PI * 2);
  mg.fill();
  mg.globalCompositeOperation = 'destination-out';
  mg.beginPath();
  mg.arc(50, 33, 19, 0, Math.PI * 2);
  mg.fill();
  g.drawImage(moon, mx - 40, my - 40);
  // 描一圈细边，让月牙在浅色裙子上更清楚
  g.fillStyle = print;
  star(g, mx + 36, my - 22, 8);
  star(g, mx - 30, my + 24, 6.5);
  return toTexture(c);
}

/** T 恤：胸口暖黄小太阳 + 两朵白云（帅帅占位形象用） */
export function shirtTexture(shirt: string, print: string): THREE.CanvasTexture {
  const c = canvas(512, 256);
  const g = c.getContext('2d')!;
  g.fillStyle = shirt;
  g.fillRect(0, 0, 512, 256);
  const x = 256;
  const y = 92;
  g.fillStyle = print;
  g.beginPath();
  g.arc(x, y, 20, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = print;
  g.lineWidth = 4;
  g.lineCap = 'round';
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    g.beginPath();
    g.moveTo(x + Math.cos(a) * 27, y + Math.sin(a) * 27);
    g.lineTo(x + Math.cos(a) * 36, y + Math.sin(a) * 36);
    g.stroke();
  }
  g.fillStyle = '#ffffff';
  g.strokeStyle = shade(shirt, 0.8);
  g.lineWidth = 2;
  for (const [cx2, cy2] of [
    [x - 48, y + 34],
    [x + 50, y - 26],
  ]) {
    g.beginPath();
    g.arc(cx2 - 9, cy2, 9, 0, Math.PI * 2);
    g.arc(cx2 + 4, cy2 - 5, 11, 0, Math.PI * 2);
    g.arc(cx2 + 15, cy2 + 1, 8, 0, Math.PI * 2);
    g.fill();
  }
  return toTexture(c);
}
