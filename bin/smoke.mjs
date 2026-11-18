#!/usr/bin/env node
/**
 * todo1 冒烟：把壁纸层注入 Codex 主窗口，把 UI 降半透明，然后截图。
 * 用法：node bin/smoke.mjs [--port 9333] [--image PATH] [--shot OUT.png] [--uninstall]
 */
import { readFileSync } from "node:fs";
import { writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { probePort, connectMain, sleep } from "../src/host/cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 ? process.argv[i + 1] : dflt;
}
const flag = (name) => process.argv.includes("--" + name);

const PORT = Number(arg("port", "9333"));
const IMAGE = arg("image", process.env.CWE_SMOKE_IMAGE || "");
const SHOT = arg("shot", resolve(ROOT, "docs/smoke-1-shot.png"));
const RUNTIME = resolve(ROOT, "src/inject/runtime.js");

const version = await probePort(PORT);
if (!version) {
  console.error(`端口 ${PORT} 没有调试端点。先带 --remote-debugging-port=${PORT} 启动 Codex。`);
  process.exit(2);
}
console.log("CDP:", version.browser);

const { cdp, target } = await connectMain(PORT);
console.log("target:", target.url, target.id);

await cdp.send("Runtime.enable");

if (flag("uninstall")) {
  const r = await cdp.eval("window.__CWE ? window.__CWE.unmount() : {ok:true, already:true}");
  console.log("uninstall:", JSON.stringify(r));
  cdp.close();
  process.exit(0);
}

// ---- 准备壁纸 data URL ----
if (!IMAGE) {
  console.error("需要一张壁纸：node bin/smoke.mjs --image /path/to/pic.jpg");
  process.exit(2);
}
if (!existsSync(IMAGE)) {
  console.error("壁纸不存在:", IMAGE);
  process.exit(2);
}
const bytes = readFileSync(IMAGE);
const ext = IMAGE.split(".").pop().toLowerCase();
const mime = ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
  : ext === "webp" ? "image/webp" : "application/octet-stream";
const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
console.log(`wallpaper: ${IMAGE} ${(bytes.length / 1048576).toFixed(2)}MB -> data url ${(dataUrl.length / 1048576).toFixed(2)}MB`);

// ---- 注入 ----
const src = readFileSync(RUNTIME, "utf8");
const payload = {
  forceReinstall: flag("force"),
  enabled: true,
  wallpaperOpacity: 100,
  wallpaperBlur: 0,
  scrim: 0.15,
  brightness: 100,
  contrast: 100,
  saturate: 100,
  fit: "cover",
  position: { x: 50, y: 50 },
  scale: 100,
  uiAlpha: 0.8,
  uiAlphaMain: 0.8,
  wallpaper: { kind: "image", url: dataUrl },
};

const expr = `(${src})(${JSON.stringify(payload)})`;
const t0 = Date.now();
let res;
try {
  res = await cdp.eval(expr, { timeoutMs: 90000 });
} catch (e) {
  console.error("evaluate 失败:", e.message);
  cdp.close();
  process.exit(1);
}
console.log(`inject ${Date.now() - t0}ms:`, JSON.stringify(res));

await sleep(700);

// ---- 回读现场：谁还在挡着壁纸 ----
const probe = await cdp.eval(`(() => {
  const info = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName, cls: (el.className || "").toString().slice(0, 70),
      bg: cs.backgroundColor, zIndex: cs.zIndex, opacity: cs.opacity,
      w: Math.round(r.width), h: Math.round(r.height),
    };
  };
  const big = [];
  for (const el of document.querySelectorAll("html,body,main,div,webview")) {
    const r = el.getBoundingClientRect();
    if (r.width < 300 || r.height < 200) continue;
    const cs = getComputedStyle(el);
    const bg = cs.backgroundColor;
    const m = bg.match(/rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/);
    const a = m ? (m[4] === undefined ? 1 : Number(m[4])) : 1;
    if (a > 0.01) big.push({ ...info(el), alpha: a });
  }
  const root = document.getElementById("cwe-root");
  const layer = document.getElementById("cwe-layer");
  return {
    cweRoot: info(root), cweLayer: info(layer),
    layerHasBg: !!(layer && layer.style.backgroundImage),
    opaqueBig: big.slice(0, 12),
    opaqueCount: big.length,
    bodyFirstChild: document.body.firstElementChild?.id || document.body.firstElementChild?.tagName,
  };
})()`, { timeoutMs: 20000 });
console.log("probe:", JSON.stringify(probe, null, 2));

// ---- 截图 ----
const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, 30000);
writeFileSync(SHOT, Buffer.from(shot.data, "base64"));
console.log("screenshot ->", SHOT, (Buffer.from(shot.data, "base64").length / 1024).toFixed(0) + "KB");

cdp.close();
