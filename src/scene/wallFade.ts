// 墙体遮挡：每帧从相机向「角色 / 各房间中心」打射线，被命中的墙段渐变为半透明（保留轮廓线），
// 未命中的恢复实体。地板、家具、门窗不参与。见 docs/技术方案要点.md §4.5。

import * as THREE from 'three';
import type { CameraConfig } from '../config/types';
import type { WallView } from './house';

/** 不透明度每秒变化量（约 0.2 秒完成一次淡入淡出） */
const FADE_SPEED = 5;

export class WallFader {
  private raycaster = new THREE.Raycaster();
  private meshes: THREE.Mesh[];
  private byMesh = new Map<THREE.Object3D, WallView>();
  /** 当前被判定为遮挡的墙段 id（调试 / 验收用） */
  readonly occluding = new Set<string>();

  constructor(
    private walls: WallView[],
    private cfg: CameraConfig,
  ) {
    this.meshes = walls.flatMap((w) => w.meshes);
    for (const w of walls) for (const m of w.meshes) this.byMesh.set(m, w);
  }

  /**
   * @param targets 需要保持可见的点（世界坐标）。M1 没有角色时传各房间中心。
   */
  update(camera: THREE.Camera, targets: THREE.Vector3[], dt: number) {
    this.occluding.clear();
    const origin = camera.getWorldPosition(new THREE.Vector3());
    const dir = new THREE.Vector3();
    for (const t of targets) {
      dir.subVectors(t, origin);
      const dist = dir.length();
      if (dist < 1e-3) continue;
      dir.divideScalar(dist);
      this.raycaster.set(origin, dir);
      this.raycaster.far = dist - 0.05;
      for (const hit of this.raycaster.intersectObjects(this.meshes, false)) {
        const w = this.byMesh.get(hit.object);
        if (w) this.occluding.add(w.segment.id);
      }
    }

    const step = Math.min(1, dt * FADE_SPEED);
    for (const w of this.walls) {
      const goal = this.occluding.has(w.segment.id) ? this.cfg.wallFadeOpacity : 1;
      w.opacity += (goal - w.opacity) * step;
      if (Math.abs(goal - w.opacity) < 0.005) w.opacity = goal;
      const solid = w.opacity > 0.98;
      // 墙材质始终 transparent=true（不切着色器变体），实体时写深度、透明时不写
      w.material.opacity = w.opacity;
      w.material.depthWrite = solid;
      // 半透明墙后渲染，避免挡住其后的家具
      for (const m of w.meshes) m.renderOrder = solid ? 0 : 3;
      // 实体墙不描线；只有被透明掉的墙保留轮廓（PRD F-01、docs/验收问题.md C2/C4）
      w.edges.visible = !solid && this.cfg.wallFadeWithOutline;
      w.edgeMaterial.opacity = 0.9;
    }
  }
}
