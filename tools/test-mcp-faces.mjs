#!/usr/bin/env node
/**
 * tools/test-mcp-faces.mjs —— MCP server 的 faces / font 四工具真机 smoke。
 *
 * 为什么用真进程而不是直接 import：MCP server 是 stdio 长驻进程，
 * 只有真跑一遍才能验证 JSON-RPC 分帧、ensureDaemon、以及工具分支的返回值形状。
 * 用法：node tools/test-mcp-faces.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SERVER = join(ROOT, "mcp", "server.mjs");

const child = spawn(process.execPath, [SERVER], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });

let buf = "";
const waiting = new Map();
let nextId = 1;

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const slot = waiting.get(msg.id);
    if (slot) { waiting.delete(msg.id); slot(msg); }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (s) => process.stderr.write("[server] " + s));

function rpc(method, params) {
  const id = nextId++;
  return new Promise((res, rej) => {
    const t = setTimeout(() => { waiting.delete(id); rej(new Error("timeout " + method)); }, 40000);
    waiting.set(id, (msg) => { clearTimeout(t); res(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function payload(msg) {
  const r = msg.result || {};
  const first = r.content && r.content[0];
  const raw = first && first.text;
  try { return { isError: !!r.isError, data: JSON.parse(raw) }; } catch { return { isError: !!r.isError, data: raw }; }
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  " + detail : ""));
}

await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "cwe-test", version: "0" } });
notify("notifications/initialized", {});

const list = await rpc("tools/list", {});
const names = (list.result.tools || []).map((t) => t.name);
// 工具数会随功能增长，这里只要求「至少 14 且四个 faces 工具都在」——
// 写死数字会每加一个工具就红一次，那不是回归，是噪声。
check("tools/list 至少 14 个且含 faces 工具", names.length >= 14, "实际 " + names.length);
for (const n of ["wallpaper_mascot", "wallpaper_avatar", "wallpaper_fontset", "wallpaper_system_fonts"]) {
  check("工具有 " + n, names.includes(n));
}

// status
const st = payload(await rpc("tools/call", { name: "wallpaper_status", arguments: {} }));
check("wallpaper_status 宿主在跑", st.data && st.data.daemon === "running", JSON.stringify(st.data && st.data.host));

const ms = payload(await rpc("tools/call", { name: "wallpaper_mascot", arguments: { action: "status" } }));
// 断言的是「能回答这个问题」而不是「本机有图」：set 是有无图的真实状态，
// 把测试绑在必须有图，换一台干净机器就红。
check("wallpaper_mascot status 返回布尔", !!(ms.data && typeof ms.data.set === "boolean"), JSON.stringify(ms.data));

const av = payload(await rpc("tools/call", { name: "wallpaper_avatar", arguments: { action: "status" } }));
check("wallpaper_avatar status", av.data && typeof av.data.user === "boolean" && typeof av.data.ai === "boolean", JSON.stringify(av.data));

const fl = payload(await rpc("tools/call", { name: "wallpaper_fontset", arguments: { action: "list" } }));
const sets = fl.data && fl.data.fontsets;
check("wallpaper_fontset list", Array.isArray(sets) && sets.length > 0, "共 " + (sets ? sets.length : 0) + " 套：" + (sets || []).map((s) => s.id).join(","));

const fg = payload(await rpc("tools/call", { name: "wallpaper_fontset", arguments: { action: "get", id: "compact" } }));
check("wallpaper_fontset get compact", fg.data && fg.data.ok === true && !!fg.data.doc, fg.data && fg.data.doc && Object.keys(fg.data.doc.values.themeSize || {}).join(","));

const sf = payload(await rpc("tools/call", { name: "wallpaper_system_fonts", arguments: {} }));
check("wallpaper_system_fonts", sf.data && Array.isArray(sf.data.fonts) && sf.data.fonts.length > 0, sf.data && sf.data.source + " / " + sf.data.count + " 个 / 前三个 " + (sf.data.fonts || []).slice(0, 3).join(" "));

const bad = payload(await rpc("tools/call", { name: "wallpaper_fontset", arguments: { action: "get", id: "no-such-set" } }));
check("不存在的字体集给 isError", bad.isError === true, String(bad.data).slice(0, 80));

const fail = results.filter((r) => !r.ok);
console.log("");
console.log("结果 " + (results.length - fail.length) + "/" + results.length + " 通过");
child.stdin.end();
setTimeout(() => process.exit(fail.length ? 1 : 0), 120);
