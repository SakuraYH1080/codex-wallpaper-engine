/**
 * src/host/daemon.mjs —— 守护进程
 *
 * 把三块拼起来并让它长期活着：
 *   createHostServer  →  loopback HTTP（清单 / 媒体 / 设置 / 上传）
 *   createInjector    →  CDP 连接 Codex 页面，注入运行时
 *   createController  →  config + inventory → payload → 页面
 *
 * 三条不变量：
 *   1. 这里不抛异常给调用者。Codex 没开、没调试端口、页面在导航 —— 全都是常态，
 *      一律记日志后等着，不做「启动失败」这种判断。
 *   2. 只有一个写者：config.json 的每一次变更都经 updateConfig，变更后统一
 *      controller.push() 重推整份 payload。
 *   3. runtime.json 是外部（MCP server / CLI / 面板）唯一发现端口的方式，
 *      进程退出必须删掉它，否则外部会去敲一个死端口。
 */

import { writeFileSync, unlinkSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { DIRS, ensureDataDirs } from "./data-dir.mjs";
import { getConfig, loadConfig, updateConfig, CONFIG_PATH } from "./config.mjs";
import { createHostServer } from "./server.mjs";
import { createInjector } from "./injector.mjs";
import { createController } from "./controller.mjs";
import { pickCdpPort, describePick } from "./port-pick.mjs";

export const RUNTIME_PATH = join(DIRS.root, "runtime.json");
export const LOG_PATH = join(DIRS.root, "cwe.log");
export const PID_PATH = join(DIRS.root, "cwe.pid");
const LOG_MAX = 2 * 1024 * 1024;

export function readRuntime() {
  try {
    if (!existsSync(RUNTIME_PATH)) return null;
    const j = JSON.parse(readFileSync(RUNTIME_PATH, "utf8"));
    if (!j || !j.port) return null;
    return j;
  } catch {
    return null;
  }
}

export function writeRuntime(obj) {
  try {
    writeFileSync(RUNTIME_PATH, JSON.stringify(obj, null, 2), "utf8");
  } catch { /* 写不了就算了，别让守护因为一个文件挂掉 */ }
}

export function clearRuntime() {
  try { if (existsSync(RUNTIME_PATH)) unlinkSync(RUNTIME_PATH); } catch {}
  try { if (existsSync(PID_PATH)) unlinkSync(PID_PATH); } catch {}
}

/**
 * 自己的版本号。原来这里写死 "0.4.2"，package.json 早就 0.7.0 了 ——
 * runtime.json 的 version 是外部判断「装的是哪一版」的唯一依据，写死等于撒谎。
 * 读不到（打包后路径变了）就退回 "0.0.0"，不抛。
 */
const PKG_PATH = new URL("../../package.json", import.meta.url);
let cachedVersion = "";
function readOwnVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    const j = JSON.parse(readFileSync(PKG_PATH, "utf8"));
    cachedVersion = String(j.version || "") || "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}

function makeLogger(verbose) {
  const stamp = () => new Date().toISOString().slice(11, 19);
  return function log(level, msg) {
    const line = "[" + stamp() + "] " + (level || "info") + " " + msg;
    if (verbose) process.stderr.write(line + "\n");
    try {
      appendFileSync(LOG_PATH, line + "\n", "utf8");
      const s = existsSync(LOG_PATH) ? 0 : 0;
      void s;
    } catch {}
  };
}

/** 把日志文件裁到 LOG_MAX 以内（保留后半段）。 */
function rotateLog() {
  try {
    if (!existsSync(LOG_PATH)) return;
    const buf = readFileSync(LOG_PATH);
    if (buf.length <= LOG_MAX) return;
    writeFileSync(LOG_PATH, buf.subarray(buf.length - Math.floor(LOG_MAX / 2)), "utf8");
  } catch {}
}

/**
 * 启动守护。返回 { port, url, server, injector, controller, close }。
 * 注意：这是「已经 listen 成功」之后才返回的；失败会 reject（端口占用重试在 server 内部）。
 */
export async function startDaemon({ port = null, host = "127.0.0.1", verbose = false } = {}) {
  ensureDataDirs();
  rotateLog();
  const log = makeLogger(verbose);
  loadConfig();

  const cfg = getConfig();
  const wantPort = Number(port || cfg.cwePort || 9333) || 9333;
  // 端口不能直接拿来就用：Codex 用 --remote-debugging-port=P 启动，P 要是被别的
  // 程序占着，它那个监听根本绑不上，注入器只能一直等 —— 日志干净得像「没事发生」。
  // 所以先挑：同段里已经有一个 DevTools 端点就复用它（重启守护时这是常态），
  // 否则找第一个真正空闲的端口。
  const pick = await pickCdpPort(wantPort);
  const cdpPort = pick.port;
  log("info", "cdp " + describePick(pick, wantPort));

  let injectorRef = null;
  const server = createHostServer({
    port: 0,
    host,
    log,
    onEvent: (ev) => {
      // 任何设置 / 上传 / 删除事件都重推一次 payload（幂等，不做增量）
      if (!injectorRef) return;
      if (!ev) return;
      if (ev.type === "panel-open") {
        // 面板本身住在页面里；这里只负责把它叫出来。
        injectorRef.evaluate("window.__CWE && window.__CWE.panel && window.__CWE.panel.show()", { awaitPromise: false })
          .catch(() => {});
        return;
      }
      if (ev.type === "rotation-next") {
        // 视频播完触发：只在组 trigger=videoEnd 时推进（controller 自己会判）。
        controllerRef && controllerRef.push({ reason: "rotation-video-end", advance: true }).catch(() => {});
        return;
      }
      if (ev.type === "settings" || ev.type === "apply" || ev.type === "upload" || ev.type === "remove") {
        controllerRef && controllerRef.push({ reason: "event:" + ev.type }).catch(() => {});
      }
    },
  });

  const listenOut = await server.listen(0);
  log("info", "http listening " + listenOut.url);

  const injector = createInjector({ port: cdpPort, log });
  injectorRef = injector;

  const controller = createController({ server, injector, log });
  var controllerRef = controller;

  writeRuntime({
    port: listenOut.port,
    url: listenOut.url,
    cdpPort: cdpPort,
    // wantPort 和 cdpPort 不同时说明配置里的端口被占了 —— 外部工具看 runtime.json
    // 就能知道「我该连哪个」，不用自己再猜一遍。
    cdpPortPreferred: wantPort,
    cdpPortState: pick.state,
    pid: process.pid,
    startedAt: Date.now(),
    version: readOwnVersion(),
    prefix: "/wallpaper-engine",
    panel: listenOut.url + "/wallpaper-engine/panel",
  });
  try { writeFileSync(PID_PATH, String(process.pid), "utf8"); } catch {}

  // 连接前缓存首份 payload，找到主窗口后直接准备媒体。
  if (getConfig().cweInjectOnStart !== false) {
    await controller.start().catch((e) => log("warn", "controller.start 失败: " + (e && e.message || e)));
  }
  await injector.start().catch((e) => log("warn", "injector.start 失败: " + (e && e.message || e)));

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    log("info", "shutdown");
    try { await controller.stop(); } catch {}
    try { await injector.stop(); } catch {}
    try { await server.close(); } catch {}
    clearRuntime();
  }

  return {
    port: listenOut.port,
    url: listenOut.url,
    server,
    injector,
    controller,
    log,
    close,
    get config() { return getConfig(); },
    configPath: CONFIG_PATH,
  };
}

/** 读配置里「该用什么 CDP 端口」。 */
export function desiredCdpPort() {
  try {
    loadConfig({ migrate: false });
    return Number(getConfig().cwePort) || 9333;
  } catch {
    return 9333;
  }
}

/** 面板设置一组值 —— CLI / MCP 共用。 */
export function applySettings(patch) {
  const cfg = updateConfig(patch);
  return cfg;
}
