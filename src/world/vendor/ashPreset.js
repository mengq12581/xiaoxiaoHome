// 白蜡树「中等」预设
// 原样取自 scottstts/Threejs-Awesome-Graphics-Agent-Skills
//   skills/threejs-procedural-vegetation/examples/structured-ash-growth
// MIT License, Copyright (c) 2026 Scott Sun（许可全文见 .claude/skills/threejs-procedural-vegetation/LICENSE）。
// 本项目只在 src/world/trees.ts 里按尺寸缩放、配材质，不改这里的生长规则。

export const ashMedium = {
  seed: 36330,
  branchLevels: 3,
  bark: {
    tint: 13552830,
    textureScaleX: 0.5,
    textureScaleY: 5,
  },
  branch: {
    angle: [0, 48, 75, 60],
    children: [7, 4, 3, 0],
    forceDirection: [0, 1, 0],
    forceStrength: 0.01,
    gnarliness: [0.03, 0.25, 0.2, 0.09],
    length: [43.47, 27.14, 9.51, 4.6],
    radius: [2, 0.63, 0.76, 0.7],
    sections: [12, 8, 6, 4],
    segments: [12, 6, 4, 3],
    start: [0, 0.23, 0.33, 0],
    taper: [0.7, 0.7, 0.7, 0.7],
    twist: [0.09, -0.07, 0, 0],
  },
  leaves: {
    angle: 55,
    count: 16,
    start: 0,
    size: 2.67,
    sizeVariance: 0.72,
    alphaTest: 0.5,
  },
};
