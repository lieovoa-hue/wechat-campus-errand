# -*- coding: utf-8 -*-
r"""
=====================================================================
tabBar 图标生成脚本（可重复执行，修改配色/尺寸后重跑即可）

产出（81x81 PNG，微信 tabBar 推荐尺寸，单文件远小于 40KB）：
    miniprogram/images/tab/home.png        / home-active.png      首页
    miniprogram/images/tab/publish.png     / publish-active.png   我的发布
    miniprogram/images/tab/task.png        / task-active.png      我的任务
    miniprogram/images/tab/profile.png     / profile-active.png   我的
    另外同名多输出一套暗色版（theme.json 的 dark 专用，共 8 张）：
        home-dark.png / home-active-dark.png / publish-dark.png / publish-active-dark.png
        task-dark.png / task-active-dark.png / profile-dark.png / profile-active-dark.png

配色与 app.json 中 tabBar 的 color / selectedColor 保持一致：
    常态 #6B7688（--text-3 冷灰）  选中 #2B5CE6（--brand 信任蓝）
    v6 配色：主色换成信任蓝 #2B5CE6、常态灰换成冷调 #6B7688，
    与 app.json 的 tabBar.color / selectedColor 必须完全相同。

原理：先用 8 倍画布（648x648）按归一化坐标绘制，再用 LANCZOS 缩放到 81x81，
      以获得平滑的抗锯齿边缘；图标采用描边风格，线宽约为画布的 7.5%。

运行：python tools\make_tab_icons.py
=====================================================================
"""

import os

from PIL import Image, ImageDraw

# ------------------------------ 基础参数 ------------------------------
SIZE = 81            # 最终输出尺寸（微信官方推荐 81x81）
SCALE = 8            # 超采样倍数
CANVAS = SIZE * SCALE

COLOR_NORMAL = (0x6B, 0x76, 0x88, 255)   # 常态色，与 app.json tabBar.color 一致
COLOR_ACTIVE = (0x2B, 0x5C, 0xE6, 255)   # 选中色，与 app.json tabBar.selectedColor 一致

# 暗色主题（app.json 的 darkmode + theme.json）：同一套图形换成深底专用配色。
# 为什么不能直接用上面两个颜色：#6B7688 在 #12151B 上只有 4.4:1，看着发灰发脏；
# #2B5CE6 在深底上对比度只有 2.6:1，与 app.wxss 里 .theme-dark 的 --brand 一致提亮到 #6D8FFF。
COLOR_NORMAL_DARK = (0x8A, 0x93, 0xA3, 255)   # 常态色，与 theme.json dark.tabBar.color 一致
COLOR_ACTIVE_DARK = (0x6D, 0x8F, 0xFF, 255)   # 选中色，与 theme.json dark.tabBar.selectedColor 一致

STROKE = 0.075       # 线宽（相对画布的比例）

OUTPUT_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', 'miniprogram', 'images', 'tab'
)


def px(ratio):
    """归一化坐标 -> 画布像素坐标"""
    return ratio * CANVAS


def stroke_width():
    return max(1, int(STROKE * CANVAS))


def new_canvas():
    """新建透明画布"""
    image = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
    return image, ImageDraw.Draw(image)


def point(x, y):
    return (px(x), px(y))


# ------------------------------ 图标绘制 ------------------------------

def draw_home(draw, color):
    """首页：屋顶 + 墙体 + 门"""
    width = stroke_width()
    # 屋顶（折线，joint='curve' 让折角圆滑）
    draw.line([point(0.05, 0.48), point(0.50, 0.07), point(0.95, 0.48)],
              fill=color, width=width, joint='curve')
    # 墙体（只画左、下、右三条边，顶部不封口，避免与屋顶重叠显脏）
    draw.line([point(0.19, 0.44), point(0.19, 0.93), point(0.81, 0.93), point(0.81, 0.44)],
              fill=color, width=width, joint='curve')
    # 门
    draw.line([point(0.42, 0.93), point(0.42, 0.70), point(0.58, 0.70), point(0.58, 0.93)],
              fill=color, width=width, joint='curve')


def draw_publish(draw, color):
    """我的发布：纸飞机（发布 / 发出）"""
    width = stroke_width()
    nose = point(0.94, 0.09)          # 机头（右上）
    tail_top = point(0.05, 0.44)      # 左上翼尖
    tail_bottom = point(0.63, 0.93)   # 机尾（右下）
    fold = point(0.34, 0.67)          # 折痕点（位于 tail_top - tail_bottom 连线中点）

    # 机身三角形
    draw.polygon([tail_top, nose, tail_bottom], outline=color, width=width)
    # 折痕：机头 -> 折痕点
    draw.line([nose, fold], fill=color, width=width)


def draw_task(draw, color):
    """我的任务：任务清单（写字板 + 三条清单线）"""
    width = stroke_width()
    # 写字板
    draw.rounded_rectangle([point(0.20, 0.15), point(0.80, 0.94)],
                           radius=px(0.09), outline=color, width=width)
    # 顶部夹子
    draw.rounded_rectangle([point(0.37, 0.04), point(0.63, 0.22)],
                           radius=px(0.05), outline=color, width=width)
    # 清单线
    for y in (0.42, 0.58, 0.74):
        draw.line([point(0.33, y), point(0.67, y)], fill=color, width=width)


def draw_profile(draw, color):
    """我的：头 + 肩"""
    width = stroke_width()
    # 头部
    draw.ellipse([point(0.33, 0.10), point(0.67, 0.44)], outline=color, width=width)
    # 肩部（上半圆弧，180度 -> 360度 经过 270度即正上方）
    draw.arc([point(0.13, 0.50), point(0.87, 1.12)], start=180, end=360,
             fill=color, width=width)


ICONS = {
    'home': draw_home,
    'publish': draw_publish,
    'task': draw_task,
    'profile': draw_profile,
}


def main():
    target = os.path.normpath(OUTPUT_DIR)
    os.makedirs(target, exist_ok=True)

    # 四份产出：浅色常态 / 浅色选中 / 深色常态 / 深色选中（后两份给 theme.json 的 dark 用）
    variants = (
        ('', COLOR_NORMAL),
        ('-active', COLOR_ACTIVE),
        ('-dark', COLOR_NORMAL_DARK),
        ('-active-dark', COLOR_ACTIVE_DARK),
    )
    for name, drawer in ICONS.items():
        for suffix, color in variants:
            image, draw = new_canvas()
            drawer(draw, color)
            image = image.resize((SIZE, SIZE), Image.LANCZOS)
            file_path = os.path.join(target, '%s%s.png' % (name, suffix))
            image.save(file_path, 'PNG', optimize=True)
            print('已生成 %s (%d 字节)' % (file_path, os.path.getsize(file_path)))

    print('\n图标输出目录：%s' % target)


if __name__ == '__main__':
    main()
