# -*- coding: utf-8 -*-
"""公共配置与工具函数。

单一数据源约定：
  - 展品  -> 007 WALLS 展墙🖼️ 文件夹（只读）
  - 文字  -> data/site.json
  - 样式  -> assets/css/variables.css
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import unicodedata
from pathlib import Path

# ---------------------------------------------------------------- 路径
SITE = Path(__file__).resolve().parent.parent          # auxia-site/
ROOT = SITE.parent                                       # 工作区

# 素材库（笔记库里的展墙目录）的解析顺序：
#   1) 环境变量 AUXIA_WALLS
#   2) 同目录下的 local.json（**已进 .gitignore**，本机路径写这儿，不进公开仓库）
#   3) 项目同级的 auxia-notes/007 WALLS 展墙🖼️ —— 别人克隆下来把素材放这儿就行
#   4) 都没有 → 返回候选第一项，让下游明确报错，而不是静默跳过一个墙
#
# ⚠️ 这里**故意不写本机绝对路径**：仓库是公开的，写进去等于公开用户名与目录结构。
#    本机用固定路径就写进 tools/local.json，形如：
#        { "walls": "D:/.../007 WALLS 展墙🖼️", "illust": "D:/.../random_illust" }
ENV_WALLS = "AUXIA_WALLS"
_LOCAL_CFG = Path(__file__).resolve().parent / "local.json"


def _local_conf(key: str) -> Path | None:
    """读 tools/local.json 里的一个路径项（该文件已进 .gitignore）。"""
    try:
        raw = json.loads(_LOCAL_CFG.read_text(encoding="utf-8"))
    except Exception:
        return None
    val = str(raw.get(key, "") or "").strip()
    return Path(val) if val else None


def _pick(env_key: str, conf_key: str, candidates: list[Path]) -> Path:
    """按 环境变量 → local.json → 候选目录 的顺序解析，全部落空则返回第一个候选。"""
    env_val = os.environ.get(env_key, "").strip()
    if env_val and Path(env_val).is_dir():
        return Path(env_val)
    from_conf = _local_conf(conf_key)
    if from_conf and from_conf.is_dir():
        return from_conf
    return next((p for p in candidates if p.is_dir()), candidates[0])


def pick_path(env_key: str, conf_key: str, candidates: list[Path]) -> Path:
    """同 _pick，但对**文件**也成立（_pick 只认目录）。

    build_fonts / build_icons 要的是具体字体文件，不是目录，所以单独给一个。
    解析顺序一致：环境变量 → tools/local.json → 候选文件 → 候选所在目录。
    """
    env_val = os.environ.get(env_key, "").strip()
    if env_val and Path(env_val).is_file():
        return Path(env_val)
    from_conf = _local_conf(conf_key)
    if from_conf and from_conf.is_file():
        return from_conf
    return next((p for p in candidates if p.is_file()), candidates[0])


WALLS = _pick(ENV_WALLS, "walls", [
    ROOT / "auxia-notes" / "007 WALLS 展墙🖼️",
    SITE / "007 WALLS 展墙🖼️",
])

DATA = SITE / "data"
IMG = SITE / "assets" / "img"
PHOTOS = IMG / "photos"
POSTERS = IMG / "posters"
ILLUST = IMG / "illust"
ICONS = IMG / "icons"

# ---------------------------------------------------------------- 对外地址
# canonical / og:url / og:image / og-cover 上印的域名统一从这里取，改一处全站同步。
#
# ⚠️ 为什么不是 https://auxia.pages.dev：
#   那个域名**已经被别人占用了** —— 实测返回 HTTP 200，是别人的站。
#   canonical 指过去等于告诉搜索引擎「正版在人家那里」，比不写还糟。
#
# 2026-10-02 起用站主自己建的 Cloudflare Pages 项目 auxiaweb（实测 HTTP 200）。
# 上一版是内置发布通道给的 auxia-site.app.workbuddy.host —— 那份已按站主要求下线，
# 两个地址内容相同，同时留着只会让「哪个是正式地址」一直含糊。
#
# 改这里之后要按顺序重跑（og-cover 图片上也印着域名）：
#   build_icons.py → gen_project_pages.py → build_fonts.py → build_site.py
# ⚠️ dist/ 是所有宿主共用的同一份产物：改这一行 = 所有宿主一起改，不是只改某一个。
PUBLIC_ORIGIN = "https://auxiaweb.pages.dev"

# 手写/生成页面里代表上面这个域名的**占位符**，由 build_site.py 在装配 dist/ 时注入。
#
# 为什么不让页面直接写死域名：`PUBLIC_ORIGIN` 改了之后，只有**从常量生成**的页面
# 会跟着变（项目页），**人写的**页面不会（首页、展墙）—— 本项目真的这么漏过一次，
# 而当时的自检只断言了 index.html 的 canonical，所以「改一处全站同步」这句话
# 对首页来说一直是假的，直到换域名那天才露出来。
#
# 约定：**源码 .html 里不许出现绝对站点域名**，一律写 {{ORIGIN}}。
# build_site.py 会替换它，并在产物里残留占位符时直接报错退出。
ORIGIN_TOKEN = "{{ORIGIN}}"

# 背景插画的离线素材来源（站主自备）。原来是运行时抓 isouweb，现已换成本地图。
# 素材不随仓库分发（体积大 + 版权在画师），克隆者自备。
# 解析顺序同 WALLS：AUXIA_ILLUST → local.json 的 illust → 项目同级 auxia-assets/random_illust。
ENV_ILLUST = "AUXIA_ILLUST"
ILLUST_SRC = _pick(ENV_ILLUST, "illust", [
    ROOT / "auxia-assets" / "random_illust",
    SITE / "random_illust",
])
ILLUST_ALT = ROOT / "auxia-assets" / "random_illust"

# 站主手工提供的封面：展品名 -> 本地原图文件名
# 优先于联网抓取（fetch_posters 里 source == "manual" 时直接读本地文件）。
# 只记**文件名**，目录由 MANUAL_POSTERS_DIR 决定，仓库里因此没有任何本机路径。
# 解析顺序：AUXIA_MANUAL_POSTERS → local.json 的 manual_posters → 插画目录同级的 manual-posters。
ENV_MANUAL_POSTERS = "AUXIA_MANUAL_POSTERS"
MANUAL_POSTERS_DIR = _pick(ENV_MANUAL_POSTERS, "manual_posters", [
    ILLUST_SRC.parent / "manual-posters",
])

MANUAL_POSTERS = {
    "舞萌maimaiDX": MANUAL_POSTERS_DIR / "maimai-dx.jpg",
    "phigros":      MANUAL_POSTERS_DIR / "phigros.png",
    "伪物":         MANUAL_POSTERS_DIR / "伪物.png",
    "匙之咒":       MANUAL_POSTERS_DIR / "匙之咒.jpg",
    "全员同学会":   MANUAL_POSTERS_DIR / "全员同学会.jpg",
    "铁花飞":       MANUAL_POSTERS_DIR / "铁花飞.jpg",
}

# 站主要求从展墙上拿掉的条目。
# 笔记库是只读的（绝不改原文件），所以「不展」这件事必须由这里控制。
EXCLUDE_ITEMS = {"BVN", "alice in cradle", "胭脂"}

# 抓取外部数据时用的 UA。**不要在这里写真实联系方式** —— 仓库是公开的。
UA = "auxia-site-builder/1.0 (+personal site)"

# ---------------------------------------------------------------- 五面墙
# bucket 决定该墙在页面上使用哪个色系（见 build_illust_pool.py）
# 注意：这里**不写 desc**。展品区只要名称与数量，多余的解释性文字一律不渲染。
WALL_DEFS = [
    {
        "id": "photo", "dir": "摄影作品展示", "name": "摄影作品展示", "en": "Photography",
        "bucket": "warm", "kind": "image",
    },
    {
        "id": "anime", "dir": "动漫展墙", "name": "动漫展墙", "en": "Anime",
        "bucket": "pink", "kind": "title",
    },
    {
        "id": "game", "dir": "游戏展墙", "name": "游戏展墙", "en": "Games",
        "bucket": "aqua", "kind": "title",
    },
    {
        "id": "book", "dir": "书籍展墙", "name": "书籍展墙", "en": "Books",
        "bucket": "cream", "kind": "title",
    },
    {
        "id": "music", "dir": "音乐展墙", "name": "音乐展墙", "en": "Music",
        "bucket": "mist", "kind": "title",
    },
]

# 文字墙的海报来源表（人工校对，宁缺毋滥）
# key = 展品原名，value = (来源, 检索词[, 命中校验串])
#   来源: manual | anilist | steam | itunes | douban
#   命中校验串：源站用自己的写法（繁体 / 日文原题），拿它做「标题包含」校验；
#              不写则用检索词本身。宁可回落题名卡，也不配一张错的封面。
POSTER_QUERIES = {
    # ---------------- 动漫 ----------------
    "我推的孩子": ("anilist", "Oshi no Ko"),
    "辉夜大小姐想让我告白": ("anilist", "Kaguya-sama wa Kokurasetai"),
    "DEATH NOTE": ("anilist", "Death Note"),
    "迷宫饭": ("anilist", "Dungeon Meshi"),
    "RE 0 从零开始的异世界生活": ("anilist", "Re:Zero kara Hajimeru Isekai Seikatsu"),
    "芙莉莲": ("anilist", "Sousou no Frieren"),
    "进击的巨人": ("anilist", "Shingeki no Kyojin"),
    "超时空辉夜姬": ("anilist", "Chou Kaguya-hime"),
    "命运石之门": ("anilist", "Steins;Gate"),
    "石纪元": ("anilist", "Dr. Stone"),
    # ---------------- 游戏 ----------------
    # Steam 搜索接口会限流，这里直接给 appid + 展示名，稳定且不会认错
    "空洞骑士": ("steam", "appid:367520", "Hollow Knight"),
    "奥日": ("steam", "appid:387290", "Ori and the Blind Forest: Definitive Edition"),
    "黑暗之魂 3": ("steam", "appid:374320", "DARK SOULS III"),
    "只狼": ("steam", "appid:814380", "Sekiro: Shadows Die Twice"),
    "蔚蓝": ("steam", "appid:504230", "Celeste"),
    "kingdom rush": ("steam", "appid:246420", "Kingdom Rush"),
    "《底特律·变人》": ("steam", "appid:1222140", "Detroit: Become Human"),
    "传说之下": ("steam", "appid:391540", "Undertale"),
    "传送门": ("steam", "appid:620", "Portal 2"),
    "星际拓荒": ("steam", "appid:753640", "Outer Wilds"),
    "邪恶铭刻": ("steam", "appid:1092790", "Inscryption"),
    "超阈限空间": ("steam", "appid:1049410", "Superliminal"),
    "noita": ("steam", "appid:881100", "Noita"),
    # 街机音游两作：站主自己给了图标，不再联网抓
    "舞萌maimaiDX": ("manual", ""),
    "phigros": ("manual", ""),
    # ---------------- 音乐 ----------------
    # 术力口 / 同人曲居多，iTunes 曲库覆盖有限；命中就配图，不命中一律题名卡
    "拼凑的断音": ("itunes", "ツギハギスタッカート"),
    "像神一样呐": ("itunes", "神っぽいな"),
    "妄想感伤代偿联盟": ("itunes", "妄想感傷代償連盟"),
    "OTTAMA GAZER": ("itunes", "OTTAMA GAZER"),
    "月詠に鳴る": ("itunes", "月詠に鳴る"),
    "鸟之诗animenz钢琴版": ("itunes", "鳥の詩 Lia", "鳥の詩"),
    "Bite 咬合力": ("itunes", "BITE HOYO-MiX", "BITE"),
    "ReDreaming Angel": ("itunes", "ReDreaming Angel"),
    "原色": ("itunes", "原色 HOYO-MiX", "原色"),
    "damidami": ("itunes", "ダミダミ"),
    "mycurse ，myfate": ("itunes", "My Curse My Fate"),
    "所以我放弃了音乐": ("itunes", "だから僕は音楽を辞めた"),
    "雨和卡布奇诺": ("itunes", "雨とカプチーノ"),
    "il vento d‘oro": ("itunes", "il vento d'oro JoJo", "il vento d'oro"),
    "缸": ("itunes", "缸"),
    "杀死那个石家庄人": ("itunes", "杀死那个石家庄人"),
    "Out of Time - The Weeknd": ("itunes", "Out of Time The Weeknd", "Out of Time"),
    "米兰的小铁匠": ("itunes", "米蘭的小鐵匠", "米蘭的小鐵匠"),
    "暗号": ("itunes", "暗號 周杰倫", "暗號"),
    "夜的第七章": ("itunes", "夜的第七章"),
    # 站主自己给了配图的三首（iTunes 里没有可靠条目）
    "伪物": ("manual", ""),
    "匙之咒": ("manual", ""),
    "全员同学会": ("manual", ""),
    "铁花飞": ("manual", ""),
    # ---------------- 书籍 ----------------
    # 豆瓣有中文版封面；拿不到就回落题名卡（fetch_posters 会自己判断）
    "悉达多": ("douban", "悉达多"),
    "德米安": ("douban", "德米安"),
    "三体系列": ("douban", "三体"),
}


# ---------------------------------------------------------------- 工具
def slugify(text: str) -> str:
    """生成稳定、URL 安全的 id。中文保留（浏览器与 CF Pages 都支持）。"""
    text = unicodedata.normalize("NFKC", text).strip()
    text = re.sub(r"^\[\[|\]\]$|^《|》$", "", text)
    text = re.sub(r"[\s/\\:*?\"<>|#%&{}$!'@+`=]+", "-", text)
    text = re.sub(r"-{2,}", "-", text).strip("-")
    return text or hashlib.md5(text.encode()).hexdigest()[:8]


def read_text(path: Path) -> str:
    for enc in ("utf-8-sig", "utf-8", "gbk"):
        try:
            return path.read_text(encoding=enc)
        except UnicodeDecodeError:
            continue
    return path.read_text(encoding="utf-8", errors="replace")


def parse_wall_list(md_path: Path) -> list[str]:
    """解析展示.md：兼容 [[双链]] / 纯文本 / 首尾空行，去重保序。"""
    if not md_path.is_file():
        return []
    out: list[str] = []
    seen: set[str] = set()
    for raw in read_text(md_path).splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith(">"):
            continue
        # [[A|B]] -> A ；[[A]] -> A
        for m in re.finditer(r"\[\[([^\]]+)\]\]", line):
            inner = m.group(1).split("|")[0].strip()
            if inner and inner not in seen:
                seen.add(inner)
                out.append(inner)
        # 去掉双链后剩下的纯文本
        leftover = re.sub(r"\[\[[^\]]+\]\]", "", line).strip()
        if leftover and leftover not in seen:
            seen.add(leftover)
            out.append(leftover)
    return out


def hex_from_rgb(rgb: tuple[int, int, int]) -> str:
    return "#%02x%02x%02x" % rgb


def rgb_from_hex(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def illust_dir() -> Path:
    """背景插画素材目录（站主自备）。缺失时明确报错，不静默降级。"""
    return ILLUST_SRC if ILLUST_SRC.is_dir() else ILLUST_ALT


def ensure_dirs() -> None:
    for d in (DATA, IMG, PHOTOS, POSTERS, ILLUST, ICONS,
              PHOTOS / "thumb", PHOTOS / "full"):
        d.mkdir(parents=True, exist_ok=True)
