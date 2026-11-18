import { createHostServer } from "../src/host/server.mjs";

const s = createHostServer({ port: 0, log: () => {} });
const listening = await s.listen(0);
const base = s.url + "/wallpaper-engine";
const j = async (p, o) => {
  const r = await fetch(base + p, o);
  const txt = await r.text();
  let body; try { body = JSON.parse(txt); } catch { body = txt.slice(0, 200); }
  return { code: r.status, body };
};
const out = [];
const ok = (n, c) => out.push((c ? "PASS " : "FAIL ") + n);

const l0 = await j("/presets");
ok("list 含 3 套内置", l0.code === 200 && l0.body.presets.filter((x) => x.builtin).length === 3);
ok("keys 非空且不含 cwePort", l0.body.keys.length > 10 && !l0.body.keys.includes("cwePort") && !l0.body.keys.includes("extraProjectDirs"));
ok("current 是外观子集", typeof l0.body.current.wallpaperOpacity === "number");

const saved = await j("/presets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "我的测试预设", values: { cweUiAlpha: 0.5, accent: "#FF8800", cwePort: 1234 } }) });
ok("保存成功", saved.code === 200 && saved.body.ok === true);
const pid = saved.body.preset.id;
ok("cwePort 被挡在预设外", saved.body.preset.keys > 0);

const one = await j("/presets/" + pid);
ok("读取单套", one.code === 200 && one.body.preset.values.accent === "#FF8800" && !("cwePort" in one.body.preset.values));

const ex = await fetch(base + "/presets/" + pid + "/export");
const exText = await ex.text();
ok("导出是合法 JSON 且带 disposition", ex.status === 200 && /attachment/.test(ex.headers.get("content-disposition") || "") && JSON.parse(exText).name === "我的测试预设");

const applied = await j("/presets/glass-dark/apply", { method: "POST" });
// 断言用预设自己的声明值，别写死数字 —— 预设参数会调，写死会让回归变成「改预设就得改测试」。
const glassDark = (await import("../src/host/presets.mjs")).BUILTIN_PRESETS.find((b) => b.id === "glass-dark");
ok("应用内置预设", applied.code === 200 && applied.body.config.cweUiAlpha === glassDark.values.cweUiAlpha);

const imp = await j("/presets/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preset: { name: "导入的", values: { cweUiAlpha: 0.11, bogusKey: 1 } }, apply: false }) });
ok("导入生效并忽略未知键", imp.code === 200 && imp.body.ok === true && Array.isArray(imp.body.ignoredKeys) && imp.body.ignoredKeys.includes("bogusKey"));

const del = await j("/presets/" + pid, { method: "DELETE" });
ok("删除用户预设", del.code === 200 && del.body.ok === true);
const delB = await j("/presets/plain", { method: "DELETE" });
ok("删除内置返回 409", delB.code === 409);
const bad = await j("/presets/..%2F..%2Fetc%2Fpasswd");
ok("路径穿越 → 404", bad.code === 404);

// 内置预设的键必须全部落在 presetKeys() 里。
// 否则「应用能过、保存被白名单静默丢掉」，导入导出还会回「忽略 N 个非外观键」。
const mod = await import("../src/host/presets.mjs");
const allowed = new Set(mod.presetKeys());
for (const b of mod.BUILTIN_PRESETS) {
  const bad = Object.keys(b.values).filter((k) => !allowed.has(k));
  ok("内置预设 " + b.id + " 无越界键" + (bad.length ? "（多了 " + bad.join(",") + "）" : ""), bad.length === 0);
}

// —— 预设命名 / 排序 / 改名 / 面板玻璃字段（本轮新增）——
const keysNow = mod.presetKeys();
ok("presetKeys 含设置面板玻璃两键", keysNow.includes("settingsWindowTransparency") && keysNow.includes("settingsWindowBlur"));
ok("HTTP keys 同步含两键", l0.body.keys.includes("settingsWindowTransparency") && l0.body.keys.includes("settingsWindowBlur"));

// 先清掉上一轮可能残留的同名测试预设，让重名断言从干净状态开始。
const h = { "content-type": "application/json" };
const pre = await j("/presets");
for (const p of pre.body.presets) {
  if (!p.builtin && (p.name.startsWith("重名测试") || p.name.startsWith("中文名观感"))) {
    await j("/presets/" + encodeURIComponent(p.id), { method: "DELETE" });
  }
}

const n1 = await j("/presets", { method: "POST", headers: h, body: JSON.stringify({ name: "重名测试", values: { cweUiAlpha: 0.31 } }) });
const n2 = await j("/presets", { method: "POST", headers: h, body: JSON.stringify({ name: "重名测试", values: { cweUiAlpha: 0.32 } }) });
ok("同名不同值 → 追加 · 2", n2.code === 200 && n2.body.preset.name === "重名测试 · 2" && n2.body.preset.id !== n1.body.preset.id);

const n1again = await j("/presets", { method: "POST", headers: h, body: JSON.stringify({ name: "重名测试", values: { cweUiAlpha: 0.31 } }) });
ok("同名同值 → 幂等复用已有项", n1again.code === 200 && n1again.body.preset.id === n1.body.preset.id);

const zh = await j("/presets", { method: "POST", headers: h, body: JSON.stringify({ name: "中文名观感", values: { accent: "#123456" } }) });
ok("中文名生成合法 id", zh.code === 200 && /^[A-Za-z0-9_-]+$/.test(zh.body.preset.id));

const l1 = await j("/presets");
const users = l1.body.presets.filter((p) => !p.builtin);
const firstBuiltin = l1.body.presets.findIndex((p) => p.builtin);
const desc = users.every((p, i) => i === 0 || String(users[i - 1].savedAt || "") >= String(p.savedAt || ""));
ok("用户预设按 savedAt 倒序", users.length >= 3 && desc);
ok("用户预设全部排在内置之前", firstBuiltin === users.length && l1.body.presets.filter((p) => p.builtin).length === 3);

const rn = await j("/presets/" + encodeURIComponent(n1.body.preset.id) + "/rename", { method: "POST", headers: h, body: JSON.stringify({ name: "改过名的" }) });
const rnGet = await j("/presets/" + encodeURIComponent(n1.body.preset.id));
ok("renamePreset 生效（HTTP 200 + 读回同名）", rn.code === 200 && rn.body.ok === true && rn.body.preset.name === "改过名的" && rnGet.body.preset.name === "改过名的");

const rnBuiltin = await j("/presets/plain/rename", { method: "POST", headers: h, body: JSON.stringify({ name: "x" }) });
ok("重命名内置 → 409", rnBuiltin.code === 409);

// 清掉本轮造的预设，不把测试数据留在真机预设目录里。
for (const p of [n1, n2, zh]) {
  const id = p && p.body && p.body.preset && p.body.preset.id;
  if (id) await j("/presets/" + encodeURIComponent(id), { method: "DELETE" });
}

console.log(out.join("\n"));
console.log("RESULT " + out.filter((x) => x.startsWith("PASS")).length + "/" + out.length);
await s.close();
process.exit(0);
