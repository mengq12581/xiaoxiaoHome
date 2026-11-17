// 美术方向概念样张（开发用页面：npm run dev 后打开 /concept.html）。
// 用现有的房子、家具、笑笑，加上新做的小岛、湖面、天空、外观和室内软装，
// 在几种时间、几个固定机位下出图，给「定美术方向」做比较（docs/art/美术方向.md）。
// 不进打包产物；确定方向后，这些模块再正式接进主场景。

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { HorizontalTiltShiftShader } from 'three/examples/jsm/shaders/HorizontalTiltShiftShader.js';
import { VerticalTiltShiftShader } from 'three/examples/jsm/shaders/VerticalTiltShiftShader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { loadConfig } from '../config/load';
import { buildHouse, P } from '../scene/house';
import { buildFurniture } from '../scene/furniture';
import { houseBounds } from '../scene/layout';
import { buildCharacter } from '../character/model';
import { preloadGltfCharacter } from '../character/gltfModel';
import { CharacterAgent } from '../character/agent';
import { Pathfinder, furnitureObstacles, wallObstacles } from '../nav/pathfinder';
import { indexAnchors } from '../scene/anchors';
import { buildIsland } from '../world/island';
import { buildWater } from '../world/water';
import { buildSky } from '../world/sky';
import { buildVegetation } from '../world/vegetation';
import { buildExterior } from '../world/exterior';
import { buildInteriorDecor } from '../world/interiorDecor';
import { LIGHTING, type TimeOfDay } from '../world/palette';
import type { Vec2 } from '../config/types';

const app = document.getElementById('app')!;

async function boot() {
  const cfg = loadConfig();
  const spec = cfg.characters.characters.find((c) => c.id === cfg.characters.active)!;
  await preloadGltfCharacter(spec);

  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(app.clientWidth, app.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  app.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  // ───────── 房子、家具、人物 ─────────
  const house = buildHouse(cfg.rooms);
  scene.add(house.root);
  const furniture = cfg.furniture.items.map(buildFurniture);
  for (const f of furniture) scene.add(f.group);
  const hb = houseBounds(cfg.rooms);
  const entry = cfg.rooms.rooms.flatMap((r) => r.doors).find((d) => d.id === 'entry_door');
  const door: Vec2 = entry ? [entry.at[0] - 0.6, entry.at[1]] : [hb.x0 - 0.6, (hb.y0 + hb.y1) / 2];

  const island = buildIsland({ house: hb, door, pierHeading: 200 });
  scene.add(island.mesh);
  const water = buildWater(island);
  scene.add(water.mesh);
  const center = P(island.center[0], 0, island.center[1]);
  const sky = buildSky(center);
  scene.add(sky.group);
  const veg = buildVegetation(island, hb);
  scene.add(veg.group);
  const exterior = buildExterior(cfg.rooms);
  scene.add(exterior.group);
  const decor = buildInteriorDecor(cfg.rooms, cfg.furniture.items);
  scene.add(decor.group);

  const character = buildCharacter(spec);
  scene.add(character.root);
  const pf = new Pathfinder(cfg.rooms.nav.nodes, cfg.rooms.nav.edges, [...wallObstacles(cfg.rooms), ...furnitureObstacles(cfg.furniture.items)]);
  const agent = new CharacterAgent(character, pf, spec.spawn ?? cfg.rooms.nav.nodes[0], -90);
  const anchors = indexAnchors(cfg.furniture.items);
  for (let i = 0; i < 30; i++) agent.update(1 / 30);

  // ───────── 光 ─────────
  const hemi = new THREE.HemisphereLight();
  const sun = new THREE.DirectionalLight();
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -17;
  sc.right = sc.top = 17;
  sc.near = 1;
  sc.far = 80;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 3;
  sun.target.position.copy(center);
  scene.add(hemi, sun, sun.target);
  const lamps = [...veg.practicals, ...decor.practicals, ...exterior.practicals].map((pr) => {
    const l = new THREE.PointLight(pr.color, pr.intensity, pr.distance, 2);
    l.position.copy(pr.position);
    scene.add(l);
    return { l, base: pr.intensity };
  });
  const glows = [...veg.emissive, ...decor.emissive, ...exterior.emissive];
  const glass: THREE.MeshStandardMaterial[] = [];
  house.root.traverse((o) => {
    if (o.name === 'glass') glass.push((o as THREE.Mesh).material as THREE.MeshStandardMaterial);
  });
  const glassBase = glass.map((m) => ({ color: m.color.clone(), opacity: m.opacity }));

  let time: TimeOfDay = 'day';
  const setTime = (t: TimeOfDay) => {
    time = t;
    const p = LIGHTING[t];
    renderer.toneMappingExposure = p.exposure;
    hemi.color.set(p.hemiSky);
    hemi.groundColor.set(p.hemiGround);
    hemi.intensity = p.hemiIntensity;
    scene.environmentIntensity = p.envIntensity;
    const az = (p.sunAzimuth * Math.PI) / 180;
    const el = (p.sunElevation * Math.PI) / 180;
    const dir = new THREE.Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), -Math.sin(az) * Math.cos(el));
    sun.position.copy(center).addScaledVector(dir, 40);
    sun.color.set(p.sunColor);
    sun.intensity = p.sunIntensity;
    sun.castShadow = p.sunShadow;
    scene.fog = new THREE.Fog(p.fog.color, p.fog.near, p.fog.far);
    sky.setLighting(p, dir);
    water.setLighting(p, dir);
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

  // ───────── 剖开：隐藏朝向镜头的墙（连同外墙贴面和内墙漆） ─────────
  const wallsBySeg = new Map(house.walls.map((w) => [w.segment.id, w.group] as const));
  const cutaway = (test: (seg: (typeof house.walls)[number]['segment']) => boolean) => {
    for (const w of house.walls) {
      const hide = test(w.segment);
      w.group.visible = !hide;
      const clad = exterior.claddingBySegment.get(w.segment.id);
      if (clad) clad.visible = !hide;
      const paint = decor.paintBySegment.get(w.segment.id);
      if (paint) paint.visible = !hide;
    }
    house.root.traverse((o) => {
      // 门窗框跟着所在的墙一起隐藏
      if (o.name.startsWith('window:') || o.name.startsWith('door:')) {
        const seg = house.walls.find((w) => w.segment.openings.some((op) => o.name.endsWith(op.id)));
        if (seg) o.visible = wallsBySeg.get(seg.segment.id)!.visible;
      }
    });
  };

  // ───────── 相机与后期 ─────────
  const camera = new THREE.PerspectiveCamera(32, app.clientWidth / app.clientHeight, 0.3, 1200);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(center);
  const view = (azDeg: number, polarDeg: number, dist: number, target: Vec2 = island.center, h = 0.5, fov = 32) => {
    camera.fov = fov;
    camera.updateProjectionMatrix();
    const t = P(target[0], h, target[1]);
    const a = (azDeg * Math.PI) / 180;
    const p = (polarDeg * Math.PI) / 180;
    camera.position.set(t.x + dist * Math.sin(p) * Math.cos(a), t.y + dist * Math.cos(p), t.z - dist * Math.sin(p) * Math.sin(a));
    controls.target.copy(t);
    camera.lookAt(t);
    controls.update();
  };

  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(app.clientWidth, app.clientHeight, { type: THREE.HalfFloatType, samples: 4 }));
  composer.addPass(new RenderPass(scene, camera));
  const gtao = new GTAOPass(scene, camera, app.clientWidth, app.clientHeight);
  gtao.blendIntensity = 0.9;
  gtao.updateGtaoMaterial({ radius: 0.5, distanceExponent: 1.2, thickness: 1, scale: 1.3, samples: 12 });
  const gtaoRender = gtao.render.bind(gtao);
  gtao.render = (...args: Parameters<GTAOPass['render']>) => {
    const hide = [water.mesh, sky.group].filter((o) => o.visible);
    const bg = scene.background;
    scene.background = null;
    for (const o of hide) o.visible = false;
    gtaoRender(...args);
    for (const o of hide) o.visible = true;
    scene.background = bg;
  };
  composer.addPass(gtao);
  const hTilt = new ShaderPass(HorizontalTiltShiftShader);
  const vTilt = new ShaderPass(VerticalTiltShiftShader);
  composer.addPass(hTilt);
  composer.addPass(vTilt);
  composer.addPass(new OutputPass());
  /** 移轴：focus = 清晰带在画面上的位置（0 底 ～ 1 顶），amount = 两端最大模糊 */
  const setTilt = (on: boolean, focus = 0.5, amount = 2.2) => {
    hTilt.enabled = vTilt.enabled = on;
    hTilt.uniforms.h.value = amount / app.clientWidth;
    vTilt.uniforms.v.value = amount / app.clientHeight;
    hTilt.uniforms.r.value = vTilt.uniforms.r.value = focus;
  };
  setTilt(false);

  const setRoof = (k: number) => exterior.setOpen(k);

  const sitAt = (key: string, seconds = 20) => {
    const seat = anchors.seats.get(key);
    if (!seat) return;
    agent.sitAt(seat);
    for (let t = 0; t < seconds; t += 1 / 30) agent.update(1 / 30);
  };
  const standAt = (p: Vec2, heading: number) => {
    agent.standAt(p, heading);
    for (let t = 0; t < 25; t += 1 / 30) agent.update(1 / 30);
  };

  const render = () => {
    water.update(1 / 60);
    composer.render();
  };
  setTime('day');
  view(225, 58, 34);

  const loop = () => {
    controls.update();
    render();
    requestAnimationFrame(loop);
  };
  if (!new URLSearchParams(location.search).has('still')) loop();

  const api = {
    setTime,
    setRoof,
    setTilt,
    view,
    cutaway,
    sitAt,
    standAt,
    render,
    get time() {
      return time;
    },
    capture(): string {
      render();
      return renderer.domElement.toDataURL('image/png');
    },
    stats() {
      let tris = 0;
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !m.visible) return;
        const g = m.geometry;
        const n = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
        tris += n * ((o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh).count : 1);
      });
      return { tris: Math.round(tris), calls: renderer.info.render.calls, textures: renderer.info.memory.textures };
    },
  };
  (window as unknown as { __concept: typeof api }).__concept = api;
}

void boot();
