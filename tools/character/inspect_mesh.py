"""把一个网格渲染成多角度预览图（不需要显卡），用来检查建模结果。
用法：python inspect_mesh.py <mesh.glb> <out.png> [yaw,yaw,...]"""
import sys

import cv2
import numpy as np
import trimesh

from meshkit import preview

m = trimesh.load(sys.argv[1], force='mesh', process=False)
V, F = np.asarray(m.vertices, float), np.asarray(m.faces)
print('verts', len(V), 'faces', len(F), 'bounds', V.min(0).round(3), V.max(0).round(3))
comps = trimesh.graph.connected_components(m.face_adjacency, nodes=np.arange(len(F)))
print('components', len(comps), sorted((len(c) for c in comps), reverse=True)[:6])
yaws = [float(x) for x in sys.argv[3].split(',')] if len(sys.argv) > 3 else (0, 45, 90, 180, 270, 315)
colors = None
try:
    vc = m.visual.to_color().vertex_colors[:, :3]
    colors = vc[F].mean(1)
except Exception:
    pass
img = preview(V, F, colors, yaws=yaws, size=420)
cv2.imwrite(sys.argv[2], cv2.cvtColor(img, cv2.COLOR_RGB2BGR))
