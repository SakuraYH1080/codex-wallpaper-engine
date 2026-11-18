/**
 * tools/e2e.mjs —— 真机端到端：宿主 server + CDP injector + controller 串起来
 *
 *   node tools/e2e.mjs [--port 9333] [--shot docs/e2e.png] [--keep] [--wallpaper ID]
 *
 * 步骤：起 host server（端口 0）→ 连 CDP →（必要时）bypass CSP + reload → push payload
 *       → 回读页面 report → 截图 → 关服务（--keep 则不关，留给浏览器看）
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
}
const flag = (n) => argv.includes("--" + n);

const CDP_PORT = Number(arg("port", "9333"));
const SHOT = resolve(ROOT, arg("shot", "docs/e2e.png"));
const KEEP = flag("keep");
const WANT_ID = arg("wallpaper", null);
const PROBE = readFileSync(resolve(HERE, "probe-dom.js"), "utf8");

const { createHostServer } = await import("../src/host/server.mjs");
const { createInjector } = await import("../src/host/injector.mjs");
const { createController } = await import("../src/host/controller.mjs");
const { updateConfig } = await import("../src/host/config.mjs");
const { sleep } = await import("../src/host/cdp.mjs");

const log = (...a) => console.log("[e2e]", ...a);

let server = null, injector = null, controller = null;
let exitCode = 0;

try {
  /* ── 1. 宿主 HTTP ── */
  server = createHostServer({ port: 0, log: (lvl, msg) => log(lvl, msg) });
  await server.listen(0);
  log("server", server.url);

  const inv = await server.inventory.build();
  log("inventory total=", inv.total, " uploads=", inv.wallpapers.filter((w) => w.source === "upload").length);
  for (const w of inv.wallpapers.slice(0, 8)) log("  ·", w.type, w.id, w.title, w.media ? "media" : "");

  if (WANT_ID) { updateConfig({ id: WANT_ID }); log("config.id 强制为", WANT_ID); }

  /* ── 2. 注入器 ── */
  injector = createInjector({
    port: CDP_PORT,
    log: (lvl, msg) => log("injector/" + lvl, msg),
    onState: (s) => log("injector state", JSON.stringify(s)),
  });
  await injector.start();
  for (let i = 0; i < 40 && !injector.connected; i++) await sleep(250);
  log("connected =", injector.connected);
  if (!injector.connected) throw new Error("CDP 未连上，检查 Codex 是否带 --remote-debugging-port=" + CDP_PORT + " 启动");

  /* ── 3. 控制器 ── */
  controller = createController({ server, injector, log: (lvl, msg) => log("ctl/" + lvl, msg) });
  const out = await controller.push({ reason: "e2e" });
  log("push =>", JSON.stringify(out).slice(0, 400));

  await sleep(1500);

  /* ── 4. 回读页面状态 ── */
  const report = await injector.evaluate("window.__CWE ? window.__CWE.report() : null", { returnByValue: true });
  log("page report =", JSON.stringify(report));

  const dom = await injector.evaluate(PROBE, { returnByValue: true });
  log("dom probe =", JSON.stringify(dom, null, 1));

  /* ── 5. 截图 ── */
  const buf = await injector.screenshot();
  if (buf && buf.length) {
    mkdirSync(dirname(SHOT), { recursive: true });
    writeFileSync(SHOT, buf);
    log("screenshot →", SHOT, buf.length, "B");
  }

} catch (e) {
  console.error("[e2e] FAIL", (e && e.stack) || e);
  exitCode = 1;
} finally {
  try { if (controller) await controller.stop(); } catch (_) {}
  try { if (injector && !KEEP) await injector.stop(); } catch (_) {}
  try { if (server && !KEEP) await server.close(); } catch (_) {}
  if (KEEP) { console.log("[e2e] --keep：服务保持运行"); await new Promise(() => {}); }
}
process.exit(exitCode);
