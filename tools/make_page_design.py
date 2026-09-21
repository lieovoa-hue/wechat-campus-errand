# -*- coding: utf-8 -*-
"""校园跑腿小程序 · 全站页面设计稿生成脚本

产物:
  docs/page-design-v1.png          全站 20 页总览板
  docs/page-design-row1.png ~ row5 分行大图(便于逐行查看)

运行: python tools/make_page_design.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "docs")
os.makedirs(DOCS, exist_ok=True)

C = dict(
    brand="#2B5CE6", brand_d="#1E49C4", brand_l="#5B84F0",
    brand_50="#EEF3FF", brand_100="#DCE6FF",
    accent="#EE6C2D", accent_tx="#C2410C", accent_50="#FFF1E7",
    succ="#0E9F6E", succ_tx="#0A7A54", succ_50="#E8F7F1",
    warn="#D97706", warn_tx="#B45309", warn_50="#FEF3E2",
    dang="#E02424", dang_tx="#C81E1E", dang_50="#FEECEC",
    bg="#F5F7FA", s2="#F1F4F9", line="#E6EAF2", line_s="#D5DBE6",
    t1="#0F172A", t2="#475569", t3="#6B7688", t4="#9AA5B4",
    d1="#0F172A", d2="#25324B", w="#FFFFFF",
)


def _hx(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def mix(a, b, k):
    ca, cb = _hx(a), _hx(b)
    return tuple(int(ca[i] + (cb[i] - ca[i]) * k) for i in range(3))


_FC = {}


def F(sz, bold=False):
    key = (sz, bold)
    if key not in _FC:
        fpath = r"C:\Windows\Fonts\msyhbd.ttc" if bold else r"C:\Windows\Fonts\msyh.ttc"
        _FC[key] = ImageFont.truetype(fpath, sz)
    return _FC[key]


PGW, PGH = 380, 800
COLS, ROWS = 4, 5
GAPX, GAPY = 48, 72
PAD = 48
HEAD_H = 214
LBL_H = 34

IMG_W = PAD * 2 + COLS * PGW + (COLS - 1) * GAPX
IMG_H = HEAD_H + ROWS * (PGH + LBL_H) + (ROWS - 1) * GAPY + 70

img = Image.new("RGB", (IMG_W, IMG_H), "#FFFFFF")
d = ImageDraw.Draw(img)


def _i(v):
    return int(round(v))


def t(x, y, s, sz=12, bold=False, color=None, anchor="la"):
    d.text((_i(x), _i(y)), s, font=F(_i(sz), bold), fill=color or C["t1"], anchor=anchor)


def rr(x, y, w, h, r=12, fill=None, outline=None, ow=1):
    x, y, w, h = _i(x), _i(y), _i(w), _i(h)
    d.rounded_rectangle([x, y, x + w, y + h], radius=_i(r), fill=fill, outline=outline, width=ow)


def bar(x, y, w, h=9, fill=None, r=None):
    x, y, w, h = _i(x), _i(y), _i(w), _i(h)
    d.rounded_rectangle([x, y, x + w, y + h], radius=_i(r) if r is not None else max(1, h // 2),
                        fill=fill or C["line"])


def hline(x, y, w, fill=None):
    d.line([(_i(x), _i(y)), (_i(x + w), _i(y))], fill=fill or C["line"], width=1)


def ggrad(x, y, w, h, r, c1, c2):
    x, y, w, h, r = _i(x), _i(y), _i(w), _i(h), _i(r)
    tmp = Image.new("RGB", (w, h), c1)
    td = ImageDraw.Draw(tmp)
    for i in range(h):
        td.line([(0, i), (w, i)], fill=mix(c1, c2, i / max(1.0, h - 1.0)))
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, w - 1, h - 1], radius=r, fill=255)
    img.paste(tmp, (x, y), m)


def dot(cx, cy, r, fill):
    cx, cy, r = _i(cx), _i(cy), _i(r)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill)


def ico(x, y, kind, col, s=18):
    x, y, s = _i(x), _i(y), max(4, _i(s))
    cx, cy = x + s / 2.0, y + s / 2.0
    h = s / 2.0
    if kind == "search":
        d.ellipse([cx - h * 0.75, cy - h * 0.85, cx + h * 0.25, cy + h * 0.15], outline=col, width=1)
        d.line([(cx + h * 0.15, cy + h * 0.05), (cx + h * 0.8, cy + h * 0.7)], fill=col, width=1)
    elif kind == "filter":
        d.line([(cx - h, cy - h * 0.6), (cx + h, cy - h * 0.6)], fill=col, width=1)
        d.line([(cx - h * 0.6, cy), (cx + h * 0.6, cy)], fill=col, width=1)
        d.line([(cx - h * 0.25, cy + h * 0.6), (cx + h * 0.25, cy + h * 0.6)], fill=col, width=1)
    elif kind == "close":
        d.line([(cx - h * 0.6, cy - h * 0.6), (cx + h * 0.6, cy + h * 0.6)], fill=col, width=1)
        d.line([(cx + h * 0.6, cy - h * 0.6), (cx - h * 0.6, cy + h * 0.6)], fill=col, width=1)
    elif kind == "eye":
        d.arc([cx - h, cy - h * 0.8, cx + h, cy + h * 0.8], start=0, end=180, fill=col, width=1)
        d.arc([cx - h, cy - h * 0.8, cx + h, cy + h * 0.8], start=180, end=360, fill=col, width=1)
        dot(cx, cy, 1.6, col)
    elif kind == "clock":
        d.ellipse([cx - h * 0.85, cy - h * 0.85, cx + h * 0.85, cy + h * 0.85], outline=col, width=1)
        d.line([(cx, cy - h * 0.45), (cx, cy)], fill=col, width=1)
        d.line([(cx, cy), (cx + h * 0.42, cy + h * 0.2)], fill=col, width=1)
    elif kind == "copy":
        d.rounded_rectangle([cx - h * 0.8, cy - h * 0.8, cx + h * 0.3, cy + h * 0.3], radius=2,
                            outline=col, width=1)
        d.rounded_rectangle([cx - h * 0.2, cy - h * 0.2, cx + h * 0.8, cy + h * 0.8], radius=2,
                            outline=col, width=1)
    elif kind == "plus":
        d.line([(cx - h * 0.7, cy), (cx + h * 0.7, cy)], fill=col, width=1)
        d.line([(cx, cy - h * 0.7), (cx, cy + h * 0.7)], fill=col, width=1)
    elif kind == "chev":
        d.line([(cx - h * 0.25, cy - h * 0.5), (cx + h * 0.3, cy)], fill=col, width=1)
        d.line([(cx + h * 0.3, cy), (cx - h * 0.25, cy + h * 0.5)], fill=col, width=1)
    elif kind == "home":
        d.line([(cx - h * 0.85, cy - h * 0.1), (cx, cy - h * 0.9)], fill=col, width=1)
        d.line([(cx, cy - h * 0.9), (cx + h * 0.85, cy - h * 0.1)], fill=col, width=1)
        d.line([(cx - h * 0.6, cy - h * 0.25), (cx - h * 0.6, cy + h * 0.8)], fill=col, width=1)
        d.line([(cx + h * 0.6, cy - h * 0.25), (cx + h * 0.6, cy + h * 0.8)], fill=col, width=1)
        d.line([(cx - h * 0.6, cy + h * 0.8), (cx + h * 0.6, cy + h * 0.8)], fill=col, width=1)
    elif kind == "list":
        for i in range(3):
            yy = cy - h * 0.6 + i * h * 0.6
            dot(cx - h * 0.6, yy, 1.4, col)
            d.line([(cx - h * 0.25, yy), (cx + h * 0.85, yy)], fill=col, width=1)
    elif kind == "bag":
        d.rounded_rectangle([cx - h * 0.8, cy - h * 0.25, cx + h * 0.8, cy + h * 0.9], radius=2,
                            outline=col, width=1)
        d.arc([cx - h * 0.4, cy - h * 0.85, cx + h * 0.4, cy + h * 0.15], start=180, end=360,
              fill=col, width=1)
    elif kind == "user":
        d.ellipse([cx - h * 0.42, cy - h * 0.9, cx + h * 0.42, cy - h * 0.06], outline=col, width=1)
        d.arc([cx - h * 0.85, cy + h * 0.05, cx + h * 0.85, cy + h * 1.3], start=180, end=360,
              fill=col, width=1)
    elif kind == "box":
        d.polygon([(cx - h * 0.85, cy - h * 0.35), (cx, cy - h * 0.9),
                   (cx + h * 0.85, cy - h * 0.35)], outline=col, width=1)
        d.line([(cx - h * 0.85, cy - h * 0.35), (cx - h * 0.85, cy + h * 0.75)], fill=col, width=1)
        d.line([(cx + h * 0.85, cy - h * 0.35), (cx + h * 0.85, cy + h * 0.75)], fill=col, width=1)
        d.line([(cx - h * 0.85, cy + h * 0.75), (cx + h * 0.85, cy + h * 0.75)], fill=col, width=1)
    elif kind == "bowl":
        d.arc([cx - h * 0.9, cy - h * 0.5, cx + h * 0.9, cy + h * 0.9], start=0, end=180,
              fill=col, width=1)
        d.line([(cx - h * 0.9, cy + h * 0.18), (cx + h * 0.9, cy + h * 0.18)], fill=col, width=1)
    elif kind == "doc":
        d.rounded_rectangle([cx - h * 0.65, cy - h * 0.9, cx + h * 0.65, cy + h * 0.9], radius=2,
                            outline=col, width=1)
        for i in range(3):
            d.line([(cx - h * 0.35, cy - h * 0.4 + i * h * 0.42),
                    (cx + h * 0.35, cy - h * 0.4 + i * h * 0.42)], fill=col, width=1)
    elif kind == "shield":
        d.polygon([(cx, cy - h * 0.9), (cx + h * 0.75, cy - h * 0.5), (cx, cy + h * 0.9),
                   (cx - h * 0.75, cy - h * 0.5)], outline=col, width=1)
    elif kind == "bell":
        d.arc([cx - h * 0.7, cy - h * 0.85, cx + h * 0.7, cy + h * 0.45], start=180, end=360,
              fill=col, width=1)
        d.line([(cx - h * 0.7, cy - h * 0.2), (cx - h * 0.7, cy + h * 0.5)], fill=col, width=1)
        d.line([(cx + h * 0.7, cy - h * 0.2), (cx + h * 0.7, cy + h * 0.5)], fill=col, width=1)
        d.line([(cx - h * 0.7, cy + h * 0.5), (cx + h * 0.7, cy + h * 0.5)], fill=col, width=1)
        dot(cx, cy + h * 0.85, 1.6, col)
    elif kind == "star":
        d.polygon([(cx, cy - h * 0.85), (cx + h * 0.3, cy - h * 0.2), (cx + h * 0.85, cy - h * 0.1),
                   (cx + h * 0.42, cy + h * 0.3), (cx + h * 0.55, cy + h * 0.9),
                   (cx, cy + h * 0.55), (cx - h * 0.55, cy + h * 0.9), (cx - h * 0.42, cy + h * 0.3),
                   (cx - h * 0.85, cy - h * 0.1), (cx - h * 0.3, cy - h * 0.2)],
                  outline=col, width=1)


def page(x, y, dark_nav=False):
    global FRAME_Y
    FRAME_Y = y
    rr(x + 3, y + 7, PGW, PGH, 28, fill="#EDF0F5")
    rr(x, y, PGW, PGH, 28, fill=C["w"], outline=C["line_s"], ow=1)
    nav_col = C["w"] if dark_nav else C["t1"]
    t(x + 22, y + 7, "9:41", 10, True, nav_col)
    for i in range(4):
        hh = 3 + i
        d.rectangle([x + PGW - 74 + i * 5, y + 16 - hh, x + PGW - 71 + i * 5, y + 16], fill=nav_col)
    rr(x + PGW - 52, y + 8, 16, 9, 3, outline=nav_col, ow=1)
    d.rectangle([x + PGW - 49, y + 11, x + PGW - 41, y + 15], fill=nav_col)
    d.rectangle([x + PGW - 34, y + 11, x + PGW - 32, y + 14], fill=nav_col)
    return y + 26


def nav(x, y, title, back=True, right=None, dark=False):
    cy = y + 22
    col = C["w"] if dark else C["t1"]
    if back:
        d.line([(x + 27, cy + 6), (x + 19, cy)], fill=col, width=2)
        d.line([(x + 19, cy), (x + 27, cy - 6)], fill=col, width=2)
    t(x + PGW / 2, cy - 8, title, 15, True, col, anchor="ma")
    if right:
        t(x + PGW - 18, cy - 6, right, 11, False, C["w"] if dark else C["brand"], anchor="ra")
    return y + 46


def tabbar(x, active=0, badge=None):
    y = FRAME_Y
    ty = y + PGH - 78
    d.rectangle([x, ty, x + PGW, ty + 66], fill=C["w"])
    hline(x + 1, ty + 1, PGW - 2)
    names = ["首页", "我的发布", "我的任务", "我的"]
    kinds = ["home", "list", "bag", "user"]
    cw = PGW / 4.0
    for i, (nm, kd) in enumerate(zip(names, kinds)):
        cx = x + cw * i + cw / 2
        col = C["brand"] if i == active else C["t4"]
        ico(cx - 9, ty + 14, kd, col, 18)
        t(cx, ty + 40, nm, 10, i == active, col, anchor="ma")
        if i == 2 and badge:
            dot(cx + 11, ty + 14, 6, C["dang"])
            t(cx + 11, ty + 9, str(badge), 8, True, C["w"], anchor="ma")
    rr(x + PGW / 2 - 42, y + PGH - 8, 84, 4, 2, fill=C["t4"])
    return ty


def field(x, y, w, label, value=None, hint=None, h=42):
    t(x, y, label, 10.5, False, C["t3"])
    by = y + 15
    rr(x, by, w, h, 10, fill=C["s2"])
    if value:
        t(x + 12, by + (h - 14) / 2, value, 12, False, C["t1"])
    else:
        bar(x + 12, by + h / 2 - 4, min(120, w * 0.42), 8, "#DCE1EA")
    if hint:
        t(x + w - 10, by + (h - 12) / 2, hint, 9.5, False, C["t3"], anchor="ra")
    return by + h + 12


def btn(x, y, w, h, text, kind="primary", sz=13):
    if kind == "primary":
        ggrad(x, y, w, h, h // 2 if h <= 40 else 12, C["brand_l"], C["brand_d"])
        t(x + w / 2, y + (h - sz * 1.35) / 2, text, sz, True, C["w"], anchor="ma")
    elif kind == "ghost":
        rr(x, y, w, h, 10, fill=C["w"], outline=C["line_s"])
        t(x + w / 2, y + (h - sz * 1.35) / 2, text, sz, True, C["t2"], anchor="ma")
    elif kind == "soft":
        rr(x, y, w, h, 10, fill=C["brand_50"])
        t(x + w / 2, y + (h - sz * 1.35) / 2, text, sz, True, C["brand"], anchor="ma")
    elif kind == "danger":
        rr(x, y, w, h, 10, fill=C["dang_50"])
        t(x + w / 2, y + (h - sz * 1.35) / 2, text, sz, True, C["dang_tx"], anchor="ma")
    elif kind == "warn":
        rr(x, y, w, h, 10, fill=C["warn_50"])
        t(x + w / 2, y + (h - sz * 1.35) / 2, text, sz, True, C["warn_tx"], anchor="ma")


def pill(x, y, text, fg, bg, sz=10, pad=9, h=20):
    w = d.textlength(text, font=F(sz, True)) + pad * 2
    rr(x, y, w, h, h / 2.0, fill=bg)
    t(x + pad, y + (h - sz * 1.3) / 2.0, text, sz, True, fg)
    return w


def pill_r(x, y, text, fg, bg, sz=10, pad=9, h=20):
    w = d.textlength(text, font=F(sz, True)) + pad * 2
    pill(x - w, y, text, fg, bg, sz, pad, h)
    return w


def tag(x, y, text, fg, bg, sz=9.5):
    w = d.textlength(text, font=F(sz)) + 12
    rr(x, y, w, 16, 4, fill=bg)
    t(x + 6, y + 2, text, sz, False, fg)
    return w


def ava(cx, cy, s, fill=None):
    d.ellipse([_i(cx - s / 2.0), _i(cy - s / 2.0), _i(cx + s / 2.0), _i(cy + s / 2.0)],
              fill=fill or C["brand_100"])
    ico(cx - s * 0.22, cy - s * 0.22, "user", "#FFFFFF", s * 0.44)


def person_card(x, y, w, role, name, uid, sid, badge):
    rr(x, y, w, 54, 12, fill=C["s2"])
    ava(x + 28, y + 27, 30, C["brand"])
    t(x + 52, y + 8, role, 9, False, C["t3"])
    t(x + 52, y + 21, name, 12, True, C["t1"])
    t(x + 52, y + 38, "ID " + uid, 9, False, C["t3"])
    t(x + 126, y + 38, "学号 " + sid, 9, False, C["t3"])
    if badge == "ok":
        pill_r(x + w - 10, y + 19, "已认证", C["succ_tx"], C["succ_50"], 9, 7, 16)
    elif badge == "admin":
        pill_r(x + w - 10, y + 19, "管理员", C["dang_tx"], C["dang_50"], 9, 7, 16)
    return y + 54 + 10


def task_card(x, y, w, addr, tpl, money, status_text, sfg, sbg, meta="09-19 15:43", accent=None):
    h = 108
    rr(x, y, w, h, 14, fill=C["w"], outline=C["line"])
    rr(x + 13, y + 16, 5, h - 32, 3, fill=accent or C["brand"])
    t(x + 28, y + 12, addr, 13, True, C["t1"])
    dw = d.textlength(addr, font=F(13, True))
    tag(x + 34 + dw, y + 12, tpl, C["t3"], C["s2"])
    t(x + w - 16, y + 10, "楼", 10, True, C["accent_tx"], anchor="ra")
    t(x + w - 16, y + 22, "%.2f" % money, 19, True, C["accent_tx"], anchor="ra")
    my = y + 42
    rr(x + 28, my, w - 44, 24, 6, fill=C["s2"])
    t(x + 38, my + 6, "送达地址", 9, False, C["t3"])
    t(x + w - 38, my + 6, "限时 60 分钟", 9, False, C["t2"], anchor="ra")
    py = y + 74
    hline(x + 28, py, w - 44)
    ava(x + 41, py + 17, 22, C["brand_100"])
    t(x + 56, py + 11, "王小明同学", 10, False, C["t2"])
    t(x + 114, py + 11, "X0003", 9, False, C["t4"])
    pill(x + 148, py + 10, "已认证", C["succ_tx"], C["succ_50"], 8, 6, 15)
    pill_r(x + w - 76, py + 9, status_text, sfg, sbg, 9, 7, 17)
    return y + h + 12


# =========================================================== 20 个页面

def pg_login(x, y):
    y = page(x, y)
    d.ellipse([x + 70, y + 40, x + 330, y + 190], fill="#F2F6FF")
    y2 = nav(x, y, "校园跑腿", back=False)
    cy = y2 + 20
    ggrad(x + PGW / 2 - 30, cy, 60, 60, 18, "#5B84F0", "#1E49C4")
    ico(x + PGW / 2 - 14, cy + 16, "bag", C["w"], 28)
    t(x + PGW / 2, cy + 72, "校园跑腿", 21, True, C["t1"], anchor="ma")
    t(x + PGW / 2, cy + 100, "校园互助 · 极速送达", 11, False, C["t3"], anchor="ma")
    cy += 130
    rr(x + 16, cy, PGW - 32, 226, 18, fill=C["w"], outline=C["line"])
    ix, iw = x + 34, PGW - 68
    rr(ix, cy + 20, iw, 46, 11, fill=C["s2"])
    ico(ix + 12, cy + 34, "user", C["t3"], 18)
    t(ix + 38, cy + 36, "手机号或账号 ID", 11.5, False, C["t4"])
    rr(ix, cy + 78, iw, 46, 11, fill=C["s2"])
    ico(ix + 12, cy + 92, "shield", C["t3"], 18)
    t(ix + 38, cy + 94, "请输入密码", 11.5, False, C["t4"])
    ico(ix + iw - 30, cy + 92, "eye", C["t3"], 18)
    btn(ix, cy + 140, iw, 48, "登 录")
    t(ix, cy + 200, "忘记密码", 10.5, False, C["brand"])
    t(ix + iw, cy + 200, "还没账号？去注册", 10.5, False, C["brand"], anchor="ra")
    t(x + PGW / 2, cy + 252, "登录即代表同意《用户服务协议》与《隐私政策》", 9, False, C["t4"], anchor="ma")
    t(x + PGW / 2, cy + 296, "设备变更需密保解锁 · 连续 5 次密码错误锁定 15 分钟", 9, False, C["t4"],
      anchor="ma")
    return y


def pg_register(x, y):
    y = page(x, y)
    y2 = nav(x, y, "注册账号")
    cx, cw = x + 16, PGW - 32
    t(x + 16, y2 + 2, "① 账号", 10, True, C["brand"])
    hline(x + 62, y2 + 9, 40, C["brand_100"])
    t(x + 110, y2 + 2, "② 密保", 10, False, C["t4"])
    hline(x + 156, y2 + 9, 40)
    t(x + 204, y2 + 2, "③ 完成", 10, False, C["t4"])
    yy = y2 + 26
    t(cx, yy, "账号 ID", 10.5, False, C["t3"])
    rr(cx, yy + 15, cw, 44, 10, fill=C["s2"])
    rr(cx + 8, yy + 21, 34, 32, 8, fill=C["brand_50"])
    t(cx + 25, yy + 29, "X", 13, True, C["brand"], anchor="ma")
    t(cx + 50, yy + 30, "0007", 13, True, C["t1"])
    rr(cx + cw - 66, yy + 21, 58, 32, 8, fill=C["w"], outline=C["line_s"])
    t(cx + cw - 37, yy + 30, "随机", 11, True, C["brand"], anchor="ma")
    t(cx, yy + 63, "前缀固定 X（普通用户），后缀可自定义", 9, False, C["t4"])
    yy += 84
    t(cx, yy, "密码", 10.5, False, C["t3"])
    rr(cx, yy + 15, cw, 42, 10, fill=C["s2"])
    t(cx + 12, yy + 27, "••••••••••", 12, False, C["t2"])
    t(cx + 2, yy + 62, "强度：中", 9, True, C["succ_tx"])
    bar(cx + 52, yy + 65, 46, 5, C["succ"])
    bar(cx + 102, yy + 65, 46, 5, C["succ"])
    bar(cx + 152, yy + 65, 46, 5, C["line"])
    yy += 82
    t(cx, yy, "确认密码", 10.5, False, C["t3"])
    rr(cx, yy + 15, cw, 42, 10, fill=C["s2"])
    yy += 66
    t(cx, yy, "手机号（选填）", 10.5, False, C["t3"])
    rr(cx, yy + 15, cw, 42, 10, fill=C["s2"])
    t(cx + 12, yy + 27, "13800000000", 12, False, C["t4"])
    t(cx + cw - 12, yy + 27, "仅用于人工联系", 9, False, C["t4"], anchor="ra")
    yy += 78
    t(cx, yy, "密保问题 1", 10.5, False, C["t3"])
    rr(cx, yy + 15, cw, 40, 10, fill=C["w"], outline=C["line_s"])
    t(cx + 12, yy + 26, "自定义问题 / 预设下拉", 11, False, C["t4"])
    ico(cx + cw - 26, yy + 25, "chev", C["t4"], 16)
    yy += 62
    rr(cx, yy, cw, 40, 10, fill=C["s2"])
    t(cx + 12, yy + 11, "答案", 11, False, C["t4"])
    yy += 52
    t(cx, yy, "密保问题 2", 10.5, False, C["t3"])
    rr(cx, yy + 15, cw, 40, 10, fill=C["w"], outline=C["line_s"])
    t(cx + 12, yy + 26, "预设问题 · 下拉选择", 11, False, C["t4"])
    ico(cx + cw - 26, yy + 25, "chev", C["t4"], 16)
    yy += 62
    rr(cx, yy, cw, 40, 10, fill=C["s2"])
    yy += 54
    d.rectangle([cx, yy + 1, cx + 13, yy + 14], outline=C["brand"], width=1)
    d.line([(cx + 3, yy + 8), (cx + 6, yy + 11)], fill=C["brand"], width=2)
    d.line([(cx + 6, yy + 11), (cx + 10, yy + 3)], fill=C["brand"], width=2)
    t(cx + 20, yy, "我已阅读并同意《用户服务协议》与《隐私政策》", 9.5, False, C["t2"])
    by = y + PGH - 78 - 62
    d.rectangle([x + 1, by, x + PGW - 1, by + 62], fill=C["w"])
    hline(x + 1, by, PGW - 2)
    btn(cx, by + 11, cw, 44, "注册并登录")
    return y


def pg_forgot(x, y):
    y = page(x, y)
    y2 = nav(x, y, "找回密码")
    cx, cw = x + 16, PGW - 32
    rr(cx, y2 + 2, cw, 46, 12, fill=C["brand_50"])
    ico(cx + 12, y2 + 16, "shield", C["brand"], 18)
    t(cx + 38, y2 + 12, "已认证账号需填：账号 ID + 学号 + 姓名", 10, True, C["brand_d"])
    t(cx + 38, y2 + 28, "+ 2 道密保答案，全部正确才可重置", 9.5, False, C["t3"])
    yy = y2 + 62
    yy = field(cx, yy, cw, "账号 ID", value="X0007")
    yy = field(cx, yy, cw, "学号", value="20240311")
    yy = field(cx, yy, cw, "姓名", value="李四")
    t(cx, yy, "密保问题 1 · 你的小学班主任姓名？", 10.5, False, C["t3"])
    rr(cx, yy + 15, cw, 40, 10, fill=C["s2"])
    t(cx + 12, yy + 26, "请输入答案", 11, False, C["t4"])
    yy += 62
    t(cx, yy, "密保问题 2 · 你母亲的名字？", 10.5, False, C["t3"])
    rr(cx, yy + 15, cw, 40, 10, fill=C["s2"])
    t(cx + 12, yy + 26, "请输入答案", 11, False, C["t4"])
    yy += 66
    t(cx, yy, "图形验证码", 10.5, False, C["t3"])
    rr(cx, yy + 15, 120, 42, 10, fill=C["s2"])
    t(cx + 14, yy + 27, "7 + 5 = ?", 12, True, C["t3"])
    rr(cx + 130, yy + 15, cw - 130, 42, 10, fill=C["s2"])
    t(cx + 142, yy + 27, "输入计算结果", 11, False, C["t4"])
    btn(cx, yy + 72, cw, 48, "验证身份并重置密码")
    return y


def pg_secsetup(x, y):
    y = page(x, y)
    y2 = nav(x, y, "设置密保问题", back=False)
    cx, cw = x + 16, PGW - 32
    rr(cx, y2 + 4, cw, 62, 14, fill=C["warn_50"])
    ico(cx + 14, y2 + 20, "shield", C["warn_tx"], 20)
    t(cx + 44, y2 + 16, "首次登录必须完成密保设置", 11.5, True, C["warn_tx"])
    t(cx + 44, y2 + 34, "用于忘记密码找回与新设备安全解锁，", 9.5, False, C["t2"])
    t(cx + 44, y2 + 48, "请务必牢记，答错无法找回。", 9.5, False, C["t2"])
    yy = y2 + 82
    for i in (1, 2):
        rr(cx, yy, cw, 132, 14, fill=C["w"], outline=C["line"])
        t(cx + 14, yy + 12, "密保问题 %d" % i, 11, True, C["t1"])
        rr(cx + 14, yy + 34, cw - 28, 40, 10, fill=C["w"], outline=C["line_s"])
        t(cx + 26, yy + 45, "下拉选择或自定义问题", 11, False, C["t4"])
        ico(cx + cw - 40, yy + 44, "chev", C["t4"], 16)
        t(cx + 14, yy + 82, "答案", 9.5, False, C["t3"])
        rr(cx + 14, yy + 96, cw - 28, 30, 8, fill=C["s2"])
        t(cx + 26, yy + 103, "请输入答案", 10.5, False, C["t4"])
        yy += 146
    btn(cx, yy - 4, cw, 48, "完成设置，进入首页")
    t(x + PGW / 2, yy + 56, "设置后可在「我的 → 安全中心」修改", 9, False, C["t4"], anchor="ma")
    return y


def pg_index(x, y):
    y = page(x, y)
    y2 = nav(x, y, "校园跑腿", back=False)
    cx, cw = x + 16, PGW - 32
    t(cx, y2 + 2, "校园跑腿", 19, True, C["t1"])
    t(cx, y2 + 28, "Hi 王小明，今天想跑点什么？", 10.5, False, C["t3"])
    yy = y2 + 48
    sw = cw - 74
    rr(cx, yy, sw, 40, 20, fill=C["w"], outline=C["line_s"])
    ico(cx + 12, yy + 11, "search", C["t4"], 18)
    t(cx + 36, yy + 13, "搜索地址 / 类型", 11, False, C["t4"])
    rr(cx + sw + 8, yy, 66, 40, 20, fill=C["brand_50"])
    ico(cx + sw + 18, yy + 11, "filter", C["brand"], 18)
    t(cx + sw + 40, yy + 13, "筛选", 11, True, C["brand"])
    dot(cx + sw + 62, yy + 9, 4, C["accent"])
    yy += 52
    ggrad(cx, yy, cw, 104, 16, "#22314F", C["d1"])
    t(cx + 16, yy + 13, "我接的单 · 配送中", 9.5, False, "#93A4C4")
    t(cx + cw - 16, yy + 9, "23:41", 21, True, C["w"], anchor="ra")
    t(cx + cw - 16, yy + 34, "剩余时间", 8.5, False, "#7D8DA9", anchor="ra")
    rr(cx + 16, yy + 46, cw - 32, 5, 2, fill="#3A4A6B")
    rr(cx + 16, yy + 46, (cw - 32) * 0.42, 5, 2, fill="#5B84F0")
    t(cx + 16, yy + 62, "东区3号楼A203", 13, True, C["w"])
    t(cx + 16, yy + 82, "取快递 · ¥ 0.80", 10, False, "#B9C6DD")
    rr(cx + cw - 40, yy + 70, 24, 24, 12, fill="#2E3E5E")
    ico(cx + cw - 34, yy + 76, "chev", C["w"], 12)
    yy += 116
    t(cx, yy, "快捷下单", 12, True, C["t1"])
    t(cx + cw, yy + 1, "点击直达发布", 9, False, C["t4"], anchor="ra")
    yy += 20
    qw = (cw - 3 * 10) / 4.0
    quick = [("box", "取快递", C["brand"], C["brand_50"], "免费x1"),
             ("bowl", "食堂带饭", C["accent"], C["accent_50"], None),
             ("doc", "打印资料", C["succ"], C["succ_50"], None),
             ("bag", "超市代买", C["warn"], C["warn_50"], None)]
    for i, (kd, nm, fg, bg, bd) in enumerate(quick):
        qx = cx + i * (qw + 10)
        rr(qx, yy, qw, 66, 14, fill=C["w"], outline=C["line"])
        rr(qx + qw / 2 - 15, yy + 10, 30, 30, 15, fill=bg)
        ico(qx + qw / 2 - 9, yy + 16, kd, fg, 18)
        t(qx + qw / 2, yy + 46, nm, 9.5, False, C["t2"], anchor="ma")
        if bd:
            pill_r(qx + qw + 2, yy - 8, bd, C["w"], C["accent"], 8, 5, 15)
    yy += 82
    t(cx, yy, "最新任务", 12, True, C["t1"])
    t(cx + cw, yy + 1, "共 12 条", 9, False, C["t4"], anchor="ra")
    yy += 18
    yy = task_card(cx, yy, cw, "东区3号楼A203", "取快递", 0.8, "待接单", C["brand"], C["brand_50"])
    yy = task_card(cx, yy, cw, "西区2号楼B406", "食堂带饭", 1.0, "进行中", C["warn_tx"],
                   C["warn_50"], accent=C["warn"])
    task_card(cx, yy, cw, "南区5号楼A101", "打印资料", 3.0, "已完成", C["succ_tx"], C["succ_50"],
              accent=C["succ"])
    tabbar(x, 0, 3)
    return y


def pg_publish(x, y):
    y = page(x, y)
    y2 = nav(x, y, "发布任务")
    cx, cw = x + 16, PGW - 32
    t(cx, y2 + 2, "快捷模板", 11, True, C["t1"])
    t(cx + cw, y2 + 3, "点击自动填充表单", 9, False, C["t4"], anchor="ra")
    yy = y2 + 20
    for i, (nm, on, bd) in enumerate([("取快递", True, "免费x1"), ("食堂带饭", False, None),
                                      ("打印资料", False, None), ("超市代买", False, None)]):
        w = 84
        px_ = cx + i * (w + 6)
        rr(px_, yy, w, 30, 15, fill=C["brand_50"] if on else C["w"],
           outline=C["brand_100"] if on else C["line_s"])
        t(px_ + w / 2, yy + 9, nm, 10.5, on, C["brand"] if on else C["t2"], anchor="ma")
        if bd:
            pill_r(px_ + w + 2, yy - 9, bd, C["w"], C["accent"], 8, 5, 15)
    yy += 44
    yy = field(cx, yy, cw, "收件人姓名 *", value="张老师")
    yy = field(cx, yy, cw, "手机号 *", value="138****6621")
    yy = field(cx, yy, cw, "取件码", value="8-2-1066")
    yy = field(cx, yy, cw, "送达地址 *", value="东区3号楼A203")
    t(cx, yy, "酬金（元）*", 10.5, False, C["t3"])
    rr(cx, yy + 15, cw, 44, 10, fill=C["w"], outline=C["brand"], ow=1)
    t(cx + 14, yy + 27, "0.80", 17, True, C["accent_tx"])
    t(cx + cw - 14, yy + 30, "最低 0.50 元", 9.5, False, C["t4"], anchor="ra")
    yy += 71
    yy = field(cx, yy, cw, "详细地址", value="3号宿舍楼2单元203")
    rr(cx, yy, cw, 46, 10, fill=C["s2"])
    t(cx + 12, yy + 15, "备注：帮我拿快递，尽快谢谢！", 10.5, False, C["t2"])
    yy += 58
    for i, lb in enumerate(["限时 60 分钟", "不限时"]):
        on = i == 0
        rx = cx + i * 104
        rr(rx, yy, 96, 30, 15, fill=C["brand_50"] if on else C["w"],
           outline=C["brand_100"] if on else C["line_s"])
        t(rx + 48, yy + 9, lb, 10, on, C["brand"] if on else C["t2"], anchor="ma")
    yy += 44
    t(cx, yy, "物品照片 *（至少 1 张，最多 3 张）", 10.5, False, C["t3"])
    yy += 16
    for i in range(3):
        bx = cx + i * 62
        if i < 2:
            rr(bx, yy, 54, 54, 10, fill=C["brand_50"])
            ico(bx + 18, yy + 18, "box", C["brand"], 18)
        else:
            rr(bx, yy, 54, 54, 10, fill=C["s2"])
            ico(bx + 18, yy + 18, "plus", C["t4"], 18)
    by = y + PGH - 78 - 64
    d.rectangle([x + 1, by, x + PGW - 1, by + 64], fill=C["w"])
    hline(x + 1, by, PGW - 2)
    t(cx, by + 12, "平台服务费", 10, False, C["t3"])
    t(cx, by + 30, "¥ 0.10（本次邀请权益已抵扣）", 11, True, C["succ_tx"])
    btn(cx + cw - 148, by + 12, 148, 42, "免费发布")
    return y


def pg_detail_owner(x, y):
    y = page(x, y)
    y2 = nav(x, y, "任务详情")
    cx, cw = x + 16, PGW - 32
    rr(cx, y2 + 2, cw, 56, 14, fill=C["succ_50"])
    t(cx + 16, y2 + 12, "待雇主确认", 14, True, C["succ_tx"])
    t(cx + 16, y2 + 34, "跑腿员已送达，请核对照片后确认", 9.5, False, C["t2"])
    pill_r(cx + cw - 12, y2 + 12, "剩余 1:47:20", C["succ_tx"], C["w"], 9, 7, 18)
    yy = y2 + 70
    t(cx, yy, "送达照片", 11, True, C["t1"])
    yy += 18
    for i in range(3):
        rr(cx + i * 62, yy, 54, 54, 10, fill=C["brand_50"])
        ico(cx + i * 62 + 18, yy + 18, "box", C["brand"], 18)
    yy += 68
    t(cx, yy, "任务人员", 11, True, C["t1"])
    yy += 18
    yy = person_card(cx, yy, cw, "雇主", "王小明同学", "X0003", "20240311", "ok")
    yy = person_card(cx, yy, cw, "跑腿员", "李四同学", "X0007", "20240402", "ok")
    yy += 2
    t(cx, yy, "任务信息", 11, True, C["t1"])
    yy += 18
    rr(cx, yy, cw, 158, 14, fill=C["w"], outline=C["line"])
    rows = [("订单号", "GCPT202609190007"), ("送达地址", "东区3号楼A203"),
            ("详细地址", "3号宿舍楼2单元203"), ("取件码", "8-2-1066"),
            ("收件人", "张老师 138****6621"), ("酬金 / 服务费", "¥ 0.80 / 0.10")]
    ry = yy + 12
    for i, (k, v) in enumerate(rows):
        t(cx + 14, ry, k, 9.5, False, C["t3"])
        t(cx + cw - 14, ry, v, 9.5, i == 0, C["t2"], anchor="ra")
        if i < len(rows) - 1:
            hline(cx + 14, ry + 14, cw - 28)
        ry += 24
    by = y + PGH - 78 - 64
    d.rectangle([x + 1, by, x + PGW - 1, by + 64], fill=C["w"])
    hline(x + 1, by, PGW - 2)
    btn(cx, by + 11, 108, 42, "未送达", "ghost")
    btn(cx + 116, by + 11, cw - 116, 42, "确认送达")
    d.rectangle([x + 1, y2 + 148, x + PGW - 1, y + PGH - 6], fill="#C9CFDA")
    mx, mw = x + 44, PGW - 88
    rr(mx, y2 + 186, mw, 172, 18, fill=C["w"], outline=C["line_s"])
    t(mx + mw / 2, y2 + 206, "确认送达", 14, True, C["t1"], anchor="ma")
    t(mx + 24, y2 + 236, "确认后任务将标记为已完成，", 10.5, False, C["t2"])
    t(mx + 24, y2 + 254, "并为跑腿员生成收入账单。", 10.5, False, C["t2"])
    bw = (mw - 60) / 2
    btn(mx + 24, y2 + 286, bw, 42, "否", "ghost")
    btn(mx + 36 + bw, y2 + 286, bw, 42, "确定 3")
    return y


def pg_detail_taker(x, y):
    y = page(x, y)
    y2 = nav(x, y, "任务详情")
    cx, cw = x + 16, PGW - 32
    rr(cx, y2 + 2, cw, 62, 14, fill=C["warn_50"])
    t(cx + 16, y2 + 12, "进行中 · 配送中", 14, True, C["warn_tx"])
    t(cx + 16, y2 + 34, "请在限时内送达并上传照片", 9.5, False, C["t2"])
    t(cx + cw - 16, y2 + 10, "23:41", 20, True, C["warn_tx"], anchor="ra")
    t(cx + cw - 16, y2 + 36, "剩余时间", 8.5, False, C["t4"], anchor="ra")
    yy = y2 + 76
    t(cx, yy, "送达照片 *（最多 3 张）", 11, True, C["t1"])
    yy += 18
    rr(cx, yy, 54, 54, 10, fill=C["brand_50"])
    ico(cx + 18, yy + 18, "box", C["brand"], 18)
    for i in (1, 2):
        rr(cx + i * 62, yy, 54, 54, 10, fill=C["s2"])
        ico(cx + i * 62 + 18, yy + 18, "plus", C["t4"], 18)
    yy += 66
    t(cx, yy, "任务人员", 11, True, C["t1"])
    yy += 18
    yy = person_card(cx, yy, cw, "雇主", "王小明同学", "X0003", "20240311", "ok")
    yy = person_card(cx, yy, cw, "跑腿员（我）", "李四同学", "X0007", "20240402", "ok")
    yy += 2
    t(cx, yy, "任务信息", 11, True, C["t1"])
    yy += 18
    rr(cx, yy, cw, 132, 14, fill=C["w"], outline=C["line"])
    rows = [("订单号", "GCPT202609190007"), ("送达地址", "东区3号楼A203"),
            ("详细地址", "3号宿舍楼2单元203"), ("取件码", "8-2-1066"),
            ("报酬", "¥ 0.80（线下转账）")]
    ry = yy + 12
    for i, (k, v) in enumerate(rows):
        t(cx + 14, ry, k, 9.5, False, C["t3"])
        t(cx + cw - 14, ry, v, 9.5, i == 0, C["t2"], anchor="ra")
        if i < len(rows) - 1:
            hline(cx + 14, ry + 14, cw - 28)
        ry += 24
    yy += 142
    btn(cx, yy, cw, 40, "取消接单", "ghost")
    by = y + PGH - 78 - 64
    d.rectangle([x + 1, by, x + PGW - 1, by + 64], fill=C["w"])
    hline(x + 1, by, PGW - 2)
    t(cx, by + 12, "请先上传送达照片", 9.5, False, C["t4"])
    btn(cx, by + 28, cw, 30, "提交已送达", "primary", 12)
    return y


def pg_mypublish(x, y):
    y = page(x, y)
    y2 = nav(x, y, "我的发布")
    cx, cw = x + 16, PGW - 32
    stat = [("全部", 12), ("待接单", 3), ("进行中", 2), ("待确认", 1), ("已完成", 6)]
    xx = cx
    for i, (nm, n) in enumerate(stat):
        on = i == 1
        w = 52
        rr(xx, y2 + 2, w, 28, 14, fill=C["brand"] if on else C["w"],
           outline=None if on else C["line_s"])
        t(xx + w / 2, y2 + 9, "%s %d" % (nm, n), 9.5, on, C["w"] if on else C["t2"], anchor="ma")
        xx += w + 5
    yy = y2 + 42
    for addr, tpl, m, st, fg, bg, btns in [
            ("东区3号楼A203", "取快递", 0.8, "待接单", C["brand"], C["brand_50"], ["编辑", "撤销"]),
            ("西区2号楼B406", "食堂带饭", 1.0, "进行中", C["warn_tx"], C["warn_50"], ["加酬金"]),
            ("南区5号楼A101", "打印资料", 3.0, "已完成", C["succ_tx"], C["succ_50"], [])]:
        rr(cx, yy, cw, 112, 14, fill=C["w"], outline=C["line"])
        rr(cx + 13, yy + 16, 5, 80, 3, fill=fg)
        t(cx + 28, yy + 12, addr, 13, True, C["t1"])
        dw = d.textlength(addr, font=F(13, True))
        tag(cx + 34 + dw, yy + 12, tpl, C["t3"], C["s2"])
        t(cx + cw - 16, yy + 10, "楼", 10, True, C["accent_tx"], anchor="ra")
        t(cx + cw - 16, yy + 22, "%.2f" % m, 19, True, C["accent_tx"], anchor="ra")
        t(cx + 28, yy + 44, "订单号 GCPT202609190007", 9, False, C["t4"])
        hline(cx + 28, yy + 64, cw - 44)
        pill(cx + 28, yy + 74, st, fg, bg, 9, 7, 18)
        bx = cx + cw - 16
        for lb in reversed(btns):
            w = 62
            bx -= w
            kind = "ghost" if lb == "撤销" else ("soft" if lb == "编辑" else "warn")
            btn(bx, yy + 72, w, 28, lb, kind, 10.5)
            bx -= 8
        yy += 124
    tabbar(x, 1)
    return y


def pg_mytake(x, y):
    y = page(x, y)
    y2 = nav(x, y, "我的任务")
    cx, cw = x + 16, PGW - 32
    for i, (nm, on) in enumerate([("进行中 2", True), ("待确认 1", False), ("已完成 5", False)]):
        w = 82
        xx = cx + i * (w + 6)
        rr(xx, y2 + 2, w, 28, 14, fill=C["brand"] if on else C["w"],
           outline=None if on else C["line_s"])
        t(xx + w / 2, y2 + 9, nm, 10, on, C["w"] if on else C["t2"], anchor="ma")
    yy = y2 + 42
    rr(cx, yy, cw, 118, 14, fill=C["w"], outline=C["line"])
    rr(cx + 13, yy + 16, 5, 86, 3, fill=C["warn"])
    t(cx + 28, yy + 12, "东区3号楼A203", 13, True, C["t1"])
    t(cx + cw - 16, yy + 12, "23:41", 18, True, C["warn_tx"], anchor="ra")
    t(cx + cw - 16, yy + 34, "剩余限时", 8.5, False, C["t4"], anchor="ra")
    rr(cx + 28, yy + 38, cw - 108, 5, 2, fill=C["line"])
    rr(cx + 28, yy + 38, (cw - 108) * 0.6, 5, 2, fill=C["warn"])
    t(cx + 28, yy + 52, "取件码 8-2-1066 · 限时 60 分钟", 9.5, False, C["t3"])
    t(cx + 28, yy + 68, "联系人 张老师 138****6621", 9.5, False, C["t3"])
    hline(cx + 28, yy + 88, cw - 44)
    ava(cx + 41, yy + 102, 20, C["brand_100"])
    t(cx + 54, yy + 96, "雇主 王小明", 9.5, False, C["t2"])
    t(cx + 110, yy + 96, "X0003", 9, False, C["t4"])
    btn(cx + cw - 108, yy + 90, 92, 26, "提交已送达", "primary", 10)
    yy += 130
    rr(cx, yy, cw, 92, 14, fill=C["w"], outline=C["line"])
    rr(cx + 13, yy + 16, 5, 60, 3, fill=C["succ"])
    t(cx + 28, yy + 12, "西区2号楼B406", 13, True, C["t1"])
    t(cx + cw - 16, yy + 12, "¥ 1.00", 18, True, C["accent_tx"], anchor="ra")
    t(cx + 28, yy + 38, "待雇主确认中 · 已上传 2 张照片", 9.5, False, C["t3"])
    pill(cx + 28, yy + 58, "待确认", C["succ_tx"], C["succ_50"], 9, 7, 18)
    t(cx + cw - 16, yy + 62, "撤销接单已关闭", 9, False, C["t4"], anchor="ra")
    tabbar(x, 2, 3)
    return y


def pg_taskedit(x, y):
    y = page(x, y)
    y2 = nav(x, y, "编辑任务")
    cx, cw = x + 16, PGW - 32
    rr(cx, y2 + 2, cw, 44, 12, fill=C["brand_50"])
    ico(cx + 12, y2 + 14, "clock", C["brand"], 18)
    t(cx + 38, y2 + 9, "待接单任务可编辑全量字段", 10.5, True, C["brand_d"])
    t(cx + 38, y2 + 25, "两次编辑间隔至少 3 分钟", 9.5, False, C["t3"])
    yy = y2 + 58
    yy = field(cx, yy, cw, "收件人姓名", value="张老师")
    yy = field(cx, yy, cw, "手机号", value="138****6621")
    yy = field(cx, yy, cw, "取件码", value="8-2-1066")
    yy = field(cx, yy, cw, "送达地址", value="东区3号楼A203")
    t(cx, yy, "酬金（元）", 10.5, False, C["t3"])
    rr(cx, yy + 15, cw, 44, 10, fill=C["w"], outline=C["brand"])
    t(cx + 14, yy + 27, "1.00", 17, True, C["accent_tx"])
    t(cx + cw - 14, yy + 30, "原 0.80", 9.5, False, C["t4"], anchor="ra")
    t(cx + 2, yy + 66, "酬金仅可提高，不可降低", 9.5, True, C["accent_tx"])
    yy += 90
    yy = field(cx, yy, cw, "详细地址", value="3号宿舍楼2单元203")
    rr(cx, yy, cw, 46, 10, fill=C["s2"])
    t(cx + 12, yy + 15, "备注：帮我拿快递，尽快谢谢！", 10.5, False, C["t2"])
    yy += 58
    t(cx, yy, "物品照片", 10.5, False, C["t3"])
    yy += 16
    for i in range(3):
        rr(cx + i * 62, yy, 54, 54, 10, fill=C["brand_50"])
        ico(cx + i * 62 + 18, yy + 18, "box", C["brand"], 18)
    by = y + PGH - 78 - 60
    d.rectangle([x + 1, by, x + PGW - 1, by + 60], fill=C["w"])
    hline(x + 1, by, PGW - 2)
    btn(cx, by + 10, 100, 40, "取消", "ghost")
    btn(cx + 108, by + 10, cw - 108, 40, "保存修改")
    return y


def pg_message(x, y):
    y = page(x, y)
    y2 = nav(x, y, "消息中心", right="一键清除")
    cx, cw = x + 16, PGW - 32
    for i, (nm, on) in enumerate([("全部", True), ("系统", False), ("管理员", False),
                                  ("任务", False), ("雇主", False)]):
        w = 54
        xx = cx + i * (w + 5)
        rr(xx, y2 + 2, w, 26, 13, fill=C["brand"] if on else C["s2"])
        t(xx + w / 2, y2 + 8, nm, 9.5, on, C["w"] if on else C["t2"], anchor="ma")
    yy = y2 + 40
    msgs = [("3", "任务消息", "你的任务已被接单", "跑腿员 李四 已接单…", "15:43", True),
            ("2", "管理员消息", "审核结果通知", "你的校园认证已审核通过…", "14:20", True),
            ("1", "系统消息", "欢迎加入校园跑腿", "完善校园认证即可发布任务…", "09-18", False),
            ("3", "任务消息", "任务已完成", "雇主已确认送达，收入 0.80 元…", "09-18", False),
            ("4", "雇主消息", "雇主调整了酬金", "酬金已从 0.80 提高到 1.00…", "09-17", False),
            ("1", "系统消息", "安全提醒", "你的账号在新设备登录…", "09-17", False)]
    colmap = {"1": (C["brand"], C["brand_50"]), "2": (C["accent"], C["accent_50"]),
              "3": (C["succ"], C["succ_50"]), "4": (C["warn"], C["warn_50"])}
    icol = {"1": "bell", "2": "shield", "3": "box", "4": "user"}
    rr(cx, yy, cw, len(msgs) * 52 + 8, 14, fill=C["w"], outline=C["line"])
    ry = yy + 4
    for i, (tp, lb, ti, sub, tm, unread) in enumerate(msgs):
        fg, bg = colmap[tp]
        rr(cx + 10, ry + 10, 30, 30, 15, fill=bg)
        ico(cx + 16, ry + 16, icol[tp], fg, 18)
        t(cx + 50, ry + 8, ti, 11, True, C["t1"])
        t(cx + 50, ry + 26, sub, 9.5, False, C["t4"])
        t(cx + cw - 12, ry + 9, tm, 9, False, C["t4"], anchor="ra")
        if unread:
            dot(cx + cw - 14, ry + 32, 3.5, C["dang"])
        if i < len(msgs) - 1:
            hline(cx + 50, ry + 52, cw - 62)
        ry += 52
    t(cx, yy + len(msgs) * 52 + 24, "点击任意消息进入详情页", 9.5, False, C["t4"])
    return y


def pg_msgdetail(x, y):
    y = page(x, y)
    y2 = nav(x, y, "消息详情")
    cx, cw = x + 16, PGW - 32
    pill(cx, y2 + 8, "任务消息", C["succ_tx"], C["succ_50"], 9, 8, 18)
    t(cx, y2 + 38, "你的任务已被接单", 17, True, C["t1"])
    t(cx, y2 + 66, "2026-09-19 15:43", 9.5, False, C["t4"])
    hline(cx, y2 + 84, cw)
    yy = y2 + 100
    for ln in ["跑腿员 李四同学（ID X0007）已接下你的任务。",
               "请在对方送达后，进入任务详情页核对送达照片，",
               "并在 2 小时内点击「确认送达」完成订单。",
               "超时未确认，系统将自动确认并生成账单。"]:
        t(cx, yy, ln, 11, False, C["t2"])
        yy += 22
    yy += 12
    rr(cx, yy, cw, 84, 14, fill=C["s2"])
    t(cx + 14, yy + 12, "关联任务", 9.5, False, C["t3"])
    t(cx + 14, yy + 30, "东区3号楼A203 · 取快递", 12, True, C["t1"])
    t(cx + 14, yy + 52, "订单号 GCPT202609190007", 9.5, False, C["t3"])
    t(cx + cw - 14, yy + 60, "查看详情", 10, True, C["brand"], anchor="ra")
    ico(cx + cw - 30, yy + 30, "chev", C["t3"], 16)
    return y


def pg_profile(x, y):
    y = page(x, y)
    y2 = nav(x, y, "我的", back=False)
    cx, cw = x + 16, PGW - 32
    rr(cx, y2 + 2, cw, 122, 18, fill=C["brand_50"])
    ava(cx + 40, y2 + 42, 52, C["brand"])
    d.ellipse([cx + 64, y2 + 12, cx + 80, y2 + 28], fill=C["w"])
    dot(cx + 72, y2 + 20, 5.5, C["succ"])
    t(cx + 76, y2 + 22, "王小明同学", 14, True, C["t1"])
    pill(cx + 158, y2 + 22, "已认证", C["succ_tx"], C["w"], 9, 7, 17)
    t(cx + 76, y2 + 44, "账号 ID  X0003", 10.5, False, C["t2"])
    ico(cx + 168, y2 + 42, "copy", C["brand"], 16)
    t(cx + 188, y2 + 44, "点击复制", 8.5, False, C["brand"])
    t(cx + 76, y2 + 64, "可用于登录", 8.5, False, C["t4"])
    t(cx + 76, y2 + 84, "邀请码  K7M2QX", 10.5, False, C["t2"])
    ico(cx + 168, y2 + 82, "copy", C["brand"], 16)
    for i, (nm, v) in enumerate([("发布", "12"), ("接单", "8"), ("完成率", "96%")]):
        bx = cx + 16 + i * 106
        t(bx, y2 + 134, v, 16, True, C["t1"])
        t(bx + 2, y2 + 158, nm, 9.5, False, C["t3"])
    yy = y2 + 178
    groups = [("账号与安全", [("校园认证", "已认证"), ("修改头像 / 昵称", ""),
                          ("安全中心（密保）", ""), ("我的设备", "2 台"),
                          ("忘记密码", "")]),
              ("我的服务", [("收支账单", ""), ("我的申诉", ""), ("帮助与反馈", "")])]
    for gt, items in groups:
        t(cx, yy, gt, 10, True, C["t3"])
        yy += 18
        rr(cx, yy, cw, len(items) * 38, 14, fill=C["w"], outline=C["line"])
        ry = yy
        for i, (nm, extra) in enumerate(items):
            dot(cx + 22, ry + 19, 3, C["brand"])
            t(cx + 34, ry + 12, nm, 11, False, C["t1"])
            if extra:
                t(cx + cw - 30, ry + 13, extra, 9.5, False, C["t3"], anchor="ra")
            ico(cx + cw - 22, ry + 11, "chev", C["t4"], 16)
            if i < len(items) - 1:
                hline(cx + 34, ry + 38, cw - 46)
            ry += 38
        yy = ry + 16
    btn(cx, yy, cw, 40, "退出登录", "ghost")
    t(x + PGW / 2, yy + 48, "注销账号", 10.5, True, C["dang_tx"], anchor="ma")
    t(x + PGW / 2, yy + 68, "使用中如遇到问题加入官方Q群咨询解决 123xxxx333", 8.5,
      False, C["t4"], anchor="ma")
    tabbar(x, 3)
    return y


def pg_bill(x, y):
    y = page(x, y)
    y2 = nav(x, y, "收支账单")
    cx, cw = x + 16, PGW - 32
    ggrad(cx, y2 + 2, cw, 92, 16, "#5B84F0", C["brand_d"])
    t(cx + 18, y2 + 16, "本月收入（跑腿酬金）", 9.5, False, "#D6E0FB")
    t(cx + 18, y2 + 32, "¥ 12.80", 24, True, C["w"])
    t(cx + 18, y2 + 66, "累计完成 8 单", 9, False, "#C3D1F6")
    d.line([(cx + cw * 0.52, y2 + 14), (cx + cw * 0.52, y2 + 80)], fill="#7C9CF3", width=1)
    t(cx + cw * 0.56, y2 + 16, "本月支出（服务费）", 9.5, False, "#D6E0FB")
    t(cx + cw * 0.56, y2 + 32, "¥ 1.20", 24, True, C["w"])
    t(cx + cw * 0.56, y2 + 66, "共发布 12 单", 9, False, "#C3D1F6")
    yy = y2 + 106
    t(cx, yy, "流水明细", 11, True, C["t1"])
    t(cx + cw, yy + 1, "按时间倒序", 9, False, C["t4"], anchor="ra")
    yy += 18
    rows = [("收入", "任务收入", "任务已完成 · 东区3号楼A203", "09-19 16:02", "+0.80"),
            ("支出", "服务费支出", "发布任务 GCPT202609190006", "09-19 15:10", "-0.10"),
            ("收入", "任务收入", "任务已完成 · 西区2号楼B406", "09-18 20:31", "+1.00"),
            ("支出", "服务费支出", "发布任务 GCPT202609180011", "09-18 19:44", "-0.10"),
            ("收入", "任务收入", "任务已完成 · 南区5号楼A101", "09-17 12:09", "+3.00")]
    rr(cx, yy, cw, len(rows) * 52 + 8, 14, fill=C["w"], outline=C["line"])
    ry = yy + 4
    for i, (kd, ttl, sub, tm, amt) in enumerate(rows):
        inc = kd == "收入"
        rr(cx + 10, ry + 9, 30, 30, 15, fill=C["succ_50"] if inc else C["accent_50"])
        ico(cx + 16, ry + 15, "star" if inc else "doc", C["succ"] if inc else C["accent"], 18)
        t(cx + 50, ry + 7, ttl, 11, True, C["t1"])
        t(cx + 50, ry + 25, sub, 9.5, False, C["t4"])
        t(cx + cw - 12, ry + 7, amt, 13, True, C["succ_tx"] if inc else C["accent_tx"], anchor="ra")
        t(cx + cw - 12, ry + 27, tm, 9, False, C["t4"], anchor="ra")
        if i < len(rows) - 1:
            hline(cx + 50, ry + 52, cw - 62)
        ry += 52
    t(cx, yy + len(rows) * 52 + 22, "账单仅作记账展示，平台不托管酬金；", 9, False, C["t4"])
    t(cx, yy + len(rows) * 52 + 36, "无提现功能，点击流水可跳转任务详情。", 9, False, C["t4"])
    return y


def pg_campus(x, y):
    y = page(x, y)
    y2 = nav(x, y, "校园认证")
    cx, cw = x + 16, PGW - 32
    rr(cx, y2 + 2, cw, 150, 14, fill=C["dang_50"])
    t(cx + 14, y2 + 12, "截图上传要求（务必阅读）", 11, True, C["dang_tx"])
    lines = ["图片需上传本人在智慧校园中打开身份卡页面，",
             "上传截图中需包含的信息有：本人照片、姓名、类别、",
             "班级、宿舍、手机号码、登录账号(学号)、专业名称。"]
    ly = y2 + 34
    for ln in lines:
        t(cx + 14, ly, ln, 9.5, False, C["dang_tx"])
        ly += 16
    rr(cx + cw - 78, y2 + 12, 64, 64, 10, fill=C["w"], outline=C["line_s"])
    ico(cx + cw - 60, y2 + 30, "doc", C["t4"], 28)
    t(cx + cw - 46, y2 + 66, "示例图", 8, False, C["t4"], anchor="ma")
    t(cx + 14, y2 + 110, "7 天内最多提交 3 次，本次提交后剩余 2 次。", 9.5, True, C["dang_tx"])
    t(cx + 14, y2 + 128, "审核通过前不能发布任务与接单。", 9.5, False, C["t2"])
    yy = y2 + 166
    yy = field(cx, yy, cw, "真实姓名 *", value="王小明")
    yy = field(cx, yy, cw, "真实学号 *", value="20240311")
    yy = field(cx, yy, cw, "可联系手机号 *", value="138****6621")
    t(cx, yy, "校园身份截图 *", 10.5, False, C["t3"])
    yy += 16
    rr(cx, yy, cw, 106, 12, fill=C["s2"], outline=C["line_s"])
    ico(cx + cw / 2 - 14, yy + 26, "plus", C["t3"], 28)
    t(cx + cw / 2, yy + 62, "点击上传（jpg / png / webp，≤2MB）", 9.5, False, C["t4"], anchor="ma")
    t(cx + cw / 2, yy + 80, "提交成功后表单将自动清空", 9, False, C["t4"], anchor="ma")
    btn(cx, yy + 122, cw, 46, "提交认证申请")
    return y


def pg_audit(x, y):
    y = page(x, y)
    y2 = nav(x, y, "修改资料")
    cx, cw = x + 16, PGW - 32
    hw = (cw - 8) / 2
    rr(cx, y2 + 2, hw, 32, 10, fill=C["brand_50"])
    t(cx + hw / 2, y2 + 10, "修改头像", 11, True, C["brand"], anchor="ma")
    rr(cx + hw + 8, y2 + 2, hw, 32, 10, fill=C["s2"])
    t(cx + hw + 8 + hw / 2, y2 + 10, "修改昵称", 11, False, C["t2"], anchor="ma")
    yy = y2 + 50
    rr(cx, yy, cw, 148, 14, fill=C["w"], outline=C["line"])
    t(cx + 16, yy + 14, "当前头像", 10, False, C["t3"])
    ava(cx + 46, yy + 58, 52, C["brand_100"])
    t(cx + 88, yy + 34, "请上传清晰的本人头像", 10.5, False, C["t2"])
    t(cx + 88, yy + 52, "提交后由管理员审核，", 9.5, False, C["t4"])
    t(cx + 88, yy + 68, "审核通过后才生效。", 9.5, False, C["t4"])
    rr(cx + cw - 108, yy + 96, 92, 32, 10, fill=C["brand_50"])
    t(cx + cw - 62, yy + 105, "选择图片", 10.5, True, C["brand"], anchor="ma")
    btn(cx, yy + 162, cw, 44, "提交审核")
    yy += 220
    t(cx, yy, "我的申请记录", 11, True, C["t1"])
    yy += 18
    rr(cx, yy, cw, 132, 14, fill=C["w"], outline=C["line"])
    recs = [("头像修改", "审核通过", C["succ_tx"], C["succ_50"]),
            ("昵称修改", "已驳回 · 含违规词", C["dang_tx"], C["dang_50"]),
            ("校园认证", "待审核", C["warn_tx"], C["warn_50"])]
    ry = yy + 6
    for i, (nm, st, fg, bg) in enumerate(recs):
        t(cx + 14, ry + 12, nm, 10.5, False, C["t1"])
        pill_r(cx + cw - 14, ry + 9, st, fg, bg, 9, 7, 18)
        if i < len(recs) - 1:
            hline(cx + 14, ry + 40, cw - 28)
        ry += 40
    return y


def pg_appeal(x, y):
    y = page(x, y)
    y2 = nav(x, y, "申诉")
    cx, cw = x + 16, PGW - 32
    rr(cx, y2 + 2, cw, 40, 12, fill=C["brand_50"])
    t(cx + 14, y2 + 12, "今日剩余申诉次数：1 / 2", 10.5, True, C["brand_d"])
    t(cx + cw - 14, y2 + 13, "每日 0 点重置", 9, False, C["t3"], anchor="ra")
    yy = y2 + 54
    t(cx, yy, "申诉内容", 10.5, False, C["t3"])
    rr(cx, yy + 16, cw, 128, 12, fill=C["s2"])
    for i, ln in enumerate(["我的账号在 09-19 被误封禁，",
                            "当时是因为配送超时，但对方地址填写有误，",
                            "希望管理员核实后解除封禁。"]):
        t(cx + 12, yy + 30 + i * 22, ln, 10.5, False, C["t2"])
    t(cx + cw - 12, yy + 122, "68 / 200", 9, False, C["t4"], anchor="ra")
    btn(cx, yy + 156, cw, 44, "提交申诉")
    yy += 216
    t(cx, yy, "我的申诉记录", 11, True, C["t1"])
    yy += 18
    for st, fg, bg, reply in [("已回复", C["succ_tx"], C["succ_50"], "已核实，封禁已解除。"),
                              ("待处理", C["warn_tx"], C["warn_50"], None)]:
        hh = 96 if reply else 66
        rr(cx, yy, cw, hh, 14, fill=C["w"], outline=C["line"])
        pill(cx + 14, yy + 12, st, fg, bg, 9, 7, 18)
        t(cx + cw - 14, yy + 14, "09-19 15:43", 9, False, C["t4"], anchor="ra")
        t(cx + 14, yy + 38, "我的账号被误封禁，请核实。", 10.5, False, C["t2"])
        if reply:
            rr(cx + 14, yy + 58, cw - 28, 28, 8, fill=C["s2"])
            t(cx + 24, yy + 65, "管理员回复：" + reply, 9.5, False, C["t2"])
        yy += hh + 12
    return y


def pg_devices(x, y):
    y = page(x, y)
    y2 = nav(x, y, "我的设备")
    cx, cw = x + 16, PGW - 32
    rr(cx, y2 + 2, cw, 42, 12, fill=C["brand_50"])
    ico(cx + 12, y2 + 12, "shield", C["brand"], 18)
    t(cx + 38, y2 + 12, "新设备登录会顶掉旧设备，", 10, False, C["t2"])
    t(cx + 38, y2 + 27, "非本人设备登录需答密保解锁。", 10, False, C["t2"])
    yy = y2 + 58
    t(cx, yy, "当前设备", 10.5, True, C["t1"])
    yy += 18
    rr(cx, yy, cw, 92, 14, fill=C["w"], outline=C["brand_100"])
    rr(cx + 14, yy + 16, 36, 36, 10, fill=C["brand_50"])
    ico(cx + 22, yy + 24, "shield", C["brand"], 20)
    t(cx + 60, yy + 14, "iPhone 15 Pro", 12, True, C["t1"])
    pill_r(cx + cw - 14, yy + 14, "本机", C["brand"], C["brand_50"], 9, 7, 17)
    t(cx + 60, yy + 36, "IP 归属：河南-南阳 · 211.84.**.**", 9.5, False, C["t3"])
    t(cx + 60, yy + 54, "最近登录：2026-09-19 15:43", 9.5, False, C["t3"])
    t(cx + 14, yy + 74, "设备标识 DEV-8F2A19C4", 9, False, C["t4"])
    yy += 106
    t(cx, yy, "历史设备", 10.5, True, C["t1"])
    yy += 18
    devs = [("Xiaomi 14", "河南-南阳 · 已下线", "09-18 21:02"),
            ("HUAWEI Mate 60", "河南-郑州 · 已下线", "09-12 08:31")]
    rr(cx, yy, cw, len(devs) * 62 + 8, 14, fill=C["w"], outline=C["line"])
    ry = yy + 4
    for i, (nm, ip, tm) in enumerate(devs):
        rr(cx + 14, ry + 14, 32, 32, 10, fill=C["s2"])
        ico(cx + 21, ry + 21, "user", C["t3"], 18)
        t(cx + 56, ry + 10, nm, 11, True, C["t1"])
        t(cx + 56, ry + 28, ip, 9.5, False, C["t3"])
        t(cx + cw - 14, ry + 20, tm, 9, False, C["t4"], anchor="ra")
        if i < len(devs) - 1:
            hline(cx + 14, ry + 62, cw - 28)
        ry += 62
    yy += len(devs) * 62 + 24
    t(cx, yy, "如发现陌生设备，请立即修改密码与密保。", 9.5, False, C["t4"])
    return y


def pg_admin(x, y):
    y = page(x, y)
    y2 = nav(x, y, "管理后台", back=False)
    cx, cw = x + 16, PGW - 32
    ggrad(cx, y2 + 2, cw, 84, 16, "#B92626", "#8E1A1A")
    t(cx + 16, y2 + 14, "管理员 · A0001", 12, True, C["w"])
    t(cx + 16, y2 + 34, "学号 20240001 · 拥有最高权限", 9.5, False, "#F3C9C9")
    t(cx + cw - 16, y2 + 16, "今日待办 7", 11, True, C["w"], anchor="ra")
    t(cx + cw - 16, y2 + 36, "2026-09-19", 9, False, "#F3C9C9", anchor="ra")
    yy = y2 + 96
    stats = [("待审核", "3", C["brand"]), ("待回复申诉", "1", C["accent"]),
             ("待处理举报", "2", C["dang"]), ("封禁中", "1", C["warn"])]
    sw = (cw - 3 * 8) / 4
    for i, (nm, v, col) in enumerate(stats):
        bx = cx + i * (sw + 8)
        rr(bx, yy, sw, 62, 12, fill=C["w"], outline=C["line"])
        t(bx + sw / 2, yy + 10, v, 18, True, col, anchor="ma")
        t(bx + sw / 2, yy + 38, nm, 8, False, C["t3"], anchor="ma")
    yy += 76
    t(cx, yy, "管理功能", 11, True, C["t1"])
    yy += 18
    funcs = [("shield", "审核管理"), ("user", "用户管理"), ("doc", "订单管理"), ("star", "申诉处理"),
             ("bell", "举报处理"), ("clock", "封禁管理"), ("list", "消息推送"), ("box", "数据统计")]
    gw = (cw - 3 * 8) / 4
    for i, (kd, nm) in enumerate(funcs):
        gx = cx + (i % 4) * (gw + 8)
        gy = yy + (i // 4) * 78
        rr(gx, gy, gw, 68, 12, fill=C["w"], outline=C["line"])
        rr(gx + gw / 2 - 14, gy + 10, 28, 28, 9, fill=C["brand_50"])
        ico(gx + gw / 2 - 9, gy + 15, kd, C["brand"], 18)
        t(gx + gw / 2, gy + 46, nm, 9, False, C["t2"], anchor="ma")
    yy += 168
    t(cx, yy, "最近待办", 11, True, C["t1"])
    yy += 18
    todos = [("校园认证待审核", "王小明同学 · X0003", C["brand"]),
             ("举报待处理", "任务 GCPT202609190007", C["dang"]),
             ("申诉待回复", "李四同学 · X0007", C["accent"])]
    rr(cx, yy, cw, len(todos) * 48 + 8, 14, fill=C["w"], outline=C["line"])
    ry = yy + 4
    for i, (ti, sub, col) in enumerate(todos):
        dot(cx + 18, ry + 24, 4, col)
        t(cx + 32, ry + 9, ti, 10.5, True, C["t1"])
        t(cx + 32, ry + 27, sub, 9, False, C["t4"])
        t(cx + cw - 14, ry + 16, "去处理", 9.5, True, C["brand"], anchor="ra")
        if i < len(todos) - 1:
            hline(cx + 32, ry + 48, cw - 46)
        ry += 48
    return y


PAGES = [
    ("登录", "单输入框双方式 · 小眼睛密码开关 · 协议链接", pg_login),
    ("注册", "账号ID(前缀锁定+随机) · 密码强度 · 2道密保", pg_register),
    ("忘记密码", "账号ID+学号+姓名+2道密保 · 图形验证码", pg_forgot),
    ("密保设置", "首次登录强制 · 上方问题 / 下方答案", pg_secsetup),
    ("首页 / 任务大厅", "搜索独占一行 · 进行中置顶卡 · 金刚区 · 筛选Sheet", pg_index),
    ("发布任务", "模板预填 · 必填校验 · 免费代拿权益", pg_publish),
    ("任务详情 · 雇主", "送达照片 · 人员卡片 · 确认送达倒计时弹窗", pg_detail_owner),
    ("任务详情 · 接单", "倒计时 · 上传送达照片 · 提交已送达", pg_detail_taker),
    ("我的发布", "状态分组 · 编辑/撤销/加酬金/退费", pg_mypublish),
    ("我的任务", "接单列表 · 倒计时 · 提交已送达", pg_mytake),
    ("编辑任务", "待接单全量编辑 · 酬金仅可提高", pg_taskedit),
    ("消息中心", "紧凑列表 · 分类chips · 一键清除", pg_message),
    ("消息详情", "正文 + 关联任务卡片可跳转", pg_msgdetail),
    ("我的", "账号ID可复制 · 认证徽章 · 分组列表", pg_profile),
    ("收支账单", "汇总卡 · 倒序流水 · 无提现入口", pg_bill),
    ("校园认证", "红色规则提示 + 示例图 + 剩余次数", pg_campus),
    ("修改资料", "头像/昵称申请 · 审核记录", pg_audit),
    ("申诉", "每日 2 次 · 记录含管理员回复", pg_appeal),
    ("我的设备", "本机高亮 · IP 归属地 · 历史设备", pg_devices),
    ("管理后台", "统计四格 · 功能宫格 · 最近待办", pg_admin),
]


def draw_header():
    d.rectangle([0, 0, IMG_W, HEAD_H], fill=C["d1"])
    t(PAD, 34, "校园跑腿 · 全站页面设计稿 v1", 30, True, C["w"])
    t(PAD, 76, "Campus Errand  ·  20 个页面  ·  现代 / 轻量 / 清爽 / 柔和 / 可信  ·  "
               "主色 #2B5CE6   辅助 #EE6C2D   背景 #F5F7FA", 13, False, "#93A4C4")
    kws = ["圆角卡片", "低饱和马卡龙", "触摸反馈 200-500ms", "无 emoji 图标", "字号阶梯 6 级"]
    kx = PAD
    for k in kws:
        w = d.textlength(k, font=F(11, True)) + 22
        rr(kx, 108, w, 26, 13, fill="#22314F")
        t(kx + 11, 116, k, 11, True, "#B9C6DD")
        kx += w + 8
    legend = [("主色", C["brand"]), ("辅色", C["accent"]), ("成功", C["succ"]),
              ("警告", C["warn"]), ("危险", C["dang"]), ("页面底", C["bg"]), ("文字", C["t1"])]
    lx = PAD
    for nm, col in legend:
        d.ellipse([lx, 152, lx + 16, 168], fill=col)
        t(lx + 22, 155, nm, 10.5, False, "#93A4C4")
        lx += 22 + d.textlength(nm, font=F(10.5)) + 20
    t(IMG_W - PAD, 155, "本稿为结构 + 视觉双确认稿，确认后再改代码", 10.5, False, "#5C6C8A",
      anchor="ra")


def draw_board():
    draw_header()
    for i, (nm, note, fn) in enumerate(PAGES):
        c = i % COLS
        r = i // COLS
        x = PAD + c * (PGW + GAPX)
        y = HEAD_H + r * (PGH + LBL_H + GAPY)
        fn(x, y)
        ly = y + PGH + 8
        t(x + 2, ly, "%02d" % (i + 1), 12, True, C["brand"])
        t(x + 26, ly, nm, 12.5, True, C["t1"])
        t(x + 2, ly + 20, note, 9.5, False, C["t3"])
    fy = IMG_H - 52
    hline(PAD, fy - 14, IMG_W - PAD * 2, C["line"])
    t(PAD, fy, "规范来源 docs/design-system.md（v6） · 校园跑腿 · UI v6", 11, False, C["t3"])
    t(IMG_W - PAD, fy, "共 20 个页面", 11, True, C["t3"], anchor="ra")


draw_board()
board = os.path.join(DOCS, "page-design-v1.png")
img.save(board, quality=95)
print("OK " + board + "  %dx%d" % (IMG_W, IMG_H))

for r in range(ROWS):
    top = HEAD_H + r * (PGH + LBL_H + GAPY) - 26
    bot = top + PGH + LBL_H + 46
    crop = img.crop((0, max(0, top), IMG_W, min(IMG_H, bot)))
    p = os.path.join(DOCS, "page-design-row%d.png" % (r + 1))
    crop.save(p, quality=95)
    print("OK " + p + "  %dx%d" % crop.size)
