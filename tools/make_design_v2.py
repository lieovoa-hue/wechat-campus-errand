# -*- coding: utf-8 -*-
"""校园跑腿小程序 · 本轮改动 UI 设计稿（v2）

产物（运行: python tools/make_design_v2.py）:
  docs/design-v2-cards.png     首页深色任务卡：类型标签 / 倒计时条 / 5 段进度条 / 无单占位
  docs/design-v2-publish.png   发布任务：取快递(取件码必填) vs 其他模板(帮带物品必填)
  docs/design-v2-detail.png    任务详情：雇主视角 / 接单人视角 / 确认取货弹窗 / 举报接单人弹窗

设计口径与 app.wxss 令牌一一对应，颜色/圆角/字号全部取自现有设计系统，保证与线上观感一致。
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
    dk1="#22314F", dk2="#0F172A", dk_tx="#C6D2E6", dk_tx2="#8FA3C0",
)

PGW, PGH = 380, 800
PAD, GAPX = 48, 48
HEAD_H, LBL_H, FOOT_H = 120, 34, 40

img = None
d = None


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


def _i(v):
    return int(round(v))


def t(x, y, s, sz=12, bold=False, color=None, anchor="la"):
    d.text((_i(x), _i(y)), s, font=F(_i(sz), bold), fill=color or C["t1"], anchor=anchor)


def rr(x, y, w, h, r=12, fill=None, outline=None, ow=1):
    d.rounded_rectangle([_i(x), _i(y), _i(x + w), _i(y + h)], radius=_i(r), fill=fill,
                        outline=outline, width=ow)


def bar(x, y, w, h=9, fill=None, r=None):
    if w <= 0:
        return
    d.rounded_rectangle([_i(x), _i(y), _i(x + w), _i(y + h)],
                        radius=_i(r) if r is not None else max(1, _i(h) // 2),
                        fill=fill or C["line"])


def hline(x, y, w, fill=None):
    d.line([(_i(x), _i(y)), (_i(x + w), _i(y))], fill=fill or C["line"], width=1)


def vline(x, y, h, fill=None):
    d.line([(_i(x), _i(y)), (_i(x), _i(y + h))], fill=fill or C["line"], width=1)


def ggrad(x, y, w, h, r, c1, c2, vertical=False):
    x, y, w, h, r = _i(x), _i(y), _i(w), _i(h), _i(r)
    tmp = Image.new("RGB", (w, h), c1)
    td = ImageDraw.Draw(tmp)
    n = h if vertical else w
    for i in range(n):
        col = mix(c1, c2, i / max(1.0, n - 1.0))
        if vertical:
            td.line([(0, i), (w, i)], fill=col)
        else:
            td.line([(i, 0), (i, h)], fill=col)
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
    elif kind == "clock":
        d.ellipse([cx - h * 0.85, cy - h * 0.85, cx + h * 0.85, cy + h * 0.85], outline=col, width=1)
        d.line([(cx, cy - h * 0.45), (cx, cy)], fill=col, width=1)
        d.line([(cx, cy), (cx + h * 0.42, cy + h * 0.2)], fill=col, width=1)
    elif kind == "copy":
        rr(cx - h * 0.8, cy - h * 0.8, h * 1.1, h * 1.1, 2, outline=col, ow=1)
        rr(cx - h * 0.2, cy - h * 0.2, h * 1.0, h * 1.0, 2, outline=col, ow=1)
    elif kind == "phone":
        rr(cx - h * 0.42, cy - h * 0.9, h * 0.84, h * 1.8, 3, outline=col, ow=1)
        dot(cx, cy + h * 0.6, 1.2, col)
    elif kind == "plus":
        d.line([(cx - h * 0.7, cy), (cx + h * 0.7, cy)], fill=col, width=1)
        d.line([(cx, cy - h * 0.7), (cx, cy + h * 0.7)], fill=col, width=1)
    elif kind == "chev":
        d.line([(cx - h * 0.25, cy - h * 0.5), (cx + h * 0.3, cy)], fill=col, width=1)
        d.line([(cx + h * 0.3, cy), (cx - h * 0.25, cy + h * 0.5)], fill=col, width=1)
    elif kind == "back":
        d.line([(cx + h * 0.3, cy - h * 0.6), (cx - h * 0.35, cy)], fill=col, width=2)
        d.line([(cx - h * 0.35, cy), (cx + h * 0.3, cy + h * 0.6)], fill=col, width=2)
    elif kind == "check":
        d.line([(cx - h * 0.5, cy), (cx - h * 0.12, cy + h * 0.42)], fill=col, width=2)
        d.line([(cx - h * 0.12, cy + h * 0.42), (cx + h * 0.55, cy - h * 0.45)], fill=col, width=2)
    elif kind == "lock":
        rr(cx - h * 0.6, cy - h * 0.05, h * 1.2, h * 0.95, 2, outline=col, ow=1)
        d.arc([cx - h * 0.38, cy - h * 0.75, cx + h * 0.38, cy + h * 0.1], start=180, end=360,
              fill=col, width=1)
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
        rr(cx - h * 0.8, cy - h * 0.25, h * 1.6, h * 1.15, 2, outline=col, ow=1)
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
        rr(cx - h * 0.65, cy - h * 0.9, h * 1.3, h * 1.8, 2, outline=col, ow=1)
        for i in range(3):
            d.line([(cx - h * 0.35, cy - h * 0.4 + i * h * 0.42),
                    (cx + h * 0.35, cy - h * 0.4 + i * h * 0.42)], fill=col, width=1)
    elif kind == "cart":
        d.line([(cx - h * 0.9, cy - h * 0.6), (cx - h * 0.55, cy - h * 0.6)], fill=col, width=1)
        d.line([(cx - h * 0.55, cy - h * 0.6), (cx - h * 0.2, cy + h * 0.35)], fill=col, width=1)
        d.line([(cx - h * 0.2, cy + h * 0.35), (cx + h * 0.85, cy + h * 0.35)], fill=col, width=1)
        d.line([(cx - h * 0.6, cy - h * 0.25), (cx + h * 0.75, cy - h * 0.25)], fill=col, width=1)
        dot(cx - h * 0.15, cy + h * 0.72, 1.6, col)
        dot(cx + h * 0.6, cy + h * 0.72, 1.6, col)
    elif kind == "warn":
        d.polygon([(cx, cy - h * 0.9), (cx + h * 0.9, cy + h * 0.75),
                   (cx - h * 0.9, cy + h * 0.75)], outline=col, width=1)
        d.line([(cx, cy - h * 0.2), (cx, cy + h * 0.25)], fill=col, width=1)
        dot(cx, cy + h * 0.5, 1.1, col)


def page(x, y):
    global FRAME_Y
    FRAME_Y = y
    rr(x + 3, y + 7, PGW, PGH, 28, fill="#EDF0F5")
    rr(x, y, PGW, PGH, 28, fill=C["w"], outline=C["line_s"], ow=1)
    t(x + 22, y + 7, "9:41", 10, True, C["t1"])
    for i in range(4):
        hh = 3 + i
        d.rectangle([x + PGW - 74 + i * 5, y + 16 - hh, x + PGW - 71 + i * 5, y + 16], fill=C["t1"])
    rr(x + PGW - 52, y + 8, 16, 9, 3, outline=C["t1"], ow=1)
    d.rectangle([x + PGW - 49, y + 11, x + PGW - 41, y + 15], fill=C["t1"])
    d.rectangle([x + PGW - 34, y + 11, x + PGW - 32, y + 14], fill=C["t1"])
    return y + 26


def nav(x, y, title, back=True, dark=False):
    cy = y + 22
    col = C["w"] if dark else C["t1"]
    if back:
        ico(x + 18, cy - 8, "back", col, 16)
    t(x + PGW / 2, cy - 8, title, 15, True, col, anchor="ma")
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


def field(x, y, w, label, value=None, hint=None, h=42, req=False, ph=None):
    lx = x
    if req:
        t(x, y, "*", 11, True, C["dang"])
        lx = x + 9
    t(lx, y, label, 10.5, False, C["t3"])
    by = y + 15
    rr(x, by, w, h, 10, fill=C["s2"])
    if value:
        t(x + 12, by + (h - 14) / 2, value, 12, False, C["t1"])
    elif ph:
        t(x + 12, by + (h - 14) / 2, ph, 11, False, C["t4"])
    else:
        bar(x + 12, by + h / 2 - 4, min(120, w * 0.42), 8, "#DCE1EA")
    if hint:
        t(x + w - 10, by + (h - 12) / 2, hint, 9.5, False, C["t3"], anchor="ra")
    return by + h + 12


def btn(x, y, w, h, text, kind="primary", sz=13, disabled=False):
    if disabled:
        rr(x, y, w, h, 10, fill=C["s2"])
        t(x + w / 2, y + (h - sz * 1.35) / 2, text, sz, True, C["t4"], anchor="ma")
        return
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


def pill(x, y, text, fg, bg, sz=10, pad=9, h=20, outline=None):
    w = d.textlength(text, font=F(sz, True)) + pad * 2
    rr(x, y, w, h, h / 2.0, fill=bg, outline=outline, ow=1 if outline else 0)
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


def ava(cx, cy, s, fill=None, ring=None):
    if ring:
        d.ellipse([_i(cx - s / 2.0 - 2), _i(cy - s / 2.0 - 2), _i(cx + s / 2.0 + 2), _i(cy + s / 2.0 + 2)],
                  fill=ring)
    d.ellipse([_i(cx - s / 2.0), _i(cy - s / 2.0), _i(cx + s / 2.0), _i(cy + s / 2.0)],
              fill=fill or C["brand_100"])
    ico(cx - s * 0.22, cy - s * 0.22, "user", "#FFFFFF", s * 0.44)


# =====================================================================
# 本轮新增组件（与 WXSS 实现一一对应）
# =====================================================================

STEPS = ["已接单", "已取货", "已送达", "待支付", "完成"]

# 倒计时条配色：待接单=蓝灰（未计时）/ 剩余>50% 绿 / 20~50% 橙 / <20% 红 / 超时 亮红
CD_COLORS = {"pending": "#41608F", "safe": "#0E9F6E", "warn": "#D97706",
             "hurry": "#E02424", "over": "#B91C1C"}
CD_TEXT = {"pending": "#8FA3C0", "safe": "#34D399", "warn": "#FBBF24",
           "hurry": "#F87171", "over": "#F87171"}


def cd_level(ratio, overtime=False, pending=False):
    if pending:
        return "pending"
    if overtime or ratio <= 0:
        return "over"
    if ratio > 0.5:
        return "safe"
    if ratio > 0.2:
        return "warn"
    return "hurry"


def countdown_bar(x, y, w, ratio, text, dark=False, overtime=False, pending=False, h=8, sz=10):
    """倒计时条：满格慢慢变空 + 右侧剩余时间 + 按剩余比例换色。返回占用高度。
    待接单（pending）时显示满格蓝灰 + 「接单后开始计时」，保证卡片高度不跳。"""
    lv = cd_level(ratio, overtime, pending)
    col = CD_COLORS[lv]
    tcol = CD_TEXT[lv] if dark else col
    track = "#2C3B57" if dark else C["line"]
    tw = d.textlength(text, font=F(sz, True))
    bw = w - tw - 10
    rr(x, y, bw, h, h / 2.0, fill=track)
    fw = bw if pending else max(h, bw * max(0.04, ratio))
    rr(x, y, fw, h, h / 2.0, fill=col)
    t(x + w, y + (h - sz * 1.3) / 2.0, text, sz, True, tcol, anchor="ra")
    return h


def stepper(x, y, w, step, dark=False, ava_size=20):
    """5 段进度：①已接单（挂接单人头像 + 「已接单」小标）②已取货 ③已送达 ④待支付 ⑤完成
    step: 0=还没人接单，1~5=走到第几段。返回占用高度。"""
    n = 5
    pad = ava_size / 2.0
    cw = (w - 2 * pad) / (n - 1.0)
    node_y = y + 16 if step >= 1 else y + 6
    lx0 = x + pad
    done_col = "#6E96F5" if dark else C["brand"]
    line_col = "#3A4A68" if dark else C["line_s"]
    for i in range(n - 1):
        x1 = lx0 + cw * i + 9
        x2 = lx0 + cw * (i + 1) - 9
        d.line([(_i(x1), _i(node_y)), (_i(x2), _i(node_y))],
               fill=done_col if (i + 1) < step else line_col, width=2)
    for i in range(n):
        cx = lx0 + cw * i
        idx = i + 1
        done = idx <= step
        cur = idx == step
        if i == 0 and step >= 1:
            ava(cx, node_y, ava_size, C["brand"], ring="#6E96F5" if dark else C["brand"])
            pw = d.textlength("已接单", font=F(8, True)) + 10
            pill(cx - pw / 2.0, node_y - 27, "已接单", C["w"], "#3E63D8", 8, 5, 13)
        else:
            r = 7
            if done:
                dot(cx, node_y, r, done_col)
                ico(cx - 4.5, node_y - 4.5, "check", C["w"] if dark else C["w"], 9)
            else:
                dot(cx, node_y, r - 1, "#243049" if dark else C["w"])
                d.ellipse([_i(cx - r), _i(node_y - r), _i(cx + r), _i(node_y + r)],
                          outline=line_col, width=2)
            if cur:
                d.ellipse([_i(cx - 11), _i(node_y - 11), _i(cx + 11), _i(node_y + 11)],
                          outline=done_col, width=2)
        lcol = (C["w"] if dark else C["t1"]) if done else (C["dk_tx2"] if dark else C["t4"])
        t(cx, node_y + 13, STEPS[i], 9.5, done, lcol, anchor="ma")
    return (node_y - y) + 30


def deck_card(x, y, w, role, tpl, status_text, money, addr, countdown=None, step=0, order_no=""):
    """首页深色堆叠卡：类型标签 + 倒计时条 + 5 段进度（①挂接单人头像）。返回卡片实际高度。"""
    pad = 14
    h = pad + 22 + 8 + 20 + 6 + 20 + 8 + 46 + 8 + 14 + pad
    rr(x + 3, y + 6, w, h, 18, fill="#EDF0F5")
    ggrad(x, y, w, h, 18, C["dk1"], C["dk2"], vertical=True)
    # 右上角品牌蓝光（与 WXSS 的 radial-gradient 一致）：只影响右上区域
    glow = Image.new("RGB", (_i(w * 0.62), _i(h * 0.72)), C["dk1"])
    gd = ImageDraw.Draw(glow)
    gw, gh = _i(w * 0.62), _i(h * 0.72)
    for i in range(gh):
        gd.line([(0, i), (gw, i)], fill=mix("#3E63A8", C["dk1"], i / max(1.0, gh - 1.0)))
    m = Image.new("L", (gw, gh), 0)
    md = ImageDraw.Draw(m)
    for i in range(gh):
        md.line([(0, i), (gw, i)], fill=int(150 * (1 - i / max(1.0, gh - 1.0))))
    img.paste(glow, (_i(x + w - gw), _i(y)), m)
    cy = y + pad
    px = x + pad
    px += pill(px, cy + 1, role, "#FFFFFF", "#2B3E63", 9, 8, 18) + 6
    px += pill(px, cy + 1, tpl, C["dk_tx"], "#2B3E63", 9, 8, 18) + 6
    st_c = {"待接单": ("#CFE0FF", "#2B3E63"), "进行中": ("#CFE0FF", "#2B3E63"),
            "待雇主确认": ("#FDE3BF", "#4A3418"), "已超时": ("#FFD5D5", "#5A1F1F")}
    fg, bg = st_c.get(status_text, ("#CFE0FF", "#2B3E63"))
    pill(px, cy + 1, status_text, fg, bg, 9, 8, 18)
    t(x + w - pad, cy, "酬金", 9, False, C["dk_tx2"], anchor="ra")
    t(x + w - pad, cy + 10, "¥" + money, 17, True, C["w"], anchor="ra")
    cy += 30
    dot(x + pad + 3, cy + 7, 3, "#7AA2FF")
    t(x + pad + 12, cy, addr, 13.5, True, C["w"])
    cy += 20 + 6
    if countdown is not None:
        ratio, text = countdown[0], countdown[1]
        pending = len(countdown) > 2 and countdown[2] == "pending"
        overtime = len(countdown) > 2 and countdown[2] == "over"
        countdown_bar(x + pad, cy, w - pad * 2, ratio if ratio is not None else 1.0, text,
                      dark=True, pending=pending, overtime=overtime)
    cy += 20 + 8
    cy += stepper(x + pad, cy, w - pad * 2, step, dark=True)
    cy += 8
    t(x + pad, cy, "订单号 " + order_no, 8.5, False, C["dk_tx2"])
    t(x + w - pad, cy, ("进度 %d/5 · %s" % (step, STEPS[step - 1])) if step else "等待接单",
      8.5, False, C["dk_tx2"], anchor="ra")
    return h


def list_card(x, y, w, addr, tpl, status_text, sfg, sbg, money=0.80, limit="1小时",
              who="王小明 学号 2023001", accent=None):
    """大厅 / 我的发布 的浅色任务卡：新增类型标签（①②③ 三处入口共用同一个组件）"""
    h = 108
    rr(x, y, w, h, 14, fill=C["w"], outline=C["line"])
    rr(x + 13, y + 16, 5, h - 32, 3, fill=accent or C["brand"])
    t(x + 28, y + 12, addr, 13, True, C["t1"])
    dw = d.textlength(addr, font=F(13, True))
    tag(x + 30 + dw, y + 12, tpl, C["t3"], C["s2"])
    t(x + w - 16, y + 10, "跑腿费", 9, True, C["accent_tx"], anchor="ra")
    t(x + w - 16, y + 20, "%.2f" % money, 18, True, C["accent_tx"], anchor="ra")
    my = y + 42
    rr(x + 28, my, w - 44, 24, 6, fill=C["s2"])
    t(x + 38, my + 6, "送达地址", 9, False, C["t3"])
    t(x + w - 38, my + 6, "限时 " + limit, 9, False, C["t2"], anchor="ra")
    py = y + 74
    hline(x + 28, py, w - 44)
    ava(x + 41, py + 17, 22, C["brand_100"])
    t(x + 56, py + 11, who, 10, False, C["t2"])
    pill_r(x + w - 16, py + 9, status_text, sfg, sbg, 9, 7, 17)
    return y + h + 12


# =====================================================================
# 设计稿 1：首页深色任务卡
# =====================================================================

def deck_page(x, y, card_args, tip=""):
    y = page(x, y)
    y = nav(x, y, "任务大厅", back=False)
    rr(x + 14, y + 4, PGW - 28, 34, 10, fill=C["s2"])
    ico(x + 26, y + 12, "search", C["t4"], 18)
    t(x + 50, y + 13, "搜索送达地址 / 备注", 10.5, False, C["t4"])
    y2 = y + 46
    ch = deck_card(x + 14, y2, PGW - 28, **card_args)
    gy = y2 + ch + 10
    t(x + PGW / 2, gy, "↓点击选择要发布的任务↓", 9, False, C["t4"], anchor="ma")
    qt = [("box", "取快递"), ("bowl", "食堂带饭"), ("doc", "打印资料"),
          ("cart", "超市代买"), ("plus", "自定义发布")]
    qw = (PGW - 28 - 4 * 8) / 5.0
    for i, (kd, nm) in enumerate(qt):
        qx = x + 14 + i * (qw + 8)
        rr(qx, gy + 14, qw, 56, 12, fill=C["w"], outline=C["line"])
        ico(qx + qw / 2 - 9, gy + 26, kd, C["brand"], 18)
        t(qx + qw / 2, gy + 50, nm, 7.5, False, C["t2"], anchor="ma")
    if tip:
        t(x + 14, gy + 78, tip, 9, False, C["t3"])
    tabbar(x, 0)
    return y


def sheet_cards(path):
    global img, d
    n = 3
    W = PAD * 2 + n * PGW + (n - 1) * GAPX
    ZOOM_H = 664
    H = HEAD_H + LBL_H + PGH + ZOOM_H + FOOT_H
    img = Image.new("RGB", (W, H), "#FFFFFF")
    d = ImageDraw.Draw(img)
    t(PAD, 34, "本轮 UI 设计稿 ①   首页深色任务卡", 26, True, C["t1"])
    t(PAD, 74, "新增：任务类型标签 · 限时倒计时条（满格→空，按剩余换色）· 5 段进度条（第①段挂接单人头像并标「已接单」）· 无单占位",
      12.5, False, C["t2"])
    cv = [
        dict(role="我是雇主", tpl="取快递", status_text="待接单", money="0.80",
             addr="一号楼A301门口", countdown=(None, "接单后开始计时", "pending"), step=0,
             order_no="GCPT000012"),
        dict(role="我是跑腿员", tpl="食堂带饭", status_text="进行中", money="1.00",
             addr="一号楼A301门口", countdown=(0.62, "剩余 41:28"), step=1,
             order_no="GCPT000012"),
        dict(role="我是雇主", tpl="取快递", status_text="已超时", money="0.80",
             addr="一号楼A301门口", countdown=(0.0, "已超时 12 分钟", "over"), step=2,
             order_no="GCPT000012"),
    ]
    labels = ["① 待接单：限时单显示满格蓝灰「接单后开始计时」（高度不跳）",
              "② 进行中·未取货：倒计时绿 + 进度 1/5（头像挂「已接单」）",
              "③ 已超时：倒计时归零转亮红，任务不取消、可继续走到完成"]
    for i, ca in enumerate(cv):
        x = PAD + i * (PGW + GAPX)
        t(x, HEAD_H - 6, labels[i], 11.5, True, C["t3"])
        deck_page(x, HEAD_H + LBL_H - 10, ca)
    # ---------------- 放大区 ----------------
    zy = HEAD_H + LBL_H + PGH + 16
    bw4 = (W - PAD * 2 - 3 * 24) / 4.0
    t(PAD, zy, "倒计时条配色（待接单 蓝灰 / 剩余>50% 绿 / 20~50% 橙 / <20% 红 / 超时 亮红）", 13, True, C["t1"])
    zy += 26
    for i, (r, tx, mode) in enumerate([(None, "接单后开始计时", "pending"), (0.86, "剩余 52:00", ""),
                                       (0.34, "剩余 20:24", ""), (0.0, "已超时 12 分钟", "over")]):
        bx = PAD + i * (bw4 + 24)
        rr(bx, zy, bw4, 56, 14, fill=C["dk2"])
        countdown_bar(bx + 14, zy + 14, bw4 - 28, 1.0 if r is None else r, tx, dark=True,
                      pending=mode == "pending", overtime=mode == "over")
        t(bx + 14, zy + 32, cd_level(0 if r is None else r, mode == "over", mode == "pending"),
          9, False, C["dk_tx2"])
    zy += 82
    bw5 = (W - PAD * 2 - 4 * 18) / 5.0
    t(PAD, zy, "5 段进度条（①已接单 ②已取货 ③已送达 ④待支付 ⑤完成）：最上面一行是接单人头像 + 「已接单」小标", 13, True, C["t1"])
    zy += 26
    for i, s in enumerate(range(1, 6)):
        bx = PAD + i * (bw5 + 18)
        rr(bx, zy, bw5, 86, 14, fill=C["dk2"])
        stepper(bx + 22, zy + 14, bw5 - 44, s, dark=True, ava_size=18)
        t(bx + 14, zy + 68, "进度 %d/5 · %s" % (s, STEPS[s - 1]), 9, False, C["dk_tx2"])
    zy += 112
    t(PAD, zy, "浅色列表卡（任务大厅 / 我的发布 / 我的任务 共用）：新增任务类型标签", 13, True, C["t1"])
    zy += 24
    lw = (W - PAD * 2 - 2 * 24) / 3.0
    for i, (tp, st, sf, sb) in enumerate([("取快递", "待接单", C["brand"], C["brand_50"]),
                                          ("食堂带饭", "进行中", C["succ_tx"], C["succ_50"]),
                                          ("其他任务", "已完成", C["t3"], C["s2"])]):
        list_card(PAD + i * (lw + 24), zy, lw, "一号楼A301门口", tp, st, sf, sb)
    t(PAD, H - 30, "校园跑腿 · 设计稿 v2 · 颜色 / 圆角 / 字号全部取自 app.wxss 令牌", 10.5, False, C["t4"])
    img.save(path, "PNG")
    return path


# =====================================================================
# 设计稿 2：发布任务（取件码 / 帮带物品 随模板切换）
# =====================================================================

def publish_page(x, y, active, field_spec, hint):
    y = page(x, y)
    y = nav(x, y, "发布任务")
    # 快捷模板
    rr(x + 14, y + 2, PGW - 28, 96, 14, fill=C["w"], outline=C["line"])
    t(x + 28, y + 14, "快捷模板", 12, True, C["t1"])
    t(x + PGW - 28, y + 15, "点一下自动填好", 9, False, C["t4"], anchor="ra")
    tpls = [("box", "取快递"), ("bowl", "食堂带饭"), ("doc", "打印资料"), ("cart", "超市代买")]
    tw = (PGW - 56 - 3 * 8) / 4.0
    for i, (kd, nm) in enumerate(tpls):
        tx = x + 28 + i * (tw + 8)
        on = nm == active
        rr(tx, y + 34, tw, 52, 10, fill=C["brand_50"] if on else C["w"],
           outline=C["brand"] if on else C["line_s"])
        ico(tx + tw / 2 - 8, y + 40, kd, C["brand"] if on else C["t3"], 16)
        t(tx + tw / 2, y + 62, nm, 8.5, on, C["brand"] if on else C["t2"], anchor="ma")
    y2 = y + 108
    # 任务信息
    rr(x + 14, y2, PGW - 28, 300, 14, fill=C["w"], outline=C["line"])
    t(x + 28, y2 + 14, "任务信息", 12, True, C["t1"])
    t(x + PGW - 28, y2 + 15, "带 * 为必填", 9, False, C["t4"], anchor="ra")
    fy = y2 + 40
    fw = PGW - 56
    fy = field(x + 28, fy, fw, "收件人", value="王小明", req=True)
    fy = field(x + 28, fy, fw, "手机号", value="13455559999", req=True)
    # 随模板切换的两项
    t(x + 28, fy - 4, hint, 9, False, C["brand"])
    fy += 14
    for i, (lb, val, reqd, ph) in enumerate(field_spec):
        fy = field(x + 28, fy, fw, lb, value=val, ph=ph, req=reqd)
    y3 = y2 + 312
    rr(x + 14, y3, PGW - 28, 92, 14, fill=C["w"], outline=C["line"])
    t(x + 28, y3 + 72, "（详细地址 / 酬金 / 限时 / 备注 / 相关图片 / 费用与规则 与现状一致，本次不改）", 9, False, C["t4"])
    t(x + 28, y3 + 14, "送达地址", 10.5, False, C["t3"])
    rr(x + 28, y3 + 30, fw, 34, 10, fill=C["s2"])
    t(x + 40, y3 + 39, "X栋X楼AXXX/BXXX", 11.5, False, C["t1"])
    rr(x + 14, FRAME_Y + PGH - 96, PGW - 28, 44, 12, fill=C["brand_50"])
    t(x + 28, FRAME_Y + PGH - 84, "平台服务费 ¥0.10", 11, True, C["brand"])
    t(x + PGW - 28, FRAME_Y + PGH - 84, "支付 ¥0.10 并发布", 11, True, C["brand"], anchor="ra")
    return y


def sheet_publish(path):
    global img, d
    n = 2
    W = PAD * 2 + n * PGW + (n - 1) * GAPX
    H = HEAD_H + LBL_H + PGH + 250 + FOOT_H
    img = Image.new("RGB", (W, H), "#FFFFFF")
    d = ImageDraw.Draw(img)
    t(PAD, 34, "本轮 UI 设计稿 ②   发布任务：取件码 / 帮带物品", 26, True, C["t1"])
    t(PAD, 74, "两个字段位置固定（不跳版）：取快递 = 取件码必填 + 帮带物品选填；其他模板 = 帮带物品必填 + 取件码选填；自定义 = 都可选填",
      12.5, False, C["t2"])
    spec_a = [("取件码", "6-8-1234", True, None), ("帮带物品", None, False, "选填，如：一个中通快递（小件）")]
    spec_b = [("帮带物品", "一份黄焖鸡米饭，不要香菜", True, None), ("取件码", None, False, "选填，如打印店取货码")]
    publish_page(PAD, HEAD_H + LBL_H - 10, "取快递", spec_a, "当前模板「取快递」：跑腿员凭取件码取件，请填写")
    publish_page(PAD + PGW + GAPX, HEAD_H + LBL_H - 10, "食堂带饭", spec_b, "当前模板「食堂带饭」：请写清要帮带的物品")
    zy = HEAD_H + LBL_H + PGH + 10
    t(PAD, zy, "必填标识的规则（与后端校验口径一致）", 13, True, C["t1"])
    rows = [("取快递", "取件码 * 必填", "帮带物品 选填", C["brand"]),
            ("食堂带饭 / 打印资料 / 超市代买", "帮带物品 * 必填", "取件码 选填", C["succ_tx"]),
            ("自定义发布", "两项都选填", "—", C["t3"])]
    ry = zy + 26
    for i, (k, a, b, col) in enumerate(rows):
        rr(PAD, ry + i * 46, W - PAD * 2, 38, 10, fill=C["s2"])
        t(PAD + 14, ry + i * 46 + 11, k, 11.5, True, C["t1"])
        pill(PAD + 320, ry + i * 46 + 9, a, C["w"], col, 9.5, 9, 19)
        t(PAD + 500, ry + i * 46 + 12, b, 11, False, C["t2"])
    t(PAD, H - 30, "校园跑腿 · 设计稿 v2 · 字段顺序固定，模板切换只改标签/星号/placeholder，不会跳版", 10.5, False, C["t4"])
    img.save(path, "PNG")
    return path


# =====================================================================
# 设计稿 3：任务详情（雇主 / 接单人 / 弹窗）
# =====================================================================

def detail_info_card(x, y, w, addr, tpl, status, money, limit, order_no, prog):
    h = 118
    rr(x, y, w, h, 14, fill=C["w"], outline=C["line"])
    t(x + 16, y + 14, addr, 14, True, C["t1"])
    dw = d.textlength(addr, font=F(14, True))
    tag(x + 20 + dw, y + 14, tpl, C["t3"], C["s2"])
    pill_r(x + w - 16, y + 13, status, C["brand"], C["brand_50"], 9, 7, 17)
    rr(x + 16, y + 40, w - 32, 42, 10, fill=C["s2"])
    t(x + 28, y + 47, "任务酬金", 9, False, C["t3"])
    t(x + 28, y + 58, "¥" + money, 15, True, C["accent_tx"])
    vline(x + w / 2, y + 48, 26, C["line_s"])
    t(x + w / 2 + 12, y + 47, "限时要求", 9, False, C["t3"])
    t(x + w / 2 + 12, y + 58, limit, 15, True, C["t1"])
    t(x + 16, y + 92, "订单号 " + order_no, 9.5, False, C["t3"])
    t(x + w - 16, y + 92, "进度 %d/5 · %s" % (prog, STEPS[prog - 1]) if prog else "等待接单",
      9.5, True, C["brand"], anchor="ra")
    return y + h + 12


def detail_progress_card(x, y, w, prog, timeline, dark=False):
    h = 124
    rr(x, y, w, h, 14, fill=C["w"], outline=C["line"])
    t(x + 16, y + 12, "任务进度", 12, True, C["t1"])
    t(x + w - 16, y + 13, ("第 %d / 5 步 · %s" % (prog, STEPS[prog - 1])) if prog else "等待接单",
      9.5, True, C["brand"], anchor="ra")
    stepper(x + 34, y + 48, w - 68, prog, ava_size=26)
    t(x + 16, y + h - 18, timeline, 9, False, C["t3"])
    return y + h + 12


def detail_person_card(x, y, w, role, name, phone, uid, sid, badge="已认证"):
    h = 112
    rr(x, y, w, h, 14, fill=C["w"], outline=C["line"])
    t(x + 16, y + 12, "相关人员", 12, True, C["t1"])
    yy = y + 30
    for i, (rl, nm, ph, uid2, sid2) in enumerate([(role[0], name[0], phone[0], uid[0], sid[0]),
                                                 (role[1], name[1], phone[1], uid[1], sid[1])]):
        cy = yy + i * 34
        ava(x + 30, cy + 12, 24, C["brand"] if i == 0 else C["accent"])
        t(x + 48, cy + 3, rl + "  " + nm, 10.5, True, C["t1"])
        t(x + 48 + d.textlength(rl + "  " + nm, font=F(10.5, True)) + 8, cy + 4, badge, 8.5,
          False, C["succ_tx"])
        t(x + 48, cy + 17, "电话 " + ph + "   ID " + uid2 + "   学号 " + sid2, 9, False, C["t3"])
        rr(x + w - 60, cy + 2, 46, 20, 10, fill=C["brand_50"])
        ico(x + w - 52, cy + 5, "phone", C["brand"], 14)
        t(x + w - 34, cy + 5, "拨打", 9, True, C["brand"])
    return y + h + 12


def detail_action_card(x, y, w, title, lines, buttons):
    h = 30 + len(lines) * 17 + (34 if buttons[0] else 0) + (34 if buttons[1] else 0) + 14
    rr(x, y, w, h, 14, fill=C["w"], outline=C["line"])
    t(x + 16, y + 12, title, 12, True, C["t1"])
    ly = y + 34
    for ln in lines:
        t(x + 16, ly, ln, 10, False, C["t3"])
        ly += 17
    by = ly + 4
    for row in buttons:
        if not row:
            continue
        bw = (w - 32 - 10 * (len(row) - 1)) / len(row)
        for i, (txt, kind, dis) in enumerate(row):
            btn(x + 16 + i * (bw + 10), by, bw, 30, txt, kind, 11.5, dis)
        by += 34
    return y + h + 12


def dialog(x, y, w, title, body_lines, ok_text, cancel_text="取消", ok_kind="primary"):
    h = 150
    rr(x, y, w, h, 16, fill=C["w"], outline=C["line_s"])
    t(x + w / 2, y + 20, title, 13.5, True, C["t1"], anchor="ma")
    ly = y + 48
    for i, ln in enumerate(body_lines):
        t(x + w / 2, ly + i * 17, ln, 10, False, C["t3"], anchor="ma")
    bw = (w - 48) / 2.0
    btn(x + 16, y + h - 46, bw, 32, cancel_text, "ghost", 12)
    btn(x + 16 + bw + 16, y + h - 46, bw, 32, ok_text, ok_kind, 12)
    return y + h


def thumbs(x, y, w, filled=1, locked=False, n=3):
    sw = (w - (n - 1) * 8) / n
    for i in range(n):
        sx = x + i * (sw + 8)
        rr(sx, y, sw, 62, 10, fill=C["s2"])
        if i < filled:
            rr(sx + 3, y + 3, sw - 6, 56, 8, fill="#C9D2E0")
            d.line([(_i(sx + 3), _i(y + 59)), (_i(sx + sw - 3), _i(y + 3))], fill="#AEBACD", width=1)
            t(sx + sw / 2, y + 26, "物品照片", 8, False, "#5C6B80", anchor="ma")
            if locked:
                dot(sx + sw - 12, y + 12, 8, C["t1"])
                ico(sx + sw - 17, y + 7, "lock", C["w"], 10)
        else:
            ico(sx + sw / 2 - 8, y + 20, "plus", C["t4"], 16)
    return 62


def taker_action_card(x, y, w, picked):
    h = 290 if picked else 200
    rr(x, y, w, h, 14, fill=C["w"], outline=C["line"])
    t(x + 16, y + 12, "接单操作", 12, True, C["t1"])
    cy = y + 34
    if not picked:
        t(x + 16, cy, "第 1 步：上传物品照片（至少1张，最多3张），证明你已拿到 / 买到物品。", 9.5, False, C["t3"])
        cy += 18
        thumbs(x + 16, cy, w - 32, filled=1)
        cy += 70
        btn(x + 16, cy, w - 32, 34, "确认取货", "primary", 13)
        cy += 40
        t(x + 16, cy, "上传物品照片后可确认取货；确认后照片与按钮将被锁定。", 9, False, C["t4"])
    else:
        t(x + 16, cy, "第 1 步：物品照片（已锁定）", 9.5, True, C["t3"])
        cy += 18
        thumbs(x + 16, cy, w - 32, filled=2, locked=True)
        cy += 70
        rr(x + 16, cy, w - 32, 26, 8, fill=C["succ_50"])
        ico(x + 26, cy + 6, "lock", C["succ_tx"], 13)
        t(x + 44, cy + 7, "已于 10:35 确认取货，照片已锁定不可修改", 9.5, True, C["succ_tx"])
        cy += 34
        t(x + 16, cy, "第 2 步：上传送达照片（至少1张，最多3张），证明已送达指定地址。", 9.5, False, C["t3"])
        cy += 18
        thumbs(x + 16, cy, w - 32, filled=0)
        cy += 70
        btn(x + 16, cy, (w - 32) / 2.0 - 5, 32, "提交已送达", "primary", 12)
        btn(x + 16 + (w - 32) / 2.0 + 5, cy, (w - 32) / 2.0 - 5, 32, "已确认取货", "ghost", 12)
    return y + h + 12


def detail_photo_card(x, y, w):
    h = 122
    rr(x, y, w, h, 14, fill=C["w"], outline=C["line"])
    t(x + 16, y + 12, "物品照片", 12, True, C["t1"])
    t(x + w - 16, y + 13, "接单人拿到 / 买到物品时拍摄", 9, False, C["t4"], anchor="ra")
    thumbs(x + 16, y + 34, w - 32, filled=2)
    return y + h + 12


def detail_owner_page(x, y, prog):
    y = page(x, y)
    y = nav(x, y, "任务详情")
    y = detail_info_card(x + 14, y + 2, PGW - 28, "一号楼A301门口", "取快递", "待雇主确认",
                         "0.80", "1小时", "GCPT000012", prog)
    y = detail_progress_card(x + 14, y, PGW - 28, prog,
                             "已接单 10:28 · 已取货 10:35 · 已送达 11:02")
    y = detail_person_card(x + 14, y, PGW - 28,
                           ("发布者", "接单者"), ("陈小雨", "王小明"),
                           ("13800001111", "13455559999"),
                           ("X0001", "X7798"), ("2023001", "2023118"))
    y = detail_photo_card(x + 14, y, PGW - 28)
    detail_action_card(x + 14, y, PGW - 28, "雇主操作",
                       ["跑腿员已提交送达照片，请核对后确认收货。",
                        "确认收货后进入「待支付」，请线下把酬金转给跑腿员，再点完成任务。"],
                       [[("确认收货", "primary", False), ("未送达", "danger", False)],
                        [("举报接单人", "danger", False), ("编辑任务", "ghost", False)]])
    return y


def detail_taker_page(x, y, picked):
    y = page(x, y)
    y = nav(x, y, "任务详情")
    y = detail_info_card(x + 14, y + 2, PGW - 28, "一号楼A301门口", "取快递",
                         "进行中" if not picked else "进行中", "0.80", "1小时", "GCPT000012",
                         1 if not picked else 2)
    y = detail_progress_card(x + 14, y, PGW - 28, 1 if not picked else 2,
                             "已接单 10:28" if not picked else "已接单 10:28 · 已取货 10:35")
    if not picked:
        y = detail_person_card(x + 14, y, PGW - 28, ("发布者", "接单者"),
                               ("陈小雨", "王小明"), ("13800001111", "13455559999"),
                               ("X0001", "X7798"), ("2023001", "2023118"))
    taker_action_card(x + 14, y, PGW - 28, picked)
    return y


def sheet_detail(path):
    global img, d
    n = 2
    W = PAD * 2 + n * PGW + (n - 1) * GAPX
    ZOOM_H = 470
    H = HEAD_H + LBL_H + PGH + ZOOM_H + FOOT_H
    img = Image.new("RGB", (W, H), "#FFFFFF")
    d = ImageDraw.Draw(img)
    t(PAD, 34, "本轮 UI 设计稿 ③   任务详情：进度 / 联系人 / 确认取货 / 举报", 26, True, C["t1"])
    t(PAD, 74, "5 段进度（①挂接单人头像 + 「已接单」小标）· 双方姓名与电话 · 接单人「确认取货」3 秒弹窗 · 雇主「举报接单人」",
      12.5, False, C["t2"])
    t(PAD, HEAD_H - 6, "雇主视角：进度 3/5 已送达（确认收货 → 待支付 → 完成任务）", 11.5, True, C["t3"])
    t(PAD + PGW + GAPX, HEAD_H - 6, "接单人视角：进度 1/5 已接单（上传物品照片 → 确认取货）", 11.5, True, C["t3"])
    detail_owner_page(PAD, HEAD_H + LBL_H - 10, 3)
    detail_taker_page(PAD + PGW + GAPX, HEAD_H + LBL_H - 10, False)
    # ---- 放大区：已取货锁定态 + 两个弹窗
    zy = HEAD_H + LBL_H + PGH + 16
    pw = (W - PAD * 2 - 2 * 28) / 3.0
    t(PAD, zy, "接单人视角：已确认取货（照片锁定）", 13, True, C["t1"])
    t(PAD + pw + 28, zy, "确认取货弹窗（确定键 3 秒倒计时）", 13, True, C["t1"])
    t(PAD + (pw + 28) * 2, zy, "雇主：举报接单人", 13, True, C["t1"])
    py = zy + 26
    rr(PAD, py, pw, 428, 16, fill=C["bg"], outline=C["line"])
    taker_action_card(PAD + 14, py + 14, pw - 28, True)
    t(PAD + 14, py + 316, "已确认取货后：", 10.5, True, C["t1"])
    for i, ln in enumerate(["· 物品照片 + 按钮锁定，不能再改", "· 「取消接单」入口消失",
                            "· 雇主侧「撤销任务」消失，只留编辑", "· 进度条点亮第 2 段「已取货」"]):
        t(PAD + 14, py + 338 + i * 16, ln, 9.5, False, C["t3"])
    dx = PAD + pw + 28
    rr(dx, py, pw, 428, 16, fill=C["bg"], outline=C["line"])
    dialog(dx + 14, py + 40, pw - 28, "确认已取货？",
           ["确认后物品照片将被锁定、不能再修改。", "如果还没真正拿到物品，请先不要确认。"],
           "确定 (2)")
    t(dx + 14, py + 220, "「确定」3 秒倒计时结束后才可点（防止误触）；", 9.5, False, C["t3"])
    t(dx + 14, py + 238, "「取消」随时可点，弹窗不会自动确认。", 9.5, False, C["t3"])
    t(dx + 14, py + 268, "为什么必须二次确认：", 10.5, True, C["t1"])
    for i, ln in enumerate(["· 一旦确认，照片就作为「已拿到物品」的凭证",
                            "· 同时关闭撤销/取消接单，双方都不能反悔",
                            "· 后端写入 pickup_confirm_time，可追溯"]):
        t(dx + 14, py + 290 + i * 16, ln, 9.5, False, C["t3"])
    rx = PAD + (pw + 28) * 2
    rr(rx, py, pw, 428, 16, fill=C["bg"], outline=C["line"])
    rr(rx + 14, py + 16, pw - 28, 366, 16, fill=C["w"], outline=C["line_s"])
    t(rx + pw / 2, py + 34, "举报接单人", 13.5, True, C["t1"], anchor="ma")
    t(rx + pw / 2, py + 56, "请选择举报原因（可多选），并补充说明", 9.5, False, C["t3"], anchor="ma")
    tags = ["物品损坏", "态度恶劣", "私自加价", "虚假送达", "擅自取消", "其他"]
    tw3 = (pw - 48 - 12) / 3.0
    for i, tg in enumerate(tags):
        tx2 = rx + 24 + (i % 3) * (tw3 + 6)
        ty2 = py + 78 + (i // 3) * 28
        on = i < 2
        rr(tx2, ty2, tw3, 23, 11.5, fill=C["brand_50"] if on else C["w"],
           outline=C["brand"] if on else C["line_s"])
        t(tx2 + tw3 / 2, ty2 + 5, tg, 10, on, C["brand"] if on else C["t2"], anchor="ma")
    rr(rx + 24, py + 146, pw - 48, 66, 10, fill=C["w"], outline=C["line_s"])
    t(rx + 36, py + 154, "补充说明（必填，不少于5个字）", 9, False, C["t4"])
    rr(rx + 24, py + 224, pw - 48, 26, 10, fill=C["s2"])
    t(rx + 36, py + 230, "订单号 GCPT000012 · 举报直达管理员后台", 9, False, C["t3"])
    btn(rx + 24, py + 306, (pw - 60) / 2.0, 32, "取消", "ghost", 12)
    btn(rx + 24 + (pw - 60) / 2.0 + 12, py + 306, (pw - 60) / 2.0, 32, "提交举报", "primary", 12)
    t(rx + 14, py + 396, "雇主 + 任务已有人接单 + 进行中/待确认/超时取消 才显示入口；", 9, False, C["t4"])
    t(rx + 14, py + 410, "每条任务每人 30 分钟最多 3 次（沿用现有后端硬校验）。", 9, False, C["t4"])
    t(PAD, H - 30, "校园跑腿 · 设计稿 v2 · 与 app.wxss 令牌一致；弹窗沿用现有自绘 confirmDialog 组件", 10.5, False, C["t4"])
    img.save(path, "PNG")
    return path


if __name__ == "__main__":
    print(sheet_cards(os.path.join(DOCS, "design-v2-cards.png")))
    print(sheet_publish(os.path.join(DOCS, "design-v2-publish.png")))
    print(sheet_detail(os.path.join(DOCS, "design-v2-detail.png")))
