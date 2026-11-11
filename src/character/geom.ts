// 角色用的软轮廓几何：平滑车削体（躯干、四肢）、渐细扁管（鬓发）。

import * as THREE from 'three';

/**
 * 平滑车削体。profile 为 [半径, 高度]（从下往上），先用样条平滑，再按弧长等距重采样，
 * 这样贴图 v 方向与实际长度成正比（印花不被拉伸）。
 * phiStart = π：正面 (+Z) 落在 u = 0.5。
 */
export function smoothLathe(profile: [number, number][], samples = 48, radial = 40): THREE.LatheGeometry {
  const curve = new THREE.SplineCurve(profile.map(([r, y]) => new THREE.Vector2(r, y)));
  const pts = curve.getSpacedPoints(samples).map((p) => new THREE.Vector2(Math.max(0.0005, p.x), p.y));
  return new THREE.LatheGeometry(pts, radial, Math.PI, Math.PI * 2);
}

/** 弧长（用于把画布像素换算成米） */
export function profileLength(profile: [number, number][]): number {
  const curve = new THREE.SplineCurve(profile.map(([r, y]) => new THREE.Vector2(r, y)));
  return curve.getLength();
}

/**
 * 沿曲线的渐细扁管：横截面是椭圆，width 沿「左右」，thick 沿 depthHint 方向（默认 +Z，前后）。
 * width / thick 是 t∈[0,1] 的函数，末端可收到很细形成发梢。
 */
export function taperedTube(
  points: THREE.Vector3[],
  width: (t: number) => number,
  thick: (t: number) => number,
  tubular = 40,
  radial = 12,
  depthHint = new THREE.Vector3(0, 0, 1),
): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const T = new THREE.Vector3();
  const D = new THREE.Vector3();
  const W = new THREE.Vector3();
  for (let i = 0; i <= tubular; i++) {
    const t = i / tubular;
    const P = curve.getPointAt(t);
    curve.getTangentAt(t, T);
    D.copy(depthHint).addScaledVector(T, -depthHint.dot(T)).normalize();
    W.crossVectors(T, D).normalize();
    const w = width(t);
    const th = thick(t);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      pos.push(
        P.x + W.x * Math.cos(a) * w + D.x * Math.sin(a) * th,
        P.y + W.y * Math.cos(a) * w + D.y * Math.sin(a) * th,
        P.z + W.z * Math.cos(a) * w + D.z * Math.sin(a) * th,
      );
      uv.push(j / radial, 1 - t);
    }
  }
  for (let i = 0; i < tubular; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j;
      const b = a + radial + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** 球面上的点（three.js SphereGeometry 的约定：phi = π/2 为 +Z 正面，theta 从头顶 0 到 π） */
export function spherePoint(r: number, phi: number, theta: number, target = new THREE.Vector3()): THREE.Vector3 {
  return target.set(-r * Math.cos(phi) * Math.sin(theta), r * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta));
}

export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
