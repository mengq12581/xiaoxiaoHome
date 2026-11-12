"""第 2 步：用腾讯开源的 Hunyuan3D-2mv（多视图 → 3D 网格）从 正 / 侧 / 背 三张图生成网格。

在 CPU 上也能跑（本仓库的模型就是在 4 核 CPU、无显卡的机器上生成的），只是慢。
需要先 clone https://github.com/Tencent-Hunyuan/Hunyuan3D-2 并把它加进 PYTHONPATH。

用法：python gen_shape.py <视图目录> <输出.glb> [--steps 5] [--octree 256] [--full] [--mirror-left]
  --full         用非蒸馏模型（hunyuan3d-dit-v2-mv，建议 30 步以上，CPU 上很慢）
  --device cuda  用显卡（默认 auto：有 CUDA 就用，没有用 CPU）
  --fp32         显卡上用单精度（默认半精度省显存；GTX 16 系半精度可能算出 NaN，那时加这个，但需要约 6G 以上显存）
  --offload      显存不够时，各部件轮流进显卡（4G 显存建议加）
  --mirror-left  把侧视图镜像后当作另一侧的视图一并输入（角色左右基本对称时可提高一致性）
"""
import argparse
import time
from pathlib import Path

import torch
from PIL import Image, ImageOps

from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline

ap = argparse.ArgumentParser()
ap.add_argument('views')
ap.add_argument('out')
ap.add_argument('--steps', type=int, default=5)
ap.add_argument('--octree', type=int, default=256)
ap.add_argument('--seed', type=int, default=12345)
ap.add_argument('--guidance', type=float, default=5.0)
ap.add_argument('--full', action='store_true')
ap.add_argument('--mirror-left', action='store_true')
ap.add_argument('--no-flashvdm', action='store_true')
ap.add_argument('--device', default='auto', choices=['auto', 'cpu', 'cuda'])
ap.add_argument('--fp32', action='store_true')
ap.add_argument('--offload', action='store_true')
args = ap.parse_args()

views = Path(args.views)
# Hunyuan3D-2mv 的视图约定：left = 从正面顺时针转 90°（角色脸朝画面左），right = 转 270°（脸朝画面右）。
# prepare_views.py 按侧视图里脸的朝向把文件命名为 side_left.png / side_right.png，这里直接对应。
side = 'right' if (views / 'side_right.png').exists() else 'left'
other = 'left' if side == 'right' else 'right'
images = {
    'front': Image.open(views / 'front.png').convert('RGBA'),
    'back': Image.open(views / 'back.png').convert('RGBA'),
    side: Image.open(views / f'side_{side}.png').convert('RGBA'),
}
if args.mirror_left:
    images[other] = ImageOps.mirror(images[side])

device = args.device if args.device != 'auto' else ('cuda' if torch.cuda.is_available() else 'cpu')
dtype = torch.float32 if (device == 'cpu' or args.fp32) else torch.float16
print(f'device={device} dtype={dtype}', flush=True)
t0 = time.time()
pipeline = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
    'tencent/Hunyuan3D-2mv',
    subfolder='hunyuan3d-dit-v2-mv' if args.full else 'hunyuan3d-dit-v2-mv-turbo',
    variant='fp16',
    device=device,
    dtype=dtype,
)
if not args.no_flashvdm:
    pipeline.enable_flashvdm()
    # FlashVDM 会另外加载一个半精度（fp16）的解码器；要和主模型用同一种精度
    pipeline.vae.to(device=device, dtype=dtype)
if args.offload and device == 'cuda':
    pipeline.enable_model_cpu_offload()
print(f'loaded in {time.time() - t0:.0f}s', flush=True)

t0 = time.time()
mesh = pipeline(
    image=images,
    num_inference_steps=args.steps,
    guidance_scale=args.guidance,
    octree_resolution=args.octree,
    num_chunks=20000,
    generator=torch.manual_seed(args.seed),
    output_type='trimesh',
)[0]
print(f'generated in {time.time() - t0:.0f}s: {len(mesh.vertices)} verts, {len(mesh.faces)} faces', flush=True)
import numpy as np

if len(mesh.faces) == 0 or not np.isfinite(np.asarray(mesh.vertices)).all():
    raise SystemExit('生成结果是空的或含 NaN：多半是这块显卡的半精度有问题，加 --fp32 重试；显存不够再加 --offload，或改用 --device cpu')
mesh.export(args.out)
