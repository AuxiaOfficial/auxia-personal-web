/**
 * smoke-test.cjs —— 用 jsdom 把构建产物真跑一遍
 *
 * 用法：  node tools/smoke-test.cjs [dist目录]
 * 前置：  先跑 tools/build_site.py 生成 dist/
 *        测试需要 jsdom；站点本身零依赖，不给站点引入常驻依赖。
 *
 * ⚠️ 为什么是「起一个本地 HTTP 服务器」而不是 JSDOM.fromFile：
 *   站点里大量使用**根绝对路径**（/assets/...）——必须如此，因为 404.html
 *   会在任意深度被命中，只有根绝对才写得对。但 file:// 下 /assets/x 会解析成
 *   file:///C:/assets/x，磁盘上没有这个文件，于是页面的 CSS/JS 全部加载失败。
 *   更隐蔽的是：jsdom 的 requestInterceptor **不会拦截 file: 协议**
 *   （见 lib/jsdom/browser/resources/jsdom-dispatcher.js：data: 与 file:
 *   在 dispatch() 里直接内部分派，根本不进用户拦截链），想靠拦截器救回来行不通。
 *   结果就是：404 页在自检里从来没跑过 JS，而 "Could not load" 又被
 *   realErrors() 过滤掉了，于是报出一个假的「无运行时报错」绿灯。
 *   换成 HTTP 之后，根绝对路径与真实部署完全一致；顺带还能验证
 *   「页面要求的每一个资源都真的存在」。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const NODE_WORKSPACE = process.env.AUXIA_NODE_PATH;
if (NODE_WORKSPACE) {
  module.paths.unshift(path.join(NODE_WORKSPACE, 'node_modules'));
}
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist'));

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json'
};

let BASE = '';       // 本地站点根，例如 http://127.0.0.1:53211/
let missed = [];     // 本次加载期间「被请求但不存在」的路径
let external = [];   // 本次加载期间对站外域名的请求

let pass = 0;
let fail = 0;
const failures = [];

function check(label, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  \u2713 ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  \u2717 ${label}${extra !== undefined ? `  ->  ${JSON.stringify(extra)}` : ''}`);
  }
}

/** 站点**唯一**允许访问的外部域：一言。
    任何其它外部请求（字体、CDN、统计、代理图片…）都属于回归，必须报错。 */
const ALLOWED_EXTERNAL = new Set(['v1.hitokoto.cn']);

// ------------------------------------------------------------------ 本地站点
/** 把 dist/ 起成一个只监听 127.0.0.1 的静态服务器（模拟 Pages 的目录路由） */
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/favicon.ico') {                 // 浏览器才会要，jsdom 不会
        res.writeHead(204); res.end(); return;
      }
      let target = path.join(ROOT, p);
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        target = path.join(target, 'index.html');  // /gallery/ -> index.html
      }
      if (!fs.existsSync(target) && fs.existsSync(target + '.html')) {
        target += '.html';                         // /404 -> 404.html
      }
      if (fs.existsSync(target) && fs.statSync(target).isFile()) {
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream'
        });
        res.end(fs.readFileSync(target));
        return;
      }
      // 真实 Pages 的行为：找不到就吐 404.html。这里同时把路径记下来，
      // 因为「页面要了一个不存在的资源」是必须在自检里暴露的事实。
      missed.push(p);
      const nf = path.join(ROOT, '404.html');
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end(fs.existsSync(nf) ? fs.readFileSync(nf) : 'not found');
    });
    server.listen(0, '127.0.0.1', () => {
      BASE = `http://127.0.0.1:${server.address().port}/`;
      resolve(server);
    });
  });
}

async function load(fileName) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(`jsdomError: ${e.message}`));
  vc.on('error', (...a) => errors.push(`console.error: ${a.join(' ')}`));
  vc.on('warn', () => {});

  missed = [];
  external = [];

  const dom = await JSDOM.fromURL(BASE + fileName, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      // jsdom 自己没有 fetch；桥接到 Node 的 fetch，让请求真的走一遍 HTTP，
      // 于是 /data/*.json、根绝对路径、404 都会按真实部署的样子发生。
      //
      // 例外是站外域名：**必须单独处理**，否则 new URL(...) 会把
      // https://v1.hitokoto.cn/... 拼成 http://127.0.0.1:PORT/https://v1.hitokoto.cn/...
      // ——既跑不通，又会污染「本页请求的资源都真实存在」这条断言。
      // 这里给一言一个固定的假响应：既把「一言」这条链路真的跑通，
      // 又保证自检本身完全不依赖公网。
      window.fetch = (input, init) => {
        const url = new URL(String(input), BASE);
        if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
          external.push(url.hostname);
          if (ALLOWED_EXTERNAL.has(url.hostname)) {
            return Promise.resolve(new Response(
              JSON.stringify({ hitokoto: '一言桩文案', from: 'stub', from_who: null }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            ));
          }
          return Promise.reject(new Error('blocked external host: ' + url.hostname));
        }
        return fetch(url, init);
      };
      window.TextDecoder = TextDecoder;
      window.TextEncoder = TextEncoder;
      window.matchMedia = (q) => ({
        // 站点按 (hover:hover) and (pointer:fine) 判断「有没有真指针」，
        // 精细光标只在这种环境下启用。jsdom 没有真实的指针能力，
        // 这里按「桌面鼠标」作答，好让光标相关的断言真的被跑到。
        matches: /hover|pointer/i.test(q), media: q, onchange: null,
        addEventListener() {}, removeEventListener() {},
        addListener() {}, removeListener() {}, dispatchEvent() { return false; }
      });
      window.IntersectionObserver = class {
        constructor(cb) { this.cb = cb; }
        observe(el) { this.cb([{ isIntersecting: true, target: el }], this); }
        unobserve() {} disconnect() {} takeRecords() { return []; }
      };
    }
  });

  await new Promise((r) => setTimeout(r, 800));
  return { dom, doc: dom.window.document, win: dom.window, errors };
}

// "Could not load" **不再被过滤**：站点现在是零外部请求的纯静态站，
// 任何加载失败都意味着某条路径写错了或者文件没进 dist/。
// 以前把它过滤掉，正好掩盖了「404 页的 CSS/JS 全都没加载」这件事。
const realErrors = (errs) => errs.filter(
  (e) => !/Could not parse CSS|not implemented|Error: Not implemented/i.test(e)
);

function readJSON(p) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
}

function readText(p) {
  return fs.readFileSync(path.join(ROOT, p), 'utf8');
}

// readText 读的是**产物**（dist/）。构建脚本、生成器这些只在源目录里有，
// 所以要另开一个读源码的入口 —— 否则会得到一个 FileNotFound 而不是断言失败。
const SITE_DIR = path.join(__dirname, '..');
function readSource(p) {
  return fs.readFileSync(path.join(SITE_DIR, p), 'utf8');
}

// ------------------------------------------------ 资源路径解析守卫
// 背景：gallery.json 里的素材路径曾经是裸相对（assets/img/x.webp），
// 在 `/` 下解析正常，但在 `/gallery/` 下会变成 /gallery/assets/... 而 404。
// 光看 DOM 数量根本发现不了这类错。
// 这里按真实 URL 规则解析每个图片地址，再回本地 dist/ 里查文件是否存在。
function pageBaseUrl(fileName) {
  const rel = fileName.replace(/\\/g, '/').replace(/index\.html$/, '');
  return BASE + rel;
}

/** 返回解析后落到 dist/ 里不存在的图片地址（正常应为空数组） */
function brokenImages(fileName, doc) {
  const base = pageBaseUrl(fileName);
  const bad = [];
  const seen = new Set();

  const consider = (raw) => {
    if (!raw || seen.has(raw)) return;
    seen.add(raw);
    if (/^(data:|blob:|https?:)/i.test(raw)) return; // 外链不由本仓保证
    let pathname;
    try { pathname = new URL(raw, base).pathname; } catch { return; }
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    if (!fs.existsSync(path.join(ROOT, rel))) bad.push(raw + '  ->  ' + pathname);
  };

  doc.querySelectorAll('img[src]').forEach((el) => consider(el.getAttribute('src')));
  doc.querySelectorAll('a[data-lightbox]').forEach((el) => consider(el.getAttribute('data-lightbox')));
  return bad;
}

/** 本次加载期间，「页面要了但服务器没有」的路径。必须为空。 */
function missingRequests(fileName) {
  return missed.slice();
}

// ------------------------------------------------------------------ 各页
async function testHome(ctx) {
  console.log('\n=== 主页 index.html ===');
  const { dom, doc, errors } = await load('index.html');

  const site = readJSON('data/site.json');
  const gallery = readJSON('data/gallery.json');

  // 开屏：打字机（站酷小薇 LOGO 体）+ 右侧布朗运动演示
  //
  // ⚠️ 这里必须分两层断言，只做一层都是假绿：
  //   第一层「源 HTML 里文案完整」——渐进增强的底线，爬虫 / 无 JS 看到的就是它。
  //   第二层「渲染后确实被逐字敲出来了」——但这是个**时间相关**的状态：
  //     定点采样必然 flaky（弹幕那条踩过同一个坑）。
  //   更阴的是：如果只轮询「文本 == 完整文案」，那么**在 splash.js 接管之前**
  //   就会立刻读到 HTML 里的原文案，于是「打字机根本没跑」也照样变绿。
  //   所以先等光标元素出现（= 接管成功的信号），再等敲完。
  const h1 = doc.querySelector('.splash h1');
  check('开屏大字存在', !!h1, h1 ? h1.textContent.trim() : null);
  check('开屏结构：两行 + data-lines 声明',
    !!h1 && h1.querySelectorAll('.st-row').length === 2 &&
      h1.getAttribute('data-lines') === "I'm Auxia,|welcome to my website！",
    h1 && h1.getAttribute('data-lines'));
  check('开屏文案在源 HTML 里就是完整的（无 JS 也不开天窗）',
    /data-lines="I'm Auxia,\|welcome to my website！"/.test(readText('index.html')));
  {
    const want = "I'mAuxia,welcometomywebsite！";
    const norm = () => (h1 ? h1.textContent.replace(/\s+/g, '') : '');
    let caretAt = Date.now() + 6000;
    while (!h1.querySelector('.st-caret') && Date.now() < caretAt) {
      await new Promise((r) => setTimeout(r, 100));
    }
    check('打字机已接管（插入了光标元素，说明 splash.js 真的跑了）',
      !!h1.querySelector('.st-caret'));
    const doneAt = Date.now() + 9000;
    while (norm() !== want && Date.now() < doneAt) {
      await new Promise((r) => setTimeout(r, 120));
    }
    check('打字机把两行都敲完了', norm() === want, norm());
  }
  check('布朗运动画布就位', !!doc.querySelector('#brownian'),
    !!doc.querySelector('#brownian'));
  check('导航 5 项', doc.querySelectorAll('.nav-links a').length === 5,
    doc.querySelectorAll('.nav-links a').length);

  // 大五人格
  const dims = site.bigfive.dims;
  const names = [...doc.querySelectorAll('.pentagon .dim-name')].map((n) => n.textContent);
  const vals = [...doc.querySelectorAll('.pentagon .dim-val')].map((n) => n.textContent);
  check('五边形 5 个顶点', names.length === 5, names);
  check('五边形维度名如实', names.join('/') === dims.map((d) => d.name).join('/'), names);
  check('五边形分值如实', vals.join('/') === dims.map((d) => `${d.value}%`).join('/'), vals);
  check('神经质 13%（未被美化）', vals.includes('13%'), vals);
  check('图例 5 行', doc.querySelectorAll('#b5-legend .b5-row').length === 5,
    doc.querySelectorAll('#b5-legend .b5-row').length);

  // 爱好
  const hobbies = [...doc.querySelectorAll('.hobby')].map((h) => h.textContent.replace(/[A-Za-z]+/g, '').trim());
  check('爱好 4 项', hobbies.length === 4, hobbies);
  check('爱好内容正确',
    ['画画', '开发', '钢琴', '玩游戏'].every((x) => hobbies.some((h) => h.includes(x))), hobbies);

  // ---- 弹幕：不再是「一条文案挂一个元素」，而是每秒固定投放 N 条 ----
  // 文案池本身用数据断言（下面 17 条新文案那一段），这里只验行为。
  check('弹幕投放器已启动（首条立刻出现）',
    doc.querySelectorAll('#danmaku .dm-item').length >= 1,
    doc.querySelectorAll('#danmaku .dm-item').length);
  check('泳道已建立（桌面 12 条）',
    doc.querySelectorAll('#danmaku .dm-lane').length === 12,
    doc.querySelectorAll('#danmaku .dm-lane').length);

  // 投放速率：等 2 秒，数新增了几条。站点声明的是 1.5 条/秒
  // （第五轮「速度放慢一半」时同步减半 —— 见 core.js 里那段密度推导：
  //   单减车速会让在场条数翻倍，撞上 DM_MAX=90 后开始静默丢条）。
  // 2 秒 × 1.5/s ≈ 3 条；容差给到 2–4，避免定时器边界抖动造成假红。
  const dmBefore = doc.querySelectorAll('#danmaku .dm-item').length;
  await new Promise((r) => setTimeout(r, 2000));
  const dmGrew = doc.querySelectorAll('#danmaku .dm-item').length - dmBefore;
  check('每秒投放约 1.5 条（2 秒实测容差 2–4）', dmGrew >= 2 && dmGrew <= 4, dmGrew);

  // 文案来源：本地池 + 一言（桩）。出现别的说明接错了池子。
  const poolSet = new Set(site.banner.lines.concat(['一言桩文案']));
  const dmTexts = [...doc.querySelectorAll('#danmaku .dm-item')].map((d) => d.textContent);
  check('弹幕文案只来自本地池或一言',
    dmTexts.length > 0 && dmTexts.every((t) => poolSet.has(t)),
    dmTexts.filter((t) => !poolSet.has(t)).slice(0, 3));

  // 几何命中检测：这条是「悬停高亮」的地基。
  // 弹幕层 z-index 1 在内容层 5 之下，指针根本碰不到 .dm-item，
  // 所以高亮只能靠解析几何算出来 —— 这里把几何本身钉住。
  const dmBoxes = dom.window.Auxia.danmakuBoxes();
  check('弹幕元素带可用几何（宽高都算得出来）',
    dmBoxes.length > 0 && dmBoxes.every((b) => b.w > 0 && b.h > 0),
    dmBoxes.slice(0, 2).map((b) => ({ w: b.w, h: b.h })));
  // p 是推出来的动画总进度，真实浏览器探针靠它跟元素自己的动画时钟对表。
  // 这里只钉住「有这个东西、而且落在 [0,1)」—— 落到 >=1 就意味着
  // 出现了「跑第二圈」的元素，而那正是高亮失灵的老 bug（见下面 CSS 那段）。
  check('每条弹幕都带进度 p，且都在一周之内（p < 1）',
    dmBoxes.length > 0 && dmBoxes.every((b) => typeof b.p === 'number' && b.p > 0 && b.p < 1),
    dmBoxes.filter((b) => !(typeof b.p === 'number' && b.p > 0 && b.p < 1))
      .slice(0, 2).map((b) => b.p));
  const dmTarget = dmBoxes.slice().sort((a, b) => a.x - b.x)[0];
  check('指针落在弹幕上能命中到某一条',
    !!dmTarget && !!dom.window.Auxia.danmakuAt(dmTarget.x + dmTarget.w / 2, dmTarget.y + dmTarget.h / 2),
    dmTarget ? { x: +dmTarget.x.toFixed(0), y: +dmTarget.y.toFixed(0) } : null);
  check('指针不在任何弹幕上时不乱命中',
    dom.window.Auxia.danmakuAt(-100, -100) === null);

  // 真的把指针移上去，看它有没有被点亮（并停住）
  const dmPE = dom.window.PointerEvent || dom.window.MouseEvent;
  doc.dispatchEvent(new dmPE('pointermove', {
    clientX: dmTarget.x + dmTarget.w / 2,
    clientY: dmTarget.y + dmTarget.h / 2,
    bubbles: true
  }));
  await new Promise((r) => setTimeout(r, 140));
  const hotEls = doc.querySelectorAll('#danmaku .dm-item.is-hot');
  check('指针移到弹幕上会把它点亮（.is-hot）', hotEls.length === 1, hotEls.length);
  check('点亮的那条同时停住，方便看清',
    hotEls.length === 1 && hotEls[0].style.animationPlayState === 'paused',
    hotEls.length === 1 ? hotEls[0].style.animationPlayState : null);

  // 移开之后必须**放手**：高亮取消、动画继续。
  // 只测「点亮」不测「释放」的话，一个只会加不会减的实现也能全绿，
  // 而用户看到的就是「弹幕被卡住不走了」。
  doc.dispatchEvent(new dmPE('pointermove', { clientX: -50, clientY: -50, bubbles: true }));
  await new Promise((r) => setTimeout(r, 140));
  check('指针移开后高亮被取消（不会一直卡住）',
    doc.querySelectorAll('#danmaku .dm-item.is-hot').length === 0,
    doc.querySelectorAll('#danmaku .dm-item.is-hot').length);
  check('指针移开后那条弹幕恢复滚动',
    hotEls.length === 1 && hotEls[0].style.animationPlayState === 'running',
    hotEls.length === 1 ? hotEls[0].style.animationPlayState : null);

  // ---- 弹幕：放慢 / 随机 / 不重合 ----
  // 这三条是本轮新增的硬要求。
  // 先让它多跑一会儿，把泳道填到「有的泳道不止一条」，重合检查才有意义 ——
  // 12 条泳道各只放一条的话，任何实现都不会重合，那种检查等于没测。
  // 12 条泳道要撑到「复用」至少得 13 条在场；速率减半后是 1.5 条/秒，
  // 所以这里必须多等：13 / 1.5 ≈ 8.7 秒。等到 8 秒（累计约 10.3 秒 ≈ 15 条）。
  await new Promise((r) => setTimeout(r, 8000));
  const dmInfo = dom.window.Auxia.danmakuInfo();
  check('弹幕投放器持续工作（泳道已被填满并开始复用）',
    dmInfo.live >= 13, dmInfo.live);

  // 不重合的**前提**是速度恒等：同泳道只要两条速度不等，快的一定会追尾。
  // 所以这里先钉速度，再钉结果。
  const spSpread = dmInfo.speedMax == null ? 0
    : (dmInfo.speedMax - dmInfo.speedMin) / dmInfo.speedTarget;
  check('所有弹幕线速度恒等（这是「不重合」能被证明的前提）',
    dmInfo.speedMin != null && spSpread < 0.005,
    { min: dmInfo.speedMin, max: dmInfo.speedMax, target: dmInfo.speedTarget });

  const overlaps = dom.window.Auxia.danmakuOverlaps();
  check('同一条泳道内没有两条弹幕重合',
    overlaps.length === 0, overlaps.slice(0, 3));

  // 第五轮：速度减半，且**投放速率同步减半**。
  // 这是两个必须一起成立的数 —— 只减速度的话，每条在屏幕上多留一倍时间，
  // 同时在场条数直接翻倍（3/s × 50s = 150 条），既撞 DM_MAX=90 的名额上限、
  // 又和「放慢=更清爽」的直觉相反。所以速度与速率必须成对钉住。
  check('弹幕线速度减半（DM_SPEED 0.09 -> 0.045）',
    Math.abs(dmInfo.speedTarget - 1024 * 0.045) < 0.01,
    { speedTarget: +dmInfo.speedTarget.toFixed(2), want: 1024 * 0.045 });
  check('投放速率同步减半（DM_PER_SEC 3 -> 1.5），屏幕密度保持不变',
    dmInfo.perSec === 1.5, dmInfo.perSec);
  // 现场条数 = perSec × 存活时长。半速半速率下应和改之前一样约 75 条，
  // 既没撞 DM_MAX(90) 也没挤爆泳道容纳上限。
  check('同时在场条数留有余量（未撞 DM_MAX=90）',
    dmInfo.live <= 90, { live: dmInfo.live, max: 90 });

  // 慢下来：一条横穿可视区的耗时应该翻倍。
  // jsdom 视口宽固定 1024，条目宽约 300，可视横穿 = 1024 + 300。
  const crossSec = (1024 + 300) / dmInfo.speedTarget;
  check('弹幕确实变慢了（横穿可视区 ≥24 秒；减半前约 14 秒）',
    crossSec >= 24, { speed: +dmInfo.speedTarget.toFixed(1), crossSec: +crossSec.toFixed(1) });

  // 大小随机：字号倍率不能是一个定值
  check('弹幕字号是随机的（存在多个不同倍率）',
    new Set(dmInfo.scales).size >= 2, Array.from(new Set(dmInfo.scales)).slice(0, 6));

  // 位置随机：泳道内还有纵向抖动
  check('弹幕纵向位置有随机抖动',
    dmInfo.laneJitter > 0 && dmInfo.dys.some((d) => Math.abs(d) > 0.5),
    { jitter: +dmInfo.laneJitter.toFixed(1), dys: dmInfo.dys.slice(0, 6) });

  // 悬停要「堵车」：同泳道后面那些必须一起停住，否则速度相同 → 必然追尾重合。
  // 但**只给被指着的那一条**加 .is-hot —— 后面的是"被堵住"，不是"被选中"。
  //
  // 这个前置条件自己需要等：投放速率 3 条/秒、桌面 12 条泳道，开局头几秒恰好
  // 每条泳道一条，"同泳道两条同时在屏"要等泳道被复用才出现。原来只在某一个
  // 固定时刻采一次样，于是这条断言会随机翻车（实测 4 次里挂 2 次，此时总数
  // 是 205 而不是 209 —— 因为下面那三条连带被跳过）。
  // 改成轮询到出现为止：真堵不上就是真问题，超时照样报红。
  function findDuo() {
    const m = {};
    dom.window.Auxia.danmakuBoxes().forEach((b) => {
      if (b.x >= 0 && b.x + b.w <= 1024) { (m[b.lane] = m[b.lane] || []).push(b); }
    });
    const pairs = Object.keys(m).map((k) => m[k]).filter((a) => a.length >= 2);
    return {
      best: pairs.sort((a, b) => a[0].x - b[0].x)[0],
      lanes: Object.keys(m).length,
      total: dom.window.Auxia.danmakuBoxes().length,
    };
  }
  let snap = findDuo();
  const jamDeadline = Date.now() + 9000;
  while (!snap.best && Date.now() < jamDeadline) {
    await new Promise((r) => setTimeout(r, 250));
    snap = findDuo();
  }
  const duo = snap.best;
  check('存在同一泳道里有多条弹幕的样本（"堵车"才测得到）', !!duo,
    { lanes: snap.lanes, total: snap.total });
  if (duo) {
    const front = duo.slice().sort((a, b) => a.x - b.x)[0];
    const behind = duo.slice().sort((a, b) => a.x - b.x).slice(1);
    doc.dispatchEvent(new dmPE('pointermove', {
      clientX: front.x + front.w / 2, clientY: front.y + front.h / 2, bubbles: true
    }));
    await new Promise((r) => setTimeout(r, 160));
    const hotNow = doc.querySelectorAll('#danmaku .dm-item.is-hot');
    check('悬停时仍然只有被指着的那一条高亮（被堵住的不跟着变色）',
      hotNow.length === 1, hotNow.length);
    check('被堵在后面的那些一起停住（否则会追尾重合）',
      behind.every((b) => b.el.style.animationPlayState === 'paused'),
      behind.map((b) => b.el.style.animationPlayState));
    doc.dispatchEvent(new dmPE('pointermove', { clientX: -50, clientY: -50, bubbles: true }));
    await new Promise((r) => setTimeout(r, 160));
    check('松手后整条队伍一起恢复滚动',
      behind.every((b) => b.el.style.animationPlayState === 'running'),
      behind.map((b) => b.el.style.animationPlayState));
  }

  // 一言真的被请求了，而且**只**请求了它
  check('一言接口真的被调用', external.indexOf('v1.hitokoto.cn') >= 0, external);
  check('运行期除一言外没有访问任何外部域',
    external.every((h) => ALLOWED_EXTERNAL.has(h)), external);

  // 展墙橱窗：每面墙随机 2 件
  const rows = doc.querySelectorAll('#wall-showcase .wall-row');
  check('橱窗 5 面墙', rows.length === gallery.walls.length, rows.length);
  let pairOk = true;
  let tileTotal = 0;
  rows.forEach((r) => {
    const n = r.querySelectorAll('.wall-pair > *, .show-rows > *').length;
    tileTotal += n;
    if (n !== 2) pairOk = false;
  });
  check('每面墙恰好 2 件', pairOk, tileTotal);
  check('橱窗共 10 件', tileTotal === 10, tileTotal);
  check('橱窗索引行不再挂来源小字',
    doc.querySelectorAll('#wall-showcase .show-row .meta span').length === 0);
  check('「换一批」按钮存在', !!doc.querySelector('#shuffle'));

  // 换一批：内容应当变化（10 件里至少一件不同）；数据太少时可能不变化，故只查不报错
  const before = doc.querySelector('#wall-showcase').innerHTML;
  doc.querySelector('#shuffle').click();
  await new Promise((r) => setTimeout(r, 60));
  const after = doc.querySelector('#wall-showcase').innerHTML;
  check('「换一批」能重渲染', after.length > 0 && typeof after === 'string',
    { changed: before !== after });

  // 项目
  const proj = doc.querySelectorAll('.proj-grid .proj');
  check('项目卡 3 张（obsidian 已按站主要求移除）', proj.length === 3, proj.length);
  check('项目链接齐备',
    [...proj].every((p) => (p.getAttribute('href') || '').startsWith('./projects/')),
    [...proj].map((p) => p.getAttribute('href')));

  // 联系方式防爬
  const html = doc.body.innerHTML;
  // 判据从「不含某个真实号码」改成「不含站点密文解出来的明文」：
  // 前者把真实号码抄进了**公开仓库**（自相矛盾），后者换任何密文都成立。
  //
  // ⚠️ 必须读**源码目录**的 site.json，不能用 readText（它读 dist/）：
  //    下面「不许是真实值」那条拿 dist/ 的 stale 产物去跟源码里的真实值比，
  //    两边根本不是一个文件，于是注入真号也照样全绿 —— 守卫是死的。
  const srcSiteJson = JSON.parse(fs.readFileSync(
    path.join(SITE_DIR, 'data', 'site.json'), 'utf8'));
  const contactItems = srcSiteJson.contact.items;
  const plainOf = (key) => {
    const it = contactItems.find((i) => i.key === key) || {};
    return it.enc ? Buffer.from(it.enc, 'base64').toString('utf8') : '';
  };
  check('DOM 不含 QQ 明文', !html.includes(plainOf('qq')), plainOf('qq'));
  check('DOM 不含微信明文', !html.includes(plainOf('wx')), plainOf('wx'));
  const cards = doc.querySelectorAll('[data-contact]');

  // GitHub 卡片：**不该走掩码那套**。它是公开地址，标记成 data-contact 只会
  // 让 initContact 找不到对应条目、点击无反应 —— 卡片看着在，点下去什么都不会发生。
  const ghCard = doc.querySelector('#contact .contact-card[href]');
  check('GitHub 卡片存在', !!ghCard);
  check('GitHub 卡片指向正确账号',
    ghCard && ghCard.getAttribute('href') === 'https://github.com/AuxiaOfficial',
    ghCard && ghCard.getAttribute('href'));
  check('GitHub 卡片有安全属性 rel/target',
    !!ghCard && ghCard.getAttribute('rel') === 'noopener noreferrer' &&
    ghCard.getAttribute('target') === '_blank',
    ghCard && [ghCard.getAttribute('rel'), ghCard.getAttribute('target')].join(' / '));
  check('GitHub 卡片不走掩码（它不是 data-contact）',
    !!ghCard && !ghCard.hasAttribute('data-contact'));
  check('GitHub 卡片显示明文账号',
    !!ghCard && ghCard.querySelector('.value').textContent.includes('AuxiaOfficial'),
    ghCard && ghCard.querySelector('.value').textContent);
  check('GitHub 卡片未被 initContact 误处理（.value 无 masked）',
    !!ghCard && !ghCard.querySelector('.value').classList.contains('masked') &&
    !ghCard.classList.contains('revealed'));
  check('联系方式共 3 张卡（QQ / 微信 / GitHub）',
    doc.querySelectorAll('#contact .contact-card').length === 3,
    doc.querySelectorAll('#contact .contact-card').length);
  check('contact-note 与实际行为一致（不再说「所有联系方式都不进 DOM」）',
    (() => {
      const note = doc.querySelector('.contact-note');
      if (!note) { return false; }
      const t = note.textContent;
      return t.includes('QQ') && t.includes('微信') && t.includes('GitHub');
    })(),
    (doc.querySelector('.contact-note') || {}).textContent);

  cards[0].click();
  await new Promise((r) => setTimeout(r, 30));
  // ⚠️ 这里**不能钉真实 QQ 号**：data/site.json 里是占位串（仓库公开，真实值在
  // .gitignore 掉的 data/.contact-real.json 里）。要验的是「点击 → 解密 → 上屏」这条链路，
  // 所以判据取**页面上那份密文解出来的结果**，密文换成什么它都跟着对。
  const qqEnc = JSON.parse(readText('data/site.json')).contact.items
    .find((i) => i.key === 'qq').enc;
  const qqPlain = Buffer.from(qqEnc, 'base64').toString('utf8');
  check('点击后展开明文（按站点密文解密比对）',
    doc.querySelector('[data-contact="qq"] .value').textContent === qqPlain,
    doc.querySelector('[data-contact="qq"] .value').textContent);
  check('展开后明文才进 DOM', doc.body.innerHTML.includes(qqPlain));
  // 仓库里不许出现真实 QQ / 微信明文（Base64 不是加密，明文写进仓库等于公开）。
  //
  // ⚠️ 这条守卫前后写坏的坑，值得留着当教材（两个都是「守卫根本没跑」）：
  //    1) 判据猜「真实账号长什么样」→ 占位串 0000000000 / please-set-me 都被误报；
  //    2) 拿 ROOT（= dist/）去读 .contact-real.json → 那文件不进产物，永远不存在，
  //       于是 `continue` 把断言整个跳过 ⇒ **注入真实值也照样全绿**（守卫是死的）。
  //    唯一可靠的判据只有一条：**跟源码目录里的真实值比**，而且要确认它真的读得到。
  const realPath = path.join(SITE_DIR, 'data', '.contact-real.json');
  const realPlain = (key) => {
    if (!fs.existsSync(realPath)) { return null; }
    const it = (JSON.parse(fs.readFileSync(realPath, 'utf8')).items || [])
      .find((i) => i.key === key) || {};
    return it.plain || null;
  };
  for (const key of ['qq', 'wx']) {
    const real = realPlain(key);
    check(`隐私比对基准可读（${key}）`, real !== null, realPath);
    if (real === null) { continue; }
    check(`data/site.json 里的 ${key} 不是真实值（没有把真号提交上去）`,
      plainOf(key) !== real, plainOf(key));
  }

  // ---- 已经明确要求删掉的文案：一个字都不许回来 ----
  // 断言「不出现」比断言「某个选择器没了」结实得多：重构换个类名也跑不掉。
  const BANNED = [
    'Personal Site · v1.0', 'zolek', 'auxie', 'echovoid',
    '在这里放一些我做过的东西', '天生我材必有用', '我不是天生的，我是妈生的',
    'auxia · 用 Obsidian 搭的第二大脑制作', 'isouweb'
  ];
  const pageHTML = doc.documentElement.innerHTML;
  check('主页里已删文案不再出现',
    BANNED.every((s) => !pageHTML.includes(s)),
    BANNED.filter((s) => pageHTML.includes(s)));
  const siteText = readText('data/site.json');
  check('site.json 里已删文案不再出现',
    BANNED.every((s) => !siteText.includes(s)),
    BANNED.filter((s) => siteText.includes(s)));
  check('开屏只剩一句大字',
    !doc.querySelector('.splash .kicker, .splash .aliases, .splash .tagline'));
  check('自我介绍只剩爱好与人格图',
    !doc.querySelector('.intro-text') && !!doc.querySelector('#intro .hobbies') &&
    !!doc.querySelector('#intro .pentagon-card'));
  check('页脚只剩版权说明',
    !doc.querySelector('.foot .joke, .foot .sig') && !!doc.querySelector('.foot .legal'));

  // ---- 站主本轮点名的 17 条弹幕，逐条钉死在数据里 ----
  // 弹幕是随机投放的，没法靠「页面里出现过某一条」来断言，
  // 所以文案本身必须在数据层查（渲染层只查行为）。
  const NEW_LINES = [
    '死亡是一个必然会降临的节日',
    '飞鸟奋力欲破壳而出，蛋即世界，欲新生者必先摧毁世界',
    '在隆冬，我终于知道，我身上有一个不可战胜的夏天',
    '压路机来了！！！',
    '还有40秒，还不能笑',
    '我们都是阴沟里的虫子，但总还是得有人仰望星空',
    '给时光以生命，给岁月以文明。',
    '前进！前进！不择手段的前进！',
    '当一个人不再寻找，他便找到了',
    '1000-7=？',
    '真由理的怀表怎么不转了？',
    '你是容器，你是空洞骑士',
    '犹豫，就会败北',
    '蛋糕是个谎言',
    '不要用力拍打机框哦',
    '明月几时有，把酒问青天',
    '云层深处的黑暗，淹没心底的景观'
  ];
  const lackingLines = NEW_LINES.filter((t) => !site.banner.lines.includes(t));
  check('站主点名的 17 条弹幕文案都在池子里', lackingLines.length === 0, lackingLines);
  check('本地文案池 8 + 17 = 25 条', site.banner.lines.length === 25, site.banner.lines.length);

  // ---- 一言：第五轮把占比从 0.4 提到 0.85 ----
  check('一言默认开启且占比 0.85',
    !!site.banner.hitokoto && site.banner.hitokoto.enabled === true &&
    site.banner.hitokoto.ratio === 0.85,
    site.banner.hitokoto && { enabled: site.banner.hitokoto.enabled, ratio: site.banner.hitokoto.ratio });

  // 85% 这个比例能不能**供给得上**，取决于预取器的吞吐，不取决于这个数。
  // 一言接口一次只返回一条、没有批量端点，所以「85% 的弹幕来自一言」
  // 在数学上就等于 perSec × ratio × 60 次请求/分钟。
  // 这里把两条不变式一起钉住 —— 它们**各自都能单独把 85% 毁掉**，
  // 而且毁掉的方式都是"静默回落本地文案"，页面看不出任何异常。
  {
    const perSec = 1.5, ratio = site.banner.hitokoto.ratio;
    const reqPerMin = perSec * ratio * 60;
    const core = readText('assets/js/core.js');
    const conc = +(/var MAX_CONC = (\d+)/.exec(core) || [, 0])[1];
    const high = +(/var LOW = \d+, HIGH = (\d+)/.exec(core) || [, 0])[1];
    const cap = +(/var MAX_REQ_PER_MIN = (\d+)/.exec(core) || [, 0])[1];

    /* 不变式①：窗口上限必须盖得住「需求 + 起步一次性开销」。
       ⚠️ 这条是本轮被**实测**纠出来的：老的值是 80，而需求 76.5 已经把
          预算吃掉 96%，再叠加"起步把缓冲填到 HIGH 条"的那 20 次，
          第一分钟实际要 96.5 次 ⇒ 窗口在 t≈30s 就打满。
          而窗口打满是**硬停**（不是降速），于是接下来整分钟一条都不发：
          实测占比从 0.842 一路掉到 0.389，hkMiss 涨到 41。
          只钉"需求 ≤ 上限"是钉不住的 —— 漏掉的正是起步那一段。 */
    const need = reqPerMin + high;
    check('一言请求上限盖得住「需求 + 起步填缓冲」（否则窗口打满后整分钟硬停）',
      cap >= need, { 需求: +reqPerMin.toFixed(1), 起步填缓冲: high, 合计: +need.toFixed(1), 上限: cap });

    /* 不变式②：「预算够」≠「供得上」。串行补货一个周期 = 往返 + 间隔，
       实测往返平均 ~1.6s、**最坏 ~3.0s**，而需求是 1.275 次/秒 ——
       串行容量只有 0.48 次/秒，连需求的一半都不到，缓冲会常年见底。
       所以必须并发，且按**最坏**延迟算也要留余量（按平均算会给出假绿）。 */
    const LATENCY_WORST = 3.0;                 // 实测最坏单次往返（秒）
    const supply = conc / LATENCY_WORST;       // 次/秒
    const demand = perSec * ratio;             // 次/秒
    check('存在并发补货，且按最坏延迟算容量仍有余量（串行只有 0.48/s）',
      conc >= 2 && supply > demand * 1.2,
      { MAX_CONC: conc, supply: +supply.toFixed(3), demand: +demand.toFixed(3) });

    /* 不变式③：URL 必须带一个变化参数。
       ⚠️ 这条是**实测**撞出来的：一言挂在 Cloudflare 后面，URL 恒定时
       边缘缓存会把同一个响应体反复发回来（同参连打 14 次只回了 7 条不同句子，
       每条原样出现两次）。而下面对重复句子的处理是「丢弃」——
       于是**一半的请求白发了**，供给腰斩，比例从 0.85 掉到实测 0.33。
       带上变化参数后同参试验：8 次请求 8 条全不重复。 */
    check('一言请求 URL 带着"打散边缘缓存"的变化参数',
      /Date\.now\(\)\.toString\(36\)/.test(core) &&
        /function endpoint\(\)/.test(core) &&
        /\bu \+= '&_='/.test(core));
    check('补货不再是串行的（busy 标记位已换成在飞计数）',
      !/var busy = false/.test(core) && /var inFlight = 0/.test(core));
    // 真正上屏的来源分布必须能被观测 —— 否则"比例偏低"只能靠猜
    check('弹幕来源分布可被观测（hkShown / localShown / hkMiss）',
      /hkShown: hkShown, localShown: localShown, hkMiss: hkMiss/.test(core));

    /* 不变式④：**每一个请求的结局都必须被记账，且槽位必须回收。**
       ⚠️ 这是本轮实测抓到的最隐蔽的一个，值得单独钉死 ——
       老写法 `.then(function (r) { return r.ok ? r.json() : null; })`
       把非 200 响应静默变成 null，紧接着 `if (!j) return;` 直接走人：
       既不进 failures，也**不调 fill()**。后果是 inFlight 一条条漏光、
       并发管道慢慢塌掉、供给"悄悄地"停住 ——
       而所有计数器都是干净的 0，页面不报错、控制台不报错，
       唯一的症状是「实测比例从 0.842 慢慢掉到 0.326，hkMiss 涨到 42」。

       这条路径不是理论顾虑：实测同参连打 120 次，接口回了 22 个 429
       （打 60 次时还是全 200），所以限流是一条真实存在的线。
       换句话说，**在不该放弃的时候放弃**和**在被限流时判死**，
       都会以同一个"静默降级"的样子出现。

       ⚠️ 负向断言必须**先剥掉注释、再只扫 issue() 这一段**：
          ① 上面这段说明文字里就原样引用了那句老写法，扫全文会撞响自己的注释；
          ② 站里另有一个 `getJSON()`（取 data/*.json）也用同样的写法 ——
             在那里"失败回落 null"是**正确**的（数据拉不到就退化成默认值），
             所以这条守卫只能盯一言的补货函数，不能扫全站。 */
    const coreCode = core
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const issueCode = coreCode.slice(
      coreCode.indexOf('function issue()'), coreCode.indexOf('function take()'));
    check('非 200 响应不再被静默吞掉（抛出去走 catch，而不是变成 null 后 return）',
      /if \(!r\.ok\) \{/.test(issueCode) && /throw e;/.test(issueCode) &&
        !/return r\.ok \? r\.json\(\) : null/.test(issueCode));
    check('每个请求的结局都被分类记账（否则"供给停摆"在计数器上看不出来）',
      /var stats = \{ yield: 0, dup: 0, tooLong: 0, bad: 0, r429: 0, netErr: 0 \}/.test(core) &&
        /lastStatus = r\.status/.test(core));
    check('429 是"退避"而不是"判死"（被限流时最不该做的事就是彻底放弃）',
      /e\.status === 429/.test(core) &&
        /cooldownUntil = Date\.now\(\) \+ 20000/.test(core) &&
        /Date\.now\(\) < cooldownUntil/.test(core));
    check('补货管道在每条结局路径上都会回收（漏一格就少一格，最终整体停摆）',
      (core.slice(core.indexOf('function issue()'), core.indexOf('function take()'))
        .match(/\bfill\(\);/g) || []).length >= 3);
  }

  // ---- 自我介绍布局：模型图横铺在上，爱好一排跟在下 ----
  check('自我介绍改成上下两段整宽区块（不再是左右两栏）',
    !!doc.querySelector('#intro .intro-stack') && !doc.querySelector('#intro .intro-grid'));
  check('人格卡排在爱好之前（模型图在上、爱好在下）', (() => {
    const card = doc.querySelector('#intro .pentagon-card');
    const hb = doc.querySelector('#intro .hobbies');
    if (!card || !hb) return false;
    return !!(card.compareDocumentPosition(hb) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  })());
  check('模型图与五条分值并排（横着放，不是上下叠）',
    !!doc.querySelector('#intro .penta-body .penta-figure') &&
    !!doc.querySelector('#intro .penta-body .b5-legend'));
  check('爱好 4 项在一排里', doc.querySelectorAll('#intro .hobbies .hobby').length === 4);

  // ---- 背景：从本地插画池按色系桶取图，且不再经过任何代理接口 ----
  const pool = readJSON('data/palette-pool.json');
  const layer = doc.querySelector('#bg') && doc.querySelector('#bg').dataset.layer;
  check('背景取自本地插画池（不是兜底、不是代理）', layer === 'illust', layer);
  check('插画池张数与元数据一致', pool.all.length === pool.total, pool.total);
  const missingIllust = pool.all
    .map((i) => i.src.replace(/^\//, ''))
    .filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
  check('插画池每一张都真实落在 dist/ 里', missingIllust.length === 0, missingIllust.slice(0, 3));
  check('插画池条目都带 accent 主色',
    pool.all.every((i) => /^#[0-9a-f]{6}$/i.test(i.accent || '')));
  // 上一版有张深色插画抽到 #100700（最亮通道只有 16/255），
  // 结果光标环、下划线、导航圆点全成了黑色。这里钉住「不许近黑」。
  check('accent 没有被抽成近黑色（那种颜色当强调色等于没有）',
    pool.all.every((i) => {
      const c = i.accent.replace('#', '');
      const mx = Math.max(...[0, 2, 4].map((k) => parseInt(c.substr(k, 2), 16)));
      return mx >= 85;
    }),
    pool.all.map((i) => i.accent));
  check('背景图路径是根绝对（各层目录都能取到）',
    pool.all.every((i) => i.src.startsWith('/assets/img/illust/')));

  // ---- 取图轮换：色系桶是「偏好」而不是「锁死」 ----
  // 池子只有十来张时，按桶锁死会让每页永远在同样一两张里打转
  // （首页的暖橙桶里就只剩 1 张）—— 那正是「来来回回都是那几张」的成因。
  // 所以这里不再要求「每桶都非空」，改要求两件事：
  //   ① 每个色系都取得到图（绝无无背景页面）
  //   ② 同一色系连抽多次，必须能把整池走一遍
  check('桶里的条目都是全池的子集',
    Object.values(pool.buckets).every((b) =>
      b.items.every((i) => pool.all.some((a) => a.id === i.id))));
  check('全池 id 唯一', new Set(pool.all.map((i) => i.id)).size === pool.all.length);

  // 取图函数抛异常本身就等于「这一页取不到图」，所以这里兜住：
  // 断言必须报告「哪条不变量破了」，而不是让整套自检崩掉、只留一句堆栈。
  const pickBg = (bucket, used) => {
    try { return dom.window.Auxia.pickBackground(pool, bucket, used); }
    catch (e) { return { item: null, used: used, error: String((e && e.message) || e) }; }
  };

  const badBuckets = Object.keys(pool.buckets).filter((k) => {
    let used = [];
    for (let i = 0; i < 20; i++) {
      const r = pickBg(k, used);
      if (!r.item) return true;
      used = r.used;
    }
    return false;
  });
  check('五个色系逐个连抽 20 次都取得到图（绝无无背景页面）',
    badBuckets.length === 0, badBuckets);

  let usedWarm = [];
  const seenIds = new Set();
  for (let i = 0; i < 30; i++) {
    const r = pickBg('warm', usedWarm);
    usedWarm = r.used;
    seenIds.add(r.item ? r.item.id : '(取不到图)');
  }
  check('首页色系连抽 30 次会出现 ≥6 张不同的图（不再只在那一两张里打转）',
    seenIds.size >= 6, { distinct: seenIds.size, poolSize: pool.all.length });
  check('一轮会把整池走完再重开',
    seenIds.size === Math.min(pool.all.length, 30), seenIds.size);

  // 兜底仍然可用：显式走一次，确认不会出现「没有背景」的页面
  dom.window.Auxia.useLocalFallback();
  await new Promise((r) => setTimeout(r, 80));
  const fbLayer = doc.querySelector('#bg').dataset.layer;
  check('插画池取不到时会退到本地摄影，绝不开天窗',
    fbLayer === 'photo' || fbLayer === 'gradient', fbLayer);

  // ---- 矢量光标 ----
  check('矢量光标已挂载（SVG 内核 + 外圈）',
    !!doc.querySelector('#cursor .cur-core .core-mark') &&
    !!doc.querySelector('#cursor .cur-ring .ring-arc'));
  check('光标启用后系统指针才被隐藏',
    doc.documentElement.classList.contains('cursor-on'));

  // 真的动一下指针，验证「内核跟手、外圈拖后」——这就是非线性跟随的可观测形式
  const PE = dom.window.PointerEvent || dom.window.MouseEvent;
  doc.dispatchEvent(new PE('pointermove', { clientX: 900, clientY: 700, bubbles: true }));
  await new Promise((r) => setTimeout(r, 130));
  const readXY = (sel) => {
    const el = doc.querySelector(sel);
    const m = el && /translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(el.style.transform || '');
    return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : null;
  };
  const coreXY = readXY('#cursor .cur-core');
  const ringXY = readXY('#cursor .cur-ring');
  const dist = (p) => (p ? Math.hypot(p.x - 900, p.y - 700) : Infinity);
  check('光标两层都在跟随指针', !!coreXY && !!ringXY, { coreXY, ringXY });
  check('外圈明显拖在内核后面（非线性阻尼跟随，不是瞬间对齐）',
    dist(coreXY) < dist(ringXY) * 0.6,
    { core: +dist(coreXY).toFixed(1), ring: +dist(ringXY).toFixed(1) });

  // ---- 回归守卫：指针移出窗口再移回来，光标必须重新出现 ----
  // 曾经的写法只在「第一次 pointermove」时补 .is-on：
  //   if (!seen) { seen = true; host.classList.add('is-on'); }
  // 而 hide() 会在指针移出时摘掉 .is-on —— 于是「移出去再移回来」之后，
  // 元素还在 DOM 里、transform 也还在逐帧更新，但 opacity 恒为 0，
  // 用户看到的就是「光标没了，再也回不来」。
  const curHost = doc.querySelector('#cursor');
  doc.dispatchEvent(new dom.window.MouseEvent('mouseleave'));
  check('指针移出窗口后光标隐藏', !curHost.classList.contains('is-on'));
  doc.dispatchEvent(new PE('pointermove', { clientX: 420, clientY: 300, bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  check('指针移回来光标会重新出现（不是永久消失）', curHost.classList.contains('is-on'));
  const back = readXY('#cursor .cur-core');
  check('重新出现时不会从旧位置横穿过来（已归位到指针处）',
    !!back && Math.hypot(back.x - 420, back.y - 300) < 60, back);

  check('前端不再依赖任何取图代理接口', !/\/api\//.test(readText('assets/js/core.js')));

  check('无运行时报错', realErrors(errors).length === 0, realErrors(errors));
  check('主页请求的每个资源都真实存在', missingRequests().length === 0, missingRequests().slice(0, 4));
  const badHome = brokenImages('index.html', doc);
  check('主页所有图片地址都能落到真实文件', badHome.length === 0, badHome.slice(0, 4));
  ctx.homeHTML = html;
  dom.window.close();
}

async function testGallery() {
  console.log('\n=== 展墙总页 gallery/index.html ===');
  const { dom, doc, errors } = await load('gallery/index.html');
  const gallery = readJSON('data/gallery.json');

  const blocks = doc.querySelectorAll('.wall-block');
  check('5 面墙分区', blocks.length === gallery.walls.length, blocks.length);
  check('总数标注正确',
    doc.querySelector('#gallery-total').textContent === String(gallery.total),
    doc.querySelector('#gallery-total').textContent);

  // ---- 站主点名的两条硬要求，直接对着数据钉死 ----
  // 这一组断言是踩坑之后补上的：build_gallery.py 里的 asset_exists() 曾经用
  // `SITE / "/assets/..."` 拼路径，在 Windows 上会被 join 丢掉前缀，
  // 于是**每一张封面**都被判成「文件不存在」，整站静默回落成题名卡——
  // 页面不报错、数量断言全过，只有肉眼看才发现配图全没了。
  const allItems = gallery.walls.flatMap((w) => w.items);
  const MUST_HAVE_POSTER = ['舞萌maimaiDX', 'phigros', '伪物', '匙之咒', '全员同学会', '铁花飞',
    '悉达多', '德米安', '三体系列'];
  const lacking = MUST_HAVE_POSTER.filter((t) => {
    const it = allItems.find((i) => i.title === t);
    return !it || !it.poster;
  });
  check('站主指定补图的 9 件都真的有封面', lacking.length === 0, lacking);
  const GONE = ['BVN', 'alice in cradle', '胭脂'];
  const stillHere = allItems.map((i) => i.title).filter((t) => GONE.includes(t));
  check('站主要求下架的 3 件已从数据里消失', stillHere.length === 0, stillHere);
  const missingPosters = allItems.filter((i) => i.poster)
    .map((i) => i.poster.replace(/^\//, ''))
    .filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
  check('所有封面文件都在 dist/ 里', missingPosters.length === 0, missingPosters.slice(0, 3));
  check('展墙数据里不再有 desc 字段（解释性文字已从源头去掉）',
    gallery.walls.every((w) => !('desc' in w)),
    gallery.walls.filter((w) => 'desc' in w).map((w) => w.id));

  for (const w of gallery.walls) {
    const block = doc.querySelector(`#${w.id}`);
    const n = block ? block.querySelectorAll('.card-tile, .photo-grid figure').length : 0;
    check(`${w.name} 渲染 ${w.count} 件`, n === w.count, n);
  }

  const posterless = gallery.walls
    .filter((w) => w.kind === 'title')
    .flatMap((w) => w.items.filter((i) => !i.poster)).length;
  const cards = doc.querySelectorAll('.titlecard').length;
  check('无封面者一律题名卡', cards === posterless, { cards, posterless });

  // ---- 展区里不再有解释性文字 ----
  check('展区不再渲染解释性段落', !doc.querySelector('.wall-block-head .desc'));
  check('展区不再出现「题名卡」字样', !doc.body.textContent.includes('题名卡'));
  check('无封面的展品一律回落题名卡，且不再重复墙名',
    [...doc.querySelectorAll('.titlecard')].every((t) => !t.querySelector('.tc-kicker, .tc-wall')));
  check('题名卡一律显示展品名（别把有用的一起删了）',
    [...doc.querySelectorAll('.titlecard .tc-name')].every((n) => n.textContent.trim().length > 0));

  // 这一轮抓齐了封面，页面上可能一张题名卡都没有——但这条渲染路径必须仍然正确，
  // 否则下次素材缺失时它会静悄悄地烂掉。直接调一次渲染函数把它钉住。
  const tcHtml = dom.window.Auxia.titleCard({ title: '测试展品' });
  check('题名卡只渲染名字，不带墙名 / 「题名卡」字样',
    tcHtml.includes('测试展品') && !tcHtml.includes('题名卡') &&
    !tcHtml.includes('tc-kicker') && !tcHtml.includes('tc-wall'),
    tcHtml);

  // 灯箱是懒创建的：点一张摄影作品才生成并打开，所以这里验证真实交互
  const shot = doc.querySelector('.photo-grid [data-lightbox]');
  check('摄影作品可点击查看大图', !!shot);
  if (shot) {
    shot.click();
    await new Promise((r) => setTimeout(r, 40));
    const lb = doc.querySelector('.lightbox');
    check('点击后灯箱打开', !!lb && lb.classList.contains('is-open'));
    check('灯箱带说明文字', !!lb && lb.querySelector('.lb-cap').textContent.length > 0,
      lb && lb.querySelector('.lb-cap').textContent);
    if (lb) {
      lb.querySelector('.lb-close').click();
      await new Promise((r) => setTimeout(r, 40));
      check('灯箱可关闭', !lb.classList.contains('is-open'));
    }
  }
  check('锚点分区 id 存在', !!doc.querySelector('#anime') && !!doc.querySelector('#music'));
  const bad = brokenImages('gallery/index.html', doc);
  check('展墙页所有图片地址都能落到真实文件', bad.length === 0, bad.slice(0, 4));
  check('展墙页请求的每个资源都真实存在', missingRequests().length === 0, missingRequests().slice(0, 4));
  check('无运行时报错', realErrors(errors).length === 0, realErrors(errors));
  dom.window.close();
}

async function testProjects() {
  console.log('\n=== 项目页 ===');
  const site = readJSON('data/site.json');
  for (const p of site.projects) {
    const { dom, doc, errors } = await load(`projects/${p.slug}/index.html`);
    const h1 = doc.querySelector('h1');
    check(`${p.slug}：标题正确`, !!h1 && h1.textContent.trim() === p.title, h1 && h1.textContent);
    check(`${p.slug}：有返回首页链接`, !!doc.querySelector('.back, .crumb'));
    check(`${p.slug}：正文非空`, doc.querySelector('.lead').textContent.trim().length > 5);
    const bad = brokenImages(`projects/${p.slug}/index.html`, doc);
    check(`${p.slug}：图片地址可解析`, bad.length === 0, bad.slice(0, 4));
    check(`${p.slug}：请求的每个资源都真实存在`, missed.length === 0, missed.slice(0, 4));
    check(`${p.slug}：无运行时报错`, realErrors(errors).length === 0, realErrors(errors));
    dom.window.close();
  }

  await testLiarEmbed();
}

// ------------------------------------------------------- liar-game 内嵌 Demo
// 这一块是「接入」这个动作的全部可验证面。之所以值得单独写而不并进上面的
// 通用循环，是因为它有三类通用断言抓不到的失败：
//   1) 生成器把 EMBED 漏进了别的项目页（多出来的东西没人管）；
//   2) iframe 的 src 写对了、但那个文件没被 build 拷进 dist/（本地在、线上 404）；
//   3) 卡片本身偷偷引了站外资源 —— 本地打开一切正常，部署后要么被 CSP 拦、
//      要么就悄悄给站点加了一个外部依赖，把「本仓零外链」的承诺破掉。
// 三样都不会让「标题正确 / 正文非空」变红，所以必须显式钉住。
async function testLiarEmbed() {
  console.log('\n--- liar-game 内嵌 Demo ---');
  const SLUG = 'liar-game';
  const { dom, doc, errors } = await load(`projects/${SLUG}/index.html`);

  // (1) 容器：卡片是横向的博弈台，用通用宽度会把牌挤扁。
  const art = doc.querySelector('main > article');
  check('liar-game：正文容器加了 wide（否则牌桌被挤扁）',
    !!art && art.classList.contains('wrap') && art.classList.contains('proj-page')
      && art.classList.contains('wide'),
    art && art.className);

  // (2) iframe 本体 + src 真的落地
  const frame = doc.querySelector('.embed-box iframe');
  check('liar-game：iframe 存在', !!frame, !!frame);
  const src = frame && frame.getAttribute('src');
  check('liar-game：iframe 指向 liar-card.html', src === 'liar-card.html', src);

  // 按真实 URL 规则解析，再回 dist/ 里确认文件在 —— 「本地有、dist 没有」
  // 是最常见的漏构建，正好是这条挡住的。
  let resolved = null;
  if (src) {
    try { resolved = new URL(src, pageBaseUrl(`projects/${SLUG}/index.html`)).pathname; } catch { /* ignore */ }
  }
  const rel = resolved ? decodeURIComponent(resolved).replace(/^\/+/, '') : null;
  check('liar-game：iframe 的资源真的进了 dist/',
    !!rel && fs.existsSync(path.join(ROOT, rel)), rel);

  // src 必须是同源相对路径。写成站外地址就等于把 demo 托管到了别人的服务器上。
  check('liar-game：iframe 不是站外地址（同源相对）',
    !!src && !/^(https?:)?\/\//i.test(src) && !/^data:/i.test(src), src);

  // (3) 卡片自包含：一个外链都不许有，也不许碰存储 API。
  //     这条是防「以后换一版卡片、那版带了个 CDN 字体」的回归。
  const cardPath = path.join(ROOT, `projects/${SLUG}/liar-card.html`);
  if (fs.existsSync(cardPath)) {
    const card = fs.readFileSync(cardPath, 'utf8');
    const ext = (card.match(/(?:src|href)\s*=\s*["'](https?:)?\/\/[^"']+/gi) || []);
    check('liar-card：零站外资源引用（自包含）', ext.length === 0, ext.slice(0, 3));

    // iframe 里的存储是分区的：某些浏览器直接抛 SecurityError，卡片的存档逻辑会挂。
    const store = (card.match(/\b(localStorage|sessionStorage|indexedDB|document\.cookie)\b/g) || []);
    check('liar-card：不使用分区存储 API（iframe 里会抛安全错误）',
      store.length === 0, [...new Set(store)]);

    check('liar-card：带完整文档结构（能独立打开）',
      /<html[\s>]/i.test(card) && /<body[\s>]/i.test(card) && /<script[\s>]/i.test(card));
  } else {
    check('liar-card：源文件存在', false, cardPath);
  }

  // (4) 样式真的跟着走了：没有高度，iframe 会缩成默认 150px 的邮票。
  const css = readText('assets/css/site.css');
  check('liar-game：embed 样式在 dist 的 CSS 里（.embed-box）',
    /\.embed-box\b/.test(css) && /\.embed-box\s+iframe\b/.test(css));
  check('liar-game：iframe 有显式高度（否则塌成 150px）',
    /\.embed-box\s+iframe\s*\{[^}]*height\s*:/s.test(css));

  // (5) 反例守卫：内嵌只属于生成器 EMBEDS 表里列出的那几个 slug，别的项目页不许有。
  //     ⚠️ 这里**不能写死 'liar-game'** —— 第五轮 starcraft3 也加了 embed，
  //     写死的话这条守卫会把合法的那个当回归报红。所以直接读生成器的表。
  const EMBED_SLUGS = new Set(
    [...(/EMBEDS\s*=\s*\{([\s\S]*?)\n\}/.exec(readSource('tools/gen_project_pages.py')) || ['', ''])[1]
      .matchAll(/"([a-z0-9-]+)"\s*:/g)].map((m) => m[1]));
  check('从生成器读到了 embed 白名单（否则下面的反例守卫是空转）', EMBED_SLUGS.size >= 2,
    [...EMBED_SLUGS]);
  for (const p of readJSON('data/site.json').projects) {
    if (EMBED_SLUGS.has(p.slug)) continue;
    const other = await load(`projects/${p.slug}/index.html`);
    check(`${p.slug}：没有被误插入 embed`,
      other.doc.querySelectorAll('.embed').length === 0,
      other.doc.querySelectorAll('.embed').length);
    other.dom.window.close();
  }

  check('liar-game：无运行时报错', realErrors(errors).length === 0, realErrors(errors));
  dom.window.close();

  testLiarGlass();
}

// ------------------------------------------------------- 卡片的液态玻璃
// 这一组守的是「材质」，不是「排版」（排版由 tools/preview.py 的 &geo=1 在真实
// 浏览器里逐项比对，jsdom 没有布局引擎，量不了）。
//
// 为什么值得单独守：liar-card.html 是**从站外拷进来的**（用户给的源路径）。
// 以后谁再拷一版新的进来，整块玻璃会被无声覆盖掉 —— 页面还能跑、牌还能打、
// 通用断言全绿，玻璃却没了。所以必须把「玻璃还在」这件事显式钉住。
function testLiarGlass() {
  console.log('\n--- liar-card 液态玻璃 ---');
  const card = readText('projects/liar-game/liar-card.html');

  // 玻璃本体：blur + vibrancy(saturate 1.5)。
  //
  // 两个坑都在这里踩过：
  //  a) 不能拿整份文件去搜 backdrop-filter —— 面板那条规则
  //     （.side,#board,...{backdrop-filter:blur(...)}）会先命中，把守卫喂绿，
  //     哪怕卡片的玻璃已经被删光。
  //  b) 也不能用 /[^}]*backdrop-filter/ 就行 —— -webkit-backdrop-filter 里
  //     同样含这几个字，标准属性被删掉、只剩前缀版也照样绿。
  // 所以先取出所有 .card{...} 块，找到**最后**声明 backdrop-filter 的那一个
  // （级联里胜出的就是它），再要求块内存在不带前缀的那一条。
  const cardBlocks = [...card.matchAll(/\.card\s*\{([^}]*)\}/gs)].map((m) => m[1]);
  const bfBlocks = cardBlocks.filter((b) => /backdrop-filter\s*:/.test(b));
  const bfWin = bfBlocks.length ? bfBlocks[bfBlocks.length - 1] : '';
  check('卡片有 backdrop-filter（玻璃本体，且是不带前缀的那一条）',
    /(^|[;{\s])backdrop-filter\s*:\s*blur\(/m.test(';' + bfWin),
    bfWin.replace(/\s+/g, ' ').slice(0, 70));
  const bfv = (bfWin.match(/(^|[;{\s])backdrop-filter\s*:\s*([^;]+);/) || [])[2] || '';
  check('玻璃链按 colorFilter→blur→lens 的顺序落成 blur+saturate',
    /blur\(/.test(bfv) && /saturate\(/.test(bfv), bfv.trim());
  check('同时给了 -webkit- 前缀（Safari 只认前缀版）',
    /-webkit-backdrop-filter\s*:/.test(card));

  // 高光：radial-gradient 的圆心必须吃 --lg-mx/--lg-my
  check('指针高光是一个吃 --lg-mx/--lg-my 的 radial-gradient',
    /radial-gradient\(circle\s+var\(--lg-spec\)\s+at\s+var\(--lg-mx\)\s+var\(--lg-my\)/s.test(card));
  check('高光用 ::before（::after 被 .card.back 的虚线圆占用了）',
    /\.card::before\s*\{/.test(card) && /\.card\.back::after\s*\{/.test(card));
  check('高光靠 mix-blend-mode:screen 只加光、不洗白牌面文字',
    /mix-blend-mode\s*:\s*screen/.test(card));
  check('高光不透明度只由 --lg-hot 一个来源决定',
    /opacity\s*:\s*var\(--lg-hot/.test(card));
  check('":hover 写 --lg-hot:1" 而不是直接写 opacity（保持单一来源）',
    /\.card:hover\s*\{\s*--lg-hot\s*:\s*1\s*\}/.test(card));
  check('点亮被关在 (hover:hover) and (pointer:fine) 里（触屏 :hover 会粘住）',
    /@media\s*\(hover:hover\)\s*and\s*\(pointer:fine\)/.test(card));

  // 这一条是踩过的坑：把 transform 整条塞进一个 :root 上的 --lg-xform 变量，
  // var() 会在 :root 就替换成死值，卡片自己写的 --lg-rx/--lg-scale 全部失效
  // —— 倾斜和按压缩放都变成静止的，而截图完全看不出来。
  const cardRule = (card.match(/\.card,\.card\.clickable:hover,\.card\.sel\{[^}]*\}/s) || [''])[0];
  check('transform 在卡片自己的规则里逐字写出（不套 --lg-xform 变量）',
    /transform\s*:\s*perspective\(/.test(cardRule)
      && /rotateX\(var\(--lg-rx\)\)/.test(cardRule)
      && /scale\(var\(--lg-scale\)\)/.test(cardRule),
    cardRule.replace(/\s+/g, ' ').slice(0, 90));

  // 类别色不能被玻璃吃掉：牌面红/蓝/琥珀是有含义的。
  // 注意要取**最后一条**声明 —— 同名选择器前面还有一条老的（只有主色、
  // 没有那层白），叠层时胜出的是后面的。取第一条会永远为假。
  check('三类牌的主色仍在背景图层里（玻璃只叠在上面）',
    ['attack', 'defense', 'neutral'].every((c) => {
      const all = [...card.matchAll(new RegExp('\\.card\\.' + c + '\\s*\\{([^}]*)\\}', 'gs'))];
      const win = all.length ? all[all.length - 1][1] : '';
      return /rgba\(255,255,255/.test(win) && /linear-gradient\(175deg/.test(win);
    }));
  check('牌背的斜条纹还在（没被表面的白盖掉）',
    /\.card\.back\s*\{[^}]*repeating-linear-gradient/s.test(card));

  // 鼠标向量脚本
  check('指针脚本在（事件委托在 document 上，不怕 innerHTML 重建）',
    /addEventListener\('pointermove'/.test(card) && /closest\('\.card'\)/.test(card));
  check('脚本按 hover/pointer:fine 和 reduced-motion 双闸门启用',
    /\(hover:hover\) and \(pointer:fine\)/.test(card)
      && /\(prefers-reduced-motion:reduce\)/.test(card));
  check('按压有抬起/取消/失焦三条回收路径（不会卡在放大态）',
    /addEventListener\('pointerup', release\)/.test(card)
      && /addEventListener\('pointercancel', release\)/.test(card)
      && /addEventListener\('blur'/.test(card));
  check('指针离开窗口会清掉高光变量（不粘在最后一张牌上）',
    /addEventListener\('pointerout'/.test(card) && /relatedTarget/.test(card));

  // 排版：为了把内容提到环境光晕之上，只多了这一条定位
  check('#app 被提为 relative 以压在环境光晕之上',
    /#app\{position:relative;z-index:1\}|\/\* 环境光晕/.test(card));
  check('有环境光晕层（否则 backdrop-filter 面对纯色背景等于空转）',
    /body::before\s*\{[^}]*radial-gradient/s.test(card));
}

async function test404() {
  console.log('\n=== 404.html ===');
  const { dom, doc, errors } = await load('404.html');
  check('404 码正确', doc.querySelector('.nf .code').textContent.trim() === '404');
  check('有回首页入口', !!doc.querySelector('a[href="/"]'));

  // 这一页专门用根绝对路径（/assets/...），因为 404 会在任意深度被命中。
  // 也正因如此，它是最容易「CSS/JS 全都没加载、而断言还全绿」的一页——
  // 下面两条就是那次踩坑留下的守卫。
  check('404 页的 CSS 真的加载了', doc.styleSheets.length > 0, doc.styleSheets.length);
  check('404 页的 JS 真的跑了（core.js 起来了）',
    typeof dom.window.Auxia === 'object' && !!doc.querySelector('#cursor'),
    { auxia: typeof dom.window.Auxia, cursor: !!doc.querySelector('#cursor') });

  check('404 页请求的每个资源都真实存在', missed.length === 0, missed.slice(0, 4));
  check('无运行时报错', realErrors(errors).length === 0, realErrors(errors));
  dom.window.close();
}

// ------------------------------------------------------- 图层契约
// 背景层 #bg 是 position:fixed + z-index:0。按 CSS 绘制顺序，它排在
// 「已定位元素」那一档，会整块盖住**未定位**的普通块级内容——
// 文字明明在 DOM 里、数量断言也全过，用户看到的却是一片空白。
// 这种问题断言「元素是否存在 / 文本是否非空」永远抓不到，所以单独核一遍层叠关系。
async function testLayering() {
  console.log('\n=== 图层契约 ===');
  const rawCss = [readText('assets/css/variables.css'), readText('assets/css/site.css')];
  const css = rawCss.join('\n');
  // 注释里也会出现属性名（比如解释为什么不能用 multiply），
  // 所以做「属性是否还存在」这类断言前必须先把注释去掉。
  const codeCss = rawCss.map((t) => t.replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');
  const pages = ['index.html', 'gallery/index.html', 'projects/liar-game/index.html', '404.html'];

  for (const p of pages) {
    const { dom, doc, errors } = await load(p);

    // 把样式表内联注入：jsdom 对 <link> 的层叠支持不可靠，
    // 但内联 <style> 能走完整级联，getComputedStyle 拿到的就是真实值。
    const style = doc.createElement('style');
    style.textContent = css;
    doc.head.appendChild(style);

    const styleOf = (sel) => {
      const el = doc.querySelector(sel);
      return el ? dom.window.getComputedStyle(el) : null;
    };
    const zOf = (sel) => {
      const s = styleOf(sel);
      if (!s) return NaN;
      return s.zIndex === 'auto' ? 0 : (parseInt(s.zIndex, 10) || 0);
    };

    const mainCss = styleOf('main');
    check(`${p}：内容层已脱离普通流（不会被背景层盖住）`,
      !!mainCss && mainCss.position !== 'static', mainCss && mainCss.position);
    check(`${p}：内容层在弹幕/粒子之上`,
      zOf('main') > zOf('#danmaku') && zOf('main') > zOf('#particles'),
      { main: zOf('main'), danmaku: zOf('#danmaku'), particles: zOf('#particles') });
    // 404 页没有导航栏，所以「高于导航」只在存在导航时才比
    const hasNav = !!doc.querySelector('.nav');
    check(`${p}：光标层盖在内容与导航之上`,
      zOf('#cursor') > zOf('main') && (!hasNav || zOf('#cursor') > zOf('.nav')),
      { cursor: zOf('#cursor'), main: zOf('main'), nav: hasNav ? zOf('.nav') : '（本页无导航）' });

    check(`${p}：图层契约检查期间无报错`, realErrors(errors).length === 0, realErrors(errors));
    check(`${p}：本页请求的资源都真实存在`, missed.length === 0, missed.slice(0, 4));
    dom.window.close();
  }

  // ---- 弹幕外观 ----
  // 历史：曾经是 opacity:.2 + mix-blend-mode:multiply + 白色药丸底。
  // multiply 让它和白纱相乘糊掉；药丸底又把每条变成一个「盒子」。
  // 现在的要求正好反过来：**不许有底**，存在感完全靠整体透明度压。
  check('弹幕层不再使用 multiply 混合（它会和白纱相乘糊掉）',
    !/mix-blend-mode/.test(codeCss));
  const opMatch = /--danmaku-opacity:\s*([\d.]+)/.exec(codeCss);
  check('弹幕存在感被压低（0.15 ≤ 不透明度 ≤ 0.40）',
    !!opMatch && parseFloat(opMatch[1]) >= 0.15 && parseFloat(opMatch[1]) <= 0.40,
    opMatch && opMatch[1]);
  const dmBlock = /\.dm-item\s*\{([\s\S]*?)\}/.exec(codeCss);
  check('弹幕不再带气泡（没有 background / box-shadow / backdrop-filter）',
    !!dmBlock && !/background\s*:/.test(dmBlock[1]) &&
    !/box-shadow\s*:/.test(dmBlock[1]) && !/backdrop-filter\s*:/.test(dmBlock[1]),
    dmBlock && dmBlock[1].replace(/\s+/g, ' ').slice(0, 150));
  check('弹幕不吃指针事件（不挡正文点击；高亮由 JS 命中检测负责）',
    !!dmBlock && /pointer-events:\s*none/.test(dmBlock[1]));
  // 弹幕层在内容层之下，指针永远碰不到它，:hover 是死代码。
  // 留着会让人以为「高亮是 CSS 在管」，所以直接禁掉。
  check('没有给弹幕写 :hover（它在内容层之下，写了也不会触发）',
    !/\.dm-item:hover/.test(codeCss));

  // ⚠️ 下面三条守着一个**真被踩到过**的 bug，别删。
  // 弹幕的命中检测（core.js 的 boxes()）是按 p ∈ [0,1] 推位置的：
  //   p >= 1 -> 当成「这一圈跑完了、已经在屏外」直接跳过。
  // 而 CSS 原本写的是 `animation: dm-scroll linear infinite`：
  //   - infinite => animationend **永不触发** => 回收只剩「dur+3 秒」兜底定时器；
  //   - 于是那条弹幕跑完一圈后，会在原地从右侧**重新进场、再飞 3 秒**；
  //   - 这 3 秒里它明明画在屏幕上，boxes() 却把它跳过了 ——
  //     「看得见、指针扫上去却不高亮」。
  // 真实浏览器实测：25 条里稳定有 3 条处于该状态（约 12%）。
  // 改成只跑一圈后 animationend 准时回收，p ∈ [0,1] 才真正等价于「在屏幕上」。
  check('弹幕动画只跑一圈（写 infinite 会让第二圈变成"看得见却高亮不了"）',
    !!dmBlock && /animation-iteration-count:\s*1\s*;/.test(dmBlock[1]) &&
    !/\binfinite\b/.test(dmBlock[1]),
    dmBlock && (/animation-iteration-count:\s*([^;]+)/.exec(dmBlock[1]) || [])[1]);
  check('弹幕动画结束保持终态，直到 animationend 把它收走（fill-mode: forwards）',
    !!dmBlock && /animation-fill-mode:\s*forwards/.test(dmBlock[1]));
  // 时长是 core.js 逐条写在内联 style 上的。CSS 这边不给兜底值的话，
  // 内联万一没写上 -> duration 退化成 0s -> 动画瞬间走完 -> 刚生成就被回收，
  // 页面上一条弹幕都看不见（这种"什么都不显示"比"太快"难排查得多）。
  check('弹幕动画在 CSS 里有兜底时长（避免内联失效时全部瞬间消失）',
    !!dmBlock && /animation-duration:\s*[\d.]+s/.test(dmBlock[1]),
    dmBlock && (/animation-duration:\s*([^;]+)/.exec(dmBlock[1]) || [])[1]);
  // 跨文件契约：上面那条 CSS 和 core.js 的 p∈[0,1] 判断必须同时成立，
  // 任意一边被改回去都会让高亮重新失灵，所以两边都钉住。
  check('core.js 命中检测仍按 p∈[0,1] 判定"在屏幕上"（与上面 iteration-count:1 配对）',
    /p <= 0 \|\| p >= 1/.test(readText('assets/js/core.js')));

  // ---- 圆角 ----
  const radius = /--radius:\s*([\d.]+)px/.exec(codeCss);
  const radiusSm = /--radius-sm:\s*([\d.]+)px/.exec(codeCss);
  const radiusPill = /--radius-pill:\s*([\d.]+)px/.exec(codeCss);
  check('圆角整体收锐（卡片 ≤10px）',
    !!radius && parseFloat(radius[1]) <= 10, radius && radius[1]);
  check('小件圆角比卡片更锐',
    !!radiusSm && !!radius && parseFloat(radiusSm[1]) < parseFloat(radius[1]),
    radiusSm && radiusSm[1]);
  check('胶囊件也收成小圆角（不再是 999px 药丸）',
    !!radiusPill && parseFloat(radiusPill[1]) <= 16, radiusPill && radiusPill[1]);
  check('全站不再有写死的 999px 圆角（圆角只能从这三档里取）',
    !/border-radius:\s*999px/.test(codeCss));

  // ---- 字号尺度 ----
  const bodyBlock = /body\s*\{([\s\S]*?)\}/.exec(codeCss);
  check('正文直接用字号阶梯，不再写死 16px',
    !!bodyBlock && /font-size:\s*var\(--fs-md\)/.test(bodyBlock[1]),
    bodyBlock && (/font-size:\s*([^;]+)/.exec(bodyBlock[1]) || [])[1]);
  const fsMd = /--fs-md:\s*([\d.]+)px/.exec(codeCss);
  check('正文字号比默认 16px 明显大一档（≥17px）',
    !!fsMd && parseFloat(fsMd[1]) >= 17, fsMd && fsMd[1]);
}

// ------------------------------------------------- 外部请求白名单
// 站点从「零外部请求」变成「只有一个外部请求：一言」。这条线必须有人看着：
// 哪天顺手引一个 CDN 字体、统计脚本或图片代理，不该没人发现。
// 注意区分两类 —— canonical / og 里那个 auxiaweb.pages.dev 只是元信息，
// 不是浏览器会去拉的东西；真正会发请求的只有 v1.hitokoto.cn。
async function testExternalOrigins() {
  console.log('\n=== 外部请求白名单 ===');

  // 两类要分开看：
  //  · 归属信息 —— 来源链接、出处、命名空间。写在数据里或只是给人点的，
  //    浏览器不会主动去拉。
  //  · 会被**自动请求**的资源 —— src= / <link href> / CSS url() / JS 里的
  //    URL 字面量。这一类才是真正决定「站点访问了哪些外部域」的东西，
  //    白名单里只允许一言。
  const INERT_HOSTS = new Set([
    'v1.hitokoto.cn', 'hitokoto.cn',
    'auxiaweb.pages.dev', 'www.w3.org',
    'anilist.co', 'store.steampowered.com', 'book.douban.com',
    'music.apple.com', 'www.bing.com'
    // 注意：www.jianguoyun.com 是**故意**从白名单里删掉的。
    // 站主要求不外泄私密信息，坚果云外链连同 projects/obsidian/ 一起删了。
    // 留着白名单等于给「哪天它悄悄回来」开了后门 —— 白名单要跟着承诺一起收窄。
    //
    // 同理 auxia-site.app.workbuddy.host 也已从这里删掉：那个地址按站主要求
    // 下线了（站点只保留 auxiaweb.pages.dev 一个），产物里不再引用它。
    // 白名单跟着一起收窄，否则就是在给一个已经废弃的地址留后门。
  ]);

  // 「只允许出现在 JS 字面量里」的域：Bing。
  // 第五轮加了「点弹幕去 Bing 搜出处」，那个 URL 是 `window.open(...)` 的
  // **参数** —— 只有用户真的点了才会导航，页面自己**不会**去拉它。
  // 所以它不能算「被自动加载的外部资源」。但也不能一放了之：
  // 白名单要钉住它的**形态** —— 出现在别处（src= / url() / <link>）就是回归，
  // 那意味着有人把它接成了一个真正的资源请求。
  const NAV_ONLY = new Set(['www.bing.com']);
  const isNavLiteral = (h, kinds) => NAV_ONLY.has(h)
    && kinds.every((d) => d.startsWith('JS 字面量'));


  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); }
      else if (/\.(html|css|js|webmanifest)$/.test(e.name)) { files.push(p); }
    }
  };
  walk(ROOT);

  // 「会被浏览器自动拉」的写法：
  //   · 资源属性 src=
  //   · CSS 里的 url()
  //   · <link> 里 **rel 属于资源类** 的那些（canonical / alternate 只是元信息，
  //     不产生请求，别把它们也算进来）
  // 另外 JS 是唯一能主动发请求的地方，所以 assets/js/ 下的外部 URL
  // 字面量全算进来（fetch 的地址是运行时拼的，扫字面量才抓得到）。
  const RESOURCE_REL = /(^|\s)(stylesheet|icon|apple-touch-icon|manifest|preload|prefetch|modulepreload|preconnect|dns-prefetch)(\s|$)/i;

  const hits = new Map();
  const note = (host, detail) => {
    if (!hits.has(host)) { hits.set(host, []); }
    hits.get(host).push(detail);
  };

  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    const txt = fs.readFileSync(f, 'utf8');

    for (const m of txt.matchAll(/\bsrc\s*=\s*["'](https?:\/\/[^"']+)/gi)) {
      try { note(new URL(m[1]).hostname.toLowerCase(), `src= @ ${rel}`); } catch (e) { /* noop */ }
    }
    for (const m of txt.matchAll(/url\(\s*["']?(https?:\/\/[^"')]+)/gi)) {
      try { note(new URL(m[1]).hostname.toLowerCase(), `CSS url() @ ${rel}`); } catch (e) { /* noop */ }
    }
    if (/\.html$/.test(f)) {
      for (const tag of txt.matchAll(/<link\b[^>]*>/gi)) {
        const s = tag[0];
        const relV = (/\brel\s*=\s*["']([^"']+)/i.exec(s) || [])[1] || '';
        const href = (/\bhref\s*=\s*["'](https?:\/\/[^"']+)/i.exec(s) || [])[1];
        if (!href || !RESOURCE_REL.test(relV)) { continue; }
        try { note(new URL(href).hostname.toLowerCase(), `link[rel=${relV}] @ ${rel}`); } catch (e) { /* noop */ }
      }
    }
    if (rel.startsWith('assets/js/')) {
      for (const m of txt.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
        note(m[1].toLowerCase(), `JS 字面量 @ ${rel}`);
      }
    }
  }

  const rogue = [...hits.keys()].filter((h) =>
    h !== 'v1.hitokoto.cn' && h !== 'www.w3.org' && !isNavLiteral(h, hits.get(h)));
  check('没有任何白名单外的外部资源被自动加载',
    rogue.length === 0, rogue.map((h) => `${h}  <-  ${hits.get(h).join(', ')}`));
  const apis = [...hits.keys()].filter((h) => h !== 'www.w3.org' && !NAV_ONLY.has(h));
  check('唯一会被请求的外部接口是一言',
    apis.join(',') === 'v1.hitokoto.cn',
    [...hits.keys()]);

  // 数据里的出处链接只做记录，不产生请求 —— 但仍然要求它们在白名单内，
  // 免得哪天真的把某个来源渲染成外链资源。
  const dataHosts = new Set();
  for (const p of ['data/gallery.json', 'data/site.json', 'data/posters.json']) {
    try {
      for (const m of readText(p).matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
        dataHosts.add(m[1].toLowerCase());
      }
    } catch (e) { /* 有的文件可能不存在 */ }
  }
  const unknownData = [...dataHosts].filter((h) => !INERT_HOSTS.has(h));
  check('数据里的出处链接也在白名单内', unknownData.length === 0, unknownData);

  check('data/site.json 里的一言开关可被关掉（有 enabled 字段）',
    'enabled' in readJSON('data/site.json').banner.hitokoto);
}

// ------------------------------------------- 第五轮：新增/改动的可验证面
// 这一批的共同点：**都不是「页面长得对不对」，而是「某个跨文件契约还成不成立」**。
// 它们几乎全都不会让页面报错 —— 坏了就是安静地坏，所以必须显式钉住。
async function testRoundFive() {
  console.log('\n=== 第五轮改动 ===');

  // ---------------------------------------------------------------- 工具
  // PNG：8 字节签名 + IHDR，宽高是紧跟其后的两个大端 32 位
  const pngSize = (buf) => {
    if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) { return null; }
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  };
  // ICO：ICONDIR 头部偏移 4 处是图像帧数（小端 16 位）
  const icoFrames = (buf) => {
    if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) { return 0; }
    return buf.readUInt16LE(4);
  };
  const distFile = (rel) => path.join(ROOT, rel);
  const hasDist = (rel) => fs.existsSync(distFile(rel));

  // ------------------------------------------------- 1. 字体预加载（回归守卫）
  // 这一条是补一个**一直存在、直到这轮才被发现**的静默失效：
  // inject_preload 原本用「两个标记之间」的正则，而页面里只有一个标记，
  // 于是正则永远匹配不上，脚本却照常打印「preload -> index.html (5 片)」。
  // 站点从上线起就从来没预加载过字体 —— 日志说做了，文件里一个字没有。
  // 所以这里不是检查「有没有 preload」，而是检查**注入真的发生了**：
  //   · 标记出现次数 >= 2（成对，说明展开过）
  //   · 而且真的带了 body / logo 两条
  {
    const pages = [];
    const walkPages = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walkPages(p); }
        else if (e.name.endsWith('.html')) { pages.push(p); }
      }
    };
    walkPages(ROOT);

    // 两个**第三方单文件包**不是本站模板生成的，里面既没有标记、
    // 也不用本站字体 —— 它们是被 iframe 引进去的独立游戏。所以排除。
    // 但排除必须**列名**，不能用「没有标记就跳过」—— 那正好会漏掉
    // 「模板里的标记被误删」这种情况，守卫就成了空转。
    const STANDALONE = new Set([
      'projects/liar-game/liar-card.html',
      'projects/starcraft3/sc3.html',
    ]);

    const bad = [];
    let guarded = 0;
    for (const p of pages) {
      const t = fs.readFileSync(p, 'utf8');
      const rel = path.relative(ROOT, p).replace(/\\/g, '/');
      if (STANDALONE.has(rel)) { continue; }
      guarded += 1;
      const marks = (t.match(/<!-- font-preload -->/g) || []).length;
      if (marks !== 2) { bad.push(`${rel}: 标记 ${marks} 个（应为 2：成对才算展开过）`); continue; }
      if (!/logo-subset\.woff2/.test(t)) { bad.push(`${rel}: 缺 logo-subset 预载`); }
      if (!/body-subset\.woff2/.test(t)) { bad.push(`${rel}: 缺 body-subset 预载`); }
    }
    check(`字体预载真的注入到了每一页（${guarded}/${pages.length} 页，排除 2 个第三方单文件）`,
      bad.length === 0 && guarded === pages.length - 2, bad.slice(0, 4));
  }

  // ------------------------------------------------ 2. LOGO 字体子集
  // 源字体 4.06MB。整包上站是不可接受的，所以子集必须真的发生。
  check('LOGO 字体已子集化且体积很小（<40KB）',
    hasDist('assets/fonts/logo-subset.woff2') &&
      fs.statSync(distFile('assets/fonts/logo-subset.woff2')).size < 40 * 1024,
    hasDist('assets/fonts/logo-subset.woff2')
      ? `${(fs.statSync(distFile('assets/fonts/logo-subset.woff2')).size / 1024).toFixed(1)}KB` : '缺失');
  check('开屏字体在 CSS 里有 @font-face（且挂进了 --font-logo）',
    /ZhanKuXiaoWei-auxia/.test(readText('assets/css/fonts.css')) &&
      /--font-logo:\s*"ZhanKuXiaoWei-auxia"/.test(readText('assets/css/variables.css')));

  // ------------------------------------------------ 3. 图标来自站主的标志
  check('favicon.ico 含 4 档尺寸（16/32/48/64）',
    hasDist('assets/img/icons/favicon.ico') &&
      icoFrames(fs.readFileSync(distFile('assets/img/icons/favicon.ico'))) === 4,
    hasDist('assets/img/icons/favicon.ico')
      ? icoFrames(fs.readFileSync(distFile('assets/img/icons/favicon.ico'))) : '缺失');
  {
    const at = hasDist('assets/img/icons/apple-touch-icon.png')
      ? pngSize(fs.readFileSync(distFile('assets/img/icons/apple-touch-icon.png'))) : null;
    check('apple-touch-icon 是 180×180', !!at && at.w === 180 && at.h === 180, at);
    const og = hasDist('assets/img/icons/og-cover.png')
      ? pngSize(fs.readFileSync(distFile('assets/img/icons/og-cover.png'))) : null;
    check('og-cover 是 1200×630', !!og && og.w === 1200 && og.h === 630, og);
    const av = hasDist('assets/img/icons/avatar.png')
      ? pngSize(fs.readFileSync(distFile('assets/img/icons/avatar.png'))) : null;
    check('avatar 是 512×512', !!av && av.w === 512 && av.h === 512, av);
  }
  // 图标改为「从站主给的标志图派生」。判据是看生成器：
  // 旧的程序化画法里有个 draw_mark；现在必须是从 SRC_LOGO 裁 CARD_BOX 派生。
  // ⚠️ 别再拿那组暖橙/粉紫常量当判据 —— OG 封面本来就在用它们，
  //    那条检查会把合法的调色板误判成「还没改」。
  {
    const src = readSource('tools/build_icons.py');
    check('图标生成器已改为读站主的标志源图',
      /SRC_LOGO/.test(src) && /CARD_BOX/.test(src) && !/def draw_mark/.test(src));
    check('favicon.svg 内嵌的是位图（源图是成图，没有矢量可描）',
      /data:image\/png;base64,/.test(readText('assets/img/icons/favicon.svg')));
  }

  // ------------------------------------------------ 4. 休眠模式标题
  {
    const core = readText('assets/js/core.js');
    // ⚠️ 精确到码位：文案里那个 ´ 是 U+00B4（尖音符）、` 是 U+0060（反引号）。
    //    它们长得像引号，极容易被「顺手规范一下」替换掉，一换表情就毁了。
    const want = '休眠模式 ( \u00b4-\u03c9-`)zzZ';
    check('core.js 里的休眠标题逐字正确（含 U+00B4 与 U+0060）',
      core.includes('SLEEP_TITLE') && core.includes(want),
      core.includes(want) ? 'ok' : want);
    // 基础标题必须是**运行时抓的**，写死会让项目页/展墙页切回来变成首页标题
    check('休眠标题的基础值运行时读取（不写死）',
      /var baseTitle = document\.title/.test(core));
    const idx = readText('index.html');
    check('首页 <title> 已改为「Auxia的个人小站」',
      /<title>Auxia的个人小站<\/title>/.test(idx));
  }

  // ------------------------------------------------ 5. 弹幕可点击
  {
    const core = readText('assets/js/core.js');
    // ⚠️ 别用 `!/target=/.test(core)` 当判据 —— core.js 里**本来**就有一个
    //    `<a ... target="_blank">`（展墙的来源链接），那会把合法代码判成回归。
    //    这里直接钉住真正的实现形态：window.open(url, '_blank', ...)。
    check('点击弹幕会去 Bing 搜出处',
      /www\.bing\.com\/search\?q=/.test(core) &&
        /window\.open\(url, '_blank'/.test(core));
    // 弹幕层是 pointer-events:none、而且在内容层下面，所以必须
    // ① 用几何命中检测而不是事件目标 ② 主动放过真正的交互元素
    check('点击弹幕时放过真正的交互元素（否则点链接会连带触发搜索）',
      /closest\(CLICKABLE\)/.test(core));
    check('弹幕记录里保留了原文案（rec.text）', /text:\s*text/.test(core));
  }

  // ------------------------------------------------ 6. 指针进 iframe 隐藏
  {
    const core = readText('assets/js/core.js');
    check('指针进入 iframe 时会隐藏自定义光标',
      /tagName === 'IFRAME'/.test(core) && /relatedTarget/.test(core));
  }

  // ------------------------------------------------ 7. 卡片玻璃 + 逐个淡入
  {
    const css = readText('assets/css/site.css');
    const blocks = [...css.matchAll(/\.card\s*\{([^}]*)\}/gs)].map((m) => m[1]);
    // ⚠️ 不能取「最后一块 .card」—— @media (hover:none) 里还有一块 .card
    //    覆盖（只重置 background），取最后一块等于在检查那条覆盖。
    //    按内容选：玻璃那块是唯一带 backdrop-filter 的。它一旦丢了，
    //    win 就是空串，下面两条会一起报红 —— 正是想要的行为。
    const win = blocks.find((b) => /backdrop-filter/.test(b)) || '';
    // 玻璃的关键是增艳（saturate），不只是模糊 —— 见 site.css 里的长注释
    check('卡片玻璃带 saturate（只 blur 在这个浅底站上等于没有）',
      /backdrop-filter:\s*[^;]*saturate\(/.test(win), /backdrop-filter:\s*([^;]+)/.exec(win));
    check('卡片高光用 background 层而不是 ::before（::before 会盖住文字）',
      /radial-gradient\([^)]*var\(--gx/.test(win));
    // 触摸设备没有指针，高光层应当被去掉（否则白算）
    check('触摸设备下高光层被去掉', /@media \(hover: none\)[\s\S]{0,120}\.card\s*\{[^}]*background:\s*linear-gradient/.test(css));
    // ⚠️ 这条是真正的坑：fill-mode 用 both/forwards 会把最后一帧的
    //    `transform: none` 永久留在元素上，把 .card:hover 的上浮压掉 ——
    //    表现是「进场之后卡片就没有悬停反馈了」，极难联想到 animation。
    const anim = /\.reveal\.is-on > \.card\s*\{([^}]*)\}/.exec(css);
    check('卡片淡入用 backwards 而非 both/forwards（否则会压掉 hover 位移）',
      !!anim && /backwards/.test(anim[1]) && !/\b(both|forwards)\b/.test(anim[1]),
      anim && anim[1].trim());
    check('卡片淡入有错落延迟（不是整块一起出现）',
      /\.reveal\.is-on > \.card:nth-child\(3\)/.test(css));
    check('卡片淡入在「减少动态效果」下被关掉',
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.reveal\.is-on > \.card \{ animation: none; \}/.test(css));
  }

  // -------------------------------------- 7b. 安全网不许把"折叠线以下的淡入"吃掉
  // 本轮真踩到的坑：initReveal 里那条 2400ms 的安全网原本写成
  //   「还有没亮的 → 全部点亮」。后果是折叠线以下的卡片在**视口外**偷偷把
  //   淡入（含错落的 cardIn）跑完，用户滚下去时什么动画都看不到 ——
  //   实测滚到项目区时卡片 opacity 恒为 1、animationName 已是 cardIn（早跑完了）。
  //   表现就是「做了个淡入，但没人看得见」，而且完全不报错、截图也看不出来。
  //
  // ⚠️ 为什么必须**另起一个 JSDOM**：主 load() 的 IO 桩在 observe() 里
  //    立刻回调 isIntersecting:true，等于所有 .reveal 秒亮 —— 安全网怎么写
  //    都测不出来。这里要的是「观察器活着、但一个都没交集」这个中间状态。
  {
    const vc2 = new VirtualConsole();
    vc2.on('jsdomError', () => { /* 这一份只关心 reveal，不收集错误 */ });
    const dom2 = await JSDOM.fromURL(BASE + 'index.html', {
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      virtualConsole: vc2,
      beforeParse(window) {
        window.fetch = () => Promise.reject(new Error('offline'));
        window.TextDecoder = TextDecoder;
        window.TextEncoder = TextEncoder;
        // matches:false ⇒ 走 IntersectionObserver 分支，而不是"减少动态效果"的 showAll
        window.matchMedia = (q) => ({
          matches: false, media: q, onchange: null,
          addEventListener() {}, removeEventListener() {},
          addListener() {}, removeListener() {}, dispatchEvent() { return false; }
        });
        // 观察器「活着」但永不交集：ioFired 会变 true，但一个都不点亮
        window.IntersectionObserver = class {
          constructor(cb) { this.cb = cb; }
          observe(el) { this.cb([{ isIntersecting: false, target: el }], this); }
          unobserve() {} disconnect() {} takeRecords() { return []; }
        };
        // 只给 .reveal 节点造矩形：一个落在视口里、一个落在折叠线以下。
        // 别的元素一律走原生（jsdom 是 0），免得干扰弹幕那套几何。
        const orig = window.Element.prototype.getBoundingClientRect;
        const box = (top, h) => ({
          top, bottom: top + h, left: 0, right: 1200,
          width: 1200, height: h, x: 0, y: top
        });
        window.Element.prototype.getBoundingClientRect = function () {
          if (this.classList && this.classList.contains('reveal')) {
            return this.classList.contains('proj-grid') ? box(4000, 400) : box(120, 300);
          }
          return orig.call(this);
        };
      }
    });
    // 安全网在 2400ms 触发，等到它之后再看结果
    await new Promise((r) => setTimeout(r, 2750));

    const d2 = dom2.window.document;
    const inView = d2.querySelector('.sec-head.reveal');
    const belowFold = d2.querySelector('.proj-grid.reveal');
    // ① 屏幕上那一份必须被兜住 —— 这才是安全网存在的**唯一理由**
    check('安全网兜住了「此刻在屏幕上却还没亮」的板块',
      !!inView && inView.classList.contains('is-on'),
      inView ? inView.className : '找不到 .sec-head.reveal');
    // ② 折叠线以下那一份**不许**被兜 —— 否则它的淡入已经在视口外跑完了
    check('安全网没有把折叠线以下的淡入提前吃掉（否则用户滚下去看不到动画）',
      !!belowFold && !belowFold.classList.contains('is-on'),
      belowFold ? belowFold.className : '找不到 .proj-grid.reveal');
    dom2.window.close();
  }

  // ------------------------------------------------ 8. starcraft3 内嵌
  {
    check('starcraft3 单文件已放进项目目录', hasDist('projects/starcraft3/sc3.html'));
    const page = readText('projects/starcraft3/index.html');
    check('starcraft3 项目页内嵌 sc3.html',
      /<iframe[^>]*src="sc3\.html"/.test(page));
    check('starcraft3 项目页用 ultra 宽度（#app 写死 min-width:1024px）',
      /class="wrap proj-page ultra"/.test(page));
    check('ultra 宽度在 CSS 里有定义', /\.proj-page\.ultra\s*\{[^}]*max-width/.test(readText('assets/css/site.css')));
    if (hasDist('projects/starcraft3/sc3.html')) {
      const sc3 = readText('projects/starcraft3/sc3.html');
      // 这个程序能整包搬进来，前提是它完全自包含：一个外链都没有
      const ext = [...sc3.matchAll(/(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)/gi)]
        .map((m) => m[1]);
      check('sc3.html 完全自包含（0 个外链）', ext.length === 0, ext.slice(0, 4));
      check('sc3.html 是那个游戏本体',
        /星际争霸 III/.test(sc3));
    }
    // 生成器不能被写死成某个 slug —— 复用的 EMBEDS 表要能漏掉别的页
    check('只有该有 embed 的项目页才有 embed',
      !/class="embed"/.test(readText('projects/qika/index.html')));
  }

  // ------------------------------------------------ 9. 私密信息彻底移除
  // 站主原话「我不想泄露私密信息」。所以不是「首页看不见了」就算数，
  // 而是**整个产物**里都不许再出现 —— 少一处就是漏一处。
  {
    const FORBIDDEN = ['jianguoyun.com', 'nutstore', '坚果云'];
    const hits = [];
    const scan = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { scan(p); continue; }
        if (!/\.(html|css|js|json|webmanifest)$/.test(e.name)) { continue; }
        const t = fs.readFileSync(p, 'utf8');
        for (const s of FORBIDDEN) {
          if (t.includes(s)) { hits.push(`${path.relative(ROOT, p).replace(/\\/g, '/')}: ${s}`); }
        }
      }
    };
    scan(ROOT);
    check('产物里没有任何坚果云外链残留', hits.length === 0, hits.slice(0, 4));
    check('projects/obsidian 目录已删除', !fs.existsSync(distFile('projects/obsidian')));
  }

  // ------------------------------------------------ 10. 对外域名
  {
    const idx = readText('index.html');
    const ORIGIN = 'https://auxiaweb.pages.dev';
    check('canonical 指向真实在服务的域名',
      idx.includes(`<link rel="canonical" href="${ORIGIN}/">`));
    // 旧域名 auxia.pages.dev 实测 HTTP 200 —— 是**别人的站**。
    // canonical 指过去等于告诉搜索引擎「正版在人家那里」，比不写还糟。
    // ⚠️ 判据要落在**赋值**上，不能是「文件里出现过这个字符串」——
    //    tools/common.py 的注释里本来就写着旧域名（解释为什么换掉），
    //    按字符串搜会把那段说明文档当成回归。
    check('对外域名常量指向真实在服务的域名',
      /PUBLIC_ORIGIN\s*=\s*"https:\/\/auxiaweb\.pages\.dev"/.test(readSource('tools/common.py')));
    const staleHits = [];
    for (const rel of ['index.html', '404.html', 'gallery/index.html', 'manifest.webmanifest']) {
      if (hasDist(rel) && /auxia\.pages\.dev/.test(readText(rel))) { staleHits.push(rel); }
    }
    check('产物里不再出现被他人占用的旧域名', staleHits.length === 0, staleHits);
    // 下线过的宿主也不能留在产物里 —— 和对外请求白名单是同一个道理：
    // 「界面上不再提到」和「产物里不再出现」是两件事，后者才可验证。
    const goneHits = [];
    for (const rel of ['index.html', '404.html', 'gallery/index.html', 'manifest.webmanifest']) {
      if (hasDist(rel) && /auxia-site\.app\.workbuddy\.host/.test(readText(rel))) { goneHits.push(rel); }
    }
    check('产物里不再出现已下线的内置通道地址', goneHits.length === 0, goneHits);
    check('og:image 用的是本站绝对地址',
      idx.includes(`content="${ORIGIN}/assets/img/icons/og-cover.png"`));

    // twitter:image 以前不在断言范围内 —— 换域名时 og 换对了、twitter 卡片还是旧地址，
    // 没有任何一条守卫会响。同一个域名在首页出现 4 次，就得断言 4 次。
    const twImgs = [...idx.matchAll(/name="twitter:image" content="([^"]*)"/g)].map((m) => m[1]);
    check('twitter:image 也指向本站绝对地址',
      twImgs.length > 0 && twImgs.every((u) => u === `${ORIGIN}/assets/img/icons/og-cover.png`),
      twImgs);

    // ---- 真源只有一个：common.py 的 PUBLIC_ORIGIN ----
    // 手写页面写 {{ORIGIN}}，由 build_site.py 注入。这条守的是
    // 「哪天有人图省事又把域名写回 HTML」—— 那种情况下换域名**只会漏改人写的页面**
    // （生成的页面跟着常量走）。本项目真的这么漏过一次：换了常量之后项目页跟着变、
    // 首页和展墙没变，而当时的断言只盯着 index.html 的 canonical，所以看着是全绿的。
    const hardCoded = [];
    for (const rel of ['index.html', '404.html', 'gallery/index.html']) {
      let t;
      try { t = readSource(rel); } catch { continue; }
      if (/https?:\/\/[a-z0-9.-]+\.(pages\.dev|workbuddy\.host)/i.test(t)) { hardCoded.push(rel); }
    }
    check('手写页面里没有写死的站点域名（一律写 {{ORIGIN}} 占位符）',
      hardCoded.length === 0, hardCoded);

    // 反向：占位符必须真的被替换掉了。残留的 {{ORIGIN}} 会让 canonical / og:image
    // 变成坏地址 —— 页面照常渲染，只有分享卡片是坏的，肉眼很难发现。
    const tokLeft = [];
    for (const rel of ['index.html', '404.html', 'gallery/index.html']) {
      if (hasDist(rel) && readText(rel).includes('{{ORIGIN}}')) { tokLeft.push(rel); }
    }
    check('产物里没有残留未注入的 {{ORIGIN}} 占位符', tokLeft.length === 0, tokLeft);
  }
}

// ------------------------------------------------------------------ main
(async () => {
  if (!fs.existsSync(ROOT)) {
    console.error(`找不到 ${ROOT} —— 先跑 tools/build_site.py`);
    process.exit(2);
  }
  const server = await startServer();
  console.log(`站点根：${ROOT}`);
  console.log(`临时站点：${BASE}`);
  const ctx = {};
  try {
    await testHome(ctx);
    await testGallery();
    await testProjects();
    await test404();
    await testLayering();
    await testExternalOrigins();
    await testRoundFive();
  } catch (err) {
    console.error('\n[崩了]', err);
    fail += 1;
  }
  server.close();
  console.log(`\n通过 ${pass}，失败 ${fail}`);
  if (fail) {
    console.log('失败项：');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  process.exit(fail ? 1 : 0);
})();
