import * as THREE from 'three';
import { loadConfig } from './config/load';
import { ConfigError } from './config/validate';
import type { AppConfig, Vec2 } from './config/types';
import { buildHouse, P } from './scene/house';
import { buildFurniture, placeFurniture } from './scene/furniture';
import { DragController } from './scene/dragController';
import { LayoutStore, type StorageLike } from './layout/layoutStore';
import { StageLayout } from './layout/stageLayout';
import { CameraRig } from './scene/cameraRig';
import { createPipeline, createRenderer } from './scene/lookdev';
import { buildWorld } from './world/world';
import type { TimeOfDay } from './world/palette';
import { LIGHTING } from './world/palette';
import { WallFader } from './scene/wallFade';
import { indexAnchors } from './scene/anchors';
import { createPathfinder } from './nav/pathfinder';
import { buildCharacter } from './character/model';
import { preloadGltfCharacter } from './character/gltfModel';
import { CharacterAgent, type LogFn } from './character/agent';
import { ContactShadow } from './character/contactShadow';
import { createHud, createLayoutBar, createToast, showConfigErrors } from './ui/hud';
import { createDevPanel } from './ui/devPanel';
import { Director } from './director/director';
import { IdlePool } from './director/idlePool';
import { isoLocal } from './state/types';
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

  // 布局：先读回上次拖动后的位置（localStorage），再按它建家具；清掉缓存就回到 config/furniture.json
  let storage: StorageLike | null = null;
  try {
    storage = window.localStorage;
  } catch {
    flog.write('warn', '[layout] localStorage 不可用，布局不会保存');
  }
  const store = new LayoutStore(cfg.furniture.items, cfg.rooms, storage, flog.write);
  if (store.loadSaved() === 'applied') flog.write('info', '[layout] 已恢复上次保存的布局');

  // 家具
  const furniture = cfg.furniture.items.map(buildFurniture);
  for (const f of furniture) scene.add(f.group);

  // 屋外世界：湖心小岛、湖面倒影、天空与环境光照、树和花草、房子外观、室内软装、太阳与夜里的灯（src/world/）
  const world = buildWorld(renderer, scene, cfg.rooms, cfg.furniture.items, house);
  const wallById = new Map(house.walls.map((w) => [w.segment.id, w] as const));

  // 角色（v0.1 只有一个 active 角色）
  const spec = cfg.characters.characters.find((c) => c.id === cfg.characters.active)!;
  const character = buildCharacter(spec);
  scene.add(character.root);

  // 寻路与走位
  const pathfinder = createPathfinder(cfg.rooms, cfg.furniture.items);
  if (pathfinder.blockedNodes.length || pathfinder.blockedEdges.length) {
    flog.write('warn', '[nav] 以下导航点/边被墙或家具挡住，已停用', {
      nodes: pathfinder.blockedNodes,
      edges: pathfinder.blockedEdges,
    });
  }
  const log: LogFn = (level, msg, data) => flog.write(level, `[agent:${spec.id}] ${msg}`, data);
  const spawn: Vec2 = spec.spawn ?? cfg.rooms.nav.nodes[0];
  const agent = new CharacterAgent(character, pathfinder, spawn, -90, { log });
  // 家具被拖动后交互点会重算，所以是 let；演员、面板都每次现取
  let anchors = indexAnchors(cfg.furniture.items);
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
  // 空闲池：没人安排时按权重自己挑事做（只从这个角色能做的活动里挑）
  const idlePool = new IdlePool(cfg.activities, { allowed: spec.activities });
  const director = new Director(cfg.activities, {
    idlePool,
    isoNow: () => isoLocal(new Date()),
    // 自己挑的事写回状态服务（source = idle）：state.json、历史、以后的模拟器都能看到她在干什么
    onIdlePick: (_id, state) => {
      void client.post(state).catch(() => {
        /* 服务不在也照常演 */
      });
    },
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
  const hud = createHud(app, 'v0.1 · M5 拖家具');
  hud.onReset(() => rig.reset());
  const toast = createToast(app);

  // 家具拖动：数据与人物配合在 layout/，鼠标键盘与选中框在 DragController
  const layout = new StageLayout({
    store,
    rooms: cfg.rooms,
    pathfinder,
    agent,
    performer,
    director,
    characterId: spec.id,
    setAnchors: (a) => {
      anchors = a;
    },
    onMoved: (ids) => {
      for (const f of furniture) if (ids.includes(f.item.id)) placeFurniture(f.group, f.item);
    },
    log: flog.write,
  });
  const syncLayoutBar = () => layoutBar.set({ canUndo: store.canUndo, isDefault: store.isDefault });
  const drag = new DragController({
    dom: renderer.domElement,
    overlayRoot: app,
    camera: rig.camera,
    controls: rig.controls,
    views: furniture,
    store,
    layout,
    toast,
    onChange: () => syncLayoutBar(),
  });
  const exportLayout = async () => {
    const data = store.export();
    try {
      const res = await fetch('/layout/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: data.items }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { file } = (await res.json()) as { file: string };
      toast(`布局已导出到 ${file}`);
      flog.write('info', '[layout] 导出布局', { file });
    } catch (e) {
      // 状态服务不在：改成浏览器下载
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify({ items: data.items }, null, 2)], { type: 'application/json' }));
      a.download = `layout-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast('状态服务没连上，已改为浏览器下载');
      flog.write('warn', '[layout] 导出接口不可用，改为浏览器下载', { error: (e as Error).message });
    }
  };
  const layoutBar = createLayoutBar(app, { undo: () => drag.undo(), reset: () => drag.reset(), exportJson: () => void exportLayout() });
  syncLayoutBar();

  const pipeline = createPipeline(
    renderer,
    scene,
    rig.camera,
    () => [
      ...house.walls.filter((w) => w.opacity < 0.98).map((w) => w.group),
      ...house.glass,
      contact.group,
      ...drag.overlayObjects,
      ...world.aoExclude(),
    ],
    [{ name: '关闭湖面倒影', run: () => world.water.setReflection(false) }],
  );

  // 时间：地址栏 ?time=day|golden|night，开发面板可切换（以后跟本机时钟、天气走，docs/验收问题.md C14）
  const setTime = (t: TimeOfDay) => {
    world.setTime(t);
    pipeline.setBloom(LIGHTING[t].practicals);
    flog.write('info', `[world] 时间：${t}`);
  };
  const qTime = new URLSearchParams(location.search).get('time');
  setTime(qTime === 'golden' || qTime === 'night' ? qTime : 'day');

  /** 屋外世界 + 透明墙：每帧一次；截图 / 快进时连推几次跳过渐变 */
  const syncScene = (dt: number) => {
    const keep = fadeTargets();
    world.update(dt, { camera: rig.camera, target: rig.controls.target, keepVisible: keep });
    // 屋顶盖着（远看全岛）时不剖墙
    fader.update(rig.camera, keep, dt, world.roofOpen > 0.5);
    world.syncWalls((id) => wallById.get(id)?.opacity ?? 1, cfg.camera.wallFadeOpacity);
  };

  const onResize = () => {
    renderer.setSize(app.clientWidth, app.clientHeight);
    pipeline.setSize(app.clientWidth, app.clientHeight);
    rig.resize(app.clientWidth, app.clientHeight);
    world.setSize(app.clientWidth, app.clientHeight);
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

  // 状态模拟面板（代替原计划的桌面模拟器，docs/验收问题.md C10）：把状态写给状态服务，再由轮询读回来交给导演
  const send = (activity: string, source = 'sim:click') =>
    client.post({ activity, source }).then((r) => {
      if (r.status !== 200) flog.write('warn', `[state] 写入被拒绝（HTTP ${r.status}）`, { activity, body: r.body as Record<string, unknown> });
    });
  // 开发态：快进（看空闲池换活动不用干等）。按 1/30 秒一步推进角色与导演，画面最后刷新一次
  const fastForward = (seconds: number) => {
    const dt = 1 / 30;
    for (let t = 0; t < seconds; t += dt) stepWorld(dt, dt);
    flog.write('info', `[dev] 快进 ${seconds} 秒`);
  };
  const devPanel = import.meta.env.DEV
    ? createDevPanel(app, '状态模拟', [
        { label: '用电脑', run: () => send('use_computer') },
        { label: '写笔记', run: () => send('write_notes') },
        { label: '沙发看电视', run: () => send('watch_tv') },
        { label: '听歌', run: () => send('listen_music') },
        { label: '床上睡觉', run: () => send('sleep') },
        { label: '窗边发呆', run: () => send('daydream_window') },
        { label: '闲逛', run: () => send('wander') },
        { label: '停下（回空闲池）', run: () => send('idle') },
        { label: '快进 1 分钟', run: () => fastForward(60) },
        { label: '非法活动(fly)', run: () => send('fly') },
        { label: '镜头看她', run: () => rig.setView(rig.view.azimuthDeg, 55, cfg.camera.minDistance) },
        { label: '镜头看全岛', run: () => rig.setView(rig.view.azimuthDeg, 60, cfg.camera.maxDistance) },
        { label: '白天', run: () => setTime('day') },
        { label: '黄昏', run: () => setTime('golden') },
        { label: '夜晚', run: () => setTime('night') },
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
    drag.update(performance.now());
    syncScene(dt);
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
        `${fps} fps · 方位 ${v.azimuthDeg.toFixed(0)}° · 俯仰 ${v.polarDeg.toFixed(0)}° · 距离 ${v.distance.toFixed(1)} m · 透明墙 ${fader.occluding.size} · 透明树 ${world.vegetation.trees.occluding}`,
      );
      const d = director.snapshot();
      const next =
        d.idleLeft !== null
          ? `再过 ${Math.ceil(d.idleLeft)} 秒换下一件`
          : d.idleIn !== null
            ? d.idleIn > 0
              ? `${Math.ceil(d.idleIn)} 秒后没新状态就进空闲池`
              : '演满后进空闲池'
            : '';
      const dwell =
        d.phase === 'ACTING'
          ? d.dwellLeft > 0
            ? `最短停留还剩 ${Math.ceil(d.dwellLeft)} 秒`
            : next || `已演 ${Math.floor(d.acted)} 秒`
          : d.phase === 'MOVING'
            ? '正在过去'
            : '';
      devPanel?.setStatus(
        d.activity
          ? `${spec.name}：${d.activity}（${d.source}）· ${dwell}${d.queued ? ` · 排队：${d.queued}` : ''} · ${agent.state}`
          : `${spec.name}：还没有收到状态${d.idleIn !== null ? `，${Math.ceil(d.idleIn)} 秒后进空闲池` : ''} · ${agent.state}`,
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
      world,
      setTime,
      pipeline,
      renderer,
      agent,
      pathfinder,
      character,
      director,
      performer,
      props,
      client,
      store,
      layout,
      drag,
      get anchors() {
        return anchors;
      },
      setView: (az: number, polar: number, dist: number) => {
        rig.setView(az, polar, dist);
        // 跳过渐变，直接到位，便于截图
        for (let i = 0; i < 30; i++) syncScene(0.1);
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
        for (let i = 0; i < 30; i++) syncScene(0.1);
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
