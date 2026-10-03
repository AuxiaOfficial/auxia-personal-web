# -*- coding: utf-8 -*-
"""摄影原图 -> WebP（全尺寸 + 缩略图）+ 主色/色系分桶 -> data/photos.json

原图 3~7MB，必须压缩后才能上站。
"""
from __future__ import annotations

import json
import sys

from PIL import Image, ImageOps

from common import DATA, PHOTOS, WALLS, ensure_dirs, hex_from_rgb, slugify

FULL_W = 1800      # 灯箱大图
THUMB_W = 720      # 展墙网格
QUALITY_FULL = 80
QUALITY_THUMB = 74

SRC_DIR = WALLS / "摄影作品展示"


def dominant_accent(img: Image.Image) -> str:
    """取主色：缩小 -> 量化 -> 按明度/饱和度加权，挑一个足够「有颜色」的代表色。"""
    small = img.convert("RGB").resize((120, 120), Image.LANCZOS)
    q = small.quantize(colors=8, method=Image.MEDIANCUT).convert("RGB")
    counts: dict[tuple[int, int, int], int] = {}
    for px in q.getdata():
        counts[px] = counts.get(px, 0) + 1

    best, best_score = None, -1.0
    for rgb, n in counts.items():
        r, g, b = [c / 255 for c in rgb]
        mx, mn = max(r, g, b), min(r, g, b)
        light = (mx + mn) / 2
        sat = 0.0 if mx == mn else (mx - mn) / (1 - abs(2 * light - 1) + 1e-6)
        # 偏好「中等明度 + 高饱和」的色，避免死黑/死白/灰当 accent
        score = n * (0.25 + sat) * (1 - abs(light - 0.55))
        if score > best_score:
            best, best_score = rgb, score
    return hex_from_rgb(best)


def bucket_of(hex_color: str) -> str:
    import colorsys
    r, g, b = (int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5))
    h, s, v = colorsys.rgb_to_hsv(r, g, b)
    deg = h * 360
    if s < 0.13:
        return "mist" if v < 0.62 else "cream"
    if deg < 22 or deg >= 340:
        return "pink" if s > 0.42 else "warm"
    if deg < 48:
        return "warm"
    if deg < 95:
        return "cream"
    if deg < 200:
        return "aqua"
    if deg < 265:
        return "mist"
    return "pink"


def main() -> None:
    ensure_dirs()
    if not SRC_DIR.is_dir():
        print(f"[error] 找不到摄影目录：{SRC_DIR}", file=sys.stderr)
        sys.exit(1)

    out = []
    files = sorted(
        (p for p in SRC_DIR.iterdir() if p.is_file() and p.suffix.lower() in {".jpg", ".jpeg", ".png"}),
        key=lambda p: p.name.lower(),
    )
    (PHOTOS / "full").mkdir(exist_ok=True)
    (PHOTOS / "thumb").mkdir(exist_ok=True)

    for f in files:
        sid = slugify(f.stem).lower()
        with Image.open(f) as im:
            im = ImageOps.exif_transpose(im)          # 尊重 EXIF 方向
            im = im.convert("RGB")
            w, h = im.size
            accent = dominant_accent(im)

            full = im.copy()
            if full.width > FULL_W:
                full = full.resize((FULL_W, round(full.height * FULL_W / full.width)), Image.LANCZOS)
            full_path = PHOTOS / "full" / f"{sid}.webp"
            full.save(full_path, "WEBP", quality=QUALITY_FULL, method=6)

            thumb = im.copy()
            if thumb.width > THUMB_W:
                thumb = thumb.resize((THUMB_W, round(thumb.height * THUMB_W / thumb.width)), Image.LANCZOS)
            thumb_path = PHOTOS / "thumb" / f"{sid}.webp"
            thumb.save(thumb_path, "WEBP", quality=QUALITY_THUMB, method=6)

        out.append({
            "id": sid,
            "title": f.stem,
            "full": f"assets/img/photos/full/{sid}.webp",
            "thumb": f"assets/img/photos/thumb/{sid}.webp",
            "w": w, "h": h,
            "accent": accent,
            "bucket": bucket_of(accent),
            "srcBytes": f.stat().st_size,
            "fullBytes": full_path.stat().st_size,
            "thumbBytes": thumb_path.stat().st_size,
        })
        print(f"  {f.name:<16} {w}x{h}  accent={accent} bucket={out[-1]['bucket']:<6} "
              f"{f.stat().st_size/1e6:.1f}MB -> {full_path.stat().st_size/1024:.0f}KB / "
              f"{thumb_path.stat().st_size/1024:.0f}KB")

    (DATA / "photos.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    raw = sum(o["srcBytes"] for o in out)
    new = sum(o["fullBytes"] + o["thumbBytes"] for o in out)
    print(f"\n{len(out)} 张：{raw/1e6:.1f}MB -> {new/1e6:.2f}MB（压缩到 {new/raw*100:.1f}%）")


if __name__ == "__main__":
    main()
