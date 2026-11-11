// 角色骨架接口：模型（model.ts）负责长相，动画/走位（agent.ts）只动这些关节。
// 模型按 1.2 米参考身高搭建，再由 scaler 统一缩放到 characters.json 的 height。
//
// 局部坐标：+Z 为角色正面，+Y 向上。
// 关节层级：root → scaler → body(胯) → { torso → { head, armL → foreL, armR → foreR }, legL → shinL, legR → shinR }

import * as THREE from 'three';

export const REFERENCE_HEIGHT = 1.2;
/** 参考身高下的胯部高度（米） */
export const REF_HIP_HEIGHT = 0.25;
/** 大腿 / 小腿长度（参考尺寸） */
export const REF_THIGH = 0.11;
export const REF_SHIN = 0.105;
/** 上臂长度（参考尺寸） */
export const REF_UPPER_ARM = 0.085;

/** 眼睛状态：0 睁开，1 半闭，2 闭上 */
export type EyeState = 0 | 1 | 2;

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
  /** 大腿（胯关节，骨骼） */
  legL: THREE.Bone;
  legR: THREE.Bone;
  /** 小腿（膝关节，骨骼） */
  shinL: THREE.Bone;
  shinR: THREE.Bone;
  /** 上臂（肩关节，骨骼） */
  armL: THREE.Bone;
  armR: THREE.Bone;
  /** 前臂（肘关节，骨骼） */
  foreL: THREE.Bone;
  foreR: THREE.Bone;
  /** 实际身高 / 参考身高 */
  scale: number;
  /** 角色 id */
  id: string;
  /** 眨眼：换脸部贴图（没有网格的骨架为空操作） */
  setEyes(state: EyeState): void;
  /** 坐姿权重 0～1：裙摆从站姿形变为坐姿（盖在大腿上） */
  setSitBlend(k: number): void;
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

  const mkLeg = (x: number) => {
    const leg = new THREE.Bone();
    leg.position.x = x;
    leg.rotation.order = 'YXZ';
    const shin = new THREE.Bone();
    shin.position.y = -REF_THIGH;
    leg.add(shin);
    body.add(leg);
    return [leg, shin] as const;
  };
  const [legL, shinL] = mkLeg(0.055);
  const [legR, shinR] = mkLeg(-0.055);

  const mkArm = (x: number) => {
    const arm = new THREE.Bone();
    arm.position.set(x, 0.322, 0);
    arm.rotation.order = 'ZXY';
    const fore = new THREE.Bone();
    fore.position.y = -REF_UPPER_ARM;
    arm.add(fore);
    torso.add(arm);
    return [arm, fore] as const;
  };
  const [armL, foreL] = mkArm(0.116);
  const [armR, foreR] = mkArm(-0.116);

  return {
    root,
    scaler,
    body,
    torso,
    head,
    legL,
    legR,
    shinL,
    shinR,
    armL,
    armR,
    foreL,
    foreR,
    scale: s,
    id,
    setEyes: () => {},
    setSitBlend: () => {},
  };
}
