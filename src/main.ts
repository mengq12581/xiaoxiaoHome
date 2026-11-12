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
import { preloadGltfCharacter } from './character/gltfModel';
import { CharacterAgent, type LogFn } from './character/agent';
import { ContactShadow } from './character/contactShadow';
import { createHud, showConfigErrors } from './ui/hud';
import { createDevPanel } from './ui/devPanel';
import { Director } from './director/director';
import { StagePerformer } from './director/stagePerformer';
import { PropManager, buildHeadphones } from './scene/props';
import { FrontendLog, StateClient } from './state/client';

const app = document.getElementById('app')!;

function boot(cfg: AppConfig) {
  // 日志：控制台 + 经状态服务落盘到 logs/frontend-YYYYMMDD.log
  const flog = new FrontendLog();
  flog.start();

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
    flog.write('warn', '[nav] 以下导航点/边被墙或家具挡住，已停用', {
      nodes: pathfinder.blockedNodes,
      edges: pathfinder.blockedEdges,
    });
  }
  const log: LogFn = (level, msg, data) => flog.write(level, `[agent:${spec.id}] ${msg}`, data);
  const spawn: Vec2 = spec.spawn ?? cfg.rooms.nav.nodes[0];
  const agent = new CharacterAgent(character, pathfinder, spawn, -90, { log });
  const anchors = indexAnchors(cfg.furniture.items);
  const contact = new ContactShadow(character.scale);
  scene.add(contact.group);
  const syncContact = () =>
    contact.update(agent.position, character.root.rotation.y, agent.sitWeight, agent.seatHeight);
  syncContact();

  // 道具（屏幕微光、翻开的本子、被子、耳机……）
  buildHeadphones(character);
  const props = new PropManager([...furniture.map((f) => f.group), character.root]);

  // 导演：状态 → 排队 / 最短停留 → 演员（走过去、就位、动作、道具）
  const directorClock = { t: 0 };
  const performer = new StagePerformer(agent, pathfinder, () => anchors, () => cfg.rooms.nav.nodes, props, log);
  const client = new StateClient({
    onState: (state) => {
      const decision = director.setState(cfg.characters.active, state);
      flog.write('info', '[state] 收到状态', { activity: state.activity, source: state.source, since: state.since, decision });
    },
    onStatus: (ok, detail) => flog.write(ok ? 'info' : 'warn', ok ? '[state] 状态服务已连接' : '[state] 状态服务连不上，保持上一次有效状态', { detail }),
  });
  const director = new Director(cfg.activities, {
    now: () => directorClock.t,
    log: (level, msg, data) => flog.write(level, `[director] ${msg}`, data),
    onPerformed: (_id, ended, next) =>
      client.reportPerformed({
        activity: next.activity,
        source: next.source,
        min_dwell: next.minDwell,
        prev: ended.activity,
        prev_duration: ended.totalSec,
        prev_acted: ended.actedSec,
        prev_min_dwell: ended.minDwell,
      }),
  });
  // 多角色接口：v0.1 只登记并路由给 active 角色
  director.register(spec.id, performer, true);
  client.start();

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

  const hud = createHud(app, 'v0.1 · M3 导演与状态');
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

  // 开发态：状态模拟面板（等同于模拟器点按钮：把状态写给状态服务，再由轮询读回来交给导演）
  const send = (activity: string, source = 'sim:click') =>
    client.post({ activity, source }).then((r) => {
      if (r.status !== 200) flog.write('warn', `[state] 写入被拒绝（HTTP ${r.status}）`, { activity, body: r.body as Record<string, unknown> });
    });
  const devPanel = import.meta.env.DEV
    ? createDevPanel(app, '状态模拟（开发态；正式的模拟器在 M6）', [
        { label: '用电脑', run: () => send('use_computer') },
        { label: '写笔记', run: () => send('write_notes') },
        { label: '沙发看电视', run: () => send('watch_tv') },
        { label: '听歌', run: () => send('listen_music') },
        { label: '床上睡觉', run: () => send('sleep') },
        { label: '窗边发呆', run: () => send('daydream_window') },
        { label: '闲逛', run: () => send('wander') },
        { label: '停下', run: () => send('idle') },
        { label: '非法活动(fly)', run: () => send('fly') },
        { label: '镜头看她', run: () => rig.setView(rig.view.azimuthDeg, 55, cfg.camera.minDistance) },
      ])
    : null;

  // 主循环
  const clock = new THREE.Clock();
  let frames = 0;
  let fpsTime = 0;
  let fps = 0;
  const stepWorld = (dt: number, realDt: number) => {
    // 导演的时钟走真实时间（最短停留按秒算，不受掉帧影响）；动作步长封顶，避免切回标签页时一步迈太大
    directorClock.t += realDt;
    agent.update(dt);
    performer.update();
    director.update();
    props.update(dt);
  };
  const renderFrame = (dt: number, realDt: number) => {
    stepWorld(dt, realDt);
    syncContact();
    syncPathLine();
    rig.update();
    fader.update(rig.camera, fadeTargets(), dt);
    pipeline.render();
    pipeline.reportFrame(dt);
  };
  renderer.setAnimationLoop(() => {
    const realDt = clock.getDelta();
    const dt = Math.min(realDt, 0.1);
    renderFrame(dt, realDt);
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
      const d = director.snapshot();
      const dwell = d.phase === 'ACTING' ? (d.dwellLeft > 0 ? `最短停留还剩 ${Math.ceil(d.dwellLeft)} 秒` : `已演 ${Math.floor(d.acted)} 秒`) : d.phase === 'MOVING' ? '正在过去' : '';
      devPanel?.setStatus(
        d.activity
          ? `${spec.name}：${d.activity}（${d.source}）· ${dwell}${d.queued ? ` · 排队：${d.queued}` : ''} · ${agent.state}`
          : `${spec.name}：还没有收到状态 · ${agent.state}`,
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
      director,
      performer,
      props,
      client,
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
          stepWorld(dt, dt);
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

(async () => {
  try {
    const cfg = loadConfig();
    const active = cfg.characters.characters.find((c) => c.id === cfg.characters.active);
    if (active) await preloadGltfCharacter(active);
    boot(cfg);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      showConfigErrors(app, e.issues);
    } else {
      throw e;
    }
  }
})();
