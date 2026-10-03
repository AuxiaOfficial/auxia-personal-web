/* ==========================================================================
   core.js —— 全站共用机制
     0) 全站共用的 rAF 循环（光标、弹幕命中检测都挂在上面）
     1) 背景图系统（本地插画池按色系优先取图 + 会话级不重复轮换 + 摄影兜底）
     2) 弹幕：每秒固定投放 N 条的投放器 + 指针悬停高亮
     3) 点击粒子
     4) 跟随指针的矢量光标（非线性跟随）
     5) 顶栏吸顶、滚动出现、联系方式防爬
   页面通过 <body data-bucket="..." data-root="../"> 告诉本文件自己的环境。
   ========================================================================== */
(function () {
  'use strict';

  var body = document.body;
  var BUCKET = body.dataset.bucket || 'warm';
  var ROOT = body.dataset.root || './';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var params = new URLSearchParams(location.search);

  var Auxia = (window.Auxia = window.Auxia || {});
  Auxia.bucket = BUCKET;
  Auxia.reduceMotion = reduceMotion.matches;

  /* ------------------------------------------------------------------ 工具 */
  function rgbToRgbTriplet(hex) {
    var h = String(hex || '').replace('#', '');
    if (h.length === 3) { h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; }
    if (!/^[0-9a-f]{6}$/i.test(h)) { return null; }
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function luminance(hex) {
    var t = rgbToRgbTriplet(hex);
    if (!t) { return 0.5; }
    var c = t.map(function (v) {
      var s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  /** accent 用作文字/描边色时，太亮会看不清 —— 压到有对比的区间 */
  function safeAccent(hex) {
    var t = rgbToRgbTriplet(hex);
    if (!t) { return null; }
    var lum = luminance(hex);
    if (lum <= 0.42) { return hex; }
    var factor = 0.42 / Math.max(lum, 0.001);
    factor = Math.max(factor, 0.45);
    return '#' + t.map(function (v) {
      return ('0' + Math.max(0, Math.min(255, Math.round(v * factor))).toString(16)).slice(-2);
    }).join('');
  }

  Auxia.setAccent = function (hex) {
    var safe = safeAccent(hex);
    if (!safe) { return; }
    var t = rgbToRgbTriplet(safe);
    var root = document.documentElement;
    root.style.setProperty('--accent', safe);
    root.style.setProperty('--accent-rgb', t[0] + ', ' + t[1] + ', ' + t[2]);
    Auxia.accentRgb = t;
  };

  function rand(n) { return Math.floor(Math.random() * n); }
  function pick(arr) { return arr.length ? arr[rand(arr.length)] : null; }

  function loadImage(src, timeoutMs) {
    return new Promise(function (resolve) {
      var img = new Image();
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; resolve(false); }
      }, timeoutMs || 9000);
      img.onload = function () {
        if (done) { return; }
        done = true; clearTimeout(timer);
        resolve(img.naturalWidth > 0);
      };
      img.onerror = function () {
        if (done) { return; }
        done = true; clearTimeout(timer);
        resolve(false);
      };
      img.src = src;
    });
  }

  function getJSON(url) {
    return fetch(url, { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  /* ==================================================================
     0. 全站共用的 rAF 循环
     —— 光标跟随与弹幕命中检测都需要「每一帧算一次」。各自
        requestAnimationFrame 的话，后面每加一个动效层就多一个互不知情的
        循环同时跑。这里集中成一个：注册回调即可，页面隐藏时统一停掉。
     ================================================================== */
  var frameHandlers = [];
  var frameHandle = 0;

  function onFrame(fn) {
    if (typeof fn !== 'function') { return; }
    frameHandlers.push(fn);
    startFrames();
  }

  function frameLoop() {
    // 没有订阅者就停掉，别让一个空循环一直占着每一帧
    if (!frameHandlers.length) { frameHandle = 0; return; }
    frameHandle = window.requestAnimationFrame(frameLoop);
    for (var i = 0; i < frameHandlers.length; i++) {
      // 单个回调抛错不能拖垮整页动画
      try { frameHandlers[i](); } catch (e) { /* noop */ }
    }
  }

  function startFrames() {
    if (frameHandle || !frameHandlers.length) { return; }
    if (!window.requestAnimationFrame) { return; }
    frameHandle = window.requestAnimationFrame(frameLoop);
  }

  function stopFrames() {
    if (!frameHandle) { return; }
    window.cancelAnimationFrame(frameHandle);
    frameHandle = 0;
  }

  Auxia.onFrame = onFrame;
  Auxia.startFrames = startFrames;

  /** 与 rAF 时间戳同一时基的毫秒时钟（弹幕的解析几何要用它算进度） */
  function now() {
    return window.performance && window.performance.now
      ? window.performance.now() : Date.now();
  }

  /* ==================================================================
     1. 背景图系统
     ================================================================== */
  var bgEl = document.getElementById('bg');
  var bgImg = bgEl ? bgEl.querySelector('.bg-img') : null;
  var bgCredit = bgEl ? bgEl.querySelector('.credit') : null;
  var bgState = { layer: 'none', credit: null };

  function paintBackground(src, credit, accent) {
    if (!bgImg) { return; }
    // 供调试与冒烟测试判断当前走的是哪条取图路径：illust / photo / gradient
    bgEl.dataset.layer = bgState.layer;
    bgImg.classList.remove('is-ready');
    var probe = new Image();
    probe.onload = function () {
      bgImg.src = src;
      // 双 rAF 确保过渡从当前状态起步
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { bgImg.classList.add('is-ready'); });
      });
    };
    probe.onerror = function () {
      if (bgState.layer !== 'photo') { useLocalFallback(); }
    };
    probe.src = src;

    if (accent) { Auxia.setAccent(accent); }
    renderCredit(credit);
  }

  function renderCredit(credit) {
    if (!bgCredit) { return; }
    if (!credit || (!credit.artist && !credit.name)) {
      bgCredit.hidden = true;
      return;
    }
    bgCredit.hidden = false;
    var kind = credit.kind === 'photo' ? '摄影作品' : '氛围插画';
    var label = credit.artist || credit.name;
    var html = kind + ' · ' + escapeHtml(label);
    if (credit.work) { html += ' 「' + escapeHtml(credit.work) + '」'; }
    if (credit.url) {
      html += ' · <a href="' + encodeURI(credit.url) + '" target="_blank" rel="noopener noreferrer nofollow">原推</a>';
    }
    bgCredit.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  Auxia.escapeHtml = escapeHtml;

  /** 兜底：本地摄影作品。任何情况下都要有一层背景，页面不许开天窗。 */
  function useLocalFallback() {
    getJSON(ROOT + 'data/gallery.json').then(function (g) {
      var wall = null;
      if (g && g.walls) {
        wall = g.walls.filter(function (w) { return w.id === 'photo'; })[0] || null;
      }
      var items = wall && wall.items ? wall.items.slice() : [];
      if (!items.length) {
        // 连数据都取不到：用纯 CSS 渐变兜底，仍不开天窗
        if (bgImg) { bgImg.removeAttribute('src'); bgImg.classList.remove('is-ready'); }
        bgState.layer = 'gradient';
        bgEl.dataset.layer = 'gradient';
        renderCredit(null);
        return;
      }
      var sameBucket = items.filter(function (i) { return i.bucket === BUCKET; });
      var chosen = pick(sameBucket.length ? sameBucket : items);
      bgState.layer = 'photo';
      if (bgImg) { bgImg.classList.add('bg-fallback'); }
      // gallery.json 里的素材路径一律是 root-absolute（/assets/...），
      // 所以这里不能再拼 ROOT，否则在 /gallery/、/projects/<slug>/ 下会拼错。
      paintBackground(chosen.full || chosen.thumb, { kind: 'photo', name: 'Auxia 自摄' }, chosen.accent);
    });
  }
  Auxia.useLocalFallback = useLocalFallback;

  function loadPool() {
    return getJSON(ROOT + 'data/palette-pool.json');
  }

  /* ---- 会话级「已经用过」名单 ----
     按色系桶**锁死**会出现一个很隐蔽的后果：池子一小，每页可选的图就只剩
     两三张（极端情况下只有一张），于是「每刷新一次换一张」成了空话——
     看起来就是「来来回回都是那几张」。
     现在改成：本页色系桶的图被加权（更容易先被抽到），但整池都在候选里，
     一轮把池子走完才重开。名单存 sessionStorage，所以刷新与翻页都接着
     上一张继续往下走，而不是每页各抽各的。 */
  var BAG_KEY = 'auxia.bg.used';
  var SAME_BUCKET_WEIGHT = 3;

  function readUsed() {
    try {
      var arr = JSON.parse(window.sessionStorage.getItem(BAG_KEY) || '[]');
      return Object.prototype.toString.call(arr) === '[object Array]' ? arr : [];
    } catch (e) { return []; }
  }

  function writeUsed(ids) {
    try { window.sessionStorage.setItem(BAG_KEY, JSON.stringify(ids)); }
    catch (e) { /* 隐私模式 / 禁用存储：退化成每次纯随机，不影响可用性 */ }
  }

  /** 纯函数：池子 + 本页色系 + 已用名单 -> 这一页用哪张，及更新后的名单。
      抽成纯函数是为了自检能直接把它跑一遍（不依赖真实渲染与网络），
      把「同一个色系连抽多次不会再只在一两张里打转」这件事钉死。 */
  Auxia.pickBackground = function (pool, bucket, used) {
    var usedIds = used ? used.slice() : [];
    var cands = [];
    (pool && pool.all ? pool.all : []).forEach(function (it) {
      if (!it || !it.src) { return; }
      var weight = it.bucket === bucket ? SAME_BUCKET_WEIGHT : 1;
      for (var i = 0; i < weight; i++) { cands.push(it); }
    });
    if (!cands.length) { return { item: null, used: usedIds, recycled: false }; }

    var fresh = cands.filter(function (it) { return usedIds.indexOf(it.id) < 0; });
    var recycled = false;
    if (!fresh.length) { fresh = cands; usedIds = []; recycled = true; }

    var item = fresh[Math.floor(Math.random() * fresh.length)];
    return { item: item, used: usedIds.concat([item.id]), recycled: recycled };
  };

  function loadPool() {
    return getJSON(ROOT + 'data/palette-pool.json');
  }

  function initBackground() {
    if (!bgEl || !bgImg) { return; }

    // ?imgfail=1 可以强制走兜底，用来验收「插画池取不到时也不出天窗」
    if (params.get('imgfail') === '1') {
      useLocalFallback();
      return;
    }

    // 背景图现在是**同站自托管**的 WebP（data/palette-pool.json 里的 src），
    // 不再经过任何代理接口，所以没有「上游挂了」这一档；
    // 唯一的失败路径是数据取不到 / 池子里没图 —— 那就退到本地摄影。
    loadPool().then(function (pool) {
      var res = Auxia.pickBackground(pool, BUCKET, readUsed());
      if (!res.item) {
        useLocalFallback();
        return;
      }
      writeUsed(res.used);
      bgState.layer = 'illust';
      paintBackground(res.item.src, null, res.item.accent);
    });
  }

  /* ==================================================================
     2. 弹幕
     —— 不是「每条文案各挂一个元素无限滚动」，而是**每秒固定投放 N 条**：
        定时器按节奏生成、CSS 动画负责飘过、animationend 负责回收。
        这样「弹幕量」是一个能直接调的旋钮（DM_PER_SEC），
        而不是被「文案有多少句」间接决定 —— 加了 17 句文案，密度不该跟着变。

     悬停高亮为什么不能用 CSS :hover：
        #danmaku 的 z-index 是 1，而 main 是 5。main 的盒子虽然透明，
        但未声明 pointer-events:none 就照样吃掉命中测试 ——
        指针永远碰不到弹幕，.dm-item:hover 一辈子不会触发。
        （把弹幕抬到 main 之上又会让它盖住正文，更糟。）
        所以命中检测改成自己算：弹幕都是 translate3d 的匀速直线运动，
        几何是解析可求的，逐帧算术比 getBoundingClientRect 便宜得多。

     ⚠️ 为什么是**恒定速度**（dur 由每条自己的宽度反推），而不是随机时长：
        CSS 动画走完的距离是 (w + 2·100vw)，所以「时长相同」并不等于
        「速度相同」—— 字宽不同，速度就不同。只要同一泳道里两条速度不等，
        快的那条迟早会追尾慢的那条，**在任何投放策略下都会重合**。
        把速度钉成常数之后，同泳道两条的相对位置永远不变：
        进场时留够空隙 ⇒ 之后一直不会撞上。
        于是「不重合」从一个调参问题变成了一个可以被证明的性质。
     ================================================================== */
  /* ⚠️ 这两个旋钮是**联动**的，动一个必须回头看另一个。
     屏幕上「同时在场」的条数 ≈ DM_PER_SEC × 一条的存活时间，
     而存活时间 = (字宽 + 2·屏宽) / (屏宽 × DM_SPEED)，
     所以 **DM_SPEED 减半 = 每条多活一倍 = 同时在场条数翻倍**。

     第五轮站主说「速度放慢一半」。如果只动 DM_SPEED，
     屏幕上的条数会直接翻倍（3 × 50s = 150 条），
     那不但会撞上 DM_MAX=90 的名额上限、被静默丢掉 40% 的投放，
     视觉上也只会更吵 —— 和「放慢」想要的效果正好相反。
     所以两个一起减半：条数不变、每条走得更慢，这才是「放慢」。

     算一下（1440px 宽、一条 20 个汉字 ≈ 358px）：
       旧：速度 129.6px/s，存活 (358+2880)/129.6 = 25.0s，3/s × 25 = 75 条
       新：速度  64.8px/s，存活 (358+2880)/64.8  = 50.0s，1.5/s × 50 = 75 条
     同时 12 条泳道的容纳上限 ≈ 12 × (2·1440+358)/(358+72) ≈ 90，
     和 DM_MAX 正好对上 —— 两边都还有余量，不会再出现「挤不下就丢」。 */
  var DM_PER_SEC = 1.5;        // 每秒投放条数
  var DM_SPEED = 0.045;        // 每秒走过多少「屏宽」—— 唯一的快慢旋钮
  var DM_GAP = 72;             // 同泳道内两条之间的最小空隙（px）
  var DM_SCALE = [0.85, 1.22]; // 字号随机区间（相对 CSS 里的 clamp 基准）
  var DM_MAX = 90;             // 同时在屏上限，防止长挂页面把 DOM 撑爆
  var DM_LANE_TOP = 12;        // 弹幕带纵向区间（%，避开顶栏与页脚）
  var DM_LANE_BOTTOM = 88;

  /* ------------------------------------------------------------------
     2.5 一言（hitokoto.cn）
     —— 全站唯一的**外部请求**。所以处处留了后路：
       · 在 data/site.json 里可以整个关掉（banner.hitokoto.enabled）
       · 比例可调（banner.hitokoto.ratio），其余用站主自己的文案兜底
       · 预取一小批放进缓冲，用完再补 —— 绝不为每条弹幕各发一个请求
       · 结果缓存在 sessionStorage，翻页复用，不会把接口打爆
       · 拿不到就是拿不到：静默回落到本地文案池，弹幕照常跑，绝不空转

     ⚠️ 站主第五轮要把比例提到 85%。这里有个**没法绕过的算术**要讲清楚：
       一言接口一次调用只返回一条，没有批量端点。
       于是「85% 的弹幕来自一言」在数学上就等于
         DM_PER_SEC × ratio × 60 = 1.5 × 0.85 × 60 ≈ 76.5 次请求/分钟。
       这是接口能力决定的，不是实现方式决定的 —— 想少请求就只能是低比例。
       本站是个人站、通常只有一个标签页在跑，76 次/分钟属于「重但可接受」；
       为了不让它失控，下面仍加了滚动窗口预算 MAX_REQ_PER_MIN 当天花板，
       超了就静默降级回本地文案（页面表现是「一言变少了」，不会报错、不会空转）。

       76.5 < 100 ⇒ 比例**在预算内是可得的**。但"预算够"不等于"供得上"：
       实测往返平均 ~1.6s、最坏 ~3.0s，而需求是 1.275 次/秒 —— 串行补货
       的容量只有 0.48 次/秒。所以补货必须是**并发**的（见 MAX_CONC）。
       另外接口挂在 Cloudflare 后面、URL 又是恒定的，会被边缘缓存
       反复喂同一条（见 endpoint()）—— 那也是供给减半。
       这几条缺一条，85% 就只是写在配置里的数字。
     ------------------------------------------------------------------ */
  var HITOKOTO_API = 'https://v1.hitokoto.cn/';

  function createHitokoto(cfg) {
    if (!cfg || cfg.enabled === false) { return null; }
    var ratio = typeof cfg.ratio === 'number' ? cfg.ratio : 0.4;
    if (ratio <= 0) { return null; }

    var CACHE_KEY = 'auxia.hitokoto.buf';
    var MAX_LEN = cfg.maxLength || 48;
    var LOW = 6, HIGH = 20;             // 缓冲水位：低于 LOW 就算"见底"，补到 HIGH 停手
    /* ⚠️ MAX_REQ_PER_MIN 从 80 提到 100，是**实测逼出来的**，不是随手放宽：
       需求是 76.5 次/分钟，而补货还要先把缓冲填到 HIGH(=20) 条 ——
       那 20 次是"起步一次性"的开销。于是**第一分钟总共要 76.5 + 20 ≈ 96.5 次**，
       而老的 80 上限连需求本身都只有 4% 余量，起步那一填立刻就把窗口打满。
       更糟的是滚动窗口一旦打满就是**硬停**，不是降速 ——
       实测（1440×990，55 秒）：
         t≈25s  hkShare 0.842  hkBuf 1
         t≈30s  reqWindow 80 / budget 0   ← 窗口打满，此后一次都不再发
         t≈55s  hkShare 0.389  hkMiss 41  ← 掷中一言却拿不到，静默回落本地
       也就是「比例写 0.85、实测掉到 0.39」，而且哪里都不报错。
       注意：把上限提到 100 **并不等于**给接口更大压力 —— 补货是需求驱动的，
       长期实际速率仍由弹幕需求决定（约 76.5 次/分钟），
       上限只是防止"起步一次性开销"把后续整整一分钟掐死的安全阀。 */
    var MAX_REQ_PER_MIN = 100;
    /* ⚠️ 为什么必须**并发**补货，而不是"一条一条来"：
       实测（本机 → v1.hitokoto.cn，Cloudflare 边缘）单次往返
       **平均约 1.6 秒、最坏摸到 3.0 秒**。串行的老写法是
       「等这一条回来，再等 GAP_URGENT(500ms)，再发下一条」——
       一个周期 2.1s 起步，也就是**最多 0.48 次/秒 = 29 次/分钟**。
       而 85% 这个比例需要的需求是 1.5 × 0.85 = 1.275 次/秒 = 76.5 次/分钟。
       供给连需求的一半都不到 ⇒ 缓冲常年是空的（实测 hkBuf 一直在 0~1），
       nextText() 掷中"要用一言"之后 take() 拿不到东西，静默回落本地文案 ——
       页面看上去一切正常，实际一言占比远低于 85%，而且**哪里都不报错**。

       并发的容量 = MAX_CONC / 往返延迟。按最坏 3.0s 算：
         5 / 3.0 ≈ 1.67 次/秒 = 100 次/分钟 > 76.5 的需求（约 30% 余量）；
       按平均 1.6s 算是 3.1 次/秒，绰绰有余。
       于是真正的天花板回到 MAX_REQ_PER_MIN 上，而它盖得住，
       85% 才第一次变得**可达**。
       注意：并发不等于"发得更多" —— 补货是**需求驱动**的，
       缓冲到位就停手，所以长期实际速率仍由弹幕需求决定（约 76 次/分钟）。
       取 5 而不是 3，就是为了扛住 3 秒那一档的延迟尖峰。 */
    var MAX_CONC = 5;
    var cats = cfg.categories || [];

    var buf = readCache();
    var inFlight = 0;
    var failures = 0;
    var dead = false;
    var stamp = [];                     // 最近几次请求的发出时间，算滚动窗口用
    var sent = 0;                       // 累计发出的请求数（只给探针看）
    /* 每一次请求的**结局**分门别类记一笔。
       ⚠️ 为什么非数不可：老代码是 `r.ok ? r.json() : null`，
       非 200 的响应被后半句静默变成 null，然后在 `.then` 里 `return` 掉 ——
       既不进 failures、也不调 fill()。后果是 inFlight 一条条漏光、
       供给「悄悄地」停住，而所有计数器都是干净的 0：
       页面不报错、控制台不报错，只是实测比例从 0.84 慢慢掉到 0.33。
       这类"哪儿都不报错"的故障，只能靠把结局摊开来看才抓得住。 */
    var stats = { yield: 0, dup: 0, tooLong: 0, bad: 0, r429: 0, netErr: 0 };
    var lastStatus = null;              // 最近一次的 HTTP 状态码（0 = 网络层就失败了）
    /* 撞上 429 之后的静默期。429 的含义是「接口活着，是我们太快了」——
       该做的是退避，不是判死。 */
    var cooldownUntil = 0;

    /** 滚动 60 秒里还剩多少请求额度。顺便把过期时间戳清掉。 */
    function budgetLeft() {
      var cut = Date.now() - 60000;
      while (stamp.length && stamp[0] < cut) { stamp.shift(); }
      return MAX_REQ_PER_MIN - stamp.length;
    }

    function readCache() {
      try {
        var a = JSON.parse(window.sessionStorage.getItem(CACHE_KEY) || '[]');
        return Object.prototype.toString.call(a) === '[object Array]' ? a : [];
      } catch (e) { return []; }
    }
    function writeCache() {
      try { window.sessionStorage.setItem(CACHE_KEY, JSON.stringify(buf.slice(-30))); }
      catch (e) { /* noop */ }
    }

    function endpoint() {
      var u = HITOKOTO_API + '?encode=json&charset=utf-8';
      for (var i = 0; i < cats.length; i++) { u += '&c=' + encodeURIComponent(cats[i]); }
      /* ⚠️ 末尾这个变化参数是**必须的**，不是装饰。

         实测（同参连打 14 次）：接口只回了 **7 条不同的句子** ——
         每一条都原样重复出现两次。而带上随机参数再打 8 次，就是 8 条全不重复。
         原因写在响应头里：`Server: cloudflare`。一言挂在 Cloudflare 后面，
         我们的 URL 又是**恒定**的，于是边缘节点按 URL 缓存，
         在 TTL 窗口里把同一个响应体反复发回来。

         后果很直接：下面那句 `if (buf.indexOf(t) < 0)` 会把重复的那条丢掉，
         等于**一半的请求白发了**。而 85% 这个比例本来就只有 4% 的余量，
         供给被砍掉一半 ⇒ 缓冲永远见底 ⇒ 掷中一言却 take() 到 null，
         静默回落本地文案（实测占比最终只有 0.33，配置里写的却是 0.85）。
         加上这个参数只是把边缘缓存绕开：**请求次数不变**，
         但每一条都真的换回一句新话。 */
      u += '&_=' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      return u;
    }

    function fill() {
      if (dead || buf.length >= HIGH) { return; }
      if (typeof document.hidden === 'boolean' && document.hidden) { return; }
      if (Date.now() < cooldownUntil) { return; }   // 退避期内不发（见 catch 里的 429）
      // 额度用完就不发了。**不设标记位**：过一会儿窗口滑过去、额度回来了，
      // 下一次 take() 触发 fill() 时会自动恢复，不需要额外逻辑。
      if (budgetLeft() <= 0) { return; }
      // 把并发的坑填满：每发一条就再进一层，直到 MAX_CONC 或水位/额度到顶。
      // 这是"补满管道"，不是"打满接口"——验收条件是缓冲深度，不是请求条数。
      while (inFlight < MAX_CONC && buf.length < HIGH && budgetLeft() > 0) {
        issue();
      }
    }

    function issue() {
      inFlight += 1;
      sent += 1;
      stamp.push(Date.now());
      fetch(endpoint(), { credentials: 'omit' })
        .then(function (r) {
          lastStatus = r.status;
          if (!r.ok) {
            // ⚠️ 这一句是补上的**关键缺陷修复**，不是防御性编程。
            // 老写法 `return r.ok ? r.json() : null` 把非 200 变成 null，
            // 下面 `if (!j) return;` 直接走人 —— 槽位释放了，但**管道不再补**，
            // 而且 failures 一动不动。于是"供给悄悄停住"这件事
            // 在任何一个计数器上都看不出来，只能从"比例越来越低"倒推。
            var e = new Error('http ' + r.status);
            e.status = r.status;
            throw e;
          }
          return r.json();
        })
        .then(function (j) {
          inFlight -= 1;
          if (!j || typeof j.hitokoto !== 'string') { stats.bad += 1; fill(); return; }
          failures = 0;                 // 成功即清零：算的是**连续**失败次数
          var t = j.hitokoto.replace(/\s+/g, ' ').trim();
          // 太长的一言飘过去看着累，直接不要
          if (!t || t.length > MAX_LEN) { stats.tooLong += 1; fill(); return; }
          if (buf.indexOf(t) < 0) { buf.push(t); stats.yield += 1; }
          else { stats.dup += 1; }      // 绕开缓存后这个数应该接近 0，它涨了就说明绕不开了
          writeCache();
          fill();                       // 回来一条，立刻把管道补满
        })
        .catch(function (e) {
          inFlight -= 1;
          if (e && e.status === 429) {
            /* 429 = 「接口活着，是我们太快了」。这时候**绝不能**算连续失败、
               更不能判死 —— 那等于在最该慢下来的时候彻底放弃。
               正确反应是退避：停 20 秒让滚动额度滑过去，然后自动恢复补货。
               （实测：同参数连打 120 次会出现 22 个 429，60 次内还是全 200，
               所以限流是真实存在的一条线，不是理论顾虑。） */
            stats.r429 += 1;
            cooldownUntil = Date.now() + 20000;
            window.setTimeout(fill, 20500);   // 略晚于冷却点，保证这次 fill 不被自己挡回去
            return;
          }
          stats.netErr += 1;            // 到不了服务器（离线、DNS、CORS…）
          failures += 1;
          // 连不上就别一直试：连续试满 3 次就彻底放弃，弹幕全部走本地文案
          if (failures >= 3) { dead = true; }
          else { window.setTimeout(fill, 4000); }
        });
    }

    function take() {
      var t = buf.length ? buf.shift() : null;
      writeCache();
      fill();
      return t;
    }

    fill();

    return {
      ratio: ratio,
      take: take,
      size: function () { return buf.length; },
      onVisible: fill,
      /* 只读诊断 —— 探针靠它判断「85% 这个比例到底供不供得上」，
         而不是只看到一个"最终比例偏低"的结果却不知道卡在哪一环。 */
      diag: function () {
        return {
          buf: buf.length, low: LOW, high: HIGH,
          inFlight: inFlight, conc: MAX_CONC,
          sent: sent, reqWindow: stamp.length, budget: budgetLeft(),
          failures: failures, dead: dead,
          /* 结局明细：把「发了 100 次、只有 30 条换回句子」这种
             供给缺口拆成可归因的几类，而不是只知道"比例不对"。 */
          yield: stats.yield, dup: stats.dup, tooLong: stats.tooLong,
          bad: stats.bad, r429: stats.r429, netErr: stats.netErr,
          lastStatus: lastStatus,
          cooling: Date.now() < cooldownUntil
        };
      }
    };
  }

  /** 没有布局引擎时（jsdom）getBoundingClientRect 全是 0，
      用一次粗略估算兜底，好让命中检测在自检里也能真的跑到。
      真实浏览器永远拿到的是实测值。scale 是这一条的字号倍率。 */
  function estimateWidth(text, scale) {
    var units = 0;
    for (var i = 0; i < text.length; i++) {
      units += text.charCodeAt(i) > 0x2e80 ? 1 : 0.56;
    }
    return Math.round((units * 17 + 18) * (scale || 1));
  }

  function initDanmaku(lines, hkCfg) {
    var host = document.getElementById('danmaku');
    if (!host || reduceMotion.matches) { return; }
    if (!window.requestAnimationFrame) { return; }

    var pool = (lines || []).filter(function (t) { return t && String(t).trim(); });
    var ik = createHitokoto(hkCfg);
    if (!pool.length && !ik) { return; }

    var LANES = window.innerWidth < 640 ? 6 : 12;
    var laneEls = [];
    var laneLastItem = [];       // 每条泳道「最后投放的那一条」，用于占用判断
    var live = [];
    var hot = null;
    var hotGroup = [];           // 悬停时一起停住的那些（含 hot 自己）
    var px = -1, py = -1, hasPointer = false;

    /* 文案来源的计数。
       ⚠️ 为什么非数不可：站主要的是「**显示出来**的弹幕里 85% 来自一言」。
       而这个比例和"请求发出去多少条"不是一回事 —— 掷中一言之后如果缓冲是空的
       （take() 返回 null），代码会**静默回落本地文案**，页面一切正常，
       比例却悄悄掉下去。不分开数，就只能看到"最终比例偏低"而看不出原因。
         hkShown / localShown —— 真正上屏的来源分布（分子/分母都在这里）
         hkMiss             —— 掷中一言但缓冲为空（供不上）的次数，问题的直接证据 */
    var hkShown = 0, localShown = 0, hkMiss = 0;

    // rand(n) 用模块级的那个（文件开头已定义），这里只需要一个浮点版本
    function randf(a, b) { return a + Math.random() * (b - a); }

    /* ---------- 泳道 ---------- */
    function laneTopPct(i) {
      return LANES > 1
        ? DM_LANE_TOP + i * (DM_LANE_BOTTOM - DM_LANE_TOP) / (LANES - 1)
        : DM_LANE_TOP;
    }
    function viewH() { return host.clientHeight || window.innerHeight || 800; }
    function laneY(i) { return viewH() * laneTopPct(i) / 100; }
    /** 相邻泳道的垂直间距（px）。用来给「随机纵向抖动」定上限。 */
    function lanePitch() {
      return LANES > 1 ? viewH() * (DM_LANE_BOTTOM - DM_LANE_TOP) / 100 / (LANES - 1) : 0;
    }
    /** 抖动上限：抖动后仍不能碰到相邻泳道的内容。
        留 34px 给「字号上限时的行高 + 上下 padding」，够了。 */
    function laneJitter() { return Math.max(0, (lanePitch() - 34) / 2); }
    function layoutLanes() {
      for (var i = 0; i < laneEls.length; i++) {
        laneEls[i].style.top = laneTopPct(i) + '%';
      }
    }
    for (var li = 0; li < LANES; li++) {
      var lane = document.createElement('div');
      lane.className = 'dm-lane';
      host.appendChild(lane);
      laneEls.push(lane);
      laneLastItem.push(null);
    }
    layoutLanes();

    /* ---------- 解析几何 ----------
       CSS 上每条弹幕都是 @keyframes dm-scroll 的匀速直线运动：
         translateX(p) = 100vw - p * (w + 2·100vw)      p ∈ [0,1]
       所以「此刻它在屏幕上的矩形」可以直接算出来，不用读布局。 */
    function winW() { return window.innerWidth || 1024; }
    /** 恒定线速度（px/s）。所有弹幕共用，这是不重合的前提。 */
    function speed() { return winW() * DM_SPEED; }

    function progress(it, t) {
      var ref = it.pausedAt != null ? it.pausedAt : t;
      var ms = ref - it.t0 - it.pausedTotal;
      return ms <= 0 ? 0 : ms / (it.dur * 1000);
    }
    /** 左边缘的 x。同一条泳道里所有弹幕速度相同，所以这个函数同时也
        给出了「谁在前、谁在后」的稳定次序。 */
    function xOf(it, t) {
      var p = progress(it, t);
      return winW() - p * (it.w + 2 * winW());
    }
    /** 某条泳道还能不能塞进一条新弹幕：要求上一条的右边缘
        已经退到「新弹幕入场点 - 空隙」的左边。
        两边速度相同 ⇒ 这个空隙一旦成立就永远成立。 */
    function laneClearance(idx, t) {
      var last = laneLastItem[idx];
      if (!last || live.indexOf(last) < 0) { return Infinity; }   // 空泳道
      var right = xOf(last, t) + last.w;
      return (winW() - DM_GAP) - right;
    }

    function boxes() {
      var t = now();
      var vw = winW();
      var out = [];
      for (var i = 0; i < live.length; i++) {
        var it = live[i];
        var p = progress(it, t);
        // ⚠️ 这条 p∈[0,1] 的假设，靠 CSS 那边 `.dm-item` 的
        //    `animation-iteration-count: 1` 撑着。
        //    CSS 一旦写成 infinite，animationend 就不再触发、元素会跑第二圈，
        //    而这里会把第二圈的元素当成"已经跑完、在屏外"直接跳过 ——
        //    结果就是它明明画在屏幕上却永远高亮不了。
        //    两个文件必须同时成立，改动任何一边都要回来对一下。
        if (p <= 0 || p >= 1) { continue; }
        var x = vw - p * (it.w + 2 * vw);
        if (x > vw || x + it.w < 0) { continue; }        // 完全在屏外
        out.push({
          el: it.el, rec: it, x: x, y: laneY(it.lane) + it.dy,
          w: it.w, h: it.h, p: p
        });
      }
      return out;
    }

    /** 命中「指针位置上的弹幕」。重叠时取中心最近的那条，避免来回闪。 */
    function hitBox(x, y) {
      var list = boxes();
      var best = null, bestD = Infinity;
      for (var i = 0; i < list.length; i++) {
        var b = list[i];
        if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) { continue; }
        var d = Math.abs(x - (b.x + b.w / 2));
        if (d < bestD) { bestD = d; best = b; }
      }
      return best;
    }

    // 供自检直接调用的只读视图
    // p 是「推出来的总进度」（可能 >1，长动画会跑第二圈），
    // 留着是为了能在真实浏览器里拿它和元素自己的动画进度对表，
    // 判断偏差是公式写错还是时钟不同步。
    Auxia.danmakuBoxes = function () {
      return boxes().map(function (b) {
        return { el: b.el, x: b.x, y: b.y, w: b.w, h: b.h, p: b.p, lane: b.rec.lane };
      });
    };
    Auxia.danmakuAt = function (x, y) {
      var b = hitBox(x, y);
      return b ? b.el : null;
    };

    /* 「不重合」这条性质是可以直接验的，所以暴露出来给自检和探针用。
       同泳道内按 x 排序，相邻两条之间必须没有交叠。
       因为同泳道速度恒等，只要**某一刻**有序且不交叠，就永远如此 ——
       所以这个检查不是抽样，是充分的。 */
    Auxia.danmakuOverlaps = function () {
      var t = now();
      var bad = [];
      for (var i = 0; i < LANES; i++) {
        var row = [];
        for (var j = 0; j < live.length; j++) {
          if (live[j].lane === i) { row.push(live[j]); }
        }
        row.sort(function (a, b) { return xOf(a, t) - xOf(b, t); });
        for (var k = 1; k < row.length; k++) {
          var left = xOf(row[k - 1], t) + row[k - 1].w;
          var right = xOf(row[k], t);
          var overlap = left - right;
          if (overlap > 0.5) {          // 0.5px 容差，抵掉浮点噪声
            bad.push({
              lane: i, overlap: Math.round(overlap),
              a: String(row[k - 1].el.textContent).slice(0, 8),
              b: String(row[k].el.textContent).slice(0, 8)
            });
          }
        }
      }
      return bad;
    };

    /** 这套参数的只读快照，方便在真实浏览器里核对「速度是不是真的恒等」。 */
    Auxia.danmakuInfo = function () {
      var sp = speed(), t = now();
      var speeds = live.map(function (it) {
        return (it.w + 2 * winW()) / it.dur;
      });
      var hkLive = 0, i;
      for (i = 0; i < live.length; i++) { if (live[i].src === 'hk') { hkLive += 1; } }
      var shown = hkShown + localShown;
      return {
        lanes: LANES, perSec: DM_PER_SEC, speedTarget: sp,
        gap: DM_GAP, lanePitch: lanePitch(), laneJitter: laneJitter(),
        live: live.length,
        // 一言的缓冲深度：探针靠它判断「85% 这个比例到底供得上供不上」
        hkBuf: ik ? ik.size() : 0,
        /* 真正上屏的来源分布 —— 这才是站主要的那 85% 的**分子与分母**。
           ratio 是"掷骰子"的期望值；hkShown/shown 是**实测**值。
           两者一旦差得多，就说明一言供不上（见 hkMiss）。 */
        hkShown: hkShown, localShown: localShown, hkMiss: hkMiss,
        hkShare: shown ? +(hkShown / shown).toFixed(4) : null,
        hkLive: hkLive, localLive: live.length - hkLive,
        hkRatio: ik ? ik.ratio : null,
        hk: ik && ik.diag ? ik.diag() : null,
        speedMin: speeds.length ? Math.min.apply(null, speeds) : null,
        speedMax: speeds.length ? Math.max.apply(null, speeds) : null,
        scales: live.map(function (it) { return +it.scale.toFixed(3); }),
        dys: live.map(function (it) { return +it.dy.toFixed(1); }),
        inFlight: boxes().length
      };
    };

    /* ---------- 高亮（含暂停） ---------- */
    // 暂停必须记账：解析几何是靠「起始时间 + 总暂停时长」推的，
    // 只改 animation-play-state 而不记账，算出来的位置会和元素真实位置错开。
    function setPaused(it, on) {
      if (on === (it.pausedAt != null)) { return; }
      if (on) {
        it.pausedAt = now();
      } else {
        it.pausedTotal += now() - it.pausedAt;
        it.pausedAt = null;
      }
      it.el.style.animationPlayState = on ? 'paused' : 'running';
    }

    /* 只停被指着的那一条是不够的：它后面（右边）那些还在往前走，
       而大家速度相同 —— 停住的那条会被从后面撞上，又变成重合。
       所以暂停时要把同一泳道里**排在它后面**的一起停住，像堵车一样；
       松手时再一起放开（速度一致，间距原样保留，不会散架）。

       但**只给被指着的那一条加 .is-hot**：后面那些是「被堵住的」，
       不是「被选中的」。全染上颜色既吵，也会让「高亮 = 指针在哪」这条
       唯一的视觉线索失效。 */
    function pauseGroupFor(rec) {
      var t = now();
      var xHot = xOf(rec, t);
      var out = [rec];
      for (var i = 0; i < live.length; i++) {
        var it = live[i];
        if (it === rec || it.lane !== rec.lane) { continue; }
        if (xOf(it, t) > xHot) { out.push(it); }   // 在它右边 = 在它后面
      }
      return out;
    }

    function setHot(next) {
      if (hot === next) { return; }
      if (hot) { hot.el.classList.remove('is-hot'); }
      for (var i = 0; i < hotGroup.length; i++) {
        setPaused(hotGroup[i], false);
      }
      hotGroup = [];
      hot = next;
      if (hot) {
        hot.el.classList.add('is-hot');     // 只有它被点亮
        hotGroup = pauseGroupFor(hot);
        for (var j = 0; j < hotGroup.length; j++) {
          setPaused(hotGroup[j], true);     // 但它后面的一起停住
        }
      }
      // 光标也跟着变一下：让「弹幕可交互」这件事被看见
      if (typeof Auxia.setCursorHoverExternal === 'function') {
        Auxia.setCursorHoverExternal(!!hot);
      }
    }

    /* ---------- 投放与回收 ---------- */
    /** 返回 { text, src }：src 是 'hk' | 'local'，用来统计真正上屏的来源分布。
        注意"掷中一言"和"拿到一言"是两件事：掷中之后 take() 可能返回 null
        （缓冲见底），这时是**回落**，不是命中 —— hkMiss 单独记一笔。 */
    function nextText() {
      if (ik && Math.random() < ik.ratio) {
        var s = ik.take();
        if (s) { hkShown += 1; return { text: s, src: 'hk' }; }
        hkMiss += 1;
      }
      if (!pool.length) { return null; }
      localShown += 1;
      return { text: pool[rand(pool.length)], src: 'local' };
    }

    /** 选一条「塞得下」的泳道。
        在所有够宽的泳道里随机挑一条 —— 不是挑最宽的那条，
        否则会一直往同一条里塞，纵向看起来就很死板。
        刚投放过的泳道 clearance 立刻变负，自然不会连着被选中。
        返回 -1 表示今天没位置：**宁可少一条，也不要叠一条**。 */
    function pickLane(t) {
      var free = [];
      for (var i = 0; i < LANES; i++) {
        if (laneClearance(i, t) >= 0) { free.push(i); }
      }
      return free.length ? free[rand(free.length)] : -1;
    }

    function recycle(rec) {
      var i = live.indexOf(rec);
      if (i >= 0) { live.splice(i, 1); }
      if (laneLastItem[rec.lane] === rec) { laneLastItem[rec.lane] = null; }
      var g = hotGroup.indexOf(rec);
      if (g >= 0) { hotGroup.splice(g, 1); }
      if (hot === rec) { setHot(null); }
      if (rec.reapTimer) { clearTimeout(rec.reapTimer); rec.reapTimer = 0; }
      if (rec.el && rec.el.parentNode) { rec.el.parentNode.removeChild(rec.el); }
    }

    /* 回收时机 = 「它走出屏幕左边」的那一刻，而不是「整圈跑完 + 3 秒」。
       两个时间差得远：左边缘走到 x=-w 时 p ≈ (vw+w)/(w+2vw) ≈ 0.56，
       剩下那 44% 的行程它已经看不见了。按整圈回收的话，
       每条都会在 DOM 里白白挂着十几个不可见的秒数 ——
       既占 DM_MAX 的名额，也让「同时在场」的节点数虚高一倍。

       暂停时不能就这么回收（会把正被看着的那条抽掉），但也不能用
       「再等一整个 exitDelay」去轮询：那样暂停一次就会多挂好几秒。
       所以改成按**已消耗的动画时间**算剩余量，暂停期间用 500ms 短轮询。 */
    function exitDelayMs(rec) {
      var vw = winW();
      var pExit = (vw + rec.w) / (rec.w + 2 * vw);
      return pExit * rec.dur * 1000;
    }

    function armReap(rec) {
      if (rec.pausedAt != null) {
        rec.reapTimer = window.setTimeout(function () { armReap(rec); }, 500);
        return;
      }
      var used = now() - rec.t0 - rec.pausedTotal;      // 已消耗的动画时间
      var remain = exitDelayMs(rec) - used;
      rec.reapTimer = window.setTimeout(function () {
        if (rec.pausedAt != null) { armReap(rec); return; }
        recycle(rec);
      }, Math.max(remain, 60));
    }

    function spawn() {
      if (live.length >= DM_MAX) { return; }

      /* ⚠️ 这里的顺序不能反：**先占泳道，再取文案**。
         nextText() 一旦命中一言，就会从缓冲里 take() 走一条 —— 那是实打实的消耗。
         原先写成「先取文案、再选泳道」，泳道满了就直接 return，
         那条一言连屏幕都没上就被丢掉了：接口请求已经发出去、缓冲少一条、
         用户什么也没看到。放慢速度后泳道更容易占满，这个浪费会被放大，
         而站主这轮又要求 85% 的弹幕都来自一言 —— 更浪费不起。 */
      var t0 = now();
      var idx = pickLane(t0);
      if (idx < 0) { return; }        // 挤不下就这一拍不投，别硬叠上去

      var pick = nextText();
      if (!pick) { return; }
      var text = pick.text;

      var scale = randf(DM_SCALE[0], DM_SCALE[1]);
      var dy = laneJitter() ? randf(-laneJitter(), laneJitter()) : 0;

      var el = document.createElement('span');
      el.className = 'dm-item';
      el.textContent = text;
      el.style.setProperty('--dm-scale', scale.toFixed(3));
      el.style.top = dy.toFixed(1) + 'px';
      // 先挂上去、先按住不动：宽度要等布局算完才知道，
      // 而时长是**由宽度反推**的（速度恒定）。不先按住的话，
      // 它会用兜底时长先跑一小段，再被改成正确时长 —— 位置会跳一下。
      el.style.animationPlayState = 'paused';
      laneEls[idx].appendChild(el);

      var rect = el.getBoundingClientRect();
      var w = rect.width || estimateWidth(text, scale);
      var h = rect.height || 26;
      var dur = (w + 2 * winW()) / speed();     // ← 恒定速度，不是随机时长

      el.style.animationDuration = dur.toFixed(2) + 's';
      el.style.animationPlayState = 'running';

      var rec = {
        el: el, lane: idx, dur: dur, t0: now(),
        w: w, h: h, dy: dy, scale: scale,
        // 原样留着文案：第五轮加的「点击弹幕去 Bing 搜出处」要用它。
        // 不存的话只能去读 el.textContent —— 也能用，但一旦将来给弹幕
        // 加了装饰性子元素（图标之类），读回来的就不是原文了。
        text: text,
        src: pick.src,
        pausedAt: null, pausedTotal: 0, reapTimer: 0
      };
      live.push(rec);
      laneLastItem[idx] = rec;

      el.addEventListener('animationend', function () { recycle(rec); });
      armReap(rec);
    }

    // 首条立刻出现，别让用户干等一个节拍
    spawn();
    var spawnTimer = window.setInterval(spawn, Math.round(1000 / DM_PER_SEC));

    /* ---------- 指针 ---------- */
    document.addEventListener('pointermove', function (e) {
      if (e.pointerType === 'touch') { return; }
      px = e.clientX; py = e.clientY; hasPointer = true;
    }, { passive: true });
    document.addEventListener('mouseleave', function () {
      hasPointer = false; setHot(null);
    });
    window.addEventListener('blur', function () {
      hasPointer = false; setHot(null);
    });

    /* ---------- 点击弹幕 -> Bing 搜这句话的出处 ----------
       弹幕层在 #danmaku（z-index:1），内容层 main 是 5，而且 #danmaku 是
       pointer-events:none —— 所以**永远收不到 click 事件**，只能沿用高亮那套
       几何命中检测：拿点击坐标去 boxes() 里找。
       也正因为如此，必须挂在 document 上、并且主动放过真正的交互元素，
       否则用户点链接/按钮时会连带触发一次搜索。 */
    var CLICKABLE = 'a, button, input, select, textarea, summary, label, [data-lightbox]';

    document.addEventListener('click', function (e) {
      if (e.defaultPrevented || e.button !== 0) { return; }
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) { return; }
      var t = e.target;
      if (t && t.closest && t.closest(CLICKABLE)) { return; }   // 让它正常走自己的跳转
      var b = hitBox(e.clientX, e.clientY);
      if (!b || !b.rec.text) { return; }
      var url = 'https://www.bing.com/search?q=' + encodeURIComponent(b.rec.text);
      window.open(url, '_blank', 'noopener,noreferrer');
    });

    // 逐帧判命中。纯算术，几十条的量级可以忽略不计。
    onFrame(function () {
      if (!hasPointer) { return; }
      var b = hitBox(px, py);
      setHot(b ? b.rec : null);
    });

    /* ---------- 视口变化 / 页面隐藏 ---------- */
    // 改窗口宽度会改变 speed() 和 100vw，在飞的弹幕用的还是旧时长 ——
    // 恒定速度的前提就没了，同泳道会开始追尾。
    // 所以 resize 之后按**新的**速度把每条的时长重算一遍，
    // 同时把进度 p 原样保留（新的 t0 = 现在 - p·新时长），
    // 这样它们不会跳位置，而全体速度又重新一致了。
    function relayout() {
      layoutLanes();
      var t = now();
      var vw = winW();
      var sp = speed();
      var jitter = laneJitter();
      for (var i = 0; i < live.length; i++) {
        var it = live[i];
        var p = progress(it, t);
        it.dur = (it.w + 2 * vw) / sp;
        it.el.style.animationDuration = it.dur.toFixed(2) + 's';
        var ref = it.pausedAt != null ? it.pausedAt : now();
        it.t0 = ref - p * it.dur * 1000;
        it.pausedTotal = 0;
        // 纵向抖动也要跟着新的行距重新夹一遍，别顶到隔壁泳道
        if (it.dy) {
          it.dy = Math.max(-jitter, Math.min(jitter, it.dy));
          it.el.style.top = it.dy.toFixed(1) + 'px';
        }
      }
    }

    var resizeTimer = 0;
    window.addEventListener('resize', function () {
      if (resizeTimer) { clearTimeout(resizeTimer); }
      resizeTimer = window.setTimeout(relayout, 180);
    }, { passive: true });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        window.clearInterval(spawnTimer); spawnTimer = 0;
        setHot(null);
      } else if (!spawnTimer) {
        spawnTimer = window.setInterval(spawn, Math.round(1000 / DM_PER_SEC));
        if (ik) { ik.onVisible(); }
      }
    });

    Auxia.danmakuCount = function () { return live.length; };
  }

  /* ==================================================================
     3. 点击粒子
     ================================================================== */
  function initParticles() {
    var host = document.getElementById('particles');
    if (!host || reduceMotion.matches) { return; }

    var isSmall = window.matchMedia('(max-width: 640px)').matches;
    var COUNT = isSmall ? 7 : 14;

    function burst(x, y) {
      var rgb = Auxia.accentRgb || [232, 132, 92];
      for (var i = 0; i < COUNT; i++) {
        var p = document.createElement('span');
        p.className = 'pt';
        var size = 3 + Math.random() * 6;
        var angle = Math.random() * Math.PI * 2;
        var dist = 26 + Math.random() * 76;
        var tint = Math.random();
        p.style.width = size.toFixed(1) + 'px';
        p.style.height = size.toFixed(1) + 'px';
        p.style.left = x + 'px';
        p.style.top = y + 'px';
        p.style.background = tint > 0.62
          ? 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')'
          : 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + (0.35 + Math.random() * 0.5).toFixed(2) + ')';
        p.style.setProperty('--dx', (Math.cos(angle) * dist).toFixed(1) + 'px');
        p.style.setProperty('--dy', (Math.sin(angle) * dist + 26).toFixed(1) + 'px');
        p.style.setProperty('--dur', (620 + Math.random() * 620).toFixed(0) + 'ms');
        host.appendChild(p);
        (function (node) {
          node.addEventListener('animationend', function () { node.remove(); });
        })(p);
      }
    }

    window.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button !== 0) { return; }
      burst(e.clientX, e.clientY);
    }, { passive: true });
  }

  /* ==================================================================
     4. 跟随指针的矢量光标
     —— 纯 SVG 画出来的「四角星 + 虚线圈」。两层各自演化：
          · 内核用大阻尼比直接贴住指针
          · 外圈用**弹簧积分**（欠阻尼），所以它总是拖在后面，速度越快被
            拉得越长、方向也随速度矢量旋转——这就是「非线性跟随」的手感，
            而不是简单地匀速直线追过去。
     ================================================================== */
  function initCursor() {
    if (reduceMotion.matches) { return; }
    if (!window.requestAnimationFrame) { return; }

    // 触摸设备不需要这层。只给「有真指针」的环境上。
    var fine = true;
    if (window.matchMedia) {
      fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    }
    if (!fine) { return; }

    var host = document.createElement('div');
    host.id = 'cursor';
    host.setAttribute('aria-hidden', 'true');
    host.innerHTML =
      '<div class="cur cur-ring">' +
        '<svg viewBox="0 0 40 40" aria-hidden="true">' +
          '<circle class="ring-arc" cx="20" cy="20" r="17"/>' +
        '</svg>' +
      '</div>' +
      '<div class="cur cur-core">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true">' +
          '<path class="core-mark" d="M12 1.2 L14.6 9.1 L22.8 12 L14.6 14.9 ' +
            'L12 22.8 L9.4 14.9 L1.2 12 L9.4 9.1 Z"/>' +
        '</svg>' +
      '</div>';

    var ring = host.querySelector('.cur-ring');
    var core = host.querySelector('.cur-core');
    if (!ring || !core) { return; }

    // 只有确认能画出来，才把系统指针藏掉。
    // 顺序很重要：反过来的话，一旦上面任何一步挂了，页面就没指针了。
    document.documentElement.classList.add('cursor-on');
    document.body.appendChild(host);

    var tx = window.innerWidth / 2;
    var ty = window.innerHeight / 2;
    var coreP = { x: tx, y: ty };
    var ringP = { x: tx, y: ty };
    var ringV = { x: 0, y: 0 };

    var K = 0.10;    // 外圈弹簧刚度
    var C = 0.58;    // 外圈阻尼。ζ = C / (2·√K) ≈ 0.92 —— 略欠阻尼：
                     // 有一点点弹性收束的手感，但几乎不会过冲跑过头，
                     // 所以外圈始终稳定地拖在内核后面。

    var INTERACTIVE = 'a, button, input, select, textarea, summary, [data-lightbox]';

    /* 悬停态有两个来源：指针下的可交互元素（本地判断），
       以及弹幕的高亮（由弹幕模块回报）。合起来才是最终状态——
       否则两边各自 toggle，会互相把对方的状态擦掉。 */
    var hoverInteractive = false;
    var hoverExternal = false;

    function syncHover() {
      host.classList.toggle('is-hover', hoverInteractive || hoverExternal);
    }

    Auxia.setCursorHoverExternal = function (on) {
      if (!!on === hoverExternal) { return; }
      hoverExternal = !!on;
      syncHover();
    };

    function frame() {
      // --- 内核：直接吃掉剩余距离的大头，几乎跟手
      coreP.x += (tx - coreP.x) * 0.42;
      coreP.y += (ty - coreP.y) * 0.42;

      // --- 外圈：欠阻尼弹簧积分
      ringV.x += K * (tx - ringP.x) - C * ringV.x;
      ringV.y += K * (ty - ringP.y) - C * ringV.y;
      ringP.x += ringV.x;
      ringP.y += ringV.y;

      var speed = Math.sqrt(ringV.x * ringV.x + ringV.y * ringV.y);
      var stretch = Math.min(speed * 0.025, 0.4);
      var ang = speed > 0.06 ? Math.atan2(ringV.y, ringV.x) * 180 / Math.PI : 0;

      core.style.transform =
        'translate3d(' + coreP.x.toFixed(2) + 'px,' + coreP.y.toFixed(2) + 'px,0)';
      ring.style.transform =
        'translate3d(' + ringP.x.toFixed(2) + 'px,' + ringP.y.toFixed(2) + 'px,0)' +
        ' rotate(' + ang.toFixed(1) + 'deg)' +
        ' scale(' + (1 + stretch).toFixed(3) + ',' + (1 - stretch * 0.5).toFixed(3) + ')';
    }
    onFrame(frame);

    function interactiveAt(el) {
      return !!(el && el.closest && el.closest(INTERACTIVE));
    }

    document.addEventListener('pointermove', function (e) {
      if (e.pointerType === 'touch') { return; }
      tx = e.clientX; ty = e.clientY;

      // ⚠️ 这里必须是「每次移动都确保可见」，不能写成「只在第一次显示」。
      //    hide() 会在指针移出窗口时摘掉 .is-on；如果补回来这件事只发生在
      //    第一次 pointermove 上（!seen 分支），那么「移出去再移回来」之后
      //    元素还在 DOM 里、transform 也还在逐帧更新，但 opacity 恒为 0 ——
      //    用户看到的就是「光标没了，再也回不来」。
      if (!host.classList.contains('is-on')) {
        // 从窗口外回来时不能让它横穿屏幕：先把两层归位到指针处再淡入
        coreP.x = ringP.x = tx;
        coreP.y = ringP.y = ty;
        ringV.x = ringV.y = 0;
        host.classList.add('is-on');
      }

      hoverInteractive = interactiveAt(e.target);
      syncHover();
    }, { passive: true });

    document.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'touch') { return; }
      host.classList.add('is-press');
    }, { passive: true });
    document.addEventListener('pointerup', function () {
      host.classList.remove('is-press');
    }, { passive: true });

    // 指针移出窗口 / 切走标签页 -> 藏起来，别让图形僵在原地。
    // 回来时由上面的 pointermove 负责重新点亮。
    function hide() {
      host.classList.remove('is-on', 'is-press');
      Auxia.setCursorHoverExternal(false);
    }
    document.addEventListener('mouseleave', hide);
    window.addEventListener('blur', hide);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { hide(); }
    });

    /* ---- 指针进到 iframe 里（项目页内嵌的游戏）----
       iframe 是**独立的文档**：指针一旦跨进它的边界，事件就全部归子文档了，
       父文档再也收不到 pointermove。于是光标图形会僵在 iframe 边框外面不动，
       而真实指针已经在游戏里跑 —— 用户看到的就是「光标特效被挡在游戏窗口外」。

       跨出去的那一刻，父文档只能拿到两个信号，两个都要接：
         · target 是 <iframe> 的 pointerover（进入子的可视区域）
         · relatedTarget 为 null 的 mouseout（离开整个文档；去浏览器地址栏同理）
       用 capture 阶段监听：iframe 内部或中间层 stopPropagation 也挡不住。

       不需要「恢复」的逻辑 —— 回到页面上时任何一次 pointermove 都会重新点亮它，
       那条路径上专门写了「每次移动都确保可见」，正是为了这种场景。 */
    document.addEventListener('pointerover', function (e) {
      if (e.target && e.target.tagName === 'IFRAME') { hide(); }
    }, true);

    document.addEventListener('mouseout', function (e) {
      if (!e.relatedTarget) { hide(); }
    }, true);
  }

  /* ==================================================================
     5.5 卡片玻璃：跟着指针走的高光
     —— 只负责给 .card 的 background 第一层（那圈径向高光）喂坐标。
        CSS 那边见 site.css 的 .card；默认圆点在卡片上方外面，所以不悬停
        就等于没有高光，不需要额外的 opacity 开关。

     为什么坐标写 px 而不是 %：radial-gradient 的圆心在卡片自己的坐标系里，
     % 会随卡片尺寸缩放，卡片一大高光就偏掉了。

     为什么要过一遍 rAF：卡片上有 backdrop-filter，每改一次 background
     就是一次重绘。pointermove 的频率远高于屏幕刷新率，直接写属性会把
     「移动指针」变成「每帧重绘好几次」。攒到下一帧统一写一次就够了，
     反正肉眼也分辨不出 1 帧以内的差别。 */
  function initCardGlass() {
    if (!window.matchMedia) { return; }
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) { return; }

    var current = null;
    var dirty = false;
    var gx = 0, gy = 0;

    function clear(el) {
      if (!el) { return; }
      el.style.removeProperty('--gx');
      el.style.removeProperty('--gy');
    }

    document.addEventListener('pointermove', function (e) {
      if (e.pointerType === 'touch') { return; }
      var card = e.target && e.target.closest ? e.target.closest('.card') : null;
      if (card !== current) { clear(current); current = card; }
      if (!card) { return; }
      var r = card.getBoundingClientRect();
      gx = e.clientX - r.left;
      gy = e.clientY - r.top;
      dirty = true;
    }, { passive: true });

    onFrame(function () {
      if (!dirty || !current) { return; }
      dirty = false;
      current.style.setProperty('--gx', gx.toFixed(1) + 'px');
      current.style.setProperty('--gy', gy.toFixed(1) + 'px');
    });

    // 指针离开窗口 / 切走标签页时把高光收掉，别让它留在卡片上
    function reset() { clear(current); current = null; dirty = false; }
    document.addEventListener('mouseleave', reset);
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { reset(); }
    });
  }

  /* ==================================================================
     6. 顶栏 / 滚动出现 / 联系方式
     ================================================================== */
  function initNav() {
    var nav = document.querySelector('.nav');
    if (!nav) { return; }
    var onScroll = function () {
      if (window.scrollY > 12) { nav.classList.add('is-stuck'); }
      else { nav.classList.remove('is-stuck'); }
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  function initReveal() {
    var nodes = document.querySelectorAll('.reveal');
    if (!nodes.length) { return; }

    function showAll() {
      Array.prototype.forEach.call(nodes, function (n) { n.classList.add('is-on'); });
    }

    if (!('IntersectionObserver' in window) || reduceMotion.matches) {
      showAll();
      return;
    }

    var ioFired = false;
    var io = new IntersectionObserver(function (entries) {
      ioFired = true;
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          en.target.classList.add('is-on');
          io.unobserve(en.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    Array.prototype.forEach.call(nodes, function (n) { io.observe(n); });

    /* 安全网：正文绝不允许因为观察器没触发而整页空白。

       ⚠️ 但**不能无条件点亮全部** —— 那是个真实踩过的坑：
          `.reveal` 是 opacity:0，如果 2.4s 就把折叠线以下的一起点亮，
          它们会在**视口外**把淡入动画（包括卡片那层错落的 cardIn）跑完，
          用户滚下去时什么动画都看不到 —— 等于「做了个淡入，但没人看得见」。
          实测：不修的话滚到项目区时卡片 opacity 恒为 1、animationName 已是
          cardIn（跑完但早已结束）；修完是 0 → 0.45 → 0.73 → 0.93 → 1。

       所以分两级，按**后果**而不是按"省事"来兜：
         ① 观察器是活着的（ioFired）→ 只兜「此刻真的在屏幕上」的那些，
            这正是"空白正文"这个后果的唯一来源；折叠线以下的照常等滚动。
         ② 观察器整个是死的 → 才退回全量点亮（否则用户一滚就是空白）。 */
    window.setTimeout(function () {
      var stuck = document.querySelectorAll('.reveal:not(.is-on)');
      if (!stuck.length) { return; }
      Array.prototype.forEach.call(stuck, function (n) {
        if (ioFired) {
          var r = n.getBoundingClientRect();
          var vh = window.innerHeight || document.documentElement.clientHeight;
          if (r.bottom > 0 && r.top < vh) { n.classList.add('is-on'); }
        } else {
          n.classList.add('is-on');
        }
      });
    }, 2400);
  }

  /** 联系方式防爬：密文只存在 JS 变量里，明文不进 DOM，点击才写入，25s 后自动收起 */
  function initContact(contact) {
    var cards = document.querySelectorAll('[data-contact]');
    if (!cards.length) { return; }
    var timers = new WeakMap();

    Array.prototype.forEach.call(cards, function (card) {
      var key = card.dataset.contact;
      var valEl = card.querySelector('.value');
      var item = (contact && contact.items ? contact.items : []).filter(function (i) { return i.key === key; })[0];
      if (!valEl || !item) { return; }

      var revealed = false;

      function collapse() {
        if (!revealed) { return; }
        revealed = false;
        card.classList.remove('revealed');
        valEl.classList.add('masked');
        valEl.textContent = '••••••••';
        var t = timers.get(card);
        if (t) { clearTimeout(t); }
      }

      card.addEventListener('click', function () {
        if (revealed) { collapse(); return; }
        var plain = '';
        if (item.enc) {
          try { plain = decodeURIComponent(escape(window.atob(item.enc))); }
          catch (err) { plain = ''; }
        }
        if (!plain && item.url) { plain = item.url; }
        if (!plain) { return; }
        revealed = true;
        card.classList.add('revealed');
        valEl.classList.remove('masked');
        valEl.textContent = plain;
        var t = setTimeout(collapse, 25000);
        timers.set(card, t);
      });
    });
  }

  /** 标签页标题：切到别的标签时变「休眠模式」，切回来复原。
      站主的手写文案里那个 ` 是 U+0060 反引号、´ 是 U+00B4 尖音符 ——
      两个都在字符串里原样保留，别顺手「纠正」成正引号，那样就不是这个表情了。

      基础标题是**运行时抓的**，不是写死的常量：项目页 / 展墙页的标题各不相同，
      写死的话切回来会一律变成首页标题。抓取时机必须在任何修改之前。 */
  var SLEEP_TITLE = '休眠模式 ( ´-ω-`)zzZ';

  function initTabTitle() {
    var baseTitle = document.title;
    if (!baseTitle) { return; }
    document.addEventListener('visibilitychange', function () {
      document.title = document.hidden ? SLEEP_TITLE : baseTitle;
    });
  }

  /* ==================================================================
     启动
     ================================================================== */
  function boot() {
    // 关键：这些初始化**不依赖任何网络请求成功**。
    // 任何一个 JSON 取不到，页面也必须完整可读，绝不能开天窗。
    initBackground();
    initCursor();
    initCardGlass();
    initNav();
    initReveal();
    initParticles();

    // 共用 rAF 循环的开关：页面隐藏时统一停掉，回来再统一拉起。
    // 各模块只管用 Auxia.onFrame 订阅，不用自己管生命周期。
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { stopFrames(); } else { startFrames(); }
    });
    initTabTitle();

    // 只有弹幕与联系方式的密文需要 site.json；取不到就静默跳过。
    getJSON(ROOT + 'data/site.json').then(function (site) {
      if (site) {
        Auxia.site = site;
        initDanmaku(site.banner && site.banner.lines,
                    site.banner && site.banner.hitokoto);
        initContact(site.contact);
      }
      if (typeof Auxia.onReady === 'function') { Auxia.onReady(site); }
      document.dispatchEvent(new CustomEvent('auxia:ready', { detail: { site: site } }));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
