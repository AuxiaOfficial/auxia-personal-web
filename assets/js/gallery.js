/* ==========================================================================
   gallery.js —— /gallery/ 展墙总页
   ========================================================================== */
(function () {
  'use strict';

  var A = (window.Auxia = window.Auxia || {});
  var ROOT = document.body.dataset.root || '../';

  function esc(s) { return A.escapeHtml ? A.escapeHtml(s) : String(s == null ? '' : s); }

  function render(g) {
    var host = document.getElementById('walls');
    if (!host || !g || !g.walls) { return; }

    host.innerHTML = g.walls.map(function (wall) {
      var body;
      if (wall.kind === 'image') {
        body = '<div class="photo-grid">' + wall.items.map(function (item) {
          return '' +
            '<figure>' +
              '<a href="' + esc(item.full || item.thumb) + '" data-lightbox="' + esc(item.full || item.thumb) + '" ' +
                 'data-caption="' + esc(item.title) + ' · Auxia 自摄" aria-label="查看 ' + esc(item.title) + '">' +
                '<img src="' + esc(item.thumb) + '" alt="' + esc(item.title) + '" loading="lazy" decoding="async" ' +
                     'width="' + (item.w || '') + '" height="' + (item.h || '') + '">' +
              '</a>' +
              '<figcaption>' + esc(item.title) + '</figcaption>' +
            '</figure>';
        }).join('') + '</div>';
      } else {
        body = '<div class="grid-cards">' + wall.items.map(function (item) {
          return A.card(item, wall);
        }).join('') + '</div>';
      }

      // 区块头只放「墙名 + 英文名 + 件数」。没有可解释的东西，就不写解释。
      return '' +
        '<section class="wall-block" id="' + esc(wall.id) + '">' +
          '<div class="wall-block-head">' +
            '<h2>' + esc(wall.name) + '</h2>' +
            '<span class="meta">' + esc(wall.en) + ' · ' + wall.count + ' 件</span>' +
          '</div>' + body +
        '</section>';
    }).join('');

    var total = document.getElementById('gallery-total');
    if (total) { total.textContent = g.total; }

    A.lightbox.bind(document);

    // 从主页 #anime 这类锚点跳进来时，稍等布局稳定再滚
    if (location.hash) {
      var target = document.querySelector(location.hash);
      if (target) {
        requestAnimationFrame(function () { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
      }
    }
  }

  A.onReady = function () {
    fetch(ROOT + 'data/gallery.json', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(render)
      .catch(function () { /* 数据取不到时不渲染，页面仍可用 */ });
  };
})();
