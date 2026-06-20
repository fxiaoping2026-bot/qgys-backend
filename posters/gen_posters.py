#!/usr/bin/env /usr/bin/python3
# -*- coding: utf-8 -*-
"""
企港渔叔 - 扫码点餐海报生成脚本（修正版）
生成3款不同样式的点餐海报 PNG（750x1200px）
"""

from PIL import Image, ImageDraw, ImageFont
import os

OUT_DIR = "/Users/admin/WorkBuddy/2026-06-16-08-21-40/seafood-order/posters"
QR_PATH = OUT_DIR + "/qrcode.png"
FONT_PATH = "/System/Library/Fonts/Hiragino Sans GB.ttc"
W, H = 750, 1200

os.makedirs(OUT_DIR, exist_ok=True)

def load_font(size):
    try:
        return ImageFont.truetype(FONT_PATH, size)
    except Exception:
        return ImageFont.load_default()

def text_w(draw, text, font):
    bbox = font.getbbox(text)
    return bbox[2] - bbox[0]

def center_x(draw, text, font):
    return (W - text_w(draw, text, font)) // 2

def draw_center(draw, text, y, font, color):
    x = center_x(draw, text, font)
    draw.text((x, y), text, font=font, fill=color)

def grad_fill(draw, h_total, stops):
    """用水平渐变填充整张图，stops = [(ratio, (r,g,b)), ...]"""
    for i in range(h_total):
        ratio = i / max(h_total-1, 1)
        # 线性插值
        for s in range(len(stops)-1):
            r0, c0 = stops[s]
            r1, c1 = stops[s+1]
            if r0 <= ratio <= r1:
                t = (ratio - r0) / (r1 - r0)
                r = int(c0[0] + (c1[0]-c0[0]) * t)
                g = int(c0[1] + (c1[1]-c0[1]) * t)
                b = int(c0[2] + (c1[2]-c0[2]) * t)
                draw.line([(0,i),(W,i)], fill=(r,g,b))
                break

def paste_qr(img, qr_img, cx, cy, box=300):
    """在(cx,cy)居中贴二维码，返回实际贴图区域"""
    qr_r = qr_img.resize((box, box), Image.LANCZOS)
    left = cx - box//2
    top  = cy - box//2
    img.paste(qr_r, (left, top))
    return (left, top, left+box, top+box)

# ============================================================
# 海报A：经典红白风
# ============================================================
def make_poster_a(qr_img):
    img = Image.new("RGB", (W, H))
    draw = ImageDraw.Draw(img)

    # 背景渐变：红→深蓝
    for i in range(H):
        ratio = i / H
        if ratio < 0.35:
            t = ratio / 0.35
            r = int(232 - 40*t);  g = int(50 + 10*t);  b = int(20 + 10*t)
        elif ratio < 0.65:
            t = (ratio-0.35)/0.3
            r = int(192 - 30*t); g = int(60 + 10*t); b = int(30 + 20*t)
        else:
            t = (ratio-0.65)/0.35
            r = int(162 - 20*t); g = int(70 - 15*t); b = int(50 - 10*t)
        draw.line([(0,i),(W,i)], fill=(max(0,min(255,r)), max(0,min(255,g)), max(0,min(255,b))))

    # 白色半透明顶波浪
    wave = Image.new("RGBA", (W,H), (0,0,0,0))
    wdraw = ImageDraw.Draw(wave)
    wdraw.ellipse([-60, -100, W+60, 160], fill=(255,255,255,30))
    img = Image.alpha_composite(img.convert("RGBA"), wave).convert("RGB")
    draw = ImageDraw.Draw(img)

    # ── 品牌区 ──
    f_brand = load_font(54)
    draw_center(draw, "企港渔叔", 50, f_brand, (255,255,255))
    f_sub = load_font(19)
    draw_center(draw, "海 鲜 厨 房  ·  社 区 鲜 味", 112, f_sub, (220,185,175))
    f_tag = load_font(14)
    tag_txt = "📍 佛山市禅城区水悦龙湾"
    tx = center_x(draw, tag_txt, f_tag)
    draw.rounded_rectangle([tx-16, 138, tx+text_w(draw,tag_txt,f_tag)+16, 138+30],
                          radius=15, fill=None, outline=(255,255,255,70), width=1)
    draw.text((tx, 143), tag_txt, font=f_tag, fill=(255,215,195))

    # ── 白色内容卡片 ──
    card_y, card_h = 200, 710
    # 阴影
    shadow = Image.new("RGBA", (W-88, card_h+8), (0,0,0,22))
    img.paste(shadow, (48, card_y+6), shadow)
    img = img.convert("RGB")
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle([40, card_y, W-40, card_y+card_h], radius=24, fill=(255,255,255))

    cy = card_y + 32
    f_st = load_font(34)
    draw_center(draw, "📱 扫码点餐", cy, f_st, (220,50,20))
    cy += 50
    f_ss = load_font(17)
    draw_center(draw, "长按识别二维码，即刻下单", cy, f_ss, (160,160,160))
    cy += 40

    # 二维码（红色边框）
    qsize = 300
    qcx, qcy = W//2, cy + qsize//2
    draw.rounded_rectangle([qcx-qsize//2-4, cy-4, qcx+qsize//2+4, cy+qsize+4],
                          radius=20, fill=(232,68,26))
    draw.rounded_rectangle([qcx-qsize//2-1, cy-1, qcx+qsize//2+1, cy+qsize+1],
                          radius=19, fill=(255,255,255))
    paste_qr(img, qr_img, W//2, cy + qsize//2, qsize)
    cy += qsize + 32

    f_tip = load_font(20)
    draw_center(draw, "打开微信扫一扫", cy, f_tip, (232,68,26))
    cy += 34
    draw_center(draw, "⬇️", cy, load_font(26), (232,68,26))
    cy += 50

    # emoji展示
    emojis = ["🦐","🦀","🐟","🦑","🦞"]
    ex = (W - len(emojis)*60) // 2
    for i, emj in enumerate(emojis):
        draw.text((ex + i*60, cy), emj, font=load_font(40), fill=(80,80,80))

    # 底部
    f_ft = load_font(16)
    draw_center(draw, "企港渔叔 · 新鲜海鲜 · 现点现做", H-55, f_ft, (255,255,255))
    return img

# ============================================================
# 海报B：清新海洋风
# ============================================================
def make_poster_b(qr_img):
    img = Image.new("RGB", (W, H))
    draw = ImageDraw.Draw(img)

    # 背景：淡青绿渐变
    for i in range(H):
        ratio = i / H
        if ratio < 0.5:
            t = ratio / 0.5
            r = int(220 + 20*t); g = int(246 - 8*t); b = int(243 + 7*t)
        else:
            t = (ratio-0.5)/0.5
            r = int(240 - 18*t); g = int(238 - 18*t); b = int(250 - 28*t)
        draw.line([(0,i),(W,i)], fill=(r,g,b))

    # 顶线
    draw.rectangle([0,0,W,5], fill=(20,150,120))

    # ── 品牌区 ──
    f_br = load_font(52)
    draw_center(draw, "🐟", 48, load_font(58), (20,150,120))
    draw_center(draw, "企港渔叔", 108, f_br, (20,150,120))
    f_sl = load_font(17)
    draw.line([(W//2-45, 162),(W//2+45, 162)], fill=(20,150,120), width=3)
    draw_center(draw, "鲜 · 从 · 港 · 口 · 到 · 餐 · 桌", 170, f_sl, (60,145,115))

    # ── 白色磨砂卡片 ──
    card_y, card_h = 218, 690
    draw.rounded_rectangle([38, card_y+5, W-38, card_y+card_h+5], radius=28, fill=(200,232,220))
    draw.rounded_rectangle([38, card_y, W-38, card_y+card_h], radius=28, fill=(255,255,255))

    cy = card_y + 30
    # 绿色badge
    bw = 185; bx = (W-bw)//2
    draw.rounded_rectangle([bx, cy, bx+bw, cy+32], radius=16, fill=(20,150,120))
    draw.text(((W-text_w(draw,"📱 微信扫码点餐",load_font(14)))//2, cy+7),
              "📱 微信扫码点餐", font=load_font(14), fill=(255,255,255))
    cy += 50

    f_ti = load_font(36)
    draw_center(draw, "轻松下单 · 无需等待", cy, f_ti, (30,30,50))
    cy += 46
    f_su = load_font(16)
    draw_center(draw, "识别二维码，即刻开始点餐", cy, f_su, (20,150,120))
    cy += 36

    # 二维码（绿色边框）
    qsize = 290
    qx = (W-qsize)//2
    draw.rounded_rectangle([qx-5, cy-5, qx+qsize+5, cy+qsize+5], radius=22, fill=(20,150,120))
    draw.rounded_rectangle([qx-2, cy-2, qx+qsize+2, cy+qsize+2], radius=21, fill=(255,255,255))
    paste_qr(img, qr_img, W//2, cy + qsize//2, qsize)
    cy += qsize + 30

    # 步骤
    steps = ["扫码进入","挑选海鲜","在线下单"]
    icons = ["📱","🦐","✅"]
    for i in range(3):
        sx = 95 + i*195
        draw.ellipse([sx, cy, sx+34, cy+34], fill=(20,150,120))
        draw.text((sx+9, cy+5), str(i+1), font=load_font(17), fill=(255,255,255))
        draw.text((sx+2, cy+42), steps[i], font=load_font(13), fill=(60,140,110))
    cy += 78

    # 标签
    tags = ["🦐 鲜活明虾","🦀 精选螃蟹","🐟 当日海鱼","🦑 爽脆鱿鱼"]
    for i, tag in enumerate(tags):
        tw = text_w(draw, tag, load_font(14)) + 22
        ty = cy + (i//2)*42
        if i % 2 == 0:
            tx = 52
        else:
            tx = W - 52 - tw
        draw.rounded_rectangle([tx, ty, tx+tw, ty+32], radius=10, fill=(230,245,240))
        draw.text((tx+10, ty+7), tag, font=load_font(14), fill=(20,150,120))

    # 底部
    f_f1 = load_font(19)
    draw_center(draw, "📍 禅城区水悦龙湾店", H-82, f_f1, (20,150,120))
    f_f2 = load_font(14)
    draw_center(draw, "新鲜海鲜 · 现点现做 · 社区鲜味", H-52, f_f2, (100,170,145))
    return img

# ============================================================
# 海报C：深色品质风
# ============================================================
def make_poster_c(qr_img):
    img = Image.new("RGB", (W, H))
    draw = ImageDraw.Draw(img)

    # 背景：深蓝黑渐变
    for i in range(H):
        ratio = i / H
        if ratio < 0.35:
            t = ratio / 0.35
            r = int(26 + 10*t); g = int(26 + 40*t); b = int(46 + 20*t)
        elif ratio < 0.7:
            t = (ratio-0.35)/0.35
            r = int(36 + 5*t); g = int(66 - 15*t); b = int(66 - 20*t)
        else:
            t = (ratio-0.7)/0.3
            r = int(41 - 10*t); g = int(51 - 10*t); b = int(46 - 6*t)
        draw.line([(0,i),(W,i)], fill=(max(0,min(255,r)),max(0,min(255,g)),max(0,min(255,b)))

    # 金色光晕
    glow = Image.new("RGBA", (W,H), (0,0,0,0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([-40,-100,480,280], fill=(212,175,55,28))
    gd.ellipse([-60,H-380,320,H+40], fill=(212,175,55,18))
    img = Image.alpha_composite(img.convert("RGBA"), glow).convert("RGB")
    draw = ImageDraw.Draw(img)

    # 金色顶底线
    draw.line([(0,0),(W,0)], fill=(212,175,55), width=4)
    draw.line([(0,H-3),(W,H-3)], fill=(212,175,55), width=3)

    # ── 品牌区 ──
    f_br = load_font(52)
    draw_center(draw, "🐚", 48, load_font(46), (212,175,55))
    draw_center(draw, "企港渔叔", 102, f_br, (212,175,55))
    f_sl = load_font(13)
    draw_center(draw, "PREMIUM  ·  SEAFOOD  ·  KITCHEN", 156, f_sl, (212,175,55))
    draw.line([(W//2-65,H-188),(W//2+65,H-188)], fill=(212,175,55), width=1)

    # ── 深色半透明卡片 ──
    card_y, card_h = 212, 700
    card_bg = Image.new("RGBA", (W-88, card_h), (255,255,255,12))
    img.paste(card_bg, (46, card_y), card_bg)
    img = img.convert("RGB")
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle([44, card_y, W-44, card_y+card_h], radius=24, outline=(212,175,55), width=1)

    cy = card_y + 30
    f_lb = load_font(13)
    draw_center(draw, "O R D E R   O N L I N E", cy, f_lb, (212,175,55))
    cy += 30
    f_ti = load_font(42)
    draw_center(draw, "扫码点餐", cy, f_ti, (255,255,255))
    cy += 54
    f_su = load_font(16)
    draw_center(draw, "Scan QR Code to Order", cy, f_su, (212,175,55))
    cy += 38

    # 二维码（金色边框）
    qsize = 300
    qx = (W-qsize)//2
    draw.rounded_rectangle([qx-5, cy-5, qx+qsize+5, cy+qsize+5], radius=20, fill=(212,175,55))
    draw.rounded_rectangle([qx-2, cy-2, qx+qsize+2, cy+qsize+2], radius=19, fill=(255,255,255))
    paste_qr(img, qr_img, W//2, cy + qsize//2, qsize)
    cy += qsize + 30

    # HOT标签
    hot_txt = "🔥 今日新鲜到港 · 每日限量供应"
    hw = text_w(draw, hot_txt, load_font(13)) + 30
    hx = (W-hw)//2
    draw.rounded_rectangle([hx, cy, hx+hw, cy+34], radius=17, fill=(212,175,55))
    draw.text(((W-text_w(draw,hot_txt,load_font(13)))//2, cy+8),
              hot_txt, font=load_font(13), fill=(50,40,10))
    cy += 52

    # 步骤
    step_icons = ["📱","🦐","✅"]
    step_labels = ["扫码进入","挑选海鲜","一键下单"]
    for i in range(3):
        sx = 72 + i*205
        draw.text((sx+2, cy), step_icons[i], font=load_font(26), fill=(255,255,255))
        draw.text((sx, cy+38), step_labels[i], font=load_font(13), fill=(255,255,255))
    cy += 78

    # 特色标签
    features = ["🦐 鲜活现杀","🔥 猛火现炒","⏱️ 极速上桌","💯 品质保证"]
    for i, feat in enumerate(features):
        fw = text_w(draw, feat, load_font(13)) + 22
        fy = cy + (i//2)*40
        if i % 2 == 0:
            fx = 58
        else:
            fx = W - 58 - fw
        draw.rounded_rectangle([fx, fy, fx+fw, fy+30], radius=8, fill=(255,255,255))
        draw.text((fx+10, fy+7), feat, font=load_font(13), fill=(255,255,255))

    # 底部
    f_f1 = load_font(18)
    draw_center(draw, "📍 佛山市禅城区水悦龙湾店", H-92, f_f1, (212,175,55))
    f_f2 = load_font(13)
    draw_center(draw, "营业时间  11:00-14:00  /  17:00-22:00", H-62, f_f2, (255,255,255))
    return img

# ============================================================
# 主程序
# ============================================================
if __name__ == "__main__":
    qr = Image.open(QR_PATH).convert("RGB")
    print("二维码已加载：" + QR_PATH)

    print("生成海报A（经典红白风）...")
    pa = make_poster_a(qr)
    pa.save(OUT_DIR + "/poster-a.png", "PNG")
    print("  ✅ poster-a.png")

    print("生成海报B（清新海洋风）...")
    pb = make_poster_b(qr)
    pb.save(OUT_DIR + "/poster-b.png", "PNG")
    print("  ✅ poster-b.png")

    print("生成海报C（深色品质风）...")
    pc = make_poster_c(qr)
    pc.save(OUT_DIR + "/poster-c.png", "PNG")
    print("  ✅ poster-c.png")

    print("\n🎉 三张海报全部生成完毕！")
    print("📂 输出目录：" + OUT_DIR)
