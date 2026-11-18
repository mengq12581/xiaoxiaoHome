// 画面风格基线（写实方向，docs/art/美术方向.md）。渲染器与后期集中在这里；天空、太阳、环境光照在 src/world/world.ts：
// - 色调映射：Neutral（保住暖色与墙色，不发灰；AgX 对比过，整体发白）；
// - 阴影：PCF 柔边；
// - 环境光遮蔽（GTAO）：墙角、家具底部、靠垫缝隙自然变暗，物体「落在」空间里；
// - 泛光（Bloom）：只在黄昏 / 夜里开，灯罩、窗户有一圈柔光；
// - 抗锯齿：4× MSAA。
// 性能兜底：约 3 秒平均帧率低于 24 时按顺序降级（先关湖面倒影，再关环境光遮蔽，再关泛光）；
// 地址栏加 ?fx=off 可手动关闭后期，?fx=on 强制保持开启（不自动降级）。

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

export const LOOK = {
  exposure: 1.0,
  bloom: { strength: 0.35, radius: 0.5, threshold: 1.1 },
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

export interface Pipeline {
  render(): void;
  setSize(w: number, h: number): void;
  /** 每帧报告耗时（秒），用于低帧率时自动降级 */
  reportFrame(dt: number): void;
  /** 泛光开关（黄昏 / 夜里开） */
  setBloom(on: boolean): void;
  readonly aoActive: boolean;
}

/** 低帧率时依次执行的降级步骤（在环境光遮蔽之前） */
export interface DegradeStep {
  name: string;
  run(): void;
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
  degradeFirst: DegradeStep[] = [],
): Pipeline {
  if (!fxEnabled()) {
    return { render: () => renderer.render(scene, camera), setSize() {}, reportFrame() {}, setBloom() {}, aoActive: false };
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
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), LOOK.bloom.strength, LOOK.bloom.radius, LOOK.bloom.threshold);
  bloom.enabled = false;
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // 自动降级：约 3 秒平均帧率低于 24 就执行下一步（不再自动恢复）
  const forced = new URLSearchParams(location.search).get('fx') === 'on';
  let bloomAllowed = true;
  const steps: DegradeStep[] = [
    ...degradeFirst,
    { name: '关闭环境光遮蔽', run: () => (gtao.enabled = false) },
    {
      name: '关闭泛光',
      run: () => {
        bloomAllowed = false;
        bloom.enabled = false;
      },
    },
  ];
  let acc = 0;
  let n = 0;
  return {
    render: () => composer.render(),
    setSize(w, h) {
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, h);
    },
    setBloom(on) {
      bloom.enabled = on && bloomAllowed;
    },
    reportFrame(dt) {
      if (!steps.length || document.hidden || forced) return;
      acc += dt;
      n++;
      if (acc < 3) return;
      if (n / acc < 24) {
        const step = steps.shift()!;
        step.run();
        console.info(`[look] 帧率偏低，已${step.name}`);
      }
      acc = 0;
      n = 0;
    },
    get aoActive() {
      return gtao.enabled;
    },
  };
}
