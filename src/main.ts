import * as THREE from 'three';
import { loadConfig } from './config/load';
import { ConfigError } from './config/validate';
import type { AppConfig } from './config/types';
import { buildHouse } from './scene/house';
import { buildFurniture } from './scene/furniture';
import { CameraRig } from './scene/cameraRig';
import { WallFader } from './scene/wallFade';
import { createHud, showConfigErrors } from './ui/hud';

const app = document.getElementById('app')!;

function boot(cfg: AppConfig) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(app.clientWidth, app.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  app.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf1ebe2);

  // 房子
  const house = buildHouse(cfg.rooms);
  scene.add(house.root);

  // 家具
  const furniture = cfg.furniture.items.map(buildFurniture);
  for (const f of furniture) scene.add(f.group);

  // 地台
  const center = house.box.getCenter(new THREE.Vector3());
  const radius = house.box.getSize(new THREE.Vector3()).setY(0).length() / 2;
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(radius * 1.6, 64),
    new THREE.MeshLambertMaterial({ color: 0xe6ddd0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(center.x, -0.065, center.z);
  // 墙不投影，屋外地台也不接影子，否则家具影子会「穿墙」落到屋外
  ground.receiveShadow = false;
  scene.add(ground);

  // 光：天光 + 一盏投影主光
  scene.add(new THREE.HemisphereLight(0xfff6ea, 0xb9a893, 1.7));
  const sun = new THREE.DirectionalLight(0xfff0dc, 1.6);
  // 主光从左前上方来：远处墙面背光略暗，空间层次清楚（墙体与门窗框不投影，见 house.ts）
  sun.position.set(center.x - 4, 10, center.z + 6);
  sun.target.position.copy(center);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -radius - 1;
  sc.right = sc.top = radius + 1;
  sc.near = 1;
  sc.far = 30;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);

  // 墙体遮挡检测用 matrixWorld 做射线；首帧渲染前就要算好，否则第一次检测全打偏
  scene.updateMatrixWorld(true);

  // 相机与墙体遮挡
  const rig = new CameraRig(renderer.domElement, cfg.camera, house.box);
  const fader = new WallFader(house.walls, cfg.camera);
  // 遮挡检测落点：M1 还没有角色，用各房间地面采样点（M2 起再加上角色位置）
  const fadeTargets = () => house.roomSamples;

  const hud = createHud(app);
  hud.onReset(() => rig.reset());

  const onResize = () => {
    renderer.setSize(app.clientWidth, app.clientHeight);
    rig.resize(app.clientWidth, app.clientHeight);
  };
  window.addEventListener('resize', onResize);
  onResize();

  // 主循环
  const clock = new THREE.Clock();
  let frames = 0;
  let fpsTime = 0;
  let fps = 0;
  const renderFrame = (dt: number) => {
    rig.update();
    fader.update(rig.camera, fadeTargets(), dt);
    renderer.render(scene, rig.camera);
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
    }
  });

  let triangles = 0;
  scene.traverse((o) => {
    const g = (o as THREE.Mesh).isMesh ? (o as THREE.Mesh).geometry : null;
    if (g) triangles += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  });
  console.info(
    `[scene] 房间 ${cfg.rooms.rooms.length} 个，墙段 ${house.walls.length} 段，家具 ${furniture.length} 件，三角面约 ${Math.round(triangles)}`,
  );

  // 开发态调试句柄（docs/验收问题.md B7）
  if (import.meta.env.DEV) {
    const debug = {
      cfg,
      scene,
      rig,
      fader,
      renderer,
      setView: (az: number, polar: number, dist: number) => {
        rig.setView(az, polar, dist);
        // 跳过渐变，直接到位，便于截图
        for (let i = 0; i < 30; i++) fader.update(rig.camera, fadeTargets(), 0.1);
      },
      occluding: () => [...fader.occluding],
      async capture(name: string) {
        // 等所有着色器编译就绪再截（Chrome 并行编译时，未就绪的物体那一帧会被跳过）
        renderFrame(0);
        await renderer.compileAsync(scene, rig.camera);
        renderFrame(0);
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
