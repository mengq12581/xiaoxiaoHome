# 角色建模流水线：三视图 → 游戏里的 3D 角色

把 `assets/<id>_q_turnaround.jpg` 这样的 Q 版三视图（正 / 侧 / 背）变成 `assets/models/<id>.glb`（笑笑和帅帅都是这样做出来的），
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

# 1. 三视图切成三张去背景的图。最后一个参数是侧视图里角色脸朝哪边（笑笑 right，帅帅 left）
./venv/bin/python tools/character/prepare_views.py assets/xiaoxiao_q_turnaround.jpg work/xiaoxiao/views right

# 2. 多视图建模（首次运行会从 Hugging Face 下载约 5G 权重）
./venv/bin/python tools/character/gen_shape.py work/xiaoxiao/views work/xiaoxiao/raw.glb --steps 5 --octree 320

# 3. 后处理并导出到 assets/models/（尺寸配置读 tools/character/chars/xiaoxiao.json）
cd tools/character
../../venv/bin/python build_character.py ../../work/xiaoxiao/raw.glb ../../work/xiaoxiao/views ../../assets/models xiaoxiao --debug ../../work/xiaoxiao/debug
```

帅帅同理：把上面的 `xiaoxiao` 换成 `shuaishuai`，第 1 步的朝向换成 `left`。

`--debug` 目录里会留下每一步的预览图（顶点上色、蒙皮权重分区、贴图、成品多角度），不用开游戏就能检查。
`inspect_mesh.py <mesh.glb> <out.png>` 可以把任意网格渲染成多角度预览。

然后在 `config/characters.json` 里把角色的 `model` 指向 `assets/models/<id>.glb`、`model_type` 设为 `"gltf"`。
想换回程序化小人，把 `model_type` 改回 `"procedural"` 即可（代码还在 `src/character/model.ts`）。

## 用显卡跑（可选）

`gen_shape.py` 默认有 CUDA 就用显卡。要先装带 CUDA 的 PyTorch（`pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121`）。

| 情况 | 参数 |
| --- | --- |
| 显存 8G 以上 | 不用加参数 |
| 显存 4～6G（如 GTX 1650） | 加 `--offload` |
| 结果是空的 / 报 NaN（GTX 16 系的半精度常见问题） | 再加 `--fp32`；仍然不行或爆显存就 `--device cpu` |

显卡主要是快；画质的提升来自非蒸馏模型：`--full --steps 30 --octree 380`。这组参数在 CPU 上也能跑（约 1 小时、内存 12G 以上）。
**以上显卡路径没有在真机上验证过**（生成这两个模型的机器没有显卡）。

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

## 加一个新角色

1. 第 1、2 步照常跑。
2. 第 3 步先加 `--measure`：只做对齐和初步上色，在 `--debug` 目录输出 `0_measure.png`（带刻度的正 / 侧视图，每格 0.1 米）
   和 `0_shape.png`（白模多角度）。
3. 对着刻度图把关键尺寸量出来，写成 `chars/<id>.json`（照着 `xiaoxiao.json` / `shuaishuai.json` 抄，文件里有每个字段的说明）：
   服装类型、裙摆 / 裤脚 / 袜口 / 下摆高度、肩和手的位置、眼睛中心与大小、脸 / 耳朵 / 印花 / 发卡的范围。
4. 去掉 `--measure` 正式跑，看 `4_textured.png` 和 `2_skin_weights.png`，不对就改配置重跑（一次约 30 秒）。

目前支持两种服装：`dress`（连衣裙，裙摆跟大腿）和 `shirt_shorts`（T 恤 + 短裤 + 袜子）。别的服装结构要在
`build_character.py` 的「按部位贴标签」和「蒙皮权重」两段里加分支。

手臂和身体长在一起的角色（比如帅帅手插兜），在配置里把 `arms` 设成 `[]`：手臂不单独蒙皮，整体跟着上身，
否则一摆臂就会把身体侧面扯变形。

## 已知的不足

- （笑笑）发梢是碎的：蒸馏版模型（5 步）在细发丝处不够干净。非蒸馏版（`gen_shape.py --full --steps 30`）可能更好，
  但在 CPU 上要一小时左右、内存约 12G 以上，这次没有跑完。
- （笑笑）手臂和搭在上面的头发在网格上是连成一体的：手臂大幅前摆（坐姿）时，袖子附近会有被拉伸的痕迹。
- （笑笑）坐下时裙子后片只是跟着大腿转，没有真正的布料垂坠；后片会插进座面里（被沙发挡住）。
- （笑笑）发卡是画在头发表面的，没有单独的厚度。
- （帅帅）手臂不单独摆动：走路时手不前后摆，坐下时手也不搭在膝上。
- （帅帅）眼镜是画在脸上的，没有立体镜框；从侧面看不到镜腿。
- （帅帅）上衣下摆和手、裤兜交界处的边缘有些毛糙。
