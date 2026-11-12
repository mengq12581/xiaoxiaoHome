// 画面风格基线（柔和 3D 游戏观感）。所有「看起来怎么样」的全局设置集中在这里：
// - 色调映射：Neutral（保住暖色与粉彩，不发灰）；
// - 环境光照：程序生成的柔光棚（RoomEnvironment → PMREM），断网可用，给每个曲面连续的明暗过渡；
// - 主光：暖色方向光 + 柔边阴影（PCF 加大采样半径）；
// - 环境光遮蔽（GTAO）：墙角、家具底部、靠垫缝隙自然变暗，物体「落在」空间里；
// - 背景：竖向渐变天色 + 边缘羽化的地台，不留硬边圆盘；
// - 抗锯齿：4× MSAA。
// 性能兜底：连续低帧率时自动关掉环境光遮蔽；地址栏加 ?fx=off 可手动关闭后期，?fx=on 强制保持开启（不自动降级）。

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export const LOOK = {
  exposure: 1.02,
  skyTop: '#e3ecef',
  skyHorizon: '#eee6da',
  skyBottom: '#e9decf',
  ground: '#e9decf',
  envIntensity: 0.4,
  hemiSky: 0xfff4e6,
  hemiGround: 0xcdb9a2,
  hemiIntensity: 0.45,
  sunColor: 0xffe9cf,
  sunIntensity: 1.7,
  /** 阴影半影（PCF 采样半径，贴图像素） */
  shadowRadius: 4,
  shadowMapSize: 2048,
  ao: { radius: 0.5, distanceExponent: 1.2, thickness: 1, scale: 1.3, samples: 16, intensity: 1 },
  maxPixelRatio: 2,
};

export function createRenderer(app: HTMLElement): THREE.WebGLRenderer {
  // 抗锯齿交给后期的 MSAA 渲染目标；关闭后期时（?fx=off）才用画布自带的
  const renderer = new THREE.WebGLRenderer({ antialias: !fxEnabled(), powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, LOOK.maxPixelRatio));
  renderer.setSize(app.clientWidth, app.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = LOOK.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  app.appendChild(renderer.domElement);
  return renderer;
}

export function fxEnabled(): boolean {
  return new URLSearchParams(location.search).get('fx') !== 'off';
}

function skyTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 512;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, LOOK.skyTop);
  grad.addColorStop(0.4, LOOK.skyHorizon);
  grad.addColorStop(1, LOOK.skyBottom);
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 512);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 地台：中间实、边缘羽化到透明，融进背景 */
function buildGround(center: THREE.Vector3, radius: number): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.3, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.65, 'rgba(255,255,255,0.25)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(radius * 2.4, 64),
    new THREE.MeshBasicMaterial({ color: LOOK.ground, alphaMap: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(center.x, -0.065, center.z);
  ground.renderOrder = -1;
  ground.name = 'ground';
  return ground;
}

export interface Lighting {
  sun: THREE.DirectionalLight;
  ground: THREE.Mesh;
}

/** 背景、环境光照、主光、地台 */
export function setupLighting(renderer: THREE.WebGLRenderer, scene: THREE.Scene, center: THREE.Vector3, radius: number): Lighting {
  scene.background = skyTexture();

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = LOOK.envIntensity;
  pmrem.dispose();

  scene.add(new THREE.HemisphereLight(LOOK.hemiSky, LOOK.hemiGround, LOOK.hemiIntensity));

  // 主光从左前上方来：远处墙面背光略暗，空间层次清楚（墙体与门窗框不投影，见 house.ts）
  const sun = new THREE.DirectionalLight(LOOK.sunColor, LOOK.sunIntensity);
  sun.position.set(center.x - 4, 10, center.z + 6);
  sun.target.position.copy(center);
  sun.castShadow = true;
  sun.shadow.mapSize.set(LOOK.shadowMapSize, LOOK.shadowMapSize);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -radius - 1;
  sc.right = sc.top = radius + 1;
  sc.near = 1;
  sc.far = 30;
  sun.shadow.radius = LOOK.shadowRadius;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  const ground = buildGround(center, radius);
  scene.add(ground);
  return { sun, ground };
}

export interface Pipeline {
  render(): void;
  setSize(w: number, h: number): void;
  /** 每帧报告耗时（秒），用于低帧率时自动降级 */
  reportFrame(dt: number): void;
  readonly aoActive: boolean;
}

/**
 * 后期管线：场景 → 环境光遮蔽 → 色调映射输出。
 * @param aoExclude 每帧返回「不参与遮蔽计算」的物体（正在透明的墙、玻璃、贴地影子），否则看不见的墙会在地上压出暗边
 */
export function createPipeline(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  aoExclude: () => THREE.Object3D[],
): Pipeline {
  if (!fxEnabled()) {
    return { render: () => renderer.render(scene, camera), setSize() {}, reportFrame() {}, aoActive: false };
  }
  const size = renderer.getSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.addPass(new RenderPass(scene, camera));

  const gtao = new GTAOPass(scene, camera, size.x, size.y);
  gtao.blendIntensity = LOOK.ao.intensity;
  gtao.updateGtaoMaterial({
    radius: LOOK.ao.radius,
    distanceExponent: LOOK.ao.distanceExponent,
    thickness: LOOK.ao.thickness,
    scale: LOOK.ao.scale,
    samples: LOOK.ao.samples,
  });
  const dbg = new URLSearchParams(location.search).get('ao');
  if (dbg) gtao.output = (GTAOPass.OUTPUT as Record<string, number>)[dbg] ?? GTAOPass.OUTPUT.Denoise;
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 4, normalPhi: 5, radius: 16, radiusExponent: 1, rings: 2, samples: 16 });
  const gtaoRender = gtao.render.bind(gtao);
  gtao.render = (...args: Parameters<GTAOPass['render']>) => {
    const hidden = aoExclude().filter((o) => o.visible);
    for (const o of hidden) o.visible = false;
    // 贴图背景在法线通道里会被当成一块普通平面画出来（原点处一块黑斑），计算遮蔽时先摘掉
    const bg = scene.background;
    scene.background = null;
    gtaoRender(...args);
    scene.background = bg;
    for (const o of hidden) o.visible = true;
  };
  composer.addPass(gtao);
  composer.addPass(new OutputPass());

  // 自动降级：约 3 秒平均帧率低于 24 就关掉遮蔽（集显兜底），不再自动打开
  const forced = new URLSearchParams(location.search).get('fx') === 'on';
  let acc = 0;
  let n = 0;
  return {
    render: () => composer.render(),
    setSize(w, h) {
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, h);
    },
    reportFrame(dt) {
      if (!gtao.enabled || document.hidden || forced) return;
      acc += dt;
      n++;
      if (acc < 3) return;
      if (n / acc < 24) {
        gtao.enabled = false;
        console.info('[look] 帧率偏低，已关闭环境光遮蔽');
      }
      acc = 0;
      n = 0;
    },
    get aoActive() {
      return gtao.enabled;
    },
  };
}
