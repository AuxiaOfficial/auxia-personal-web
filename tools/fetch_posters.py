# -*- coding: utf-8 -*-
"""联网抓展品海报/封面 -> assets/img/posters/*.webp + data/posters.json

来源（均为公开可访问接口，抓取时加延时）：
  动漫        ：AniList GraphQL   https://graphql.anilist.co
  游戏        ：Steam Store API  https://store.steampowered.com/api
  音乐        ：iTunes Search    https://itunes.apple.com/search
  书籍        ：豆瓣图书搜索     https://book.douban.com/subject_search
  站主自备    ：MANUAL_POSTERS 里的本地文件（街机音游 / 同人曲）
抓不到的展品**不报错**，交由前端用「题名卡」兜底。

用法：
  python fetch_posters.py            # 全量（带缓存，已抓过的跳过）
  python fetch_posters.py --force    # 忽略缓存重抓
  python fetch_posters.py --only 动漫展墙
"""
from __future__ import annotations

import argparse
import html
import json
import re
import sys
import time
from io import BytesIO

import requests
from PIL import Image, ImageOps

from common import (DATA, EXCLUDE_ITEMS, MANUAL_POSTERS, POSTERS, POSTER_QUERIES,
                    WALL_DEFS, WALLS, ensure_dirs, parse_wall_list, slugify)

DELAY = 0.9                      # 秒，每次网络请求之间
TIMEOUT = 25
CACHE = DATA / ".poster-cache.json"


def norm(s: str) -> str:
    """归一化用于「标题包含」校验：去空格、标点、大小写差异。"""
    return re.sub(r"[^0-9a-z\u3040-\u30ff\u4e00-\u9fff]+", "", (s or "").lower())


def _get(url: str, **kw) -> requests.Response | None:
    # 调用方可能自带 headers（比如豆瓣图床要 Referer），要和默认 UA 合并而不是覆盖
    extra = kw.pop("headers", None) or {}
    headers = {"User-Agent": "Mozilla/5.0 (auxia-site/1.0)"}
    headers.update(extra)
    try:
        r = requests.get(url, timeout=TIMEOUT, headers=headers, **kw)
        return r if r.ok else None
    except requests.RequestException as e:
        print(f"    [net] {e}", file=sys.stderr)
        return None


def _post(url: str, payload: dict) -> dict | None:
    try:
        r = requests.post(url, json=payload, timeout=TIMEOUT,
                          headers={"Content-Type": "application/json", "User-Agent": "auxia-site/1.0"})
        return r.json() if r.ok else None
    except (requests.RequestException, ValueError) as e:
        print(f"    [net] {e}", file=sys.stderr)
        return None


# ------------------------------------------------------------------ 三个源
ANILIST_Q = """
query ($s: String) {
  Page(perPage: 3) { media(search: $s) {
    id title { romaji native english }
    coverImage { extraLarge large }
    siteUrl type format
  } }
}
"""


def by_anilist(term: str, expect: str = "") -> dict | None:
    d = _post("https://graphql.anilist.co", {"query": ANILIST_Q, "variables": {"s": term}})
    if not d:
        return None
    media = (d.get("data") or {}).get("Page", {}).get("media") or []
    if not media:
        return None
    m = media[0]
    url = (m.get("coverImage") or {}).get("extraLarge") or (m.get("coverImage") or {}).get("large")
    if not url:
        return None
    title = m.get("title") or {}
    return {
        "imageUrl": url,
        "credit": title.get("native") or title.get("romaji") or title.get("english") or "",
        "creditEn": title.get("romaji") or "",
        "url": m.get("siteUrl", ""),
        "source": "anilist",
        "sourceLabel": "封面 · AniList",
        "ratio": "portrait",
    }


STEAM_IMG = [
    "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/{id}/library_600x900.jpg",
    "https://cdn.cloudflare.steamstatic.com/steam/apps/{id}/library_600x900.jpg",
    "https://cdn.cloudflare.steamstatic.com/steam/apps/{id}/header.jpg",
    "https://cdn.cloudflare.steamstatic.com/steam/apps/{id}/capsule_616x353.jpg",
]


def by_steam(term: str, expect: str = "") -> dict | None:
    """term = "appid:367520" 时直取（Steam 搜索接口会限流，已知 appid 时更可靠）；
    否则走搜索 + 名称校验。"""
    direct = None
    if term.startswith("appid:"):
        try:
            direct = int(term.split(":", 1)[1].strip())
        except ValueError:
            return None

    if direct is not None:
        for tpl in STEAM_IMG:
            url = tpl.format(id=direct)
            if _get(url):
                ratio = "wide" if ("header" in tpl or "capsule" in tpl) else "portrait"
                return {"imageUrl": url, "credit": expect or f"appid {direct}", "creditEn": "",
                        "url": f"https://store.steampowered.com/app/{direct}/",
                        "source": "steam", "sourceLabel": "封面 · Steam", "ratio": ratio}
            time.sleep(DELAY)
        return None

    r = _get("https://store.steampowered.com/api/storesearch/",
             params={"term": term, "l": "schinese", "cc": "CN"})
    if not r:
        return None
    try:
        items = r.json().get("items") or []
    except ValueError:
        return None
    if not items:
        return None

    want = norm(expect or term)
    for cand in items[:3]:
        appid, name = cand["id"], cand.get("name", "")
        hay = norm(name)
        if not want or (want not in hay and hay not in want):
            continue
        for tpl in STEAM_IMG:
            url = tpl.format(id=appid)
            if _get(url):
                ratio = "wide" if "header" in tpl or "capsule" in tpl else "portrait"
                return {"imageUrl": url, "credit": name, "creditEn": "",
                        "url": f"https://store.steampowered.com/app/{appid}/",
                        "source": "steam", "sourceLabel": "封面 · Steam", "ratio": ratio}
            time.sleep(DELAY)
    return None


def by_itunes(term: str, expect: str = "") -> dict | None:
    """必须通过「标题包含」校验才算命中 —— 宁可回落题名卡，也不配错封面。
    expect 用于处理源站写法与中文译名不一致的情况（繁体 / 日文原题）。"""
    want = norm(expect or term)
    for country in ("JP", "CN", "US"):
        r = _get("https://itunes.apple.com/search",
                 params={"term": term, "entity": "song", "limit": 8, "country": country})
        if not r:
            continue
        try:
            results = r.json().get("results") or []
        except ValueError:
            continue
        for it in results:
            art = it.get("artworkUrl100", "")
            if not art:
                continue
            hay = norm((it.get("trackName") or "") + (it.get("collectionName") or ""))
            if not want or want not in hay:
                continue
            url = art.replace("/100x100bb.jpg", "/600x600bb.jpg")
            return {
                "imageUrl": url,
                "credit": f"{it.get('artistName','')} · {it.get('collectionName','')}".strip(" ·"),
                "creditEn": it.get("trackName", ""),
                "url": it.get("collectionViewUrl") or it.get("trackViewUrl") or "",
                "source": "itunes",
                "sourceLabel": "封面 · Apple Music",
                "ratio": "square",
            }
        time.sleep(DELAY)
    return None


def by_manual(term: str, expect: str = "") -> dict | None:
    """站主自己给的封面。term 留空即可，本地文件从 MANUAL_POSTERS 按展品名取。"""
    return None  # 真身见 manual_meta()，这里只为让 RESOLVERS 查表通过


def manual_meta(title: str) -> dict | None:
    src = MANUAL_POSTERS.get(title)
    if not src or not src.is_file():
        print(f"    [manual] 找不到本地文件：{src}", file=sys.stderr)
        return None
    return {
        "localPath": src,
        "credit": "",
        "creditEn": "",
        "url": "",                      # 站主自备素材，没有可外链的出处
        "source": "manual",
        "sourceLabel": "封面 · 站主自备",
        "ratio": "auto",
    }


def by_douban(term: str, expect: str = "") -> dict | None:
    """豆瓣图书搜索。返回页内内嵌的 window.__DATA__ JSON，含 title / cover_url / abstract。
    必须通过「标题包含」校验；拿不准就回落题名卡。"""
    want = norm(expect or term)
    try:
        r = requests.get(
            "https://book.douban.com/subject_search",
            params={"search_text": term, "cat": "1001"},
            timeout=TIMEOUT,
            headers={
                "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                               "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"),
                "Accept-Language": "zh-CN,zh;q=0.9",
            },
        )
    except requests.RequestException as e:
        print(f"    [net] {e}", file=sys.stderr)
        return None
    if not r.ok:
        return None

    page = r.text
    k = page.find("window.__DATA__ =")
    if k < 0:
        return None
    i = page.find("{", k)
    depth, end = 0, -1
    for p in range(i, len(page)):
        c = page[p]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                end = p + 1
                break
    if end < 0:
        return None
    try:
        items = json.loads(page[i:end]).get("items") or []
    except ValueError:
        return None

    for it in items:
        cover = it.get("cover_url") or ""
        title = html.unescape(it.get("title") or "")
        if not cover or not title:
            continue
        hay = norm(title)
        if want and want not in hay and hay not in want:
            continue
        return {
            # 搜索页给的是 /m/ 中图，换成 /l/ 大图（已实测可直连）
            "imageUrl": cover.replace("/view/subject/m/", "/view/subject/l/"),
            "referer": "https://book.douban.com/",
            "credit": (it.get("abstract") or "").split("/")[0].strip(),
            "creditEn": title,
            "url": f"https://book.douban.com/subject/{it.get('id')}/",
            "source": "douban",
            "sourceLabel": "封面 · 豆瓣读书",
            "ratio": "portrait",
        }
    return None


RESOLVERS = {"anilist": by_anilist, "steam": by_steam, "itunes": by_itunes,
             "douban": by_douban, "manual": by_manual}


# ------------------------------------------------------------------ 下载
def _open_image(meta: dict) -> Image.Image | None:
    """统一把源图读成 RGB。带透明通道的 PNG 必须压到白底上再存，
    否则转 WebP(RGB) 之后原本透明的地方会变成黑块。"""
    try:
        if meta.get("localPath"):
            raw = meta["localPath"].read_bytes()
        else:
            headers = {"User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                                      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36")}
            if meta.get("referer"):
                headers["Referer"] = meta["referer"]
            r = _get(meta["imageUrl"], headers=headers)
            if not r or not r.content:
                return None
            raw = r.content
        im = Image.open(BytesIO(raw))
        im = ImageOps.exif_transpose(im)
        if im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGBA")
            flat = Image.new("RGB", im.size, (255, 255, 255))
            flat.paste(im, mask=im.split()[-1])
            im = flat
        else:
            im = im.convert("RGB")
        return im
    except Exception as e:                                  # noqa: BLE001
        print(f"    [img] {e}", file=sys.stderr)
        return None


def save_poster(meta: dict, out_name: str) -> dict | None:
    im = _open_image(meta)
    if im is None:
        return None

    # 站主自备的各种素材长宽比不一，统一按最长边压到 720，别把图标拉成巨大横幅
    target = 720
    scale = target / max(im.width, im.height)
    if scale < 1:
        im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)

    path = POSTERS / f"{out_name}.webp"
    im.save(path, "WEBP", quality=82, method=6)
    meta = dict(meta)
    meta.update({"file": f"assets/img/posters/{out_name}.webp",
                 "w": im.width, "h": im.height, "bytes": path.stat().st_size})
    meta.pop("imageUrl", None)
    meta.pop("localPath", None)
    meta.pop("referer", None)
    return meta


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--only", default=None, help="只跑某一面墙（如 动漫展墙）")
    args = ap.parse_args()

    ensure_dirs()
    cache: dict = {}
    if CACHE.is_file() and not args.force:
        cache = json.loads(CACHE.read_text(encoding="utf-8"))

    results: dict[str, dict] = {}
    missing: list[dict] = []
    failed: list[str] = []

    def drop_stale(name: str) -> None:
        """回落题名卡时，把上一次抓错留下的封面文件删掉，避免配错图。"""
        f = POSTERS / f"{name}.webp"
        if f.is_file():
            f.unlink()

    for d in WALL_DEFS:
        if d["kind"] != "title":
            continue
        if args.only and d["dir"] != args.only:
            continue
        titles = parse_wall_list(WALLS / d["dir"] / "展示.md")
        titles = [t for t in titles if t not in EXCLUDE_ITEMS]
        print(f"\n=== {d['name']}（{len(titles)} 项）===")
        for title in titles:
            name = f"{d['id']}-{slugify(title)}"
            if title in cache and cache[title]:
                results[title] = cache[title]
                print(f"  ✓ {title}  （缓存）")
                continue

            q = POSTER_QUERIES.get(title)
            if not q:
                missing.append({"title": title, "wall": d["id"], "reason": "无可靠公开封面源"})
                failed.append(title)
                drop_stale(name)
                print(f"  · {title}  -> 题名卡")
                continue

            src, term = q[0], q[1]
            expect = q[2] if len(q) > 2 else term
            print(f"  … {title}  [{src}{': ' + term if term else ''}]")
            if src == "manual":
                meta = manual_meta(title)
            else:
                meta = RESOLVERS[src](term, expect)
                time.sleep(DELAY)
            if not meta:
                missing.append({"title": title, "wall": d["id"], "reason": f"{src} 未通过校验"})
                failed.append(title)
                drop_stale(name)
                print("      ✗ 未命中 -> 题名卡")
                continue

            saved = save_poster(meta, name)
            time.sleep(DELAY)
            if not saved:
                missing.append({"title": title, "wall": d["id"], "reason": "图片读取/下载失败"})
                failed.append(title)
                drop_stale(name)
                print("      ✗ 图片失败 -> 题名卡")
                continue

            saved["query"] = term or src
            results[title] = saved
            print(f"      ✓ {saved['w']}x{saved['h']} {saved['bytes']/1024:.0f}KB  {saved.get('credit','')[:40]}")

    # 汇总：历史缓存 + 本轮结果，并剔除本轮判定失败的条目
    out: dict = {}
    if CACHE.is_file():
        out = json.loads(CACHE.read_text(encoding="utf-8"))
    out = {k: v for k, v in out.items() if v}
    out.update(results)
    for t in failed:
        out.pop(t, None)
    CACHE.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    (DATA / "posters.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    (DATA / "missing.json").write_text(json.dumps(missing, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"\n封面已就位 {len(out)} 件；本轮走题名卡 {len(missing)} 件")
    for m in missing:
        print(f"  · {m['title']}（{m['reason']}）")


if __name__ == "__main__":
    main()
