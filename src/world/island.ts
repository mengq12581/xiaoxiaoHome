// 湖心小岛的地形（程序生成，跟着户型走）：
//   - 岛的轮廓 = 绕房子的椭圆 + 几层正弦起伏，保证房子四周至少留 3 米多的草地；
//   - 房子底下和四周一圈是平台（比地板略低），往外慢慢降到沙滩、再没入水下；
//   - 屋后有一个小土坡（放一棵大树，打破地平线）；
//   - 颜色按「草地（几种深浅自然过渡）/ 小路 / 沙滩 / 岩石」上顶点色，再叠一张可平铺的细节贴图（草叶的细碎明暗 + 凹凸）。
// 同时导出：任意平面点的地面高度、水深贴图（给湖面着色用）、小路中线（给植被避让用）。

import * as THREE from 'three';
import type { Vec2 } from '../config/types';
import { P } from '../scene/house';
import { fbm, smoothstep } from './noise';
import { PALETTE } from './palette';
import { groundDetail } from './textures';

export const WATER_LEVEL = -0.4;
/** 房子底下平台的高度（地板盒子底面是 -0.06） */
const PLATEAU = -0.065;

export interface IslandSpec {
  /** 房子外接矩形（平面） */
  house: { x0: number; y0: number; x1: number; y1: number };
  /** 入户门外的位置（小路起点） */
  door: Vec2;
  /** 码头在岛边的落脚点、朝外的方向（平面角，度） */
  pierHeading: number;
}

export interface Island {
  mesh: THREE.Mesh;
  /** 地面高度（世界 y） */
  height(p: Vec2): number;
  /** 离岸距离：岛内为正，水里为负（米） */
  shore(p: Vec2): number;
  /** 离小路中线的距离 */
  pathDist(p: Vec2): number;
  /** 小路中线（从入户门到码头） */
  pathPoints: Vec2[];
  /** 是否在房子（含外扩一圈）范围内 */
  nearHouse(p: Vec2, margin: number): boolean;
  /** 码头起点（岸边）与方向 */
  pier: { start: Vec2; dir: Vec2 };
  /** 地形范围（平面） */
  extent: { x0: number; y0: number; x1: number; y1: number };
  /** 水深贴图：r = 深度（米，0～4 映射到 0～1） */
  depthTexture: THREE.DataTexture;
  center: Vec2;
}

export function buildIsland(spec: IslandSpec): Island {
  const h = spec.house;
  const center: Vec2 = [(h.x0 + h.x1) / 2 - 0.4, (h.y0 + h.y1) / 2 + 0.2];
  // 椭圆半径：房子半宽 / 半深再各加 6～7 米
  const rx = (h.x1 - h.x0) / 2 + 6.4;
  const ry = (h.y1 - h.y0) / 2 + 6.0;

  /** 岸线半径（随角度起伏） */
  const radiusAt = (theta: number) => {
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const base = 1 / Math.sqrt((c * c) / (rx * rx) + (s * s) / (ry * ry));
    const wobble = 1 + 0.06 * Math.sin(3 * theta + 1.1) + 0.045 * Math.sin(5 * theta + 2.3) + 0.025 * Math.sin(8 * theta + 0.4);
    return base * wobble;
  };
  const shore = (p: Vec2) => {
    const dx = p[0] - center[0];
    const dy = p[1] - center[1];
    return radiusAt(Math.atan2(dy, dx)) - Math.hypot(dx, dy);
  };

  // 码头：从入户门往码头方向找岸线
  const dir: Vec2 = [Math.cos((spec.pierHeading * Math.PI) / 180), Math.sin((spec.pierHeading * Math.PI) / 180)];
  let t = 0;
  while (shore([spec.door[0] + dir[0] * t, spec.door[1] + dir[1] * t]) > 0.6 && t < 30) t += 0.05;
  const pierStart: Vec2 = [spec.door[0] + dir[0] * t, spec.door[1] + dir[1] * t];

  // 小路：入户门 → 码头，带一点弯
  const mid: Vec2 = [(spec.door[0] + pierStart[0]) / 2 - dir[1] * 0.7, (spec.door[1] + pierStart[1]) / 2 + dir[0] * 0.7];
  const pathPts: Vec2[] = [];
  for (let i = 0; i <= 24; i++) {
    const u = i / 24;
    const a = 1 - u;
    pathPts.push([a * a * spec.door[0] + 2 * a * u * mid[0] + u * u * pierStart[0], a * a * spec.door[1] + 2 * a * u * mid[1] + u * u * pierStart[1]]);
  }
  const pathDist = (p: Vec2) => {
    let best = Infinity;
    for (let i = 0; i < pathPts.length - 1; i++) {
      const [ax, ay] = pathPts[i];
      const [bx, by] = pathPts[i + 1];
      const vx = bx - ax;
      const vy = by - ay;
      const k = Math.max(0, Math.min(1, ((p[0] - ax) * vx + (p[1] - ay) * vy) / (vx * vx + vy * vy)));
      best = Math.min(best, Math.hypot(p[0] - ax - vx * k, p[1] - ay - vy * k));
    }
    return best;
  };

  const houseDist = (p: Vec2) => {
    const dx = Math.max(h.x0 - p[0], 0, p[0] - h.x1);
    const dy = Math.max(h.y0 - p[1], 0, p[1] - h.y1);
    return Math.hypot(dx, dy);
  };
  const nearHouse = (p: Vec2, margin: number) => houseDist(p) <= margin;

  // 屋后小土坡
  const hill: Vec2 = [h.x0 + 1.2, h.y1 + 4.4];
  const height = (p: Vec2) => {
    const d = shore(p);
    if (d < 0) return WATER_LEVEL - 0.08 + Math.max(d * 0.55, -3.2) - 0.25 * smoothstep(0, -1.5, d);
    // 岸上：从岸线（略低于水面）抬到平台；平台外有缓慢起伏
    const rise = smoothstep(0, 3.2, d);
    let y = WATER_LEVEL - 0.06 + (PLATEAU - (WATER_LEVEL - 0.06)) * rise;
    const undulate = (fbm(p[0] * 0.18, p[1] * 0.18, 3, 7) - 0.5) * 0.5 * smoothstep(1.5, 4, d);
    const bump = 0.95 * Math.exp(-((p[0] - hill[0]) ** 2 + (p[1] - hill[1]) ** 2) / (2 * 2.2 * 2.2));
    y += undulate + bump * smoothstep(0.5, 3, d);
    // 房子四周一圈压平（门口和小路也压平一点）
    const flat = Math.max(1 - smoothstep(0.6, 2.2, houseDist(p)), 0.7 * (1 - smoothstep(0.5, 1.3, pathDist(p))));
    return y + (PLATEAU - y) * flat;
  };

  // ───────── 网格 ─────────
  const extent = { x0: center[0] - rx - 5, x1: center[0] + rx + 5, y0: center[1] - ry - 5, y1: center[1] + ry + 5 };
  const step = 0.35;
  const nx = Math.ceil((extent.x1 - extent.x0) / step) + 1;
  const ny = Math.ceil((extent.y1 - extent.y0) / step) + 1;
  const pos = new Float32Array(nx * ny * 3);
  const col = new Float32Array(nx * ny * 3);
  const uvs = new Float32Array(nx * ny * 2);
  const c = (hex: string) => new THREE.Color(hex);
  const G = PALETTE.grass;
  const Gr = PALETTE.ground;
  const cLit = c(G.lit);
  const cMid = c(G.mid);
  const cShade = c(G.shade);
  const cPath = c(Gr.path);
  const cSand = c(Gr.sand);
  const cEarth = c(Gr.earth);
  const cRock = c(Gr.rock);
  const tmp = new THREE.Color();
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const p: Vec2 = [extent.x0 + i * step, extent.y0 + j * step];
      const y = height(p);
      const k = (j * nx + i) * 3;
      const w = P(p[0], y, p[1]);
      pos[k] = w.x;
      pos[k + 1] = w.y;
      pos[k + 2] = w.z;
      // 细节贴图按平面坐标平铺（每 1.6 米一张）
      uvs[(j * nx + i) * 2] = p[0] / 1.6;
      uvs[(j * nx + i) * 2 + 1] = p[1] / 1.6;
      // 草地：低频噪声在三种深浅之间自然过渡（写实：不再量化成硬色块）
      const n = fbm(p[0] * 0.12 + 3.1, p[1] * 0.12 - 1.7, 3, 11);
      const band = smoothstep(0.36, 0.5, n) + smoothstep(0.52, 0.68, n);
      tmp.copy(cShade).lerp(cMid, Math.min(1, band)).lerp(cLit, Math.max(0, band - 1));
      // 屋檐下、房子脚下偏暗一点
      tmp.lerp(cShade, 0.35 * (1 - smoothstep(0.2, 1.4, houseDist(p))));
      const d = shore(p);
      // 小路：边缘不规则
      const pd = pathDist(p) + (fbm(p[0] * 1.3, p[1] * 1.3, 2, 5) - 0.5) * 0.35;
      tmp.lerp(cPath, 1 - smoothstep(0.42, 0.62, pd));
      // 沙滩带与水下
      tmp.lerp(cSand, 1 - smoothstep(0.5, 1.4 + (fbm(p[0] * 0.5, p[1] * 0.5, 2, 9) - 0.5) * 0.8, d));
      if (d < 0) tmp.lerp(cEarth, smoothstep(0, -1.5, d) * 0.7);
      // 土坡上露出一点岩石
      const rocky = smoothstep(0.62, 0.72, fbm(p[0] * 0.6 + 9, p[1] * 0.6, 2, 3)) * smoothstep(0.35, 0.7, y - PLATEAU);
      tmp.lerp(cRock, rocky * 0.8);
      col[k] = tmp.r;
      col[k + 1] = tmp.g;
      col[k + 2] = tmp.b;
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < ny - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const cc = a + nx;
      const d = cc + 1;
      // 平面 y 向上 = 世界 -z：三角形绕向要让法线朝上
      idx.push(a, b, cc, b, d, cc);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const detail = groundDetail();
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ vertexColors: true, map: detail.map, normalMap: detail.normalMap, normalScale: new THREE.Vector2(0.8, 0.8), roughness: 0.95, metalness: 0 }),
  );
  mesh.receiveShadow = true;
  mesh.name = 'island';

  // ───────── 水深贴图 ─────────
  const N = 256;
  const data = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const p: Vec2 = [extent.x0 + ((i + 0.5) / N) * (extent.x1 - extent.x0), extent.y0 + ((j + 0.5) / N) * (extent.y1 - extent.y0)];
      const depth = Math.max(0, WATER_LEVEL - height(p));
      const k = (j * N + i) * 4;
      data[k] = Math.round(Math.min(1, depth / 4) * 255);
      data[k + 1] = Math.round(Math.max(0, Math.min(1, (shore(p) + 6) / 12)) * 255);
      data[k + 3] = 255;
    }
  const depthTexture = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  depthTexture.magFilter = THREE.LinearFilter;
  depthTexture.minFilter = THREE.LinearFilter;
  depthTexture.needsUpdate = true;

  return { mesh, height, shore, pathDist, pathPoints: pathPts, nearHouse, pier: { start: pierStart, dir }, extent, depthTexture, center };
}
