# -*- coding: utf-8 -*-
"""本地预览：把 dist/ 起成一个小型静态服务器

纯静态站点，没有任何后端接口；不再有 /api/* 这种东西。

用法： python tools/preview.py [端口]
"""
from __future__ import annotations

import base64
import functools
import http.server
import socket
import socketserver
import sys
import time
import urllib.parse
from pathlib import Path

from common import SITE

DIST = SITE / "dist"

EXTRA = {
    ".webmanifest": "application/manifest+json",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
    ".ico": "image/x-icon",
    ".avif": "image/avif",
}

# 一个"慢资源"：睡 N 毫秒再吐 1x1 的 gif。
#
# 存在的理由：`msedge --headless --dump-dom` 是**等 load 事件**才 dump 的，
# 而 load 会等所有 <img>。把一个指向这里的 <img> 塞进页面，就能把 load
# 拖住任意长度 —— 于是我们在**不启用 --virtual-time-budget** 的前提下
# 也能让真实时间真的流过去（虚拟时间会把动画时钟快进、和 performance.now()
# 脱节，量出来的位置差十万八千里，见 README 的说明）。
# 这是"一次性进程"路线的替代方案：本环境不允许留常驻浏览器进程，
# 所以没法用 CDP 的 remote-debugging-port。
SLOW_GIF = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")

# 无缝截图用的探针页。**故意做成虚拟路由**（不落盘）：
# 之前是往 dist/ 里塞一个 _probe.html，结果每次构建产物里都留一个多余文件。
# 现在由预览服务器直接吐出来，dist/ 永远是干净的部署产物。
#
#   /__probe.html?p=/gallery/&y=2400      把某页塞进 iframe 并滚到 y
#
# 为什么需要它：headless 截图时 `scroll-behavior: smooth` 和锚点跳转都不会
# 真正落位，页面动画也会停在中间态。探针在 iframe 内部强制关掉平滑滚动再滚，
# 就能拍到稳定的一屏。配合 --force-prefers-reduced-motion 效果最好。
PROBE = """<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#fff;overflow:hidden}
iframe{width:%(w)dpx;height:%(h)dpx;border:0;display:block}
</style></head><body>
<iframe id="f" src="%(p)s"></iframe>
<script>
var f=document.getElementById('f'),y=%(y)d;
f.addEventListener('load',function(){setTimeout(function(){try{
  var d=f.contentDocument;
  d.documentElement.style.scrollBehavior='auto';
  d.body.style.scrollBehavior='auto';
  f.contentWindow.scrollTo(0,y);
}catch(e){}},2200);});
</script></body></html>"""

# &diag=1 时，探针会把 iframe 内每张图的真实加载/布局状态写回顶层文档，
# 方便用 `msedge --headless --dump-dom` 直接读到数据（无浏览器自动化依赖）。
DIAG = """
<script>
function __runDiag(){
  try{
    var d=document.getElementById('f').contentDocument, w=document.getElementById('f').contentWindow;
    var out=[];
    d.querySelectorAll('img').forEach(function(im){
      var r=im.getBoundingClientRect();
      var box=im.parentElement? im.parentElement.getBoundingClientRect():null;
      out.push({
        src:im.getAttribute('src'),
        complete:im.complete, nw:im.naturalWidth,
        img:[Math.round(r.width),Math.round(r.height)],
        box:box?[Math.round(box.width),Math.round(box.height)]:null,
        cls:im.parentElement?im.parentElement.className:null
      });
    });
    document.body.textContent='DIAGSTART'+JSON.stringify(out)+'DIAGEND';
  }catch(e){ document.body.textContent='DIAGSTART ERR '+e.message+'DIAGEND'; }
}
setTimeout(__runDiag, __DELAY__);
</script>
"""

# &dm=1 时校验弹幕的「解析几何命中检测」在真实浏览器里是否成立。
#
# 为什么要分开量两件事：
#   1) 公式对不对 —— 与时钟无关。把元素**自己的动画进度** p（currentTime/duration）
#      代进 x(p) = vw - p·(w + 2·vw)，和真实 getBoundingClientRect().left 比。
#      这一项不等于 0 就是公式写错了，和时间快慢无关。
#   2) 时钟对不对 —— 端到端。把 core.js 用 performance.now() 推出来的 x
#      和真实 left 比。headless 的虚拟时间下这一项可能有偏差（合成器时钟和
#      performance.now 不一定同步），偏差本身不等于生产代码有 bug。
# 只有 (1) 为 0 且 (2) 也很小，才能放心删掉 jsdom 的宽度兜底估算。
DM_DIAG = """
<script>
function __dmDiag(){
  var f=document.getElementById('f');
  var w=f.contentWindow, d=f.contentDocument;
  function done(o){
    var s;
    try{ s=JSON.stringify(o); }catch(e){ s='"ERR '+e.message+'"'; }
    document.body.textContent='DMSTART'+s+'DMEND';
  }
  try{
    if(!w.Auxia||!w.Auxia.danmakuBoxes){ return done({ready:false,why:'no Auxia.danmakuBoxes'}); }
    var vw=w.innerWidth, i;
    // 两个时钟跑多快？CSS 动画跑在 document.timeline 上，
    // performance.now() 应当和它同源同速；不同速就说明是测量环境的锅。
    var ckP0=w.performance.now();
    var ckT0=w.document.timeline?w.document.timeline.currentTime:null;
    // 一个同步块里连取两次快照：中间不可能插进 setInterval / animationend
    // （事件和定时器都是任务，跑不到同步代码中间），所以两者必须严格一致，
    // 不一致就说明 live 数组和 DOM 真的脱节了 —— 那本身就是个 bug。
    var boxes=w.Auxia.danmakuBoxes();
    var dom=Array.prototype.slice.call(d.querySelectorAll('#danmaku .dm-item'));
    var hitSet=boxes.map(function(b){ return b.el; });
    var domSet=dom;
    var inLiveNotDom=hitSet.filter(function(e){ return domSet.indexOf(e)<0; }).length;
    var inDomNotLive=domSet.filter(function(e){ return hitSet.indexOf(e)<0; }).length;
    var noAnim=0, j;
    for(j=0;j<boxes.length;j++){
      if(!boxes[j].el.getAnimations||!boxes[j].el.getAnimations().length){ noAnim++; }
    }

    var formulaErr=0, clockErr=0, endErr=0, maxDy=0, maxDw=0, maxDh=0, n=0;
    var samples=[], pWallMin=9, pWallMax=-9, pAnimMin=9, pAnimMax=-9;

    // 本轮新增的三项硬要求：慢 / 随机 / 不重合。
    // 在**真实宽度**下量才作数 —— jsdom 里 rect.width 恒为 0，
    // 走的是估算兜底，泳道占用判断拿到的也是估出来的宽度。
    var overlaps = (w.Auxia.danmakuOverlaps ? w.Auxia.danmakuOverlaps() : null);
    var info = (w.Auxia.danmakuInfo ? w.Auxia.danmakuInfo() : null);
    for(i=0;i<boxes.length;i++){
      var b=boxes[i], el=b.el, r=el.getBoundingClientRect();
      var an=el.getAnimations?el.getAnimations():[];
      if(!an.length){ continue; }
      var ct=an[0].getComputedTiming?an[0].getComputedTiming():null;
      var dur=ct?ct.duration:an[0].effect.getComputedTiming().duration;
      var iterP=ct?ct.progress:(an[0].currentTime/dur);
      var totP=(ct&&ct.currentIteration!=null?ct.currentIteration:0)+(iterP||0);
      var fracP=totP-Math.floor(totP);
      // (1) 与时钟无关：把元素自己的动画进度代回公式
      var fErr=Math.abs((vw-fracP*(r.width+2*vw))-r.left);
      // (2) 时钟是否同步（headless 虚拟时间下故意量出来）
      var cErr=Math.abs((b.p==null?NaN:b.p)-totP);
      // (3) 端到端
      var eErr=Math.abs(b.x-r.left);
      if(fErr>formulaErr){formulaErr=fErr;}
      if(cErr>clockErr){clockErr=cErr;}
      if(eErr>endErr){endErr=eErr;}
      maxDy=Math.max(maxDy,Math.abs(b.y-r.top));
      maxDw=Math.max(maxDw,Math.abs(b.w-r.width));
      maxDh=Math.max(maxDh,Math.abs(b.h-r.height));
      pWallMin=Math.min(pWallMin,b.p==null?9:b.p); pWallMax=Math.max(pWallMax,b.p==null?-9:b.p);
      pAnimMin=Math.min(pAnimMin,totP); pAnimMax=Math.max(pAnimMax,totP);
      n++;
      if(samples.length<3){
        samples.push({t:el.textContent.slice(0,5),pw:b.p==null?null:+b.p.toFixed(4),
                      pa:+totP.toFixed(4),pfrac:+fracP.toFixed(4),
                      xf:+(vw-fracP*(r.width+2*vw)).toFixed(2),left:+r.left.toFixed(2),
                      ax:+b.x.toFixed(2),ay:+b.y.toFixed(2),top:+r.top.toFixed(2),
                      aw:+b.w.toFixed(2),rw:+r.width.toFixed(2)});
      }
    }

    // (4) 不变式：**画在屏幕上的** 每条弹幕，都必须能被 danmakuAt 找到。
    // 这是「悬停高亮有时不灵」的根因探针：只要某个元素能被看见却不在
    // boxes() 里，它就永远高亮不了。
    var orphan=[];
    for(i=0;i<dom.length;i++){
      var e2=dom[i], r2=e2.getBoundingClientRect();
      var onScreen=(r2.right>0&&r2.left<vw&&r2.width>1);
      if(!onScreen){ continue; }
      if(hitSet.indexOf(e2)<0){
        var a2=e2.getAnimations?e2.getAnimations():[];
        var c2=a2.length&&a2[0].getComputedTiming?a2[0].getComputedTiming():null;
        var tp2=c2?((c2.currentIteration||0)+(c2.progress||0)):null;
        orphan.push({t:e2.textContent.slice(0,5),left:+r2.left.toFixed(1),
                     w:+r2.width.toFixed(1),animP:tp2==null?null:+tp2.toFixed(3)});
      }
    }

    // (5) 悬停链路：真发 PointerEvent
    var pick=null;
    for(i=0;i<boxes.length;i++){
      var rr=boxes[i].el.getBoundingClientRect();
      if(rr.left>=0&&rr.right<=vw&&rr.width>2){ pick=boxes[i]; break; }
    }
    var hover={picked:!!pick};
    function finish(){
      var ckP1=w.performance.now();
      var ckT1=w.document.timeline?w.document.timeline.currentTime:null;
      done({ready:true,count:n,boxes:boxes.length,total:dom.length,
            inLiveNotDom:inLiveNotDom,inDomNotLive:inDomNotLive,noAnim:noAnim,
            perfDelta:Math.round(ckP1-ckP0),
            timelineDelta:ckT0==null?null:Math.round(ckT1-ckT0),
            vw:vw,innerW:w.innerWidth,
            formulaErr:+formulaErr.toFixed(3),clockErr:+clockErr.toFixed(3),
            endErr:+endErr.toFixed(3),
            maxDy:+maxDy.toFixed(3),maxDw:+maxDw.toFixed(3),maxDh:+maxDh.toFixed(3),
            wallRange:[+pWallMin.toFixed(3),+pWallMax.toFixed(3)],
            animRange:[+pAnimMin.toFixed(3),+pAnimMax.toFixed(3)],
            orphanCount:orphan.length,orphans:orphan.slice(0,4),
            overlapCount:overlaps===null?null:overlaps.length,
            overlaps:overlaps===null?null:overlaps.slice(0,4),
            info:info,
            hover:hover,samples:samples});
    }
    if(!pick){ return finish(); }
    var cx=pick.x+pick.w/2, cy=pick.y+pick.h/2;
    hover.cx=+cx.toFixed(1); hover.cy=+cy.toFixed(1);
    d.dispatchEvent(new w.PointerEvent('pointermove',
      {clientX:cx, clientY:cy, pointerType:'mouse', bubbles:true}));
    setTimeout(function(){
      try{
        hover.at=w.Auxia.danmakuAt(cx,cy)===pick.el;
        hover.hot=pick.el.classList.contains('is-hot');
        hover.play=pick.el.style.animationPlayState;
        var ch=d.getElementById('cursor');
        hover.cursorHot=!!(ch&&ch.classList.contains('is-hover'));
      }catch(e){ hover.err=e.message; }
      try{
        d.dispatchEvent(new w.PointerEvent('pointermove',
          {clientX:5, clientY:2, pointerType:'mouse', bubbles:true}));
      }catch(e){}
      setTimeout(function(){
        try{
          hover.miss=w.Auxia.danmakuAt(5,2)===null;
          hover.released=!pick.el.classList.contains('is-hot');
          hover.resumed=pick.el.style.animationPlayState||'';
        }catch(e){ hover.err2=e.message; }
        finish();
      },140);
    },140);
  }catch(e){ done({ready:false,why:e.message}); }
}
setTimeout(__dmDiag, __DELAY__);
</script>
"""

# &sec=1 时把 iframe 里每个顶层板块的偏移量吐出来。
# 用途：截图要按 y 滚到"自我介绍""展墙橱窗"这些位置，硬编码的 y 一改布局就废了；
# 先从页面自己量一遍偏移，截图才可复现。
SEC_DIAG = """
<script>
function __secDiag(){
  var f=document.getElementById('f');
  function done(o){
    var s; try{ s=JSON.stringify(o); }catch(e){ s='"ERR '+e.message+'"'; }
    document.body.textContent='SECSTART'+s+'SECEND';
  }
  try{
    var d=f.contentDocument, w=f.contentWindow;
    var out=[], els=d.querySelectorAll('main > section, main > .proj-page, main > .nf, body > .nf');
    for(var i=0;i<els.length;i++){
      var el=els[i], r=el.getBoundingClientRect(), cs=w.getComputedStyle(el);
      if(cs.display==='none'){ continue; }
      out.push({id:el.id||null, cls:el.className||null,
                top:Math.round(r.top+w.scrollY), h:Math.round(r.height)});
    }
    done({ready:true, path:w.location.pathname,
          scrollH:Math.round(d.documentElement.scrollHeight),
          viewH:Math.round(w.innerHeight), sections:out});
  }catch(e){ done({ready:false,why:e.message}); }
}
setTimeout(__secDiag, __DELAY__);
</script>
"""



# &geo=1 时把 iframe 里一批关键元素的**几何**（含计算样式）dump 出来。
#
# 用途：验证「改材质」没有动到「排版」。
# 换背景、加 backdrop-filter、改 transform，都有一万种方式把布局搞歪 ——
# 截图看着"还行"完全不能说明没歪。所以直接量：同一组选择器在两个版本里的
# 位置 / 尺寸 / 关键计算样式，逐项对比，不一致就是歪了。
GEO_DIAG = """
<script>
function __geoDiag(){
  var f=document.getElementById('f');
  function done(o){
    var s; try{ s=JSON.stringify(o); }catch(e){ s='"ERR '+e.message+'"'; }
    document.body.textContent='GEOSTART'+s+'GEOEND';
  }
  try{
    var d=f.contentDocument, w=f.contentWindow;
    var SEL=['#app','#topbar','.side','#board','.slots','.slot','.hand',
             '.card','.card.mini','#actions','#logbox','#counts','.modes','.tbtn',
             '.brand','.prompt','.btn','#banner'];
    var out={};
    SEL.forEach(function(sel){
      var el=d.querySelector(sel);
      if(!el){ out[sel]=null; return; }
      var r=el.getBoundingClientRect(), cs=w.getComputedStyle(el);
      out[sel]={
        x:Math.round(r.left*10)/10, y:Math.round(r.top*10)/10,
        w:Math.round(r.width*10)/10, h:Math.round(r.height*10)/10,
        display:cs.display, position:cs.position, overflow:cs.overflow,
        border:cs.borderTopWidth, pad:cs.padding, radius:cs.borderTopLeftRadius
      };
    });
    done({ready:true, view:[w.innerWidth,w.innerHeight],
          scrollH:Math.round(d.documentElement.scrollHeight),
          bodyH:Math.round(d.body.getBoundingClientRect().height),
          geo:out});
  }catch(e){ done({ready:false,why:e.message}); }
}
setTimeout(__geoDiag, __DELAY__);
</script>
"""


# &ptr=1 时验证「鼠标向量 → CSS 变量 → 高光/倾斜」这条链路真的通了。
#
# 为什么必须量而不能只看截图：headless 截图里没有指针，
# --lg-mx/--lg-my/--lg-rx/--lg-ry 全是空值，高光永远停在默认位置，
# 于是「截图看着正常」和「代码根本没生效」长得一模一样。
# 这里用合成的 PointerEvent 把指针放到卡片的不同位置，再读回：
#   1) 内联变量有没有被写上（JS 这一层）
#   2) 计算出来的 transform 有没有真的变（变量 → 变换这一层）
#   3) ::before 的 radial-gradient 圆心有没有跟着坐标跑（变量 → 绘制这一层）
# 三层都过才算真的通了。
PTR_DIAG = """
<script>
function __ptrDiag(){
  var f=document.getElementById('f');
  function done(o){
    var s; try{ s=JSON.stringify(o); }catch(e){ s='"ERR '+e.message+'"'; }
    document.body.textContent='PTRSTART'+s+'PTREND';
  }
  try{
    var d=f.contentDocument, w=f.contentWindow;

    // 先确认这套材质在本浏览器里真的被支持 —— 不支持的话后面全是空谈
    var sup={
      backdropFilter: !!((w.CSS&&w.CSS.supports)&&(
        w.CSS.supports('backdrop-filter','blur(4px)')||
        w.CSS.supports('-webkit-backdrop-filter','blur(4px)'))),
      mixBlendMode: !!((w.CSS&&w.CSS.supports)&&w.CSS.supports('mix-blend-mode','screen')),
      customPropInGradient: !!((w.CSS&&w.CSS.supports)&&w.CSS.supports('background','radial-gradient(circle 40px at 10px 10px, #fff, transparent)'))
    };

    // 找一张可点的牌（真的会被鼠标指到的那种）
    var card=d.querySelector('.card.clickable')||d.querySelector('.card');
    if(!card){ done({ready:false,why:'页面上没有 .card'}); return; }
    var r=card.getBoundingClientRect();

    // 关键：.card 和 ::before 都声明了 transition（那是阻尼手感本身）。
    // 如果在同一个任务里"写完变量马上读计算样式"，读到的是**过渡的起始值**
    // —— transform 恒为单位阵、opacity 恒为 0，看起来像"变量没生效"，
    // 其实只是还没开始动。第一版探针就被这个骗过一次。
    // 所以量目标值之前先关掉过渡；过渡本身另开一条断言去查 CSS 文本。
    //
    // 注意 ::before 有它自己的 transition，而 transition **不可继承**，
    // 给 .card 写内联 transition:none 是盖不住伪元素的 —— 必须注入规则。
    var declTransition=w.getComputedStyle(card).transition;
    var st=d.createElement('style');
    st.textContent='.card,.card::before{transition:none !important}';
    (d.head||d.documentElement).appendChild(st);

    function probe(fx,fy){
      var x=r.left+r.width*fx, y=r.top+r.height*fy;
      var ev=new w.PointerEvent('pointermove',{bubbles:true,clientX:x,clientY:y,pointerType:'mouse'});
      card.dispatchEvent(ev);
      var cs=w.getComputedStyle(card);
      var bef=w.getComputedStyle(card,'::before');
      return {
        fx:fx, fy:fy,
        mx:card.style.getPropertyValue('--lg-mx'),
        my:card.style.getPropertyValue('--lg-my'),
        rx:card.style.getPropertyValue('--lg-rx'),
        ry:card.style.getPropertyValue('--lg-ry'),
        transform:cs.transform,
        beforeImg:bef.backgroundImage,
        beforeOpacity:bef.opacity
      };
    }

    // 左上角 vs 右下角：向量方向相反，倾角符号也必须相反
    var tl=probe(0.15,0.15);
    var br=probe(0.85,0.85);

    // :hover 是浏览器按真实指针位置驱动的状态，dispatchEvent 合成不出来。
    // 所以「点亮」这一段拆成两半验：
    //   a) 变量 -> 绘制：直接把 --lg-hot 写上去，看 ::before 的不透明度有没有跟。
    //   b) :hover -> 变量：查 CSS 文本里 /hover/ 是否写了 --lg-hot:1（见自检）。
    var opaBefore=w.getComputedStyle(card,'::before').opacity;
    card.style.setProperty('--lg-hot','1');
    var opaAfter=w.getComputedStyle(card,'::before').opacity;
    card.style.removeProperty('--lg-hot');
    var opaBack=w.getComputedStyle(card,'::before').opacity;

    // 按压 -> 抬起
    card.dispatchEvent(new w.PointerEvent('pointerdown',{bubbles:true,clientX:r.left+5,clientY:r.top+5,pointerType:'mouse'}));
    var pressed=card.style.getPropertyValue('--lg-scale');
    var pressedTf=w.getComputedStyle(card).transform;
    w.dispatchEvent(new w.PointerEvent('pointerup',{bubbles:true,clientX:r.left+5,clientY:r.top+5,pointerType:'mouse'}));
    var released=card.style.getPropertyValue('--lg-scale');

    // 指针移出文档 -> 变量要被清掉，不能粘在最后一张牌上
    d.dispatchEvent(new w.PointerEvent('pointerout',{bubbles:true,relatedTarget:null,clientX:0,clientY:0,pointerType:'mouse'}));

    done({
      ready:true,
      support:sup,
      cardBox:[Math.round(r.width),Math.round(r.height)],
      declTransition:declTransition,
      tl:tl, br:br,
      tiltFlipped: tl.ry!==br.ry && tl.rx!==br.rx,
      transformChanged: tl.transform!==br.transform,
      specMoved: tl.beforeImg!==br.beforeImg,
      hot:{before:opaBefore, on:opaAfter, back:opaBack},
      pressed:pressed, pressedTfDiffers:pressedTf!==tl.transform, released:released||'(已清)',
      cleared:card.style.getPropertyValue('--lg-mx')===''
    });
  }catch(e){ done({ready:false,why:e.message+' @'+(e.stack||'').split('\\n')[1]}); }
}
setTimeout(__ptrDiag, __DELAY__);
</script>
"""


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/__slow":
            q = urllib.parse.parse_qs(parsed.query)
            ms = min(max(int((q.get("ms") or ["3000"])[0] or 0), 0), 60000)
            time.sleep(ms / 1000.0)
            self.send_response(200)
            self.send_header("Content-Type", "image/gif")
            self.send_header("Content-Length", str(len(SLOW_GIF)))
            self.end_headers()
            self.wfile.write(SLOW_GIF)
            return
        if parsed.path in ("/__probe", "/__probe.html"):
            q = urllib.parse.parse_qs(parsed.query)
            page = (q.get("p") or ["/"])[0]
            if not page.startswith("/"):
                page = "/" + page
            body = (PROBE % {
                "p": page,
                "y": int((q.get("y") or ["0"])[0] or 0),
                "w": int((q.get("w") or ["1440"])[0] or 1440),
                "h": int((q.get("h") or ["990"])[0] or 990),
            })
            # slow=N 塞一张拖住 load 的图。配合不带 --virtual-time-budget 的
            # headless，就能在**真实时间**里量动画（虚拟时间会快进动画时钟）。
            if q.get("slow"):
                ms = min(max(int((q.get("slow") or ["3000"])[0] or 0), 0), 60000)
                body += '<img id="__slowpoke" src="/__slow?ms=%d" alt="" width="1" height="1">' % ms
            if (q.get("diag") or ["0"])[0] == "1":
                # 延迟要落后于 PROBE 里的滚动，跑完诊断直接换掉整页内容
                body += DIAG.replace("__DELAY__", (q.get("d") or ["3200"])[0])
            if (q.get("dm") or ["0"])[0] == "1":
                # 弹幕解析几何的真实浏览器校验，同样换掉整页内容
                body += DM_DIAG.replace("__DELAY__", (q.get("d") or ["6000"])[0])
            if (q.get("sec") or ["0"])[0] == "1":
                # 板块偏移量，用来给截图挑稳定的 y
                body += SEC_DIAG.replace("__DELAY__", (q.get("d") or ["3200"])[0])
            if (q.get("geo") or ["0"])[0] == "1":
                # 几何比对：验证「换材质没动排版」
                body += GEO_DIAG.replace("__DELAY__", (q.get("d") or ["2600"])[0])
            if (q.get("ptr") or ["0"])[0] == "1":
                # 鼠标向量链路：JS → CSS 变量 → 变换 / 高光
                body += PTR_DIAG.replace("__DELAY__", (q.get("d") or ["2600"])[0])
            body = body.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def free_port(start: int) -> int:
    for p in range(start, start + 40):
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", p)) != 0:
                return p
    return start


def main() -> None:
    if not DIST.is_dir():
        print("找不到 dist/，先跑： python tools/build_site.py", file=sys.stderr)
        sys.exit(1)

    port = int(sys.argv[1]) if len(sys.argv) > 1 else free_port(8788)

    http.server.SimpleHTTPRequestHandler.extensions_map.update(EXTRA)
    handler = functools.partial(Handler, directory=str(DIST))

    with Server(("127.0.0.1", port), handler) as httpd:
        print(f"预览： http://127.0.0.1:{port}/")
        print(f"       http://127.0.0.1:{port}/gallery/")
        print(f"       强制走兜底： http://127.0.0.1:{port}/?imgfail=1")
        print(f"       截图探针：   http://127.0.0.1:{port}/__probe.html?p=/gallery/&y=2400")
        print("Ctrl+C 结束")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止")


if __name__ == "__main__":
    main()
