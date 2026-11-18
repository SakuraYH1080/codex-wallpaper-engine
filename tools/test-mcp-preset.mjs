import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const srv = spawn(process.execPath, ["mcp/server.mjs"], { cwd: process.cwd(), stdio: ["pipe","pipe","pipe"] });
srv.stderr.on("data", () => {});
const rl = createInterface({ input: srv.stdout });
const waiting = new Map();
let id = 0;
rl.on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); w(m); }
});
function rpc(method, params) {
  const myId = ++id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(myId); reject(new Error("timeout " + method)); }, 40000);
    waiting.set(myId, (m) => { clearTimeout(timer); resolve(m); });
    srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
  });
}
function payload(m) {
  const txt = m?.result?.content?.[0]?.text ?? JSON.stringify(m);
  try { return JSON.parse(txt); } catch { return txt; }
}
function call(name, args) { return rpc("tools/call", { name, arguments: args || {} }).then(payload); }

await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const tl = await rpc("tools/list", {});
const names = (tl.result?.tools || []).map(t => t.name);
console.log("tools:", names.length, names.includes("wallpaper_preset") ? "HAS_PRESET" : "MISSING");

console.log("list:", JSON.stringify(await call("wallpaper_preset", { action: "list" })).slice(0, 400));
const saved = await call("wallpaper_preset", { action: "save", name: "mcp 测试观感" });
console.log("save:", JSON.stringify(saved).slice(0, 300));
const savedId = saved.saved?.id;
console.log("apply:", JSON.stringify(await call("wallpaper_preset", { action: "apply", id: savedId })).slice(0, 250));
const exp = await call("wallpaper_preset", { action: "export", id: savedId });
console.log("export keys:", Object.keys(exp || {}).join(","));
console.log("import:", JSON.stringify(await call("wallpaper_preset", { action: "import", preset: exp, name: "导入副本" })).slice(0, 300));
console.log("delete builtin:", JSON.stringify(await call("wallpaper_preset", { action: "delete", id: "clear-max" })).slice(0, 200));
console.log("delete saved:", JSON.stringify(await call("wallpaper_preset", { action: "delete", id: savedId })).slice(0, 200));

srv.stdin.end();
srv.kill();
process.exit(0);
