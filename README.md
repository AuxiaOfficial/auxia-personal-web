# Auxia · 个人站

a new programmer's trying, producted by agent ｜ 线上：<https://auxiaweb.pages.dev>
（仓库简介另见 [`docs/ABOUT.md`](docs/ABOUT.md)）

二次元日系美学，干净、明亮、有空气感。单页滚动主页 + 独立展墙页 + 4 个项目占位页。

底座是 **纯静态 Cloudflare Pages**：零后端、零运行时依赖。
背景插画已全部离线压成同站 WebP，所以早先那套「取图 Worker / Pages Functions」
（`functions/` + `shared/` + `workers/`）已经整体移除。

> **唯一的例外**：背景弹幕里 40% 的文案来自一言（`v1.hitokoto.cn`）。这是全站
> **唯一**的外部网络请求，可以在 `data/site.json` 的 `banner.hitokoto.enabled`
> 里一键关掉 —— 关掉之后站点重新回到「零外部请求」。自检里有白名单守卫盯着这条线。

- 主页 `/`：开屏 → 自我介绍（人格模型横铺 + 爱好一排）→ 展墙橱窗 → 项目 → 联系方式
- 展墙总页 `/gallery/`：摄影 / 动漫 / 音乐 / 书籍 / 游戏，五面墙一次逛完
- 项目页 `/projects/<slug>/`：`liar-game` 已**内嵌**可玩 Demo（iframe），其余 3 个仍是占位页
- `404.html`：日系兜底页

界面截图见 [`docs/screenshots/`](docs/screenshots/)（`01` 开屏 → `11` 404，共 11 张，
按本版界面重拍：锐圆角、无气泡弹幕、横向人格卡 + 爱好一排；`10-project` 为
liar-game 内嵌 Demo + 液态玻璃卡片的最新样张）。

---

## 一、30 秒上手

> 🚫 **不要双击 `index.html` 打开本站。** 直接双击走的是 `file://` 协议，页面必然坏成
> 「没图片、点项目打不开、一片空白」，而这**不是站点的问题**。实测 `file://` 下的三个症状：
>
> | 你看到的 | 原因 |
> |---|---|
> | 没有背景图 | 背景图是**根绝对路径** `/assets/...`，`file://` 下解析成 `file:///C:/assets/...` |
> | 展品卡一片空白 | `core.js` 用 `fetch()` 读 `data/*.json`，浏览器**禁止 `file://` 页面发起 fetch**（origin 是 `null`）→ 三份数据全读不到 |
> | 点项目链接打不开 | `file://` 不做目录索引，`./projects/liar-game/` 只会显示文件列表，不会跳到 `index.html` |
>
> 实测对比：同一个 `dist/index.html`，`file://` 下 `<img>` 只有 1 个（还是没 `src` 的）、展品卡 0 张；
> 走 HTTP 则 11 个 `<img>`、橱窗 10 件。**必须起服务器**（第 3 步）。

```bash
# 1) 只重建数据（素材变了才需要跑）
python tools/build_gallery.py          # 扫 007 展墙 -> data/gallery.json
python tools/optimize_photos.py        # 摄影原图 -> WebP + 主色 + 色系分桶
python tools/fetch_posters.py          # 抓展品封面（不命中才回落题名卡）
python tools/build_illust_pool.py      # 本地背景插画 -> WebP + 色系池
python tools/build_fonts.py            # 字体下载 + 子集化 + 注入预加载
python tools/build_icons.py            # 全套图标 + og-cover

# 2) 装配可部署产物
python tools/build_site.py             # -> dist/

# 3) 本地预览（脚本会打印真实端口；这行是唯一正确的"看网站"方式）
python tools/preview.py                # http://127.0.0.1:8788

# 4) 自检（需要 jsdom；站点本身零依赖）
node tools/smoke-test.cjs

# 5) 发布到 Cloudflare Pages（只有一个宿主了，详见「九、部署」）
python tools/make_dist_zip.py          # -> build/dist-site.zip，拖进 Pages 上传区
```

> `tools/gen_project_pages.py` 由 `data/site.json` 生成 4 个项目页。
> **顺序要求**：`gen_project_pages.py` → `build_fonts.py`
> （后者会往页面里的 `<!-- font-preload -->` 标记注入字体预加载，重生成页面会覆盖它）。

> `build_fonts.py` 的正文子集化依赖 `fontTools` + `brotli`，它们**不在**站点的运行时依赖里，
> 只在构建时需要。用一个隔离的虚拟环境跑就行，别往站点里加 `package.json`：
>
> ```bash
> python -m venv .venv && .venv/Scripts/pip install fonttools brotli requests
> .venv/Scripts/python tools/build_fonts.py
> ```

> ⚠️ **别把构建脚本的 stdout 接到 `head` / `tail` 上**。
> 这些脚本是**边拷贝边打印**进度的，管道提前关闭会让它吃到 SIGPIPE 半路死掉，
> `dist/` 就停在一半（缺 `data/site.json` 之类），而报错是静默的。
> 症状会伪装成「页面自检突然挂了几个」这种莫名其妙的样子。
> 要看简短输出就跑完之后 `| tail`，或者直接 `>/dev/null`。

---

## 二、目录职责

```
auxia-site/
├── index.html                  主页（文案直接写死，爬虫不执行 JS）
├── gallery/index.html          展墙总页
├── projects/<slug>/index.html  由 gen_project_pages.py 生成
├── projects/liar-game/liar-card.html   内嵌 Demo（自包含单文件，液态玻璃版）
├── 404.html
├── _headers / _redirects       Pages 的响应头与重定向
├── manifest.webmanifest        由 build_icons.py 生成
├── assets/
│   ├── css/variables.css       ★ 全站唯一的样式来源（色板、五桶、尺度、字号阶梯）
│   ├── css/site.css            布局与组件（含项目页的 .embed / .embed-box）
│   ├── css/fonts.css           由 build_fonts.py 生成，勿手改
│   ├── js/core.js              背景图系统 / 弹幕 / 粒子 / 矢量光标 / 顶栏 / 联系方式防爬
│   ├── js/tiles.js             展品卡片渲染 + 灯箱（主页与展墙页共用）
│   ├── js/home.js              大五人格五边形 + 展墙橱窗
│   ├── js/gallery.js           展墙总页渲染
│   ├── fonts/                  得意黑分片 + 思源黑体子集
│   └── img/{photos,posters,illust,icons}
├── data/                       ★ 运行时数据源
│   ├── site.json               文案 / 人格分 / 弹幕 / 项目 / 联系方式（密文）
│   ├── gallery.json            展品（由 build_gallery.py 生成）
│   ├── palette-pool.json       背景插画色系池（由 build_illust_pool.py 生成）
│   └── posters.json            封面元数据（含画师/来源署名）
├── docs/screenshots/           11 张界面截图（10-project 含内嵌 Demo + 玻璃卡片）
├── tools/                      构建与自检脚本
│   ├── build_*.py              素材 → data/*.json / 字体 / 图标 / 产物
│   ├── gen_project_pages.py    生成 4 个项目页（EMBED / EXTERNAL / SLOT 三选一）
│   ├── preview.py              本地预览，含虚拟探针路由（probe/diag/dm/sec/slow/geo/ptr）
│   ├── smoke-test.cjs          jsdom 自检（259 条），**默认查 dist/**
│   ├── make_dist_zip.py        打包 dist/ 成上传用 zip（带结构与体积自检）
│   ├── dist_manifest_hash.py   dist/ 全量内容哈希（用来证明自检不改产物）
│   ├── dm-invariant.js         弹幕几何不变式（函数体，给 browser-probe 跑）
│   └── browser-probe.cjs       真实浏览器驱动（CDP，零依赖；能用的环境里更好用）
└── dist/                       ★ 部署产物（build_site.py 生成）
```

> `index.html` / `404.html` / `gallery/index.html` 里的**绝对域名写成 `{{ORIGIN}}`**，
> 由 `build_site.py` 装配时注入（真源是 `tools/common.py` 的 `PUBLIC_ORIGIN`）。
> 别把它们改回写死的域名 —— 详见「九、部署」里那笔账。

**为什么不直接部署根目录**：根目录还有 `tools/`、`data/.poster-cache.json`
这类不该公开的东西。`build_site.py` 只把浏览器真正需要的搬进 `dist/`。

---

## 三、背景图系统（本版关键机制）

```
[离线·一次性]  tools/build_illust_pool.py
  <插画素材目录>\  10 张原图（站主挑的横构图，适配网页比例）
      -> 压成 WebP（最长边 1800，q=74）落到 assets/img/illust/*.webp
      -> 量化取主色（明度压进可用区间）-> 按色相分成五桶 -> data/palette-pool.json
      6.1MB -> 1.56MB

[运行时·前端]  core.js 的 initBackground()
  页面按 <body data-bucket> 拿到自己的色系 -> Auxia.pickBackground() 取一张
      -> 直接用它（同站资源）
      -> 数据取不到 / 池子里没图 就回落本地摄影（gallery.json 的 photo 墙，优先同色系）
      -> 连摄影都取不到 就纯 CSS 渐变
```

**没有后端了**：所有图都是同站 WebP，不存在「上游挂了」这一档，也就没有代理接口。
以前那套 `/api/img?id=` + Worker 实时压缩 + 边缘缓存的链路已整体删除。

### 取图为什么不是「按桶锁死」

早先的写法是**只从本页色系桶里取**，桶里不足 3 张才用全池补。池子小的时候这会让
「每刷新一次换一张」变成空话 —— 首页的暖橙桶里只剩 1 张，于是刷新多少次都是同一张，
看起来就是**「来来回回都是那几张」**。站主报过这个现象。

现在的规则（`Auxia.pickBackground`，是个纯函数，自检直接跑它）：

1. 本页色系桶的图**加权 3 倍**，所以更容易被先抽到，色系偏好还在；
2. 但整池都在候选里，**一轮把池子走完才重开** —— 不重复轮换；
3. 「已用过的 id」存在 `sessionStorage`，所以**刷新和翻页都接着上一张往下走**，
   而不是每页各抽各的。

> 自检里有一条直接钉住这个投诉：以首页色系连抽 30 次，必须出现 ≥6 张不同的图。
> 把这条逻辑改回「按桶锁死」，它会立刻报 `{"distinct":1,"poolSize":10}`。

### 三条必须记住的规则

1. **基调色 vs 强调色**：页面基调色由色系桶**固定**（刷新不变）；随机抽到的那张插画的
   实测主色只用作 **accent**（下划线、按钮、粒子、光标）。这样「每页固定色系」和
   「从插画取色」两个要求同时成立。想完全跟随图变化，改 `variables.css` 里的 `--base` 引用即可。
2. **兜底绝不允许开天窗**：数据 404 / 桶为空 / 图片裂了 —— 一律回落本地摄影；
   连 `gallery.json` 都取不到时用纯 CSS 渐变。想验证，加一个 `?imgfail=1` 就行。
3. **`gallery.json` 里的素材路径一律 root-absolute（`/assets/...`）**。
   这份 JSON 会被 `/`（0 层）、`/gallery/`（1 层）、`/projects/<slug>/`（2 层）三种深度的
   页面消费，存裸相对路径必炸。`build_gallery.py` 里的 `rootabs()` 是唯一的归一化入口，
   前端因此**不再拼 `ROOT` 前缀** —— 加新素材时别在前端手动拼路径。
   改完务必跑一遍自检，里面有专门的守卫。

> **accent 的明度会被压进 `[0.34, 0.72]`**（`build_illust_pool.py` 的 `usable_accent`）。
> 上一版有张深色插画抽到 `#100700`（最亮通道只有 16/255），光标环、下划线、导航圆点
> 全成了黑色，落在明亮的日系基调上像一块脏斑。自检里有「不许近黑」的守卫。

### 五桶与页面对应

| 桶 | 基调 | 用在哪 |
|---|---|---|
| `warm` 暖橙 | `#fdf8f2` | 主页 |
| `pink` 粉紫 | `#fdf7fb` | 动漫墙 |
| `aqua` 冷青 | `#f4fbfa` | 游戏墙、展墙总页 |
| `cream` 米白 | `#fdfaf2` | 书籍墙 |
| `mist` 灰蓝 | `#f5f8fc` | 项目页、404 |

色系桶**只管页面的 `--paper / --base / --sheen`**（这一层依旧是固定的），
背景图那一边只把它当**偏好**。所以某个桶里没有图也不影响页面观感 ——
`cream` 现在就是空的，书籍墙会从全池里取，而且照样轮换。

---

## 四、素材与版权

| 素材 | 来源 | 处理 |
|---|---|---|
| 摄影作品 | `007 WALLS 展墙🖼️/摄影作品展示/` 12 张自摄 | WebP 压缩 57.6MB → 2.2MB |
| 动漫封面 | AniList GraphQL | 抓不到才回落题名卡 |
| 游戏封面 | Steam Store API | 竖版 `library_600x900`，无则退横版 |
| 音乐封面 | iTunes Search API | **必须通过标题包含校验**才采用 |
| 街机音游 / 同人曲封面 | 站主自备（`common.py` 的 `MANUAL_POSTERS`） | 优先于联网抓取 |
| 书籍封面 | 豆瓣读书 | 解析 `window.__DATA__` 拿 `/view/subject/l/` 大图 |
| 背景插画 | 站主自备（`<插画素材目录>`，10 张横构图） | 离线压成同站 WebP，无外部请求 |
| 弹幕文案 | 站主自写 25 条 + 一言（`v1.hitokoto.cn`）40% | 见 §五。一言是**唯一**的外部请求 |
| `zzz摄影/` 126 张 | —— | **永久排除，不上传** |

- **站主要求不展的条目**（`BVN` / `alice in cradle` / `胭脂`）写在 `tools/common.py` 的
  `EXCLUDE_ITEMS` 里。笔记库是只读的，绝不改原文件，所以「不展」只在构建时控制：
  自检里有专门断言，防止它们被重新带回来。
- 页脚有完整的非商用声明。抓封面有一条硬规则：**宁可回落题名卡，也不配一张错的封面**。
  校验串写在 `tools/common.py` 的 `POSTER_QUERIES` 里，源站用繁体/日文原题时显式给出。

---

## 五、交互与无障碍

### 开屏页（`splash.js`）

左栏是一行打字机 + 右侧一个小演示，两栏并排（实测栅格 `609.109px 518.891px`、gap 72px）。

- **打字机**：文本逐字浮现，光标用**真元素**（不是伪元素），列宽从一开始就按最长行预留，
  所以打到一半不会把版面顶歪。自检直接比对 `rowTexts` 与 `data-lines` 是否**逐字相等**
  （实测 `textExact: true`、2 个光标、`caretPos: "static"`）——
  只验「有文字在动」是不够的，串行/断行都会让动效看着对、内容却是错的。
- **字体是站酷小薇 LOGO 体**（子集化后的 `logo-subset.woff2`，见「六、字体」）。
  ⚠️ **验证字体真的生效，不能只看 `document.fonts.check`** —— 它在本机会说谎：
  找不到字体时同样可能返回 `true`。可靠的判据是**用它去量字宽再和别家比**：

  ```
  { logo: 210.8, mono: 220, missing: 221.7 }   ← 三个值互不相同 ⇒ 真的用上了
  ```

  三者若相同，说明字体根本没生效、全部回落到了同一个后备字体。
- **右侧的布朗运动演示**（`<canvas>`，实测 517×337、34 个粒子）：
  粒子做随机游走，同时受**指针的力**影响。力的公式抽成了独立的 `forceAt(x, y)`，
  这样探针可以直接查询它，**不用靠数截图像素去反推**：

  ```js
  Auxia.brownianForce(x, y)   // 返回该点的力大小
  Auxia.brownianInfo()        // 尺寸 / 粒子数 / 指针状态 / 力与半径参数
  ```

  实测：力随距离**单调递减且各向同性**（`d5 → 3.10`、`d40 → 0.286`、
  `d100 → 0.044`、`dR+20 → 0`），反向对称，指针移出后归 `0`，
  只看帧差确认画面确实在变（`frameChanged: true`）。

### 弹幕（本轮重做）

- **密度是旋钮，不是副作用**：`core.js` 里 `DM_PER_SEC = 1.5` —— 每秒固定投放 1.5 条。
  定时器负责生成、CSS 动画负责飘过、`animationend` 负责回收，`DM_MAX = 90` 兜住上限。
  早先是「每条文案各挂一个元素无限循环」，于是**弹幕量被文案条数间接决定**：
  加了 17 句文案，密度会莫名其妙跟着变。现在不会了。
- **⚠️ 慢一半必须**同时**减半投放速率**（本轮站主要求「速度放慢差不多一半」）。
  这里有两个常量，只有一个是「快慢旋钮」：

  ```
  DM_SPEED = 0.045   // 每秒走过多少「屏宽」—— 唯一的快慢旋钮
  DM_PER_SEC = 1.5   // 每秒投放多少条 —— 密度旋钮
  ```

  在屏密度是一个**乘积**，不是两个独立的东西：

  ```
  在屏条数 ≈ DM_PER_SEC × 在屏寿命
  在屏寿命 = 整圈时长 × p_exit，p_exit = (屏宽 + 字宽) / (字宽 + 2·屏宽) ≈ 0.55
  整圈时长 = (字宽 + 2·屏宽) / (屏宽 × DM_SPEED)
  ```

  所以 **`DM_SPEED` 减半 ⇒ 每条多活一倍 ⇒ 在屏条数翻倍**。
  只动 `DM_SPEED` 的话，1512px 屏下在屏条数会从 ~40 涨到 ~80，
  直接顶到 `DM_MAX = 90` 的门槛 —— 表现不是「变慢了」，而是**后半段投放被静默丢掉**
  （`live.length >= DM_MAX` 就直接 `return`，不报错）。
  于是 `DM_PER_SEC` 从 3 一起降到 1.5：**速度减半 + 速率减半 ⇒ 密度不变**，
  实测在屏条数 40、`DM_MAX` 90，两边都还有余量。
  改动任何一边都要回来对一下另一边。
- **没有气泡底**。每条只有一层很淡的白色 `text-shadow` 保证可读性，
  存在感完全由 `--danmaku-opacity`（现在是 **0.30**）这一个旋钮控制。
  密度上去之后单条必须更淡，否则会糊成一层灰网。
  ⚠️ **不要给它加 `mix-blend-mode: multiply`**：multiply 会和下面的白纱相乘糊成脏色，
  再叠上低透明度就等于隐形（这是踩过的坑，自检里有守卫钉着）。
- **悬停高亮必须用 JS 算，不能用 `:hover`**。原因在图层顺序：
  `#danmaku` 是 `z-index: 1`，而 `main` 是 `5`。`main` 的盒子虽然透明，
  但没声明 `pointer-events: none` 就照样吃掉命中测试 —— **指针永远碰不到 `.dm-item`**，
  `.dm-item:hover` 一辈子不会触发。把弹幕抬到 `main` 之上又会让它盖住正文，更糟。
  所以命中检测是自己算的：弹幕都是 `@keyframes dm-scroll` 的匀速直线运动，
  几何解析可求（`x(p) = 100vw − p·(w + 2·100vw)`），逐帧算术比 `getBoundingClientRect` 便宜得多。
  被点亮的那条会加 `.is-hot` 并**暂停**（暂停要记账 `pausedTotal`，否则算出来的位置会和元素真实位置错开）。
  对外暴露 `Auxia.danmakuBoxes()` / `Auxia.danmakuAt(x, y)` 供自检直接验证
  （`danmakuBoxes()` 每条还带一个 `p`，即推出来的动画进度，专门给真实浏览器探针对表用）。
  `.dm-item` 保持 `pointer-events: none`，所以弹幕**不挡正文的点击**。
- **⚠️ 动画必须只跑一圈**（`.dm-item` 的 `animation-iteration-count: 1`）。
  这是本轮修掉的一个真 bug，也是最值得记住的一处**跨文件契约**：
  命中检测是按 `p ∈ [0,1]` 推位置的，`p >= 1` 一律当成「这圈跑完了、已经在屏外」跳过。
  而 CSS 原本写的是 `animation: dm-scroll linear infinite`：
  - `infinite` ⇒ `animationend` **永不触发** ⇒ 回收只剩「`dur + 3` 秒」那个兜底定时器说了算；
  - 于是每条弹幕跑完一整圈后，会在原地**从右侧重新进场、再飞 3 秒**才被删掉；
  - 这 3 秒里它**明明画在屏幕上**，`boxes()` 却把它跳过了 ——
    表现就是**「看得见，指针扫上去却不高亮」**。

  真实浏览器实测：25 条里稳定有 3 条处于该状态（约 **12%**），正好对得上站主反馈的
  「高亮效果没实现」。改成只跑一圈后 `animationend` 准时回收，`p ∈ [0,1]` 才真正
  等价于「在屏幕上」，实测掉到 **0 条**。
  **改动任何一边都要回来对一下另一边**，自检里有三条守卫（CSS 的 `iteration-count`、
  块内不许出现 `infinite`、core.js 的 `p >= 1` 判断）把这个配对钉住了。
- **一言**（`banner.hitokoto`）：默认 `enabled: true`、`ratio: 0.85`。
  它是**预取 buffered** 的 —— 一次只补一小批、用完再补，绝不为每条弹幕各发一个请求；
  结果缓存在 `sessionStorage`，翻页复用；连不上 3 次就彻底放弃、静默回落本地文案池。
  `categories` 里排除了「抖机灵」分类。
  想回到「零外部请求」：把 `enabled` 改成 `false` 再 `build_site.py`。

  站主这轮要求「**显示出来的**弹幕里 85% 来自一言」。这个数字看着只是个配置项，
  实际上是一条**算术链**，四环缺一不可 —— 而且每一环失灵都表现为同一个样子：
  **页面完全正常、哪里都不报错，只是一言悄悄变少**（回落本地文案）。
  这四环都是**量出来的**，不是推出来的：

  1. **需求**：一言没有批量端点，一次调用只回一条。
     于是 `DM_PER_SEC × ratio × 60 = 1.5 × 0.85 × 60 ≈ 76.5 次/分钟`。
     这是接口能力决定的，不是实现方式决定的。
  2. **预算要盖住「需求 + 起步一次性开销」**。`MAX_REQ_PER_MIN` 老值是 80，
     而 76.5 已经吃掉 96%；补货还要先把缓冲填到 `HIGH = 20` 条，
     那 20 次是起步开销 ⇒ **第一分钟总共要 96.5 次**。
     滚动窗口一旦打满就是**硬停**（不是降速），于是 t≈30s 之后整分钟一条都不发。
     实测占比从 0.842 掉到 0.389、`hkMiss` 涨到 41。现取值 **100**。
  3. **补货必须并发**。实测单次往返**平均 1.6s、最坏 3.0s**，
     而串行写法一个周期 = 往返 + 间隔 ≥ 2.1s ⇒ 容量只有 **0.48 次/秒**，
     连需求 1.275 次/秒的一半都不到。现用 `MAX_CONC = 5` 的有界并发。
  4. **URL 必须带一个变化参数**。一言挂在 Cloudflare 后面（响应头 `Server: cloudflare`），
     URL 恒定时边缘缓存会把同一个响应体反复发回来 ——
     **同参连打 14 次只回了 7 条不同句子**（每条原样出现两次），
     而代码对重复句子的处理是「丢弃」⇒ **一半的请求白发**。
     加上 `&_=<Date.now()+random>` 后同参试验 8 次 8 条全不重复，实测 `dup` 占比降到 ~1.5%。

  - **⚠️ 最隐蔽的一个坑：`.then(r => r.ok ? r.json() : null)`**。
    非 200 的响应被后半句静默变成 `null`，紧接着 `if (!j) return;` 直接走人 ——
    既不进 `failures`、也**不调 `fill()`**。后果是 `inFlight` 一条条漏光、
    并发管道慢慢塌掉、供给「悄悄地」停住，**而所有计数器都是干净的 0**。
    症状就只有「比例越来越低」，代码读上去毫无破绽。
    现在改成 `if (!r.ok) { throw e; }` 走 `catch`，并且**每条结局路径都补一句 `fill()`**。
    另外 429 单独处理：它是「接口活着、是我们太快了」，
    所以**退避 20 秒**而不是算连续失败（在最该慢下来的时候判死是最坏的选择）。
    实测接口确实会限流：**同参连打 120 次回了 22 个 429**，打 60 次时还是全 200。
  - 诊断口 `Auxia.danmakuInfo().hk` 把每次请求的**结局**摊开：
    `yield / dup / tooLong / bad / r429 / netErr / lastStatus`。
    没有这几项，就只能看到「比例不对」这个结果、看不到卡在哪一环。
    同级的 `hkShown / localShown / hkMiss` 是**真正上屏**的来源分布（分子分母都在）。

  **实测（1440 宽，25 秒）**：`hkShare` 从冷启动的 0.40 在 t≈10s 穿过 0.85，
  末值 **0.88**；`hkMiss` **全程为 0**（缓冲从没见底）；`buf` 稳定在 20–23（打满 `HIGH`）；
  `sent 67 → yield 66 / dup 1`；`r429 / netErr / bad / tooLong` 全 0；`budget` 还剩 33。
  注意 `sent` 比修复前（104）**更少**却结果更好 —— 缓冲满了 `fill()` 就停手，
  这才是「按需求补货」，修复前那种「空转到把预算打满」是恶性循环。

### 项目页内嵌真实程序（liar-game / starcraft3）

`projects/liar-game/index.html` 里放了一个 `<iframe src="liar-card.html">`，
把 59KB 的说谎者之牌 Demo 整块嵌进项目页。同时把该页容器放宽成
`.wrap.proj-page.wide`（1020px）—— 760px 装不下能玩的牌桌。

`projects/starcraft3/` 是第二块内嵌，规格不一样：

- 容器用 **`ultra`** 宽度（1200px），因为那个页面把 `#app` 写死了 `min-width: 1024px`。
  用 `wide`（1020px）会让内容横向溢出、页面长出横向滚动条 —— 实测 `#app` 1198px
  刚好塞得下，`overflowing: false`。
- 主体是 `sc3.html`，**完全自包含（0 个外链）**，自检里有一条专门扫它。
  这一条比 liar-game 更要紧：它是个真游戏，任何外链都会在 iframe 里变成额外依赖。

**为什么用 iframe 而不是直接搬进来**：那个片子自带一整套样式（自己的深色主题、
自己的 `.card` / `.slot` / `button` 规则）和全局状态，直接内联会和本站样式表
互相渗透 —— 本站的 `body`、`button`、`.card` 会顺着层叠糊到它身上，而它的
`*{margin:0;padding:0}` 也会反过来打本站。iframe 给两边一个干净的边界，谁都不用改。

**它必须是自包含的**，这不是洁癖：卡片是「一个会在站点里跑的第三方程序」，
一旦它引一个 CDN 字体或调 `localStorage`，就同时破了本站两条承诺
（零外链 / 不碰存储），而 iframe 里的存储是**分区**的，部分浏览器直接抛
SecurityError，卡片的存档逻辑会当场挂掉。自检里有三条守着这件事（见下表）。

生成方式在 `tools/gen_project_pages.py`：`liar-game` 与 `starcraft3` → `EMBED`、
其余 → `SLOT` 占位。想换 Demo，把对应的 `*.html` 覆盖掉再 `build_site.py` 就行。

> ⚠️ 自检里那条「不许有误插入的 embed」是**从生成器的 `EMBEDS` 表里读白名单**的，
> 不是硬编码某几个 slug。硬编码的话，第二个内嵌项目一上线就会被当成回归报红，
> 而且会误导人把一个正确的改动改坏。

> 曾经还有一个 `obsidian` 项目页，指向站主的坚果云外链。本轮**站主明确要求下架**
> （不想泄露私密信息），所以数据、页面、生成器条目、目录、备份**全部清掉**，
> 并加了一条守卫扫全站产物里是否还有坚果云外链残留 —— 「把链接从界面上拿掉」
> 和「链接不出现在产物里」是两件事，只有后者才是真的不泄露。

### 卡片的液态玻璃（`liar-card.html`）

> ⚠️ **`@skill:skill-liquid-glass` 用不上**。那个 Skill 是 Android / Jetpack Compose
> 的（`io.github.kyant0:backdrop:2.0.0`），依赖 `RenderEffect`（Android 12+ / API 31）
> 与 `RuntimeShader`（API 33+），**在网页里没有任何运行路径**。
> 所以这里是「把它的规格翻译成 CSS」，不是调用它。

翻译对照（库的绘制顺序不能换，`colorFilter → blur → lens → Highlight → Shadow →
InnerShadow → 表面色`）：

| backdrop 2.0.0 | 网页落点 |
|---|---|
| `vibrancy()`（`== colorControls(saturation=1.5)`） | `saturate(1.5)` |
| `blur(2dp)` | `blur()`。库里 blur 只有 2dp，主要视觉交给 `lens`；网页没有真 `lens`，把等效强度并进 blur 值 |
| `lens(h, a, chromaticAberration)` | 边缘折射：高/暗发丝线（box-shadow inset）做出「光在边上弯折」 |
| `Highlight.Default(angle, falloff)` | 沿对角线的发丝高光，**随鼠标向量转向** |
| `Shadow(24, +4, 10%)` / `InnerShadow(24, +24, 15%)` | 外阴影 / `inset` 内阴影 |
| `onDrawSurface` 的 10% 白 | 表面那层白，**压在各自主色之上而不是替掉它** |

**两个前提，缺一个整套效果就是空的：**

1. **`backdrop-filter` 只能模糊「身后真实存在的东西」。** 原页面 `body` 是纯色
   `#0e0f15`、面板也是纯色，身后空无一物 —— 模糊等于没做。所以先给 `body::before`
   铺三层极淡的环境光晕（紫 / 蓝 / 绿），并把面板底色改成带透明度的 `rgba()`，
   玻璃才有东西可折射。为了把内容提到光晕之上，`#app` 多了 `position:relative; z-index:1`
   （**这是本改动唯一动到的排版属性**，见下）。
2. **类别色不能被玻璃吃掉。** 牌面的红 / 蓝 / 琥珀是有含义的，所以表面那层白是
   **叠在**主色渐变之上的第二个背景图层，不是替换。牌背的斜条纹同理。

鼠标向量（对应库里的 `InteractiveHighlight` + `DampedDragAnimation`）用事件委托
写在 `document` 上（卡片一直被 `innerHTML` 重建，逐张绑定会被冲掉），更新三个
自定义属性：`--lg-mx/--lg-my`（高光中心）、`--lg-rx/--lg-ry`（由「卡片中心 → 指针」
向量折算的 ±7° 倾角）、`--lg-scale`（按压，`lerp(1, 1+4dp/h, p)` ≈ 1.045）。
阻尼手感来自 CSS 的 `transition`，不是 JS。

⚠️ **不要把整条 `transform` 包成一个 `:root` 上的自定义属性。**
自定义属性是在**声明它的那个元素**上完成 `var()` 替换的：写在 `:root` 上，
`rotateX(var(--lg-rx))` 会在 `:root` 就替换成 `rotateX(0deg)` 并被继承成死值，
卡片后来写的 `--lg-rx` / `--lg-scale` 全部被无声忽略 —— 倾斜和按压缩放都变成静止的，
**而截图完全看不出来**。这条是被 `&ptr=1` 探针抓出来的（计算出的 transform 恒为单位阵）。

#### 卡片的淡入（`cardIn`）—— 两个反直觉的坑

淡入本身很简单（`opacity` + `translateY(30px→0)`），难的是**别把它写坏**。
两个坑都是实测撞出来的，而且都「不报错、截图也看不出来」：

1. **⚠️ `animation-fill-mode` 不能用 `both` / `forwards`，只能用 `backwards`。**
   动画里的 `transform` 落在 **Animation origin**，它的优先级**高于**普通作者声明。
   于是 `forwards` / `both` 会把最后一帧的 `transform: none` **永久**留在元素上，
   把 `.card:hover { transform: translateY(-4px) }` 整个压掉 ——
   表现是「**进场之后卡片就没有悬停反馈了**」，而你要联想到 animation 得费很大劲。
   `backwards` 只在动画开始前生效，跑完就把控制权交还给普通声明，两个效果才能共存。

   这条是被一个**小样本 A/B 探针**证明的（`build/_probe/probe-fade.js`）：
   造一个合成动画、三种 fill 各跑一遍，看 `getComputedStyle` 读到的 `transform`
   是「动画末帧」还是「内联 hover 值」。第一版写得不成立 ——
   用 `animation-delay: 0` 时动画还停在 `startTime: null / currentTime: 0`，
   三种 fill 读到的**全是起始帧**，测出来 `abDiscriminates: false`。
   改成 **负延迟** `animation-delay: -2s` 让动画直接落在 `finished`，判别度才起来
   （`forwards → 吃掉内联`、`backwards/none → 不吃`）。
   **测不出来不等于没有**，先确认测量本身有判别力。

2. **⚠️ 淡入要错落（stagger），而且必须真的错落。**
   `.card:nth-child(3)` 用 `animation-delay` 偏移，否则整块一起出现、看不出是「依次淡入」。

3. **⚠️ 最隐蔽的一处：`initReveal()` 的 2400ms 安全网把淡入整个吃掉了。**
   安全网的本意是「IntersectionObserver 万一不生效，别让内容永远看不见」，
   老写法是「**还有没亮的 → 全部点亮**」。后果是折叠线以下的卡片在**视口外**
   就把 `cardIn`（含错落延迟）跑完了 —— 用户滚到项目区时，卡片
   `opacity` 恒为 `1`、`animationName` 已经是跑完的 `cardIn`，
   **什么动画都看不到**。做了个淡入，但没人看得见。
   现在改成**只在视口内**兜底，并且区分两种情况：观察器活着（`ioFired`）就只点亮
   「此刻真的在屏幕上」的节点；观察器根本没触发过，才退回全亮。
   实测滚到项目区：修复前 `gridCls` 已是 `proj-grid reveal is-on`、
   `cardOpacity: 1`；修复后 `gridWasPreRevealed: false`，
   trace `1, 0, 0, 0.586, 0.805, 0.913, 0.97, 0.99, …` —— 动画真的发生在眼睛里了。

   > 这一条**自检抓不到**，得另起一个 JSDOM 才测得出来。
   > 原因：主 `load()` 的 IO 桩在 `observe()` 里立刻回调 `isIntersecting: true`，
   > 等于所有 `.reveal` 秒亮 —— 安全网怎么写都能通过。
   > 需要的是「观察器活着、但一个都没交集」这个中间状态。

### 其它

- **矢量光标**：`core.js` 的 `initCursor()` 画一枚「四角星 + 虚线圈」。
  内核用大阻尼比直接贴住指针，外圈用**欠阻尼弹簧积分**跟随（ζ≈0.92），
  所以它总是拖在后面、速度越快被拉得越长、方向随速度矢量旋转 —— 这就是「非线性跟随」。
  只在「精细指针 + 未开启减少动效」时启用；**先确认画得出来，才把系统指针藏掉**
  （`html.cursor-on`），否则 JS 一挂用户就没指针了。
  ⚠️ `pointermove` 里补 `.is-on` 必须写成「**每次移动都确保可见**」，不能写成
  「只在第一次显示」：`hide()` 会在指针移出窗口时摘掉 `.is-on`，
  只补一次的话「移出去再移回来」之后元素还在、位置也在跟，但 `opacity` 恒为 0 ——
  用户看到的就是「光标没了，再也回不来」。自检里有一条专门盯这个。
- **点击粒子**：颜色取自当页 accent，移动端自动降频。
- **点击弹幕去 Bing 搜这句的出处**：`window.open(url, '_blank')` 打开
  `https://www.bing.com/search?q=<encodeURIComponent(整条文案)>`，
  并带上 `noopener,noreferrer`。
  ⚠️ 这条给「外部请求白名单」那条守卫添了个例外：Bing 的域名出现在 `core.js` 里，
  但它是 `window.open` 的**参数**、不是页面会自动去拉的资源。
  所以白名单校验里加了 `NAV_ONLY`（只允许作为 JS 字面量出现的行为）。
  实测反例也验过：点一条**真的 `<a>` 链接**（弹幕里的外链）时
  `dmOnLink: 0`，**不会**误触发搜索 —— 两种点击必须分得开。
- **「休眠模式」标题**：`document.hidden` 变化时把标题在
  `Auxia的个人小站` ↔ `休眠模式 ( ´-ω-`)zzZ` 之间切换。
  这是对**用户切走了**这件事的礼貌回应，不涉及任何数据。实测两个方向都对。
- **网页图标**：由站主的标志源图派生整套（`build_icons.py`）——
  `favicon.ico`（16/32/48/64 四档）、`favicon.svg`、`apple-touch-icon`、`og-cover`。
  ⚠️ `favicon.ico` 的多尺寸有个 PIL 的坑：`IcoImagePlugin._save` 判断「这一档放不放得下」
  用的是 `im.size`，**不是** `sizes` 参数。如果拿 16px 那张当基准图，32/48/64 会被
  静默丢掉，**而日志照旧打印 `[16, 32, 48, 64]`**。正确写法是以最大档为基准，
  其余档走 `append_images`。实测修好后 `favicon.ico` 报 `[(16,16),(32,32),(48,48),(64,64)]`。
  `favicon.svg` 是 32.6KB（内嵌 192px 的 base64 PNG）—— 源图是带渐变和抗锯齿边缘的
  **渲染图**，不是矢量，硬描只会失真，所以这里如实保留位图，不假装成矢量。
- **共用 rAF 循环**：`Auxia.onFrame(fn)` 订阅，`boot()` 统一在页面隐藏时停、回来时拉起。
  别各自 `requestAnimationFrame`，否则每加一个动效层就多一个互不知情的循环。
- **`prefers-reduced-motion`**：关闭弹幕、粒子、矢量光标、五边形展开动画与滚动揭示。
- **焦点可见性**：`:focus-visible` 全站保留，未做任何 `outline: none`。
- **圆角**：只有三档，全在 `variables.css` 里 —— `--radius` 8px（卡片）/ `--radius-sm` 4px（卡内小件）
  / `--radius-pill` 10px（按钮、导航项、标签）。**不要在组件里写死像素值**，
  自检里有一条「全站不再有写死的 999px 圆角」盯着。
- **图片**：全部带 `width/height` 与 `alt`，`loading="lazy"`。
- **联系方式防爬**：明文只存在于 `site.json` 的 base64 字段里，点击才写入 DOM，25 秒自动收起。
- **字号**：正文 17.5px 起，全站只从 `variables.css` 的 `--fs-xs…--fs-xl` 五档里取值，
  别在各处写死 px，否则一轮轮改下来尺度会散掉。
- 移动端视口用 `100dvh`。

---

## 六、字体

| 用途 | 字体 | 体积 |
|---|---|---|
| 标题 | 得意黑 Smiley Sans Oblique（OFL-1.1，zeoseven FontsAPI #92） | 26 片共 1.41MB，只加载用到的片 |
| 正文 | 思源黑体（本地 `cmdysj.ttf`）子集化后自托管 | 8.47MB → **118KB** |

`cmdysj.ttf` 经核实 **就是思源黑体 CN Regular**（name 表 nameID 16 残留
`Source Han Sans CN`，无艺术化改造）。

字符集由 `build_fonts.py` **扫描全站 HTML + data/*.json 自动生成**——
展品名会不断增加，手工写死字符集必然缺字。**加了新展品后要重跑 `build_fonts.py`**。

弹幕的字体栈是 `--font-mono`，而它现在**显式挂了正文字体兜底**：
`ui-monospace, "SF Mono", Menlo, Consolas, var(--font-body), monospace`。
拉丁与数字走等宽，中日韩字符落到思源黑体子集上 —— 不挂的话中文会掉进系统默认字体，
和正文不是一套。所以**弹幕文案里的字也在子集里**，加弹幕同样要重跑 `build_fonts.py`。

---

## 七、加东西的日常流程

**加摄影**：丢图进 `007 WALLS 展墙🖼️/摄影作品展示/` → `optimize_photos.py` → `build_gallery.py`

**加动漫 / 音乐 / 书籍 / 游戏**：改对应 `展示.md` →（封面需求写进 `tools/common.py`
的 `POSTER_QUERIES`）→ `fetch_posters.py` → `build_gallery.py`

**两者都要**：最后重跑 `build_fonts.py`（补字）+ `build_site.py`（装配）→ **跑一遍自检**

> 加了新展品**一定**要跑 `build_fonts.py`，否则新出现的字会缺字。
> 跑自检是因为它会替你看「新图路径在这个页面深度下解不解析得到」，
> 这是肉眼最容易漏的一环。

---

## 八、自检

```bash
python tools/build_site.py
AUXIA_NODE_PATH=<jsdom 所在目录> \
  node tools/smoke-test.cjs
```

`tools/smoke-test.cjs` 起一个只监听 `127.0.0.1` 的临时静态服务器，用 jsdom 把每一页
真跑一遍，逐条核对：五边形五个分值与用户给的一致、橱窗每面墙恰好 2 件、
背景取自本地插画池、矢量光标的外圈确实拖在内核后面、联系方式明文不在 DOM 里、
点击才展开、题名卡数量 = 无封面展品数、全站无运行时报错。

**为什么必须起服务器、不能用 `JSDOM.fromFile`**：站点里大量使用根绝对路径
（`/assets/...`），因为 `404.html` 会在任意深度被命中，只有根绝对才写得对。
但 `file://` 下 `/assets/x` 会解析成 `file:///C:/assets/x`，页面的 CSS/JS 全部加载失败。
更隐蔽的是 jsdom 的 `requestInterceptor` **不拦截 `file:` 协议**
（`data:` 与 `file:` 在 dispatcher 里直接内部分派，根本不进用户拦截链），
靠拦截器救不回来。曾经的结果是：**404 页在自检里从来没跑过 JS**，
而 `Could not load` 又被 `realErrors()` 过滤掉，于是报出一个假的绿灯。
换成 HTTP 之后根绝对路径与真实部署完全一致，顺带还能验证
「页面要求的每一个资源都真的存在」（`missed` 列表必须为空）。

自检里还钉了几组「靠眼睛容易漏、靠数量断言永远漏」的守卫，改动时**不要删**：

| 守卫 | 防的是什么 |
|---|---|
| **图片地址可达性**（每页都查） | JSON 里存裸相对路径时，`/` 正常但 `/gallery/`、`/projects/<slug>/` 会解析成 `/gallery/assets/...` 而 404 —— 文字 CSS 全对，只有图全碎。守卫把页面当成部署在站点根上，按真实 URL 规则解析后回磁盘查文件 |
| **层叠契约** | `#bg` 是 `position:fixed; z-index:0`，会整块盖住**未定位**的普通块级内容。`.splash` / `.sec` 自带 `position:relative` 所以没事，`.proj-page` / `.nf` 没有就被盖成空白（DOM 里文字都在）。守卫把 CSS 内联注入后用 `getComputedStyle` 核 `main` 的 `position` 与层级 |
| **站主点名的硬要求** | 9 件指定补图的展品**必须真的有封面**、3 件下架的**必须不在数据里**、17 条新弹幕文案**必须都在池子里**。`build_gallery.py` 的 `asset_exists()` 曾用 `SITE / "/assets/..."` 拼路径，在 Windows 上会被 join 丢掉前缀，于是每张封面都被判成「文件不存在」，整站静默回落成题名卡——页面不报错、数量断言全过，只有肉眼才发现配图全没了 |
| **背景图轮换** | 以首页色系连抽 30 次必须出现 ≥6 张不同的图；五个色系各连抽 20 次都必须取得到图。防的是「按桶锁死 → 每页永远那一两张」（站主报过的现象）与「桶为空 → 页面没背景」。取图函数抛异常也算失败，**不会让整套自检崩掉** |
| **accent 不许近黑** | 深色插画会把主色抽成 `#100700` 这种近黑，光标/下划线/导航点就全黑了 |
| **弹幕行为** | 投放器真的在跑、每秒约 1.5 条（2 秒实测容差 2–4 条）、文案只来自本地池或一言、几何算得出来、**指针移上去会点亮那一条并暂停**、**移开之后必须取消高亮并恢复滚动**。只测「点亮」不测「释放」的话，一个只会加不会减的实现也能全绿，而用户看到的是弹幕被卡住不走 |
| **弹幕外观** | 不许出现 `mix-blend-mode`、`--danmaku-opacity` 落在 0.15–0.40、`.dm-item` **必须没有**气泡底、必须 `pointer-events: none`。断言前先把 CSS 注释剥掉，否则注释里提到的属性名会造成假通过 |
| **弹幕只跑一圈**（跨文件契约） | `.dm-item` 的 `animation-iteration-count` 必须是 `1`，且块内不许出现 `infinite`；同时又要求 core.js 里还留着 `p <= 0 \|\| p >= 1` 这句跳过判断。**这两条必须同时成立**：CSS 写 `infinite` ⇒ `animationend` 永不触发 ⇒ 元素跑完一圈后原地**从右侧重新进场再飞 3 秒**，而命中检测把第二圈当「已跑完、在屏外」跳过 ⇒ **明明看得见、指针扫上去却不高亮**。真实浏览器实测 25 条里稳定有 3 条处于该状态（约 12%） |
| **弹幕进度 p** | `Auxia.danmakuBoxes()` 每条的 `p` 必须落在 `(0,1)`。一旦出现 `p >= 1` 就说明又有「第二圈」元素了，也就是上面那条的症状 |
| **光标移出后可恢复** | 指针移出窗口 → 再移回来，`.is-on` 必须回来，而且**不能从旧位置横穿**过来 |
| **外部请求白名单** | 只有一言（`v1.hitokoto.cn`）允许被自动请求。区分「会加载的资源」（`src=` / `<link rel=stylesheet…>` / CSS `url()` / JS 里的 URL 字面量）和「只是归属信息的外链」（canonical、出处链接）——后者不算回归 |
| **字号与圆角尺度** | 正文必须走 `--fs-md` 且 ≥17px；圆角只能从三档变量里取，不许再出现写死的 999px |
| **内嵌 Demo 是真的落地了** | `liar-game` 的容器必须是 `wide`、iframe 的 `src` 必须同源相对、**且那个文件真的进了 `dist/`**（按真实 URL 规则解析后回磁盘查）。「本地有、dist 没有」是最常见的漏构建，线上就是 404；其余 3 个项目页则**不许**有 `.embed`（防生成器把 EMBED 漏给所有页） |
| **内嵌卡片必须自包含** | `liar-card.html` 里**不许出现任何站外 `src/href`**、不许用 `localStorage`/`sessionStorage`/`indexedDB`/`document.cookie`（iframe 里存储是分区的，部分浏览器抛 SecurityError）。这条是防「以后换一版卡片、那版带了个 CDN 字体」——本地一切正常，部署后悄悄多一个外部依赖 |
| **液态玻璃还在** | 卡片的 `backdrop-filter`（**不带 `-webkit-` 前缀的那一条**）、吃 `--lg-mx/--lg-my` 的高光渐变、`::before`（不是 `::after`，那个被牌背的虚线圆占着）、`mix-blend-mode:screen`、三类牌的主色仍在背景图层里、牌背斜条纹还在、指针脚本的三条回收路径。**卡片是从站外拷进来的**，谁再拷一版新的进来就会把整块玻璃无声覆盖掉，而页面照样能跑、通用断言全绿 |
| **`transform` 没有走变量间接** | 必须能在卡片自己的规则里逐字看到 `perspective(...) rotateX(var(--lg-rx)) ... scale(var(--lg-scale))`。防的正是上面那个「`:root` 上的嵌套 `var()` 被提前固化」的坑 |
| **卡片淡入的 fill-mode** | 只能是 `backwards`，块内**不许**出现 `both` / `forwards`。它们会把动画末帧的 `transform: none` 永久钉在元素上，压掉 `.card:hover` 的上浮 —— 「进场之后就没有悬停反馈了」，极难联想到 animation |
| **淡入安全网的作用域**（另起一个 JSDOM） | 2400ms 安全网只许点亮**视口内**的 `.reveal`。老写法「还有没亮的就全部点亮」会让折叠线以下的卡片在视口外把 `cardIn`（含错落）跑完，用户滚下去**什么动画都看不到**。这条必须另起 JSDOM：主 `load()` 的 IO 桩在 `observe()` 里立刻回调 `isIntersecting: true`，等于所有节点秒亮，安全网怎么写都能过 |
| **一言供给链路的四条算术** | ①`MAX_REQ_PER_MIN ≥ 需求 + 起步填缓冲`（76.5 + 20，老值 80 会在 t≈30s 打满硬停）②`MAX_CONC ≥ 2` 且按**最坏** 3.0s 延迟算容量仍有余量（串行只有 0.48/s）③URL 必须带变化参数（不然 Cloudflare 边缘缓存让一半请求白发）④来源分布可观测（`hkShown`/`localShown`/`hkMiss`）。**四条缺一条，85% 都会静默掉下去**，而页面毫无异常 |
| **非 200 不许被静默吞掉** | 一言补货路径上必须 `if (!r.ok) { throw e; }`，且**每条结局路径都有一句 `fill()`**，还要有一份结局分类计数（`yield/dup/tooLong/bad/r429/netErr`）。老写法 `.then(r => r.ok ? r.json() : null)` 把非 200 变成 `null` 后 `return`，槽位释放但管道不补 ⇒ 供给悄悄停摆，**所有计数器却都是干净的 0**。⚠️ 这条断言必须**先剥注释、再只扫 `issue()`**：注释里引用了那句老写法，站里另有一个取 `data/*.json` 的 `getJSON()` 也用同样写法（在那里回落 `null` 是正确的） |
| **429 是退避不是判死** | 撞 429 必须走 `cooldownUntil` 降温，**不能**算进连续失败（否则会在最该慢下来的时候彻底放弃）。实测接口限流是真实存在的：同参连打 120 次回 22 个 429，打 60 次时还是全 200 |

> 前两条都是实际踩过的：前者让 `/gallery/` 整页图片全碎，后者让 4 个项目页
> 和 404 页只剩导航、正文一片空白。**两处都通过了当时所有别的断言。**
>
> 后两条是本轮踩出来的另一类坑：**守卫自己会「假绿」**。同一条断言我改了三次才真正有牙 ——
> ①拿整份文件搜 `backdrop-filter`，结果被面板那条规则喂绿；②改成 `[^}]*backdrop-filter`，
> 结果 `-webkit-backdrop-filter` 里也含这几个字，标准属性删光照样绿；③最后才改成
> 「取出所有 `.card{...}` 块，找**最后一个**声明了 `backdrop-filter` 的（级联胜出者），
> 再要求块内存在不带前缀的那一条」。**每一条守卫都要注入故障试一次**，
> 否则你守的是「文件里提到过这个属性」，不是「这个属性真的生效」。

#### 注入故障的那个脚本，自己也可能假绿

`build/_probe/fault-inject.sh` 会逐条给产物注入故障、再看对应守卫是否变红。
它第一版跑出 **11/11「守卫没抓到」** —— 看着像全部守卫都是死的，其实是脚本自己的锅：

```bash
"$MUTATOR" "$SCRATCH"     # ✗ 把整串 `bash <path>` 当成一个可执行文件名
$MUTATOR "$SCRATCH"       # ✓ 正常分词
```

引号一加，等于**一个变异都没注入**，而判定又拿全量输出（含 `✓` 行）去搜期望字符串，
于是每个用例都"找不到 → 判定没抓到"。修完立刻 **10/11 确认变红**，
剩下那一条是 sed 模式没对上真实标记（改成删掉字体预载那一行后复验通过）。

> **判据必须只搜失败清单**（`sed -n '/失败项：/,$p'`），不能搜全量输出 ——
> 否则 `✓` 行会冒充命中。这条和「先确认注入到底有没有进到被测对象里」是同一个道理。

### ⚠️ 自检读的是 `dist/`，不是源码

`smoke-test.cjs` 第 30 行：`ROOT = process.argv[2] || path.join(__dirname, '..', 'dist')`。
**默认查的是构建产物。** 所以：

- 直接改 `assets/css/*.css` 再跑自检，**测的还是旧构建**，改动一点没生效；
- 想验一条新守卫是不是真的会响，必须 **先 `build_site.py`，再跑自检**，
  或者把 bug 直接注入 `dist/` 里的那份。

我这次就栽在这上面：把 `animation-iteration-count` 改成 `infinite` 之后直接跑自检，
结果 **当时全绿**，一度以为「守卫是死的」。其实守卫是对的，只是我在测一份
没被污染的旧产物。**先重建再跑**，立刻变成 `166 通过 / 1 失败` 并准确指出
`-> "infinite"`。

> 这条纪律值得单独记一笔：**「守卫没响」和「守卫是死的」是两回事，
> 先确认你的注入到底有没有进到被测对象里。** 反过来同样成立 ——
> 一个从没红过的守卫，等于没有守卫。

### 真实浏览器验收（自检覆盖不到的那一层）

jsdom 没有布局引擎，`getBoundingClientRect()` 恒返回 0，所以 core.js 里
`rect.width || estimateWidth(text)` 的**兜底估算永远会被走到**，
「真实测量宽度」那条路径在自检里一次都没跑过。弹幕的解析几何是纯算术，
必须拿真实布局引擎对一次表：

```bash
# 起预览服务器后（tools/preview.py）
node tools/browser-probe.cjs \
  --url=http://127.0.0.1:8791/ --wait=9000 \
  --eval-file=tools/dm-invariant.js
```

`tools/dm-invariant.js` 量四项：

| 指标 | 期望 | 含义 |
|---|---|---|
| `formulaErr` | **0** | 把元素**自己的动画进度**代回 `x(p) = vw − p·(w + 2·vw)`，和真实 `left` 比。**与时钟无关**，不为 0 就是公式或宽度测量写错了 |
| `maxDy` / `maxDw` / `maxDh` | **≈0** | 泳道纵向定位与宽高测量的误差（实测 `maxDy 0.013`，其余 0） |
| `orphanCount` | **0** | 不变式：**画在屏幕上的每条弹幕都必须能被 `danmakuAt` 命中**。判定只看 `=== null`——元素重叠时 `hitBox` 会按「中心最近」选中另一条，那不算违规 |
| `perfDelta` / `timelineDelta` | 两者接近 | CSS 动画跑在 `document.timeline` 上，`performance.now()` 应当和它同源同速。差很远就说明是测量环境的问题，不是代码问题 |

> **新加的守卫要顺手验一次「它在 bug 存在时确实会报错」**。做法：把 bug 临时写回去，
> 跑一遍自检确认它红了，再改回来。「背景图轮换」和「光标移出后可恢复」这两条就是这么验的
> —— 前者在 bug 状态下报 `{"distinct":1,"poolSize":10}`，后者报「移回来光标会重新出现」失败。
> 没验过的守卫很可能只是在陪跑。

#### 跑长探针的三个坑（本轮逐个踩过）

1. **`cd X && python -m http.server ... &` 会把 `cd` 一起丢进后台子壳。**
   前台的工作目录**没有变**，于是 `tools/browser-probe.cjs`、`build/_probe/_run.out`
   这些相对路径全部落空 —— 报出来的是 `MODULE_NOT_FOUND` / `No such file or directory`，
   看着像依赖丢了，其实是**路径基准错了**。要么全程用绝对路径，要么把服务和探针分成两条命令。

2. **前台跑超过约 20 秒的探针会被整个 SIGTERM 掉**（不是探针的问题，是运行环境的清理规则）。
   短探针（`--wait=1500`）正常退出、长探针（25 秒档）必被砍。
   做法：后台跑，`> build/_probe/_xxx.out 2>&1` 落盘，再读文件。
   **结果通常已经写出来了**，被砍的只是收尾 —— 先看文件，别急着重跑。
   另外 `--cdp-timeout` 要调到探针时长之上（默认 30s 会在长 `sleep` 中途报「CDP 超时」）。

3. **`tasklist | grep -ci msedge` 数的不是 Edge。** 它把宿主 App 的
   `msedgewebview2.exe` 一起数进去了，于是一堆"幽灵浏览器"其实是自己的窗口。
   要看真的是否清干净：`tasklist /FI "IMAGENAME eq msedge.exe"`。
   另外 `msedge.exe` 启动器会**立刻交接退出**，`child.kill()` 和 `taskkill /PID /T`
   都够不到真正的渲染进程 —— 只能按命令行上的 `--user-data-dir` 去匹配整棵树收掉
   （`browser-probe.cjs` 的 `killTree()` 就是这么做的）。
   收不干净的话，下一次探针会因为 devtools 端口占用而连不上。

#### 另外两个探针：`&geo=1` 与 `&ptr=1`

改「材质」最容易顺手把「排版」改歪，而**截图看着"还行"完全不能说明没歪**。
所以给 `tools/preview.py` 加了两个路由，都在真实布局引擎里跑：

**`&geo=1` —— 几何比对。** dump 一批关键元素（`#app`/`.side`/`#board`/`.slot`/`.card`/
`#actions`/…）的 x/y/w/h 与关键计算样式，同一组选择器在两个版本里逐项对比：

```bash
# 把原版从备份里解到 dist/__origcard.html，两个版本各抓着一次，再逐字段 diff
curl -s ".../__probe.html?p=/__origcard.html&geo=1&d=1200"     # 原版
curl -s ".../__probe.html?p=/projects/liar-game/liar-card.html&geo=1&d=1200"  # 玻璃版
```

实测结果：**17/18 项逐字段完全一致（0 px 偏移）**，唯一差异是
`#app` 的 `position: static → relative` —— 那是为了让内容压在环境光晕之上，
是本次**唯一**动到的排版属性。（比对完记得把 `dist/__origcard.html` 删掉。）

**`&ptr=1` —— 鼠标向量链路。** headless 截图里没有指针，`--lg-mx/--lg-rx/--lg-scale`
全是空值，高光永远停在默认位置 —— 于是「截图看着正常」和「代码根本没生效」
长得一模一样。探针用合成的 `PointerEvent` 把指针放到卡片的不同位置，再分层读回：
JS 写没写变量 → 计算出的 `transform` 变了没 → `::before` 的渐变圆心跟没跟。

这一条**直接抓出了一个截图绝对看不出来的真 bug**（就是上面那个 `:root` 嵌套 `var()`
被提前固化的坑：倾斜与按压缩放全是死的）。判定十项全绿后才算数。

> ⚠️ 写这类探针有个自己的坑：**`getComputedStyle` 在「写完变量」的同一个任务里读，
> 拿到的是过渡的起始值**（`transform` 恒为单位阵、`opacity` 恒为 0），看起来就像
> 「变量没生效」。`.card` 和 `::before` 都有 `transition`，而 `transition` **不可继承**，
> 给 `.card` 写内联 `transition:none` 是盖不住伪元素的 —— 必须注入
> `.card,.card::before{transition:none !important}` 再量。第一版探针就被这个骗了一轮。

> **时序相关的前置条件要轮询，不要定点采样。** 弹幕那条「存在同泳道两条」的断言
> 原来只在某一个固定时刻采一次样：投放 3 条/秒、桌面 12 条泳道，开局头几秒恰好
> 每条泳道一条，"堵车"要等泳道被复用才出现 —— 于是 4 次里挂 2 次（挂的时候总数是
> 205 而不是 209，因为下面 3 条连带被跳过）。改成轮询到出现为止（上限 9s，超时照样报红）
> 之后连跑 5 次稳定 209/0。**随机翻车的断言比没有断言更糟**，它会训练你忽略红色。

> 测试才需要 jsdom；**站点本身零依赖**，不要为此给站点加 `package.json`。
> 外部域名（一言）在自检里走的是**桩响应**，所以测试完全不依赖公网。

### 截图验证（可选，需要本机有 Edge）

headless 截图**不可靠**：`--virtual-time-budget` 快进虚拟时间，但图片解码在别的
线程上，经常拍到「文字和 CSS 都好了、位图还没上屏」的那一帧，看起来就是几个空白圆角块。
同一个页面连拍三次，文件大小能差一倍。

而且 `--virtual-time-budget` 对**测量**来说是个陷阱：它只快进动画时钟，
`performance.now()` 基本按真实时间走。实测同一时刻两条弹幕的动画进度已经到
`2.696` 圈，而 `performance.now()` 才推到 `0.538` 圈 —— 算出来的位置和画出来的
位置差出 2000px 以上，看着像布局全错，其实纯属测量假象。

所以现在**默认不用虚拟时间**，改用探针的 `&slow=` 参数把 load 事件拖住，
让真实时间真的流过去：

```bash
# 探针路由（虚拟的，不落盘，dist/ 永远是干净产物）
#   p=   要装进 iframe 的页面       y=   滚到哪个偏移
#   slow= 塞一张 /__slow?ms=N 的图把 load 拖住 N 毫秒（= 真实等待）
#   diag=1 输出每张图的状态   dm=1 跑弹幕几何校验   sec=1 输出各板块偏移
#   geo=1  dump 一批元素的几何（换材质没动排版）    ptr=1 跑鼠标向量链路
http://127.0.0.1:8791/__probe.html?p=/&y=990&slow=5000

# 截图（真实等待，不会拍到空白块）
msedge --headless --disable-gpu --hide-scrollbars \
  --user-data-dir=/tmp/p1 --window-size=1440,990 \
  --screenshot=out.png \
  "http://127.0.0.1:8791/__probe.html?p=/&y=990&slow=5000"

# 读回某页图片的真实状态
msedge --headless --dump-dom \
  "http://127.0.0.1:8791/__probe.html?p=/&y=2480&diag=1"
```

`diag` 会输出每张图的 `complete` / `naturalWidth` / 实际盒子尺寸。
`complete:true` + `naturalWidth>0` + 盒子正常 = 图片是好的，纯粹是截图时序。

**为什么 `slow` 这一招管用**：`--dump-dom` / `--screenshot` 都是**等 load 事件**才动手，
而 load 会等所有 `<img>`。塞一张故意慢的图，就能把「何时动手」推迟到任意时刻，
不需要 `--virtual-time-budget`、也不需要常驻浏览器进程。

> 常驻进程路线（CDP `--remote-debugging-port` + `tools/browser-probe.cjs`）在本机
> **跑不通**：只要留下活着的浏览器进程，命令就会被整个 SIGTERM 掉。
> 所以 `browser-probe.cjs` 在能用它的环境里更好用（固定视口、可 `Runtime.evaluate`），
> 但**别把它当唯一手段** —— `slow=` 这条纯一次性进程的路子才是稳的。

**顺手把 y 偏移量出**：布局一改，硬编码的 y 就废了。用 `sec=1` 先量一遍：

```bash
msedge --headless --dump-dom \
  "http://127.0.0.1:8791/__probe.html?p=/&sec=1&d=3500&slow=4200"
# -> 首页 5732px：splash 0 / intro 990 / walls 1937 / projects 3769 / contact 4966
```

`diag` 会输出每张图的 `complete` / `naturalWidth` / 实际盒子尺寸。
`complete:true` + `naturalWidth>0` + 盒子正常 = 图片是好的，纯粹是截图时序。

---

## 九、部署

### 已上线

**<https://auxiaweb.pages.dev/>** —— Cloudflare Pages，项目 `auxiaweb`。

上传对象是 `dist/`（`python tools/build_site.py` 的产物）。

> **曾经同时挂在两个宿主上。** 另一个是内置发布通道给的
> `auxia-site.app.workbuddy.host`，两边内容完全相同。2026-10-02 按站主要求
> **把那一份下线了**：两个地址同时活着只会让「哪个是正式地址」一直含糊。
> 它现在返回 **404**（实测），分享链接已失效。

Pages 上线后逐项验过：

| 检查 | 结果 |
|---|---|
| 首页 / 展墙 / 4 个项目页 / 404 / manifest | 全部 **200** |
| `/assets/...`、`/data/*.json`（根绝对路径） | 全部 **200** —— 站点是挂在**域名根**上的，所以根绝对路径成立 |
| 首页真实渲染 | `<img>` 11 个、橱窗 **10 件**、背景插画 `bg-img.is-ready` 且带真实 `src` |
| 内嵌 Demo | `/projects/liar-game/` 的 `<iframe src="liar-card.html">` 在位，卡片 200（含 5 处 `backdrop-filter` + 鼠标向量脚本） |
| `_headers` / `_redirects` | **真的生效**（只有 Pages 会读这两个文件）—— 见下面「canonical 与对外域名」 |

并且**在新域名下另起真实浏览器**验收过一次。这套才是有效证据：
`curl` 只能证明「文件传上去了」，证不了「页面跑起来了」。

| 检查 | 结果 |
|---|---|
| 标题 | `Auxia的个人小站` |
| `canonical` | `https://auxiaweb.pages.dev/` |
| `<img>` | 11 个，**碎图 0 个**（`naturalWidth===0` 的一个都没有） |
| 字体预载 | 7 条 `link[rel=preload]` |
| 弹幕 | 38 个节点在跑 |
| 打字机 / LOGO 字体 | 在位 / `document.fonts.check()` → `true` |
| 加载失败请求 | **0 个 4xx/5xx** |
| 实际发起的外部请求 | 只有 `v1.hitokoto.cn` —— 「零外部请求（除一言）」这条承诺在新宿主上依然成立 |

### 上传到 Cloudflare Pages

**现状（2026-10-02 起）**：Pages 项目 **`auxiaweb`** 已建好并发布成功，
线上地址 **<https://auxiaweb.pages.dev/>**（账户 id `6abdb26c02b6d078bbd02a75841bcf84`）。
所以下面这条路已经完整走通过一次，**以后更新只是重复第 5 步**。

产物是纯静态，**没有后端 / Functions 要一起传**，`dist/` 里的东西就是全部。

#### ⚠️ 要 `.pages.dev`，必须走旧版 Pages 流程

现在点「创建应用程序」默认落到的是**新版 Workers 静态资源**流程，
那个出来的是 `*.workers.dev`，**不是** `.pages.dev`。同一个页面上两个入口：

| 「Create an app」页上的选项 | 走到哪 | 域名长什么样 |
|---|---|---|
| `Upload your static files` | 新版 Workers 静态资源 | `*.workers.dev` ❌ |
| **`Continue to Pages`**（最下面那行小字） | **旧版 Pages 流程** | **`*.pages.dev`** ✅ |

#### 路 A：网页上传（现在在用的就是这条）

完整点击路径（对照走一次就记住了）：

1. <https://dash.cloudflare.com/> → **Workers 和 Pages** → **创建应用程序**
2. 在「Create an app / Select a method」里点最下面那行小字 **`Continue to Pages`**
3. 在「How would you like to begin?」里选 **`Drag and drop your files`** 右侧的 `Get started`
4. **Project name** 填 `auxiaweb` → **Create project**
   （页面会回显「Your project will be deployed to `auxiaweb.pages.dev`」——
   **先确认这一行再往下**，项目名建完就固定了）
5. 拖入 **`build/dist-site.zip`** → 等进度到 **`141/141 files uploaded`** → 点 **Deploy site**

**以后每次更新**：进项目页 → 点 **`Create deployment`** → 拖入 zip → 点 **`Save and deploy`**。

⚠️ 更新页和首次创建页**不是同一张**，多了一个环境选择：

| 控件 | 首次创建 | 每次更新 |
|---|---|---|
| 主按钮文案 | `Deploy site` | **`Save and deploy`** |
| 部署环境 | （没有） | **`Production` / `Preview`**，默认 Production |

**发生产必须确认选的是 `Production`。** 选成 `Preview` 的话，部署一样成功、
进度一样走到 141/141、Dashboard 一样是绿的 —— 但**生产域名 `auxiaweb.pages.dev`
根本不会更新**，你打开还是旧内容。这类静默失败只能靠「点之前断言一次」
（`input[type=radio][value="production"]` 的 `checked === true`）来防。

顺带一条：更新页的 `Create deployment` 是 **`<a href=".../deployments/new">` 不是按钮**，
按按钮角色去找会一直等到超时；而且它是 SPA 路由 —— 直接对该 URL 做整页 `goto`
会超时且 URL 不变，**点它自己的链接**才走得通。

#### 上传用 zip，别用文件夹

上传区同时收「一个文件夹」和「`.zip`」两种，**用 zip**：

- 自己用浏览器手动拖文件夹没问题，随便；
- 但**自动化里拖文件夹会挂住** —— 实测往那个 `webkitdirectory` 输入框塞 141 个文件，
  **两分多钟没有任何响应**；换成 zip 是单文件，**9 秒**走完，页面直接显示 `141/141 files uploaded`。
  原因大概是逐文件走 CDP 太慢，而 zip 只传一个流。

zip 自己生成，**不要手压**：

```bash
cd <项目目录>/auxia-site
python tools/build_site.py        # 重新装配 dist/
python tools/make_dist_zip.py     # 产出 build/dist-site.zip
```

`tools/make_dist_zip.py` 存在的唯一理由是：压 zip 有一个**静默的结构要求** ——
**`index.html` 必须在 zip 根部**（也就是压 `dist` 的*内容*，不是压 `dist` 这个目录）。

> 压错了**不会报任何错**：本地解压正常、上传进度照样走到 141/141、
> Dashboard 也照样显示部署成功 —— **只有打开域名才是 404**。
> 所以脚本在落位之前自检，结构不对就退 1，并且**不动已有的好包**（先写临时文件、校验过了才 `os.replace`）。
> 它还有一道体积预检：`--src` 若指向整个项目而不是 `dist/`，会在开始压之前就拒绝
> （实测那种误操作会压出 2.9 GB 的包）。

#### 路 B：wrangler 命令行（想少点鼠标时用）

```bash
npx wrangler login                                        # 首次，会开浏览器走 OAuth
npx wrangler pages deploy dist --project-name=auxiaweb    # 每次发布
```

`wrangler login` 开不了浏览器（CI、或没有桌面交互的会话）就改用 API Token，
**别把 token 写进仓库**：

```bash
export CLOUDFLARE_API_TOKEN=<dash.cloudflare.com/profile/api-tokens 建，模板选 "Edit Cloudflare Workers">
export CLOUDFLARE_ACCOUNT_ID=6abdb26c02b6d078bbd02a75841bcf84
npx wrangler pages deploy dist --project-name=auxiaweb
```

### canonical 与对外域名：只有一个真源

`canonical` / `og:url` / `og:image` / `twitter:image` 印的是**绝对域名**，
真源只有一个：`tools/common.py` 的 `PUBLIC_ORIGIN`。

**这里踩过一个坑，值得单独记一笔** —— 「改一处全站同步」这句话以前是**假的**：

- **从常量生成**的页面（4 个项目页）跟着常量变；
- **人写的**页面（首页 `index.html`、展墙 `gallery/index.html`）不变 —— 域名直接写在 HTML 里。

于是换域名那天，项目页变了、首页和展墙没变。更糟的是当时的自检只断言了
`index.html` 的 `canonical` **一条**，所以它一直看着是绿的，直到真换域名才露出来。
而同一个域名在首页出现 **4 次**，当时只断了 2 次（`og:image` 断了，`twitter:image` 没断）。

**现在的做法**：源码 HTML 里不许写绝对域名，一律写占位符 **`{{ORIGIN}}`**，
由 `build_site.py` 装配 `dist/` 时注入。替换是**逐字节**做的
（`read_bytes` / `write_bytes`），不会顺手把行尾改掉。

改域名的完整动作（顺序有讲究，`og-cover` 那张图上也印着域名）：

```bash
cd <项目目录>/auxia-site
# 1) 先改 tools/common.py 里的 PUBLIC_ORIGIN
python tools/build_icons.py           # og-cover 图上印着域名，必须重出
python tools/gen_project_pages.py     # 项目页的 canonical / og:url
python tools/build_fonts.py           # 上一步重生成页面会冲掉字体预载注入，必须补跑
python tools/build_site.py            # 注入 {{ORIGIN}} -> dist/
node tools/smoke-test.cjs             # 会拦住漏改的域名字面量
python tools/make_dist_zip.py         # 打包，拖进 Pages
```

守卫（每条都注入故障验过会变红）：

| 断言 | 守什么 |
|---|---|
| `canonical` / `og:image` / `twitter:image` **各断一条** | 同一个域名在一页里出现几次就断几次。只断 canonical 会漏掉 twitter 卡片那次 |
| 手写页面里没有写死的站点域名 | 防「哪天有人图省事又把域名写回 HTML」 |
| 产物里没有残留 `{{ORIGIN}}` | 反向：防注入没生效。残余会让 `og:image` 变成坏地址 —— 页面照常渲染，只有分享卡片是坏的 |
| 产物里不出现被他人占用的 `auxia.pages.dev` | 那个域名**是别人的站**，canonical 指过去等于告诉搜索引擎「正版在人家那里」 |
| 产物里不出现已下线的 `auxia-site.app.workbuddy.host` | 「界面上不再提到」和「产物里不再出现」是两件事，只有后者可验证 |

`_headers` / `_redirects` 是 **Cloudflare Pages 专有**格式，只有 Pages 会读，实测生效：
`/assets/js/*` 的响应头正是 `_headers` 里写的 `Cache-Control: public, max-age=86400`；
不存在的路径返回 404，且是 `_redirects` 里 `/* /404.html 404` 兜住的那张**自定义** 404 页
（要把它和 CDN 默认 404 页区分开，两者状态码都是 404）。

### 回滚

Dashboard 项目页 → **Deployments** → 任意旧版本右侧 **`Rollback`**，
或用 `npx wrangler pages deployment list` 查历史。
本站纯静态、无状态，回滚不需要动数据。

> 内置发布通道那条路已按站主要求下线（见「已上线」）。真要恢复：
> 它按**目录**收敛，重新发布 `dist/` 就会拿回同一个应用与同一个链接。

---

## 十、待补

| # | 项 | 现状 |
|:-:|---|---|
| 1 | 背景插画数量 | 现在只有 **10 张**（站主换成了适配网页比例的横构图），五个色系桶里 `cream` 是空的、`warm` 只有 1 张。轮换算法已经能保证「每页都会把 10 张走一遍」，但**想让观感更丰富只能加图**：往 `random_illust` 里多丢几张再跑 `build_illust_pool.py` |
| 2 | 4 个项目的一句话简介 | 由 AI 拟的占位，改 `data/site.json` 的 `projects[].summary` |
| 3 | 音乐墙的歌手名 | 笔记里没有；已尽量联网识别，拿不准的一律题名卡 |
| 4 | ~~坚果云知识库链接~~ | **已下架**（本轮）：站主要求不再暴露私密信息。数据、项目页、生成器条目、目录、备份全部删除，并有守卫扫全站产物确认没有残留外链。「从界面上拿掉」不等于「不在产物里」 |
| 5 | 正式域名 | **已定：继续用 <https://auxia-site.app.workbuddy.host/>**。站主问过改用 `auxiaweb.pages.dev`，实测该名字可用（无 DNS 记录），但**占位需要站主自己的 Cloudflare 账号登录**，我做不了。`auxia.pages.dev` 已被别人占用（HTTP 200，返回的是别人的项目）。换域名只要改 `tools/common.py` 的 `PUBLIC_ORIGIN` 一处，`canonical` / `og:*` 全部由它派生；自检里已有守卫防止旧域名被写回去 |
| 6 | 弹幕里的 3 条占位文案 | `这是一个1.0时期的tip` / `XX，启动！` / `XX XXX XXXX XXX` 是早先留下的，站主没说要删就没动 —— 要删直接改 `data/site.json` 的 `banner.lines` |
| 7 | `docs/screenshots/`（上一轮） | **本轮已过时**，见第 14 行。上一轮拍过 11 张（`01-home-splash` → `11-404`），拍法是探针 `&slow=` 真实等待 + `--dump-dom`/`--screenshot`，不依赖虚拟时间，所以不会拍到空白块 |
| 8 | `tools/browser-probe.cjs` 在本机怎么跑 | **本轮找到了可用姿势**（见「跑长探针的三个坑」）：静态服务与探针**分成两条命令**（或全程绝对路径），长探针**后台跑并落盘**，`--cdp-timeout` 调到时长之上。仍要记住：探针收尾时可能被 SIGTERM，**结果通常已经写进文件了**，先看文件再决定要不要重跑。`killTree()` 按 `--user-data-dir` 收整棵树，否则下一次会因 devtools 端口被占而连不上 |
| 9 | 弹幕几何的端到端残差 | 真实浏览器下 `formulaErr` 恒为 **0**，但 `endErr` 会在 5–45px 之间浮动 —— 这是「算完 `boxes()` 再去读 `getBoundingClientRect()`」之间的几十毫秒里元素继续移动造成的采样抖动（约 212px/s），不是系统性误差。真要压到 0 得在同一帧里取两次快照，收益不大，暂不处理 |
| 10 | 部署 | **已上线**：<https://auxia-site.app.workbuddy.host/>（内置发布通道，上传目录 `dist/`）。`_redirects` / `_headers` 在非 Pages 的宿主上不生效 —— 想要自定义 404 换回 Cloudflare Pages。域名结论见第 5 行 |
| 11 | 液态玻璃只做了「卡片」类 | 按要求改造的是 `.card`（牌面）与承载它的面板（`.side`/`#board`/`.slot`/`#actions`/`#logbox`/`.modal`/`.overlay`）。顶部工具条（`.modes`/`.tbtn`）、`#counts` 里的牌名 chip、`.btn` 仍是原来的实心样式 —— 它们体量小、玻璃只会增加噪声，有意没动。想要「全玻璃」再说 |
| 12 | 玻璃的可读性下限没量过 | `backdrop-filter` 的 blur 值（`--lg-blur: 11px`，窄屏 8px）与面板底色的 alpha（0.62–0.82）是按观感定的，**没有做过对比度实测**。深色主题下牌面文字是 `#e9eaf0`，肉眼很稳；但如果以后有人调高整个环境光晕的亮度，牌面文字可能开始吃力。真要动，改 `--lg-*` 变量即可，别散落改 |
| 13 | 开屏页的小演示（布朗运动） | 右侧那块的「分子随机布朗运动 + 指针推力」已经实测过：`forceAt(x,y)` 单调递减且各向同性（`d5 3.10 > d40 0.286 > d100 0.044 > dR+20 0`）、指针移出后归 0、帧确实在变。留了一条小尾巴：**开屏的首屏有点偏低**（`demoTop 312` vs `copyTop 369`，画布 517×337 落在第一屏下沿之外一点），站主如果想一眼看到演示，把画布整体上移 ~60px 即可 |
| 14 | `docs/screenshots/` 需要重拍 | 现有 11 张是按**上一版**界面拍的（弹幕速度、卡片玻璃、开屏页、项目页都变了）。重拍走 `preview.py` 的 `&slow=` 真实等待 + `--dump-dom`/`--screenshot`，不要用虚拟时间 |
