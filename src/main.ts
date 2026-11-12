import * as THREE from 'three';
import { loadConfig } from './config/load';
import { ConfigError } from './config/validate';
import type { AppConfig, Vec2 } from './config/types';
import { buildHouse, P } from './scene/house';
import { buildFurniture } from './scene/furniture';
import { CameraRig } from './scene/cameraRig';
import { createPipeline, createRenderer, setupLighting } from './scene/lookdev';
import { WallFader } from './scene/wallFade';
import { indexAnchors } from './scene/anchors';
import { Pathfinder, furnitureObstacles, wallObstacles } from './nav/pathfinder';
import { buildCharacter } from './character/model';
import { CharacterAgent, type LogFn } from './character/agent';
import { ContactShadow } from './character/contactShadow';
import { createHud, showConfigErrors } from './ui/hud';
import { createDevPanel } from './ui/devPanel';

const app = document.getElementById('app')!;

function boot(cfg: AppConfig) {
  const renderer = createRenderer(app);

  const scene = new THREE.Scene();

  // 房子
  const house = buildHouse(cfg.rooms);
  scene.add(house.root);

  // 家具
  const furniture = cfg.furniture.items.map(buildFurniture);
  for (const f of furniture) scene.add(f.group);

  // 背景、环境光照、主光、地台（风格基线见 scene/lookdev.ts）
  const center = house.box.getCenter(new THREE.Vector3());
  const radius = house.box.getSize(new THREE.Vector3()).setY(0).length() / 2;
  setupLighting(renderer, scene, center, radius);

  // 角色（v0.1 只有一个 active 角色）
  const spec = cfg.characters.characters.find((c) => c.id === cfg.characters.active)!;
  const character = buildCharacter(spec);
  scene.add(character.root);

  // 寻路与走位
  const pathfinder = new Pathfinder(cfg.rooms.nav.nodes, cfg.rooms.nav.edges, [
    ...wallObstacles(cfg.rooms),
    ...furnitureObstacles(cfg.furniture.items),
  ]);
  if (pathfinder.blockedNodes.length || pathfinder.blockedEdges.length) {
    console.warn('[nav] 以下导航点/边被墙或家具挡住，已停用', {
      nodes: pathfinder.blockedNodes,
      edges: pathfinder.blockedEdges,
    });
  }
  const log: LogFn = (level, msg, data) => {
    (level === 'warn' ? console.warn : console.info)(`[agent:${spec.id}] ${msg}`, data ?? '');
  };
  const spawn: Vec2 = spec.spawn ?? cfg.rooms.nav.nodes[0];
  const agent = new CharacterAgent(character, pathfinder, spawn, -90, { log });
  const anchors = indexAnchors(cfg.furniture.items);
  const contact = new ContactShadow(character.scale);
  scene.add(contact.group);
  const syncContact = () =>
    contact.update(agent.position, character.root.rotation.y, agent.sitWeight, agent.seatHeight);
  syncContact();

  // 墙体遮挡检测用 matrixWorld 做射线；首帧渲染前就要算好，否则第一次检测全打偏
  scene.updateMatrixWorld(true);

  // 相机与墙体遮挡
  const rig = new CameraRig(renderer.domElement, cfg.camera, house.box);
  const headPoint = () => P(agent.position[0], 0.82 * character.scale, agent.position[1]);
  rig.setFocus(headPoint);
  const fader = new WallFader(house.walls, cfg.camera);
  // 遮挡检测落点：各房间地面采样点 + 角色头部与身体
  const fadeTargets = () => [
    ...house.roomSamples,
    headPoint(),
    P(agent.position[0], 0.35 * character.scale, agent.position[1]),
  ];

  // 后期：正在透明的墙、玻璃、贴地影子不参与环境光遮蔽
  const pipeline = createPipeline(renderer, scene, rig.camera, () => [
    ...house.walls.filter((w) => w.opacity < 0.98).map((w) => w.group),
    ...house.glass,
    contact.group,
  ]);

  const hud = createHud(app, 'v0.1 · M2 角色与走位');
  hud.onReset(() => rig.reset());

  const onResize = () => {
    renderer.setSize(app.clientWidth, app.clientHeight);
    pipeline.setSize(app.clientWidth, app.clientHeight);
    rig.resize(app.clientWidth, app.clientHeight);
  };
  window.addEventListener('resize', onResize);
  onResize();

  // 开发态：路径显示 + 走位演示面板
  const pathLine = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineDashedMaterial({ color: 0xc98b6b, dashSize: 0.12, gapSize: 0.08, depthTest: false }),
  );
  pathLine.renderOrder = 5;
  pathLine.visible = false;
  scene.add(pathLine);
  let shownPath: Vec2[] = [];
  const syncPathLine = () => {
    if (agent.path === shownPath) return;
    shownPath = agent.path;
    pathLine.visible = import.meta.env.DEV && shownPath.length > 1;
    if (!pathLine.visible) return;
    // setFromPoints 会复用旧缓冲区，点数变少时出错，所以每次换新几何体
    pathLine.geometry.dispose();
    pathLine.geometry = new THREE.BufferGeometry().setFromPoints(shownPath.map(([x, y]) => P(x, 0.03, y)));
    pathLine.computeLineDistances();
  };

  const seat = (key: string) => anchors.seats.get(key)!;
  const stand = (key: string) => anchors.stands.get(key)!;
  const devPanel = import.meta.env.DEV
    ? createDevPanel(app, 'M2 走位演示（开发态；M3 起由状态驱动）', [
        { label: '走到卧室床边', run: () => agent.walkTo(seat('bed:bed_lie').approach) },
        { label: '坐电脑椅', run: () => agent.sitAt(seat('desk:desk_seat')) },
        { label: '坐沙发', run: () => agent.sitAt(seat('sofa:sofa_seat')) },
        { label: '客厅窗边', run: () => { const s = stand('living_window_spot:window_stand'); agent.standAt(s.plan, s.headingDeg); } },
        { label: '卧室窗边', run: () => { const s = stand('bedroom_window_spot:window_stand'); agent.standAt(s.plan, s.headingDeg); } },
        { label: '站起来', run: () => agent.standUp() },
        { label: '无解测试', run: () => agent.walkTo(cfg.furniture.items.find((i) => i.id === 'wardrobe')!.position) },
        { label: '镜头看她', run: () => rig.setView(rig.view.azimuthDeg, 55, cfg.camera.minDistance) },
      ])
    : null;

  // 主循环
  const clock = new THREE.Clock();
  let frames = 0;
  let fpsTime = 0;
  let fps = 0;
  const renderFrame = (dt: number) => {
    agent.update(dt);
    syncContact();
    syncPathLine();
    rig.update();
    fader.update(rig.camera, fadeTargets(), dt);
    pipeline.render();
    pipeline.reportFrame(dt);
  };
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    renderFrame(dt);
    frames++;
    fpsTime += dt;
    if (fpsTime >= 0.5) {
      fps = Math.round(frames / fpsTime);
      frames = 0;
      fpsTime = 0;
      const v = rig.view;
      hud.setStats(
        `${fps} fps · 方位 ${v.azimuthDeg.toFixed(0)}° · 俯仰 ${v.polarDeg.toFixed(0)}° · 距离 ${v.distance.toFixed(1)} m · 透明墙 ${fader.occluding.size}`,
      );
      devPanel?.setStatus(
        `${spec.name}：${agent.state} · (${agent.position[0].toFixed(2)}, ${agent.position[1].toFixed(2)}) · ${agent.headingDeg.toFixed(0)}°`,
      );
    }
  });

  let triangles = 0;
  scene.traverse((o) => {
    const g = (o as THREE.Mesh).isMesh ? (o as THREE.Mesh).geometry : null;
    if (g) triangles += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  });
  console.info(
    `[scene] 房间 ${cfg.rooms.rooms.length} 个，墙段 ${house.walls.length} 段，家具 ${furniture.length} 件，角色 ${spec.name}，三角面约 ${Math.round(triangles)}`,
  );

  // 开发态调试句柄（docs/验收问题.md B7）
  if (import.meta.env.DEV) {
    const debug = {
      cfg,
      scene,
      rig,
      fader,
      pipeline,
      renderer,
      agent,
      anchors,
      pathfinder,
      character,
      setView: (az: number, polar: number, dist: number) => {
        rig.setView(az, polar, dist);
        // 跳过渐变，直接到位，便于截图
        for (let i = 0; i < 30; i++) fader.update(rig.camera, fadeTargets(), 0.1);
      },
      /** 后台标签页没有动画帧时，用固定步长推进角色（秒） */
      simulate(seconds: number, until?: () => boolean) {
        const dt = 1 / 60;
        let t = 0;
        for (; t < seconds; t += dt) {
          agent.update(dt);
          if (until?.()) break;
        }
        syncContact();
        syncPathLine();
        rig.update();
        for (let i = 0; i < 30; i++) fader.update(rig.camera, fadeTargets(), 0.1);
        return { t: +t.toFixed(2), state: agent.state, pos: agent.position.map((v) => +v.toFixed(3)), heading: +agent.headingDeg.toFixed(1) };
      },
      occluding: () => [...fader.occluding],
      /** 三视图对照：只渲染角色，正面 / 侧面 / 背面并排，存到 docs/screenshots/ */
      async portraitSheet(name: string) {
        const hidden: THREE.Object3D[] = [];
        for (const o of scene.children) {
          if (o === character.root || (o as THREE.Light).isLight || !o.visible) continue;
          o.visible = false;
          hidden.push(o);
        }
        const bg = scene.background;
        scene.background = new THREE.Color(0xf6ead8);
        const size = renderer.getSize(new THREE.Vector2());
        const w = size.x / 3;
        const h = size.y;
        const cam = new THREE.PerspectiveCamera(14, w / h, 0.1, 50);
        const savedPos = character.root.position.clone();
        const savedRot = character.root.rotation.y;
        character.root.position.set(0, 0, 0);
        character.root.rotation.y = 0; // 正面朝 +Z
        renderer.setScissorTest(true);
        const views: [number, number][] = [
          [0, 0], // 正面
          [Math.PI / 2, 0], // 侧面（她的左手边看过去，与三视图一致朝右）
          [Math.PI, 0], // 背面
        ];
        const look = new THREE.Vector3(0, 0.58 * character.scale, 0);
        views.forEach(([yaw], i) => {
          cam.position.set(Math.sin(yaw) * 6.2, 0.75 * character.scale, Math.cos(yaw) * 6.2);
          cam.lookAt(look);
          renderer.setViewport(w * i, 0, w, h);
          renderer.setScissor(w * i, 0, w, h);
          renderer.render(scene, cam);
        });
        const data = renderer.domElement.toDataURL('image/png');
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, size.x, size.y);
        character.root.position.copy(savedPos);
        character.root.rotation.y = savedRot;
        scene.background = bg;
        for (const o of hidden) o.visible = true;
        const res = await fetch(`/__dev/screenshot?name=${encodeURIComponent(name)}`, { method: 'POST', body: data });
        return res.json();
      },
      async capture(name: string) {
        // 等所有着色器编译就绪再截（Chrome 并行编译时，未就绪的物体那一帧会被跳过）
        pipeline.render();
        await renderer.compileAsync(scene, rig.camera);
        pipeline.render();
        const data = renderer.domElement.toDataURL('image/png');
        const res = await fetch(`/__dev/screenshot?name=${encodeURIComponent(name)}`, { method: 'POST', body: data });
        return res.json();
      },
    };
    (window as unknown as { __xh: typeof debug }).__xh = debug;
  }
}

try {
  boot(loadConfig());
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(e.message);
    showConfigErrors(app, e.issues);
  } else {
    throw e;
  }
}
