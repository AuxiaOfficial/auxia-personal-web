/* ==========================================================================
   tiles.js —— 展品卡片的统一渲染 + 灯箱
   主页橱窗与 /gallery/ 共用，保证两处外观、交互完全一致。
   ========================================================================== */
(function () {
  'use strict';

  var A = (window.Auxia = window.Auxia || {});
  var esc = function (s) { return A.escapeHtml ? A.escapeHtml(s) : String(s == null ? '' : s); };

  /** 展品图的比例样式：竖版海报 2:3、方图 1:1、横图 16:9 */
  function ratioClass(item) {
    var w = item.posterW || item.w;
    var h = item.posterH || item.h;
    if (!w || !h) { return ''; }
    var r = w / h;
    if (r > 1.35) { return 'wide'; }
    if (r > 0.82) { return 'square'; }
    return '';
  }

  /** 题名卡：抓不到封面时的兜底，只留名字 + 一道分隔线。
      墙名（Anime / Games…）和「题名卡」字样都已在展区里露过面，属于解释性文字，不重复渲染。*/
  function titleCard(item) {
    return '' +
      '<div class="card-tile titlecard ' + ratioClass(item) + '">' +
        '<span class="tc-name">' + esc(item.title) + '</span>' +
        '<span class="tc-rule"></span>' +
      '</div>';
  }

  /** 橱窗用的「索引行」：小缩略图 + 标题。十件一屏看得完，不再挂来源小字。 */
  function rowCard(item, wall) {
    var hasPoster = !!item.poster;
    // 橱窗一共只有 10 张缩略图，直接 eager 加载，避免滚动时闪出空白
    var thumb = hasPoster
      ? '<span class="thumb"><img src="' + esc(item.poster) + '" alt="' + esc(item.title) + '" ' +
        'decoding="async"></span>'
      : '<span class="thumb is-card" aria-hidden="true">' + esc(String(item.title).trim().charAt(0)) + '</span>';

    var href = hasPoster && item.credit && item.credit.url ? item.credit.url : '';
    var inner = thumb +
      '<span class="meta"><b>' + esc(item.title) + '</b></span>';

    if (!href) {
      return '<a class="show-row" href="gallery/#' + esc(wall.id) + '">' + inner + '</a>';
    }
    return '<a class="show-row" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer nofollow">' +
      inner + '</a>';
  }

  /** 一张展品卡：摄影（真图）/ 海报 / 题名卡三种形态 */
  function card(item, wall, opts) {
    var o = opts || {};
    var isPhoto = wall.kind === 'image';
    var src = isPhoto ? (o.small ? item.thumb : item.thumb) : item.poster;
    var lazy = ' loading="lazy" decoding="async"';

    if (isPhoto) {
      return '' +
        '<a class="tile" href="' + esc(item.full || src) + '" data-lightbox="' + esc(item.full || src) + '" ' +
           'data-caption="' + esc(item.title) + ' · Auxia 自摄" aria-label="查看摄影作品 ' + esc(item.title) + '">' +
          '<img src="' + esc(src) + '" alt="' + esc(item.title) + '"' + lazy + ' width="' + (item.w || '') + '" height="' + (item.h || '') + '">' +
          '<span class="cap">' + esc(item.title) + '<small>摄影作品展示</small></span>' +
        '</a>';
    }

    if (!src) { return titleCard(item); }

    var credit = item.credit && item.credit.name ? item.credit.name : '';
    return '' +
      '<a class="card-tile ' + ratioClass(item) + '" href="' + esc(item.credit && item.credit.url ? item.credit.url : src) + '" ' +
         'target="_blank" rel="noopener noreferrer nofollow" aria-label="' + esc(item.title) + '">' +
        '<img src="' + esc(src) + '" alt="' + esc(item.title) + '"' + lazy + '>' +
        '<span class="name">' + esc(item.title) + (credit ? '<small>' + esc(credit) + '</small>' : '') + '</span>' +
      '</a>';
  }

  /* ---------------------------------------------------------------- 灯箱 */
  var box = null;
  function ensureLightbox() {
    if (box) { return box; }
    box = document.createElement('div');
    box.className = 'lightbox';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', '图片查看');
    box.innerHTML =
      '<button class="lb-close" type="button" aria-label="关闭">✕ 关闭</button>' +
      '<img alt="">' +
      '<div class="lb-cap"></div>';
    document.body.appendChild(box);

    box.addEventListener('click', function (e) {
      if (e.target === box || e.target.classList.contains('lb-close')) { close(); }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && box.classList.contains('is-open')) { close(); }
    });
    return box;
  }

  function open(src, caption) {
    var b = ensureLightbox();
    b.querySelector('img').src = src;
    b.querySelector('.lb-cap').textContent = caption || '';
    b.classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }
  function close() {
    if (!box) { return; }
    box.classList.remove('is-open');
    document.body.style.overflow = '';
  }

  function bindLightbox(scope) {
    var root = scope || document;
    root.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('[data-lightbox]') : null;
      if (!t) { return; }
      e.preventDefault();
      open(t.dataset.lightbox, t.dataset.caption);
    });
  }

  A.card = card;
  A.rowCard = rowCard;
  A.titleCard = titleCard;
  A.ratioClass = ratioClass;
  A.lightbox = { open: open, close: close, bind: bindLightbox };
})();
