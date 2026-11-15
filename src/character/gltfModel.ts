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
