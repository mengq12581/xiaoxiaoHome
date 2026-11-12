"""第 1 步：把三视图切成 正 / 侧 / 背 三张去背景的 RGBA 图，作为多视图建模的输入。

背景是近似纯色的米色，角色有深色描边包住，所以做法是：
「颜色接近背景（或脚下阴影）的像素」里，凡是和图片边缘连通的都算背景。
裙子颜色虽然接近背景，但被描边围住、不与边缘连通，不会被误删。

用法：python prepare_views.py <三视图.jpg> <输出目录>
"""
import sys
from pathlib import Path

import cv2
import numpy as np

src, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
bgr = cv2.imread(str(src))
H, W = bgr.shape[:2]
rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB).astype(np.float32)

# 背景色取四周边框的中位数；阴影色取画面底部「比背景暗、偏米色」的像素中位数
border = np.concatenate([rgb[:40].reshape(-1, 3), rgb[-40:].reshape(-1, 3), rgb[:, :40].reshape(-1, 3), rgb[:, -40:].reshape(-1, 3)])
bg = np.median(border, axis=0)
d_bg = np.linalg.norm(rgb - bg, axis=2)

# 先粗分出角色的包围范围（三列）
fg_rough = d_bg > 60
cols = fg_rough.sum(0) > 10
runs, on = [], False
for x, c in enumerate(cols):
    if c and not on:
        on, s = True, x
    if not c and on:
        on = False
        if x - s > W * 0.05:
            runs.append((s, x))
assert len(runs) == 3, runs
rows = np.where(fg_rough.sum(1) > 10)[0]
y0, y1 = rows.min(), rows.max()

# 阴影：只出现在脚附近（画面下方 12%），颜色落在「背景色 → 阴影色」这条线上
shadow = np.array([224.0, 197.0, 172.0])
seg = shadow - bg
t = np.clip(((rgb - bg) @ seg) / (seg @ seg), 0, 1.25)
d_seg = np.linalg.norm(rgb - (bg + t[..., None] * seg), axis=2)
low = np.zeros((H, W), bool)
low[int(y1 - (y1 - y0) * 0.12):] = True

# 背景是带纸纹的米色，且上浅下深：逐行用左右边缘估计背景色，阈值放宽到 17
# （裙子离背景约 22，而且被描边围住，不会连通到边缘）
row_bg = np.median(np.concatenate([rgb[:, :60], rgb[:, -60:]], axis=1), axis=1)
row_bg = cv2.GaussianBlur(row_bg[None].astype(np.float32), (0, 0), 30, borderType=cv2.BORDER_REPLICATE)[0]
d_row = np.linalg.norm(rgb - row_bg[:, None, :], axis=2)
cand = (np.minimum(d_bg, d_row) < 17) | (low & (d_seg < 11))
n, labels = cv2.connectedComponents(cand.astype(np.uint8), connectivity=4)
edge = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
background = np.isin(labels, edge) & cand
alpha = (~background).astype(np.uint8) * 255
# 开运算去掉细碎残留，再把边缘收 1 像素并羽化，去掉米色毛边（每个视图只保留最大的一块，见下）
alpha = cv2.morphologyEx(alpha, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
alpha = cv2.erode(alpha, np.ones((3, 3), np.uint8))

names = ['front', 'side_right', 'back']  # 侧视图画的是她自己的右侧（脸朝画面右）
pad = 40
size = max(max(x1 - x0 for x0, x1 in runs), y1 - y0) + pad * 2
for (x0, x1), name in zip(runs, names):
    canvas = np.zeros((size, size, 4), np.uint8)
    a = alpha[y0:y1 + 1, x0:x1].copy()
    n, labels, stats, _ = cv2.connectedComponentsWithStats((a > 0).astype(np.uint8), connectivity=8)
    a[labels != 1 + np.argmax(stats[1:, cv2.CC_STAT_AREA])] = 0
    a = cv2.GaussianBlur(a, (0, 0), 1.2)
    crop = np.dstack([rgb[y0:y1 + 1, x0:x1].astype(np.uint8), a])
    h, w = crop.shape[:2]
    ox, oy = (size - w) // 2, (size - h) // 2
    canvas[oy:oy + h, ox:ox + w] = crop
    cv2.imwrite(str(out / f'{name}.png'), cv2.cvtColor(canvas, cv2.COLOR_RGBA2BGRA))
    print(name, (x0, x1), w, h, 'alpha cover', round(float((a > 127).mean()), 3))
print('rows', y0, y1, 'canvas', size)
