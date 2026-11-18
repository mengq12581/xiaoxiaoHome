// 屋外世界的总装：小岛、湖面（实时倒影）、天空（物理天空 + 由它生成的环境光照）、植被、房子外观、室内软装、
// 太阳 / 月亮与夜里的灯。主场景（src/main.ts）和样张页（src/concept/main.ts）共用这一份。
//
// 每帧要做的事都在 update() 里：
//   - 阴影范围跟着相机：拉近时只罩住房子（影子清楚），拉远时罩住整个岛；
//   - 屋顶随距离开合（远看盖着，拉近看屋里时抬起淡出）；
//   - 外墙贴面、内墙漆跟着透明墙一起淡出；屋顶盖着时不剖墙；
//   - 树挡住她或房间时变成稀疏网点；风。

import * as THREE from 'three';
import type { FurnitureItem, RoomsConfig, Vec2 } from '../config/types';
import { P, type HouseView } from '../scene/house';
import { houseBounds } from '../scene/layout';
import { buildExterior, type Exterior } from './exterior';
import { makeFadeable, type FadeFn } from './fadeable';
import { buildInteriorDecor, type InteriorDecor } from './interiorDecor';
import { buildIsland, type Island } from './island';
import { LIGHTING, type TimeOfDay } from './palette';
import { buildSky, type Sky } from './sky';
import { buildVegetation, type Vegetation } from './vegetation';
import { buildWater, type Water } from './water';

/** 相机拉近到这个距离以内掀开屋顶、拉远到这个距离以外盖上（米）；中间保持原状，避免在临界处来回闪 */
export const ROOF_OPEN_DISTANCE = 20;
export const ROOF_CLOSED_DISTANCE = 23;
/** 屋顶开合动画：每秒走完的比例（约 0.4 秒开 / 合） */
const ROOF_SPEED = 2.5;

export interface WorldUpdate {
  camera: THREE.Camera;
  /** 相机看向的点（阴影范围以它为中心） */
  target: THREE.Vector3;
  /** 需要保持可见的点（她、各房间采样点）：树挡住这些点就淡出 */
  keepVisible: THREE.Vector3[];
  /** 屋顶开合（0～1，立即生效）：不传则按相机距离自动开合（带动画） */
  roofOpen?: number;
}

export interface World {
  center: THREE.Vector3;
  island: Island;
  water: Water;
  sky: Sky;
  vegetation: Vegetation;
  exterior: Exterior;
  decor: InteriorDecor;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  readonly time: TimeOfDay;
  /** 当前屋顶开合（0 盖着 ～ 1 掀开） */
  readonly roofOpen: number;
  setTime(t: TimeOfDay): void;
  update(dt: number, u: WorldUpdate): void;
  /**
   * 外墙贴面、内墙漆跟着墙的透明度走（walls 来自 HouseView）。
   * wallOpacity：墙段 id → 当前不透明度；fadeOpacity：墙透明到底时的不透明度。
   */
  syncWalls(wallOpacity: (segId: string) => number, fadeOpacity: number): void;
  /** 不参与环境光遮蔽的物体（湖面、天空） */
  aoExclude(): THREE.Object3D[];
  setSize(w: number, h: number): void;
}

export function buildWorld(renderer: THREE.WebGLRenderer, scene: THREE.Scene, rooms: RoomsConfig, items: FurnitureItem[], house: HouseView): World {
  const hb = houseBounds(rooms);
  const entry = rooms.rooms.flatMap((r) => r.doors).find((d) => d.id === 'entry_door');
  const door: Vec2 = entry ? [entry.at[0] - 0.6, entry.at[1]] : [hb.x0 - 0.6, (hb.y0 + hb.y1) / 2];

  const island = buildIsland({ house: hb, door, pierHeading: 200 });
  const water = buildWater(island);
  const center = P(island.center[0], 0, island.center[1]);
  const sky = buildSky(center);
  const indoorX1 = Math.max(...rooms.rooms.filter((r) => !r.outdoor).map((r) => Math.max(r.bounds[0][0], r.bounds[1][0])));
  const vegetation = buildVegetation(island, hb, indoorX1);
  const exterior = buildExterior(rooms);
  const decor = buildInteriorDecor(rooms, items);
  scene.add(island.mesh, water.mesh, sky.group, vegetation.group, exterior.group, decor.group);

  // ───────── 光 ─────────
  const hemi = new THREE.HemisphereLight();
  const sun = new THREE.DirectionalLight();
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 3;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 90;
  scene.add(hemi, sun, sun.target);
  const lamps = [...vegetation.practicals, ...decor.practicals, ...exterior.practicals].map((pr) => {
    const l = new THREE.PointLight(pr.color, pr.intensity, pr.distance, 2);
    l.position.copy(pr.position);
    scene.add(l);
    return { l, base: pr.intensity };
  });
  const glows = [...vegetation.emissive, ...decor.emissive, ...exterior.emissive];
  const glass = house.glass.flatMap((o) => {
    const out: THREE.MeshStandardMaterial[] = [];
    o.traverse((c) => {
      const m = (c as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (m && m.isMeshStandardMaterial && !out.includes(m)) out.push(m);
    });
    return out;
  });
  const glassBase = glass.map((m) => ({ color: m.color.clone(), opacity: m.opacity }));

  const pmrem = new THREE.PMREMGenerator(renderer);
  let envRT: THREE.WebGLRenderTarget | null = null;
  const sunDir = new THREE.Vector3(0, 1, 0);
  let time: TimeOfDay = 'day';

  const setTime = (t: TimeOfDay) => {
    time = t;
    const p = LIGHTING[t];
    renderer.toneMappingExposure = p.exposure;
    hemi.color.set(p.hemiSky);
    hemi.groundColor.set(p.hemiGround);
    hemi.intensity = p.hemiIntensity;
    const az = (p.sunAzimuth * Math.PI) / 180;
    const el = (p.sunElevation * Math.PI) / 180;
    sunDir.set(Math.cos(az) * Math.cos(el), Math.sin(el), -Math.sin(az) * Math.cos(el));
    sun.color.set(p.sunColor);
    sun.intensity = p.sunIntensity;
    sun.castShadow = p.sunShadow;
    scene.fog = new THREE.Fog(p.fog.color, p.fog.near, p.fog.far);
    sky.setLighting(p, sunDir);
    water.setLighting(p, sunDir);
    // 环境光照从这片天空生成：墙、树、人身上的天光颜色和天色一致
    envRT?.dispose();
    envRT = pmrem.fromScene(sky.envScene, 0, 0.1, 1000);
    scene.environment = envRT.texture;
    scene.environmentIntensity = p.envIntensity;
    for (const { l, base } of lamps) {
      l.visible = p.practicals;
      l.intensity = base * (t === 'night' ? 1 : 0.6);
    }
    for (const m of glows) m.emissiveIntensity = p.practicals ? (t === 'night' ? 2.2 : 1.2) : 0;
    // 夜里从屋外看，窗玻璃透出暖光
    glass.forEach((m, i) => {
      if (t === 'night') {
        m.color.set('#ffcf8f');
        m.emissive.set('#ffb46b');
        m.emissiveIntensity = 0.55;
        m.opacity = 0.75;
      } else {
        m.color.copy(glassBase[i].color);
        m.emissiveIntensity = 0;
        m.opacity = glassBase[i].opacity;
      }
    });
  };

  // 外墙贴面、内墙漆：按墙段可淡出
  const cladFade = new Map<string, FadeFn>();
  for (const [id, g] of exterior.claddingBySegment) cladFade.set(id, makeFadeable(g));
  const paintFade = new Map<string, FadeFn>();
  for (const [id, g] of decor.paintBySegment) paintFade.set(id, makeFadeable(g));

  // 透明度裁切的叶片 / 花卡片：环境光遮蔽的法线 / 深度通道不认裁切，会把整张卡片当成实心方块，
  // 在后面的墙上压出一块块亮斑，所以不参与环境光遮蔽
  const alphaCut: THREE.Object3D[] = [];
  for (const root of [vegetation.group, exterior.group]) {
    root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if ((o as THREE.Mesh).isMesh && m && !Array.isArray(m) && m.alphaTest > 0) alphaCut.push(o);
    });
  }

  let roofOpen = 0;
  let roofGoal = 0;
  exterior.setOpen(0);
  const snap = new THREE.Vector3();
  let shadowHalf = 0;

  return {
    center,
    island,
    water,
    sky,
    vegetation,
    exterior,
    decor,
    sun,
    hemi,
    get time() {
      return time;
    },
    get roofOpen() {
      return roofOpen;
    },
    setTime,
    update(dt, u) {
      water.update(dt);
      const camPos = u.camera.getWorldPosition(new THREE.Vector3());
      const dist = camPos.distanceTo(u.target);
      // 屋顶：不停在半透明的中间状态，到距离就整片开 / 合
      if (dist < ROOF_OPEN_DISTANCE) roofGoal = 1;
      else if (dist > ROOF_CLOSED_DISTANCE) roofGoal = 0;
      const k = u.roofOpen ?? roofOpen + THREE.MathUtils.clamp(roofGoal - roofOpen, -dt * ROOF_SPEED, dt * ROOF_SPEED);
      if (Math.abs(k - roofOpen) > 1e-4) {
        roofOpen = k;
        exterior.setOpen(k);
      }
      // 树：屋顶掀开、在看屋里时，挡住她或房间的树才淡出；远看全岛时树就是风景
      vegetation.update(dt, u.camera, roofOpen > 0.3 ? u.keepVisible : []);
      // 阴影范围：近时 7 米（影子清楚），远时 18 米罩住整个岛；按 1 米一档变，中心对齐阴影贴图像素，拉动时影子不抖
      const half = THREE.MathUtils.clamp(Math.round(dist * 0.55), 8, 19);
      const sc = sun.shadow.camera;
      if (half !== shadowHalf) {
        shadowHalf = half;
        sc.left = sc.bottom = -half;
        sc.right = sc.top = half;
        sc.updateProjectionMatrix();
      }
      const texel = (2 * half) / sun.shadow.mapSize.x;
      const focus = u.target.clone().lerp(center, THREE.MathUtils.smoothstep(dist, 12, 30));
      snap.set(Math.round(focus.x / texel) * texel, 0, Math.round(focus.z / texel) * texel);
      sun.target.position.copy(snap);
      sun.position.copy(snap).addScaledVector(sunDir, 45);
    },
    syncWalls(wallOpacity, fadeOpacity) {
      const span = Math.max(1e-3, 1 - fadeOpacity);
      for (const [id, f] of cladFade) f(THREE.MathUtils.clamp((wallOpacity(id) - fadeOpacity) / span, 0, 1));
      for (const [id, f] of paintFade) f(THREE.MathUtils.clamp((wallOpacity(id) - fadeOpacity) / span, 0, 1));
    },
    aoExclude: () => [water.mesh, sky.group, ...alphaCut],
    setSize(w, h) {
      water.setSize(w, h);
    },
  };
}
