// 接触阴影：角色脚下（地面）一团柔和的暗影；坐下时座面上再加一团，避免「浮着」。
// 与主光投影叠加使用：主光阴影随光向偏移，接触阴影始终贴在接触点。

import * as THREE from 'three';

function blobTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,1)');
  grad.addColorStop(0.45, 'rgba(0,0,0,0.6)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function blob(tex: THREE.Texture): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      color: 0x3b2a1e,
      alphaMap: tex,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  );
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = 1;
  return m;
}

export class ContactShadow {
  readonly group = new THREE.Group();
  private floor: ReturnType<typeof blob>;
  private seat: ReturnType<typeof blob>;

  constructor(private scale: number) {
    const tex = blobTexture();
    this.floor = blob(tex);
    this.seat = blob(tex);
    this.group.add(this.floor, this.seat);
    this.group.name = 'contact-shadow';
  }

  /**
   * @param plan 角色平面位置
   * @param headingRad 角色 root 的 yaw（世界）
   * @param sit 坐姿权重 0～1
   * @param seatHeight 座面高度（米）
   */
  update(plan: [number, number], headingRad: number, sit: number, seatHeight: number) {
    const s = this.scale;
    this.floor.position.set(plan[0], 0.004, -plan[1]);
    this.floor.rotation.z = headingRad;
    // 站立：脚下一团偏前后的椭圆；坐下：脚离地，影子变淡变大
    this.floor.scale.set(0.34 * s * (1 + 0.3 * sit), 0.4 * s * (1 + 0.3 * sit), 1);
    this.floor.material.opacity = 0.5 - 0.3 * sit;

    this.seat.visible = sit > 0.05;
    this.seat.position.set(plan[0], seatHeight + 0.004, -plan[1]);
    this.seat.rotation.z = headingRad;
    this.seat.scale.set(0.36 * s, 0.32 * s, 1);
    this.seat.material.opacity = 0.42 * sit;
  }
}
