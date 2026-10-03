# -*- coding: utf-8 -*-
"""由 data/site.json 生成 4 个项目占位页 projects/<slug>/index.html

将来把真实的 HTML 程序丢进 projects/<slug>/ 覆盖即可，主页与路由都不需要改。
"""
from __future__ import annotations

import json
import sys

from common import DATA, ORIGIN_TOKEN, SITE

TPL = """<!DOCTYPE html>
<html lang="zh-CN" data-bucket="mist">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{title} — Auxia 的项目</title>
<meta name="description" content="{desc}">
<meta name="theme-color" content="#f5f8fc">
<link rel="canonical" href="{origin}/projects/{slug}/">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Auxia">
<meta property="og:title" content="{title} — Auxia">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="{origin}/projects/{slug}/">
<meta property="og:image" content="{origin}/assets/img/icons/og-cover.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="../../assets/img/icons/favicon.ico" sizes="any">
<link rel="icon" type="image/svg+xml" href="../../assets/img/icons/favicon.svg">
<link rel="apple-touch-icon" href="../../assets/img/icons/apple-touch-icon.png">
<!-- font-preload -->
<link rel="stylesheet" href="../../assets/css/variables.css">
<link rel="stylesheet" href="../../assets/css/fonts.css">
<link rel="stylesheet" href="../../assets/css/site.css">
</head>

<body data-bucket="mist" data-root="../../">
<a class="skip" href="#main">跳到主内容</a>

<div id="bg" aria-hidden="true">
  <img class="bg-img" alt="">
  <div class="veil"></div>
  <div class="credit" hidden></div>
</div>
<div id="danmaku" aria-hidden="true"></div>
<div id="particles" aria-hidden="true"></div>

<nav class="nav">
  <div class="wrap">
    <a class="brand" href="../../"><span class="dot"></span>auxia</a>
    <div class="nav-links">
      <a href="../../#walls">展墙</a>
      <a href="../../#projects">项目</a>
      <a href="../../gallery/">全部展品</a>
      <a href="../../#contact">联系方式</a>
    </div>
  </div>
</nav>

<main id="main">
  <article class="{pagecls}">
    <a class="crumb" href="../../#projects">← 回到项目列表</a>
    <div class="tag">{tag}</div>
    <h1>{title}</h1>
    <p class="lead">{summary}</p>
    <span class="status">{status}</span>
{extra}
    <a class="back" href="../../">← 回到首页</a>
  </article>
</main>

<script src="../../assets/js/core.js"></script>
<script src="../../assets/js/tiles.js"></script>
</body>
</html>
"""

SLOT = """    <div class="slot">
      <b>SLOT RESERVED · /projects/{slug}/</b>
      这个位置是给真实程序留的。等 {title} 做出来，把它的 HTML 直接放进
      <code>projects/{slug}/</code> 覆盖本文件即可，主页和路由都不需要动。
    </div>
"""

# 这里原本有个 EXTERNAL 分支：obsidian 项目页会外链到站主的坚果云仓库。
# 站主要求不把私密信息挂到公网，已连同 site.json 里的 nutstore 联系方式一起删除，
# projects/obsidian/ 整个目录也删了。
# 教训：那个分支写的是 site["contact"]["items"][2]["url"] —— 按**下标**取联系方式。
# 一旦删掉items里的第三项，这里立刻 IndexError。以后要取联系方式请按 key 查。

# 内嵌一个真正能玩的 Demo。
#
# 为什么是 iframe：那个小程序自带一整套样式（深色主题、自己的布局与字号）和状态，
# 直接搬进来会和本站的样式表互相渗透 —— 本站的 body / button / .card / .slot
# 都会顺着层叠糊到它身上。iframe 给它一个干净的沙箱，两边都不用改代码。
#
# 注意 embed 里的 src 是**相对本页**的（同目录），所以写相对路径最稳：
# 换成根绝对路径的话，本地 file:// 预览会挂、而目录路由又没必要。
EMBED = """    <div class="embed">
      <div class="embed-head">
        <b>{head}</b>
        <span class="sub">{sub}</span>
        <a class="open" href="{file}" target="_blank" rel="noopener">新标签打开 ↗</a>
      </div>
      <div class="embed-box">
        <iframe src="{file}" title="{iframe_title}"
                loading="lazy" referrerpolicy="no-referrer"></iframe>
      </div>
    </div>
"""

# slug -> (要内嵌的文件, 卡片标题, 副标题, iframe 无障碍标题)
EMBEDS = {
    "liar-game": (
        "liar-card.html", "Liar Card",
        "说谎者之牌 · 按「声明」结算的双人博弈",
        "Liar Card · 说谎者之牌（可玩 Demo）",
    ),
    "starcraft3": (
        "sc3.html", "Star Craft III",
        "星际争霸 III · 回合制博弈（同人二创）",
        "Star Craft III · 回合制博弈（可玩 Demo）",
    ),
}

# 哪些项目页要放宽 / 放到多宽（760px 装不下能玩的界面）
#
# wide  = 1020px，够 liar-card（自带响应式，620px 以下另有布局）
# ultra = 1200px（= --wrap 满宽），给 starcraft3 —— 那个程序 #app 写死了
#         min-width:1024px，再留 52px 内边距，1020px 的框里必然出横向滚动条。
PAGECLS = {
    "liar-game": "wrap proj-page wide",
    "starcraft3": "wrap proj-page ultra",
}


def main() -> None:
    site = json.loads((DATA / "site.json").read_text(encoding="utf-8"))
    projects = site.get("projects") or []
    if not projects:
        print("[error] site.json 里没有 projects", file=sys.stderr)
        sys.exit(1)

    for p in projects:
        # 从站内路由反推 slug（site.json 里的 href 是相对主页的）
        slug = p["slug"]
        title = p["title"]
        summary = p["summary"]
        desc = f"{title} — {summary}"
        if slug in EMBEDS:
            file, head, sub, iframe_title = EMBEDS[slug]
            extra = EMBED.format(file=file, head=head, sub=sub, iframe_title=iframe_title)
        else:
            extra = SLOT.format(slug=slug, title=title)

        html = TPL.format(
            slug=slug, title=title, tag=p["tag"], status=p["status"],
            summary=summary, desc=desc, extra=extra, origin=ORIGIN_TOKEN,
            pagecls=PAGECLS.get(slug, "wrap proj-page"),
        )
        out = SITE / "projects" / slug / "index.html"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(html, encoding="utf-8")
        print(f"  generated projects/{slug}/index.html")


if __name__ == "__main__":
    main()
