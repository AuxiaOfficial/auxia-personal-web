/**
 * 真实浏览器探针 / 截图器 —— 走 CDP，**零 npm 依赖**
 *
 * 为什么需要它：
 *   1) `msedge --headless --virtual-time-budget=N` 会把**动画时钟快进**，
 *      而 `performance.now()` 基本按真实时间走。于是「算出来的位置」和
 *      「画出来的位置」会差出十万八千里，看着像布局 bug，其实是测量假象。
 *      要量真实行为，就必须让真实时间真的流过去 —— 那就得有个能"等"的驱动。
 *   2) `--virtual-time-budget` 截图老拍到"CSS 好了、位图还没上屏"的那一帧
 *      （README 里记过这个坑）。本脚本等 load + 固定真实延时 + 显式滚动，
 *      拍到空白块的概率低得多。
 *
 * 只用了 Node 22 自带的 fetch 与 WebSocket，不引入任何依赖，
 * 所以「站点零依赖」这条底线没被破坏（这个脚本也不进 dist/）。
 *
 * 用法：
 *   node tools/browser-probe.cjs --url=<url> [--eval=<js> | --eval-file=<f>]
 *                               [--wait=ms] [--w=1440] [--h=990]
 *                               [--shot=out.png] [--shot-full]
 *                               [--scroll-y=2400] [--keep]
 *
 *   --eval / --eval-file : 页面内执行的 **函数体**（语句，必须自己 return）。
 *                          返回值会被 JSON 化打到 stdout 的 PROBE_JSON: 行。
 *                          支持 async：写成 `return (async function(){...})();`
 *   --shot               : 截图存到该路径
 *   --shot-full          : 截整页（默认只截视口）
 *   --scroll-y           : 求值/截图前先滚到该偏移（顺带关掉平滑滚动）
 *   --cdp-timeout        : 单条 CDP 命令的等待上限（ms，默认 30000）。
 *                          探针里要 sleep 很久时**必须**调大，否则会以
 *                          「CDP 超时」告终（弹幕稳态要约 50s 才谈得上密度）。
 *   --keep               : 别吞掉浏览器 stderr，排查连不上时用
 *
 * 退出码：0 成功；1 参数/连接失败。
 */
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

/* 收尾：把这次探针起的浏览器**连整棵进程树**一起收干净。

   child.kill() 只打死直接子进程，而 Edge 还会派生 renderer / GPU /
   network service 等一堆子进程；更要命的是 msedge.exe 这个启动器
   **会自己立刻退出并把工作交接出去** —— 于是那些子进程被重新挂到别的
   父进程底下，连 taskkill /PID /T 都追不到（实测确实如此：
   一次探针跑完，子进程全都活着）。

   所以除了 kill(pid)，再按**唯一的 user-data-dir** 认一遍人：
   浏览器每个进程的命令行里都带着 --user-data-dir=<临时目录>，
   按这个特征扫一遍比靠父子关系可靠。

   ⚠️ 顺带记一个**差点被误判的测量**：`tasklist | grep -ci msedge`
   会把 msedgewebview2.exe 一起数进去（宿主应用自己的 WebView2 进程），
   一度显示"残留 12 个"其实根本不是我们起的 —— 判断有没有残留要看
   `tasklist /FI "IMAGENAME eq msedge.exe"`，别用模糊 grep。 */
function killTree(pid, profile) {
  if (process.platform === 'win32') {
    if (profile) {
      const script =
        'Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\'" | ' +
        'Where-Object { $_.CommandLine -like \'*' + profile.replace(/'/g, "''") + '*\' } | ' +
        'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
      try {
        spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
          { stdio: 'ignore', timeout: 20000 });
      } catch (e) { /* noop */ }
    }
  }
  if (pid) {
    try { process.kill(pid, 'SIGKILL'); } catch (e) { /* noop */ }
  }
}

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) { continue; }
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

function num(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function findEdge() {
  for (const p of EDGE_CANDIDATES) {
    if (fs.existsSync(p)) { return p; }
  }
  return null;
}

function getJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

/** 等 devtools 的 http 端点起来 */
async function waitForDevtools(port, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      return await getJson(`http://127.0.0.1:${port}/json/version`, 1000);
    } catch (e) {
      lastErr = e;
      await sleep(120);
    }
  }
  throw new Error(`devtools 没起来 (port ${port}): ${lastErr && lastErr.message}`);
}

/** 一个极简 CDP 客户端：send(method, params) → 等对应 id 的回复
 *
 *  ⚠️ requestTimeoutMs 必须可调：单次 `Runtime.evaluate` 的**总耗时**受它管。
 *     以前写死 30s，于是"跑 55 秒再采样"这种探针会以「CDP 超时」告终 ——
 *     而弹幕的稳态密度恰恰要约 50 秒才谈得上（存活时间就是这么长）。
 *     用 --cdp-timeout=<ms> 放开，默认仍是 30s。 */
function connect(wsUrl, requestTimeoutMs) {
  const rtt = requestTimeoutMs || 30000;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const listeners = new Set();

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) { rej(new Error(`${msg.error.message}`)); } else { res(msg.result); }
        return;
      }
      if (msg.method) {
        for (const fn of listeners) { fn(msg); }
      }
    });
    ws.addEventListener('error', () => reject(new Error('websocket 出错')));
    ws.addEventListener('open', () => {
      resolve({
        send(method, params) {
          const id = nextId++;
          return new Promise((res, rej) => {
            pending.set(id, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id, method, params: params || {} }));
            setTimeout(() => {
              if (pending.has(id)) {
                pending.delete(id);
                rej(new Error(`CDP 超时(${rtt}ms): ${method}`));
              }
            }, rtt);
          });
        },
        on(fn) { listeners.add(fn); },
        once(method, budgetMs) {
          return new Promise((res, rej) => {
            const fn = (msg) => { if (msg.method === method) { listeners.delete(fn); res(msg.params); } };
            listeners.add(fn);
            setTimeout(() => { listeners.delete(fn); rej(new Error(`等 ${method} 超时`)); }, budgetMs);
          });
        },
        close() { try { ws.close(); } catch (e) { /* noop */ } },
      });
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    console.error('用法: node tools/browser-probe.cjs --url=<url> [--eval=<js>] [--shot=out.png] ...');
    process.exit(1);
  }

  const exe = findEdge();
  if (!exe) {
    console.error('找不到 Edge / Chrome');
    process.exit(1);
  }

  const width = num(args.w, 1440);
  const height = num(args.h, 990);
  const waitMs = num(args.wait, 2500);
  const scrollY = num(args['scroll-y'], 0);

  let expression = args.eval ? String(args.eval) : null;
  if (!expression && args['eval-file']) {
    expression = fs.readFileSync(String(args['eval-file']), 'utf8');
  }

  const port = 9333 + Math.floor(Math.random() * 300);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'auxia-probe-'));
  const child = spawn(exe, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--mute-audio',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    'about:blank',
  ], { stdio: args.keep ? 'inherit' : 'ignore' });

  let client = null;
  try {
    await waitForDevtools(port, 20000);
    const list = await getJson(`http://127.0.0.1:${port}/json/list`, 3000);
    const page = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page) { throw new Error('没有找到 page target'); }

    client = await connect(page.webSocketDebuggerUrl, num(args['cdp-timeout'], 30000));
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    // 固定视口，别让 --window-size 和实际布局对不上
    await client.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false,
    });

    const loaded = client.once('Page.loadEventFired', 30000);
    await client.send('Page.navigate', { url: String(args.url) });
    await loaded;
    // 真实时间真的流过去 —— 这正是 --virtual-time-budget 做不到的事
    await sleep(waitMs);

    if (scrollY) {
      await client.send('Runtime.evaluate', {
        expression: `(function(){document.documentElement.style.scrollBehavior='auto';` +
          `document.body.style.scrollBehavior='auto';` +
          `window.scrollTo(0,${scrollY});return window.scrollY;})()`,
        returnByValue: true,
      });
      await sleep(500);
    }

    if (expression) {
      // 把 --eval / --eval-file 的内容当「函数体」跑，所以它必须自己 return。
      // await 是为了让 `return (async function(){...})()` 这种写法也能用。
      const res = await client.send('Runtime.evaluate', {
        expression: `(async function(){try{` +
          `var __v=await (function(){${expression}})();` +
          `return JSON.stringify(__v===undefined?null:__v);` +
          `}catch(e){return JSON.stringify({__error:String(e&&e.message||e)});}})()`,
        returnByValue: true,
        awaitPromise: true,
      });
      const raw = res && res.result ? res.result.value : null;
      console.log('PROBE_JSON:' + (raw === undefined || raw === null ? 'null' : raw));
    }

    if (args.shot) {
      const shot = await client.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: !!args['shot-full'],
      });
      const outPath = path.resolve(String(args.shot));
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
      console.log('PROBE_SHOT:' + outPath + ' (' + fs.statSync(outPath).size + ' bytes)');
    }
  } finally {
    if (client) { client.close(); }
    killTree(child.pid, profile);
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* noop */ }
  }
}

main().catch((e) => {
  console.error('探针失败: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
