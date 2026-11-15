// 道具：活动需要时才出现的东西。按物体名字接管（命名约定见 scene/furniture.ts 顶部）：
//   prop:<名字>  出现 / 收起（缩放渐变）
//   hide:<名字>  该道具出现时藏起来
//   glow:<名字>  该道具出现时发光（屏幕）
// 哪个活动要哪些道具写在 config/activities.json 的 props 里。

import * as THREE from 'three';
import type { PropSink } from '../director/stagePerformer';
import type { CharacterRig } from '../character/rig';
import { ROUGH, soft } from './materials';

interface Entry {
  name: string;
  kind: 'prop' | 'hide' | 'glow';
  obj: THREE.Object3D;
  /** 当前显示程度 0～1 */
  k: number;
  baseScale: THREE.Vector3;
  mat?: THREE.MeshStandardMaterial;
  baseEmissive?: THREE.Color;
}

const GLOW: Record<string, { color: number; flicker: number }> = {
  screen_glow: { color: 0x7fb2e6, flicker: 0.05 },
  tv_glow: { color: 0x8fa9d9, flicker: 0.22 },
};

export class PropManager implements PropSink {
  private entries: Entry[] = [];
  private active = new Set<string>();
  private time = 0;

  constructor(roots: THREE.Object3D[]) {
    for (const root of roots) this.adopt(root);
    this.apply(1);
  }

  /** 接管某棵子树里按约定命名的物体（家具重建、角色加载后调用） */
  adopt(root: THREE.Object3D) {
    root.traverse((o) => {
      const m = /^(prop|hide|glow):(.+)$/.exec(o.name);
      if (!m) return;
      const e: Entry = { name: m[2], kind: m[1] as Entry['kind'], obj: o, k: 0, baseScale: o.scale.clone() };
      if (e.kind === 'glow' && (o as THREE.Mesh).isMesh) {
        // 发光要单独调，材质克隆一份，不影响共用同一材质的其他物体
        const mesh = o as THREE.Mesh;
        e.mat = (mesh.material as THREE.MeshStandardMaterial).clone();
        mesh.material = e.mat;
        e.baseEmissive = e.mat.emissive.clone();
      }
      this.entries.push(e);
    });
  }

  set(props: string[]) {
    this.active = new Set(props);
  }

  has(name: string) {
    return this.active.has(name);
  }

  update(dt: number) {
    this.time += dt;
    this.apply(Math.min(1, dt / 0.5));
  }

  private apply(step: number) {
    for (const e of this.entries) {
      const goal = this.active.has(e.name) ? 1 : 0;
      e.k += Math.sign(goal - e.k) * Math.min(Math.abs(goal - e.k), step);
      const s = e.k * e.k * (3 - 2 * e.k);
      if (e.kind === 'prop') {
        e.obj.visible = e.k > 0.01;
        e.obj.scale.copy(e.baseScale).multiplyScalar(0.35 + 0.65 * s);
      } else if (e.kind === 'hide') {
        e.obj.visible = e.k < 0.5;
      } else if (e.mat && e.baseEmissive) {
        const g = GLOW[e.name] ?? { color: 0x9fbfe8, flicker: 0.1 };
        // 屏幕内容在变：亮度缓慢起伏
        const wobble = 1 + g.flicker * (Math.sin(this.time * 2.3) * 0.6 + Math.sin(this.time * 5.1 + 1) * 0.4);
        e.mat.emissive.copy(e.baseEmissive).lerp(new THREE.Color(g.color), s);
        e.mat.emissiveIntensity = 1 + 0.9 * s * wobble;
      }
    }
  }
}

/** 给角色做一副头戴耳机（平时隐藏，由 PropManager 以 prop:headphones 接管） */
export function buildHeadphones(rig: CharacterRig): THREE.Group {
  const g = new THREE.Group();
  g.name = 'prop:headphones';
  const { ear, top } = rig.headphones;
  const bandMat = soft(0x4a4a52, { roughness: ROUGH.paint, envMapIntensity: 0.5 });
  const cupMat = soft(0xf2ede4, { roughness: ROUGH.paint });
  const padMat = soft(0x5b5b64, { roughness: ROUGH.fabric });
  // 头梁：从一只耳朵越过头顶到另一只耳朵的半椭圆
  const pts: THREE.Vector3[] = [];
  const ex = ear[0] + 0.022;
  for (let i = 0; i <= 24; i++) {
    const a = (i / 24) * Math.PI;
    pts.push(new THREE.Vector3(Math.cos(a) * ex, ear[1] + Math.sin(a) * (top - ear[1]), ear[2]));
  }
  const band = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, 0.011, 10), bandMat);
  band.castShadow = true;
  g.add(band);
  for (const s of [-1, 1]) {
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.046, 0.034, 28), cupMat);
    cup.rotation.z = Math.PI / 2;
    cup.position.set(s * (ex + 0.004), ear[1], ear[2]);
    cup.castShadow = true;
    const pad = new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.012, 10, 28), padMat);
    pad.rotation.y = Math.PI / 2;
    pad.position.set(s * (ex - 0.012), ear[1], ear[2]);
    g.add(cup, pad);
  }
  rig.head.add(g);
  return g;
}
