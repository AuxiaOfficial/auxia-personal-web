# -*- coding: utf-8 -*-
"""图标链路：一切图标从站主给的那张「A」标志派生

    avatar.png(512) / apple-touch-icon.png(180) / favicon.ico(16/32/48/64)
    favicon.svg / og-cover.png(1200x630)

与上一版的区别：上一版的「A」是用 PIL 画出来的（渐变圆角方块 + 白色斜体 A）。
第五轮站主给了自己的标志图，改成从那张图派生 —— 之后改标志只需要换源图重跑。
"""
from __future__ import annotations

import base64
import io
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from common import ICONS, PUBLIC_ORIGIN, SITE, ensure_dirs, pick_path

# 字体与标志源文件（站主自备，不随仓库分发）。
# 解析顺序同 tools/common.py：环境变量 → tools/local.json → 项目内 assets-src/。
# 仓库里不写本机路径；本机路径放 local.json（已进 .gitignore）。
BODY_TTF = pick_path("AUXIA_TTF_BODY", "ttf_body",
                     [SITE / "assets-src" / "fonts" / "cmdysj.ttf"])

# 站主自备标志。1920×1920：中间一张浅色方卡，外圈一圈灰色渐变底。
# 卡片边界是**量出来的**（逐列/逐行平均亮度找台阶），不是目测：
#   x=83 处 162→240、x=1836 处 239→167，y 同值 —— 四边对称，属实。
# 外框必须切掉：那圈灰度会把真正的图形挤小，16px 下直接糊成一团灰。
SRC_LOGO = pick_path("AUXIA_LOGO_SRC", "logo_src",
                     [SITE / "assets-src" / "icons" / "logo-source.png"])
CARD_BOX = (83, 83, 1839, 1839)

OG_DOMAIN = PUBLIC_ORIGIN.replace("https://", "").rstrip("/")

_master_cache: Image.Image | None = None


def master() -> Image.Image:
    """源图裁掉外框后的正方形主图（1756×1756）。全流程只读一次盘。"""
    global _master_cache
    if _master_cache is None:
        if not SRC_LOGO.is_file():
            raise SystemExit(f"[error] 找不到标志源图：{SRC_LOGO}")
        _master_cache = Image.open(SRC_LOGO).convert("RGB").crop(CARD_BOX)
    return _master_cache


def rounded(img: Image.Image, radius_ratio: float) -> Image.Image:
    """给方形图加圆角（返回 RGBA）。图标留一点圆角更像「卡片」而不是贴图。"""
    px = img.size[0]
    m = Image.new("L", (px, px), 0)
    ImageDraw.Draw(m).rounded_rectangle(
        [0, 0, px - 1, px - 1], radius=int(px * radius_ratio), fill=255)
    out = img.convert("RGBA")
    out.putalpha(m)
    return out


def square(size: int) -> Image.Image:
    """主图缩到 size×size（RGB，不透明）。"""
    return master().resize((size, size), Image.LANCZOS)


# ---------------------------------------------------------------- SVG
def build_favicon_svg() -> str:
    """favicon.svg 里嵌的是**位图**，不是矢量的。

    为什么不做真矢量：源图是一张有渐变、有半透明叠加、有抗锯齿边缘的成图，
    想描成 path 需要描摹工具（potrace 之类），本机没有；
    手工重画等于重新设计标志，那已经不是站主要的那张图了。
    所以老老实实嵌 192px 的 PNG —— SVG 里放 data URI 是标准做法，
    data URI 又不受本站根路径规则影响，等于顺手解决了 file:// 预览的问题。"""
    buf = io.BytesIO()
    square(192).save(buf, format="PNG", optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192" '
        'width="192" height="192" role="img" aria-label="Auxia">\n'
        f'  <image width="192" height="192" href="data:image/png;base64,{b64}"/>\n'
        '</svg>\n'
    )


# ---------------------------------------------------------------- OG 封面
C1 = (242, 177, 132)      # 暖橙浅
C2 = (221, 122, 173)      # 粉紫
INK = (42, 39, 36)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def build_og_cover() -> Image.Image:
    from PIL import ImageFilter

    W, H = 1200, 630
    img = Image.new("RGB", (W, H), (253, 248, 242))
    px = img.load()
    for y in range(H):
        for x in range(W):
            t = (x / W * 0.5 + y / H * 0.5)
            a = lerp((253, 248, 242), (255, 255, 255), 0.5 - abs(t - 0.5))
            b = lerp((255, 233, 218), (250, 226, 240), t)
            px[x, y] = lerp(a, b, 0.5)

    # 右侧柔光（bokeh）：画在独立图层后整体高斯模糊，得到有空气感的散景
    bokeh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bokeh)
    blobs = [
        (950, 240, 130, C1, 130), (1090, 415, 100, C2, 118),
        (880, 470, 66, (255, 214, 178), 105), (1060, 150, 52, (250, 200, 225), 115),
        (800, 190, 40, (255, 236, 214), 95), (1150, 300, 34, (245, 205, 230), 105),
        (960, 540, 44, (255, 226, 240), 90), (1160, 520, 30, C1, 95),
        (700, 430, 26, (250, 214, 196), 85),
    ]
    for x, y, r, col, alpha in blobs:
        bd.ellipse([x - r, y - r, x + r, y + r], fill=col + (alpha,))
    bokeh = bokeh.filter(ImageFilter.GaussianBlur(26))
    img = Image.alpha_composite(img.convert("RGBA"), bokeh)

    # 左侧站主自己的标志。它是灰阶的，压在暖色底上正好是一处对比 ——
    # 不用再把标志染成主题色，那会毁掉原图的层次。
    mark = rounded(square(190), 0.16)
    img.paste(mark, (92, 108), mark)

    d = ImageDraw.Draw(img)
    f_title = ImageFont.truetype(str(BODY_TTF), 112)
    f_sub = ImageFont.truetype(str(BODY_TTF), 34)
    f_tag = ImageFont.truetype(str(BODY_TTF), 25)

    d.text((92, 344), "Auxia", font=f_title, fill=INK)
    d.rectangle([92, 480, 156, 484], fill=C2)
    d.text((96, 502), "个人站 · 大五人格 · 五面展墙 · 在建项目", font=f_sub, fill=(108, 100, 93))
    d.text((96, 556), OG_DOMAIN, font=f_tag, fill=(167, 158, 150))
    return img.convert("RGB")


# ---------------------------------------------------------------- 主流程
def main() -> None:
    ensure_dirs()

    print(f"  源图已裁到 {CARD_BOX} -> {master().size[0]}x{master().size[1]}")

    avatar = square(512)
    avatar.save(ICONS / "avatar.png", optimize=True)
    print(f"  avatar.png        512x512   {avatar.size}")

    at = square(180)
    at.save(ICONS / "apple-touch-icon.png", optimize=True)
    print("  apple-touch-icon.png  180x180")

    # ⚠️ ICO 的多尺寸有个坑：PIL 的 _save 里有这么一句
    #     `width, height = im.size` / `if size[0] > width ... continue` ——
    #     它会拿**主图**的尺寸当上限。上一版把 16px 那张当主图传进去，
    #     于是 32/48/64 全部被 `continue` 掉，ICO 里只剩 1 帧，
    #     而日志照样打印 [16, 32, 48, 64]（本机实测 Pillow 12.3.0）。
    #     正确做法：主图用**最大的**那张，其余按精确尺寸放进 append_images。
    ico_sizes = [16, 32, 48, 64]
    frames = {s: square(s) for s in ico_sizes}
    big = ico_sizes[-1]
    frames[big].save(ICONS / "favicon.ico", format="ICO",
                     sizes=[(s, s) for s in ico_sizes],
                     append_images=[frames[s] for s in ico_sizes if s != big])
    print(f"  favicon.ico       {ico_sizes}（主图 {big}px，其余精确尺寸追加）")

    svg = build_favicon_svg()
    (ICONS / "favicon.svg").write_text(svg, encoding="utf-8")
    print(f"  favicon.svg       {len(svg)/1024:.1f}KB（内嵌 192px 位图）")

    og = build_og_cover()
    og.save(ICONS / "og-cover.png", optimize=True)
    print("  og-cover.png      1200x630")

    manifest = {
        "name": "Auxia 的个人小站",
        "short_name": "Auxia",
        "description": "大五人格自画像 · 五面展墙 · 在建项目",
        "start_url": "/",
        "display": "standalone",
        "background_color": "#fdf8f2",
        "theme_color": "#fdf8f2",
        "icons": [
            {"src": "/assets/img/icons/avatar.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
            {"src": "/assets/img/icons/apple-touch-icon.png", "sizes": "180x180", "type": "image/png"},
            {"src": "/assets/img/icons/favicon.svg", "sizes": "any", "type": "image/svg+xml"},
        ],
    }
    (SITE / "manifest.webmanifest").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    print("  manifest.webmanifest")


if __name__ == "__main__":
    main()
