// Q 版笑笑（程序化建模），形象依据 assets/xiaoxiao_q_turnaround.jpg：
// - 脸：贴图绘制（深棕虹膜、黑瞳孔、左上大高光 + 右下小高光 + 下缘反光、眉毛、腮红、闭口微笑），睁 / 半闭 / 闭三张贴图用于眨眼；
// - 头发分三块：刘海（齐、下沿略有发丝缺口）、两侧鬓发（沿脸侧垂到胸前、发梢内扣）、后发（头顶 + 垂到腰、发梢内扣、中间略长成 V）；
// - 音符发卡：挤出成型、有厚度，在正面看的左侧（角色自己的右侧，-X）；
// - 身体：车削出的软轮廓——圆肩、胸下收腰、A 字裙摆；四肢两端收圆、上粗下细，膝 / 肘可弯；
// - 裙面：胸前浅黄月牙 + 两颗小星星，按真实尺寸绘制。
//
// 尺寸单位：米（1.2 米参考身高），局部 +Z 为正面。帅帅的占位形象在 placeholder.ts，不受这里影响。

import * as THREE from 'three';
import { ParametricGeometry } from 'three/examples/jsm/geometries/ParametricGeometry.js';
import type { CharacterSpec } from '../config/types';
import { createBareRig, REF_SHIN, REF_THIGH, REF_UPPER_ARM, type CharacterRig, type EyeState } from './rig';
import { dressTexture, faceTextures, hairTexture } from './textures';
import { profileLength, smoothLathe, smoothstep, spherePoint, taperedTube } from './geom';
import { buildPlaceholder } from './placeholder';

const HEAD_R = 0.205;
const HEAD_CENTER_Y = 0.2; // 相对 head 枢轴（脖子顶）

function lambert(color: string | number | THREE.Color, opts: THREE.MeshLambertMaterialParameters = {}) {
  return new THREE.MeshLambertMaterial({ color, ...opts });
}

function add(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, name?: string) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  if (name) m.name = name;
  parent.add(m);
  return m;
}

// ───────── 头与脸 ─────────

function buildHead(rig: CharacterRig, spec: CharacterSpec, skinMat: THREE.Material) {
  const p = (k: string, d: string) => spec.palette[k] ?? d;
  const faces = faceTextures({
    skin: p('skin', '#f8e1d4'),
    iris: p('eye_iris', '#6b4025'),
    blush: p('blush', '#f2b8b0'),
    brow: p('brow', '#4b3529'),
    kind: 'girl',
    headRadius: HEAD_R,
  });
  const faceMat = lambert('#ffffff', { map: faces.open });
  const head = add(rig.head, new THREE.SphereGeometry(HEAD_R, 64, 40), faceMat, 0, HEAD_CENTER_Y, 0, 'face');
  head.scale.set(1, 0.97, 1);
  const byState: Record<EyeState, THREE.Texture> = { 0: faces.open, 1: faces.half, 2: faces.closed };
  rig.setEyes = (state) => {
    faceMat.map = byState[state];
  };
  for (const s of [-1, 1]) {
    const ear = add(rig.head, new THREE.SphereGeometry(0.034, 16, 12), skinMat, s * 0.208, HEAD_CENTER_Y - 0.012, -0.005);
    ear.scale.set(0.55, 1, 0.8);
  }
  add(rig.torso, new THREE.CylinderGeometry(0.034, 0.038, 0.08, 20), skinMat, 0, 0.37, 0);
}

// ───────── 头发：刘海 / 鬓发 / 后发 ─────────

function buildHair(rig: CharacterRig, spec: CharacterSpec) {
  const base = spec.palette.hair ?? '#17161b';
  const hairMat = lambert('#ffffff', { map: hairTexture(base, 3), side: THREE.DoubleSide });
  const cy = HEAD_CENTER_Y;
  const front = Math.PI / 2;

  // 后发 ①：头顶到耳际（正面 ±0.95 弧度留给脸和刘海）
  const crownGap = 0.95;
  const crown = new ParametricGeometry(
    (u, v, t) => {
      const phi = front + crownGap + u * (Math.PI * 2 - crownGap * 2);
      spherePoint(0.219, phi, v * Math.PI * 0.6, t);
    },
    56,
    20,
  );
  add(rig.head, crown, hairMat, 0, cy, 0, 'hair_back_crown');

  // 后发 ②：从后脑垂到腰，后中略长形成 V，发梢往里收
  const sideGap = 1.55;
  const back = new ParametricGeometry(
    (u, v, t) => {
      const phi = front + sideGap + u * (Math.PI * 2 - sideGap * 2);
      const backness = (1 + Math.cos(phi - Math.PI * 1.5)) / 2;
      const len = 0.43 + 0.075 * Math.pow(backness, 2);
      const r = 0.219 + 0.012 * Math.sin(Math.PI * v * 0.8) - 0.04 * smoothstep(0.78, 1, v);
      t.set(-r * Math.cos(phi), -v * len, r * Math.sin(phi));
    },
    48,
    24,
  );
  add(rig.head, back, hairMat, 0, cy, 0, 'hair_back_long');

  // 刘海：齐刘海，下沿在眉毛上方，两侧略往下收；下沿有几处细小发丝缺口
  const bangHalf = 1.02;
  const bangs = new ParametricGeometry(
    (u, v, t) => {
      const phi = front - bangHalf + u * bangHalf * 2;
      const side = Math.abs(u - 0.5) * 2;
      const notch = Math.pow(Math.abs(Math.sin(u * Math.PI * 9)), 24);
      const thetaEnd = Math.PI * (0.425 + 0.07 * Math.pow(side, 3) - 0.007 * notch);
      const r = 0.223 - 0.013 * smoothstep(0.55, 1, v);
      spherePoint(r, phi, v * thetaEnd, t);
    },
    96,
    16,
  );
  add(rig.head, bangs, hairMat, 0, cy, 0, 'hair_bangs');

  // 两侧鬓发：从太阳穴沿脸侧垂到胸前，发梢内扣
  for (const s of [-1, 1]) {
    const pts = [
      [0.165, 0.05, 0.1],
      [0.199, -0.04, 0.085],
      [0.203, -0.14, 0.066],
      [0.193, -0.24, 0.066],
      [0.177, -0.33, 0.08],
      [0.157, -0.385, 0.097],
    ].map(([x, y, z]) => new THREE.Vector3(s * x, y, z));
    const geo = taperedTube(
      pts,
      (t) => 0.038 * (0.6 + 0.4 * Math.sin(Math.min(1, t * 3) * (Math.PI / 2))) * (1 - 0.78 * smoothstep(0.68, 1, t)),
      (t) => 0.018 * (1 - 0.6 * smoothstep(0.72, 1, t)),
      48,
      14,
    );
    add(rig.head, geo, hairMat, 0, cy, 0, s < 0 ? 'hair_side_R' : 'hair_side_L');
  }

  // 音符发卡：正面看左侧（-X），在耳朵上方，有厚度
  const clipMat = lambert(spec.palette.hair_clip ?? '#f7f0e3');
  const headShape = new THREE.Shape();
  headShape.absellipse(0, 0, 0.021, 0.0155, 0, Math.PI * 2, false, -0.38);
  const stem = new THREE.Shape();
  stem.moveTo(0.0135, 0.004);
  stem.lineTo(0.0215, 0.004);
  stem.lineTo(0.0215, 0.07);
  stem.lineTo(0.0135, 0.07);
  stem.closePath();
  const flag = new THREE.Shape();
  flag.moveTo(0.0175, 0.07);
  flag.quadraticCurveTo(0.03, 0.066, 0.042, 0.05);
  flag.quadraticCurveTo(0.047, 0.04, 0.043, 0.03);
  flag.quadraticCurveTo(0.04, 0.042, 0.0215, 0.052);
  flag.closePath();
  const noteGeo = new THREE.ExtrudeGeometry([headShape, stem, flag], {
    depth: 0.007,
    bevelEnabled: true,
    bevelThickness: 0.003,
    bevelSize: 0.0022,
    bevelSegments: 3,
    curveSegments: 20,
  });
  noteGeo.center();
  const note = new THREE.Mesh(noteGeo, clipMat);
  note.castShadow = true;
  note.name = 'hair_clip';
  const dir = spherePoint(1, front - 0.92, Math.PI * 0.37).normalize();
  const xAxis = new THREE.Vector3(0, 1, 0).cross(dir).normalize();
  const yAxis = dir.clone().cross(xAxis);
  note.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, dir));
  note.rotateZ(0.22);
  note.position.copy(dir.clone().multiplyScalar(0.228)).add(new THREE.Vector3(0, cy, 0));
  note.scale.setScalar(1.25);
  rig.head.add(note);
}

// ───────── 身体：车削软轮廓 ─────────

/** 连衣裙轮廓 [半径, 高度]（相对胯部，从下摆到领口） */
const DRESS_PROFILE: [number, number][] = [
  [0.172, -0.054],
  [0.203, -0.048],
  [0.2, -0.018],
  [0.182, 0.05],
  [0.152, 0.12],
  [0.12, 0.178],
  [0.101, 0.214],
  [0.107, 0.252],
  [0.111, 0.287],
  [0.106, 0.318],
  [0.088, 0.342],
  [0.062, 0.357],
  [0.042, 0.364],
];

/** 从领口往下量到某高度的弧长 */
function arcFromTop(profile: [number, number][], y: number): number {
  const curve = new THREE.SplineCurve(profile.map(([r, yy]) => new THREE.Vector2(r, yy)));
  const pts = curve.getSpacedPoints(400);
  let len = 0;
  for (let i = pts.length - 1; i > 0; i--) {
    if (pts[i].y <= y) break;
    len += pts[i].distanceTo(pts[i - 1]);
  }
  return len;
}

function buildBody(rig: CharacterRig, spec: CharacterSpec, skinMat: THREE.Material) {
  const p = (k: string, d: string) => spec.palette[k] ?? d;
  const dressColor = p('dress', '#f3eadf');
  const chestY = 0.262;
  const dressMap = dressTexture(dressColor, p('dress_print', '#f2d58a'), {
    circumference: 2 * Math.PI * 0.109 * 0.95,
    length: profileLength(DRESS_PROFILE),
    fromTop: arcFromTop(DRESS_PROFILE, chestY),
  });
  const dress = add(rig.torso, smoothLathe(DRESS_PROFILE, 72, 56), lambert('#ffffff', { map: dressMap }), 0, 0, 0, 'dress');
  dress.scale.z = 0.9; // 胸背略扁，不是正圆柱
  const trim = lambert(new THREE.Color(dressColor).lerp(new THREE.Color('#c9b8a2'), 0.25));
  const collar = add(rig.torso, new THREE.TorusGeometry(0.045, 0.0065, 10, 40), trim, 0, 0.362, 0);
  collar.rotation.x = Math.PI / 2;
  collar.scale.y = 0.9;

  // 裙摆坐姿形变：腰线以下的裙子往前铺在大腿上、变短，好让膝盖和小腿露出来
  addSeatedSkirtMorph(dress.geometry as THREE.BufferGeometry);
  dress.updateMorphTargets();
  rig.setSitBlend = (k) => {
    dress.morphTargetInfluences![0] = k;
  };

  const sleeveMat = lambert(dressColor);
  const limbs: { mesh: THREE.SkinnedMesh; bones: THREE.Bone[] }[] = [];
  for (const [arm, fore, s] of [
    [rig.armL, rig.foreL, 1],
    [rig.armR, rig.foreR, -1],
  ] as const) {
    // 泡泡袖（随肩转动）
    const sleeve = add(arm, smoothLathe([[0.001, -0.06], [0.048, -0.052], [0.058, -0.025], [0.05, 0.008], [0.001, 0.02]], 24, 28), sleeveMat);
    sleeve.scale.z = 0.92;
    // 整条手臂一张蒙皮网格：上粗下细、肘部平滑弯曲
    limbs.push(
      skinnedLimb(rig.torso, arm, fore, -REF_UPPER_ARM, skinMat, [
        [0.001, -0.163],
        [0.02, -0.156],
        [0.023, -0.13],
        [0.025, -0.097],
        [0.026, -0.075],
        [0.027, -0.05],
        [0.029, -0.015],
        [0.001, 0.008],
      ]),
    );
    // 手：圆润的手掌 + 拇指
    const hand = add(fore, new THREE.SphereGeometry(0.029, 20, 16), skinMat, 0, -0.088, 0.002);
    hand.scale.set(0.9, 1.15, 0.72);
    add(fore, new THREE.SphereGeometry(0.011, 12, 10), skinMat, -s * 0.017, -0.08, 0.012);
  }

  for (const [leg, shin] of [
    [rig.legL, rig.shinL],
    [rig.legR, rig.shinR],
  ] as const) {
    // 整条腿一张蒙皮网格：大腿到脚踝连续，膝部平滑弯曲
    limbs.push(
      skinnedLimb(rig.body, leg, shin, -REF_THIGH, skinMat, [
        [0.001, -REF_THIGH - REF_SHIN - 0.008],
        [0.026, -REF_THIGH - REF_SHIN],
        [0.029, -0.19],
        [0.032, -0.15],
        [0.036, -0.115],
        [0.039, -0.09],
        [0.042, -0.06],
        [0.046, -0.02],
        [0.001, 0.012],
      ]),
    );
    // 光脚：圆润的脚掌
    const foot = add(shin, new THREE.CapsuleGeometry(0.026, 0.04, 8, 16), skinMat, 0, -REF_SHIN - 0.004, 0.021);
    foot.rotation.x = Math.PI / 2;
    foot.scale.set(1.12, 1, 0.7);
  }

  // 蒙皮绑定：在静止姿势下算骨骼逆矩阵
  rig.root.updateMatrixWorld(true);
  for (const l of limbs) l.mesh.bind(new THREE.Skeleton(l.bones));
}

/**
 * 两段骨骼的蒙皮肢体：几何体在上段骨骼的局部空间里（关节在 jointY），
 * 关节上下 2 厘米内两段骨骼权重平滑过渡，弯曲时表面连续、没有「娃娃关节」。
 */
function skinnedLimb(
  parent: THREE.Object3D,
  upper: THREE.Bone,
  lower: THREE.Bone,
  jointY: number,
  mat: THREE.Material,
  profile: [number, number][],
): { mesh: THREE.SkinnedMesh; bones: THREE.Bone[] } {
  const geo = smoothLathe(profile, 72, 22);
  const pos = geo.getAttribute('position');
  const idx = new Uint16Array(pos.count * 4);
  const wts = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    const w = smoothstep(jointY + 0.02, jointY - 0.02, pos.getY(i));
    idx[i * 4] = 0;
    idx[i * 4 + 1] = 1;
    wts[i * 4] = 1 - w;
    wts[i * 4 + 1] = w;
  }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wts, 4));
  const mesh = new THREE.SkinnedMesh(geo, mat);
  mesh.position.copy(upper.position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  parent.add(mesh);
  return { mesh, bones: [upper, lower] };
}

/** 给连衣裙加一个「坐下」形变目标（位置 + 法线） */
function addSeatedSkirtMorph(geo: THREE.BufferGeometry) {
  const WAIST = 0.2;
  const SPAN = 0.254;
  const pos = geo.getAttribute('position');
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (y >= WAIST) {
      out.set([x, y, z], i * 3);
      continue;
    }
    const f = Math.min(1, (WAIST - y) / SPAN);
    const a = Math.atan2(x, z); // 0 = 正前
    const front = (1 + Math.cos(a)) / 2;
    const rHem = 0.122 + 0.05 * front;
    const r0 = Math.hypot(x, z);
    const r = r0 < 1e-5 ? 0 : 0.101 + (rHem - 0.101) * f;
    const k = r0 < 1e-5 ? 0 : r / r0;
    out.set([x * k, WAIST - f * 0.215, z * k], i * 3);
  }
  const tmp = new THREE.BufferGeometry();
  tmp.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  tmp.setIndex(geo.getIndex());
  tmp.computeVertexNormals();
  geo.morphAttributes.position = [new THREE.Float32BufferAttribute(out, 3)];
  geo.morphAttributes.normal = [tmp.getAttribute('normal') as THREE.BufferAttribute];
}

export function buildCharacter(spec: CharacterSpec): CharacterRig {
  if (spec.model_type === 'placeholder') return buildPlaceholder(spec);
  const rig = createBareRig(spec.id, spec.height);
  const skinMat = lambert(spec.palette.skin ?? '#f8e1d4');
  buildHead(rig, spec, skinMat);
  buildHair(rig, spec);
  buildBody(rig, spec, skinMat);
  return rig;
}
