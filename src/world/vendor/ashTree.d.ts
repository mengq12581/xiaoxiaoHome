import type * as THREE from 'three';

export interface AshPreset {
  seed: number;
  branchLevels: number;
  bark: { tint: number; textureScaleX: number; textureScaleY: number };
  branch: {
    angle: number[];
    children: number[];
    forceDirection: [number, number, number];
    forceStrength: number;
    gnarliness: number[];
    length: number[];
    radius: number[];
    sections: number[];
    segments: number[];
    start: number[];
    taper: number[];
    twist: number[];
  };
  leaves: { angle: number; count: number; start: number; size: number; sizeVariance: number; alphaTest: number };
}

export function compileAshTree(preset: AshPreset): {
  branchGeometry: THREE.BufferGeometry;
  leafGeometry: THREE.BufferGeometry;
  leafOrigins: THREE.BufferGeometry;
  stats: { branchJobs: number[]; continuations: number[]; lateralChildren: number[]; leafCards: number };
};
