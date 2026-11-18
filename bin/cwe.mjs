#!/usr/bin/env node
/**
 * bin/cwe.mjs —— 命令行入口
 *
 *   cwe start [--port 9333] [--verbose]     起守护（前台，Ctrl-C 退出）
 *   cwe start --detach                      起守护（后台）
 *   cwe stop                                停守护
 *   cwe status [--json]                     看守护状态与页面挂载情况
 *   cwe check [--port N] [--json]            检查当前 Codex 窗口的适配情况
 *   cwe list [--type video|image] 列壁纸
 *   cwe use <id>                            换壁纸
 *   cwe set key=value ...                   改配置
 *   cwe get [key]                           读配置
 *   cwe reset                               恢复默认
 *   cwe upload <file> [--title ...]         上传壁纸
 *   cwe remove <id>                         删上传壁纸
 *   cwe panel                               在页面里打开设置面板
 *   cwe launch [--profile dir] [--port N]   以调试端口启动 Codex
 *   cwe uninstall                           从页面移除一切注入
 *   cwe log [-n 80]                         看日志尾巴
 *
 * 约定：失败 exit 1，成功 exit 0；--json 给程序看，默认给人看。
 */

import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, openSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const { startDaemon, readRuntime, clearRuntime, desiredCdpPort, RUNTIME_PATH, LOG_PATH, PID_PATH } =
  await import("../src/host/daemon.mjs");
const { getConfig, loadConfig, updateConfig, resetConfig, CONFIG_PATH } = await import("../src/host/config.mjs");
const { ensureDataDirs } = await import("../src/host/data-dir.mjs");
const { findAppBinary, describeSearch } = await import("../src/host/app-path.mjs");
const { pickCdpPort, describePick } = await import("../src/host/port-pick.mjs");

const argv = process.argv.slice(2);
const cmd = argv[0] || "help";
const rest = argv.slice(1);

function flag(name) { return rest.includes("--" + name); }
function opt(name, dflt = null) {
  const i = rest.indexOf("--" + name);
  if (i < 0) return dflt;
  const v = rest[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
function positional() {
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) { if (rest[i + 1] && !rest[i + 1].startsWith("--")) i++; continue; }
    out.push(a);
  }
  return out;
}
const say = (...a) => console.log(...a);
const die = (msg, code = 1) => { console.error(msg); process.exit(code); };
const j = (o) => JSON.stringify(o, null, 2);

function base() {
  const rt = readRuntime();
  if (!rt) die("守护没在跑（找不到 " + RUNTIME_PATH + "）。先执行 cwe start。");
  return rt;
}

async function callApi(path, opts = {}) {
  const rt = base();
  const res = await fetch(rt.url + "/wallpaper-engine" + path, opts);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { ok: res.ok, raw: text.slice(0, 400) }; }
}

/* ═════════ start ═════════ */

async function cmdStart() {
  ensureDataDirs();
  const wantPort = opt("port");
  const verbose = flag("verbose") || flag("v");

  if (flag("detach")) {
    // 单实例闸门：看守（cwe-watch）和我手动 start 会各拉一个，两个守护抢同一份
    // runtime.json，页面被注入两遍、端口一会儿变一个。起之前先探一次：活着就复用。
    const live = readRuntime();
    if (live && live.pid) {
      try {
        const res = await fetch(live.url + "/wallpaper-engine/status", { signal: AbortSignal.timeout(1200) });
        if (res.ok) {
          say("守护已经在跑 pid=" + live.pid + "  " + live.url + "（" + (live.version || "?") + "），不再起第二个。");
          say("要重启就先 cwe stop。");
          return 0;
        }
      } catch (e) { /* 探不到就当它死了，继续起 */ }
    }
    const out = openSync(LOG_PATH, "a");
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "start", ...(wantPort ? ["--port", String(wantPort)] : [])], {
      detached: true,
      stdio: ["ignore", out, out],
      cwd: ROOT,
    });
    child.unref();
    say("守护已在后台启动 pid=" + child.pid);
    say("日志：" + LOG_PATH);
    say("用 cwe status 看它起来没有。");
    return 0;
  }

  const d = await startDaemon({ port: wantPort || null, verbose });
  say("宿主 " + d.url + "  （端口 " + d.port + "）");
  say("注入目标 127.0.0.1:" + (Number(wantPort) || d.config.cwePort || 9333));
  say("配置 " + CONFIG_PATH);
  say("日志 " + LOG_PATH);
  say("");
  say("按 Ctrl-C 退出。");

  let stopping = false;
  const stop = async (sig) => {
    if (stopping) return;
    stopping = true;
    say("\n[" + sig + "] 退出中…");
    await d.close();
    process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  await new Promise(() => {});
  return 0;
}

/* ═════════ stop ═════════ */

async function cmdStop() {
  const rt = readRuntime();
  let pid = rt && rt.pid ? rt.pid : null;
  if (!pid && existsSync(PID_PATH)) {
    try { pid = Number(readFileSync(PID_PATH, "utf8").trim()) || null; } catch { pid = null; }
  }
  if (!pid) { say("没有在跑的守护。"); clearRuntime(); return 0; }
  try {
    process.kill(pid, "SIGTERM");
    say("已发 SIGTERM 给 pid " + pid);
  } catch (e) {
    say("pid " + pid + " 已经不在了（" + (e && e.code) + "）");
  }
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (!readRuntime()) break;
  }
  clearRuntime();
  say("守护已停。");
  return 0;
}

/* ═════════ status ═════════ */

async function cmdStatus() {
  const rt = readRuntime();
  loadConfig({ migrate: false });
  const cfg = getConfig();
  const asJson = flag("json");

  if (!rt) {
    const out = { running: false, cdpPort: desiredCdpPort(), configPath: CONFIG_PATH };
    if (asJson) say(j(out));
    else {
      say("守护：没在跑");
      say("CDP 端口（配置）：" + out.cdpPort);
      say("配置：" + CONFIG_PATH);
    }
    return 0;
  }

  let alive = false, inv = null, page = null;
  try {
    const r = await fetch(rt.url + "/wallpaper-engine/status", { signal: AbortSignal.timeout(2500) });
    inv = await r.json();
    alive = true;
  } catch { alive = false; }

  try {
    const { probePort, connectMain } = await import("../src/host/cdp.mjs");
    const pr = await probePort(rt.cdpPort || 9333);
    if (pr) {
      const { cdp } = await connectMain(rt.cdpPort || 9333, { timeoutMs: 4000 });
      try {
        page = await cdp.eval("window.__CWE ? window.__CWE.report() : null", { returnByValue: true, timeoutMs: 4000 });
      } finally {
        cdp.close();
      }
    }
  } catch { page = null; }

  const out = {
    running: alive,
    host: { port: rt.port, url: rt.url, pid: rt.pid, startedAt: rt.startedAt, version: rt.version },
    cdpPort: rt.cdpPort,
    page,
    inventory: inv ? { total: inv.inventoryTotal, wallpapers: inv.inventoryTotal, counters: inv.stats } : null,
    config: { id: cfg.id, cweEnabled: cfg.cweEnabled, uiAlpha: cfg.cweUiAlpha, uiAlphaMain: cfg.cweUiAlphaMain },
    configPath: CONFIG_PATH,
  };
  if (asJson) { say(j(out)); return 0; }

  say("守护：" + (alive ? "在跑" : "进程活着但 HTTP 不通"));
  say("  宿主     " + rt.url + "  (pid " + rt.pid + (rt.version ? " · " + rt.version : "") + ")");
  say("  页面注入 " + (page && page.mounted ? "已挂上 · " + (page.kind || "-") + " · 不透明度 " + page.opacity + "%" : "未挂上"));
  if (page?.mediaStatus === "loading") say("  媒体     正在加载");
  if (page?.mediaStatus === "failed") say("  媒体     加载失败" + (page.hasMedia ? "，继续显示上一张" : "，使用原生界面"));
  if (page && page.url) say("  壁纸     " + page.url);
  say("CDP 端口 " + rt.cdpPort);
  say("配置     " + CONFIG_PATH);
  return 0;
}

async function cmdCheck() {
  const port = Number(opt("port") ?? readRuntime()?.cdpPort ?? 9333);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || opt("port") === true) {
    die("用法：cwe check [--port N] [--json]");
  }
  const { connectMain, probePort, mainWindowExpression } = await import("../src/host/cdp.mjs");
  const { runtimeExpression } = await import("../src/host/injector.mjs");
  const engine = await probePort(port);
  const out = { ok: false, port, browser: engine?.browser || null };
  if (!engine) {
    out.error = "没有调试端点";
  } else {
    try {
      const { cdp } = await connectMain(port, { timeoutMs: 3000 });
      try {
        const expression = mainWindowExpression() +
          " ? " + runtimeExpression({ compatProbe: true }) + " : null";
        const report = await cdp.eval(expression, { timeoutMs: 5000 });
        if (report) Object.assign(out, report, { ok: report.shellReady });
        else out.error = "主窗口正在切换文档";
      } finally {
        cdp.close();
      }
    } catch (e) {
      out.error = e.message;
    }
  }
  const app = findAppBinary();
  if (process.platform === "darwin" && app?.bundle) {
    try {
      out.installedVersion = execFileSync("/usr/libexec/PlistBuddy", [
        "-c", "Print :CFBundleShortVersionString", join(app.bundle, "Contents", "Info.plist"),
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim();
    } catch {}
  }

  if (flag("json")) say(j(out));
  else {
    say("Codex " + (out.installedVersion || "版本未知") + " · " + (out.browser || "无 CDP") + " · 端口 " + port);
    if (out.error) say(out.error);
    else {
      say("主界面 " + (out.shellReady ? "已识别" : "尚未识别") + " · 文档 " + out.readyState);
      say("背景模糊 " + (out.backdropFilter ? "支持" : "使用实色回退"));
      say("当前窗口可见/匹配数  " + Object.entries(out.matches).map(([name, hits]) =>
        name + " " + hits.visible + "/" + hits.total).join(" · "));
    }
  }
  return out.ok ? 0 : 1;
}

/* ═════════ list / use / set / get / reset ═════════ */

async function cmdList() {
  const inv = await callApi("/inventory");
  const type = opt("type");
  let ws = inv.wallpapers || [];
  if (type && type !== true) ws = ws.filter((w) => w.type === type);
  if (flag("json")) { say(j(ws)); return 0; }
  loadConfig({ migrate: false });
  const cfg = getConfig();
  say("共 " + ws.length + " 条（清单总数 " + (inv.total || 0) + "）");
  for (const w of ws) {
    const mark = w.id === cfg.id ? "*" : " ";
    say(mark + " " + String(w.type).padEnd(6) + " " + String(w.id).padEnd(26) + " " + (w.title || ""));
  }
  say("");
  say("带 * 的是当前壁纸。换：cwe use <id>");
  return 0;
}

async function cmdUse() {
  const id = positional()[0];
  if (!id) die("用法：cwe use <id>（先用 cwe list 看有哪些）");
  const r = await callApi("/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!r || !r.ok) die("换壁纸失败：" + JSON.stringify(r).slice(0, 300));
  say("已换成 " + r.config.id);
  return 0;
}

function parseVal(raw) {
  const t = raw.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith("[") && t.endsWith("]")) || (t.startsWith("{") && t.endsWith("}"))) {
    try { return JSON.parse(t); } catch { return raw; }
  }
  return raw;
}

async function cmdSet() {
  const kvs = positional();
  if (!kvs.length) die("用法：cwe set key=value [key=value ...]");
  const patch = {};
  for (const kv of kvs) {
    const i = kv.indexOf("=");
    if (i <= 0) die("这不像 key=value：" + kv);
    patch[kv.slice(0, i)] = parseVal(kv.slice(i + 1));
  }
  const r = await callApi("/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r || !r.ok) die("保存失败：" + JSON.stringify(r).slice(0, 300));
  for (const k of Object.keys(patch)) {
    const a = JSON.stringify(patch[k]), b = JSON.stringify(r.config[k]);
    say(k + " = " + b + (a === b ? "" : "   （宿主钳制，提交的是 " + a + "）"));
  }
  return 0;
}

async function cmdGet() {
  const key = positional()[0];
  const r = await callApi("/settings");
  if (key) { say(j(r.config ? r.config[key] : null)); return 0; }
  say(j(r.config));
  return 0;
}

async function cmdReset() {
  const r = await callApi("/settings", { method: "DELETE" });
  if (!r || !r.ok) die("恢复默认失败：" + JSON.stringify(r).slice(0, 300));
  say("已恢复默认。");
  return 0;
}

/* ═════════ upload / remove ═════════ */

async function cmdUpload() {
  const file = positional()[0];
  if (!file) die("用法：cwe upload <图片或视频>");
  const abs = resolve(file);
  if (!existsSync(abs)) die("找不到文件：" + abs);
  const title = opt("title");
  const q = "/upload?name=" + encodeURIComponent(abs.split("/").pop()) +
    (title && title !== true ? "&title=" + encodeURIComponent(title) : "");
  const rt = base();
  const body = readFileSync(abs);
  const res = await fetch(rt.url + "/wallpaper-engine" + q, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body,
  });
  const r = await res.json().catch(() => ({}));
  if (!r || !r.ok) die("上传失败：" + JSON.stringify(r).slice(0, 300));
  say("已上传 " + (r.id || "") + "  (" + Math.round(body.length / 1024) + " KB)");
  return 0;
}

async function cmdRemove() {
  const id = positional()[0];
  if (!id) die("用法：cwe remove <id>");
  const r = await callApi("/remove", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!r || !r.ok) die("删除失败：" + JSON.stringify(r).slice(0, 300));
  say("已删 " + id);
  return 0;
}

/* ═════════ panel / uninstall ═════════ */

async function withPage(fn) {
  const rt = base();
  const { connectMain } = await import("../src/host/cdp.mjs");
  const { cdp } = await connectMain(rt.cdpPort || 9333, { timeoutMs: 6000 });
  try { return await fn(cdp); } finally { cdp.close(); }
}

async function cmdPanel() {
  const out = await withPage((cdp) =>
    cdp.eval("window.__CWE && window.__CWE.panel ? (window.__CWE.panel.show(), 'ok') : 'no-panel'", { returnByValue: true }));
  if (out === "no-panel") die("页面里没有面板（守护还没注入？先 cwe status）。");
  say("面板已打开（⌥⌘W 也可以）。");
  return 0;
}

async function cmdUninstall() {
  const out = await withPage((cdp) =>
    cdp.eval("window.__CWE ? (window.__CWE.unmount(), 'ok') : 'nothing'", { returnByValue: true }));
  say(out === "ok" ? "已从页面移除。" : "页面里本来就没有注入。");
  return 0;
}

/* ═════════ launch ═════════ */

async function cmdLaunch() {
  const app = findAppBinary();
  if (!app) {
    say("找不到 Codex 的可执行文件。找过这些位置：");
    describeSearch().forEach(function (p) { say("  " + p); });
    say("");
    say("装在别处就显式指定：CWE_APP_BIN=/path/to/Codex cwe launch");
    return 1;
  }

  // 端口要先挑：不挑的话 Codex 可能因为端口被占而根本没开 CDP，
  // 之后所有「注入失败」都只是这个原因的回声。
  const preferred = Number(opt("port") || desiredCdpPort());
  const pick = await pickCdpPort(preferred);
  if (pick.state === "cdp") {
    say("这个端口上已经有一个调试端点在跑了（" + pick.port + "）。");
    say("要是 Codex 已经开着，直接用 cwe status；要重开请先退出它。");
    return 0;
  }
  const port = pick.port;
  const profile = opt("profile");

  const args = ["--remote-debugging-port=" + String(port)];
  if (profile && profile !== true) args.push("--user-data-dir=" + resolve(profile));

  const child = spawn(app.bin, args, { detached: true, stdio: "ignore" });
  child.unref();
  say("已启动 Codex pid=" + child.pid + "  " + app.bin);
  say("  " + describePick(pick, preferred));
  if (profile && profile !== true) say("  用户目录 " + resolve(profile));
  if (port !== preferred) say("  提示：配置里的 cwePort 是 " + preferred + "，被别的程序占着；想固定就用 cwe set cwePort=" + port);
  say("等两秒再 cwe status 看注入接上没有。");
  return 0;
}

/* ═════════ rotation ═════════ */

/** 轮播组：status / new / use / rm / set / add / remove / on / off。 */
async function cmdRotation() {
  const sub = argv[1] || "status";
  // callApi 直接返回解析后的响应体（见 cmdList 的 inv.wallpapers），不是 {ok, body}
  const s = await callApi("/settings");
  const cfg = (s && s.config) || {};
  let groups = Array.isArray(cfg.rotationGroups) ? cfg.rotationGroups.map((g) => Object.assign({}, g)) : [];

  const save = async (body) => {
    const r = await callApi("/settings", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    if (!r || r.ok === false) die("宿主拒绝：" + JSON.stringify(r).slice(0, 300));
    return r.config;
  };
  const find = (id) => groups.find((g) => g.id === id);

  if (sub === "status" || sub === "ls") {
    const inv = await callApi("/inventory");
    const byId = new Map(((inv && inv.wallpapers) || []).map((w) => [w.id, w]));
    say("自动轮换：" + (cfg.rotationEnabled ? "开" : "关") +
        "  当前组 " + (cfg.rotationGroupId || "（未选）") +
        "  " + groups.length + " 组");
    groups.forEach((g) => {
      const ids = Array.isArray(g.wallpaperIds) ? g.wallpaperIds : [];
      const missing = ids.filter((id) => !byId.has(id)).length;
      say("  " + (g.id === cfg.rotationGroupId ? "* " : "  ") + g.id +
          "  " + (g.name || "") +
          "  " + ids.length + " 张" +
          "  每 " + g.interval + " 分钟" +
          "  " + (g.order === "random" ? "随机" : "顺序") +
          "  " + (g.trigger === "videoEnd" ? "视频播完就换" : "按间隔") +
          (missing ? "  ⚠ " + missing + " 张找不到" : ""));
    });
    return 0;
  }

  if (sub === "new") {
    const g = {
      id: "grp-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
      name: opt("name") && opt("name") !== true ? String(opt("name")) : "轮播列表 " + (groups.length + 1),
      interval: Number(opt("interval") || cfg.rotationInterval || 30),
      order: opt("order") === "random" ? "random" : "sequence",
      trigger: opt("trigger") === "videoEnd" ? "videoEnd" : "interval",
      wallpaperIds: [],
    };
    groups.push(g);
    await save({ rotationGroups: groups, rotationGroupId: g.id });
    say("已建 " + g.id + "（" + g.name + "，每 " + g.interval + " 分钟），并设为当前组。");
    return 0;
  }

  // argv[0] 是子命令本身（rotation 已被 cmd 吃掉），组 id 在 argv[2]。
  // 这里曾经写成 argv[1]，于是 set/add/remove/use/rm 全把子命令名当成组 id。
  const id = argv[2] || "";
  if (sub === "on" || sub === "off") {
    const c = await save({ rotationEnabled: sub === "on" });
    say("自动轮换已" + (c.rotationEnabled ? "打开" : "关闭"));
    return 0;
  }

  if (sub === "use") {
    if (!find(id)) die("没有这一组：" + id);
    await save({ rotationGroupId: id });
    say("当前组 → " + id);
    return 0;
  }
  if (sub === "rm" || sub === "delete") {
    const at = groups.findIndex((g) => g.id === id);
    if (at < 0) die("没有这一组：" + id);
    groups.splice(at, 1);
    const body = { rotationGroups: groups };
    if (cfg.rotationGroupId === id) body.rotationGroupId = groups[0] ? groups[0].id : "";
    await save(body);
    say("已删除 " + id);
    return 0;
  }
  if (sub === "set") {
    const g = find(id);
    if (!g) die("没有这一组：" + id);
    // 剩余参数形如 key=value；只认 name / interval / order / trigger
    for (const raw of argv.slice(2)) {
      const eq = raw.indexOf("=");
      if (eq < 0) continue;
      const k = raw.slice(0, eq);
      const v = raw.slice(eq + 1);
      if (k === "interval") g.interval = Number(v);
      else if (k === "order") g.order = v === "random" ? "random" : "sequence";
      else if (k === "trigger") g.trigger = v === "videoEnd" ? "videoEnd" : "interval";
      else if (k === "name") g.name = v;
    }
    const c = await save({ rotationGroups: groups });
    const after = (c.rotationGroups || []).find((x) => x.id === id) || g;
    say(after.id + "  " + after.name + "  " + after.interval + " 分钟  " + after.order + "  " + after.trigger);
    return 0;
  }
  if (sub === "add" || sub === "remove") {
    const g = find(id);
    if (!g) die("没有这一组：" + id);
    const wid = argv[3];
    if (!wid) die("用法：cwe rotation " + sub + " <组id> <壁纸id>");
    const ids = Array.isArray(g.wallpaperIds) ? g.wallpaperIds.slice() : [];
    const at = ids.indexOf(wid);
    if (sub === "add") { if (at < 0) ids.push(wid); }
    else if (at >= 0) ids.splice(at, 1);
    g.wallpaperIds = ids;
    await save({ rotationGroups: groups });
    say(g.id + " 现在有 " + ids.length + " 张");
    return 0;
  }

  say("用法：cwe rotation [status|new|use <id>|rm <id>|set <id> k=v ...|add <id> <wid>|remove <id> <wid>|on|off]");
  return 1;
}

/* ═════════ preset ═════════ */

async function cmdPreset() {
  const sub = argv[1] || "ls";
  // callApi 直接返回响应体，不是 {ok, body}（同 cmdRotation 的注释）。
  const pos = positional();
  const arg1 = pos[1]; // pos[0] 是子命令本身

  if (sub === "ls" || sub === "list" || sub === "status") {
    const r = await callApi("/presets");
    const list = (r && r.presets) || [];
    if (flag("json")) { say(j(list)); return 0; }
    const cur = (r && r.current) || {};
    say("外观预设 " + list.length + " 套（改动即时生效）");
    list.forEach((x) => {
      say("  " + (x.builtin ? "随包" : "自建") + "  " + x.id + "  " + (x.name || "") +
          "  " + ((x.keys && x.keys.length) || x.keys || 0) + " 个键");
    });
    say("\n当前壁纸不透明度 " + cur.wallpaperOpacity + "%  界面 α " + cur.cweUiAlpha);
    return 0;
  }

  if (sub === "save" || sub === "add") {
    const nm = opt("name") && opt("name") !== true ? String(opt("name")) : "我的观感 " + new Date().toLocaleString("zh-CN");
    const r = await callApi("/presets", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: nm }),
    });
    if (!r || r.ok === false) die("保存失败：" + j(r).slice(0, 300));
    say("已保存 " + r.preset.id + "（" + r.preset.name + "，" + r.preset.keys + " 个键）");
    return 0;
  }

  if (sub === "use" || sub === "apply") {
    if (!arg1) die("用法：cwe preset use <id>");
    const r = await callApi("/presets/" + encodeURIComponent(arg1) + "/apply", { method: "POST" });
    if (!r || r.ok === false) die("应用失败：" + j(r).slice(0, 300));
    say("已应用 " + arg1 + "（改了 " + Object.keys(r.applied || {}).length + " 个外观键）");
    return 0;
  }

  if (sub === "rm" || sub === "remove" || sub === "delete") {
    if (!arg1) die("用法：cwe preset rm <id>");
    const r = await callApi("/presets/" + encodeURIComponent(arg1), { method: "DELETE" });
    if (!r || r.ok === false) {
      die(r && r.builtin ? "随包预设删不掉（" + arg1 + "）。想改它就先调好外观再 cwe preset save。" : "删除失败：" + j(r).slice(0, 300));
    }
    say("已删除 " + arg1);
    return 0;
  }

  if (sub === "export" || sub === "dump") {
    if (!arg1) die("用法：cwe preset export <id> [--out file.json]");
    const r = await callApi("/presets/" + encodeURIComponent(arg1) + "/export");
    if (!r || r.ok === false) die("导出失败：" + j(r).slice(0, 300));
    const out = opt("out");
    const text = JSON.stringify(r, null, 2);
    if (out && out !== true) {
      // 直接写盘：导出是「拿到一个可分享的文件」，不该逼人从终端里复制。
      const { writeFileSync } = await import("node:fs");
      writeFileSync(resolve(String(out)), text);
      say("已写出 " + resolve(String(out)));
    } else {
      say(text);
    }
    return 0;
  }

  if (sub === "import") {
    const file = arg1;
    if (!file) die("用法：cwe preset import <file.json> [--name 名字]");
    const { readFileSync } = await import("node:fs");
    const abs = resolve(file);
    if (!existsSync(abs)) die("找不到文件：" + abs);
    let doc;
    try { doc = JSON.parse(readFileSync(abs, "utf8")); } catch (e) { die("不是合法 JSON：" + e.message); }
    const nm = opt("name") && opt("name") !== true ? String(opt("name")) : (doc.name || file);
    const r = await callApi("/presets/import", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: doc, name: nm, apply: !flag("no-apply") }),
    });
    if (!r || r.ok === false) die("导入失败：" + j(r).slice(0, 300));
    say("已导入 " + r.preset.id + "（" + r.preset.name + "）" +
        (r.ignoredKeys && r.ignoredKeys.length ? "，忽略 " + r.ignoredKeys.length + " 个非外观键" : "") +
        (flag("no-apply") ? "，未应用" : "，已应用"));
    return 0;
  }

  die("未知子命令：" + sub + "\n可用：ls | save [--name X] | use <id> | rm <id> | export <id> [--out f] | import <f.json>");
}

/* ═════════ log ═════════ */

function cmdLog() {
  const n = Number(opt("n") || 80);
  if (!existsSync(LOG_PATH)) die("还没有日志：" + LOG_PATH);
  const lines = readFileSync(LOG_PATH, "utf8").split("\n").filter(Boolean);
  say(lines.slice(-n).join("\n"));
  return 0;
}

/* ═════════ help ═════════ */

function cmdHelp() {
  say("codex-wallpaper-engine");
  say("");
  say("  cwe start [--port 9333] [--detach] [--verbose]   起守护");
  say("  cwe stop                                         停守护");
  say("  cwe status [--json]                              看状态");
  say("  cwe check [--port N] [--json]                    查看 Codex 版本与当前页面的适配命中");
  say("  cwe list [--type video|image] [--json] 列壁纸");
  say("  cwe use <id>                                     换壁纸");
  say("  cwe set key=value ...                            改配置");
  say("  cwe get [key]                                    读配置");
  say("  cwe reset                                        恢复默认");
  say("  cwe upload <file> [--title ...]                  上传壁纸");
  say("  cwe remove <id>                                  删上传");
  say("  cwe panel                                        打开设置面板");
  say("  cwe launch [--profile dir] [--port 9333]         带调试端口启动 Codex");
  say("  cwe autostart on|off|status                      开机自启（点 Dock 启动也带壁纸）");
  say("  cwe uninstall                                    移除注入");
  say("  cwe rotation status                              看轮播组");
  say("  cwe rotation new [--name X] [--interval 30]      新建轮播组");
  say("  cwe rotation use <组id>                          切当前组");
  say("  cwe rotation set <组id> interval=30 order=random 改组参数");
  say("  cwe rotation add|remove <组id> <壁纸id>          增减成员");
  say("  cwe rotation on|off                              开关自动轮换");
  say("  cwe preset ls                                    列外观预设");
  say("  cwe preset save [--name X]                       把当前观感存成预设");
  say("  cwe preset use <id>                              应用预设");
  say("  cwe preset rm <id>                               删自建预设");
  say("  cwe preset export <id> [--out f.json]            导出预设");
  say("  cwe preset import <f.json> [--name X]            导入并应用");
  say("  cwe log [-n 80]                                  看日志");
  return 0;
}

/* ═════════ autostart ═════════ */

const LAUNCH_AGENTS = join(homedir(), "Library", "LaunchAgents");
const PLIST_LABEL = "com.codexwallpaper.engine.watch";
const PLIST_PATH = join(LAUNCH_AGENTS, PLIST_LABEL + ".plist");
const WATCH_SCRIPT = join(HERE, "cwe-watch.mjs");

function plistXml(nodePath) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    '  <string>' + PLIST_LABEL + '</string>',
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>' + nodePath + '</string>',
    '    <string>' + WATCH_SCRIPT + '</string>',
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>ThrottleInterval</key>',
    '  <integer>10</integer>',
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PATH</key>',
    '    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>',
    '  </dict>',
    '  <key>StandardOutPath</key>',
    '  <string>' + join(DATA_DIR_FOR_PLIST(), "watch.launchd.log") + '</string>',
    '  <key>StandardErrorPath</key>',
    '  <string>' + join(DATA_DIR_FOR_PLIST(), "watch.launchd.log") + '</string>',
    '</dict>',
    '</plist>',
    "",
  ].join("\n");
}

function DATA_DIR_FOR_PLIST() {
  return process.env.CWE_DATA_DIR || join(homedir(), ".codex-wallpaper-engine");
}

function launchctl(args) {
  // stdio 必须显式给 pipe：execFileSync 默认会把子进程 stderr 直接继承到终端，
  // 于是 "unload 一个本来就没加载的 plist" 这种预期内失败会把
  //   Unload failed: 5: Input/output error / Try running `launchctl bootout` as root
  // 当成噪音打到用户脸上。这里全部收进返回值，由调用方决定要不要展示。
  try {
    return execFileSync("/bin/launchctl", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    return String(((e && e.stderr) || "") + ((e && e.stdout) || "")).trim();
  }
}

/** plist 是否已经被 launchd 接管。unload 之前必须先问，未加载时 unload 必失败。 */
function plistLoaded() {
  const out = launchctl(["list"]);
  return out.split("\n").some(function (line) {
    return line.trim().split(/\s+/).pop() === PLIST_LABEL;
  });
}

/** 只有在真的加载过的时候才 unload，避免无意义失败与噪音。 */
function unloadIfLoaded() {
  if (!plistLoaded()) return false;
  launchctl(["unload", "-w", PLIST_PATH]);
  return true;
}

// 找出真正在跑的看门人进程。
// 不能只 grep "cwe-watch.mjs" —— 包住本命令的 shell（bash -c "... cwe-watch.mjs ..."）命令行里
// 也含这个字符串，会被数成「来自其它副本的看门人」，status 因此误报。
// 判据收紧成：第一个 token 是 node，最后一个 token 就是那个脚本路径。
function watchProcesses() {
  const out = { running: false, foreign: 0, pids: [] };
  let ps = "";
  try {
    ps = execFileSync("/bin/ps", ["-Ao", "pid=,command="], { encoding: "utf8" });
  } catch (e) {
    return out;
  }
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const argv = m[2].trim().split(/\s+/);
    if (argv.length < 2) continue;
    const exe = argv[0];
    const script = argv[argv.length - 1];
    if (!/\bnode(\d+)?$/.test(exe) && !/\/node$/.test(exe)) continue;
    if (!/cwe-watch\.mjs$/.test(script)) continue;
    out.pids.push(pid);
    if (script === WATCH_SCRIPT) out.running = true;
    else out.foreign += 1;
  }
  return out;
}

function autostartStatus() {
  const installed = existsSync(PLIST_PATH);
  const loaded = plistLoaded();
  const procs = watchProcesses();
  return {
    installed: installed,
    loaded: loaded,
    running: procs.running,
    foreign: procs.foreign,
    pids: procs.pids,
    plist: PLIST_PATH,
    script: WATCH_SCRIPT,
  };
}

function cmdAutostart() {
  const sub = (rest[0] || "status").toLowerCase();
  const nodePath = process.execPath;

  if (sub === "on" || sub === "enable" || sub === "install") {
    if (process.platform !== "darwin") die("autostart 只支持 macOS（其它平台用 cwe launch 起 Codex）");
    if (!existsSync(WATCH_SCRIPT)) die("找不到看门人脚本：" + WATCH_SCRIPT);
    if (!existsSync(LAUNCH_AGENTS)) {
      try { mkdirSync(LAUNCH_AGENTS, { recursive: true }); }
      catch (e) { die("建不了 " + LAUNCH_AGENTS + "：" + (e && e.message || e)); }
    }
    ensureDataDirs();
    writeFileSync(PLIST_PATH, plistXml(nodePath), "utf8");
    // 先卸再装：重复 on 不该堆出第二个实例。没加载过就不卸，省掉一条预期内的失败。
    unloadIfLoaded();
    const out = launchctl(["load", "-w", PLIST_PATH]);
    const st = autostartStatus();
    if (!st.loaded && !st.running) {
      say("写了 plist 但 launchctl 没装上：" + (out || "（无输出）"));
      say("可以手动跑一次：launchctl load -w " + PLIST_PATH);
      return 1;
    }
    // 立刻把守护也拉起来，别等用户下次点 Codex
    try {
      const rt = readRuntime();
      if (!rt) {
        const child = spawn(process.execPath, [join(HERE, "cwe.mjs"), "start", "--detach"], { detached: true, stdio: "ignore" });
        child.unref();
      }
    } catch (e) {}
    say("已开启开机自启");
    say("  看门人  " + WATCH_SCRIPT);
    say("  配置    " + PLIST_PATH);
    say("  日志    " + join(DATA_DIR_FOR_PLIST(), "watch.log"));
    say("");
    say("点 Dock 启动时，看门人会在进程刚出现时尝试补调试端口。");
    return 0;
  }

  if (sub === "off" || sub === "disable" || sub === "uninstall") {
    if (process.platform !== "darwin") die("autostart 只支持 macOS");
    if (existsSync(PLIST_PATH)) {
      unloadIfLoaded();
      try { unlinkSync(PLIST_PATH); } catch (e) {}
    }
    // 用严格匹配，别把包住本命令的 shell 一起 SIGTERM 掉
    for (const pid of watchProcesses().pids) {
      try { process.kill(pid, "SIGTERM"); } catch (e) {}
    }
    say("已关闭开机自启（壁纸本身不受影响，只是启动 Codex 不再自动带端口）");
    return 0;
  }

  // status
  const st = autostartStatus();
  say("开机自启：" + (st.installed && st.loaded ? "已开启" : st.installed ? "装了但没加载" : "未开启"));
  say("  看门人进程  " + (st.running ? "在跑" : "没跑") + (st.foreign ? "（另有 " + st.foreign + " 个来自其它副本的看门人在跑）" : ""));
  say("  plist       " + st.plist + (existsSync(st.plist) ? "" : "（不存在）"));
  say("  脚本        " + st.script);
  say("  日志        " + join(DATA_DIR_FOR_PLIST(), "watch.log"));
  return 0;
}
/* ═════════ 分发 ═════════ */

const TABLE = {
  start: cmdStart, stop: cmdStop, status: cmdStatus, check: cmdCheck,
  list: cmdList, ls: cmdList, use: cmdUse, set: cmdSet, get: cmdGet, reset: cmdReset,
  upload: cmdUpload, remove: cmdRemove, panel: cmdPanel, uninstall: cmdUninstall,
  launch: cmdLaunch, log: cmdLog, logs: cmdLog, help: cmdHelp,
  autostart: cmdAutostart, auto: cmdAutostart,
  rotation: cmdRotation, rot: cmdRotation,
  preset: cmdPreset, presets: cmdPreset, look: cmdPreset,
};

const fn = TABLE[cmd] || cmdHelp;
try {
  const code = await fn();
  process.exit(code || 0);
} catch (e) {
  console.error("失败：" + ((e && e.stack) || e));
  process.exit(1);
}
