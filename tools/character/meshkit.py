"""小工具：正交投影的软件光栅化（画家算法）、预览渲染、图像采样。只依赖 numpy + opencv。"""
import cv2
import numpy as np

# 视图定义：d = 从物体指向相机的单位向量，r = 画面向右，u = 画面向上（世界坐标，+Y 上、+Z 为角色正面、+X 为她的左手边）
VIEWS = {
    'front': dict(d=(0, 0, 1), r=(1, 0, 0)),
    'back': dict(d=(0, 0, -1), r=(-1, 0, 0)),
    'right': dict(d=(-1, 0, 0), r=(0, 0, 1)),  # 她自己的右侧，脸朝画面右
    'left': dict(d=(1, 0, 0), r=(0, 0, -1)),
}
UP = np.array([0.0, 1.0, 0.0])


def view_axes(yaw_deg=None, name=None, pitch_deg=0.0):
    """返回 (r, u, d)。yaw 0 = 正面，90 = 从她的左侧看。"""
    if name is not None:
        d = np.array(VIEWS[name]['d'], float)
        r = np.array(VIEWS[name]['r'], float)
        return r, UP.copy(), d
    a, p = np.radians(yaw_deg), np.radians(pitch_deg)
    d = np.array([np.sin(a) * np.cos(p), np.sin(p), np.cos(a) * np.cos(p)])
    r = np.cross(UP, d)
    r /= np.linalg.norm(r)
    u = np.cross(d, r)
    return r, u, d


def project(V, axes):
    r, u, d = axes
    return np.stack([V @ r, V @ u], 1), V @ d


def raster(V, F, axes, size, bounds, face_values=None):
    """画家算法光栅化。bounds = (xmin, xmax, ymin, ymax) 为画面覆盖的投影范围。
    返回 (face_id 图 int32，-1 为空, depth 图 float32，每面取重心深度)。"""
    xy, depth = project(V, axes)
    xmin, xmax, ymin, ymax = bounds
    px = np.empty_like(xy)
    px[:, 0] = (xy[:, 0] - xmin) / (xmax - xmin) * size[0]
    px[:, 1] = (ymax - xy[:, 1]) / (ymax - ymin) * size[1]
    fd = depth[F].mean(1)
    order = np.argsort(fd)  # 远的先画
    ids = np.full((size[1], size[0]), -1, np.int32)
    tri = np.round(px[F] * 16).astype(np.int32)
    for f in order:
        cv2.fillConvexPoly(ids, tri[f], int(f), lineType=cv2.LINE_8, shift=4)
    dimg = np.full(ids.shape, -1e9, np.float32)
    m = ids >= 0
    dimg[m] = fd[ids[m]]
    return ids, dimg, px


def preview(V, F, colors=None, yaws=(0, 45, 90, 180, 270, 315), size=384, pitch=8, bg=(255, 255, 255)):
    """多角度预览图（带简单光照）。colors: 每面 RGB(0..255) 或 None。"""
    lo, hi = V.min(0), V.max(0)
    c = (lo + hi) / 2
    R = np.linalg.norm(hi - lo) / 2 * 1.02
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    fn /= np.linalg.norm(fn, axis=1, keepdims=True) + 1e-12
    tiles = []
    for yaw in yaws:
        axes = view_axes(yaw, pitch_deg=pitch)
        r, u, d = axes
        ids, _, _ = raster(V - c, F, axes, (size, size), (-R, R, -R, R))
        img = np.empty((size, size, 3), np.uint8)
        img[:] = bg
        m = ids >= 0
        light = d * 0.75 + u * 0.5 + r * 0.3
        light /= np.linalg.norm(light)
        sh = 0.45 + 0.55 * np.clip(fn @ light, 0, 1)
        base = np.full((len(F), 3), 200.0) if colors is None else colors.astype(float)
        col = np.clip(base * sh[:, None], 0, 255).astype(np.uint8)
        img[m] = col[ids[m]]
        tiles.append(img)
    return np.concatenate(tiles, 1)


def sample(img, xy):
    """双线性采样。img: HxWxC float32，xy: (N,2) 像素坐标。"""
    out = []
    for i in range(0, len(xy), 30000):  # cv2.remap 单次最多 32767 行
        mx = xy[i:i + 30000, 0].astype(np.float32).reshape(-1, 1)
        my = xy[i:i + 30000, 1].astype(np.float32).reshape(-1, 1)
        out.append(cv2.remap(img, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0).reshape(len(mx), -1))
    return np.concatenate(out, 0) if out else np.zeros((0, 1), np.float32)
