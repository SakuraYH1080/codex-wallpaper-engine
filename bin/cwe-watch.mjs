#!/usr/bin/env node
/**
 * bin/cwe-watch.mjs —— 让「点 Dock 图标启动 Codex」也自动带上调试端口。
 *
 * 为什么需要一个看门人：
 *   Codex 是 Electron 应用，调试端口只能从命令行传 --remote-debugging-port。
 *   Dock、Spotlight、最近项目都无法附加参数；app.asar 里也没有任何开关能开它
 *   （实测 grep remote-debugging 零命中）。改包内二进制会破坏 OpenAI 的签名与公证，
 *   Sparkle 更新还会把它全部还原。
 *   Dock 启动后，只在刚发现进程时尝试一次平滑退出，再用同一份应用带端口启动。
 *
 * 三条纪律：
 *   1. 只换「新起的」进程（etime <= LAUNCH_WINDOW_SEC）。已经跑了一会儿的实例
 *      直接动它就是丢用户正在写的东西 —— 那种情况只记日志，等用户自己重启。
 *   2. cweAutoRelaunch === false 时只观察不动作（给人一个纯看守的选择）。
 *   3. 顺带看守宿主守护进程：每 HOST_PROBE_MS 探一次 /status，挂了就拉起来。
 *      但拉之前先确认调试端点还活着 —— Codex 没端口时，宿主起来也连不上主窗口，
 *      只会「起→连不上→退」，历史上 watch.log 里那 8 条连拉就是这么来的。
 *
 * 日志：~/.codex-wallpaper-engine/watch.log
 * 装成开机常驻：node bin/cwe.mjs autostart on
 */

import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { findAppBinary } from "../src/host/app-path.mjs";

const DATA_DIR = process.env.CWE_DATA_DIR || join(homedir(), ".codex-wallpaper-engine");
const CONFIG_PATH = join(DATA_DIR, "config.json");
const RUNTIME_PATH = join(DATA_DIR, "runtime.json");
const WATCH_LOG = join(DATA_DIR, "watch.log");
const LOG_MAX = 1024 * 1024;

const TICK_MS = 500;
const LAUNCH_WINDOW_SEC = 2;
const SWAP_COOLDOWN_MS = 15000;
const HOST_PROBE_MS = 8000;
const HOST_START_COOLDOWN_MS = 15000;
const NO_CDP_NOTE_MS = 60000;
const GRACEFUL_QUIT_MS = 8000;
const LAUNCH_WINDOW_WAIT_MS = 9000;
const REOPEN_WAIT_MS = 6000;
const NO_WINDOW_STRIKES = 3;
const NO_WINDOW_RECOVER_COOLDOWN_MS = 60000;
const WINDOW_PROBE_MS = 5000;

const CWE_BIN = fileURLToPath(new URL("./cwe.mjs", import.meta.url));

// 本地时间，和 cwe.log 对齐。以前用 toISOString()（UTC），watch.log 比 cwe.log 慢 8 小时，
// 对照两份日志时几乎每次都要重新换算一遍。
const pad2 = (n) => String(n).padStart(2, "0");
const stamp = () => {
  const d = new Date();
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
    " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
};

function rotate() {
  try {
    if (!existsSync(WATCH_LOG)) return;
    const buf = readFileSync(WATCH_LOG);
    if (buf.length <= LOG_MAX) return;
    writeFileSync(WATCH_LOG, buf.subarray(buf.length - Math.floor(LOG_MAX / 2)));
  } catch (e) { /* 日志转不动也不该让看守死掉 */ }
}

function log(msg) {
  const line = "[" + stamp() + "] " + msg;
  try { appendFileSync(WATCH_LOG, line + "\n", "utf8"); } catch (e) {}
  if (process.stdout.isTTY) process.stdout.write(line + "\n");
}

function readConfig() {
  try {
    const j = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch (e) { return {}; }
}

function readRuntime() {
  try {
    const j = JSON.parse(readFileSync(RUNTIME_PATH, "utf8"));
    return j && j.port ? j : null;
  } catch (e) { return null; }
}

/** ps 的 etime 形如 12 / 1:02 / 1:02:03 / 2-01:02:03，统一化成秒。 */
function etimeToSec(s) {
  if (!s) return null;
  let days = 0;
  let rest = s;
  const dash = rest.indexOf("-");
  if (dash >= 0) { days = Number(rest.slice(0, dash)) || 0; rest = rest.slice(dash + 1); }
  const parts = rest.split(":").map((x) => Number(x) || 0);
  let sec = 0;
  if (parts.length === 3) sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else if (parts.length === 2) sec = parts[0] * 60 + parts[1];
  else if (parts.length === 1) sec = parts[0];
  return days * 86400 + sec;
}

/**
 * 找出 Codex 的主进程（不含 --type= 的渲染/GPU/工具子进程）。
 * 返回 [{pid, etime, hasPort}] —— 通常 0 个或 1 个。
 */
function listMainProcesses(binary) {
  let out = "";
  try {
    out = execFileSync("/bin/ps", ["-Ao", "pid=,etime=,command="], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  } catch (e) { return []; }
  const rows = [];
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const etime = m[2];
    const cmd = m[3];
    if (cmd !== binary && !cmd.startsWith(binary + " ")) continue;
    if (cmd.indexOf("--type=") >= 0) continue;
    rows.push({ pid: pid, etime: etime, hasPort: cmd.indexOf("--remote-debugging-port=") >= 0 });
  }
  return rows;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function quitAndWait(pid, timeoutMs) {
  try { process.kill(pid, "SIGTERM"); } catch (e) { return false; }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (e) { return true; }
    await sleep(100);
  }
  return false;
}

function openWithPort(app, port) {
  try {
    const child = spawn("/usr/bin/open", ["-na", app.bundle, "--args", "--remote-debugging-port=" + String(port)], {
      stdio: "ignore",
    });
    return new Promise((resolve) => {
      child.once("error", (error) => { log("error 无法重启 Codex: " + error.message); resolve(false); });
      child.once("exit", (code) => resolve(code === 0));
    });
  } catch (e) {
    log("error 无法重启 Codex: " + (e && e.message || e));
    return false;
  }
}

/**
 * 换端口之后必须验「窗口真的出来了」。
 * 2026-11-18 的故障就是：/usr/bin/open -na 只把进程拉起来，窗口没跟着回来，
 * 于是 CDP 在、进程在、/json/list 却是空的 —— 用户看到的是「Codex 打不开」。
 */
async function pageCount(port) {
  try {
    const res = await fetch("http://127.0.0.1:" + port + "/json/list", { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return -1;
    const list = await res.json();
    if (!Array.isArray(list)) return -1;
    return list.filter((t) => t && t.type === "page").length;
  } catch (e) { return -1; }
}

/**
 * 是不是主窗口这一页 —— 和 src/host/cdp.mjs 的 isMainUrl 同一套判据。
 * 光看前缀会漏掉一件事：app://-/index.html?initialRoute=%2Favatar-overlay 也以前缀开头，
 * 但那是头像浮层，不是用户那扇窗。只数前缀，浮层还活着就会被当成「窗口还在」。
 */
function isMainWindowUrl(url) {
  if (typeof url !== "string" || url.split(/[?#]/, 1)[0] !== "app://-/index.html") return false;
  let route = "";
  try { route = new URL(url).searchParams.get("initialRoute") || ""; } catch (e) { return false; }
  return !/^\/(?:avatar-overlay|detached-window)(?:[/?#]|$)/.test(route);
}

/** 主窗口页面还在不在。CDP 里没有 app://-/index.html 就等于「用户看得见的那扇窗」丢了。 */
async function mainWindowPages(port) {
  try {
    const res = await fetch("http://127.0.0.1:" + port + "/json/list", { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return -1;
    const list = await res.json();
    if (!Array.isArray(list)) return -1;
    return list.filter((t) => t && t.type === "page" && isMainWindowUrl(t.url)).length;
  } catch (e) { return -1; }
}

/**
 * App 自己报的窗口数。走 System Events —— 直接问 App「count of windows」会报 -1708
 * （ChatGPT 的 AppleScript 字典里没有 window 类），这条路实测能拿到数字。
 * 拿不到（没给辅助功能权限）就返回 -1，调用方必须把 -1 当成「不知道」而不是「没有」。
 */
function windowCount(bundle) {
  const name = String(bundle || "").split("/").pop().replace(/\.app$/i, "");
  if (!name) return -1;
  try {
    const out = execFileSync("/usr/bin/osascript", ["-e", 'tell application "System Events" to tell process "' + name + '" to get count of windows'], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000,
    });
    const n = Number(String(out).trim());
    return Number.isFinite(n) ? n : -1;
  } catch (e) { return -1; }
}

/**
 * 等的是「主窗口」，不是「有页面」。
 * 换端口之后 Codex 常常先起 overlay / detached 这类附属窗口，
 * 只判 pageCount>0 会把「主窗还没回来」当成好了 —— 那正是 11-18 那次留下的状态。
 */
async function waitForMainWindow(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await mainWindowPages(port) > 0) return true;
    await sleep(400);
  }
  return (await mainWindowPages(port)) > 0;
}

/** 和 cwe launch 同一条路径：直接带参数起二进制。实测这条能出窗口，open -na 有时不出。 */
function launchBinary(app, port) {
  try {
    const child = spawn(app.bin, ["--remote-debugging-port=" + String(port)], { detached: true, stdio: "ignore" });
    child.once("error", (e) => log("error 直启 Codex 失败: " + (e && e.message || e)));
    child.unref();
    return true;
  } catch (e) {
    log("error 直启 Codex 失败: " + (e && e.message || e));
    return false;
  }
}

async function hostAlive() {
  const rt = readRuntime();
  if (!rt) return false;
  try {
    const res = await fetch(rt.url + "/wallpaper-engine/status", { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch (e) { return false; }
}

function startHost() {
  try {
    const child = spawn(process.execPath, [CWE_BIN, "start", "--detach"], {
      detached: true, stdio: "ignore",
    });
    child.unref();
    return true;
  } catch (e) {
    log("error 无法拉起宿主: " + (e && e.message || e));
    return false;
  }
}

/** 调试端点是否真的在监听 —— 只看 TCP/HTTP，不猜。 */
async function cdpAlive(port) {
  try {
    const res = await fetch("http://127.0.0.1:" + port + "/json/version", { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch (e) { return false; }
}

/**
 * 久跑的裸实例只能提醒，不能动手 —— 那是用户正在写的会话。
 * 走通知中心，比只写进 watch.log 有用；通知失败也不该让看门人死掉。
 */
function notify(title, body) {
  try {
    const child = spawn("/usr/bin/osascript", [
      "-e", "on run argv",
      "-e", "display notification (item 2 of argv) with title (item 1 of argv)",
      "-e", "end run",
      title, body,
    ], { stdio: "ignore", detached: true });
    child.once("error", () => {});
    child.unref();
    return true;
  } catch (e) { return false; }
}

/** 让 App 自己走退出流程（会保存窗口与会话），比直接 SIGTERM 温和。 */
async function gracefulQuit(bundle, pid, timeoutMs) {
  const name = String(bundle || "").split("/").pop().replace(/\.app$/i, "");
  if (name) {
    try {
      execFileSync("/usr/bin/osascript", ["-e", 'tell application "' + name + '" to quit'], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 4000,
      });
    } catch (e) { /* 走信号兜底 */ }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (e) { return true; }
    await sleep(100);
  }
  return quitAndWait(pid, 2000);
}

let lastSwapAt = 0;
let lastHostStartAt = 0;
let lastHostProbeAt = 0;
let lastBareNoteAt = 0;
let lastNoCdpNoteAt = 0;
let notifiedPid = 0;
let lastWindowProbeAt = 0;
let noWindowStrikes = 0;
let lastNoWindowRecoverAt = 0;
let noWindowNoticedPid = 0;

async function tick() {
  const cfg = readConfig();
  const port = Number(cfg.cwePort) || 9333;
  const runtime = readRuntime();
  const chosenPort = runtime?.cdpPortPreferred === port ? runtime.cdpPort || port : port;
  const autoRelaunch = cfg.cweAutoRelaunch !== false;
  const app = autoRelaunch ? findAppBinary() : null;
  const procs = app?.bundle ? listMainProcesses(app.bin) : [];
  const ported = procs.filter((p) => p.hasPort);
  const bare = procs.filter((p) => !p.hasPort);

  // ---- 一、让 Codex 带上调试端口 ----
  if (autoRelaunch && ported.length === 0 && bare.length > 0) {
    const fresh = bare.filter((p) => {
      const sec = etimeToSec(p.etime);
      return sec !== null && sec <= LAUNCH_WINDOW_SEC;
    });
    if (fresh.length > 0) {
      const now = Date.now();
      if (now - lastSwapAt >= SWAP_COOLDOWN_MS) {
        lastSwapAt = now;
        const victim = fresh[0];
        log("info 发现刚启动的 Codex pid=" + victim.pid + "（" + victim.etime + "）没有调试端口，换成带端口的同一份二进制");
        // 退出必须走 App 自己的流程。以前直接 SIGTERM：进程是干净的，窗口状态却没跟着回来，
        // 于是出现了「进程在、CDP 在、/json/list 空数组」这种最难查的状态（2026-11-18 那次）。
        if (await gracefulQuit(app.bundle, victim.pid, GRACEFUL_QUIT_MS)) {
          if (await openWithPort(app, chosenPort)) log("info 已用 --remote-debugging-port=" + chosenPort + " 重新拉起 Codex");
          else log("warn Codex 重开失败，可用 cwe launch 启动");
          // 起来了不算成功，有窗口才算。
          if (!await waitForMainWindow(chosenPort, LAUNCH_WINDOW_WAIT_MS)) {
            log("warn open 之后 " + LAUNCH_WINDOW_WAIT_MS + "ms 内主窗口没回来，改用二进制直启补一次");
            const left = listMainProcesses(app.bin);
            for (const p of left) { try { process.kill(p.pid, "SIGTERM"); } catch (err) {} }
            await sleep(1200);
            launchBinary(app, chosenPort);
            if (await waitForMainWindow(chosenPort, REOPEN_WAIT_MS)) {
              log("info 直启成功，主窗口已回来");
            } else {
              log("error 换了两种起法都没有主窗口，等用户手动开一次 Codex");
              notify("壁纸引擎：Codex 没起来", "自动重开没成功，请手动点一次 Codex。");
            }
          } else {
            log("info 主窗口已回来（页面 " + await pageCount(chosenPort) + " 个）");
          }
        } else {
          log("warn Codex 未在 " + Math.round(GRACEFUL_QUIT_MS / 1000) + " 秒内退出，保留现有进程");
        }
      }
    } else if (Date.now() - lastBareNoteAt > 60000) {
      lastBareNoteAt = Date.now();
      const victim = bare[0];
      log("warn Codex 已在运行但没带调试端口（pid=" + victim.pid + " 已跑 " + victim.etime + "，超过 " + LAUNCH_WINDOW_SEC + " 秒不再自动重启，避免丢内容）。重启一次 Codex 就好。");
      // 只对同一个 pid 提醒一次：用户看得见才算提醒，看得见的渠道是通知中心而不是日志。
      if (notifiedPid !== victim.pid) {
        notifiedPid = victim.pid;
        notify("壁纸引擎：Codex 没带调试端口", "退出 Codex 再点 Dock 重开一次就有壁纸；不想手动，就装上开机自启。");
      }
    }
  }

  // ---- 二、窗口健康：进程在、端口在，但主窗口没了 ----
  // 这种状态下用户看到的就是「Codex 打不开」：点 Dock 没反应，切过去是空的。
  // 判据用 CDP 的结构信息（有没有 app://-/index.html 这个主窗口 page），不用截图，
  // 也不依赖 AppleScript —— 后者在 ChatGPT.app 上时灵时不灵。
  // 只重启一次、带冷却；所有探针都「不知道」时什么都不做，宁可不救也不误杀。
  const wnow = Date.now();
  if (autoRelaunch && ported.length > 0 && wnow - lastWindowProbeAt >= WINDOW_PROBE_MS) {
    lastWindowProbeAt = wnow;
    const main = ported[0];
    const sec = etimeToSec(main.etime);
    const settled = sec !== null && sec > LAUNCH_WINDOW_SEC;
    if (settled) {
      const mains = await mainWindowPages(chosenPort);
      const wins = mains >= 0 ? -1 : windowCount(app.bundle);
      const lost = mains === 0 || wins === 0;
      if (lost) {
        noWindowStrikes += 1;
        if (noWindowNoticedPid !== main.pid) {
          noWindowNoticedPid = main.pid;
          log("warn Codex pid=" + main.pid + " 在跑但没有主窗口（没有 app://-/index.html；第 " + noWindowStrikes + " 次）");
        }
        if (noWindowStrikes >= NO_WINDOW_STRIKES && wnow - lastNoWindowRecoverAt >= NO_WINDOW_RECOVER_COOLDOWN_MS) {
          lastNoWindowRecoverAt = wnow;
          noWindowStrikes = 0;
          log("warn 连续 " + NO_WINDOW_STRIKES + " 次没有主窗口，重开一次 Codex 把窗口拿回来");
          if (await gracefulQuit(app.bundle, main.pid, GRACEFUL_QUIT_MS)) {
            launchBinary(app, chosenPort);
            if (await waitForMainWindow(chosenPort, REOPEN_WAIT_MS)) {
              log("info 窗口已恢复（页面 " + await pageCount(chosenPort) + " 个）");
            } else {
              log("error 重开后仍然没有窗口，等用户手动开一次 Codex");
              notify("壁纸引擎：Codex 窗口没起来", "自动重开没成功，请手动点一次 Codex。");
            }
          } else {
            log("warn Codex 没在 " + Math.round(GRACEFUL_QUIT_MS / 1000) + " 秒内退出，这次不动它");
          }
        }
      } else if (noWindowStrikes > 0) {
        noWindowStrikes = 0;
        noWindowNoticedPid = 0;
        log("info 主窗口回来了（主窗口 page " + mains + " 个），窗口计数清零");
      }
    }
  }

  // ---- 三、看守宿主 ----
  // 这里的顺序不能反：宿主是「连上 CDP 主窗口」才有意义的东西。
  // Codex 没端口时先拉宿主，等于每 8 秒制造一次「起来→连不上→退出」的空转
  // （历史 watch.log 里那 8 条连拉就是这么来的）。所以先问 CDP 在不在。
  const now = Date.now();
  if (now - lastHostProbeAt >= HOST_PROBE_MS) {
    lastHostProbeAt = now;
    if (now - lastHostStartAt >= HOST_START_COOLDOWN_MS && !await hostAlive()) {
      if (!await cdpAlive(chosenPort)) {
        if (now - lastNoCdpNoteAt > NO_CDP_NOTE_MS) {
          lastNoCdpNoteAt = now;
          log("info 调试端口 " + chosenPort + " 上没有端点，宿主起来了也连不上主窗口，先不拉（等 Codex 带上端口）");
        }
      } else {
        lastHostStartAt = now;
        log("info 宿主没响应，拉起一个：cwe start --detach");
        startHost();
      }
    }
  }
}

async function main() {
  if (process.platform !== "darwin") {
    log("warn 本看守只为 macOS 的 Codex 设计（Dock 启动无法附加参数），当前平台 " + process.platform + "，退出");
    return;
  }
  rotate();
  log("info 看门人启动 pid=" + process.pid + "，轮询 " + TICK_MS + "ms");
  for (;;) {
    try { await tick(); } catch (e) { log("error tick: " + (e && e.message || e)); }
    await sleep(TICK_MS);
  }
}

main();
