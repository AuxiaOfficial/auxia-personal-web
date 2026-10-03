#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 dist/ 打成一个可以直接拖进 Cloudflare Pages 的 zip。

为什么需要这个脚本：
  Cloudflare Pages 的「Direct Upload」上传区收两种东西 —— 一个文件夹，或一个 zip。
  用文件夹那条路在自动化里会挂住（见 README「上传到 Cloudflare Pages」），所以
  手工/半自动更新都走 zip。而 zip 有一个**很容易踩错的结构要求**：

      index.html 必须在 zip 的**根部**。

  也就是「压 dist 的**内容**」，而不是「压 dist 这个目录」。
  后者会得到 <zip>/dist/index.html，Pages 解出来站点根下多一层 dist/，
  于是首页 404。

  ⚠️ 这个错**不会报任何错**：本地解压正常、上传进度照样走到 141/141、
  Dashboard 也显示部署成功 —— 只有打开域名才是 404。所以下面必须自检。

用法：
    python tools/make_dist_zip.py              # 生成 build/dist-site.zip
    python tools/make_dist_zip.py -o out.zip   # 指定输出路径
"""
from __future__ import annotations

import argparse
import os
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
DEFAULT_OUT = ROOT / "build" / "dist-site.zip"

# 站点根必须有它，否则 Pages 上打开域名会 404
REQUIRED_AT_ROOT = "index.html"

# 体积预检上限。本站 dist/ 的实测规模是 141 个文件 / 8.1 MB，
# 离这两个上限很远；而一旦有人把 `--src` 指向整个项目目录，
# 会开始压 node_modules / .git / 各种缓存 —— 实测跑出过 2.8 GB 的包。
# 与其等它压完，不如在**开始压之前**就拒绝。
MAX_FILES = 5000
MAX_BYTES = 300 * 1024 * 1024


def prescan(src: Path) -> tuple[int, int]:
    """先数一遍，返回 (文件数, 总字节数)。"""
    count = 0
    total = 0
    for dirpath, _dirnames, filenames in os.walk(src):
        for name in filenames:
            count += 1
            try:
                total += (Path(dirpath) / name).stat().st_size
            except OSError:
                pass
    return count, total


def build_zip(src: Path, out: Path) -> tuple[int, int]:
    """把 src 的内容压到 out 的根部。返回 (条目数, 字节数)。"""
    out.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    # compresslevel=9 对这种「大量小文本」的产物很划算：8.1 MB -> 7.4 MB
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for dirpath, _dirnames, filenames in os.walk(src):
            for name in filenames:
                full = Path(dirpath) / name
                # 相对 src 的路径 = zip 内的路径。这就是「压内容不压目录」的关键一步。
                rel = os.path.relpath(full, src).replace(os.sep, "/")
                z.write(full, rel)
                count += 1
    return count, out.stat().st_size


def validate(path: Path) -> tuple[bool, str]:
    """结构自检。返回 (是否通过, 诊断文字)。"""
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        at_root = [n for n in names if "/" not in n]

        if REQUIRED_AT_ROOT in at_root:
            return True, f"根部条目：{at_root[:6]}"

        # 诊断：最常见的错法是把目录本身压了进去，于是 index.html 在下一层。
        # 直接把「错在哪一层」指出来，省得对着 zip 猜。
        top_dirs = sorted({n.split("/")[0] for n in names if "/" in n})
        lines = [
            f"zip 根部没有 {REQUIRED_AT_ROOT} —— 部署后打开域名会是 404。",
            f"  根部条目：{at_root[:8] or '（无，全是目录）'}",
            f"  顶层目录：{top_dirs[:8]}",
        ]
        for d in top_dirs:
            if f"{d}/{REQUIRED_AT_ROOT}" in names:
                lines.append(
                    f"  ├─ 看起来把「{d}」这个目录本身压进去了："
                    f"zip 内路径是 {d}/{REQUIRED_AT_ROOT}。"
                )
                lines.append(f"  │  应该压目录的**内容**，让它变成 {REQUIRED_AT_ROOT}。")
                break
        return False, "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description="把 dist/ 打成可上传 Cloudflare Pages 的 zip")
    ap.add_argument("-o", "--out", default=str(DEFAULT_OUT), help="输出 zip 路径")
    ap.add_argument("--src", default=str(DIST), help="要打包的目录（默认 dist/）")
    args = ap.parse_args()

    src = Path(args.src)
    out = Path(args.out)

    if not src.is_dir():
        print(f"找不到 {src} —— 先跑 python tools/build_site.py", file=sys.stderr)
        return 2

    # ---- 体积预检：压之前就判断，别等它压出几个 GB 才发现 src 指错了 ----
    files, bytes_ = prescan(src)
    print(f"预扫描 {src}：{files} 个文件，{bytes_ / 1048576:.1f} MB")
    if files > MAX_FILES or bytes_ > MAX_BYTES:
        print(
            f"拒绝打包：{files} 个文件 / {bytes_ / 1048576:.0f} MB，明显超过一个静态站产物的规模。\n"
            f"  src 很可能指向了整个项目而不是构建产物。\n"
            f"  上传对象应该是 dist/（纯静态产物），不是仓库根 —— \n"
            f"  根目录里的 node_modules / .git / 各种缓存都不该进 zip，Pages 也不需要它们。",
            file=sys.stderr,
        )
        return 2

    # 先写到临时文件，校验通过才 os.replace 落位。
    # 这样**目标位置永远不会出现一个坏包** —— 旧的好 zip 原封不动，
    # 而且不需要「失败了再删」，删文件这件事在很多环境里会被安全策略拦下。
    tmp = out.with_name(out.name + ".tmp")
    count, size = build_zip(src, tmp)

    ok, detail = validate(tmp)
    if not ok:
        print(detail, file=sys.stderr)
        try:
            tmp.unlink()
        except OSError:
            print(f"（临时文件没删掉，可以手动删：{tmp}）", file=sys.stderr)
        if out.exists():
            print(f"目标位置保持原样，仍是上一次的包：{out}", file=sys.stderr)
        return 1

    os.replace(tmp, out)

    print(f"OK  {out}")
    print(f"    {count} 个条目，{size / 1048576:.1f} MB")
    print(f"    {detail}")
    print("    拖进 Cloudflare Pages 的上传区即可（选 .zip 那条输入，或直接拖文件）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
