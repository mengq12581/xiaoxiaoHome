// 角色骨架接口：模型（model.ts）负责长相，动画/走位（agent.ts）只动这些关节。
// 模型按 1.2 米参考身高搭建，再由 scaler 统一缩放到 characters.json 的 height。
//
// 局部坐标：+Z 为角色正面，+Y 向上。

import * as THREE from 'three';

export const REFERENCE_HEIGHT = 1.2;
/** 参考身高下的胯部高度（米） */
export const REF_HIP_HEIGHT = 0.25;

export interface CharacterRig {
  /** 世界位置 + 朝向（yaw） */
  root: THREE.Group;
  /** 统一缩放 */
  scaler: THREE.Group;
  /** 胯部枢轴（y = 胯高，参考尺寸） */
  body: THREE.Group;
  /** 上身：呼吸缩放、前后倾 */
  torso: THREE.Group;
  head: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  /** 实际身高 / 参考身高 */
  scale: number;
  /** 角色 id */
  id: string;
}

/** 只有关节、没有网格的骨架（单测与占位用） */
export function createBareRig(id: string, height = REFERENCE_HEIGHT): CharacterRig {
  const root = new THREE.Group();
  root.name = `character:${id}`;
  const scaler = new THREE.Group();
  const s = height / REFERENCE_HEIGHT;
  scaler.scale.setScalar(s);
  root.add(scaler);
  const body = new THREE.Group();
  body.position.y = REF_HIP_HEIGHT;
  scaler.add(body);
  const torso = new THREE.Group();
  body.add(torso);
  const head = new THREE.Group();
  head.position.y = 0.385;
  torso.add(head);
  const legL = new THREE.Group();
  const legR = new THREE.Group();
  legL.position.x = 0.055;
  legR.position.x = -0.055;
  body.add(legL, legR);
  const armL = new THREE.Group();
  const armR = new THREE.Group();
  armL.position.set(0.112, 0.325, 0);
  armR.position.set(-0.112, 0.325, 0);
  torso.add(armL, armR);
  return { root, scaler, body, torso, head, legL, legR, armL, armR, scale: s, id };
}
