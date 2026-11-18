// 房子外观（程序生成，跟着 rooms.json 走，改户型自动跟上）。风格按客户 2026-11-18 给的两张参考图：
//   - 外墙：白色细抹灰（几乎看不出纹理，只有很淡的抹痕），墙脚一道很矮的浅灰混凝土勒脚；不要角柱、檐口线；
//   - 屋顶：深炭灰立边咬合金属屋面，薄屋面板 + 细封檐，长边出檐较深、檐下露出一排木椽，两端山墙同样白色抹灰；
//   - 门窗：外侧一圈深灰细框（窗洞有进深）；入户门是深色竖向木板门，门边一盏黑框壁灯，门外两级石阶；
//   - 南墙：几缕从地面爬上去的藤（后面一片木格栅）、长椅两侧两盏筒灯；阳台上方的木花架保留；
//   - 细节（2026-11-18 客户「外墙和屋顶太简陋」）：山墙三角改成竖向木板 + 压条，下沿一道木腰线；山墙下露出檩条头；
//     屋檐一圈深灰檐沟，四角落水管；南坡两扇天窗；入户门上方一块薄雨棚；北墙窗下木花箱；
//   - 门窗与户型一一对应（rooms.json）：窗外侧的窗棂改深灰（和外框一致）；阳台推拉门画成「拉开」停在固定玻璃外侧；
//   - 屋顶可以「掀开」：setOpen(k) 让屋顶抬起并淡出，看屋里时用（docs/art/美术方向.md）。

import * as THREE from 'three';
import type { RoomsConfig } from '../config/types';
import { P } from '../scene/house';
import { computeWallLayout, normBounds, wallPieces, type Opening, type WallSegment } from '../scene/layout';
import { PALETTE } from './palette';
import { bushGeometry, foliageMaterial } from './foliage';
import { leafCard, metalSeamMaps, plasterMaps, rockMaps, woodMaps } from './textures';

const PLINTH_H = 0.16; // 混凝土勒脚高度
const CLAD = 0.025; // 外墙贴面厚度
const PITCH = (24 * Math.PI) / 180;
const ROOF_T = 0.07; // 屋面板厚度
const EAVE = 0.68; // 长边出檐（从墙中线算）
const RAKE = 0.32; // 山墙一侧出檐
const SEAM = 0.45; // 金属屋面板宽度

/**
 * 盒子按世界尺寸重算 UV（每个面取另外两个轴的坐标 / tile 米），相邻墙块的纹理接得上。
 * offset：网格在世界里的位置（只有平移、没有旋转的盒子才用；旋转过的传 0，用自身坐标）。
 */
function worldUV(geo: THREE.BufferGeometry, tile: number, offset = new THREE.Vector3(), swap = false) {
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  const uv = geo.getAttribute('uv');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + offset.x;
    const y = pos.getY(i) + offset.y;
    const z = pos.getZ(i) + offset.z;
    const ax = Math.abs(nor.getX(i));
    const ay = Math.abs(nor.getY(i));
    const az = Math.abs(nor.getZ(i));
    let u: number;
    let v: number;
    if (ax >= ay && ax >= az) [u, v] = [z, y];
    else if (az >= ay) [u, v] = [x, y];
    else [u, v] = [x, z];
    if (swap) [u, v] = [v, u];
    uv.setXY(i, u / tile, v / tile);
  }
  uv.needsUpdate = true;
}

export interface Exterior {
  group: THREE.Group;
  /** 夜里点亮的外墙灯 */
  practicals: { position: THREE.Vector3; color: string; intensity: number; distance: number }[];
  emissive: THREE.MeshStandardMaterial[];
  roof: THREE.Group;
  /** 外墙贴面按墙段分组（剖开看屋里时跟着墙一起淡出；门窗外框、入户门、壁灯、爬藤也在里面） */
  claddingBySegment: Map<string, THREE.Object3D>;
  /** 0 = 盖着，1 = 完全掀开 */
  setOpen(k: number): void;
}

export function buildExterior(cfg: RoomsConfig): Exterior {
  const group = new THREE.Group();
  group.name = 'exterior';
  const layout = computeWallLayout(cfg);
  const T = layout.thickness;
  const E = PALETTE.exterior;

  // ───────── 材质 ─────────
  const pm = plasterMaps();
  const wm = woodMaps();
  const rm = rockMaps();
  const plaster = new THREE.MeshStandardMaterial({ color: E.plaster, map: pm.map, normalMap: pm.normalMap, normalScale: new THREE.Vector2(0.3, 0.3), roughness: 0.92 });
  const plinth = new THREE.MeshStandardMaterial({ color: E.plinth, map: pm.map, normalMap: pm.normalMap, normalScale: new THREE.Vector2(0.5, 0.5), roughness: 0.9 });
  const frame = new THREE.MeshStandardMaterial({ color: E.frame, roughness: 0.5, metalness: 0.15 });
  const doorWood = new THREE.MeshStandardMaterial({ color: E.door, map: wm.map, normalMap: wm.normalMap, roughness: 0.7 });
  const timber = new THREE.MeshStandardMaterial({ color: E.timber, map: wm.map, normalMap: wm.normalMap, roughness: 0.75 });
  const timberDark = new THREE.MeshStandardMaterial({ color: E.timberDark, map: wm.map, normalMap: wm.normalMap, roughness: 0.8 });
  const stoneMat = new THREE.MeshStandardMaterial({ color: E.stone, map: pm.map, normalMap: rm.normalMap, normalScale: new THREE.Vector2(0.5, 0.5), roughness: 0.9 });
  const tileOf = (m: THREE.Material) => (m === timber || m === timberDark || m === doorWood ? 0.9 : 1.6);

  const box = (seg: Pick<WallSegment, 'orient' | 'c'>, s: number, e: number, y0: number, y1: number, across: number, depth: number, mat: THREE.Material, swap = false) => {
    const len = e - s;
    const geo = seg.orient === 'h' ? new THREE.BoxGeometry(len, y1 - y0, depth) : new THREE.BoxGeometry(depth, y1 - y0, len);
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(seg.orient === 'h' ? P((s + e) / 2, (y0 + y1) / 2, across) : P(across, (y0 + y1) / 2, (s + e) / 2));
    worldUV(geo, tileOf(mat), m.position, swap);
    m.castShadow = false;
    m.receiveShadow = true;
    return m;
  };

  const practicals: Exterior['practicals'] = [];
  const emissive: THREE.MeshStandardMaterial[] = [];

  // ───────── 外墙贴面、勒脚、门窗外框 ─────────
  const claddingBySegment = new Map<string, THREE.Object3D>();
  const segGroup = new Map<string, THREE.Group>();
  for (const seg of layout.segments) {
    if (!seg.outward) continue;
    const g = new THREE.Group();
    g.name = `cladding:${seg.id}`;
    const sign = seg.orient === 'h' ? seg.outward[1] : seg.outward[0];
    const across = seg.c + sign * (T / 2 + CLAD / 2);
    for (const p of wallPieces(seg, T)) {
      const s = p.s - (p.s < seg.a + 1e-6 ? CLAD : 0);
      const e = p.e + (p.e > seg.b - 1e-6 ? CLAD : 0);
      if (p.y0 < PLINTH_H) g.add(box(seg, s, e, p.y0, Math.min(PLINTH_H, p.y1), across + sign * 0.006, CLAD + 0.012, plinth));
      if (p.y1 > PLINTH_H) g.add(box(seg, s, e, Math.max(PLINTH_H, p.y0), p.y1, across, CLAD, plaster));
    }
    // 门窗外侧一圈深灰细框（贴在洞口里侧，看起来窗洞有进深）
    for (const op of seg.openings) addFrame(g, seg, sign, op);
    claddingBySegment.set(seg.id, g);
    segGroup.set(seg.id, g);
    group.add(g);
  }

  function addFrame(g: THREE.Group, seg: WallSegment, sign: number, op: Opening) {
    const f = 0.05;
    const acr = seg.c + sign * (T / 2 + CLAD / 2 - 0.004);
    const d = CLAD + 0.03;
    g.add(box(seg, op.s, op.s + f, op.bottom, op.top, acr, d, frame));
    g.add(box(seg, op.e - f, op.e, op.bottom, op.top, acr, d, frame));
    g.add(box(seg, op.s, op.e, op.top - f, op.top, acr, d, frame));
    if (op.bottom > 0.3) {
      // 窗台：一条薄金属披水板，略伸出墙面
      g.add(box(seg, op.s - 0.03, op.e + 0.03, op.bottom - 0.03, op.bottom, seg.c + sign * (T / 2 + CLAD + 0.02), 0.07, frame));
    } else if (op.kind === 'window') {
      g.add(box(seg, op.s, op.e, op.bottom, op.bottom + f, acr, d, frame));
    }
    // 窗棂：和室内窗框同样的分格（scene/house.ts buildWindow），外侧一面盖一层深灰，从屋外看窗框颜色统一
    if (op.kind === 'window') {
      const mz = seg.c + sign * (T / 2 + 0.014);
      const width = op.e - op.s;
      const panes = Math.max(1, Math.round(width / 0.8));
      for (let i = 1; i < panes; i++) {
        const x = op.s + (width * i) / panes;
        g.add(box(seg, x - f / 2 - 0.002, x + f / 2 + 0.002, op.bottom, op.top, mz, 0.008, frame));
      }
      if (op.bottom > 0.3) {
        const y = op.bottom + (op.top - op.bottom) * 0.62;
        g.add(box(seg, op.s, op.e, y - f / 2 - 0.002, y + f / 2 + 0.002, mz, 0.008, frame));
      }
    }
  }

  // 室内部分的外接矩形（不含露天阳台）
  const indoor = cfg.rooms.filter((r) => !r.outdoor).map(normBounds);
  const ix0 = Math.min(...indoor.map((b) => b.x0));
  const ix1 = Math.max(...indoor.map((b) => b.x1));
  const iy0 = Math.min(...indoor.map((b) => b.y0));
  const iy1 = Math.max(...indoor.map((b) => b.y1));
  const H = Math.max(...layout.segments.map((s) => s.height));

  // ───────── 屋顶 ─────────
  const roof = new THREE.Group();
  roof.name = 'roof';
  const half = (iy1 - iy0) / 2;
  const ym = (iy0 + iy1) / 2;
  const tan = Math.tan(PITCH);
  const eaveH = H + 0.1;
  /** 屋面（板底）在离屋脊线水平距离 d 处的高度 */
  const under = (d: number) => eaveH + (half - d) * tan;
  const ridgeH = under(0);
  const slope = (half + EAVE) / Math.cos(PITCH);
  const lenX = ix1 - ix0 + RAKE * 2;
  const seam = metalSeamMaps();
  const sMap = seam.map.clone();
  const sNor = seam.normalMap.clone();
  for (const t of [sMap, sNor]) {
    t.repeat.set(lenX / SEAM, slope / 2.2);
    t.needsUpdate = true;
  }
  // 金属度压低：太「金属」会把蓝天整片反射上去，深灰屋面看起来发蓝
  const roofMetal = new THREE.MeshStandardMaterial({ color: E.roof, map: sMap, normalMap: sNor, roughness: 0.62, metalness: 0.12, transparent: true });
  const roofEdge = new THREE.MeshStandardMaterial({ color: E.roofEdge, roughness: 0.55, metalness: 0.15, transparent: true });
  const soffit = new THREE.MeshStandardMaterial({ color: E.soffit, map: wm.map, roughness: 0.8, transparent: true });
  const roofMats: THREE.Material[] = [roofMetal, roofEdge, soffit];
  const cx = (ix0 + ix1) / 2;
  for (const side of [-1, 1]) {
    // side -1：南坡（平面 y 小的一侧）；+1：北坡。上面金属屋面，底面木吊顶，四边深灰封边
    const slab = new THREE.Mesh(new THREE.BoxGeometry(lenX, ROOF_T, slope), [roofEdge, roofEdge, roofMetal, soffit, roofEdge, roofEdge]);
    const dc = (half + EAVE) / 2;
    slab.position.copy(P(cx, under(dc) + ROOF_T / 2 / Math.cos(PITCH), ym + side * dc));
    slab.rotation.x = side < 0 ? PITCH : -PITCH;
    slab.castShadow = true;
    slab.receiveShadow = true;
    roof.add(slab);
    // 封檐板：檐口一道细的深灰金属边
    const fascia = new THREE.Mesh(new THREE.BoxGeometry(lenX + 0.02, 0.11, 0.03), roofEdge);
    fascia.position.copy(P(cx, under(half + EAVE) + 0.01, ym + side * (half + EAVE + 0.01)));
    roof.add(fascia);
  }
  // 屋脊盖板
  const ridge = new THREE.Mesh(new THREE.BoxGeometry(lenX + 0.02, 0.05, 0.24), roofEdge);
  ridge.position.copy(P(cx, ridgeH + ROOF_T + 0.03, ym));
  roof.add(ridge);
  // 檐下木椽：两条长边，每 0.6 米一根，从墙面伸到檐口
  const wallFace = half + T / 2 + CLAD;
  const rafterLen = (half + EAVE - wallFace + 0.1) / Math.cos(PITCH);
  const rafterXs: number[] = [];
  for (let x = ix0 - RAKE + 0.18; x <= ix1 + RAKE - 0.18; x += 0.6) rafterXs.push(x);
  const rafters = new THREE.InstancedMesh(new THREE.BoxGeometry(0.05, 0.09, rafterLen), timber, rafterXs.length * 2);
  const o = new THREE.Object3D();
  let ri = 0;
  for (const side of [-1, 1]) {
    const dMid = (wallFace - 0.1 + half + EAVE) / 2;
    for (const x of rafterXs) {
      o.position.copy(P(x, under(dMid) - 0.05, ym + side * dMid));
      o.rotation.set(side < 0 ? PITCH : -PITCH, 0, 0);
      o.updateMatrix();
      rafters.setMatrixAt(ri++, o.matrix);
    }
  }
  rafters.castShadow = true;
  rafters.name = 'rafters';
  const rafterMat = timber.clone();
  rafterMat.transparent = true;
  rafters.material = rafterMat;
  roofMats.push(rafterMat);
  roof.add(rafters);
  // 山墙（两端的三角墙，白色抹灰）+ 斜向封檐（博风板）
  const rakeWood = timberDark.clone();
  rakeWood.transparent = true;
  roofMats.push(rakeWood);
  const gableMat = plaster.clone();
  gableMat.transparent = true;
  roofMats.push(gableMat);
  for (const x of [ix0, ix1]) {
    const shape = new THREE.Shape();
    const y0 = iy0 - T / 2 - CLAD;
    const y1 = iy1 + T / 2 + CLAD;
    shape.moveTo(y0, 0);
    shape.lineTo(y1, 0);
    shape.lineTo(y1, under(wallFace) - H);
    shape.lineTo(ym, ridgeH - H);
    shape.lineTo(y0, under(wallFace) - H);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: T + CLAD * 2, bevelEnabled: false });
    geo.translate(0, 0, -(T + CLAD * 2) / 2);
    // ExtrudeGeometry 的 UV 就是形状坐标（米），抹灰贴图每 1.6 米一张
    const uv = geo.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 1.6, uv.getY(i) / 1.6);
    const gable = new THREE.Mesh(geo, gableMat);
    gable.rotation.y = Math.PI / 2;
    gable.position.set(x, H - 0.005, 0);
    gable.castShadow = true;
    gable.receiveShadow = true;
    roof.add(gable);
    for (const side of [-1, 1]) {
      // 博风板：木色、比檐口封边厚一些，和山墙的木板呼应
      const board = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.17, slope + 0.03), rakeWood);
      const dc = (half + EAVE) / 2;
      board.position.copy(P(x + (x === ix0 ? -RAKE - 0.01 : RAKE + 0.01), under(dc) + ROOF_T / 2, ym + side * dc));
      board.rotation.x = side < 0 ? PITCH : -PITCH;
      roof.add(board);
    }
  }

  // ───────── 屋顶与山墙的细节 ─────────
  const roofWood = timber.clone();
  roofWood.transparent = true;
  const gableWood = new THREE.MeshStandardMaterial({ color: '#9c7552', map: wm.map, normalMap: wm.normalMap, roughness: 0.78, transparent: true });
  const gutterMat = roofEdge;
  roofMats.push(roofWood, gableWood);
  const yWall0 = iy0 - T / 2 - CLAD;
  const yWall1 = iy1 + T / 2 + CLAD;
  const BAND = 0.14; // 山墙下沿的木腰线高度
  for (const x of [ix0, ix1]) {
    const sx = x === ix0 ? -1 : 1;
    const face = x + sx * (T / 2 + CLAD);
    // 木腰线：白墙和木山墙的分界
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.05, BAND, yWall1 - yWall0 + 0.1), roofWood);
    band.position.copy(P(face + sx * 0.025, H + BAND / 2, ym));
    band.castShadow = true;
    roof.add(band);
    // 竖向木板：一整片薄板铺满三角，上面每 0.2 米一根压条（板缝压条）
    const shape = new THREE.Shape();
    shape.moveTo(yWall0, 0);
    shape.lineTo(yWall1, 0);
    shape.lineTo(yWall1, under(wallFace) - H - BAND - 0.02);
    shape.lineTo(ym, ridgeH - H - BAND - 0.02);
    shape.lineTo(yWall0, under(wallFace) - H - BAND - 0.02);
    shape.closePath();
    const boardsGeo = new THREE.ShapeGeometry(shape);
    // 竖纹：木纹贴图的条纹沿 v 变化，这里把 v 设成水平坐标
    const uv = boardsGeo.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getY(i) / 0.9, uv.getX(i) / 0.9);
    const boards = new THREE.Mesh(boardsGeo, gableWood);
    boards.rotation.y = sx < 0 ? -Math.PI / 2 : Math.PI / 2;
    // rotation.y = ±90°：形状的 x（平面 y）落到世界 ∓z；西山墙朝 -x 要镜像，用 scale 修正方向
    if (sx < 0) boards.scale.x = -1;
    boards.position.set(face + sx * 0.008, H + BAND, 0);
    boards.receiveShadow = true;
    roof.add(boards);
    const battenYs: number[] = [];
    for (let y = yWall0 + 0.1; y < yWall1 - 0.05; y += 0.2) battenYs.push(y);
    const battens = new THREE.InstancedMesh(new THREE.BoxGeometry(0.025, 1, 0.035), gableWood, battenYs.length);
    battenYs.forEach((y, i) => {
      const top = under(Math.min(Math.abs(y - ym), wallFace)) - 0.03;
      const h = Math.max(0.01, top - (H + BAND));
      o.position.copy(P(face + sx * 0.02, H + BAND + h / 2, y));
      o.rotation.set(0, 0, 0);
      o.scale.set(1, h, 1);
      o.updateMatrix();
      battens.setMatrixAt(i, o.matrix);
    });
    o.scale.set(1, 1, 1);
    battens.castShadow = true;
    roof.add(battens);
    // 檩条头：屋脊 + 两侧各一根，从山墙伸出到博风板下
    for (const d of [0, half * 0.5]) {
      for (const side of d === 0 ? [0] : [-1, 1]) {
        const len = RAKE + 0.02;
        const beam = new THREE.Mesh(new THREE.BoxGeometry(len, 0.13, 0.1), roofWood);
        beam.position.copy(P(face + sx * (len / 2), under(d) - 0.075, ym + side * d));
        beam.castShadow = true;
        roof.add(beam);
      }
    }
  }
  // 檐沟：两条长边檐口外一道深灰方形檐沟
  for (const side of [-1, 1]) {
    const gutter = new THREE.Mesh(new THREE.BoxGeometry(lenX + 0.04, 0.08, 0.1), gutterMat);
    gutter.position.copy(P(cx, under(half + EAVE) - 0.03, ym + side * (half + EAVE + 0.07)));
    gutter.castShadow = true;
    roof.add(gutter);
  }
  // 南坡两扇天窗（深灰窗框 + 反着天光的玻璃），贴在屋面板上
  const skyGlass = new THREE.MeshStandardMaterial({ color: '#33404c', roughness: 0.06, metalness: 0.6, transparent: true });
  roofMats.push(skyGlass);
  const southSlab = roof.children.find((c) => (c as THREE.Mesh).isMesh && c.rotation.x > 0) as THREE.Mesh;
  for (const x of [ix0 + (ix1 - ix0) * 0.38, ix0 + (ix1 - ix0) * 0.66]) {
    const d = half * 0.5;
    const zl = (d - (half + EAVE) / 2) / Math.cos(PITCH);
    const fr = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.07, 1.0), roofEdge);
    fr.position.set(x - cx, ROOF_T / 2 + 0.03, zl);
    fr.castShadow = true;
    const gl = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.02, 0.9), skyGlass);
    gl.position.set(x - cx, ROOF_T / 2 + 0.065, zl);
    southSlab.add(fr, gl);
  }
  group.add(roof);

  // 落水管：四个角，从檐沟往下斜着收回墙面，再贴墙落到地面（跟着所在的墙一起淡出）
  const pipe = (a: THREE.Vector3, b: THREE.Vector3) => {
    const len = a.distanceTo(b);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, len, 10), gutterMat);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    m.castShadow = true;
    return m;
  };
  for (const side of [-1, 1]) {
    for (const x of [ix0 + 0.18, ix1 - 0.18]) {
      const seg = layout.segments.find((sg) => sg.outward && sg.orient === 'h' && Math.sign(sg.outward[1]) === side && x >= sg.a - 1e-6 && x <= sg.b + 1e-6);
      const g = (seg && segGroup.get(seg.id)) ?? group;
      const yG = ym + side * (half + EAVE + 0.07);
      const yW = ym + side * (wallFace + 0.06);
      const top = under(half + EAVE) - 0.07;
      const a = P(x, top, yG);
      const b = P(x, top - 0.12, yG);
      const c = P(x, top - 0.55, yW);
      const d = P(x, 0.05, yW);
      g.add(pipe(a, b), pipe(b, c), pipe(c, d));
      const shoe = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.1, 10), gutterMat);
      shoe.position.copy(P(x, 0.08, yW));
      g.add(shoe);
    }
  }

  // ───────── 阳台花架 ─────────
  const balcony = cfg.rooms.find((r) => r.outdoor);
  if (balcony) {
    const b = normBounds(balcony);
    const pergola = new THREE.Group();
    pergola.name = 'pergola';
    const ph = H - 0.05;
    for (const y of [b.y0 + 0.08, (b.y0 + b.y1) / 2, b.y1 - 0.08]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, ph, 0.1), timber);
      post.position.copy(P(b.x1 - 0.08, ph / 2, y));
      post.castShadow = true;
      pergola.add(post);
    }
    const header = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.14, b.y1 - b.y0), timber);
    header.position.copy(P(b.x1 - 0.08, ph, (b.y0 + b.y1) / 2));
    pergola.add(header);
    for (let y = b.y0 + 0.15; y < b.y1; y += 0.55) {
      const rafter = new THREE.Mesh(new THREE.BoxGeometry(b.x1 - b.x0 + 0.3, 0.09, 0.05), timberDark);
      rafter.position.copy(P((b.x0 + b.x1) / 2 + 0.1, ph + 0.11, y));
      rafter.castShadow = true;
      pergola.add(rafter);
    }
    group.add(pergola);
  }

  // ───────── 入户门：竖向木板门、黑框壁灯、两级石阶 ─────────
  const entry = layout.openings.find((op) => op.id === 'entry_door');
  const entrySeg = entry && layout.segments.find((sg) => sg.outward && sg.openings.some((op) => op.id === entry.id));
  if (entry && entrySeg) {
    const g = segGroup.get(entrySeg.id)!;
    const sign = entrySeg.orient === 'h' ? entrySeg.outward![1] : entrySeg.outward![0];
    const acr = entrySeg.c + sign * (T / 2 - 0.03);
    // 门板：几块竖向木板，板缝里是深色衬板
    g.add(box(entrySeg, entry.s + 0.02, entry.e - 0.02, 0.01, entry.top - 0.01, acr - sign * 0.01, 0.03, timberDark));
    const planks = 5;
    const w = (entry.e - entry.s - 0.04) / planks;
    for (let i = 0; i < planks; i++) {
      const s = entry.s + 0.02 + i * w + 0.006;
      g.add(box(entrySeg, s, s + w - 0.012, 0.01, entry.top - 0.01, acr, 0.04, doorWood, true));
    }
    // 门把手
    g.add(box(entrySeg, entry.e - 0.12, entry.e - 0.1, 0.95, 1.12, acr + sign * 0.035, 0.03, frame));
    // 雨棚：门上方一块薄板（深灰顶面 + 木底面），两根细钢拉杆斜拉到墙上
    const cy = entry.top + 0.3;
    const cDepth = 0.8;
    const wallOut = entrySeg.c + sign * (T / 2 + CLAD);
    g.add(box(entrySeg, entry.s - 0.35, entry.e + 0.35, cy, cy + 0.05, wallOut + sign * (cDepth / 2), cDepth, frame));
    g.add(box(entrySeg, entry.s - 0.33, entry.e + 0.33, cy - 0.025, cy, wallOut + sign * (cDepth / 2 - 0.01), cDepth - 0.02, timber));
    for (const along of [entry.s - 0.25, entry.e + 0.25]) {
      const a = entrySeg.orient === 'v' ? P(wallOut + sign * (cDepth - 0.06), cy + 0.05, along) : P(along, cy + 0.05, wallOut + sign * (cDepth - 0.06));
      const b = entrySeg.orient === 'v' ? P(wallOut, cy + 0.6, along) : P(along, cy + 0.6, wallOut);
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, a.distanceTo(b), 6), frame);
      rod.position.copy(a).add(b).multiplyScalar(0.5);
      rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      g.add(rod);
    }
    // 壁灯：黑色细框 + 发光的灯罩，挂在门把手一侧
    const along = entry.e + 0.32;
    const lx = entrySeg.c + sign * (T / 2 + CLAD + 0.1);
    const lampGlow = new THREE.MeshStandardMaterial({ color: '#fff1d6', roughness: 0.4, emissive: new THREE.Color(PALETTE.lamp), emissiveIntensity: 0 });
    emissive.push(lampGlow);
    const lamp = new THREE.Group();
    lamp.name = 'wall-lantern';
    const glass = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.24, 0.15), lampGlow);
    lamp.add(glass);
    for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.26, 0.015), frame);
      post.position.set(dx * 0.075, 0, dz * 0.075);
      lamp.add(post);
    }
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.12, 0.07, 4), frame);
    cap.rotation.y = Math.PI / 4;
    cap.position.y = 0.16;
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.03, 0.17), frame);
    base.position.y = -0.13;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.1), frame);
    lamp.add(cap, base, arm);
    if (entrySeg.orient === 'v') {
      lamp.position.copy(P(lx, 1.9, along));
      arm.rotation.y = Math.PI / 2;
      arm.position.set(-sign * 0.09, 0.08, 0);
    } else {
      lamp.position.copy(P(along, 1.9, lx));
      arm.position.set(0, 0.08, sign * 0.09);
    }
    g.add(lamp);
    practicals.push({ position: lamp.position.clone().add(new THREE.Vector3(entrySeg.orient === 'v' ? sign * 0.15 : 0, -0.05, entrySeg.orient === 'h' ? -sign * 0.15 : 0)), color: PALETTE.lamp, intensity: 2.6, distance: 5 });
    // 门外两级石阶（贴着门，往外一级比一级低）
    for (const [i, h, depth] of [[0, 0.06, 0.42], [1, -0.02, 0.4]] as const) {
      const out = T / 2 + CLAD + 0.02 + i * 0.36 + depth / 2;
      const step = new THREE.Mesh(new THREE.BoxGeometry(entrySeg.orient === 'v' ? depth : entry.e - entry.s + 0.5 - i * 0.1, 0.12, entrySeg.orient === 'v' ? entry.e - entry.s + 0.5 - i * 0.1 : depth), stoneMat);
      const c = (entry.s + entry.e) / 2;
      step.position.copy(entrySeg.orient === 'v' ? P(entrySeg.c + sign * out, h - 0.06, c) : P(c, h - 0.06, entrySeg.c + sign * out));
      step.castShadow = step.receiveShadow = true;
      group.add(step);
    }
  }

  // ───────── 阳台推拉门：门洞（door_to_balcony）旁边的玻璃扇画成「拉开」状态，停在固定玻璃外侧 ─────────
  const slideGlass = new THREE.MeshStandardMaterial({ color: '#cfe6f2', roughness: 0.12, transparent: true, opacity: 0.3, depthWrite: false });
  for (const seg of layout.segments) {
    if (!seg.outward) continue;
    const sign = seg.orient === 'h' ? seg.outward[1] : seg.outward[0];
    const g = segGroup.get(seg.id)!;
    for (const op of seg.openings) {
      if (op.kind !== 'door' || op.id === 'entry_door') continue;
      // 门洞紧挨着落地玻璃：往玻璃那一侧拉开
      const glassSide = seg.openings.find((o) => o.kind === 'window' && o.bottom < 0.3 && (Math.abs(o.e - op.s) < 0.05 || Math.abs(o.s - op.e) < 0.05));
      if (!glassSide) continue;
      const w = op.e - op.s;
      const dir = Math.abs(glassSide.e - op.s) < 0.05 ? -1 : 1;
      const s0 = dir < 0 ? op.s - w + 0.04 : op.e - 0.04;
      const acr = seg.c + sign * (T / 2 + CLAD + 0.035);
      const f = 0.045;
      for (const [a, b, y0, y1] of [
        [s0, s0 + f, 0.02, op.top],
        [s0 + w - f, s0 + w, 0.02, op.top],
        [s0, s0 + w, op.top - f, op.top],
        [s0, s0 + w, 0.02, 0.02 + f * 1.6],
      ] as const)
        g.add(box(seg, a, b, y0, y1, acr, 0.035, frame));
      const pane = box(seg, s0 + f, s0 + w - f, 0.02 + f * 1.6, op.top - f, acr, 0.01, slideGlass);
      pane.renderOrder = 1;
      g.add(pane);
      // 上轨：一条细长的深灰滑轨，横跨门洞和停靠位置
      g.add(box(seg, Math.min(s0, op.s) - 0.03, Math.max(s0 + w, op.e) + 0.03, op.top, op.top + 0.05, seg.c + sign * (T / 2 + CLAD + 0.03), 0.07, frame));
    }
  }

  // ───────── 窗下木花箱（窗台高于半米的窗）：木箱 + 一溜叶团 + 几朵小花 ─────────
  const boxLeaf = foliageMaterial(leafCard('planter', [86, 124, 60], 23).map, null);
  const boxBush = bushGeometry(13, 18, 0.22, 0.12);
  for (const seg of layout.segments) {
    if (!seg.outward) continue;
    const sign = seg.orient === 'h' ? seg.outward[1] : seg.outward[0];
    const g = segGroup.get(seg.id)!;
    for (const op of seg.openings) {
      if (op.kind !== 'window' || op.bottom < 0.5) continue;
      const y = op.bottom - 0.06;
      const out = seg.c + sign * (T / 2 + CLAD + 0.11);
      g.add(box(seg, op.s - 0.02, op.e + 0.02, y - 0.18, y, out, 0.2, timber));
      const n = Math.max(2, Math.round((op.e - op.s) / 0.28));
      for (let i = 0; i < n; i++) {
        const along = op.s + ((i + 0.5) / n) * (op.e - op.s);
        const bush = new THREE.Mesh(boxBush, boxLeaf);
        bush.position.copy(seg.orient === 'h' ? P(along, y - 0.04, out) : P(out, y - 0.04, along));
        bush.scale.set(1, 0.8, 0.75);
        bush.rotation.y = i * 1.7;
        g.add(bush);
        const flower = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), new THREE.MeshStandardMaterial({ color: i % 2 ? '#f3c3cb' : '#fbf6ec', roughness: 0.7 }));
        flower.position.copy(bush.position).add(new THREE.Vector3(0.05, 0.16, 0));
        g.add(flower);
      }
    }
  }

  // ───────── 南墙：长椅 + 几缕爬藤（爬藤跟着墙一起淡出） ─────────
  const south = layout.segments.filter((sg) => sg.outward && sg.orient === 'h' && sg.outward[1] < 0);
  const vineMat = new THREE.MeshStandardMaterial({ map: leafCard('vine', [78, 112, 56], 17).map, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.85 });
  for (const sg of south) {
    const across = sg.c - (T / 2 + CLAD);
    const midX = (sg.a + sg.b) / 2;
    if (sg.b - sg.a > 3) {
      const benchX = midX + 0.4;
      const seat = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.06, 0.38), timber);
      seat.position.copy(P(benchX, 0.44, across - 0.3));
      const back = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.32, 0.05), timber);
      back.position.copy(P(benchX, 0.72, across - 0.08));
      seat.castShadow = back.castShadow = true;
      group.add(seat, back);
      for (const dx of [-0.58, 0.58]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.42, 0.34), timberDark);
        leg.position.copy(P(benchX + dx, 0.21, across - 0.3));
        group.add(leg);
      }
    }
    // 爬藤：靠西头的一段墙上 7 缕，从地面往上爬 1.6～2.5 米，叶子越往上越小
    const strands = 7;
    const perStrand = 34;
    const vine = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), vineMat, strands * perStrand);
    let k = 0;
    for (let sIdx = 0; sIdx < strands; sIdx++) {
      const x0 = sg.a + 0.5 + sIdx * 0.22 + Math.sin(sIdx * 7.1) * 0.06;
      const top = 1.6 + Math.abs(Math.sin(sIdx * 3.7)) * 0.9;
      for (let i = 0; i < perStrand; i++) {
        const u = i / perStrand;
        const size = 0.2 - 0.08 * u;
        o.position.copy(P(x0 + Math.sin(u * 9 + sIdx) * 0.06, 0.12 + u * top, across - 0.03 - (i % 3) * 0.015));
        o.rotation.set(Math.sin(i * 1.7) * 0.4, Math.PI + Math.sin(i * 3.1) * 0.4, Math.sin(i * 0.9 + sIdx) * Math.PI);
        o.scale.setScalar(size);
        o.updateMatrix();
        vine.setMatrixAt(k++, o.matrix);
      }
    }
    vine.castShadow = true;
    vine.name = 'vine';
    (segGroup.get(sg.id) ?? group).add(vine);
    // 藤后面一片细木格栅（藤就是顺着它爬上去的）
    const tx0 = sg.a + 0.3;
    const tx1 = sg.a + 0.5 + (strands - 1) * 0.22 + 0.2;
    const lathMat = timber;
    const tg = segGroup.get(sg.id) ?? group;
    for (let x = tx0; x <= tx1 + 1e-6; x += (tx1 - tx0) / 5) tg.add(box(sg, x - 0.0125, x + 0.0125, 0.35, 2.35, across - 0.015, 0.02, lathMat));
    for (let y = 0.5; y <= 2.3; y += 0.3) tg.add(box(sg, tx0 - 0.04, tx1 + 0.04, y - 0.0125, y + 0.0125, across - 0.03, 0.02, lathMat));
    // 长椅两侧两盏上下出光的筒灯（只发光、不打光，夜里墙上两团暖光）
    if (sg.b - sg.a > 3) {
      for (const dx of [-1.05, 1.05]) {
        const lx = midX + 0.4 + dx;
        const sconce = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.22, 16), frame);
        sconce.position.copy(P(lx, 1.95, across - 0.07));
        const glowM = new THREE.MeshStandardMaterial({ color: '#fff1d6', emissive: new THREE.Color(PALETTE.lamp), emissiveIntensity: 0, roughness: 0.4 });
        emissive.push(glowM);
        for (const dy of [-0.112, 0.112]) {
          const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.006, 16), glowM);
          ring.position.copy(sconce.position).add(new THREE.Vector3(0, dy, 0));
          tg.add(ring);
        }
        tg.add(sconce);
      }
    }
  }

  const setOpen = (k: number) => {
    const e = k * k * (3 - 2 * k);
    roof.position.y = e * 1.2;
    roof.visible = e < 0.999;
    for (const m of roofMats) {
      m.opacity = 1 - e;
      m.depthWrite = e < 0.02;
    }
  };
  setOpen(0);

  return { group, roof, claddingBySegment, setOpen, practicals, emissive };
}
