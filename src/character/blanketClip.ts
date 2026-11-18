// 盖被子时把被子下面的身体裁掉（docs/验收问题.md C20）：Q 版人物的裙子、手脚比被子能盖住的体积大，
// 直接盖会从被子里穿出来。做法：角色所有材质挂一个裁切面，躺好、被子完全铺开时，裁切面放在被头（furniture.ts 的
// blanket_cuff）处、法线朝头，脚那一侧全部不画；其他时候把裁切面挪到无穷远，什么都不裁（不切换着色器）。

import * as THREE from 'three';

const FAR = 1e6;

export class BlanketClip {
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), FAR);
  private n = new THREE.Vector3();
  private p = new THREE.Vector3();
  active = false;

  constructor(root: THREE.Object3D) {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        m.clippingPlanes = [this.plane];
        m.clipShadows = true;
        m.needsUpdate = true;
      }
    });
  }

  /** cuff：被头标记（+z 朝头）；on：此刻是否该裁 */
  update(cuff: THREE.Object3D | null | undefined, on: boolean) {
    this.active = !!cuff && on;
    if (!this.active) {
      this.plane.set(new THREE.Vector3(0, 1, 0), FAR);
      return;
    }
    cuff!.updateWorldMatrix(true, false);
    this.n.set(0, 0, 1).transformDirection(cuff!.matrixWorld);
    cuff!.getWorldPosition(this.p);
    this.plane.setFromNormalAndCoplanarPoint(this.n, this.p);
  }
}
