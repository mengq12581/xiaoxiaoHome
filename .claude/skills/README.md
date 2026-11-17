# 项目 skill（美术与 3D 场景）

这些 skill 放在仓库的 `.claude/skills/` 下：在本仓库里打开的 Claude Code 会话（云端或本机）都会自动加载。
都是 MIT 许可的开源项目，按需挑选了文字说明与示例代码；**没有拷贝**大体积的图片、模型、贴图素材和 GPL 许可的示例。

2026-11-17 引入。需要更新时，从下面的源仓库重新拷贝对应目录。

## 美术方向与资产生产

| skill | 来源 | 用途 |
| --- | --- | --- |
| `art-director` | [NewenergyEric/art-director-skill](https://github.com/NewenergyEric/art-director-skill) | 把参考、取舍和样张整理成「项目美术包」：定位、视觉语言、各类资产要求、样张与验收。本项目的美术方向（`docs/art/`）按它的方法整理 |
| `game-art-production` | 同上（附带的子 skill） | 按美术包批量生产人物、场景、道具资产 |
| `3dviz-pro-max` | [viettranx/3dviz-pro-max](https://github.com/viettranx/3dviz-pro-max) | 3D 场景的设计决策：物体造型推理、配色与材质方向、光照方向与尺度、Blender / three.js 分工、视觉自查清单 |

## three.js 图形技术（屋外场景、天气、画面）

来源 [scottstts/Threejs-Awesome-Graphics-Agent-Skills](https://github.com/scottstts/Threejs-Awesome-Graphics-Agent-Skills)。只拷了 `SKILL.md`、`references/` 和示例代码。
注意：不少示例针对 WebGPU / TSL，本项目是 WebGL（three.js 0.170），用的时候取其方法、按 WebGL 改写。

| skill | 本项目里用在 |
| --- | --- |
| `threejs-skill-router` | 把一个画面目标拆给最少的几个 skill |
| `threejs-atmosphere-aerial-perspective` | 天空、大气、远景的空气透视（昼夜） |
| `threejs-volumetric-clouds` | 云（天气） |
| `threejs-precipitation-surfaces` | 雨、雪及地面的湿润 / 积雪（天气）。**源仓库里 `wet-puddle-rain` 示例含 GPL 代码，没有拷贝，也不要从源仓库照抄** |
| `threejs-water-optics` | 湖面 |
| `threejs-procedural-vegetation` | 树、草、花、藤蔓 |
| `threejs-procedural-architecture` | 屋顶、外墙、屋檐等建筑外观 |
| `threejs-procedural-fields` | 小岛地形、湖岸、噪声场 |
| `threejs-shadow-systems` | 大场景阴影 |
| `threejs-exposure-color-grading` | 曝光与调色（不同时间、天气的画面基调） |
| `threejs-bloom` | 灯光、窗户的泛光 |
| `threejs-visual-validation` | 用固定视角截图做画面验收 |

## three.js 基础参考

来源 [CloudAI-X/threejs-skills](https://github.com/CloudAI-X/threejs-skills)（没拷 React Three Fiber）：
`threejs-fundamentals`、`threejs-geometry`、`threejs-materials`、`threejs-textures`、`threejs-lighting`、`threejs-shaders`、
`threejs-postprocessing`、`threejs-performance`、`threejs-asset-pipeline`、`threejs-loaders`、`threejs-animation`、`threejs-interaction`。

## 看过但没有引入的

| 项目 | 原因 |
| --- | --- |
| [anthropics/skills](https://github.com/anthropics/skills)（canvas-design、theme-factory 等） | 面向海报、文档、网页的平面设计，不是 3D 场景 |
| MeltFlexDevs/skills（室内设计） | 是一个付费云服务的调用封装（上传照片生成效果图），需要联网和账号，与「断网可运行」冲突 |
| [ahujasid/mcp-for-blender](https://github.com/ahujasid/mcp-for-blender)（Blender MCP） | 很有用，但要在装了 Blender 的电脑上运行，云端会话用不了。以后在本机建模、从 Poly Haven 取素材时再接 |
| 搜索结果里一批名字随机、创建时间很近、星数相近的 「blender-ai-copilot-*」 仓库 | 典型的刷星仓库特征，不碰 |
