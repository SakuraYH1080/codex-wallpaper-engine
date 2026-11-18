/**
 * tools/test-mcp-rotation.mjs —— MCP 轮播工具的进程级 smoke。
 *
 * 起真 mcp/server.mjs，走 stdio JSON-RPC，验证：
 *   ① tools/list 里有 wallpaper_rotation（工具总数会随功能增长，只断言下限）
 *   ② wallpaper_rotation status 能列出已有的组
 *   ③ create → status 里能看到 → update 改字段生效 → add/remove 成员 → delete 清掉
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const proc = spawn(process.execPath, [resolve(ROOT, "mcp/server.mjs")], { stdio: ["pipe", "pipe", "pipe"], cwd: ROOT });
let seq = 0;
const waiting = new Map();
createInterface({ input: proc.stdout }).on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const w = waiting.get(msg.id);
  if (w) { waiting.delete(msg.id); w(msg); }
});
proc.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

function rpc(method, params) {
  const id = ++seq;
  return new Promise((res, rej) => {
    waiting.set(id, res);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); rej(new Error("timeout " + method)); } }, 40000);
  });
}
const payload = (m) => {
  const t = m.result && m.result.content && m.result.content[0] && m.result.content[0].text;
  try { return JSON.parse(t); } catch { return t; }
};

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : "")); };

await rpc("initialize", { protocolVersion: "2024-11-05" });
// notifications/* 是通知（没有 id），服务端按规范不回包 —— 不能等它。
proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");

const tools = await rpc("tools/list", {});
const names = tools.result.tools.map((t) => t.name);
check("tools/list 至少 15 个", names.length >= 15, names.length + ": " + names.join(","));
check("有 wallpaper_rotation", names.includes("wallpaper_rotation"));

const st0 = payload(await rpc("tools/call", { name: "wallpaper_rotation", arguments: { action: "status" } }));
check("status 返回组列表", Array.isArray(st0.groups), "共 " + (st0.groups || []).length + " 组，enabled=" + st0.enabled);

const created = payload(await rpc("tools/call", {
  name: "wallpaper_rotation",
  arguments: { action: "create", name: "MCP 测试组", interval: 7, order: "random", trigger: "videoEnd" },
}));
check("create 成功", created.ok === true && !!created.created, JSON.stringify(created.created || created).slice(0, 160));
const gid = created.created.id;

const st1 = payload(await rpc("tools/call", { name: "wallpaper_rotation", arguments: { action: "status" } }));
const g1 = st1.groups.find((g) => g.id === gid);
check("status 能看到新组", !!g1, g1 ? JSON.stringify({ interval: g1.interval, order: g1.order, trigger: g1.trigger }) : "missing");
check("新组字段正确", g1 && g1.interval === 7 && g1.order === "random" && g1.trigger === "videoEnd");

const updated = payload(await rpc("tools/call", {
  name: "wallpaper_rotation", arguments: { action: "update", id: gid, interval: 45, order: "sequence" },
}));
check("update 生效", updated.ok && updated.group.interval === 45 && updated.group.order === "sequence", JSON.stringify({ i: updated.group && updated.group.interval }));

// 拿一个真实壁纸 id 做 add/remove
const inv = payload(await rpc("tools/call", { name: "wallpaper_list", arguments: {} }));
const firstId = (() => {
  const txt = typeof inv === "string" ? inv : JSON.stringify(inv);
  const m = /up-[a-z0-9-]+/.exec(txt);
  return m ? m[0] : null;
})();
check("拿得到壁纸 id", !!firstId, firstId || "none");
if (firstId) {
  const added = payload(await rpc("tools/call", { name: "wallpaper_rotation", arguments: { action: "add", id: gid, wallpaperId: firstId } }));
  check("add 成员", added.ok && added.members === 1, "members=" + added.members);
  const rm = payload(await rpc("tools/call", { name: "wallpaper_rotation", arguments: { action: "remove", id: gid, wallpaperId: firstId } }));
  check("remove 成员", rm.ok && rm.members === 0, "members=" + rm.members);
}

const del = payload(await rpc("tools/call", { name: "wallpaper_rotation", arguments: { action: "delete", id: gid } }));
check("delete 成功", del.ok && del.deleted === gid, "remaining=" + del.remaining);

const st2 = payload(await rpc("tools/call", { name: "wallpaper_rotation", arguments: { action: "status" } }));
check("delete 后组不在了", !st2.groups.some((g) => g.id === gid));

proc.kill();
const allPass = results.every((r) => r.ok);
console.log(allPass ? "MCP_ROTATION_TEST_PASS" : "MCP_ROTATION_TEST_FAIL");
process.exit(allPass ? 0 : 1);
