// 让一组物体能整体淡出（外墙贴面、内墙漆跟着透明墙一起淡）。
// 第一次调用时把组内材质各克隆一份（同组内共用），改成始终 transparent，之后只改不透明度，不切着色器变体。

import * as THREE from 'three';

export type FadeFn = (k: number) => void;

export function makeFadeable(root: THREE.Object3D): FadeFn {
  const clones = new Map<THREE.Material, THREE.Material>();
  const mats: { m: THREE.Material; base: number }[] = [];
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshes.push(mesh);
    const swap = (m: THREE.Material) => {
      let c = clones.get(m);
      if (!c) {
        c = m.clone();
        c.transparent = true;
        clones.set(m, c);
        mats.push({ m: c, base: m.opacity });
      }
      return c;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
  });
  let last = -1;
  return (k: number) => {
    if (Math.abs(k - last) < 1e-3) return;
    last = k;
    const solid = k > 0.98;
    for (const { m, base } of mats) {
      m.opacity = base * k;
      m.depthWrite = solid;
    }
    root.visible = k > 0.01;
    for (const mesh of meshes) mesh.renderOrder = solid ? 0 : 3;
  };
}
