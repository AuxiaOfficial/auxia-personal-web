/* ==========================================================================
   home.js —— 主页专属：大五人格五边形 + 展墙橱窗（随机 2 件 / 每墙）
   ========================================================================== */
(function () {
  'use strict';

  var A = (window.Auxia = window.Auxia || {});
  var esc = function (s) { return A.escapeHtml ? A.escapeHtml(s) : String(s == null ? '' : s); };
  var ROOT = document.body.dataset.root || './';

  function getJSON(url) {
    return fetch(url, { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ==================================================================
     大五人格五边形（纯 SVG，完全如实绘制，不加任何注解）
     ================================================================== */
  function renderPentagon(dims) {
    var host = document.getElementById('pentagon');
    if (!host || !dims || dims.length !== 5) { return; }

    var W = 380, H = 340, cx = 190, cy = 168, R = 100, LABEL_R = 130;
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('class', 'pentagon');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label',
      '大五人格雷达图：' + dims.map(function (d) { return d.name + ' ' + d.value + '%'; }).join('，'));

    function pt(i, radius) {
      var ang = -Math.PI / 2 + (i * 2 * Math.PI / 5);
      return [cx + Math.cos(ang) * radius, cy + Math.sin(ang) * radius];
    }
    function poly(radiusAt) {
      var out = [];
      for (var i = 0; i < 5; i++) {
        var p = pt(i, radiusAt(i));
        out.push(p[0].toFixed(1) + ',' + p[1].toFixed(1));
      }
      return out.join(' ');
    }
    function el(name, attrs) {
      var e = document.createElementNS(NS, name);
      Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
      return e;
    }

    // 网格环 + 轴线
    [0.25, 0.5, 0.75, 1].forEach(function (k) {
      svg.appendChild(el('polygon', { points: poly(function () { return R * k; }), 'class': 'grid-ring' }));
    });
    for (var i = 0; i < 5; i++) {
      var outer = pt(i, R);
      svg.appendChild(el('line', {
        x1: cx, y1: cy, x2: outer[0].toFixed(1), y2: outer[1].toFixed(1), 'class': 'axis'
      }));
    }

    // 数据多边形
    var shape = el('polygon', {
      points: poly(function (idx) { return R * (dims[idx].value / 100); }),
      'class': 'shape'
    });
    svg.appendChild(shape);

    // 顶点 + 标注
    dims.forEach(function (d, idx) {
      var dp = pt(idx, R * (d.value / 100));
      svg.appendChild(el('circle', {
        cx: dp[0].toFixed(1), cy: dp[1].toFixed(1), r: 4, 'class': 'pt-dot'
      }));

      var lp = pt(idx, LABEL_R);
      var ang = -Math.PI / 2 + (idx * 2 * Math.PI / 5);
      var cos = Math.cos(ang);
      var anchor = cos > 0.3 ? 'start' : (cos < -0.3 ? 'end' : 'middle');
      var dy = Math.sin(ang) < -0.5 ? -6 : (Math.sin(ang) > 0.5 ? 4 : 4);

      var name = el('text', {
        x: lp[0].toFixed(1), y: (lp[1] + dy).toFixed(1),
        'text-anchor': anchor, 'class': 'dim-name'
      });
      name.textContent = d.name;
      svg.appendChild(name);

      var val = el('text', {
        x: lp[0].toFixed(1), y: (lp[1] + dy + 16).toFixed(1),
        'text-anchor': anchor, 'class': 'dim-val'
      });
      val.textContent = d.value + '%';
      svg.appendChild(val);
    });

    host.innerHTML = '';
    host.appendChild(svg);

    // 从中心展开；尊重「减少动态效果」
    if (A.reduceMotion) {
      svg.classList.add('is-in');
      return;
    }
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) {
            svg.classList.add('is-in');
            io.disconnect();
          }
        });
      }, { threshold: 0.3 });
      io.observe(svg);
    } else {
      svg.classList.add('is-in');
    }
  }

  function renderLegend(dims) {
    var host = document.getElementById('b5-legend');
    if (!host) { return; }
    host.innerHTML = dims.map(function (d) {
      return '' +
        '<div class="b5-row">' +
          '<span>' + esc(d.name) + '</span>' +
          '<span class="val">' + d.value + '%</span>' +
          '<span class="track"><span class="fill" data-w="' + d.value + '" ' +
            'style="background:linear-gradient(90deg,var(--base),var(--accent))"></span></span>' +
        '</div>';
    }).join('');

    var fills = host.querySelectorAll('.fill');
    function go() {
      Array.prototype.forEach.call(fills, function (f) {
        f.style.width = f.dataset.w + '%';
      });
    }
    if (A.reduceMotion || !('IntersectionObserver' in window)) { go(); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { go(); io.disconnect(); }
      });
    }, { threshold: 0.2 });
    io.observe(host);
  }

  /* ==================================================================
     展墙橱窗
     ================================================================== */
  var galleryData = null;
  var PER_WALL = 2;

  function renderShowcase() {
    var host = document.getElementById('wall-showcase');
    if (!host || !galleryData || !galleryData.walls) { return; }

    host.innerHTML = galleryData.walls.map(function (wall) {
      var picked = shuffle(wall.items).slice(0, PER_WALL);

      // 摄影是真图，用大一点的图块；文字墙信息密度高，用索引行，十件一屏看得完
      var body;
      if (wall.kind === 'image') {
        body = '<div class="wall-pair">' +
          picked.map(function (item) { return A.card(item, wall); }).join('') + '</div>';
      } else {
        body = '<div class="show-rows">' +
          picked.map(function (item) { return A.rowCard(item, wall); }).join('') + '</div>';
      }

      return '' +
        '<div class="wall-row">' +
          '<div class="wall-row-head">' +
            '<h3>' + esc(wall.name) + '</h3>' +
            '<span class="count">' + esc(wall.en) + ' · ' + wall.count + ' 件</span>' +
            '<a href="' + esc(ROOT) + 'gallery/#' + esc(wall.id) + '">查看全部 →</a>' +
          '</div>' + body +
        '</div>';
    }).join('');
  }

  function initShowcase() {
    getJSON(ROOT + 'data/gallery.json').then(function (g) {
      if (!g) { return; }
      galleryData = g;
      renderShowcase();
      A.lightbox.bind(document);

      var btn = document.getElementById('shuffle');
      if (btn) {
        btn.addEventListener('click', renderShowcase);
      }
      var total = document.getElementById('showcase-total');
      if (total) { total.textContent = g.total + ' 件展品'; }
    });
  }

  A.onReady = function (site) {
    if (site && site.bigfive) {
      renderPentagon(site.bigfive.dims);
      renderLegend(site.bigfive.dims);
    }
    initShowcase();
  };
})();
