# -*- coding: utf-8 -*-
"""字体管线
  1) 标题字体：从 zeoseven（FontsAPI 92 = 得意黑 Smiley Sans，OFL-1.1）取分片 woff2，落到 assets/fonts/smiley/
  2) 正文字体：把本地 cmdysj.ttf（= 思源黑体 CN Regular）按全站实际文案子集化
  3) 把「首屏真正用得到的那几个分片」注入各页 <head>（标记之间自动替换）

字符集**必须**由构建时扫描全站文案自动生成 —— 展墙展品名会不断增加，
手工写死字符集必然缺字。
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import requests

from common import DATA, SITE, UA, pick_path

FONTS = SITE / "assets" / "fonts"
SMILEY_DIR = FONTS / "smiley"
CSS_FILE = SITE / "assets" / "css" / "fonts.css"
CHARSET_FILE = FONTS / ".charset.txt"

# 字体源文件（站主自备，版权在字库方，不随仓库分发）。
# 解析顺序同 tools/common.py：环境变量 → tools/local.json → 项目内 assets-src/fonts/。
# 仓库里**不写本机路径**；本机路径放 local.json（已进 .gitignore）。
# 缺文件时脚本会在用到的那一步明确报错，不会静默出一个没字体的站。
SRC_BODY_TTF = pick_path("AUXIA_TTF_BODY", "ttf_body",
                         [SITE / "assets-src" / "fonts" / "cmdysj.ttf"])

# 开屏页的展示字体：站酷小薇 LOGO 体（站主自备）。
# 源文件是一整套 7713 字的中文字库、4.06MB —— 整包上站是不可接受的。
# 开屏只用到 "I'm Auxia," + "welcome to my website！"，
# 所以按这几个字子集化，体积会掉到几 KB。
SRC_LOGO_OTF = pick_path("AUXIA_OTF_LOGO", "otf_logo",
                         [SITE / "assets-src" / "fonts" / "ZhanKuXiaoLOGOTi-2.otf"])
# 打字机动效会**逐字**渲染，少一个字就有一个字掉回正文字体 —— 所以这里
# 必须把两行文案的每个字符都列进去，且留好改文案的余量（数字与常用标点）。
LOGO_TEXT = (
    "ImAuxia,welcome to my website！"
    "0123456789"
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    "，。、！？：；·…“”‘’（）()【】「」—–-'\""
)
ZEOSEVEN_ID = 92                                   # 得意黑
ZEOSEVEN_CSS = f"https://fontsapi.zeoseven.com/{ZEOSEVEN_ID}/main/result.css"
ZEOSEVEN_BASE = f"https://fontsapi.zeoseven.com/{ZEOSEVEN_ID}/main/"

# 首屏一定会渲染的字符 —— 用来决定预加载哪几片
PRELOAD_TEXT = "I'm Auxia，welcome to my website！ auxia 自我介绍 展墙 项目 联系方式 查看全部展品 回到首页"

BREAK = "<!-- font-preload -->"
HEADERS = {"User-Agent": UA}


# ---------------------------------------------------------------- 字符集
def collect_charset() -> str:
    chars: set[str] = set()
    for p in list(SITE.rglob("*.html")):
        chars.update(p.read_text(encoding="utf-8"))
    for p in list(DATA.glob("*.json")):
        if p.name.startswith("."):
            continue
        chars.update(p.read_text(encoding="utf-8"))
    # 数字 / 标点 / 常用符号 / 界面字符，保证动态拼接的文案也不缺字
    chars.update("0123456789%+-—–·×↻↗→←↑↓「」『』《》〈〉（）()【】[]，。、！？：；·…“”‘’")
    chars.update("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")
    chars.update("·/\\|_+=<>@#$&*^~`'\",.:;!?()[]{}")
    chars.update("件共第页张张幅随机展示全部回到跳到主内容关闭原推署名版权说明素材来源")
    chars.update("哇呀啊哦嗯哈嘻嘿诶呃啦吧呢吗")
    # 只保留可打印字符，去掉 JSON/HTML 的语法噪音没意义，保留即可（体积影响很小）
    return "".join(sorted(c for c in chars if c.isprintable() and c != "\n"))


# ---------------------------------------------------------------- 得意黑
def fetch_smiley() -> list[dict]:
    SMILEY_DIR.mkdir(parents=True, exist_ok=True)
    r = requests.get(ZEOSEVEN_CSS, headers=HEADERS, timeout=40)
    r.raise_for_status()
    css = r.text

    blocks = re.findall(r"@font-face\s*\{(.*?)\}", css, re.S)
    out_css: list[str] = []
    index: list[dict] = []
    n = 0

    for blk in blocks:
        m_url = re.search(r"url\(['\"]?\./([^'\")]+)['\"]?\)", blk)
        if not m_url:
            continue
        remote = m_url.group(1)
        local_name = f"smiley-{n:02d}.woff2"
        dest = SMILEY_DIR / local_name
        if not dest.is_file() or dest.stat().st_size == 0:
            fr = requests.get(ZEOSEVEN_BASE + remote, headers=HEADERS, timeout=60)
            if not fr.ok:
                print(f"  [warn] 分片下载失败 {remote} -> {fr.status_code}", file=sys.stderr)
                continue
            dest.write_bytes(fr.content)
        n += 1

        ranges = re.search(r"unicode-range\s*:\s*([^;]+);", blk)
        new_blk = re.sub(r"url\(['\"]?\./[^'\")]+['\"]?\)",
                         f"url('../fonts/smiley/{local_name}')", blk)
        out_css.append("@font-face {" + new_blk.strip() + "}")
        index.append({
            "file": local_name,
            "bytes": dest.stat().st_size,
            "ranges": parse_ranges(ranges.group(1)) if ranges else [],
        })
        print(f"  {local_name}  {dest.stat().st_size/1024:6.1f}KB")

    # 正文字体：自托管子集
    out_css.append(
        "@font-face{\n"
        '  font-family:"SourceHanSansCN-auxia";\n'
        '  src:url("../fonts/body-subset.woff2") format("woff2");\n'
        "  font-weight:400;font-style:normal;font-display:swap;\n"
        "}"
    )

    # 开屏展示字体：也自托管
    out_css.append(
        "@font-face{\n"
        '  font-family:"ZhanKuXiaoWei-auxia";\n'
        '  src:url("../fonts/logo-subset.woff2") format("woff2");\n'
        "  font-weight:400;font-style:normal;font-display:block;\n"
        "}"
    )

    CSS_FILE.write_text(
        "/* 自动生成，请勿手改 —— 见 tools/build_fonts.py */\n"
        "/* 得意黑 Smiley Sans Oblique · OFL-1.1 · 来源 zeoseven FontsAPI #92 */\n"
        + "\n".join(out_css) + "\n", encoding="utf-8")
    return index


def parse_ranges(spec: str) -> list[tuple[int, int]]:
    out = []
    for part in spec.split(","):
        part = part.strip().upper().replace("U+", "")
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            try:
                out.append((int(a, 16), int(b, 16)))
            except ValueError:
                continue
        else:
            try:
                v = int(part, 16)
                out.append((v, v))
            except ValueError:
                continue
    return out


def preload_chunks(index: list[dict], text: str) -> list[str]:
    need: list[str] = []
    for ch in dict.fromkeys(text):
        cp = ord(ch)
        for item in index:
            if any(a <= cp <= b for a, b in item["ranges"]):
                if item["file"] not in need:
                    need.append(item["file"])
                break
    return need


# ---------------------------------------------------------------- 正文子集
def subset_body(charset: str) -> Path | None:
    if not SRC_BODY_TTF.is_file():
        print(f"[error] 找不到正文字体源：{SRC_BODY_TTF}", file=sys.stderr)
        return None
    FONTS.mkdir(parents=True, exist_ok=True)
    CHARSET_FILE.write_text(charset, encoding="utf-8")
    out = FONTS / "body-subset.woff2"
    cmd = [
        sys.executable, "-m", "fontTools.subset",
        str(SRC_BODY_TTF),
        f"--text-file={CHARSET_FILE}",
        f"--output-file={out}",
        "--flavor=woff2",
        "--layout-features=*",
        "--no-hinting",
        "--desubroutinize",
        "--drop-tables+=DSIG",
        "--name-IDs=*",
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        print(res.stdout[-2000:], res.stderr[-2000:], file=sys.stderr)
        return None
    return out


def subset_logo() -> Path | None:
    """把 4MB 的站酷小薇 LOGO 体子集化成开屏那两行字用得上的部分。

    注意 --text 是**通过临时文件**传的（--text-file），不用命令行实参：
    文案里有单引号、感叹号、全角标点，走 shell 会被纠结一轮转义。"""
    if not SRC_LOGO_OTF.is_file():
        print(f"[error] 找不到 LOGO 字体源：{SRC_LOGO_OTF}", file=sys.stderr)
        return None
    FONTS.mkdir(parents=True, exist_ok=True)
    tmp = FONTS / ".logo-charset.txt"
    tmp.write_text(LOGO_TEXT, encoding="utf-8")
    out = FONTS / "logo-subset.woff2"
    cmd = [
        sys.executable, "-m", "fontTools.subset",
        str(SRC_LOGO_OTF),
        f"--text-file={tmp}",
        f"--output-file={out}",
        "--flavor=woff2",
        "--layout-features=*",
        "--no-hinting",
        "--desubroutinize",
        "--drop-tables+=DSIG",
        "--name-IDs=*",
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    tmp.unlink(missing_ok=True)
    if res.returncode != 0:
        print(res.stdout[-2000:], res.stderr[-2000:], file=sys.stderr)
        return None
    return out


# ---------------------------------------------------------------- 注入 HTML
def inject_preload(files: list[str]) -> None:
    """把「首屏要用的那几个字体分片」的 preload 写进各页 <head>。

    ⚠️ 这里曾经有个静默失效的写法，值得记下来：
       原实现是 re.sub(BREAK + ".*?" + BREAK, ...) —— 要求文件里**两个**标记。
       但实际上每个页面的 HTML 里只有**一个** BREAK（它是插入点，不是一对括号）。
       于是正则永远匹配不上，write_text 又把原样内容写了回去：日志照常打印
       「preload -> index.html (5 片)」，文件里却一个字都没加。
       这种「日志说做了、其实没做」的失败最难发现 —— 它是被这轮新加 logo 字体时
       顺手 grep 一下才暴露的：站从上线起就**从来没预加载过字体**。

       现在两种情况都处理：
         · 已经有成对的标记（跑过第二遍之后）-> 替换中间那段，保证幂等
         · 只有一个标记（首次）-> 就地展开成成对的标记
    """
    for p in SITE.rglob("*.html"):
        # dist/ 是 build_site.py 生成出来的，真源在站根目录；
        # build/ 是本地暂存。都不该被这里改写，否则会重复注入。
        if any(part in ("node_modules", "dist", "build") for part in p.parts):
            continue
        html = p.read_text(encoding="utf-8")
        if BREAK not in html:
            continue
        depth = len(p.relative_to(SITE).parts) - 1
        prefix = "../" * depth
        lines = [f'<link rel="preload" href="{prefix}assets/fonts/body-subset.woff2" as="font" '
                 f'type="font/woff2" crossorigin>',
                 # 开屏第一眼就是它，不预载的话打字机会先闪一下正文字体再换字形
                 f'<link rel="preload" href="{prefix}assets/fonts/logo-subset.woff2" as="font" '
                 f'type="font/woff2" crossorigin>']
        for f in files:
            lines.append(f'<link rel="preload" href="{prefix}assets/fonts/smiley/{f}" as="font" '
                         f'type="font/woff2" crossorigin>')
        block = "\n".join([BREAK] + lines + [BREAK])

        if html.count(BREAK) >= 2:
            html = re.sub(re.escape(BREAK) + r".*?" + re.escape(BREAK), block,
                          html, count=1, flags=re.S)
        else:
            html = html.replace(BREAK, block, 1)

        p.write_text(html, encoding="utf-8")
        print(f"  preload -> {p.relative_to(SITE)}  ({len(files) + 2} 条)")


def main() -> None:
    print("== 扫描全站文案，生成字符集 ==")
    charset = collect_charset()
    print(f"  {len(charset)} 个不同字符")

    print("\n== 正文子集化（cmdysj.ttf -> body-subset.woff2）==")
    body = subset_body(charset)
    if body:
        print(f"  {SRC_BODY_TTF.stat().st_size/1e6:.2f}MB -> {body.stat().st_size/1024:.0f}KB")

    print("\n== 开屏 LOGO 字体子集化（站酷小薇 -> logo-subset.woff2）==")
    logo = subset_logo()
    if logo:
        print(f"  {SRC_LOGO_OTF.stat().st_size/1e6:.2f}MB -> {logo.stat().st_size/1024:.1f}KB"
              f"  （只留 {len(set(LOGO_TEXT))} 个字符）")

    print("\n== 标题字体（得意黑 #92）==")
    index = fetch_smiley()
    total = sum(i["bytes"] for i in index)
    print(f"  共 {len(index)} 片，合计 {total/1e6:.2f}MB")

    need = preload_chunks(index, PRELOAD_TEXT)
    print(f"\n== 首屏需要预加载的分片：{need} ==")
    (DATA / "font-preload.json").write_text(json.dumps(need, ensure_ascii=False, indent=1), encoding="utf-8")
    inject_preload(need)

    print("\n完成：assets/css/fonts.css")


if __name__ == "__main__":
    main()
