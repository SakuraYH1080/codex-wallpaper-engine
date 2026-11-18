/** 用独立的 Chrome 进程回归 CDP、壁纸交接和玻璃选择器。 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp, connectMain, isMainUrl, listPages, probePort, sleep } from "../src/host/cdp.mjs";
import { createInjector, runtimeExpression } from "../src/host/injector.mjs";

const chrome = process.env.CWE_TEST_CHROME || (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : "google-chrome");

const profile = await mkdtemp(join(tmpdir(), "cwe-renderer-"));
const requests = new Map();
let hostHealthy = true;
const host = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.url.startsWith("/wallpaper-engine/")) {
    res.statusCode = hostHealthy ? 200 : 503;
    res.setHeader("Content-Type", "application/json");
    res.end('{"ok":true}');
  } else {
    requests.set(req.url, res);
  }
});
async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function until(check, message) {
  for (let i = 0; i < 120; i++) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(message);
}

const image = (res, color) => {
  res.setHeader("Content-Type", "image/svg+xml");
  res.end('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="24"><rect width="40" height="24" fill="' + color + '"/></svg>');
};

const shell = [
  '<div class="Layout-new" data-app-shell-frame>',
  '<header id="bar" data-app-shell-titlebar>Workspace</header>',
  '<aside id="left" data-app-shell-left-panel-appearance>',
  '<nav id="rail" data-app-navigation-rail><button id="control">New chat</button></nav>',
  '<div id="conversations" data-sidebar-navigation-root><div id="peek" data-slate-sidebar-content>',
  '<button id="selected" aria-current="page">Current chat</button></div></div></aside>',
  '<main id="main" data-app-shell-main-surface="default">',
  '<aside id="side" data-app-shell-focus-area="right-panel">Changes</aside>',
  '<div data-composer-surface-variant><div data-composer-body id="composer"><textarea>draft</textarea></div></div>',
  '<div class="Root-renamed" id="code"><div class="ActionBar-renamed">JavaScript</div><div data-code-block-source><pre>42</pre></div></div>',
  '</main>',
  '<div id="menu" role="menu" class="bg-surface-elevated-secondary"><button>Menu item</button></div>',
  '<div id="unrelated" role="menu" class="native">Unrelated menu</div>',
  '<div id="dialog" role="dialog" class="Modal-renamed">Settings</div>',
  '<div id="searchFrame" role="dialog" class="bg-surface-elevated command-menu-dialog"><div cmdk-root id="search">Search</div></div>',
  '</div>',
].join("");

let documents = 0;
const fixture = createServer((req, res) => {
  const { pathname, searchParams } = new URL(req.url, "http://localhost");
  if (pathname !== "/index.html" && pathname !== "/detached-window.html") {
    res.writeHead(404).end();
    return;
  }
  const loads = pathname === "/index.html" && !searchParams.has("initialRoute") ? ++documents : 0;
  res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
  res.end(`<!doctype html>
    <html data-theme="dark" data-loads="${loads}">
    <head>
      <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'">
      <style>
        :root { --color-surface:#181818; --color-surface-elevated-secondary:#2d2d2d; color:#f4f4f4 }
        :root[data-theme=light] { --color-surface:#fff; --color-surface-elevated-secondary:#f5f5f5; color:#171717 }
        body, html { background:var(--color-surface) }
        #root { position:relative; z-index:1 }
        #main { min-height:240px }
        #control { background:#006cff }
        #selected { background:#3c3c3c }
        #left { display:flex }
        #left:not([data-slate-sidebar-peeking="true"]) #conversations { background-color:rgb(24 24 24 / .65) }
        #left[data-slate-sidebar-peeking="true"] #peek { background:#292929; box-shadow:0 2px 4px #000 }
        #unrelated { background:#383838 }
        #searchFrame { background:#2d2d2d }
        .invisible { visibility:hidden }
      </style>
    </head>
    <body><div id="root"><div class="invisible"><main class="bg-surface"><webview class="bg-surface"></webview></main></div></div></body>
    </html>`);
});

let app, exited, injector, browser;
let appOutput = "";
try {
  const base = "http://127.0.0.1:" + await listen(host);
  const ephemeral = createServer();
  const port = await listen(ephemeral);
  await new Promise((resolve) => ephemeral.close(resolve));
  const site = "http://127.0.0.1:" + await listen(fixture);
  const mainUrl = site + "/index.html";
  const avatarUrl = mainUrl + "?initialRoute=%2Favatar-overlay";
  assert.equal(isMainUrl(avatarUrl, mainUrl), false);
  app = spawn(chrome, ["--headless", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--user-data-dir=" + profile, "--remote-debugging-port=" + port,
    mainUrl + "?fixture=1"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  exited = once(app, "exit");
  exited.catch(() => {});
  app.stderr.on("data", (data) => { appOutput = (appOutput + data).slice(-3000); });
  ({ cdp: browser } = await connectMain(port, { match: mainUrl, timeoutMs: 10000 }));
  const root = await Cdp.attach((await probePort(port)).wsUrl);
  try {
    await root.send("Target.createTarget", { url: site + "/detached-window.html" });
    await root.send("Target.createTarget", { url: avatarUrl });
  }
  finally { root.close(); }
  await browser.send("Page.bringToFront");

  const page = (expr) => browser.eval(expr, { timeoutMs: 6000 });
  const report = () => page("window.__CWE?.report()");
  const loads = () => page("Number(document.documentElement.dataset.loads)");
  const evalFn = (fn, ...args) => page("(" + fn.toString() + ")(" + args.map((arg) => JSON.stringify(arg)).join(",") + ")");
  assert.equal(await loads(), 1);
  assert.equal((await page(runtimeExpression({ compatProbe: true }))).shellReady, false);
  assert.equal(await page("!!window.__CWE"), false);

  injector = createInjector({ port, mainUrl, log: (level, message) => {
    if (level === "warn") process.stderr.write(message + "\n");
  } });
  await injector.start();
  assert.equal(await loads(), 1, "连接本身不能触发重载");
  const glass = { titlebar: { on: true }, sidebar: { on: true, blur: 12 },
    conversationSidebar: { on: true, alpha: 70, blur: 18 }, rightSidebar: { on: true },
    overlay: { on: true }, composer: { on: true }, code: { on: true } };
  const payload = (name, kind = "image", enabled = true) => ({
    enabled, base, ui: { alpha: 0.66, alphaMain: 0.58, glass },
    wallpaper: { kind, url: base + name, transition: "fade", opacity: 100, muted: true },
  });
  const apply = (name, kind, enabled) => injector.apply(payload(name, kind, enabled));
  await apply("/first");
  await until(() => requests.has("/first"), "重载后的媒体请求未到达");
  assert.equal(await loads(), 2, "首次遇到 CSP 阻断时只重载一次");
  assert.equal((await report()).mediaStatus, "loading");
  assert.equal(await page("document.querySelector('#cwe-style')?.textContent || ''"), "");
  image(requests.get("/first"), "#203d5b");
  await until(async () => (await report())?.mediaStatus === "ready", "图片未解码");
  assert.equal((await report()).appearanceActive, false, "加载屏阶段保持原生外观");
  await evalFn((markup) => { document.getElementById("root").innerHTML = markup; }, shell);
  await until(async () => (await report()).appearanceActive, "主窗口就绪时未显示壁纸");
  console.log("✓ 首次 CSP 重载及加载屏交接");

  const pages = await listPages(port);
  for (const helperUrl of [site + "/detached-window.html", avatarUrl]) {
    const helper = await Cdp.attach(pages.find((target) => target.url === helperUrl).webSocketDebuggerUrl);
    try { assert.equal(await helper.eval("!!window.__CWE"), false); }
    finally { helper.close(); }
  }

  await apply("/slow");
  await until(() => requests.has("/slow"), "慢图未发出请求");
  assert.equal((await report()).url, base + "/first");
  await apply("/newest");
  await until(() => requests.has("/newest"), "最新图片未发出请求");
  image(requests.get("/slow"), "green");
  assert.equal((await report()).url, base + "/first", "被取消的旧请求不能提交");
  image(requests.get("/newest"), "#9f544c");
  await until(async () => (await report()).url === base + "/newest", "连切后没显示最后一次请求");
  await apply("/missing");
  await until(() => requests.has("/missing"), "坏图未发出请求");
  requests.get("/missing").writeHead(404).end();
  await until(async () => (await report()).mediaStatus === "failed", "未报告加载失败");
  assert.equal((await report()).url, base + "/newest", "失败后应保留原画面");

  const videoBytes = await evalFn(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 48;
    canvas.height = 32;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(25);
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
    const chunks = [];
    recorder.ondataavailable = ({ data }) => chunks.push(data);
    const recording = new Promise((resolve) => {
      recorder.onstop = () => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(",")[1]);
        reader.readAsDataURL(new Blob(chunks));
      };
    });
    recorder.start();
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = i % 2 ? "navy" : "teal";
      ctx.fillRect(0, 0, 48, 32);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    recorder.stop();
    return recording;
  });
  await apply("/video", "video");
  await until(() => requests.has("/video"), "视频未发出请求");
  assert.equal((await report()).url, base + "/newest");
  requests.get("/video").writeHead(200, { "Content-Type": "video/webm" }).end(Buffer.from(videoBytes, "base64"));
  await until(async () => (await report()).kind === "video", "视频首帧未提交");
  assert(await page("document.querySelector('#cwe-root video').readyState >= HTMLMediaElement.HAVE_CURRENT_DATA"));
  console.log("✓ 快速连切、媒体失败回退与视频首帧");

  const matches = await page(runtimeExpression({ compatProbe: true }));
  for (const name of ["titlebar", "sidebarRail", "conversationSidebar", "rightSidebar", "composerBody", "code", "menu", "dialog", "search"]) {
    assert.equal(matches.matches[name].visible, 1, name);
  }
  const blur = (id) => evalFn((id) => getComputedStyle(document.getElementById(id)).backdropFilter, id);
  for (const id of ["bar", "rail", "conversations", "side", "composer", "code", "menu", "dialog", "search"]) {
    assert.match(await blur(id), /^blur\(/, id);
  }
  assert.equal(await blur("unrelated"), "none");
  assert.equal(await blur("searchFrame"), "none");
  assert.equal(await page("getComputedStyle(document.getElementById('control')).backgroundColor"), "rgb(0, 108, 255)");

  const background = (id) => evalFn((id) => getComputedStyle(document.getElementById(id)).backgroundColor, id);
  const originalTint = await background("conversations");
  const railTint = await background("rail");
  glass.conversationSidebar = { on: true, alpha: 42, blur: 31 };
  await apply("/video", "video");
  assert.match(await blur("conversations"), /^blur\(31px\)/);
  assert.notEqual(await background("conversations"), originalTint);
  assert.equal(await blur("left"), "none");
  assert.equal(await background("rail"), railTint);
  assert.match(await blur("rail"), /^blur\(12px\)/);
  assert.equal(await background("selected"), "rgb(60, 60, 60)");

  await page("document.getElementById('left').setAttribute('data-slate-sidebar-peeking', 'true')");
  assert.equal(await blur("conversations"), "none");
  assert.match(await blur("peek"), /^blur\(31px\)/);
  assert.notEqual(await page("getComputedStyle(document.getElementById('peek')).boxShadow"), "none");
  glass.conversationSidebar.on = false;
  await apply("/video", "video");
  assert.equal(await blur("peek"), "none");
  assert.equal(await background("peek"), "rgb(41, 41, 41)");
  assert.match(await blur("rail"), /^blur\(12px\)/);
  await page("document.getElementById('left').removeAttribute('data-slate-sidebar-peeking')");
  assert.equal(await blur("conversations"), "none");
  assert.equal(await background("conversations"), "rgba(24, 24, 24, 0.65)");
  glass.conversationSidebar = { on: true, alpha: 70, blur: 18 };
  await apply("/video", "video");
  console.log("✓ 会话列表可独立调节，贴边展开和选中高亮正常");

  for (const dark of [true, false]) {
    const ratios = await evalFn((dark) => {
      document.documentElement.dataset.theme = dark ? "dark" : "light";
      const menu = getComputedStyle(document.getElementById("menu"));
      const ctx = document.createElement("canvas").getContext("2d");
      const pixel = () => [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
      const luminance = (rgb) => rgb.map((c) => c / 255).map((c) =>
        c < 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
      ).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
      ctx.fillStyle = menu.color;
      ctx.fillRect(0, 0, 1, 1);
      const text = luminance(pixel());
      return ["#fff", "#000"].map((backdrop) => {
        ctx.fillStyle = backdrop;
        ctx.fillRect(0, 0, 1, 1);
        ctx.fillStyle = menu.backgroundColor;
        ctx.fillRect(0, 0, 1, 1);
        const background = luminance(pixel());
        return (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05);
      });
    }, dark);
    assert(ratios.every((ratio) => ratio >= 4.5), "浮层正文反差不足");
    console.log("✓ " + (dark ? "深色" : "浅色") + "浮层在白底 / 黑底上的对比度 " + ratios.map((ratio) => ratio.toFixed(2)).join(" / "));
  }
  await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
  await until(async () => !(await report()).appearanceActive, "系统减少透明度时应使用原生外观");
  await browser.send("Emulation.setEmulatedMedia", { features: [] });
  await until(async () => (await report()).appearanceActive, "取消减少透明度后未恢复");
  await apply("/video", "video", false);
  assert.equal((await report()).mediaStatus, "disabled");
  assert.equal(await blur("composer"), "none");
  assert.equal(await page("document.querySelector('textarea').value"), "draft");
  assert.equal(await page("document.querySelector('#cwe-root video')"), null);

  // 用户自己刷新后，自动同步新文档。现有 CDP 会话已经允许本机媒体。
  await browser.send("Page.reload", { ignoreCache: false });
  await until(async () => {
    try { return (await loads()) === 3 && (await report())?.mediaStatus === "disabled"; }
    catch { return false; }
  }, "正常导航后未重新挂载");
  assert.equal(await loads(), 3);
  await injector.stop();
  assert.equal(await page("!!window.__CWE"), false);
  injector = createInjector({ port, mainUrl });
  await injector.start();
  hostHealthy = false;
  const unavailable = await apply("/unused", "image", false);
  assert.equal(unavailable.reason, "host-unreachable");
  assert.equal(await loads(), 3, "宿主返回 503 时不能刷新当前文档");
  hostHealthy = true;
  // 自愈：宿主恢复后不再手动 apply，靠退避重试自己把壁纸装回去。
  // 这条断言守着 injector 的「失败不再是一次性终点」（旧实现会永久停在 host-unreachable）。
  await until(async () => {
    try { return (await report())?.mediaStatus === "disabled"; } catch { return false; }
  }, "宿主恢复后没有自动重试恢复注入");
  assert.equal(await loads(), 3, "自愈重试不能重载文档");
  console.log("✓ 宿主短暂不可达后自动恢复（无需手动 apply）");
  console.log("✓ 玻璃命中、原生控件、总开关及正常导航");
} catch (e) {
  if (appOutput) process.stderr.write(appOutput + "\n");
  throw e;
} finally {
  await injector?.stop();
  browser?.close();
  if (app) {
    app.kill();
    await exited.catch(() => {});
  }
  for (const server of [host, fixture]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(profile, { recursive: true, force: true });
}
