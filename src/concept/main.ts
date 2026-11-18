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
import { loadConfig } from '../config/load';
import { buildHouse, P } from '../scene/house';
import { buildFurniture } from '../scene/furniture';
import { buildCharacter } from '../character/model';
import { preloadGltfCharacter } from '../character/gltfModel';
import { CharacterAgent } from '../character/agent';
import { Pathfinder, furnitureObstacles, wallObstacles } from '../nav/pathfinder';
import { indexAnchors } from '../scene/anchors';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { buildWorld } from '../world/world';
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
  const tm = new URLSearchParams(location.search).get('tm');
  renderer.toneMapping = tm === 'agx' ? THREE.AgXToneMapping : tm === 'aces' ? THREE.ACESFilmicToneMapping : THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  app.appendChild(renderer.domElement);

  const scene = new THREE.Scene();

  // ───────── 房子、家具、人物 ─────────
  const house = buildHouse(cfg.rooms);
  scene.add(house.root);
  const furniture = cfg.furniture.items.map(buildFurniture);
  for (const f of furniture) scene.add(f.group);
  const world = buildWorld(renderer, scene, cfg.rooms, cfg.furniture.items, house);
  const { island, water, exterior, decor, center } = world;

  const character = buildCharacter(spec);
  scene.add(character.root);
  const pf = new Pathfinder(cfg.rooms.nav.nodes, cfg.rooms.nav.edges, [...wallObstacles(cfg.rooms), ...furnitureObstacles(cfg.furniture.items)]);
  const agent = new CharacterAgent(character, pf, spec.spawn ?? cfg.rooms.nav.nodes[0], -90);
  const anchors = indexAnchors(cfg.furniture.items);
  for (let i = 0; i < 30; i++) agent.update(1 / 30);

  const setTime = (t: TimeOfDay) => {
    world.setTime(t);
    bloom.enabled = LIGHTING[t].practicals;
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
    const hide = world.aoExclude().filter((o) => o.visible);
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
  const bloom = new UnrealBloomPass(new THREE.Vector2(app.clientWidth / 2, app.clientHeight / 2), 0.35, 0.5, 1.1);
  composer.addPass(bloom);
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

  /** 屋顶开合；不传 = 按距离自动 */
  const setRoof = (k?: number) => {
    roof = k;
  };

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

  water.setSize(app.clientWidth, app.clientHeight);
  let roof: number | undefined;
  const keep = () => [...house.roomSamples, P(agent.position[0], 0.82 * character.scale, agent.position[1])];
  const render = () => {
    world.update(1 / 60, { camera, target: controls.target, keepVisible: keep(), roofOpen: roof });
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
    setReflection: (on: boolean) => water.setReflection(on),
    world,
    setTilt,
    view,
    cutaway,
    sitAt,
    standAt,
    render,
    get time() {
      return world.time;
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
