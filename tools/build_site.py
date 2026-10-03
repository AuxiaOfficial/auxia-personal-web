# -*- coding: utf-8 -*-
"""把站点源目录装配成可部署的 dist/（Cloudflare Pages 的产物目录）

为什么要 dist：源码根目录里还有 tools/、data/.poster-cache.json 等
不该公开的文件。直接部署根目录会把这些一起暴露出去。
dist/ 里只放「浏览器真的需要的东西」。

注意：站点现在是**纯静态 + 零外部请求**的。背景插画已离线自托管到
assets/img/illust/，所以不再需要 Cloudflare Pages Functions / Worker
去代理外部图片——原来那套（functions/ + shared/ + workers/）已整体移除。

另外这里还负责**注入对外域名**（见 copy_one 的说明）：
手写页面里写 {{ORIGIN}}，装配时替换成 common.PUBLIC_ORIGIN。
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

from common import ORIGIN_TOKEN, PUBLIC_ORIGIN, SITE

DIST = SITE / "dist"

# 需要走一遍占位符替换的文本类后缀。
# 只收 .html / .webmanifest：这两个才会印绝对域名。
# .css / .js 一律用根相对路径（/assets/...），不需要、也不该出现绝对域名。
TEXT_SUFFIXES = {".html", ".webmanifest"}

# 需要整体拷贝的目录
COPY_DIRS = [
    ("assets", "assets"),
    ("gallery", "gallery"),
    ("projects", "projects"),
]

# 需要整体拷贝的文件
COPY_FILES = ["manifest.webmanifest", "_headers", "_redirects"]

# 需要拷贝的 data/*.json（跳过以 . 开头的中间缓存）
DATA_FILES = ["site.json", "gallery.json", "palette-pool.json"]

# 根目录下的页面
PAGES = ["index.html", "404.html"]

SKIP_SUFFIX = {".map"}

_replaced_files: list[str] = []


def copy_one(src: Path, dst: Path) -> None:
    """拷贝单个文件；文本类顺带走一遍占位符替换。

    ⚠️ 为什么要替换，而不是让人把域名直接写进 HTML：

      `canonical` / `og:url` / `og:image` / `twitter:image` 印的是**绝对域名**，
      而它只有一个真源 —— `common.PUBLIC_ORIGIN`。写死在页面里，换域名必然漏改。

      本项目真的漏过一次：改 `PUBLIC_ORIGIN` 之后，**项目页**跟着变了
      （它们由 `gen_project_pages.py` 从常量生成），但**首页和展墙**没变
      （它们是人写的 HTML）—— 而那一版自检只断言了 `index.html` 的 canonical，
      所以「改一处全站同步」这句话对首页来说一直是假的，直到换域名那天才露出来。

      所以约定：手写页面里写 `{{ORIGIN}}`，构建时在这里注入。
      下面还有一道「产物里不许残留占位符」的校验兜着。
    """
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.suffix.lower() in TEXT_SUFFIXES:
        text = src.read_bytes().decode("utf-8")
        if ORIGIN_TOKEN in text:
            # 用字节读写而不是 read_text/write_text：后者的换行归一化会把源文件的
            # 行尾悄悄改掉（CRLF -> LF），产生一个「什么都没改但整个文件都变了」的 diff。
            dst.write_bytes(text.replace(ORIGIN_TOKEN, PUBLIC_ORIGIN).encode("utf-8"))
            _replaced_files.append(dst.relative_to(DIST).as_posix())
            return
    shutil.copy2(src, dst)


def copy_tree(src: Path, dst: Path) -> int:
    n = 0
    for p in src.rglob("*"):
        if p.is_dir() or p.suffix in SKIP_SUFFIX:
            continue
        if p.name.startswith(".") or "node_modules" in p.parts:
            continue
        copy_one(p, dst / p.relative_to(src))
        n += 1
    return n


def verify_no_token_left() -> None:
    """产物里不许残留 {{ORIGIN}}。

    有的拷贝路径是**整目录复制**（gallery/、projects/），替换是逐文件做的 ——
    万一以后有人往那些目录里放一个用占位符的页面而替换没覆盖到，
    产物里就会带着字面的 `{{ORIGIN}}` 上线。那是肉眼很难发现的那种错：
    页面照常渲染，只有分享卡片的图片地址是坏的。所以这里必须响。
    """
    leftover = []
    for p in DIST.rglob("*"):
        if not p.is_file() or p.suffix.lower() not in TEXT_SUFFIXES:
            continue
        if ORIGIN_TOKEN in p.read_text(encoding="utf-8", errors="replace"):
            leftover.append(p.relative_to(DIST).as_posix())
    if leftover:
        print(
            f"[error] 产物里还有没被替换的 {ORIGIN_TOKEN}：{leftover[:5]}\n"
            f"        这些文件的拷贝路径没有走 copy_one 的替换。",
            file=sys.stderr,
        )
        sys.exit(1)


def main() -> None:
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir(parents=True)

    total = 0
    for src_name, dst_name in COPY_DIRS:
        src = SITE / src_name
        if not src.is_dir():
            print(f"[warn] 缺少目录 {src_name}，跳过", file=sys.stderr)
            continue
        n = copy_tree(src, DIST / dst_name)
        total += n
        print(f"  {src_name}/  ->  dist/{dst_name}/   {n} 个文件")

    for name in COPY_FILES:
        src = SITE / name
        if src.is_file():
            copy_one(src, DIST / name)
            total += 1
            print(f"  {name}")

    (DIST / "data").mkdir(exist_ok=True)
    for name in DATA_FILES:
        src = SITE / "data" / name
        if src.is_file():
            shutil.copy2(src, DIST / "data" / name)
            total += 1
            print(f"  data/{name}  ({src.stat().st_size/1024:.0f}KB)")
        else:
            print(f"[warn] 缺少 data/{name}，页面会走兜底逻辑", file=sys.stderr)

    for name in PAGES:
        src = SITE / name
        if src.is_file():
            copy_one(src, DIST / name)
            total += 1
            print(f"  {name}")
        else:
            print(f"[error] 缺少页面 {name}", file=sys.stderr)

    verify_no_token_left()

    size = sum(f.stat().st_size for f in DIST.rglob("*") if f.is_file())
    print(f"\ndist/ 就绪：{total} 个文件，{size/1e6:.2f}MB")
    print(f"  对外域名已注入：{PUBLIC_ORIGIN}")
    if _replaced_files:
        print(f"  替换了 {ORIGIN_TOKEN} 的页面：{_replaced_files}")
    # 项目名要和实际建的 Pages 项目**逐字一致**（本站是 auxiaweb）：
    # 名字写错的话，wrangler 不是报错，而是去**新建一个项目** —— 你会以为发上去了，
    # 结果新域名是空的、老域名还是旧内容。
    print("发布到 Cloudflare Pages（详见 README「九、部署」）：")
    print("  python tools/make_dist_zip.py    # -> build/dist-site.zip，拖进 Pages 上传区")
    print("  npx wrangler pages deploy dist --project-name=auxiaweb")


if __name__ == "__main__":
    main()
