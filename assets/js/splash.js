/* ==========================================================================
   splash.js —— 开屏页的两件事：打字机标题 + 布朗运动小演示
   只有首页引这个文件，项目页 / 展墙页不加载它。
   ========================================================================== */
(function () {
  'use strict';

  var Auxia = (window.Auxia = window.Auxia || {});
  var reduce = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false };

  /* ==================================================================
     1. 打字机
     ================================================================== */
  function initTypewriter() {
    var h1 = document.getElementById('splash-title');
    if (!h1) { return; }

    var rows = h1.querySelectorAll('.st-row');
    if (!rows.length) { return; }

    // 文案来自 data-lines（用 | 分行）。HTML 里本来就写着完整文案
    //（给爬虫、无 JS、屏幕阅读器看），这里把它读出来再把 DOM 清空。
    // 清空之后每行仍有 min-height:1.16em 撑着，所以不会跳版。
    var lines = (h1.getAttribute('data-lines') || '').split('|');
    if (lines.length !== rows.length || !lines[0]) { return; }

    var texts = [];
    var i;
    for (i = 0; i < rows.length; i++) {
      var el = rows[i].querySelector('.st-text');
      if (!el) { return; }
      el.textContent = '';
      texts.push(el);
    }

    // 光标做成**行内元素**挂在每行末尾，跟着最后一个字走。
    // 绝对定位的话得自己量每行文字的宽度，换个字体就得重算。
    var carets = [];
    for (i = 0; i < rows.length; i++) {
      var c = document.createElement('span');
      c.className = 'st-caret';
      c.setAttribute('aria-hidden', 'true');
      rows[i].appendChild(c);
      carets.push(c);
    }

    function fillAll() {
      for (var k = 0; k < texts.length; k++) { texts[k].textContent = lines[k]; }
    }

    if (reduce.matches) { fillAll(); return; }

    var SPEED = 62;         // 每字毫秒
    var LINE_PAUSE = 340;   // 行间停顿
    var START_DELAY = 260;  // 先让页面画出来再开始敲

    function type() {
      var li = 0;
      var ci = 0;
      carets[0].classList.add('is-on');

      function step() {
        var line = lines[li];
        if (ci < line.length) {
          ci += 1;
          texts[li].textContent = line.slice(0, ci);
          window.setTimeout(step, SPEED);
          return;
        }
        li += 1;
        ci = 0;
        if (li >= lines.length) { return; }   // 打完收工，光标停在最后一行继续闪
        carets[li - 1].classList.remove('is-on');
        carets[li].classList.add('is-on');
        window.setTimeout(step, LINE_PAUSE);
      }

      step();
    }

    /* 字体没就位就开始敲，字形会中途换一次 —— 已经敲出来的字会「跳」一下。
       所以先等 LOGO 字体加载完。但**必须留一个超时兜底**：
       等字体这件事本身不能变成开屏的阻塞点（字体加载失败、被墙、
       离线打开……都得照常敲下去）。 */
    var started = false;
    function start() {
      if (started) { return; }
      started = true;
      type();
    }
    function schedule() { window.setTimeout(start, START_DELAY); }

    if (document.fonts && document.fonts.load) {
      document.fonts.load('1em "ZhanKuXiaoWei-auxia"').then(schedule, schedule);
      window.setTimeout(start, 1400);
    } else {
      schedule();
    }
  }

  /* ==================================================================
     2. 布朗运动 + 指针施力
     ================================================================== */
  function initBrownian() {
    var cv = document.getElementById('brownian');
    if (!cv || !cv.getContext) { return; }
    var ctx = cv.getContext('2d');
    // jsdom（自检环境）没有 canvas 实现，getContext 返回 null。
    // 没有 2D 上下文就安静退出，不要往控制台扔异常。
    if (!ctx) { return; }

    var T = {
      jitter: 0.46,   // 布朗项的强度：每帧给速度叠一个随机增量
      damp: 0.972,    // 速度阻尼。太小会糊成一团，太大会一直乱窜
      force: 1.15,    // 指针力的强度
      radius: 138,    // 指针力场半径
      link: 74        // 近邻连线阈值
    };

    var W = 0, H = 0, dpr = 1, N = 0;
    var ps = [];
    var pointer = { x: -1e5, y: -1e5, on: false };
    var colors = { particle: '#e8845c', accent: '#e8845c' };

    function readColors() {
      var cs = window.getComputedStyle
        ? window.getComputedStyle(document.documentElement) : null;
      if (!cs) { return; }
      var b = (cs.getPropertyValue('--base') || '').trim();
      var a = (cs.getPropertyValue('--accent') || '').trim();
      if (b) { colors.particle = b; }
      if (a) { colors.accent = a; }
    }

    function seed() {
      ps = [];
      for (var i = 0; i < N; i++) {
        ps.push({
          x: Math.random() * W, y: Math.random() * H,
          vx: (Math.random() - .5) * 1.6, vy: (Math.random() - .5) * 1.6,
          r: 1.7 + Math.random() * 2.3
        });
      }
    }

    /** 量画布的 CSS 盒子。拿不到尺寸（jsdom）就返回 false，调用方直接放弃。 */
    function resize() {
      var r = cv.getBoundingClientRect();
      var w = Math.round(r.width) || cv.clientWidth || 0;
      var h = Math.round(r.height) || cv.clientHeight || 0;
      if (!w || !h) { return false; }

      var oldW = W, oldH = H;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = w; H = h;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // 粒子数随面积走，但留上下限：太小看着空，太大就是一团糊
      N = Math.max(30, Math.min(72, Math.round(w * h / 5200)));

      if (!ps.length || !oldW || !oldH) {
        seed();
      } else {
        // 只按比例挪位置，**不重新随机** —— 否则每次 resize 粒子都会瞬移，
        // 手机上地址栏一收一放就会看到整片跳一次。
        var sx = w / oldW, sy = h / oldH;
        for (var i = 0; i < ps.length; i++) {
          ps[i].x *= sx; ps[i].y *= sy;
        }
      }
      readColors();
      return true;
    }

    /** 指针力场在画布坐标 (x,y) 处的强度：0 = 不在场内。
        线性衰减（**不是**平方反比）—— 反比在近距离会爆掉，
        粒子会被瞬间弹飞出画面，看起来像 bug 而不是「力」。
        抽成函数是为了让探针能直接问「这一点有没有力、多强」，
        而不是靠在截图上数像素；step 和探针共用同一份公式，不会各写一遍。 */
    function forceAt(x, y) {
      if (!pointer.on) { return 0; }
      var R = T.radius;
      var dx = x - pointer.x, dy = y - pointer.y;
      var d2 = dx * dx + dy * dy;
      if (d2 >= R * R || d2 <= 1) { return 0; }
      return T.force * (1 - Math.sqrt(d2) / R) / Math.sqrt(d2) * 14;
    }

    function step() {
      for (var i = 0; i < ps.length; i++) {
        var p = ps[i];

        // 布朗项：叠在**速度**上，不是叠在位移上。
        // 叠位移只会得到一个抖动的规则游走；叠速度才有无处不可微的样子。
        p.vx += (Math.random() - .5) * T.jitter;
        p.vy += (Math.random() - .5) * T.jitter;

        var k = forceAt(p.x, p.y);
        if (k) {
          p.vx += (p.x - pointer.x) * k;
          p.vy += (p.y - pointer.y) * k;
        }

        p.vx *= T.damp;
        p.vy *= T.damp;
        p.x += p.vx;
        p.y += p.vy;

        // 边界反弹，带能量损失
        if (p.x < 0) { p.x = 0; p.vx = Math.abs(p.vx) * .82; }
        else if (p.x > W) { p.x = W; p.vx = -Math.abs(p.vx) * .82; }
        if (p.y < 0) { p.y = 0; p.vy = Math.abs(p.vy) * .82; }
        else if (p.y > H) { p.y = H; p.vy = -Math.abs(p.vy) * .82; }
      }
    }

    function draw() {
      ctx.clearRect(0, 0, W, H);

      // 近邻连线：点之间连起来才像「分子」，否则只是一层灰。
      // 先比 dx/dy 再开根号，能把绝大多数配对整个跳过。
      var L = T.link;
      ctx.lineWidth = 1;
      ctx.strokeStyle = colors.accent;
      for (var i = 0; i < ps.length; i++) {
        var a = ps[i];
        for (var j = i + 1; j < ps.length; j++) {
          var b = ps[j];
          var dx = a.x - b.x;
          if (dx > L || dx < -L) { continue; }
          var dy = a.y - b.y;
          if (dy > L || dy < -L) { continue; }
          var d = Math.sqrt(dx * dx + dy * dy);
          if (d > L) { continue; }
          ctx.globalAlpha = (1 - d / L) * 0.30;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      // 指针的力场：画个虚圈，让「这里有只手指在施力」看得见
      if (pointer.on) {
        ctx.globalAlpha = 0.34;
        ctx.strokeStyle = colors.accent;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(pointer.x, pointer.y, T.radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.arc(pointer.x, pointer.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = colors.accent;
        ctx.fill();
      }

      ctx.globalAlpha = 1;
      ctx.fillStyle = colors.particle;
      for (var k = 0; k < ps.length; k++) {
        ctx.beginPath();
        ctx.arc(ps[k].x, ps[k].y, ps[k].r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    if (!resize()) { return; }

    // 指针进 / 出画布
    function move(e) {
      var r = cv.getBoundingClientRect();
      pointer.x = e.clientX - r.left;
      pointer.y = e.clientY - r.top;
      pointer.on = true;
    }
    function release() { pointer.on = false; }

    cv.addEventListener('pointermove', move, { passive: true });
    cv.addEventListener('pointerdown', move, { passive: true });
    cv.addEventListener('pointerenter', move, { passive: true });
    cv.addEventListener('pointerleave', release);
    cv.addEventListener('pointercancel', release);

    /* ---------- 只读探针（和 core.js 的 danmakuInfo 一个路子）----------
       为什么要有：headless 里没有真实指针，截图上的粒子看起来永远"在动"，
       所以「指针力到底有没有生效」光看图判断不了。这两个口子把
       ① 当前状态 ② 力场公式本身 都摊开，让真实浏览器探针能直接问。 */
    Auxia.brownianInfo = function () {
      return {
        w: W, h: H, n: ps.length, dpr: dpr,
        px: pointer.on ? +pointer.x.toFixed(1) : null,
        py: pointer.on ? +pointer.y.toFixed(1) : null,
        on: pointer.on,
        radius: T.radius, link: T.link, force: T.force
      };
    };
    Auxia.brownianForce = forceAt;

    // 尺寸变化：只按比例挪，不重新播种（见 resize 里的说明）
    if (window.ResizeObserver) {
      new ResizeObserver(function () { if (resize()) { draw(); } }).observe(cv);
    } else {
      window.addEventListener('resize', function () { if (resize()) { draw(); } });
    }

    // 背景系统会在运行时把 --accent 换成当页插画的主色，
    // 颜色读早了会拿到兜底值，所以页面就绪后重读一次。
    document.addEventListener('auxia:ready', readColors);

    if (reduce.matches) {
      draw();      // 减少动态效果：只画一帧静帧，不跑循环
      return;
    }
    Auxia.onFrame(function () { step(); draw(); });
  }

  function boot() {
    initTypewriter();
    initBrownian();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
