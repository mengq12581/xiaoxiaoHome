// 角色贴图（canvas 程序绘制）：脸（睁 / 半闭 / 闭三张，用于眨眼）、头发丝理、裙面印花、T 恤印花。
//
// 脸贴在 SphereGeometry 上：u = phi / 2π，phi = π/2 对应 +Z（正面）→ 画布 x = 0.25W；
// v 方向画布 y = θ/π · H（θ 从头顶 0 到下巴 π）。2048×1024、头半径 0.205 米 → 约 1590 px/米。
// 所有尺寸先按「米」写，再用 setTransform 换算成像素，改头的大小不用改画法。

import * as THREE from 'three';
import type { EyeState } from './rig';

export interface FaceStyle {
  skin: string;
  iris: string;
  blush: string;
  brow: string;
  /** 'girl'：上睫毛粗、外眼角一小撇；'boy'：细眼线 */
  kind: 'girl' | 'boy';
  /** 头半径（米），用于像素换算 */
  headRadius: number;
}

const FW = 2048;
const FH = 1024;

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function toTexture(c: HTMLCanvasElement) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function mix(a: string, b: string, k: number): string {
  return `#${new THREE.Color(a).lerp(new THREE.Color(b), k).getHexString()}`;
}

function rgba(hex: string, a: number): string {
  const c = new THREE.Color(hex);
  return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;
}

/** 在「米」坐标系里画：原点在脸中心线、眼睛高度 */
function drawFace(g: CanvasRenderingContext2D, st: FaceStyle, eyes: EyeState) {
  const px = FW / (2 * Math.PI * st.headRadius);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = st.skin;
  g.fillRect(0, 0, FW, FH);
  g.setTransform(px, 0, 0, px, FW * 0.25, FH * 0.565);
  g.lineCap = 'round';
  g.lineJoin = 'round';

  const girl = st.kind === 'girl';
  const dx = girl ? 0.072 : 0.07;

  // 腮红：两团柔和椭圆
  for (const s of [-1, 1]) {
    const bx = s * 0.087;
    const by = 0.041;
    const grad = g.createRadialGradient(bx, by, 0, bx, by, 0.03);
    grad.addColorStop(0, rgba(st.blush, girl ? 0.7 : 0.45));
    grad.addColorStop(0.6, rgba(st.blush, girl ? 0.35 : 0.2));
    grad.addColorStop(1, rgba(st.blush, 0));
    g.save();
    g.scale(1, 0.62);
    g.fillStyle = grad;
    g.beginPath();
    g.arc(bx, by / 0.62, 0.032, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }

  for (const s of [-1, 1]) {
    const ex = s * dx;
    // 眉毛：细、柔、略弯（在刘海下沿与眼睛之间）
    g.strokeStyle = rgba(st.brow, 0.9);
    g.lineWidth = girl ? 0.0032 : 0.0038;
    g.beginPath();
    g.moveTo(ex - s * 0.019, -0.047);
    g.quadraticCurveTo(ex + s * 0.002, -0.059, ex + s * 0.025, -0.05);
    g.stroke();

    if (eyes === 2) {
      drawClosedEye(g, ex, s, girl);
      continue;
    }
    drawOpenEye(g, st, ex, s, girl);
    if (eyes === 1) {
      // 半闭：上眼睑皮肤盖住上半，睫毛线落在眼睛中部
      g.fillStyle = st.skin;
      g.beginPath();
      g.moveTo(ex - s * 0.034, -0.048);
      g.lineTo(ex + s * 0.038, -0.048);
      g.lineTo(ex + s * 0.036, -0.004);
      g.quadraticCurveTo(ex, 0.006, ex - s * 0.032, -0.002);
      g.closePath();
      g.fill();
      g.strokeStyle = '#24160f';
      g.lineWidth = girl ? 0.0052 : 0.0035;
      g.beginPath();
      g.moveTo(ex - s * 0.028, -0.002);
      g.quadraticCurveTo(ex, 0.007, ex + s * 0.031, -0.004);
      g.stroke();
    }
  }

  // 鼻子：一个小小的柔点
  g.fillStyle = mix(st.skin, '#b0705a', 0.35);
  g.beginPath();
  g.ellipse(0, 0.037, 0.0034, 0.0026, 0, 0, Math.PI * 2);
  g.fill();

  // 嘴：闭口微笑
  g.strokeStyle = '#9b5144';
  g.lineWidth = 0.0034;
  g.beginPath();
  g.moveTo(-0.013, 0.055);
  g.quadraticCurveTo(0, 0.0655, 0.013, 0.055);
  g.stroke();
  g.setTransform(1, 0, 0, 1, 0, 0);
}

function drawOpenEye(g: CanvasRenderingContext2D, st: FaceStyle, ex: number, s: number, girl: boolean) {
  const rx = girl ? 0.024 : 0.019;
  const ry = girl ? 0.029 : 0.022;
  const cy = 0.002;
  // 眼白：只在虹膜两侧露一点
  g.fillStyle = '#fffaf5';
  g.beginPath();
  g.ellipse(ex, cy, rx * 1.16, ry * 1.0, 0, 0, Math.PI * 2);
  g.fill();

  g.save();
  g.beginPath();
  g.ellipse(ex, cy, rx, ry, 0, 0, Math.PI * 2);
  g.clip();
  // 虹膜：上深下浅
  const ig = g.createLinearGradient(ex, cy - ry, ex, cy + ry);
  ig.addColorStop(0, mix(st.iris, '#140b07', 0.65));
  ig.addColorStop(0.38, mix(st.iris, '#140b07', 0.3));
  ig.addColorStop(0.72, st.iris);
  ig.addColorStop(1, mix(st.iris, '#e0a874', 0.45));
  g.fillStyle = ig;
  g.fillRect(ex - rx, cy - ry, rx * 2, ry * 2);
  // 下缘反光：一弯浅色
  g.fillStyle = rgba(mix(st.iris, '#f2c28d', 0.65), 0.8);
  g.beginPath();
  g.ellipse(ex, cy + ry * 0.78, rx * 0.66, ry * 0.3, 0, 0, Math.PI * 2);
  g.fill();
  // 瞳孔
  g.fillStyle = '#110906';
  g.beginPath();
  g.ellipse(ex, cy + ry * 0.04, rx * 0.44, ry * 0.46, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();
  // 虹膜外圈
  g.strokeStyle = rgba('#2a170e', 0.85);
  g.lineWidth = 0.0013;
  g.beginPath();
  g.ellipse(ex, cy, rx, ry, 0, 0, Math.PI * 2);
  g.stroke();

  // 高光：左上大、右下小（两只眼方向一致）
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.ellipse(ex - rx * 0.36, cy - ry * 0.38, rx * 0.31, ry * 0.27, -0.3, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.arc(ex + rx * 0.38, cy + ry * 0.36, rx * 0.15, 0, Math.PI * 2);
  g.fill();

  // 上睫毛线（粗、自然弧度，外眼角一小撇，不上挑）
  g.strokeStyle = '#22150e';
  g.lineWidth = girl ? 0.0056 : 0.0034;
  g.beginPath();
  g.moveTo(ex - s * rx * 1.12, cy - ry * 0.3);
  g.quadraticCurveTo(ex - s * rx * 0.2, cy - ry * 1.42, ex + s * rx * 1.2, cy - ry * 0.48);
  g.stroke();
  if (girl) {
    g.lineWidth = 0.003;
    g.beginPath();
    g.moveTo(ex + s * rx * 1.18, cy - ry * 0.5);
    g.lineTo(ex + s * rx * 1.5, cy - ry * 0.62);
    g.stroke();
  }
  // 下眼线：细、淡、短
  g.strokeStyle = rgba('#5a3a2c', 0.5);
  g.lineWidth = 0.0016;
  g.beginPath();
  g.moveTo(ex - s * rx * 0.55, cy + ry * 1.02);
  g.quadraticCurveTo(ex + s * rx * 0.2, cy + ry * 1.12, ex + s * rx * 0.85, cy + ry * 0.86);
  g.stroke();
}

function drawClosedEye(g: CanvasRenderingContext2D, ex: number, s: number, girl: boolean) {
  g.strokeStyle = '#22150e';
  g.lineWidth = girl ? 0.0052 : 0.0035;
  g.beginPath();
  g.moveTo(ex - s * 0.027, 0.0);
  g.quadraticCurveTo(ex, 0.012, ex + s * 0.03, -0.003);
  g.stroke();
  if (girl) {
    g.lineWidth = 0.0025;
    for (const k of [0.25, 0.6]) {
      const x = ex + s * (-0.027 + k * 0.057);
      g.beginPath();
      g.moveTo(x, 0.006);
      g.lineTo(x + s * 0.002, 0.011);
      g.stroke();
    }
  }
}

export interface FaceTextures {
  open: THREE.CanvasTexture;
  half: THREE.CanvasTexture;
  closed: THREE.CanvasTexture;
}

export function faceTextures(style: FaceStyle): FaceTextures {
  const make = (e: EyeState) => {
    const c = canvas(FW, FH);
    drawFace(c.getContext('2d')!, style, e);
    return toTexture(c);
  };
  return { open: make(0), half: make(1), closed: make(2) };
}

/** 头发丝理：沿 v 方向（从发根到发梢）的细纹 + 头顶一圈柔光，哑光 */
export function hairTexture(base: string, seed = 1): THREE.CanvasTexture {
  const c = canvas(512, 512);
  const g = c.getContext('2d')!;
  g.fillStyle = base;
  g.fillRect(0, 0, 512, 512);
  let a = seed * 9301 + 49297;
  const rnd = () => ((a = (a * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < 260; i++) {
    const x = rnd() * 512;
    const light = rnd() > 0.5;
    g.strokeStyle = light ? rgba(mix(base, '#6a6070', 0.5), 0.22) : rgba('#000000', 0.25);
    g.lineWidth = 0.6 + rnd() * 1.6;
    g.beginPath();
    g.moveTo(x, 0);
    g.bezierCurveTo(x + (rnd() - 0.5) * 10, 170, x + (rnd() - 0.5) * 14, 340, x + (rnd() - 0.5) * 18, 512);
    g.stroke();
  }
  // 头顶柔光带（「天使环」，哑光、很淡）
  const band = g.createLinearGradient(0, 70, 0, 170);
  band.addColorStop(0, rgba('#9a90a8', 0));
  band.addColorStop(0.5, rgba('#9a90a8', 0.22));
  band.addColorStop(1, rgba('#9a90a8', 0));
  g.fillStyle = band;
  g.fillRect(0, 70, 512, 100);
  const t = toTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

/** 月牙路径：外圆 (0,0,R) 减去内圆 (dx,dy,r)，用两段圆弧（多边形采样）围成 */
function crescent(g: CanvasRenderingContext2D, R: number, dx: number, dy: number, r: number) {
  const d = Math.hypot(dx, dy);
  const a = (R * R - r * r + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, R * R - a * a));
  const bx = (a / d) * dx;
  const by = (a / d) * dy;
  const p1 = [bx - (h * dy) / d, by + (h * dx) / d];
  const p2 = [bx + (h * dy) / d, by - (h * dx) / d];
  const away = Math.atan2(-dy, -dx); // 外弧经过背离内圆的一侧
  const norm = (x: number) => Math.atan2(Math.sin(x), Math.cos(x));
  const t1 = Math.atan2(p1[1], p1[0]);
  const t2 = Math.atan2(p2[1], p2[0]);
  // 从 t1 走到 t2，方向选经过 away 的那一边
  let span = norm(t2 - t1);
  const mid = t1 + span / 2;
  if (Math.cos(mid - away) < 0) span = span > 0 ? span - Math.PI * 2 : span + Math.PI * 2;
  g.beginPath();
  const N = 48;
  for (let i = 0; i <= N; i++) {
    const t = t1 + (span * i) / N;
    const x = R * Math.cos(t);
    const y = R * Math.sin(t);
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  // 内弧：从 p2 回到 p1，走在外圆里面的那一边
  const f2 = Math.atan2(p2[1] - dy, p2[0] - dx);
  const f1 = Math.atan2(p1[1] - dy, p1[0] - dx);
  let span2 = norm(f1 - f2);
  const m2 = f2 + span2 / 2;
  if (Math.hypot(dx + r * Math.cos(m2), dy + r * Math.sin(m2)) > R) span2 = span2 > 0 ? span2 - Math.PI * 2 : span2 + Math.PI * 2;
  for (let i = 1; i <= N; i++) {
    const t = f2 + (span2 * i) / N;
    g.lineTo(dx + r * Math.cos(t), dy + r * Math.sin(t));
  }
  g.closePath();
}

function star(g: CanvasRenderingContext2D, x: number, y: number, r: number) {
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 === 0 ? r : r * 0.46;
    const ang = -Math.PI / 2 + (i * Math.PI) / 5;
    const px = x + rr * Math.cos(ang);
    const py = y + rr * Math.sin(ang);
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  g.closePath();
}

export interface PrintMapping {
  /** 印花处一圈的周长（米） */
  circumference: number;
  /** 车削轮廓总弧长（米），对应画布高度 */
  length: number;
  /** 印花中心距轮廓顶端（领口）的弧长（米） */
  fromTop: number;
}

/**
 * 连衣裙：车削体（phiStart = π），正面在画布正中；画布顶边 = 领口，按弧长等比。
 * 胸口一弯浅黄月牙（开口朝右上）+ 右上、左下各一颗小星星，按米绘制，不变形。
 */
export function dressTexture(dress: string, print: string, map: PrintMapping): THREE.CanvasTexture {
  const W = 2048;
  const H = 1024;
  const c = canvas(W, H);
  const g = c.getContext('2d')!;
  g.fillStyle = dress;
  g.fillRect(0, 0, W, H);
  const pu = W / map.circumference;
  const pv = H / map.length;
  // 领口滚边、下摆缝线（米 → 像素）
  g.fillStyle = mix(dress, '#c9b8a2', 0.35);
  g.fillRect(0, 0, W, 0.008 * pv);
  g.fillRect(0, H - 0.014 * pv, W, 0.003 * pv);

  g.setTransform(pu, 0, 0, pv, W / 2, map.fromTop * pv);
  const edge = mix(print, '#a8752e', 0.45);
  // 月牙：外圆减去偏右上的内圆，开口朝右上
  g.save();
  g.translate(0.006, 0.002);
  crescent(g, 0.031, 0.013, -0.009, 0.026);
  g.fillStyle = print;
  g.fill();
  g.lineWidth = 0.0013;
  g.strokeStyle = edge;
  g.stroke();
  g.restore();
  // 两颗星
  for (const [x, y, r] of [
    [0.05, -0.03, 0.011],
    [-0.034, 0.033, 0.0095],
  ]) {
    star(g, x, y, r);
    g.fillStyle = print;
    g.fill();
    g.lineWidth = 0.001;
    g.strokeStyle = edge;
    g.stroke();
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  return toTexture(c);
}
