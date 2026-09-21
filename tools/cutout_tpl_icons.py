
# -*- coding: utf-8 -*-
"""
发布任务快捷模板图标：把 AI 生成图处理成可直接上屏的干净图标
  1) 去掉「豆包AI生成」水印与底部文字标签 —— 靠裁剪范围排除；
  2) 去掉白色底 —— 从画面四边泛洪，只清除与外界连通的近白像素，
     图案内部的白色（纸张 / 米饭 / 包装袋）会被保留；
  3) 打印机出纸口与外界连通，用多边形把纸张内部补回不透明；
  4) 图案下方的柔和投影会因泛洪变成碎灰色斑块，用「底部带内放宽阈值」
     把整块投影一并清除；
  5) 输出 320x320 透明 PNG，四周留 12% 边距，保证四个图标视觉大小一致。
"""
import os
import numpy as np
from PIL import Image, ImageFilter

SRC = {
    "express": (r"C:\Users\liqiud\AppData\Local\Temp\codex-clipboard-e965bb1f-b329-4de8-8074-2e6f55748a60.png",
                (535, 510, 1617, 1480), None, 0.15),
    "meal":    (r"C:\Users\liqiud\AppData\Local\Temp\codex-clipboard-a0af4ed8-897a-4825-8fc4-da97f4323221.png",
                (500, 508, 1580, 1420), None, 0.0),
    "print":   (r"C:\Users\liqiud\AppData\Local\Temp\codex-clipboard-84c4d2b4-1435-454a-b525-c2952c4d3992.png",
                (440, 300, 1620, 1620), [(215, 725), (478, 795), (335, 1195), (70, 1050)], 0.0),
    "market":  (r"C:\Users\liqiud\AppData\Local\Temp\codex-clipboard-44f9db46-bc4f-4ee5-887e-93a54fc011e5.png",
                (403, 420, 1563, 1545), None, 0.15),
}
TOL = 30            # 常规背景阈值（与纯白的曼哈顿距离）
SHADOW_TOL = 165    # 底部投影带内的放宽阈值：投影是柔和浅色，整块清掉
OUT_DIR = r"D:\miniprogram123\miniprogram\images\tpl"
SIZE = 320


def polygon_mask(w, h, pts):
    """多边形转布尔掩码（射线法，纯 numpy）"""
    ys, xs = np.mgrid[0:h, 0:w]
    inside = np.zeros((h, w), dtype=bool)
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        cond = (y1 > ys) != (y2 > ys)
        xin = (x2 - x1) * (ys - y1) / np.where(y2 - y1 == 0, 1, y2 - y1) + x1
        inside ^= cond & (xs < xin)
    return inside


def flood(near, seed=None):
    """连通域泛洪：无 seed 时从画面四边出发，有 seed 时从 seed 出发"""
    r = np.zeros_like(near)
    if seed is None:
        r[0, :] = near[0, :]; r[-1, :] = near[-1, :]
        r[:, 0] = near[:, 0]; r[:, -1] = near[:, -1]
    else:
        r = seed & near
    while True:
        nb = r.copy()
        nb[1:, :] |= r[:-1, :]; nb[:-1, :] |= r[1:, :]
        nb[:, 1:] |= r[:, :-1]; nb[:, :-1] |= r[:, 1:]
        nb &= near
        if np.array_equal(nb, r):
            return r
        r = nb


def run(key, path, box, protect_pts, shadow_band):
    im = Image.open(path).convert("RGB").crop(box)
    w, h = im.size
    rgb = np.asarray(im).astype(np.float32)
    d = np.abs(np.asarray(im).astype(np.int16) - 255).sum(axis=2)

    fg = d > TOL
    if protect_pts:
        fg = fg | polygon_mask(w, h, protect_pts)
    reach = flood(~fg)

    # 底部投影带：从已判定的背景出发，用放宽阈值把柔和投影整块吃进来
    if shadow_band > 0:
        band = np.zeros((h, w), dtype=bool)
        band[int(h * (1 - shadow_band)):, :] = True
        near2 = (d <= SHADOW_TOL) & band
        reach = reach | flood(near2, seed=reach & band)

    alpha = np.where(reach, 0, 255).astype(np.uint8)
    alpha_img = Image.fromarray(alpha, "L").filter(ImageFilter.GaussianBlur(1.2))
    al = np.asarray(alpha_img).astype(np.float32) / 255.0

    # 边缘反预乘：减掉混入的白色，避免浅色描边出现白晕
    edge = (al > 0.03) & (al < 0.97)
    if edge.any():
        av = al[edge][:, None]
        rgb[edge] = np.clip((rgb[edge] - (1 - av) * 255.0) / av, 0, 255)
    al = np.where(al < 0.03, 0.0, np.where(al > 0.97, 1.0, al))

    img = Image.fromarray(np.dstack([rgb.astype(np.uint8), (al * 255).astype(np.uint8)]), "RGBA")
    img = img.crop(img.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox())

    side = int(max(img.size) * 1.12)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(img, ((side - img.width) // 2, (side - img.height) // 2), img)
    canvas = canvas.resize((SIZE, SIZE), Image.LANCZOS)

    os.makedirs(OUT_DIR, exist_ok=True)
    dst = os.path.join(OUT_DIR, key + ".png")
    canvas.save(dst, "PNG", optimize=True)
    cover = (np.asarray(canvas)[:, :, 3] == 0).mean() * 100
    print(f"{key:8s} 图形={img.size} -> {SIZE}x{SIZE} 透明占比={cover:4.1f}% {os.path.getsize(dst)//1024}KB")


for k, (p, b, poly, band) in SRC.items():
    run(k, p, b, poly, band)
