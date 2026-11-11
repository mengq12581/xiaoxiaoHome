// 轨道相机：左键自由环绕（水平 360°，极角受限），滚轮连续缩放，目标点固定，相机始终在屋外。
// 参数见 config/camera.json 与 docs/验收问题.md C1/C3。

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { CameraConfig } from '../config/types';
import { P } from './house';

const DEG = Math.PI / 180;
/** 屋体包围盒外再留的余量（米） */
const OUTSIDE_MARGIN = 0.35;

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private readonly target: THREE.Vector3;
  private readonly keepOut: THREE.Box3;

  constructor(
    dom: HTMLElement,
    private cfg: CameraConfig,
    houseBox: THREE.Box3,
  ) {
    this.camera = new THREE.PerspectiveCamera(45, dom.clientWidth / Math.max(1, dom.clientHeight), 0.1, 200);
    this.target = P(cfg.target[0], cfg.target[1], cfg.target[2]);
    this.keepOut = houseBox.clone().expandByScalar(OUTSIDE_MARGIN);
    this.keepOut.min.y = -Infinity;

    const c = new OrbitControls(this.camera, dom);
    c.target.copy(this.target);
    c.enablePan = false;
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.rotateSpeed = 0.6;
    c.zoomSpeed = 0.9;
    c.minDistance = cfg.minDistance;
    c.maxDistance = cfg.maxDistance;
    c.minPolarAngle = cfg.minPolarDeg * DEG;
    c.maxPolarAngle = cfg.maxPolarDeg * DEG;
    c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: null as unknown as THREE.MOUSE };
    c.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_ROTATE };
    this.controls = c;
    this.reset();
  }

  /** 回到配置里的起始视角 */
  reset() {
    this.setView(this.cfg.startAzimuthDeg, this.cfg.startPolarDeg, this.cfg.startDistance);
  }

  /** azimuth：相机相对目标点的平面方位（从 +x 逆时针，度）；polar：与竖直向上的夹角（度） */
  setView(azimuthDeg: number, polarDeg: number, distance: number) {
    const a = azimuthDeg * DEG;
    const p = THREE.MathUtils.clamp(polarDeg, this.cfg.minPolarDeg, this.cfg.maxPolarDeg) * DEG;
    const d = THREE.MathUtils.clamp(distance, this.cfg.minDistance, this.cfg.maxDistance);
    const r = d * Math.sin(p);
    const planX = this.cfg.target[0] + r * Math.cos(a);
    const planY = this.cfg.target[2] + r * Math.sin(a);
    this.camera.position.copy(P(planX, this.cfg.target[1] + d * Math.cos(p), planY));
    this.controls.target.copy(this.target);
    this.camera.lookAt(this.target);
    // 立即生效，不走阻尼
    const damping = this.controls.enableDamping;
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = damping;
    this.keepOutside();
  }

  /** 当前视角（度、米），用于 HUD */
  get view() {
    const off = this.camera.position.clone().sub(this.controls.target);
    const d = off.length();
    // 世界 (x, z) → 平面 (x, -z)
    const az = (Math.atan2(-off.z, off.x) / DEG + 360) % 360;
    const polar = Math.acos(THREE.MathUtils.clamp(off.y / d, -1, 1)) / DEG;
    return { azimuthDeg: az, polarDeg: polar, distance: d };
  }

  resize(w: number, h: number) {
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  update() {
    this.controls.update();
    this.keepOutside();
  }

  /** 相机若落进屋体（含余量），沿视线方向往外推到包围盒外 */
  private keepOutside() {
    const pos = this.camera.position;
    if (!this.keepOut.containsPoint(pos)) return;
    const t0 = this.controls.target;
    const dir = pos.clone().sub(t0).normalize();
    let exit = Infinity;
    for (const axis of ['x', 'y', 'z'] as const) {
      const v = dir[axis];
      if (Math.abs(v) < 1e-6) continue;
      const bound = v > 0 ? this.keepOut.max[axis] : this.keepOut.min[axis];
      if (!Number.isFinite(bound)) continue;
      exit = Math.min(exit, (bound - t0[axis]) / v);
    }
    if (!Number.isFinite(exit)) return;
    pos.copy(t0).addScaledVector(dir, exit + 0.01);
  }
}
