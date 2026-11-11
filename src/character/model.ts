// Q 版角色模型（程序化几何体拼装），形象依据 assets/xiaoxiao_q_turnaround.jpg：
// 三头身、黑长直、发梢微内扣、齐刘海、正面看左侧浅奶白音符发卡、奶白居家短裙（胸口浅黄月牙 + 两颗星）、
// 光脚；眼睛圆润、深棕瞳仁 + 黑瞳孔 + 白高光。
//
// 尺寸单位：米（1.2 米参考身高），局部 +Z 为正面。

import * as THREE from 'three';
import type { CharacterSpec } from '../config/types';
import { createBareRig, type CharacterRig } from './rig';
import { dressTexture, faceTexture, shirtTexture } from './textures';

const HEAD_R = 0.205;
const HEAD_CENTER_Y = 0.2; // 相对 head 枢轴（脖子顶）

function lambert(color: string | number, opts: THREE.MeshLambertMaterialParameters = {}) {
  return new THREE.MeshLambertMaterial({ color, ...opts });
}

function add(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

function color(spec: CharacterSpec, key: string, fallback: string) {
  return spec.palette[key] ?? fallback;
}

/** 脸 + 耳朵 */
function buildHead(rig: CharacterRig, spec: CharacterSpec, kind: 'girl' | 'boy') {
  const skin = color(spec, 'skin', '#f8e1d4');
  const face = faceTexture({
    skin,
    iris: color(spec, 'eye_iris', kind === 'girl' ? '#6b4025' : '#3b2a20'),
    blush: color(spec, 'blush', '#f2b8b0'),
    kind,
  });
  const head = add(rig.head, new THREE.SphereGeometry(HEAD_R, 48, 32), lambert('#ffffff', { map: face }), 0, HEAD_CENTER_Y, 0);
  head.scale.set(1, 0.97, 1);
  head.name = 'face';
  const skinMat = lambert(skin);
  for (const s of [-1, 1]) {
    const ear = add(rig.head, new THREE.SphereGeometry(0.034, 16, 12), skinMat, s * 0.208, HEAD_CENTER_Y - 0.012, -0.005);
    ear.scale.set(0.55, 1, 0.8);
  }
  // 脖子
  add(rig.torso, new THREE.CylinderGeometry(0.036, 0.04, 0.08, 16), skinMat, 0, 0.395, 0);
}

/** 黑长直 + 齐刘海 + 侧发 + 音符发卡 */
function buildLongHair(rig: CharacterRig, spec: CharacterSpec) {
  const hairMat = lambert(color(spec, 'hair', '#17161b'), { side: THREE.DoubleSide });
  const cy = HEAD_CENTER_Y;
  // 头顶 + 后脑 + 两侧（正面 ±0.9 弧度留给脸）
  add(rig.head, new THREE.SphereGeometry(0.218, 48, 24, Math.PI / 2 + 0.9, Math.PI * 2 - 1.8, 0, Math.PI * 0.64), hairMat, 0, cy, 0);
  // 齐刘海：正面一块，下沿平齐、在眼睛上方
  add(rig.head, new THREE.SphereGeometry(0.215, 32, 16, Math.PI / 2 - 0.98, 1.96, 0, Math.PI * 0.43), hairMat, 0, cy, 0);
  // 后面的长发：从头部中线垂到腰，发梢略往里收
  const back = add(
    rig.head,
    new THREE.CylinderGeometry(0.218, 0.2, 0.46, 40, 1, true, 1.75, Math.PI * 2 - 3.5),
    hairMat,
    0,
    cy - 0.23,
    0,
  );
  back.name = 'hair_back';
  add(rig.head, new THREE.CylinderGeometry(0.2, 0.165, 0.035, 40, 1, true, 1.75, Math.PI * 2 - 3.5), hairMat, 0, cy - 0.477, 0);
  // 两侧垂在肩前的发束
  for (const s of [-1, 1]) {
    const lock = add(rig.head, new THREE.CapsuleGeometry(0.042, 0.22, 6, 12), hairMat, s * 0.175, cy - 0.1, 0.03);
    lock.scale.set(1, 1, 0.5);
    lock.rotation.z = s * 0.05;
  }

  // 音符发卡：正面看在左侧（角色自己的右侧，即 -X）
  const clipMat = lambert(color(spec, 'hair_clip', '#f7f0e3'));
  const clip = new THREE.Group();
  const phi = Math.PI / 2 - 0.82;
  const theta = Math.PI * 0.33;
  const dir = new THREE.Vector3(-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta));
  clip.position.copy(dir.clone().multiplyScalar(0.222)).add(new THREE.Vector3(0, cy, 0));
  clip.scale.setScalar(1.35);
  clip.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
  const noteHead = add(clip, new THREE.SphereGeometry(0.022, 16, 12), clipMat, 0, -0.012, 0.006);
  noteHead.scale.set(1.3, 0.95, 0.55);
  noteHead.rotation.z = 0.35;
  add(clip, new THREE.BoxGeometry(0.009, 0.072, 0.012), clipMat, 0.024, 0.024, 0.006);
  const flag = add(clip, new THREE.BoxGeometry(0.034, 0.012, 0.012), clipMat, 0.038, 0.054, 0.006);
  flag.rotation.z = -0.55;
  clip.name = 'hair_clip';
  rig.head.add(clip);
}

/** 短发 + 圆框眼镜（帅帅占位） */
function buildShortHair(rig: CharacterRig, spec: CharacterSpec) {
  const hairMat = lambert(color(spec, 'hair', '#1a1a1e'), { side: THREE.DoubleSide });
  const cy = HEAD_CENTER_Y;
  add(rig.head, new THREE.SphereGeometry(0.222, 40, 20, Math.PI / 2 + 0.95, Math.PI * 2 - 1.9, 0, Math.PI * 0.6), hairMat, 0, cy, 0);
  add(rig.head, new THREE.SphereGeometry(0.227, 32, 12, Math.PI / 2 - 1.0, 2.0, 0, Math.PI * 0.42), hairMat, 0, cy, 0);
  const glassMat = lambert(color(spec, 'glasses', '#3a3a40'));
  const eyeY = cy + HEAD_R * Math.cos(Math.PI * 0.56);
  for (const s of [-1, 1]) {
    add(rig.head, new THREE.TorusGeometry(0.036, 0.0055, 8, 24), glassMat, s * 0.07, eyeY, 0.198);
  }
  add(rig.head, new THREE.BoxGeometry(0.03, 0.006, 0.006), glassMat, 0, eyeY + 0.008, 0.205);
}

/** 连衣裙 + 泡泡袖 + 手臂 + 光脚 */
function buildDressBody(rig: CharacterRig, spec: CharacterSpec) {
  const skinMat = lambert(color(spec, 'skin', '#f8e1d4'));
  const dressColor = color(spec, 'dress', '#f3eadf');
  const dressMat = lambert('#ffffff', { map: dressTexture(dressColor, color(spec, 'dress_print', '#f2d58a')) });
  const plainDress = lambert(dressColor);
  // A 字裙：胯下 0.05 到领口 0.37（相对胯部）
  const dress = add(rig.torso, new THREE.CylinderGeometry(0.105, 0.205, 0.42, 40, 1, false, Math.PI, Math.PI * 2), [dressMat, plainDress, plainDress], 0, 0.16, 0);
  dress.name = 'dress';
  // 圆领
  const collar = add(rig.torso, new THREE.TorusGeometry(0.066, 0.009, 8, 32), plainDress, 0, 0.37, 0);
  collar.rotation.x = Math.PI / 2;
  // 泡泡袖
  for (const arm of [rig.armL, rig.armR]) {
    const s = arm === rig.armL ? 1 : -1;
    const sleeve = add(rig.torso, new THREE.SphereGeometry(0.056, 20, 14), plainDress, s * 0.112, 0.31, 0);
    sleeve.scale.set(1, 0.85, 1);
    add(arm, new THREE.CapsuleGeometry(0.03, 0.12, 6, 12), skinMat, 0, -0.1, 0);
    add(arm, new THREE.SphereGeometry(0.035, 16, 12), skinMat, 0, -0.19, 0.005);
    arm.rotation.z = s * 0.24;
  }
  buildLegs(rig, skinMat, skinMat);
}

/** T 恤 + 短裤 + 白短袜（帅帅占位） */
function buildTeeBody(rig: CharacterRig, spec: CharacterSpec) {
  const skinMat = lambert(color(spec, 'skin', '#f6dccb'));
  const shirt = color(spec, 'shirt', '#fbfaf7');
  const shirtMat = lambert('#ffffff', { map: shirtTexture(shirt, color(spec, 'shirt_print', '#f4c56a')) });
  const plainShirt = lambert(shirt);
  add(rig.torso, new THREE.CylinderGeometry(0.115, 0.15, 0.27, 36, 1, false, Math.PI, Math.PI * 2), [shirtMat, plainShirt, plainShirt], 0, 0.235, 0);
  const shortsMat = lambert(color(spec, 'shorts', '#26365a'));
  add(rig.body, new THREE.CylinderGeometry(0.15, 0.155, 0.11, 32), shortsMat, 0, 0.05, 0);
  for (const arm of [rig.armL, rig.armR]) {
    const s = arm === rig.armL ? 1 : -1;
    add(rig.torso, new THREE.SphereGeometry(0.055, 18, 12), plainShirt, s * 0.115, 0.32, 0).scale.set(1, 0.85, 1);
    add(arm, new THREE.CapsuleGeometry(0.03, 0.12, 6, 12), skinMat, 0, -0.1, 0);
    add(arm, new THREE.SphereGeometry(0.035, 16, 12), skinMat, 0, -0.19, 0.005);
    arm.rotation.z = s * 0.2;
  }
  buildLegs(rig, skinMat, lambert(color(spec, 'socks', '#ffffff')));
  for (const leg of [rig.legL, rig.legR]) add(leg, new THREE.CylinderGeometry(0.06, 0.06, 0.07, 18), shortsMat, 0, -0.01, 0);
}

function buildLegs(rig: CharacterRig, skinMat: THREE.Material, footMat: THREE.Material) {
  for (const leg of [rig.legL, rig.legR]) {
    add(leg, new THREE.CapsuleGeometry(0.042, 0.15, 6, 12), skinMat, 0, -0.115, 0);
    const foot = add(leg, new THREE.SphereGeometry(0.043, 16, 12), footMat, 0, -0.222, 0.022);
    foot.scale.set(1, 0.6, 1.45);
  }
}

export function buildCharacter(spec: CharacterSpec): CharacterRig {
  const rig = createBareRig(spec.id, spec.height);
  if (spec.model_type === 'placeholder') {
    buildHead(rig, spec, 'boy');
    buildShortHair(rig, spec);
    buildTeeBody(rig, spec);
  } else {
    buildHead(rig, spec, 'girl');
    buildLongHair(rig, spec);
    buildDressBody(rig, spec);
  }
  return rig;
}
