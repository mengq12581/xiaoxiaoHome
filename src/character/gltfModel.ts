// 外部建模的角色（model_type: "gltf"）。模型由 tools/character/ 下的流水线从三视图生成：
// 一张贴图 + 一张网格，顶点上带「关节编号 / 权重」（自定义属性 _joints / _weights），
// 这里把它绑到与程序化角色同一副骨架上，所以走路、坐下、待机这些动作不用改。
//
// 模型文件：assets/models/<id>.glb；关节位置等信息：assets/models/<id>.rig.json。

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { CharacterSpec } from '../config/types';
import { ROUGH, soft } from '../scene/materials';
import { createBareRig, type CharacterRig, type EyeState, type RigLayout } from './rig';

/** rig.json：流水线量出来的关节位置（参考身高 1.2 米下的米数） */
interface RigInfo extends RigLayout {
  /** 网格建模时手臂相对竖直方向外张的角度（弧度）；绑定前先把骨架摆成这个姿势 */
  armRestAngle: number;
  /** 肘关节在上臂骨骼局部坐标里的位置（左臂；右臂 x 取反） */
  elbow?: [number, number, number];
  /** 蒙皮权重里的关节顺序 */
  joints: string[];
  /** 连衣裙的几个尺寸：有这一项才做「坐下时裙子前片搭在腿上」 */
  skirt?: SkirtInfo;
}

interface SkirtInfo {
  /** 裙摆下沿高度 */
  hemY: number;
  /** 胯关节高度 */
  hipY: number;
  /** 腿轴线的 z */
  legZ: number;
  /** 大腿半径 */
  legRadius: number;
}

/**
 * 坐下时裙子前片搭在腿上（docs/验收问题.md C21）。
 * 流水线给裙摆的蒙皮是「越靠下越跟大腿、前片最多跟 85%」，裙子又是很蓬的钟形（前沿离身体中线约 19 厘米、大腿只有 7 厘米粗），
 * 坐下大腿转平以后，前片只转了一部分、又离大腿很远，就像一顶帐篷支在腿上。这里在蒙皮着色器里按坐姿（uDrape，0～1）改两件事：
 *   - 前片胯以下：权重全部给大腿（完全跟着大腿转平），并把向前鼓出的部分收回到贴着大腿上表面；
 *   - 前片胯以上：权重收回给身体（不跟着大腿往上翻），鼓出的部分也略微收回，胯部形成一道自然的折。
 * 站着、走路时 uDrape = 0，模型完全不变。阴影用同一套变形。
 */
function skirtDrape(mat: THREE.Material, sk: SkirtInfo, legJoints: [number, number], drape: { value: number }) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev.call(mat, shader, renderer);
    shader.uniforms.uDrape = drape;
    const f = (v: number) => v.toFixed(4);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uDrape;')
      .replace(
        '#include <skinbase_vertex>',
        `#include <skinbase_vertex>
vec4 skw = skinWeight;
float drapeDz = 0.0;
if (uDrape > 0.001) {
  vec4 isLeg = vec4(equal(skinIndex, vec4(${legJoints[0].toFixed(1)}))) + vec4(equal(skinIndex, vec4(${legJoints[1].toFixed(1)})));
  float legW = dot(skw, isLeg);
  vec3 bp = position;
  float skirt = step(${f(sk.hemY + 0.003)}, bp.y) * smoothstep(0.05, 0.3, legW);
  float front = smoothstep(${f(sk.legZ + 0.02)}, ${f(sk.legZ + 0.1)}, bp.z);
  float k = uDrape * skirt * front;
  float below = smoothstep(${f(sk.hipY + 0.012)}, ${f(sk.hipY - 0.02)}, bp.y);
  float legT = mix(legW, below, k);
  float sL = legW > 1e-4 ? legT / legW : 0.0;
  float sO = legW < 0.9999 ? (1.0 - legT) / (1.0 - legW) : 0.0;
  skw = skw * (isLeg * sL + (1.0 - isLeg) * sO);
  float dz = bp.z - ${f(sk.legZ)};
  float tLap = ${f(sk.legRadius + 0.006)};
  float tBel = ${f(sk.legRadius + 0.035)};
  float dzLap = dz > tLap ? tLap + (dz - tLap) * 0.12 : dz;
  float dzBel = dz > tBel ? tBel + (dz - tBel) * 0.35 : dz;
  float bellyK = k * (1.0 - below) * smoothstep(${f(sk.hipY + 0.09)}, ${f(sk.hipY)}, bp.y);
  drapeDz = mix(mix(dz, dzBel, bellyK), dzLap, k * below) - dz;
}`,
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.z += drapeDz;');
    // 蒙皮（位置、法线）用改过的权重
    for (const chunk of ['skinning_vertex', 'skinnormal_vertex'] as const) {
      const src = THREE.ShaderChunk[chunk].replace(/skinWeight/g, 'skw');
      shader.vertexShader = shader.vertexShader.replace(`#include <${chunk}>`, src);
    }
  };
  const key = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => `${key()}|skirt-drape`;
}

const glbUrls = import.meta.glob('../../assets/models/*.glb', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
const rigInfos = import.meta.glob('../../assets/models/*.rig.json', { import: 'default', eager: true }) as Record<string, RigInfo>;

const loaded = new Map<string, THREE.Group>();

const modelKey = (spec: CharacterSpec, ext: string) => `../../${spec.model.replace(/\.glb$/, '')}${ext}`;

export function hasGltfModel(spec: CharacterSpec): boolean {
  return spec.model_type === 'gltf' && modelKey(spec, '.glb') in glbUrls && modelKey(spec, '.rig.json') in rigInfos;
}

/** 启动前预加载（GLB 解析是异步的，建模型本身保持同步） */
export async function preloadGltfCharacter(spec: CharacterSpec): Promise<void> {
  if (!hasGltfModel(spec) || loaded.has(spec.id)) return;
  const gltf = await new GLTFLoader().loadAsync(glbUrls[modelKey(spec, '.glb')]);
  loaded.set(spec.id, gltf.scene);
}

export function buildGltfCharacter(spec: CharacterSpec): CharacterRig | null {
  const scene = loaded.get(spec.id);
  if (!scene) return null;
  const info = rigInfos[modelKey(spec, '.rig.json')];
  const rig = createBareRig(spec.id, spec.height, info);
  const bones = info.joints.map((j) => (rig as unknown as Record<string, THREE.Object3D>)[j]);

  if (info.elbow) {
    rig.foreL.position.set(info.elbow[0], info.elbow[1], info.elbow[2]);
    rig.foreR.position.set(-info.elbow[0], info.elbow[1], info.elbow[2]);
  }

  // 绑定姿势：手臂按建模时的外张角摆好，再算骨骼逆矩阵
  rig.armL.rotation.z = info.armRestAngle;
  rig.armR.rotation.z = -info.armRestAngle;
  rig.root.updateMatrixWorld(true);
  const headInv = new THREE.Matrix4().copy(rig.head.matrixWorld).invert();
  const scalerWorld = rig.scaler.matrixWorld;

  const lids: Partial<Record<'lid_half' | 'lid_closed', THREE.Mesh>> = {};
  const drape = { value: 0 };
  const sources: THREE.Mesh[] = [];
  scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) sources.push(o as THREE.Mesh);
  });
  for (const src of sources) {
    const geo = src.geometry;
    const srcMat = src.material as THREE.MeshStandardMaterial;
    const map = srcMat.map;
    if (map) map.anisotropy = 8;
    if (src.name.startsWith('lid_')) {
      // 眼睑贴片：只跟头动，平时隐藏，眨眼时显示
      const mesh = new THREE.Mesh(
        geo,
        soft(0xffffff, { map, roughness: ROUGH.skin, transparent: true, alphaTest: 0.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      );
      // 顶点在「模型空间」（= scaler 空间），换到 head 局部
      mesh.applyMatrix4(new THREE.Matrix4().multiplyMatrices(headInv, scalerWorld));
      mesh.visible = false;
      mesh.name = src.name;
      rig.head.add(mesh);
      lids[src.name as 'lid_half' | 'lid_closed'] = mesh;
      continue;
    }
    const joints = geo.getAttribute('_joints');
    const weights = geo.getAttribute('_weights');
    if (!joints || !weights) throw new Error(`角色模型 ${spec.model} 的网格 ${src.name} 缺少蒙皮属性 _joints / _weights`);
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(Uint16Array.from(joints.array as ArrayLike<number>), 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Float32Array.from(weights.array as ArrayLike<number>), 4));
    geo.deleteAttribute('_joints');
    geo.deleteAttribute('_weights');
    // 粗糙度按部位写在贴图里（头发略亮、裙子哑光）；模型自带的金属度通道不用
    const roughnessMap = srcMat.roughnessMap;
    const mesh = new THREE.SkinnedMesh(
      geo,
      soft(0xffffff, { map, roughnessMap, roughness: roughnessMap ? 1 : ROUGH.cloth, side: THREE.DoubleSide, envMapIntensity: 0.7 }),
    );
    mesh.name = 'body_mesh';
    if (info.skirt) {
      const legJoints: [number, number] = [info.joints.indexOf('legL'), info.joints.indexOf('legR')];
      skirtDrape(mesh.material as THREE.Material, info.skirt, legJoints, drape);
      // 阴影也用同样的变形，不然影子里还是一顶帐篷
      const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
      skirtDrape(depth, info.skirt, legJoints, drape);
      mesh.customDepthMaterial = depth;
      // 坐姿程度：两条大腿都往前抬时才算（走路时一前一后，取较小的那条，得 0）
      mesh.onBeforeRender = () => {
        const fwd = Math.min(-rig.legL.rotation.x, -rig.legR.rotation.x);
        drape.value = THREE.MathUtils.clamp(fwd / 1.2, 0, 1);
      };
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    rig.scaler.add(mesh);
    mesh.updateMatrixWorld(true);
    mesh.bind(new THREE.Skeleton(bones as THREE.Bone[]));
  }
  rig.armL.rotation.z = 0;
  rig.armR.rotation.z = 0;

  rig.setEyes = (state: EyeState) => {
    if (lids.lid_half) lids.lid_half.visible = state === 1;
    if (lids.lid_closed) lids.lid_closed.visible = state === 2;
  };
  return rig;
}
