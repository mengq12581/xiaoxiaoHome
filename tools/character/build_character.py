"""第 3 步：把建模工具吐出来的原始网格做成游戏里能用的角色。

  原始网格 → 清理 / 摆正 / 归一到 1.2 米 → 减面 → 展 UV
          → 把三视图按正交投影「贴」回模型，烘焙成一张贴图（看不到的地方用最近的颜色补）
          → 按部位算蒙皮权重（头发跟头、裙摆跟大腿、四肢两段骨骼）
          → 生成眨眼用的眼睑贴片 → 导出 GLB + 关节信息 JSON

用法：python build_character.py <raw.glb> <视图目录> <输出目录> <名字> [--faces 60000] [--tex 2048] [--debug 目录] [--measure]

每个角色的关键尺寸和服装类型写在 chars/<名字>.json 里。新角色先加 --measure 跑一遍，
对着 debug 目录里的 0_measure.png（带刻度的正 / 侧视图）把尺寸量出来，再正式跑。
"""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np
import trimesh
from scipy.spatial import cKDTree
from scipy.sparse import coo_matrix, diags

from meshkit import VIEWS, preview, project, raster, sample, view_axes  # noqa: F401

REF_H = 1.2  # 参考身高（米），与 src/character/rig.ts 的 REFERENCE_HEIGHT 一致

ap = argparse.ArgumentParser()
ap.add_argument('raw')
ap.add_argument('views')
ap.add_argument('out')
ap.add_argument('name')
ap.add_argument('--faces', type=int, default=60000)
ap.add_argument('--tex', type=int, default=2048)
ap.add_argument('--debug', default=None)
ap.add_argument('--config', default=None, help='角色的关键尺寸，默认 chars/<名字>.json')
ap.add_argument('--measure', action='store_true', help='只做对齐和初步上色，输出带刻度的正 / 侧视图（量尺寸用），然后退出')
args = ap.parse_args()
dbg = Path(args.debug) if args.debug else None
if dbg:
    dbg.mkdir(parents=True, exist_ok=True)


def save_dbg(name, rgb):
    if dbg:
        cv2.imwrite(str(dbg / name), cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))


# ───────── 0. 参考图 ─────────

def load_view(path, mirror=False):
    im = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if mirror:
        im = im[:, ::-1].copy()
    rgb = cv2.cvtColor(im[..., :3], cv2.COLOR_BGR2RGB).astype(np.float32)
    a = im[..., 3]
    ys, xs = np.where(a > 127)
    return dict(rgb=rgb, alpha=a, bbox=(xs.min(), xs.max() + 1, ys.min(), ys.max() + 1))


def remove_clip(view):
    """左侧视图是右侧镜像出来的，但发卡只在右边：把镜像图里的发卡涂成头发色。"""
    rgb, a = view['rgb'], view['alpha']
    H = a.shape[0]
    x0, x1, y0, y1 = view['bbox']
    bright = ((rgb.min(2) > 150) & (a > 200)).astype(np.uint8)
    n, labels, stats, cent = cv2.connectedComponentsWithStats(bright, connectivity=8)
    for i in range(1, n):
        area = stats[i, cv2.CC_STAT_AREA]
        cy = cent[i][1]
        if 0.0008 * H * H < area < 0.02 * H * H and cy < y0 + (y1 - y0) * 0.27:
            m = cv2.dilate((labels == i).astype(np.uint8), np.ones((25, 25), np.uint8)) > 0
            hair = np.median(rgb[(rgb.max(2) < 70) & (a > 200)], axis=0)
            rgb[m & (a > 0)] = hair
            print('  removed mirrored hair clip, area', area)


views_dir = Path(args.views)
# 侧视图只画了一边：脸朝右 = 角色自己的右侧。另一边用镜像补
SIDE = 'right' if (views_dir / 'side_right.png').exists() else 'left'
OTHER = 'left' if SIDE == 'right' else 'right'
REF = {
    'front': load_view(views_dir / 'front.png'),
    'back': load_view(views_dir / 'back.png'),
    SIDE: load_view(views_dir / f'side_{SIDE}.png'),
    OTHER: load_view(views_dir / f'side_{SIDE}.png', mirror=True),
}

cfg_path = Path(args.config) if args.config else Path(__file__).parent / 'chars' / f'{args.name}.json'
K = json.loads(cfg_path.read_text(encoding='utf8')) if cfg_path.exists() else {}
if not K and not args.measure:
    raise SystemExit(f'缺少角色配置 {cfg_path}；新角色请先加 --measure 量尺寸')
OUTFIT = K.get('outfit', 'dress')
if K.get('clip_box'):
    remove_clip(REF[OTHER])
for v in REF.values():
    # 采样时避开剪影最外圈的描边：把 alpha 往里收
    v['inner'] = cv2.erode(v['alpha'], np.ones((17, 17), np.uint8)).astype(np.float32) / 255.0
    v['alpha_f'] = v['alpha'].astype(np.float32) / 255.0

# ───────── 1. 清理、摆正、归一 ─────────

mesh = trimesh.load(args.raw, force='mesh', process=True)
comps = mesh.split(only_watertight=False)
mesh = max(comps, key=lambda c: len(c.faces))
print('raw', len(mesh.vertices), len(mesh.faces), 'components', len(comps))


def silhouette_iou(V, F, name, res=256):
    """把网格在某视图下的剪影缩放到参考图的包围盒里，算 IoU。"""
    axes = view_axes(name=name)
    xy, _ = project(V, axes)
    b = (xy[:, 0].min(), xy[:, 0].max(), xy[:, 1].min(), xy[:, 1].max())
    ids, _, _ = raster(V, F, axes, (res, res), b)
    x0, x1, y0, y1 = REF[name]['bbox']
    ref = cv2.resize(REF[name]['alpha'][y0:y1, x0:x1], (res, res), interpolation=cv2.INTER_AREA) > 127
    m = ids >= 0
    return (m & ref).sum() / max(1, (m | ref).sum())


def rot_y(deg):
    a = np.radians(deg)
    return np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]])


V0 = np.asarray(mesh.vertices, float)
F0 = np.asarray(mesh.faces)
sub = F0[:: max(1, len(F0) // 40000)]
best = None
for yaw in (0, 90, 180, 270):
    Vr = V0 @ rot_y(yaw).T
    score = silhouette_iou(Vr, sub, 'front') + silhouette_iou(Vr, sub, SIDE) + silhouette_iou(Vr, sub, 'back')
    print(f'  yaw {yaw}: silhouette score {score:.3f}')
    if best is None or score > best[0]:
        best = (score, yaw)
V0 = V0 @ rot_y(best[1]).T
print('orientation yaw', best[1])

lo, hi = V0.min(0), V0.max(0)
s = REF_H / (hi[1] - lo[1])
V0 = (V0 - [(lo[0] + hi[0]) / 2, lo[1], 0]) * s
# 前后位置：以脚（最低 6%）的中心为 z = 0
feet = V0[V0[:, 1] < REF_H * 0.06]
V0[:, 2] -= (feet[:, 2].min() + feet[:, 2].max()) / 2 - 0.012
mesh = trimesh.Trimesh(V0, F0, process=False)

# ───────── 2. 减面 + 轻度平滑 ─────────

if len(mesh.faces) > args.faces:
    import fast_simplification

    Vs, Fs = fast_simplification.simplify(np.asarray(mesh.vertices, np.float32), np.asarray(mesh.faces), target_count=args.faces, agg=5)
    mesh = trimesh.Trimesh(Vs, Fs, process=True)
    mesh = max(mesh.split(only_watertight=False), key=lambda c: len(c.faces))
trimesh.smoothing.filter_taubin(mesh, lamb=0.5, nu=-0.53, iterations=6)
V = np.asarray(mesh.vertices, float)
F = np.asarray(mesh.faces)
N = np.asarray(mesh.vertex_normals, float)
print('simplified', len(V), len(F), 'bounds', V.min(0).round(3), V.max(0).round(3))

# ───────── 3. 三视图投影上色 ─────────


class Projector:
    """把参考图按正交投影对到网格上；对齐方式：网格剪影包围盒 ↔ 参考图包围盒。"""

    def __init__(self, V, F, res=1400):
        self.views = {}
        for name in VIEWS:
            axes = view_axes(name=name)
            xy, _ = project(V, axes)
            pad = 0.01
            b = (xy[:, 0].min() - pad, xy[:, 0].max() + pad, xy[:, 1].min() - pad, xy[:, 1].max() + pad)
            _, dimg, _ = raster(V, F, axes, (res, res), b)
            x0, x1, y0, y1 = REF[name]['bbox']
            self.views[name] = dict(axes=axes, b=b, dimg=dimg, res=res,
                                    mb=(xy[:, 0].min(), xy[:, 0].max(), xy[:, 1].min(), xy[:, 1].max()), ib=(x0, x1, y0, y1))

    def shade(self, P, Nrm, power=4.0, eps=0.012):
        acc = np.zeros((len(P), 3), np.float32)
        wsum = np.zeros(len(P), np.float32)
        for name, v in self.views.items():
            r, u, d = v['axes']
            xy, depth = project(P, v['axes'])
            b, res = v['b'], v['res']
            dpx = np.stack([(xy[:, 0] - b[0]) / (b[1] - b[0]) * res, (b[3] - xy[:, 1]) / (b[3] - b[2]) * res], 1)
            di = np.clip(dpx.astype(int), 0, res - 1)
            visible = depth >= v['dimg'][di[:, 1], di[:, 0]] - eps
            mb, ib = v['mb'], v['ib']
            ipx = np.stack([ib[0] + (xy[:, 0] - mb[0]) / (mb[1] - mb[0]) * (ib[1] - ib[0]),
                            ib[2] + (mb[3] - xy[:, 1]) / (mb[3] - mb[2]) * (ib[3] - ib[2])], 1)
            col = sample(REF[name]['rgb'], ipx)
            inner = sample(REF[name]['inner'], ipx)[:, 0]
            w = np.clip(Nrm @ d, 0, 1) ** power * visible * (inner > 0.97)
            if name == OTHER:
                w *= 0.999  # 镜像出来的视图，同等条件下让位给真实视图
            acc += col * w[:, None]
            wsum += w
        ok = wsum > 0.02
        out = np.zeros_like(acc)
        out[ok] = acc[ok] / wsum[ok, None]
        return out, ok


def fill_nearest(P, col, ok):
    if ok.all():
        return col
    src = np.where(ok)[0]
    if len(src) > 400000:
        src = src[:: len(src) // 400000 + 1]
    _, j = cKDTree(P[src]).query(P[~ok])
    col = col.copy()
    col[~ok] = col[src[j]]
    return col



def lum(c):
    return c @ np.array([0.299, 0.587, 0.114], np.float32)


def adjacency(n, F):
    i = np.concatenate([F[:, 0], F[:, 1], F[:, 2], F[:, 1], F[:, 2], F[:, 0]])
    j = np.concatenate([F[:, 1], F[:, 2], F[:, 0], F[:, 0], F[:, 1], F[:, 2]])
    A = coo_matrix((np.ones(len(i)), (i, j)), shape=(n, n)).tocsr()
    A.data[:] = 1
    return diags(1.0 / np.maximum(1, np.asarray(A.sum(1)).ravel())) @ A  # 行归一化：一次乘法 = 取邻居平均


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


proj = Projector(V, F)
for name in ('front', SIDE, 'back'):
    print(f'  silhouette IoU {name}: {silhouette_iou(V, F, name):.3f}')
vcol, vok = proj.shade(V, N)
vcol = fill_nearest(V, vcol, vok)
A = adjacency(len(V), F)

if args.measure:
    # 带刻度的正视图 + 侧视图（脸朝右），每格 0.1 米
    fc = vcol[F].mean(1)
    R_, b_ = 1000, (-0.45, 0.45, -0.02, 1.24)
    tiles = []
    for name in ('front', 'right'):
        axes = view_axes(name=name)
        W_ = int(R_ * 0.9 / 1.26)
        ids_, _, _ = raster(V, F, axes, (W_, R_), b_)
        img = np.full((R_, W_, 3), 255, np.uint8)
        img[ids_ >= 0] = fc[ids_[ids_ >= 0]].astype(np.uint8)
        for g in np.arange(0, 1.21, 0.1):
            yy = int((b_[3] - g) / (b_[3] - b_[2]) * R_)
            cv2.line(img, (0, yy), (W_, yy), (0, 120, 255), 1)
            cv2.putText(img, f'{g:.1f}', (2, yy - 2), 0, 0.4, (0, 0, 255), 1)
        for g in np.arange(-0.4, 0.41, 0.1):
            xx = int((g - b_[0]) / (b_[1] - b_[0]) * W_)
            cv2.line(img, (xx, 0), (xx, R_), (0, 200, 0), 1)
            cv2.putText(img, f'{g:.1f}', (xx + 2, 12), 0, 0.4, (0, 120, 0), 1)
        tiles.append(img)
    out_dir = dbg or Path('.')
    cv2.imwrite(str(out_dir / '0_measure.png'), cv2.cvtColor(np.concatenate(tiles, 1), cv2.COLOR_RGB2BGR))
    cv2.imwrite(str(out_dir / '0_shape.png'), preview(V, F, None, yaws=(0, 40, 90, 180, 270), size=640, pitch=5))
    print('measure image written to', out_dir / '0_measure.png')
    raise SystemExit(0)

# ───────── 4. 把脸磨平 ─────────
# 建模工具会把大眼睛做成凹进去的眼窝、鼻子做成小鼓包；Q 版的脸应该是一张光滑的面，五官靠贴图。
fb = K['face_box']
is_hair_v = lum(vcol) < 115
if not K.get('long_hair', False):
    is_hair_v &= V[:, 1] > K['neck_y'] - 0.03   # 短发只在头上；身上的深色是衣服
for _ in range(2):
    is_hair_v = (A @ is_hair_v.astype(float)) > 0.5
face_v = (~is_hair_v) & (V[:, 0] > fb[0]) & (V[:, 0] < fb[1]) & (V[:, 1] > fb[2]) & (V[:, 1] < fb[3]) & (V[:, 2] > fb[4])
wface = face_v.astype(float)
for _ in range(3):
    wface = A @ wface  # 边缘渐变，避免磨平区域的边界起棱
for _ in range(60):
    V = V + wface[:, None] * (A @ V - V) * 0.6
mesh = trimesh.Trimesh(V, F, process=False)
N = np.asarray(mesh.vertex_normals, float)
proj = Projector(V, F)
vcol, vok = proj.shade(V, N)
vcol = fill_nearest(V, vcol, vok)
is_hair_v = lum(vcol) < 115
if not K.get('long_hair', False):
    is_hair_v &= V[:, 1] > K['neck_y'] - 0.03   # 短发只在头上；身上的深色是衣服
for _ in range(2):
    is_hair_v = (A @ is_hair_v.astype(float)) > 0.5
save_dbg('1_vertex_color.png', preview(V, F, vcol[F].mean(1), size=420))

# ───────── 5. 蒙皮权重 ─────────
JOINTS = ['body', 'torso', 'head', 'armL', 'foreL', 'armR', 'foreR', 'legL', 'shinL', 'legR', 'shinR']
J = {n: i for i, n in enumerate(JOINTS)}
W = np.zeros((len(V), len(JOINTS)))
x, y, z = V[:, 0], V[:, 1], V[:, 2]
hair = is_hair_v.astype(float)

# 手臂：离「肩 → 手」这条线足够近、且不是头发的顶点
arm_w = {}
arm_t = np.zeros(len(V))
# 有的角色手插在兜里、手臂和身体长在一起（见配置的 arms）：那一侧不单独蒙皮，整条手臂跟着上身；
# 但「哪里是手臂」仍然要算出来（arm_geo），贴图分类要用
arm_geo = np.zeros(len(V))
for side, sgn in (('L', 1), ('R', -1)):
    S = np.array(K['shoulder']) * [sgn, 1, 1]
    Hd = np.array(K['hand']) * [sgn, 1, 1]
    ax = Hd - S
    L = np.linalg.norm(ax)
    ax /= L
    t = (V - S) @ ax
    dist = np.linalg.norm(V - S - np.clip(t, 0, L)[:, None] * ax, axis=1)
    tn = np.clip(t / L, 0, 1.15)
    r_in = 0.04 + 0.022 * (1 - tn) + K.get('hand_extra_r', 0.0) * smoothstep(0.75, 1.0, tn)   # 袖子处略粗；手掌可再放宽
    w = smoothstep(r_in + 0.018, r_in, dist) * smoothstep(-0.08, 0.02, t / L) * (t / L < 1.25)
    # 手臂贴着身体侧面：轴线内侧只取 3 厘米，免得把身体侧面也算进来
    axis_x = S[0] + (Hd[0] - S[0]) * np.clip((S[1] - y) / (S[1] - Hd[1]), 0, 1.2)
    w *= smoothstep(-0.04, -0.02, sgn * (x - axis_x))
    arm_geo = np.maximum(arm_geo, w)
    arm_t = np.where(w > 0.3, tn, arm_t)
    if side not in K.get('arms', ['L', 'R']):
        arm_w[side] = np.zeros(len(V))
        continue
    # 搭在手臂上的发丝和手臂在网格上是连着的：让它们半跟着手臂动，手臂前摆时接缝处不会被扯出洞
    w = w * (1 - 0.45 * hair)
    # 肩头留给上身：从肩到袖子中段逐渐过渡到手臂
    w = w * (0.25 + 0.75 * smoothstep(0.0, 0.3, t / L))
    arm_w[side] = w
    te = K['upper_arm'] / L
    fore = smoothstep(te - 0.12, te + 0.12, t / L)
    W[:, J['arm' + side]] = w * (1 - fore)
    W[:, J['fore' + side]] = w * fore
arm_any = np.clip(arm_w['L'] + arm_w['R'], 0, 1)
rest = 1 - arm_any

# 腿：裙摆以下、靠近腿轴线
leg_any = np.zeros(len(V))
leg_top = K['hem_y'] if OUTFIT == 'dress' else K['crotch_y']   # 腿从哪里开始单独动：裙摆下沿 / 裤裆
for side, sgn in (('L', 1), ('R', -1)):
    d = np.hypot(x - sgn * K['hip_x'], z - K['leg_z'])
    near = np.maximum(smoothstep(0.1, 0.075, d), smoothstep(leg_top - 0.015, leg_top - 0.03, y))  # 再往下全是腿脚
    w = near * smoothstep(leg_top + 0.035, leg_top - 0.01, y) * smoothstep(-0.006, 0.006, sgn * x) * (1 - hair * (y > leg_top)) * rest
    shin = smoothstep(K['knee_y'] + 0.025, K['knee_y'] - 0.025, y)
    W[:, J['leg' + side]] += w * (1 - shin)
    W[:, J['shin' + side]] += w * shin
    leg_any += w
rest = rest * (1 - np.clip(leg_any, 0, 1))

# 头：颈部以上全部；垂到肩以下的头发越往下越跟着上身
head = smoothstep(K['neck_y'] - 0.02, K['neck_y'] + 0.035, y)
hair_follow = 1 - 0.7 * smoothstep(K['neck_y'], 0.32, y)   # 发梢 30% 跟头、70% 跟上身
head_w = np.where(is_hair_v, np.maximum(head, hair_follow), head) if K.get('long_hair', False) else head
W[:, J['head']] = head_w * rest
rest = rest * (1 - head_w)

# 裙摆：越靠下越跟大腿（坐下时前片搭在腿上），后片跟得少一些；头发不参与
skirt = smoothstep(0.42, 0.23, y) * (1 - hair) * (OUTFIT == 'dress')
frontness = smoothstep(-0.1, 0.06, z)
thigh_amt = skirt * (0.35 + 0.5 * frontness)
wl = smoothstep(-0.05, 0.05, x)
W[:, J['legL']] += rest * thigh_amt * wl
W[:, J['legR']] += rest * thigh_amt * (1 - wl)
rest = rest * (1 - thigh_amt)

# 其余：胯（下）↔ 上身（上）
torso = smoothstep(0.3, 0.44, y)
W[:, J['torso']] += rest * torso
W[:, J['body']] += rest * (1 - torso)

W /= W.sum(1, keepdims=True)
for _ in range(8):  # 在网格上把权重抹匀，关节处不起褶
    W = 0.5 * W + 0.5 * (A @ W)
W /= W.sum(1, keepdims=True)
top = np.argsort(-W, axis=1)[:, :4]
Wtop = np.take_along_axis(W, top, 1)
Wtop[Wtop < 0.02] = 0
Wtop /= Wtop.sum(1, keepdims=True)

part_rgb = np.array([[150, 150, 150], [200, 200, 120], [60, 60, 60], [230, 80, 80], [250, 160, 60], [80, 80, 230], [60, 160, 250],
                     [60, 200, 90], [20, 120, 50], [200, 60, 200], [120, 20, 120]], float)
save_dbg('2_skin_weights.png', preview(V, F, (W @ part_rgb)[F].mean(1), size=420))
print('stage 5 done: skin weights')

# ───────── 6. 展 UV，烘焙贴图 ─────────
import xatlas

atlas = xatlas.Atlas()
atlas.add_mesh(V.astype(np.float32), F.astype(np.uint32))
po = xatlas.PackOptions()
po.padding = 4
po.resolution = args.tex
atlas.generate(pack_options=po)
vmap, F2, UV = atlas[0]
F2 = F2.astype(np.int64)
V2, N2 = V[vmap], N[vmap]
T = args.tex
print('atlas', len(V2), 'verts', atlas.chart_count if hasattr(atlas, 'chart_count') else '', 'charts')

tri = np.round(np.stack([UV[F2][..., 0] * T, (1 - UV[F2][..., 1]) * T], -1) * 16).astype(np.int32)
ids = np.full((T, T), -1, np.int32)
for f in range(len(F2)):
    cv2.fillConvexPoly(ids, tri[f], f, lineType=cv2.LINE_8, shift=4)
ty, tx = np.where(ids >= 0)
tf = ids[ty, tx]
# 纹素中心的重心坐标
p = np.stack([(tx + 0.5) / T, 1 - (ty + 0.5) / T], 1)
a, b, c = UV[F2[tf, 0]], UV[F2[tf, 1]], UV[F2[tf, 2]]
v0, v1, v2 = b - a, c - a, p - a
den = v0[:, 0] * v1[:, 1] - v1[:, 0] * v0[:, 1]
den = np.where(np.abs(den) < 1e-12, 1e-12, den)
bb = (v2[:, 0] * v1[:, 1] - v1[:, 0] * v2[:, 1]) / den
bc = (v0[:, 0] * v2[:, 1] - v2[:, 0] * v0[:, 1]) / den
bary = np.clip(np.stack([1 - bb - bc, bb, bc], 1), 0, 1)
bary /= bary.sum(1, keepdims=True)


def interp(attr):
    return (attr[F2[tf]] * bary[..., None]).sum(1) if attr.ndim == 2 else (attr[F2[tf]] * bary).sum(1)


P = interp(V2)
Nt = interp(N2)
Nt /= np.linalg.norm(Nt, axis=1, keepdims=True) + 1e-12
Wt = interp(W[vmap])
arm_t_tex = interp(arm_t[vmap])
arm_geo_tex = interp(arm_geo[vmap])

raw, ok = proj.shade(P, Nt)
raw = fill_nearest(P, raw, ok)



def single_view(name, min_facing=0.15):
    """只用某一个视图取色（不与其他视图混合）。返回 (颜色, 是否可用)。"""
    v = proj.views[name]
    r, u, d = v['axes']
    xy, depth = project(P, v['axes'])
    dpx = np.stack([(xy[:, 0] - v['b'][0]) / (v['b'][1] - v['b'][0]) * v['res'], (v['b'][3] - xy[:, 1]) / (v['b'][3] - v['b'][2]) * v['res']], 1)
    di = np.clip(dpx.astype(int), 0, v['res'] - 1)
    vis = (depth >= v['dimg'][di[:, 1], di[:, 0]] - 0.012) & (Nt @ d > min_facing)
    mb, ib = v['mb'], v['ib']
    ipx = np.stack([ib[0] + (xy[:, 0] - mb[0]) / (mb[1] - mb[0]) * (ib[1] - ib[0]), ib[2] + (mb[3] - xy[:, 1]) / (mb[3] - mb[2]) * (ib[3] - ib[2])], 1)
    col = sample(REF[name]['rgb'], ipx)
    vis &= sample(REF[name]['alpha_f'], ipx)[:, 0] > 0.9
    return col, vis


# 脸、胸前印花直接用正面原画；发卡只看右侧视图（两个视图混在一起会出重影）
front_col, front_vis = single_view('front')
right_col, right_vis = single_view('right', 0.05)

# —— 按部位贴标签（标签表随服装类型不同） ——
HAIR, SKIN = 0, 1
rg = raw[:, 0] - raw[:, 1]
w_head = Wt[:, J['head']]
w_leg = Wt[:, [J['legL'], J['shinL'], J['legR'], J['shinR']]].sum(1)
w_shin = Wt[:, [J['shinL'], J['shinR']]].sum(1)
w_arm = Wt[:, [J['armL'], J['foreL'], J['armR'], J['foreR']]].sum(1)
fbx0 = K['face_box']
eb = K['ear_box']
on_head = P[:, 1] > K['neck_y'] + 0.02
in_face = (P[:, 0] > fbx0[0]) & (P[:, 0] < fbx0[1]) & (P[:, 1] < fbx0[3]) & (P[:, 2] > 0.02)
in_ear = (np.abs(P[:, 0]) > eb[0]) & (P[:, 1] > eb[1]) & (P[:, 1] < eb[2]) & (P[:, 2] > eb[3]) & (P[:, 2] < eb[4])
pb = K['print_box']
in_print = (P[:, 0] > pb[0]) & (P[:, 0] < pb[1]) & (P[:, 1] > pb[2]) & (P[:, 1] < pb[3]) & (P[:, 2] > 0)

if OUTFIT == 'dress':
    # 0 头发 1 皮肤 2 裙子 3 发卡
    DRESS, CLIP = 2, 3
    LABELS = ['hair', 'skin', 'dress', 'clip']
    ROUGH = [0.5, 0.62, 0.9, 0.45]
    DARK = {HAIR}
    PRINT_ON = DRESS
    label = np.full(len(P), DRESS, np.uint8)
    cb = K['clip_box']
    in_clip = on_head & (P[:, 0] > cb[0]) & (P[:, 0] < cb[1]) & (P[:, 1] > cb[2]) & (P[:, 1] < cb[3])
    # 头上只有三处不是头发：脸、耳朵、发卡。其余一律按头发处理（建模和原画对不齐时，浅色会漏到头发上）
    label[on_head] = np.where((in_clip & right_vis & (lum(right_col) > 150))[on_head], CLIP, np.where((in_face | in_ear)[on_head], SKIN, HAIR))
    label[(~on_head) & (P[:, 1] > K['neck_y'] - 0.035) & (rg > 38)] = SKIN  # 脖子
    label[(w_arm > 0.5) & (arm_t_tex > K['sleeve_t'])] = SKIN             # 袖口以下的手臂和手
    label[(P[:, 1] < K['hem_y'] - 0.004) & ((w_shin > 0.2) | (w_leg > 0.75))] = SKIN  # 腿、脚
    # 头发：颜色够深，并且附近的顶点也是头发（排除描边线、指缝线这些深色细线）；四肢上不会有头发
    hair_prior = interp((A @ (A @ (A @ is_hair_v.astype(float))))[vmap])
    label[(lum(raw) < 115) & (hair_prior > 0.2) & (w_arm < 0.6) & (w_leg < 0.6)] = HAIR
    label[(P[:, 1] < K['hem_y'] - 0.02)] = SKIN                           # 裙摆以下没有头发
else:
    # T 恤 + 短裤 + 袜子：0 头发 1 皮肤 2 上衣 3 短裤 4 袜子
    SHIRT, SHORTS, SOCKS = 2, 3, 4
    LABELS = ['hair', 'skin', 'shirt', 'shorts', 'socks']
    ROUGH = [0.5, 0.62, 0.9, 0.85, 0.95]
    DARK = {HAIR, SHORTS}
    PRINT_ON = SHIRT
    yy = P[:, 1]
    dark = lum(raw) < 120
    skinish = (rg > 16) & ~dark
    below_sleeve = arm_t_tex > K['sleeve_t']
    label = np.full(len(P), SHIRT, np.uint8)
    # 手臂：袖口以下是皮肤。几何上确定是手臂的直接算；手臂边缘再参考颜色
    label[(arm_geo_tex > 0.5) & below_sleeve] = SKIN
    label[(arm_geo_tex > 0.15) & (arm_t_tex > K['sleeve_t'] - 0.04) & skinish] = SKIN
    label[(arm_geo_tex > 0.15) & (arm_t_tex > 0.8) & ~dark] = SKIN        # 手掌：建模的手和原画位置对不齐，只要不是深色都算皮肤
    if 'hand_x_min' in K:  # 垂在短裤两侧的手：比身体侧面更靠外、上衣下摆附近的浅色
        label[(np.abs(P[:, 0]) > K['hand_x_min']) & (yy < K['waist_y'] + 0.04) & (yy > K['hem_y']) & ~dark] = SKIN
    label[in_print] = SHIRT
    label[dark & (yy < K['waist_y'] + 0.06) & (arm_geo_tex < 0.5)] = SHORTS   # 上衣下摆以下的深色是短裤（更高处的深色只会是描边线）
    label[(yy < K['hem_y']) & (w_leg > 0.5)] = SKIN         # 裤脚以下是腿
    label[yy < K['sock_y']] = SOCKS
    # 脖子：领口以上、头以下（下巴底下三个视图都看不到，不能靠颜色）
    neck_r = np.hypot(P[:, 0], P[:, 2] - K.get('neck_z', -0.02))
    label[(~on_head) & (yy > K['neck_y'] - 0.03) & (neck_r < K.get('neck_r', 0.075))] = SKIN
    label[(~on_head) & (yy > K['neck_y'] - 0.06) & (neck_r < K.get('neck_r', 0.075) + 0.02) & skinish] = SKIN
    # 头：脸和耳朵是皮肤，其余是头发。脸的范围里也有刘海、耳朵范围里也有鬓角：原画上是深色的算头发，
    # 眼睛和镜片范围除外（瞳孔、眉毛、镜框也是深色，那里直接用原画）
    ex_, ey_ = K['eye']
    in_lens = (((np.abs(P[:, 0]) - ex_) / (K['eye_r'][0] * 1.5)) ** 2 + ((P[:, 1] - ey_) / (K['eye_r'][1] * 1.4)) ** 2 < 1) & (P[:, 2] > 0.05)
    label[on_head] = np.where((in_face | in_ear)[on_head], SKIN, HAIR)
    label[on_head & dark & ~in_lens] = HAIR
    label[on_head & in_face & front_vis & (lum(front_col) < 105) & ~in_lens & (P[:, 1] > ey_ + K['eye_r'][1] * 0.6)] = HAIR

# 在贴图空间里做「多数表决」去掉零碎斑点和描边细线
lab_img = np.full((T, T), 255, np.uint8)
lab_img[ty, tx] = label
valid = (lab_img != 255).astype(np.float32)
votes = []
for k in range(len(LABELS)):
    votes.append(cv2.blur((lab_img == k).astype(np.float32), (9, 9)))
label = np.argmax(np.stack(votes, -1), -1)[ty, tx].astype(np.uint8)

palette = np.zeros((len(LABELS), 3), np.float32)
for k in range(len(LABELS)):
    m = label == k
    if m.sum() < 50:
        palette[k] = (255, 0, 255)
        continue
    c = raw[m]
    L = lum(c)
    # 取该部位「典型」的颜色：头发取偏暗的一半，其余取偏亮的一半（避开描边和混色）
    sel = L <= np.median(L) if k in DARK else L >= np.median(L)
    palette[k] = np.median(c[sel], axis=0)
print('palette', {n: palette[i].round().tolist() for i, n in enumerate(LABELS)})
palette[HAIR] = np.maximum(palette[HAIR], [40, 35, 36])  # 纯黑在光照下看不出体积，略提一点
color = palette[label].copy()

# 脸：正面可见的皮肤直接用原画（眼睛、眉毛、腮红、嘴）
fbx = K['face_box']
face_t = front_vis & (label == SKIN) & (P[:, 0] > fbx[0]) & (P[:, 0] < fbx[1]) & (P[:, 1] > fbx[2] - 0.03) & (P[:, 1] < fbx[3]) & (P[:, 2] > 0.0)
color[face_t] = front_col[face_t]
# 胸前印花：正面、胸口范围内与衣服底色明显不同的像素用原画
base = palette[PRINT_ON]
if OUTFIT == 'dress':
    differs = ((front_col[:, 0] - front_col[:, 2]) > 72) & (lum(front_col) > 150)
else:
    differs = np.linalg.norm(front_col - base, axis=1) > 22
print_t = front_vis & (label == PRINT_ON) & in_print & differs
color[print_t] = front_col[print_t]
print('face texels', int(face_t.sum()), 'print texels', int(print_t.sum()))

tex = np.zeros((T, T, 3), np.float32)
tex[ty, tx] = color
# 岛外留白用最近的颜色填上（避免 mipmap 把底色渗进来）
_, lbl = cv2.distanceTransformWithLabels((valid == 0).astype(np.uint8), cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
lut = np.zeros((lbl.max() + 1, 3), np.float32)
lut[lbl[ty, tx]] = color
tex = lut[lbl]
tex_u8 = np.clip(tex, 0, 255).astype(np.uint8)
# 粗糙度贴图（glTF 约定：G 通道 = 粗糙度，B 通道 = 金属度）：头发略有光泽，皮肤柔和，衣服哑光
rough_of = np.array(ROUGH, np.float32)
lut_r = np.zeros(lbl.max() + 1, np.float32)
lut_r[lbl[ty, tx]] = rough_of[label]
rough_img = np.zeros((T, T, 3), np.uint8)
rough_img[..., 1] = np.clip(cv2.blur(lut_r[lbl], (5, 5)) * 255, 0, 255).astype(np.uint8)
save_dbg('3_texture.png', tex_u8)
fcol = np.zeros((len(F2), 3))
cnt = np.bincount(tf, minlength=len(F2)).astype(float)
for ch in range(3):
    fcol[:, ch] = np.bincount(tf, weights=color[:, ch], minlength=len(F2)) / np.maximum(1, cnt)
save_dbg('4_textured.png', preview(V2, F2, fcol, yaws=(0, 40, 90, 180, 270, 320), size=640, pitch=5))
np.savez(str((dbg or Path('.')) / 'stage6.npz'), V=V2, F=F2, fcol=fcol)
print('stage 6 done: texture')

# ───────── 7. 眼睑贴片（眨眼用） ─────────
# 把眼睛范围内、朝前的三角面复制一份并沿法线抬高一点，贴上「半闭 / 闭眼」的贴图；平时隐藏。
from PIL import Image, ImageDraw

ex, ey = K['eye']
rx, ry = K['eye_r']
skin = tuple(int(v) for v in palette[SKIN].round())
lash = (58, 36, 30)


def lid_texture(closed: bool, size=256):
    im = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    s = size
    if closed:
        d.ellipse([0.04 * s, 0.04 * s, 0.96 * s, 0.96 * s], fill=skin + (255,))
        # 闭眼：一条向下弯的弧线 + 外眼角两根睫毛（u = 1 是外侧）
        pts = [(s * (0.14 + 0.72 * t), s * (0.56 + 0.1 * np.sin(np.pi * t))) for t in np.linspace(0, 1, 40)]
        d.line(pts, fill=lash + (255,), width=int(s * 0.05), joint='curve')
        d.line([(0.84 * s, 0.57 * s), (0.95 * s, 0.5 * s)], fill=lash + (255,), width=int(s * 0.035))
        d.line([(0.78 * s, 0.62 * s), (0.9 * s, 0.63 * s)], fill=lash + (255,), width=int(s * 0.03))
    else:
        # 半闭：上半只眼被眼皮盖住，眼皮下沿一条睫毛线
        d.pieslice([0.04 * s, 0.04 * s, 0.96 * s, 0.96 * s], 180, 360, fill=skin + (255,))
        d.rectangle([0.04 * s, 0.46 * s, 0.96 * s, 0.52 * s], fill=skin + (255,))
        pts = [(s * (0.1 + 0.8 * t), s * (0.5 + 0.035 * np.sin(np.pi * t))) for t in np.linspace(0, 1, 40)]
        d.line(pts, fill=lash + (255,), width=int(s * 0.055), joint='curve')
    return im


def lid_mesh(closed: bool):
    parts_v, parts_uv, parts_f, parts_n = [], [], [], []
    off = 0
    for sgn in (1, -1):
        cx = sgn * ex
        fc_ = V[F].mean(1)
        fn_ = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
        sel = (((fc_[:, 0] - cx) / (rx * 1.08)) ** 2 + ((fc_[:, 1] - ey) / (ry * 1.08)) ** 2 < 1) & (fc_[:, 2] > 0.05) & (fn_[:, 2] > 0)
        fs = F[sel]
        used, inv = np.unique(fs, return_inverse=True)
        pv = V[used] + N[used] * 0.0025
        u = (pv[:, 0] - cx) / (2 * rx) * sgn + 0.5   # 镜像，让 u = 1 始终是外眼角
        v = (pv[:, 1] - ey) / (2 * ry) + 0.5
        parts_v.append(pv)
        parts_n.append(N[used])
        parts_uv.append(np.stack([u, v], 1))
        parts_f.append(inv.reshape(-1, 3) + off)
        off += len(pv)
    m = trimesh.Trimesh(np.concatenate(parts_v), np.concatenate(parts_f), vertex_normals=np.concatenate(parts_n), process=False)
    mat = trimesh.visual.material.PBRMaterial(baseColorTexture=lid_texture(closed), metallicFactor=0.0, roughnessFactor=0.7, alphaMode='MASK', alphaCutoff=0.5)
    m.visual = trimesh.visual.TextureVisuals(uv=np.concatenate(parts_uv), material=mat)
    return m


# ───────── 8. 导出 ─────────
out = Path(args.out)
out.mkdir(parents=True, exist_ok=True)
body = trimesh.Trimesh(V2, F2, vertex_normals=N2, process=False)
mat = trimesh.visual.material.PBRMaterial(baseColorTexture=Image.fromarray(tex_u8), metallicRoughnessTexture=Image.fromarray(rough_img),
                                          metallicFactor=1.0, roughnessFactor=1.0, doubleSided=True)
body.visual = trimesh.visual.TextureVisuals(uv=UV, material=mat)
body.vertex_attributes['_joints'] = top[vmap].astype(np.uint8)
body.vertex_attributes['_weights'] = Wtop[vmap].astype(np.float32)
scene = trimesh.Scene()
scene.add_geometry(body, geom_name='body', node_name='body')
scene.add_geometry(lid_mesh(False), geom_name='lid_half', node_name='lid_half')
scene.add_geometry(lid_mesh(True), geom_name='lid_closed', node_name='lid_closed')
glb = out / f'{args.name}.glb'
glb.write_bytes(scene.export(file_type='glb'))

# 骨架信息：前端按这个摆关节（见 src/character/gltfModel.ts）
d_roll = np.arctan2(K['hand'][0] - K['shoulder'][0], K['shoulder'][1] - K['hand'][1]) - K['arm_bind_roll']
rig = dict(
    joints=JOINTS,
    neckY=K['neck_y'],
    hipX=K['hip_x'],
    shoulder=list(K['shoulder']),
    upperArm=K['upper_arm'],
    armRestAngle=K['arm_bind_roll'],
    # 戴耳机用：左耳中心与头顶（含头发）高度
    ear=K.get('ear', [K['ear_box'][0] + 0.03, (K['ear_box'][1] + K['ear_box'][2]) / 2, (K['ear_box'][3] + K['ear_box'][4]) / 2]),
    headTop=REF_H + 0.012,
    # 肘关节在上臂骨骼局部坐标里的位置（左臂；右臂 x 取反）：建模姿势的手臂比绑定姿势更外张 d_roll
    elbow=[round(float(np.sin(d_roll) * K['upper_arm']), 4), round(float(-np.cos(d_roll) * K['upper_arm']), 4), 0],
    source=dict(tool='Hunyuan3D-2mv (tencent/Hunyuan3D-2mv, hunyuan3d-dit-v2-mv-turbo)', reference=f'assets/{args.name}_q_turnaround.jpg',
                vertices=int(len(V2)), faces=int(len(F2)), texture=int(T)),
)
(out / f'{args.name}.rig.json').write_text(json.dumps(rig, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
print('exported', glb, f'{glb.stat().st_size / 1e6:.2f} MB')
