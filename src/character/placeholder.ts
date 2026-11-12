// 帅帅占位小人（v0.1 只要求「切过去显示占位小人、不报错」）。
// 形象按 M2 首版冻结，不随笑笑的形象整改变化；v0.2 帅帅进场时再按他的三视图重做。

import * as THREE from 'three';
import { ROUGH, soft, type SoftParams } from '../scene/materials';
import type { CharacterSpec } from '../config/types';
import { createBareRig, type CharacterRig } from './rig';

const HEAD_R = 0.205;
const HEAD_CENTER_Y = 0.2;

function lambert(color: string | number, opts: SoftParams = {}) {
  return soft(color, { roughness: ROUGH.cloth, ...opts });
}

function add(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

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

function hexA(hex: string, a: number): string {
  const c = new THREE.Color(hex);
  return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;
}

/** M2 首版的简化脸（1024×512，约 795 px/米） */
function placeholderFace(skin: string, iris: string, blush: string): THREE.CanvasTexture {
  const W = 1024;
  const H = 512;
  const c = canvas(W, H);
  const g = c.getContext('2d')!;
  g.fillStyle = skin;
  g.fillRect(0, 0, W, H);
  const m = (v: number) => v * 795;
  const cx = W * 0.25;
  const eyeY = H * 0.56;
  for (const s of [-1, 1]) {
    const bx = cx + s * m(0.085);
    const by = eyeY + m(0.05);
    const grad = g.createRadialGradient(bx, by, 0, bx, by, m(0.03));
    grad.addColorStop(0, hexA(blush, 0.75));
    grad.addColorStop(1, hexA(blush, 0));
    g.fillStyle = grad;
    g.beginPath();
    g.ellipse(bx, by, m(0.032), m(0.02), 0, 0, Math.PI * 2);
    g.fill();
  }
  const rx = m(0.02);
  const ry = m(0.022);
  for (const s of [-1, 1]) {
    const ex = cx + s * m(0.074);
    g.fillStyle = '#fffaf6';
    g.beginPath();
    g.ellipse(ex, eyeY, rx * 1.08, ry, 0, 0, Math.PI * 2);
    g.fill();
    const ig = g.createLinearGradient(ex, eyeY - ry, ex, eyeY + ry);
    ig.addColorStop(0, shade(iris, 0.55));
    ig.addColorStop(0.55, iris);
    ig.addColorStop(1, shade(iris, 1.35));
    g.fillStyle = ig;
    g.beginPath();
    g.ellipse(ex, eyeY + ry * 0.04, rx * 0.92, ry * 0.96, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#1b120e';
    g.beginPath();
    g.ellipse(ex, eyeY + ry * 0.08, rx * 0.42, ry * 0.46, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.ellipse(ex - s * rx * 0.3 - rx * 0.05, eyeY - ry * 0.36, rx * 0.3, ry * 0.26, 0, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#24170f';
    g.lineCap = 'round';
    g.lineWidth = m(0.004);
    g.beginPath();
    g.ellipse(ex, eyeY + ry * 0.12, rx * 1.12, ry * 1.08, 0, Math.PI * 1.08, Math.PI * 1.92);
    g.stroke();
  }
  g.fillStyle = shade(skin, 0.78);
  g.beginPath();
  g.arc(cx, eyeY + m(0.038), m(0.0032), 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#8c4b3f';
  g.lineWidth = m(0.0035);
  g.beginPath();
  g.arc(cx, eyeY + m(0.052), m(0.014), Math.PI * 0.22, Math.PI * 0.78);
  g.stroke();
  return toTexture(c);
}

/** M2 首版 T 恤印花（圆柱贴图，正面在画布正中） */
function placeholderShirt(shirt: string, print: string): THREE.CanvasTexture {
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

export function buildPlaceholder(spec: CharacterSpec): CharacterRig {
  const rig = createBareRig(spec.id, spec.height);
  const p = (k: string, d: string) => spec.palette[k] ?? d;
  const skinMat = lambert(p('skin', '#f6dccb'), { roughness: ROUGH.skin });

  // 头
  const face = placeholderFace(p('skin', '#f6dccb'), p('eye_iris', '#3b2a20'), p('blush', '#f2b8b0'));
  const head = add(rig.head, new THREE.SphereGeometry(HEAD_R, 48, 32), lambert('#ffffff', { map: face }), 0, HEAD_CENTER_Y, 0);
  head.scale.set(1, 0.97, 1);
  for (const s of [-1, 1]) {
    const ear = add(rig.head, new THREE.SphereGeometry(0.034, 16, 12), skinMat, s * 0.208, HEAD_CENTER_Y - 0.012, -0.005);
    ear.scale.set(0.55, 1, 0.8);
  }
  add(rig.torso, new THREE.CylinderGeometry(0.036, 0.04, 0.08, 16), skinMat, 0, 0.395, 0);

  // 短发 + 圆框眼镜
  const hairMat = lambert(p('hair', '#1a1a1e'), { side: THREE.DoubleSide, roughness: ROUGH.hair, envMapIntensity: 0.45 });
  add(rig.head, new THREE.SphereGeometry(0.222, 40, 20, Math.PI / 2 + 0.95, Math.PI * 2 - 1.9, 0, Math.PI * 0.6), hairMat, 0, HEAD_CENTER_Y, 0);
  add(rig.head, new THREE.SphereGeometry(0.227, 32, 12, Math.PI / 2 - 1.0, 2.0, 0, Math.PI * 0.42), hairMat, 0, HEAD_CENTER_Y, 0);
  const glassMat = lambert(p('glasses', '#3a3a40'));
  const eyeY = HEAD_CENTER_Y + HEAD_R * Math.cos(Math.PI * 0.56);
  for (const s of [-1, 1]) add(rig.head, new THREE.TorusGeometry(0.036, 0.0055, 8, 24), glassMat, s * 0.07, eyeY, 0.198);
  add(rig.head, new THREE.BoxGeometry(0.03, 0.006, 0.006), glassMat, 0, eyeY + 0.008, 0.205);

  // T 恤 + 短裤
  const shirt = p('shirt', '#fbfaf7');
  const shirtMat = lambert('#ffffff', { map: placeholderShirt(shirt, p('shirt_print', '#f4c56a')) });
  const plainShirt = lambert(shirt);
  add(rig.torso, new THREE.CylinderGeometry(0.115, 0.15, 0.27, 36, 1, false, Math.PI, Math.PI * 2), [shirtMat, plainShirt, plainShirt], 0, 0.235, 0);
  const shortsMat = lambert(p('shorts', '#26365a'));
  add(rig.body, new THREE.CylinderGeometry(0.15, 0.155, 0.11, 32), shortsMat, 0, 0.05, 0);
  for (const arm of [rig.armL, rig.armR]) {
    const s = arm === rig.armL ? 1 : -1;
    add(rig.torso, new THREE.SphereGeometry(0.055, 18, 12), plainShirt, s * 0.115, 0.32, 0).scale.set(1, 0.85, 1);
    add(arm, new THREE.CapsuleGeometry(0.03, 0.12, 6, 12), skinMat, 0, -0.1, 0);
    add(arm, new THREE.SphereGeometry(0.035, 16, 12), skinMat, 0, -0.19, 0.005);
  }
  const sockMat = lambert(p('socks', '#ffffff'));
  for (const leg of [rig.legL, rig.legR]) {
    add(leg, new THREE.CapsuleGeometry(0.042, 0.15, 6, 12), skinMat, 0, -0.115, 0);
    const foot = add(leg, new THREE.SphereGeometry(0.043, 16, 12), sockMat, 0, -0.222, 0.022);
    foot.scale.set(1, 0.6, 1.45);
    add(leg, new THREE.CylinderGeometry(0.06, 0.06, 0.07, 18), shortsMat, 0, -0.01, 0);
  }
  return rig;
}
