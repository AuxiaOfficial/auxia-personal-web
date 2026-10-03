/**
 * 弹幕「解析几何」不变式的真实浏览器检查 —— **函数体，必须自己 return**
 *
 * 用法（配合 tools/browser-probe.cjs）：
 *   node tools/browser-probe.cjs \
 *     --url=http://127.0.0.1:8791/ --wait=9000 \
 *     --eval-file=tools/dm-invariant.js
 *
 * 它回答的是自检（jsdom）回答不了的问题：
 *   jsdom 没有布局引擎，getBoundingClientRect 恒为 0，所以 core.js 里那条
 *   `rect.width || estimateWidth(text)` 的兜底估算**永远**会被走到，
 *   真正的宽度测量路径在自检里一次都没跑过。这里用真实布局引擎量它。
 *
 * 三项断言：
 *   1) formulaErr —— 与时钟无关。把元素**自己的动画进度**代回
 *      x(p) = vw - p·(w + 2·vw)，和真实 getBoundingClientRect().left 比。
 *      不等于 0 就是公式或宽度测量写错了。
 *      注意必须用**迭代进度**（currentIteration + progress）：
 *      currentTime/duration 会累加，第二圈就 >1，拿它代公式必然算歪。
 *   2) maxDy / maxDw / maxDh —— 泳道纵向定位与宽高测量的误差。
 *   3) orphanCount —— 不变式：**画在屏幕上的每条弹幕都必须能被命中**。
 *      判定用 danmakuAt(元素真实中心) === null。只看 null，
 *      因为元素重叠时 hitBox 会按"中心最近"选中另一条，那不算违规。
 *
 * perfDelta vs timelineDelta 用来判断时钟是否同源同速：
 * CSS 动画跑在 document.timeline 上，performance.now() 应当和它同步。
 * 如果这两个数差很远，那 endErr 就不是代码问题而是时钟问题。
 */
return (async function () {
  var A = window.Auxia;
  if (!A || !A.danmakuBoxes) {
    return {
      ready: false,
      why: 'Auxia.danmakuBoxes 不存在：可能开了 prefers-reduced-motion，或弹幕没启用',
      reduceMotion: !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches),
    };
  }

  var vw = window.innerWidth;
  var i;

  // ---- 时钟同步性：让真实时间真的流过去，再比两个时钟推进了多少 ----
  var hasTL = !!(document.timeline && document.timeline.currentTime != null);
  var p0 = performance.now();
  var t0 = hasTL ? document.timeline.currentTime : null;
  await new Promise(function (r) { setTimeout(r, 900); });
  var p1 = performance.now();
  var t1 = hasTL ? document.timeline.currentTime : null;

  var boxes = A.danmakuBoxes();
  var dom = Array.prototype.slice.call(document.querySelectorAll('#danmaku .dm-item'));
  var hitSet = boxes.map(function (b) { return b.el; });

  var out = {
    ready: true,
    vw: vw,
    innerW: window.innerWidth,
    docClientW: document.documentElement.clientWidth,
    boxes: boxes.length,
    dom: dom.length,
    // live 数组和 DOM 必须严丝合缝（同一个同步块里取的两份快照）
    inLiveNotDom: hitSet.filter(function (e) { return dom.indexOf(e) < 0; }).length,
    inDomNotLive: dom.filter(function (e) { return hitSet.indexOf(e) < 0; }).length,
    perfDelta: Math.round(p1 - p0),
    timelineDelta: hasTL ? Math.round(t1 - t0) : null,
  };

  var formulaErr = 0, endErr = 0, maxDy = 0, maxDw = 0, maxDh = 0, n = 0;
  var pWallMin = 9, pWallMax = -9, pAnimMin = 9, pAnimMax = -9;
  var samples = [];

  for (i = 0; i < boxes.length; i++) {
    var b = boxes[i];
    var el = b.el;
    var r = el.getBoundingClientRect();
    var an = el.getAnimations ? el.getAnimations() : [];
    if (!an.length) { continue; }
    var ct = an[0].getComputedTiming ? an[0].getComputedTiming() : null;
    var totP = ct ? ((ct.currentIteration || 0) + (ct.progress || 0)) : null;
    if (totP == null) { continue; }
    var frac = totP - Math.floor(totP);

    var fErr = Math.abs((vw - frac * (r.width + 2 * vw)) - r.left);
    var eErr = Math.abs(b.x - r.left);
    if (fErr > formulaErr) { formulaErr = fErr; }
    if (eErr > endErr) { endErr = eErr; }
    maxDy = Math.max(maxDy, Math.abs(b.y - r.top));
    maxDw = Math.max(maxDw, Math.abs(b.w - r.width));
    maxDh = Math.max(maxDh, Math.abs(b.h - r.height));
    if (b.p != null) {
      pWallMin = Math.min(pWallMin, b.p);
      pWallMax = Math.max(pWallMax, b.p);
    }
    pAnimMin = Math.min(pAnimMin, totP);
    pAnimMax = Math.max(pAnimMax, totP);
    n++;

    if (samples.length < 3) {
      samples.push({
        t: el.textContent.slice(0, 5),
        pw: b.p == null ? null : +b.p.toFixed(4),
        pa: +totP.toFixed(4),
        xf: +(vw - frac * (r.width + 2 * vw)).toFixed(2),
        left: +r.left.toFixed(2),
        ax: +b.x.toFixed(2),
        ay: +b.y.toFixed(2),
        top: +r.top.toFixed(2),
        aw: +b.w.toFixed(2),
        rw: +r.width.toFixed(2),
      });
    }
  }

  out.count = n;
  out.formulaErr = +formulaErr.toFixed(3);
  out.endErr = +endErr.toFixed(3);
  out.maxDy = +maxDy.toFixed(3);
  out.maxDw = +maxDw.toFixed(3);
  out.maxDh = +maxDh.toFixed(3);
  out.wallRange = [+pWallMin.toFixed(3), +pWallMax.toFixed(3)];
  out.animRange = [+pAnimMin.toFixed(3), +pAnimMax.toFixed(3)];
  out.samples = samples;

  // ---- 不变式：看得见 => 命得中 ----
  var orphan = [], tie = 0;
  for (i = 0; i < dom.length; i++) {
    var e2 = dom[i];
    var r2 = e2.getBoundingClientRect();
    if (!(r2.right > 0 && r2.left < vw && r2.width > 1)) { continue; }
    var at = A.danmakuAt(r2.left + r2.width / 2, r2.top + r2.height / 2);
    if (at === null) {
      orphan.push({
        t: e2.textContent.slice(0, 6),
        left: +r2.left.toFixed(1),
        w: +r2.width.toFixed(1),
      });
    } else if (at !== e2) {
      tie++;   // 与别的弹幕重叠，被按"中心最近"规则选走了，不算违规
    }
  }
  out.orphanCount = orphan.length;
  out.orphans = orphan.slice(0, 5);
  out.overlapTies = tie;

  return out;
})();
