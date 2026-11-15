// 全场景统一的「柔和 3D」材质：哑光 PBR（无金属），由环境光照给出连续的明暗过渡，
// 不再用 Lambert 平涂——平涂的面只有一个亮度，看起来像色块拼出来的。

import * as THREE from 'three';

export type SoftParams = THREE.MeshStandardMaterialParameters;

/** 哑光软材质。roughness 越低越有「软糖」般的柔和高光；金属度恒为 0 */
export function soft(color: THREE.ColorRepresentation, opts: SoftParams = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0, ...opts });
}

/** 各类表面的粗糙度基线（改这里统一调质感） */
export const ROUGH = {
  wall: 0.95,
  floor: 0.72,
  wood: 0.72,
  fabric: 0.96,
  paint: 0.78,
  skin: 0.62,
  hair: 0.66,
  cloth: 0.9,
  trim: 0.55,
} as const;
