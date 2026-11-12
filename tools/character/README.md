# 角色建模流水线：三视图 → 游戏里的 3D 角色

把 `assets/xiaoxiao_q_turnaround.jpg` 这样的 Q 版三视图（正 / 侧 / 背）变成 `assets/models/<id>.glb`，
前端（`src/character/gltfModel.ts`）把它绑到现成的骨架上，走路、坐下、待机、眨眼这些动作不用改。

这些脚本**只在重做模型时才需要跑**；游戏运行不依赖 Python，也不联网。

## 用到的开源工具

| 环节 | 工具 | 说明 |
| --- | --- | --- |
| 多视图 → 网格 | [Hunyuan3D-2mv](https://github.com/Tencent-Hunyuan/Hunyuan3D-2)（腾讯混元 3D，权重 `tencent/Hunyuan3D-2mv`） | 专门吃 正 / 侧 / 背 多张图的版本；这里用蒸馏版 `hunyuan3d-dit-v2-mv-turbo`（5 步）+ FlashVDM 解码 |
| 减面 | fast-simplification | 约 79 万面 → 6 万面 |
| 展 UV | xatlas | |
| 其余（抠图、对齐、贴图烘焙、蒙皮权重、眼睑） | 本目录的脚本（numpy / OpenCV / trimesh / scipy） | |

许可提醒：Hunyuan3D-2 的代码和权重用的是腾讯自己的社区许可（Tencent Hunyuan 3D 2.0 Community License），
不是 MIT / Apache，对使用地区和用途有限制。自己玩没问题；要商用或公开分发前请先读它仓库里的 `LICENSE`。

## 怎么跑

不需要显卡。实测 4 核 CPU、16G 内存：建模约 6.5 分钟（内存峰值约 11G），后处理约 40 秒。

```bash
python -m venv venv && ./venv/bin/pip install -r tools/character/requirements.txt
git clone --depth 1 https://github.com/Tencent-Hunyuan/Hunyuan3D-2 ../Hunyuan3D-2
export PYTHONPATH=../Hunyuan3D-2

# 1. 三视图切成三张去背景的图
./venv/bin/python tools/character/prepare_views.py assets/xiaoxiao_q_turnaround.jpg work/views

# 2. 多视图建模（首次运行会从 Hugging Face 下载约 5G 权重）
./venv/bin/python tools/character/gen_shape.py work/views work/raw.glb --steps 5 --octree 320

# 3. 后处理并导出到 assets/models/
cd tools/character
../../venv/bin/python build_character.py ../../work/raw.glb ../../work/views ../../assets/models xiaoxiao --debug ../../work/debug
```

`--debug` 目录里会留下每一步的预览图（顶点上色、蒙皮权重分区、贴图、成品多角度），不用开游戏就能检查。
`inspect_mesh.py <mesh.glb> <out.png>` 可以把任意网格渲染成多角度预览。

然后在 `config/characters.json` 里把角色的 `model` 指向 `assets/models/<id>.glb`、`model_type` 设为 `"gltf"`。
想换回程序化小人，把 `model_type` 改回 `"procedural"` 即可（代码还在 `src/character/model.ts`）。

## 第 3 步做了什么（build_character.py）

1. **清理、摆正、归一**：只留最大连通块；绕竖轴试 4 个朝向，取剪影与三视图最吻合的；缩放到 1.2 米、脚踩地面。
2. **减面 + 轻度平滑**。
3. **把脸磨平**：建模工具会把大眼睛做成凹陷的眼窝，Q 版的脸应该是一张光滑的面，五官靠贴图。
4. **蒙皮权重**：按部位分给 11 个关节（胯、上身、头、左右上臂 / 前臂、左右大腿 / 小腿）。
   头发跟头，垂到肩以下的部分逐渐改跟上身；裙摆越靠下越跟大腿，坐下时前片搭在腿上。
5. **贴图**：把三视图按正交投影对到模型上。头发 / 皮肤 / 裙子 / 发卡先分类再涂**纯色**
   （直接贴原画会把描边线和对不齐的色块带上来），只有**脸**和**胸前的月亮印花**直接取自正面原画。
   另外输出一张粗糙度贴图：头发略有光泽、皮肤柔和、裙子哑光。
6. **眼睑**：复制眼睛范围内的面片、抬高 2.5 毫米，贴「半闭 / 闭眼」两张图；平时隐藏，眨眼时显示。
7. **导出**：`<id>.glb`（网格 + 贴图，顶点属性 `_joints` / `_weights` 是蒙皮数据，另有 `lid_half` / `lid_closed` 两个眼睑网格）
   和 `<id>.rig.json`（关节位置，前端按它摆骨架）。

## 换一个角色时要改的地方

`build_character.py` 顶部的 `K = dict(...)` 是从三视图上量出来的关键尺寸（参考身高 1.2 米）：
裙摆高度、肩和手的位置、眼睛中心与大小、脸 / 耳朵 / 发卡 / 印花所在的范围。换角色（比如帅帅）要重新量一遍；
调试时看 `--debug` 目录里的图。服装结构不同（裤子、短发、眼镜）的角色，分类规则也要相应改。

## 已知的不足

- 发梢是碎的：蒸馏版模型（5 步）在细发丝处不够干净。非蒸馏版（`gen_shape.py --full --steps 30`）可能更好，
  但在 CPU 上要一小时左右、内存约 12G 以上，这次没有跑完。
- 手臂和搭在上面的头发在网格上是连成一体的：手臂大幅前摆（坐姿）时，袖子附近会有被拉伸的痕迹。
- 坐下时裙子后片只是跟着大腿转，没有真正的布料垂坠；后片会插进座面里（被沙发挡住）。
- 发卡是画在头发表面的，没有单独的厚度。
