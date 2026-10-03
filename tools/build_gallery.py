# -*- coding: utf-8 -*-
"""扫 007 WALLS 展墙🖼️ -> data/gallery.json

硬规则：
  * 只读原笔记，绝不写入 / 修改笔记库
  * zzz摄影 永久排除（不上传）
  * 海报信息（poster / source / credit）若 data/posters.json 里有就合并进来
"""
from __future__ import annotations

import json
import sys

from common import DATA, EXCLUDE_ITEMS, SITE, WALL_DEFS, WALLS, parse_wall_list, slugify

EXCLUDE_DIRS = {"zzz摄影", ".obsidian", ".trash"}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"}


def rootabs(p: str | None) -> str:
    """把素材路径统一成 root-absolute（/assets/...）。

    必须这么做的原因：gallery.json 会被三种不同深度的页面消费——
    `/`（1 层）、`/gallery/`（1 层）、`/projects/<slug>/`（2 层）。
    如果这里存 `assets/img/x.webp` 这种裸相对路径，浏览器会按当前文档的
    base 去解析，在 `/gallery/` 下就变成 `/gallery/assets/img/x.webp` → 404。
    存成 `/assets/...` 则任何深度都解析正确，前端也就无需再拼 ROOT 前缀。
    """
    if not p:
        return ""
    if p.startswith(("http://", "https://", "//", "/", "data:")):
        return p
    return "/" + p.lstrip("./")


def asset_exists(rel: str) -> bool:
    """海报缓存里可能留着已删文件的条目（比如换成题名卡之后）。
    引用一个不存在的文件会在页面上留一张裂图，所以这里落盘校验一次。

    ⚠️ 必须先 lstrip 掉开头的 /：传进来的是 root-absolute 路径（/assets/...），
    而在 pathlib 里用一个「带根」的片段去 join 会把左边整段丢掉——
    `SITE / "/assets/img/x.webp"` 得到的是 `C:/assets/img/x.webp`，而不是
    站点下的 assets/。结果就是每一张封面都被判成「文件不存在」，
    整站静默回落成题名卡，而且只打一堆 [warn]，看上去像素材没抓到。
    """
    if not rel:
        return False
    return (SITE / rel.lstrip("./")).is_file()


def build() -> dict:
    posters = {}
    pf = DATA / "posters.json"
    if pf.is_file():
        posters = json.loads(pf.read_text(encoding="utf-8"))

    photo_meta = {}
    mf = DATA / "photos.json"
    if mf.is_file():
        photo_meta = {p["id"]: p for p in json.loads(mf.read_text(encoding="utf-8"))}

    walls = []
    for d in WALL_DEFS:
        wall_dir = WALLS / d["dir"]
        items: list[dict] = []

        if d["kind"] == "image":
            if wall_dir.is_dir():
                files = sorted(
                    (p for p in wall_dir.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXT),
                    key=lambda p: p.name.lower(),
                )
                for f in files:
                    sid = slugify(f.stem).lower()
                    meta = photo_meta.get(sid, {})
                    items.append({
                        "id": sid,
                        "title": meta.get("title") or f.stem,
                        "thumb": rootabs(meta.get("thumb", "")),
                        "full": rootabs(meta.get("full", "")),
                        "w": meta.get("w"), "h": meta.get("h"),
                        "bucket": meta.get("bucket", d["bucket"]),
                        "accent": meta.get("accent", ""),
                        "credit": {"type": "self", "name": "Auxia 自摄", "url": ""},
                    })
        else:
            for title in parse_wall_list(wall_dir / "展示.md"):
                # 站主要求不展的条目直接跳过（笔记库只读，不展只在这里控制）
                if title in EXCLUDE_ITEMS:
                    continue
                sid = slugify(title)
                p = posters.get(title, {})
                poster = rootabs(p.get("file", ""))
                if poster and not asset_exists(poster):
                    print(f"[warn] {title} 的封面文件不存在，回落题名卡：{poster}", file=sys.stderr)
                    poster = ""
                items.append({
                    "id": sid,
                    "title": title,
                    "poster": poster,
                    "posterW": p.get("w") if poster else None,
                    "posterH": p.get("h") if poster else None,
                    "accent": p.get("accent", ""),
                    "credit": {
                        "type": p.get("source", "card") if poster else "card",
                        "name": p.get("credit", "") if poster else "",
                        "url": p.get("url", "") if poster else "",
                    },
                })

        # 空墙不渲染：一面没有任何展品的墙留在页面上只是噪音
        if not items:
            print(f"[skip] {d['name']} 没有任何展品，已从站上移除", file=sys.stderr)
            continue

        walls.append({
            "id": d["id"], "name": d["name"], "en": d["en"],
            "bucket": d["bucket"], "kind": d["kind"],
            "count": len(items), "items": items,
        })

    # 散落在素材库根目录、未被 WALL_DEFS 覆盖的子目录（仅提示，不收录）
    known = {d["dir"] for d in WALL_DEFS} | EXCLUDE_DIRS
    if WALLS.is_dir():
        stray = sorted(p.name for p in WALLS.iterdir() if p.is_dir() and p.name not in known)
        if stray:
            print(f"[warn] 素材库存在未纳入规格的目录，已忽略：{stray}", file=sys.stderr)

    total = sum(w["count"] for w in walls)
    return {
        "source": "007 WALLS 展墙🖼️",
        "excluded": sorted(EXCLUDE_DIRS),
        "total": total,
        "walls": walls,
    }


if __name__ == "__main__":
    data = build()
    DATA.mkdir(parents=True, exist_ok=True)
    out = DATA / "gallery.json"
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    for w in data["walls"]:
        miss = sum(1 for i in w["items"] if w["kind"] == "title" and not i.get("poster"))
        extra = f"（{miss} 件走题名卡）" if w["kind"] == "title" else ""
        print(f"  {w['name']:<10} {w['count']:>3} 件  [{w['bucket']}] {extra}")
    print(f"合计 {data['total']} 件 -> {out.relative_to(DATA.parent)}")
