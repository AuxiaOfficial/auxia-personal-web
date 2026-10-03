# -*- coding: utf-8 -*-
"""背景插画（站主自备）-> assets/img/illust/*.webp + data/palette-pool.json

取代原来的 build_palette_pool.py（那时是运行时抓 isouweb.cn）。
现在背景图完全离线自托管，因此：
  * 不再需要 Worker / Pages Function 去代理和实时压缩
  * 页面不依赖任何外部请求，也就不存在「上游挂了开天窗」这一档

流程：读本地原图 -> 压成 WebP -> 抽主色 -> 按色相分桶 -> 写元数据
前端按页面所属色系桶取图；桶内为空时退回全池（绝不出现没背景的页面）。
"""
from __future__ import annotations

import colorsys
import json
import sys

from PIL import Image, ImageOps

from common import DATA, ILLUST, ensure_dirs, hex_from_rgb, illust_dir, slugify

MAX_W = 1800          # 背景会被模糊，1800 足够，再大只是浪费流量
QUALITY = 74          # 模糊之后质量差异看不出来，压狠一点

BUCKETS = {
    "warm":  "暖橙",
    "pink":  "粉紫",
    "aqua":  "冷青",
    "cream": "米白",
    "mist":  "灰蓝",
}


def bucket_of(rgb: tuple[int, int, int]) -> str:
    r, g, b = [c / 255 for c in rgb]
    h, s, v = colorsys.rgb_to_hsv(r, g, b)
    deg = h * 360
    if s < 0.14:                       # 低饱和：按明度分米白 / 灰蓝
        return "cream" if v >= 0.70 else ("mist" if v < 0.52 else "cream")
    if deg < 20 or deg >= 345:
        return "pink" if s > 0.40 else "warm"
    if deg < 50:
        return "warm"
    if deg < 95:
        return "cream"
    if deg < 200:
        return "aqua"
    if deg < 270:
        return "mist"
    return "pink"


def accent_of(img: Image.Image) -> str:
    """取主色：量化后按「出现面积 × 饱和度 × 中等明度」打分。
    插画的主色要能当按钮/下划线用，所以宁可挑鲜艳的，也不要挑一大片灰。"""
    small = img.convert("RGB").resize((96, 96), Image.LANCZOS)
    q = small.quantize(colors=8, method=Image.MEDIANCUT).convert("RGB")
    counts: dict[tuple[int, int, int], int] = {}
    px = q.load()
    for y in range(q.height):
        for x in range(q.width):
            c = px[x, y]
            counts[c] = counts.get(c, 0) + 1

    best, best_score = None, -1.0
    for rgb, n in counts.items():
        r, g, b = [c / 255 for c in rgb]
        _, s, v = colorsys.rgb_to_hsv(r, g, b)
        score = n * (0.2 + s) * (1 - abs(v - 0.58))
        if score > best_score:
            best, best_score = rgb, score
    return hex_from_rgb(best)


# 强调色的可用明度区间。
# 偏亮：白纸上读不清（站点 CSS 那边还会再兜一层）。
# 偏暗：接近纯黑，落在「明亮的日系」基调上就像一块脏斑 ——
#       上一版有张深色插画抽到 #100700，光标和链接全成了黑色。
V_MIN, V_MAX = 0.34, 0.72


def usable_accent(hex_color: str) -> str:
    """只压明度，不动色相与饱和度。"""
    r, g, b = (int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5))
    h, s, v = colorsys.rgb_to_hsv(r, g, b)
    v = min(max(v, V_MIN), V_MAX)
    return hex_from_rgb(tuple(round(c * 255) for c in colorsys.hsv_to_rgb(h, s, v)))


def main() -> None:
    ensure_dirs()
    src_dir = illust_dir()
    if not src_dir.is_dir():
        print(f"[error] 找不到插画目录：{src_dir}", file=sys.stderr)
        sys.exit(1)

    files = sorted(
        (p for p in src_dir.iterdir()
         if p.is_file() and p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".avif"}),
        key=lambda p: p.name.lower(),
    )
    if not files:
        print(f"[error] {src_dir} 里没有图片", file=sys.stderr)
        sys.exit(1)

    ILLUST.mkdir(parents=True, exist_ok=True)
    # 先清掉上一轮产物，避免素材删了之后留下孤儿文件
    for old in ILLUST.glob("*.webp"):
        old.unlink()

    items: list[dict] = []
    raw_bytes = new_bytes = 0

    for f in files:
        # 素材名是长哈希，取前 10 位足够区分
        base = (slugify(f.stem)[:10].lower() or "illust")
        sid, n = base, 1
        while any(i["id"] == sid for i in items):
            n += 1
            sid = f"{base}-{n}"

        try:
            with Image.open(f) as im0:
                im = ImageOps.exif_transpose(im0)
                if im.mode in ("RGBA", "LA", "P"):
                    im = im.convert("RGBA")
                    flat = Image.new("RGB", im.size, (255, 255, 255))
                    flat.paste(im, mask=im.split()[-1])
                    im = flat
                else:
                    im = im.convert("RGB")
                w0, h0 = im.size
                accent = usable_accent(accent_of(im))

                if im.width > MAX_W:
                    im = im.resize((MAX_W, max(1, round(im.height * MAX_W / im.width))), Image.LANCZOS)
                out = ILLUST / f"{sid}.webp"
                im.save(out, "WEBP", quality=QUALITY, method=6)
                w, h = im.size
        except Exception as e:                              # noqa: BLE001
            print(f"  [skip] {f.name}: {e}", file=sys.stderr)
            continue

        bucket = bucket_of(tuple(int(accent[i:i + 2], 16) for i in (1, 3, 5)))
        items.append({
            "id": sid,
            "src": f"/assets/img/illust/{sid}.webp",
            "accent": accent,
            "bucket": bucket,
            "w": w, "h": h,
        })
        raw_bytes += f.stat().st_size
        new_bytes += out.stat().st_size
        print(f"  {sid:<11} {w0}x{h0} -> {w}x{h}  {out.stat().st_size/1024:>5.0f}KB  "
              f"accent={accent}  bucket={bucket}")

    if not items:
        print("[error] 一张都没处理成功", file=sys.stderr)
        sys.exit(1)

    by_bucket: dict[str, list[dict]] = {k: [] for k in BUCKETS}
    for it in items:
        by_bucket[it["bucket"]].append(it)

    out = {
        "source": "local:random_illust",
        "note": "站主自备插画，已压缩为同站 WebP；页面按色系桶随机取图，不再走外部接口",
        "total": len(items),
        "all": items,
        "buckets": {
            k: {"label": BUCKETS[k], "count": len(v), "items": v}
            for k, v in by_bucket.items()
        },
    }
    (DATA / "palette-pool.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"\n分桶统计（共 {len(items)} 张）：")
    for k, v in by_bucket.items():
        flag = "  ← 空，该页将退回全池" if not v else ""
        print(f"  {k:<6}{BUCKETS[k]}  {len(v):>3} 张{flag}")
    print(f"\n{raw_bytes/1e6:.1f}MB -> {new_bytes/1e6:.2f}MB "
          f"（压缩到 {new_bytes/raw_bytes*100:.1f}%）  -> data/palette-pool.json")


if __name__ == "__main__":
    main()
